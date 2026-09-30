/**
 * The working directory of a pair participant's turn (tsk_cd_executor_default_cwd).
 * A sub-session starts in the project's main checkout, so a tool call that omits
 * its workdir used to land there. resolveTaskPairTurnCwd names the pair
 * workspace for the executor/auditor of an OPEN pair and nothing else, and reads
 * the live pair state each time so it needs no revert step.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { TaskPairStore, getTaskPairStore, setTaskPairStoreForTests } from '../../../src/daemon/task-pairs/store.js';
import { noteTaskPairFocus, resetTaskPairFocusForTests } from '../../../src/daemon/task-pairs/focus.js';
import { resolveTaskPairTurnCwd } from '../../../src/daemon/task-pairs/turn-cwd.js';
import type { TaskPairState, TaskPairStatus } from '../../../shared/task-pair.js';

const PROJECT = 'tcwdproj';
const MAIN = '/Users/test/main-checkout';
const BRAIN = 'deck_tcwdproj_brain';
const EXEC = 'deck_sub_tcwdexec';
const AUD = 'deck_sub_tcwdaud';
const OWNER = 'deck_sub_tcwdowner';

let root: string;
const dir = (name: string): string => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

function session(name: string, role: SessionRecord['role'], project = PROJECT): SessionRecord {
  return {
    name, projectName: project, role, agentType: 'codex-sdk', projectDir: MAIN, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`, restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function savePair(taskId: string, path: string | undefined, over: Partial<TaskPairState> = {}, status: TaskPairStatus = 'working'): void {
  const now = Date.now();
  getTaskPairStore().savePair(PROJECT, {
    taskId, status, brain: BRAIN, executor: EXEC, auditor: AUD, round: 1, blocking: ['P0'], title: taskId,
    ...(path ? { workspace: { kind: 'worktree', path, createdAt: now, status: 'active' } } : {}),
    createdAt: now, updatedAt: now,
    ...over,
  } as unknown as TaskPairState);
}

describe('resolveTaskPairTurnCwd', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imc-turn-cwd-'));
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    resetTaskPairFocusForTests();
    upsertSession(session(BRAIN, 'brain'));
    for (const name of [EXEC, AUD, OWNER]) upsertSession(session(name, 'w1'));
  });
  afterEach(() => {
    setTaskPairStoreForTests(undefined);
    resetTaskPairFocusForTests();
    for (const name of [BRAIN, EXEC, AUD, OWNER]) removeSession(name);
    rmSync(root, { recursive: true, force: true });
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('gives the executor and the auditor of an open pair the pair workspace', () => {
    const ws = dir('pair_t1/repo');
    savePair('T1', ws);
    expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd: ws, taskId: 'T1', role: 'executor' });
    expect(resolveTaskPairTurnCwd(AUD)).toEqual({ cwd: ws, taskId: 'T1', role: 'auditor' });
  });

  it('leaves Brain and a session without an open pair alone', () => {
    savePair('T1', dir('pair_t1/repo'));
    expect(resolveTaskPairTurnCwd(BRAIN)).toBeUndefined();
    expect(resolveTaskPairTurnCwd(OWNER)).toBeUndefined();
    expect(resolveTaskPairTurnCwd('deck_sub_unknown')).toBeUndefined();
  });

  it('leaves a session alone when the project does not run the pairs engine', () => {
    savePair('T1', dir('pair_t1/repo'));
    process.env.IMCODES_SUPERVISION_ENGINE = 'legacy';
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
  });

  it('reverts by itself when the pair ends (DONE, CANCEL) or the session leaves the role', () => {
    const ws = dir('pair_t1/repo');
    savePair('T1', ws);
    expect(resolveTaskPairTurnCwd(EXEC)?.cwd).toBe(ws);
    savePair('T1', ws, {}, 'done');
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    expect(resolveTaskPairTurnCwd(AUD)).toBeUndefined();

    savePair('T2', ws);
    expect(resolveTaskPairTurnCwd(EXEC)?.cwd).toBe(ws);
    savePair('T2', ws, {}, 'cancelled');
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();

    // REASSIGN: the old executor is no longer a participant, the new one is.
    savePair('T3', ws);
    savePair('T3', ws, { executor: OWNER });
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    expect(resolveTaskPairTurnCwd(OWNER)?.cwd).toBe(ws);
  });

  it('follows a workspace the daemon moved, and a task directory (non-git) like a worktree', () => {
    const before = dir('pair_t1/repo');
    savePair('T1', before);
    expect(resolveTaskPairTurnCwd(EXEC)?.cwd).toBe(before);
    const moved = dir('moved/pair_t1/repo');
    savePair('T1', moved, { workspace: { kind: 'worktree', path: moved, createdAt: 1, status: 'active', previousPaths: [before] } as never });
    expect(resolveTaskPairTurnCwd(EXEC)?.cwd).toBe(moved);
    const taskDir = dir('works/tcwdproj/T4');
    savePair('T4', undefined, { executor: OWNER, workspaceKind: 'dir', workspace: { kind: 'dir', path: taskDir, createdAt: 1, status: 'active' } as never });
    expect(resolveTaskPairTurnCwd(OWNER)).toEqual({ cwd: taskDir, taskId: 'T4', role: 'executor' });
  });

  describe('the pair\'s recorded working location, by project kind', () => {
    const inProject = (projectDir: string) => {
      for (const name of [EXEC, AUD]) upsertSession({ ...session(name, 'w1'), projectDir });
    };
    const both = (cwd: string, taskId: string) => {
      expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd, taskId, role: 'executor' });
      expect(resolveTaskPairTurnCwd(AUD)).toEqual({ cwd, taskId, role: 'auditor' });
    };

    it('git project: the pair worktree, not the project directory', () => {
      const project = dir('git-project');
      mkdirSync(join(project, '.git'));
      inProject(project);
      const worktree = dir('worktrees/pair_g1/repo');
      savePair('G1', worktree);
      both(worktree, 'G1');
    });

    it('git project, workspace=dir task: the task directory Brain asked for', () => {
      const project = dir('git-project-dir-task');
      mkdirSync(join(project, '.git'));
      inProject(project);
      const taskDir = dir('works/gproj/D1');
      savePair('D1', undefined, { workspaceKind: 'dir', workspace: { kind: 'dir', path: taskDir, createdAt: 1, status: 'active' } as never });
      both(taskDir, 'D1');
    });

    it('non-git project, copy-on-write clone: the clone in the task directory (kind and mode do not matter)', () => {
      const project = dir('plain-project-cow');
      inProject(project);
      const clone = dir('works/plain/C1');
      for (const kind of ['worktree', 'dir', 'snapshot']) {
        savePair('C1', undefined, { workspace: { kind, path: clone, createdAt: 1, status: 'active', snapshot: { mode: 'clone', projectRoot: project } } as never });
        both(clone, 'C1');
      }
    });

    it('non-git project, in place: the project directory; the task directory is only scratch', () => {
      const project = dir('plain-project-inplace');
      inProject(project);
      const scratch = dir('works/plain/P1');
      // Recorded: workingDir names the project directory.
      savePair('P1', undefined, { workspace: { kind: 'dir', path: scratch, workingDir: project, createdAt: 1, status: 'active' } as never });
      both(project, 'P1');
      // Not recorded (the empty task-directory fallback, or a pair from before the field): the workspace path, never the project.
      savePair('P1', undefined, { workspace: { kind: 'dir', path: scratch, createdAt: 1, status: 'active' } as never });
      both(scratch, 'P1');
      savePair('P1', undefined, { workspace: { kind: 'dir', path: scratch, workingDir: project, createdAt: 1, status: 'active' } as never });
      // It ends with the pair, like any other workspace.
      savePair('P1', undefined, { workspace: { kind: 'dir', path: scratch, workingDir: project, createdAt: 1, status: 'active' } as never }, 'done');
      expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
      expect(resolveTaskPairTurnCwd(AUD)).toBeUndefined();
    });

    it('a recorded workingDir that is missing or relative is never used', () => {
      inProject(dir('plain-project-bad'));
      const scratch = dir('works/plain/B1');
      savePair('B1', undefined, { workspace: { kind: 'dir', path: scratch, workingDir: join(root, 'gone'), createdAt: 1, status: 'active' } as never });
      expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
      savePair('B1', undefined, { workspace: { kind: 'dir', path: scratch, workingDir: 'relative/dir', createdAt: 1, status: 'active' } as never });
      expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    });
  });

  it('never points a turn at a workspace that is not usable', () => {
    savePair('T1', join(root, 'missing/repo'));
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    const ended = dir('ended/repo');
    savePair('T2', ended, { executor: OWNER, workspace: { kind: 'worktree', path: ended, createdAt: 1, status: 'removed' } as never });
    expect(resolveTaskPairTurnCwd(OWNER)).toBeUndefined();
    savePair('T3', undefined, { executor: OWNER });
    expect(resolveTaskPairTurnCwd(OWNER)).toBeUndefined();
    savePair('T5', 'relative/repo', { executor: OWNER });
    expect(resolveTaskPairTurnCwd(OWNER)).toBeUndefined();
  });

  it('a session in two pairs follows the pair it was last messaged about, else the workspace they share', () => {
    const a = dir('pair_a/repo');
    const b = dir('pair_b/repo');
    savePair('A', a);
    savePair('B', b);
    // Two different workspaces and no focus: keep the session's own cwd rather than guess the wrong worktree.
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    noteTaskPairFocus(EXEC, 'B');
    expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd: b, taskId: 'B', role: 'executor' });
    noteTaskPairFocus(EXEC, 'A');
    expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd: a, taskId: 'A', role: 'executor' });
    // A focus on a pair that has ended no longer narrows anything.
    savePair('A', a, {}, 'done');
    expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd: b, taskId: 'B', role: 'executor' });
    // Two pairs sharing one workspace are unambiguous without a focus.
    resetTaskPairFocusForTests();
    savePair('C', b);
    expect(resolveTaskPairTurnCwd(EXEC)?.cwd).toBe(b);
  });

  it('an executor of one pair and auditor of another (two workspaces) keeps its cwd without a focus', () => {
    const own = dir('pair_own/repo');
    const other = dir('pair_other/repo');
    savePair('OWN', own);
    savePair('OTHER', other, { executor: OWNER, auditor: EXEC });
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
    noteTaskPairFocus(EXEC, 'OTHER');
    expect(resolveTaskPairTurnCwd(EXEC)).toEqual({ cwd: other, taskId: 'OTHER', role: 'auditor' });
  });

  it('a pair that is still queued has no workspace yet and changes nothing', () => {
    savePair('Q', undefined, {}, 'queued');
    expect(resolveTaskPairTurnCwd(EXEC)).toBeUndefined();
  });
});
