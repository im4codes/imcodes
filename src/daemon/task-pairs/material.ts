/**
 * Where a pair's audit material is.
 *
 * A pair has no bundle, attempt or registry binding: the material is the
 * executor's workspace. For a worktree that is the worktree at a HEAD: the
 * executor names it on READY_FOR_AUDIT (`worktree=`, `head=`, `base=`); what it
 * leaves out the daemon fills in from the pair's worktree or the executor
 * session (its project directory, and that worktree's HEAD read with one
 * bounded, asynchronous `git rev-parse`). For a task directory it is a path
 * (`path=`, else the directory itself) and there is no HEAD.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getSession } from '../../store/session-store.js';
import type { TaskPairState } from '../../../shared/task-pair.js';

const GIT_HEAD_TIMEOUT_MS = 5_000;

export interface ResolvedTaskPairMaterial {
  worktree?: string;
  head?: string;
  base?: string;
  /** Task-directory material. */
  path?: string;
  /** Who named the material: the executor's marker, or the daemon's fallback. */
  source: 'executor' | 'daemon';
}

export interface TaskPairMaterialDeps {
  projectDirOf?: (sessionName: string) => string | undefined;
  gitHead?: (worktree: string) => Promise<string | undefined>;
}

function defaultGitHead(worktree: string): Promise<string | undefined> {
  // No process for a directory that is not there (a session without a checkout).
  if (!existsSync(worktree)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, 'rev-parse', 'HEAD'], { timeout: GIT_HEAD_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const head = String(stdout ?? '').trim();
      resolve(!error && /^[0-9a-f]{7,64}$/i.test(head) ? head : undefined);
    });
  });
}

let testDeps: TaskPairMaterialDeps | undefined;

export function setTaskPairMaterialDepsForTests(deps: TaskPairMaterialDeps | undefined): void {
  testDeps = deps;
}

export async function resolveTaskPairMaterial(pair: TaskPairState, deps: TaskPairMaterialDeps = testDeps ?? {}): Promise<ResolvedTaskPairMaterial> {
  const named = pair.material;
  const workspace = pair.workspace && pair.workspace.status !== 'removed' ? pair.workspace : undefined;
  if (workspace?.kind === 'dir' && !named?.worktree && !named?.head) {
    return { path: named?.path ?? workspace.path, source: named?.path ? 'executor' : 'daemon' };
  }
  // The executor's own words first, then the worktree the daemon created for
  // the pair, then the executor session's checkout.
  const worktree = named?.worktree
    ?? (workspace?.kind === 'worktree' ? workspace.path : undefined)
    ?? (pair.executor ? (deps.projectDirOf ?? ((name) => getSession(name)?.projectDir))(pair.executor) : undefined);
  const head = named?.head ?? (worktree ? await (deps.gitHead ?? defaultGitHead)(worktree) : undefined);
  return {
    ...(worktree ? { worktree } : {}),
    ...(head ? { head } : {}),
    ...(named?.base ? { base: named.base } : workspace?.base ? { base: workspace.base } : {}),
    source: named?.worktree || named?.head ? 'executor' : 'daemon',
  };
}
