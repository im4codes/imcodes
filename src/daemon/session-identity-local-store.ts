import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

async function readStore(): Promise<DiskStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<DiskStore>;
    if (parsed.version !== STORE_VERSION || !parsed.profiles || typeof parsed.profiles !== 'object') {
      return { version: STORE_VERSION, profiles: {} };
    }
    return {
      version: STORE_VERSION,
      profiles: parsed.profiles as Record<string, DiskProfile>,
      ...(typeof parsed.migratedAt === 'number' ? { migratedAt: parsed.migratedAt } : {}),
    };
  } catch {
    return { version: STORE_VERSION, profiles: {} };
  }
}

/** Whether the one-time server->daemon content migration has already run here. */
export async function isSessionIdentityMigrated(): Promise<boolean> {
  return typeof (await readStore()).migratedAt === 'number';
}

export async function markSessionIdentityMigrated(now = Date.now()): Promise<void> {
  const store = await readStore();
  if (typeof store.migratedAt === 'number') return;
  store.migratedAt = now;
  await writeStore(store);
}

async function writeStore(store: DiskStore): Promise<void> {
  const target = storePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 });
  await rename(temporary, target);
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
  const store = await readStore();
  const previous = store.profiles[key(input.scope, input.scopeKey)];
  const profile: DiskProfile = {
    scope: input.scope,
    scopeKey: input.scopeKey,
    content,
    contentHash: contentHash(content),
    revision: Math.max(previous?.revision ?? 0, input.revision ?? 0) + 1,
    updatedAt: Date.now(),
    source: input.source,
    ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
  };
  store.profiles[key(input.scope, input.scopeKey)] = profile;
  await writeStore(store);
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
  const store = await readStore();
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
}

/** Removes without reporting -- used to apply a server-initiated USER-scope delete push. */
export async function removeLocalSessionIdentityProfileQuiet(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  const store = await readStore();
  const existed = delete store.profiles[key(scope, scopeKey)];
  if (existed) await writeStore(store);
  return existed;
}

export async function removeLocalSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<boolean> {
  const store = await readStore();
  const existed = delete store.profiles[key(scope, scopeKey)];
  if (existed) {
    await writeStore(store);
    report(scope === 'user'
      ? { type: SESSION_IDENTITY_WS.USER_REPORT, deleted: true }
      : { type: SESSION_IDENTITY_WS.LOCAL_REPORT, scope, scopeKey, deleted: true });
  }
  return existed;
}

export function localSessionIdentityStorePath(): string {
  return storePath();
}
