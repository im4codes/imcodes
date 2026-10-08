import { createHash } from 'node:crypto';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import {
  normalizeSessionIdentityContent,
  sessionIdentityContentError,
  sessionIdentityContentLength,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';
import { registerMemoryProbe } from './memory-probes.js';

/**
 * Set once at daemon startup (lifecycle.ts, where the server WS connection
 * is available) so a local write can report itself to the server -- keeping
 * its metadata row (PROJECT/SESSION) or its content (USER) in step. Never
 * required for the write itself to succeed: the local write is already
 * durable by the time this fires, and a report that fails to send (daemon
 * offline) is simply caught up by the next MIGRATE/PUSH cycle or the next
 * write's report. Fire-and-forget by design -- this is not the daemon->server
 * HTTP path the owner rule eliminates, it is its WS replacement.
 */
export type SessionIdentityReportSender = (report: Record<string, unknown>) => void;
let reportSender: SessionIdentityReportSender | null = null;
export function setSessionIdentityReportSender(sender: SessionIdentityReportSender | null): void {
  reportSender = sender;
}
function report(payload: Record<string, unknown>): void {
  try {
    reportSender?.(payload);
  } catch {
    // Best-effort; the local write already succeeded.
  }
}

const STORE_VERSION = 1;
const STORE_FILE = 'session-identities.json';

interface DiskProfile extends Omit<SessionIdentityProfile, 'content'> {
  content: string;
}

interface DiskStore {
  version: number;
  profiles: Record<string, DiskProfile>;
  /** Set once the one-time server->daemon content migration has run. */
  migratedAt?: number;
}

function key(scope: SessionIdentityScope, scopeKey: string): string {
  return `${scope}\0${scopeKey}`;
}

function storePath(): string {
  return join(resolveImcodesHome(), STORE_FILE);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function emptyStore(): DiskStore {
  return { version: STORE_VERSION, profiles: {} };
}

function normalizeParsedStore(parsed: Partial<DiskStore>): DiskStore {
  if (parsed.version !== STORE_VERSION || !parsed.profiles || typeof parsed.profiles !== 'object') return emptyStore();
  return {
    version: STORE_VERSION,
    profiles: parsed.profiles as Record<string, DiskProfile>,
    ...(typeof parsed.migratedAt === 'number' ? { migratedAt: parsed.migratedAt } : {}),
  };
}

/**
 * The file is the whole repository: 33.5 MB on 158 (184 sessions, prompts of 250-550 KB), and every list/get used to read and parse
 * all of it. `fs.promises.readFile(path, 'utf8')` of a big file decodes it in 512 KB chunks into one growing string, so N concurrent
 * readers hold N half-built copies at once: 20 readers of that file peak at 2 GB of heap, ~200 of them (one per session: a server
 * `get`, an MCP call, a launch each) exhausted the 8 GB heap, in a few seconds, in `StringDecoder::DecodeData`
 * (158, 2026-10-08, four guard restarts). Readers now share ONE in-flight read and then the parsed store, as long as the file is
 * unchanged (identity: inode, size, mtime, taken from the very handle the bytes came from); the bytes are read into one flat
 * buffer and decoded once.
 */
interface StoreSnapshot {
  signature: string;
  bytes: number;
  store: DiskStore;
}

let cachedSnapshot: StoreSnapshot | null = null;
let inFlightLoad: { signature: string; promise: Promise<StoreSnapshot | null> } | null = null;
const readStats = { loads: 0, cacheHits: 0, sharedLoads: 0, inFlightLoads: 0 };

registerMemoryProbe('identityStore', () => ({
  loads: readStats.loads,
  cacheHits: readStats.cacheHits,
  sharedLoads: readStats.sharedLoads,
  inFlightLoads: readStats.inFlightLoads,
  cachedBytes: cachedSnapshot?.bytes ?? 0,
}));

function fileSignature(info: { ino: number; size: number; mtimeMs: number }): string {
  return `${storePath()}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

/** Read and parse the file once. Resolves null when the file does not exist; rejects on any other read error. */
async function loadSnapshot(): Promise<StoreSnapshot | null> {
  let handle;
  try {
    handle = await open(storePath(), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    // No encoding: one Buffer of the file's size, decoded in one call (an encoding makes the runtime build the string chunk by chunk).
    const bytes = await handle.readFile();
    readStats.loads += 1;
    const text = bytes.toString('utf8');
    let store: DiskStore;
    try {
      store = normalizeParsedStore(JSON.parse(text) as Partial<DiskStore>);
    } catch {
      // A file that is not JSON holds nothing usable; the next write replaces it.
      store = emptyStore();
    }
    return { signature: fileSignature(info), bytes: bytes.length, store };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The store as of the file's current content. Shared and read-only: never mutate what this returns (mutators use readStoreForUpdate). */
async function readSnapshot(): Promise<StoreSnapshot | null> {
  let signature: string | undefined;
  try {
    signature = fileSignature(await stat(storePath()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cachedSnapshot = null; return null; }
    throw error;
  }
  if (cachedSnapshot && cachedSnapshot.signature === signature) {
    readStats.cacheHits += 1;
    return cachedSnapshot;
  }
  // Only a read of THIS version of the file is shared: a read that started before a write finished must not answer the next
  // read-modify-write, or that write's change would be lost.
  if (inFlightLoad && inFlightLoad.signature === signature) {
    readStats.sharedLoads += 1;
    return inFlightLoad.promise;
  }
  readStats.inFlightLoads += 1;
  const entry = {
    signature,
    promise: loadSnapshot().then((snapshot) => {
      cachedSnapshot = snapshot;
      return snapshot;
    }),
  };
  inFlightLoad = entry;
  try {
    return await entry.promise;
  } finally {
    readStats.inFlightLoads -= 1;
    if (inFlightLoad === entry) inFlightLoad = null;
  }
}

/** Read-only view for list/get. An unreadable store reads as empty, as it always did. */
async function readStore(): Promise<DiskStore> {
  try {
    return (await readSnapshot())?.store ?? emptyStore();
  } catch {
    return emptyStore();
  }
}

/**
 * The store for a read-modify-write: a private copy of the profile map (the profiles themselves are replaced, never edited, so the
 * copy is cheap and the shared snapshot stays untouched when the write fails). A store that cannot be READ (I/O error) rejects the
 * mutation instead of reading as empty: writing back "empty + one change" over a store that merely failed to open would wipe it.
 */
async function readStoreForUpdate(): Promise<DiskStore> {
  const store = (await readSnapshot())?.store ?? emptyStore();
  return { ...store, profiles: { ...store.profiles } };
}

/** Whether the one-time server->daemon content migration has already run here. */
export async function isSessionIdentityMigrated(): Promise<boolean> {
  return typeof (await readStore()).migratedAt === 'number';
}

export async function markSessionIdentityMigrated(now = Date.now()): Promise<void> {
  return enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    if (typeof store.migratedAt === 'number') return;
    store.migratedAt = now;
    await writeStore(store);
  });
}

async function writeStore(store: DiskStore): Promise<void> {
  const target = storePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  // The next reader compares the file's signature with the cached one: the rename changed it, so it loads the new content once.
  cachedSnapshot = null;
}

/**
 * Every mutator below does readStore() -> mutate -> writeStore(): a
 * read-modify-write on the whole shared file. Without serialization, two
 * concurrent mutations for DIFFERENT scope/scopeKey keys (an MCP write
 * racing a browser-triggered LOCAL_REQUEST, or two agent sessions on the
 * same daemon writing PROJECT vs SESSION scope) can interleave so the
 * second call's writeStore() overwrites the file with a snapshot that never
 * saw the first call's change -- silently discarding it. Queuing every
 * mutation's full read+mutate+write body here (mirroring session-store.ts's
 * writeQueue) makes them serialize regardless of which key they touch.
 * Reads stay outside the queue; eventual consistency for reads is fine.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(fn, fn);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export interface LocalIdentityWrite {
  scope: SessionIdentityScope;
  scopeKey: string;
  content: string;
  revision?: number;
  source: 'web' | 'mcp';
  sourceFile?: string;
}

/**
 * The daemon-local identity repository. The file is deliberately kept below
 * resolveImcodesHome(), so scoped daemons never read or write the default
 * user's home. Writes use a same-directory rename for crash-safe recovery.
 */
export async function listLocalSessionIdentityProfiles(): Promise<SessionIdentityProfile[]> {
  const store = await readStore();
  return Object.values(store.profiles).map((profile) => ({ ...profile }));
}

export async function getLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<SessionIdentityProfile | null> {
  const store = await readStore();
  const profile = store.profiles[key(scope, scopeKey)];
  return profile ? { ...profile } : null;
}

export async function putLocalSessionIdentityProfile(input: LocalIdentityWrite): Promise<SessionIdentityProfile> {
  const content = normalizeSessionIdentityContent(input.content);
  const error = sessionIdentityContentError(content, input.scope);
  if (error) throw new Error(error);
  const profile = await enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    const previous = store.profiles[key(input.scope, input.scopeKey)];
    const next: DiskProfile = {
      scope: input.scope,
      scopeKey: input.scopeKey,
      content,
      contentHash: contentHash(content),
      revision: Math.max(previous?.revision ?? 0, input.revision ?? 0) + 1,
      updatedAt: Date.now(),
      source: input.source,
      ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    };
    store.profiles[key(input.scope, input.scopeKey)] = next;
    await writeStore(store);
    return next;
  });
  if (profile.scope === 'user') {
    report({
      type: SESSION_IDENTITY_WS.USER_REPORT, content: profile.content,
      source: profile.source, sourceFile: profile.sourceFile,
    });
  } else {
    report({
      type: SESSION_IDENTITY_WS.LOCAL_REPORT, scope: profile.scope, scopeKey: profile.scopeKey,
      contentHash: profile.contentHash, contentLength: sessionIdentityContentLength(profile.content),
      revision: profile.revision, updatedAt: profile.updatedAt,
      source: profile.source, sourceFile: profile.sourceFile,
    });
  }
  return { ...profile };
}

/**
 * Apply content the SERVER already considers authoritative (a USER-scope
 * PUSH, or a migration pull's own rows) -- stores the exact revision/
 * updatedAt given rather than bumping a local counter, and never reports
 * back (reporting the server's own data back to it would loop).
 */
export async function putLocalSessionIdentityProfileExact(input: {
  scope: SessionIdentityScope;
  scopeKey: string;
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
  source: 'web' | 'mcp';
  sourceFile?: string;
}): Promise<SessionIdentityProfile> {
  const content = normalizeSessionIdentityContent(input.content);
  return enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    const profile: DiskProfile = {
      scope: input.scope,
      scopeKey: input.scopeKey,
      content,
      contentHash: input.contentHash,
      revision: input.revision,
      updatedAt: input.updatedAt,
      source: input.source,
      ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    };
    store.profiles[key(input.scope, input.scopeKey)] = profile;
    await writeStore(store);
    return { ...profile };
  });
}

/** Removes without reporting -- used to apply a server-initiated USER-scope delete push. */
export async function removeLocalSessionIdentityProfileQuiet(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  return enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    const existed = delete store.profiles[key(scope, scopeKey)];
    if (existed) await writeStore(store);
    return existed;
  });
}

export async function removeLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  const existed = await enqueueMutation(async () => {
    const store = await readStoreForUpdate();
    const found = delete store.profiles[key(scope, scopeKey)];
    if (found) await writeStore(store);
    return found;
  });
  if (existed) {
    report(scope === 'user'
      ? { type: SESSION_IDENTITY_WS.USER_REPORT, deleted: true }
      : { type: SESSION_IDENTITY_WS.LOCAL_REPORT, scope, scopeKey, deleted: true });
  }
  return existed;
}

/** Test seam: how the reads were served (counters never include content), and a way to start from a cold cache. */
export function identityStoreReadStatsForTests(): { loads: number; cacheHits: number; sharedLoads: number } {
  return { loads: readStats.loads, cacheHits: readStats.cacheHits, sharedLoads: readStats.sharedLoads };
}

export function resetIdentityStoreCacheForTests(): void {
  cachedSnapshot = null;
  inFlightLoad = null;
  readStats.loads = 0;
  readStats.cacheHits = 0;
  readStats.sharedLoads = 0;
}

export function localSessionIdentityStorePath(): string {
  return storePath();
}
