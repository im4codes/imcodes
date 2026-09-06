import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  SESSION_RESOURCE_HANDLE_TYPE,
  SESSION_RESOURCE_KIND,
  SESSION_RESOURCE_RELEASE_REASON,
  type SessionResourceKind,
  type SessionResourceOwnerIdentity,
} from '../../shared/session-resource-lifecycle.js';

const execFile = promisify(execFileCallback);
const RECORD_VERSION = 1;
const FIELD_LIMIT = 512;
const PODMAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REGISTRY_LOCK_FILE = '.registry.lock';
const REGISTRY_LOCK_WAIT_MS = 30_000;
const TMUX_IDENTITY_QUERY_TIMEOUT_MS = 2_000;

export type SessionResourceOwner = SessionResourceOwnerIdentity;

export type SessionResourceHandle =
  | { type: typeof SESSION_RESOURCE_HANDLE_TYPE.PID; pid: number; processStart?: string; killTree?: boolean }
  | { type: typeof SESSION_RESOURCE_HANDLE_TYPE.TMUX; name: string; paneId?: string }
  | { type: typeof SESSION_RESOURCE_HANDLE_TYPE.PODMAN; containerId: string };

export interface SessionResourceRegistration {
  resourceId: string;
  kind: SessionResourceKind;
  owner: SessionResourceOwner;
  handle: SessionResourceHandle;
  ttlMs?: number;
  idleTimeoutMs?: number;
}

export interface SessionResourceRecord extends SessionResourceRegistration {
  version: typeof RECORD_VERSION;
  createdAt: number;
  lastUsedAt: number;
}

export type SessionResourceCleanup = (
  record: SessionResourceRecord,
  reason: string,
) => Promise<void>;

export interface SessionResourceRegistryOptions {
  directory?: string;
  now?: () => number;
  cleanup?: SessionResourceCleanup;
  resolveTmuxIdentity?: (name: string) => Promise<{
    paneId: string;
    sessionInstanceId: string;
    runtimeEpoch: string;
  } | undefined>;
  tmuxIdentityTimeoutMs?: number;
}

export interface ReleaseSummary {
  released: number;
  failed: number;
}

export interface OrphanSweepSummary extends ReleaseSummary {
  preserved: number;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= FIELD_LIMIT;
}

function validOwner(value: unknown): value is SessionResourceOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return boundedString(owner.sessionName)
    && boundedString(owner.sessionInstanceId)
    && boundedString(owner.runtimeEpoch);
}

function validPositiveDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validHandle(value: unknown): value is SessionResourceHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handle = value as Record<string, unknown>;
  if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.PID) {
    return typeof handle.pid === 'number' && Number.isSafeInteger(handle.pid) && handle.pid > 1
      && (handle.processStart === undefined || boundedString(handle.processStart))
      && (handle.killTree === undefined || typeof handle.killTree === 'boolean');
  }
  if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX) {
    return boundedString(handle.name) && (handle.paneId === undefined || boundedString(handle.paneId));
  }
  if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.PODMAN) {
    return typeof handle.containerId === 'string' && PODMAN_ID.test(handle.containerId);
  }
  return false;
}

function validKind(value: unknown): value is SessionResourceKind {
  return Object.values(SESSION_RESOURCE_KIND).includes(value as SessionResourceKind);
}

function parseRecord(value: unknown): SessionResourceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== RECORD_VERSION || !boundedString(record.resourceId)
    || !validKind(record.kind) || !validOwner(record.owner) || !validHandle(record.handle)
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)
    || typeof record.lastUsedAt !== 'number' || !Number.isFinite(record.lastUsedAt)
    || (record.ttlMs !== undefined && !validPositiveDuration(record.ttlMs))
    || (record.idleTimeoutMs !== undefined && !validPositiveDuration(record.idleTimeoutMs))) return null;
  return record as unknown as SessionResourceRecord;
}

function ownerKey(owner: SessionResourceOwner): string {
  return JSON.stringify([owner.sessionName, owner.sessionInstanceId, owner.runtimeEpoch]);
}

function recordFileName(resourceId: string): string {
  return `${createHash('sha256').update(resourceId).digest('hex')}.json`;
}

async function readProcessStart(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { timeout: 2_000, windowsHide: true });
      const value = stdout.trim();
      return /^\d+$/.test(value) ? value : undefined;
    }
    const { stdout } = await execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function resolveLiveTmuxIdentity(name: string): Promise<{
  paneId: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
} | undefined> {
  try {
    const { getTmuxSessionResourceIdentity } = await import('../agent/tmux.js');
    return await getTmuxSessionResourceIdentity(name, TMUX_IDENTITY_QUERY_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Verifies that a PID handle still names the exact process registered for the
 * resource. A null result means the OS can still see the PID but could not
 * provide a strong start-time identity, so callers must fail safe without
 * killing or restarting anything.
 */
export async function sessionResourcePidHandleIsCurrent(
  handle: Extract<SessionResourceHandle, { type: typeof SESSION_RESOURCE_HANDLE_TYPE.PID }>,
): Promise<boolean | null> {
  const currentStart = await readProcessStart(handle.pid);
  if (currentStart) {
    return handle.processStart ? currentStart === handle.processStart : null;
  }
  return processIsAlive(handle.pid) ? null : false;
}

export async function cleanupSessionResource(
  record: SessionResourceRecord,
  _reason: string,
): Promise<void> {
  const handle = record.handle;
  if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.PID) {
    if (handle.pid === process.pid) return;
    if (!handle.processStart) return;
    const currentStart = await readProcessStart(handle.pid);
    if (!currentStart) {
      if (handle.killTree && process.platform !== 'win32') {
        try { process.kill(-handle.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      return;
    }
    if (currentStart !== handle.processStart) return;
    const signal = async (force: boolean) => {
      if (handle.killTree && process.platform === 'win32') {
        await execFile('taskkill', [...(force ? ['/F'] : []), '/T', '/PID', String(handle.pid)], {
          timeout: 5_000,
          windowsHide: true,
        });
        return;
      }
      process.kill(handle.killTree ? -handle.pid : handle.pid, force ? 'SIGKILL' : 'SIGTERM');
    };
    try {
      await signal(false);
    } catch (error) {
      const output = `${(error as { stderr?: unknown }).stderr ?? ''} ${(error as Error).message}`.toLowerCase();
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH'
        && !output.includes('not found') && !output.includes('no running instance')) throw error;
      return;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stillSame = await readProcessStart(handle.pid);
      if (!stillSame || stillSame !== handle.processStart) {
        if (!handle.killTree) return;
        break;
      }
    }
    try {
      await signal(true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    return;
  }
  if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX) {
    const { getPaneId, killSession } = await import('../agent/tmux.js');
    if (handle.paneId) {
      const currentPaneId = await getPaneId(handle.name).catch(() => undefined);
      if (!currentPaneId || currentPaneId !== handle.paneId) return;
    }
    await killSession(handle.name);
    return;
  }
  try {
    await execFile('podman', ['rm', '--force', '--', handle.containerId], { timeout: 15_000 });
  } catch (error) {
    const output = `${(error as { stderr?: unknown }).stderr ?? ''} ${(error as Error).message}`.toLowerCase();
    if (!output.includes('no such container') && !output.includes('not found')) throw error;
  }
}

export class SessionResourceRegistry {
  readonly directory: string;
  private readonly now: () => number;
  private readonly cleanup: SessionResourceCleanup;
  private readonly resolveTmuxIdentity: NonNullable<SessionResourceRegistryOptions['resolveTmuxIdentity']>;
  private readonly tmuxIdentityTimeoutMs: number;
  private readonly requiresStrongHandles: boolean;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionResourceRegistryOptions = {}) {
    this.directory = options.directory ?? join(
      process.env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes'),
      'session-resources',
    );
    this.now = options.now ?? Date.now;
    this.cleanup = options.cleanup ?? cleanupSessionResource;
    this.resolveTmuxIdentity = options.resolveTmuxIdentity ?? resolveLiveTmuxIdentity;
    this.tmuxIdentityTimeoutMs = options.tmuxIdentityTimeoutMs ?? TMUX_IDENTITY_QUERY_TIMEOUT_MS;
    this.requiresStrongHandles = options.cleanup === undefined;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let finish!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { finish = resolve; });
    await previous.catch(() => {});
    let releaseFileLock: (() => Promise<void>) | null = null;
    try {
      releaseFileLock = await this.acquireFileLock();
      return await operation();
    } finally {
      await releaseFileLock?.();
      finish();
    }
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, REGISTRY_LOCK_FILE);
    const token = randomBytes(16).toString('hex');
    const processStart = await readProcessStart(process.pid);
    const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, processStart, token })}\n`, 'utf8');
        await handle.close();
        return async () => {
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
            if (current.token === token) await rm(path, { force: true });
          } catch { /* another process recovered it or the directory vanished */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const lock = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; processStart?: unknown };
          if (typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid <= 1) {
            stale = true;
          } else {
            const liveStart = await readProcessStart(lock.pid);
            stale = liveStart
              ? typeof lock.processStart === 'string' && liveStart !== lock.processStart
              : !processIsAlive(lock.pid);
          }
        } catch {
          const metadata = await stat(path).catch(() => null);
          stale = Boolean(metadata && Date.now() - metadata.mtimeMs > 2_000);
        }
        if (stale) {
          await rm(path, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() >= deadline) throw new Error('session_resource_registry_busy');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private pathFor(resourceId: string): string {
    return join(this.directory, recordFileName(resourceId));
  }

  private async listUnlocked(): Promise<SessionResourceRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
      try {
        const record = parseRecord(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
        return record && recordFileName(record.resourceId) === name ? record : null;
      } catch {
        return null;
      }
    }));
    return records.filter((record): record is SessionResourceRecord => record !== null)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.resourceId.localeCompare(b.resourceId));
  }

  async list(): Promise<SessionResourceRecord[]> {
    return this.serialized(() => this.listUnlocked());
  }

  async register(registration: SessionResourceRegistration): Promise<SessionResourceRecord> {
    return this.serialized(async () => {
      if (!boundedString(registration.resourceId) || !validKind(registration.kind)
        || !validOwner(registration.owner) || !validHandle(registration.handle)
        || (registration.ttlMs !== undefined && !validPositiveDuration(registration.ttlMs))
        || (registration.idleTimeoutMs !== undefined && !validPositiveDuration(registration.idleTimeoutMs))) {
        throw new Error('invalid_session_resource_registration');
      }
      if ((registration.ttlMs !== undefined || registration.idleTimeoutMs !== undefined)
        && registration.kind !== SESSION_RESOURCE_KIND.BROWSER
        && registration.kind !== SESSION_RESOURCE_KIND.CONTAINER) {
        throw new Error('session_resource_ttl_not_supported');
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.pathFor(registration.resourceId);
      let previous: SessionResourceRecord | null = null;
      try {
        previous = parseRecord(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof SyntaxError === false) throw error;
      }
      let replacesStaleTmuxOwner = false;
      if (previous && ownerKey(previous.owner) !== ownerKey(registration.owner)) {
        const sameLogicalTmuxOwner = previous.kind === SESSION_RESOURCE_KIND.TMUX
          && registration.kind === SESSION_RESOURCE_KIND.TMUX
          && previous.handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX
          && registration.handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX
          && previous.owner.sessionName === registration.owner.sessionName
          && previous.owner.sessionInstanceId === registration.owner.sessionInstanceId
          && previous.handle.name === registration.handle.name
          && previous.handle.paneId === registration.handle.paneId;
        if (!sameLogicalTmuxOwner
          && previous.kind === SESSION_RESOURCE_KIND.TMUX
          && registration.kind === SESSION_RESOURCE_KIND.TMUX
          && previous.handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX
          && registration.handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX
          && previous.resourceId === registration.resourceId
          && registration.resourceId === `${SESSION_RESOURCE_KIND.TMUX}:${registration.handle.name}`
          && previous.owner.sessionName === previous.handle.name
          && registration.owner.sessionName === registration.handle.name
          && previous.handle.name === registration.handle.name) {
          let timeout: number | undefined;
          const liveIdentity = await Promise.race([
            this.resolveTmuxIdentity(registration.handle.name).catch(() => undefined),
            new Promise<undefined>((resolve) => {
              timeout = globalThis.setTimeout(resolve, this.tmuxIdentityTimeoutMs);
            }),
          ]).finally(() => {
            if (timeout) globalThis.clearTimeout(timeout);
          });
          replacesStaleTmuxOwner = Boolean(liveIdentity
            && liveIdentity.paneId === registration.handle.paneId
            && liveIdentity.sessionInstanceId === registration.owner.sessionInstanceId
            && liveIdentity.runtimeEpoch === registration.owner.runtimeEpoch);
        }
        if (!sameLogicalTmuxOwner && !replacesStaleTmuxOwner) {
          throw new Error('session_resource_owner_conflict');
        }
      }
      const now = this.now();
      let handle = registration.handle;
      if (handle.type === SESSION_RESOURCE_HANDLE_TYPE.PID && handle.processStart === undefined) {
        handle = { ...handle, processStart: await readProcessStart(handle.pid) };
      }
      if (this.requiresStrongHandles && handle.type === SESSION_RESOURCE_HANDLE_TYPE.PID && !handle.processStart) {
        throw new Error('session_resource_process_identity_unavailable');
      }
      if (this.requiresStrongHandles && handle.type === SESSION_RESOURCE_HANDLE_TYPE.TMUX && !handle.paneId) {
        throw new Error('session_resource_tmux_identity_unavailable');
      }
      if (this.requiresStrongHandles && handle.type === SESSION_RESOURCE_HANDLE_TYPE.PODMAN
        && !/^[a-f0-9]{12,64}$/i.test(handle.containerId)) {
        throw new Error('session_resource_container_identity_unavailable');
      }
      const record: SessionResourceRecord = {
        ...registration,
        handle,
        version: RECORD_VERSION,
        createdAt: previous && !replacesStaleTmuxOwner ? previous.createdAt : now,
        lastUsedAt: now,
      };
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      return record;
    });
  }

  async touch(resourceId: string): Promise<boolean> {
    return this.serialized(async () => {
      const path = this.pathFor(resourceId);
      let record: SessionResourceRecord | null;
      try {
        record = parseRecord(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (!record || record.resourceId !== resourceId) return false;
      record.lastUsedAt = this.now();
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      return true;
    });
  }

  private async releaseRecords(records: SessionResourceRecord[], reason: string): Promise<ReleaseSummary> {
    let released = 0;
    let failed = 0;
    for (const record of records) {
      try {
        await this.cleanup(record, reason);
        await rm(this.pathFor(record.resourceId), { force: true });
        released += 1;
      } catch {
        failed += 1;
      }
    }
    return { released, failed };
  }

  async releaseOwner(owner: SessionResourceOwner, reason: string): Promise<ReleaseSummary> {
    if (!validOwner(owner) || !boundedString(reason)) throw new Error('invalid_session_resource_release');
    return this.serialized(async () => {
      const key = ownerKey(owner);
      return this.releaseRecords((await this.listUnlocked()).filter((record) => ownerKey(record.owner) === key), reason);
    });
  }

  async releaseOwnerKinds(
    owner: SessionResourceOwner,
    kinds: readonly SessionResourceKind[],
    reason: string,
  ): Promise<ReleaseSummary> {
    if (!validOwner(owner) || !boundedString(reason) || kinds.length === 0 || !kinds.every(validKind)) {
      throw new Error('invalid_session_resource_release');
    }
    return this.serialized(async () => {
      const key = ownerKey(owner);
      const selected = new Set(kinds);
      return this.releaseRecords(
        (await this.listUnlocked()).filter((record) => ownerKey(record.owner) === key && selected.has(record.kind)),
        reason,
      );
    });
  }

  async releaseResourceIdPrefixes(prefixes: readonly string[], reason: string): Promise<ReleaseSummary> {
    if (prefixes.length === 0 || !prefixes.every(boundedString) || !boundedString(reason)) {
      throw new Error('invalid_session_resource_release');
    }
    return this.serialized(async () => this.releaseRecords(
      (await this.listUnlocked()).filter((record) => prefixes.some((prefix) => record.resourceId.startsWith(prefix))),
      reason,
    ));
  }

  async releaseResource(resourceId: string, owner: SessionResourceOwner, reason: string): Promise<ReleaseSummary> {
    if (!boundedString(resourceId) || !validOwner(owner) || !boundedString(reason)) {
      throw new Error('invalid_session_resource_release');
    }
    return this.serialized(async () => {
      const key = ownerKey(owner);
      const record = (await this.listUnlocked()).find((candidate) => candidate.resourceId === resourceId);
      if (!record) return { released: 0, failed: 0 };
      if (ownerKey(record.owner) !== key) throw new Error('session_resource_owner_mismatch');
      return this.releaseRecords([record], reason);
    });
  }

  async sweepOrphans(activeOwners: readonly SessionResourceOwner[]): Promise<OrphanSweepSummary> {
    if (!activeOwners.every(validOwner)) throw new Error('invalid_session_resource_owner');
    return this.serialized(async () => {
      const active = new Set(activeOwners.map(ownerKey));
      const records = await this.listUnlocked();
      const invalidPidResources = new Set((await Promise.all(records.map(async (record) => {
        if (record.handle.type !== SESSION_RESOURCE_HANDLE_TYPE.PID || !record.handle.processStart) return null;
        const currentStart = await readProcessStart(record.handle.pid);
        return currentStart === record.handle.processStart ? null : record.resourceId;
      }))).filter((resourceId): resourceId is string => resourceId !== null));
      const orphans = records.filter((record) => (
        !active.has(ownerKey(record.owner)) || invalidPidResources.has(record.resourceId)
      ));
      const result = await this.releaseRecords(orphans, SESSION_RESOURCE_RELEASE_REASON.ORPHANED);
      return { ...result, preserved: records.length - orphans.length };
    });
  }

  async sweepExpired(): Promise<ReleaseSummary> {
    return this.serialized(async () => {
      const now = this.now();
      const records = (await this.listUnlocked()).filter((record) => {
        if (record.kind !== SESSION_RESOURCE_KIND.BROWSER && record.kind !== SESSION_RESOURCE_KIND.CONTAINER) return false;
        return (record.ttlMs !== undefined && now - record.createdAt > record.ttlMs)
          || (record.idleTimeoutMs !== undefined && now - record.lastUsedAt > record.idleTimeoutMs);
      });
      return this.releaseRecords(records, records.some((record) => record.ttlMs !== undefined && now - record.createdAt > record.ttlMs)
        ? SESSION_RESOURCE_RELEASE_REASON.TTL_EXPIRED
        : SESSION_RESOURCE_RELEASE_REASON.IDLE_EXPIRED);
    });
  }
}
