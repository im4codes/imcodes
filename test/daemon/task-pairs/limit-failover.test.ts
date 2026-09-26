/**
 * Causal tests for tsk_cd_limit_failover: a rate/usage-limited pair
 * participant fails over to a different provider family at once; a mere
 * transient "at capacity" error never fails over; when every eligible
 * provider is genuinely limited the pair waits with one aggregated notice;
 * and two owner-report fixes travel with the same package: needs_auditor is
 * never kept once a real, available auditor is assigned, and an escalation
 * for a BLOCKED participant states the real cause instead of the generic
 * no-auditor text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { describeLimitedProviderFamilies, listTaskPairCandidates } from '../../../src/daemon/task-pairs/pool.js';
import { DELEGATION_LIMIT_REASONS, PROVIDER_LIMIT_EVIDENCE_KINDS } from '../../../shared/delegation-availability.js';
import { TASK_PAIR_SILENCE_LIMIT, type TaskPairAllowlistEntry } from '../../../shared/task-pair.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { resetTaskPairProviderErrorsForTests } from '../../../src/daemon/task-pairs/provider-errors.js';

const PROJECT = 'limitproj';
const BRAIN = 'deck_limitproj_brain';
const NOW = 1_000_000;

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', providerId: 'anthropic',
    ...(role === 'brain' ? {} : { parentSession: BRAIN }),
    projectDir: `/tmp/${PROJECT}`, state: 'idle', sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

const CROSS_FAMILY_ALLOWLIST: TaskPairAllowlistEntry[] = [
  { role: 'auditor', agentType: 'claude-code-sdk', modelPattern: '' },
  { role: 'auditor', agentType: 'codex-sdk', modelPattern: '' },
];

describe('pool: provider-family preference and limited-family reporting', () => {
  it('prefers a different provider family once one is named to avoid, but still returns the same family last rather than nothing', () => {
    const anthropic = session('deck_sub_anthropic', 'w1', { agentType: 'claude-code-sdk', providerId: 'anthropic', updatedAt: 1 });
    const openai = session('deck_sub_openai', 'w2', { agentType: 'codex-sdk', providerId: 'openai', updatedAt: 2 });
    const deps = { listSessions: () => [session(BRAIN, 'brain'), anthropic, openai], hasPendingMessages: () => false };

    const plain = listTaskPairCandidates({ brain: BRAIN, role: 'auditor', pool: 'primary', allowlist: CROSS_FAMILY_ALLOWLIST, exclude: new Set() }, deps);
    expect(plain.map((s) => s.name)).toEqual(['deck_sub_anthropic', 'deck_sub_openai']);

    const preferred = listTaskPairCandidates({
      brain: BRAIN, role: 'auditor', pool: 'primary', allowlist: CROSS_FAMILY_ALLOWLIST, exclude: new Set(), avoidProviderFamily: 'anthropic',
    }, deps);
    expect(preferred.map((s) => s.name)).toEqual(['deck_sub_openai', 'deck_sub_anthropic']);
  });

  it('reports the real, structured-limited families and their retry time, not sessions merely busy or off-allowlist', () => {
    const limitedAnthropic = session('deck_sub_anthropic', 'w1', {
      agentType: 'claude-code-sdk', providerId: 'anthropic',
      providerLimit: { limitedAt: NOW, retryAt: NOW + 60_000, reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED, evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED, agentType: 'claude-code-sdk' },
    } as Partial<SessionRecord>);
    const busyOpenai = session('deck_sub_openai', 'w2', { agentType: 'codex-sdk', providerId: 'openai', state: 'running' });
    const deps = { listSessions: () => [session(BRAIN, 'brain'), limitedAnthropic, busyOpenai], now: () => NOW };

    const result = describeLimitedProviderFamilies({
      brain: BRAIN, role: 'auditor', pool: 'primary', allowlist: CROSS_FAMILY_ALLOWLIST, exclude: new Set(),
    }, deps);
    // The reported deadline is a FLOOR (limitedAt + a minimum backoff), never
    // shorter than the provider's own retryAt -- see delegationLimitDeadline.
    expect(result?.families).toEqual([{ family: 'anthropic', retryAt: expect.any(Number) }]);
    expect(result?.families?.[0]?.retryAt).toBeGreaterThan(NOW);
    expect(result?.text).toContain('anthropic');
    expect(result?.text).not.toContain('openai');
  });

  it('finds nothing when the pick failed for a different reason (no eligible session at all)', () => {
    const deps = { listSessions: () => [session(BRAIN, 'brain')], now: () => NOW };
    const result = describeLimitedProviderFamilies({
      brain: BRAIN, role: 'auditor', pool: 'primary', allowlist: CROSS_FAMILY_ALLOWLIST, exclude: new Set(),
    }, deps);
    expect(result).toBeUndefined();
  });
});

describe('scheduler: limit-triggered failover, needs_auditor invariant, and real-cause escalation', () => {
  const EXEC = 'deck_sub_limitexec';
  const AUD = 'deck_sub_limitaud';
  const OPENAI_AUD = 'deck_sub_openaiaud';
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  let now = NOW;
  let sent: Array<{ target: string; text: string; id: string }>;
  let automation: TaskPairAutomation;

  function marker(writer: string, line: string) {
    return taskPairService.ingestText(PROJECT, writer, line, `limit-turn-${Math.random()}`, now);
  }
  function pair(taskId: string) {
    return getTaskPairStore().getPair(PROJECT, taskId)!.state;
  }
  function sentTo(target: string, reasonPart?: string) {
    return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}:`)));
  }
  async function flush() {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    getTaskPairStore().setProjectAllowlist(PROJECT, CROSS_FAMILY_ALLOWLIST);
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [
      session(BRAIN, 'brain'),
      session(EXEC, 'w1', { agentType: 'codex-sdk', providerId: 'openai' }),
      session(AUD, 'w2', { agentType: 'claude-code-sdk', providerId: 'anthropic' }),
    ]) upsertSession(record);
    taskPairService.init();
  });

  afterEach(async () => {
    await taskPairService.dispose();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairProviderErrorsForTests();
    for (const name of [BRAIN, EXEC, AUD, OPENAI_AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('reassigns a rate-limited auditor to the different-family candidate, not the same-family one that is also idle', async () => {
    upsertSession(session(OPENAI_AUD, 'w3', { agentType: 'codex-sdk', providerId: 'openai', updatedAt: 2 }));
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T1 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T1 -->');
    await flush();
    sent = [];
    upsertSession(session(AUD, 'w2', {
      agentType: 'claude-code-sdk', providerId: 'anthropic',
      // isSessionProviderLimited (unlike the scheduler's own fake `now`)
      // resolves availability against real wall-clock time, since scheduler.ts
      // never threads a `now` override into the pool.ts availability check.
      providerLimit: { limitedAt: Date.now(), reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED, evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED, agentType: 'claude-code-sdk' },
    } as Partial<SessionRecord>));

    now += 6 * 60_000;
    await automation.tick();
    await flush();

    expect(pair('T1').auditor).toBe(OPENAI_AUD);
    expect(sentTo(OPENAI_AUD, 'handoff')).toHaveLength(1);
  });

  it('sets all_providers_limited and sends one notice naming the limited family when no replacement exists anywhere', async () => {
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T2 -->');
    await flush();
    sent = [];
    // AUD is the only eligible auditor in the whole pool, and it is limited.
    upsertSession(session(AUD, 'w2', {
      agentType: 'claude-code-sdk', providerId: 'anthropic',
      providerLimit: { limitedAt: Date.now(), reason: DELEGATION_LIMIT_REASONS.PROVIDER_RATE_LIMITED, evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED, agentType: 'claude-code-sdk' },
    } as Partial<SessionRecord>));

    now += 6 * 60_000;
    await automation.tick();
    await flush();

    expect(pair('T2').flags).toContain('all_providers_limited');
    expect(pair('T2').flags).not.toContain('needs_auditor');
    const notice = sentTo(BRAIN).find((entry) => entry.text.includes('all_providers_limited') || entry.text.includes('anthropic'));
    expect(notice?.text).toContain('anthropic');
    expect(notice?.text).toContain(AUD);
  });

  it('owner report: never keeps needs_auditor once a real, available auditor is assigned (self-heals a stale flag)', async () => {
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T3 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T3 -->');
    await flush();
    // Simulate the stale state the owner reported: a real, idle, unlimited
    // auditor is assigned, but needs_auditor is ALSO set (however it got
    // there -- an import, a race, ...).
    const stale = { ...pair('T3'), flags: [...pair('T3').flags, 'needs_auditor' as const] };
    getTaskPairStore().savePair(PROJECT, stale);
    expect(pair('T3').flags).toContain('needs_auditor');
    sent = [];

    now += 6 * 60_000;
    await automation.tick();
    await flush();

    expect(pair('T3').flags).not.toContain('needs_auditor');
    expect(pair('T3').auditor).toBe(AUD);
    expect(sentTo(BRAIN, 'brain-needs_auditor')).toHaveLength(0);
  });

  it('owner report: escalates a BLOCKED auditor with the real cause, never the generic no-auditor text, while the auditor stays assigned', async () => {
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T4 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T4 -->');
    await flush();
    sent = [];
    marker(AUD, '<!-- IMCODES_TASK BLOCKED T4 note="no worktree/assignment/manifest" -->');
    await flush();
    expect(pair('T4').auditor).toBe(AUD);
    expect(pair('T4').flags).not.toContain('needs_auditor');

    now += 6 * 60_000;
    await automation.tick();
    await flush();

    const notice = sentTo(BRAIN, 'brain-blocked');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain(`auditor ${AUD} BLOCKED: no worktree/assignment/manifest`);
    expect(notice[0]!.text).not.toContain('no auditor could be found');
    expect(pair('T4').flags).not.toContain('needs_auditor');
    expect(pair('T4').auditor).toBe(AUD);
  });

  it('r1 audit fix: a capacity-limited auditor is never reassigned, however long it persists, and gets exactly one notice', async () => {
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    taskPairService.setScheduler(automation);
    const capacity = () => timelineEmitter.emit(AUD, 'session.state', {
      state: 'error', error: 'Selected model is at capacity. Please try a different model.',
    }, { source: 'daemon', confidence: 'high', ts: now });

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T5 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T5 -->');
    await flush();
    sent = [];

    for (let i = 0; i < TASK_PAIR_SILENCE_LIMIT + 2; i += 1) {
      capacity();
      now += 6 * 60_000;
      await automation.tick();
      await flush();
    }

    expect(pair('T5').auditor).toBe(AUD);
    expect(sentTo(BRAIN, 'brain-auditor_capacity_hold')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-auditor_capacity_hold')[0]!.text).toContain('retrying on the same session');
    expect(sentTo(AUD, 'handoff')).toHaveLength(0);
  });

  it('keeps replacing an ordinarily silent auditor (no capacity/rate-limit signal) at the silence limit', async () => {
    automation = new TaskPairAutomation({ now: () => now, importLegacy: () => undefined });
    upsertSession(session(OPENAI_AUD, 'w3', { agentType: 'codex-sdk', providerId: 'openai' }));
    taskPairService.setScheduler(automation);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH T6 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT T6 -->');
    await flush();
    sent = [];
    // Keep the executor busy throughout: this isolates the auditor's silence
    // (asymmetric quiet) from the upstream "both sides quiet" nudge-executor
    // path, which takes over only when NEITHER side has done anything.
    upsertSession(session(EXEC, 'w1', { agentType: 'codex-sdk', providerId: 'openai', state: 'running' }));

    for (let i = 0; i < TASK_PAIR_SILENCE_LIMIT; i += 1) {
      now += 6 * 60_000;
      await automation.tick();
      await flush();
    }

    expect(pair('T6').auditor).not.toBe(AUD);
    expect(sentTo(pair('T6').auditor!, 'handoff')).toHaveLength(1);
  });
});
