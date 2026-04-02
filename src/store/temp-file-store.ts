import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../util/logger.js';

const STORE_DIR = join(homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'temp-files.json');
const DEBOUNCE_MS = 500;
const CLEANUP_SWEEP_MS = 5 * 60_000;

export interface TempFileEntry {
  path: string;
  createdAt: number;
  expiresAt: number;
  reason: 'sendKeys' | 'sandbox-ref-copy';
}

interface TempFileStore {
  files: Record<string, TempFileEntry>;
}

let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const entryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let store: TempFileStore = { files: {} };

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    store = JSON.parse(raw) as TempFileStore;
  } catch {
    store = { files: {} };
  }
  loaded = true;
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
    writeTimer = null;
  }, DEBOUNCE_MS);
}

export async function flushTempFileStore(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function clearEntryTimer(filePath: string): void {
  const timer = entryTimers.get(filePath);
  if (timer) clearTimeout(timer);
  entryTimers.delete(filePath);
}

async function cleanupTrackedFile(filePath: string): Promise<void> {
  clearEntryTimer(filePath);
  try {
    await unlink(filePath);
  } catch {
    // already gone
  }
  if (store.files[filePath]) {
    delete store.files[filePath];
    scheduleWrite();
  }
}

function scheduleEntryTimer(entry: TempFileEntry): void {
  clearEntryTimer(entry.path);
  const delay = Math.max(0, entry.expiresAt - Date.now());
  entryTimers.set(entry.path, setTimeout(() => {
    void cleanupTrackedFile(entry.path).catch((err) => {
      logger.warn({ err, path: entry.path, reason: entry.reason }, 'temp-file-store: cleanup failed');
    });
  }, delay));
}

export async function registerTempFile(entry: TempFileEntry): Promise<void> {
  await ensureLoaded();
  store.files[entry.path] = entry;
  scheduleEntryTimer(entry);
  scheduleWrite();
}

export async function removeTrackedTempFile(filePath: string): Promise<void> {
  await ensureLoaded();
  clearEntryTimer(filePath);
  if (store.files[filePath]) {
    delete store.files[filePath];
    scheduleWrite();
  }
}

export async function cleanupExpiredTempFiles(): Promise<void> {
  await ensureLoaded();
  const now = Date.now();
  const entries = Object.values(store.files);
  for (const entry of entries) {
    if (entry.expiresAt <= now) {
      await cleanupTrackedFile(entry.path);
    } else if (!entryTimers.has(entry.path)) {
      scheduleEntryTimer(entry);
    }
  }
}

export async function initTempFileStore(): Promise<void> {
  await ensureLoaded();
  await cleanupExpiredTempFiles();
  for (const entry of Object.values(store.files)) {
    scheduleEntryTimer(entry);
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      void cleanupExpiredTempFiles().catch((err) => {
        logger.warn({ err }, 'temp-file-store: periodic cleanup failed');
      });
    }, CLEANUP_SWEEP_MS);
  }
}

export function shutdownTempFileStore(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const timer of entryTimers.values()) clearTimeout(timer);
  entryTimers.clear();
  loaded = false;
  store = { files: {} };
}
