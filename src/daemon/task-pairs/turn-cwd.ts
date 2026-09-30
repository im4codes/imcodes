/**
 * The working directory a pair participant's turn runs in.
 *
 * A sub-session is created with the project directory as its cwd, and a
 * provider that fixes cwd when its thread starts leaves every command that
 * omits a workdir in the project's MAIN checkout -- Brain's integration space
 * and the owner's checkout (owner report tsk_cd_executor_default_cwd: an
 * executor's `python3 open("var/x","w")` landed in the main checkout). The pair
 * workspace is only ever named in the message text, so a tool call without a
 * workdir escapes it. This resolves, per turn, the workspace of the open pair
 * the turn belongs to; the transport runtime hands it to the provider as the
 * turn's cwd (or, for a provider that cannot take one, as a one-line preamble).
 *
 * Nothing is remembered: the answer is read from the live pair state on every
 * turn, so a pair that ends (DONE/CANCEL), a session that leaves the role, a
 * REASSIGN and a worktree the daemon moved all take effect on the next turn
 * with no separate revert step -- an unresolved turn simply runs in the
 * session's own cwd again.
 *
 * Scope is the same as the main-checkout write guard: only the executor or
 * auditor of an OPEN pair on a `pairs` project. Brain sessions and sessions
 * without an open pair are never touched.
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TASK_PAIR_PARTICIPANT_STATUSES } from '../../../shared/task-pair.js';
import { getSession } from '../../store/session-store.js';
import { isPairsEngineProject } from './engine.js';
import { taskPairFocusOf } from './focus.js';
import { getTaskPairStore } from './store.js';

export interface TaskPairTurnCwd {
  cwd: string;
  taskId: string;
  role: 'executor' | 'auditor';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The workspace for `sessionName`'s next turn, or undefined to leave the
 * session's own cwd alone.
 *
 * A session in several open pairs follows the pair it was last messaged about
 * (the same focus its plain output is attributed to). Without a focus that
 * narrows it to one pair, it follows the single workspace all its pairs share,
 * and keeps its own cwd when they differ: guessing would put a turn in the
 * wrong pair's worktree, which is worse than the old behaviour.
 */
export function resolveTaskPairTurnCwd(sessionName: string): TaskPairTurnCwd | undefined {
  const session = getSession(sessionName);
  if (!session || session.role === 'brain' || !isPairsEngineProject(session.projectName)) return undefined;
  const candidates: TaskPairTurnCwd[] = [];
  for (const stored of getTaskPairStore().pairsForSession(sessionName)) {
    const pair = stored.state;
    if (!TASK_PAIR_PARTICIPANT_STATUSES.includes(pair.status)) continue;
    const role = pair.executor === sessionName ? 'executor' : pair.auditor === sessionName ? 'auditor' : undefined;
    if (!role || pair.brain === sessionName) continue;
    const workspace = pair.workspace;
    if (!workspace || workspace.status !== 'active' || !workspace.path || !isAbsolute(workspace.path)) continue;
    candidates.push({ cwd: workspace.path, taskId: pair.taskId, role });
  }
  if (candidates.length === 0) return undefined;
  const focus = taskPairFocusOf(sessionName);
  const focused = focus ? candidates.filter((candidate) => candidate.taskId === focus) : [];
  const pool = focused.length > 0 ? focused : candidates;
  const distinct = new Set(pool.map((candidate) => candidate.cwd));
  if (distinct.size !== 1) return undefined;
  const chosen = pool[0]!;
  // A workspace the daemon has not (re)built yet must not become the cwd of a
  // turn: a provider refuses to start in a directory that does not exist.
  if (!isDirectory(chosen.cwd)) return undefined;
  return chosen;
}
