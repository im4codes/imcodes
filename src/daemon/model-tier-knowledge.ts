import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MODEL_TIERS,
  normalizeModelTierKnowledgeProvider,
  type LearnedModelTierRecord,
  type ModelTier,
} from '../../shared/supervision-execution-pool.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';
import { imcodesStatePath } from '../util/imcodes-state-dir.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

export const MODEL_TIER_KNOWLEDGE_PATH_ENV = 'IMCODES_MODEL_TIER_KNOWLEDGE_PATH' as const;
const MODEL_TIER_KNOWLEDGE_FILE = 'model-tier-knowledge.json';
const MODEL_TIER_KNOWLEDGE_SCHEMA_VERSION = 1;
const MAX_KNOWLEDGE_RECORDS = 500;
const MAX_SOURCE_CHARS = 200;
const MAX_NOTES_CHARS = 300;
const KNOWLEDGE_LOCK_TIMEOUT_MS = 5_000;
const KNOWLEDGE_LOCK_STALE_MS = 10_000;
const SLEEP_INT32 = new Int32Array(new SharedArrayBuffer(4));

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

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function tryBreakStaleKnowledgeLock(lockDirPath: string): boolean {
  try {
    const ownerFile = join(lockDirPath, 'owner.json');
    if (existsSync(ownerFile)) {
      const parsed = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: unknown; createdAt?: unknown };
      const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
      const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : null;
      if ((pid !== null && !isProcessAlive(pid)) || (createdAt !== null && Date.now() - createdAt >= KNOWLEDGE_LOCK_STALE_MS)) {
        rmSync(lockDirPath, { recursive: true, force: true });
        return true;
      }
      return false;
    }
    const stat = statSync(lockDirPath);
    if (Date.now() - stat.mtimeMs >= KNOWLEDGE_LOCK_STALE_MS) {
      rmSync(lockDirPath, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function tryAcquireKnowledgeLock(lockDirPath: string): (() => void) | null {
  try {
    mkdirSync(lockDirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  try {
    writeFileSync(join(lockDirPath, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
  } catch { /* ignore owner metadata write failure */ }
  return () => {
    try {
      rmSync(lockDirPath, { recursive: true, force: true });
    } catch { /* ignore release error */ }
  };
}

function acquireKnowledgeLockSync(filePath: string): () => void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockDirPath = `${filePath}.lock`;
  const deadline = Date.now() + KNOWLEDGE_LOCK_TIMEOUT_MS;
  while (true) {
    const release = tryAcquireKnowledgeLock(lockDirPath);
    if (release) return release;
    if (tryBreakStaleKnowledgeLock(lockDirPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring model-tier-knowledge lock: ${lockDirPath}`);
    }
    Atomics.wait(SLEEP_INT32, 0, 0, 10);
  }
}

async function acquireKnowledgeLockAsync(filePath: string): Promise<() => void> {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockDirPath = `${filePath}.lock`;
  const deadline = Date.now() + KNOWLEDGE_LOCK_TIMEOUT_MS;
  while (true) {
    const release = tryAcquireKnowledgeLock(lockDirPath);
    if (release) return release;
    if (tryBreakStaleKnowledgeLock(lockDirPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring model-tier-knowledge lock: ${lockDirPath}`);
    }
    const jitter = 5 + Math.floor(Math.random() * 11);
    await new Promise((resolve) => setTimeout(resolve, jitter));
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
): LearnedModelTierRecord[] {
  assertNotRealImcodesPathInTests(filePath, MODEL_TIER_KNOWLEDGE_FILE);
  const release = acquireKnowledgeLockSync(filePath);
  try {
    return performLockedKnowledgeUpsert(updates, filePath, now);
  } finally {
    release();
  }
}

export async function upsertModelTierKnowledge(
  updates: readonly LearnedModelTierInput[],
  filePath = resolveModelTierKnowledgePath(),
  now = Date.now(),
): Promise<LearnedModelTierRecord[]> {
  assertNotRealImcodesPathInTests(filePath, MODEL_TIER_KNOWLEDGE_FILE);
  const run = writeChain.catch(() => {}).then(async () => {
    const release = await acquireKnowledgeLockAsync(filePath);
    try {
      return performLockedKnowledgeUpsert(updates, filePath, now);
    } finally {
      release();
    }
  });
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}
