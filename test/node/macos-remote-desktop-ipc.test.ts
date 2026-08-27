import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_MSG,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES,
  MACOS_REMOTE_DESKTOP_IPC_MESSAGE,
  MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE,
  MACOS_REMOTE_DESKTOP_SOCKET_MODE,
  MacosRemoteDesktopIpcAuthorityHost,
  decodeMacosRemoteDesktopIpcFrame,
  validateMacosRemoteDesktopSocketSecurity,
  type MacosRemoteDesktopFilesystemEntry,
  type MacosRemoteDesktopIpcLaunch,
  type MacosRemoteDesktopIpcSession,
  type MacosRemoteDesktopSocketSecurityEvidence,
  type MacosRemoteDesktopVerifiedPeerIdentity,
} from '../../src/node/macos-remote-desktop-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  macosRemoteDesktopUserSessionPaths,
} from '../../src/node/macos-user-session.js';
import type { MacosUserSession } from '../../src/node/user-session-launcher.js';

const NOW = 1_800_000_000_000;
const USER: MacosUserSession = {
  name: 'desktop-user',
  uid: 501,
  gid: 20,
  home: '/Users/desktop-user',
  tempDir: '/private/var/folders/ab/session/T/',
};
const TEAM_ID = 'ABCDE12345';
const DESIGNATED_REQUIREMENT = [
  `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}"`,
  'and anchor apple generic',
  `and certificate leaf[subject.OU] = "${TEAM_ID}"`,
].join(' ');
const REQUEST_ID = 'request_123456789';
const SESSION_ID = 'session_123456789';
const CAPABILITY = 'capability_12345678901234567890123456789012';

function frame(value: unknown): string {
  return JSON.stringify(value);
}

function socketSecurity(
  overrides: {
    runtime?: Partial<MacosRemoteDesktopFilesystemEntry>;
    socket?: Partial<MacosRemoteDesktopFilesystemEntry>;
  } = {},
): MacosRemoteDesktopSocketSecurityEvidence {
  const paths = macosRemoteDesktopUserSessionPaths(USER);
  return {
    runtimeDirectory: {
      path: paths.runtimeDirectory,
      uid: USER.uid,
      mode: 0o040000 | MACOS_REMOTE_DESKTOP_RUNTIME_DIRECTORY_MODE,
      kind: 'directory',
      ...overrides.runtime,
    },
    socket: {
      path: paths.socketPath,
      uid: USER.uid,
      mode: 0o140000 | MACOS_REMOTE_DESKTOP_SOCKET_MODE,
      kind: 'socket',
      ...overrides.socket,
    },
  };
}

function peer(overrides: Partial<MacosRemoteDesktopVerifiedPeerIdentity> = {}): MacosRemoteDesktopVerifiedPeerIdentity {
  return {
    uid: USER.uid,
    bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
    teamId: TEAM_ID,
    designatedRequirement: DESIGNATED_REQUIREMENT,
    ...overrides,
  };
}

function host(challengeByte = 0x41): MacosRemoteDesktopIpcAuthorityHost {
  return new MacosRemoteDesktopIpcAuthorityHost({
    user: USER,
    expectedCodeIdentity: {
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: DESIGNATED_REQUIREMENT,
    },
    randomChallenge: () => Buffer.alloc(32, challengeByte),
  });
}

function hello(launch: MacosRemoteDesktopIpcLaunch, overrides: Record<string, unknown> = {}): string {
  return frame({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: launch.workerGeneration,
    challenge: launch.challenge,
    ...overrides,
  });
}

function authenticate(authority = host()): {
  authority: MacosRemoteDesktopIpcAuthorityHost;
  launch: MacosRemoteDesktopIpcLaunch;
  session: MacosRemoteDesktopIpcSession;
} {
  const launch = authority.beginLaunch();
  const session = authority.authenticate(hello(launch), peer(), socketSecurity());
  return { authority, launch, session };
}

function prepare(overrides: Partial<RemoteDesktopPrepare> = {}): RemoteDesktopPrepare {
  return {
    type: REMOTE_DESKTOP_MSG.PREPARE,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    capability: CAPABILITY,
    expiresAt: NOW + 120_000,
    leaseExpiresAt: NOW + 60_000,
    daemonGeneration: 7,
    routeGeneration: 11,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 3,
    iceServers: [{
      urls: ['turn:turn.example.test:3478'],
      username: 'ephemeral-user',
      credential: 'ephemeral-password',
    }],
    ...overrides,
  };
}

function hostCommand(
  launch: Pick<MacosRemoteDesktopIpcLaunch, 'workerGeneration'>,
  command: unknown,
  extra: Record<string, unknown> = {},
): string {
  return frame({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: launch.workerGeneration,
    command,
    ...extra,
  });
}

function authorizeRoute(): ReturnType<typeof authenticate> {
  const context = authenticate();
  expect(context.authority.acceptHostFrame(
    context.session,
    hostCommand(context.launch, prepare()),
    NOW,
  )).toEqual(prepare());
  return context;
}

describe('macOS remote-desktop authenticated local IPC contract', () => {
  it('requires the configured designated requirement to bind the exact bundle and Team ID', () => {
    for (const designatedRequirement of [
      'anchor apple generic',
      `identifier "cc.attacker.agent" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`,
      `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "ZZZZZ99999"`,
      `${DESIGNATED_REQUIREMENT} or identifier "cc.attacker.agent"`,
      DESIGNATED_REQUIREMENT.replace(`"${TEAM_ID}"`, TEAM_ID),
    ]) {
      expect(() => new MacosRemoteDesktopIpcAuthorityHost({
        user: USER,
        expectedCodeIdentity: {
          bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
          teamId: TEAM_ID,
          designatedRequirement,
        },
      })).toThrow('macos_remote_desktop_ipc_invalid_expected_identity');
    }
    expect(() => host()).not.toThrow();
  });

  it('requires the exact per-user directory/socket path, owner, type and restrictive modes', () => {
    expect(validateMacosRemoteDesktopSocketSecurity(socketSecurity(), USER)).toBe(true);
    for (const evidence of [
      socketSecurity({ runtime: { uid: 0 } }),
      socketSecurity({ runtime: { mode: 0o755 } }),
      socketSecurity({ runtime: { kind: 'socket' } }),
      socketSecurity({ socket: { uid: 0 } }),
      socketSecurity({ socket: { mode: 0o660 } }),
      socketSecurity({ socket: { kind: 'directory' } }),
      socketSecurity({ socket: { path: '/tmp/attacker.sock' } }),
    ]) {
      expect(validateMacosRemoteDesktopSocketSecurity(evidence, USER)).toBe(false);
    }
  });

  it('authenticates once using OS-derived uid/signing evidence plus the launch challenge and generation', () => {
    const authority = host();
    const launch = authority.beginLaunch();
    expect(launch.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authority.authenticate(hello(launch), peer(), socketSecurity())).toEqual({
      workerGeneration: launch.workerGeneration,
      socketPath: macosRemoteDesktopUserSessionPaths(USER).socketPath,
    });
    expect(() => authority.authenticate(hello(launch), peer(), socketSecurity()))
      .toThrow('macos_remote_desktop_ipc_authentication_failed');
  });

  it.each([
    ['wrong uid', peer({ uid: 502 }), undefined, undefined],
    ['wrong bundle', peer({ bundleIdentifier: 'cc.attacker.agent' }), undefined, undefined],
    ['wrong Team ID', peer({ teamId: 'ZZZZZ99999' }), undefined, undefined],
    ['wrong designated requirement', peer({ designatedRequirement: `${DESIGNATED_REQUIREMENT} or true` }), undefined, undefined],
    ['wrong challenge', peer(), { challenge: Buffer.alloc(32, 0x42).toString('base64url') }, undefined],
    ['stale generation', peer(), { workerGeneration: 999 }, undefined],
    ['unsafe filesystem', peer(), undefined, socketSecurity({ socket: { mode: 0o666 } })],
  ])('fails closed for %s', (_label, actualPeer, helloOverride, filesystemOverride) => {
    const authority = host();
    const launch = authority.beginLaunch();
    expect(() => authority.authenticate(
      hello(launch, helloOverride ?? {}),
      actualPeer,
      filesystemOverride ?? socketSecurity(),
    )).toThrow('macos_remote_desktop_ipc_authentication_failed');
  });

  it('accepts only strict bounded route authority with ephemeral ICE and no node credential', () => {
    const { authority, launch, session } = authenticate();
    const accepted = authority.acceptHostFrame(session, hostCommand(launch, prepare()), NOW);
    expect(accepted).toEqual(prepare());
    expect(JSON.stringify(accepted)).toContain('ephemeral-password');
    expect(JSON.stringify(accepted)).not.toContain('controlledNodeCredential');

    expect(() => authority.acceptHostFrame(
      session,
      hostCommand(launch, prepare({ sessionId: 'session_other_12345' }), {
        controlledNodeCredential: 'must-not-cross-ipc',
      }),
      NOW,
    )).toThrow('macos_remote_desktop_ipc_invalid_host_frame');

    expect(() => authority.acceptHostFrame(
      session,
      hostCommand(launch, {
        ...prepare({ sessionId: 'session_other_12345' }),
        unrelatedRouteAuthority: { role: 'owner', serverToken: 'must-not-cross' },
      }),
      NOW,
    )).toThrow('macos_remote_desktop_ipc_invalid_host_frame');
  });

  it('binds every later command and worker response to the exact authorized route', () => {
    const { authority, launch, session } = authorizeRoute();
    const lease = {
      type: REMOTE_DESKTOP_MSG.LEASE,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      leaseExpiresAt: NOW + 55_000,
      daemonGeneration: 7,
      routeGeneration: 11,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 3,
    } as const;
    expect(authority.acceptHostFrame(session, hostCommand(launch, lease), NOW)).toEqual(lease);

    const response = {
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 3,
      reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
    } as const;
    expect(authority.acceptWorkerFrame(session, frame({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: launch.workerGeneration,
      message: response,
    }), NOW)).toEqual(response);

    expect(() => authority.acceptWorkerFrame(session, frame({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: launch.workerGeneration,
      message: { ...response, sessionId: 'session_unrelated_1' },
    }), NOW)).toThrow('macos_remote_desktop_ipc_route_authority_rejected');
    expect(() => authority.acceptHostFrame(session, hostCommand(launch, {
      ...lease,
      capability: 'Z'.repeat(43),
    }), NOW)).toThrow('macos_remote_desktop_ipc_route_authority_rejected');
    expect(() => authority.acceptHostFrame(session, hostCommand(
      { workerGeneration: launch.workerGeneration + 1 },
      lease,
    ), NOW)).toThrow('macos_remote_desktop_ipc_invalid_host_frame');
  });

  it('rejects expired, overlong and generation-mismatched route grants and leases', () => {
    for (const invalid of [
      prepare({ expiresAt: NOW, leaseExpiresAt: NOW }),
      prepare({ leaseExpiresAt: NOW }),
      prepare({ expiresAt: NOW + REMOTE_DESKTOP_LIMITS.ABSOLUTE_LIFETIME_MS + 1 }),
      prepare({ leaseExpiresAt: NOW + REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS + 1 }),
      prepare({ routeGeneration: undefined }),
    ]) {
      const { authority, launch, session } = authenticate();
      expect(() => authority.acceptHostFrame(session, hostCommand(launch, invalid), NOW))
        .toThrow('macos_remote_desktop_ipc_route_authority_rejected');
    }

    const { authority, launch, session } = authorizeRoute();
    const wrongGenerationLease = {
      type: REMOTE_DESKTOP_MSG.LEASE,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      leaseExpiresAt: NOW + 30_000,
      daemonGeneration: 8,
      routeGeneration: 11,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 3,
    } as const;
    expect(() => authority.acceptHostFrame(
      session,
      hostCommand(launch, wrongGenerationLease),
      NOW,
    )).toThrow('macos_remote_desktop_ipc_route_authority_rejected');
  });

  it('invalidates the challenge, authenticated session and all route authority on cleanup', () => {
    let launchCount = 0;
    const authority = new MacosRemoteDesktopIpcAuthorityHost({
      user: USER,
      expectedCodeIdentity: {
        bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
        teamId: TEAM_ID,
        designatedRequirement: DESIGNATED_REQUIREMENT,
      },
      randomChallenge: () => Buffer.alloc(32, ++launchCount),
    });
    const launch = authority.beginLaunch();
    const session = authority.authenticate(hello(launch), peer(), socketSecurity());
    authority.acceptHostFrame(session, hostCommand(launch, prepare()), NOW);
    authority.cleanup();
    expect(() => authority.acceptHostFrame(session, hostCommand(launch, prepare()), NOW))
      .toThrow('macos_remote_desktop_ipc_stale_session');
    expect(() => authority.authenticate(hello(launch), peer(), socketSecurity()))
      .toThrow('macos_remote_desktop_ipc_authentication_failed');

    const replacement = authority.beginLaunch();
    expect(replacement.workerGeneration).toBeGreaterThan(launch.workerGeneration);
    expect(replacement.challenge).not.toBe(launch.challenge);
    expect(() => authority.authenticate(
      hello(replacement, { challenge: launch.challenge }),
      peer(),
      socketSecurity(),
    )).toThrow('macos_remote_desktop_ipc_authentication_failed');
    expect(() => authority.authenticate(hello(replacement), peer(), socketSecurity())).not.toThrow();
  });

  it('rejects unknown keys, multiline/NUL JSON and oversized request/response frames', () => {
    const { authority, launch, session } = authorizeRoute();
    expect(() => authority.acceptHostFrame(session, `${hostCommand(launch, prepare())}\n`, NOW))
      .toThrow('macos_remote_desktop_ipc_invalid_frame');
    expect(() => decodeMacosRemoteDesktopIpcFrame(`{"x":"\0"}`))
      .toThrow('macos_remote_desktop_ipc_invalid_frame');
    expect(() => decodeMacosRemoteDesktopIpcFrame('x'.repeat(MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES + 1)))
      .toThrow('macos_remote_desktop_ipc_invalid_frame');
    expect(() => authority.acceptWorkerFrame(session, frame({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: launch.workerGeneration,
      message: {
        type: REMOTE_DESKTOP_MSG.ANSWER,
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        capability: CAPABILITY,
        sdp: 'v=0',
        controlledNodeCredential: 'must-not-cross',
      },
    }), NOW)).toThrow('macos_remote_desktop_ipc_invalid_worker_frame');
  });
});
