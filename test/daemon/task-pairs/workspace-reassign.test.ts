/**
 * Executor change (tsk_cd_reassigned_executor_workspace): the pair's worktree
 * used to stay under the PREVIOUS executor's session directory, and a rebuild
 * under the new executor forked a second worktree for the same task. The daemon
 * now keeps exactly one authoritative workspace under the current executor:
 * moves it (git worktree move), registers a same-task worktree found beside it,
 * and rewrites/redirects material that names the old path.
 *
 * Real git and real directories under a temporary worktrees root.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { setTaskPairMaterialDepsForTests, resolveTaskPairMaterial } from '../../../src/daemon/task-pairs/material.js';
import { setRebaseRevertGuardDepsForTests } from '../../../src/daemon/task-pairs/rebase-revert-guard.js';
import { ensureTaskPairWorkspaceAvailable, taskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import {
  rehomeTaskPairWorkspace,
  setTaskPairWorkspaceDepsForTests,
  taskPairWorktreeName,
  type TaskPairWorkspaceDeps,
} from '../../../src/daemon/task-pairs/workspace.js';
import {
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  redirectTaskPairWorkspacePath,
  type TaskPairState,
} from '../../../shared/task-pair.js';

const PROJECT = 'wrproj';
const BRAIN = 'deck_wrproj_brain';
const OLD = 'deck_sub_wrold';
const NEW = 'deck_sub_wrnew';
const AUD = 'deck_sub_wraud';

let base = '';
let project = '';
let worktreesRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;
let deps: TaskPairWorkspaceDeps;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const pair = (taskId: string): TaskPairState => getTaskPairStore().getPair(PROJECT, taskId)!.state;
const sentTo = (target: string, reason: string) => sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));
const workspaceEvents = (taskId: string) => getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB);
const pathOf = (session: string, taskId: string) => join(worktreesRoot, 'imcodes', session, taskPairWorktreeName(taskId), 'repo');

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir: project, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `wr-turn-${turn}`);
}
const testScheduler: TaskPairScheduler = {
  async onIntent(projectName, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    taskPairService.applyMarker({
      project: projectName, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue', now: Date.now(), eventId: `test-queue-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await taskPairService.briefParticipants(projectName, pairState.taskId);
  },
};

async function openedByOld(taskId: string): Promise<string> {
  marker(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${OLD} auditor=${AUD} -->`);
  await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
  await vi.waitFor(() => expect(sentTo(OLD, 'pair-brief')).toHaveLength(1));
  return pair(taskId).workspace!.path;
}
async function reassignExecutor(taskId: string) {
  sent = [];
  marker(BRAIN, `<!-- IMCODES_TASK REASSIGN ${taskId} executor=${NEW} -->`);
  await taskPairService.waitForIdle();
}

describe('pair workspace follows an executor change', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-reassign-')));
    project = join(base, 'project');
    worktreesRoot = join(base, 'worktrees');
    const origin = join(base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', project]);
    git(project, 'config', 'user.email', 'test@example.invalid');
    git(project, 'config', 'user.name', 'Test');
    writeFileSync(join(project, 'README.md'), 'hello\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'base');
    git(project, 'remote', 'add', 'origin', origin);
    git(project, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(project, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
    git(project, 'fetch', '-q', 'origin');
    deps = { env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: join(base, 'works') }, isBusy: () => false, hasProcessInside: async () => false };
    setTaskPairWorkspaceDepsForTests(deps);
    for (const record of [session(BRAIN, 'brain'), session(OLD, 'w1'), session(NEW, 'w2'), session(AUD, 'w3')]) upsertSession(record);
    taskPairService.setScheduler(testScheduler);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairMaterialDepsForTests(undefined);
    setRebaseRevertGuardDepsForTests();
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, OLD, NEW, AUD]) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('REASSIGN moves the worktree under the new executor: one authoritative path, work and stash intact, brief names it', async () => {
    const oldPath = await openedByOld('R1');
    expect(oldPath).toBe(pathOf(OLD, 'R1'));
    // Work the old executor left behind: a commit on a branch, a tracked edit, an untracked file and a stash.
    git(oldPath, 'checkout', '-q', '-b', 'fix/r1');
    writeFileSync(join(oldPath, 'committed.txt'), 'c\n');
    git(oldPath, 'add', '-A');
    git(oldPath, 'commit', '-qm', 'work');
    writeFileSync(join(oldPath, 'README.md'), 'stashed edit\n');
    git(oldPath, 'stash', 'push', '-q');
    writeFileSync(join(oldPath, 'README.md'), 'uncommitted edit\n');
    writeFileSync(join(oldPath, 'untracked.txt'), 'u\n');
    const head = git(oldPath, 'rev-parse', 'HEAD');

    await reassignExecutor('R1');

    const newPath = pathOf(NEW, 'R1');
    expect(pair('R1').workspace).toMatchObject({ kind: 'worktree', path: newPath, previousPaths: [oldPath], status: 'active' });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(oldPath, '..'))).toBe(false);
    expect(git(newPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(newPath, 'symbolic-ref', '--short', 'HEAD')).toBe('fix/r1');
    expect(readFileSync(join(newPath, 'README.md'), 'utf8')).toBe('uncommitted edit\n');
    expect(readFileSync(join(newPath, 'untracked.txt'), 'utf8')).toBe('u\n');
    expect(git(newPath, 'stash', 'list')).toContain('stash@{0}');
    const listed = git(project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => realpathSync(line.slice(9)));
    expect(listed).toContain(realpathSync(newPath));
    expect(listed).not.toContain(oldPath);
    expect(listed.filter((entry) => entry.includes(taskPairWorktreeName('R1')))).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(join(newPath, '..', 'metadata.json'), 'utf8')) as Record<string, string>;
    expect(metadata).toMatchObject({ taskId: 'R1', sessionName: NEW, repoPath: newPath });
    // The new executor's brief names the single path, the branch, the head and where it came from.
    const brief = sentTo(NEW, 'pair-brief')[0]!.text;
    expect(brief).toContain(newPath);
    expect(brief).toContain('on branch fix/r1');
    expect(brief).toContain(`moved here from ${oldPath}`);
    expect(brief).not.toContain('WARNING: another worktree');
    expect(workspaceEvents('R1').some((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.MOVED)).toBe(true);
  });

  it('material naming the old path is rewritten at the move and redirected when a later READY still names it', async () => {
    const oldPath = await openedByOld('R2');
    const state = pair('R2');
    getTaskPairStore().savePair(PROJECT, { ...state, material: { worktree: oldPath, head: 'a'.repeat(40), at: 1 } });
    await reassignExecutor('R2');
    const newPath = pathOf(NEW, 'R2');
    expect(pair('R2').material?.worktree).toBe(newPath);

    // The new executor (or a stale habit) still writes the old path on READY_FOR_AUDIT.
    const head = git(newPath, 'rev-parse', 'HEAD');
    sent = [];
    marker(NEW, `<!-- IMCODES_TASK STARTED R2 -->`);
    marker(NEW, `<!-- IMCODES_TASK READY_FOR_AUDIT R2 worktree=${oldPath} head=${head} -->`);
    await taskPairService.waitForIdle();
    expect(pair('R2').material?.worktree).toBe(newPath);
    const resolved = await resolveTaskPairMaterial(pair('R2'));
    expect(resolved.worktree).toBe(newPath);
    const request = sentTo(AUD, 'audit-request')[0]!.text;
    expect(request).toContain(newPath);
    expect(request).not.toContain(oldPath);
  });

  it('an auditor-only change never moves anything', async () => {
    const oldPath = await openedByOld('R3');
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R3 auditor=${NEW} -->`);
    await taskPairService.waitForIdle();
    expect(pair('R3').workspace!.path).toBe(oldPath);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(pathOf(NEW, 'R3'))).toBe(false);
  });

  it('a task-directory (non-git) workspace never moves on an executor change', async () => {
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH R3D executor=${OLD} auditor=${AUD} workspace=dir -->`);
    await vi.waitFor(() => expect(pair('R3D').workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
    const dir = pair('R3D').workspace!.path;
    marker(BRAIN, `<!-- IMCODES_TASK REASSIGN R3D executor=${NEW} -->`);
    await taskPairService.waitForIdle();
    expect(pair('R3D').workspace).toMatchObject({ kind: 'dir', path: dir });
    expect(await rehomeTaskPairWorkspace(pair('R3D'), deps)).toEqual({ action: 'unchanged' });
  });

  it('a path outside the daemon layout (Brain named its own) stays where it is', async () => {
    await openedByOld('R4');
    const custom = join(base, 'custom', 'somewhere');
    mkdirSync(custom, { recursive: true });
    const state = { ...pair('R4'), workspace: { ...pair('R4').workspace!, path: custom }, executor: NEW };
    expect(await rehomeTaskPairWorkspace(state, deps)).toEqual({ action: 'unchanged' });
  });

  it('defers while the old or the new executor is busy, or a process still has its cwd inside; never moves mid-work', async () => {
    const oldPath = await openedByOld('R5');
    const state = { ...pair('R5'), executor: NEW };
    const busy = new Set([OLD]);
    const busyDeps: TaskPairWorkspaceDeps = { ...deps, isBusy: (name) => busy.has(name) };
    expect(await rehomeTaskPairWorkspace(state, busyDeps)).toMatchObject({ action: 'deferred', reason: 'session_busy', detail: OLD });
    busy.clear(); busy.add(NEW);
    expect(await rehomeTaskPairWorkspace(state, busyDeps)).toMatchObject({ action: 'deferred', reason: 'session_busy', detail: NEW });
    expect(await rehomeTaskPairWorkspace(state, { ...deps, hasProcessInside: async () => true })).toMatchObject({ action: 'deferred', reason: 'process_inside' });
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(pathOf(NEW, 'R5'))).toBe(false);
  });

  it('the real process probe sees a shell working inside the worktree, and lets go once it exits', async () => {
    const oldPath = await openedByOld('R6');
    const state = { ...pair('R6'), executor: NEW };
    const realProbe: TaskPairWorkspaceDeps = { env: deps.env, isBusy: () => false }; // default process probe
    const child = spawn('sleep', ['30'], { cwd: oldPath, stdio: 'ignore' });
    try {
      await vi.waitFor(async () => {
        expect(await rehomeTaskPairWorkspace(state, realProbe)).toMatchObject({ action: 'deferred', reason: 'process_inside' });
      }, { timeout: 10_000, interval: 200 });
      expect(existsSync(oldPath)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect(await rehomeTaskPairWorkspace(state, realProbe)).toMatchObject({ action: 'moved', from: oldPath, to: pathOf(NEW, 'R6') });
  });

  it('the heartbeat completes a deferred move once both sides are idle, and tells the executor and auditor the new path', async () => {
    const oldPath = await openedByOld('R7');
    let busy = true;
    setTaskPairWorkspaceDepsForTests({ ...deps, isBusy: () => busy });
    await reassignExecutor('R7');
    expect(pair('R7').workspace!.path).toBe(oldPath);
    expect(sentTo(NEW, 'pair-brief')[0]!.text).toContain(oldPath); // one authoritative path at that moment: the old one
    expect(workspaceEvents('R7').filter((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.MOVE_DEFERRED)).toHaveLength(1);
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R7');
    expect(workspaceEvents('R7').filter((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.MOVE_DEFERRED)).toHaveLength(1); // one entry, quiet retries

    busy = false;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 60_000 }); // past the one-minute retry backoff
    sent = [];
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R7');
    vi.useRealTimers();
    const newPath = pathOf(NEW, 'R7');
    expect(pair('R7').workspace).toMatchObject({ path: newPath, previousPaths: [oldPath] });
    expect(existsSync(oldPath)).toBe(false);
    expect(sentTo(NEW, 'workspace-moved')[0]!.text).toContain(newPath);
    expect(sentTo(AUD, 'workspace-moved')[0]!.text).toContain(newPath);
  });

  it('a worktree for the same task already at the target is registered as a duplicate: the recorded one stays authoritative, nothing is forked or overwritten', async () => {
    const oldPath = await openedByOld('R8');
    // The new executor's own stale copy: the same task, a different branch, uncommitted changes.
    const stale = pathOf(NEW, 'R8');
    mkdirSync(join(stale, '..'), { recursive: true });
    git(project, 'worktree', 'add', '-q', '-b', 'fix/r8-cx13', stale, 'HEAD');
    writeFileSync(join(stale, 'stale-work.txt'), 'do not lose\n');
    await reassignExecutor('R8');

    expect(pair('R8').workspace).toMatchObject({ path: oldPath, duplicatePaths: [stale] });
    expect(existsSync(oldPath)).toBe(true);
    expect(readFileSync(join(stale, 'stale-work.txt'), 'utf8')).toBe('do not lose\n');
    const brief = sentTo(NEW, 'pair-brief')[0]!.text;
    expect(brief).toContain(oldPath);
    expect(brief).toContain(`WARNING: another worktree for this task exists at ${stale}`);
    expect(sentTo(BRAIN, 'brain-workspace-duplicate')).toHaveLength(1);
    expect(workspaceEvents('R8').some((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.DUPLICATE && event.unusual)).toBe(true);
    // Idempotent: the heartbeat neither re-reports nor moves.
    sent = [];
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R8');
    expect(sentTo(BRAIN, 'brain-workspace-duplicate')).toHaveLength(0);
    expect(pair('R8').workspace!.path).toBe(oldPath);
  });

  it('a move that finished on disk but not on the pair (crash) is adopted, not redone or rebuilt', async () => {
    const oldPath = await openedByOld('R9');
    writeFileSync(join(oldPath, 'wip.txt'), 'wip\n');
    const head = git(oldPath, 'rev-parse', 'HEAD');
    // The daemon died right after `git worktree move`, before saving the pair.
    const newPath = pathOf(NEW, 'R9');
    mkdirSync(join(newPath, '..'), { recursive: true });
    git(project, 'worktree', 'move', oldPath, newPath);
    getTaskPairStore().savePair(PROJECT, { ...pair('R9'), executor: NEW });

    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R9');
    expect(pair('R9').workspace).toMatchObject({ path: newPath, previousPaths: [oldPath] });
    expect(readFileSync(join(newPath, 'wip.txt'), 'utf8')).toBe('wip\n');
    expect(git(newPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(sentTo(NEW, 'workspace-rebuilt')).toHaveLength(0);
    expect(sentTo(NEW, 'workspace-moved')[0]!.text).toContain('is now');
  });

  it('a move git refuses (locked worktree) leaves the old path authoritative, tells Brain once and backs off instead of retrying every heartbeat', async () => {
    const oldPath = await openedByOld('R12');
    git(project, 'worktree', 'lock', oldPath);
    await reassignExecutor('R12');
    expect(pair('R12').workspace!.path).toBe(oldPath);
    expect(existsSync(oldPath)).toBe(true);
    expect(sentTo(BRAIN, 'brain-workspace-move-failed')).toHaveLength(1);
    expect(sentTo(BRAIN, 'brain-workspace-move-failed')[0]!.text).toContain('stays authoritative');
    expect(workspaceEvents('R12').filter((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.MOVE_FAILED && event.unusual)).toHaveLength(1);
    // Inside the five-minute backoff the heartbeat does not touch git or Brain again.
    sent = [];
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R12');
    expect(sent).toHaveLength(0);
    expect(workspaceEvents('R12').filter((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.MOVE_FAILED)).toHaveLength(1);
    // Once unlocked (and past the backoff) the move goes through.
    git(project, 'worktree', 'unlock', oldPath);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 });
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R12');
    vi.useRealTimers();
    expect(pair('R12').workspace!.path).toBe(pathOf(NEW, 'R12'));
  });

  it('survives a daemon restart: the moved path is persisted and a second pass changes nothing', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'imcodes-reassign-db-'));
    try {
      const dbPath = join(dbDir, 'task-pairs.sqlite');
      setTaskPairStoreForTests(new TaskPairStore(dbPath));
      const oldPath = await openedByOld('R10');
      await reassignExecutor('R10');
      const newPath = pathOf(NEW, 'R10');
      expect(pair('R10').workspace!.path).toBe(newPath);
      await taskPairService.waitForIdle();
      setTaskPairStoreForTests(new TaskPairStore(dbPath)); // "restart": same file, fresh store
      expect(pair('R10').workspace).toMatchObject({ path: newPath, previousPaths: [oldPath] });
      sent = [];
      await ensureTaskPairWorkspaceAvailable(PROJECT, 'R10');
      expect(pair('R10').workspace!.path).toBe(newPath);
      expect(sent).toHaveLength(0);
    } finally {
      setTaskPairStoreForTests(new TaskPairStore(':memory:'));
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('counterexample: without any executor change nothing is touched and no extra git or event work happens', async () => {
    const oldPath = await openedByOld('R11');
    const before = workspaceEvents('R11').length;
    sent = [];
    await ensureTaskPairWorkspaceAvailable(PROJECT, 'R11');
    await taskPairService.settleWorkspaceOwner(PROJECT, 'R11', { notify: true });
    expect(pair('R11').workspace!.path).toBe(oldPath);
    expect(pair('R11').workspace!.previousPaths).toBeUndefined();
    expect(workspaceEvents('R11')).toHaveLength(before);
    expect(sent).toHaveLength(0);
  });
});

describe('redirectTaskPairWorkspacePath', () => {
  const workspace = { path: '/w/new/repo', previousPaths: ['/w/old/repo'] };
  it('maps the old path, and paths inside it, onto the current workspace', () => {
    expect(redirectTaskPairWorkspacePath(workspace, '/w/old/repo')).toBe('/w/new/repo');
    expect(redirectTaskPairWorkspacePath(workspace, '/w/old/repo/')).toBe('/w/new/repo');
    expect(redirectTaskPairWorkspacePath(workspace, '/w/old/repo/src/a.ts')).toBe('/w/new/repo/src/a.ts');
  });
  it('leaves unrelated paths alone, including a sibling that merely shares the prefix', () => {
    expect(redirectTaskPairWorkspacePath(workspace, '/w/old/repo2')).toBe('/w/old/repo2');
    expect(redirectTaskPairWorkspacePath(workspace, '/w/other/repo')).toBe('/w/other/repo');
    expect(redirectTaskPairWorkspacePath({ path: '/w/new/repo' }, '/w/old/repo')).toBe('/w/old/repo');
    expect(redirectTaskPairWorkspacePath(undefined, '/w/old/repo')).toBe('/w/old/repo');
    expect(redirectTaskPairWorkspacePath(workspace, '')).toBe('');
  });
  it('handles Windows paths: backslashes, mixed separators and drive-letter case', () => {
    const win = { path: 'C:\\Users\\k\\.imcodes\\worktrees\\imcodes\\new\\pair_t\\repo', previousPaths: ['C:\\Users\\k\\.imcodes\\worktrees\\imcodes\\old\\pair_t\\repo'] };
    expect(redirectTaskPairWorkspacePath(win, 'c:/users/k/.imcodes/worktrees/imcodes/old/pair_t/repo')).toBe(win.path);
    expect(redirectTaskPairWorkspacePath(win, 'C:\\Users\\k\\.imcodes\\worktrees\\imcodes\\old\\pair_t\\repo\\src\\a.ts'))
      .toBe('C:\\Users\\k\\.imcodes\\worktrees\\imcodes\\new\\pair_t\\repo\\src\\a.ts');
  });
});
