/**
 * Pairs on a project that is not a git repository (tsk_cd_non_git_pair_workspace), through real marker ingestion, real git and
 * real files: git init first (worktree flow + merge at DONE), then the COW-clone and in-place fallbacks.
 */
import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { resetTaskPairFocusForTests, setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { setTaskPairMaterialDepsForTests } from '../../../src/daemon/task-pairs/material.js';
import { setRebaseRevertGuardDepsForTests } from '../../../src/daemon/task-pairs/rebase-revert-guard.js';
import { taskPairService, type TaskPairScheduler } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setTaskPairWorkspaceDepsForTests, type TaskPairWorkspaceDeps } from '../../../src/daemon/task-pairs/workspace.js';
import {
  TASK_PAIR_GIT_INIT_ENABLE_ENV,
  TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_RULES,
  type TaskPairState,
} from '../../../shared/task-pair.js';

const PROJECT = 'ngproj';
const BRAIN = 'deck_ngproj_brain';
const EXEC = 'deck_sub_ngexec';
const AUD = 'deck_sub_ngaud';
const EXEC2 = 'deck_sub_ngexec2';
const AUD2 = 'deck_sub_ngaud2';

let base = '';
let plain = '';
let worktreesRoot = '';
let worksRoot = '';
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;
let deps: TaskPairWorkspaceDeps;
const saved: Record<string, string | undefined> = {};
/** The workspace code reads its environment from the injected deps (like production reads process.env): set both. */
const setEnv = (key: string, value: string) => { process.env[key] = value; deps.env![key] = value; };

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const plainCopy = (from: string, to: string) => copyFile(from, to);
const readdirSyncSafe = (dir: string) => readdirSync(dir).filter((name) => !name.startsWith('.'));
const noClone = async () => { throw Object.assign(new Error('no cow'), { code: 'ENOTSUP' }); };

function session(name: string, role: SessionRecord['role'], projectDir: string): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'codex-sdk', projectDir, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}
function useProject(dir: string, executor = EXEC, auditor = AUD) {
  for (const record of [session(BRAIN, 'brain', dir), session(executor, 'w1', dir), session(auditor, 'w2', dir)]) upsertSession(record);
}
const marker = (writer: string, line: string) => { turn += 1; return taskPairService.ingestText(PROJECT, writer, line, `ng-turn-${turn}`); };
const pair = (taskId: string): TaskPairState => getTaskPairStore().getPair(PROJECT, taskId)!.state;
const sentTo = (target: string, reason: string) => sent.filter((entry) => entry.target === target && entry.id.includes(`:${reason}:`));
const workspaceEvents = (taskId: string) => getTaskPairStore().listEvents(PROJECT, taskId).filter((event) => event.verb === TASK_PAIR_WORKSPACE_EVENT_VERB);
const writeFile = (root: string, rel: string, content: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), content); };

const testScheduler: TaskPairScheduler = {
  async onIntent(project, pairState, intent) {
    if (intent.kind !== 'slot_changed') return;
    if (pairState.status !== 'queued' || !pairState.executor || pairState.auditor === undefined) return;
    taskPairService.applyMarker({
      project, writer: 'daemon',
      marker: { verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: pairState.taskId, attrs: { executor: pairState.executor, auditor: pairState.auditor } },
      source: 'queue', now: Date.now(), eventId: `test-queue-drain:${pairState.taskId}:${Date.now()}:${Math.random()}`,
    });
    await taskPairService.briefParticipants(project, pairState.taskId);
  },
};

async function opened(taskId: string, attrs = `auditor=${AUD}`, executor = EXEC): Promise<TaskPairState> {
  marker(BRAIN, `<!-- IMCODES_TASK DISPATCH ${taskId} executor=${executor} ${attrs} -->`);
  await vi.waitFor(() => expect(pair(taskId).workspace?.status).toBe('active'), { timeout: 20_000, interval: 50 });
  await taskPairService.waitForIdle();
  return pair(taskId);
}

describe('pairs on a non-git project', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-nongit-')));
    plain = join(base, 'plain-project');
    worktreesRoot = join(base, 'worktrees');
    worksRoot = join(base, 'works');
    mkdirSync(plain);
    writeFile(plain, 'src/a.ts', 'export const a = 1;\n');
    writeFile(plain, 'notes.txt', 'n1\n');
    writeFile(plain, 'node_modules/dep/index.js', 'heavy\n');
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', TASK_PAIR_GIT_INIT_ENABLE_ENV, TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV]) saved[key] = process.env[key];
    writeFileSync(join(base, 'global.gitconfig'), '[user]\n\tname = Global\n\temail = g@example.invalid\n');
    process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    deps = { env: { ...process.env, IMCODES_WORKTREES_ROOT: worktreesRoot, IMCODES_WORKS_ROOT: worksRoot }, cloneEngine: noClone };
    setTaskPairWorkspaceDepsForTests(deps);
    useProject(plain);
    taskPairService.setScheduler(testScheduler);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await taskPairService.waitForIdle();
    taskPairService.setScheduler(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairWorkspaceDepsForTests(undefined);
    setTaskPairMaterialDepsForTests(undefined);
    setRebaseRevertGuardDepsForTests();
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD, EXEC2, AUD2]) removeSession(name);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(base, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  describe('git init first (the normal worktree flow, then a merge at DONE)', () => {
    it('dispatch on a non-git project: the project becomes a local repo, the pair gets a normal worktree, the mode is recorded, Brain hears it once', async () => {
      const state = await opened('G1');
      expect(existsSync(join(plain, '.git'))).toBe(true);
      expect(git(plain, 'log', '--format=%s')).toBe('imcodes: baseline before pair G1');
      expect(git(plain, 'remote')).toBe('');
      expect(git(plain, 'ls-files').split('\n').sort()).toEqual(['.gitignore', 'notes.txt', 'src/a.ts']);
      expect(state.workspace).toMatchObject({ kind: 'worktree', status: 'active', nonGit: { mode: 'git_init', projectRoot: plain, gitInit: { created: true, ignoredHeavyDirs: expect.arrayContaining(['node_modules']) } } });
      expect(state.workspace!.path).toBe(join(worktreesRoot, 'imcodes', EXEC, 'pair_g1', 'repo'));
      expect(state.workspace!.workingDir).toBeUndefined(); // the worktree path is the working location
      expect(readFileSync(join(state.workspace!.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      const brainNotices = sentTo(BRAIN, 'brain-non-git-mode');
      expect(brainNotices).toHaveLength(1);
      expect(brainNotices[0]!.text).toContain('created a LOCAL repo');
      expect(brainNotices[0]!.text).toContain('no remote');
      const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
      expect(brief).toContain('was not a git repository');
      expect(brief).toContain('the daemon merges your branch into the project');
      expect(workspaceEvents('G1').some((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.NON_GIT_MODE)).toBe(true);
      // A second pair on the same project: the repo exists, so no second "created" report.
      useProject(plain, EXEC2, AUD2);
      await opened('G2', `auditor=${AUD2}`, EXEC2);
      expect(pair('G2').workspace?.nonGit).toMatchObject({ mode: 'git_init', gitInit: { created: false } });
      expect(sentTo(BRAIN, 'brain-non-git-mode')).toHaveLength(1);
      expect(git(plain, 'rev-list', '--count', 'HEAD')).toBe('1');
    });

    it('READY head/base -> PASS -> DONE: the pair branch is merged into the project, Brain is told, the unchanged git flow ran', async () => {
      const state = await opened('G3');
      const worktree = state.workspace!.path;
      writeFile(worktree, 'src/a.ts', 'export const a = 2;\n');
      writeFile(worktree, 'src/new.ts', 'export const n = 1;\n');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'work');
      const head = git(worktree, 'rev-parse', 'HEAD');
      const baseCommit = git(plain, 'rev-parse', 'HEAD');
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT G3 worktree=${worktree} head=${head} base=${baseCommit} -->`);
      await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 20_000 });
      expect(sentTo(AUD, 'audit-request')[0]!.text).toContain(`git -C ${worktree} diff ${baseCommit}..${head}`);
      marker(AUD, '<!-- IMCODES_TASK PASS G3 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE G3 -->');
      await vi.waitFor(() => expect(pair('G3').workspace?.nonGit?.applyBack?.status).toBe('applied'), { timeout: 20_000 });
      expect(git(plain, 'rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(readFileSync(join(plain, 'src', 'new.ts'), 'utf8')).toBe('export const n = 1;\n');
      expect(git(plain, 'status', '--porcelain')).toBe('');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-non-git-finish')).toHaveLength(1));
      expect(sentTo(BRAIN, 'brain-non-git-finish')[0]!.text).toContain('merge of the pair branch into the project succeeded');
      expect(workspaceEvents('G3').some((event) => event.effect === TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_APPLIED)).toBe(true);
    });

    it('DONE with the user\'s uncommitted edit in a file the pair changed: REFUSED, nothing overwritten, Brain told once, the work is kept; the sweep lands it after the user resolves', async () => {
      const state = await opened('G4');
      const worktree = state.workspace!.path;
      writeFile(worktree, 'src/a.ts', 'export const a = 100;\n');
      git(worktree, 'add', '-A');
      git(worktree, 'commit', '-q', '-m', 'work');
      const headBefore = git(plain, 'rev-parse', 'HEAD');
      writeFile(plain, 'src/a.ts', 'user edit, not committed\n');
      marker(EXEC, '<!-- IMCODES_TASK READY_FOR_AUDIT G4 -->');
      marker(AUD, '<!-- IMCODES_TASK PASS G4 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE G4 -->');
      await vi.waitFor(() => expect(pair('G4').workspace?.nonGit?.applyBack?.status).toBe('conflict'), { timeout: 20_000 });
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('user edit, not committed\n');
      expect(git(plain, 'rev-parse', 'HEAD')).toBe(headBefore);
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-non-git-finish')).toHaveLength(1));
      expect(sentTo(BRAIN, 'brain-non-git-finish')[0]!.text).toContain('REFUSED');
      expect(sentTo(BRAIN, 'brain-non-git-finish')[0]!.text).toContain('src/a.ts');
      // The worktree is the only place the work lives: retention will not remove it.
      const at = pair('G4').workspace!.endedAt!;
      await taskPairService.sweepWorkspaces(at + 8 * 24 * 60 * 60_000, { force: true });
      await taskPairService.waitForIdle();
      expect(existsSync(worktree)).toBe(true);
      expect(pair('G4').workspace?.status).toBe('kept');
      // The retry sees the same refusal: no second notice.
      expect(sentTo(BRAIN, 'brain-non-git-finish')).toHaveLength(1);
      // The user commits/discards their edit; the next retry lands the pair's work.
      git(plain, 'checkout', '--', 'src/a.ts');
      await taskPairService.sweepWorkspaces(at + 9 * 24 * 60 * 60_000, { force: true });
      await vi.waitFor(() => expect(pair('G4').workspace?.nonGit?.applyBack?.status).toBe('applied'), { timeout: 20_000 });
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('export const a = 100;\n');
    });

    it('the size cap: over it the init is rolled back (no .git, .gitignore as it was) and the pair falls back (here: in-place, no COW)', async () => {
      setEnv(TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV, '10');
      const state = await opened('S1');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(existsSync(join(plain, '.gitignore'))).toBe(false);
      expect(state.workspace).toMatchObject({ kind: 'dir', nonGit: { mode: 'in_place', fallbackReason: expect.stringContaining('git_init_over_cap') } });
    });

    it('git disabled by setting: straight to the fallbacks, the project is left exactly as it was', async () => {
      setEnv(TASK_PAIR_GIT_INIT_ENABLE_ENV, 'off');
      const before = statSync(plain).mtimeMs;
      const state = await opened('S2');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(state.workspace?.nonGit).toMatchObject({ mode: 'in_place', fallbackReason: expect.stringContaining('git_init_disabled') });
      expect(statSync(plain).mtimeMs).toBe(before);
    });

    it('a project nested in an existing git repo is a git project: no init, the ordinary flow', async () => {
      execFileSync('git', ['-C', base, 'init', '-q']);
      execFileSync('git', ['-C', base, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'outer']);
      const state = await opened('S3');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(state.workspace?.nonGit).toBeUndefined();
      expect(state.workspace?.kind).toBe('worktree');
    });
  });


  describe('containers are never made a repo, cloned or edited (plain task dir instead)', () => {
    it('the pair\'s project root is the HOME directory: no .git ever, a plain task dir, no clone, nothing edited; Brain told once', async () => {
      deps.homeDir = plain;
      deps.cloneEngine = plainCopy;
      const before = statSync(plain).mtimeMs;
      const state = await opened('H1');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(existsSync(join(plain, '.gitignore'))).toBe(false);
      expect(state.workspace).toMatchObject({ kind: 'dir', path: join(worksRoot, PROJECT, 'H1'), nonGit: { mode: 'plain_dir', fallbackReason: expect.stringContaining('the home directory') } });
      expect(state.workspace!.workingDir).toBeUndefined();
      expect(readdirSyncSafe(state.workspace!.path)).toEqual([]); // nothing was cloned into it
      expect(statSync(plain).mtimeMs).toBe(before);
      expect(sentTo(BRAIN, 'brain-non-git-mode')).toHaveLength(1);
      expect(sentTo(BRAIN, 'brain-non-git-mode')[0]!.text).toContain('not a project IM.codes will touch');
      // Finished, it is an ordinary plain dir: no merge, no copy-back, nothing kept as "unapplied".
      marker(BRAIN, '<!-- IMCODES_TASK DONE H1 force=true -->');
      await vi.waitFor(() => expect(pair('H1').status).toBe('done'));
      await taskPairService.waitForIdle();
      expect(pair('H1').workspace?.nonGit?.applyBack).toBeUndefined();
      expect(sentTo(BRAIN, 'brain-non-git-finish')).toHaveLength(0);
      await taskPairService.sweepWorkspaces(pair('H1').workspace!.endedAt! + 8 * 24 * 60 * 60_000, { force: true });
      expect(pair('H1').workspace?.status).toBe('removed');
    });

    it('a directory that CONTAINS another registered project is not inited; a pair on the child project still gets its own repo', async () => {
      const child = join(plain, 'agents', 'emma');
      mkdirSync(child, { recursive: true });
      writeFile(child, 'a.txt', 'a');
      for (const record of [session(EXEC2, 'w1', child), session(AUD2, 'w2', child)]) upsertSession(record);
      const parent = await opened('K1');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(parent.workspace?.nonGit).toMatchObject({ mode: 'plain_dir', fallbackReason: expect.stringContaining('contains another project') });
      const childPair = await opened('K2', `auditor=${AUD2}`, EXEC2);
      expect(existsSync(join(child, '.git'))).toBe(true);
      expect(childPair.workspace).toMatchObject({ kind: 'worktree', nonGit: { mode: 'git_init', projectRoot: child } });
      // The parent is still not "inside a git work tree", so a later pair on it is refused again, not sent to the child's repo.
      expect(existsSync(join(plain, '.git'))).toBe(false);
    });

    it('a directory holding a nested repository is refused after the listing and rolled back: plain task dir, no .git left', async () => {
      mkdirSync(join(plain, 'sub-project'));
      execFileSync('git', ['-C', join(plain, 'sub-project'), 'init', '-q']);
      const state = await opened('N1');
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(existsSync(join(plain, '.gitignore'))).toBe(false);
      expect(state.workspace?.nonGit).toMatchObject({ mode: 'plain_dir', fallbackReason: expect.stringContaining('container_root') });
    });
  });

  describe('a later pair starts from the owner\'s current files', () => {
    it('edits made since the baseline are committed as a snapshot before the next pair\'s worktree is cut, and Brain is told', async () => {
      await opened('B1');
      useProject(plain, EXEC2, AUD2);
      writeFile(plain, 'src/a.ts', 'export const a = "edited by the owner";\n');
      const second = await opened('B2', `auditor=${AUD2}`, EXEC2);
      expect(git(plain, 'log', '-1', '--format=%s')).toBe('imcodes: snapshot before pair B2');
      expect(readFileSync(join(second.workspace!.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = "edited by the owner";\n');
      expect(git(plain, 'status', '--porcelain')).toBe('');
      const notices = sentTo(BRAIN, 'brain-non-git-mode').map((entry) => entry.text);
      expect(notices.some((text) => text.includes('committed them as "imcodes: snapshot before pair B2"'))).toBe(true);
    });
  });

  describe('fallback: copy-on-write clone (no git)', () => {
    beforeEach(() => {
      setEnv(TASK_PAIR_GIT_INIT_ENABLE_ENV, 'off');
      deps.cloneEngine = plainCopy; // stands in for a copy-on-write filesystem; the real APFS clone is covered in non-git-cow.test.ts
    });

    it('mode is cow, recorded; the project is untouched; the brief names the clone, READY path=<clone>', async () => {
      const state = await opened('C1');
      expect(state.workspace).toMatchObject({ kind: 'dir', path: join(worksRoot, PROJECT, 'C1'), nonGit: { mode: 'cow', projectRoot: plain, clone: { files: 2 } } });
      expect(state.workspace!.workingDir).toBeUndefined();
      expect(existsSync(join(plain, '.git'))).toBe(false);
      expect(existsSync(join(state.workspace!.path, 'node_modules'))).toBe(false);
      expect(readFileSync(join(state.workspace!.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
      expect(brief).toContain('copy-on-write CLONE');
      expect(brief).toContain(`READY_FOR_AUDIT C1 path=${state.workspace!.path}`);
      expect(sentTo(BRAIN, 'brain-non-git-mode')[0]!.text).toContain('copy-on-write clone');
    });

    it('edit in the clone -> READY: the audit request carries the daemon-computed changed files and the per-file diff; PASS + DONE copy the changes back', async () => {
      const state = await opened('C2');
      const clone = state.workspace!.path;
      writeFile(clone, 'src/a.ts', 'export const a = 2;\n');
      writeFile(clone, 'src/added.ts', 'export const added = true;\n');
      rmSync(join(clone, 'notes.txt'));
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT C2 path=${clone} -->`);
      await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 20_000 });
      const request = sentTo(AUD, 'audit-request')[0]!.text;
      expect(request).toContain('copy-on-write CLONE');
      expect(request).toContain('deleted notes.txt');
      expect(request).toContain('modified src/a.ts');
      expect(request).toContain('added src/added.ts');
      expect(request).toContain('diff --git a/src/a.ts b/src/a.ts');
      expect(request).toContain('-export const a = 1;');
      expect(request).toContain('+export const a = 2;');
      expect(request).not.toMatch(/worktree \S+ · head/); // no worktree/head/base material line
      expect(request).toContain('there is no HEAD or base');
      const before = readFileSync(join(plain, 'src', 'a.ts'), 'utf8');
      expect(before).toBe('export const a = 1;\n'); // the project is untouched until DONE
      marker(AUD, '<!-- IMCODES_TASK PASS C2 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE C2 -->');
      await vi.waitFor(() => expect(pair('C2').workspace?.nonGit?.applyBack?.status).toBe('applied'), { timeout: 20_000 });
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(existsSync(join(plain, 'notes.txt'))).toBe(false);
      expect(readFileSync(join(plain, 'src', 'added.ts'), 'utf8')).toBe('export const added = true;\n');
      expect(readFileSync(join(plain, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('heavy\n');
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-non-git-finish')[0]?.text).toContain('copy-back of the clone into the project succeeded'));
      // Undo from the backup restores the project exactly.
      const undone = await taskPairService.undoNonGitApply(PROJECT, 'C2');
      expect(undone.ok).toBe(true);
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(readFileSync(join(plain, 'notes.txt'), 'utf8')).toBe('n1\n');
      expect(existsSync(join(plain, 'src', 'added.ts'))).toBe(false);
      expect(pair('C2').workspace?.nonGit?.applyBack?.status).toBe('undone');
    });

    it('CONFLICT: the project file changed after the clone -> DONE refuses, writes nothing, tells Brain; the workspace is kept', async () => {
      const state = await opened('C3');
      const clone = state.workspace!.path;
      writeFile(clone, 'src/a.ts', 'export const a = 2;\n');
      writeFile(clone, 'notes.txt', 'n2\n');
      writeFile(plain, 'src/a.ts', 'owner edit meanwhile, longer\n');
      utimesSync(join(plain, 'src', 'a.ts'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT C3 path=${clone} -->`);
      marker(AUD, '<!-- IMCODES_TASK PASS C3 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE C3 -->');
      await vi.waitFor(() => expect(pair('C3').workspace?.nonGit?.applyBack?.status).toBe('conflict'), { timeout: 20_000 });
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('owner edit meanwhile, longer\n');
      expect(readFileSync(join(plain, 'notes.txt'), 'utf8')).toBe('n1\n'); // the non-conflicting file was not applied either
      await vi.waitFor(() => expect(sentTo(BRAIN, 'brain-non-git-finish')).toHaveLength(1));
      expect(sentTo(BRAIN, 'brain-non-git-finish')[0]!.text).toContain('src/a.ts (changed_in_project)');
      const at = pair('C3').workspace!.endedAt!;
      await taskPairService.sweepWorkspaces(at + 8 * 24 * 60 * 60_000, { force: true });
      expect(existsSync(clone)).toBe(true);
    });

    it('a finished COW workspace is stripped of the heavy directories the pair installed (listed names only), its own files survive; the copy-back is not affected', async () => {
      const state = await opened('C5');
      const clone = state.workspace!.path;
      writeFile(clone, 'node_modules/x/i.js', 'installed by the pair');
      writeFile(clone, 'src/keep.ts', 'kept');
      writeFile(clone, 'src/a.ts', 'export const a = 3;\n');
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT C5 path=${clone} -->`);
      marker(AUD, '<!-- IMCODES_TASK PASS C5 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE C5 -->');
      await vi.waitFor(() => expect(pair('C5').workspace?.strippedAt).toBeDefined(), { timeout: 20_000 });
      expect(existsSync(join(clone, 'node_modules'))).toBe(false);
      expect(readFileSync(join(clone, 'src', 'keep.ts'), 'utf8')).toBe('kept');
      expect(pair('C5').workspace?.nonGit?.applyBack?.status).toBe('applied');
      expect(readFileSync(join(plain, 'src', 'keep.ts'), 'utf8')).toBe('kept');
      expect(existsSync(join(plain, 'node_modules', 'dep', 'index.js'))).toBe(true); // the project's own node_modules is untouched
    });

    it('the mode is persisted for the pair: the project becoming a git repo while the pair is open changes nothing', async () => {
      const state = await opened('C4');
      execFileSync('git', ['-C', plain, 'init', '-q']);
      setEnv(TASK_PAIR_GIT_INIT_ENABLE_ENV, 'on');
      await taskPairService.ensureWorkspace(PROJECT, 'C4');
      expect(pair('C4').workspace).toMatchObject({ kind: 'dir', path: state.workspace!.path, nonGit: { mode: 'cow' } });
    });
  });

  describe('fallback: in-place editing (no git, no copy-on-write)', () => {
    beforeEach(() => {
      setEnv(TASK_PAIR_GIT_INIT_ENABLE_ENV, 'off');
      deps.cloneEngine = noClone;
    });

    it('the working location is the project directory (workingDir), the task dir is scratch; briefs and READY name the project dir', async () => {
      const state = await opened('I1');
      expect(state.workspace).toMatchObject({ kind: 'dir', path: join(worksRoot, PROJECT, 'I1'), workingDir: plain, nonGit: { mode: 'in_place', projectRoot: plain } });
      expect(existsSync(state.workspace!.path)).toBe(true);
      expect(readFileSync(join(plain, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n'); // nothing was copied or created in the project
      expect(existsSync(join(plain, '.git'))).toBe(false);
      const brief = sentTo(EXEC, 'pair-brief')[0]!.text;
      expect(brief).toContain(`Work DIRECTLY in the project directory: ${plain}`);
      expect(brief).toContain('only for scratch, evidence and deliverables');
      expect(brief).toContain(`READY_FOR_AUDIT I1 path=${plain} files=<comma separated changed files>`);
      expect(sentTo(BRAIN, 'brain-non-git-mode')[0]!.text).toContain('edits the project directory in place');
    });

    it('READY path=<project dir> files=... is accepted with no HEAD or base flagged; the audit request names the project dir and the executor\'s file list', async () => {
      await opened('I2');
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT I2 path=${plain} files=src/a.ts,notes.txt -->`);
      await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 20_000 });
      const request = sentTo(AUD, 'audit-request')[0]!.text;
      expect(request).toContain(`the project directory ${plain}, edited IN PLACE`);
      expect(request).toContain('Changed files stated by the executor: src/a.ts,notes.txt.');
      expect(request).toContain('no HEAD, base or diff');
      expect(sentTo(EXEC, 'material-pending')).toHaveLength(0);
      expect(pair('I2').status).toBe('in_audit');
      marker(AUD, '<!-- IMCODES_TASK PASS I2 blocking=P0 -->');
      marker(EXEC, '<!-- IMCODES_TASK DONE I2 -->');
      await vi.waitFor(() => expect(pair('I2').status).toBe('done'), { timeout: 20_000 });
      expect(pair('I2').workspace?.nonGit?.applyBack).toBeUndefined(); // nothing to bring back: the edits are already in the project
    });

    it('a READY without the file list asks the auditor to get it first', async () => {
      await opened('I3');
      marker(EXEC, `<!-- IMCODES_TASK READY_FOR_AUDIT I3 path=${plain} -->`);
      await vi.waitFor(() => expect(sentTo(AUD, 'audit-request')).toHaveLength(1), { timeout: 20_000 });
      expect(sentTo(AUD, 'audit-request')[0]!.text).toContain('did not list the changed files');
    });

    describe('serialization', () => {
      let automation: TaskPairAutomation;
      beforeEach(() => {
        useProject(plain, EXEC2, AUD2);
        automation = new TaskPairAutomation({ now: () => Date.now(), isBusy: () => false, importLegacy: () => undefined, poolOf: () => 'primary' });
        taskPairService.setScheduler(automation);
      });

      it('a second pair on the same in-place project waits (reason names the first); it starts when the first ends; parallel=true overrides', async () => {
        await opened('P1');
        marker(BRAIN, `<!-- IMCODES_TASK DISPATCH P2 executor=${EXEC2} auditor=${AUD2} -->`);
        await taskPairService.waitForIdle();
        await automation.runQueue(PROJECT, BRAIN);
        expect(pair('P2').status).toBe('queued');
        expect(pair('P2').capacityWaitReason).toBe(`waiting for P1 (it edits ${plain} in place; pass parallel=true on DISPATCH to run alongside)`);
        marker(BRAIN, '<!-- IMCODES_TASK CANCEL P1 -->');
        await taskPairService.waitForIdle();
        await automation.runQueue(PROJECT, BRAIN);
        await taskPairService.waitForIdle();
        expect(pair('P2').status).toBe('working');
        expect(pair('P2').workspace?.nonGit?.mode).toBe('in_place');
        // Brain's override: a third pair runs alongside the running second.
        useProject(plain, 'deck_sub_ngexec3', 'deck_sub_ngaud3');
        marker(BRAIN, `<!-- IMCODES_TASK DISPATCH P3 executor=deck_sub_ngexec3 auditor=deck_sub_ngaud3 parallel=true -->`);
        await taskPairService.waitForIdle();
        await automation.runQueue(PROJECT, BRAIN);
        await taskPairService.waitForIdle();
        expect(pair('P3').status).toBe('working');
        expect(pair('P3').parallelInPlace).toBe(true);
        removeSession('deck_sub_ngexec3'); removeSession('deck_sub_ngaud3');
      });

      it('pairs on DIFFERENT non-git projects run in parallel', async () => {
        await opened('Q1');
        const other = join(base, 'other-project');
        mkdirSync(other);
        writeFile(other, 'x.txt', 'x');
        for (const record of [session(EXEC2, 'w1', other), session(AUD2, 'w2', other)]) upsertSession(record);
        marker(BRAIN, `<!-- IMCODES_TASK DISPATCH Q2 executor=${EXEC2} auditor=${AUD2} -->`);
        await taskPairService.waitForIdle();
        await automation.runQueue(PROJECT, BRAIN);
        await taskPairService.waitForIdle();
        expect(pair('Q2').status).toBe('working');
        expect(pair('Q2').workspace?.nonGit).toMatchObject({ mode: 'in_place', projectRoot: other });
      });
    });
  });

  it('git projects are unchanged: a git project gets no nonGit record and the worktree flow', async () => {
    execFileSync('git', ['-C', plain, 'init', '-q']);
    execFileSync('git', ['-C', plain, 'add', '-A']);
    execFileSync('git', ['-C', plain, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'base']);
    const state = await opened('R1');
    expect(state.workspace?.kind).toBe('worktree');
    expect(state.workspace?.nonGit).toBeUndefined();
    expect(sentTo(BRAIN, 'brain-non-git-mode')).toHaveLength(0);
  });

  it('the contract text describes the git init and both fallbacks', () => {
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('A project that is not a git repository');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('LOCAL repo');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('copy-on-write CLONE');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('IN-PLACE');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('parallel=true');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('CONTAINER');
    expect(TASK_PAIR_WORKSPACE_RULES).toContain('snapshot');
  });
});
