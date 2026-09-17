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
  REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
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
  translateServerDeadlines,
} from '../../src/node/runtime.js';
import { ServerClockEstimator } from '../../shared/clock-sync.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from '../../shared/controlled-node-auto-unlock.js';
import type { AuthenticatedWebSocketLike } from '../../src/transport/authenticated-websocket.js';

const USER = {
  name: 'desktop-user', uid: 501, gid: 20,
  home: '/Users/desktop-user', tempDir: '/private/var/folders/test/T/',
} as const;
const TEAM_ID = 'ABCDE12345';
const BUNDLE_ID = 'cc.imcodes.node.remote-desktop-agent';
const WORKER_BUNDLE_ID = 'cc.imcodes.node.remote-desktop-worker';
const WORKER_REQUIREMENT = `identifier "${WORKER_BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM_ID}`;
const REQUIREMENT = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM_ID}`;

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
      worker: {
        kind: 'worker',
        executablePath: '/verified/release/imcodes-remote-desktop-worker',
        fileName: 'imcodes-remote-desktop-worker',
        size: 1,
        sha256: 'c'.repeat(64),
        bundleIdentifier: WORKER_BUNDLE_ID,
        designatedRequirement: WORKER_REQUIREMENT,
      } as never,
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
          // The per-user worker is the IPC peer, so its identity is required.
          worker: {
            bundleIdentifier: WORKER_BUNDLE_ID,
            designatedRequirement: WORKER_REQUIREMENT,
            hardenedRuntime: true,
          },
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
    capturePrivacy: true,
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
    // Control reaches the lock screen: the session survives the Mac locking.
    expect(advertised).toContain(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
    // The macOS worker host implements the privacy frame channel and shields
    // every later route by default; the Windows-only signed shell stays out.
    expect(advertised).toContain(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);
    expect(advertised).toContain(REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY);

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

  it('advertises macOS auto unlock only with a host that can keep the secret', () => {
    for (const supportsAutoUnlock of [true, false]) {
      const socket = new MockSocket();
      const runtime = createControlledNodeRuntime({
        serverUrl: 'https://im.example',
        serverId: 'controlled-1',
        token: 'secret',
        nodeRole: NODE_ROLE.CONTROLLED,
      }, () => socket, {
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
            REMOTE_DESKTOP_INPUT_CAPABILITY,
          ],
          supportsAutoUnlock: () => supportsAutoUnlock,
          applyAutoUnlockSecret: async () => true,
          autoUnlockConfigured: async () => false,
          handle: async () => true,
          close: () => undefined,
        },
      });
      runtime.start();
      socket.open();
      const advertised = JSON.parse(socket.sent[0]!).capabilities as string[];
      if (supportsAutoUnlock) expect(advertised).toContain(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY);
      else expect(advertised).not.toContain(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY);
      runtime.stop();
    }
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

  it('stops proactively restarting a macOS worker once it has proven itself available, and starts it lazily for a real PREPARE', async () => {
    // Live evidence on node m3 (mac): every ~60-90s a brand new
    // aidesk-agent/worker/disclosure process chain appeared, each one
    // unconditionally claiming "1 viewing" the instant it started, with
    // nobody ever connecting. The worker's own generation was already fixed
    // not to respawn itself on a no-real-session disconnect (see
    // macos-remote-desktop-worker-host.test.ts); this proves the OTHER half:
    // the daemon's own heartbeat-driven keepalive must not bring an idle,
    // already-proven-healthy worker back up on its own, while a REAL PREPARE
    // still starts it (lazily, on demand) rather than failing worker_failed.
    // A capability change (available -> unavailable, or back) is only ever
    // seen by the server through a fresh auth frame, so the runtime opens a
    // NEW socket whenever what it advertises changes -- exactly like "tells
    // the server once installed components change what the node can do"
    // above. Every socket after the first must therefore be tracked and
    // opened in turn, not just the first one.
    const sockets: MockSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    });
    let serverOptions: MacosRemoteDesktopIpcServerOptions | null = null;
    let workerGeneration = 0;
    let launchAgentStarts = 0;
    let now = Date.now();
    const runtime = createControlledNodeRuntime({
      serverUrl: 'https://im.example',
      serverId: 'controlled-1',
      token: 'secret',
      nodeRole: NODE_ROLE.CONTROLLED,
    }, createSocket, {
      platform: 'darwin',
      arch: 'arm64',
      now: () => now,
      macosRemoteDesktopComponentsInstalled: async () => true,
      macosRemoteDesktopWorker: {
        resolveVerifiedArtifact: async () => verifiedArtifact(),
        capturePrivacy: true,
        resolveUserSession: async () => USER,
        inspectReadiness: async () => ({
          screenRecording: true, encoder: true, accessibility: true, clipboard: true, disclosure: true,
        }),
        inspectPeerUid: async (_socket: Socket) => USER.uid,
        verifyPeerCodeIdentity: async (_socket: Socket, expected) => expected,
        createIpcServer: (options: MacosRemoteDesktopIpcServerOptions) => {
          serverOptions = options;
          return {
            start: async () => {
              workerGeneration += 1;
              return {
                workerGeneration,
                challenge: 'A'.repeat(43),
                socketPath: '/private/var/run/imcodes/501/remote-desktop.sock',
              };
            },
            sendCommand: async () => undefined,
            stop: async () => undefined,
          };
        },
        createLaunchAgentSupervisor: (
          dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies,
        ) => ({
          start: async () => {
            launchAgentStarts += 1;
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
      },
    });
    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();

    // The initial connect starts the worker once and it authenticates.
    await vi.waitFor(() => expect(launchAgentStarts).toBe(1));

    // Nothing real ever asked for it. Its own "connection_never_established"
    // watchdog closing it with zero tracked authorities looks exactly like
    // this from the host's perspective: an authenticated peer disconnecting
    // with no real session in progress. Availability narrows to false, which
    // reconnects (a fresh auth frame is the only way the server learns).
    serverOptions?.onDisconnect?.('peer_disconnected');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.open();

    now += 31_000; // past the 30s heartbeat retry throttle
    sockets.at(-1)!.emit('message', JSON.stringify({ type: 'heartbeat_ack' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Proven healthy once already: the heartbeat must not keep respawning it
    // purely to idle again -- that is the endless "1 viewing" flash. No third
    // socket means capabilities never changed again, i.e. nothing restarted.
    expect(launchAgentStarts).toBe(1);
    expect(sockets).toHaveLength(2);

    // A real PREPARE is real demand arriving right now: it must still start
    // the worker lazily rather than leave the feature silently unavailable.
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
    sockets.at(-1)!.emit('message', JSON.stringify(prepare));
    await vi.waitFor(() => expect(launchAgentStarts).toBe(2));
    runtime.stop();
  });
});

describe('translateServerDeadlines', () => {
  it('leaves messages untouched before the clock is synchronized', () => {
    const message = { type: 'x', expiresAt: 5_000_000, leaseExpiresAt: 6_000_000 };
    expect(translateServerDeadlines(message, new ServerClockEstimator())).toBe(message);
  });

  it('moves Server deadlines onto the local clock when the Mac is minutes behind', () => {
    const clock = new ServerClockEstimator();
    clock.addSample(1_000, 1_050 + 180_000, 1_100);
    const message = { type: 'x', expiresAt: 5_000_000, leaseExpiresAt: 6_000_000, other: 7 };
    const translated = translateServerDeadlines(message, clock);
    expect(translated).toEqual({ type: 'x', expiresAt: 4_820_000, leaseExpiresAt: 5_820_000, other: 7 });
    expect(message.expiresAt).toBe(5_000_000);
  });

  it('ignores absent or malformed deadline fields', () => {
    const clock = new ServerClockEstimator();
    clock.addSample(1_000, 1_050 + 1_000, 1_100);
    const message = { type: 'x', expiresAt: 'soon', leaseExpiresAt: -1 };
    expect(translateServerDeadlines(message, clock)).toBe(message);
  });
});
