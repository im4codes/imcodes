/**
 * A queued pair starts ONLY through the scheduler's admission, which checks
 * capacity, provisions the workspace and delivers the brief that names it
 * (owner report, tsk_cd_implicit_working_no_workspace: a Brain send_message to
 * the named executor of a queued pair flipped it to `working` with no workspace).
 *
 * Real git and real directories under temporary roots; the real queue
 * (TaskPairAutomation) with fake busy/limit/pick dependencies.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setTaskPairWorkspaceDepsForTests } from '../../../src/daemon/task-pairs/workspace.js';
import { TASK_PAIR_WORKSPACE_EFFECTS, TASK_PAIR_WORKSPACE_EVENT_VERB, type TaskPairState } from '../../../shared/task-pair.js';

const PROJECT = 'qsaproj';
const BRAIN = 'deck_qsaproj_brain';
const EXEC = 'deck_sub_qsaexec';
const AUD = 'deck_sub_qsaaud';
const EXEC2 = 'deck_sub_qsaexec2';
const AUD2 = 'deck_sub_qsaaud2';
const ALL = [BRAIN, EXEC, AUD, EXEC2, AUD2];

let base = '';
let repo = '';
let plainDir = '';
let worktreesRoot = '';
let worksRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let now = 5_000_000;
let turn = 0;
let automation: TaskPairAutomation;
let projectDir = '';
const busy = new Set<string>();

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function session(name: string, role: SessionRecord['role'], dir: string): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: dir, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function useProject(dir: string) {
  projectDir = dir;
  for (const [name, role] of [[BRAIN, 'brain'], [EXEC, 'w1'], [AUD, 'w2'], [EXEC2, 'w3'], [AUD2, 'w4']] as const) upsertSession(session(name, role, dir));
  setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot } });
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `qsa-turn-${turn}`, now);
}
const pair = (taskId: string): TaskPairState => getTaskPairStore().getPair(PROJECT, taskId)!.state;
const sentTo = (target: string, reason?: string) => sent.filter((entry) => entry.target === target && (!reason || entry.id.includes(`:${reason}:`)));
async function flush() {
  for (let i = 0; i < 80; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await taskPairService.waitForIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (taskPairService.pendingCount === 0) return;
  }
}
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    now += 6 * 60_000;
    await automation.tick();
    await flush();
  }
}
function newAutomation(): TaskPairAutomation {
  return new TaskPairAutomation({
    now: () => now, isBusy: (name) => busy.has(name), isLimited: () => false,
    pickCandidate: () => undefined, provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined,
  });
}
/** Brain's send_message bound to a pair, delivered to `target` (the daemon-side bookkeeping of that send). */
function brainSends(taskId: string, target: string, eventId: string) {
  return taskPairService.implicitDispatch({ project: PROJECT, sender: BRAIN, target, taskId, eventId, message: 'please look at this' });
}
/** A started pair whose workspace is missing: what the bare flip (or a failed provisioning) left behind. */
function startedWithoutWorkspace(taskId: string, status: TaskPairState['status'] = 'working', extra: Partial<TaskPairState> = {}, executor = EXEC, auditor = AUD) {
  getTaskPairStore().savePair(PROJECT, {
    taskId, brain: BRAIN, status, flags: [], flagSides: {}, round: status === 'in_audit' || status === 'rework' ? 1 : 0,
    blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 0, createdAt: now, updatedAt: now, startedAt: now,
    executor, auditor, brief: `brief of ${taskId}`, ...extra,
  } satisfies TaskPairState);
}
const workspaceEvents = (taskId: string, effect: string) => getTaskPairStore().listEvents(PROJECT, taskId, 200)
  .filter((event) => event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB && event.effect === effect);

describe('a queued pair starts only through admission', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    busy.clear();
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-qsa-')));
    repo = join(base, 'project');
    plainDir = join(base, 'plain');
    worktreesRoot = join(base, 'worktrees');
    worksRoot = join(base, 'works');
    const origin = join(base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
    git(repo, 'fetch', '-q', 'origin');
    mkdirSync(plainDir, { recursive: true });
    useProject(repo);
    automation = newAutomation();
    taskPairService.setScheduler(automation);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of ALL) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  /** Capacity 1, D1 holding it, D2 queued behind it with its own executor/auditor. */
  async function queuedBehindCapacity(extra = ''): Promise<void> {
    marker(BRAIN, '<!-- IMCODES_TASK QUEUE - max=1 -->');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH D1 title="First" executor=${EXEC} auditor=${AUD} -->\nfirst brief\n<!-- IMCODES_TASK_END D1 -->`);
    await flush();
    expect(pair('D1').status).toBe('working');
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH D2 title="Second" executor=${EXEC2} auditor=${AUD2}${extra} -->\nsecond brief\n<!-- IMCODES_TASK_END D2 -->`);
    await flush();
    expect(pair('D2')).toMatchObject({ status: 'queued', executor: EXEC2, auditor: AUD2 });
  }

  it('CAUSAL: a Brain send_message to the executor of a queued pair leaves it queued, without a working-without-workspace state; admission then starts it with workspace and brief', async () => {
    await queuedBehindCapacity();
    const transition = brainSends('D2', EXEC2, 'brain-send-1');
    await flush();
    expect(transition?.effect).toBe('recorded');
    expect(pair('D2').status).toBe('queued');
    expect(pair('D2').startedAt).toBeUndefined();
    expect(pair('D2').workspace).toBeUndefined();
    expect(sentTo(EXEC2, 'dispatch')).toHaveLength(0); // the brief has not been sent, and it will be (below)
    // The invariant, stated directly: no pair is started without a workspace.
    for (const stored of getTaskPairStore().listActivePairs()) {
      if (stored.state.status !== 'queued') expect(stored.state.workspace, stored.state.taskId).toBeDefined();
    }

    marker(BRAIN, '<!-- IMCODES_TASK DONE D1 force=true -->');
    await flush();
    expect(pair('D2').status).toBe('working');
    expect(pair('D2').workspace).toMatchObject({ kind: 'worktree', status: 'active' });
    expect(existsSync(pair('D2').workspace!.path)).toBe(true);
    const brief = sentTo(EXEC2, 'dispatch');
    expect(brief).toHaveLength(1);
    expect(brief[0]!.text.startsWith('second brief')).toBe(true);
    expect(brief[0]!.text).toContain(pair('D2').workspace!.path);
  });

  it('an urgent queued pair on a full queue is also left to admission by a Brain send', async () => {
    await queuedBehindCapacity(' urgent=true');
    brainSends('D2', EXEC2, 'brain-send-urgent');
    await flush();
    expect(pair('D2')).toMatchObject({ status: 'queued' });
    expect(pair('D2').workspace).toBeUndefined();
  });

  it('a message to the AUDITOR of a queued pair is recorded and starts nothing', async () => {
    await queuedBehindCapacity();
    expect(brainSends('D2', AUD2, 'brain-send-auditor')?.effect).toBe('recorded');
    await flush();
    expect(pair('D2').status).toBe('queued');
    expect(pair('D2').workspace).toBeUndefined();
  });

  it("the executor's own STARTED / WORKING / READY_FOR_AUDIT markers on a queued pair are recorded, not a start", async () => {
    await queuedBehindCapacity();
    marker(EXEC2, '<!-- IMCODES_TASK STARTED D2 -->');
    marker(EXEC2, '<!-- IMCODES_TASK READY_FOR_AUDIT D2 path=/elsewhere -->');
    await flush();
    expect(pair('D2').status).toBe('queued');
    expect(pair('D2').workspace).toBeUndefined();
  });

  it("Brain's explicit WORKING marker is the manual override, and it ends up like an admitted pair: workspace and brief", async () => {
    await queuedBehindCapacity();
    marker(BRAIN, '<!-- IMCODES_TASK WORKING D2 -->');
    await flush();
    expect(pair('D2').status).toBe('working');
    await vi.waitFor(() => expect(pair('D2').workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
    await vi.waitFor(() => expect(sentTo(EXEC2, 'pair-brief')).toHaveLength(1));
    expect(sentTo(EXEC2, 'pair-brief')[0]!.text).toContain(pair('D2').workspace!.path);
  });

  it('a queued pair whose executor is free is admitted at once by the send request (capacity and holds still apply)', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK QUEUE Q1 executor=${EXEC} auditor=${AUD} -->\nq brief\n<!-- IMCODES_TASK_END Q1 -->`);
    await flush(); // the queue drains it at once...
    now += 1_000; // (a later instant: the queue's event ids carry the clock)
    sent = [];
    // ...so put it back the way an older daemon might have left it (no drain yet), then message its executor.
    getTaskPairStore().savePair(PROJECT, { ...pair('Q1'), status: 'queued', startedAt: undefined, workspace: undefined });
    brainSends('Q1', EXEC, 'brain-send-free');
    await flush();
    expect(pair('Q1').status).toBe('working');
    expect(pair('Q1').workspace).toMatchObject({ status: 'active' });
    expect(sentTo(EXEC, 'dispatch')).toHaveLength(1);
  });

  it('a cancelled pair is never revived by a send to its executor, nor touched by the repair pass', async () => {
    startedWithoutWorkspace('C1', 'working');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL C1 -->');
    await flush();
    expect(pair('C1').status).toBe('cancelled');
    brainSends('C1', EXEC, 'brain-send-cancelled');
    await tick(2);
    expect(pair('C1').status).toBe('cancelled');
    expect(pair('C1').workspace).toBeUndefined();
    expect(sentTo(EXEC, 'workspace-provisioned')).toHaveLength(0);
  });

  it('non-queued implicit dispatch is unchanged: a send to a working pair is recorded, an awaiting-decision pair resumes', async () => {
    startedWithoutWorkspace('N1', 'working');
    expect(brainSends('N1', EXEC, 'brain-send-working')?.effect).toBe('recorded');
    expect(pair('N1').status).toBe('working');
    startedWithoutWorkspace('N2', 'awaiting_brain_decision');
    expect(brainSends('N2', EXEC, 'brain-send-awaiting')?.effect).toBe('brain_resolved');
    expect(pair('N2').status).toBe('working');
  });

  describe('repair pass: a started pair with no workspace gets one on the next heartbeat', () => {
    it('provisions a git worktree, tells the executor and auditor once, and records the event', async () => {
      startedWithoutWorkspace('R1', 'working');
      await tick(1);
      expect(pair('R1').workspace).toMatchObject({ kind: 'worktree', status: 'active' });
      expect(existsSync(pair('R1').workspace!.path)).toBe(true);
      expect(sentTo(EXEC, 'workspace-provisioned')).toHaveLength(1);
      expect(sentTo(EXEC, 'workspace-provisioned')[0]!.text).toContain(pair('R1').workspace!.path);
      expect(sentTo(AUD, 'workspace-provisioned')).toHaveLength(1);
      expect(workspaceEvents('R1', TASK_PAIR_WORKSPACE_EFFECTS.PROVISIONED_LATE)).toHaveLength(1);
      await tick(2); // later heartbeats leave it alone
      expect(sentTo(EXEC, 'workspace-provisioned')).toHaveLength(1);
      expect(workspaceEvents('R1', TASK_PAIR_WORKSPACE_EFFECTS.PROVISIONED_LATE)).toHaveLength(1);
    });

    it.each(['in_audit', 'rework'] as const)('also repairs a %s pair', async (status) => {
      startedWithoutWorkspace(`R-${status}`, status);
      await tick(1);
      expect(pair(`R-${status}`).workspace).toMatchObject({ status: 'active' });
    });

    it('a non-git project gets a task directory, never a git init', async () => {
      useProject(plainDir);
      startedWithoutWorkspace('R2', 'working');
      await tick(1);
      expect(pair('R2').workspace).toMatchObject({ kind: 'dir', status: 'active' });
      expect(pair('R2').workspace!.path.startsWith(worksRoot)).toBe(true);
      expect(existsSync(join(plainDir, '.git'))).toBe(false);
    });

    it('when it cannot be created, Brain is told exactly once; the repair still succeeds later and clears that state', async () => {
      useProject(join(base, 'does-not-exist'));
      startedWithoutWorkspace('R3', 'working');
      await tick(3);
      expect(pair('R3').workspace).toBeUndefined();
      expect(sentTo(BRAIN, 'brain-workspace-unprovisioned')).toHaveLength(1);
      expect(pair('R3').workspaceRecoveryEscalatedAt).toBeDefined();

      useProject(repo); // the project directory appears
      await tick(1);
      expect(pair('R3').workspace).toMatchObject({ status: 'active' });
      expect(pair('R3').workspaceRecoveryEscalatedAt).toBeUndefined();
      expect(sentTo(BRAIN, 'brain-workspace-unprovisioned')).toHaveLength(1);
    });

    it('survives a daemon restart: a fresh scheduler over the same store repairs it, once', async () => {
      startedWithoutWorkspace('R4', 'working');
      automation = newAutomation(); // "restart": nothing in memory
      taskPairService.setScheduler(automation);
      await tick(1);
      expect(pair('R4').workspace).toMatchObject({ status: 'active' });
      automation = newAutomation();
      taskPairService.setScheduler(automation);
      await tick(1);
      expect(sentTo(EXEC, 'workspace-provisioned')).toHaveLength(1);
    });

    it('leaves queued pairs (admission provisions those) and legacy-imported pairs (they keep their own worktrees) alone', async () => {
      getTaskPairStore().savePair(PROJECT, {
        taskId: 'R5', brain: BRAIN, status: 'queued', flags: [], flagSides: {}, round: 0, blocking: ['P0'], previousAuditors: [],
        capCounts: {}, capRound: 0, createdAt: now, updatedAt: now, executor: EXEC2, auditor: AUD2, brief: 'queued brief',
      } satisfies TaskPairState);
      startedWithoutWorkspace('R6', 'working', {}, EXEC, AUD);
      const stored = getTaskPairStore().getPair(PROJECT, 'R6')!;
      getTaskPairStore().savePair(PROJECT, stored.state, { legacyTaskId: 'legacy_R6' });
      busy.add(EXEC2); // R5 stays queued
      await tick(1);
      expect(pair('R5').workspace).toBeUndefined();
      expect(pair('R6').workspace).toBeUndefined();
    });
  });
});
