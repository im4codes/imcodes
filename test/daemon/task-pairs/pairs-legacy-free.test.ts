/**
 * 215 / jdzj (2026-09-25 evening): every pair stalled because executors and
 * auditors were still working by the legacy engine's rules. Executors would not
 * write READY_FOR_AUDIT until "the control plane" issued an assignmentId /
 * auditAttemptId / auditRevision / immutable bundle; auditors filed a P0 for
 * the same missing artifacts or because the executor was rate limited; and a
 * provider capacity error stopped supervision. A pair has none of those
 * artifacts: its material is the executor's worktree at a HEAD.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setTaskPairMaterialDepsForTests } from '../../../src/daemon/task-pairs/material.js';
import { setTaskPairWorkspaceDepsForTests } from '../../../src/daemon/task-pairs/workspace.js';
import { isTransientProviderError, resetTaskPairProviderErrorsForTests } from '../../../src/daemon/task-pairs/provider-errors.js';
import { handleLegacyToolOnPairs } from '../../../src/daemon/task-pairs/legacy-tools.js';
import {
  NO_LEGACY_ARTIFACTS,
  buildAuditorAssignmentMessage,
  buildAuditorHandoffMessage,
  buildDispatchTrailer,
  buildDoneReminderMessage,
  buildExecutorPairBrief,
  buildExecutorResendMessage,
  buildNudgeMessage,
  buildReworkNoticeMessage,
} from '../../../src/daemon/task-pairs/messages.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { buildSessionDispatchMessage } from '../../../src/daemon/session-dispatch.js';
import { extractAgentDelegationReplyAuthorityFromInstruction } from '../../../shared/agent-delegation.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { SUPERVISION_MCP_TOOLS } from '../../../shared/supervision-mcp-tools.js';
import { TASK_PAIR_AUDIT_EVIDENCE, buildAuditConvergenceContract } from '../../../shared/audit-convergence.js';
import { buildTaskPairMarkerContract, emptySeverityCounts, type TaskPairState } from '../../../shared/task-pair.js';

const PROJECT = 'legacyfreeproj';
const BRAIN = 'deck_legacyfreeproj_brain';
const EXEC = 'deck_sub_lfexec';
const AUD = 'deck_sub_lfaud';
const SPARE = 'deck_sub_lfspare';

let repo = '';
let now = 1_000_000;
let turn = 0;
let sent: Array<{ target: string; text: string; id: string }>;
let limited: Set<string>;
let automation: TaskPairAutomation;

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `lf-turn-${turn}`, now);
}
function pair(taskId: string): TaskPairState {
  return getTaskPairStore().getPair(PROJECT, taskId)!.state;
}
function sentTo(target: string, reasonPart?: string) {
  return sent.filter((entry) => entry.target === target && (!reasonPart || entry.id.includes(`:${reasonPart}:`)));
}
async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    now += 6 * 60_000;
    await automation.tick();
    await flush();
  }
}
/** The legacy demands the agents on 215 kept making, as instructions (not as the negated "has no ..." sentence). */
function demandsLegacyArtifacts(text: string): boolean {
  const withoutNegation = text.split(NO_LEGACY_ARTIFACTS).join('');
  return /assignmentId|auditAttemptId|auditRevision|immutable bundle|scopeFiles|exact[- ]revision/i.test(withoutNegation);
}

describe('pairs run without legacy supervision artifacts', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    resetTaskPairProviderErrorsForTests();
    sent = [];
    limited = new Set();
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    // A real executor worktree with one commit and an uncommitted edit.
    repo = mkdtempSync(join(tmpdir(), 'imcodes-pair-material-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w1', { projectDir: repo }), session(AUD, 'w2'), session(SPARE, 'w3')]) {
      upsertSession(record);
    }
    automation = new TaskPairAutomation({
      now: () => now,
      isBusy: () => false,
      isLimited: (name) => limited.has(name),
      pickCandidate: ({ exclude }) => (exclude.has(SPARE) ? undefined : SPARE),
      provision: async () => undefined,
      poolOf: () => 'primary',
      importLegacy: () => undefined,
    });
    taskPairService.setScheduler(automation);
    taskPairService.init();
    // Material and wording only here; pair workspaces are covered in pairs-workspace.test.ts.
    setTaskPairWorkspaceDepsForTests({ projectRootOf: () => undefined });
  });

  afterEach(() => {
    taskPairService.dispose();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairMaterialDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    resetTaskPairProviderErrorsForTests();
    for (const name of [BRAIN, EXEC, AUD, SPARE]) removeSession(name);
    rmSync(repo, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('briefs both sides when Brain opens a pair and relays the executor-named worktree/head/base to the auditor on READY_FOR_AUDIT', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH M1 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(sentTo(AUD, 'auditor-assigned')).toHaveLength(1));
    const brief = sentTo(EXEC, 'pair-brief');
    expect(brief).toHaveLength(1);
    expect(brief[0]!.text).toContain('READY_FOR_AUDIT M1 worktree=<absolute path> head=<commit> base=<commit>');
    expect(brief[0]!.text).toContain(NO_LEGACY_ARTIFACTS);
    expect(sentTo(AUD, 'auditor-assigned')).toHaveLength(1);
    expect(sentTo(AUD, 'auditor-assigned')[0]!.text).toContain(NO_LEGACY_ARTIFACTS);

    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT M1 worktree=/work/exec head=abc1234 base=def5678 -->');
    await flush();
    expect(pair('M1')).toMatchObject({ status: 'in_audit', material: { worktree: '/work/exec', head: 'abc1234', base: 'def5678' } });
    const request = sentTo(AUD, 'audit-request');
    expect(request).toHaveLength(1);
    expect(request[0]!.text).toContain('worktree /work/exec · head abc1234 · base def5678');
    expect(request[0]!.text).toContain('git -C /work/exec diff def5678..abc1234');
    expect(request[0]!.text).toContain('NEEDS_INPUT M1');
    expect(request[0]!.text).not.toContain('resolved by the daemon');
    expect(demandsLegacyArtifacts(request[0]!.text)).toBe(false);

    // task_get on a pairs task: the pairs view, the material, and a plain "no legacy artifacts" note.
    const got = await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.GET, AUD, { taskId: 'M1' });
    expect(got).toMatchObject({ engine: 'pairs', task: { taskId: 'M1', material: { worktree: '/work/exec', head: 'abc1234' } } });
    expect(String(got.pairsNote)).toContain(NO_LEGACY_ARTIFACTS);
    expect(String(got.hint)).toContain('PASS M1');
  });

  it('resolves the material from the executor session and its real git HEAD when READY_FOR_AUDIT names none', async () => {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH M2 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT M2 -->');
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    const request = sentTo(AUD, 'audit-request');
    expect(request).toHaveLength(1);
    expect(request[0]!.text).toContain(`worktree ${repo} · head ${head}`);
    expect(request[0]!.text).toContain('resolved by the daemon from the executor session');
  });

  it('answers every legacy tool on a pairs task with the pairs view and a role-appropriate marker, never a legacy demand', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH M3 executor=${EXEC} auditor=${AUD} -->`);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT M3 worktree=/w head=1234567 -->');
    // An auditor trained on peer_audit_reply: its verdict is recorded and it is shown the marker.
    const reply = await handleLegacyToolOnPairs(MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY, AUD, {
      taskId: 'M3', verdict: 'PASS', findings: '[P3] naming nit', receiptKind: 'final',
    });
    expect(reply).toMatchObject({ engine: 'pairs', taskId: 'M3', pairStatus: 'passed' });
    expect(String(reply.hint)).toContain('PASS M3 blocking=P0');
    expect(String(reply.pairsNote)).toContain(NO_LEGACY_ARTIFACTS);
    const listed = await handleLegacyToolOnPairs(SUPERVISION_MCP_TOOLS.LIST, EXEC, {});
    expect(String(listed.pairsNote)).toContain('Legacy supervision tasks are history and are not shown');
    expect(String(listed.hint)).toContain('READY_FOR_AUDIT <taskId> worktree=<absolute path>');
  });

  it('never instructs an executor or auditor to wait for legacy artifacts, in any pair message or contract', () => {
    const state: TaskPairState = {
      taskId: 'M4', brain: BRAIN, executor: EXEC, auditor: AUD, status: 'in_audit', flags: [], flagSides: {}, round: 2,
      blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 2, createdAt: 1, updatedAt: 1,
      material: { worktree: '/w', head: '1234567', at: 1 },
      lastVerdict: { verb: 'REWORK', counts: { ...emptySeverityCounts(), P0: 1 }, judgement: 'consistent', round: 1 },
    };
    const messages = [
      buildExecutorPairBrief(state), buildAuditorAssignmentMessage(state), buildAuditorHandoffMessage(state),
      buildNudgeMessage(state, 'auditor'), buildNudgeMessage({ ...state, status: 'working' }, 'executor'),
      buildDispatchTrailer(state), buildExecutorResendMessage(state, SPARE), buildDoneReminderMessage(state),
      buildReworkNoticeMessage(state, { ...emptySeverityCounts(), P0: 1 }),
    ];
    for (const text of messages) expect(demandsLegacyArtifacts(text), text).toBe(false);
    for (const text of [buildExecutorPairBrief(state), buildAuditorAssignmentMessage(state), buildAuditorHandoffMessage(state), buildNudgeMessage(state, 'auditor')]) {
      expect(text).toContain(NO_LEGACY_ARTIFACTS);
    }
    expect(buildAuditorHandoffMessage(state)).toContain('worktree /w · head 1234567');

    // The contracts every session carries say the same.
    const audit = JSON.parse(buildAuditConvergenceContract()) as { taskPairs: typeof TASK_PAIR_AUDIT_EVIDENCE };
    expect(audit.taskPairs).toEqual(TASK_PAIR_AUDIT_EVIDENCE);
    expect(audit.taskPairs.noLegacyArtifacts).toContain('never a finding and never blocks');
    expect(audit.taskPairs.materialUnreachable).toContain('NEEDS_INPUT');
    const pairs = buildTaskPairMarkerContract();
    expect(pairs).toContain('READY_FOR_AUDIT <taskId> worktree=<absolute path> head=<commit> base=<commit>');
    expect(pairs).toContain('never wait for, ask for or block on them');
    expect(pairs).toContain('write NEEDS_INPUT <taskId> note="..." and wait: that is never a P0 or REWORK');
  });

  it('sends pairs delegations with a reply instruction that references no supervision_* contract', () => {
    const delegationId = 'delegation_pairs_1234567890';
    const pairsText = buildSessionDispatchMessage('do the work', { from: BRAIN, replyTo: BRAIN, replyAuthority: { delegationId } });
    expect(pairsText).not.toMatch(/supervision_[a-z_]+_v\d/);
    expect(extractAgentDelegationReplyAuthorityFromInstruction(pairsText)).toEqual({ delegationId });
    process.env.IMCODES_SUPERVISION_ENGINE = 'legacy';
    const legacyText = buildSessionDispatchMessage('do the work', { from: BRAIN, replyTo: BRAIN, replyAuthority: { delegationId } });
    expect(legacyText).toContain('supervision_messaging_v1');
    expect(extractAgentDelegationReplyAuthorityFromInstruction(legacyText)).toEqual({ delegationId });
  });

  it('treats a capacity error as limited: the executor is held without nudges and escalated only if it lasts, the auditor is replaced at once', async () => {
    expect(isTransientProviderError('Error: Selected model is at capacity. Please try a different model.')).toBe(true);
    expect(isTransientProviderError('429 Too Many Requests')).toBe(true);
    expect(isTransientProviderError('Invalid API key')).toBe(false);

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH M5 executor=${EXEC} auditor=${AUD} -->`);
    await flush();
    sent = [];
    const capacity = (sessionName: string) => timelineEmitter.emit(sessionName, 'session.state', {
      state: 'error', error: 'Selected model is at capacity. Please try a different model.',
    }, { source: 'daemon', confidence: 'high', ts: now });

    // Executor refused by its provider, again on every retry.
    for (let i = 0; i < 2; i += 1) {
      capacity(EXEC);
      await tick(1);
    }
    expect(sentTo(EXEC, 'nudge-executor')).toHaveLength(0);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(0);
    capacity(EXEC);
    await tick(1);
    expect(sentTo(BRAIN, 'brain-executor_silent')).toHaveLength(1);

    // It answers again: no longer limited, nudged normally on the next idle heartbeat.
    timelineEmitter.emit(EXEC, 'assistant.text', { text: 'back', streaming: false }, { source: 'daemon', confidence: 'high', ts: now + 1 });
    await flush();
    await tick(2);
    expect(sentTo(EXEC, 'nudge-executor').length).toBeGreaterThan(0);

    // A non-transient error is not a limit.
    sent = [];
    timelineEmitter.emit(EXEC, 'session.state', { state: 'error', error: 'Invalid API key' }, { source: 'daemon', confidence: 'high' });
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT M5 worktree=/w head=7654321 -->');
    await flush();
    // Auditor refused: replaced at once, not left holding the audit.
    capacity(AUD);
    await tick(1);
    expect(pair('M5').auditor).toBe(SPARE);
  });
});
