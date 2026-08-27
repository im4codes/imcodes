import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';
import type { VerifiedMacosRemoteDesktopArtifact } from '../../src/node/macos-remote-desktop-artifact.js';
import type { MacosRemoteDesktopIpcServerOptions } from '../../src/node/macos-remote-desktop-ipc-server.js';
import type {
  MacosRemoteDesktopLaunchAgentSupervisorDependencies,
} from '../../src/node/macos-remote-desktop-launch-agent.js';
import {
  createControlledNodeRuntime,
  createPlatformRemoteDesktopWorkerHost,
} from '../../src/node/runtime.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

const USER = {
  name: 'desktop-user', uid: 501, gid: 20,
  home: '/Users/desktop-user', tempDir: '/private/var/folders/test/T/',
} as const;
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'cc.imcodes.node.remote-desktop-agent';
const REQUIREMENT = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;

class MockSocket extends EventEmitter implements AuthenticatedWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit('close'); }
  open(): void { this.readyState = 1; this.emit('open'); }
}

function verifiedArtifact(): VerifiedMacosRemoteDesktopArtifact {
  return {
    artifactDirectory: '/verified/release',
    manifestPath: '/verified/release/imcodes-remote-desktop.manifest.json',
    setSha256: 'a'.repeat(64),
    components: {
      worker: {} as never,
      disclosure: {} as never,
      launchAgent: {
        kind: 'launchAgent',
        executablePath: '/verified/release/imcodes-remote-desktop-launch-agent',
        fileName: 'imcodes-remote-desktop-launch-agent',
        size: 1,
        sha256: 'b'.repeat(64),
        bundleIdentifier: BUNDLE_ID,
        designatedRequirement: REQUIREMENT,
      },
    },
    manifest: {
      os: 'darwin',
      arch: 'arm64',
      codeSignature: {
        teamId: TEAM_ID,
        bundles: {
          worker: {} as never,
          disclosure: {} as never,
          launchAgent: {
            bundleIdentifier: BUNDLE_ID,
            designatedRequirement: REQUIREMENT,
            hardenedRuntime: true,
          },
        },
      },
    } as never,
  };
}

function macosRuntimeOptions(
  sent: RemoteDesktopDaemonCommand[],
  readiness: { disclosure: boolean; accessibility: boolean },
  errors: unknown[] = [],
) {
  let serverOptions: MacosRemoteDesktopIpcServerOptions | null = null;
  const launch = {
    workerGeneration: 1,
    challenge: 'A'.repeat(43),
    socketPath: '/private/var/run/imcodes/501/remote-desktop.sock',
  } as const;
  return {
    resolveVerifiedArtifact: async () => verifiedArtifact(),
    resolveUserSession: async () => USER,
    inspectReadiness: async () => ({
      screenRecording: true,
      encoder: true,
      accessibility: readiness.accessibility,
      clipboard: true,
      disclosure: readiness.disclosure,
    }),
    inspectPeerUid: async (_socket: Socket) => USER.uid,
    verifyPeerCodeIdentity: async (_socket: Socket, expected: {
      bundleIdentifier: string;
      teamId: string;
      designatedRequirement: string;
    }) => expected,
    createIpcServer: (options: MacosRemoteDesktopIpcServerOptions) => {
      serverOptions = options;
      return {
        start: async () => launch,
        sendCommand: async (command: RemoteDesktopDaemonCommand) => { sent.push(command); },
        stop: async () => undefined,
      };
    },
    createLaunchAgentSupervisor: (
      dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies,
    ) => ({
      start: async () => {
        dependencies.markAuthorityUnavailable('start');
        const active = dependencies.beginIpcLaunch();
        queueMicrotask(() => serverOptions?.onPeerAuthenticated?.(active));
        return {
          user: USER,
          workerGeneration: active.workerGeneration,
          serviceTarget: 'gui/501/cc.imcodes.node.remote-desktop',
          socketPath: active.socketPath,
        };
      },
      stop: async () => undefined,
    }),
    onBackgroundError: (error: unknown) => errors.push(error),
  };
}

describe('macOS controlled-node remote-desktop runtime', () => {
  it('never falls back to the Windows host without native macOS verification seams', () => {
    const selected = createPlatformRemoteDesktopWorkerHost({
      platform: 'darwin',
      arch: 'arm64',
      onMessage: () => undefined,
    });
    expect(selected.startup).toBeUndefined();
    expect(selected.worker.available()).toBe(false);
    expect(selected.worker.sessionCapabilities?.()).toEqual([]);
    expect('applyAutoUnlockSecret' in selected.worker).toBe(false);
  });

  it('waits for verified IPC readiness before advertising the macOS profile', async () => {
    const socket = new MockSocket();
    const createSocket = vi.fn(() => socket);
    const sent: RemoteDesktopDaemonCommand[] = [];
    const errors: unknown[] = [];
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'CONTROLLED_NODE_SECRET',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, createSocket, {
      platform: 'darwin',
      arch: 'arm64',
      macosRemoteDesktopWorker: macosRuntimeOptions(sent, {
        disclosure: true,
        accessibility: true,
      }, errors),
    });

    runtime.start();
    expect(createSocket).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    expect(errors).toEqual([]);
    socket.open();
    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).toEqual(expect.arrayContaining([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
    ]));
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);

    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: 'request_12345678',
      sessionId: 'session_12345678',
      capability: 'a'.repeat(43),
      expiresAt: Date.now() + 60_000,
      leaseExpiresAt: Date.now() + 15_000,
      daemonGeneration: 7,
      routeGeneration: 11,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 3,
      iceServers: [],
    } as const;
    socket.emit('message', JSON.stringify(prepare));
    await vi.waitFor(() => expect(sent).toEqual([prepare]));
    expect(JSON.stringify(sent)).not.toContain('CONTROLLED_NODE_SECRET');
    runtime.stop();
  });

  it('advertises no macOS route when local disclosure is unavailable', async () => {
    const socket = new MockSocket();
    const createSocket = vi.fn(() => socket);
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, createSocket, {
      platform: 'darwin',
      arch: 'arm64',
      macosRemoteDesktopWorker: macosRuntimeOptions([], {
        disclosure: false,
        accessibility: true,
      }),
    });
    runtime.start();
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    socket.open();
    const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
    expect(advertised).not.toContain(REMOTE_DESKTOP_SESSION_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS);
    expect(advertised).not.toContain(REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY);
    runtime.stop();
  });

  it('re-samples a narrowed macOS profile for the next WebSocket generation', async () => {
    const first = new MockSocket();
    const second = new MockSocket();
    const sockets = [first, second];
    let control = true;
    const onDaemonDisconnected = vi.fn();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, vi.fn(() => sockets.shift()!), {
      platform: 'darwin',
      arch: 'arm64',
      remoteDesktopWorker: {
        available: () => true,
        sessionCapabilities: () => [
          REMOTE_DESKTOP_SESSION_CAPABILITY,
          REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
          REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
        ],
        adapterCapabilities: () => [
          REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
          REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
          ...(control ? [REMOTE_DESKTOP_INPUT_CAPABILITY] : []),
        ],
        handle: async () => true,
        onDaemonDisconnected,
        close: () => undefined,
      },
    });
    runtime.start();
    first.open();
    expect(JSON.parse(first.sent[0]!).capabilities).toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);

    control = false;
    first.close();
    expect(onDaemonDisconnected).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(second.listenerCount('open')).toBeGreaterThan(0), {
      timeout: 1_500,
    });
    second.open();
    const advertised = JSON.parse(second.sent[0]!).capabilities as string[];
    expect(advertised).toContain(REMOTE_DESKTOP_SESSION_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    runtime.stop();
  });
});
