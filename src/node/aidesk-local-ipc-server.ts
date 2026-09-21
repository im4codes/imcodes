import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  AIDESK_LOCAL_IPC,
  AIDESK_LOCAL_IPC_ACCESS_STATE,
  AIDESK_LOCAL_IPC_ERROR,
  AIDESK_LOCAL_IPC_MESSAGE,
  AIDESK_LOCAL_IPC_SERVICE_STATE,
  AideskLocalIpcFrameDecoder,
  encodeAideskLocalIpcFrame,
  type AideskLocalIpcAction,
  type AideskLocalIpcBootstrap,
  type AideskLocalIpcHello,
  type AideskLocalIpcRefresh,
  type AideskLocalIpcSnapshot,
} from '../../shared/aidesk-local-ipc.js';
import {
  REMOTE_DESKTOP_LOCAL_ACTION,
  type RemoteDesktopLocalStatus,
} from '../../shared/remote-desktop-local-management.js';
import { defaultCredentialPath } from './enrollment.js';
import { windowsPowerShellExecutablePath } from './installer.js';

const MAX_REPLAY_ENTRIES = 128;
const MAX_PENDING_ACTIONS = 32;
const MAX_SAFE_STRING_BYTES = 512;

export interface AideskLocalIpcServerOptions {
  publicNodeId: string;
  runtimeVersion: string;
  productVersion: string;
  status(): Omit<RemoteDesktopLocalStatus, 'publicNodeId'>;
  setPaused(paused: boolean): Promise<void>;
  stopAll(): Promise<void>;
  disconnect(connectionId: string): Promise<boolean>;
  platform?: NodeJS.Platform;
  endpoint?: string;
  bootstrapPath?: string;
  now?: () => number;
  randomSecret?: () => string;
  refreshIntervalMs?: number;
  capabilityTtlMs?: number;
  handshakeTimeoutMs?: number;
  /** Additional native peer-credential/signature seam. False rejects before hello. */
  authorizePeer?: (socket: Socket) => boolean | Promise<boolean>;
  /** Windows DACL seam. Production resolves the active interactive user SID. */
  hardenWindowsEndpoint?: (endpoint: string, bootstrapPath: string) => Promise<void>;
}

export interface AideskLocalIpcServer {
  readonly endpoint: string;
  readonly bootstrapPath: string;
  close(): Promise<void>;
}

interface ClientState {
  decoder: AideskLocalIpcFrameDecoder;
  authorized: boolean;
  capability: string | null;
  capabilityExpiresAt: number;
  sessionId: string | null;
  handshakeTimer: ReturnType<typeof setTimeout>;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function safeString(value: unknown, maximumBytes = MAX_SAFE_STRING_BYTES): value is string {
  return typeof value === 'string'
    && value.length > 0
    && byteLength(value) <= maximumBytes
    && !/[\0\r\n]/u.test(value);
}

function safeToken(value: unknown): value is string {
  return safeString(value, 256) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function defaultAideskLocalIpcPaths(
  platform: NodeJS.Platform = process.platform,
  credentialPath = defaultCredentialPath(),
): { endpoint: string; bootstrapPath: string } {
  const root = dirname(credentialPath);
  return {
    endpoint: platform === 'win32'
      ? AIDESK_LOCAL_IPC.WINDOWS_PIPE
      : join(root, AIDESK_LOCAL_IPC.SOCKET_FILE),
    bootstrapPath: join(root, AIDESK_LOCAL_IPC.BOOTSTRAP_FILE),
  };
}

/**
 * Builds the locale-independent Windows ACL script. It resolves the exact
 * interactive user to a SID, then permits only that SID and SYSTEM. The node
 * service never grants the Authenticated Users group for this authority pipe.
 */
export function windowsAideskLocalIpcAclScript(endpoint: string, bootstrapPath: string): string {
  const encodedEndpoint = Buffer.from(endpoint, 'utf8').toString('base64');
  const encodedBootstrap = Buffer.from(bootstrapPath, 'utf8').toString('base64');
  return String.raw`$ErrorActionPreference='Stop'
$utf8=[Text.Encoding]::UTF8
$pipe=$utf8.GetString([Convert]::FromBase64String('${encodedEndpoint}'))
$bootstrap=$utf8.GetString([Convert]::FromBase64String('${encodedBootstrap}'))
$name=(Get-CimInstance Win32_ComputerSystem).UserName
if([string]::IsNullOrWhiteSpace($name)){throw 'aidesk_local_ipc_no_interactive_user'}
$sid=([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value
$native=@'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AiDeskLocalPipeAcl {
  const uint WRITE_DAC = 0x00040000;
  const uint OPEN_EXISTING = 3;
  const uint DACL_SECURITY_INFORMATION = 0x00000004;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  public static void Apply(string pipe, byte[] descriptor) {
    IntPtr handle = CreateFileW(pipe, WRITE_DAC, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error(), "aidesk_local_ipc_pipe_open_failed");
    try {
      if (!SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, descriptor))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "aidesk_local_ipc_pipe_acl_failed");
    } finally { CloseHandle(handle); }
  }
}
'@
Add-Type -TypeDefinition $native -Language CSharp
$descriptor=New-Object System.Security.AccessControl.RawSecurityDescriptor(('D:P(A;;GA;;;SY)(A;;GA;;;'+$sid+')'))
$bytes=New-Object byte[] $descriptor.BinaryLength
$descriptor.GetBinaryForm($bytes,0)
[AiDeskLocalPipeAcl]::Apply($pipe,$bytes)
& (Join-Path $env:SystemRoot 'System32\icacls.exe') $bootstrap '/inheritance:r' '/grant:r' '*S-1-5-18:F' ('*'+$sid+':F') | Out-Null
if($LASTEXITCODE -ne 0){throw 'aidesk_local_ipc_bootstrap_acl_failed'}`;
}

export function hardenWindowsAideskLocalIpcEndpoint(
  endpoint: string,
  bootstrapPath: string,
  run: typeof execFile = execFile,
): Promise<void> {
  const script = windowsAideskLocalIpcAclScript(endpoint, bootstrapPath);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    run(windowsPowerShellExecutablePath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 15_000,
    }, (error) => error ? reject(error) : resolve());
  });
}

async function writeBootstrap(path: string, value: AideskLocalIpcBootstrap): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function removeStaleUnixSocket(endpoint: string): Promise<void> {
  const entry = await lstat(endpoint).catch(() => null);
  if (!entry) return;
  if (!entry.isSocket() || entry.isSymbolicLink()) {
    throw new Error('aidesk_local_ipc_endpoint_unsafe');
  }
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw new Error('aidesk_local_ipc_endpoint_owner_mismatch');
  }
  await rm(endpoint);
}

function canonicalConnections(
  status: Omit<RemoteDesktopLocalStatus, 'publicNodeId'>,
): readonly RemoteDesktopLocalStatus['connections'][number][] {
  return [...status.connections]
    .filter((connection) => safeToken(connection.id)
      && safeString(connection.label, 256)
      && Number.isSafeInteger(connection.connectedAt)
      && connection.connectedAt >= 0)
    .sort((left, right) => left.connectedAt - right.connectedAt || left.id.localeCompare(right.id));
}

export async function startAideskLocalIpcServer(
  options: AideskLocalIpcServerOptions,
): Promise<AideskLocalIpcServer> {
  if (!safeToken(options.publicNodeId)
    || !safeString(options.runtimeVersion, 128)
    || !safeString(options.productVersion, 128)) {
    throw new Error('aidesk_local_ipc_options_invalid');
  }
  const platform = options.platform ?? process.platform;
  const defaults = defaultAideskLocalIpcPaths(platform);
  const endpoint = options.endpoint ?? defaults.endpoint;
  const bootstrapPath = options.bootstrapPath ?? defaults.bootstrapPath;
  const now = options.now ?? Date.now;
  const randomSecret = options.randomSecret ?? (() => randomBytes(32).toString('base64url'));
  const bootstrapSecret = randomSecret();
  if (!safeToken(bootstrapSecret)) throw new Error('aidesk_local_ipc_secret_invalid');
  const capabilityTtlMs = options.capabilityTtlMs ?? AIDESK_LOCAL_IPC.CAPABILITY_TTL_MS;
  const clients = new Map<Socket, ClientState>();
  let closed = false;
  let endpointReady = false;
  let revision = 1;
  let lastFingerprint = '';
  let mutationTail: Promise<void> = Promise.resolve();
  // Request IDs are UI-operation authorities, not connection-local sequence
  // numbers. Keep them across reconnects so losing a pipe after the runtime
  // applied an action cannot turn the retry into a second mutation.
  const replays = new Map<string, { signature: string; response: Record<string, unknown> }>();
  const inFlight = new Map<string, { signature: string; response: Promise<Record<string, unknown>> }>();
  const rememberReplay = (
    requestId: string,
    signature: string,
    response: Record<string, unknown>,
  ): void => {
    replays.set(requestId, { signature, response });
    while (replays.size > MAX_REPLAY_ENTRIES) {
      const oldest = replays.keys().next().value as string | undefined;
      if (!oldest) break;
      replays.delete(oldest);
    }
  };

  const currentStatus = (): Omit<RemoteDesktopLocalStatus, 'publicNodeId'> => {
    const status = options.status();
    return { paused: status.paused === true, connections: canonicalConnections(status) };
  };
  const fingerprint = (status: Omit<RemoteDesktopLocalStatus, 'publicNodeId'>): string => (
    JSON.stringify({ paused: status.paused, connections: status.connections })
  );
  const snapshot = (): AideskLocalIpcSnapshot => {
    const status = currentStatus();
    const nextFingerprint = fingerprint(status);
    if (lastFingerprint && nextFingerprint !== lastFingerprint) revision += 1;
    lastFingerprint = nextFingerprint;
    return {
      type: AIDESK_LOCAL_IPC_MESSAGE.SNAPSHOT,
      protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
      revision,
      publicNodeId: options.publicNodeId,
      serviceState: AIDESK_LOCAL_IPC_SERVICE_STATE.READY,
      accessState: status.paused
        ? AIDESK_LOCAL_IPC_ACCESS_STATE.PAUSED
        : AIDESK_LOCAL_IPC_ACCESS_STATE.READY,
      paused: status.paused,
      connections: status.connections.map((connection) => ({
        ...connection,
        durationMs: Math.max(0, now() - connection.connectedAt),
      })),
    };
  };
  snapshot();

  const send = (socket: Socket, value: unknown): void => {
    if (!socket.destroyed) socket.write(encodeAideskLocalIpcFrame(value));
  };
  const reject = (socket: Socket, code: string, close = false): void => {
    send(socket, {
      type: AIDESK_LOCAL_IPC_MESSAGE.ERROR,
      protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
      error: code,
    });
    if (close) socket.end();
  };
  const hasCapability = (state: ClientState, value: unknown): value is string => (
    typeof value === 'string'
      && state.capability !== null
      && state.capabilityExpiresAt > now()
      && secureEqual(value, state.capability)
  );

  const performAction = async (
    action: AideskLocalIpcAction,
  ): Promise<Record<string, unknown>> => {
    let error: string | undefined;
    try {
      if (action.action === REMOTE_DESKTOP_LOCAL_ACTION.PAUSE) {
        await options.setPaused(true);
      } else if (action.action === REMOTE_DESKTOP_LOCAL_ACTION.RESUME) {
        await options.setPaused(false);
      } else if (action.action === REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL) {
        await options.stopAll();
      } else if (action.action === REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT
        && safeToken(action.connectionId)) {
        if (!await options.disconnect(action.connectionId)) error = AIDESK_LOCAL_IPC_ERROR.NOT_FOUND;
      } else {
        error = AIDESK_LOCAL_IPC_ERROR.INVALID_ACTION;
      }
    } catch {
      error = AIDESK_LOCAL_IPC_ERROR.ACTION_FAILED;
    }
    const current = snapshot();
    return {
      type: AIDESK_LOCAL_IPC_MESSAGE.ACK,
      protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
      requestId: action.requestId,
      ok: error === undefined,
      appliedRevision: current.revision,
      ...(error ? { error } : {}),
    };
  };

  const onFrame = async (socket: Socket, state: ClientState, frame: unknown): Promise<void> => {
    if (!isRecord(frame)) return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME, true);
    if (!state.authorized) return reject(socket, AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED, true);
    if (state.capability === null) {
      const hello = frame as Partial<AideskLocalIpcHello>;
      if (hello.type !== AIDESK_LOCAL_IPC_MESSAGE.HELLO
        || hello.protocolVersion !== AIDESK_LOCAL_IPC.PROTOCOL_VERSION) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.VERSION_MISMATCH, true);
      }
      if (!hasExactKeys(frame, [
        'type', 'protocolVersion', 'bootstrapSecret', 'clientNonce', 'uiVersion', 'productVersion',
      ])) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME, true);
      }
      if (!safeToken(hello.bootstrapSecret)
        || !secureEqual(hello.bootstrapSecret, bootstrapSecret)
        || !safeToken(hello.clientNonce)
        || !safeString(hello.uiVersion, 128)
        || !safeString(hello.productVersion, 128)) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED, true);
      }
      if (hello.productVersion !== options.productVersion) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.VERSION_MISMATCH, true);
      }
      clearTimeout(state.handshakeTimer);
      state.capability = randomSecret();
      state.capabilityExpiresAt = now() + capabilityTtlMs;
      state.sessionId = randomUUID();
      send(socket, {
        type: AIDESK_LOCAL_IPC_MESSAGE.WELCOME,
        protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
        runtimeVersion: options.runtimeVersion,
        productVersion: options.productVersion,
        sessionId: state.sessionId,
        capability: state.capability,
        capabilityExpiresAt: state.capabilityExpiresAt,
        snapshot: snapshot(),
      });
      return;
    }
    if (frame.protocolVersion !== AIDESK_LOCAL_IPC.PROTOCOL_VERSION) {
      return reject(socket, AIDESK_LOCAL_IPC_ERROR.VERSION_MISMATCH, true);
    }
    if (!hasCapability(state, frame.capability)) {
      return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_CAPABILITY);
    }
    if (frame.type === AIDESK_LOCAL_IPC_MESSAGE.REFRESH) {
      const refresh = frame as Partial<AideskLocalIpcRefresh>;
      if (!hasExactKeys(frame, ['type', 'protocolVersion', 'requestId', 'capability'])
        || !safeToken(refresh.requestId)) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME);
      }
      send(socket, snapshot());
      return;
    }
    if (frame.type !== AIDESK_LOCAL_IPC_MESSAGE.ACTION) {
      return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME);
    }
    const action = frame as unknown as AideskLocalIpcAction;
    if (!hasExactKeys(frame, [
      'type', 'protocolVersion', 'requestId', 'capability', 'expectedRevision', 'action',
    ], ['connectionId'])
      || !safeToken(action.requestId)
      || !Number.isSafeInteger(action.expectedRevision)
      || action.expectedRevision <= 0
      || !safeString(action.action, 64)) {
      return reject(socket, AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME);
    }
    const signature = createHash('sha256').update(JSON.stringify({
      expectedRevision: action.expectedRevision,
      action: action.action,
      connectionId: action.connectionId ?? null,
    })).digest('hex');
    const replay = replays.get(action.requestId);
    if (replay) {
      if (replay.signature !== signature) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.REQUEST_CONFLICT);
      }
      send(socket, replay.response);
      return;
    }
    const pending = inFlight.get(action.requestId);
    if (pending) {
      if (pending.signature !== signature) {
        return reject(socket, AIDESK_LOCAL_IPC_ERROR.REQUEST_CONFLICT);
      }
      send(socket, await pending.response);
      return;
    }
    if (inFlight.size >= MAX_PENDING_ACTIONS) {
      return reject(socket, AIDESK_LOCAL_IPC_ERROR.ACTION_FAILED);
    }
    const before = snapshot();
    if (action.expectedRevision !== before.revision) {
      const response = {
        type: AIDESK_LOCAL_IPC_MESSAGE.ACK,
        protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
        requestId: action.requestId,
        ok: false,
        appliedRevision: before.revision,
        error: AIDESK_LOCAL_IPC_ERROR.STALE_REVISION,
      };
      rememberReplay(action.requestId, signature, response);
      send(socket, response);
      send(socket, before);
      return;
    }
    const operation: Promise<Record<string, unknown>> = mutationTail.then(async () => {
      // Recheck after waiting behind a concurrent action.
      const live = snapshot();
      if (live.revision !== action.expectedRevision) {
        return {
          type: AIDESK_LOCAL_IPC_MESSAGE.ACK,
          protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
          requestId: action.requestId,
          ok: false,
          appliedRevision: live.revision,
          error: AIDESK_LOCAL_IPC_ERROR.STALE_REVISION,
        };
      }
      return await performAction(action);
    });
    // Publish the promise before awaiting it: retries can arrive in the same
    // stream chunk or on a second UI event-loop turn while the runtime action
    // is still pending. They must join the first authority operation rather
    // than execute twice or spuriously observe a stale revision.
    inFlight.set(action.requestId, { signature, response: operation });
    mutationTail = operation.then(() => undefined, () => undefined);
    const response = await operation.finally(() => {
      inFlight.delete(action.requestId);
    });
    rememberReplay(action.requestId, signature, response);
    send(socket, response);
    send(socket, snapshot());
  };

  if (platform !== 'win32') await removeStaleUnixSocket(endpoint);
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.pause();
    const state: ClientState = {
      decoder: new AideskLocalIpcFrameDecoder(),
      authorized: false,
      capability: null,
      capabilityExpiresAt: 0,
      sessionId: null,
      handshakeTimer: setTimeout(() => {
        reject(socket, AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED, true);
      }, options.handshakeTimeoutMs ?? AIDESK_LOCAL_IPC.HANDSHAKE_TIMEOUT_MS),
    };
    state.handshakeTimer.unref?.();
    clients.set(socket, state);
    socket.once('close', () => {
      clearTimeout(state.handshakeTimer);
      clients.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of state.decoder.push(chunk)) {
          void onFrame(socket, state, frame).catch(() => {
            reject(socket, AIDESK_LOCAL_IPC_ERROR.ACTION_FAILED, true);
          });
        }
      } catch (error) {
        reject(socket, error instanceof Error ? error.message : AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME, true);
      }
    });
    void Promise.resolve(endpointReady && (options.authorizePeer?.(socket) ?? true)).then((authorized) => {
      if (socket.destroyed) return;
      if (!authorized) {
        reject(socket, AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED, true);
        return;
      }
      state.authorized = true;
      socket.resume();
    }, () => reject(socket, AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED, true));
  });
  server.maxConnections = 4;
  await listen(server, endpoint);
  try {
    if (platform !== 'win32') {
      await chmod(endpoint, 0o600);
      const endpointStat = await lstat(endpoint);
      if (!endpointStat.isSocket()
        || (endpointStat.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && endpointStat.uid !== process.getuid())) {
        throw new Error('aidesk_local_ipc_endpoint_unsafe');
      }
    }
    await writeBootstrap(bootstrapPath, {
      version: 1,
      protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
      endpoint,
      bootstrapSecret,
      runtimeVersion: options.runtimeVersion,
      productVersion: options.productVersion,
    });
    if (platform === 'win32') {
      await (options.hardenWindowsEndpoint ?? hardenWindowsAideskLocalIpcEndpoint)(
        endpoint,
        bootstrapPath,
      );
    }
    endpointReady = true;
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
    await rm(bootstrapPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const interval = setInterval(() => {
    if (closed) return;
    const before = revision;
    const current = snapshot();
    if (current.revision === before) return;
    for (const [socket, state] of clients) {
      if (state.capability && state.capabilityExpiresAt > now()) send(socket, current);
    }
  }, options.refreshIntervalMs ?? AIDESK_LOCAL_IPC.REFRESH_INTERVAL_MS);
  interval.unref?.();

  return {
    endpoint,
    bootstrapPath,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const [socket, state] of clients) {
        clearTimeout(state.handshakeTimer);
        socket.destroy();
      }
      await closeServer(server);
      await rm(bootstrapPath, { force: true });
      if (platform !== 'win32') await rm(endpoint, { force: true });
    },
  };
}

/** Read-only helper for the C++ UI launcher and integration tests. */
export async function readAideskLocalIpcBootstrap(path: string): Promise<AideskLocalIpcBootstrap> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('aidesk_local_ipc_bootstrap_unsafe');
  if (process.platform !== 'win32' && ((entry.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid()))) {
    throw new Error('aidesk_local_ipc_bootstrap_unsafe');
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as Partial<AideskLocalIpcBootstrap>;
  if (value.version !== 1
    || value.protocolVersion !== AIDESK_LOCAL_IPC.PROTOCOL_VERSION
    || !safeString(value.endpoint, 512)
    || !safeToken(value.bootstrapSecret)
    || !safeString(value.runtimeVersion, 128)
    || !safeString(value.productVersion, 128)) {
    throw new Error('aidesk_local_ipc_bootstrap_invalid');
  }
  return value as AideskLocalIpcBootstrap;
}
