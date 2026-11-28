import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import {
  MODEL_TIERS,
  normalizeModelTierKnowledgeProvider,
  type LearnedModelTierRecord,
  type ModelTier,
} from '../../shared/supervision-execution-pool.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';
import { imcodesStatePath } from '../util/imcodes-state-dir.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const sqlite = require('node:sqlite') as typeof import('node:sqlite');
const { DatabaseSync } = sqlite;

export const MODEL_TIER_KNOWLEDGE_PATH_ENV = 'IMCODES_MODEL_TIER_KNOWLEDGE_PATH' as const;
const MODEL_TIER_KNOWLEDGE_FILE = 'model-tier-knowledge.json';
const MODEL_TIER_KNOWLEDGE_SCHEMA_VERSION = 1;
const MAX_KNOWLEDGE_RECORDS = 500;
const MAX_SOURCE_CHARS = 200;
const MAX_NOTES_CHARS = 300;
const KNOWLEDGE_LOCK_TIMEOUT_MS = 5_000;

export interface UpsertModelTierKnowledgeOptions {
  lockTimeoutMs?: number;
}

export interface LearnedModelTierInput {
  provider: string;
  model: string;
  tier: ModelTier;
  source?: string;
  notes?: string;
}

interface PersistedModelTierKnowledge {
  schemaVersion: number;
  records: LearnedModelTierRecord[];
}

let writeChain: Promise<void> = Promise.resolve();

export function resolveModelTierKnowledgePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[MODEL_TIER_KNOWLEDGE_PATH_ENV]?.trim();
  return override || imcodesStatePath(MODEL_TIER_KNOWLEDGE_FILE);
}

function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value);
}

function sanitizeOptionalText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = redactSensitiveText(value.trim());
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function normalizeRecord(raw: unknown): LearnedModelTierRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj.provider === 'string' ? obj.provider.trim() : '';
  const model = typeof obj.model === 'string' ? obj.model.trim() : '';
  if (!provider || !model || !isModelTier(obj.tier)) return undefined;
  const updatedAt = typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) && obj.updatedAt > 0
    ? Math.floor(obj.updatedAt)
    : 0;
  const source = sanitizeOptionalText(obj.source, MAX_SOURCE_CHARS);
  const notes = sanitizeOptionalText(obj.notes, MAX_NOTES_CHARS);
  return {
    provider: normalizeModelTierKnowledgeProvider(provider),
    model,
    tier: obj.tier,
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
    updatedAt,
  };
}

function knowledgeKey(provider: string, model: string): string {
  return `${normalizeModelTierKnowledgeProvider(provider)}\0${model.trim().toLowerCase()}`;
}

function deduplicateAndBoundRecords(records: readonly LearnedModelTierRecord[]): LearnedModelTierRecord[] {
  const byKey = new Map<string, LearnedModelTierRecord>();
  for (const record of records) {
    const key = knowledgeKey(record.provider, record.model);
    const prev = byKey.get(key);
    if (!prev || record.updatedAt >= prev.updatedAt) {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_KNOWLEDGE_RECORDS);
}

/**
 * Load persisted model-tier knowledge from disk (`~/.imcodes/model-tier-knowledge.json`).
 * Returns `[]` cleanly if the file does not exist or contains corrupt JSON.
 */
export function loadModelTierKnowledge(filePath = resolveModelTierKnowledgePath()): LearnedModelTierRecord[] {
  assertNotRealImcodesPathInTests(filePath, MODEL_TIER_KNOWLEDGE_FILE);
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedModelTierKnowledge> | unknown;
    const rawRecords = Array.isArray((parsed as { records?: unknown })?.records)
      ? (parsed as { records: unknown[] }).records
      : [];
    const normalized = rawRecords
      .map(normalizeRecord)
      .filter((item): item is LearnedModelTierRecord => Boolean(item));
    return deduplicateAndBoundRecords(normalized);
  } catch {
    return [];
  }
}

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_SQLITE_ERROR' && /database is locked|SQLITE_BUSY/i.test(msg)
    || /database is locked|SQLITE_BUSY/i.test(msg);
}

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runBusyBoundedSync(
  db: InstanceType<typeof DatabaseSync>,
  sql: string,
  deadline: number,
  timeoutErrorMessage: string,
): void {
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutErrorMessage);
    }
    try {
      db.exec(sql);
      return;
    } catch (err) {
      if (!isSqliteBusyError(err)) throw err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(timeoutErrorMessage);
      }
      sleepSyncMs(Math.min(5, remaining));
    }
  }
}

async function runBusyBoundedAsync(
  db: InstanceType<typeof DatabaseSync>,
  sql: string,
  deadline: number,
  timeoutErrorMessage: string,
): Promise<void> {
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutErrorMessage);
    }
    try {
      db.exec(sql);
      return;
    } catch (err) {
      if (!isSqliteBusyError(err)) throw err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(timeoutErrorMessage);
      }
      const jitter = 5 + Math.floor(Math.random() * 11);
      await new Promise((resolve) => setTimeout(resolve, Math.min(jitter, remaining)));
    }
  }
}

/**
 * Acquire an OS-kernel transactional lock via SQLite `BEGIN IMMEDIATE` on a
 * companion `.lock.db` file so concurrent processes serialize strictly without
 * fragile lock-directory deletion or stale-age races. OS kernel releases the
 * descriptor lock immediately if any holder crashes.
 */
function withSqliteKnowledgeLockSync<T>(
  filePath: string,
  options: UpsertModelTierKnowledgeOptions,
  fn: () => T,
): T {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockDbPath = `${filePath}.lock.db`;
  const timeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? KNOWLEDGE_LOCK_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const db = new DatabaseSync(lockDbPath);
  let inTx = false;
  try {
    db.exec('PRAGMA busy_timeout = 0;');
    runBusyBoundedSync(
      db,
      'BEGIN IMMEDIATE;',
      deadline,
      `Timed out acquiring model-tier-knowledge lock: ${lockDbPath}`,
    );
    inTx = true;
    const result = fn();
    runBusyBoundedSync(
      db,
      'COMMIT;',
      deadline,
      `Timed out committing model-tier-knowledge lock: ${lockDbPath}`,
    );
    inTx = false;
    return result;
  } catch (err) {
    if (inTx) {
      try {
        db.exec('ROLLBACK;');
      } catch { /* ignore rollback error */ }
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch { /* ignore close error */ }
  }
}

async function withSqliteKnowledgeLockAsync<T>(
  filePath: string,
  options: UpsertModelTierKnowledgeOptions,
  fn: () => T,
): Promise<T> {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockDbPath = `${filePath}.lock.db`;
  const timeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? KNOWLEDGE_LOCK_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const db = new DatabaseSync(lockDbPath);
  let inTx = false;
  try {
    db.exec('PRAGMA busy_timeout = 0;');
    await runBusyBoundedAsync(
      db,
      'BEGIN IMMEDIATE;',
      deadline,
      `Timed out acquiring model-tier-knowledge lock: ${lockDbPath}`,
    );
    inTx = true;
    const result = fn();
    await runBusyBoundedAsync(
      db,
      'COMMIT;',
      deadline,
      `Timed out committing model-tier-knowledge lock: ${lockDbPath}`,
    );
    inTx = false;
    return result;
  } catch (err) {
    if (inTx) {
      try {
        db.exec('ROLLBACK;');
      } catch { /* ignore rollback error */ }
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch { /* ignore close error */ }
  }
}

function performLockedKnowledgeUpsert(
  updates: readonly LearnedModelTierInput[],
  filePath: string,
  now: number,
): LearnedModelTierRecord[] {
  const existing = loadModelTierKnowledge(filePath);
  const incoming: LearnedModelTierRecord[] = [];
  for (let i = 0; i < updates.length; i += 1) {
    const item = updates[i]!;
    const provider = item.provider?.trim();
    const model = item.model?.trim();
    if (!provider || !model || !isModelTier(item.tier)) continue;
    const source = sanitizeOptionalText(item.source, MAX_SOURCE_CHARS);
    const notes = sanitizeOptionalText(item.notes, MAX_NOTES_CHARS);
    incoming.push({
      provider: normalizeModelTierKnowledgeProvider(provider),
      model,
      tier: item.tier,
      ...(source ? { source } : {}),
      ...(notes ? { notes } : {}),
      updatedAt: now + i,
    });
  }
  const merged = deduplicateAndBoundRecords([...existing, ...incoming]);
  const payload: PersistedModelTierKnowledge = {
    schemaVersion: MODEL_TIER_KNOWLEDGE_SCHEMA_VERSION,
    records: merged,
  };
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
  } finally {
    try {
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    } catch { /* ignore cleanup error */ }
  }
  return merged;
}

/**
 * Atomically persist learned model-tier records (tmp + rename) with cross-process lock + serialized writes.
 */
export function upsertModelTierKnowledgeSync(
  updates: readonly LearnedModelTierInput[],
  filePath = resolveModelTierKnowledgePath(),
  now = Date.now(),
  options: UpsertModelTierKnowledgeOptions = {},
): LearnedModelTierRecord[] {
  assertNotRealImcodesPathInTests(filePath, MODEL_TIER_KNOWLEDGE_FILE);
  return withSqliteKnowledgeLockSync(
    filePath,
    options,
    () => performLockedKnowledgeUpsert(updates, filePath, now),
  );
}

export async function upsertModelTierKnowledge(
  updates: readonly LearnedModelTierInput[],
  filePath = resolveModelTierKnowledgePath(),
  now = Date.now(),
  options: UpsertModelTierKnowledgeOptions = {},
): Promise<LearnedModelTierRecord[]> {
  assertNotRealImcodesPathInTests(filePath, MODEL_TIER_KNOWLEDGE_FILE);
  const run = writeChain.catch(() => {}).then(() => withSqliteKnowledgeLockAsync(
    filePath,
    options,
    () => performLockedKnowledgeUpsert(updates, filePath, now),
  ));
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}
