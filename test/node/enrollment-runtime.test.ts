import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { markServiceHealthy } from '../../src/node/bootstrap.js';
import { encodeEnrollmentBlob, parseEnrollmentBlob } from '../../src/node/enrollment.js';
import { loadInstallJournal } from '../../src/node/install-journal.js';
import { createControlledNodeRuntime, isControlledNodeAuthAck } from '../../src/node/runtime.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

const temporaryDirs: string[] = [];
afterEach(async () => {
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
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { onAuthenticated });
    runtime.start();
    socket.open();
    const authFrame = JSON.parse(socket.sent[0]!);
    expect(authFrame).toMatchObject({ type: 'auth', serverId: 'controlled-1' });
    expect(authFrame.nodeRole).toBeUndefined();
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: 'heartbeat' });

    socket.emit('message', JSON.stringify({ type: 'session.send', correlationId: 'ignored', command: 'echo nope' }));
    expect(onAuthenticated).not.toHaveBeenCalled();

    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(isControlledNodeAuthAck({ type: 'heartbeat_ack' })).toBe(true);

    socket.emit('message', JSON.stringify({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId: 'exec-1', idempotencyKey: 'exec-1', command: 'printf ok', shell: 'sh' }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({
      type: DAEMON_MSG.MACHINE_EXEC_RESULT,
      correlationId: 'exec-1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
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
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      phase: 'service_registered',
      updatedAt: 6,
      installId: 'install-1',
      nodeTokenHash: 'a'.repeat(64),
      sourceExePath: '/tmp/imcodes-node-download',
      stagedExePath: '/tmp/imcodes-node',
      serverId: 'controlled-1',
      serviceName: 'imcodes-node',
      serviceReceipt: {
        name: 'imcodes-node',
        platform: 'linux',
        definitionPath: '/etc/systemd/system/imcodes-node.service',
        definitionSha256: 'b'.repeat(64),
        action: '/tmp/imcodes-node',
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
      onAuthenticated: () => markServiceHealthy(journalPath, 7, {
        isStableRuntime: () => true,
        inspectServiceState: async () => ({
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
      expect(await loadInstallJournal(journalPath)).toMatchObject({
        phase: 'service_healthy',
        serviceStartRequestedAt: 7,
        healthyAt: 7,
      });
    });
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
