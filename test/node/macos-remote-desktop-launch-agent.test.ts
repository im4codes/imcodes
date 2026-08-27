import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
  REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
  REMOTE_DESKTOP_WORKER_IPC_VERSION,
  type RemoteDesktopMacosWorkerManifest,
  REMOTE_DESKTOP_MACOS_TEAM_ID,
} from '../../shared/remote-desktop-worker.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../shared/remote-desktop.js';
import type { VerifiedMacosRemoteDesktopArtifact } from '../../src/node/macos-remote-desktop-artifact.js';
import type { MacosRemoteDesktopIpcLaunch } from '../../src/node/macos-remote-desktop-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT,
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR,
  MacosRemoteDesktopLaunchAgentSupervisor,
  buildMacosRemoteDesktopLaunchAgentDefinition,
  macosRemoteDesktopLaunchctlArgs,
  type MacosRemoteDesktopLaunchAgentDefinition,
  type MacosRemoteDesktopLaunchAgentSupervisorDependencies,
  type MacosRemoteDesktopLifecycleEvent,
  type MacosRemoteDesktopLifecycleSource,
} from '../../src/node/macos-remote-desktop-launch-agent.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  macosRemoteDesktopUserSessionPaths,
} from '../../src/node/macos-user-session.js';
import type { MacosUserSession } from '../../src/node/user-session-launcher.js';

const TEAM_ID = REMOTE_DESKTOP_MACOS_TEAM_ID;
const USER: MacosUserSession = {
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/ab/session/T/',
};
const OTHER_USER: MacosUserSession = {
  name: 'second-user',
  uid: 502,
  gid: 20,
  home: '/Users/second-user',
  tempDir: '/private/var/folders/cd/session/T/',
};

function designatedRequirement(bundleIdentifier: string): string {
  return `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
}

function manifest(): RemoteDesktopMacosWorkerManifest {
  return {
    manifestVersion: REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION,
    artifactKind: REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND,
    workerVersion: '2026.8.5000',
    protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    os: 'darwin',
    arch: 'arm64',
    components: {
      worker: {
        fileName: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
        size: 1024,
        sha256: 'a'.repeat(64),
        notarization: {
          status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000',
          ticketSha256: 'a'.repeat(64), stapled: true, stapleValidated: true,
        },
      },
      launchAgent: {
        fileName: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
        size: 2048,
        sha256: 'b'.repeat(64),
        notarization: {
          status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000',
          ticketSha256: 'b'.repeat(64), stapled: true, stapleValidated: true,
        },
      },
      disclosure: {
        fileName: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
        size: 4096,
        sha256: 'c'.repeat(64),
        notarization: {
          status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000',
          ticketSha256: 'c'.repeat(64), stapled: true, stapleValidated: true,
        },
      },
      virtualDisplayHelper: {
        fileName: 'imcodes-virtual-display-helper',
        size: 4096,
        sha256: 'e'.repeat(64),
        notarization: {
          status: 'accepted', submissionId: '123e4567-e89b-42d3-a456-426614174000',
          ticketSha256: 'e'.repeat(64), stapled: true, stapleValidated: true,
        },
      },
    },
    libwebrtcRevision: 'branch-heads/7390@{#1}',
    minimumOsVersion: '12.3',
    codeSignature: {
      teamId: TEAM_ID,
      bundles: {
        worker: {
          bundleIdentifier: 'cc.imcodes.node.remote-desktop-worker',
          designatedRequirement: designatedRequirement(
            'cc.imcodes.node.remote-desktop-worker',
          ),
          hardenedRuntime: true,
        },
        launchAgent: {
          bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
          designatedRequirement: designatedRequirement(
            MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
          ),
          hardenedRuntime: true,
        },
        disclosure: {
          bundleIdentifier: 'cc.imcodes.node.remote-desktop-disclosure',
          designatedRequirement: designatedRequirement(
            'cc.imcodes.node.remote-desktop-disclosure',
          ),
          hardenedRuntime: true,
        },
        virtualDisplayHelper: {
          bundleIdentifier: 'cc.imcodes.node.virtual-display-helper',
          designatedRequirement:
            'identifier "cc.imcodes.node.virtual-display-helper" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
          hardenedRuntime: true,
        },
      },
    },
    toolchain: {
      xcode: '16.4',
      macosSdk: '15.5',
      clang: '17.0.0',
    },
  };
}

function artifact(
  overrides: Partial<VerifiedMacosRemoteDesktopArtifact> = {},
): VerifiedMacosRemoteDesktopArtifact {
  const artifactDirectory = '/Library/Application Support/IM.codes/remote-desktop/release';
  const artifactManifest = manifest();
  return {
    artifactDirectory,
    manifestPath: `${artifactDirectory}/${REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME}`,
    manifest: artifactManifest,
    components: {
      worker: {
        kind: 'worker',
        executablePath: `${artifactDirectory}/${REMOTE_DESKTOP_MACOS_WORKER_FILENAME}`,
        fileName: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
        size: artifactManifest.components.worker.size,
        sha256: artifactManifest.components.worker.sha256,
        bundleIdentifier: artifactManifest.codeSignature.bundles.worker.bundleIdentifier,
        designatedRequirement:
          artifactManifest.codeSignature.bundles.worker.designatedRequirement,
      },
      launchAgent: {
        kind: 'launchAgent',
        executablePath: `${artifactDirectory}/${REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME}`,
        fileName: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
        size: artifactManifest.components.launchAgent.size,
        sha256: artifactManifest.components.launchAgent.sha256,
        bundleIdentifier: artifactManifest.codeSignature.bundles.launchAgent.bundleIdentifier,
        designatedRequirement:
          artifactManifest.codeSignature.bundles.launchAgent.designatedRequirement,
      },
      disclosure: {
        kind: 'disclosure',
        executablePath: `${artifactDirectory}/${REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME}`,
        fileName: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
        size: artifactManifest.components.disclosure.size,
        sha256: artifactManifest.components.disclosure.sha256,
        bundleIdentifier: artifactManifest.codeSignature.bundles.disclosure.bundleIdentifier,
        designatedRequirement:
          artifactManifest.codeSignature.bundles.disclosure.designatedRequirement,
      },
      virtualDisplayHelper: {
        kind: 'virtualDisplayHelper',
        executablePath: `${artifactDirectory}/imcodes-virtual-display-helper`,
        fileName: 'imcodes-virtual-display-helper',
        size: artifactManifest.components.virtualDisplayHelper.size,
        sha256: artifactManifest.components.virtualDisplayHelper.sha256,
        bundleIdentifier:
          artifactManifest.codeSignature.bundles.virtualDisplayHelper.bundleIdentifier,
        designatedRequirement:
          artifactManifest.codeSignature.bundles.virtualDisplayHelper.designatedRequirement,
      },
    },
    setSha256: 'd'.repeat(64),
    releaseName: `sha256-${'a'.repeat(64)}`,
    ...overrides,
  };
}

function launch(user: MacosUserSession, workerGeneration = 1): MacosRemoteDesktopIpcLaunch {
  return {
    workerGeneration,
    challenge: 'A'.repeat(43),
    socketPath: macosRemoteDesktopUserSessionPaths(user).socketPath,
  };
}

interface Harness {
  supervisor: MacosRemoteDesktopLaunchAgentSupervisor;
  definitions: MacosRemoteDesktopLaunchAgentDefinition[];
  operations: Array<{
    operation: string;
    definition: MacosRemoteDesktopLaunchAgentDefinition;
  }>;
  beginIpcLaunch: ReturnType<typeof vi.fn>;
  markAuthorityUnavailable: ReturnType<typeof vi.fn>;
  releaseInput: ReturnType<typeof vi.fn>;
  stopCapture: ReturnType<typeof vi.fn>;
  invalidateRoutes: ReturnType<typeof vi.fn>;
}

function harness(
  options: Partial<MacosRemoteDesktopLaunchAgentSupervisorDependencies> & {
    users?: MacosUserSession[];
  } = {},
): Harness {
  const users = options.users ?? [USER];
  let userIndex = 0;
  let lastResolvedUser = users[0]!;
  let generation = 0;
  const definitions: MacosRemoteDesktopLaunchAgentDefinition[] = [];
  const operations: Harness['operations'] = [];
  const currentUser = (): MacosUserSession => users[Math.min(userIndex, users.length - 1)]!;
  const resolveUserSession = options.resolveUserSession ?? vi.fn(async () => {
    const user = currentUser();
    lastResolvedUser = user;
    userIndex += 1;
    return user;
  });
  const beginIpcLaunch = options.beginIpcLaunch ?? vi.fn(() => {
    generation += 1;
    return launch(lastResolvedUser, generation);
  });
  const markAuthorityUnavailable = options.markAuthorityUnavailable ?? vi.fn();
  const releaseInput = options.releaseInput ?? vi.fn();
  const stopCapture = options.stopCapture ?? vi.fn();
  const invalidateRoutes = options.invalidateRoutes ?? vi.fn();
  const dependencies: MacosRemoteDesktopLaunchAgentSupervisorDependencies = {
    artifact: options.artifact ?? artifact(),
    resolveUserSession,
    beginIpcLaunch,
    markAuthorityUnavailable,
    releaseInput,
    stopCapture,
    invalidateRoutes,
    installPlist: options.installPlist ?? vi.fn(async (definition) => {
      definitions.push(definition);
    }),
    runLaunchctl: options.runLaunchctl ?? vi.fn(async (operation, definition) => {
      operations.push({ operation, definition });
    }),
    lifecycleSource: options.lifecycleSource,
    onBackgroundError: options.onBackgroundError,
    now: options.now,
    maxCrashRestarts: options.maxCrashRestarts,
    crashWindowMs: options.crashWindowMs,
  };
  return {
    supervisor: new MacosRemoteDesktopLaunchAgentSupervisor(dependencies),
    definitions,
    operations,
    beginIpcLaunch: beginIpcLaunch as ReturnType<typeof vi.fn>,
    markAuthorityUnavailable: markAuthorityUnavailable as ReturnType<typeof vi.fn>,
    releaseInput: releaseInput as ReturnType<typeof vi.fn>,
    stopCapture: stopCapture as ReturnType<typeof vi.fn>,
    invalidateRoutes: invalidateRoutes as ReturnType<typeof vi.fn>,
  };
}

describe('macOS remote-desktop LaunchAgent definition', () => {
  it('builds a deterministic per-user plist and binds exact uid, bundle, generation, challenge and socket', () => {
    const definition = buildMacosRemoteDesktopLaunchAgentDefinition(USER, artifact(), launch(USER, 7));

    expect(definition).toMatchObject({
      label: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label,
      domainTarget: 'gui/501',
      serviceTarget: 'gui/501/cc.imcodes.node.remote-desktop-agent',
      plistPath: '/Users/desktop-user/Library/LaunchAgents/cc.imcodes.node.remote-desktop-agent.plist',
      programArguments: [
        '/Library/Application Support/IM.codes/remote-desktop/release/imcodes-remote-desktop-launch-agent',
        '--macos-remote-desktop-launch-agent',
      ],
      workerGeneration: 7,
      challenge: 'A'.repeat(43),
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: designatedRequirement(
        MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      ),
    });
    expect(definition.environment).toEqual({
      HOME: USER.home,
      TMPDIR: USER.tempDir,
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.runtimeDirectory]:
        macosRemoteDesktopUserSessionPaths(USER).runtimeDirectory,
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.socketPath]:
        macosRemoteDesktopUserSessionPaths(USER).socketPath,
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.label]:
        MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.label,
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.workerGeneration]: '7',
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.launchChallenge]: 'A'.repeat(43),
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.bundleIdentifier]:
        MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      [MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.teamId]: TEAM_ID,
    });
    // Both session types, in a fixed order. Aqua alone would leave a rebooted
    // headless Mac unreachable until somebody physically logged in, and a
    // moving order would change the signed plist's bytes for no reason.
    expect(definition.plist).toContain(
      '<key>LimitLoadToSessionType</key>\n  <array>\n    <string>Aqua</string>\n'
      + '    <string>LoginWindow</string>\n  </array>',
    );
    expect(definition.plist).toContain('<key>RunAtLoad</key>\n  <false/>');
    expect(definition.plist).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(buildMacosRemoteDesktopLaunchAgentDefinition(USER, artifact(), launch(USER, 7)).plist)
      .toBe(definition.plist);
  });

  it('never places a controlled-node credential, server token or route authority in plist or launchctl', () => {
    const definition = buildMacosRemoteDesktopLaunchAgentDefinition(USER, artifact(), launch(USER));
    const serialized = JSON.stringify({
      definition,
      bootstrap: macosRemoteDesktopLaunchctlArgs('bootstrap', definition),
      kickstart: macosRemoteDesktopLaunchctlArgs('kickstart', definition),
      bootout: macosRemoteDesktopLaunchctlArgs('bootout', definition),
    }).toLowerCase();

    expect(serialized).not.toMatch(/controlled.?node|deck_auth|server.?token|bearer|route.?authority|capability/);
    expect(macosRemoteDesktopLaunchctlArgs('bootstrap', definition)).toEqual([
      'bootstrap', 'gui/501', definition.plistPath,
    ]);
    expect(macosRemoteDesktopLaunchctlArgs('kickstart', definition)).toEqual([
      'kickstart', '-k', definition.serviceTarget,
    ]);
    expect(macosRemoteDesktopLaunchctlArgs('bootout', definition)).toEqual([
      'bootout', definition.serviceTarget,
    ]);
  });

  it('refuses an artifact whose complete-set authority is missing or malformed', () => {
    // These three values are what the worker binds the helper to. If any is
    // blank or ill-formed the native side rejects the whole launch context, and
    // the failure then looks like a launch bug rather than a missing release
    // identity -- so it is caught here, at the source, instead.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing release name', { releaseName: undefined }],
      ['malformed release name', { releaseName: 'not/a/release' }],
      ['oversized release name', { releaseName: 'a'.repeat(97) }],
      ['malformed set digest', { setSha256: 'not-hex' }],
      ['short set digest', { setSha256: 'a'.repeat(63) }],
      ['upper-case set digest', { setSha256: 'A'.repeat(64) }],
    ];
    for (const [label, overrides] of cases) {
      expect(
        () => buildMacosRemoteDesktopLaunchAgentDefinition(
          USER, artifact(overrides), launch(USER, 7),
        ),
        `accepted an artifact with a ${label}`,
      ).toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
    }

    // A malformed helper digest inside the verified manifest must be refused
    // too: it is the value the worker compares the spawned bytes against.
    for (const bad of ['nothex', 'a'.repeat(63), 'E'.repeat(64)]) {
      const broken = artifact();
      (broken.manifest.components as Record<string, { sha256: string }>)
        .virtualDisplayHelper.sha256 = bad;
      expect(
        () => buildMacosRemoteDesktopLaunchAgentDefinition(USER, broken, launch(USER, 7)),
        `accepted a helper digest of "${bad}"`,
      ).toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
    }
  });

  it('rejects a SELF-CONSISTENT foreign-team artifact before any launch authority', () => {
    // `VerifiedMacosRemoteDesktopArtifact` is a plain TypeScript type: the name
    // says "Verified" but nothing at runtime proves this object came from
    // verification. Every field below agrees with every other -- the manifest
    // names a foreign team and BOTH the manifest bundle and the verified
    // component carry a designated requirement derived from that same team --
    // so it is internally consistent and rejected only on the pinned team.
    for (const foreign of ['ABCDE12345', 'ZZZZZ99999']) {
      const forged = artifact();
      // Built inline, NOT via the local designatedRequirement() helper: that
      // helper closes over the canonical TEAM_ID and ignores any team passed to
      // it, which would have produced a canonical requirement beside a foreign
      // team -- a self-INconsistent artifact that the requirement comparison
      // rejects on its own, leaving the team pin unexercised.
      const requirement = `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}" `
        + `and anchor apple generic and certificate leaf[subject.OU] = "${foreign}"`;
      (forged.manifest.codeSignature as { teamId: string }).teamId = foreign;
      forged.manifest.codeSignature.bundles.launchAgent = {
        bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
        designatedRequirement: requirement,
        hardenedRuntime: true,
      };
      (forged.components.launchAgent as { designatedRequirement: string })
        .designatedRequirement = requirement;
      expect(
        () => buildMacosRemoteDesktopLaunchAgentDefinition(USER, forged, launch(USER)),
        foreign,
      ).toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
    }
  });

  it('rejects an artifact whose manifest does not bind the stable LaunchAgent identity', () => {
    const invalid = artifact();
    invalid.manifest.codeSignature.bundles.launchAgent = {
      bundleIdentifier: 'cc.attacker.agent',
      designatedRequirement: designatedRequirement('cc.attacker.agent'),
      hardenedRuntime: true,
    };
    expect(() => buildMacosRemoteDesktopLaunchAgentDefinition(USER, invalid, launch(USER)))
      .toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
  });

  it('executes the verified LaunchAgent component and rejects a worker-path regression', () => {
    const valid = artifact();
    const definition = buildMacosRemoteDesktopLaunchAgentDefinition(USER, valid, launch(USER));
    expect(definition.executablePath).toBe(valid.components.launchAgent.executablePath);
    expect(definition.executablePath).not.toBe(valid.components.worker.executablePath);

    const base = artifact();
    const forged = artifact({
      components: {
        ...base.components,
        launchAgent: {
          ...base.components.launchAgent,
          executablePath: base.components.worker.executablePath,
        },
      },
    });
    expect(() => buildMacosRemoteDesktopLaunchAgentDefinition(USER, forged, launch(USER)))
      .toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.INVALID_ARTIFACT);
  });
});

describe('macOS remote-desktop LaunchAgent supervision', () => {
  it('bootstraps and kickstarts only in the exact resolved GUI uid with a fresh IPC generation', async () => {
    const context = harness();
    const snapshot = await context.supervisor.start();

    expect(snapshot).toEqual({
      user: USER,
      workerGeneration: 1,
      serviceTarget: 'gui/501/cc.imcodes.node.remote-desktop-agent',
      socketPath: macosRemoteDesktopUserSessionPaths(USER).socketPath,
    });
    expect(context.operations.map(({ operation, definition }) => [
      operation, definition.domainTarget, definition.user.uid,
    ])).toEqual([
      ['bootout', 'gui/501', 501],
      ['bootstrap', 'gui/501', 501],
      ['kickstart', 'gui/501', 501],
    ]);
    expect(context.definitions).toHaveLength(1);
  });

  it.each([
    ['no GUI user', new Error('computer_use_no_active_gui_session')],
    ['ambiguous GUI users', new Error('macos_remote_desktop_ambiguous_gui_session')],
  ])('fails closed for %s without creating launch authority', async (_label, error) => {
    const context = harness({ resolveUserSession: vi.fn(async () => { throw error; }) });
    await expect(context.supervisor.start()).rejects.toThrow(error.message);

    expect(context.markAuthorityUnavailable).toHaveBeenCalledWith('start');
    expect(context.releaseInput).toHaveBeenCalledWith('start');
    expect(context.stopCapture).toHaveBeenCalledWith('start');
    expect(context.invalidateRoutes).toHaveBeenCalledWith('start');
    expect(context.beginIpcLaunch).not.toHaveBeenCalled();
    expect(context.operations).toHaveLength(0);
  });

  it('synchronously tears down on sleep/lock/logout and relaunches only after a resume event', async () => {
    const runLaunchctl = vi.fn(async () => undefined) as NonNullable<
      MacosRemoteDesktopLaunchAgentSupervisorDependencies['runLaunchctl']
    >;
    const context = harness({ runLaunchctl });
    await context.supervisor.start();
    vi.clearAllMocks();

    const sleeping = context.supervisor.handleLifecycleEvent({ type: 'sleep' });
    expect(context.markAuthorityUnavailable).toHaveBeenCalledWith('sleep');
    expect(context.releaseInput).toHaveBeenCalledWith('sleep');
    expect(context.stopCapture).toHaveBeenCalledWith('sleep');
    expect(context.invalidateRoutes).toHaveBeenCalledWith('sleep');
    expect(context.beginIpcLaunch).not.toHaveBeenCalled();
    await sleeping;

    await context.supervisor.handleLifecycleEvent({ type: 'wake' });
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(2);
    await context.supervisor.handleLifecycleEvent({ type: 'lock' });
    expect(context.supervisor.snapshot()).toBeNull();
    await context.supervisor.handleLifecycleEvent({ type: 'unlock' });
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(3);
    await context.supervisor.handleLifecycleEvent({ type: 'logout' });
    expect(context.supervisor.snapshot()).toBeNull();
  });

  it('ignores a stale crash callback and bounds same-window crash relaunches', async () => {
    const context = harness({ maxCrashRestarts: 1, now: () => 10_000 });
    await context.supervisor.start();
    vi.clearAllMocks();

    await context.supervisor.handleLifecycleEvent({ type: 'agent_crash', workerGeneration: 99 });
    expect(context.releaseInput).not.toHaveBeenCalled();
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(1);

    await context.supervisor.handleLifecycleEvent({ type: 'agent_crash', workerGeneration: 1 });
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(2);
    await expect(context.supervisor.handleLifecycleEvent({
      type: 'agent_crash',
      workerGeneration: 2,
    })).rejects.toThrow(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ERROR.CRASH_LOOP);
    expect(context.supervisor.snapshot()).toBeNull();
    expect(context.beginIpcLaunch).toHaveBeenCalledTimes(1);
  });

  it('marks unavailable and releases input/capture/routes synchronously before relaunch work', async () => {
    const order: string[] = [];
    const context = harness({
      markAuthorityUnavailable: vi.fn(() => { order.push('unavailable'); }),
      releaseInput: vi.fn(() => { order.push('release'); }),
      stopCapture: vi.fn(() => { order.push('stop-capture'); }),
      invalidateRoutes: vi.fn(() => { order.push('invalidate'); }),
      runLaunchctl: vi.fn(async (operation) => { order.push(operation); }),
      installPlist: vi.fn(async () => { order.push('install'); }),
    });
    await context.supervisor.start();
    order.length = 0;

    const restarting = context.supervisor.handleLifecycleEvent({
      type: 'agent_crash',
      workerGeneration: 1,
    });
    expect(order).toEqual(['unavailable', 'release', 'stop-capture', 'invalidate']);
    await restarting;
    expect(order.slice(0, 4)).toEqual([
      'unavailable', 'release', 'stop-capture', 'invalidate',
    ]);
    expect(order).toContain('install');
    expect(order).toContain('bootstrap');
    expect(order).toContain('kickstart');
  });

  it('cleans each generation once even when terminal lifecycle notifications repeat', async () => {
    const context = harness();
    await context.supervisor.start();
    vi.clearAllMocks();

    await context.supervisor.handleLifecycleEvent({ type: 'sleep' });
    await context.supervisor.handleLifecycleEvent({ type: 'sleep' });
    await context.supervisor.handleLifecycleEvent({ type: 'lock' });

    expect(context.markAuthorityUnavailable).toHaveBeenCalledTimes(1);
    expect(context.releaseInput).toHaveBeenCalledTimes(1);
    expect(context.stopCapture).toHaveBeenCalledTimes(1);
    expect(context.invalidateRoutes).toHaveBeenCalledTimes(1);
  });

  it('boots out the old user and launches a new generation in the switched active session', async () => {
    const context = harness({ users: [USER, OTHER_USER] });
    await context.supervisor.start();
    await context.supervisor.handleLifecycleEvent({ type: 'fast_user_switch' });

    expect(context.supervisor.snapshot()).toEqual({
      user: OTHER_USER,
      workerGeneration: 2,
      serviceTarget: 'gui/502/cc.imcodes.node.remote-desktop-agent',
      socketPath: macosRemoteDesktopUserSessionPaths(OTHER_USER).socketPath,
    });
    const secondGenerationOperations = context.operations.filter(
      ({ definition }) => definition.workerGeneration === 2,
    );
    expect(secondGenerationOperations.map(({ operation, definition }) => [
      operation, definition.user.uid, definition.domainTarget,
    ])).toEqual([
      ['bootout', 502, 'gui/502'],
      ['bootstrap', 502, 'gui/502'],
      ['kickstart', 502, 'gui/502'],
    ]);
  });

  it('restarts on a newer service generation but ignores duplicate or older notifications', async () => {
    const context = harness();
    await context.supervisor.start();

    await context.supervisor.handleLifecycleEvent({
      type: 'service_generation',
      serviceGeneration: 8,
    });
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(2);
    await context.supervisor.handleLifecycleEvent({
      type: 'service_generation',
      serviceGeneration: 8,
    });
    await context.supervisor.handleLifecycleEvent({
      type: 'service_generation',
      serviceGeneration: 7,
    });
    expect(context.supervisor.snapshot()?.workerGeneration).toBe(2);
  });

  it('subscribes to the injected event source and removes the observer on stop', async () => {
    let listener: ((event: MacosRemoteDesktopLifecycleEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const lifecycleSource: MacosRemoteDesktopLifecycleSource = {
      subscribe: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const onBackgroundError = vi.fn();
    const context = harness({ lifecycleSource, onBackgroundError });
    await context.supervisor.start();
    vi.clearAllMocks();

    listener?.({ type: 'lock' });
    await vi.waitFor(() => expect(context.supervisor.snapshot()).toBeNull());
    expect(context.releaseInput).toHaveBeenCalledWith('lock');
    expect(onBackgroundError).not.toHaveBeenCalled();
    await context.supervisor.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
