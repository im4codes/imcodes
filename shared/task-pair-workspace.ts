/**
 * What Brain can ask for with `pair_create workspace=` (or `workspace=` on QUEUE/DISPATCH). A module of its own so the MCP tool
 * contract can import it without pulling in the whole pair state machine.
 */
/** A git worktree for code in a git project; a plain task directory otherwise. */
export const TASK_PAIR_WORKSPACE_KINDS = ['worktree', 'dir'] as const;
export type TaskPairWorkspaceKind = typeof TASK_PAIR_WORKSPACE_KINDS[number];

/**
 * What Brain can ask for with `pair_create workspace=` (or `workspace=` on QUEUE/DISPATCH):
 *  - `auto`     today's rule: a worktree for code in a git project, a task directory otherwise (the default, stored as nothing);
 *  - `worktree` the same as auto, stated;
 *  - `dir`      an empty task directory under ~/.imcodes/works/<project>/<taskId>/ (reports, scratch; a deliverable leaves it with DONE output=);
 *  - `none`     no workspace at all: nothing is created on disk, the executor works wherever the brief says (a remote machine, a service),
 *               and the material for the audit is its report and evidence.
 */
export const TASK_PAIR_WORKSPACE_REQUESTS = ['auto', 'worktree', 'dir', 'none'] as const;
export type TaskPairWorkspaceRequest = typeof TASK_PAIR_WORKSPACE_REQUESTS[number];
export const TASK_PAIR_WORKSPACE_NONE = 'none' as const;
/** The kind a pair stores: a provisioned kind, or `none` (auto is stored as nothing). */
export type TaskPairRequestedWorkspaceKind = TaskPairWorkspaceKind | typeof TASK_PAIR_WORKSPACE_NONE;
export function isTaskPairWorkspaceRequest(value: unknown): value is TaskPairWorkspaceRequest {
  return typeof value === 'string' && (TASK_PAIR_WORKSPACE_REQUESTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The owner rule, in ONE place. Every text a Brain, an executor or an auditor reads about workspaces (the marker contract, the
// pair_create tool and parameter descriptions, the guidance returned when a pair is created, the daemon's briefs) is built from
// these constants; test/shared/task-pair-workspace-rule.test.ts fails when any of them loses the sentence.
// ---------------------------------------------------------------------------------------------------------------------------

/** First rule of every workspace text: a worktree is the exception, not the default. */
export const TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY: string =
  'A worktree is created only when the task changes the project\'s tracked files and the result will be merged. '
  + 'Research, measurements, tests on other machines, reports, audits and any read-only work must use workspace=dir (a small task directory) '
  + 'or workspace=none; do not ask for a worktree "just in case".';

/** What `auto` (the default, kept so existing callers do not break) does. */
export const TASK_PAIR_WORKSPACE_AUTO_NOTE: string =
  'workspace=auto (the default, kept only so existing callers do not break) means a worktree for a code task in a git project; '
  + 'prefer an explicit dir or none for everything else.';

/** The three explicit values and when to use each. */
export const TASK_PAIR_WORKSPACE_VALUES_GUIDE: string =
  'workspace=worktree: the task edits tracked files that you will merge. '
  + 'workspace=dir: an empty task directory under ~/.imcodes/works/<project>/<taskId>/ for reports, scratch files and deliverables (a deliverable leaves it with DONE output=/dest=). '
  + 'workspace=none: nothing is created on disk (research, measurements, remote-machine testing, audits); the audit material is the executor\'s report and evidence.';

/** The sentence the daemon puts in front of the Brain when it creates a pair. */
export const TASK_PAIR_WORKSPACE_PICK_GUIDANCE: string =
  'Pick workspace=dir or none unless this task edits tracked files that you will merge.';

/** The compact token form used by the Brain duty table (src/daemon/supervision-prompts.ts), which stores rules as snake_case tokens. */
export const TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY_TOKEN =
  'worktree_only_when_the_task_changes_tracked_files_that_will_be_merged_else_workspace=dir_or_none';

/** The full workspace choice text for the pair_create PARAMETER description. */
export const TASK_PAIR_WORKSPACE_PARAMETER_DESCRIPTION: string =
  `${TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY} ${TASK_PAIR_WORKSPACE_VALUES_GUIDE} ${TASK_PAIR_WORKSPACE_AUTO_NOTE}`;

/** What pair_create returns beside the stored choice: the rule, and the pick guidance when the Brain left the choice to `auto`. */
export function taskPairWorkspaceCreateNote(requested: TaskPairWorkspaceRequest): string {
  return requested === 'dir' || requested === 'none'
    ? `workspace=${requested}: no worktree is created for this pair. ${TASK_PAIR_WORKTREE_ONLY_WHEN_NECESSARY}`
    : `${TASK_PAIR_WORKSPACE_AUTO_NOTE} ${TASK_PAIR_WORKSPACE_PICK_GUIDANCE}`;
}
