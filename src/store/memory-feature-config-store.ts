import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isMemoryFeatureFlag,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagValues,
} from '../../shared/feature-flags.js';
import logger from '../util/logger.js';

const STORE_VERSION = 1;
const STORE_PATH_ENV = 'IMCODES_MEMORY_FEATURE_CONFIG_PATH';

interface MemoryFeatureConfigStorePayload {
  version: typeof STORE_VERSION;
  flags: MemoryFeatureFlagValues;
}

let loaded = false;
let payload: MemoryFeatureConfigStorePayload = { version: STORE_VERSION, flags: {} };
let lastLoadIssue: string | undefined;

function storePath(): string {
  const override = process.env[STORE_PATH_ENV]?.trim();
  if (override) return override;
  return join(homedir(), '.imcodes', 'memory-feature-flags.json');
}

function normalizeStore(raw: unknown): MemoryFeatureConfigStorePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const flagsRaw = (raw as { flags?: unknown }).flags;
  if (!flagsRaw || typeof flagsRaw !== 'object') {
    return { version: STORE_VERSION, flags: {} };
  }
  const flags: MemoryFeatureFlagValues = {};
  for (const [key, value] of Object.entries(flagsRaw)) {
    if (!isMemoryFeatureFlag(key)) continue;
    if (value === true || value === false) flags[key] = value;
  }
  return { version: STORE_VERSION, flags };
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  lastLoadIssue = undefined;
  try {
    const raw = readFileSync(storePath(), 'utf8');
    const parsed = normalizeStore(JSON.parse(raw));
    if (!parsed) {
      payload = { version: STORE_VERSION, flags: {} };
      lastLoadIssue = 'invalid_store_shape';
      logger.warn('[memory-feature-config] Ignoring invalid feature flag config shape');
      return;
    }
    payload = parsed;
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code !== 'ENOENT') {
      lastLoadIssue = err instanceof Error ? err.message : String(err);
      logger.warn({ error: lastLoadIssue }, '[memory-feature-config] Failed to read feature flag config');
    }
    payload = { version: STORE_VERSION, flags: {} };
  }
}

function persist(nextPayload: MemoryFeatureConfigStorePayload): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

export function getPersistedMemoryFeatureFlagValues(): MemoryFeatureFlagValues {
  ensureLoaded();
  return { ...payload.flags };
}

export function setPersistedMemoryFeatureFlagValue(flag: MemoryFeatureFlag, enabled: boolean): MemoryFeatureFlagValues {
  ensureLoaded();
  const nextPayload: MemoryFeatureConfigStorePayload = {
    version: STORE_VERSION,
    flags: {
      ...payload.flags,
      [flag]: enabled,
    },
  };
  persist(nextPayload);
  payload = nextPayload;
  lastLoadIssue = undefined;
  return { ...payload.flags };
}

export function getMemoryFeatureConfigStoreDiagnostics(): { path: string; lastLoadIssue?: string } {
  return {
    path: storePath(),
    lastLoadIssue,
  };
}

export function resetMemoryFeatureConfigStoreForTests(): void {
  loaded = false;
  payload = { version: STORE_VERSION, flags: {} };
  lastLoadIssue = undefined;
}
