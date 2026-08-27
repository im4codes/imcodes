import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  grantAckAccepted,
  MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME,
} from '../../src/node/macos-virtual-display-authority-host.js';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * The production chain, asserted end to end.
 *
 * Every one of these was absent while the whole display path type-checked: the
 * listener was never started, the grant was never built or sent, the lease was
 * never held, and the IPC server -- which already supported injection -- was
 * never injected into. The result answered `agent_unavailable` to every
 * request, which reads exactly like a machine with no display support.
 */
describe('macOS virtual-display production composition', () => {
  const host = read('src/node/macos-virtual-display-authority-host.ts');
  const workerHost = read('src/node/macos-remote-desktop-worker-host.ts');
  const ipcServer = read('src/node/macos-remote-desktop-ipc-server.ts');

  it('starts the root authority listener', () => {
    // The CALL, not the import. Asserting the identifier alone passed even
    // when the call was deleted, because the import line still mentioned it.
    expect(host).toContain('await startMacosVirtualDisplayAuthorityListener(');
    expect(host).toContain('onLeaseEnded');
  });

  it('builds and sends the grant from the same verified artifact', () => {
    expect(host).toContain('buildMacosVirtualDisplayAuthority');
    expect(host).toContain('serializeMacosVirtualDisplayAuthority');
    // Sent on the lease, not merely constructed.
    expect(host).toMatch(/entry\.socket\.write\(`\$\{wire\}\\n`\)/u);
    // The artifact is the one handed in, never re-derived from disk.
    expect(host).toContain('options.artifact');
    expect(host).not.toMatch(/readFileSync|statSync/u);
  });

  it('holds exactly one lease and never lets a second replace it', () => {
    // The incumbent holds the supervised helper; a newcomer replacing it would
    // strand that helper under an authority nobody is tracking.
    expect(host).toMatch(/if \(live !== null\) \{ lease\.socket\.destroy\(\); return; \}/u);
  });

  it('serializes every exchange onto the single lease', () => {
    // A promise chain, not a boolean: two callers checking a flag in one tick
    // both see it clear, and the second answer then settles the first request.
    expect(host).toContain('tail.then(run, run)');
    expect(host).toContain('if (entry.waiter) return null;');
    // An answer nobody asked for means correlation has slipped.
    expect(host).toMatch(/if \(!waiter\) \{[\s\S]{0,200}endLease\('unsolicited'\)/u);
  });

  it('injects the real lease and seams into the stock IPC server', () => {
    expect(ipcServer).toContain('virtualDisplayLease');
    expect(ipcServer).toContain('virtualDisplaySeams');
    // ...and the host actually supplies them, which is what was missing.
    expect(workerHost).toContain('virtualDisplayLease:');
    expect(workerHost).toContain('virtualDisplaySeams:');
    expect(workerHost).toContain('startVirtualDisplayAuthority');
  });

  it('revokes the channel by CALLING it when authority is lost', () => {
    // Not merely by letting a getter start returning null: requests already
    // dispatched must be failed, not left waiting on a principal that is gone.
    expect(workerHost).toContain('revokeVirtualDisplayChannel');
    expect(workerHost).toMatch(
      /onAuthorityLost:[\s\S]{0,400}revokeVirtualDisplayChannel/u,
    );
    expect(host).toContain('options.onAuthorityLost()');
    // Lease end, overflow and an unsolicited frame all route through one place.
    expect(host).toMatch(/onLeaseEnded: \(\) => endLease\('ended'\)/u);
  });

  it('closes the authority with the generation that established it', () => {
    expect(workerHost).toMatch(/displayAuthority\.close\(\)/u);
  });
});

/**
 * Two-phase readiness.
 *
 * The standalone CLI probe runs before any resident agent exists, so it cannot
 * answer display control and must not pretend to. Answering it truthfully
 * requires the agent's lease, which only exists after the listener is up and
 * the grant has been accepted -- so the answer has to be merged in AFTER that,
 * and nothing may be advertised before its evidence exists.
 */
describe('macOS two-phase virtual-display readiness', () => {
  const host = read('src/node/macos-virtual-display-authority-host.ts');
  const workerHost = read('src/node/macos-remote-desktop-worker-host.ts');
  const nativeProbe = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');

  it('keeps display control out of the preflight phase', () => {
    // Phase 1 asserts it false rather than omitting it: an absent optional
    // reads as falsy anyway, but writing it down is what makes the intent
    // survive someone spreading a wider object into it later.
    expect(workerHost).toMatch(
      /PHASE 1[\s\S]{0,900}preflightProfile = resolveMacosRemoteDesktopRuntimeProfile\(\{[\s\S]{0,300}virtualDisplay: false/u,
    );
    // The preflight profile is a gate, never an advertisement.
    expect(workerHost).not.toMatch(/setAdvertisedProfile\(preflightProfile\)/u);
  });

  it('answers display control only after the agent lease exists', () => {
    // Phase 2 sits between authentication and the single advertisement.
    const phaseTwo = workerHost.indexOf('PHASE 2');
    const advertise = workerHost.indexOf('this.setAdvertisedProfile(profile);');
    expect(phaseTwo).toBeGreaterThan(-1);
    expect(advertise).toBeGreaterThan(phaseTwo);
    // Asserted INSIDE that span. A bare `toContain` was satisfied by the
    // identical call in the refresh path, so deleting phase 2 outright still
    // passed -- the probe has to happen on the way to the advertisement.
    const span = workerHost.slice(phaseTwo, advertise);
    expect(span).toContain('this.displayReadiness = await this.probeVirtualDisplayReadiness();');
    expect(span).toMatch(/virtualDisplay: this\.displayReadiness/u);
  });

  it('asks on the existing lease and never opens a second authority channel', () => {
    expect(host).toContain('const lease = host.lease();');
    expect(host).toContain('proxyVirtualDisplayRequest');
    // Readiness is the zero-mutation op; nothing here may hold, enable or create.
    expect(host).toMatch(/MACOS_VIRTUAL_DISPLAY_PROXY_OP\.READINESS/u);
    const start = host.indexOf('export async function probeVirtualDisplayCreateReadiness');
    expect(start).toBeGreaterThan(-1);
    // Bounded by the next export, not by a name that a longer identifier also
    // starts with -- `MacosVirtualDisplayAuthorityHostOptions` matched first
    // and produced an empty, vacuously passing slice.
    const probe = host.slice(start, host.indexOf('export interface', start + 1));
    expect(probe).not.toMatch(/HOLD|ENABLE|startMacosVirtualDisplayAuthorityListener/u);
    // No lease is false, not "assume yes".
    expect(probe).toContain('if (lease === null) return false;');
  });

  it('advertises on qualification alone, not on an existing display', () => {
    // Requiring admission would mean a headless host could never advertise the
    // capability that lets it create its first display.
    const probe = host.slice(host.indexOf('probeVirtualDisplayCreateReadiness'));
    expect(probe).toContain('reply.qualifiedToCreate === true');
    expect(probe).not.toContain('displayControlAdmitted === true');
  });

  it('re-asks the agent on every refresh so the profile does not self-narrow', () => {
    // Recomputing from the preflight items alone would drop display control on
    // the first poll after advertising it, and a narrowing profile is treated
    // as a readiness loss -- the session would tear itself down.
    const refresh = workerHost.slice(workerHost.indexOf('let next: MacosRemoteDesktopRuntimeProfile;'));
    expect(refresh).toContain('this.probeVirtualDisplayReadiness()');
    expect(refresh).toMatch(/virtualDisplay: this\.displayReadiness/u);
  });

  it('never lets a later phase widen control after authentication', () => {
    // The existing rule stays: display control may be established in phase 2,
    // but control itself can only ever narrow once the Server has authenticated.
    expect(workerHost).toContain(
      'const effective = !currentCanControl && nextCanControl ? current : next;',
    );
  });

  it('stops claiming release/stop reachability from a constructible path', () => {
    // `BuildControlSocketPath` succeeding proves a string was assembled, which
    // is true on every machine whether or not anything is listening.
    expect(nativeProbe).toContain('out->release_input = false;');
    expect(nativeProbe).toContain('out->stop_capture = false;');
    expect(nativeProbe).not.toMatch(/out->release_input = control_reachable/u);
    expect(nativeProbe).not.toMatch(/out->stop_capture = control_reachable/u);
  });
});

/**
 * Grant issuance: one challenge, and an acknowledged handshake.
 */
describe('macOS virtual-display grant issuance', () => {
  const host = read('src/node/macos-virtual-display-authority-host.ts');

  it('grants with the challenge the listener already sent, never a second one', () => {
    // The listener mints the challenge and puts it on the `chal1` line the
    // agent answers. Minting again here produced a grant carrying a secret the
    // agent had never seen, and left two live challenges for one
    // authentication -- the agent then refused every grant.
    expect(host).toContain('challenge: lease.challenge,');
    const onLease = host.slice(host.indexOf('onLease:'), host.indexOf('onLeaseEnded:'));
    expect(onLease, 'the grant path mints its own challenge')
      .not.toMatch(/options\.mintChallenge\(\)/u);
  });

  it('exposes the lease only after the agent acknowledges the grant', () => {
    // `granted` is what `lease()` gates on, so setting it before the ACK meant
    // answering display requests against a helper nobody confirmed exists.
    const ackIndex = host.indexOf('const acked = await new Promise');
    const grantedIndex = host.indexOf('entry.granted = true;');
    expect(ackIndex).toBeGreaterThan(-1);
    expect(grantedIndex).toBeGreaterThan(ackIndex);
    expect(host).toContain('grantAckAccepted(acked)');
    expect(host).toContain("endLease('grant_not_acked')");
  });

  it('routes the ACK instead of destroying the lease as unsolicited', () => {
    // The agent answers the grant with a `ctl1r` frame that no request is
    // waiting on. Falling through to the unsolicited branch destroyed the lease
    // the instant it was established, so every later request answered
    // agent_unavailable.
    const reader = host.slice(host.indexOf("entry.socket.on('data'"), host.indexOf('listener = await'));
    const ackBranch = reader.indexOf('entry.grantAck');
    const unsolicited = reader.indexOf("endLease('unsolicited')");
    // Both must EXIST before comparing. `-1 < n` is true, so a missing ACK
    // branch passed an ordering assertion that was meant to require it.
    expect(ackBranch, 'the reader has no ACK branch at all').toBeGreaterThan(-1);
    expect(unsolicited).toBeGreaterThan(-1);
    expect(ackBranch).toBeLessThan(unsolicited);
  });

  it('accepts EXACTLY the one canonical acknowledgement frame', () => {
    // There is one legal success frame. `SerializeVirtualDisplayControlReply
    // ({ok:true})` emits precisely this and nothing else -- verified against
    // the native serializer -- so acceptance is an identity test, not a parse.
    expect(MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME)
      .toBe('ctl1r ok=1 admitted=0 presence=absent');
    expect(grantAckAccepted(MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME)).toBe(true);

    // INVERTED from the previous version, which parsed arbitrary k=v tokens and
    // trimmed. Each of these was ACCEPTED before, and each one is an agent
    // describing something this daemon did not understand -- published as
    // authority anyway.
    for (const bad of [
      'ctl1r ok=1',                                        // bare: was accepted
      'ctl1r ok=1 admitted=0 presence=absent unexpected=1', // extra field
      'ctl1r unexpected=1 ok=1 admitted=0 presence=absent', // unknown key first
      ' ctl1r ok=1 admitted=0 presence=absent',             // leading space
      'ctl1r ok=1 admitted=0 presence=absent ',             // trailing space
      '\tctl1r ok=1 admitted=0 presence=absent',            // leading tab
      'ctl1r ok=1 admitted=0 presence=absent\n',            // trailing newline
      'ctl1r  ok=1 admitted=0 presence=absent',             // doubled separator
      'ctl1r ok=1 ok=1 admitted=0 presence=absent',         // duplicate key
      'ctl1r admitted=0 presence=absent ok=1',              // reordered
      'ctl1r ok=1 admitted=1 presence=absent',              // wrong flag value
      'ctl1r ok=1 admitted=0 presence=active',              // wrong presence
      'ctl1r ok=0 error=grant_refused',                     // explicit refusal
      'ctl1r ok=2 admitted=0 presence=absent',              // not a boolean
      'CTL1R ok=1 admitted=0 presence=absent',              // case variant
      'ctl1 ok=1 admitted=0 presence=absent',               // request prefix
      'grant1 uid=501',                                     // another grammar
      'ctl1r',                                              // no fields
      '',                                                   // empty
      null,                                                 // timeout
    ]) {
      expect(grantAckAccepted(bad as string | null),
        `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('publishes no lease for any non-canonical acknowledgement', () => {
    // Composition-level, not just the predicate: `granted` is what `lease()`
    // gates on, and it is set only on the exact frame.
    const host = read('src/node/macos-virtual-display-authority-host.ts');
    expect(host).toContain('grantAckAccepted(acked)');
    expect(host).toContain("endLease('grant_not_acked')");
    // The predicate must be an identity test -- no tokenising, no trimming.
    const predicate = host.slice(
      host.indexOf('export function grantAckAccepted'),
      host.indexOf('export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_HOST_ERROR'),
    );
    expect(predicate).toContain('line === MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME');
    expect(predicate).not.toMatch(/trim\(\)|split\(|indexOf\(/u);
  });

  it('settles a pending ACK when the lease ends underneath it', () => {
    // Otherwise the grant path awaits a promise that can never resolve and the
    // authority start never completes.
    const end = host.slice(host.indexOf('const endLease ='), host.indexOf('const attach ='));
    expect(end).toContain('ending?.grantAck');
  });
});

/**
 * One clock domain.
 */
describe('macOS virtual-display presentation clock domain', () => {
  const shared = read('shared/macos-virtual-display-authority.ts');
  const listener = read('src/node/macos-virtual-display-authority-listener.ts');
  const listenerTest = read('test/node/macos-virtual-display-authority-listener.test.ts');
  const hostTest = read('test/node/macos-virtual-display-authority-host.test.ts');
  const grantHeader = read('native/macos-remote-desktop/macos_virtual_display_grant.h');
  const linkHeader = read('native/macos-remote-desktop/macos_virtual_display_authority_link.h');
  const link = read('native/macos-remote-desktop/macos_virtual_display_authority_link.cc');

  it('leaves no dead epoch clock, and no prose that contradicts the code', () => {
    // SUPPLEMENTARY ONLY. The load-bearing checks are the arity assertion
    // inside callHandleAuthorityConnection (fails under plain `vitest run`)
    // and `Parameters<typeof handleAuthorityConnection>` (fails under the
    // isolated tsc invocation). This catches the same shape a step earlier and
    // in files those two cannot reach; it does not replace either.
    //
    // An identifier grep for `nowMs` was the guard that MISSED this: the dead
    // clock was passed anonymously, so it had no identifier to find. Match the
    // literal's SHAPE instead -- an arrow returning an epoch-ms constant, as a
    // bare argument on its own line.
    const deadEpochClockArgument = /^\s*\(\)\s*=>\s*1_7\d{2}(?:_\d{3}){3},\s*$/mu;
    for (const [name, body] of [
      ['listener test', listenerTest], ['host test', hostTest],
    ] as const)
      expect(deadEpochClockArgument.test(body), `${name} passes a dead epoch clock`)
        .toBe(false);

    // Prose that states the OLD model in the present tense. History is fine and
    // is deliberately kept, but it has to read as history.
    // Assembled from fragments on purpose: spelled out in one piece, this
    // pattern would match the file it is defined in and the guard would fail
    // on itself.
    const staleClaim = new RegExp(
      [['daemon', 'stamps', 'epoch'].join(' '),
       ['ledger', 'enforces', 'it'].join(' ')].join('|'), 'iu');
    for (const [name, body] of [
      ['shared', shared], ['listener', listener], ['grant header', grantHeader],
      ['link header', linkHeader], ['link', link],
      ['listener test', listenerTest], ['host test', hostTest],
    ] as const)
      expect(staleClaim.test(body), `${name} still asserts the old clock model`)
        .toBe(false);
  });

  it('puts a duration on the wire, never an absolute deadline', () => {
    // The wire carries a DURATION. The authority link turns it into a deadline
    // when it receives the challenge, on the receiver's own CLOCK_MONOTONIC,
    // and AcceptGrant enforces that deadline before admission, ledger reserve
    // or helper start; the ledger enforces single use, not expiry.
    //
    // It used to be an absolute epoch deadline stamped daemon-side and compared
    // against CLOCK_MONOTONIC, which counts from boot -- always astronomically
    // in that clock's future, so BOTH the grant expiry and the challenge
    // freshness check silently never fired. That is what this test pins shut.
    expect(shared).toContain('readonly ttlMs: number;');
    expect(shared).toContain('`ttl=${authority.ttlMs}`');
    expect(shared).not.toMatch(/expiresAtMs/u);
    expect(listener).toContain('ttl=${lease.ttlMs}');
    expect(listener).not.toMatch(/expires=\$\{/u);
    expect(grantHeader).toContain('std::uint64_t ttl_ms = 0;');
    expect(linkHeader).toContain('std::uint64_t ttl_ms = 0;');
  });

  it('forms the deadline on the receiver own monotonic clock', () => {
    expect(link).toContain('challenge.deadline_ms = received_at_ms + challenge.ttl_ms;');
    // Like compared with like: both are durations now.
    expect(link).toContain('if (grant.ttl_ms > challenge.ttl_ms)');
  });

  it('bounds the TTL identically in both languages', () => {
    const shapeMax = /MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS = ([0-9_]+)/u.exec(shared);
    const nativeMax = /kVirtualDisplayGrantMaxLifetimeMs = ([0-9']+)/u.exec(grantHeader);
    expect(shapeMax).not.toBeNull();
    expect(nativeMax).not.toBeNull();
    expect(Number(shapeMax![1].replace(/_/gu, '')))
      .toBe(Number(nativeMax![1].replace(/'/gu, '')));
  });
});

/**
 * The STOCK production composition, exercised from the real entry point.
 *
 * The whole chain type-checked while being dead: the default runtime supplied
 * no `startVirtualDisplayAuthority`, so the host held no lease and every
 * display request answered `agent_unavailable`. This starts from
 * `createMacosRemoteDesktopProductionDependencies` -- the function production
 * actually calls -- rather than from a hand-built options object, because a
 * hand-built one is exactly what hid the gap.
 */
describe('macOS stock production composition', () => {
  it('supplies a virtual-display authority factory from the default runtime', async () => {
    const { createMacosRemoteDesktopProductionDependencies } =
      await import('../../src/node/macos-remote-desktop-production.js');
    const dependencies = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(dependencies, 'stock composition produced nothing on darwin/arm64').toBeDefined();
    expect(typeof dependencies!.startVirtualDisplayAuthority,
      'stock composition supplies no authority factory: every display request '
      + 'would answer agent_unavailable').toBe('function');
  });

  it('refuses to start authority when nothing can verify the agent', async () => {
    // A narrow test seam implements the worker-socket methods only. Admitting
    // an agent nobody could verify is worse than holding no authority at all,
    // so the factory returns null rather than opening the rendezvous.
    const { createMacosRemoteDesktopProductionDependencies } =
      await import('../../src/node/macos-remote-desktop-production.js');
    const errors: unknown[] = [];
    const dependencies = createMacosRemoteDesktopProductionDependencies({
      platform: 'darwin',
      arch: 'arm64',
      onBackgroundError: (error) => errors.push(error),
    })!;
    const started = await dependencies.startVirtualDisplayAuthority!(
      {
        artifact: {} as never,
        user: {} as never,
        identity: {} as never,
        verification: undefined,
      },
      { onAuthorityLost: () => undefined },
    );
    expect(started, 'authority started with no agent verifier').toBeNull();
    // Null alone is not enough: a factory that TRIED and threw also returns
    // null, so this would pass with the guard deleted. It must refuse without
    // ever attempting to open the rendezvous, and an attempt reports an error.
    expect(errors, 'the factory tried to start before checking the verifier')
      .toEqual([]);
  });

  it('hands the factory the same artifact, user and verifier the IPC server uses', () => {
    const workerHost = read('src/node/macos-remote-desktop-worker-host.ts');
    // Passed from the host's own scope, not re-derived: two independently
    // built verifiers are two things to keep in step, and the weaker decides.
    expect(workerHost).toMatch(
      /startVirtualDisplayAuthority\(\{[\s\S]{0,120}artifact,[\s\S]{0,40}user,[\s\S]{0,40}identity,/u,
    );
    // The predicate must match the listener's exactly; `'verifyPeer' in seams`
    // would admit `{ verifyPeer: undefined }`, which the listener then rejects.
    expect(workerHost).toContain("verifyPeer === 'function'");
    const listener = read('src/node/macos-virtual-display-authority-listener.ts');
    expect(listener).toContain("typeof seams.verification.verifyPeer !== 'function'");
  });
});
