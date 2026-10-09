import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROCESS_SHARED_MACHINE_IDLE_GUARD_MS,
  PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS,
  bindProcessSharedMachineActivity,
  bindProcessSharedMachineCommand,
  clearProcessSharedMachineAuthoritiesForTests,
  readProcessSharedMachineAuthority,
  releaseProcessSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';
import { SHARED_MACHINE_ACTIVITY_KIND, type SharedMachineActivity } from '../../shared/shared-machine-authority.js';

const identity = { sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1' };
const SESSION = 'deck_a';
const CLOSED = { required: true, authority: null };
const OPEN = { required: false, authority: null };

const owner: SharedMachineActivity = { kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER };
const participant = (actorUserId: string, authority?: string): SharedMachineActivity => (
  { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId, authority }
);

type Step =
  | { act: SharedMachineActivity }
  | 'idle';

/** Replays steps at 10s spacing (past the idle guard) and returns the hook answer at the end. */
function replay(steps: readonly Step[]): { required: boolean; authority: string | null } {
  let now = 1_000_000;
  for (const step of steps) {
    now += 10_000;
    if (step === 'idle') releaseProcessSharedMachineAuthority(SESSION, now);
    else bindProcessSharedMachineActivity(SESSION, identity, step.act, { now });
  }
  return readProcessSharedMachineAuthority(SESSION, identity, now + 1);
}

describe('process shared machine authority context', () => {
  beforeEach(clearProcessSharedMachineAuthoritiesForTests);

  describe('every order of participant send / participant input / owner activity / idle', () => {
    const send = { act: participant('alice', 'tok-send') } as const;
    const input = { act: participant('alice', 'tok-input') } as const;
    const ownerAct = { act: owner } as const;
    const other = { act: participant('bob', 'tok-bob') } as const;

    const table: Array<[string, readonly Step[], { required: boolean; authority: string | null }]> = [
      ['nothing yet', [], OPEN],
      ['participant send', [send], { required: true, authority: 'tok-send' }],
      ['participant input', [input], { required: true, authority: 'tok-input' }],
      ['input then send (same participant): the latest token', [input, send], { required: true, authority: 'tok-send' }],
      ['send then input (same participant): the latest token', [send, input], { required: true, authority: 'tok-input' }],
      ['owner only', [ownerAct], OPEN],
      ['owner input then owner send', [ownerAct, ownerAct], OPEN],
      ['D2: participant send, then owner send while the turn runs', [send, ownerAct], CLOSED],
      ['D6: owner turn, then participant keystrokes', [ownerAct, input], CLOSED],
      ['owner turn, then participant send', [ownerAct, send], CLOSED],
      ['participant input, then owner input', [input, ownerAct], CLOSED],
      ['participant send, owner, participant again: stays closed', [send, ownerAct, send], CLOSED],
      ['two different participants in one turn', [send, other], CLOSED],
      ['participant, owner, idle: released', [send, ownerAct, 'idle'], OPEN],
      ['participant, idle: released', [send, 'idle'], OPEN],
      ['participant, idle, owner: owner runs unrestricted', [send, 'idle', ownerAct], OPEN],
      ['owner, idle, participant: participant bound', [ownerAct, 'idle', send], { required: true, authority: 'tok-send' }],
      ['participant, idle, other participant: only the new one', [send, 'idle', other], { required: true, authority: 'tok-bob' }],
      ['idle with nothing bound', ['idle'], OPEN],
      ['participant without any token fails closed', [{ act: participant('alice') }], CLOSED],
      ['participant without token, then owner', [{ act: participant('alice') }, ownerAct], CLOSED],
      ['tokenless keystroke then the same participant sends with a token', [{ act: participant('alice') }, send], { required: true, authority: 'tok-send' }],
      ['tokenless keystroke then another participant sends', [{ act: participant('alice') }, other], CLOSED],
    ];

    it.each(table)('%s', (_name, steps, expected) => {
      expect(replay(steps)).toEqual(expected);
    });
  });

  it('never returns authority for a required context that cannot be resolved', () => {
    // No token at all.
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice'), { now: 1_000 });
    expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(CLOSED);
    // A session record without a runtime identity cannot match any caller.
    clearProcessSharedMachineAuthoritiesForTests();
    bindProcessSharedMachineActivity(SESSION, null, participant('alice', 'tok'), { now: 1_000 });
    expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(CLOSED);
    // A stale hook child of an earlier runtime.
    clearProcessSharedMachineAuthoritiesForTests();
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 1_000 });
    expect(readProcessSharedMachineAuthority(SESSION, { ...identity, runtimeEpoch: 'epoch-2' }, 1_001)).toEqual(CLOSED);
    expect(readProcessSharedMachineAuthority(SESSION, { ...identity, sessionInstanceId: 'instance-2' }, 1_001)).toEqual(CLOSED);
  });

  it('a restarted runtime starts a fresh window instead of inheriting the old one', () => {
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 1_000 });
    const restarted = { sessionInstanceId: 'instance-2', runtimeEpoch: 'epoch-2' };
    bindProcessSharedMachineActivity(SESSION, restarted, owner, { now: 2_000 });
    expect(readProcessSharedMachineAuthority(SESSION, restarted, 2_001)).toEqual(OPEN);
  });

  it('ignores an idle signal that is only the tail of the previous turn', () => {
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 5_000 });
    releaseProcessSharedMachineAuthority(SESSION, 5_000 + PROCESS_SHARED_MACHINE_IDLE_GUARD_MS - 1);
    expect(readProcessSharedMachineAuthority(SESSION, identity, 6_000)).toEqual({ required: true, authority: 'tok' });
    releaseProcessSharedMachineAuthority(SESSION, 5_000 + PROCESS_SHARED_MACHINE_IDLE_GUARD_MS);
    expect(readProcessSharedMachineAuthority(SESSION, identity, 6_600)).toEqual(OPEN);
  });

  it('keeps the restriction while the session still reports a running turn, however long it is quiet', () => {
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 1_000 });
    const later = 1_000 + PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS * 3;
    expect(readProcessSharedMachineAuthority(SESSION, identity, later, true)).toEqual({ required: true, authority: 'tok' });
    // A running turn is not released by an owner message either.
    bindProcessSharedMachineActivity(SESSION, identity, owner, { now: later, sessionRunning: true });
    expect(readProcessSharedMachineAuthority(SESSION, identity, later + 1, true)).toEqual(CLOSED);
  });

  it('releases a window that has been quiet on a session that is no longer running (no idle edge was seen)', () => {
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 1_000 });
    expect(readProcessSharedMachineAuthority(SESSION, identity, 1_000 + PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS - 1, false))
      .toEqual({ required: true, authority: 'tok' });
    expect(readProcessSharedMachineAuthority(SESSION, identity, 1_000 + PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS, false)).toEqual(OPEN);
    // And a bind after that starts fresh rather than mixing with the dead window.
    bindProcessSharedMachineActivity(SESSION, identity, participant('alice', 'tok'), { now: 1_000 });
    bindProcessSharedMachineActivity(SESSION, identity, owner, { now: 1_000 + PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS });
    expect(readProcessSharedMachineAuthority(SESSION, identity, 1_000 + PROCESS_SHARED_MACHINE_WINDOW_QUIET_MS + 1)).toEqual(OPEN);
  });

  describe('bindProcessSharedMachineCommand (what the daemon does with a browser command)', () => {
    const record = { ...identity, state: 'idle' };
    const stamped = (role: string) => ({ sharedActor: { actorUserId: 'alice', effectiveActorRole: role } });

    it('treats a server-stamped participant command as participant activity and anything unstamped as owner activity', () => {
      bindProcessSharedMachineCommand(SESSION, record, { ...stamped('participant'), sharedMachineAuthority: ' tok ' }, 1_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual({ required: true, authority: 'tok' });
      clearProcessSharedMachineAuthoritiesForTests();
      bindProcessSharedMachineCommand(SESSION, record, { data: 'x' }, 1_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(OPEN);
      clearProcessSharedMachineAuthoritiesForTests();
      bindProcessSharedMachineCommand(SESSION, record, stamped('owner'), 1_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(OPEN);
    });

    it('a participant keystroke without a token binds the participant context with no authority', () => {
      bindProcessSharedMachineCommand(SESSION, record, stamped('participant'), 1_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(CLOSED);
    });

    it('a record without a runtime identity fails closed for a participant command', () => {
      bindProcessSharedMachineCommand(SESSION, undefined, { ...stamped('participant'), sharedMachineAuthority: 'tok' }, 1_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 1_001)).toEqual(CLOSED);
    });

    it('an owner command during a participant turn does not unlock it; ESC from either side stays a plain input', () => {
      bindProcessSharedMachineCommand(SESSION, record, { ...stamped('participant'), sharedMachineAuthority: 'tok' }, 1_000);
      bindProcessSharedMachineCommand(SESSION, record, { data: '\u001b' }, 20_000);
      expect(readProcessSharedMachineAuthority(SESSION, identity, 20_001)).toEqual(CLOSED);
    });
  });
});
