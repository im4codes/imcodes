import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR,
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE,
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
  MacosRemoteDesktopGlobalAgentBootstrap,
  MacosRemoteDesktopGlobalAgentBootstrapListener,
  type MacosRemoteDesktopBootstrapHello,
  type MacosRemoteDesktopBootstrapVerifiedPeer,
} from '../../src/node/macos-remote-desktop-global-agent-bootstrap.js';
import {
  MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH,
  macosRemoteDesktopGraphicalSessionPaths,
} from '../../src/node/macos-user-session.js';

const NONCE = 'N'.repeat(43);
const CHALLENGE = 'C'.repeat(43);

function peer(
  overrides: Partial<MacosRemoteDesktopBootstrapVerifiedPeer> = {},
): MacosRemoteDesktopBootstrapVerifiedPeer {
  return {
    uid: 501,
    auditSessionId: 100003,
    pidVersion: 17,
    sessionType: 'Aqua',
    bundleIdentifier: 'cc.imcodes.node.remote-desktop-agent',
    teamId: 'M675E26Q67',
    designatedRequirement: 'signed-and-pinned',
    ...overrides,
  };
}

function authority(identity = peer()) {
  return identity.sessionType === 'LoginWindow'
    ? Object.freeze({
      kind: 'loginwindow_bootstrap' as const,
      sessionType: 'LoginWindow' as const,
      uid: identity.uid,
      auditSessionId: identity.auditSessionId,
      pidVersion: identity.pidVersion,
    })
    : Object.freeze({
      kind: 'aqua_user' as const,
      sessionType: 'Aqua' as const,
      auditSessionId: identity.auditSessionId,
      pidVersion: identity.pidVersion,
      user: Object.freeze({
        name: 'desktop-user',
        uid: identity.uid,
        gid: 20,
        home: '/Users/desktop-user',
        tempDir: '/private/var/folders/test/T/',
      }),
    });
}

function hello(
  overrides: Partial<MacosRemoteDesktopBootstrapHello> = {},
): MacosRemoteDesktopBootstrapHello {
  return {
    type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.HELLO,
    bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
    uid: 501,
    auditSessionId: 100003,
    sessionType: 'Aqua',
    instanceNonce: NONCE,
    ...overrides,
  };
}

function launch(identity = peer(), generation = 1) {
  return {
    workerGeneration: generation,
    challenge: CHALLENGE,
    socketPath: macosRemoteDesktopGraphicalSessionPaths(identity).socketPath,
  };
}

describe('macOS global LaunchAgent bootstrap', () => {
  it('issues a one-time grant only after exact kernel identity agreement', async () => {
    const revoke = vi.fn();
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(revoke);
    const verified = peer();
    const grant = await bootstrap.issueGrant(
      verified, hello(), authority(verified), launch(verified),
    );

    expect(bootstrap.socketPath).toBe(MACOS_REMOTE_DESKTOP_BOOTSTRAP_SOCKET_PATH);
    expect(grant).toEqual({
      type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT,
      bootstrapVersion: MACOS_REMOTE_DESKTOP_BOOTSTRAP_VERSION,
      uid: 501,
      auditSessionId: 100003,
      sessionType: 'Aqua',
      instanceNonce: NONCE,
      workerGeneration: 1,
      challenge: CHALLENGE,
      socketPath: macosRemoteDesktopGraphicalSessionPaths(verified).socketPath,
    });
    expect(bootstrap.isActive(grant)).toBe(true);
    expect(revoke).not.toHaveBeenCalled();

    await expect(bootstrap.issueGrant(
      verified, hello(), authority(verified), launch(verified, 2),
    ))
      .rejects.toThrow(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.REPLAY);
  });

  it.each([
    ['uid', peer(), hello({ uid: 502 })],
    ['audit session', peer(), hello({ auditSessionId: 100004 })],
  ])('rejects a mismatched %s before any authority is created', async (_label, verified, claim) => {
    const revoke = vi.fn();
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(revoke);
    await expect(bootstrap.issueGrant(
      verified, claim, authority(verified), launch(verified),
    ))
      .rejects.toThrow(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.IDENTITY_MISMATCH);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes and removes an Aqua predecessor before granting its successor', async () => {
    const order: string[] = [];
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(async (revocation) => {
      order.push(`revoke:${revocation.auditSessionId}:${revocation.workerGeneration}`);
    });
    const firstPeer = peer();
    const first = await bootstrap.issueGrant(
      firstPeer, hello(), authority(firstPeer), launch(firstPeer),
    );
    order.push('first-granted');

    const successorPeer = peer({ auditSessionId: 100004, pidVersion: 18 });
    const successorHello = hello({
      auditSessionId: 100004,
      instanceNonce: 'S'.repeat(43),
    });
    const successor = await bootstrap.issueGrant(
      successorPeer,
      successorHello,
      authority(successorPeer),
      { ...launch(successorPeer, 2), challenge: 'D'.repeat(43) },
    );
    order.push('successor-granted');

    expect(order).toEqual([
      'first-granted',
      'revoke:100003:1',
      'successor-granted',
    ]);
    expect(first.socketPath).not.toBe(successor.socketPath);
    expect(first.challenge).not.toBe(successor.challenge);
    expect(first.instanceNonce).not.toBe(successor.instanceNonce);
    expect(bootstrap.isActive(first)).toBe(false);
    expect(bootstrap.isActive(successor)).toBe(true);
  });

  it('does not let a stale exit revoke a successor session', async () => {
    const revoke = vi.fn();
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(revoke);
    const firstPeer = peer();
    const first = await bootstrap.issueGrant(
      firstPeer, hello(), authority(firstPeer), launch(firstPeer),
    );
    const successorPeer = peer({ auditSessionId: 100004, pidVersion: 18 });
    const successor = await bootstrap.issueGrant(
      successorPeer,
      hello({ auditSessionId: 100004, instanceNonce: 'S'.repeat(43) }),
      authority(successorPeer),
      { ...launch(successorPeer, 2), challenge: 'D'.repeat(43) },
    );

    expect(await bootstrap.revokeInstance(firstPeer)).toBe(false);
    expect(bootstrap.isActive(first)).toBe(false);
    expect(bootstrap.isActive(successor)).toBe(true);
    expect(await bootstrap.revokeInstance(successorPeer)).toBe(true);
    expect(bootstrap.isActive(successor)).toBe(false);
  });

  it('refuses a previous session socket and non-increasing generation', async () => {
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(vi.fn());
    const verified = peer();
    await expect(bootstrap.issueGrant(verified, hello(), authority(verified), {
      ...launch(verified),
      socketPath: macosRemoteDesktopGraphicalSessionPaths({
        uid: verified.uid,
        auditSessionId: 100002,
      }).socketPath,
    })).rejects.toThrow(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.INVALID_LAUNCH);

    await bootstrap.issueGrant(
      verified, hello(), authority(verified), launch(verified, 2),
    );
    const nextPeer = peer({ auditSessionId: 100004, pidVersion: 18 });
    await expect(bootstrap.issueGrant(
      nextPeer,
      hello({ auditSessionId: 100004, instanceNonce: 'S'.repeat(43) }),
      authority(nextPeer),
      { ...launch(nextPeer, 2), challenge: 'D'.repeat(43) },
    )).rejects.toThrow(MACOS_REMOTE_DESKTOP_BOOTSTRAP_ERROR.STALE_GENERATION);
  });

  it('admits LoginWindow without claiming an active Aqua user', async () => {
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(vi.fn());
    const loginWindowPeer = peer({
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 2,
      sessionType: 'LoginWindow',
    });
    const grant = await bootstrap.issueGrant(
      loginWindowPeer,
      hello({
        uid: 88,
        auditSessionId: 100000,
        sessionType: 'LoginWindow',
        instanceNonce: 'L'.repeat(43),
      }),
      authority(loginWindowPeer),
      {
        workerGeneration: 1,
        challenge: 'W'.repeat(43),
        socketPath: macosRemoteDesktopGraphicalSessionPaths(loginWindowPeer).socketPath,
      },
    );
    expect(grant.sessionType).toBe('LoginWindow');
    expect(JSON.stringify(grant)).not.toMatch(/HOME|TMPDIR|Users\//u);
  });

  it('mints session type from resolved authority rather than the raw hello', async () => {
    const bootstrap = new MacosRemoteDesktopGlobalAgentBootstrap(vi.fn());
    const loginWindowPeer = peer({
      uid: 88,
      auditSessionId: 100000,
      pidVersion: 2,
      sessionType: 'LoginWindow',
    });
    const rawAqua = hello({
      uid: 88,
      auditSessionId: 100000,
      sessionType: 'Aqua',
      instanceNonce: 'A'.repeat(43),
    });
    const grant = await bootstrap.issueGrant(
      loginWindowPeer,
      rawAqua,
      authority(loginWindowPeer),
      {
        workerGeneration: 1,
        challenge: 'W'.repeat(43),
        socketPath: macosRemoteDesktopGraphicalSessionPaths(loginWindowPeer).socketPath,
      },
    );
    expect(grant.sessionType).toBe('LoginWindow');
  });

  it('serves a bounded production listener and tears down cleanly for restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-bootstrap-listener-'));
    const socketPath = join(directory, 'bootstrap.sock');
    const errors: unknown[] = [];
    const listener = new MacosRemoteDesktopGlobalAgentBootstrapListener({
      socketPath,
      prepareSocketPath: async () => undefined,
      secureSocketPath: async () => undefined,
      verifyPeer: async (_socket, expected) => peer({
        uid: expected.uid,
        auditSessionId: expected.auditSessionId,
        sessionType: 'LoginWindow',
      }),
      resolveAuthority: async (verified, claim) => ({
        kind: 'loginwindow_bootstrap',
        sessionType: 'LoginWindow',
        uid: verified.uid,
        auditSessionId: verified.auditSessionId,
        pidVersion: verified.pidVersion,
      }),
      createLaunch: async (authority) => ({
        workerGeneration: 1,
        challenge: CHALLENGE,
        socketPath: macosRemoteDesktopGraphicalSessionPaths({
          uid: authority.kind === 'aqua_user' ? authority.user.uid : authority.uid,
          auditSessionId: authority.auditSessionId,
        }).socketPath,
      }),
      revoke: vi.fn(),
      onBackgroundError: (error) => errors.push(error),
    });
    try {
      await listener.start();
      const response = await exchange(socketPath, hello({
        sessionType: 'LoginWindow',
      }));
      expect(JSON.parse(response)).toMatchObject({
        type: MACOS_REMOTE_DESKTOP_BOOTSTRAP_MESSAGE.GRANT,
        uid: 501,
        auditSessionId: 100003,
        sessionType: 'LoginWindow',
        workerGeneration: 1,
      });
      expect(errors).toEqual([]);
      await listener.stop();
      await listener.start();
      await listener.stop();
    } finally {
      await listener.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('awaits the exact ledger grant before writing and revokes when the callback refuses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-bootstrap-grant-hook-'));
    const socketPath = join(directory, 'bootstrap.sock');
    const revoke = vi.fn();
    const observed: object[] = [];
    const listener = new MacosRemoteDesktopGlobalAgentBootstrapListener({
      socketPath,
      prepareSocketPath: async () => undefined,
      secureSocketPath: async () => undefined,
      verifyPeer: async (_socket, expected) => peer({
        uid: expected.uid,
        auditSessionId: expected.auditSessionId,
        sessionType: 'LoginWindow',
      }),
      resolveAuthority: async (verified) => authority(verified),
      createLaunch: async (resolved) => ({
        workerGeneration: 1,
        challenge: CHALLENGE,
        socketPath: macosRemoteDesktopGraphicalSessionPaths({
          uid: resolved.kind === 'aqua_user' ? resolved.user.uid : resolved.uid,
          auditSessionId: resolved.auditSessionId,
        }).socketPath,
      }),
      onGrantIssued: async (grant) => {
        observed.push(grant);
        expect(Object.isFrozen(grant)).toBe(true);
        throw new Error('refuse_exact_grant');
      },
      revoke,
    });
    try {
      await listener.start();
      await expect(exchange(socketPath, hello({ sessionType: 'LoginWindow' })))
        .rejects.toBeDefined();
      expect(observed).toHaveLength(1);
      expect(revoke).toHaveBeenCalledOnce();
      expect(revoke.mock.calls[0]?.[0]).toMatchObject({
        workerGeneration: 1,
        socketPath: macosRemoteDesktopGraphicalSessionPaths(peer()).socketPath,
        reason: 'session_exit',
      });
    } finally {
      await listener.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('closes a listener connection when native peer evidence disagrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-bootstrap-reject-'));
    const socketPath = join(directory, 'bootstrap.sock');
    const errors: unknown[] = [];
    const createLaunch = vi.fn();
    const listener = new MacosRemoteDesktopGlobalAgentBootstrapListener({
      socketPath,
      prepareSocketPath: async () => undefined,
      secureSocketPath: async () => undefined,
      verifyPeer: async () => peer({ uid: 502 }),
      resolveAuthority: async () => {
        throw new Error('must_not_resolve');
      },
      createLaunch,
      revoke: vi.fn(),
      onBackgroundError: (error) => errors.push(error),
    });
    try {
      await listener.start();
      await expect(exchange(socketPath, hello())).rejects.toThrow('closed_without_grant');
      expect(createLaunch).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    } finally {
      await listener.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function exchange(socketPath: string, value: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.once('error', reject);
    socket.once('close', () => {
      const line = response.trim();
      if (!line) reject(new Error('closed_without_grant'));
      else resolve(line);
    });
  });
}
