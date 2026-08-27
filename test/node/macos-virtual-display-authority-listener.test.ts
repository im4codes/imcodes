import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY_MODE,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_MODE,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH,
  assertAuthorityChainSafe,
  authorityAncestors,
  handleAuthorityConnection,
  serializeAuthorityChallenge,
  startMacosVirtualDisplayAuthorityListener,
  type MacosVirtualDisplayAuthorityLease,
} from '../../src/node/macos-virtual-display-authority-listener.js';

/**
 * Every call to `handleAuthorityConnection` in this file goes through here.
 *
 * The function takes exactly THREE arguments. Vitest only transpiles -- it
 * never typechecks -- and the root tsconfig excludes `test/` outright, so for
 * a while all eight call sites below quietly passed a fourth argument: a dead
 * `() => 1_700_000_000_000` clock left behind when the parameter was removed.
 * Nothing failed. An identifier grep for `nowMs` could not see it either,
 * because the argument was anonymous.
 *
 * So the check is made load-bearing at RUN time, under the same `vitest run`
 * everyone already executes. `Parameters<typeof handleAuthorityConnection>`
 * rejects a fourth argument for anyone who does typecheck this file, and the
 * arity assertion catches it for everyone who does not.
 */
function callHandleAuthorityConnection(
  ...args: Parameters<typeof handleAuthorityConnection>
): Promise<void> {
  expect(args.length, 'handleAuthorityConnection takes exactly three arguments')
    .toBe(3);
  return handleAuthorityConnection(...args);
}

type Facts = {
  uid: number; mode: number; isSymbolicLink: boolean; isDirectory: boolean;
};

/** The chain a correctly installed daemon produces. */
function healthyChain(): Map<string, Facts> {
  const chain = new Map<string, Facts>();
  for (const directory of ['/', '/private', '/private/var', '/private/var/db',
                           '/private/var/db/imcodes-node']) {
    chain.set(directory, { uid: 0, mode: 0o755, isSymbolicLink: false, isDirectory: true });
  }
  chain.set('/private/var/db/imcodes-node/runtime', {
    uid: 0,
    mode: MACOS_VIRTUAL_DISPLAY_AUTHORITY_DIRECTORY_MODE,
    isSymbolicLink: false,
    isDirectory: true,
  });
  chain.set(MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, {
    uid: 0,
    mode: MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_MODE,
    isSymbolicLink: false,
    isDirectory: false,
  });
  return chain;
}

const inspectFrom = (chain: Map<string, Facts>) =>
  (path: string) => chain.get(path) ?? null;

/** A socket that records what was written to it and can be ended on demand. */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  end(): void {
    this.emit('close');
  }
}

const asSocket = (socket: FakeSocket): Socket => socket as unknown as Socket;

interface VerifiedPeer {
  uid: number;
  auditSessionId: number;
  pidVersion: number;
  bundleIdentifier: string;
  teamId: string;
  designatedRequirement: string;
}

function peer(overrides: Partial<VerifiedPeer> = {}): VerifiedPeer {
  return {
    uid: 501,
    auditSessionId: 100_003,
    pidVersion: 7,
    bundleIdentifier: 'cc.imcodes.node.remote-desktop-launch-agent',
    teamId: 'ABCDE12345',
    designatedRequirement: 'identifier "cc.imcodes.node.remote-desktop-launch-agent"'
      + ' and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
    ...overrides,
  };
}

/** Records the order of every externally visible effect. */
function makeSeams(options: {
  verify?: () => Promise<VerifiedPeer>;
  trace?: string[];
} = {}) {
  const trace = options.trace ?? [];
  let generation = 0;
  let secrets = 0;
  return {
    trace,
    seams: {
      verification: {
        async inspectPeerUid() { return 501; },
        async verifyPeerCodeIdentity() { throw new Error('unused'); },
        async verifyPeer() {
          trace.push('verify');
          if (options.verify) return await options.verify() as never;
          return peer() as never;
        },
      } as never,
      nextServiceGeneration: () => {
        trace.push('mint-generation');
        generation += 1;
        return generation;
      },
      mintChallenge: () => {
        // Traced so the ordering assertion covers the SECRET, not merely the
        // generation counter next to it.
        trace.push('mint-challenge');
        secrets += 1;
        return `${'z'.repeat(42)}${String(secrets % 10)}`;
      },
    },
  };
}

describe('macOS virtual-display authority listener', () => {
  it('walks every ancestor, not just the socket', () => {
    // A writable directory ANYWHERE above the socket is a directory in which
    // the socket can be replaced, so checking only the leaf proves nothing.
    expect(authorityAncestors(MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH)).toEqual([
      '/', '/private', '/private/var', '/private/var/db',
      '/private/var/db/imcodes-node', '/private/var/db/imcodes-node/runtime',
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH,
    ]);
    expect(() => assertAuthorityChainSafe(
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(healthyChain()),
    )).not.toThrow();
  });

  it('refuses a non-root owner at any position, leaf included', () => {
    for (const component of authorityAncestors(MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH)) {
      const chain = healthyChain();
      chain.set(component, { ...chain.get(component)!, uid: 501 });
      expect(() => assertAuthorityChainSafe(
        MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
      ), `${component} owned by 501 was accepted`)
        .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    }
  });

  it('refuses a group- or world-writable directory at any position', () => {
    const directories = authorityAncestors(MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH).slice(0, -1);
    for (const component of directories) {
      for (const bit of [0o020, 0o002]) {
        const chain = healthyChain();
        chain.set(component, { ...chain.get(component)!, mode: chain.get(component)!.mode | bit });
        expect(() => assertAuthorityChainSafe(
          MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
        ), `${component} writable by others was accepted`)
          .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
      }
    }
  });

  it('refuses a directory the agent cannot traverse, and accepts 0711', () => {
    // 0700 is unreachable by a console-uid agent: connect(2) needs search on
    // every component, and the resulting EACCES is indistinguishable from "the
    // daemon is not running". Removing other's x buys nothing -- replacing the
    // socket needs WRITE, which 0711 still denies.
    const chain = healthyChain();
    chain.set('/private/var/db/imcodes-node/runtime', {
      uid: 0, mode: 0o700, isSymbolicLink: false, isDirectory: true,
    });
    expect(() => assertAuthorityChainSafe(
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
    )).toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);

    chain.set('/private/var/db/imcodes-node/runtime', {
      uid: 0, mode: 0o711, isSymbolicLink: false, isDirectory: true,
    });
    expect(() => assertAuthorityChainSafe(
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
    )).not.toThrow();

    // ...while 0o731 still fails, so what is accepted is not "anything with an
    // x bit".
    chain.set('/private/var/db/imcodes-node/runtime', {
      uid: 0, mode: 0o731, isSymbolicLink: false, isDirectory: true,
    });
    expect(() => assertAuthorityChainSafe(
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
    )).toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
  });

  it('refuses a symlink anywhere in the chain', () => {
    for (const component of authorityAncestors(MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH)) {
      const chain = healthyChain();
      chain.set(component, { ...chain.get(component)!, isSymbolicLink: true });
      expect(() => assertAuthorityChainSafe(
        MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(chain),
      ), `symlinked ${component} was accepted`)
        .toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
    }
    // A missing component is refused rather than skipped.
    const missing = healthyChain();
    missing.delete('/private/var/db');
    expect(() => assertAuthorityChainSafe(
      MACOS_VIRTUAL_DISPLAY_AUTHORITY_SOCKET_PATH, inspectFrom(missing),
    )).toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.CHAIN_UNSAFE);
  });

  it('refuses to listen at all when not root', async () => {
    // A non-root daemon cannot create a rendezvous the agent would accept, so
    // it refuses here rather than producing one that is silently never usable.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    await expect(startMacosVirtualDisplayAuthorityListener(
      { onLease: () => {}, onLeaseEnded: () => {} },
      makeSeams().seams,
    )).rejects.toThrow(MACOS_VIRTUAL_DISPLAY_AUTHORITY_ERROR.NOT_ROOT);
  });

  it('mints the challenge only AFTER the agent is authenticated', async () => {
    const trace: string[] = [];
    const { seams } = makeSeams({ trace });
    const socket = new FakeSocket();
    const leases: MacosVirtualDisplayAuthorityLease[] = [];
    await callHandleAuthorityConnection(
      asSocket(socket),
      { onLease: (lease) => { trace.push('lease'); leases.push(lease); }, onLeaseEnded: () => {} },
      seams,
    );
    // Ordering is the property, not just that all three happened: a challenge
    // minted before verification is a secret handed to whoever connected.
    // The SECRET's creation is in the trace, so "minted only after
    // authentication" is a property of this assertion rather than an
    // inference from the counter beside it.
    expect(trace).toEqual(['verify', 'mint-challenge', 'mint-generation', 'lease']);
    expect(leases).toHaveLength(1);
    expect(socket.written).toHaveLength(1);
    expect(socket.written[0]).toBe(`${serializeAuthorityChallenge(leases[0]!)}\n`);
    expect(socket.written[0]).toMatch(/^chal1 challenge=[A-Za-z0-9_-]{43} svcgen=\d+ asid=\d+ ttl=\d+\n$/u);
    // Exactly one secret was ever created for this connection.
    expect(trace.filter((entry) => entry === 'mint-challenge')).toHaveLength(1);
  });

  it('mints nothing at all for a peer it cannot verify', async () => {
    for (const [what, verify] of [
      ['an unverifiable peer', async () => { throw new Error('refused'); }],
      ['a peer with no audit session', async () => peer({ auditSessionId: 0 })],
      ['a peer with a negative audit session', async () => peer({ auditSessionId: -1 })],
      ['a peer with no uid', async () => peer({ uid: 0 })],
    ] as const) {
      const trace: string[] = [];
      const { seams } = makeSeams({ trace, verify: verify as never });
      const socket = new FakeSocket();
      let leased = false;
      await callHandleAuthorityConnection(
        asSocket(socket),
        { onLease: () => { leased = true; }, onLeaseEnded: () => {} },
        seams,
        );
      expect(leased, `${what} was leased`).toBe(false);
      expect(socket.destroyed, `${what} was not dropped`).toBe(true);
      // NOTHING was written: no challenge, no partial frame, no diagnosis.
      expect(socket.written, `${what} was sent bytes`).toHaveLength(0);
      // And no generation was consumed, so a refused peer cannot burn through
      // the generation space.
      // Not even a challenge came into existence, let alone reached the wire.
      expect(trace).toEqual(['verify']);
    }
  });

  it('refuses to lease when the seam cannot fully verify the peer', async () => {
    // `verifyPeer` is optional on the seam: narrow test seams implement only
    // the worker-socket methods. When it is absent nobody can establish the
    // agent's audit session, and admitting a peer we could not fully check is
    // worse than refusing to lease. An optional field must not become a silent
    // pass.
    const { trace } = makeSeams();
    const narrow = {
      verification: {
        async inspectPeerUid() { return 501; },
        async verifyPeerCodeIdentity() { throw new Error('unused'); },
        // verifyPeer deliberately absent
      } as never,
      nextServiceGeneration: () => 1,
    };
    const socket = new FakeSocket();
    let leased = false;
    await callHandleAuthorityConnection(
      asSocket(socket),
      { onLease: () => { leased = true; }, onLeaseEnded: () => {} },
      narrow,
    );
    expect(leased).toBe(false);
    expect(socket.destroyed).toBe(true);
    expect(socket.written).toHaveLength(0);
    expect(trace).toEqual([]);
  });

  it('binds the lease to the peer audit session, never to uid alone', async () => {
    const { seams } = makeSeams({ verify: async () => peer({ auditSessionId: 424_242 }) });
    const socket = new FakeSocket();
    const leases: MacosVirtualDisplayAuthorityLease[] = [];
    await callHandleAuthorityConnection(
      asSocket(socket),
      { onLease: (lease) => leases.push(lease), onLeaseEnded: () => {} },
      seams,
    );
    // uid alone cannot tell two successive login windows apart, so the session
    // travels in the challenge and the agent's grant must match it.
    expect(leases[0]!.auditSessionId).toBe(424_242);
    expect(socket.written[0]).toContain('asid=424242');
  });

  it('ends authority when the connection ends, exactly once', async () => {
    const { seams } = makeSeams();
    const socket = new FakeSocket();
    const ended: MacosVirtualDisplayAuthorityLease[] = [];
    await callHandleAuthorityConnection(
      asSocket(socket),
      { onLease: () => {}, onLeaseEnded: (lease) => ended.push(lease) },
      seams,
    );
    expect(ended).toHaveLength(0);
    socket.emit('end');
    socket.emit('close');
    socket.emit('error', new Error('gone'));
    // The connection IS the lease, and it ends once however many ways it is
    // reported: a second revocation would revoke a lease that no longer exists.
    expect(ended).toHaveLength(1);
  });

  it('never reuses a service generation across connections', async () => {
    const { seams } = makeSeams();
    const generations: number[] = [];
    const challenges: string[] = [];
    for (let connection = 0; connection < 4; connection += 1) {
      const socket = new FakeSocket();
      await callHandleAuthorityConnection(
        asSocket(socket),
        {
          onLease: (lease) => {
            generations.push(lease.serviceGeneration);
            challenges.push(lease.challenge);
          },
          onLeaseEnded: () => {},
        },
        seams,
        );
      socket.emit('close');
    }
    // Strictly increasing: a restarted agent must not be able to present a
    // grant minted for a previous incarnation.
    expect(generations).toEqual([1, 2, 3, 4]);
    // And every challenge is distinct, so one connection's secret is useless
    // on the next.
    expect(new Set(challenges).size).toBe(4);
    for (const challenge of challenges) expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('mints unpredictable secrets on the PRODUCTION path, with no seam', async () => {
    // Every other test injects mintChallenge so it can observe the ordering.
    // That leaves the real CSPRNG path untested -- a mutation replacing it with
    // a constant survived until this case existed.
    let generation = 0;
    const seams = {
      verification: {
        async inspectPeerUid() { return 501; },
        async verifyPeerCodeIdentity() { throw new Error('unused'); },
        async verifyPeer() { return peer() as never; },
      } as never,
      nextServiceGeneration: () => { generation += 1; return generation; },
      // mintChallenge deliberately ABSENT: this exercises production.
    };

    const challenges = new Set<string>();
    for (let connection = 0; connection < 16; connection += 1) {
      const socket = new FakeSocket();
      await callHandleAuthorityConnection(
        asSocket(socket),
        { onLease: (lease) => challenges.add(lease.challenge), onLeaseEnded: () => {} },
        seams,
        );
      socket.emit('close');
    }
    // Sixteen connections, sixteen distinct secrets. A counter or a constant
    // would collide here; so would anything seeded from the clock at this
    // resolution.
    expect(challenges.size).toBe(16);
    for (const challenge of challenges) {
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      // Not a repeated character, which is what a lazy stand-in looks like.
      expect(new Set(challenge).size).toBeGreaterThan(4);
    }
  });

  it('puts the secret on the authenticated socket and nowhere else', async () => {
    const { seams } = makeSeams();
    const socket = new FakeSocket();
    const leases: MacosVirtualDisplayAuthorityLease[] = [];
    await callHandleAuthorityConnection(
      asSocket(socket),
      { onLease: (lease) => leases.push(lease), onLeaseEnded: () => {} },
      seams,
    );
    const secret = leases[0]!.challenge;
    // Not in the environment, not in argv. Anything readable there is readable
    // by the local user, and a readable secret authenticates nobody.
    expect(JSON.stringify(process.env)).not.toContain(secret);
    expect(process.argv.join(' ')).not.toContain(secret);
    // The only place it appears is the frame written to the socket that was
    // just authenticated.
    expect(socket.written.join('')).toContain(secret);
    expect(socket.written).toHaveLength(1);
  });
});
