import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_MSG,
  type RemoteDesktopDaemonMessage,
  type RemoteDesktopPrepare,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES,
  MACOS_REMOTE_DESKTOP_IPC_MESSAGE,
  MacosRemoteDesktopIpcAuthorityHost,
  type MacosRemoteDesktopIpcLaunch,
} from '../../src/node/macos-remote-desktop-ipc.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR,
  MacosRemoteDesktopIpcServer,
  type MacosRemoteDesktopIpcDisconnectReason,
  type MacosRemoteDesktopIpcServerOptions,
} from '../../src/node/macos-remote-desktop-ipc-server.js';
import {
  MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
} from '../../src/node/macos-remote-desktop-graphical-readiness.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY,
  macosRemoteDesktopGraphicalSessionPaths,
  macosRemoteDesktopUserSessionPaths,
} from '../../src/node/macos-user-session.js';
import type {
  MacosRemoteDesktopGraphicalSessionAuthority,
  MacosUserSession,
} from '../../src/node/user-session-launcher.js';

const NOW = 1_800_000_000_000;
const TEAM_ID = 'ABCDE12345';
const DESIGNATED_REQUIREMENT = [
  `identifier "${MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier}"`,
  'and anchor apple generic',
  `and certificate leaf[subject.OU] = "${TEAM_ID}"`,
].join(' ');
const REQUEST_ID = 'request_123456789';
const SESSION_ID = 'session_123456789';
const CAPABILITY = 'capability_12345678901234567890123456789012';
const tempRoots: string[] = [];
const servers: MacosRemoteDesktopIpcServer[] = [];

function currentUser(): MacosUserSession {
  const processUid = process.getuid?.() ?? 501;
  const processGid = process.getgid?.() ?? 20;
  return {
    name: 'ipc-test-user',
    uid: processUid === 0 ? 501 : processUid,
    gid: processGid === 0 ? 20 : processGid,
    home: '/Users/ipc-test-user',
    tempDir: '/tmp/ipc-test-user/',
  };
}

async function temporaryRoot(): Promise<string> {
  // Darwin sockaddr_un paths are short; keep the executable local-socket
  // fixture under canonical /private/tmp instead of the much longer DARWIN_USER_TEMP_DIR.
  const created = await mkdtemp('/tmp/ird-');
  const canonical = await realpath(created);
  tempRoots.push(canonical);
  return canonical;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function modeState(): RemoteDesktopDaemonMessage {
  return {
    type: REMOTE_DESKTOP_MSG.MODE_STATE,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    capability: CAPABILITY,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 3,
    reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
  };
}

function hello(launch: MacosRemoteDesktopIpcLaunch): string {
  return JSON.stringify({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: launch.workerGeneration,
    challenge: launch.challenge,
  });
}

function workerFrame(launch: MacosRemoteDesktopIpcLaunch, message: RemoteDesktopDaemonMessage): string {
  return JSON.stringify({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: launch.workerGeneration,
    message,
  });
}

async function connect(path: string): Promise<Socket> {
  const socket = net.createConnection({ path });
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  return socket;
}

async function readLine(socket: Socket): Promise<string> {
  let buffer = Buffer.alloc(0);
  return await new Promise<string>((resolveLine, reject) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      resolveLine(buffer.subarray(0, newline).toString('utf8'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket_closed_before_line'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

async function createFixture(
  overrides: Partial<MacosRemoteDesktopIpcServerOptions> = {},
): Promise<{
  server: MacosRemoteDesktopIpcServer;
  authority: MacosRemoteDesktopIpcAuthorityHost;
  user: MacosUserSession;
  runtimeRoot: string;
  authenticated: ReturnType<typeof deferred<MacosRemoteDesktopIpcLaunch>>;
  disconnected: ReturnType<typeof deferred<MacosRemoteDesktopIpcDisconnectReason>>;
  workerMessages: RemoteDesktopDaemonMessage[];
}> {
  const user = currentUser();
  const runtimeRoot = await temporaryRoot();
  let challenge = 0;
  const expectedCodeIdentity = {
    bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
    teamId: TEAM_ID,
    designatedRequirement: DESIGNATED_REQUIREMENT,
  } as const;
  const authority = new MacosRemoteDesktopIpcAuthorityHost({
    user,
    expectedCodeIdentity,
    runtimeRoot,
    randomChallenge: () => Buffer.alloc(32, ++challenge),
  });
  const authenticated = deferred<MacosRemoteDesktopIpcLaunch>();
  const disconnected = deferred<MacosRemoteDesktopIpcDisconnectReason>();
  const workerMessages: RemoteDesktopDaemonMessage[] = [];
  const server = new MacosRemoteDesktopIpcServer({
    authority,
    user,
    expectedCodeIdentity,
    runtimeRoot,
    inspectPeerUid: async () => user.uid,
    verifyPeerCodeIdentity: async () => ({
      bundleIdentifier: expectedCodeIdentity.bundleIdentifier,
      teamId: expectedCodeIdentity.teamId,
      designatedRequirement: expectedCodeIdentity.designatedRequirement,
      // The kernel audit session and pid generation are part of the identity
      // the server pins; a peer that cannot state them is not admitted.
      auditSessionId: 100_003,
      pidVersion: 5,
    }),
    onPeerAuthenticated: (launch) => authenticated.resolve(launch),
    onWorkerMessage: (message) => {
      workerMessages.push(message);
    },
    onDisconnect: (reason) => disconnected.resolve(reason),
    now: () => NOW,
    handshakeTimeoutMs: 250,
    frameTimeoutMs: 100,
    callbackTimeoutMs: 100,
    writeTimeoutMs: 250,
    ...overrides,
  });
  servers.push(server);
  return { server, authority, user, runtimeRoot, authenticated, disconnected, workerMessages };
}

async function authenticate(
  server: MacosRemoteDesktopIpcServer,
  authenticated: ReturnType<typeof deferred<MacosRemoteDesktopIpcLaunch>>,
  launch: MacosRemoteDesktopIpcLaunch,
  graphical = false,
  expectedPeer: {
    uid: number;
    auditSessionId: number;
    pidVersion: number;
    sessionType: 'Aqua' | 'LoginWindow';
  } = {
    uid: currentUser().uid,
    auditSessionId: 100_003,
    pidVersion: 5,
    sessionType: 'Aqua',
  },
): Promise<Socket> {
  const socket = await connect(launch.socketPath);
  socket.write(`${hello(launch)}\n`);
  const acknowledgement = JSON.parse(await readLine(socket)) as Record<string, unknown>;
  expect(acknowledgement).toEqual({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.AUTHENTICATED,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: launch.workerGeneration,
    uid: expectedPeer.uid,
    auditSessionId: expectedPeer.auditSessionId,
    pidVersion: expectedPeer.pidVersion,
    sessionType: expectedPeer.sessionType,
    launchChallenge: launch.challenge,
  });
  if (graphical) {
    socket.write(`${JSON.stringify({
      type: MACOS_REMOTE_DESKTOP_GRAPHICAL_READINESS_MESSAGE,
    })}\n`);
  }
  await authenticated.promise;
  return socket;
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('macOS remote-desktop virtual-display production chain', () => {
  const NONCE = 4242;

  function displayFixture(answers: string[]) {
    const asked: string[] = [];
    let leaseId = 0;
    const lease = {
      socket: null as unknown as Socket,
      serviceGeneration: 3,
      auditSessionId: 100_003,
    };
    let current: typeof lease | null = lease;
    return {
      asked,
      lease,
      release: () => { current = null; },
      replace: () => {
        leaseId += 1;
        current = { ...lease };
        return current;
      },
      overrides: {
        virtualDisplayLease: () => current,
        virtualDisplaySeams: {
          exchange: async (_lease: unknown, line: string) => {
            asked.push(line);
            return answers.length > 0 ? answers.shift()! : null;
          },
        },
      },
    };
  }

  const request = (requestId: number, body: Record<string, unknown>) => `${JSON.stringify({
    type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REQUEST,
    ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
    workerGeneration: 1,
    requestId,
    request: body,
  })}\n`;

  it('answers a readiness question on the same socket without dropping it', async () => {
    // The whole chain: HELLO, a virtual-display request, one authored ctl1 to
    // the agent, and the reply back on the SAME connection. Before the
    // dispatcher existed this frame reached the worker-message parser and took
    // the connection down with it.
    const display = displayFixture(['ctl1r ok=1 nonce=4242 qualified=1 admittedctl=1']);
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, { op: 'readiness', nonce: NONCE }));
    const answered = JSON.parse(await readLine(socket)) as Record<string, unknown>;

    expect(answered.type).toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.VIRTUAL_DISPLAY_REPLY);
    expect(answered.requestId).toBe(1);
    expect(answered.reply).toMatchObject({ ok: true, nonce: NONCE, qualifiedToCreate: true });
    // The daemon authored the line; readiness carries a nonce and nothing else.
    expect(display.asked).toEqual([`ctl1 verb=ready nonce=${NONCE}`]);
    // And the connection is still usable, which is the point.
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it('authors the route generation from the authenticated session, not the frame', async () => {
    const display = displayFixture(['ctl1r ok=1 rgen=1 repoch=9 seed=8 uid=501']);
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, { op: 'route' }));
    const answered = JSON.parse(await readLine(socket)) as Record<string, unknown>;
    expect(answered.reply).toMatchObject({ ok: true, routeEpoch: 9, cookieSeed: 8 });
    // generation 1 is the authenticated one; the frame had no field to ask.
    expect(display.asked).toEqual(['ctl1 verb=route rgen=1']);
    socket.destroy();
  });

  it('refuses instead of disconnecting when there is no agent lease', async () => {
    const display = displayFixture([]);
    display.release();
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, { op: 'readiness', nonce: NONCE }));
    const answered = JSON.parse(await readLine(socket)) as Record<string, unknown>;
    expect(answered.reply).toMatchObject({ ok: false, error: 'agent_unavailable' });
    // A refusal is an ANSWER. Dropping the socket would take capture and input
    // down with a question the worker was entitled to ask.
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it('refuses an agent lease belonging to another audit session', async () => {
    const display = displayFixture(['ctl1r ok=1 nonce=4242 qualified=1 admittedctl=1']);
    display.lease.auditSessionId = 100_009;
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, { op: 'readiness', nonce: NONCE }));
    const answered = JSON.parse(await readLine(socket)) as Record<string, unknown>;
    expect(answered.reply).toMatchObject({ ok: false, error: 'agent_session_mismatch' });
    // It never reached the agent at all.
    expect(display.asked).toEqual([]);
    socket.destroy();
  });

  it('refuses a reused request id within one generation', async () => {
    const display = displayFixture([
      'ctl1r ok=1 nonce=4242 qualified=1 admittedctl=1',
      'ctl1r ok=1 nonce=4242 qualified=1 admittedctl=1',
    ]);
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, { op: 'readiness', nonce: NONCE }));
    expect(JSON.parse(await readLine(socket)).reply.ok).toBe(true);
    // Same id again: spent for this generation, so a late answer to the first
    // has nothing to correlate to.
    socket.write(request(1, { op: 'readiness', nonce: NONCE }));
    const replayed = JSON.parse(await readLine(socket)) as Record<string, unknown>;
    expect(replayed.reply).toMatchObject({
      ok: false, error: 'virtual_display_request_not_fresh',
    });
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it('has no request shape that could express a release', async () => {
    const display = displayFixture(['ctl1r ok=1 admitted=1 presence=absent']);
    const { server, authenticated } = await createFixture(display.overrides);
    const launch = await server.start();
    const socket = await authenticate(server, authenticated, launch);

    socket.write(request(1, {
      op: 'release', routeEpoch: 1, routeCookie: 1, requestIndex: 1,
    }));
    // An unknown op is not a request this daemon can author, so the frame is
    // refused at the envelope and never becomes an agent line.
    await new Promise((r) => setTimeout(r, 50));
    expect(display.asked).toEqual([]);
    socket.destroy();
  });
});

describe('macOS remote-desktop bounded Unix IPC transport', () => {
  it('creates a LoginWindow socket from uid/asid only and pins the verified pid generation', async () => {
    const runtimeRoot = await temporaryRoot();
    const user = currentUser();
    const principal: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
      kind: 'loginwindow_bootstrap',
      sessionType: 'LoginWindow',
      uid: user.uid,
      auditSessionId: 100_004,
      pidVersion: 7,
    });
    const expectedCodeIdentity = {
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: DESIGNATED_REQUIREMENT,
    } as const;
    const authority = new MacosRemoteDesktopIpcAuthorityHost({
      principal,
      expectedCodeIdentity,
      runtimeRoot,
      randomChallenge: () => Buffer.alloc(32, 0x4c),
    });
    const authenticated = deferred<MacosRemoteDesktopIpcLaunch>();
    const sessions: unknown[] = [];
    const server = new MacosRemoteDesktopIpcServer({
      authority,
      principal,
      expectedCodeIdentity,
      runtimeRoot,
      inspectPeerGraphicalSession: async () => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
      }),
      inspectPeerUid: async () => principal.uid,
      verifyPeerCodeIdentity: async () => ({
        ...expectedCodeIdentity,
        auditSessionId: principal.auditSessionId,
        pidVersion: principal.pidVersion,
      }),
      onPeerAuthenticated: (launch, session) => {
        sessions.push(session);
        authenticated.resolve(launch);
      },
      onGraphicalReadinessAttestation: () => undefined,
      onWorkerMessage: () => undefined,
    });
    servers.push(server);

    const launch = await server.start();
    const paths = macosRemoteDesktopGraphicalSessionPaths(principal, runtimeRoot);
    expect(launch.socketPath).toBe(paths.socketPath);
    const socket = await authenticate(server, authenticated, launch, true, {
      uid: principal.uid,
      auditSessionId: principal.auditSessionId,
      pidVersion: principal.pidVersion,
      sessionType: principal.sessionType,
    });
    expect(sessions).toEqual([{
      workerGeneration: launch.workerGeneration,
      socketPath: launch.socketPath,
      principal: {
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
        uid: principal.uid,
        auditSessionId: principal.auditSessionId,
        pidVersion: principal.pidVersion,
      },
      launchNonce: launch.challenge,
    }]);
    expect(JSON.stringify({ launch, sessions })).not.toMatch(/name|HOME|TMPDIR|Users\//u);
    socket.destroy();
  });

  it('rejects a signed LoginWindow successor whose verified asid is not the granted one', async () => {
    const runtimeRoot = await temporaryRoot();
    const user = currentUser();
    const principal: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
      kind: 'loginwindow_bootstrap',
      sessionType: 'LoginWindow',
      uid: user.uid,
      auditSessionId: 100_004,
      pidVersion: 7,
    });
    const expectedCodeIdentity = {
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: DESIGNATED_REQUIREMENT,
    } as const;
    const authority = new MacosRemoteDesktopIpcAuthorityHost({
      principal, expectedCodeIdentity, runtimeRoot,
    });
    const outcome = deferred<MacosRemoteDesktopIpcDisconnectReason | 'authenticated'>();
    const server = new MacosRemoteDesktopIpcServer({
      authority,
      principal,
      expectedCodeIdentity,
      runtimeRoot,
      inspectPeerGraphicalSession: async () => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
      }),
      inspectPeerUid: async () => principal.uid,
      verifyPeerCodeIdentity: async () => ({
        ...expectedCodeIdentity,
        auditSessionId: principal.auditSessionId + 1,
        pidVersion: principal.pidVersion,
      }),
      onWorkerMessage: () => undefined,
      onPeerAuthenticated: () => outcome.resolve('authenticated'),
      onDisconnect: (reason) => outcome.resolve(reason),
    });
    servers.push(server);
    const launch = await server.start();
    const socket = await connect(launch.socketPath);
    socket.write(`${hello(launch)}\n`);
    await expect(outcome.promise).resolves.toBe('authentication_failed');
    socket.destroy();
  });

  it('rejects a signed LoginWindow peer observed in the wrong graphical session type', async () => {
    const runtimeRoot = await temporaryRoot();
    const user = currentUser();
    const principal: MacosRemoteDesktopGraphicalSessionAuthority = Object.freeze({
      kind: 'loginwindow_bootstrap',
      sessionType: 'LoginWindow',
      uid: user.uid,
      auditSessionId: 100_004,
      pidVersion: 7,
    });
    const expectedCodeIdentity = {
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: DESIGNATED_REQUIREMENT,
    } as const;
    const authority = new MacosRemoteDesktopIpcAuthorityHost({
      principal, expectedCodeIdentity, runtimeRoot,
    });
    const outcome = deferred<MacosRemoteDesktopIpcDisconnectReason | 'authenticated'>();
    const server = new MacosRemoteDesktopIpcServer({
      authority,
      principal,
      expectedCodeIdentity,
      runtimeRoot,
      // Authenticated observed evidence is deliberately independent from the
      // expected LoginWindow principal and must fail closed when it disagrees.
      inspectPeerGraphicalSession: async () => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'Aqua',
      }),
      inspectPeerUid: async () => principal.uid,
      verifyPeerCodeIdentity: async () => ({
        ...expectedCodeIdentity,
        auditSessionId: principal.auditSessionId,
        pidVersion: principal.pidVersion,
      }),
      onWorkerMessage: () => undefined,
      onPeerAuthenticated: () => outcome.resolve('authenticated'),
      onDisconnect: (reason) => outcome.resolve(reason),
    });
    servers.push(server);
    const launch = await server.start();
    const socket = await connect(launch.socketPath);
    socket.write(`${hello(launch)}\n`);
    await expect(outcome.promise).resolves.toBe('authentication_failed');
    socket.destroy();
  });

  it('creates an exact-mode socket, authenticates from injected native evidence and routes both directions', async () => {
    const fixture = await createFixture();
    const launch = await fixture.server.start();
    const paths = macosRemoteDesktopUserSessionPaths(fixture.user, fixture.runtimeRoot);
    const runtimeStats = await lstat(paths.runtimeDirectory);
    const socketStats = await lstat(paths.socketPath);
    expect(runtimeStats.isDirectory()).toBe(true);
    expect(runtimeStats.isSymbolicLink()).toBe(false);
    expect(runtimeStats.uid).toBe(fixture.user.uid);
    expect(runtimeStats.mode & 0o7777).toBe(0o700);
    expect(socketStats.isSocket()).toBe(true);
    expect(socketStats.isSymbolicLink()).toBe(false);
    expect(socketStats.uid).toBe(fixture.user.uid);
    expect(socketStats.mode & 0o7777).toBe(0o600);

    const socket = await authenticate(fixture.server, fixture.authenticated, launch);
    const commandLine = readLine(socket);
    await fixture.server.sendCommand(prepare());
    const encodedCommand = await commandLine;
    expect(JSON.parse(encodedCommand)).toEqual({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: launch.workerGeneration,
      command: prepare(),
    });
    expect(encodedCommand).not.toContain('controlledNodeCredential');
    expect(encodedCommand).not.toContain('serverToken');

    socket.write(`${workerFrame(launch, modeState())}\n`);
    await expect.poll(() => fixture.workerMessages).toEqual([modeState()]);
    socket.destroy();
    await expect(fixture.disconnected.promise).resolves.toBe('peer_disconnected');
  });

  it('takes uid and signing identity only from the injected OS/Security.framework seams', async () => {
    let uidChecks = 0;
    let signatureChecks = 0;
    const fixture = await createFixture({
      inspectPeerUid: async () => {
        uidChecks += 1;
        return currentUser().uid + 1;
      },
      verifyPeerCodeIdentity: async (_socket, expected) => {
        signatureChecks += 1;
        return {
          bundleIdentifier: expected.bundleIdentifier,
          teamId: expected.teamId,
          designatedRequirement: expected.designatedRequirement,
          auditSessionId: 100_003,
          pidVersion: 5,
          // A runtime object cannot override the separately captured uid.
          uid: currentUser().uid,
        } as never;
      },
    });
    const launch = await fixture.server.start();
    const socket = await connect(launch.socketPath);
    socket.write(`${JSON.stringify({
      ...JSON.parse(hello(launch)),
      uid: fixture.user.uid,
      teamId: TEAM_ID,
    })}\n`);
    await once(socket, 'close');
    expect(uidChecks).toBe(1);
    expect(signatureChecks).toBe(1);
    await expect(fixture.disconnected.promise).resolves.toBe('authentication_failed');
  });

  it('keeps the first authenticated peer alive while rejecting every additional peer', async () => {
    const fixture = await createFixture();
    const launch = await fixture.server.start();
    const first = await authenticate(fixture.server, fixture.authenticated, launch);
    const second = await connect(launch.socketPath);
    await once(second, 'close');

    const commandLine = readLine(first);
    await fixture.server.sendCommand(prepare());
    expect(JSON.parse(await commandLine)).toMatchObject({
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND,
      workerGeneration: launch.workerGeneration,
    });
    first.destroy();
  });

  it.each([
    ['malformed hello', () => '{}\n'],
    ['oversized frame', () => `${'x'.repeat(MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES + 1)}\n`],
    ['too many queued lines', (launch: MacosRemoteDesktopIpcLaunch) => `${hello(launch)}\n${hello(launch)}\n${hello(launch)}\n`],
  ])('fails closed for %s', async (_label, input) => {
    const fixture = await createFixture({ maxQueuedFrames: 2 });
    const launch = await fixture.server.start();
    const socket = await connect(launch.socketPath);
    socket.write(input(launch));
    await once(socket, 'close');
    await expect(fixture.disconnected.promise).resolves.toBe('authentication_failed');
    await expect(fixture.server.sendCommand(prepare())).rejects.toThrow(
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.NOT_CONNECTED,
    );
  });

  it('bounds a trickled partial frame by an absolute frame deadline', async () => {
    const fixture = await createFixture();
    const launch = await fixture.server.start();
    const socket = await authenticate(fixture.server, fixture.authenticated, launch);
    socket.write('{');
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    socket.write('"type"');
    await once(socket, 'close');
    await expect(fixture.disconnected.promise).resolves.toBe('frame_rejected');
  });

  it('applies callback deadlines and releases all route/session authority on disconnect', async () => {
    const never = new Promise<void>(() => undefined);
    const fixture = await createFixture({ onWorkerMessage: () => never });
    const launch = await fixture.server.start();
    const socket = await authenticate(fixture.server, fixture.authenticated, launch);
    const commandLine = readLine(socket);
    await fixture.server.sendCommand(prepare());
    await commandLine;
    socket.write(`${workerFrame(launch, modeState())}\n`);
    await once(socket, 'close');
    await expect(fixture.disconnected.promise).resolves.toBe('callback_failed');
    await expect(fixture.server.sendCommand(prepare())).rejects.toThrow(
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.NOT_CONNECTED,
    );
  });

  it('enforces bounded serialized outbound backpressure without dropping the first command', async () => {
    const provisional = {
      type: MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND,
      ipcVersion: REMOTE_DESKTOP_WORKER_IPC_VERSION,
      workerGeneration: 1,
      command: prepare(),
    };
    const oneFrameBytes = Buffer.byteLength(`${JSON.stringify(provisional)}\n`);
    const fixture = await createFixture({ maxPendingOutboundBytes: oneFrameBytes + 8 });
    const launch = await fixture.server.start();
    const socket = await authenticate(fixture.server, fixture.authenticated, launch);
    const commandLine = readLine(socket);
    const first = fixture.server.sendCommand(prepare());
    const second = fixture.server.sendCommand(prepare({ sessionId: 'session_second_123' }));
    await expect(second).rejects.toThrow(MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.BACKPRESSURE);
    await expect(first).resolves.toBeUndefined();
    expect(JSON.parse(await commandLine)).toMatchObject({ command: { sessionId: SESSION_ID } });
    socket.destroy();
  });

  it('invalidates a stopped generation and rejects its stale hello after restart', async () => {
    const reasons: MacosRemoteDesktopIpcDisconnectReason[] = [];
    const fixture = await createFixture({ onDisconnect: (reason) => { reasons.push(reason); } });
    const firstLaunch = await fixture.server.start();
    await fixture.server.stop();
    expect(reasons).toEqual(['server_stopped']);
    const secondLaunch = await fixture.server.start();
    expect(secondLaunch.workerGeneration).toBeGreaterThan(firstLaunch.workerGeneration);
    const stale = await connect(secondLaunch.socketPath);
    stale.write(`${hello(firstLaunch)}\n`);
    await once(stale, 'close');
    await expect.poll(() => reasons).toEqual(['server_stopped', 'authentication_failed']);
  });

  it('rejects symlink runtime directories and existing non-socket paths without replacing them', async () => {
    const user = currentUser();
    const root = await temporaryRoot();
    const target = join(root, 'attacker-target');
    await mkdir(target);
    const paths = macosRemoteDesktopUserSessionPaths(user, root);
    await mkdir(join(root, String(user.uid)), { recursive: true });
    await symlink(target, paths.runtimeDirectory);

    const identity = {
      bundleIdentifier: MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_IDENTITY.bundleIdentifier,
      teamId: TEAM_ID,
      designatedRequirement: DESIGNATED_REQUIREMENT,
    } as const;
    const symlinkAuthority = new MacosRemoteDesktopIpcAuthorityHost({
      user,
      expectedCodeIdentity: identity,
      runtimeRoot: root,
    });
    const symlinkServer = new MacosRemoteDesktopIpcServer({
      authority: symlinkAuthority,
      user,
      expectedCodeIdentity: identity,
      runtimeRoot: root,
      inspectPeerUid: async () => user.uid,
      verifyPeerCodeIdentity: async () => identity,
      onWorkerMessage: () => undefined,
    });
    servers.push(symlinkServer);
    await expect(symlinkServer.start()).rejects.toThrow(
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH,
    );
    expect(await readlink(paths.runtimeDirectory)).toBe(target);

    await rm(paths.runtimeDirectory);
    await mkdir(paths.runtimeDirectory);
    await writeFile(paths.socketPath, 'do-not-replace');
    const fileAuthority = new MacosRemoteDesktopIpcAuthorityHost({
      user,
      expectedCodeIdentity: identity,
      runtimeRoot: root,
    });
    const fileServer = new MacosRemoteDesktopIpcServer({
      authority: fileAuthority,
      user,
      expectedCodeIdentity: identity,
      runtimeRoot: root,
      inspectPeerUid: async () => user.uid,
      verifyPeerCodeIdentity: async () => identity,
      onWorkerMessage: () => undefined,
    });
    servers.push(fileServer);
    await expect(fileServer.start()).rejects.toThrow(
      MACOS_REMOTE_DESKTOP_IPC_SERVER_ERROR.UNSAFE_RUNTIME_PATH,
    );
    expect((await lstat(paths.socketPath)).isFile()).toBe(true);
  });
});
