import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const IS_TEST_ENV = !!process.env.VITEST || process.env.NODE_ENV === 'test';
const STORE_DIR = join(IS_TEST_ENV ? tmpdir() : homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'provider-usage.json');
const QWEN_OAUTH_DAY_LIMIT = 1000;
const QWEN_OAUTH_MINUTE_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

interface ProviderUsageStore {
  qwenOAuthRequestTimestamps: number[];
}

let loaded = false;
let store: ProviderUsageStore = { qwenOAuthRequestTimestamps: [] };

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(STORE_PATH)) return;
    const raw = readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderUsageStore>;
    store = {
      qwenOAuthRequestTimestamps: Array.isArray(parsed.qwenOAuthRequestTimestamps)
        ? parsed.qwenOAuthRequestTimestamps.filter((value): value is number => Number.isFinite(value))
        : [],
    };
  } catch {
    store = { qwenOAuthRequestTimestamps: [] };
  }
}

function persist(): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function prune(now: number): void {
  store.qwenOAuthRequestTimestamps = store.qwenOAuthRequestTimestamps.filter((ts) => now - ts <= DAY_MS);
}

function snapshot(now: number): { dayUsed: number; minuteUsed: number } {
  ensureLoaded();
  prune(now);
  const minuteUsed = store.qwenOAuthRequestTimestamps.filter((ts) => now - ts <= MINUTE_MS).length;
  return {
    dayUsed: store.qwenOAuthRequestTimestamps.length,
    minuteUsed,
  };
}

export function formatQwenOAuthQuotaUsageLabel(now = Date.now()): string {
  const { dayUsed, minuteUsed } = snapshot(now);
  return `today ${dayUsed}/${QWEN_OAUTH_DAY_LIMIT} · 1m ${minuteUsed}/${QWEN_OAUTH_MINUTE_LIMIT}`;
}

export function recordQwenOAuthRequest(now = Date.now()): string {
  ensureLoaded();
  prune(now);
  store.qwenOAuthRequestTimestamps.push(now);
  persist();
  return formatQwenOAuthQuotaUsageLabel(now);
}

export function getQwenOAuthQuotaUsageLabel(now = Date.now()): string {
  return formatQwenOAuthQuotaUsageLabel(now);
}
