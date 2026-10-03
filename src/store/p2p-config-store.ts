import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import logger from '../util/logger.js';
import { isP2pSavedConfig, type P2pSavedConfig } from '../../shared/p2p-modes.js';

interface P2pConfigStore {
  version: 1;
  configs: Record<string, P2pSavedConfig>;
}

type P2pConfigStoreLoadIssue = 'missing_file' | 'corrupted_file' | 'validation_failed' | null;

function storeDir(): string { return resolveImcodesHome(); }
function storePath(): string { return join(storeDir(), 'p2p-config.json'); }

let loaded = false;
let store: P2pConfigStore = { version: 1, configs: {} };
let lastLoadIssue: P2pConfigStoreLoadIssue = null;
let persistSequence = 0;
let persistQueue: Promise<void> = Promise.resolve();
let loadPromise: Promise<void> | null = null;

function resetStore(): void {
  store = { version: 1, configs: {} };
}

function isP2pConfigStore(value: unknown): value is P2pConfigStore {
  if (!value || typeof value !== 'object') return false;
  const record = value as { version?: unknown; configs?: unknown };
  if (record.version !== 1) return false;
  if (!record.configs || typeof record.configs !== 'object' || Array.isArray(record.configs)) return false;
  return Object.values(record.configs as Record<string, unknown>).every(isP2pSavedConfig);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const dir = storeDir();
      const path = storePath();
      await mkdir(dir, { recursive: true });
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (!isP2pConfigStore(parsed)) {
          lastLoadIssue = 'validation_failed';
          logger.warn({ path }, 'P2P config store validation failed; resetting local authority cache');
          resetStore();
          return;
        }
        store = parsed;
        lastLoadIssue = null;
      } catch (err) {
        const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        if (code === 'ENOENT') {
          lastLoadIssue = 'missing_file';
          resetStore();
          return;
        }
        lastLoadIssue = 'corrupted_file';
        logger.warn({ err, path }, 'P2P config store unreadable; resetting local authority cache');
        resetStore();
      } finally {
        loaded = true;
      }
    })();
  }
  await loadPromise;
}

async function persist(): Promise<void> {
  const dir = storeDir();
  const path = storePath();
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${persistSequence += 1}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(tmpPath, path);
  lastLoadIssue = null;
}

async function queuePersist(): Promise<void> {
  const nextPersist = persistQueue.then(() => persist());
  persistQueue = nextPersist.catch(() => {});
  await nextPersist;
}

export async function getSavedP2pConfig(scopeSession: string): Promise<P2pSavedConfig | undefined> {
  await ensureLoaded();
  return store.configs[scopeSession];
}

export async function upsertSavedP2pConfig(scopeSession: string, config: P2pSavedConfig): Promise<void> {
  await ensureLoaded();
  store.configs[scopeSession] = config;
  await queuePersist();
}

export async function removeSavedP2pConfig(scopeSession: string): Promise<void> {
  await ensureLoaded();
  delete store.configs[scopeSession];
  await queuePersist();
}

export function getP2pConfigStoreDiagnostics(): { path: string; lastLoadIssue: P2pConfigStoreLoadIssue } {
  return { path: storePath(), lastLoadIssue };
}

export function resetP2pConfigStoreForTests(): void {
  loaded = false;
  lastLoadIssue = null;
  persistSequence = 0;
  persistQueue = Promise.resolve();
  loadPromise = null;
  resetStore();
}
