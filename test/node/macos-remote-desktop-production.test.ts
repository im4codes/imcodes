import { once } from 'node:events';
import net from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  VerifiedMacosRemoteDesktopArtifact,
} from '../../src/node/macos-remote-desktop-artifact.js';
import {
  createMacosRemoteDesktopProductionDependencies,
  createMacosRemoteDesktopProductionGlobalBootstrapListener,
  defaultMacosRemoteDesktopArtifactStoreRoot,
  inspectMacosRemoteDesktopAuthorityReadiness,
  MACOS_REMOTE_DESKTOP_NATIVE_COMMAND,
  MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
  MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
  MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE,
  macosRemoteDesktopNativeCommandInvocation,
  parseMacosRemoteDesktopNativeReadiness,
  type MacosRemoteDesktopProductionDependencies,
  type MacosRemoteDesktopNativeReadinessSnapshot,
} from '../../src/node/macos-remote-desktop-production.js';
import {
  MACOS_REMOTE_DESKTOP_READINESS_MODE,
  resolveMacosRemoteDesktopRuntimeProfile,
} from '../../src/node/macos-remote-desktop-readiness.js';
import type { MacosUserSession } from '../../src/node/user-session-launcher.js';
import { macosRemoteDesktopGraphicalSessionPaths } from '../../src/node/macos-user-session.js';
import {
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE,
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
} from '../../src/node/macos-remote-desktop-global-agent-bootstrap.js';
import {
  MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
} from '../../src/node/macos-remote-desktop-graphical-readiness.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_MESSAGE,
} from '../../src/node/macos-remote-desktop-ipc.js';
import { MacosRemoteDesktopWorkerHost } from '../../src/node/macos-remote-desktop-worker-host.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';

const USER: MacosUserSession = Object.freeze({
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/test/T/',
});

const productionRoots: string[] = [];

function stockFactory(dependencies: MacosRemoteDesktopProductionDependencies = {}) {
  return createMacosRemoteDesktopProductionDependencies({
    createGlobalBootstrapListener: (() => ({
      start: async () => undefined,
      stop: async () => undefined,
    })) as never,
    installGlobalLaunchAgent: async () => ({ rollback: async () => undefined }),
    loadGlobalLaunchAgent: async () => ({ loaded: false, unload: async () => undefined }),
    ...dependencies,
  });
}

/**
 * A REAL store on disk, owned by this process and mode 0700.
 *
 * `inspectReadiness` now re-asserts store trust immediately before running the
 * LaunchAgent, so a fixture pointing at a path that does not exist makes every
 * readiness answer UNAVAILABLE and hides whatever the test meant to check. The
 * store has to be real for the readiness assertions to mean anything.
 */
async function trustedStore(releaseName: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-macos-production-store-'));
  productionRoots.push(root);
  await mkdir(join(root, 'releases', releaseName), { recursive: true, mode: 0o700 });
  await chmod(join(root, 'releases', releaseName), 0o700);
  await chmod(join(root, 'releases'), 0o700);
  await chmod(root, 0o700);
  return root;
}

function artifact(setSha256 = 'a'.repeat(64)): VerifiedMacosRemoteDesktopArtifact {
  const requirement = 'identifier "cc.imcodes.node.remote-desktop-agent" and anchor apple generic and certificate leaf[subject.OU] = "M675E26Q67"';
  return {
    artifactDirectory: '/verified/release',
    manifestPath: '/verified/release/imcodes-remote-desktop.manifest.json',
    setSha256,
    components: {
      worker: {
        kind: 'worker',
        executablePath: '/verified/release/imcodes-remote-desktop-worker',
        fileName: 'imcodes-remote-desktop-worker',
        size: 1,
        sha256: 'e'.repeat(64),
        bundleIdentifier: 'cc.imcodes.node.remote-desktop-worker',
        designatedRequirement: 'identifier "cc.imcodes.node.remote-desktop-worker" and anchor apple generic and certificate leaf[subject.OU] = "M675E26Q67"',
      },
      disclosure: {} as never,
      launchAgent: {
        kind: 'launchAgent',
        executablePath: '/verified/release/imcodes-remote-desktop-launch-agent',
        fileName: 'imcodes-remote-desktop-launch-agent',
        size: 1,
        sha256: 'b'.repeat(64),
        bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
        designatedRequirement: requirement,
      },
    },
    manifest: {
      os: 'darwin',
      arch: 'arm64',
      components: {
        launchAgent: {
          fileName: 'imcodes-remote-desktop-launch-agent',
          size: 1,
          sha256: 'b'.repeat(64),
        },
        virtualDisplayHelper: { sha256: 'd'.repeat(64) },
      },
      codeSignature: {
        teamId: 'M675E26Q67',
        bundles: {
          launchAgent: {
            bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
            designatedRequirement: requirement,
            hardenedRuntime: true,
          },
        },
      },
    } as never,
    releaseName: `sha256-${setSha256}`,
  };
}

function bootstrapArtifact(): VerifiedMacosRemoteDesktopArtifact {
  return artifact();
}

function snapshot(
  overrides: Partial<MacosRemoteDesktopNativeReadinessSnapshot> = {},
): MacosRemoteDesktopNativeReadinessSnapshot {
  return {
    version: MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
    activeAquaUserUids: [USER.uid],
    sessionState: MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.ACTIVE_UNLOCKED,
    screenRecording: true,
    encoder: true,
    accessibility: true,
    clipboard: true,
    disclosure: true,
    lifecycleObservation: true,
    releaseInput: true,
    stopCapture: true,
    virtualDisplay: true,
    ...overrides,
  };
}

async function readyHarness(
  nativeSnapshot: MacosRemoteDesktopNativeReadinessSnapshot,
) {
  const verified = artifact();
  const executeNativeCommand = vi.fn(async () => JSON.stringify(nativeSnapshot));
  const storeRoot = await trustedStore(verified.releaseName!);
  const options = stockFactory({
    platform: 'darwin',
    arch: 'arm64',
    storeRoot,
    selectArtifact: vi.fn(async (_root, selector) => selector === 'current' ? verified : null),
    resolveUserSession: async () => USER,
    executeNativeCommand,
  })!;
  expect(await options.resolveVerifiedArtifact()).toBe(verified);
  expect(await options.resolveUserSession()).toBe(USER);
  return {
    options,
    storeRoot,
    verified,
    readiness: await options.inspectReadiness(verified, USER),
    executeNativeCommand,
  };
}

function exchangeBootstrap(socketPath: string, hello: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(hello)}\n`));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      try {
        resolve(JSON.parse(response.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function readSocketLine(socket: net.Socket): Promise<string> {
  let buffer = Buffer.alloc(0);
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolve(buffer.subarray(0, newline).toString('utf8'));
    };
    const onClose = () => { cleanup(); reject(new Error('socket_closed_before_line')); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

describe('stock macOS remote-desktop production dependency factory', () => {
  afterEach(async () => {
    await Promise.all(productionRoots.splice(0)
      .map((root) => rm(root, { recursive: true, force: true })));
  });

  it('constructs dependencies only for exact darwin arm64/x64 targets', () => {
    expect(stockFactory({ platform: 'linux', arch: 'arm64' }))
      .toBeUndefined();
    expect(stockFactory({ platform: 'darwin', arch: 'ia32' }))
      .toBeUndefined();
    expect(stockFactory({ platform: 'darwin', arch: 'arm64' }))
      .toBeDefined();
    expect(stockFactory({ platform: 'darwin', arch: 'x64' }))
      .toBeDefined();
    expect(defaultMacosRemoteDesktopArtifactStoreRoot('arm64'))
      .toBe('/Library/Application Support/imcodes-node/remote-desktop-worker/darwin-arm64');
  });

  it('uses authenticated composition for LoginWindow without invoking active-user readiness', async () => {
    const inspectAqua = vi.fn(async () => ({
      screenRecording: true,
      encoder: true,
      accessibility: true,
      clipboard: true,
      disclosure: true,
      virtualDisplay: true,
    }));
    const loginWindow = Object.freeze({
      kind: 'loginwindow_bootstrap' as const,
      sessionType: 'LoginWindow' as const,
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 44,
    });
    const grant = Object.freeze({
      type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT,
      bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
      uid: 88,
      auditSessionId: 100000,
      sessionType: 'LoginWindow' as const,
      instanceNonce: 'N'.repeat(43),
      workerGeneration: 7,
      challenge: 'C'.repeat(43),
      socketPath:
        '/private/var/run/imcodes-node/graphical-sessions/88/100000/remote-desktop-agent.sock',
    });
    const readiness = await inspectMacosRemoteDesktopAuthorityReadiness(loginWindow, {
      inspectAqua,
      grant,
      graphicalAttestation: JSON.stringify({
        type: 'remote_desktop.macos_ipc.graphical_readiness',
        ipcVersion: 1,
        workerGeneration: 7,
        uid: 88,
        auditSessionId: 100000,
        pidVersion: 44,
        sessionType: 'LoginWindow',
        launchChallenge: 'C'.repeat(43),
        capture: true,
        encoder: true,
        input: true,
        clipboard: false,
        display: true,
        disclosure: true,
        graphicalSession: true,
        cleanupReachable: true,
      }),
    });
    expect(inspectAqua).not.toHaveBeenCalled();
    expect(readiness).toEqual({
      screenRecording: true,
      encoder: true,
      accessibility: true,
      clipboard: false,
      disclosure: true,
      virtualDisplay: true,
    });
  });

  it('keeps Aqua on the existing user readiness command and fails closed without LoginWindow proof', async () => {
    const inspectAqua = vi.fn(async () => ({
      screenRecording: true,
      encoder: true,
      accessibility: true,
      clipboard: true,
      disclosure: true,
    }));
    const aqua = Object.freeze({
      kind: 'aqua_user' as const,
      sessionType: 'Aqua' as const,
      auditSessionId: 100003,
      pidVersion: 45,
      user: USER,
    });
    expect(await inspectMacosRemoteDesktopAuthorityReadiness(aqua, { inspectAqua }))
      .toMatchObject({ clipboard: true });
    expect(inspectAqua).toHaveBeenCalledWith(USER);

    const loginWindow = Object.freeze({
      kind: 'loginwindow_bootstrap' as const,
      sessionType: 'LoginWindow' as const,
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 44,
    });
    expect(await inspectMacosRemoteDesktopAuthorityReadiness(loginWindow, { inspectAqua }))
      .toEqual({
        screenRecording: false,
        encoder: false,
        accessibility: false,
        clipboard: false,
        disclosure: false,
      });
    expect(inspectAqua).toHaveBeenCalledTimes(1);
  });

  it('injects the production bootstrap listener with native uid/asid verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-production-bootstrap-'));
    const socketPath = join(directory, 'bootstrap.sock');
    const verifierOptions: unknown[] = [];
    const authorities: unknown[] = [];
    const listener = createMacosRemoteDesktopProductionGlobalBootstrapListener({
      artifact: bootstrapArtifact(),
      socketPath,
      prepareSocketPath: async () => undefined,
      secureSocketPath: async () => undefined,
      createPeerVerificationSeams: ((options: unknown) => {
        verifierOptions.push(options);
        return {
          inspectPeerUid: async () => 88,
          verifyPeerCodeIdentity: async () => ({}) as never,
          verifyPeer: async () => ({
            uid: 88,
            auditSessionId: 100000,
            pidVersion: 4,
            sessionType: 'LoginWindow',
            bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
            teamId: 'M675E26Q67',
            designatedRequirement:
              'identifier "cc.imcodes.node.remote-desktop-agent" and anchor apple generic and certificate leaf[subject.OU] = "M675E26Q67"',
          }),
        };
      }) as never,
      createLaunch: async (authority) => {
        authorities.push(authority);
        return {
          workerGeneration: 1,
          challenge: 'C'.repeat(43),
          socketPath: macosRemoteDesktopGraphicalSessionPaths({
            uid: authority.kind === 'aqua_user' ? authority.user.uid : authority.uid,
            auditSessionId: authority.auditSessionId,
          }).socketPath,
        };
      },
      revoke: vi.fn(),
    });
    try {
      await listener.start();
      const response = await exchangeBootstrap(socketPath, {
        type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO,
        bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
        uid: 88,
        auditSessionId: 100000,
        sessionType: 'LoginWindow',
        instanceNonce: 'L'.repeat(43),
      });
      expect(response).toMatchObject({ uid: 88, auditSessionId: 100000 });
      expect(verifierOptions).toHaveLength(1);
      expect(verifierOptions[0]).toMatchObject({
        expectedUid: 88,
        expectedAuditSessionId: 100000,
      });
      expect(authorities).toEqual([{
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
        uid: 88,
        auditSessionId: 100000,
        pidVersion: 4,
      }]);
    } finally {
      await listener.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a LoginWindow declaration when native peer classification is Aqua', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-production-session-type-'));
    const socketPath = join(directory, 'bootstrap.sock');
    const errors: unknown[] = [];
    const createLaunch = vi.fn();
    const listener = createMacosRemoteDesktopProductionGlobalBootstrapListener({
      artifact: bootstrapArtifact(),
      socketPath,
      prepareSocketPath: async () => undefined,
      secureSocketPath: async () => undefined,
      createPeerVerificationSeams: (() => ({
        inspectPeerUid: async () => 88,
        verifyPeerCodeIdentity: async () => ({}) as never,
        verifyPeer: async () => ({
          uid: 88,
          auditSessionId: 100000,
          pidVersion: 4,
          sessionType: 'Aqua',
          bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
          teamId: 'M675E26Q67',
          designatedRequirement:
            'identifier "cc.imcodes.node.remote-desktop-agent" and anchor apple generic and certificate leaf[subject.OU] = "M675E26Q67"',
        }),
      })) as never,
      createLaunch,
      revoke: vi.fn(),
      onBackgroundError: (error) => errors.push(error),
    });
    try {
      await listener.start();
      await expect(exchangeBootstrap(socketPath, {
        type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO,
        bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
        uid: 88,
        auditSessionId: 100000,
        sessionType: 'LoginWindow',
        instanceNonce: 'L'.repeat(43),
      })).rejects.toBeDefined();
      expect(createLaunch).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    } finally {
      await listener.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('traverses the stock factory, bootstrap socket, exact grant, IPC ACK and readiness socket', async () => {
    const verified = bootstrapArtifact();
    const storeRoot = await trustedStore(verified.releaseName!);
    const runtimeRoot = await realpath(await mkdtemp(join(tmpdir(), 'rd-')));
    const bootstrapDirectory = await mkdtemp(join(tmpdir(), 'ird-bootstrap-e2e-'));
    productionRoots.push(runtimeRoot, bootstrapDirectory);
    const bootstrapSocketPath = join(bootstrapDirectory, 'bootstrap.sock');
    const uid = process.getuid?.() || 501;
    const auditSessionId = 100_004;
    const pidVersion = 17;
    const unload = vi.fn(async () => undefined);
    const installRollback = vi.fn(async () => undefined);
    const errors: unknown[] = [];
    const lifecycleOrder: string[] = [];
    let workerSocket: net.Socket | null = null;
    let client: Promise<void> | null = null;
    const options = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      runtimeRoot,
      storeRoot,
      bootstrapSocketPath,
      prepareBootstrapSocketPath: async () => undefined,
      secureBootstrapSocketPath: async () => undefined,
      selectArtifact: vi.fn(async (_root, selector) => selector === 'current' ? verified : null),
      resolveUserSession: async () => {
        throw new Error('computer_use_no_active_gui_session');
      },
      installGlobalLaunchAgent: async () => {
        lifecycleOrder.push('install');
        return { rollback: installRollback };
      },
      loadGlobalLaunchAgent: async () => {
        lifecycleOrder.push('load');
        client = (async () => {
          const grant = await exchangeBootstrap(bootstrapSocketPath, {
            type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO,
            bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
            uid,
            auditSessionId,
            sessionType: 'LoginWindow',
            instanceNonce: 'L'.repeat(43),
          });
          const socket = net.createConnection({ path: String(grant.socketPath) });
          workerSocket = socket;
          await once(socket, 'connect');
          socket.write(`${JSON.stringify({
            type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            workerGeneration: grant.workerGeneration,
            challenge: grant.challenge,
          })}\n`);
          const acknowledgement = JSON.parse(await readSocketLine(socket));
          expect(acknowledgement).toEqual({
            type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.AUTHENTICATED,
            ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
            workerGeneration: grant.workerGeneration,
            uid,
            auditSessionId,
            pidVersion,
            sessionType: 'LoginWindow',
            launchChallenge: grant.challenge,
          });
          socket.write(`${JSON.stringify({
            type: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
            ipcVersion: 1,
            workerGeneration: grant.workerGeneration,
            uid,
            auditSessionId,
            pidVersion,
            sessionType: 'LoginWindow',
            launchChallenge: grant.challenge,
            capture: true,
            encoder: true,
            input: true,
            clipboard: false,
            display: false,
            disclosure: true,
            graphicalSession: true,
            cleanupReachable: true,
          })}\n`);
        })();
        return { loaded: true, unload };
      },
      createPeerVerificationSeams: ((verificationOptions: {
        expectedCodeIdentity: {
          bundleIdentifier: string;
          teamId: string;
          designatedRequirement: string;
        };
      }) => {
        const identity = verificationOptions.expectedCodeIdentity;
        const verifiedPeer = Object.freeze({
          uid,
          auditSessionId,
          pidVersion,
          sessionType: 'LoginWindow' as const,
          bundleIdentifier: identity.bundleIdentifier,
          teamId: identity.teamId,
          designatedRequirement: identity.designatedRequirement,
        });
        return {
          inspectPeerUid: async () => uid,
          verifyPeer: async () => verifiedPeer,
          verifyPeerCodeIdentity: async () => ({
            bundleIdentifier: identity.bundleIdentifier,
            teamId: identity.teamId,
            designatedRequirement: identity.designatedRequirement,
            auditSessionId,
            pidVersion,
          }),
        };
      }) as never,
      graphicalAuthorityTimeoutMs: 2_000,
      onBackgroundError: (error) => errors.push(error),
    })!;
    const host = new MacosRemoteDesktopWorkerHost(() => undefined, options);
    await host.start();
    await client?.catch((error) => {
      throw new Error(`${String(error)}; background=${errors.map(String).join('|')}`);
    });
    expect(host.available(), errors.map(String).join('|')).toBe(true);
    expect(host.adapterCapabilities().length).toBeGreaterThan(0);
    expect(lifecycleOrder).toEqual(['install', 'load']);
    expect(installRollback).not.toHaveBeenCalled();

    host.close();
    workerSocket?.destroy();
    await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
    expect(host.available()).toBe(false);
    await expect(readFile(bootstrapSocketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(errors.filter((error) => String(error).includes('graphical_readiness'))).toEqual([]);
  });

  it('rolls back install and closes the listener when activation fails', async () => {
    const verified = bootstrapArtifact();
    const storeRoot = await trustedStore(verified.releaseName!);
    const directory = await mkdtemp(join(tmpdir(), 'ird-bootstrap-rollback-'));
    productionRoots.push(directory);
    const socketPath = join(directory, 'bootstrap.sock');
    const rollback = vi.fn(async () => undefined);
    const options = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      storeRoot,
      bootstrapSocketPath: socketPath,
      prepareBootstrapSocketPath: async () => undefined,
      secureBootstrapSocketPath: async () => undefined,
      selectArtifact: vi.fn(async () => verified),
      installGlobalLaunchAgent: async () => ({ rollback }),
      loadGlobalLaunchAgent: async () => { throw new Error('load_failed'); },
      createPeerVerificationSeams: (() => ({
        inspectPeerUid: async () => 501,
        verifyPeerCodeIdentity: async () => ({}) as never,
        verifyPeer: async () => ({}) as never,
      })) as never,
    })!;
    await expect(options.resolveVerifiedArtifact()).resolves.toBeNull();
    expect(rollback).toHaveBeenCalledOnce();
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selects only verified current or last-known-good artifacts and survives corrupt current', async () => {
    const lkg = artifact('c'.repeat(64));
    const selectArtifact = vi.fn(async (_root: string, selector: 'current' | 'lastKnownGood') => {
      if (selector === 'current') throw new Error('corrupt current');
      return lkg;
    });
    const errors: unknown[] = [];
    const options = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      storeRoot: '/protected/macos-artifacts',
      selectArtifact: selectArtifact as never,
      onBackgroundError: (error) => errors.push(error),
    })!;

    await expect(options.resolveVerifiedArtifact()).resolves.toBe(lkg);
    expect(selectArtifact.mock.calls).toEqual([
      ['/protected/macos-artifacts', 'current', { runtime: { platform: 'darwin', arch: 'arm64' } }],
      ['/protected/macos-artifacts', 'lastKnownGood', { runtime: { platform: 'darwin', arch: 'arm64' } }],
    ]);
    expect(errors).toHaveLength(1);
  });

  it('advertises nothing when both current and last-known-good are absent or corrupt', async () => {
    const absent = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => null),
    })!;
    await expect(absent.resolveVerifiedArtifact()).resolves.toBeNull();

    const corrupt = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => { throw new Error('corrupt'); }),
    })!;
    await expect(corrupt.resolveVerifiedArtifact()).resolves.toBeNull();
  });

  it('fails closed for headless discovery and ambiguous active Aqua users', async () => {
    const headless = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => artifact()),
      resolveUserSession: async () => { throw new Error('no Aqua user'); },
    })!;
    await headless.resolveVerifiedArtifact();
    await expect(headless.resolveUserSession()).rejects.toThrow('no Aqua user');

    const ambiguous = await readyHarness(snapshot({ activeAquaUserUids: [501, 502] }));
    expect(ambiguous.readiness).toEqual({
      screenRecording: false,
      encoder: false,
      accessibility: false,
      clipboard: false,
      disclosure: false,
    });
  });

  it('keeps denied capture and unavailable disclosure fail closed', async () => {
    const deniedCapture = await readyHarness(snapshot({ screenRecording: false }));
    expect(resolveMacosRemoteDesktopRuntimeProfile({
      artifactVerified: true,
      activeUserQualified: true,
      ...deniedCapture.readiness,
    }).mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);

    const noDisclosure = await readyHarness(snapshot({ disclosure: false }));
    expect(resolveMacosRemoteDesktopRuntimeProfile({
      artifactVerified: true,
      activeUserQualified: true,
      ...noDisclosure.readiness,
    }).mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);
  });

  it('re-checks store trust at the readiness boundary and fails closed when it is loosened', async () => {
    // Selection validated the store, then RETURNED A PATH. Everything after
    // that is a window: chmod 0777 the store and the executable readiness is
    // about to run is one an attacker can replace. Readiness is the last thing
    // that happens before that binary is used for real, so it re-checks.
    const value = await readyHarness(snapshot());
    expect(value.readiness.screenRecording).toBe(true);
    const releaseDirectory = join(value.storeRoot, 'releases', value.verified.releaseName!);
    const loosenings: Array<[string, () => Promise<void>]> = [
      ['store world-writable', () => chmod(value.storeRoot, 0o777)],
      ['releases world-writable', () => chmod(join(value.storeRoot, 'releases'), 0o777)],
      ['release world-writable', () => chmod(releaseDirectory, 0o777)],
      ['release replaced', () => rm(releaseDirectory, { recursive: true, force: true })],
    ];
    for (const [label, loosen] of loosenings) {
      await chmod(value.storeRoot, 0o700);
      await chmod(join(value.storeRoot, 'releases'), 0o700);
      await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
      await chmod(releaseDirectory, 0o700);
      // Trusted again, so this test cannot pass by being permanently broken.
      expect(
        (await value.options.inspectReadiness(value.verified, USER)).screenRecording, label,
      ).toBe(true);
      await loosen();
      expect(
        (await value.options.inspectReadiness(value.verified, USER)).screenRecording, label,
      ).toBe(false);
    }
  });

  it('downgrades to View when Accessibility is absent', async () => {
    const value = await readyHarness(snapshot({ accessibility: false }));
    expect(resolveMacosRemoteDesktopRuntimeProfile({
      artifactVerified: true,
      activeUserQualified: true,
      ...value.readiness,
    }).mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.VIEW);
  });

  it('requires native lifecycle and cleanup readiness before any profile is usable', async () => {
    for (const override of [
      { sessionState: MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.LOCKED },
      { lifecycleObservation: false },
      { releaseInput: false },
      { stopCapture: false },
    ] as const) {
      const value = await readyHarness(snapshot(override));
      expect(value.readiness).toEqual({
        screenRecording: false,
        encoder: false,
        accessibility: false,
        clipboard: false,
        disclosure: false,
      });
    }
  });

  // The native `releaseInput`/`stopCapture` fields are a CAPABILITY claim by
  // the signed build, not a claim that a generation is live. That distinction
  // is what makes the gate above satisfiable at all: readiness is collected by
  // a cold, short-lived process that by construction owns no generation, so if
  // the native side answered liveness these would be permanently false, every
  // profile would be UNAVAILABLE forever, and no generation could ever be
  // created to change it. The gate itself is deliberately NOT relaxed here --
  // it still demands both -- so this pins the other half of the contract.
  it('admits a profile only when every real gate holds, cleanup capability included', async () => {
    const gates = [
      ['screen recording denied', { screenRecording: false }],
      ['session locked', { sessionState: MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.LOCKED }],
      ['session sleeping', { sessionState: MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.SLEEPING }],
      ['no lifecycle observation', { lifecycleObservation: false }],
      ['no release-input capability', { releaseInput: false }],
      ['no stop-capture capability', { stopCapture: false }],
      ['ambiguous active user', { activeAquaUserUids: [501, 502] }],
      ['no disclosure', { disclosure: false }],
    ] as const;
    for (const [label, override] of gates) {
      const value = await readyHarness(snapshot(override));
      expect(resolveMacosRemoteDesktopRuntimeProfile({
        artifactVerified: true,
        activeUserQualified: true,
        ...value.readiness,
      }).mode, label).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);
    }

    // Only with every gate satisfied -- including cleanup capability, which a
    // cold probe CAN legitimately answer -- does the profile become eligible.
    const eligible = await readyHarness(snapshot());
    const profile = resolveMacosRemoteDesktopRuntimeProfile({
      artifactVerified: true,
      activeUserQualified: true,
      ...eligible.readiness,
    });
    expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.CONTROL);

    // ...and an unverified artifact still overrides all of it.
    expect(resolveMacosRemoteDesktopRuntimeProfile({
      artifactVerified: false,
      activeUserQualified: true,
      ...eligible.readiness,
    }).mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);
  });

  it('fails closed when the native executable lacks the readiness command', async () => {
    const errors: unknown[] = [];
    const verified = artifact();
    const options = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeNativeCommand: async () => { throw new Error('unsupported command'); },
      onBackgroundError: (error) => errors.push(error),
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();
    await expect(options.inspectReadiness(verified, USER)).resolves.toEqual({
      screenRecording: false,
      encoder: false,
      accessibility: false,
      clipboard: false,
      disclosure: false,
    });
    expect(errors).toHaveLength(1);
  });

  it('treats a nonzero cleanup exit as failure and refuses generation 0', async () => {
    const verified = artifact();
    const launches: Array<{ args: readonly string[] }> = [];
    const options = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeNativeCommand: async () => JSON.stringify(snapshot()),
      launchNativeCleanup: async (_user, _component, args) => {
        launches.push({ args });
        throw new Error('native cleanup failed');
      },
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();

    // Spawn acceptance is not success: a command that exits nonzero must not be
    // reported as a completed release/stop.
    expect(await options.releaseInput?.({ reason: 'close', workerGeneration: 3 }))
      .toMatchObject({ ok: false });

    // Generation 0 means "whatever is live" to the native command, so a stale
    // request must be refused before anything is spawned.
    const launchCount = launches.length;
    expect(await options.stopCapture?.({ reason: 'close', workerGeneration: 0 }))
      .toMatchObject({ ok: false });
    expect(launches).toHaveLength(launchCount);
  });

  it('uses one responsibility-safe runner for readiness and generation cleanup', async () => {
    const verified = artifact();
    const storeRoot = await trustedStore(verified.releaseName!);
    const executeResponsibleCommand = vi.fn(async ({ args }) => {
      if (args[0] === MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness) {
        return { stdout: `${JSON.stringify(snapshot())}\n`, stderr: '' };
      }
      if (args[0] === MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput) {
        return { stdout: 'macos_remote_desktop_release_input_ok\n', stderr: '' };
      }
      return { stdout: '', stderr: 'macos_remote_desktop_stop_capture_no_active_generation\n' };
    });
    const options = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      storeRoot,
      responsibleAppPath: '/verified/aiDesk.to by IM.codes.app',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeResponsibleCommand,
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();

    await expect(options.inspectReadiness(verified, USER)).resolves.toMatchObject({
      screenRecording: true,
      clipboard: true,
    });
    await expect(options.releaseInput?.({ reason: 'close', workerGeneration: 11 }))
      .resolves.toEqual({ ok: true });
    await expect(options.stopCapture?.({ reason: 'close', workerGeneration: 11 }))
      .resolves.toMatchObject({ ok: false });

    expect(executeResponsibleCommand).toHaveBeenCalledTimes(3);
    for (const [request] of executeResponsibleCommand.mock.calls) {
      expect(request.user).toBe(USER);
      expect(request.component).toBe(verified.components.worker);
      expect(request.appPath).toBe('/verified/aiDesk.to by IM.codes.app');
    }
    expect(executeResponsibleCommand.mock.calls.map(([request]) => request.args)).toEqual([
      [MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness],
      [
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput,
        MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
        '11',
      ],
      [
        MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture,
        MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
        '11',
      ],
    ]);
  });

  it('uses bounded fixed cleanup commands and never carries an ambient credential', async () => {
    const verified = artifact();
    const launches: Array<{
      user: MacosUserSession;
      component: VerifiedMacosRemoteDesktopArtifact['components']['worker'];
      args: readonly string[];
    }> = [];
    const options = stockFactory({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeNativeCommand: async () => JSON.stringify(snapshot()),
      launchNativeCleanup: async (user, component, args) => {
        launches.push({ user, component, args });
      },
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();
    const release = options.releaseInput?.({ reason: 'close', workerGeneration: 7 });
    const stop = options.stopCapture?.({ reason: 'close', workerGeneration: 7 });
    expect(await release).toEqual({ ok: true });
    expect(await stop).toEqual({ ok: true });

    expect(launches).toEqual([
      {
        user: USER,
        component: verified.components.worker,
        args: [
          MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput,
          MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
          '7',
        ],
      },
      {
        user: USER,
        component: verified.components.worker,
        args: [
          MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture,
          MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
          '7',
        ],
      },
    ]);
    expect(JSON.stringify(launches)).not.toMatch(/credential|node.?token|bearer|secret/iu);

    const invocation = macosRemoteDesktopNativeCommandInvocation(
      USER,
      '/Library/Application Support/aidesk/aiDesk.to by IM.codes.app',
      [MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness],
      { stdout: '/tmp/stdout', stderr: '/tmp/stderr' },
    );
    expect(invocation.env).toEqual({});
    expect(JSON.stringify(invocation)).not.toMatch(/credential|node.?token|bearer|secret/iu);
  });

  it('rejects unknown or widened readiness contracts', () => {
    expect(() => parseMacosRemoteDesktopNativeReadiness(JSON.stringify({
      ...snapshot(),
      unexpected: true,
    }))).toThrow('macos_remote_desktop_native_readiness_invalid');
    expect(() => parseMacosRemoteDesktopNativeReadiness(JSON.stringify({
      ...snapshot(),
      version: 2,
    }))).toThrow('macos_remote_desktop_native_readiness_invalid');
  });

  it('wires the stock node entry point to the production factory only through the option seam', async () => {
    const source = await readFile(fileURLToPath(new URL('../../src/node/index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("import { createMacosRemoteDesktopProductionDependencies } from './macos-remote-desktop-production.js';");
    expect(source).toContain("process.platform === 'darwin'");
    expect(source).toContain("process.arch === 'arm64' || process.arch === 'x64'");
    expect(source).toContain('    macosRemoteDesktopWorker,');
  });
});
