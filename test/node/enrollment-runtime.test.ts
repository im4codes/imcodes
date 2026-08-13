import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from '../../shared/transport/file-transfer.js';
import { markServiceHealthy } from '../../src/node/bootstrap.js';
import { encodeEnrollmentBlob, parseEnrollmentBlob } from '../../src/node/enrollment.js';
import { loadInstallJournal } from '../../src/node/install-journal.js';
import { createControlledNodeRuntime, isControlledNodeAuthAck } from '../../src/node/runtime.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';
import {
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_ERROR,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
} from '../../shared/machine-direct-file-transfer.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
} from '../../shared/remote-desktop.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from '../../shared/controlled-node-service.js';

const { receiveMachineDirectUploadMock, sendMachineDirectFetchMock } = vi.hoisted(() => ({
  receiveMachineDirectUploadMock: vi.fn(),
  sendMachineDirectFetchMock: vi.fn(),
}));

vi.mock('../../src/daemon/machine-direct-transfer.js', () => ({
  receiveMachineDirectUpload: receiveMachineDirectUploadMock,
  sendMachineDirectFetch: sendMachineDirectFetchMock,
}));

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

const temporaryDirs: string[] = [];
const originalRemoteDesktopEnabled = process.env.IMCODES_REMOTE_DESKTOP_ENABLED;
afterEach(async () => {
  if (originalRemoteDesktopEnabled === undefined) delete process.env.IMCODES_REMOTE_DESKTOP_ENABLED;
  else process.env.IMCODES_REMOTE_DESKTOP_ENABLED = originalRemoteDesktopEnabled;
  vi.restoreAllMocks();
  receiveMachineDirectUploadMock.mockReset();
  sendMachineDirectFetchMock.mockReset();
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('controlled node enrollment and runtime', () => {
  it('round-trips an enrollment blob appended to arbitrary executable bytes', () => {
    const encoded = encodeEnrollmentBlob({ serverUrl: 'https://im.example/', enrollToken: 'once-123' });
    expect(parseEnrollmentBlob(Buffer.concat([Buffer.from('binary-prefix'), encoded]))).toEqual({
      serverUrl: 'https://im.example',
      enrollToken: 'once-123',
    });
    expect(parseEnrollmentBlob(Buffer.from('no marker'))).toBeNull();
    expect(parseEnrollmentBlob(Buffer.concat([encoded, Buffer.from('trailing-garbage')]))).toBeNull();
  });

  it('authenticates, executes only machine.exec, and returns a correlated result', async () => {
    const socket = new MockSocket();
    const onAuthenticated = vi.fn();
    const onHeartbeatAck = vi.fn();
    const cleanupLegacyUpgradeRescue = vi.fn(async () => {});
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { onAuthenticated, onHeartbeatAck, cleanupLegacyUpgradeRescue });
    runtime.start();
    socket.open();
    const authFrame = JSON.parse(socket.sent[0]!);
    expect(authFrame).toMatchObject({ type: 'auth', serverId: 'controlled-1' });
    expect(authFrame.nodeRole).toBeUndefined();
    expect(authFrame.capabilities).toEqual(expect.arrayContaining([
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
      MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
      CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY,
    ]));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: 'heartbeat', daemonVersion: expect.any(String) });

    socket.emit('message', JSON.stringify({ type: 'session.send', correlationId: 'ignored', command: 'echo nope' }));
    expect(onAuthenticated).not.toHaveBeenCalled();

    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(onHeartbeatAck).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(cleanupLegacyUpgradeRescue).toHaveBeenCalledOnce());
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(onHeartbeatAck).toHaveBeenCalledTimes(2);
    expect(cleanupLegacyUpgradeRescue).toHaveBeenCalledOnce();
    expect(isControlledNodeAuthAck({ type: 'heartbeat_ack' })).toBe(true);

    const execCommand = process.platform === 'win32' ? "[Console]::Write('ok')" : 'printf ok';
    socket.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId: 'exec-1', idempotencyKey: 'exec-1', command: execCommand }));
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(4), { timeout: 5_000 });
    const execFrames = socket.sent.slice(2).map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(execFrames).toContainEqual(expect.objectContaining({
      type: DAEMON_MSG.MACHINE_EXEC_CHUNK,
      correlationId: 'exec-1',
      seq: 0,
      stream: 'stdout',
      chunk: 'ok',
    }));
    expect(execFrames).toContainEqual(expect.objectContaining({
      type: DAEMON_MSG.MACHINE_EXEC_RESULT,
      correlationId: 'exec-1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
    }));
    runtime.stop();
  });

  it('advertises and dispatches remote desktop only through a verified worker', async () => {
    const socket = new MockSocket();
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      handle: vi.fn(async () => true),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker });
    runtime.start();
    socket.open();
    expect(JSON.parse(socket.sent[0]!).capabilities).toContain(REMOTE_DESKTOP_CAPABILITY);

    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: 'request_12345678',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      iceServers: ['stun:stun.example.test:3478'],
    };
    socket.emit('message', JSON.stringify(prepare));
    await vi.waitFor(() => expect(remoteDesktopWorker.handle).toHaveBeenCalledWith(prepare));

    socket.emit('message', JSON.stringify({ ...prepare, injected: true }));
    await Promise.resolve();
    expect(remoteDesktopWorker.handle).toHaveBeenCalledOnce();
    runtime.stop();
    expect(remoteDesktopWorker.close).toHaveBeenCalled();
  });

  it('keeps heartbeat, exec, and file transfer available when the remote-desktop kill switch is off', async () => {
    process.env.IMCODES_REMOTE_DESKTOP_ENABLED = '0';
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-rd-disabled-'));
    temporaryDirs.push(dir);
    const filePath = join(dir, 'still-available.txt');
    await writeFile(filePath, 'available');
    const socket = new MockSocket();
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      handle: vi.fn(async () => true),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker });
    runtime.start();
    socket.open();
    const authFrame = JSON.parse(socket.sent[0]!);
    expect(authFrame.capabilities).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(authFrame.capabilities).toEqual(expect.arrayContaining([
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
    ]));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: 'heartbeat' });

    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: 'request_12345678',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: ['stun:stun.example.test:3478'],
    };
    socket.emit('message', JSON.stringify(prepare));
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        reason: 'capability_unavailable',
      }),
    ));
    expect(remoteDesktopWorker.handle).not.toHaveBeenCalled();

    socket.emit('message', JSON.stringify({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'path-kill-switch',
      path: filePath,
    }));
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({
        type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
        requestId: 'path-kill-switch',
      }),
    ));
    const execCommand = process.platform === 'win32' ? "[Console]::Write('ok')" : 'printf ok';
    socket.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.MACHINE_EXEC,
      correlationId: 'exec-kill-switch',
      idempotencyKey: 'exec-kill-switch',
      command: execCommand,
    }));
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({
        type: DAEMON_MSG.MACHINE_EXEC_RESULT,
        correlationId: 'exec-kill-switch',
        ok: true,
      }),
    ), { timeout: 5_000 });
    runtime.stop();
  });

  it('handles an explicit file path without enabling directory browsing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-file-'));
    temporaryDirs.push(dir);
    const filePath = join(dir, 'report.txt');
    await writeFile(filePath, 'report');
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket);
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'path-1',
      path: filePath,
    }));
    await vi.waitFor(() => {
      const frames = socket.sent.map((raw) => JSON.parse(raw));
      expect(frames).toContainEqual(expect.objectContaining({
        type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
        requestId: 'path-1',
        attachment: expect.objectContaining({ daemonPath: expect.stringMatching(/report\.txt$/), size: 6 }),
      }));
    });
    socket.emit('message', JSON.stringify({ type: 'fs.list', requestId: 'forbidden', path: dir }));
    expect(socket.sent.some((raw) => raw.includes('forbidden'))).toBe(false);
    runtime.stop();
  });

  it('strictly validates machine-direct control and refreshes authority from the controlled-node clock', async () => {
    const receivedAt = Date.parse('2026-08-03T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(receivedAt);
    receiveMachineDirectUploadMock.mockResolvedValue({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: 'r'.repeat(32),
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED,
    });
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket);
    runtime.start();
    socket.open();
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: 'r'.repeat(32),
      clientUploadId: 'c'.repeat(32),
      capability: 'A'.repeat(43),
      candidates: [{ host: '192.168.2.145', port: 45123 }],
      originalName: 'clock-skewed.txt',
      size: 1,
      expiresAt: receivedAt - 30 * 86_400_000,
    };
    const before = socket.sent.length;
    socket.emit('message', JSON.stringify({ ...request, injected: true }));
    await Promise.resolve();
    expect(socket.sent).toHaveLength(before);

    socket.emit('message', JSON.stringify(request));
    await vi.waitFor(() => expect(receiveMachineDirectUploadMock).toHaveBeenCalledOnce());
    expect(receiveMachineDirectUploadMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.requestId,
      expiresAt: receivedAt + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    }));
    expect(socket.sent.slice(before).map((raw) => JSON.parse(raw))).toContainEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.ERROR,
      requestId: request.requestId,
      error: MACHINE_DIRECT_FILE_TRANSFER_ERROR.CONNECT_FAILED,
    });
    runtime.stop();
  });

  it('advertises reverse direct fetch and refreshes its authority before outbound sending', async () => {
    const receivedAt = Date.parse('2026-08-03T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(receivedAt);
    const requestId = 'f'.repeat(32);
    sendMachineDirectFetchMock.mockResolvedValue({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId,
      size: 4,
    });
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket);
    runtime.start();
    socket.open();
    expect(JSON.parse(socket.sent[0]!).capabilities).toContain(MACHINE_DIRECT_FILE_FETCH_CAPABILITY);
    socket.emit('message', JSON.stringify({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId,
      capability: 'B'.repeat(43),
      candidates: [{ host: '172.16.253.211', port: 45125 }],
      sourcePath: '/tmp/source.bin',
      expiresAt: receivedAt - 30 * 86_400_000,
    }));
    await vi.waitFor(() => expect(sendMachineDirectFetchMock).toHaveBeenCalledOnce());
    expect(sendMachineDirectFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      expiresAt: receivedAt + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS,
    }));
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId,
      size: 4,
    });
    runtime.stop();
  });

  it('keeps the process alive while a disconnected controlled node waits to reconnect', () => {
    const firstSocket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => firstSocket);

    runtime.start();
    firstSocket.close();

    const reconnectTimer = (runtime as unknown as {
      reconnectTimer: NodeJS.Timeout | null;
    }).reconnectTimer;
    expect(reconnectTimer).not.toBeNull();
    expect(reconnectTimer?.hasRef()).toBe(true);
    runtime.stop();
  });

  it('persists service_registered -> service_healthy after heartbeat authentication proof', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-healthy-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    const servicePath = process.platform === 'win32' ? 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe' : '/tmp/imcodes-node';
    const serviceDefinitionPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\Tasks\\imcodes-node'
      : (process.platform === 'darwin' ? '/Library/LaunchDaemons/imcodes-node.plist' : '/etc/systemd/system/imcodes-node.service');
    const servicePrincipal = process.platform === 'win32' ? 'S-1-5-18' : 'root';
    const serviceRestartPolicy = process.platform === 'darwin' ? 'keepalive' : 'on-failure';
    const onAuthenticationError = vi.fn();
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_registered',
      updatedAt: 6,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: `${servicePath}.download`,
      stagedExePath: servicePath,
      serverId: 'controlled-1',
      serviceName: 'imcodes-node',
      serviceReceipt: {
        name: 'imcodes-node',
        platform: process.platform,
        definitionPath: serviceDefinitionPath,
        definitionSha256: 'b'.repeat(64),
        action: servicePath,
      },
      cleanupStatus: 'cleaned',
    }), 'utf8');
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      onAuthenticationError,
      onAuthenticated: () => markServiceHealthy(journalPath, 7, {
        isStableRuntime: () => true,
        inspectServiceState: async () => ({
          installed: true,
          action: servicePath,
          effectiveAction: servicePath,
          loadedActionMatches: true,
          loaded: true,
          bootEnabled: true,
          principal: servicePrincipal,
          restartPolicy: serviceRestartPolicy,
          observedDefinitionSha256: 'b'.repeat(64),
          definitionMatches: true,
          runState: 'running',
          errors: [],
          raw: 'ActiveState=active',
        }),
      }),
    });
    runtime.start();
    socket.open();

    socket.emit('message', JSON.stringify({ type: 'auth_ok' }));
    expect((await loadInstallJournal(journalPath)).phase).toBe('service_registered');
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));

    await vi.waitFor(async () => {
      if (onAuthenticationError.mock.calls.length > 0) {
        throw onAuthenticationError.mock.calls[0]![0];
      }
      expect(await loadInstallJournal(journalPath)).toMatchObject({
        phase: 'service_healthy',
        serviceStartRequestedAt: 7,
        healthyAt: 7,
      });
    }, { timeout: 3_000 });
    runtime.stop();
  });

  it.each([
    ['not loaded', { loaded: false }],
    ['not boot enabled', { bootEnabled: false }],
    ['wrong principal', { principal: 'nobody' }],
    ['wrong restart policy', { restartPolicy: 'no' }],
  ] as const)('refuses service_healthy when manager posture is %s', async (_label, override) => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-service-posture-'));
    temporaryDirs.push(dir);
    const journalPath = join(dir, 'install-journal.json');
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_start_requested',
      updatedAt: 6,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: '/tmp/imcodes-node-download',
      stagedExePath: '/tmp/imcodes-node',
      serverId: 'controlled-1',
      serviceName: 'imcodes-node',
      serviceStartRequestedAt: 6,
      serviceReceipt: {
        name: 'imcodes-node',
        platform: 'linux',
        definitionPath: '/etc/systemd/system/imcodes-node.service',
        definitionSha256: 'b'.repeat(64),
        action: '/tmp/imcodes-node',
      },
    }), 'utf8');
    const inspection = {
      installed: true,
      action: '/tmp/imcodes-node',
      effectiveAction: '/tmp/imcodes-node',
      loadedActionMatches: true,
      loaded: true,
      bootEnabled: true,
      principal: 'root',
      restartPolicy: 'on-failure',
      observedDefinitionSha256: 'b'.repeat(64),
      definitionMatches: true,
      runState: 'running' as const,
      errors: [],
      raw: 'loaded',
      ...override,
    };
    await expect(markServiceHealthy(journalPath, 7, {
      isStableRuntime: () => true,
      inspectServiceState: async () => inspection,
    })).rejects.toThrow(/service_healthy refused/);
    expect((await loadInstallJournal(journalPath)).phase).toBe('service_start_requested');
  });

  it('retries a failed healthy write without overlap and deduplicates after success', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let resolveSecond!: () => void;
    const secondWrite = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const persistHealthy = vi.fn()
      .mockReturnValueOnce(firstWrite)
      .mockReturnValueOnce(secondWrite);
    const onAuthenticationError = vi.fn();
    const firstSocket = new MockSocket();
    const secondSocket = new MockSocket();
    const sockets = [firstSocket, secondSocket];
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => sockets.shift()!, { onAuthenticated: persistHealthy, onAuthenticationError });
    runtime.start();
    firstSocket.open();

    firstSocket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    firstSocket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(persistHealthy).toHaveBeenCalledOnce();

    rejectFirst(new Error('journal fsync failed'));
    await vi.waitFor(() => expect(onAuthenticationError).toHaveBeenCalledOnce());
    await Promise.resolve();
    runtime.stop();
    runtime.start();
    secondSocket.open();
    secondSocket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    secondSocket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(persistHealthy).toHaveBeenCalledTimes(2);

    resolveSecond();
    await secondWrite;
    await Promise.resolve();
    secondSocket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await Promise.resolve();
    expect(persistHealthy).toHaveBeenCalledTimes(2);
    runtime.stop();
  });
});
