/**
 * Hook endpoint authority: legacy-format compatibility, publish fencing,
 * fixture containment, and owner-verified resolution.
 *
 * This file REPLACES the previous `resolveLiveHookPort` suite, which asserted
 * the behaviour that caused the field incident:
 *
 *   it('scans the range and heals the file when the saved port is dead')
 *   it('scans from DEFAULT_HOOK_PORT when there is no saved port')
 *
 * Those encoded "if any listener in a fixed 20-port window accepts a TCP
 * connection, adopt it and rewrite the record" — which is how an unrelated
 * listener could become the daemon hook endpoint, and why a live daemon on
 * 51941 was unreachable when the record said 51915 (window 51896..51932).
 * Resolution is now scan-free and owner-verified, so those assertions are gone
 * on purpose.
 *
 * Two regressions here are load-bearing and must never be weakened:
 *  - `hook-port` stays DIGITS-ONLY. Writing JSON there broke the installed CLI
 *    (which parses only digits) and made a healthy daemon look unreachable.
 *  - A test-runner process cannot publish over the machine-global record.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync, chmodSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_AUTHORITY_ERROR,
  HOOK_AUTHORITY_RECORD_VERSION,
  HOOK_AUTHORITY_SIDECAR_FILE_NAME,
  HOOK_PORT_FILE_NAME,
  isLegacyCompatibleHookPortFile,
  parseHookPortFile,
  serializeHookAuthorityRecord,
  type HookAuthorityOwner,
  type HookAuthorityRecord,
  type HookIdentityResponse,
} from '../../shared/hook-authority.js';
import {
  hookAuthorityLockDirPath,
  hookAuthorityLockPath,
  publishHookAuthority,
  readHookAuthorityState,
  readSavedHookPort,
  resolveHookAuthority,
  resolveLiveHookPort,
  DEFAULT_HOOK_PORT,
  HOOK_BIND_RETRY_SPAN,
  HOOK_PUBLISH_LOCK,
} from '../../src/daemon/hook-port.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import type { ProcessLiveness } from '../../src/daemon/instance-lock.js';
import type { AuthorityFileRead } from '../../src/daemon/hook-port.js';

const LIVE_PORT = 51941;
const STALE_PORT = 51915;

const OWNER: HookAuthorityOwner = { pid: 4242, startToken: 'ps:Thu Jan  1 00:00:00 2026' };
const OTHER_OWNER: HookAuthorityOwner = { pid: 777, startToken: 'ps:Wed Dec 31 23:00:00 2025' };

function record(port: number, owner: HookAuthorityOwner = OWNER): HookAuthorityRecord {
  return {
    version: HOOK_AUTHORITY_RECORD_VERSION,
    port,
    pid: owner.pid,
    startToken: owner.startToken,
    publishedAt: 1_700_000_000_000,
  };
}

function identity(port: number, owner: HookAuthorityOwner = OWNER): HookIdentityResponse {
  return { version: HOOK_AUTHORITY_RECORD_VERSION, port, pid: owner.pid, startToken: owner.startToken };
}

const alive = (owner: HookAuthorityOwner): ProcessLiveness => ({ status: 'alive', startToken: owner.startToken });

/** Hex nonce derived from a readable tag (released-marker names are hex). */
const hexNonce = (tag: string): string => Buffer.from(tag, 'utf8').toString('hex');

/** Current generation token of the lock directory, creating one if absent. */
function lockGeneration(home: string): string {
  const dir = hookAuthorityLockDirPath(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'generation');
  if (!existsSync(path)) writeFileSync(path, `${hexNonce('seed-generation-0').padEnd(32, '0').slice(0, 32)}\n`);
  return readFileSync(path, 'utf8').trim();
}

/** Install epoch `epoch` of the publication lock (current generation) as held
 *  by `owner`. */
function seedEpoch(
  home: string,
  epoch: number,
  owner: HookAuthorityOwner,
  nonce = hexNonce(`seed-${owner.pid}-${epoch}`),
): { nonce: string; ino: bigint } {
  const generation = lockGeneration(home);
  const path = join(hookAuthorityLockDirPath(home), `${generation}.${epoch}.lock`);
  writeFileSync(path, `${JSON.stringify({ ...owner, nonce, acquiredAt: Date.now() })}\n`);
  return { nonce, ino: statSync(path, { bigint: true }).ino };
}

interface TopEpoch {
  generation: string;
  epoch: number;
  pid: number;
  nonce: string;
  ino: bigint;
  released: boolean;
}

/** The highest epoch of the CURRENT generation - the entry every lock decision
 *  is made on. */
function topEpoch(home: string): TopEpoch | null {
  const dir = hookAuthorityLockDirPath(home);
  const genPath = join(dir, 'generation');
  if (!existsSync(genPath)) return null;
  const generation = readFileSync(genPath, 'utf8').trim();
  const names = readdirSync(dir);
  const epochs = names
    .map((name) => /^([0-9a-f]{32})\.(\d+)\.lock$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === generation)
    .map((m) => Number(m[2]));
  if (epochs.length === 0) return null;
  const epoch = Math.max(...epochs);
  const path = join(dir, `${generation}.${epoch}.lock`);
  const holder = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; nonce: string };
  return {
    generation,
    epoch,
    pid: holder.pid,
    nonce: holder.nonce,
    ino: statSync(path, { bigint: true }).ino,
    released: names.includes(`${generation}.${epoch}.${holder.nonce}.released`),
  };
}

/** Write the LEGACY single-file lock (an older build's format) verbatim. */
function seedLegacyLock(home: string, text: string): { ino: bigint } {
  mkdirSync(home, { recursive: true });
  writeFileSync(hookAuthorityLockPath(home), text);
  return { ino: statSync(hookAuthorityLockPath(home), { bigint: true }).ino };
}

/** A suspension point a test opens explicitly. */
function barrier(): { hook: () => Promise<void>; reached: Promise<void>; open: () => void } {
  let open = (): void => {};
  let markReached = (): void => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  return {
    hook: async () => { markReached(); await gate; },
    reached,
    open: () => open(),
  };
}

/** Publish as a machine owner that proves its own daemon lock. */
function publishAs(
  home: string,
  port: number,
  owner: HookAuthorityOwner,
  extra: Parameters<typeof publishHookAuthority>[1] = {},
) {
  return publishHookAuthority(port, {
    home,
    owner,
    isTestRuntime: () => false,
    readLockOwner: () => owner,
    probeLiveness: () => alive(owner),
    probeListener: async () => false,
    allowGlobalWriteInTests: true,
    ...extra,
  });
}

const gone: ProcessLiveness = { status: 'reclaimable', reason: 'absent' };
const indeterminate: ProcessLiveness = { status: 'unknown', reason: 'proc-stat-unreadable:EACCES' };

const tempHomes: string[] = [];

/** A sandboxed imcodes state dir. EVERY test that touches the filesystem uses
 *  one; nothing in this file may reach the real `~/.imcodes`. */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'imcodes-hook-authority-'));
  tempHomes.push(home);
  return home;
}

/** Publish into a sandboxed home. `allowGlobalWriteInTests` is required because
 *  the production guard otherwise refuses to publish from a test runner. */
function publishInto(home: string, port: number, extra: Parameters<typeof publishHookAuthority>[1] = {}) {
  return publishHookAuthority(port, { home, allowGlobalWriteInTests: true, ...extra });
}

function portFile(home: string): string {
  return join(home, HOOK_PORT_FILE_NAME);
}
function sidecarFile(home: string): string {
  return join(home, HOOK_AUTHORITY_SIDECAR_FILE_NAME);
}

afterEach(() => {
  while (tempHomes.length) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('hook-port file format compatibility (load-bearing)', () => {
  it('writes hook-port as DIGITS ONLY so already-installed readers keep working', async () => {
    const home = tempHome();
    const result = await publishInto(home, LIVE_PORT, { owner: OWNER, now: () => 12345 });
    expect(result.published).toBe(true);

    const bytes = readFileSync(portFile(home), 'utf8');
    // The installed CLI parses digits and nothing else. A JSON payload here
    // made a healthy daemon unreachable in the field.
    expect(bytes).toBe(`${LIVE_PORT}\n`);
    expect(isLegacyCompatibleHookPortFile(bytes)).toBe(true);
    expect(bytes.trimStart().startsWith('{')).toBe(false);
    // The legacy reader implementation, reproduced exactly:
    expect(Number.parseInt(bytes.trim(), 10)).toBe(LIVE_PORT);
  });

  it('keeps owner identity in the sidecar, which an old reader never opens', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER, now: () => 12345 });
    expect(JSON.parse(readFileSync(sidecarFile(home), 'utf8'))).toEqual({
      version: 1,
      port: LIVE_PORT,
      pid: OWNER.pid,
      startToken: OWNER.startToken,
      publishedAt: 12345,
    });
  });

  it('falls back to legacy when only the bare port exists (pre-upgrade daemon)', () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'legacy', port: STALE_PORT });
    expect(readSavedHookPort(home)).toBe(STALE_PORT);
  });

  it('does NOT downgrade a disagreeing sidecar to legacy', () => {
    // Reachable if a legacy writer rewrote hook-port, or if the publisher died
    // between the two writes. The previous behaviour collapsed this into
    // `legacy`, and `legacy` is accepted on a bare TCP probe - so a torn pair
    // silently traded pid/startToken ownership for connect-only trust.
    const home = tempHome();
    writeFileSync(portFile(home), `${LIVE_PORT}\n`);
    writeFileSync(sidecarFile(home), serializeHookAuthorityRecord(record(STALE_PORT)));
    expect(readHookAuthorityState(home)).toEqual({
      kind: 'portMismatch',
      port: LIVE_PORT,
      record: record(STALE_PORT),
    });
  });

  it('classifies an unparseable sidecar as its own state, not as legacy', () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${LIVE_PORT}\n`);
    writeFileSync(sidecarFile(home), '{ this is not json');
    expect(readHookAuthorityState(home)).toEqual({ kind: 'sidecarUnreadable', port: LIVE_PORT });
  });

  it('treats a missing sidecar FILE as the only genuine legacy case', () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${LIVE_PORT}\n`);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'legacy', port: LIVE_PORT });
  });

  it('still recovers the port from a JSON hook-port left by an intermediate build', () => {
    const home = tempHome();
    writeFileSync(portFile(home), JSON.stringify(record(LIVE_PORT)));
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('rejects torn writes and out-of-range ports instead of trusting a prefix', () => {
    expect(parseHookPortFile('51915abc')).toBeNull();
    expect(parseHookPortFile('')).toBeNull();
    expect(parseHookPortFile('80')).toBeNull();
    expect(parseHookPortFile('70000')).toBeNull();
    expect(parseHookPortFile('{"version":1,"port":"nope"}')).toBeNull();
    expect(parseHookPortFile(String(LIVE_PORT))).toBe(LIVE_PORT);
    expect(isLegacyCompatibleHookPortFile('51915abc')).toBe(false);
  });
});

describe('an UNREADABLE authority file fails closed (never falls through to legacy)', () => {
  // The catch-all `readFileSync` wrapper mapped EVERY read failure to null, so a
  // sidecar that EXISTED but could not be read (EACCES, EMFILE, EIO) was
  // indistinguishable from a genuinely absent pre-upgrade sidecar - and `absent`
  // selects the legacy branch, which authorises a bare port from a TCP-connect
  // probe alone and returns `owner: null`. Malformed BYTES were covered; an
  // unreadable FILE was not, so the fail-open survived.

  const denied = (path: string, target: string): AuthorityFileRead => (
    path === target ? { kind: 'error', code: 'EACCES' } : { kind: 'absent' }
  );

  it('classifies a real chmod-000 sidecar as sidecarUnreadable, not legacy', () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${LIVE_PORT}\n`);
    writeFileSync(sidecarFile(home), serializeHookAuthorityRecord(record(LIVE_PORT)));
    chmodSync(sidecarFile(home), 0o000);
    try {
      let readable = true;
      try {
        readFileSync(sidecarFile(home), 'utf8');
      } catch {
        readable = false;
      }
      // root bypasses the mode, so only THEN may this case be skipped. On any
      // normal machine the denial must be real - otherwise the assertion below
      // would pass vacuously, which is the failure mode this whole task keeps
      // running into.
      const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      expect(readable, 'chmod 000 did not deny the read; assertion would be vacuous').toBe(isRoot);
      if (!readable) {
        expect(readHookAuthorityState(home)).toEqual({ kind: 'sidecarUnreadable', port: LIVE_PORT });
      }
    } finally {
      chmodSync(sidecarFile(home), 0o600);
    }
  });

  it('refuses to authorise an unreadable sidecar even when the port answers, with NO probe', async () => {
    const home = tempHome();
    const probeListener = vi.fn(async () => true);
    const fetchIdentity = vi.fn(async () => identity(LIVE_PORT));
    const resolution = await resolveHookAuthority({
      home,
      // Deterministic EACCES on the sidecar only - independent of chmod
      // semantics, so this holds for root and on any filesystem.
      readFile: (path) => (
        path === sidecarFile(home)
          ? { kind: 'error', code: 'EACCES' }
          : { kind: 'ok', text: `${LIVE_PORT}\n` }
      ),
      probeListener,
      fetchIdentity,
      probeLiveness: () => alive(OWNER),
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.unreadable);
    // The exact fail-open the audit reproduced: no ownerless success, and the
    // connect-only probe must never even be consulted.
    expect(probeListener).not.toHaveBeenCalled();
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it('maps an unreadable hook-port file to unreadable, not absent', async () => {
    const home = tempHome();
    expect(readHookAuthorityState(home, {
      readFile: (path) => denied(path, portFile(home)),
    })).toEqual({ kind: 'invalid' });

    const probeListener = vi.fn(async () => true);
    const resolution = await resolveHookAuthority({
      home,
      readFile: (path) => denied(path, portFile(home)),
      probeListener,
      fetchIdentity: async () => identity(LIVE_PORT),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    // Declared taxonomy: present-but-unusable is NOT "nothing published".
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.unreadable);
    expect(resolution.reason).not.toBe(HOOK_AUTHORITY_ERROR.hookUnavailable);
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('still reports a genuinely missing record as absent -> daemon_hook_unavailable', async () => {
    const home = tempHome();
    // ENOENT is the ONLY thing that may mean "nothing published".
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
    const resolution = await resolveHookAuthority({ home, fetchIdentity: async () => null });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.hookUnavailable);
  });

  it('treats every non-ENOENT errno as present-but-unusable', () => {
    const home = tempHome();
    for (const code of ['EACCES', 'EMFILE', 'EIO', 'EISDIR', 'ELOOP', 'UNKNOWN']) {
      expect(readHookAuthorityState(home, {
        readFile: (path) => (
          path === sidecarFile(home)
            ? { kind: 'error', code }
            : { kind: 'ok', text: `${LIVE_PORT}\n` }
        ),
      }), `errno ${code}`).toEqual({ kind: 'sidecarUnreadable', port: LIVE_PORT });
    }
    // ENOTDIR means a path component is not a directory, i.e. genuinely absent.
    expect(readHookAuthorityState(home, {
      readFile: (path) => (
        path === sidecarFile(home)
          ? { kind: 'absent' }
          : { kind: 'ok', text: `${LIVE_PORT}\n` }
      ),
    })).toEqual({ kind: 'legacy', port: LIVE_PORT });
  });
});

describe('fixture containment: a test process cannot publish the global record', () => {
  const neverWrite = () => {
    throw new Error('a test must never write the global hook authority');
  };

  it('refuses the machine-global record when another live process holds the daemon lock', async () => {
    // PRIMARY fence, and the one that survives a spawn: a test can start the
    // daemon / stdio MCP as a CHILD process, which does NOT inherit VITEST and
    // therefore looks like production. Ownership is a machine property, so the
    // instance lock still names the real daemon and the child is refused.
    const result = await publishHookAuthority(DEFAULT_HOOK_PORT, {
      owner: OWNER,
      isTestRuntime: () => false, // exactly what a spawned child reports
      readLockOwner: () => OTHER_OWNER,
      probeLiveness: () => alive(OTHER_OWNER),
      writeFile: neverWrite,
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(result.heldBy).toEqual(OTHER_OWNER);
  });

  it('refuses the machine-global record from an in-process test runner even with no daemon lock', async () => {
    // Defence in depth: covers a suite that publishes before any instance lock
    // exists on the machine.
    const result = await publishHookAuthority(DEFAULT_HOOK_PORT, {
      owner: OWNER,
      isTestRuntime: () => true,
      readLockOwner: () => null,
      writeFile: neverWrite,
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishSuppressedForTests);
  });

  it('still lets the lock-holding daemon publish its own record', async () => {
    const home = tempHome();
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => OWNER, // the daemon that owns the machine
      allowGlobalWriteInTests: true,
    });
    expect(result.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('does not fence a lock owner that is provably gone', async () => {
    const home = tempHome();
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => OTHER_OWNER,
      probeLiveness: () => gone,
      allowGlobalWriteInTests: true,
    });
    expect(result.published).toBe(true);
  });

  it('allows publishing once the test injected its own home', async () => {
    const home = tempHome();
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => true,
      allowGlobalWriteInTests: true,
    });
    expect(result.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('does not suppress the real daemon, which is not a test runtime', async () => {
    const home = tempHome();
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
    });
    expect(result.published).toBe(true);
  });
});

describe('authenticated lock ownership outranks unauthenticated legacy compat', () => {
  it('lets the proven lock owner replace a stale legacy record whose port is LIVE', async () => {
    // The reported incident, exactly: the record says 51915, something is still
    // listening there, and the authoritative daemon serves 51941. The legacy
    // live-listener fence used to refuse this forever, so the live daemon could
    // never repair the record.
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    const probeListener = vi.fn(async (candidate: number) => candidate === STALE_PORT);

    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => OWNER, // the daemon lock proves WE are the publisher
      probeListener,
      allowGlobalWriteInTests: true,
    });

    expect(result.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(state.record.pid).toBe(OWNER.pid);
    expect(state.record.startToken).toBe(OWNER.startToken);
    // Repair is publication only - ownership is never asserted by port alone.
    expect(readFileSync(portFile(home), 'utf8')).toBe(`${LIVE_PORT}\n`);
  });

  it('still fences a NON-owner in the same live-legacy-listener situation', async () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OTHER_OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => OWNER, // lock belongs to someone else
      probeLiveness: () => alive(OWNER),
      probeListener: async (candidate: number) => candidate === STALE_PORT,
      allowGlobalWriteInTests: true,
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(readSavedHookPort(home)).toBe(STALE_PORT);
  });

  it('lets the proven lock owner repair a torn pair and an unreadable sidecar', async () => {
    for (const seed of ['mismatch', 'unreadable'] as const) {
      const home = tempHome();
      writeFileSync(portFile(home), `${STALE_PORT}\n`);
      writeFileSync(
        sidecarFile(home),
        seed === 'mismatch' ? serializeHookAuthorityRecord(record(LIVE_PORT, OTHER_OWNER)) : 'not json',
      );
      const result = await publishHookAuthority(LIVE_PORT, {
        home,
        owner: OWNER,
        isTestRuntime: () => false,
        readLockOwner: () => OWNER,
        probeLiveness: () => alive(OTHER_OWNER),
        probeListener: async () => true,
        allowGlobalWriteInTests: true,
      });
      expect(result.published, `seed=${seed}`).toBe(true);
      expect(readHookAuthorityState(home).kind).toBe('record');
    }
  });

  it('does not let a publisher WITHOUT the lock repair a torn pair held by a live owner', async () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    writeFileSync(sidecarFile(home), serializeHookAuthorityRecord(record(LIVE_PORT, OTHER_OWNER)));
    const result = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => null, // nothing proves ownership
      probeLiveness: () => alive(OTHER_OWNER),
      probeListener: async () => true,
      allowGlobalWriteInTests: true,
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(result.heldBy).toEqual(OTHER_OWNER);
  });
});

describe('publication is an owner-fenced TRANSACTION, not just atomic writes', () => {
  /** A pre-existing legacy record, distinct from both publishers' target ports
   *  so "nothing changed" and "who won" are separately observable. */
  const PRIOR_PORT = 61777;

  // Atomic renames make each FILE write atomic, but publication spans two files
  // and contains an `await`. The previous "late write from an old owner" test
  // was SEQUENTIAL: the stale writer performed its ownership check only after
  // the successor's record already existed, so it never exercised the
  // check/write interleaving. The real hazard is:
  //   stale authorizes -> stale pauses -> successor publishes -> stale resumes
  // and the resumed stale publisher must be unable to change EITHER file.

  it('refuses a stale publisher that authorized, paused, and resumed after a successor published', async () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${PRIOR_PORT}\n`);

    // The machine's daemon lock starts out naming the STALE publisher, so its
    // authorize snapshot legitimately passes.
    let currentLockOwner: HookAuthorityOwner = OWNER;
    const readLockOwner = (): HookAuthorityOwner => currentLockOwner;

    // Barrier: released only after the successor has fully published.
    let releaseStale = (): void => {};
    const staleSuspended = new Promise<void>((resolve) => { releaseStale = resolve; });
    let staleReachedBarrier = (): void => {};
    const staleAtBarrier = new Promise<void>((resolve) => { staleReachedBarrier = resolve; });

    const stalePublish = publishHookAuthority(STALE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner,
      probeLiveness: () => alive(currentLockOwner),
      probeListener: async () => false,
      allowGlobalWriteInTests: true,
      afterAuthorize: async () => {
        staleReachedBarrier();
        await staleSuspended;
      },
    });

    // The stale publisher is now parked AFTER its ownership check and BEFORE it
    // holds the publication lock.
    await staleAtBarrier;
    expect(readHookAuthorityState(home)).toEqual({ kind: 'legacy', port: PRIOR_PORT });

    // Authority moves to the successor, which publishes to completion.
    currentLockOwner = OTHER_OWNER;
    const successor = await publishHookAuthority(LIVE_PORT, {
      home,
      owner: OTHER_OWNER,
      isTestRuntime: () => false,
      readLockOwner,
      probeLiveness: () => alive(OTHER_OWNER),
      probeListener: async () => false,
      allowGlobalWriteInTests: true,
    });
    expect(successor.published).toBe(true);

    const afterSuccessor = readHookAuthorityState(home);
    expect(afterSuccessor.kind).toBe('record');
    if (afterSuccessor.kind !== 'record') return;
    expect(afterSuccessor.record.port).toBe(LIVE_PORT);
    expect(afterSuccessor.record.pid).toBe(OTHER_OWNER.pid);
    const successorSidecar = readFileSync(sidecarFile(home), 'utf8');
    const successorPortBytes = readFileSync(portFile(home), 'utf8');

    // Now let the stale publisher resume. It must NOT commit.
    releaseStale();
    const staleResult = await stalePublish;
    expect(staleResult.published).toBe(false);
    expect(staleResult.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);

    // NEITHER authoritative file may have changed.
    expect(readFileSync(sidecarFile(home), 'utf8')).toBe(successorSidecar);
    expect(readFileSync(portFile(home), 'utf8')).toBe(successorPortBytes);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('fails closed when the daemon-lock identity changes at all under a paused publisher', async () => {
    // Even a publisher that was the proven owner at snapshot must abort if the
    // exact identity is no longer the same at the commit point.
    const home = tempHome();
    let currentLockOwner: HookAuthorityOwner | null = OWNER;
    let release = (): void => {};
    const suspended = new Promise<void>((resolve) => { release = resolve; });
    let atBarrier = (): void => {};
    const reachedBarrier = new Promise<void>((resolve) => { atBarrier = resolve; });

    const pending = publishHookAuthority(LIVE_PORT, {
      home,
      owner: OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => currentLockOwner,
      probeLiveness: () => alive(OWNER),
      allowGlobalWriteInTests: true,
      afterAuthorize: async () => {
        atBarrier();
        await suspended;
      },
    });

    await reachedBarrier;
    // The lock disappears entirely - authority is no longer provable.
    currentLockOwner = null;
    release();

    const result = await pending;
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    // Nothing was written at all.
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
  });

  it('serializes two concurrent publishers so exactly one record survives intact', async () => {
    const home = tempHome();
    const [first, second] = await Promise.all([
      publishHookAuthority(LIVE_PORT, {
        home, owner: OWNER, isTestRuntime: () => false,
        readLockOwner: () => OWNER, probeLiveness: () => alive(OWNER),
        allowGlobalWriteInTests: true,
      }),
      publishHookAuthority(LIVE_PORT + 1, {
        home, owner: OWNER, isTestRuntime: () => false,
        readLockOwner: () => OWNER, probeLiveness: () => alive(OWNER),
        allowGlobalWriteInTests: true,
      }),
    ]);

    // Same proven owner, so both are authorised; the lock only orders them.
    expect(first.published || second.published).toBe(true);
    // Whatever the order, the pair must agree - never a torn sidecar/port split.
    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(readFileSync(portFile(home), 'utf8')).toBe(`${state.record.port}\n`);
    expect([LIVE_PORT, LIVE_PORT + 1]).toContain(state.record.port);
  });

  it('releases the publication lock after every outcome', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER });
    expect(topEpoch(home)?.released).toBe(true);

    // A fenced refusal happens INSIDE the lock and must release it too.
    const fenced = await publishHookAuthority(STALE_PORT, {
      home,
      owner: OTHER_OWNER,
      isTestRuntime: () => false,
      readLockOwner: () => OWNER,
      probeLiveness: () => alive(OWNER),
      allowGlobalWriteInTests: true,
    });
    expect(fenced.published).toBe(false);
    expect(fenced.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(topEpoch(home)).toMatchObject({ epoch: 2, released: true });
  });
});

describe('publication lock - never taken from a live or indeterminate holder', () => {
  it('refuses while a LIVE holder owns the current epoch, leaving it untouched', async () => {
    const home = tempHome();
    const holder = currentDaemonProcessIdentity();
    const held = seedEpoch(home, 1, holder);

    const result = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      // pid-aware, so the live holder is judged by its own identity
      probeLiveness: (pid) => (pid === holder.pid ? alive(holder) : alive(OTHER_OWNER)),
    });

    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
    expect(topEpoch(home)).toMatchObject({ epoch: 1, pid: holder.pid, nonce: held.nonce, ino: held.ino, released: false });
  });

  it('never takes over a live holder however old its acquisition is', async () => {
    const home = tempHome();
    const holder = currentDaemonProcessIdentity();
    const dir = hookAuthorityLockDirPath(home);
    mkdirSync(dir, { recursive: true });
    const nonce = hexNonce('ancient-but-live');
    writeFileSync(join(dir, `${lockGeneration(home)}.1.lock`), `${JSON.stringify({ ...holder, nonce, acquiredAt: 1 })}\n`);

    const result = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === holder.pid ? alive(holder) : alive(OTHER_OWNER)),
      now: () => Date.now() + 86_400_000, // any age rule would fire
    });

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(topEpoch(home)).toMatchObject({ epoch: 1, nonce, released: false });
  });

  it('never treats a holder with the same {pid,startToken} as its own leftover', async () => {
    // Two publishers inside ONE process share pid and startToken exactly.
    const home = tempHome();
    const self = currentDaemonProcessIdentity();
    const held = seedEpoch(home, 1, self, hexNonce('sibling-acquisition'));

    const result = await publishAs(home, LIVE_PORT, self);

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(topEpoch(home)).toMatchObject({ epoch: 1, nonce: held.nonce, released: false });
  });

  it('never takes over a holder whose liveness is indeterminate', async () => {
    const home = tempHome();
    const held = seedEpoch(home, 1, OTHER_OWNER);

    const result = await publishAs(home, LIVE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? indeterminate : alive(OWNER)),
    });

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(topEpoch(home)).toMatchObject({ epoch: 1, nonce: held.nonce, released: false });
  });

  it('takes over a provably dead holder by claiming the NEXT epoch, never by rewriting', async () => {
    const home = tempHome();
    seedEpoch(home, 1, OTHER_OWNER);

    const result = await publishAs(home, LIVE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? gone : alive(OWNER)),
    });

    expect(result.published).toBe(true);
    expect(topEpoch(home)).toMatchObject({ epoch: 2, pid: OWNER.pid, released: true });
    // History below the held epoch is pruned.
    expect(existsSync(join(hookAuthorityLockDirPath(home), `${lockGeneration(home)}.1.lock`))).toBe(false);
  });

  it('fails closed on epoch content that names no acquisition', async () => {
    const home = tempHome();
    const dir = hookAuthorityLockDirPath(home);
    const name = `${lockGeneration(home)}.1.lock`;
    writeFileSync(join(dir, name), '{ torn');

    const result = await publishAs(home, LIVE_PORT, OWNER);

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(readdirSync(dir).sort()).toEqual(['generation', name].sort());
    expect(readFileSync(join(dir, name), 'utf8')).toBe('{ torn');
  });

  it('fails closed on a corrupt generation token and leaves it alone', async () => {
    const home = tempHome();
    const dir = hookAuthorityLockDirPath(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generation'), 'not-a-token\n');

    const result = await publishAs(home, LIVE_PORT, OWNER);

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(readdirSync(dir)).toEqual(['generation']);
    expect(readFileSync(join(dir, 'generation'), 'utf8')).toBe('not-a-token\n');
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
  });

  it('keeps the lock directory bounded and leaks no claim temps', async () => {
    const home = tempHome();
    for (let index = 0; index < 5; index += 1) {
      expect((await publishAs(home, LIVE_PORT, OWNER)).published).toBe(true);
    }
    const top = topEpoch(home);
    expect(top).toMatchObject({ epoch: 5, released: true });
    expect(readdirSync(hookAuthorityLockDirPath(home)).sort())
      .toEqual([
        'generation',
        `${top!.generation}.5.lock`,
        `${top!.generation}.5.${top!.nonce}.released`,
        // the held epoch's own capability; every lower one was revoked
        `${top!.generation}.5.${top!.nonce}.d`,
      ].sort());
  });
});

describe('legacy single-file lock - respected, never modified', () => {
  const LEGACY_LOCK = (owner: HookAuthorityOwner, acquiredAt = Date.now()): string =>
    `${JSON.stringify({ pid: owner.pid, startToken: owner.startToken, acquiredAt })}\n`;

  it('a LIVE nonce-less legacy holder is never taken over, however long it waits', async () => {
    // Replaces the R7 test that blessed "unchanged for the whole wait => reclaim".
    // A nonce-less record still names a real process; waiting is not evidence
    // that it is gone.
    const home = tempHome();
    const holder = currentDaemonProcessIdentity();
    const bytes = LEGACY_LOCK(holder, 1);
    const seeded = seedLegacyLock(home, bytes);

    const started = Date.now();
    const result = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === holder.pid ? alive(holder) : alive(OTHER_OWNER)),
      now: () => Date.now() + 86_400_000,
    });

    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    // It waited the whole bounded window rather than giving up on sight...
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      (HOOK_PUBLISH_LOCK.maxAttempts - 1) * HOOK_PUBLISH_LOCK.retryDelayMs,
    );
    // ...and then left everything exactly as it was.
    expect(readFileSync(hookAuthorityLockPath(home), 'utf8')).toBe(bytes);
    expect(statSync(hookAuthorityLockPath(home), { bigint: true }).ino).toBe(seeded.ino);
    expect(topEpoch(home)).toBeNull();
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
  });

  it('an indeterminate legacy holder is never taken over', async () => {
    const home = tempHome();
    const bytes = LEGACY_LOCK(OTHER_OWNER);
    seedLegacyLock(home, bytes);

    const result = await publishAs(home, LIVE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? indeterminate : alive(OWNER)),
    });

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(readFileSync(hookAuthorityLockPath(home), 'utf8')).toBe(bytes);
    expect(topEpoch(home)).toBeNull();
  });

  it('a provably dead legacy holder no longer blocks, and its file is still not touched', async () => {
    const home = tempHome();
    const bytes = LEGACY_LOCK(OTHER_OWNER);
    const seeded = seedLegacyLock(home, bytes);

    const result = await publishAs(home, LIVE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? gone : alive(OWNER)),
    });

    expect(result.published).toBe(true);
    expect(readFileSync(hookAuthorityLockPath(home), 'utf8')).toBe(bytes);
    expect(statSync(hookAuthorityLockPath(home), { bigint: true }).ino).toBe(seeded.ino);
  });

  it('unparseable legacy lock bytes fail closed and are left alone', async () => {
    const home = tempHome();
    seedLegacyLock(home, '{"pid": 777, "startTo');

    const result = await publishAs(home, LIVE_PORT, OWNER);

    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(readFileSync(hookAuthorityLockPath(home), 'utf8')).toBe('{"pid": 777, "startTo');
    expect(topEpoch(home)).toBeNull();
  });

  it('a live legacy holder that appears mid-transaction voids the commit', async () => {
    const home = tempHome();
    const legacyWriter = currentDaemonProcessIdentity();
    const pause = barrier();
    const pending = publishAs(home, LIVE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === legacyWriter.pid ? alive(legacyWriter) : alive(OWNER)),
      beforeCommit: pause.hook,
    });
    await pause.reached;
    seedLegacyLock(home, LEGACY_LOCK(legacyWriter));
    pause.open();

    const result = await pending;
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
  });
});

describe('publication lock - ownership-safe interleavings', () => {
  // A stale actor is suspended exactly in the gap between its final validation
  // and its action, for claim, commit and release. In every case it must change
  // neither authority file nor the successor's lock entry (nonce and inode).

  it('a holder suspended after its owner CAS cannot commit once a successor takes over', async () => {
    const home = tempHome();
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { beforeCommit: pauseA.hook });
    await pauseA.reached;
    const aNonce = topEpoch(home)!.nonce;

    const b = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === OWNER.pid ? gone : alive(OTHER_OWNER)),
    });
    expect(b.published).toBe(true);
    const bTop = topEpoch(home)!;
    expect(bTop.nonce).not.toBe(aNonce);
    const sidecarAfterB = readFileSync(sidecarFile(home), 'utf8');
    const portAfterB = readFileSync(portFile(home), 'utf8');

    pauseA.open();
    const aResult = await aPublish;
    expect(aResult.published).toBe(false);
    expect(aResult.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    expect(readFileSync(sidecarFile(home), 'utf8')).toBe(sidecarAfterB);
    expect(readFileSync(portFile(home), 'utf8')).toBe(portAfterB);
    expect(topEpoch(home)).toEqual(bTop);
  });

  it('re-validates the ACQUISITION nonce, not the entry object, at the commit point', async () => {
    const home = tempHome();
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { beforeCommit: pauseA.hook });
    await pauseA.reached;

    const top = topEpoch(home)!;
    const path = join(hookAuthorityLockDirPath(home), `${top.generation}.${top.epoch}.lock`);
    // Truncating in-place write: same object, different acquisition.
    writeFileSync(path, `${JSON.stringify({ ...OTHER_OWNER, nonce: hexNonce('other'), acquiredAt: Date.now() })}\n`);
    expect(statSync(path, { bigint: true }).ino).toBe(top.ino);

    pauseA.open();
    expect((await aPublish).reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
  });

  it('CLAIM gap: a reclaimer suspended after final validation cannot displace a successor', async () => {
    const home = tempHome();
    seedEpoch(home, 1, OTHER_OWNER); // dead holder
    const successor: HookAuthorityOwner = { pid: 31337, startToken: 'ps:Fri Feb  2 02:02:02 2026' };
    const probe = (pid: number): ProcessLiveness => {
      if (pid === OTHER_OWNER.pid) return gone;
      if (pid === successor.pid) return alive(successor);
      return alive(OWNER);
    };

    // R validates "epoch 1 is dead, claim epoch 2" and is suspended right there.
    const pauseR = barrier();
    let rClaimTarget = 0;
    const rPublish = publishAs(home, STALE_PORT, OWNER, {
      probeLiveness: probe,
      beforeClaim: async ({ epoch }) => {
        if (rClaimTarget !== 0) return; // suspend only on the first validation
        rClaimTarget = epoch;
        await pauseR.hook();
      },
    });
    await pauseR.reached;
    expect(rClaimTarget).toBe(2);

    // The successor installs itself in that gap and HOLDS the lock.
    const pauseB = barrier();
    const bPublish = publishAs(home, LIVE_PORT, successor, { probeLiveness: probe, beforeCommit: pauseB.hook });
    await pauseB.reached;
    const bTop = topEpoch(home)!;
    expect(bTop).toMatchObject({ epoch: 2, pid: successor.pid, released: false });

    // R resumes: its claim of epoch 2 must fail, and B is live, so it waits out.
    pauseR.open();
    const rResult = await rPublish;
    expect(rResult.published).toBe(false);
    expect(rResult.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
    expect(topEpoch(home)).toEqual(bTop);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });

    pauseB.open();
    expect((await bPublish).published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it("RELEASE gap: a stale holder's release cannot release or remove a successor's entry", async () => {
    const home = tempHome();
    const third: HookAuthorityOwner = { pid: 4040, startToken: 'ps:Sat Mar  3 03:03:03 2026' };

    // A commits, then is suspended immediately before releasing.
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { beforeRelease: pauseA.hook });
    await pauseA.reached;

    // A is declared dead; B takes over (epoch 2) and holds.
    const pauseB = barrier();
    const bPublish = publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === OWNER.pid ? gone : alive(OTHER_OWNER)),
      beforeCommit: pauseB.hook,
    });
    await pauseB.reached;
    const bTop = topEpoch(home)!;
    expect(bTop).toMatchObject({ epoch: 2, pid: OTHER_OWNER.pid, released: false });

    // A resumes and releases.
    pauseA.open();
    expect((await aPublish).published).toBe(true);
    expect(topEpoch(home)).toEqual(bTop); // same epoch, nonce, inode; NOT released

    // The lock is still genuinely B's: a third publisher is excluded.
    const c = await publishAs(home, LIVE_PORT + 1, third, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? alive(OTHER_OWNER) : alive(third)),
    });
    expect(c.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);

    pauseB.open();
    expect((await bPublish).published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('PRUNE gap: a high-epoch claimer resumed after a directory reset cannot prune the new generation', async () => {
    // The R8 counterexample, exactly: A claims a high epoch and is suspended
    // after the claim and before pruning; the directory is deleted and
    // recreated; B claims epoch 1 of the NEW instance and holds it; A resumes.
    const home = tempHome();
    const successor: HookAuthorityOwner = { pid: 31337, startToken: 'ps:Fri Feb  2 02:02:02 2026' };
    const third: HookAuthorityOwner = { pid: 4040, startToken: 'ps:Sat Mar  3 03:03:03 2026' };
    seedEpoch(home, 99, OTHER_OWNER); // dead holder, so A's claim is epoch 100
    const probe = (pid: number): ProcessLiveness => {
      if (pid === OTHER_OWNER.pid) return gone;
      if (pid === successor.pid) return alive(successor);
      if (pid === third.pid) return alive(third);
      return alive(OWNER);
    };

    const pauseA = barrier();
    let aClaimed = 0;
    const aPublish = publishAs(home, STALE_PORT, OWNER, {
      probeLiveness: probe,
      afterClaim: async ({ epoch }) => {
        aClaimed = epoch;
        await pauseA.hook();
      },
    });
    await pauseA.reached;
    expect(aClaimed).toBe(100);
    const oldGeneration = topEpoch(home)!.generation;

    rmSync(hookAuthorityLockDirPath(home), { recursive: true, force: true });

    const pauseB = barrier();
    const bPublish = publishAs(home, LIVE_PORT, successor, { probeLiveness: probe, beforeCommit: pauseB.hook });
    await pauseB.reached;
    const bTop = topEpoch(home)!;
    expect(bTop).toMatchObject({ epoch: 1, pid: successor.pid, released: false });
    expect(bTop.generation).not.toBe(oldGeneration);

    // A resumes: prunes, then reaches its commit.
    pauseA.open();
    const aResult = await aPublish;
    expect(aResult.published).toBe(false);
    expect(aResult.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);

    // B's exact entry survived: same generation, epoch, nonce and inode.
    expect(topEpoch(home)).toEqual(bTop);
    expect(existsSync(join(hookAuthorityLockDirPath(home), `${bTop.generation}.1.lock`))).toBe(true);
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });

    // B still excludes everyone else...
    const c = await publishAs(home, LIVE_PORT + 1, third, { probeLiveness: probe });
    expect(c.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);

    // ...and only B commits.
    pauseB.open();
    expect((await bPublish).published).toBe(true);
    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(state.record).toMatchObject({ port: LIVE_PORT, pid: successor.pid });
  });

  it('CLAIM across a reset: a late old-generation claim is invisible to the new generation', async () => {
    // A validated against the old instance (dead holder at 99, so it will claim
    // 100) and is suspended before claiming. The directory is reset, B claims
    // and holds epoch 1 of the new instance, then A's claim lands in the new
    // directory under its OLD generation token. That entry must not count as a
    // lock of the new namespace.
    const home = tempHome();
    const successor: HookAuthorityOwner = { pid: 31337, startToken: 'ps:Fri Feb  2 02:02:02 2026' };
    const third: HookAuthorityOwner = { pid: 4040, startToken: 'ps:Sat Mar  3 03:03:03 2026' };
    seedEpoch(home, 99, OTHER_OWNER);
    const probe = (pid: number): ProcessLiveness => {
      if (pid === OTHER_OWNER.pid) return gone;
      if (pid === successor.pid) return alive(successor);
      if (pid === third.pid) return alive(third);
      return alive(OWNER);
    };

    const pauseA = barrier();
    let suspended = false;
    const aPublish = publishAs(home, STALE_PORT, OWNER, {
      probeLiveness: probe,
      beforeClaim: async () => {
        if (suspended) return;
        suspended = true;
        await pauseA.hook();
      },
    });
    await pauseA.reached;

    rmSync(hookAuthorityLockDirPath(home), { recursive: true, force: true });
    const pauseB = barrier();
    const bPublish = publishAs(home, LIVE_PORT, successor, { probeLiveness: probe, beforeCommit: pauseB.hook });
    await pauseB.reached;
    const bTop = topEpoch(home)!;

    pauseA.open();
    expect((await aPublish).reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    // A's late claim exists on disk under the old token...
    expect(readdirSync(hookAuthorityLockDirPath(home)).some((name) => name.endsWith('.100.lock'))).toBe(true);
    // ...but the current generation's lock is still exactly B's.
    expect(topEpoch(home)).toEqual(bTop);

    const c = await publishAs(home, LIVE_PORT + 1, third, { probeLiveness: probe });
    expect(c.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);

    pauseB.open();
    expect((await bPublish).published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('a lock directory removed during a claim is re-created and the claim retried', async () => {
    const home = tempHome();
    let removed = false;
    const result = await publishAs(home, LIVE_PORT, OWNER, {
      beforeClaim: async () => {
        if (removed) return;
        removed = true;
        rmSync(hookAuthorityLockDirPath(home), { recursive: true, force: true });
      },
    });
    expect(removed).toBe(true);
    expect(result.published).toBe(true);
    expect(topEpoch(home)).toMatchObject({ epoch: 1, pid: OWNER.pid, released: true });
  });

  // ── proof -> write gap ────────────────────────────────────────────────────
  // A publisher that has PASSED its final commit proof is suspended before its
  // first authority write. Authority then moves on. On resume it must change
  // neither authority file: its publish capability was revoked, so the write
  // itself fails.

  it('PROOF->WRITE across a directory reset: G1 proof, reset, G2 claim+commit, A changes neither file', async () => {
    const home = tempHome();
    const successor: HookAuthorityOwner = { pid: 31337, startToken: 'ps:Fri Feb  2 02:02:02 2026' };

    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { afterProof: pauseA.hook });
    await pauseA.reached;
    const g1 = topEpoch(home)!.generation;
    expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });

    rmSync(hookAuthorityLockDirPath(home), { recursive: true, force: true });

    const b = await publishAs(home, LIVE_PORT, successor);
    expect(b.published).toBe(true);
    expect(topEpoch(home)!.generation).not.toBe(g1);
    const sidecarAfterB = readFileSync(sidecarFile(home), 'utf8');
    const portAfterB = readFileSync(portFile(home), 'utf8');
    const sidecarIno = statSync(sidecarFile(home), { bigint: true }).ino;
    const portIno = statSync(portFile(home), { bigint: true }).ino;

    pauseA.open();
    const aResult = await aPublish;
    expect(aResult.published).toBe(false);
    expect(aResult.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);

    expect(readFileSync(sidecarFile(home), 'utf8')).toBe(sidecarAfterB);
    expect(readFileSync(portFile(home), 'utf8')).toBe(portAfterB);
    expect(statSync(sidecarFile(home), { bigint: true }).ino).toBe(sidecarIno);
    expect(statSync(portFile(home), { bigint: true }).ino).toBe(portIno);
    const state = readHookAuthorityState(home);
    expect(state.kind === 'record' && state.record.pid).toBe(successor.pid);
  });

  it('PROOF->WRITE within one generation: a successor that took over revokes the stale capability', async () => {
    const home = tempHome();
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { afterProof: pauseA.hook });
    await pauseA.reached;
    const aTop = topEpoch(home)!;

    const b = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === OWNER.pid ? gone : alive(OTHER_OWNER)),
    });
    expect(b.published).toBe(true);
    expect(topEpoch(home)!.generation).toBe(aTop.generation); // no reset involved
    // A's capability is gone.
    expect(existsSync(join(hookAuthorityLockDirPath(home), `${aTop.generation}.${aTop.epoch}.${aTop.nonce}.d`))).toBe(false);
    const sidecarAfterB = readFileSync(sidecarFile(home), 'utf8');
    const portAfterB = readFileSync(portFile(home), 'utf8');

    pauseA.open();
    expect((await aPublish).reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    expect(readFileSync(sidecarFile(home), 'utf8')).toBe(sidecarAfterB);
    expect(readFileSync(portFile(home), 'utf8')).toBe(portAfterB);
  });

  it('BETWEEN WRITES: a takeover after the first write leaves a consistent successor pair, never a torn cross-owner one', async () => {
    const home = tempHome();
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { betweenWrites: pauseA.hook });
    await pauseA.reached;
    // A has replaced the sidecar but not the port.
    const mid = readHookAuthorityState(home);
    expect(mid.kind).not.toBe('record'); // torn/partial state is never a usable record

    const b = await publishAs(home, LIVE_PORT, OTHER_OWNER, {
      probeLiveness: (pid) => (pid === OWNER.pid ? gone : alive(OTHER_OWNER)),
    });
    expect(b.published).toBe(true);

    pauseA.open();
    expect((await aPublish).reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);

    const state = readHookAuthorityState(home);
    expect(state.kind).toBe('record');
    if (state.kind !== 'record') return;
    expect(state.record).toMatchObject({ port: LIVE_PORT, pid: OTHER_OWNER.pid });
    expect(readFileSync(portFile(home), 'utf8')).toBe(`${LIVE_PORT}\n`);
  });

  it('BETWEEN WRITES with the successor not yet committed: the torn pair resolves fail-closed, never to the stale port', async () => {
    const home = tempHome();
    await publishAs(home, LIVE_PORT, OTHER_OWNER); // an earlier, complete record
    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? gone : alive(OWNER)),
      betweenWrites: pauseA.hook,
    });
    await pauseA.reached;

    const pauseB = barrier();
    const successor: HookAuthorityOwner = { pid: 31337, startToken: 'ps:Fri Feb  2 02:02:02 2026' };
    const bPublish = publishAs(home, LIVE_PORT + 1, successor, {
      probeLiveness: (pid) => (pid === OWNER.pid ? gone : alive(successor)),
      beforeCommit: pauseB.hook,
    });
    await pauseB.reached;

    // Mid-flight: sidecar says STALE_PORT, port file still says LIVE_PORT.
    const probed: number[] = [];
    const resolution = await resolveHookAuthority({
      home,
      probeListener: async (candidate) => { probed.push(candidate); return true; },
      fetchIdentity: async () => null,
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    expect(probed).toEqual([]);

    pauseA.open();
    expect((await aPublish).reason).toBe(HOOK_AUTHORITY_ERROR.publishLockLost);
    pauseB.open();
    expect((await bPublish).published).toBe(true);
    const state = readHookAuthorityState(home);
    expect(state.kind === 'record' && state.record.port).toBe(LIVE_PORT + 1);
    expect(readFileSync(portFile(home), 'utf8')).toBe(`${LIVE_PORT + 1}\n`);
  });

  it('fails closed when a predecessor capability cannot be revoked', async () => {
    const home = tempHome();
    // A dead predecessor whose capability contains something we cannot remove.
    const held = seedEpoch(home, 1, OTHER_OWNER);
    const generation = lockGeneration(home);
    const capability = join(hookAuthorityLockDirPath(home), `${generation}.1.${held.nonce}.d`);
    const locked = join(capability, 'locked');
    mkdirSync(join(locked, 'inner'), { recursive: true });
    writeFileSync(join(locked, 'inner', 'f'), 'x');
    chmodSync(locked, 0o500);
    try {
      const result = await publishAs(home, LIVE_PORT, OWNER, {
        probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? gone : alive(OWNER)),
      });
      expect(result.published).toBe(false);
      expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);
      expect(readHookAuthorityState(home)).toEqual({ kind: 'absent' });
      expect(existsSync(capability)).toBe(true);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('RELEASE after epoch reuse: a stale release names only its own acquisition', async () => {
    // If the lock directory is wiped externally, epoch numbers restart. A stale
    // holder of the old epoch 1 must not release the NEW holder of epoch 1.
    const home = tempHome();
    const third: HookAuthorityOwner = { pid: 4040, startToken: 'ps:Sat Mar  3 03:03:03 2026' };

    const pauseA = barrier();
    const aPublish = publishAs(home, STALE_PORT, OWNER, { beforeRelease: pauseA.hook });
    await pauseA.reached;
    expect(topEpoch(home)?.epoch).toBe(1);

    rmSync(hookAuthorityLockDirPath(home), { recursive: true, force: true });

    const pauseB = barrier();
    const bPublish = publishAs(home, LIVE_PORT, OTHER_OWNER, { beforeCommit: pauseB.hook });
    await pauseB.reached;
    const bTop = topEpoch(home)!;
    expect(bTop).toMatchObject({ epoch: 1, pid: OTHER_OWNER.pid, released: false });

    pauseA.open();
    await aPublish;
    expect(topEpoch(home)).toEqual(bTop);

    const c = await publishAs(home, LIVE_PORT + 1, third, {
      probeLiveness: (pid) => (pid === OTHER_OWNER.pid ? alive(OTHER_OWNER) : alive(third)),
    });
    expect(c.reason).toBe(HOOK_AUTHORITY_ERROR.publishLockUnavailable);

    pauseB.open();
    expect((await bPublish).published).toBe(true);
  });
});

describe('publishHookAuthority - atomic and fenced', () => {
  it('REFUSES to overwrite a record held by a different live owner', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER });

    // A secondary/older daemon that bound its own port used to clobber this.
    const result = await publishInto(home, STALE_PORT, {
      owner: OTHER_OWNER,
      probeLiveness: () => alive(OWNER),
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(result.heldBy).toEqual(OWNER);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT); // untouched
  });

  it('refuses when the incumbent owner liveness is indeterminate (fails closed)', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER });
    const result = await publishInto(home, STALE_PORT, {
      owner: OTHER_OWNER,
      probeLiveness: () => indeterminate,
    });
    expect(result.published).toBe(false);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('takes over when the incumbent owner is provably gone', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER });
    const result = await publishInto(home, STALE_PORT, {
      owner: OTHER_OWNER,
      probeLiveness: () => gone,
    });
    expect(result.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(STALE_PORT);
  });

  it('lets the SAME owner republish (the rebind path) without fencing itself out', async () => {
    const home = tempHome();
    await publishInto(home, STALE_PORT, { owner: OWNER });
    const result = await publishInto(home, LIVE_PORT, {
      owner: OWNER,
      probeLiveness: () => alive(OWNER),
    });
    expect(result.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('refuses to steal a LEGACY record whose port still has a live listener', async () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    const result = await publishInto(home, LIVE_PORT, {
      owner: OWNER,
      probeListener: async (port) => port === STALE_PORT,
    });
    expect(result.published).toBe(false);
    expect(result.reason).toBe(HOOK_AUTHORITY_ERROR.publishFenced);
    expect(readSavedHookPort(home)).toBe(STALE_PORT);
  });

  it('survives a late write from an old owner: the fence, not write order, decides', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER, probeListener: async () => false });
    // An old/duplicate daemon wakes up afterwards and tries to publish its port.
    const late = await publishInto(home, STALE_PORT, {
      owner: OTHER_OWNER,
      probeLiveness: (pid) => (pid === OWNER.pid ? alive(OWNER) : gone),
    });
    expect(late.published).toBe(false);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
  });

  it('leaves no temp file behind and reports write failures instead of throwing silently', async () => {
    const home = tempHome();
    await publishInto(home, LIVE_PORT, { owner: OWNER });
    expect(existsSync(`${portFile(home)}.${process.pid}.tmp`)).toBe(false);
    expect(existsSync(`${sidecarFile(home)}.${process.pid}.tmp`)).toBe(false);

    const readOnly = join(home, 'nested');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      await expect(publishInto(readOnly, LIVE_PORT, { owner: OWNER })).rejects.toThrow();
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

describe('resolveHookAuthority - owner-verified, scan-free', () => {
  it('accepts the recorded port when the owner identity matches', async () => {
    const fetchIdentity = vi.fn(async () => identity(LIVE_PORT));
    const probeListener = vi.fn(async () => true);
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(LIVE_PORT) }),
      fetchIdentity,
      probeListener,
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution).toEqual({ ok: true, port: LIVE_PORT, owner: OWNER });
    expect(fetchIdentity).toHaveBeenCalledExactlyOnceWith(LIVE_PORT);
    // Owner verification replaces connect-only trust.
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('reports stale_hook_authority when a DIFFERENT process answers the recorded port', async () => {
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(LIVE_PORT, OWNER) }),
      fetchIdentity: async () => identity(LIVE_PORT, OTHER_OWNER),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
    expect(resolution.detail).toContain('owned by pid 777');
  });

  it('reports stale_hook_authority when the recorded owner is provably gone', async () => {
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(STALE_PORT) }),
      fetchIdentity: async () => null,
      probeLiveness: () => gone,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
  });

  it('reports daemon_hook_unavailable (NOT stale) when the owner may still be alive', async () => {
    // Fail closed: an unreadable /proc must never invalidate a live record.
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(LIVE_PORT) }),
      fetchIdentity: async () => null,
      probeLiveness: () => indeterminate,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.hookUnavailable);
  });

  it('rejects an owner that reports a port different from its record', async () => {
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(STALE_PORT) }),
      fetchIdentity: async () => identity(LIVE_PORT),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
  });

  it('NEVER scans other ports when the recorded endpoint fails', async () => {
    const probedIdentity: number[] = [];
    const probedTcp: number[] = [];
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(STALE_PORT) }),
      fetchIdentity: async (port) => {
        probedIdentity.push(port);
        return null;
      },
      probeListener: async (port) => {
        probedTcp.push(port);
        return port === LIVE_PORT;
      },
      probeLiveness: () => gone,
    });
    expect(resolution.ok).toBe(false);
    expect(probedIdentity).toEqual([STALE_PORT]); // exactly the recorded endpoint
    expect(probedTcp).toEqual([]);
  });

  it('distinguishes absent, malformed, and legacy records', async () => {
    const home = tempHome();
    const absent = await resolveHookAuthority({ home, fetchIdentity: async () => null });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe(HOOK_AUTHORITY_ERROR.hookUnavailable);

    writeFileSync(portFile(home), 'not-a-port-or-json');
    const corrupt = await resolveHookAuthority({ home, fetchIdentity: async () => null });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toBe(HOOK_AUTHORITY_ERROR.unreadable);
  });

  it('accepts a legacy bare-port record only on its own port', async () => {
    const accepted = await resolveHookAuthority({
      readState: () => ({ kind: 'legacy', port: STALE_PORT }),
      probeListener: async (port) => port === STALE_PORT,
      fetchIdentity: async () => null,
    });
    expect(accepted).toEqual({ ok: true, port: STALE_PORT, owner: null });

    // A dead legacy record must NOT migrate to the live port.
    const rejected = await resolveHookAuthority({
      readState: () => ({ kind: 'legacy', port: STALE_PORT }),
      probeListener: async (port) => port === LIVE_PORT,
      fetchIdentity: async () => null,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
  });

  it('fails closed on a port mismatch EVEN WHEN a listener answers', async () => {
    // The regression in full: a listener answering the bare port is exactly the
    // signal the legacy path trusts, so this is the case that used to be
    // silently accepted without any owner verification.
    const probeListener = vi.fn(async () => true);
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'portMismatch', port: LIVE_PORT, record: record(STALE_PORT) }),
      probeListener,
      fetchIdentity: async () => identity(LIVE_PORT),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
    expect(resolution.detail).toContain(String(STALE_PORT));
    // It must not even consult the connect-only probe.
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable sidecar EVEN WHEN a listener answers', async () => {
    const probeListener = vi.fn(async () => true);
    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'sidecarUnreadable', port: LIVE_PORT }),
      probeListener,
      fetchIdentity: async () => identity(LIVE_PORT),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.unreadable);
    expect(probeListener).not.toHaveBeenCalled();
  });

  it('fails closed end to end on a real torn pair on disk', async () => {
    const home = tempHome();
    // Publisher wrote the sidecar and died before updating the bare port.
    writeFileSync(sidecarFile(home), serializeHookAuthorityRecord(record(LIVE_PORT)));
    writeFileSync(portFile(home), `${STALE_PORT}\n`);
    const resolution = await resolveHookAuthority({
      home,
      probeListener: async () => true, // something IS listening on the stale port
      fetchIdentity: async () => identity(STALE_PORT),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
  });

  it('resolveLiveHookPort keeps the port-only contract for existing callers', async () => {
    await expect(resolveLiveHookPort({
      readState: () => ({ kind: 'record', record: record(LIVE_PORT) }),
      fetchIdentity: async () => identity(LIVE_PORT),
      probeLiveness: () => alive(OWNER),
    })).resolves.toBe(LIVE_PORT);

    await expect(resolveLiveHookPort({
      readState: () => ({ kind: 'record', record: record(LIVE_PORT) }),
      fetchIdentity: async () => null,
      probeLiveness: () => gone,
    })).resolves.toBeNull();
  });
});

describe('the exact field scenario: live 51941 vs stale record 51915', () => {
  it('is attributed as stale_hook_authority instead of failing outside a fixed scan window', async () => {
    // The old reader swept DEFAULT_HOOK_PORT..+20 plus saved-19..saved, i.e.
    // 51896..51932 for a saved value of 51915 — proving 51941 was unreachable.
    const oldWindow = new Set<number>();
    for (let p = DEFAULT_HOOK_PORT; p < DEFAULT_HOOK_PORT + HOOK_BIND_RETRY_SPAN; p += 1) oldWindow.add(p);
    for (let p = STALE_PORT - HOOK_BIND_RETRY_SPAN + 1; p <= STALE_PORT; p += 1) oldWindow.add(p);
    expect(oldWindow.has(LIVE_PORT)).toBe(false);

    const resolution = await resolveHookAuthority({
      readState: () => ({ kind: 'record', record: record(STALE_PORT, OTHER_OWNER) }),
      fetchIdentity: async () => null,
      probeLiveness: () => gone,
      probeListener: async () => false,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(HOOK_AUTHORITY_ERROR.staleHookAuthority);
    // The whole point: this is NOT a memory-worker failure.
    expect(resolution.reason).not.toBe('daemon_memory_worker_unavailable');
  });

  it('lets the live owner republish the correct port, which then resolves', async () => {
    const home = tempHome();
    writeFileSync(portFile(home), `${STALE_PORT}\n`); // stale legacy bytes, as found in the field

    const published = await publishInto(home, LIVE_PORT, {
      owner: OWNER,
      probeListener: async () => false, // nothing listening on the stale port
    });
    expect(published.published).toBe(true);
    expect(readSavedHookPort(home)).toBe(LIVE_PORT);
    expect(readFileSync(portFile(home), 'utf8')).toBe(`${LIVE_PORT}\n`);

    const resolution = await resolveHookAuthority({
      home,
      fetchIdentity: async (port) => (port === LIVE_PORT ? identity(LIVE_PORT) : null),
      probeLiveness: () => alive(OWNER),
    });
    expect(resolution).toEqual({ ok: true, port: LIVE_PORT, owner: OWNER });
  });
});
