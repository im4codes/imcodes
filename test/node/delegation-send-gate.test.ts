import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRecord } from '../../src/store/session-store.js';
import {
  CronSendTargetLimitedError,
  clearSendIdempotencyCacheForTests,
  dispatchCronSend,
  dispatchHookSend,
  dispatchSendMessage,
  dispatchSendStop,
  listSendTargets,
} from '../../src/daemon/send-tool.js';
import {
  DELEGATION_AVAILABILITY,
  DELEGATION_LIMIT_FALLBACK_TTL_MS,
  DELEGATION_LIMIT_REASONS,
  DELEGATION_TARGET_LIMITED,
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  type DelegationLimitState,
} from '../../shared/delegation-availability.js';

const NOW = 1_700_000_000_000;

const caller = {
  userId: 'user-1',
  sessionName: 'deck_alpha_brain',
  projectName: 'alpha',
  projectRoot: '/work/alpha',
};

function session(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>,
): SessionRecord {
  return {
    sessionInstanceId: `instance_${overrides.name}`,
    runtimeEpoch: `epoch_${overrides.name}`,
    agentType: 'codex',
    projectDir: `/work/${overrides.projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    // `deck_<project>_w<n>` with role `w<n>` is the legacy auto-worker shape,
    // which `isDiscoverableInterAgentSession` hides unless it was user-created
    // or labelled. Without this these fixtures resolve to nothing and every
    // assertion below passes or fails for a reason that has nothing to do with
    // provider limits.
    userCreated: true,
    ...overrides,
  } as SessionRecord;
}

function limit(overrides: Partial<DelegationLimitState> = {}): DelegationLimitState {
  return {
    limitedAt: NOW,
    reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    agentType: 'codex',
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    ...overrides,
  };
}

const deps = (sessions: SessionRecord[], dispatchMessage = vi.fn(async () => {})) => ({
  now: () => NOW,
  listSessions: () => sessions,
  dispatchMessage,
});

/**
 * The CONSUMERS of the provider-limit chain.
 *
 * Detection was wired end to end -- Claude, Codex and DeepSeek all persist a
 * canonical signal -- and nothing read it. `send_list_targets` still advertised
 * a refused account as selectable and `send_message` still queued into it, so
 * the whole feature was observable only by reading sessions.json by hand. These
 * tests exist so "detected" can never again be mistaken for "acted on".
 */
describe('delegation send gate', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
  });

  it('refuses a send to a limited target instead of queueing it', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    // Fail CLOSED. A queued message looks accepted and then sits unread, so the
    // orchestrator waits on a turn that will never start.
    expect(dispatchMessage).not.toHaveBeenCalled();
    // `reason` is the machine ADMISSION reason the caller branches on;
    // `limitReason` is the provider verdict behind it. Two fields because a
    // caller re-routing needs the first and an operator diagnosing needs the
    // second.
    expect(result.limited?.targets[0]).toMatchObject({
      target: 'deck_alpha_w1',
      reason: DELEGATION_TARGET_LIMITED,
      limitReason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED,
    });
  });

  it('refuses a SIBLING that never met the provider itself', async () => {
    // The limit belongs to the account, not the session that happened to hit
    // it. Routing to an untouched sibling on the same account is the exact
    // retry-into-a-wall this feature exists to stop.
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w2', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    expect(result.limited?.targets[0]?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('offers alternatives only from a DIFFERENT provider family', async () => {
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
        session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
      ]),
    );

    if (result.status !== 'error') throw new Error('expected a refusal');
    const alternatives = result.limited?.alternatives.map((a) => a.target) ?? [];
    // w3 is a different account. w2 shares the refused one, so offering it
    // would just be the same wall with another name.
    expect(alternatives).toContain('deck_alpha_w3');
    expect(alternatives).not.toContain('deck_alpha_w2');
  });

  it('does not offer a second limited family as the escape from the first', async () => {
    const result = await dispatchSendMessage(
      caller,
      { target: 'deck_alpha_w1', message: 'do the thing' },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({
          name: 'deck_alpha_w3',
          projectName: 'alpha',
          role: 'w3',
          agentType: 'claude-code',
          providerLimit: limit({ agentType: 'claude-code' }),
        }),
        session({ name: 'deck_alpha_w4', projectName: 'alpha', role: 'w4', agentType: 'gemini' }),
      ]),
    );

    if (result.status !== 'error') throw new Error('expected a refusal');
    const alternatives = result.limited?.alternatives.map((a) => a.target) ?? [];
    expect(alternatives).toEqual(['deck_alpha_w4']);
  });

  it('still delivers to healthy recipients on a broadcast, and reports the limited ones', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(
      caller,
      { message: 'all hands', broadcast: true },
      deps([
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
        session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
      ], dispatchMessage),
    );

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('unreachable');
    // Reported, never silently dropped: a caller reading "accepted" must not
    // believe every sibling received it.
    expect(result.deliveries).toContainEqual(expect.objectContaining({
      target: 'deck_alpha_w1',
      status: 'failed',
      error: expect.stringContaining(DELEGATION_TARGET_LIMITED),
    }));
    expect(result.deliveries).toContainEqual(expect.objectContaining({
      target: 'deck_alpha_w3',
      status: 'delivered',
    }));
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('marks the whole family limited in send_list_targets', () => {
    const listed = listSendTargets(caller, {}, deps([
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW + 60_000 }) }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ]));

    const byName = new Map(listed.items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_w1')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    // Effective deadline: the bounded fallback floors a shorter provider reset,
    // so a caller that waits until this instant is not refused a second time.
    expect(byName.get('deck_alpha_w1')?.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(byName.get('deck_alpha_w2')?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
    expect(byName.get('deck_alpha_w2')?.limitReason).toBe(DELEGATION_LIMIT_REASONS.FAMILY_LIMITED);
    // A different account is untouched.
    expect(byName.get('deck_alpha_w3')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
    expect(byName.get('deck_alpha_w3')?.limitGroup)
      .not.toBe(byName.get('deck_alpha_w1')?.limitGroup);
  });

  it('does not let a query filter hide the sibling holding the evidence', () => {
    // Resolution runs over every session BEFORE the filter. Resolving after it
    // would report the family healthy exactly when the caller narrowed its
    // search -- the case where it is least likely to be double-checked.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ];
    const listed = listSendTargets(caller, { query: 'w2' }, deps(sessions));

    expect(listed.items.map((i) => i.sessionName)).toEqual(['deck_alpha_w2']);
    expect(listed.items[0]?.availability).toBe(DELEGATION_AVAILABILITY.LIMITED);
  });

  it('uses ONE decision source, so the list never offers what the send refuses', async () => {
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const listed = listSendTargets(caller, {}, deps(sessions));

    // Guard against a VACUOUS pass. An empty list makes the loop below assert
    // nothing while reporting green -- and an earlier run of this suite did
    // exactly that, because the fixtures were undiscoverable.
    expect(listed.items.length).toBe(3);
    expect(listed.items.some((i) => i.availability === DELEGATION_AVAILABILITY.LIMITED)).toBe(true);
    expect(listed.items.some((i) => i.availability === DELEGATION_AVAILABILITY.READY)).toBe(true);

    for (const item of listed.items) {
      const sent = await dispatchSendMessage(
        caller,
        { target: item.sessionName, message: 'probe' },
        deps(sessions),
      );
      const listSaysLimited = item.availability === DELEGATION_AVAILABILITY.LIMITED;
      const sendSaysLimited = sent.status === 'error' && sent.reason === DELEGATION_TARGET_LIMITED;
      expect(sendSaysLimited, `${item.sessionName}: list and send disagree`).toBe(listSaysLimited);
    }
  });

  it('reopens the target once the limit expires, as unknown rather than ready', async () => {
    // `limited` is not terminal. An expired window proves the WAIT is over, not
    // that the quota came back, so the target is re-probed instead of trusted.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW - 1 }) }),
    ];
    const expired = {
      now: () => NOW + 24 * 60 * 60_000,
      listSessions: () => sessions,
      dispatchMessage: vi.fn(async () => {}),
    };

    const listed = listSendTargets(caller, {}, expired);
    expect(listed.items[0]?.availability).toBe(DELEGATION_AVAILABILITY.UNKNOWN);

    const sent = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'probe' }, expired);
    expect(sent.status).toBe('accepted');
    expect(expired.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('never lists or targets a STOPPED session', async () => {
    // Discovered by mutation: deleting the `state !== 'stopped'` clause from
    // the authorized-candidate resolver broke no test at all. It is invisible
    // in the alternatives path (availability already drops offline candidates),
    // so the only place it is load-bearing is target resolution -- which
    // nothing was checking. A stopped session would have become a listable,
    // sendable target whose message goes nowhere.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'stopped' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ];
    const dispatchMessage = vi.fn(async () => {});

    const listed = listSendTargets(caller, {}, deps(sessions, dispatchMessage));
    expect(listed.items.map((i) => i.sessionName)).toEqual(['deck_alpha_w2']);

    const sent = await dispatchSendMessage(
      caller, { target: 'deck_alpha_w1', message: 'x' }, deps(sessions, dispatchMessage),
    );
    expect(sent.status).toBe('error');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('leaves an ordinary provider error alone', async () => {
    // Only a canonical limit signal may gate a send. A session in `error` is
    // unhealthy for its own reasons and must not be reported as rate limited,
    // or every crash would look like an exhausted account.
    const listed = listSendTargets(caller, {}, deps([
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'error' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
    ]));

    const byName = new Map(listed.items.map((item) => [item.sessionName, item]));
    expect(byName.get('deck_alpha_w1')?.availability).toBe(DELEGATION_AVAILABILITY.OFFLINE);
    expect(byName.get('deck_alpha_w1')?.limitReason).toBeUndefined();
    // And it does not contaminate its family.
    expect(byName.get('deck_alpha_w2')?.availability).toBe(DELEGATION_AVAILABILITY.READY);
  });
});

/**
 * Every entry point that creates new work runs the SAME gate.
 *
 * `send_message` was gated first and the others were not, which meant the
 * refusal could be walked around three ways: a `/send` hook passes its target
 * records in directly, a cron tick fires on a schedule nobody watches, and a
 * clone spawns a fresh worker that inherits the template's exhausted account.
 * A gate with three bypasses is not a gate.
 */
describe('delegation gate covers every work-creating entry point', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
  });

  it('hook /send refuses a limited target and still delivers to the rest', async () => {
    const dispatchMessage = vi.fn(async () => 'delivered' as const);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const result = await dispatchHookSend(
      {
        from: 'deck_alpha_brain',
        targetRecords: [sessions[1]!, sessions[2]!],
        message: 'hello',
      },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );

    expect(result.errors.join(' ')).toContain(DELEGATION_TARGET_LIMITED);
    // Named alternative, not just a refusal: a caller told only "no" retries.
    expect(result.errors.join(' ')).toContain('deck_alpha_w3');
    expect(result.delivered).toEqual(['deck_alpha_w3']);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('hook /send is unchanged when nothing is limited', async () => {
    const dispatchMessage = vi.fn(async () => 'delivered' as const);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2', state: 'running' }),
    ];
    const result = await dispatchHookSend(
      { from: 'deck_alpha_brain', targetRecords: [sessions[1]!, sessions[2]!], message: 'hello' },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );

    // ready AND busy both still dispatch. `busy` is "ask later", not "refused".
    expect(result.errors).toEqual([]);
    expect(result.delivered).toEqual(['deck_alpha_w1', 'deck_alpha_w2']);
    expect(dispatchMessage).toHaveBeenCalledTimes(2);
  });

  it('cron raises a TYPED limited refusal rather than a bare error', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit({ retryAt: NOW + 60_000 }) }),
      session({ name: 'deck_alpha_w3', projectName: 'alpha', role: 'w3', agentType: 'claude-code' }),
    ];
    const cronDeps = {
      now: () => NOW,
      listSessions: () => sessions,
      getSession: (n: string) => sessions.find((s) => s.name === n),
      dispatchMessage,
    };

    await expect(dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      cronDeps,
    )).rejects.toBeInstanceOf(CronSendTargetLimitedError);

    // The scheduler must be able to read WHEN, not parse a sentence.
    const raised = await dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      cronDeps,
    ).catch((err: unknown) => err as CronSendTargetLimitedError);
    expect(raised.reason).toBe(DELEGATION_TARGET_LIMITED);
    expect(raised.limited?.targets[0]?.retryAt).toBe(NOW + DELEGATION_LIMIT_FALLBACK_TTL_MS);
    expect(raised.limited?.alternatives.map((a) => a.target)).toContain('deck_alpha_w3');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('cron still dispatches normally to a healthy target', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
    ];
    const result = await dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      { now: () => NOW, listSessions: () => sessions, getSession: (n) => sessions.find((s) => s.name === n), dispatchMessage },
    );
    expect(result.status).toBe('dispatched');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('never creates a clone whose template family is already limited', async () => {
    const createExecutionClone = vi.fn();
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit() }),
    ];
    const result = await dispatchSendMessage(
      caller,
      {
        target: 'deck_alpha_w1',
        message: 'do work',
        clone: { kind: 'execution_clone', ephemeral: true, parentRunId: 'run-1', parentStage: 'generic_execution' },
      },
      { now: () => NOW, listSessions: () => sessions, dispatchMessage: vi.fn(async () => {}), createExecutionClone },
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.reason).toBe(DELEGATION_TARGET_LIMITED);
    // The point of gating BEFORE create: an ephemeral clone with a hard timeout
    // would otherwise spend its entire lifetime waiting on a quota that was
    // already exhausted, then be reaped as if it had merely been slow.
    expect(createExecutionClone).not.toHaveBeenCalled();
  });

  it('keeps send_stop working against a limited target', async () => {
    // Control plane, not delegation. Stopping a session that is stuck behind a
    // provider limit is exactly when an operator most needs the button to work.
    const cancelSession = vi.fn(async () => true);
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', providerLimit: limit(), state: 'running' }),
    ];
    const result = await dispatchSendStop(
      caller,
      { target: 'deck_alpha_w1' },
      { now: () => NOW, listSessions: () => sessions, cancelSession },
    );

    expect(result.status).toBe('accepted');
    expect(cancelSession).toHaveBeenCalledTimes(1);
  });

  it('widens the refusal for spawned work without changing ordinary sends', async () => {
    // An unhealthy session can still be MESSAGED -- that is often how it gets
    // woken. But a scheduler firing into one just grows a backlog nobody is
    // draining, so the work-creating paths refuse where an ordinary send does not.
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', state: 'error' }),
    ];
    const shared = {
      now: () => NOW,
      listSessions: () => sessions,
      getSession: (n: string) => sessions.find((s) => s.name === n),
      dispatchMessage: vi.fn(async () => {}),
    };

    const ordinary = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'wake up' }, shared);
    expect(ordinary.status).toBe('accepted');

    await expect(dispatchCronSend(
      { fromSessionName: 'deck_alpha_brain', target: 'deck_alpha_w1', message: 'tick' },
      shared,
    )).rejects.toBeInstanceOf(CronSendTargetLimitedError);
  });
});
