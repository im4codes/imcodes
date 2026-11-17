import net from 'node:net';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveImcodesHome, windowsDaemonLockPipeName } from '../util/windows-daemon-lock.js';
import {
  daemonProcessAppearsRunning as daemonProcessAppearsRunningWithProbe,
  isReapedProcessState,
  linuxProcStatLiveness,
  ownerRemainsAuthoritative,
  probeProcessLivenessWithExec,
  psLiveness,
  readInstanceLockMetadata as readInstanceLockMetadataFromPath,
  type ProcessLiveness,
} from './daemon-lock-identity.mjs';

export { WINDOWS_DAEMON_LOCK_PIPE, normalizeWindowsLockPath, resolveImcodesHome, resolveWindowsDefaultHome, windowsDaemonLockPipeName } from '../util/windows-daemon-lock.js';
export { isReapedProcessState, linuxProcStatLiveness, ownerRemainsAuthoritative, psLiveness, type ProcessLiveness } from './daemon-lock-identity.mjs';

export interface DaemonProcessIdentity {
  pid: number;
  startToken: string;
}

export interface InstanceLockMetadata extends DaemonProcessIdentity {
  version: 1;
  acquiredAt: number;
  socketPath: string;
  sessionIds: string[];
  residualResources: string[];
}

export interface InstanceLockHandle {
  server: net.Server;
  socketPath: string;
  metadataPath: string;
  pidPath: string;
  identity: DaemonProcessIdentity;
  metadata: InstanceLockMetadata;
  released: boolean;
}

export interface AcquireInstanceLockOptions {
  socketPath?: string;
  metadataPath?: string;
  pidPath?: string;
  currentIdentity?: DaemonProcessIdentity;
  probeProcessStartToken?: (pid: number) => string | null;
  /** Fail-closed liveness seam. Takes precedence over `probeProcessStartToken`. */
  probeProcessLiveness?: (pid: number) => ProcessLiveness;
  connectTimeoutMs?: number;
}

export class DaemonInstanceLockError extends Error {
  constructor(
    public readonly code: 'DAEMON_ALREADY_RUNNING' | 'DAEMON_LOCK_OWNER_UNREACHABLE',
    public readonly owner: InstanceLockMetadata | null,
    detail: string,
  ) {
    super(detail);
    this.name = 'DaemonInstanceLockError';
  }
}

const fallbackCurrentStartToken = `runtime:${Date.now() - Math.floor(process.uptime() * 1_000)}`;

export type LinuxProcStatLiveness = ProcessLiveness;

export function probeProcessLiveness(pid: number): ProcessLiveness {
  return probeProcessLivenessWithExec(
    pid,
    process.platform,
    (file, args, options) => execFileSync(file, args, options),
  );
}

/** Back-compatible string probe. `null` means "not the recorded process"; callers
 *  needing the fail-closed distinction must use {@link probeProcessLiveness}. */
export function probeProcessStartToken(pid: number): string | null {
  const liveness = probeProcessLiveness(pid);
  return liveness.status === 'alive' ? liveness.startToken : null;
}

export function currentDaemonProcessIdentity(): DaemonProcessIdentity {
  return {
    pid: process.pid,
    startToken: probeProcessStartToken(process.pid) ?? fallbackCurrentStartToken,
  };
}

/**
 * Whether a PID may still be presented as a running daemon.
 *
 * `kill(pid, 0)` succeeds for a zombie and systemd keeps publishing a non-zero
 * `MainPID` while a unit is falsely active, so both of those signals report a
 * reaped daemon as running. Only positive proof of death (`absent` or a Z/X/x
 * state) answers `false`; `unknown` stays `true` so a process that merely cannot
 * be inspected — notably Windows cross-security-context daemons — is not
 * mislabelled as stopped.
 */
export function daemonProcessAppearsRunning(
  pid: number,
  probe: (pid: number) => ProcessLiveness = probeProcessLiveness,
): boolean {
  return daemonProcessAppearsRunningWithProbe(pid, probe);
}

export function readInstanceLockMetadata(metadataPath = join(resolveImcodesHome(), 'daemon.lock.json')): InstanceLockMetadata | null {
  return readInstanceLockMetadataFromPath(metadataPath) as InstanceLockMetadata | null;
}

export function isRecordedProcessIdentityCurrent(
  owner: Pick<DaemonProcessIdentity, 'pid' | 'startToken'>,
  probe: (pid: number) => string | null = probeProcessStartToken,
): boolean {
  // Preserved string-probe seam. The real default probe routes through
  // `probeProcessLiveness`, so production callers inherit fail-closed behaviour;
  // an injected string probe keeps its historical `null` = reclaimable meaning.
  if (probe === probeProcessStartToken) {
    return ownerRemainsAuthoritative(owner, probeProcessLiveness(owner.pid));
  }
  return probe(owner.pid) === owner.startToken;
}

function sameIdentity(a: DaemonProcessIdentity, b: DaemonProcessIdentity): boolean {
  return a.pid === b.pid && a.startToken === b.startToken;
}

function writeMetadata(path: string, metadata: InstanceLockMetadata): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function removePath(path: string): void {
  try { unlinkSync(path); } catch { /* absent or owned elsewhere */ }
}

interface ReclaimGuard {
  fd: number;
  path: string;
  identity: DaemonProcessIdentity;
}

function readGuardIdentity(path: string): DaemonProcessIdentity | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonProcessIdentity>;
    return Number.isSafeInteger(value.pid) && (value.pid ?? 0) > 0
      && typeof value.startToken === 'string' && value.startToken
      ? { pid: value.pid!, startToken: value.startToken }
      : null;
  } catch {
    return null;
  }
}

async function acquireReclaimGuard(
  path: string,
  identity: DaemonProcessIdentity,
  probe: (pid: number) => ProcessLiveness,
): Promise<ReclaimGuard> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(identity)}\n`, 'utf8');
      return { fd, path, identity };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const owner = readGuardIdentity(path);
      if (!owner || !ownerRemainsAuthoritative(owner, probe(owner.pid))) {
        removePath(path);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for daemon stale-lock recovery authority at ${path}`);
}

function releaseReclaimGuard(guard: ReclaimGuard): void {
  try { closeSync(guard.fd); } catch { /* already closed */ }
  const owner = readGuardIdentity(guard.path);
  if (owner && sameIdentity(owner, guard.identity)) removePath(guard.path);
}

function formatOwner(owner: InstanceLockMetadata | null): string {
  if (!owner) return 'owner=unknown; sessions=[]; residualResources=[]';
  return `pid=${owner.pid}; startToken=${owner.startToken}; sessions=${JSON.stringify(owner.sessionIds)}; residualResources=${JSON.stringify(owner.residualResources)}`;
}

async function listen(server: net.Server, path: string): Promise<'listening' | 'in_use'> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve('in_use');
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve('listening');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function probeSocket(path: string, timeoutMs: number): Promise<{ connected: boolean; owner: InstanceLockMetadata | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let raw = '';
    const client = net.connect(path);
    const finish = () => {
      if (settled) return;
      settled = true;
      client.destroy();
      let owner: InstanceLockMetadata | null = null;
      try {
        const parsed = JSON.parse(raw) as InstanceLockMetadata;
        if (parsed.version === 1 && Number.isSafeInteger(parsed.pid) && typeof parsed.startToken === 'string') owner = parsed;
      } catch { /* legacy live socket has no identity payload */ }
      resolve({ connected, owner });
    };
    client.setEncoding('utf8');
    client.on('connect', () => { connected = true; });
    client.on('data', (chunk) => { raw += chunk; });
    client.on('end', finish);
    client.on('close', finish);
    client.on('error', finish);
    client.setTimeout(timeoutMs, finish);
  });
}

/**
 * Whether the daemon authority socket accepts a connection.
 *
 * Reuses the same probe the lock uses, so "is a daemon serving?" has exactly one
 * implementation. A reachable socket is positive proof that a daemon is alive
 * regardless of what any PID or unit state claims.
 */
export async function isAuthoritySocketReachable(
  socketPath?: string,
  timeoutMs = 500,
): Promise<boolean> {
  const authorityPath = socketPath ?? (process.platform === 'win32'
    ? windowsDaemonLockPipeName()
    : join(resolveImcodesHome(), 'daemon.sock'));
  const result = await probeSocket(authorityPath, timeoutMs);
  return result.connected;
}

export async function acquireInstanceLock(options: AcquireInstanceLockOptions = {}): Promise<InstanceLockHandle> {
  const stateHome = resolveImcodesHome({ socketPath: options.socketPath });
  const socketPath = process.platform === 'win32'
    ? windowsDaemonLockPipeName({ socketPath: options.socketPath })
    : (options.socketPath ?? join(stateHome, 'daemon.sock'));
  const metadataPath = options.metadataPath ?? (options.socketPath ? `${options.socketPath}.lock.json` : join(stateHome, 'daemon.lock.json'));
  const pidPath = options.pidPath ?? (options.socketPath ? `${metadataPath}.pid` : join(stateHome, 'daemon.pid'));
  const identity = options.currentIdentity ?? currentDaemonProcessIdentity();
  const stringProbe = options.probeProcessStartToken;
  const processProbe: (pid: number) => ProcessLiveness = options.probeProcessLiveness
    ?? (stringProbe
      // Historical string seam: `null` kept its "not the recorded process" meaning.
      ? (pid) => {
        const token = stringProbe(pid);
        return token === null ? { status: 'reclaimable', reason: 'absent' } : { status: 'alive', startToken: token };
      }
      : probeProcessLiveness);
  const connectTimeoutMs = options.connectTimeoutMs ?? 500;
  if (process.platform !== 'win32') mkdirSync(dirname(socketPath), { recursive: true });

  let metadata: InstanceLockMetadata = {
    version: 1,
    ...identity,
    acquiredAt: Date.now(),
    socketPath,
    sessionIds: [],
    residualResources: [`instance-lock:${socketPath}`],
  };
  const server = net.createServer((socket) => socket.end(`${JSON.stringify(metadata)}\n`));

  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await listen(server, socketPath);
    if (outcome === 'listening') {
      try {
        writeMetadata(metadataPath, metadata);
        writeFileSync(pidPath, String(identity.pid), { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (process.platform !== 'win32') removePath(socketPath);
        removePath(metadataPath);
        removePath(pidPath);
        throw error;
      }
      return { server, socketPath, metadataPath, pidPath, identity, metadata, released: false };
    }

    const socketOwner = await probeSocket(socketPath, connectTimeoutMs);
    const recordedOwner = socketOwner.owner ?? readInstanceLockMetadata(metadataPath);
    if (socketOwner.connected) {
      throw new DaemonInstanceLockError(
        'DAEMON_ALREADY_RUNNING',
        recordedOwner,
        `Another imcodes daemon is already running (${formatOwner(recordedOwner)}). Use 'imcodes restart' to replace that exact instance.`,
      );
    }
    if (recordedOwner && ownerRemainsAuthoritative(recordedOwner, processProbe(recordedOwner.pid))) {
      throw new DaemonInstanceLockError(
        'DAEMON_LOCK_OWNER_UNREACHABLE',
        recordedOwner,
        `Daemon lock owner is still alive but its authority socket is unreachable (${formatOwner(recordedOwner)}); refusing unsafe lock theft.`,
      );
    }
    const guard = await acquireReclaimGuard(`${metadataPath}.reclaim`, identity, processProbe);
    try {
      // Another contender may have repaired the socket between our first
      // failed probe and acquiring the recovery CAS. Re-check under authority.
      const repaired = await probeSocket(socketPath, connectTimeoutMs);
      const repairedOwner = repaired.owner ?? readInstanceLockMetadata(metadataPath);
      if (repaired.connected) {
        throw new DaemonInstanceLockError(
          'DAEMON_ALREADY_RUNNING',
          repairedOwner,
          `Another imcodes daemon is already running (${formatOwner(repairedOwner)}). Use 'imcodes restart' to replace that exact instance.`,
        );
      }
      if (repairedOwner && ownerRemainsAuthoritative(repairedOwner, processProbe(repairedOwner.pid))) {
        throw new DaemonInstanceLockError(
          'DAEMON_LOCK_OWNER_UNREACHABLE',
          repairedOwner,
          `Daemon lock owner is still alive but its authority socket is unreachable (${formatOwner(repairedOwner)}); refusing unsafe lock theft.`,
        );
      }
      if (process.platform !== 'win32') removePath(socketPath);
      removePath(metadataPath);
    } finally {
      releaseReclaimGuard(guard);
    }
  }

  throw new Error(`Failed to acquire daemon instance lock at ${socketPath} after stale-owner cleanup`);
}

export function updateInstanceLockDiagnostics(
  handle: InstanceLockHandle,
  diagnostics: Pick<InstanceLockMetadata, 'sessionIds' | 'residualResources'>,
): void {
  if (handle.released) throw new Error('Cannot update a released daemon instance lock');
  const current = readInstanceLockMetadata(handle.metadataPath);
  if (!current || !sameIdentity(current, handle.identity)) {
    throw new Error('Daemon instance lock metadata ownership changed; refusing overwrite');
  }
  // Preserve the object captured by the socket responder so live probes see
  // the same diagnostics that were durably written to disk.
  handle.metadata.sessionIds = [...new Set(diagnostics.sessionIds)].sort();
  handle.metadata.residualResources = [...new Set(diagnostics.residualResources)].sort();
  writeMetadata(handle.metadataPath, handle.metadata);
}

export async function releaseInstanceLock(handle: InstanceLockHandle): Promise<void> {
  if (handle.released) return;
  handle.released = true;
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  const current = readInstanceLockMetadata(handle.metadataPath);
  if (!current || !sameIdentity(current, handle.identity)) return;
  if (process.platform !== 'win32') removePath(handle.socketPath);
  removePath(handle.metadataPath);
  try {
    if (Number.parseInt(readFileSync(handle.pidPath, 'utf8').trim(), 10) === handle.identity.pid) {
      removePath(handle.pidPath);
    }
  } catch { /* missing or foreign PID file */ }
}
