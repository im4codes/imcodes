import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MSG,
  type RemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '../../shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  type RemoteDesktopMacosWorkerManifest,
} from '../../shared/remote-desktop-worker.js';
import type { VerifiedMacosRemoteDesktopArtifact } from '../../src/node/macos-remote-desktop-artifact.js';
import type {
  MacosRemoteDesktopIpcLaunch,
  MacosRemoteDesktopExpectedCodeIdentity,
  MacosRemoteDesktopIpcPrincipalBinding,
  MacosRemoteDesktopIpcSession,
} from '../../src/node/macos-remote-desktop-ipc.js';
import type { MacosRemoteDesktopIpcServerOptions } from '../../src/node/macos-remote-desktop-ipc-server.js';
import type {
  MacosRemoteDesktopLaunchAgentSnapshot,
  MacosRemoteDesktopLaunchAgentSupervisorDependencies,
  MacosRemoteDesktopLifecycleEvent,
  MacosRemoteDesktopLifecycleSource,
} from '../../src/node/macos-remote-desktop-launch-agent.js';
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY } from '../../src/node/macos-user-session.js';
import {
  WORKER_PRIVACY_FRAME,
  parseWorkerPrivacyFrame,
  type WorkerPrivacyInboundFrame,
} from '../../src/node/remote-desktop-privacy-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON,
  MACOS_REMOTE_DESKTOP_HOST_CLEANUP_TIMEOUT_MS,
  MacosRemoteDesktopWorkerHost,
  type MacosRemoteDesktopWorkerHostOptions,
} from '../../src/node/macos-remote-desktop-worker-host.js';
import type {
  MacosRemoteDesktopGraphicalSessionAuthority,
  MacosUserSession,
} from '../../src/node/user-session-launcher.js';

const NOW = 1_800_000_000_000;
const TEAM_ID = 'ABCDE12345';
const REQUEST_ID = 'request_123456789';
const SESSION_ID = 'session_123456789';
const CAPABILITY = 'capability_12345678901234567890123456789012';
const USER: MacosUserSession = {
  name: 'desktop-user', uid: 501, gid: 20,
  home: '/Users/desktop-user', tempDir: '/private/var/folders/test/T/',
};
const LOGINWINDOW: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
  kind: 'loginwindow_bootstrap',
  sessionType: 'LoginWindow',
  uid: 88,
  auditSessionId: 100_004,
  pidVersion: 7,
});

function requirement(bundleIdentifier: string): string {
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM_ID}`;
}

function artifact(): VerifiedMacosRemoteDesktopArtifact {
  const artifactDirectory = '/Library/Application Support/IM.codes/remote-desktop/release';
  const manifest: RemoteDesktopMacosWorkerManifest = {
    manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
    artifactKind: REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
    workerVersion: '2026.8.5000',
    protocolVersion: 2,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    os: 'darwin', arch: 'arm64',
    components: {
      worker: { fileName: REMOTE_DESKTOP_MACOS_WORKER_FILENAME, size: 10, sha256: 'a'.repeat(64), notarization: { status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000', ticketSha256: 'a'.repeat(64), stapled: true, stapleValidated: true } },
      launchAgent: { fileName: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME, size: 11, sha256: 'b'.repeat(64), notarization: { status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000', ticketSha256: 'b'.repeat(64), stapled: true, stapleValidated: true } },
      disclosure: { fileName: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME, size: 12, sha256: 'c'.repeat(64), notarization: { status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000', ticketSha256: 'c'.repeat(64), stapled: true, stapleValidated: true } },
    },
    libwebrtcRevision: 'branch-heads/7390@{#1}', minimumOsVersion: '12.3',
    codeSignature: {
      teamId: TEAM_ID,
      bundles: {
        worker: { bundleIdentifier: 'cc.imcodes.node.remote-desktop-worker', designatedRequirement: requirement('cc.imcodes.node.remote-desktop-worker'), hardenedRuntime: true },
        launchAgent: { bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier, designatedRequirement: requirement(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier), hardenedRuntime: true },
        disclosure: { bundleIdentifier: 'cc.imcodes.node.remote-desktop-disclosure', designatedRequirement: requirement('cc.imcodes.node.remote-desktop-disclosure'), hardenedRuntime: true },
      },
    },
    toolchain: { xcode: '16.4', macosSdk: '15.5', clang: '17.0.0' },
  };
  const component = (kind: 'worker' | 'launchAgent' | 'disclosure') => ({
    kind,
    executablePath: `${artifactDirectory}/${manifest.components[kind].fileName}`,
    fileName: manifest.components[kind].fileName,
    size: manifest.components[kind].size,
    sha256: manifest.components[kind].sha256,
    bundleIdentifier: manifest.codeSignature.bundles[kind].bundleIdentifier,
    designatedRequirement: manifest.codeSignature.bundles[kind].designatedRequirement,
  });
  return {
    artifactDirectory,
    manifestPath: `${artifactDirectory}/${REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME}`,
    manifest,
    components: { worker: component('worker'), launchAgent: component('launchAgent'), disclosure: component('disclosure') },
    setSha256: 'd'.repeat(64), releaseName: `sha256-${'d'.repeat(64)}`,
  };
}

function prepare(overrides: Partial<RemoteDesktopPrepare> = {}): RemoteDesktopPrepare {
  return {
    type: REMOTE_DESKTOP_MSG.PREPARE,
    requestId: REQUEST_ID, sessionId: SESSION_ID, capability: CAPABILITY,
    expiresAt: NOW + 120_000, leaseExpiresAt: NOW + 60_000,
    daemonGeneration: 7, routeGeneration: 11,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, inputEpoch: 3,
    iceServers: [],
    ...overrides,
  };
}

class Lifecycle implements MacosRemoteDesktopLifecycleSource {
  private listener: ((event: MacosRemoteDesktopLifecycleEvent) => void) | null = null;
  subscribe(listener: (event: MacosRemoteDesktopLifecycleEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }
  active(): boolean { return this.listener !== null; }
  emit(event: MacosRemoteDesktopLifecycleEvent): void { this.listener?.(event); }
}

interface Harness {
  host: MacosRemoteDesktopWorkerHost;
  sent: RemoteDesktopDaemonCommand[];
  messages: RemoteDesktopDaemonMessage[];
  authenticate(
    overrides?: Partial<MacosRemoteDesktopIpcPrincipalBinding>,
    sessionOverrides?: Partial<MacosRemoteDesktopIpcSession>,
  ): boolean;
  workerMessage(message: RemoteDesktopDaemonMessage): void;
  lifecycle: Lifecycle;
  stopped: ReturnType<typeof vi.fn>;
  serverStarts: ReturnType<typeof vi.fn>;
  /** Everything written to the worker, in order: `command:<type>` or `privacy:<shield>`. */
  outbound: string[];
  privacyRequests: Array<{ requestId: number; shield: boolean; workerGeneration: number }>;
  privacyReply(
    requestId: number,
    reply: { shielded: boolean; inputReleased?: boolean; realFrameGeneration: number },
  ): void;
}

function harness(overrides: Partial<MacosRemoteDesktopWorkerHostOptions> = {}): Harness {
  const lifecycle = new Lifecycle();
  const sent: RemoteDesktopDaemonCommand[] = [];
  const messages: RemoteDesktopDaemonMessage[] = [];
  const outbound: string[] = [];
  const privacyRequests: Harness['privacyRequests'] = [];
  const stopped = vi.fn(async () => undefined);
  let serverOptions: MacosRemoteDesktopIpcServerOptions | null = null;
  let activeLaunch: MacosRemoteDesktopIpcLaunch | null = null;
  let workerGeneration = 0;
  const serverStarts = vi.fn(async () => {
    activeLaunch = {
      workerGeneration: ++workerGeneration,
      challenge: String.fromCharCode(64 + workerGeneration).repeat(43),
      socketPath: '/private/var/run/imcodes/501/remote-desktop.sock',
    };
    return activeLaunch;
  });
  const expectedPeer = (expected: MacosRemoteDesktopExpectedCodeIdentity) => ({
    bundleIdentifier: expected.bundleIdentifier,
    teamId: expected.teamId,
    designatedRequirement: expected.designatedRequirement,
  });
  const options: MacosRemoteDesktopWorkerHostOptions = {
    runtime: { platform: 'darwin', arch: 'arm64' },
    capturePrivacy: true,
    resolveVerifiedArtifact: async () => artifact(),
    resolveUserSession: async () => USER,
    inspectReadiness: async () => ({
      screenRecording: true, encoder: true, accessibility: true,
      clipboard: true, disclosure: true,
    }),
    inspectPeerUid: async () => USER.uid,
    verifyPeerCodeIdentity: async (_socket: Socket, expected) => expectedPeer(expected),
    lifecycleSource: lifecycle,
    authenticationTimeoutMs: 1_000,
    createIpcServer: (createdOptions) => {
      serverOptions = createdOptions;
      return {
        start: serverStarts,
        sendCommand: async (command) => {
          sent.push(command);
          outbound.push(`command:${command.type}`);
        },
        sendPrivacyRequest: async (requestId, shield) => {
          privacyRequests.push({
            requestId, shield, workerGeneration: activeLaunch?.workerGeneration ?? 0,
          });
          outbound.push(`privacy:${String(shield)}`);
        },
        stop: stopped,
      };
    },
    createLaunchAgentSupervisor: (dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies) => ({
      start: async (): Promise<MacosRemoteDesktopLaunchAgentSnapshot> => {
        dependencies.markAuthorityUnavailable('start');
        const ipcLaunch = dependencies.beginIpcLaunch();
        return { user: USER, workerGeneration: ipcLaunch.workerGeneration, serviceTarget: 'gui/501/cc.imcodes.node.remote-desktop', socketPath: ipcLaunch.socketPath };
      },
      stop: stopped,
    }),
    ...overrides,
  };
  const host = new MacosRemoteDesktopWorkerHost((message) => messages.push(message), options);
  return {
    host, sent, messages, lifecycle, stopped, serverStarts, outbound, privacyRequests,
    privacyReply: (requestId, reply) => {
      const request = privacyRequests.find((entry) => entry.requestId === requestId);
      void serverOptions?.onPrivacyReply?.({
        workerGeneration: request?.workerGeneration ?? 0,
        requestId,
        shielded: reply.shielded,
        inputReleased: reply.inputReleased ?? true,
        realFrameGeneration: reply.realFrameGeneration,
      });
    },
    authenticate: (overrides = {}, sessionOverrides = {}) => {
      if (!serverOptions || !activeLaunch) return false;
      const explicit = serverOptions.principal;
      const principal: MacosRemoteDesktopIpcPrincipalBinding = explicit
        ? {
          kind: explicit.kind,
          sessionType: explicit.sessionType,
          uid: explicit.kind === 'aqua_user' ? explicit.user.uid : explicit.uid,
          auditSessionId: explicit.auditSessionId,
          pidVersion: explicit.pidVersion,
          ...overrides,
        }
        : {
          kind: 'aqua_user',
          sessionType: 'Aqua',
          uid: serverOptions.user!.uid,
          auditSessionId: 100_003,
          pidVersion: 5,
          ...overrides,
        };
      const session = {
        workerGeneration: activeLaunch.workerGeneration,
        socketPath: activeLaunch.socketPath,
        principal,
        launchNonce: activeLaunch.challenge,
        ...sessionOverrides,
      };
      if (explicit?.kind === 'loginwindow_bootstrap') {
        void Promise.resolve(serverOptions.onGraphicalReadinessAttestation?.(
          'authenticated-readiness',
          activeLaunch,
          session,
        )).then(() => serverOptions?.onPeerAuthenticated?.(activeLaunch!, session));
      } else {
        serverOptions.onPeerAuthenticated?.(activeLaunch, session);
      }
      return true;
    },
    workerMessage: (message) => { void serverOptions?.onWorkerMessage(message); },
  };
}

async function startAuthenticated(value: Harness): Promise<void> {
  const starting = value.host.start();
  await vi.waitFor(() => expect(value.authenticate()).toBe(true));
  await starting;
}

describe('macOS remote-desktop worker host', () => {
  it('delivers LoginWindow generation/nonce through the explicit principal path without Aqua data', async () => {
    const resolveUserSession = vi.fn(async () => USER);
    const graphicalLaunches: unknown[] = [];
    const value = harness({
      resolveUserSession,
      resolveGraphicalSessionAuthority: async () => LOGINWINDOW,
      inspectGraphicalReadiness: async (_artifact, principal) => {
        expect(principal).toBe(LOGINWINDOW);
        return {
          screenRecording: true,
          encoder: true,
          accessibility: true,
          clipboard: false,
          disclosure: true,
        };
      },
      onGraphicalIpcLaunch: (principal, launch) => {
        graphicalLaunches.push({ principal, launch });
      },
      inspectPeerGraphicalSession: async () => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
      }),
    });

    await startAuthenticated(value);

    expect(resolveUserSession).not.toHaveBeenCalled();
    expect(graphicalLaunches).toHaveLength(1);
    expect(graphicalLaunches[0]).toMatchObject({
      principal: LOGINWINDOW,
      launch: {
        workerGeneration: 1,
        challenge: 'A'.repeat(43),
      },
    });
    expect(JSON.stringify(graphicalLaunches)).not.toMatch(/name|HOME|TMPDIR|Users\//u);
    expect(value.host.available()).toBe(true);
  });

  it.each([
    ['stale predecessor', { auditSessionId: LOGINWINDOW.auditSessionId - 1 }, {}],
    ['successor session', { auditSessionId: LOGINWINDOW.auditSessionId + 1 }, {}],
    ['replayed process generation', { pidVersion: LOGINWINDOW.pidVersion - 1 }, {}],
    ['stale worker generation', {}, { workerGeneration: 99 }],
    ['replayed launch nonce', {}, { launchNonce: 'Z'.repeat(43) }],
  ])('refuses a %s session returned by the IPC boundary', async (
    _label,
    mismatch,
    sessionMismatch,
  ) => {
    const errors: unknown[] = [];
    const value = harness({
      resolveGraphicalSessionAuthority: async () => LOGINWINDOW,
      inspectGraphicalReadiness: async () => ({
        screenRecording: true,
        encoder: true,
        accessibility: true,
        clipboard: false,
        disclosure: true,
      }),
      onGraphicalIpcLaunch: () => undefined,
      inspectPeerGraphicalSession: async () => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
      }),
      onBackgroundError: (error) => errors.push(error),
    });
    const starting = value.host.start();
    await vi.waitFor(() => expect(value.authenticate(mismatch, sessionMismatch)).toBe(true));
    await starting;
    expect(value.host.available()).toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({
      message: 'macos_remote_desktop_worker_host_graphical_principal_mismatch',
    }));
  });

  it('fails closed when an explicit graphical principal has no independent observer', async () => {
    const errors: unknown[] = [];
    const value = harness({
      resolveGraphicalSessionAuthority: async () => LOGINWINDOW,
      inspectGraphicalReadiness: async () => ({
        screenRecording: true,
        encoder: true,
        accessibility: true,
        clipboard: false,
        disclosure: true,
      }),
      onGraphicalIpcLaunch: () => undefined,
      onBackgroundError: (error) => errors.push(error),
    });

    await value.host.start();

    expect(value.host.available()).toBe(false);
    expect(value.serverStarts).not.toHaveBeenCalled();
    expect(errors).toContainEqual(expect.objectContaining({
      message: 'macos_remote_desktop_worker_host_graphical_peer_observer_unavailable',
    }));
  });

  it.each([
    ['artifact', { resolveVerifiedArtifact: async () => null }],
    ['active user', { resolveUserSession: async () => { throw new Error('no_aqua_user'); } }],
    ['screen recording', { inspectReadiness: async () => ({ screenRecording: false, encoder: true, accessibility: true, clipboard: true, disclosure: true }) }],
    ['encoder', { inspectReadiness: async () => ({ screenRecording: true, encoder: false, accessibility: true, clipboard: true, disclosure: true }) }],
    ['disclosure', { inspectReadiness: async () => ({ screenRecording: true, encoder: true, accessibility: true, clipboard: true, disclosure: false }) }],
  ] as const)('fails closed when %s is unavailable', async (_label, override) => {
    const value = harness(override);
    await value.host.start();
    expect(value.host.available()).toBe(false);
    expect(value.host.sessionCapabilities()).toEqual([]);
    expect(value.host.adapterCapabilities()).toEqual([]);
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.sent).toEqual([]);
  });

  it('exposes View then Control capabilities only after authenticated IPC', async () => {
    const view = harness({ inspectReadiness: async () => ({ screenRecording: true, encoder: true, accessibility: false, clipboard: true, disclosure: true }) });
    const viewStart = view.host.start();
    expect(view.host.available()).toBe(false);
    expect(await view.host.handle(prepare())).toBe(false);
    expect(view.sent).toEqual([]);
    await vi.waitFor(() => expect(view.authenticate()).toBe(true));
    await viewStart;
    expect(view.host.sessionCapabilities()).toEqual([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
    ]);
    expect(view.host.adapterCapabilities()).toEqual([
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
    ]);
    expect(await view.host.handle(prepare())).toBe(false);
    expect(await view.host.handle(prepare({
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
    }))).toBe(true);

    const control = harness();
    await startAuthenticated(control);
    expect(control.host.adapterCapabilities()).toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    expect(control.host.sessionCapabilities()).toContain(REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY);
  });

  it('rejects an artifact for a different runtime architecture', async () => {
    const value = harness({ runtime: { platform: 'darwin', arch: 'x64' } });
    await value.host.start();
    expect(value.host.available()).toBe(false);
    expect(value.host.sessionCapabilities()).toEqual([]);
    expect(value.sent).toEqual([]);
  });

  it('downgrades Control to View when Accessibility is lost', async () => {
    let accessibility = true;
    const releaseInput = vi.fn();
    const value = harness({
      releaseInput,
      inspectReadiness: async () => ({
        screenRecording: true,
        encoder: true,
        accessibility,
        clipboard: true,
        disclosure: true,
      }),
    });
    await startAuthenticated(value);
    expect(await value.host.handle(prepare())).toBe(true);

    accessibility = false;
    const view = prepare({
      requestId: 'request_222222222',
      sessionId: 'session_222222222',
      capability: 'b'.repeat(43),
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
    });
    // A capability narrowing retires the old IPC generation; the rejected
    // command cannot race across that boundary.
    expect(await value.host.handle(view)).toBe(false);
    await vi.waitFor(() => {
      value.authenticate();
      expect(value.host.available()).toBe(true);
    });
    expect(await value.host.handle(view)).toBe(true);
    expect(value.host.available()).toBe(true);
    expect(value.host.adapterCapabilities()).not.toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    expect(value.host.sessionCapabilities()).not.toContain(REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY);
    expect(releaseInput).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
    expect(value.messages).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: SESSION_ID,
    }));
    expect(await value.host.handle(prepare({
      requestId: 'request_333333333',
      sessionId: 'session_333333333',
      capability: 'c'.repeat(43),
    }))).toBe(false);
  });

  it('retires the generation when disclosure readiness disappears', async () => {
    let disclosure = true;
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const value = harness({
      releaseInput,
      stopCapture,
      inspectReadiness: async () => ({
        screenRecording: true,
        encoder: true,
        accessibility: true,
        clipboard: true,
        disclosure,
      }),
    });
    await startAuthenticated(value);
    expect(await value.host.handle(prepare())).toBe(true);

    disclosure = false;
    expect(await value.host.handle(prepare({
      requestId: 'request_444444444',
      sessionId: 'session_444444444',
      capability: 'd'.repeat(43),
    }))).toBe(false);
    expect(value.host.available()).toBe(false);
    expect(value.host.sessionCapabilities()).toEqual([]);
    expect(value.host.adapterCapabilities()).toEqual([]);
    expect(releaseInput).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
    expect(stopCapture).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
  });

  it('polls readiness so permission loss tears down an idle active generation', async () => {
    let screenRecording = true;
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const value = harness({
      readinessPollMs: 100,
      releaseInput,
      stopCapture,
      inspectReadiness: async () => ({
        screenRecording,
        encoder: true,
        accessibility: true,
        clipboard: true,
        disclosure: true,
      }),
    });
    await startAuthenticated(value);
    screenRecording = false;

    await vi.waitFor(() => expect(value.host.available()).toBe(false), { timeout: 500 });
    expect(releaseInput).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
    expect(stopCapture).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
  });

  it('forwards route commands only after IPC authentication', async () => {
    const value = harness();
    const starting = value.host.start();
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.sent).toEqual([]);
    await vi.waitFor(() => expect(value.authenticate()).toBe(true));
    await starting;
    expect(await value.host.handle(prepare())).toBe(true);
    expect(value.sent).toEqual([prepare()]);
  });

  it('fences stale generations and clears routes on close', async () => {
    const value = harness();
    await startAuthenticated(value);
    expect(await value.host.handle(prepare())).toBe(true);
    value.host.close();
    expect(value.host.available()).toBe(false);
    expect(value.host.sessionCapabilities()).toEqual([]);
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.messages).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
    }));
    expect(value.messages.filter((message) => message.type === REMOTE_DESKTOP_MSG.TERMINAL))
      .toHaveLength(1);
    value.authenticate();
    expect(value.host.available()).toBe(false);
    await vi.waitFor(() => expect(value.stopped).toHaveBeenCalled());
  });

  it('synchronously invalidates capability and authority on lifecycle loss', async () => {
    const errors: unknown[] = [];
    const value = harness({
      releaseInput: () => { throw new Error('release_failed'); },
      onBackgroundError: (error) => errors.push(error),
    });
    await startAuthenticated(value);
    await value.host.handle(prepare());
    value.lifecycle.emit({ type: 'lock' });
    expect(value.host.available()).toBe(false);
    expect(value.host.adapterCapabilities()).toEqual([]);
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.messages).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: SESSION_ID,
    }));
    expect(errors).toContainEqual(expect.objectContaining({ message: 'release_failed' }));
  });

  it('cancels an unauthenticated generation immediately on lifecycle loss', async () => {
    const value = harness({ authenticationTimeoutMs: 10_000 });
    const starting = value.host.start();
    await vi.waitFor(() => expect(value.lifecycle.active()).toBe(true));
    value.lifecycle.emit({ type: 'sleep' });
    await expect(starting).resolves.toBeUndefined();
    expect(value.host.available()).toBe(false);
    expect(value.sent).toEqual([]);
    value.authenticate();
    expect(value.host.available()).toBe(false);
  });

  it('cancels the authentication deadline when launch setup fails early', async () => {
    const backgroundErrors: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const value = harness({
        authenticationTimeoutMs: 10,
        onBackgroundError: (error) => backgroundErrors.push(error),
        createIpcServer: () => ({
          start: async () => { throw new Error('ipc_start_failed'); },
          sendCommand: async () => undefined,
          stop: async () => undefined,
        }),
      });

      await value.host.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(value.host.available()).toBe(false);
      expect(backgroundErrors).toContainEqual(expect.objectContaining({
        message: 'ipc_start_failed',
      }));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the worker and control socket alive until both cleanups settle', async () => {
    let releaseSettle: (() => void) | null = null;
    let stopSettle: (() => void) | null = null;
    const releaseInput = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      releaseSettle = () => resolve({ ok: true });
    }));
    const stopCapture = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      stopSettle = () => resolve({ ok: true });
    }));
    const value = harness({ releaseInput, stopCapture });
    await startAuthenticated(value);
    value.stopped.mockClear();

    value.lifecycle.emit({ type: 'lock' });
    // Both cleanups are dispatched with the live generation...
    expect(releaseInput).toHaveBeenCalledWith(
      { reason: { type: 'lock' }, workerGeneration: expect.any(Number) },
    );
    expect(releaseInput.mock.calls[0]![0].workerGeneration).toBeGreaterThan(0);
    await Promise.resolve();
    await Promise.resolve();
    // ...and nothing may stop the supervisor or the IPC server while they are
    // still in flight: doing so removes the control socket the freshly spawned
    // cleanup still has to connect to.
    expect(value.stopped).not.toHaveBeenCalled();

    releaseSettle!();
    stopSettle!();
    await vi.waitFor(() => expect(value.stopped).toHaveBeenCalled());
  });

  it('tears down after the bound when a cleanup never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const releaseInput = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
      const stopCapture = vi.fn(async () => ({ ok: true }));
      const backgroundErrors: unknown[] = [];
      const value = harness({
        releaseInput,
        stopCapture,
        onBackgroundError: (error: unknown) => backgroundErrors.push(error),
      });
      const starting = value.host.start();
      await vi.waitFor(() => expect(value.authenticate()).toBe(true));
      await starting;
      value.stopped.mockClear();

      value.lifecycle.emit({ type: 'lock' });
      await vi.advanceTimersByTimeAsync(
        MACOS_REMOTE_DESKTOP_HOST_CLEANUP_TIMEOUT_MS - 1,
      );
      expect(value.stopped).not.toHaveBeenCalled();

      // A wedged worker must not be able to block teardown forever.
      await vi.advanceTimersByTimeAsync(2);
      await vi.waitFor(() => expect(value.stopped).toHaveBeenCalled());
      expect(backgroundErrors.some((error) => (error as Error)?.message
        === 'macos_remote_desktop_host_cleanup_timeout')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts into a fresh worker generation after unlock and service generation changes', async () => {
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const value = harness({ releaseInput, stopCapture });
    await startAuthenticated(value);
    expect(value.serverStarts).toHaveBeenCalledTimes(1);

    value.lifecycle.emit({ type: 'lock' });
    expect(value.host.available()).toBe(false);
    expect(releaseInput).toHaveBeenCalledWith({ reason: { type: 'lock' }, workerGeneration: expect.any(Number) });
    expect(stopCapture).toHaveBeenCalledWith({ reason: { type: 'lock' }, workerGeneration: expect.any(Number) });

    value.lifecycle.emit({ type: 'unlock' });
    await vi.waitFor(() => expect(value.serverStarts).toHaveBeenCalledTimes(2));
    expect(value.authenticate()).toBe(true);
    await vi.waitFor(() => expect(value.host.available()).toBe(true));

    value.lifecycle.emit({ type: 'service_generation', serviceGeneration: 4 });
    value.lifecycle.emit({ type: 'service_generation', serviceGeneration: 4 });
    await vi.waitFor(() => expect(value.serverStarts).toHaveBeenCalledTimes(3));
    expect(value.authenticate()).toBe(true);
    await vi.waitFor(() => expect(value.host.available()).toBe(true));
    expect(value.serverStarts).toHaveBeenCalledTimes(3);
  });

  it('retires a changed Control profile and relaunches View-only before accepting a new route', async () => {
    let accessibility = true;
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const onProfileChanged = vi.fn();
    const value = harness({
      releaseInput,
      stopCapture,
      onProfileChanged,
      inspectReadiness: async () => ({
        screenRecording: true,
        encoder: true,
        accessibility,
        clipboard: true,
        disclosure: true,
      }),
    });
    await startAuthenticated(value);
    expect(value.host.adapterCapabilities()).toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);

    accessibility = false;
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.host.available()).toBe(false);
    expect(releaseInput).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });
    expect(stopCapture).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.READINESS_CHANGED,
        workerGeneration: expect.any(Number),
    });

    await vi.waitFor(() => expect(value.serverStarts).toHaveBeenCalledTimes(2));
    expect(value.authenticate()).toBe(true);
    await vi.waitFor(() => expect(value.host.available()).toBe(true));
    expect(value.host.adapterCapabilities()).not.toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    expect(onProfileChanged).toHaveBeenCalledTimes(3);
    expect(await value.host.handle(prepare())).toBe(false);
    expect(await value.host.handle(prepare({
      sessionId: 'session_view_123456789',
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
    }))).toBe(true);
  });

  it('uses the verified LaunchAgent executable for the supported native fd-3 verifier seam', async () => {
    const createPeerVerificationSeams = vi.fn(() => ({
      inspectPeerUid: async () => USER.uid,
      verifyPeerCodeIdentity: async (
        _socket: Socket,
        expected: MacosRemoteDesktopExpectedCodeIdentity,
      ) => ({ ...expected }),
    }));
    const value = harness({
      inspectPeerUid: undefined,
      verifyPeerCodeIdentity: undefined,
      createPeerVerificationSeams,
    });
    await startAuthenticated(value);

    expect(createPeerVerificationSeams).toHaveBeenCalledWith({
      executablePath: artifact().components.launchAgent.executablePath,
      expectedUid: USER.uid,
      expectedCodeIdentity: {
        bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
        teamId: TEAM_ID,
        designatedRequirement: requirement(
          MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
        ),
      },
    });
  });

  it('holds an OFFER that arrives while PREPARE is still re-checking readiness', async () => {
    // The browser sends its OFFER the moment it is authorized, while PREPARE is
    // still inside a readiness re-check that launches a native process. With no
    // preparing marker yet, the OFFER found no session and failed the route.
    let slow = false;
    const value = harness({
      inspectReadiness: async () => {
        if (slow) await new Promise((resolve) => { setTimeout(resolve, 50); });
        return { screenRecording: true, encoder: true, accessibility: true, clipboard: true, disclosure: true };
      },
    });
    await startAuthenticated(value);
    slow = true;
    const preparing = value.host.handle(prepare());
    const offering = value.host.handle({
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId: REQUEST_ID, sessionId: SESSION_ID, capability: CAPABILITY,
      sdp: 'v=0',
    });
    expect(await preparing).toBe(true);
    expect(await offering).toBe(true);
    expect(value.sent.map((command) => command.type)).toEqual([
      REMOTE_DESKTOP_MSG.PREPARE,
      REMOTE_DESKTOP_MSG.OFFER,
    ]);
  });

  it('leaves an idle worker untouched when the Server link reconnects', async () => {
    // Stop-capture sent to a worker with no session running stopped its session
    // object for good, so the next PREPARE was refused; and every capability
    // change reconnects the link, so every session after the first failed.
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const value = harness({ releaseInput, stopCapture });
    await startAuthenticated(value);

    value.host.onDaemonDisconnected();

    expect(value.host.available()).toBe(true);
    expect(releaseInput).not.toHaveBeenCalled();
    expect(stopCapture).not.toHaveBeenCalled();
  });

  it('retires open routes on Server disconnect and replaces the worker whose session was stopped', async () => {
    const releaseInput = vi.fn();
    const stopCapture = vi.fn();
    const value = harness({ releaseInput, stopCapture });
    await startAuthenticated(value);
    await value.host.handle(prepare());

    value.host.onDaemonDisconnected();

    expect(releaseInput).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.DAEMON_DISCONNECTED,
        workerGeneration: expect.any(Number),
    });
    expect(stopCapture).toHaveBeenCalledWith({
        reason: MACOS_REMOTE_DESKTOP_HOST_CLEANUP_REASON.DAEMON_DISCONNECTED,
        workerGeneration: expect.any(Number),
    });
    expect(value.messages).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: SESSION_ID,
    }));
  });

  it('has no Windows-style worker-side secret mode: unlock support comes only from a node store', () => {
    // Windows hands the secret to its SYSTEM worker binary. macOS never does:
    // without the root store the host reports no support at all.
    const value = harness();
    expect('spawnUnlockSecret' in (value.host as unknown as Record<string, unknown>)).toBe(false);
    expect(value.host.supportsAutoUnlock()).toBe(false);
  });
});

describe('macOS worker host auto unlock', () => {
  it('keeps the sign-in secret in the injected root store and hands it to the IPC server', async () => {
    let kept: string | null = null;
    const unlockSecretStore = {
      configured: async () => kept !== null,
      reveal: async () => kept,
      store: async (value: string) => { kept = value; return true; },
      clear: async () => { kept = null; return true; },
    };
    const { host } = harness({ unlockSecretStore });
    expect(host.supportsAutoUnlock()).toBe(true);
    expect(await host.autoUnlockConfigured()).toBe(false);
    expect(await host.applyAutoUnlockSecret('hunter2')).toBe(true);
    expect(await host.autoUnlockConfigured()).toBe(true);
    expect(await host.applyAutoUnlockSecret(null)).toBe(true);
    expect(await host.autoUnlockConfigured()).toBe(false);
    host.close();
  });

  it('offers no auto unlock without a store', async () => {
    const { host } = harness();
    expect(host.supportsAutoUnlock()).toBe(false);
    expect(await host.applyAutoUnlockSecret('hunter2')).toBe(false);
    expect(await host.autoUnlockConfigured()).toBe(false);
    host.close();
  });
});

describe('macOS worker host management privacy', () => {
  const EPOCH_ID = 'epoch_1234567890abcdef';
  const shieldFrame = (revision = 1) => ({
    type: WORKER_PRIVACY_FRAME.SHIELD,
    epochId: EPOCH_ID,
    revision,
    presentationSource: 'opaque',
    routes: [],
  });
  const releaseFrame = (revision = 1) => ({
    type: WORKER_PRIVACY_FRAME.RELEASE,
    epochId: EPOCH_ID,
    revision,
  });
  const collect = (host: MacosRemoteDesktopWorkerHost): WorkerPrivacyInboundFrame[] => {
    const frames: WorkerPrivacyInboundFrame[] = [];
    host.onPrivacyFrame((frame) => {
      // Every emitted frame must be one the barrier itself would parse.
      expect(parseWorkerPrivacyFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
      frames.push(frame);
    });
    return frames;
  };

  it('advertises capture privacy with a default-shielded route', async () => {
    const value = harness();
    await startAuthenticated(value);
    expect(value.host.adapterCapabilities()).toContain(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);
    expect(value.host.supportsDefaultShieldedRoute()).toBe(true);
  });

  it('shields the connected worker, reports its authorized routes, and releases on a newer real frame', async () => {
    const value = harness();
    await startAuthenticated(value);
    expect(await value.host.handle(prepare())).toBe(true);
    const frames = collect(value.host);

    const shielding = value.host.sendPrivacyFrame(shieldFrame());
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(1));
    expect(value.privacyRequests[0]).toMatchObject({ shield: true, workerGeneration: 1 });
    // Nothing is claimed before the worker answers.
    expect(frames).toEqual([]);
    value.privacyReply(value.privacyRequests[0]!.requestId, {
      shielded: true, realFrameGeneration: 4,
    });
    expect(await shielding).toBe(true);
    expect(frames).toEqual([{
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 5,
      inputReleased: true,
      routes: [{ routeId: SESSION_ID, routeGeneration: 11 }],
    }]);

    // A route added under the shield is reported as a complete new set.
    expect(await value.host.handle(prepare({
      requestId: 'request_222222222',
      sessionId: 'session_222222222',
      capability: 'b'.repeat(43),
      routeGeneration: 12,
    }))).toBe(true);
    expect(frames[1]).toEqual({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 5,
      inputReleased: true,
      routes: [
        { routeId: SESSION_ID, routeGeneration: 11 },
        { routeId: 'session_222222222', routeGeneration: 12 },
      ],
    });

    // A release for another epoch is not honoured.
    expect(await value.host.sendPrivacyFrame({ ...releaseFrame(), epochId: 'epoch_9999999999999999' }))
      .toBe(false);
    const releasing = value.host.sendPrivacyFrame(releaseFrame());
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(2));
    expect(value.privacyRequests[1]).toMatchObject({ shield: false });
    value.privacyReply(value.privacyRequests[1]!.requestId, {
      shielded: false, realFrameGeneration: 6,
    });
    expect(await releasing).toBe(true);
    expect(frames[2]).toEqual({
      type: WORKER_PRIVACY_FRAME.RELEASED,
      epochId: EPOCH_ID,
      secretCleanupComplete: true,
      freshFrameWorkerGeneration: 7,
    });
    expect(frames).toHaveLength(3);
  });

  it('shields immediately with no routes when no worker is connected', async () => {
    const value = harness();
    const frames = collect(value.host);
    expect(await value.host.sendPrivacyFrame(shieldFrame())).toBe(true);
    expect(value.privacyRequests).toEqual([]);
    expect(frames).toEqual([{
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 0,
      inputReleased: true,
      routes: [],
    }]);
    expect(await value.host.sendPrivacyFrame(releaseFrame())).toBe(true);
    expect(frames[1]).toEqual({
      type: WORKER_PRIVACY_FRAME.RELEASED,
      epochId: EPOCH_ID,
      secretCleanupComplete: true,
      freshFrameWorkerGeneration: 1,
    });
  });

  it('shields a newly admitted worker before forwarding any command to it', async () => {
    const value = harness();
    const frames = collect(value.host);
    expect(await value.host.sendPrivacyFrame(shieldFrame())).toBe(true);

    const starting = value.host.start();
    await vi.waitFor(() => expect(value.authenticate()).toBe(true));
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(1));
    expect(value.privacyRequests[0]).toMatchObject({ shield: true, workerGeneration: 1 });
    // Held: the worker is not admitted until its shield is acknowledged.
    expect(value.host.available()).toBe(false);
    expect(await value.host.handle(prepare())).toBe(false);
    expect(value.sent).toEqual([]);

    value.privacyReply(value.privacyRequests[0]!.requestId, {
      shielded: true, realFrameGeneration: 0,
    });
    await starting;
    expect(value.host.available()).toBe(true);
    expect(await value.host.handle(prepare())).toBe(true);
    expect(value.outbound).toEqual(['privacy:true', `command:${REMOTE_DESKTOP_MSG.PREPARE}`]);
    expect(frames.at(-1)).toEqual({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 1,
      inputReleased: true,
      routes: [{ routeId: SESSION_ID, routeGeneration: 11 }],
    });
  });

  it('never emits SHIELDED when the worker reply is missing or contradictory', async () => {
    const value = harness({ privacyReplyTimeoutMs: 20 });
    await startAuthenticated(value);
    const frames = collect(value.host);

    expect(await value.host.sendPrivacyFrame(shieldFrame())).toBe(false);
    expect(value.privacyRequests).toHaveLength(1);

    const contradictory = value.host.sendPrivacyFrame(shieldFrame(2));
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(2));
    value.privacyReply(value.privacyRequests[1]!.requestId, {
      shielded: false, realFrameGeneration: 3,
    });
    expect(await contradictory).toBe(false);
    expect(frames).toEqual([]);
    // Unconfirmed epochs cannot be released either.
    expect(await value.host.sendPrivacyFrame(releaseFrame(2))).toBe(false);
  });

  it('tears the generation down when a shielded admission is not acknowledged', async () => {
    const errors: unknown[] = [];
    const value = harness({
      privacyReplyTimeoutMs: 20,
      onBackgroundError: (error) => errors.push(error),
    });
    expect(await value.host.sendPrivacyFrame(shieldFrame())).toBe(true);
    const starting = value.host.start();
    await vi.waitFor(() => expect(value.authenticate()).toBe(true));
    await starting;
    expect(value.host.available()).toBe(false);
    expect(value.sent).toEqual([]);
    expect(errors).toContainEqual(expect.objectContaining({
      message: 'macos_remote_desktop_worker_host_privacy_shield_failed',
    }));
  });

  it('keeps the frame generation monotonic across a worker restart', async () => {
    const value = harness();
    await startAuthenticated(value);
    const frames = collect(value.host);
    const shielding = value.host.sendPrivacyFrame(shieldFrame());
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(1));
    value.privacyReply(value.privacyRequests[0]!.requestId, {
      shielded: true, realFrameGeneration: 10,
    });
    expect(await shielding).toBe(true);
    expect(frames[0]).toMatchObject({ workerGeneration: 11 });

    value.lifecycle.emit({ type: 'lock' });
    value.lifecycle.emit({ type: 'unlock' });
    await vi.waitFor(() => expect(value.serverStarts).toHaveBeenCalledTimes(2));
    expect(value.authenticate()).toBe(true);
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(2));
    expect(value.privacyRequests[1]).toMatchObject({ shield: true, workerGeneration: 2 });
    // The fresh worker counts from zero again.
    value.privacyReply(value.privacyRequests[1]!.requestId, {
      shielded: true, realFrameGeneration: 0,
    });
    await vi.waitFor(() => expect(value.host.available()).toBe(true));

    const releasing = value.host.sendPrivacyFrame(releaseFrame());
    await vi.waitFor(() => expect(value.privacyRequests).toHaveLength(3));
    value.privacyReply(value.privacyRequests[2]!.requestId, {
      shielded: false, realFrameGeneration: 1,
    });
    expect(await releasing).toBe(true);
    const released = frames.at(-1)!;
    expect(released).toMatchObject({ type: WORKER_PRIVACY_FRAME.RELEASED });
    expect((released as { freshFrameWorkerGeneration: number }).freshFrameWorkerGeneration)
      .toBeGreaterThan(11);
  });
});
