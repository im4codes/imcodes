import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_COMPACT_HIJACK_GLOBAL_CONFIG,
  encodeCompactHijackGlobalConfigJson,
  normalizeCompactHijackGlobalConfig,
  parseCompactHijackGlobalConfigJson,
  type CompactHijackGlobalConfig,
} from '../../shared/compact-hijack.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';

const STORE_FILENAME = 'compact-hijack-config.json';
const STORE_PATH_ENV = 'IMCODES_COMPACT_HIJACK_CONFIG_PATH';

let cachedConfig: CompactHijackGlobalConfig | null = null;
let loadedFromPath: string | null = null;

function resolveStorePath(): string {
  const override = process.env[STORE_PATH_ENV]?.trim();
  return override || join(imcodesStateDir(), STORE_FILENAME);
}

function readFromDisk(filePath: string): CompactHijackGlobalConfig {
  try {
    if (!existsSync(filePath)) return { ...DEFAULT_COMPACT_HIJACK_GLOBAL_CONFIG };
    const raw = readFileSync(filePath, 'utf8');
    return parseCompactHijackGlobalConfigJson(raw);
  } catch {
    return { ...DEFAULT_COMPACT_HIJACK_GLOBAL_CONFIG };
  }
}

function writeAtomic(filePath: string, config: CompactHijackGlobalConfig): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmpPath, `${encodeCompactHijackGlobalConfigJson(config)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, filePath);
}

function ensureLoaded(): CompactHijackGlobalConfig {
  const filePath = resolveStorePath();
  if (cachedConfig !== null && loadedFromPath === filePath) return cachedConfig;
  cachedConfig = readFromDisk(filePath);
  loadedFromPath = filePath;
  return cachedConfig;
}

export function getPersistedCompactHijackGlobalConfig(): CompactHijackGlobalConfig {
  return { ...ensureLoaded() };
}

export function isGlobalCompactHijackEnabled(): boolean {
  return ensureLoaded().enabled === true;
}

export function setPersistedCompactHijackGlobalConfig(raw: unknown): CompactHijackGlobalConfig {
  const filePath = resolveStorePath();
  const normalized = normalizeCompactHijackGlobalConfig(raw);
  writeAtomic(filePath, normalized);
  cachedConfig = normalized;
  loadedFromPath = filePath;
  return { ...normalized };
}

export function resetCompactHijackConfigStoreForTests(): void {
  cachedConfig = null;
  loadedFromPath = null;
}
