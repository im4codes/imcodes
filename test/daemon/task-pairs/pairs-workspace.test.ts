/**
 * Pair workspace lifecycle (owner requirements):
 * - a code task in a git project gets a daemon-created worktree under
 *   ~/.imcodes/worktrees, registered with the worktree GC; a non-git project
 *   (or `workspace=dir`) gets a task directory under ~/.imcodes/works/<project>/
 *   <taskId>/ and is never git-initialised; the path goes to the executor at
 *   dispatch and to the auditor at READY_FOR_AUDIT (no HEAD for a directory);
 * - when the pair ends (DONE, CANCEL, DONE force=true) the workspace is kept
 *   for 7 days, then removed -- a worktree with uncommitted or unpushed work is
 *   kept and Brain is told;
 * - DONE output=<path> copies the deliverable into the project directory and
 *   tells the user where; plain DONE copies nothing.
 *
 * Real git and real directories throughout, under temporary roots standing in
 * for ~/.imcodes/worktrees and ~/.imcodes/works.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { setTaskPairMaterialDepsForTests } from '../../../src/daemon/task-pairs/material.js';
import { ensureTaskPairWorkspaceAvailable, refreshTaskPairWorkspaceHead, taskPairService } from '../../../src/daemon/task-pairs/service.js';
import {
  releaseTaskPairWorkspace,
  provisionTaskPairWorkspace,
  resolveTaskPairTaskDir,
  resolveTaskPairWorksRoot,
  setTaskPairWorkspaceDepsForTests,
  taskPairWorktreeName,
} from '../../../src/daemon/task-pairs/workspace.js';
import { runSupervisionWorktreeGc, SUPERVISION_WORKTREE_GC_REASONS } from '../../../src/daemon/supervision-worktree-gc.js';
import { createSupervisionWorktreeGcDeps } from '../../../src/daemon/supervision-registry-port.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import {
  TASK_PAIR_TIMELINE_EVENT,
  TASK_PAIR_WORKS_DIR,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_RETENTION_MS,
  TASK_PAIR_WORKSPACE_RULES,
  buildTaskPairMarkerContract,
  type TaskPairState,
} from '../../../shared/task-pair.js';

const PROJECT = 'wtproj';
const BRAIN = 'deck_wtproj_brain';
const EXEC = 'deck_sub_wtexec';
const AUD = 'deck_sub_wtaud';
const MINUTE = 60_000;

let base = '';
let project = '';
let worktreesRoot = '';
let worksRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function session(name: string, role: SessionRecord['role'], projectDir: string): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function useProject(dir: string) {
  for (const record of [session(BRAIN, 'brain', dir), session(EXEC, 'w1', dir), session(AUD, 'w2', dir)]) upsertSession(record);
}
function marker(writer: string, line: string) {
  turn += 1;
  return taskPairService.ingestText(PROJECT, writer, line, `wt-turn-${turn}`);
}
function pair(taskId: string): TaskPairState {
  return getTaskPairStore().getPair(PROJECT, taskId)!.state;
}
async function opened(taskId: string, attrs = `auditor=${AUD}`): Promise<string> {
  marker(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${EXEC} ${attrs} -->`);
  await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 15_000, interval: 50 });
  return pair(taskId).workspace!.path;
}
async function endedAt(taskId: string): Promise<number> {
  await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('ended'), { timeout: 15_000, interval: 50 });
  return pair(taskId).workspace!.endedAt!;
}
/** Move a pair's end back in time (the worktree GC reads the wall clock). */
function backdate(taskId: string, ms: number) {
  const state = pair(taskId);
  getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, endedAt: state.workspace!.endedAt! - ms } });
}
function sentTo(target: string, reason: string) {
  return sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));
}
function workspaceEvents(taskId: string) {
  return getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB);
}
function listedWorktrees(): string[] {
  return git(project, 'worktree', 'list', '--porcelain').split('\n')
    .filter((line) => line.startsWith('worktree ')).map((line) => realpathSync(line.slice('worktree '.length)));
}
const gcDryRun = () => runSupervisionWorktreeGc({ projectName: PROJECT, mode: 'dryRun', worktreesRoot }, createSupervisionWorktreeGcDeps());

describe('pair workspaces', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-pair-ws-')));
    project = join(base, 'project');
    worktreesRoot = join(base, 'worktrees');
    worksRoot = join(base, TASK_PAIR_WORKS_DIR);
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
    git(project, 'fetch', '-q', 'origin');
    setTaskPairWorkspaceDepsForTests({ env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot } });
    useProject(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Markers fired through marker()/ingestText in this suite start
    // background work (workspace provisioning, briefs, head refreshes) that
    // this file never subscribes/disposes for -- wait for it before the
    // store underneath it closes, or a late write throws against an
    // already-closed database (the original tsk_cd_pairs_bg_drain report).
    await taskPairService.waitForIdle();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairMaterialDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('puts task directories under ~/.imcodes/works/<project>/<taskId>/ by default', () => {
    expect(TASK_PAIR_WORKS_DIR).toBe('works');
    const env = { HOME: '/home/someone' } as NodeJS.ProcessEnv;
    expect(resolveTaskPairWorksRoot({})).toMatch(/[/\\]\.imcodes[/\\]works$/);
    expect(resolveTaskPairTaskDir('proj', 'T1', env)).toMatch(/[/\\]\.imcodes[/\\]works[/\\]proj[/\\]T1$/);
    expect(resolveTaskPairTaskDir('proj', 'T1', { IMCODES_WORKS_ROOT: '/x/works' } as NodeJS.ProcessEnv)).toBe(join('/x/works', 'proj', 'T1'));
    // One rules text, carried by the contract and the executor brief.
    expect(buildTaskPairMarkerContract()).toContain(TASK_PAIR_WORKSPACE_RULES);
  });

  it('git project: creates the executor worktree, registers it with git and the GC, and hands its path over', async () => {
    const path = await opened('W1');
    expect(path).toBe(join(worktreesRoot, 'imcodes', EXEC, taskPairWorktreeName('W1'), 'repo'));
    expect(listedWorktrees()).toContain(realpathSync(path));
    const metadata = JSON.parse(readFileSync(join(path, '..', 'metadata.json'), 'utf8')) as Record<string, string>;
    expect(metadata).toMatchObject({ taskId: 'W1', assignmentId: taskPairWorktreeName('W1'), sessionName: EXEC, repoPath: path });
    expect(pair('W1').workspace).toMatchObject({ kind: 'worktree', path, base: git(project, 'rev-parse', 'HEAD'), status: 'active' });

    await vi.waitFor(() => expect(sentTo(EXEC, 'pair-brief')).toHaveLength(1));
    const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
    expect(brief).toContain(`Work in the worktree the daemon created for this pair: ${path}`);
    expect(brief).toContain(TASK_PAIR_WORKSPACE_RULES);
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT W1 -->');
    await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 10_000 });
    expect(sentTo(AUD, 'audit-request')[0]!.text).toContain(`worktree ${path} · head ${git(path, 'rev-parse', 'HEAD')}`);

    const gc = await gcDryRun();
    expect(gc.entries).toEqual([expect.objectContaining({ taskId: 'W1', action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE })]);
  });

  it('non-git project: allocates a task directory under the works root, never git-inits the project, and delivers the path', async () => {
    const plain = join(base, 'plain-project');
    mkdirSync(plain);
    writeFileSync(join(plain, 'notes.txt'), 'input\n');
    useProject(plain);
    const dir = await opened('D1');
    expect(dir).toBe(join(worksRoot, PROJECT, 'D1'));
    expect(pair('D1').workspace).toMatchObject({ kind: 'dir', status: 'active' });
    expect(pair('D1').workspace?.base).toBeUndefined();
    expect(existsSync(join(plain, '.git'))).toBe(false);
    expect(existsSync(worktreesRoot)).toBe(false);

    await vi.waitFor(() => expect(sentTo(EXEC, 'pair-brief')).toHaveLength(1));
    const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
    expect(brief).toContain(`Work in the task directory the daemon created for this pair: ${dir}`);
    // Its own READY instruction names a path, never a head.
    expect(brief).toContain('write <!-- IMCODES_TASK READY_FOR_AUDIT D1 path=<the task directory or the result files> -->');
    expect(brief).not.toContain('READY_FOR_AUDIT D1 worktree=');

    // READY_FOR_AUDIT without a path: the daemon names the directory, no HEAD.
    marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT D1 -->');
    await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 10_000 });
    const request = sentTo(AUD, 'audit-request')[0]!.text;
    expect(request).toContain(`Material: task directory ${dir}.`);
    expect(request).not.toMatch(/head [0-9a-f]{7}/);
    // With a path, the executor's own path is relayed.
    marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT D1 path=${join(dir, 'report.md')} -->`);
    await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(2), { timeout: 10_000 });
    expect(sentTo(AUD, 'audit-request')[1]!.text).toContain(`Material: task directory ${join(dir, 'report.md')}.`);
  });

  it('git project with workspace=dir: non-code work gets a task directory, not a worktree', async () => {
    const dir = await opened('D2', `auditor=${AUD} workspace=dir`);
    expect(dir).toBe(join(worksRoot, PROJECT, 'D2'));
    expect(pair('D2').workspace?.kind).toBe('dir');
    expect(listedWorktrees()).toEqual([realpathSync(project)]);
  });

  for (const [label, end] of [
    ['DONE after PASS', (id: string) => {
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT ${id} -->`);
      marker(AUD, `<!-- IMCODES_TASK PASS ${id} blocking=P0 -->`);
      marker(EXEC, `<!-- IMCODES_TASK DONE ${id} -->`);
    }],
    ['CANCEL', (id: string) => marker(BRAIN, `<!-- IMCODES_TASK CANCEL ${id} -->`)],
    ['Brain DONE force=true', (id: string) => marker(BRAIN, `<!-- IMCODES_TASK DONE ${id} force=true -->`)],
  ] as const) {
    it(`keeps a clean worktree for 7 days after ${label}, then removes it (sweep and GC agree)`, async () => {
      const taskId = `W-${label.split(' ')[0]}`;
      const path = await opened(taskId);
      end(taskId);
      const at = await endedAt(taskId);
      expect(existsSync(path)).toBe(true);

      // Not before: one minute short of the retention nothing is removed.
      await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS - MINUTE, { force: true });
      expect(pair(taskId).workspace?.status).toBe('ended');
      expect(existsSync(path)).toBe(true);
      const early = await gcDryRun();
      expect(early.entries).toEqual([expect.objectContaining({ taskId, action: 'retain', reason: SUPERVISION_WORKTREE_GC_REASONS.ACTIVE_REFERENCE, detail: 'pair_retention' })]);

      await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
      expect(pair(taskId).workspace?.status).toBe('removed');
      expect(existsSync(join(path, '..'))).toBe(false);
      expect(listedWorktrees()).not.toContain(path);
      expect(workspaceEvents(taskId)).toEqual([expect.objectContaining({ effect: TASK_PAIR_WORKSPACE_EFFECTS.REMOVED })]);
    });
  }

  it('removes a task directory 7 days after the pair ends, and not before', async () => {
    const plain = join(base, 'plain-project');
    mkdirSync(plain);
    useProject(plain);
    const dir = await opened('D3');
    writeFileSync(join(dir, 'scratch.txt'), 'temporary\n');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL D3 -->');
    const at = await endedAt('D3');
    await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS - MINUTE, { force: true });
    expect(existsSync(join(dir, 'scratch.txt'))).toBe(true);
    await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(existsSync(dir)).toBe(false);
    expect(pair('D3').workspace?.status).toBe('removed');
  });

  it('resets the retention clock when a terminal pair is reopened and ends again', async () => {
    const plain = join(base, 'plain-project');
    mkdirSync(plain);
    useProject(plain);
    const dir = await opened('REOPEN', 'auditor=none');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL REOPEN -->');
    const firstEnd = await endedAt('REOPEN');
    expect(pair('REOPEN').workspace).toMatchObject({ status: 'ended', endedAt: firstEnd });

    // A Brain DISPATCH marker is the supported way to reopen a cancelled pair.
    // It changes the terminal status directly and does not call ensureWorkspace
    // (the slot_changed intent only runs the queue), so marker ingestion itself
    // must clear the old endedAt before the next termination.
    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH REOPEN executor=${EXEC} auditor=none -->`);
    await vi.waitFor(() => expect(pair('REOPEN').workspace?.status).toBe('active'));
    expect(pair('REOPEN').workspace?.endedAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 2));
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL REOPEN -->');
    const secondEnd = await endedAt('REOPEN');
    expect(secondEnd).toBeGreaterThan(firstEnd);
    expect(pair('REOPEN').workspace?.endedAt).toBe(secondEnd);
    expect(existsSync(dir)).toBe(true);
    await taskPairService.sweepWorkspaces(firstEnd + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(pair('REOPEN').workspace?.status).toBe('ended');
    expect(existsSync(dir)).toBe(true);
    await taskPairService.sweepWorkspaces(secondEnd + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(pair('REOPEN').workspace?.status).toBe('removed');
  });

  it('does not remove a workspace when its last-moment ownership check observes a reopen', async () => {
    const plain = join(base, 'plain-project');
    mkdirSync(plain);
    useProject(plain);
    const dir = await opened('RACE', 'auditor=none');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL RACE -->');
    const at = await endedAt('RACE');
    const state = pair('RACE');
    const result = await releaseTaskPairWorkspace(state, {
      beforeRemove: () => {
        // Model the reopen winning the race immediately before rm().
        getTaskPairStore().savePair(PROJECT, {
          ...state,
          status: 'working',
          workspace: { ...state.workspace!, status: 'active', endedAt: undefined },
        });
        return false;
      },
    });
    expect(result).toEqual({ action: 'skipped' });
    expect(existsSync(dir)).toBe(true);
    expect(pair('RACE').workspace?.status).toBe('active');
    // Keep the fixture's state coherent for teardown and prove a valid old
    // terminal workspace is still removable after the reopen has ended it.
    getTaskPairStore().savePair(PROJECT, {
      ...pair('RACE'),
      status: 'cancelled',
      workspace: { ...pair('RACE').workspace!, status: 'ended', endedAt: at },
    });
    await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(pair('RACE').workspace?.status).toBe('removed');
  });

  it('in a project without a remote, removes a clean worktree at its base and keeps one with an executor commit', async () => {
    git(project, 'remote', 'remove', 'origin');
    const cleanPath = await opened('N1');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL N1 -->');
    const cleanEnd = await endedAt('N1');
    await taskPairService.sweepWorkspaces(cleanEnd + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(existsSync(join(cleanPath, '..'))).toBe(false);

    const workPath = await opened('N2');
    writeFileSync(join(workPath, 'work.txt'), 'done\n');
    git(workPath, 'add', '-A');
    git(workPath, '-c', 'user.email=t@e.invalid', '-c', 'user.name=T', 'commit', '-qm', 'work');
    marker(BRAIN, '<!-- IMCODES_TASK DONE N2 force=true -->');
    const workEnd = await endedAt('N2');
    await taskPairService.sweepWorkspaces(workEnd + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(pair('N2').workspace).toMatchObject({ status: 'kept', keptReason: 'unpushed' });
  });

  it('keeps a worktree with uncommitted or unpushed work after the retention, tells Brain once, and the GC reclaims it once saved', async () => {
    const dirtyPath = await opened('K1');
    writeFileSync(join(dirtyPath, 'wip.txt'), 'unsaved\n');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL K1 -->');
    const unpushedPath = await opened('K2');
    writeFileSync(join(unpushedPath, 'feature.txt'), 'done\n');
    git(unpushedPath, 'add', '-A');
    git(unpushedPath, '-c', 'user.email=t@e.invalid', '-c', 'user.name=T', 'commit', '-qm', 'feature');
    marker(BRAIN, '<!-- IMCODES_TASK DONE K2 force=true -->');
    const at = Math.max(await endedAt('K1'), await endedAt('K2'));

    await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS, { force: true });
    expect(pair('K1').workspace).toMatchObject({ status: 'kept', keptReason: 'untracked' });
    expect(pair('K2').workspace).toMatchObject({ status: 'kept', keptReason: 'unpushed' });
    expect(existsSync(join(dirtyPath, 'wip.txt'))).toBe(true);
    await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-workspace-kept')).toHaveLength(2));
    expect(sentTo(BRAIN, 'brain-workspace-kept').map((entry) => entry.text).join('\n')).toContain('has untracked files, so it was kept instead of deleted');
    // A later sweep retries silently.
    await taskPairService.sweepWorkspaces(at + TASK_PAIR_WORKSPACE_RETENTION_MS + MINUTE, { force: true });
    expect(sentTo(BRAIN, 'brain-workspace-kept')).toHaveLength(2);

    // The worktree GC backstop agrees once the retention has passed on the wall clock.
    backdate('K1', TASK_PAIR_WORKSPACE_RETENTION_MS);
    backdate('K2', TASK_PAIR_WORKSPACE_RETENTION_MS);
    const deps = createSupervisionWorktreeGcDeps();
    const before = await runSupervisionWorktreeGc({ projectName: PROJECT, mode: 'apply', worktreesRoot }, deps);
    expect(before.entries.map((entry) => [entry.taskId, entry.action, entry.reason]).sort()).toEqual([
      ['K1', 'retain', SUPERVISION_WORKTREE_GC_REASONS.UNTRACKED],
      ['K2', 'retain', SUPERVISION_WORKTREE_GC_REASONS.UNPUSHED_BRANCH],
    ]);
    git(dirtyPath, 'add', '-A');
    git(dirtyPath, '-c', 'user.email=t@e.invalid', '-c', 'user.name=T', 'commit', '-qm', 'wip');
    git(dirtyPath, 'push', '-q', 'origin', 'HEAD:refs/heads/k1');
    git(dirtyPath, 'fetch', '-q', 'origin');
    git(unpushedPath, 'push', '-q', 'origin', 'HEAD:refs/heads/k2');
    git(unpushedPath, 'fetch', '-q', 'origin');
    const after = await runSupervisionWorktreeGc({ projectName: PROJECT, mode: 'apply', worktreesRoot }, deps);
    expect(after.deleted, JSON.stringify(after.entries)).toBe(2);
    expect(existsSync(join(dirtyPath, '..'))).toBe(false);
    expect(existsSync(join(unpushedPath, '..'))).toBe(false);
  });

  it('Brain re-dispatching a cancelled pair reuses the same worktree, never resetting or recreating it', async () => {
    const path = await opened('REQ1');
    writeFileSync(join(path, 'in-progress.txt'), 'not yet committed\n');
    marker(BRAIN, '<!-- IMCODES_TASK CANCEL REQ1 -->');
    await vi.waitFor(() => expect(pair('REQ1').workspace?.status).toBe('ended'));
    expect(pair('REQ1').status).toBe('cancelled');
    expect(existsSync(join(path, 'in-progress.txt'))).toBe(true);

    // A participant marker must not revive it (see the shared-level test for
    // the full class); only the Brain's own DISPATCH does.
    marker(EXEC, '<!-- IMCODES_TASK STARTED REQ1 -->');
    expect(pair('REQ1').status).toBe('cancelled');

    marker(BRAIN, `<!-- IMCODES_TASK DISPATCH REQ1 executor=${EXEC} auditor=${AUD} -->`);
    await vi.waitFor(() => expect(pair('REQ1').workspace?.status).toBe('active'));
    expect(pair('REQ1').workspace?.path).toBe(path);
    // The file from before the cancel is still there: reopening reused the
    // same worktree instead of provisioning a fresh one.
    expect(existsSync(join(path, 'in-progress.txt'))).toBe(true);
  });

  describe('self-heal: rebuild order, first that resolves', () => {
    const commitOn = (repo: string, file: string, message: string) => {
      writeFileSync(join(repo, file), `${message}\n`);
      git(repo, 'add', '-A');
      git(repo, '-c', 'user.email=t@e.invalid', '-c', 'user.name=T', 'commit', '-qm', message);
      return git(repo, 'rev-parse', 'HEAD');
    };

    it('rebuilds from the existing branch first, preserving its commits and re-attaching (not detached)', async () => {
      const path = await opened('R1');
      // Provisioning itself always starts detached; the branch this step
      // resolves is one the executor created themselves during their work,
      // a normal git workflow.
      const branch = 'r1-work';
      git(path, 'checkout', '-qb', branch);
      const branchHead = commitOn(path, 'work.txt', 'executor work');
      const state = pair('R1');
      getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, branch } });

      rmSync(path, { recursive: true, force: true });
      const provision = await provisionTaskPairWorkspace(PROJECT, pair('R1'));
      expect(provision).toMatchObject({ ok: true, source: 'branch', path });
      expect(git(path, 'rev-parse', 'HEAD')).toBe(branchHead);
      // Re-attached to the branch, not left detached.
      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
    });

    it('falls back to lastHead when the recorded branch no longer resolves', async () => {
      const path = await opened('R2');
      const midCommit = commitOn(path, 'a.txt', 'a');
      commitOn(path, 'b.txt', 'b');
      rmSync(path, { recursive: true, force: true });
      const state = pair('R2');
      getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, branch: 'no-such-branch-xyz', lastHead: midCommit } });

      const provision = await provisionTaskPairWorkspace(PROJECT, pair('R2'));
      expect(provision).toMatchObject({ ok: true, source: 'lastHead', path });
      expect(git(path, 'rev-parse', 'HEAD')).toBe(midCommit);
      // Detached at that commit, not on the (nonexistent) branch.
      expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    });

    it("falls back to material.head when neither branch nor lastHead resolve", async () => {
      const path = await opened('R3');
      const materialHead = commitOn(project, 'later.txt', 'later on project');
      rmSync(path, { recursive: true, force: true });
      const state = pair('R3');
      getTaskPairStore().savePair(PROJECT, {
        ...state,
        workspace: { ...state.workspace!, branch: undefined, lastHead: undefined },
        material: { head: materialHead, at: Date.now() },
      });

      const provision = await provisionTaskPairWorkspace(PROJECT, pair('R3'));
      expect(provision).toMatchObject({ ok: true, source: 'materialHead', path });
      expect(git(path, 'rev-parse', 'HEAD')).toBe(materialHead);
    });

    it('falls back to the recorded base when no branch, lastHead, or material.head resolve', async () => {
      const path = await opened('R4');
      const base = pair('R4').workspace!.base!;
      rmSync(path, { recursive: true, force: true });
      const state = pair('R4');
      getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, branch: undefined, lastHead: undefined, base } });

      const provision = await provisionTaskPairWorkspace(PROJECT, pair('R4'));
      expect(provision).toMatchObject({ ok: true, source: 'base', path });
      expect(git(path, 'rev-parse', 'HEAD')).toBe(base);
    });

    it("falls back to the project's default branch (HEAD) as the last resort", async () => {
      const path = await opened('R5');
      rmSync(path, { recursive: true, force: true });
      const state = pair('R5');
      getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, branch: undefined, lastHead: undefined, base: undefined } });
      const projectHead = git(project, 'rev-parse', 'HEAD');

      const provision = await provisionTaskPairWorkspace(PROJECT, pair('R5'));
      expect(provision).toMatchObject({ ok: true, source: 'default', path });
      expect(git(path, 'rev-parse', 'HEAD')).toBe(projectHead);
    });

    it('the rebuild notice names the source actually used, not the one that merely looked present', async () => {
      const path = await opened('R6');
      const lastHead = commitOn(path, 'x.txt', 'x');
      rmSync(path, { recursive: true, force: true });
      const state = pair('R6');
      // A branch name that looks set but no longer resolves -- the pre-fix
      // notice logic labelled this 'branch' on truthiness alone, even though
      // provisioning never actually used it.
      getTaskPairStore().savePair(PROJECT, { ...state, workspace: { ...state.workspace!, branch: 'stale-branch-gone', lastHead } });

      await ensureTaskPairWorkspaceAvailable(PROJECT, 'R6');
      expect(pair('R6').workspace).toMatchObject({ status: 'active', path });
      await vi.waitFor(() => expect(sentTo(EXEC, 'workspace-rebuilt')).toHaveLength(1));
      const notice = sentTo(EXEC, 'workspace-rebuilt')[0]!.text;
      expect(notice).toContain('the last observed head');
      expect(notice).not.toContain('its own branch');
      await vi.waitFor(() => expect(sentTo(AUD, 'workspace-rebuilt')).toHaveLength(1));
    });

    it('escalates to Brain exactly once, after delivery, when the workspace cannot be rebuilt at all', async () => {
      const path = await opened('R7');
      rmSync(path, { recursive: true, force: true });
      // The project checkout itself is gone -- nothing to provision from at all.
      rmSync(project, { recursive: true, force: true });

      await ensureTaskPairWorkspaceAvailable(PROJECT, 'R7');
      await ensureTaskPairWorkspaceAvailable(PROJECT, 'R7');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-workspace-unrecoverable')).toHaveLength(1));
      expect(pair('R7').workspaceRecoveryEscalatedAt).toBeTruthy();
    });
  });

  it('refreshTaskPairWorkspaceHead never rejects when the store closes mid-flight (a fire-and-forget call, not awaited by its caller)', async () => {
    await opened('R8');
    const refresh = refreshTaskPairWorkspaceHead(PROJECT, 'R8');
    // Race the real `git rev-parse HEAD` subprocess this kicks off: swap in a
    // fresh store (which closes the old one) before it can resolve, exactly
    // like afterEach does while a background refresh from a prior test is
    // still in flight.
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    await expect(refresh).resolves.toBeUndefined();
  });

  it('tracks applyMarker\'s refreshTaskPairWorkspaceHead call so it can be drained deterministically, not just relying on its own try/catch', async () => {
    // The test above pins that the function itself never rejects. This pins
    // the other half of the original tsk_cd_pairs_bg_drain report: applyMarker
    // starts it via a bare, untracked call, so nothing could ever wait for it
    // -- a test (or daemon shutdown) that closes the store right after a
    // marker has no way to know this write is still coming. #track fixes
    // that; this proves it deterministically, not by racing a real git
    // subprocess against machine load.
    await opened('R9');
    // WORKING on an already-working pair is a plain status echo: it produces
    // no intents (unlike READY_FOR_AUDIT's audit_request, which would also
    // call resolveTaskPairMaterial via #executeIntents and confound which
    // tracked call is actually being observed here).
    const resolvers: Array<(head: string | undefined) => void> = [];
    setTaskPairMaterialDepsForTests({
      gitHead: () => new Promise((resolve) => { resolvers.push(resolve); }),
    });

    marker(EXEC, '<!-- IMCODES_TASK WORKING R9 -->');
    // Let #executeIntents([]) -- tracked for every marker regardless of
    // whether it has any intents to run -- settle its own trivial promise, so
    // the only thing that could still be keeping pendingCount above zero here
    // is refreshTaskPairWorkspaceHead's real, still-in-flight gitHead await.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(taskPairService.pendingCount).toBeGreaterThan(0);

    for (const resolve of resolvers) resolve('deadbeefcafefeed0000000000000000000000');
    await taskPairService.waitForIdle();

    expect(taskPairService.pendingCount).toBe(0);
    expect(pair('R9').workspace?.lastHead).toBe('deadbeefcafefeed0000000000000000000000');
  });

  describe('deliverables', () => {
    let plain = '';
    let timeline: Array<{ session: string; payload: Record<string, unknown> }>;

    beforeEach(() => {
      plain = join(base, 'plain-project');
      mkdirSync(plain);
      useProject(plain);
      timeline = [];
      const emit = timelineEmitter.emit.bind(timelineEmitter);
      vi.spyOn(timelineEmitter, 'emit').mockImplementation(((session: string, type: string, payload: Record<string, unknown>, options?: never) => {
        if (type === TASK_PAIR_TIMELINE_EVENT) timeline.push({ session, payload });
        return emit(session, type as never, payload, options);
      }) as typeof timelineEmitter.emit);
    });

    const outputEvents = () => timeline.filter((entry) => entry.payload.verb === TASK_PAIR_WORKSPACE_EVENT_VERB);

    it('copies the deliverable named on DONE into the project directory and tells the user where', async () => {
      const dir = await opened('O1', 'auditor=none');
      mkdirSync(join(dir, 'reports'));
      writeFileSync(join(dir, 'reports', 'summary.md'), '# result\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O1 output=reports/summary.md -->');
      const dest = join(realpathSync(plain), 'reports', 'summary.md');
      await vi.waitFor(() => expect(existsSync(dest)).toBe(true), { timeout: 10_000 });
      expect(readFileSync(dest, 'utf8')).toBe('# result\n');
      expect(existsSync(join(dir, 'reports', 'summary.md'))).toBe(true);
      await vi.waitFor(() => expect(outputEvents().map((entry) => entry.session)).toContain(BRAIN));
      expect(outputEvents().find((entry) => entry.session === BRAIN)!.payload).toMatchObject({
        effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED, outputPath: dest,
      });
      expect(workspaceEvents('O1')).toEqual([expect.objectContaining({ effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED, attrs: expect.objectContaining({ dest }) })]);
    });

    it('honours dest= and never overwrites an existing file', async () => {
      writeFileSync(join(plain, 'final.md'), 'the user\'s own file\n');
      const dir = await opened('O2', 'auditor=none');
      writeFileSync(join(dir, 'draft.md'), 'new\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O2 output=draft.md dest=final.md -->');
      const dest = join(realpathSync(plain), 'final.O2.md');
      await vi.waitFor(() => expect(existsSync(dest)).toBe(true), { timeout: 10_000 });
      expect(readFileSync(join(plain, 'final.md'), 'utf8')).toBe('the user\'s own file\n');
      expect(readFileSync(dest, 'utf8')).toBe('new\n');
    });

    it('refuses an output outside the workspace or a destination outside the project, and tells Brain', async () => {
      writeFileSync(join(base, 'secret.txt'), 'x\n');
      await opened('O3', 'auditor=none');
      marker(EXEC, '<!-- IMCODES_TASK DONE O3 output=../../../secret.txt -->');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-output-failed')).toHaveLength(1), { timeout: 10_000 });
      expect(workspaceEvents('O3')).toEqual([expect.objectContaining({ effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED, attrs: expect.objectContaining({ reason: 'outside_workspace' }) })]);

      const dir = await opened('O4', 'auditor=none');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O4 output=a.txt dest=../escaped.txt -->');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-output-failed')).toHaveLength(2), { timeout: 10_000 });
      expect(existsSync(join(base, 'escaped.txt'))).toBe(false);
      expect(workspaceEvents('O4')).toEqual([expect.objectContaining({ attrs: expect.objectContaining({ reason: 'outside_project' }) })]);
    });

    it('refuses a destination whose existing parent symlink escapes the project', async () => {
      const outside = join(base, 'outside');
      mkdirSync(outside);
      const link = join(plain, 'linked');
      try {
        await import('node:fs/promises').then(({ symlink }) => symlink(outside, link, 'dir'));
      } catch {
        return;
      }
      const dir = await opened('O-SYMLINK', 'auditor=none');
      writeFileSync(join(dir, 'draft.md'), 'must stay in workspace\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O-SYMLINK output=draft.md dest=linked/escaped.md -->');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-output-failed')).toHaveLength(1), { timeout: 10_000 });
      expect(existsSync(join(outside, 'escaped.md'))).toBe(false);
      expect(workspaceEvents('O-SYMLINK')).toEqual([expect.objectContaining({
        effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED,
        attrs: expect.objectContaining({ reason: 'outside_project' }),
      })]);
    });

    it('copies nothing for temporary work (plain DONE, or CANCEL)', async () => {
      const dir = await opened('O5', 'auditor=none');
      writeFileSync(join(dir, 'scratch.md'), 'temp\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O5 -->');
      await endedAt('O5');
      // An output named on an early DONE (no PASS yet) is dropped when the pair is cancelled.
      const cancelled = await opened('O6', `auditor=${AUD}`);
      writeFileSync(join(cancelled, 'x.md'), 'x\n');
      marker(EXEC, '<!-- IMCODES_TASK DONE O6 output=x.md -->');
      expect(pair('O6')).toMatchObject({ status: 'awaiting_audit', output: { path: 'x.md' } });
      marker(BRAIN, '<!-- IMCODES_TASK CANCEL O6 -->');
      await endedAt('O6');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(workspaceEvents('O5')).toEqual([]);
      expect(workspaceEvents('O6')).toEqual([]);
      expect(outputEvents()).toEqual([]);
      expect(existsSync(join(plain, 'scratch.md'))).toBe(false);
      expect(existsSync(join(plain, 'x.md'))).toBe(false);
    });
  });
});
