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
import {
  CONTROLLED_NODE_UPGRADE_HANDOFF_TIMEOUT_MS,
  createControlledNodeRuntime,
  isControlledNodeAuthAck,
} from '../../src/node/runtime.js';
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
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import { CONTROLLED_NODE_SAFE_SELF_UPGRADE_CAPABILITY } from '../../shared/controlled-node-service.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from '../../shared/controlled-node-auto-unlock.js';
import {
  REMOTE_DESKTOP_ADAPTER_CAPABILITIES,
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_DECISION,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
  REMOTE_DESKTOP_NODE_CONTEXT_MSG,
  REMOTE_DESKTOP_SHELL_MSG,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
} from '../../src/node/remote-desktop-shell-launch.js';
import {
  WORKER_CONSENT_FRAME,
  WORKER_CONSENT_OUTCOME,
  type WorkerConsentInboundFrame,
} from '../../src/node/remote-desktop-consent-ipc.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
} from '../../shared/remote-desktop-install.js';
import { DAEMON_VERSION } from '../../src/util/version.js';
import { DAEMON_UPGRADE_BLOCK_REASON } from '../../shared/daemon-upgrade.js';

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
  it('reports one bounded blocker when a staged Windows upgrade never hands off', async () => {
    const socket = new MockSocket();
    let now = 10_000;
    const startSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      targetVersion: '2026.9.9999',
      artifactSha256: 'c'.repeat(64),
    }));
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'win32',
      arch: 'x64',
      now: () => now,
      startSelfUpgrade,
    });
    runtime.start();
    socket.open();

    socket.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      targetVersion: '2026.9.9999',
    }));
    await vi.waitFor(() => expect(startSelfUpgrade).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual({
      type: DAEMON_MSG.UPGRADING,
      targetVersion: '2026.9.9999',
      artifactSha256: 'c'.repeat(64),
    }));

    now += CONTROLLED_NODE_UPGRADE_HANDOFF_TIMEOUT_MS - 1;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(socket.sent.map(JSON.parse).filter((frame) => (
      frame.type === DAEMON_MSG.UPGRADE_BLOCKED
      && frame.reason === DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS
    ))).toHaveLength(0);

    now += 1;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS,
    }));
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(socket.sent.map(JSON.parse).filter((frame) => (
      frame.type === DAEMON_MSG.UPGRADE_BLOCKED
      && frame.reason === DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS
    ))).toHaveLength(1);
    runtime.stop();
  });

  it('does not request the Windows rescue path for a stalled non-Windows upgrade', async () => {
    const socket = new MockSocket();
    let now = 10_000;
    const startSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      targetVersion: '2026.9.9999',
      artifactSha256: 'c'.repeat(64),
    }));
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'linux',
      arch: 'x64',
      now: () => now,
      startSelfUpgrade,
    });
    runtime.start();
    socket.open();

    socket.emit('message', JSON.stringify({
      type: DAEMON_COMMAND_TYPES.DAEMON_UPGRADE,
      targetVersion: '2026.9.9999',
    }));
    await vi.waitFor(() => expect(startSelfUpgrade).toHaveBeenCalledOnce());
    now += CONTROLLED_NODE_UPGRADE_HANDOFF_TIMEOUT_MS;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    expect(socket.sent.map(JSON.parse).filter((frame) => (
      frame.type === DAEMON_MSG.UPGRADE_BLOCKED
      && frame.reason === DAEMON_UPGRADE_BLOCK_REASON.ALREADY_IN_PROGRESS
    ))).toHaveLength(0);
    runtime.stop();
  });

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
    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).toContain(REMOTE_DESKTOP_CAPABILITY);
    // Auto unlock lives in that same worker, so it is advertised with it.
    expect(advertised).toContain(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY);
    expect(advertised).not.toEqual(expect.arrayContaining([...REMOTE_DESKTOP_ADAPTER_CAPABILITIES]));
    for (const adapterCapability of REMOTE_DESKTOP_ADAPTER_CAPABILITIES) {
      expect(advertised).not.toContain(adapterCapability);
    }

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

  it('answers consent only after Server binds the canonical host and connection generation', async () => {
    const socket = new MockSocket();
    let consentSubscriber: ((frame: WorkerConsentInboundFrame) => void) | undefined;
    const workerFrames: Record<string, unknown>[] = [];
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => [REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY]),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
      onConsentFrame: vi.fn((handler: (frame: WorkerConsentInboundFrame) => void) => {
        consentSubscriber = handler;
        return () => { consentSubscriber = undefined; };
      }),
      sendConsentFrame: vi.fn(async (frame: Record<string, unknown>) => {
        workerFrames.push(frame);
        if (frame.type === WORKER_CONSENT_FRAME.SURFACE_QUERY) {
          queueMicrotask(() => consentSubscriber?.({
            type: WORKER_CONSENT_FRAME.SURFACE_STATE,
            uiAvailable: true,
            interactiveSession: true,
            protectedDesktopActive: false,
          }));
        } else if (frame.type === WORKER_CONSENT_FRAME.ASK) {
          queueMicrotask(() => consentSubscriber?.({
            type: WORKER_CONSENT_FRAME.ANSWER,
            approvalId: String(frame.approvalId),
            outcome: WORKER_CONSENT_OUTCOME.ALLOWED,
          }));
        }
        return true;
      }),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker, now: () => 1_000 });
    runtime.start();
    socket.open();
    expect((JSON.parse(socket.sent[0]!).capabilities as string[]))
      .toContain(REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY);

    const consent = (approvalId: string) => ({
      type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
      approvalId,
      hostId: 'host-00000000000000000001',
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      requesterLabel: 'Owner',
      createdAt: 1_000,
      deadlineAt: 31_000,
      daemonGeneration: 7,
    });

    // Endpoint serverId is not a canonical host and local generation zero is
    // not the Server bridge generation. No prompt may be shown by guessing.
    socket.emit('message', JSON.stringify(consent('approval-0000000000000001')));
    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: 'approval-0000000000000001',
    })));
    expect(workerFrames).toEqual([]);

    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: 'host-00000000000000000001',
      daemonGeneration: 7,
    }));
    socket.emit('message', JSON.stringify(consent('approval-0000000000000002')));
    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
      approvalId: 'approval-0000000000000002',
      decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
      daemonGeneration: 7,
    }));
    expect(workerFrames).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: WORKER_CONSENT_FRAME.SURFACE_QUERY }),
      expect.objectContaining({
        type: WORKER_CONSENT_FRAME.ASK,
        approvalId: 'approval-0000000000000002',
      }),
    ]));

    const askCount = workerFrames.filter((frame) => frame.type === WORKER_CONSENT_FRAME.ASK).length;
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE,
      daemonGeneration: 7,
    }));
    socket.emit('message', JSON.stringify(consent('approval-0000000000000003')));
    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: 'approval-0000000000000003',
    })));
    expect(workerFrames.filter((frame) => frame.type === WORKER_CONSENT_FRAME.ASK)).toHaveLength(askCount);
    runtime.stop();
  });

  it('advertises implemented adapter concerns independently and keeps missing shell/consent closed', () => {
    const socket = new MockSocket();
    const implemented = [
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ] as const;
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => implemented),
      sendConsentFrame: vi.fn(async () => false),
      sendPrivacyFrame: vi.fn(async () => false),
      onPrivacyFrame: vi.fn(() => () => {}),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
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

    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).toEqual(expect.arrayContaining([...implemented, REMOTE_DESKTOP_CAPABILITY]));
    expect(advertised).not.toContain(REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY);
    runtime.stop();
  });

  it('advertises and consumes shell launch context only with a separately verified sidecar', async () => {
    const socket = new MockSocket();
    const launch = vi.fn(async (_command: unknown) => {});
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY]),
      sendConsentFrame: vi.fn(async () => true),
      sendPrivacyFrame: vi.fn(async () => true),
      onPrivacyFrame: vi.fn(() => () => {}),
      supportsDefaultShieldedRoute: vi.fn(() => true),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example', serverId: 'controlled-1', token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      remoteDesktopWorker,
      remoteDesktopSignedShell: {
        available: () => true,
        executablePath: 'C:/Program Files/IM.codes/imcodes-remote-desktop-account-shell.exe',
        launcher: { launch },
      },
      now: () => 2_000,
    });
    runtime.start();
    socket.open();
    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).toContain(REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY);
    expect(advertised).toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);
    expect(JSON.parse(socket.sent[0]!).capabilities)
      .toContain(REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY);
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: '../not-a-canonical-host',
      daemonGeneration: 7,
    }));
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: 'host-00000000000000000001',
      daemonGeneration: 7,
    }));
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]![0]).toMatchObject({
      context: null,
      hostId: 'host-00000000000000000001',
      serverOrigin: 'https://im.example',
      args: [
        REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
        REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
        'https://im.example',
        REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG,
        'host-00000000000000000001',
      ],
    });
    expect(remoteDesktopWorker.sendPrivacyFrame).not.toHaveBeenCalled();
    expect(remoteDesktopWorker.handle).not.toHaveBeenCalled();
    const context = {
      hostId: 'host-00000000000000000001',
      launchId: 'launch-000000000000000001',
      issuedAt: 1_000,
      expiresAt: 61_000,
      endpointGeneration: 7,
    };
    for (const rejected of [
      { ...context, launchId: 'launch-000000000000000011', hostId: 'host-00000000000000000002' },
      { ...context, launchId: 'launch-000000000000000012', endpointGeneration: 8 },
      { ...context, launchId: 'launch-000000000000000013', expiresAt: 1_500 },
      { ...context, launchId: 'launch-000000000000000014', authority: 'node' },
    ]) {
      socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH, context: rejected }));
    }
    await Promise.resolve();
    expect(launch).toHaveBeenCalledOnce();
    socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH, context }));
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    expect(launch.mock.calls[1]![0]).toMatchObject({
      context,
      hostId: context.hostId,
      serverOrigin: 'https://im.example',
    });
    const boundArgs = (launch.mock.calls[1]![0] as { args: readonly string[] }).args;
    expect(boundArgs).toHaveLength(5);
    expect(boundArgs.slice(0, 4)).toEqual([
      REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
      REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
      'https://im.example',
      REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG,
    ]);
    expect(JSON.parse(Buffer.from(boundArgs[4]!, 'base64url').toString('utf8'))).toEqual(context);
    socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH, context }));
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH,
      context: { ...context, launchId: 'launch-000000000000000002', token: 'must-not-cross' },
    }));
    await Promise.resolve();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(remoteDesktopWorker.sendPrivacyFrame).not.toHaveBeenCalled();
    expect(remoteDesktopWorker.handle).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('keeps signed-shell capability closed when the sidecar trust probe fails', () => {
    const socket = new MockSocket();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example', serverId: 'controlled-1', token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      remoteDesktopWorker: {
        available: () => true,
        adapterCapabilities: () => [REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY],
        sendConsentFrame: async () => true,
        sendPrivacyFrame: async () => true,
        onPrivacyFrame: () => () => {},
        handle: async () => true,
        applyAutoUnlockSecret: async () => true,
        autoUnlockConfigured: async () => false,
        close: () => {},
      },
      remoteDesktopSignedShell: {
        available: () => { throw new Error('signature_invalid'); },
        executablePath: 'C:/untrusted-shell.exe',
        launcher: { launch: async () => {} },
      },
    });
    runtime.start();
    socket.open();
    expect(JSON.parse(socket.sent[0]!).capabilities)
      .not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);
    runtime.stop();
  });

  it('fails capture-privacy PREPARE/LEASE closed when routeGeneration is omitted or malformed', async () => {
    const socket = new MockSocket();
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => [REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY]),
      sendConsentFrame: vi.fn(async () => true),
      sendPrivacyFrame: vi.fn(async () => true),
      onPrivacyFrame: vi.fn(() => () => {}),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker, now: () => 1_000 });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: 'host-00000000000000000001',
      daemonGeneration: 7,
    }));

    const base = {
      requestId: 'request_12345678',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      leaseExpiresAt: 20_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
    };
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...base,
      expiresAt: 60_000,
      iceServers: [],
    }));
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_MSG.LEASE,
      ...base,
    }));
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...base,
      routeGeneration: '7',
      expiresAt: 60_000,
      iceServers: [],
    }));
    await vi.waitFor(() => expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: REMOTE_DESKTOP_MSG.TERMINAL, reason: REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE }),
    ])));
    expect(socket.sent.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === REMOTE_DESKTOP_MSG.TERMINAL)).toHaveLength(3);
    expect(remoteDesktopWorker.handle).not.toHaveBeenCalled();

    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...base,
      routeGeneration: 3,
      expiresAt: 60_000,
      iceServers: [],
    }));
    await vi.waitFor(() => expect(remoteDesktopWorker.handle).toHaveBeenCalledOnce());
    runtime.stop();
  });



  it('keeps legacy authenticated remote desktop usable without capture-privacy advertisement', async () => {
    const socket = new MockSocket();
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => []),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker, now: () => 1_000 });
    runtime.start();
    socket.open();

    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);

    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: 'request_12345678',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      leaseExpiresAt: 20_000,
      daemonGeneration: 7,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      expiresAt: 60_000,
      iceServers: [],
    }));
    await vi.waitFor(() => expect(remoteDesktopWorker.handle).toHaveBeenCalledOnce());
    expect(socket.sent.map((raw) => JSON.parse(raw)).filter((msg) => msg.type === REMOTE_DESKTOP_MSG.TERMINAL)).toHaveLength(0);
    runtime.stop();
  });

  it('fails a consent request closed when the declared adapter becomes unavailable', async () => {
    const socket = new MockSocket();
    const remoteDesktopWorker = {
      available: vi.fn(() => true),
      adapterCapabilities: vi.fn(() => [REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY]),
      sendConsentFrame: vi.fn(async () => false),
      onConsentFrame: vi.fn(() => () => {}),
      handle: vi.fn(async () => true),
      applyAutoUnlockSecret: vi.fn(async () => true),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, { remoteDesktopWorker, now: () => 1_000 });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT,
      hostId: 'host-00000000000000000001',
      daemonGeneration: 7,
    }));
    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
      approvalId: 'approval-0000000000000009',
      hostId: 'host-00000000000000000001',
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      requesterLabel: 'Owner',
      createdAt: 1_000,
      deadlineAt: 31_000,
      daemonGeneration: 7,
    }));

    await vi.waitFor(() => expect(socket.sent.map(JSON.parse)).toContainEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: 'approval-0000000000000009',
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.NON_INTERACTIVE_SESSION,
    }));
    expect(remoteDesktopWorker.handle).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('self-repairs a missing Windows worker even when the main version already matches', async () => {
    const socket = new MockSocket();
    let now = 10_000;
    const repairMissingRemoteDesktopWorker = vi.fn(async () => ({
      ok: true as const,
      targetVersion: 'current',
      artifactSha256: 'a'.repeat(64),
    }));
    const remoteDesktopWorker = {
      available: vi.fn(() => false),
      handle: vi.fn(async () => false),
      applyAutoUnlockSecret: vi.fn(async () => false),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'win32',
      arch: 'x64',
      remoteDesktopWorker,
      repairMissingRemoteDesktopWorker,
      now: () => now,
    });
    runtime.start();
    socket.open();

    expect((JSON.parse(socket.sent[0]!).capabilities as string[])).toContain(
      REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
    );

    expect(repairMissingRemoteDesktopWorker).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await Promise.resolve();
    expect(repairMissingRemoteDesktopWorker).not.toHaveBeenCalled();
    now += 10_000;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce());
    expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledWith(DAEMON_VERSION);
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: DAEMON_MSG.UPGRADING,
      targetVersion: DAEMON_VERSION,
      artifactSha256: 'a'.repeat(64),
    });

    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await Promise.resolve();
    expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it('backs off a failed missing-worker repair and retries on a later authenticated heartbeat', async () => {
    const socket = new MockSocket();
    let now = 10_000;
    const repairMissingRemoteDesktopWorker = vi.fn()
      .mockRejectedValueOnce(new Error('artifact temporarily unavailable'))
      .mockResolvedValueOnce({ ok: true, targetVersion: 'current', artifactSha256: 'b'.repeat(64) });
    const remoteDesktopWorker = {
      available: vi.fn(() => false),
      handle: vi.fn(async () => false),
      applyAutoUnlockSecret: vi.fn(async () => false),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'win32',
      arch: 'x64',
      now: () => now,
      remoteDesktopWorker,
      repairMissingRemoteDesktopWorker,
    });
    runtime.start();
    socket.open();

    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    now += 10_000;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce());
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await Promise.resolve();
    expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce();

    now += 5 * 60_000;
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await vi.waitFor(() => expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledTimes(2));
    runtime.stop();
  });

  it('lets an exact quick-install request bypass repair backoff without widening the command', async () => {
    const socket = new MockSocket();
    let rejectFirst!: (error: Error) => void;
    const repairMissingRemoteDesktopWorker = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ ok: true, targetVersion: DAEMON_VERSION });
    const remoteDesktopWorker = {
      available: vi.fn(() => false),
      handle: vi.fn(async () => false),
      applyAutoUnlockSecret: vi.fn(async () => false),
      autoUnlockConfigured: vi.fn(async () => false),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'win32',
      arch: 'x64',
      remoteDesktopWorker,
      repairMissingRemoteDesktopWorker,
      now: () => 10_000,
    });
    runtime.start();
    socket.open();
    socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }));
    await vi.waitFor(() => expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce());
    rejectFirst(new Error('temporary'));
    await Promise.resolve();

    socket.emit('message', JSON.stringify({
      type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST,
      targetVersion: 'attacker-controlled',
    }));
    await Promise.resolve();
    expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledOnce();

    socket.emit('message', JSON.stringify({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }));
    await vi.waitFor(() => expect(repairMissingRemoteDesktopWorker).toHaveBeenCalledTimes(2));
    expect(repairMissingRemoteDesktopWorker).toHaveBeenLastCalledWith(DAEMON_VERSION);
    runtime.stop();
  });

  it('keeps heartbeat, exec, and file transfer available when the remote-desktop kill switch is off', async () => {
    process.env.IMCODES_REMOTE_DESKTOP_ENABLED = '0';
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-node-rd-disabled-'));
    temporaryDirs.push(dir);
    const filePath = join(dir, 'still-available.txt');
    await writeFile(filePath, 'available');
    const socket = new MockSocket();
    const repairMissingRemoteDesktopWorker = vi.fn(async () => ({ ok: true as const }));
    const remoteDesktopWorker = {
      available: vi.fn(() => false),
      handle: vi.fn(async () => true),
      close: vi.fn(),
    };
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, () => socket, {
      platform: 'win32',
      arch: 'x64',
      remoteDesktopWorker,
      repairMissingRemoteDesktopWorker,
    });
    runtime.start();
    socket.open();
    const authFrame = JSON.parse(socket.sent[0]!);
    expect(authFrame.capabilities).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(authFrame.capabilities).not.toContain(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY);
    expect(authFrame.capabilities).not.toContain(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY);
    expect(authFrame.capabilities).toEqual(expect.arrayContaining([
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
    ]));
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ type: 'heartbeat' });
    socket.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await Promise.resolve();
    expect(repairMissingRemoteDesktopWorker).not.toHaveBeenCalled();

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
