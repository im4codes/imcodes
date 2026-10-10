import { once } from 'node:events';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AIDESK_LOCAL_IPC,
  AIDESK_LOCAL_IPC_ERROR,
  AIDESK_LOCAL_IPC_MESSAGE,
  AideskLocalIpcFrameDecoder,
  encodeAideskLocalIpcFrame,
  type AideskLocalIpcBootstrap,
} from '../../shared/aidesk-local-ipc.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_LOCAL_ACTION } from '../../shared/remote-desktop-local-management.js';
import {
  readAideskLocalIpcBootstrap,
  startAideskLocalIpcServer,
  windowsAideskLocalIpcAclScript,
  type AideskLocalIpcServer,
} from '../../src/node/aidesk-local-ipc-server.js';
import { applyRemoteDesktopAccessPaused, loadRemoteDesktopAccessPaused } from '../../src/node/remote-desktop-access-state.js';
import { createControlledNodeRuntime } from '../../src/node/runtime.js';

const roots: string[] = [];
const servers: AideskLocalIpcServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(overrides: Partial<Parameters<typeof startAideskLocalIpcServer>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aidesk-ipc-'));
  roots.push(root);
  const endpoint = join(root, 'a.sock');
  const bootstrapPath = join(root, 'bootstrap.json');
  const state = {
    paused: false,
    connections: [{
      id: 'connection_A1',
      label: '#1',
      connectedAt: 1_700_000_000_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    }],
  };
  const calls = { pause: 0, resume: 0, stopAll: 0, disconnect: [] as string[] };
  const server = await startAideskLocalIpcServer({
    publicNodeId: '6321982267',
    managementUrl: 'https://im.example/?aideskAction=manage',
    shareUrl: 'https://im.example/?aideskAction=share',
    runtimeVersion: '2026.9.1',
    productVersion: '2026.9.1',
    endpoint,
    bootstrapPath,
    now: () => 1_700_000_010_000,
    refreshIntervalMs: 10,
    status: () => state,
    setPaused: async (paused) => {
      calls[paused ? 'pause' : 'resume'] += 1;
      state.paused = paused;
    },
    stopAll: async () => {
      calls.stopAll += 1;
      state.connections = [];
    },
    disconnect: async (connectionId) => {
      calls.disconnect.push(connectionId);
      const before = state.connections.length;
      state.connections = state.connections.filter((entry) => entry.id !== connectionId);
      return before !== state.connections.length;
    },
    ...overrides,
  });
  servers.push(server);
  return { server, state, calls, bootstrapPath };
}

class Frames {
  private readonly decoder = new AideskLocalIpcFrameDecoder();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.queue.push(frame);
      }
    });
  }

  next(): Promise<Record<string, unknown>> {
    const existing = this.queue.shift();
    if (existing) return Promise.resolve(existing as Record<string, unknown>);
    return new Promise((resolve) => this.waiters.push((value) => resolve(value as Record<string, unknown>)));
  }
}

async function connect(server: AideskLocalIpcServer): Promise<{ socket: Socket; frames: Frames }> {
  const socket = net.createConnection(server.endpoint);
  socket.on('error', () => undefined);
  sockets.push(socket);
  await once(socket, 'connect');
  return { socket, frames: new Frames(socket) };
}

function hello(bootstrap: AideskLocalIpcBootstrap, overrides: Record<string, unknown> = {}) {
  return {
    type: AIDESK_LOCAL_IPC_MESSAGE.HELLO,
    protocolVersion: AIDESK_LOCAL_IPC.PROTOCOL_VERSION,
    bootstrapSecret: bootstrap.bootstrapSecret,
    clientNonce: 'client_nonce_123456',
    uiVersion: '1.0.0',
    productVersion: bootstrap.productVersion,
    ...overrides,
  };
}

async function authenticate(server: AideskLocalIpcServer, bootstrapPath: string) {
  const bootstrap = await readAideskLocalIpcBootstrap(bootstrapPath);
  const client = await connect(server);
  client.socket.write(encodeAideskLocalIpcFrame(hello(bootstrap)));
  const welcome = await client.frames.next();
  expect(welcome.type).toBe(AIDESK_LOCAL_IPC_MESSAGE.WELCOME);
  return { ...client, bootstrap, welcome };
}

async function nextMatching(
  frames: Frames,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let index = 0; index < 10; index += 1) {
    const value = await frames.next();
    if (predicate(value)) return value;
  }
  throw new Error('expected_ipc_frame_not_received');
}

describe('aiDesk local IPC server', () => {
  it('rejects non-web management targets before exposing them to the native UI', async () => {
    await expect(fixture({ managementUrl: 'javascript:alert(1)' })).rejects.toThrow(
      'aidesk_local_ipc_options_invalid',
    );
  });

  it('decodes fragmented/coalesced frames and rejects an oversized frame before allocating it', () => {
    const decoder = new AideskLocalIpcFrameDecoder();
    const first = encodeAideskLocalIpcFrame({ value: 1 });
    const second = encodeAideskLocalIpcFrame({ value: 2 });
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([{ value: 1 }, { value: 2 }]);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(AIDESK_LOCAL_IPC.MAX_FRAME_BYTES + 1);
    expect(() => decoder.push(oversized)).toThrow(AIDESK_LOCAL_IPC_ERROR.FRAME_TOO_LARGE);
  });

  it('binds a real 0600 UDS and returns the real runtime snapshot after capability bootstrap', async () => {
    const { server, bootstrapPath } = await fixture();
    expect((await lstat(server.endpoint)).mode & 0o777).toBe(0o600);
    expect((await lstat(bootstrapPath)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(bootstrapPath, 'utf8')) as AideskLocalIpcBootstrap;
    expect(persisted.bootstrapSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const { welcome } = await authenticate(server, bootstrapPath);
    expect(welcome).toMatchObject({
      protocolVersion: 1,
      runtimeVersion: '2026.9.1',
      productVersion: '2026.9.1',
      snapshot: {
        revision: 1,
        publicNodeId: '6321982267',
        managementUrl: 'https://im.example/?aideskAction=manage',
        shareUrl: 'https://im.example/?aideskAction=share',
        paused: false,
        connections: [{
          id: 'connection_A1',
          label: '#1',
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          durationMs: 10_000,
        }],
      },
    });
    expect(JSON.stringify(welcome)).not.toContain(persisted.bootstrapSecret);
  });

  it('rejects a peer before hello when the native peer-identity seam refuses it', async () => {
    const { server } = await fixture({ authorizePeer: () => false });
    const { frames } = await connect(server);
    await expect(frames.next()).resolves.toMatchObject({ error: AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED });
  });

  it('rejects a wrong bootstrap secret and a mismatched UI product version', async () => {
    const { server, bootstrapPath } = await fixture();
    const bootstrap = await readAideskLocalIpcBootstrap(bootstrapPath);
    const wrong = await connect(server);
    wrong.socket.write(encodeAideskLocalIpcFrame(hello(bootstrap, {
      bootstrapSecret: 'wrong_secret_1234567890',
    })));
    await expect(wrong.frames.next()).resolves.toMatchObject({ error: AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED });

    const mismatch = await connect(server);
    mismatch.socket.write(encodeAideskLocalIpcFrame(hello(bootstrap, {
      productVersion: '2026.9.2',
    })));
    await expect(mismatch.frames.next()).resolves.toMatchObject({ error: AIDESK_LOCAL_IPC_ERROR.VERSION_MISMATCH });
  });

  it('times out a silent handshake and rejects extension fields rather than weakening the protocol', async () => {
    const timed = await fixture({ handshakeTimeoutMs: 10 });
    const silent = await connect(timed.server);
    await expect(silent.frames.next()).resolves.toMatchObject({
      type: AIDESK_LOCAL_IPC_MESSAGE.ERROR,
      error: AIDESK_LOCAL_IPC_ERROR.UNAUTHORIZED,
    });

    const strict = await fixture();
    const bootstrap = await readAideskLocalIpcBootstrap(strict.bootstrapPath);
    const extended = await connect(strict.server);
    extended.socket.write(encodeAideskLocalIpcFrame({ ...hello(bootstrap), unexpected: true }));
    await expect(extended.frames.next()).resolves.toMatchObject({
      type: AIDESK_LOCAL_IPC_MESSAGE.ERROR,
      error: AIDESK_LOCAL_IPC_ERROR.INVALID_FRAME,
    });
  });

  it('requires the short-lived capability for every refresh and action', async () => {
    const { server, bootstrapPath } = await fixture();
    const { socket, frames } = await authenticate(server, bootstrapPath);
    socket.write(encodeAideskLocalIpcFrame({
      type: AIDESK_LOCAL_IPC_MESSAGE.REFRESH,
      protocolVersion: 1,
      requestId: 'refresh_123456789',
      capability: 'wrong_capability_123456789',
    }));
    await expect(frames.next()).resolves.toMatchObject({ error: AIDESK_LOCAL_IPC_ERROR.INVALID_CAPABILITY });
  });

  it('expires a capability and requires a fresh authenticated connection', async () => {
    let now = 100;
    const { server, bootstrapPath } = await fixture({ now: () => now, capabilityTtlMs: 50 });
    const { socket, frames, welcome } = await authenticate(server, bootstrapPath);
    now = 151;
    socket.write(encodeAideskLocalIpcFrame({
      type: AIDESK_LOCAL_IPC_MESSAGE.REFRESH,
      protocolVersion: 1,
      requestId: 'expired_refresh_123456',
      capability: welcome.capability,
    }));
    await expect(frames.next()).resolves.toMatchObject({
      type: AIDESK_LOCAL_IPC_MESSAGE.ERROR,
      error: AIDESK_LOCAL_IPC_ERROR.INVALID_CAPABILITY,
    });
  });

  it('makes a duplicate action idempotent and rejects the same request id with different content', async () => {
    const { server, bootstrapPath, calls } = await fixture();
    const { socket, frames, welcome } = await authenticate(server, bootstrapPath);
    const capability = welcome.capability as string;
    const action = {
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'pause_request_123456',
      capability,
      expectedRevision: 1,
      action: REMOTE_DESKTOP_LOCAL_ACTION.PAUSE,
    };
    socket.write(encodeAideskLocalIpcFrame(action));
    await expect(frames.next()).resolves.toMatchObject({ type: AIDESK_LOCAL_IPC_MESSAGE.ACK, ok: true });
    await frames.next(); // authoritative post-action snapshot
    socket.write(encodeAideskLocalIpcFrame(action));
    await expect(frames.next()).resolves.toMatchObject({ type: AIDESK_LOCAL_IPC_MESSAGE.ACK, ok: true });
    expect(calls.pause).toBe(1);

    socket.write(encodeAideskLocalIpcFrame({ ...action, action: REMOTE_DESKTOP_LOCAL_ACTION.STOP_ALL }));
    await expect(frames.next()).resolves.toMatchObject({ error: AIDESK_LOCAL_IPC_ERROR.REQUEST_CONFLICT });
    expect(calls.stopAll).toBe(0);
  });

  it('coalesces duplicate actions that arrive together while the runtime mutation is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { server, bootstrapPath, calls } = await fixture({
      setPaused: async () => {
        calls.pause += 1;
        await gate;
      },
    });
    const { socket, frames, welcome } = await authenticate(server, bootstrapPath);
    const action = {
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'concurrent_pause_123456',
      capability: welcome.capability,
      expectedRevision: 1,
      action: REMOTE_DESKTOP_LOCAL_ACTION.PAUSE,
    };
    socket.write(Buffer.concat([
      encodeAideskLocalIpcFrame(action),
      encodeAideskLocalIpcFrame(action),
    ]));
    await vi.waitFor(() => expect(calls.pause).toBe(1));
    release();
    const responses = [await frames.next(), await frames.next(), await frames.next()];
    expect(responses.filter((entry) => entry.type === AIDESK_LOCAL_IPC_MESSAGE.ACK)).toHaveLength(2);
    expect(calls.pause).toBe(1);
  });

  it('rejects an old revision after a concurrent state change', async () => {
    const { server, bootstrapPath, state, calls } = await fixture();
    const { socket, frames, welcome } = await authenticate(server, bootstrapPath);
    state.paused = true;
    const pushed = await frames.next();
    expect(pushed).toMatchObject({ type: AIDESK_LOCAL_IPC_MESSAGE.SNAPSHOT, revision: 2, paused: true });
    socket.write(encodeAideskLocalIpcFrame({
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'stale_request_123456',
      capability: welcome.capability,
      expectedRevision: 1,
      action: REMOTE_DESKTOP_LOCAL_ACTION.RESUME,
    }));
    await expect(frames.next()).resolves.toMatchObject({
      type: AIDESK_LOCAL_IPC_MESSAGE.ACK,
      ok: false,
      error: AIDESK_LOCAL_IPC_ERROR.STALE_REVISION,
      appliedRevision: 2,
    });
    expect(calls.resume).toBe(0);
  });

  it('disconnects only the selected real connection and survives reconnect', async () => {
    const { server, bootstrapPath, state, calls } = await fixture();
    state.connections.push({
      id: 'connection_B2',
      label: '#2',
      connectedAt: 1_700_000_001_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    });
    const first = await authenticate(server, bootstrapPath);
    const revision = (first.welcome.snapshot as { revision: number }).revision;
    const disconnect = {
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'disconnect_request_123456',
      capability: first.welcome.capability,
      expectedRevision: revision,
      action: REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT,
      connectionId: 'connection_A1',
    };
    first.socket.write(encodeAideskLocalIpcFrame(disconnect));
    await expect(first.frames.next()).resolves.toMatchObject({ ok: true });
    const snapshot = await first.frames.next();
    expect((snapshot.connections as Array<{ id: string }>).map(({ id }) => id)).toEqual(['connection_B2']);
    expect(calls.disconnect).toEqual(['connection_A1']);
    first.socket.destroy();

    const second = await authenticate(server, bootstrapPath);
    expect(second.welcome.capability).not.toBe(first.welcome.capability);
    expect((second.welcome.snapshot as { connections: unknown[] }).connections).toHaveLength(1);
    second.socket.write(encodeAideskLocalIpcFrame({
      ...disconnect,
      capability: second.welcome.capability,
    }));
    await expect(second.frames.next()).resolves.toMatchObject({
      type: AIDESK_LOCAL_IPC_MESSAGE.ACK,
      ok: true,
      requestId: 'disconnect_request_123456',
    });
    expect(calls.disconnect).toEqual(['connection_A1']);
  });

  it('keeps the Windows pipe ACL limited to the exact interactive SID and SYSTEM', () => {
    const script = windowsAideskLocalIpcAclScript(
      AIDESK_LOCAL_IPC.WINDOWS_PIPE,
      String.raw`C:\ProgramData\IM.codes\aidesk-local-management-v1.json`,
    );
    expect(script).toContain("Translate([Security.Principal.SecurityIdentifier]).Value");
    expect(script).toContain('SetKernelObjectSecurity');
    expect(script).toContain('RawSecurityDescriptor');
    expect(script).toContain('[AiDeskLocalPipeAcl]::Apply($pipe,$bytes)');
    expect(script).toContain("'D:P(A;;GA;;;SY)(A;;GA;;;'+$sid+')'");
    expect(script).toContain("'*S-1-5-18:F'");
    expect(script).toContain("('*'+$sid+':F')");
    expect(script).toContain("'/inheritance:r'");
    expect(script).not.toContain('$targets=@($pipe,$bootstrap)');
    expect(script).not.toContain('S-1-5-11');
    expect(script).not.toContain('Authenticated Users');
  });

  it('drives a real controlled-node runtime and durable pause gate through the IPC boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidesk-ipc-runtime-'));
    roots.push(root);
    const endpoint = join(root, 'runtime.sock');
    const bootstrapPath = join(root, 'bootstrap.json');
    const pausedPath = join(root, 'remote-desktop-access.json');
    const active = [{
      id: 'public_connection_1',
      label: 'Alice',
      connectedAt: 1_700_000_000_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    }, {
      id: 'public_connection_2',
      label: '#2',
      connectedAt: 1_700_000_001_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    }];
    let workerPaused = false;
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-runtime-test',
      nodeId: '9535523706',
      token: 'CONTROLLED_NODE_SECRET',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, (() => { throw new Error('network_not_expected'); }) as never, {
      remoteDesktopWorker: {
        available: () => true,
        handle: async () => true,
        activeConnections: () => active,
        stopConnection: async (id) => {
          const index = active.findIndex((entry) => entry.id === id);
          if (index < 0) return false;
          active.splice(index, 1);
          return true;
        },
        stopAllConnections: async () => { active.splice(0); },
        setAccessPaused: (paused) => { workerPaused = paused; },
        close: () => undefined,
      },
    });
    const server = await startAideskLocalIpcServer({
      publicNodeId: '9535523706',
      managementUrl: 'https://im.example/?aideskAction=manage',
      shareUrl: 'https://im.example/?aideskAction=share',
      runtimeVersion: '2026.9.1',
      productVersion: '2026.9.1',
      endpoint,
      bootstrapPath,
      now: () => 1_700_000_010_000,
      refreshIntervalMs: 60_000,
      status: () => runtime.remoteDesktopAccessStatus(),
      setPaused: (paused) => applyRemoteDesktopAccessPaused(
        paused,
        (next) => runtime.setRemoteDesktopAccessPaused(next),
        pausedPath,
      ),
      stopAll: () => runtime.stopAllRemoteDesktopConnections(),
      disconnect: (id) => runtime.stopRemoteDesktopConnection(id),
    });
    servers.push(server);
    const client = await authenticate(server, bootstrapPath);
    client.socket.write(encodeAideskLocalIpcFrame({
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'runtime_disconnect_123456',
      capability: client.welcome.capability,
      expectedRevision: 1,
      action: REMOTE_DESKTOP_LOCAL_ACTION.DISCONNECT,
      connectionId: 'public_connection_1',
    }));
    await expect(nextMatching(client.frames, (value) => value.type === AIDESK_LOCAL_IPC_MESSAGE.ACK))
      .resolves.toMatchObject({ ok: true });
    await expect(nextMatching(client.frames, (value) => value.type === AIDESK_LOCAL_IPC_MESSAGE.SNAPSHOT
      && Array.isArray(value.connections) && value.connections.length === 1)).resolves.toMatchObject({
      connections: [{ id: 'public_connection_2' }],
    });
    client.socket.write(encodeAideskLocalIpcFrame({
      type: AIDESK_LOCAL_IPC_MESSAGE.ACTION,
      protocolVersion: 1,
      requestId: 'runtime_pause_123456',
      capability: client.welcome.capability,
      expectedRevision: 2,
      action: REMOTE_DESKTOP_LOCAL_ACTION.PAUSE,
    }));
    await expect(nextMatching(client.frames, (value) => value.type === AIDESK_LOCAL_IPC_MESSAGE.ACK))
      .resolves.toMatchObject({ ok: true });
    await expect(nextMatching(client.frames, (value) => value.type === AIDESK_LOCAL_IPC_MESSAGE.SNAPSHOT
      && value.paused === true)).resolves.toMatchObject({ paused: true, connections: [] });
    expect(workerPaused).toBe(true);
    expect(await loadRemoteDesktopAccessPaused(pausedPath)).toBe(true);
  });
});
