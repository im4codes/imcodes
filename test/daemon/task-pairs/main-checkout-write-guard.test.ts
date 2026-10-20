/**
 * A pair participant's git write in the main checkout is refused before it runs
 * where the provider has a pre-tool hook, and reported at once otherwise
 * (tsk_cd_reassigned_executor_workspace). Brain and sessions without an open
 * pair are never blocked or reported: Brain merges in the main checkout and the
 * owner works there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import {
  PAIR_MAIN_CHECKOUT_GUARD_ENV,
  evaluatePairMainCheckoutGitWrite,
  inspectToolCallForPairMainCheckoutWrite,
  mainCheckoutWriteRefusal,
  resetPairMainCheckoutWriteNoticesForTests,
} from '../../../src/daemon/task-pairs/main-checkout-write-guard.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import type { TaskPairState, TaskPairStatus } from '../../../shared/task-pair.js';

const PROJECT = 'mcgproj';
const MAIN = '/Users/test/main-checkout';
const WS = '/Users/test/.imcodes/worktrees/imcodes/deck_sub_mcgexec/pair_t1/repo';
const BRAIN = 'deck_mcgproj_brain';
const EXEC = 'deck_sub_mcgexec';
const AUD = 'deck_sub_mcgaud';
const OWNER = 'deck_sub_mcgowner';
let sent: Array<{ target: string; text: string; id: string }>;

function session(name: string, role: SessionRecord['role'], agentType = 'codex-sdk'): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType, projectDir: MAIN, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function openPair(status: TaskPairStatus = 'working'): void {
  const now = Date.now();
  getTaskPairStore().savePair(PROJECT, {
    taskId: 'T1', status, brain: BRAIN, executor: EXEC, auditor: AUD, round: 1, blocking: ['P0'], title: 'demo',
    workspace: { kind: 'worktree', path: WS, createdAt: now, status: 'active' },
    createdAt: now, updatedAt: now,
  } as unknown as TaskPairState);
}
const sentTo = (target: string, reason: string) => sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool: 'Bash', input: { command }, ...extra });

describe('pair participants and the main checkout', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    delete process.env[PAIR_MAIN_CHECKOUT_GUARD_ENV];
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    resetPairMainCheckoutWriteNoticesForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    upsertSession(session(BRAIN, 'brain', 'claude-code-sdk'));
    upsertSession(session(EXEC, 'w1'));
    upsertSession(session(AUD, 'w2'));
    upsertSession(session(OWNER, 'w3'));
    openPair();
  });
  afterEach(() => {
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD, OWNER]) removeSession(name);
    delete process.env[PAIR_MAIN_CHECKOUT_GUARD_ENV];
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('codex-sdk executor: a reset in the main checkout is reported to it and to Brain at once (command run in the session cwd)', () => {
    inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git reset --hard origin/dev'));
    expect(sentTo(EXEC, 'main-checkout-git-write')[0]!.text).toContain('WARNING');
    expect(sentTo(EXEC, 'main-checkout-git-write')[0]!.text).toContain('git reset');
    expect(sentTo(EXEC, 'main-checkout-git-write')[0]!.text).toContain(WS);
    const brainLine = sentTo(BRAIN, 'brain-main-checkout-git-write')[0]!.text;
    expect(brainLine).toContain(`executor ${EXEC}`);
    expect(brainLine).toContain('it ran');
  });

  it('codex-sdk shape: cwd arrives as a file:// URL in detail.input, and a cd into the main checkout is followed', () => {
    inspectToolCallForPairMainCheckoutWrite(EXEC, { tool: 'Bash', input: { command: 'git cherry-pick abc123' }, detail: { input: { cwd: `file://${MAIN}` } } });
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1);
    sent = [];
    resetPairMainCheckoutWriteNoticesForTests();
    inspectToolCallForPairMainCheckoutWrite(EXEC, { tool: 'Bash', input: { command: `cd ${MAIN} && git checkout dev` }, detail: { input: { cwd: `file://${WS}` } } });
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1);
  });

  it('the same commands inside the pair workspace, and read-only git in the main checkout, are silent', () => {
    inspectToolCallForPairMainCheckoutWrite(EXEC, { tool: 'Bash', input: { command: 'git commit -am x && git reset --hard HEAD~1' }, detail: { input: { cwd: `file://${WS}` } } });
    inspectToolCallForPairMainCheckoutWrite(EXEC, bash(`git -C ${WS} cherry-pick abc`));
    inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git status && git log --oneline -5 && git diff'));
    inspectToolCallForPairMainCheckoutWrite(EXEC, bash('npm test'));
    expect(sent).toHaveLength(0);
  });

  it('gemini-sdk (run_shell_command), process agents (string input) and the auditor are covered too', () => {
    inspectToolCallForPairMainCheckoutWrite(AUD, { tool: 'run_shell_command', input: { command: 'git checkout dev' } });
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')[0]!.text).toContain(`auditor ${AUD}`);
    sent = [];
    // codex-watcher style: the tool input is the plain command string.
    inspectToolCallForPairMainCheckoutWrite(EXEC, { tool: 'exec_command', input: 'git merge feature' });
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1);
    // A string input on a non-shell tool is not a command.
    sent = [];
    inspectToolCallForPairMainCheckoutWrite(EXEC, { tool: 'web_search', input: 'git reset --hard' });
    expect(sent).toHaveLength(0);
  });

  it('Brain is never blocked or reported: it merges in the main checkout', () => {
    inspectToolCallForPairMainCheckoutWrite(BRAIN, bash('git cherry-pick abc123 && git push origin dev'));
    expect(evaluatePairMainCheckoutGitWrite(BRAIN, 'Bash', { command: 'git reset --hard' })).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("the owner's own session without an open pair is never blocked or reported", () => {
    inspectToolCallForPairMainCheckoutWrite(OWNER, bash('git commit -am "fix" && git reset --hard'));
    expect(evaluatePairMainCheckoutGitWrite(OWNER, 'Bash', { command: 'git checkout dev' })).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('a session stops being guarded when its pair is no longer open (queued, done, cancelled)', () => {
    for (const status of ['queued', 'done', 'cancelled'] as TaskPairStatus[]) {
      openPair(status);
      expect(evaluatePairMainCheckoutGitWrite(EXEC, 'Bash', { command: 'git reset --hard' }), status).toBeUndefined();
    }
    openPair('in_audit');
    expect(evaluatePairMainCheckoutGitWrite(AUD, 'Bash', { command: 'git reset --hard' })).toMatchObject({ role: 'auditor', taskId: 'T1' });
  });

  it('claude-code-sdk: the pre-tool evaluation refuses (with the reason the tool call carries) and tells Brain; the later timeline event does not repeat it as "already ran"', () => {
    upsertSession(session(EXEC, 'w1', 'claude-code-sdk'));
    const hit = evaluatePairMainCheckoutGitWrite(EXEC, 'Bash', { command: 'git reset --hard origin/dev' }, { cwd: MAIN })!;
    expect(hit).toMatchObject({ verb: 'reset', taskId: 'T1', role: 'executor', brain: BRAIN });
    const reason = mainCheckoutWriteRefusal(hit);
    expect(reason).toContain('REFUSED');
    expect(reason).toContain('It did not run');
    expect(reason).toContain(WS);
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')[0]!.text).toContain('refused before it ran');
    expect(sentTo(EXEC, 'main-checkout-git-write')).toHaveLength(0); // the refusal is in the tool result
    inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git reset --hard origin/dev'));
    expect(sentTo(EXEC, 'main-checkout-git-write')).toHaveLength(0);
    expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1);
  });

  it('reports a repeated command once per window, and again once the window has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git reset --hard'));
      inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git reset --hard'));
      expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1);
      vi.setSystemTime(Date.now() + 6 * 60_000);
      inspectToolCallForPairMainCheckoutWrite(EXEC, bash('git reset --hard'));
      expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the switch turns the whole guard off, and a project not on the pairs engine is never guarded', () => {
    process.env[PAIR_MAIN_CHECKOUT_GUARD_ENV] = 'off';
    expect(evaluatePairMainCheckoutGitWrite(EXEC, 'Bash', { command: 'git reset --hard' })).toBeUndefined();
    delete process.env[PAIR_MAIN_CHECKOUT_GUARD_ENV];
    process.env.IMCODES_SUPERVISION_ENGINE = 'legacy';
    expect(evaluatePairMainCheckoutGitWrite(EXEC, 'Bash', { command: 'git reset --hard' })).toBeUndefined();
  });

  it('the service timeline hook reaches the guard for a real tool.call event', async () => {
    taskPairService.init();
    try {
      timelineEmitter.emit(EXEC, 'tool.call', { tool: 'Bash', input: { command: 'git reset --hard' } }, { source: 'daemon', confidence: 'high', eventId: 'mcg-1' });
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-main-checkout-git-write')).toHaveLength(1));
    } finally {
      await taskPairService.dispose();
    }
  });
});
