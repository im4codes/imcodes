import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  VerifiedMacosRemoteDesktopArtifact,
} from '../../src/node/macos-remote-desktop-artifact.js';
import {
  createMacosRemoteDesktopProductionDependencies,
  defaultMacosRemoteDesktopArtifactStoreRoot,
  MACOS_REMOTE_DESKTOP_NATIVE_COMMAND,
  MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
  MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
  MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE,
  macosRemoteDesktopNativeCommandInvocation,
  parseMacosRemoteDesktopNativeReadiness,
  type MacosRemoteDesktopNativeReadinessSnapshot,
} from '../../src/node/macos-remote-desktop-production.js';
import {
  MACOS_REMOTE_DESKTOP_READINESS_MODE,
  resolveMacosRemoteDesktopRuntimeProfile,
} from '../../src/node/macos-remote-desktop-readiness.js';
import type { MacosUserSession } from '../../src/node/user-session-launcher.js';

const USER: MacosUserSession = Object.freeze({
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/test/T/',
});

const productionRoots: string[] = [];

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
  return {
    artifactDirectory: '/verified/release',
    manifestPath: '/verified/release/imcodes-remote-desktop.manifest.json',
    setSha256,
    components: {
      worker: {} as never,
      disclosure: {} as never,
      launchAgent: {
        kind: 'launchAgent',
        executablePath: '/verified/release/imcodes-remote-desktop-launch-agent',
        fileName: 'imcodes-remote-desktop-launch-agent',
        size: 1,
        sha256: 'b'.repeat(64),
        bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
        designatedRequirement: 'verified requirement',
      },
    },
    manifest: { os: 'darwin', arch: 'arm64' } as never,
    releaseName: `sha256-${setSha256}`,
  };
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
  const options = createMacosRemoteDesktopProductionDependencies({
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

describe('stock macOS remote-desktop production dependency factory', () => {
  afterEach(async () => {
    await Promise.all(productionRoots.splice(0)
      .map((root) => rm(root, { recursive: true, force: true })));
  });

  it('constructs dependencies only for exact darwin arm64/x64 targets', () => {
    expect(createMacosRemoteDesktopProductionDependencies({ platform: 'linux', arch: 'arm64' }))
      .toBeUndefined();
    expect(createMacosRemoteDesktopProductionDependencies({ platform: 'darwin', arch: 'ia32' }))
      .toBeUndefined();
    expect(createMacosRemoteDesktopProductionDependencies({ platform: 'darwin', arch: 'arm64' }))
      .toBeDefined();
    expect(createMacosRemoteDesktopProductionDependencies({ platform: 'darwin', arch: 'x64' }))
      .toBeDefined();
    expect(defaultMacosRemoteDesktopArtifactStoreRoot('arm64'))
      .toBe('/Library/Application Support/imcodes-node/remote-desktop-worker/darwin-arm64');
  });

  it('selects only verified current or last-known-good artifacts and survives corrupt current', async () => {
    const lkg = artifact('c'.repeat(64));
    const selectArtifact = vi.fn(async (_root: string, selector: 'current' | 'lastKnownGood') => {
      if (selector === 'current') throw new Error('corrupt current');
      return lkg;
    });
    const errors: unknown[] = [];
    const options = createMacosRemoteDesktopProductionDependencies({
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
    const absent = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => null),
    })!;
    await expect(absent.resolveVerifiedArtifact()).resolves.toBeNull();

    const corrupt = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => { throw new Error('corrupt'); }),
    })!;
    await expect(corrupt.resolveVerifiedArtifact()).resolves.toBeNull();
  });

  it('fails closed for headless discovery and ambiguous active Aqua users', async () => {
    const headless = createMacosRemoteDesktopProductionDependencies({
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

  it('fails closed when the native executable lacks the readiness command', async () => {
    const errors: unknown[] = [];
    const verified = artifact();
    const options = createMacosRemoteDesktopProductionDependencies({
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
    const launches: Array<{ args: readonly string[]; child: ChildProcess }> = [];
    const options = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeNativeCommand: async () => JSON.stringify(snapshot()),
      launchNativeCleanup: (_user, _executable, args) => {
        const child = new EventEmitter() as ChildProcess;
        launches.push({ args, child });
        return child;
      },
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();

    // Spawn acceptance is not success: a command that exits nonzero must not be
    // reported as a completed release/stop.
    const failing = options.releaseInput?.({ reason: 'close', workerGeneration: 3 });
    launches[0]!.child.emit('exit', 2, null);
    expect(await failing).toMatchObject({ ok: false });

    // Generation 0 means "whatever is live" to the native command, so a stale
    // request must be refused before anything is spawned.
    const launchCount = launches.length;
    expect(await options.stopCapture?.({ reason: 'close', workerGeneration: 0 }))
      .toMatchObject({ ok: false });
    expect(launches).toHaveLength(launchCount);
  });

  it('uses bounded fixed cleanup commands and never carries an ambient credential', async () => {
    const verified = artifact();
    const launches: Array<{
      user: MacosUserSession;
      executable: string;
      args: readonly string[];
      child: ChildProcess;
    }> = [];
    const options = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      selectArtifact: vi.fn(async () => verified),
      resolveUserSession: async () => USER,
      executeNativeCommand: async () => JSON.stringify(snapshot()),
      launchNativeCleanup: (user, executable, args) => {
        const child = new EventEmitter() as ChildProcess;
        launches.push({ user, executable, args, child });
        return child;
      },
    })!;
    await options.resolveVerifiedArtifact();
    await options.resolveUserSession();
    const release = options.releaseInput?.({ reason: 'close', workerGeneration: 7 });
    const stop = options.stopCapture?.({ reason: 'close', workerGeneration: 7 });
    // Settle both children so the awaited results are real exit status, not
    // spawn acceptance.
    for (const entry of launches) (entry.child as EventEmitter).emit('exit', 0, null);
    expect(await release).toEqual({ ok: true });
    expect(await stop).toEqual({ ok: true });

    expect(launches.map(({ user, executable, args }) => ({ user, executable, args }))).toEqual([
      {
        user: USER,
        executable: verified.components.launchAgent.executablePath,
        args: [
          MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput,
          MACOS_REMOTE_DESKTOP_NATIVE_GENERATION_ARGUMENT,
          '7',
        ],
      },
      {
        user: USER,
        executable: verified.components.launchAgent.executablePath,
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
      verified.components.launchAgent.executablePath,
      [MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness],
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
