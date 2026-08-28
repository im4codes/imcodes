import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_MACOS_TEAM_ID } from '../../shared/remote-desktop-worker.js';
import {
  createMacosRemoteDesktopNativePeerVerificationSeams,
} from '../../src/node/macos-remote-desktop-peer-verifier.js';

const tempRoots: string[] = [];
const BUNDLE_ID = 'cc.imcodes.node.remote-desktop-agent';
// The expectation the daemon is allowed to hold. Built from the pinned team so
// a test cannot silently re-introduce the arbitrary-team acceptance it guards.
const EXPECTED = Object.freeze({
  bundleIdentifier: BUNDLE_ID,
  teamId: REMOTE_DESKTOP_MACOS_TEAM_ID,
  designatedRequirement: `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${REMOTE_DESKTOP_MACOS_TEAM_ID}"`,
});

/**
 * A verifier stand-in whose ENTIRE behaviour is the body it is handed.
 *
 * `fixtureHelper` echoes the arguments back, which can only ever produce the
 * happy path -- a peer that agrees with whatever was asked of it. Every defect
 * worth testing here is a peer that DISAGREES, dies, floods or hangs, so those
 * cases need a script that ignores the arguments entirely.
 */
async function scriptedHelper(root: string, body: string): Promise<string> {
  const executable = join(root, `scripted-${randomUUID()}`);
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, 'utf8');
  await chmod(executable, 0o700);
  return executable;
}

/** A script that prints one JSON payload verbatim and exits cleanly. */
function emits(payload: unknown): string {
  return `process.stdout.write(${JSON.stringify(`${JSON.stringify(payload)}\n`)});`;
}

function peerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    uid: process.getuid!(),
    auditSessionId: 100003,
    pidVersion: 7,
    sessionType: 'Aqua',
    bundleIdentifier: EXPECTED.bundleIdentifier,
    teamId: EXPECTED.teamId,
    designatedRequirement: EXPECTED.designatedRequirement,
    ...overrides,
  };
}

async function fixtureHelper(root: string): Promise<{ executable: string; calls: string }> {
  const executable = join(root, 'peer-verifier-fixture');
  const calls = join(root, 'calls');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (!fs.fstatSync(3).isSocket()) process.exit(70);
const args = Object.fromEntries(process.argv.slice(3).map((item) => {
  const separator = item.indexOf('=');
  return [item.slice(2, separator), item.slice(separator + 1)];
}));
fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
process.stdout.write(JSON.stringify({
  version: 1,
  uid: Number(args['expected-uid']),
  // The native verifier emits the audit session and the process-id version so
  // a caller can bind a capability to THIS session and THIS incarnation. Echoed
  // here in the same shape, and honouring --expected-audit-session-id when the
  // caller named one.
  auditSessionId: Number(args['expected-audit-session-id'] ?? 100003),
  pidVersion: 7,
  // The production native child joins the authenticated audit session and
  // classifies the window-server dictionary there. This fixture represents
  // that independent result rather than echoing a hello field.
  sessionType: 'Aqua',
  bundleIdentifier: args['bundle-id'],
  teamId: args['team-id'],
  designatedRequirement: args['designated-requirement'],
}) + '\\n');
`, 'utf8');
  await chmod(executable, 0o700);
  return { executable, calls };
}

async function socketFixture(root: string): Promise<{ server: net.Server; peer: Socket; client: Socket }> {
  const socketPath = join(root, 'peer.sock');
  let resolvePeer!: (socket: Socket) => void;
  const peerPromise = new Promise<Socket>((resolveSocket) => {
    resolvePeer = resolveSocket;
  });
  const server = net.createServer((socket) => resolvePeer(socket));
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListening);
  });
  const client = net.createConnection({ path: socketPath });
  client.on('error', () => undefined);
  await once(client, 'connect');
  return { server, peer: await peerPromise, client };
}

afterEach(async () => {
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'darwin')('macOS native peer verifier bridge', () => {
  it('passes the accepted socket through documented child stdio and shares one native result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-peer-verifier-'));
    tempRoots.push(root);
    const helper = await fixtureHelper(root);
    const sockets = await socketFixture(root);
    const expected = EXPECTED;
    try {
      const seams = createMacosRemoteDesktopNativePeerVerificationSeams({
        executablePath: helper.executable,
        expectedUid: process.getuid!(),
        expectedCodeIdentity: expected,
      });
      const [uid, identity, peer] = await Promise.all([
        seams.inspectPeerUid(sockets.peer),
        seams.verifyPeerCodeIdentity(sockets.peer, expected),
        seams.verifyPeer!(sockets.peer),
      ]);
      expect(uid).toBe(process.getuid!());
      expect(identity).toMatchObject(expected);
      // The audit session and pid generation are carried, not dropped. The
      // server binds display authority to them, and a uid plus a code identity
      // cannot tell a relaunched peer from the live one.
      expect(identity.auditSessionId).toBeGreaterThan(0);
      expect(identity.pidVersion).toBeGreaterThan(0);
      expect(peer.sessionType).toBe('Aqua');
      expect(await readFile(helper.calls, 'utf8')).toBe('call\n');
    } finally {
      sockets.peer.destroy();
      sockets.client.destroy();
      await new Promise<void>((resolveClose) => sockets.server.close(() => resolveClose()));
    }
  });

  it('fails closed when a caller changes the expected code identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-peer-verifier-'));
    tempRoots.push(root);
    const helper = await fixtureHelper(root);
    const sockets = await socketFixture(root);
    const expected = EXPECTED;
    try {
      const seams = createMacosRemoteDesktopNativePeerVerificationSeams({
        executablePath: helper.executable,
        expectedUid: process.getuid!(),
        expectedCodeIdentity: expected,
      });
      await expect(seams.verifyPeerCodeIdentity(sockets.peer, {
        ...expected,
        designatedRequirement: `${expected.designatedRequirement} and false`,
      })).rejects.toThrow('macos_remote_desktop_native_peer_verification_failed');
      await expect(seams.inspectPeerUid(sockets.peer)).resolves.toBe(process.getuid!());
    } finally {
      sockets.peer.destroy();
      sockets.client.destroy();
      await new Promise<void>((resolveClose) => sockets.server.close(() => resolveClose()));
    }
  });

  it('refuses to be constructed with a team the product does not ship under', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-peer-verifier-'));
    tempRoots.push(root);
    const helper = await fixtureHelper(root);
    // The whole point of the pin. A well-formed ten-character team id used to
    // be accepted on its own shape, which meant a component set signed by any
    // Apple team could name itself as the expectation and then satisfy it.
    for (const teamId of ['ABCDE12345', 'ZZZZZ99999', REMOTE_DESKTOP_MACOS_TEAM_ID.toLowerCase()]) {
      expect(() => createMacosRemoteDesktopNativePeerVerificationSeams({
        executablePath: helper.executable,
        expectedUid: process.getuid!(),
        expectedCodeIdentity: {
          bundleIdentifier: BUNDLE_ID,
          teamId,
          designatedRequirement: `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`,
        },
      }), teamId).toThrow('macos_remote_desktop_native_peer_verification_failed');
    }
    // The canonical team is the one that survives.
    expect(() => createMacosRemoteDesktopNativePeerVerificationSeams({
      executablePath: helper.executable,
      expectedUid: process.getuid!(),
      expectedCodeIdentity: EXPECTED,
    })).not.toThrow();
  });

  it('rejects every peer payload that disagrees, is malformed or is mis-shaped', async () => {
    const cases: Array<[string, string]> = [
      // A peer that answers with a DIFFERENT team than the one asked for. The
      // native side echoing the expectation is what makes this the load-bearing
      // case: only an explicit comparison catches a lying verifier.
      ['wrong team', emits(peerPayload({
        teamId: 'ABCDE12345',
        designatedRequirement: `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"`,
      }))],
      ['wrong bundle identifier', emits(peerPayload({ bundleIdentifier: 'cc.imcodes.node.somebody-else' }))],
      ['wrong designated requirement', emits(peerPayload({ designatedRequirement: `${EXPECTED.designatedRequirement} or anchor trusted` }))],
      ['wrong uid', emits(peerPayload({ uid: process.getuid!() + 1 }))],
      // Zero is the kernel's "no audit session". A capability bound to it is a
      // capability that outlives the login it was granted in.
      ['zero audit session', emits(peerPayload({ auditSessionId: 0 }))],
      ['negative audit session', emits(peerPayload({ auditSessionId: -1 }))],
      // Pids are reused; the version is what makes one an identity.
      ['zero pid version', emits(peerPayload({ pidVersion: 0 }))],
      ['unknown graphical session type', emits(peerPayload({ sessionType: 'Console' }))],
      ['version mismatch', emits(peerPayload({ version: 2 }))],
      ['extra key', emits({ ...peerPayload(), privileged: true })],
      ['missing key', emits((() => {
        const { pidVersion: _dropped, ...rest } = peerPayload();
        return rest;
      })())],
      ['non-integer uid', emits(peerPayload({ uid: 1.5 }))],
      ['array instead of object', emits([peerPayload()])],
      ['null payload', emits(null)],
      ['malformed JSON', 'process.stdout.write(\'{"version":1,\');'],
      ['empty output', 'process.stdout.write("");'],
      ['nonzero exit after a valid payload', `${emits(peerPayload())}process.exit(3);`],
      ['death by signal', `${emits(peerPayload())}process.kill(process.pid, 'SIGKILL');`],
      // MAX_OUTPUT_BYTES is 4 KiB; a peer that floods the pipe must be killed
      // rather than buffered until the daemon runs out of memory.
      ['oversized stdout', `process.stdout.write("x".repeat(64 * 1024));${emits(peerPayload())}`],
      ['oversized stderr', `process.stderr.write("x".repeat(64 * 1024));${emits(peerPayload())}`],
    ];
    for (const [label, body] of cases) {
      const root = await mkdtemp(join(tmpdir(), 'imcodes-peer-verifier-'));
      tempRoots.push(root);
      const executable = await scriptedHelper(root, body);
      const sockets = await socketFixture(root);
      try {
        const seams = createMacosRemoteDesktopNativePeerVerificationSeams({
          executablePath: executable,
          expectedUid: process.getuid!(),
          expectedCodeIdentity: EXPECTED,
        });
        await expect(seams.verifyPeer!(sockets.peer), label)
          .rejects.toThrow('macos_remote_desktop_native_peer_verification_failed');
        // uid must not leak out of a verification that failed: both seams are
        // views onto the SAME native result, so one cannot succeed alone.
        await expect(seams.inspectPeerUid(sockets.peer), label)
          .rejects.toThrow('macos_remote_desktop_native_peer_verification_failed');
      } finally {
        sockets.peer.destroy();
        sockets.client.destroy();
        await new Promise<void>((resolveClose) => sockets.server.close(() => resolveClose()));
      }
    }
    // Each case spawns a real verifier process and a real unix socket server.
    // Nineteen of those legitimately exceed the suite's 20s default when the
    // machine is loaded, which showed up as a flake in full-suite runs while
    // passing in isolation. The budget is raised rather than the coverage cut.
  }, 90_000);

  it('kills and fails a verifier that never answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-peer-verifier-'));
    tempRoots.push(root);
    const executable = await scriptedHelper(root, 'setTimeout(() => undefined, 60_000);');
    const sockets = await socketFixture(root);
    try {
      const seams = createMacosRemoteDesktopNativePeerVerificationSeams({
        executablePath: executable,
        expectedUid: process.getuid!(),
        expectedCodeIdentity: EXPECTED,
        timeoutMs: 50,
      });
      await expect(seams.verifyPeer!(sockets.peer))
        .rejects.toThrow('macos_remote_desktop_native_peer_verification_failed');
    } finally {
      sockets.peer.destroy();
      sockets.client.destroy();
      await new Promise<void>((resolveClose) => sockets.server.close(() => resolveClose()));
    }
  });

  it('does not depend on private net.Socket handle fields', async () => {
    const source = await readFile(resolve('src/node/macos-remote-desktop-peer-verifier.ts'), 'utf8');
    expect(source).not.toContain('_handle');
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe', socket]");
  });
});
