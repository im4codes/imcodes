/**
 * Marker-driven executor + auditor task pairs (the `pairs` supervision engine).
 *
 * Models signal progress with one-line markers in their own output; the daemon
 * parses them, advances the lenient state machine below, and projects the
 * result to the web UI. Nothing here refuses work: every well-formed marker is
 * recorded, applied when it makes sense, and otherwise kept as history.
 *
 * Kept from the legacy system: the P0-P4 severity contract
 * (`audit_convergence_v1`) judges verdict markers, and participants come from
 * the execution model pool.
 */
import {
  AUDIT_CONVERGENCE_CONTRACT_ID,
  AUDIT_SEVERITY_LEVELS,
  normalizeAuditBlockingSeverities,
  type AuditSeverity,
} from './audit-convergence.js';
import { advanceMarkdownFence, type MarkdownFenceState } from './markdown-fence.js';
import { parseTaskPairChecklist, updateTaskPairChecklist } from './task-pair-checklist.js';

export const TASK_PAIR_CONTRACT_ID = 'task_pair_markers_v1' as const;
export const TASK_PAIR_MARKER_TAG = 'IMCODES_TASK' as const;
export const TASK_PAIR_BRIEF_END_TAG = 'IMCODES_TASK_END' as const;
/** Timeline event carrying every applied or recorded marker event. */
export const TASK_PAIR_TIMELINE_EVENT = 'task_pair.event' as const;
/** Every daemon-authored pair message id starts with this prefix plus the task id. */
export const TASK_PAIR_NUDGE_ID_PREFIX = 'task-pair-nudge:' as const;
/** Hook path through which MCP child processes hand legacy supervision tool calls to the daemon. */
export const TASK_PAIR_LEGACY_TOOL_HOOK_PATH = '/task-pairs/legacy-tool' as const;
/** Hook path through which an MCP child process asks whether its session is on the `pairs` engine. */
export const TASK_PAIR_ENGINE_HOOK_PATH = '/task-pairs/engine' as const;
/**
 * Brain's work-delegation contract on a `pairs` project. It has its own id so a
 * pairs Brain never carries a `supervision_*` contract.
 */
export const TASK_PAIR_BRAIN_CONTRACT_ID = 'task_pair_brain_v1' as const;
export const TASK_PAIR_CHECKLIST_RULE = 'Pair brief checklist: keep requirements in Markdown lines "- [ ][ ] item"; a single-box "- [ ]" item has no audit box; number items 1..N in brief order. The executor ticks each implemented box as soon as that item is done and all delivered items before READY_FOR_AUDIT; the auditor ticks each audited box when verified and all verified items before PASS; on REWORK the auditor unticks failed items and names their numbers. Tick only work really done or verified. Use pair_task_get/update/check or the CHECK marker to update the whole brief.';
export const TASK_PAIR_RESOURCE_CLAIM_RULE = 'Before using a shared machine, directory, port range, or named test stack, claim it with pair_resource_claim or `<!-- IMCODES_TASK CLAIM <taskId> resource=... mode=exclusive|shared ttl=... -->`; renew before the TTL expires. Claims are user-scoped, conflict-checked, persisted across daemon restarts, and released on DONE/CANCEL. Never touch an unclaimed shared resource.';
export const TASK_PAIR_CHECK_VERB = 'CHECK' as const;
/** Brain-only: opens the next delivery round on a passed (not yet done) pair. */
export const TASK_PAIR_NEXT_ROUND_VERB = 'NEXT_ROUND' as const;
export const TASK_PAIR_CHECKLIST_AUTO_TICK_VERB = 'CHECKLIST_AUTO_TICK' as const;
export const TASK_PAIR_CHECKLIST_BOXES = ['implemented', 'audited'] as const;
export type TaskPairChecklistBox = typeof TASK_PAIR_CHECKLIST_BOXES[number];

export interface TaskPairChecklistCheck {
  box: TaskPairChecklistBox;
  indexes: number[];
  checked: boolean;
}

/** Parse compact CHECK marker attributes without silently accepting bad input. */
export function parseTaskPairChecklistCheck(attrs: Record<string, string>): TaskPairChecklistCheck | undefined {
  const box = attrs.box;
  if (!(TASK_PAIR_CHECKLIST_BOXES as readonly string[]).includes(box ?? '')) return undefined;
  const rawItems = attrs.items;
  if (!rawItems) return undefined;
  if (rawItems !== 'all' && !/^\d+(?:,\d+)*$/u.test(rawItems)) return undefined;
  const indexes = rawItems === 'all'
    ? undefined
    : rawItems.split(',').map((value) => Number.parseInt(value, 10));
  if (indexes && (indexes.length === 0 || indexes.some((index) => !Number.isSafeInteger(index) || index < 1))) return undefined;
  const checkedRaw = attrs.checked;
  if (checkedRaw !== undefined && checkedRaw !== 'true' && checkedRaw !== 'false') return undefined;
  return { box: box as TaskPairChecklistBox, indexes: indexes ?? [], checked: checkedRaw !== 'false' };
}

export function resolveTaskPairChecklistIndexes(markdown: string, check: TaskPairChecklistCheck): number[] {
  if (check.indexes.length > 0) return [...new Set(check.indexes)].sort((a, b) => a - b);
  return parseTaskPairChecklist(markdown).map((item) => item.index);
}

export function applyTaskPairChecklistCheck(markdown: string, check: TaskPairChecklistCheck): { markdown: string; indexes: number[] } {
  const indexes = resolveTaskPairChecklistIndexes(markdown, check);
  return { markdown: updateTaskPairChecklist(markdown, indexes, check.box, check.checked), indexes };
}

/** Shared default used by implicit dispatch when no auditor was named. */
export function isComplexSupervisionTaskBrief(brief: string | undefined): boolean {
  const text = brief?.trim() ?? '';
  if (!text) return false;
  if (text.length >= 240) return true;
  return /\b(?:multi[- ]?step|cross[- ]?file|real[- ]?(?:device|machine)|test(?:s|ing)?|suite|build|deploy|migration|security|performance|audit|repro|regression|integration|e2e|database|schema)\b|(?:修复|测试|构建|部署|多步|跨文件|实机|审计|回归|集成)/iu.test(text)
    || (text.match(/\.(?:ts|tsx|js|jsx|py|go|rs|cpp|h)\b/giu)?.length ?? 0) >= 2;
}
/** Every task entry point must carry a short title in the owner's UI locale. */
export const TASK_PAIR_TITLE_RULE =
  'TITLE RULE (required): every DISPATCH, QUEUE, and task-bound send_message '
  + 'that creates a task MUST include title="<short specific title>" in the '
  + 'owner\'s UI language (example: QUEUE tsk_demo title="Fix login retry"). '
  + 'Do not use a raw taskId, "Brain: …", or a copied message prefix; the '
  + 'daemon supplies a neutral localized placeholder and asks the project '
  + 'Brain for the final title asynchronously when omitted.';
/** Lifecycle semantics for title reminders sent as marker examples. */
export const TASK_PAIR_TITLE_MARKER_RULE =
  'A Brain DISPATCH with only title="..." is a metadata-only title update: '
  + 'it never reopens, requeues, or wakes an existing pair, including a '
  + 'cancelled or done pair. A DISPATCH with lifecycle attributes cannot '
  + 'revive a cancelled or done pair; use a new taskId instead.';
/** Brain/provider-native boundary: routing authority lives in IM.codes pairs, not provider sub-agents. */
export const TASK_PAIR_NATIVE_COLLABORATION_RULE =
  'Brain must never dispatch pair/task work (implementation, repair, audit, PASS/REWORK, merges) through provider-native sub-agents. '
  + 'Dispatch it only through IM.codes pair markers (DISPATCH/QUEUE). Native sub-agents are fine for read-only research and analysis.';
/** Automation kind stamped on daemon-authored pair messages. */
export const TASK_PAIR_AUTOMATION_KIND = 'task-pair' as const;
/** Directory-name prefix of a pair's executor worktree, beside legacy `asg_…` assignment worktrees. */
export const TASK_PAIR_WORKTREE_PREFIX = 'pair_' as const;
/**
 * Root (under the IM.codes home, ~/.imcodes) of the task directories of pairs
 * that are not git/code work: `~/.imcodes/works/<project>/<taskId>/`.
 */
export const TASK_PAIR_WORKS_DIR = 'works' as const;
/** Environment override of the works root (tests, relocated homes). */
export const TASK_PAIR_WORKS_ROOT_ENV = 'IMCODES_WORKS_ROOT' as const;
/** A pair's workspace is removed this long after the pair ends (DONE/CANCEL). */
export const TASK_PAIR_WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A git worktree for code in a git project; a plain task directory otherwise. */
export const TASK_PAIR_WORKSPACE_KINDS = ['worktree', 'dir'] as const;
export type TaskPairWorkspaceKind = typeof TASK_PAIR_WORKSPACE_KINDS[number];
/**
 * Rebuildable directory names stripped from a finished pair's worktree, and
 * only ever when git reports the path as ignored (never tracked or untracked
 * source). Deliberately a name allowlist, not "everything ignored": an ignored
 * directory may hold something that cannot be rebuilt.
 */
export const TASK_PAIR_HEAVY_DIR_NAMES = [
  'node_modules', 'dist', 'build', '.build', '.vite', '.turbo', '.next', '.nuxt', '.parcel-cache',
  'coverage', 'cmake-build-debug', 'cmake-build-release',
] as const;
/**
 * A pair on a project that is NOT a git repository (owner 2026-09-30: "设备有安装git的 你可以创建git项目的", earlier "不是git就直接改",
 * "支持cow的可以复制", and "几十g的你也复制吧 这个不太合适！" -- never a real full copy). The mode is chosen once, at pair start, and kept:
 *  - `git_init`: git is installed, so the project directory becomes a local git repository (repo-local identity, an IM.codes block
 *    in .gitignore for heavy directories and files over TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES, a baseline commit, no remote, never a
 *    push), refused above TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES with the init rolled back. Then the normal git worktree flow runs;
 *    at DONE the daemon merges the pair branch into the project, refusing any file the user has uncommitted edits in.
 *  - `cow`: fallback (no git, over the cap, init failed): the volume supports copy-on-write clones (APFS clonefile, Btrfs/XFS reflink)
 *    and the project shares it with ~/.imcodes: the pair works on a clone; no git; a size/mtime manifest finds the changed files, the
 *    audit request carries a per-file diff, and at DONE the changes are copied back with conflict refusal and backups.
 *  - `plain_dir`: the project directory is a CONTAINER (the home directory, a volume root, a directory that holds other projects or
 *    nested repositories): none of the above is safe there, so the pair gets the old empty task directory (results via DONE output=).
 *  - `in_place`: last resort: the pair edits the project directory itself; READY lists the changed files and pairs on the same
 *    project run one after another unless Brain passes parallel=true.
 */
export const TASK_PAIR_NON_GIT_MODES = ['git_init', 'cow', 'in_place', 'plain_dir'] as const;
export type TaskPairNonGitMode = typeof TASK_PAIR_NON_GIT_MODES[number];
/** Files larger than this are not tracked by the auto-created repo (listed explicitly in the IM.codes .gitignore block). */
export const TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES = 50 * 1024 * 1024;
export const TASK_PAIR_GIT_INIT_LARGE_FILE_BYTES_ENV = 'IMCODES_PAIR_GIT_INIT_LARGE_FILE_BYTES' as const;
/** Tracked bytes above which the auto-init is refused and rolled back (fallback: COW clone, then in-place). */
export const TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES = 2 * 1024 * 1024 * 1024;
export const TASK_PAIR_GIT_INIT_MAX_TRACKED_BYTES_ENV = 'IMCODES_PAIR_GIT_INIT_MAX_TRACKED_BYTES' as const;
/** Set to `off` to never `git init` a non-git project (straight to the COW / in-place fallbacks). */
export const TASK_PAIR_GIT_INIT_ENABLE_ENV = 'IMCODES_PAIR_GIT_INIT' as const;
/** Markers of the block IM.codes adds to the project's .gitignore. */
export const TASK_PAIR_GITIGNORE_BLOCK_START = '# >>> IM.codes (auto: non-git project) >>>' as const;
export const TASK_PAIR_GITIGNORE_BLOCK_END = '# <<< IM.codes <<<' as const;
/** Directory names left out of a COW clone (rebuildable weight; not cloned, not compared, not copied back). */
export const TASK_PAIR_CLONE_EXCLUDE_DIR_NAMES = [
  ...TASK_PAIR_HEAVY_DIR_NAMES,
  '.venv', 'venv', '__pycache__', 'target', '.gradle', '.mypy_cache', '.pytest_cache', '.tox',
] as const;
/** Directory inside a COW task directory holding the base manifest (never part of a comparison). */
export const TASK_PAIR_COW_MANIFEST_DIR = '.imcodes-cow' as const;
/** Directory inside a COW task directory holding the apply-back journal and the pre-apply backups. */
export const TASK_PAIR_APPLY_BACK_DIR = '.imcodes-applyback' as const;
/** The per-file diff a COW audit request refers to is cut at this size; the whole diff is written to the task directory. */
export const TASK_PAIR_REVIEW_DIFF_MAX_BYTES = 48 * 1024;
/** READY_FOR_AUDIT attribute listing the changed files (in-place mode: stated by the executor). */
export const TASK_PAIR_READY_FILES_ATTR = 'files' as const;
/** Free space on the worktree volume below which closed pairs are stripped, oldest first. */
export const TASK_PAIR_DISK_LOW_FREE_BYTES = 10 * 1024 ** 3;
export const TASK_PAIR_DISK_LOW_FREE_FRACTION = 0.05;
/** Below this the notice to Brain says so plainly. */
export const TASK_PAIR_DISK_CRITICAL_FREE_BYTES = 3 * 1024 ** 3;
export const TASK_PAIR_DISK_CRITICAL_FREE_FRACTION = 0.02;
/** A level only recovers once free space is this multiple above its threshold, so the boundary cannot flap. */
export const TASK_PAIR_DISK_RECOVERY_FACTOR = 1.25;
export const TASK_PAIR_DISK_LEVELS = ['ok', 'low', 'critical'] as const;
export type TaskPairDiskLevel = typeof TASK_PAIR_DISK_LEVELS[number];
/** Store meta key holding the last announced level, so Brain hears one message per crossing. */
export const TASK_PAIR_DISK_LEVEL_META_KEY = 'task_pair_disk_level' as const;
/** Pseudo task id of disk notices: they are aggregate notices, never a pair's durable instruction. */
export const TASK_PAIR_DISK_NOTICE_TASK_ID = '__disk_hygiene' as const;
/** Effects of daemon workspace events on the pair timeline. */
export const TASK_PAIR_WORKSPACE_EFFECTS = {
  REMOVED: 'workspace_removed',
  KEPT: 'workspace_kept',
  OUTPUT_SAVED: 'output_saved',
  OUTPUT_FAILED: 'output_failed',
  /** The worktree was moved under the new executor after an executor change. */
  MOVED: 'workspace_moved',
  /** The new executor already had a worktree for the task at the target path; it was adopted (the old path is gone). */
  ADOPTED: 'workspace_adopted',
  /** Another worktree for the same task exists next to the authoritative one; it is only registered, never used. */
  DUPLICATE: 'workspace_duplicate',
  /** The move waits until the old executor and every process working inside the worktree are idle. */
  MOVE_DEFERRED: 'workspace_move_deferred',
  MOVE_FAILED: 'workspace_move_failed',
  /** A non-git project's workspace mode was chosen at pair start (cow clone or in-place). */
  NON_GIT_MODE: 'non_git_mode',
  /** A COW workspace's changes were copied back to the project. */
  APPLY_BACK_APPLIED: 'apply_back_applied',
  /** Nothing to copy back. */
  APPLY_BACK_NOOP: 'apply_back_noop',
  /** The project changed since the clone; nothing was written. */
  APPLY_BACK_CONFLICT: 'apply_back_conflict',
  /** The apply failed midway and was rolled back from the backup. */
  APPLY_BACK_FAILED: 'apply_back_failed',
  /** An applied change was undone from the backup. */
  APPLY_BACK_UNDONE: 'apply_back_undone',
  /** A started pair that had no workspace (its start skipped admission or provisioning failed) got one on a heartbeat. */
  PROVISIONED_LATE: 'workspace_provisioned_late',
} as const;
/** Started, open pairs whose executor must have a workspace; the heartbeat provisions a missing one. */
export const TASK_PAIR_WORKSPACE_REPAIR_STATUSES: readonly TaskPairStatus[] = ['working', 'in_audit', 'awaiting_audit', 'rework'];
/** Verb of daemon workspace events (never a marker verb). */
export const TASK_PAIR_WORKSPACE_EVENT_VERB = 'WORKSPACE' as const;
/** Verb/effect of a daemon-generated localized title landing on a pair (never a marker verb). */
export const TASK_PAIR_TITLE_EVENT_VERB = 'TITLE' as const;
export const TASK_PAIR_TITLE_GENERATED_EFFECT = 'title_generated' as const;
/** Daemon-authored event: the round's material was held because its head does not build on the round base. */
export const TASK_PAIR_MATERIAL_EVENT_VERB = 'MATERIAL' as const;
export const TASK_PAIR_MATERIAL_HELD_EFFECT = 'material_held' as const;
/** Result of a repeated STARTED from the current executor of an already-working pair: nothing is recorded or rewritten. */
export const TASK_PAIR_IDEMPOTENT_STARTED_EFFECT = 'idempotent_started' as const;
/**
 * Known non-informative titles a pair can carry (a legacy-import default
 * objective, a formatting fallback used elsewhere for a missing title).
 * Back-fill treats these the same as no title at all; every other stored
 * title is presumed deliberate (explicit or already regenerated) and is
 * never touched.
 */
export const TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS = ['Delegated supervised task', '(untitled task)'] as const;

/**
 * The workspace rules every pair participant gets, in the marker contract and
 * in the daemon's briefs. One text, so the contract and the deliveries agree.
 */
export const TASK_PAIR_WORKSPACE_RULES = [
  'Workspace: the daemon gives every pair one and names it in the executor brief and in the auditor\'s audit request.',
  'A code task in a git project gets a git worktree under ~/.imcodes/worktrees: READY_FOR_AUDIT <taskId> worktree=<absolute path> head=<commit> base=<commit>.',
  `Any other task (the project is not a git repo, or Brain dispatched it with workspace=dir) gets a task directory under ~/.imcodes/${TASK_PAIR_WORKS_DIR}/<project>/<taskId>/: work and write results there; READY_FOR_AUDIT <taskId> path=<the directory or the result files>, no git HEAD needed.`,
  'Never work in the main checkout or /tmp, and never delete the workspace by hand: the daemon removes it 7 days after the pair ends (DONE/CANCEL), and keeps a git worktree that still has uncommitted work or commits not yet integrated into origin/dev.',
  'If your workspace is missing, rebuild it from the original branch (or use the rebuilt path the daemon sends) and continue; do not wait.',
  'A project that is not a git repository: when git is installed the daemon makes it a LOCAL repo (baseline commit, repo-local identity, no remote, never a push; heavy directories and files over 50 MB stay untracked via a marked block in .gitignore; refused above 2 GB tracked) and the normal worktree flow above runs; at DONE the daemon merges your branch into the project and refuses any file the user has uncommitted edits in. Fallbacks (no git, over the cap, init failed): a copy-on-write CLONE in the task directory, no git (the daemon finds your changed files by comparing with a manifest, the auditor gets a per-file diff, READY path=<clone>, and at DONE the changes are copied back with conflicts refused and overwritten files backed up); else IN-PLACE editing of the project directory (READY path=<project dir> files=<comma separated changed files>; pairs on that project run one at a time unless Brain passes parallel=true). The mode is fixed at pair start. A directory that is a CONTAINER (the home directory, a volume root, a directory holding other registered projects or nested repositories) is never made a repo, cloned or edited: it gets an empty task directory and results come back through DONE output=. A later pair on a repo IM.codes made starts from the files as they are on disk (uncommitted edits are committed as a snapshot first, unless the owner has committed there themselves). Deleting unchanged files of a clone frees no disk (shared blocks); only the whole workspace or files you changed do.',
  'After an executor change the daemon moves the worktree under the new executor and names the one authoritative path; never work in a second copy of it. Git writes (reset, checkout, cherry-pick, commit) in the main checkout by a pair participant are refused or reported to Brain at once.',
  'Deliverables: judge from the task type whether the result must outlive the pair (a report, document or asset the user keeps) or is only temporary (scratch work, or code that is committed locally). If it must be kept, end with DONE <taskId> output=<path inside the workspace> [dest=<path inside the project directory>]: the daemon copies it into the project directory (by default under the same relative path, never overwriting) and tells the user where. Temporary work: plain DONE.',
].join(' ');

/** User-selectable engines. The retired `legacy` value is intentionally not
 * offered by settings, but remains part of the stored-value type so old
 * snapshots can be read and migrated without data loss. */
export const TASK_PAIR_ENGINES = ['pairs'] as const;
export type TaskPairEngine = 'pairs' | 'legacy';
export const TASK_PAIR_DEFAULT_ENGINE: TaskPairEngine = 'pairs';
/** Global override for every project; `legacy` is accepted only to resolve old
 * environments to inert/off during migration. */
export const TASK_PAIR_ENGINE_ENV = 'IMCODES_SUPERVISION_ENGINE' as const;
/**
 * The resolved engine state for a project, including the inert `off` state:
 * a project whose supervision mode is `off` and which has no explicit engine
 * choice runs neither engine. Distinct from {@link TaskPairEngine}, which is
 * only the two engines a project can explicitly choose between.
 */
export type TaskPairEngineState = TaskPairEngine | 'off';

/**
 * Stated in the pairs contract (Brain's dispatch prompt, and the
 * executor/auditor brief) so a project with its own dispatch/audit workflow
 * is never fought over. Kept as one shared string so the clause cannot drift
 * between the places it is injected.
 */
export const TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE: string =
  'If the project defines its own dispatch/audit/pairing workflow (e.g. in '
  + 'AGENTS.md/CLAUDE.md/project rules), that workflow takes precedence over '
  + 'this IM.codes pairs flow. Follow the project\'s rules for auditor choice, '
  + 'heartbeat, ledger and receipts; use IM.codes markers only where the '
  + 'project\'s rules don\'t cover something.';

/**
 * Stated in the pairs contract and the executor/auditor briefs so Brain is
 * never paged for what the pair can settle itself. Kept as one shared string
 * so the rule cannot drift between the places it is injected, and so the
 * daemon's own Brain-notification code can be reviewed against the same text.
 */
export const TASK_PAIR_BRAIN_REPORTING_RULE: string =
  'Routine progress, REWORK rounds and non-blocking findings stay inside the '
  + 'pair. Escalate to Brain immediately (send_message or BLOCKED/NEEDS_INPUT) '
  + 'when the pair cannot decide scope/acceptance, conflicting approaches, '
  + 'ownership overlap, an unreachable target, or an environment/infra '
  + 'problem that the pair genuinely cannot resolve; include the options and '
  + 'a recommendation. At the end report DONE (or a PASS ready to '
  + 'integrate), or a BLOCKED/NEEDS_INPUT the pair cannot resolve. The only '
  + 'other Brain contact is an auditor\'s conditional non-convergence report '
  + 'at REWORK rounds 2, 4, 6… when the pair is not clearly converging.';

/**
 * Division of labour: Brain (usually the stronger model) does quick analysis,
 * sets direction and makes decisions; the pair does the legwork and the
 * verification, decides within that direction, and escalates when it can't.
 */
export const TASK_PAIR_ANALYZE_BEFORE_DISPATCH_RULE: string =
  'Direction before dispatch: Brain (usually the stronger model) owns '
  + 'analysis and decisions; the pair does the legwork and the verification. '
  + 'Before a DISPATCH, Brain does only a QUICK analysis (read the actual '
  + 'failure, locate the likely code path, test a cheap hypothesis) and gives '
  + 'the pair a DIRECTION: what is proven, what is suspected, and what to find '
  + 'out. Executor and auditor gather the evidence along that direction and '
  + 'decide for themselves whenever the evidence makes the decision clear. '
  + 'When it does not, or the evidence points away from the direction, they '
  + 'report the findings with options and a recommendation to Brain for a '
  + 'new direction instead of guessing or looping. Brain decides each next '
  + 'step from task difficulty and pair feedback: analyze further itself, '
  + 'change the direction, or let the pair execute.';

/**
 * Pair execution discipline learned from slow pairs: stay in your own
 * workspace, report on state changes only, and keep evidence bound to one
 * frozen head.
 */
export const TASK_PAIR_EXECUTION_DISCIPLINE_RULE: string =
  'Execution discipline: run every command and write every file inside your '
  + 'pair workspace or a temp directory, never in the project main checkout; '
  + 'credentials never go into any git checkout. Report to Brain only on a '
  + 'real state change (READY, DONE, BLOCKED/NEEDS_INPUT, a decision needed) '
  + 'or as one summary table every 2 hours during long runs; no '
  + 'minute-by-minute status and never relay another pair\'s report. For long '
  + 'real-machine evidence, freeze the head: bind all evidence to one exact '
  + 'commit and rebase only once at the end; after any rebase, check that it '
  + 'removed none of the recently merged code before collecting evidence. '
  + 'On shared test machines, only start detached processes (never tied to '
  + 'an SSH session), only remove paths you created by exact name, and never '
  + 'touch the machine default daemon, its tasks or its files. Before '
  + 'removing test resources, write the evidence summary (paths, hashes, key '
  + 'numbers) into the pair workspace; tear down the images and build caches '
  + 'you created and check free disk before large runs. When Brain freezes a '
  + 'head, it names the safety fixes merged after it and the steps they make '
  + 'unsafe on the frozen build. Test scripts on real machines never expand '
  + 'the home directory ($HOME, $home, ~, %USERPROFILE%): they use explicit '
  + 'scoped absolute paths, abort if a write target resolves into a default '
  + 'daemon home, and compare the default-state hashes after every setup '
  + 'step, stopping at the first mismatch. The same holds for the agent '
  + 'CLIs a test daemon launches: pin every agent binary by absolute path and '
  + 'every agent home (CODEX_HOME, the Claude config dir and the like) to a '
  + 'scoped directory, and abort if any of them resolves through the system '
  + 'PATH or into the real user home.';

/**
 * Generic pair start-up rules for every IM.codes project, derived from where
 * pairs actually stall: unstated boundaries, late discovery of missing
 * environments, unbounded acceptance and redundant merge verification.
 */
export const TASK_PAIR_BRIEF_STRUCTURE_RULE: string =
  'Brief structure (Brain): every DISPATCH brief states, in this order: Goal '
  + '(the user-visible outcome, quoting the request); Proven (facts already '
  + 'verified, with evidence); Suspected (hypotheses to confirm or refute); '
  + 'Direction; Acceptance (numbered, checkable items); Boundary checks '
  + '(extremes the change must not break: sizes and scale limits, every key '
  + 'or identifier form, defaults and fallbacks, concurrency, restart and '
  + 'upgrade, isolation from real user data); Evidence method and '
  + 'environment (how and where each acceptance item is proven, and which '
  + 'machines, accounts or credentials it needs); Out of scope. Acceptance is '
  + 'risk-tiered by default: full coverage for paths the change touches '
  + 'directly, a smoke check for paths it only rides on, unless the owner '
  + 'asks for more.';

export const TASK_PAIR_ENVIRONMENT_PREFLIGHT_RULE: string =
  'Preflight first (executor): before implementing, check that everything '
  + 'the acceptance needs is actually available: machines reachable, '
  + 'accounts and credentials usable, services and test data present, and '
  + 'any shared machine free. Report every gap immediately as NEEDS_INPUT '
  + 'with options (an alternative machine, a test double, a narrower row) '
  + 'instead of discovering it hours later. Reuse existing shared test '
  + 'tooling before building a new harness, and prefer scripted checks '
  + 'against real services over hand-driven UI.';

export const TASK_PAIR_BOUNDARY_AUDIT_RULE: string =
  'Boundary audit (auditor): before PASS, check every Boundary checks item in '
  + 'the brief and state the evidence for each. For any change to limits, '
  + 'timeouts, formats, keys, defaults, paths or filters, also test the '
  + 'extremes the brief may have missed (large and slow inputs, every '
  + 'identifier variant, missing or stale state, the default install, '
  + 'restart). When a change edits or replaces a shared function, list every '
  + 'call site and state its behaviour change; for heuristics, warnings and '
  + 'alerts, require a normal-use case that must NOT trigger and a time or '
  + 'cost bound. For protocol or wire changes, check version skew: an older '
  + 'server or daemon on the other side (missing or unknown fields must keep '
  + 'the safe old behaviour). For data migrations, check keys shared by '
  + 'several owners (two daemons, two users of one project) so the first '
  + 'owner\'s step cannot strand the others. When a producer changes what a '
  + 'message carries (fields dropped, partial frames), list every consumer '
  + 'and show it keeps the last good values. For code that runs per event, '
  + 'per streamed chunk or per heartbeat, state its per-call cost at '
  + 'production-shaped data size with a measurement. A missed boundary that '
  + 'breaks existing behaviour is a P0.';

export const TASK_PAIR_MERGE_VERIFICATION_RULE: string =
  'Merge verification (Brain): read the diff for removed lines of recently '
  + 'merged work and for boundary regressions before merging. When the '
  + 'executor reported complete full-suite results for the exact head on a '
  + 'base equal to the current integration tip, rerun only type checks and '
  + 'the suites the change touches; otherwise rerun the full suites. A '
  + 'change to a state machine, protocol or marker handling always includes '
  + 'the end-to-end tests that drive it. Batch small verified merges.';

/**
 * Multi-round deliveries (2026-09-30): a task delivered in stages (spinner,
 * then console sync, then watchdog attribution) used to continue on an
 * already-passed pair, where every later READY_FOR_AUDIT/PASS was recorded
 * as unusual and the panel kept saying "passed".
 */
export const TASK_PAIR_NEXT_ROUND_RULE: string =
  'Multi-round delivery: split a task into rounds when each round is a '
  + 'separately auditable, mergeable deliverable (the first PASS can be '
  + 'integrated before the next round starts). Only Brain opens the next '
  + 'round, on a PASSED pair that is not yet DONE: NEXT_ROUND <taskId> '
  + '[base=<commit>] [note="what round N delivers"]. The pair returns to '
  + 'working with the same workspace, executor and auditor; the delivery '
  + 'round number goes up. base defaults to the previous round\'s PASSed '
  + 'head; name base=<commit> (typically the dev tip that already contains '
  + 'the merged previous round) when the executor must build on something '
  + 'else. The executor commits on top of that base, then writes '
  + 'READY_FOR_AUDIT for the new round (a base= that differs from the round '
  + 'base is rejected, and a head that does not descend from it is sent '
  + 'back); the auditor\'s PASS/REWORK then applies to that round only. '
  + 'An executor whose brief names further rounds reports the PASSed head to '
  + 'Brain and waits for NEXT_ROUND instead of writing DONE. '
  + 'Do not DONE a pair you still intend to continue: a DONE or CANCELled '
  + 'pair cannot open another round (use a new taskId), and nobody but '
  + 'Brain may write NEXT_ROUND. Update the brief (pair_task_update) with '
  + 'the new round\'s items before or with NEXT_ROUND.';

/**
 * From the 2-hourly stall review: most READYs bounced within minutes for
 * missing evidence, and pairs stopped to ask Brain about harness problems
 * they could fix themselves.
 */
export const TASK_PAIR_READY_SELF_CHECK_RULE: string =
  'READY self-check (executor): before READY_FOR_AUDIT, map every numbered '
  + 'acceptance item and every Boundary checks item to its evidence (command, '
  + 'machine, exact head, result). For a bug fix, include the counterexample '
  + 'that fails on the base and passes on the head. Real-machine evidence '
  + 'must come from the head under test (a scoped build), never from an '
  + 'installed or default daemon. Any unmapped item means not READY: keep '
  + 'working or raise NEEDS_INPUT. Send the validation report together with '
  + 'the READY. Brain answers a question on a pair in audit with a plain '
  + 'reply, never WORKING, which takes the pair out of audit and voids a '
  + 'pending PASS.';

export const TASK_PAIR_SELF_SUFFICIENCY_RULE: string =
  'Fix your own harness (pair): test stacks and their URLs, test accounts '
  + 'and keys minted in your own stack, and extra test participants are the '
  + 'pair\'s job, not decisions for Brain. When a tool or channel fails, '
  + 'switch to an available alternative (for example plain ssh instead of a '
  + 'machine tool) before escalating. Any "cannot" sent to Brain includes '
  + 'the exact command, the exact error and the alternatives already tried. '
  + 'When a switch or option is missing, create the condition another way '
  + '(an unpublished port, a temporary firewall rule on a test machine) '
  + 'instead of dropping the row.';

/**
 * Brain-side rule (2026-09-29 22:00 review): a scope decision given only by
 * message is lost when an auditor is replaced; the replacement audits the
 * original brief and reopens settled rows (core_lane: six voided P0s).
 */
export const TASK_PAIR_SCOPE_DECISION_RULE: string =
  'When Brain narrows, re-scopes or classifies acceptance (N/A, accepted '
  + 'elsewhere), it writes the decision into the pair brief itself '
  + '(pair_task_update), so any current or future auditor audits the same '
  + 'scope; a decision sent only by message does not bind a replaced auditor.';

/** Short liveness rule shown with Brain decision notices. */
export const TASK_PAIR_BRAIN_REPLY_RESOLUTION_RULE: string =
  'A plain reply to the participant (including delegation_reply) resolves the wait and stops reminders.';

/**
 * Stated in the pairs contract and the executor/auditor briefs (owner
 * evidence: an executor's questions written only in its own reply, never
 * sent anywhere, left a pair stalled until the owner happened to notice).
 * Kept as one shared string so the rule cannot drift between the places it
 * is injected.
 */
export const TASK_PAIR_ASK_DONT_JUST_REPLY_RULE: string =
  'Ask, don\'t just reply: whenever you need a decision, clarification or '
  + 'confirmation from Brain (scope, conflicting instructions, a blocked '
  + 'tool, missing material), send it to Brain as a message (send_message to '
  + 'the Brain session, or a BLOCKED/NEEDS_INPUT marker with note="...", '
  + 'which the daemon relays to Brain), then continue other work or wait -- '
  + 'never leave the question only in your own reply. Questions for your '
  + 'partner (executor/auditor) go to them by message the same way. If the '
  + 'pair still cannot decide, escalate to Brain with options and a '
  + 'recommendation instead of looping.';

/** Shared auditor direction used in contracts and every generated brief. */
export const TASK_PAIR_AUDITOR_PROPOSAL_RULE: string =
  'For every blocking finding, propose a concrete solution: approach, likely '
  + 'files/functions, trade-offs, and (optionally) a causal test; give an '
  + 'appropriate proposal for non-blocking findings too. The auditor '
  + 'co-owns convergence, without writing the executor\'s code. If a decision '
  + 'is not yours to make, escalate it to Brain with options and a '
  + 'recommendation rather than repeating REWORK.';

export const TASK_PAIR_VALIDATION_REPORT_RULE: string =
  'The executor\'s READY_FOR_AUDIT validation must include the exact test '
  + 'commands, machine, exact HEAD, pass/fail/skip counts per suite, and '
  + 'any failure with proof it reproduces on the base. The auditor trusts a '
  + 'complete named-commit report and does not rerun suites; run tests only '
  + 'when evidence is missing or for one concrete suspicion.';

export const TASK_PAIR_NO_INTERMEDIATE_BRAIN_UPDATES_RULE: string =
  'Do not send Brain status updates, intermediate heads, or test-run requests; '
  + 'Brain hears only final PASS/DONE, a genuinely undecidable escalation, or '
  + 'the auditor\'s conditional non-convergence report at REWORK rounds 2, '
  + '4, 6… when the pair is not clearly converging.';

export const TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE: string =
  'At REWORK rounds 2, 4, 6… assess convergence. If the pair is not clearly '
  + 'converging, the auditor (not the daemon) sends Brain one concise report '
  + 'with the problem, what was tried, options, and a recommendation; otherwise '
  + 'keep resolving it inside the pair.';

/**
 * Stated in the pairs contract and the executor brief. Owner report: two
 * PASSed pairs sat unintegrated for hours because Brain relied on the
 * executor remembering to say so -- the daemon now tells Brain itself on
 * PASS/DONE (see buildPassDoneNoticeMessage), but the executor still owns
 * its own branch: never merge/push to dev or main itself, only Brain
 * integrates.
 */
export const TASK_PAIR_INTEGRATION_RULE: string =
  'After PASS: make sure the PASSed head is committed locally in your pair worktree (never push any branch), then report the worktree path and HEAD '
  + 'to Brain in your reply (the daemon also tells Brain, but say it '
  + 'yourself too). Brain cherry-picks the commit into dev and pushes dev. '
  + 'Keep evidence, logs and scratch files out of the product commits Brain '
  + 'merges: leave them untracked in the workspace or put them in a separate '
  + 'commit whose subject starts with "evidence:".';

/**
 * Stated in the Brain contract for a project not enabled for pairs (owner
 * decision, 2026-09-26, tsk_cd_pairs_optin: pairs is no longer a zero-config
 * default). Kept as one shared string so the daemon's own auto-start gates
 * can be reviewed against the same text.
 */
export const TASK_PAIR_INERT_AUTHORIZATION_RULE: string =
  'This project is not enabled for the pairs engine: never auto-start a '
  + 'pair here, and no marker or DISPATCH can start one either -- the '
  + 'engine ignores this project until it is enabled. If the user '
  + 'explicitly asks for audited/paired work, ask them to confirm first; '
  + 'on an explicit yes, tell them to enable it themselves (Session/Project '
  + 'Settings -> Task Pairs -> Engine -> Task pairs) since no tool or '
  + 'marker can enable it for them. If the project defines its own '
  + 'dispatch/audit/pairing workflow (e.g. in AGENTS.md/CLAUDE.md/project '
  + 'rules), tell the user about the conflict before recommending that, '
  + 'and only recommend it if they explicitly override after hearing it.';

export const TASK_PAIR_DEFAULT_MAX_CONCURRENCY = 5;
export const TASK_PAIR_HEARTBEAT_MS = 6 * 60_000;
/**
 * A session with no turn in progress but leftover background work or open-tool
 * counters (a Claude subagent/native task, a Codex background item) stops
 * blocking pair admission once it has produced no output and no activity for
 * this long: a counter that never drains must not keep a queued pair waiting
 * forever on a session that is idle in every other respect. Fresh background
 * work still counts as working.
 */
export const TASK_PAIR_STALE_RESIDUAL_WORK_MS = 5 * 60_000;
/**
 * How long the side(s) whose turn it is (or, with no real auditor, the
 * executor alone) must have been continuously idle before an out-of-band
 * nudge fires -- independent of, and faster than, the TASK_PAIR_HEARTBEAT_MS
 * heartbeat tick. Shares the same nudge/silence/escalation machinery as the
 * heartbeat's own quiet-side check (see scheduler.ts).
 */
export const TASK_PAIR_BOTH_IDLE_NUDGE_MS = 2 * 60_000;
/** Silent ticks before a side stops being nudged and escalates. */
export const TASK_PAIR_SILENCE_LIMIT = 3;
/** Marker-triggered daemon messages per pair, per reason, per audit round. */
export const TASK_PAIR_MESSAGE_CAP_PER_ROUND = 2;
export const TASK_PAIR_ATTR_VALUE_MAX = 500;
export const TASK_PAIR_BRIEF_MAX_BYTES = 256 * 1024;
/** `auditor=none`: no audit wanted. */
export const TASK_PAIR_NO_AUDITOR = 'none' as const;
/** Task id meaning "the writer's single open pair" (or, for `QUEUE - max=`, the writer's queue). */
export const TASK_PAIR_INFER_TASK_ID = '-' as const;

export const TASK_PAIR_VERBS = [
  'DISPATCH', 'QUEUE', 'STARTED', 'WORKING', 'READY_FOR_AUDIT', 'PASS', 'REWORK',
  'DONE', 'BLOCKED', 'NEEDS_INPUT', 'REASSIGN', 'CANCEL', 'CLAIM', TASK_PAIR_CHECK_VERB, TASK_PAIR_NEXT_ROUND_VERB,
] as const;
export type TaskPairVerb = typeof TASK_PAIR_VERBS[number];

export const TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION = 'awaiting_brain_decision' as const;
/** Local-storage namespace for the web task-pair status panel (layout suffix is added by the UI). */
export const TASK_PAIR_STATUS_PANEL_STORAGE_KEY = 'imcodes.task-pair-status-panel.collapsed' as const;
export const TASK_PAIR_STATUSES = [
  'queued', 'working', 'in_audit', 'awaiting_audit', TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION, 'rework', 'passed', 'done', 'cancelled',
] as const;
export type TaskPairStatus = typeof TASK_PAIR_STATUSES[number];
export const TASK_PAIR_TERMINAL_STATUSES: readonly TaskPairStatus[] = ['done', 'cancelled'];
/** Statuses that occupy a concurrency slot. */
export const TASK_PAIR_OPEN_STATUSES: readonly TaskPairStatus[] = ['working', 'in_audit', 'awaiting_audit', TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION, 'rework', 'passed'];
/**
 * Statuses that reserve a named executor/auditor.  A queued pair is only a
 * scheduling intent; it must not hold a participant and thereby prevent the
 * pair that is actually running from progressing (or make REASSIGN bounce
 * back to the queue).  `passed` remains held until the executor reports DONE
 * so the Brain can still accept the audited result.
 */
export const TASK_PAIR_PARTICIPANT_STATUSES: readonly TaskPairStatus[] = [
  'working', 'in_audit', 'awaiting_audit', TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION,
  'rework', 'passed',
];

export const TASK_PAIR_FLAGS = [
  'blocked', 'needs_input', 'unaudited', 'needs_auditor', 'over_limit', 'off_pool', 'economy_unreviewed',
  'waiting_for_capacity', 'executor_silent', 'verdict_inconsistent', 'awaiting_audit_ignored',
  'replacement_churn', 'markers_unresolved', 'all_providers_limited', 'auditor_capacity_hold', 'policy_violation',
  'no_pool_configured', 'brain_reminder_due',
] as const;
export type TaskPairFlag = typeof TASK_PAIR_FLAGS[number];

/** Brain escalation reminder cadence: 5m, then 10m, then no more than 15m. */
export const TASK_PAIR_BRAIN_REMINDER_INITIAL_MS = 5 * 60_000;
export const TASK_PAIR_BRAIN_REMINDER_SECOND_MS = 10 * 60_000;
export const TASK_PAIR_BRAIN_REMINDER_REPEAT_MS = 15 * 60_000;
/** Hard minimum between any two aggregate Brain heartbeat/reminder messages. */
export const TASK_PAIR_BRAIN_MIN_GAP_MS = 10 * 60_000;

/**
 * Set by the daemon when a READY's head definitely does not descend from the
 * round base (git said "not an ancestor"): PASS is held until a fresh READY
 * replaces the material. REWORK is unaffected. Persisted with the pair, so it
 * survives a daemon restart.
 */
export interface TaskPairMaterialHold {
  reason: 'round_base_not_ancestor';
  head: string;
  base: string;
  at: number;
}

/** Base commit of a delivery round after NEXT_ROUND. */
export interface TaskPairRoundBase {
  commit: string;
  /** `passed_head`: the previous round's PASSed head; `brain`: a commit Brain named (typically the dev tip that contains the merged previous round). */
  source: 'passed_head' | 'brain';
  deliveryRound: number;
  /** The previous round's PASSed head when known, kept even when Brain names another base. */
  previousHead?: string;
  note?: string;
  at: number;
}

export const TASK_PAIR_ROLES = ['brain', 'executor', 'auditor', 'other', 'daemon'] as const;
export type TaskPairRole = typeof TASK_PAIR_ROLES[number];

export const TASK_PAIR_EVENT_SOURCES = ['marker', 'implicit_dispatch', 'legacy_tool', 'legacy_import', 'heartbeat', 'queue', 'mcp', 'daemon'] as const;
export type TaskPairEventSource = typeof TASK_PAIR_EVENT_SOURCES[number];

/** Reasons for marker-triggered daemon messages; each is capped per round. */
export const TASK_PAIR_CAPPED_REASONS = {
  verdict_correction: 'verdict_inconsistent',
  done_reminder: 'awaiting_audit_ignored',
  policy_rejection: 'policy_violation',
  blocked_replacement: 'replacement_churn',
  unresolved_hint: 'markers_unresolved',
} as const satisfies Record<string, TaskPairFlag>;
export type TaskPairCappedReason = keyof typeof TASK_PAIR_CAPPED_REASONS;

export const TASK_PAIR_VERDICT_JUDGEMENTS = ['consistent', 'inconsistent', 'missing_severity', 'implicit_zero'] as const;
export type TaskPairVerdictJudgement = typeof TASK_PAIR_VERDICT_JUDGEMENTS[number];

export type TaskPairSeverityCounts = Record<AuditSeverity, number>;

/** How long a queued pair may sit unable to start before Brain hears about it (once, combined per project). */
export const TASK_PAIR_QUEUE_STALL_NOTICE_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Marker grammar and parsing
// ---------------------------------------------------------------------------

export interface TaskPairMarker {
  verb: string;
  /** Upper-cased known verb, or undefined for an unrecognized one. */
  knownVerb?: TaskPairVerb;
  taskId: string;
  attrs: Record<string, string>;
  lineIndex: number;
  /** Position among markers of this turn; with the turn id this is the idempotency key. */
  markerIndex: number;
  /** QUEUE brief captured between the marker and its END line, verbatim. */
  brief?: string;
  /** QUEUE without a matching END in the same turn. */
  briefMissing?: boolean;
}

export interface TaskPairMarkerScan {
  markers: TaskPairMarker[];
  /** Line indexes of active marker and END lines, hidden from display. */
  markerLineIndexes: number[];
}

const MARKER_LINE_RE = new RegExp(
  String.raw`^[ \t]{0,3}<!--\s*${TASK_PAIR_MARKER_TAG}\s+([A-Za-z_]+)\s+([A-Za-z0-9._:-]{1,64}|-)`
  + String.raw`((?:\s+[a-z0-9_]+=(?:"(?:[^"\\]|\\.){0,${TASK_PAIR_ATTR_VALUE_MAX}}"|[^\s">]+))*)\s*-->[ \t]*$`,
);
const ATTR_RE = /([a-z0-9_]+)=(?:"((?:[^"\\]|\\.)*)"|([^\s">]+))/g;

function briefEndLineRe(taskId: string): RegExp {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`^[ \t]{0,3}<!--\s*${TASK_PAIR_BRIEF_END_TAG}\s+${escaped}\s*-->[ \t]*$`);
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const key = match[1]!;
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!;
    attrs[key] = value;
  }
  return attrs;
}

function knownVerb(verb: string): TaskPairVerb | undefined {
  const upper = verb.toUpperCase();
  return (TASK_PAIR_VERBS as readonly string[]).includes(upper) ? upper as TaskPairVerb : undefined;
}

/**
 * Scan assistant-authored text for task-pair markers. Markers inside fenced
 * code, inline in prose, or inside a QUEUE brief are not protocol.
 */
export function scanTaskPairMarkers(text: string): TaskPairMarkerScan {
  const lines = text.split(/\r?\n/u);
  const markers: TaskPairMarker[] = [];
  const markerLineIndexes: number[] = [];
  let fence: MarkdownFenceState | undefined;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const advanced = advanceMarkdownFence(line, fence);
    fence = advanced.fence;
    if (advanced.fenced) continue;
    const match = line.match(MARKER_LINE_RE);
    if (!match) continue;
    const verb = match[1]!;
    const taskId = match[2]!;
    const marker: TaskPairMarker = {
      verb,
      knownVerb: knownVerb(verb),
      taskId,
      attrs: parseAttrs(match[3] ?? ''),
      lineIndex,
      markerIndex: markers.length,
    };
    markerLineIndexes.push(lineIndex);
    if ((marker.knownVerb === 'QUEUE' || marker.knownVerb === 'DISPATCH') && taskId !== TASK_PAIR_INFER_TASK_ID) {
      // The brief runs to the matching END line regardless of fences inside it.
      const endRe = briefEndLineRe(taskId);
      let endIndex = -1;
      for (let probe = lineIndex + 1; probe < lines.length; probe += 1) {
        if (endRe.test(lines[probe]!)) { endIndex = probe; break; }
      }
      if (endIndex >= 0) {
        const brief = lines.slice(lineIndex + 1, endIndex).join('\n');
        marker.brief = brief.length > TASK_PAIR_BRIEF_MAX_BYTES ? brief.slice(0, TASK_PAIR_BRIEF_MAX_BYTES) : brief;
        markerLineIndexes.push(endIndex);
        lineIndex = endIndex;
        fence = undefined;
      } else {
        marker.briefMissing = true;
      }
    }
    markers.push(marker);
  }
  return { markers, markerLineIndexes };
}

/** Hide active marker and END lines from displayed assistant text; briefs stay visible. */
export function stripTaskPairMarkersForDisplay(text: string): string {
  const { markerLineIndexes } = scanTaskPairMarkers(text);
  if (markerLineIndexes.length === 0) return text;
  const hidden = new Set(markerLineIndexes);
  return text.split(/\r?\n/u).filter((_line, index) => !hidden.has(index)).join('\n');
}

/** Cheap pre-check before a full scan. */
export function mayContainTaskPairMarker(text: string): boolean {
  return text.includes(TASK_PAIR_MARKER_TAG);
}

// ---------------------------------------------------------------------------
// Severity judgement (audit_convergence_v1)
// ---------------------------------------------------------------------------

export function emptySeverityCounts(): TaskPairSeverityCounts {
  return { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
}

export function parseBlockingAttr(value: string | undefined): AuditSeverity[] | undefined {
  if (value === undefined) return undefined;
  return normalizeAuditBlockingSeverities(value.split(',').map((level) => level.trim().toUpperCase()));
}

/**
 * Owner rule: a human/marker-named `blocking=` set is authoritative and never
 * drifts on its own; a config-derived set tracks the Brain's configured
 * `auditBlockingSeverities` and is free to change with it. A pair stored
 * before this field existed has no recorded source -- treated as `config` so
 * it still tracks config, matching every such pair's actual history (it was
 * never given an explicit override, since that path always set `blocking`
 * from the attr directly).
 */
export type TaskPairBlockingSource = 'explicit' | 'config';

export function taskPairBlockingSource(pair: Pick<TaskPairState, 'blockingSource'>): TaskPairBlockingSource {
  return pair.blockingSource ?? 'config';
}

export interface TaskPairVerdictJudgementResult {
  judgement: TaskPairVerdictJudgement;
  counts: TaskPairSeverityCounts;
  blockingCount: number;
  statedBlocking?: AuditSeverity[];
  blockingMismatch: boolean;
}

/**
 * Judge a PASS/REWORK against the pair's blocking set: REWORK needs at least
 * one blocking finding, PASS none. A PASS with no severity at all is the common
 * "no findings" case and counts as zero.
 */
export function judgeTaskPairVerdict(
  verb: 'PASS' | 'REWORK',
  attrs: Record<string, string>,
  pairBlocking: readonly AuditSeverity[],
): TaskPairVerdictJudgementResult {
  const counts = emptySeverityCounts();
  let hasSeverity = attrs.blocking !== undefined;
  for (const level of AUDIT_SEVERITY_LEVELS) {
    const raw = attrs[level.toLowerCase()];
    if (raw === undefined) continue;
    hasSeverity = true;
    const parsed = Number.parseInt(raw, 10);
    counts[level] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  const statedBlocking = parseBlockingAttr(attrs.blocking);
  const blockingMismatch = !!statedBlocking
    && statedBlocking.join(',') !== [...pairBlocking].join(',');
  const blockingCount = pairBlocking.reduce((sum, level) => sum + counts[level], 0);
  let judgement: TaskPairVerdictJudgement;
  if (!hasSeverity) judgement = verb === 'PASS' ? 'implicit_zero' : 'missing_severity';
  else if (verb === 'REWORK') judgement = blockingCount >= 1 ? 'consistent' : 'inconsistent';
  else judgement = blockingCount === 0 ? 'consistent' : 'inconsistent';
  return { judgement, counts, blockingCount, statedBlocking, blockingMismatch };
}

export function isAppliedVerdict(judgement: TaskPairVerdictJudgement): boolean {
  return judgement === 'consistent' || judgement === 'implicit_zero';
}

// ---------------------------------------------------------------------------
// Pair state and the lenient state machine
// ---------------------------------------------------------------------------

export interface TaskPairState {
  taskId: string;
  brain: string;
  executor?: string;
  /** Session name, `none` for no audit, or undefined while one is being picked. */
  auditor?: string;
  title?: string;
  status: TaskPairStatus;
  flags: TaskPairFlag[];
  /** Which side set `blocked` / `needs_input`, so that side's progress clears it. */
  flagSides: Partial<Record<'blocked' | 'needs_input', TaskPairRole>>;
  /** The `note=` text of the BLOCKED/NEEDS_INPUT marker that set flagSides, so an escalation can state the real cause. */
  blockedNote?: string;
  /** Last authoritative Brain/daemon resolution of a participant wait. */
  lastWaitResolution?: { writer: string; note?: string; at: number };
  /** Audit submissions so far. */
  round: number;
  /** Round in which a consistent PASS was recorded, if any. */
  passRound?: number;
  /**
   * Delivery round (1-based; missing means 1): one deliverable cycle of the
   * same pair, advanced only by Brain's NEXT_ROUND on a passed pair. Distinct
   * from `round`, which counts audit submissions and keeps its own caps and
   * convergence cadence across delivery rounds.
   */
  deliveryRound?: number;
  /** What this delivery round builds on; READY_FOR_AUDIT material is checked against it. */
  roundBase?: TaskPairRoundBase;
  /** See {@link TaskPairMaterialHold}. */
  materialHold?: TaskPairMaterialHold;
  blocking: AuditSeverity[];
  /**
   * Where `blocking` came from: `explicit` when a human/marker named it
   * (a `blocking=` attr), `config` when it tracks the Brain's configured
   * `auditBlockingSeverities`. Missing on pairs stored before this field
   * existed -- {@link taskPairBlockingSource} treats that as `config`, so an
   * old pair still picks up config changes rather than freezing at whatever
   * it happened to resolve to.
   */
  blockingSource?: TaskPairBlockingSource;
  lastVerdict?: { verb: 'PASS' | 'REWORK'; counts: TaskPairSeverityCounts; judgement: TaskPairVerdictJudgement; round: number };
  previousAuditors: string[];
  /** Auditor explicitly selected by Brain; heartbeat replacement must keep it
   * unless the session is genuinely unavailable. */
  auditorPinned?: string;
  executorPool?: string;
  auditorPool?: string;
  /**
   * An explicit `executormodel=`/`auditormodel=` marker attr, or a
   * `send_message task.requestedExecutionType.model` captured at implicit
   * dispatch bind time. Owner rule (design D-pool-sync): once set, the
   * pairs engine picks or auto-provisions that role by model match alone,
   * bypassing the execution pool's per-entry role -- for both the initial
   * pick and any later automatic replacement (executor_silent, auditor
   * replacement). The pool's role config governs only a role with neither
   * an explicit session nor an explicit model.
   */
  executorModel?: string;
  auditorModel?: string;
  brief?: string;
  /**
   * Where the audit material is: the executor's worktree at the HEAD it named
   * on READY_FOR_AUDIT. Relayed to the auditor; a pair has no other artifact.
   */
  material?: TaskPairMaterial;
  /** The workspace the daemon created for the pair (see task-pairs/workspace.ts). */
  workspace?: TaskPairWorkspace;
  workspaceRecoveryEscalatedAt?: number;
  /** Human-readable reason a queued pair is waiting for capacity. */
  capacityWaitReason?: string;
  /** Enforcement bookkeeping for auditor proposals and repeated REWORK. */
  auditorProposalNudgeRound?: number;
  /** Workspace Brain asked for on DISPATCH/QUEUE (`workspace=dir`); otherwise chosen by the project. */
  workspaceKind?: TaskPairWorkspaceKind;
  /** Brain's `parallel=true` on DISPATCH/QUEUE: run alongside another pair editing the same non-git project in place. */
  parallelInPlace?: boolean;
  /** Queue priority requested by the Brain; urgent queued work runs before normal FIFO work. */
  urgent?: boolean;
  /** Deliverable to keep, named on DONE (`output=`, `dest=`); copied into the project when the pair ends DONE. */
  output?: TaskPairOutput;
  /** Marker-triggered messages sent this round, per capped reason. */
  capCounts: Partial<Record<TaskPairCappedReason, number>>;
  capRound: number;
  /**
   * Writers already told this closed (cancelled/done) pair can't be revived
   * by their own marker (see the closed-pair guard below). Capped at one
   * notice per writer per closure, not per round -- a closed pair's round
   * never advances again, so a round-scoped cap would either fire once for
   * the pair's whole remaining lifetime regardless of writer, or (if reset)
   * never actually cap a writer that keeps re-emitting the same marker.
   * Cleared whenever Brain/the daemon reopens the pair (D-armed on revival).
   */
  closedNoticeSentTo?: readonly string[];
  /** Actual start time. Undefined while queued; unlike createdAt this does not
   * include time spent waiting for a named participant or a free slot. */
  startedAt?: number;
  createdAt: number;
  updatedAt: number;
  resourceClaims?: TaskPairResourceClaim[];
  resourceCleanup?: { releasedAt: number; resources: string[]; checklist: string[] };
}

export const TASK_PAIR_RESOURCE_MODES = ['exclusive', 'shared'] as const;
export type TaskPairResourceMode = typeof TASK_PAIR_RESOURCE_MODES[number];
export interface TaskPairResourceClaim {
  claimId: string;
  resource: string;
  mode: TaskPairResourceMode;
  owner: string;
  taskId: string;
  project: string;
  claimedAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface TaskPairMaterial {
  worktree?: string;
  head?: string;
  base?: string;
  /** Task-directory material: the directory or the result files. */
  path?: string;
  /** Explicit note that a deletion is intentional; suppresses only the advisory. */
  intentionalNote?: string;
  /** Changed files the executor stated on READY (comma separated); in-place mode's only record of what changed. */
  files?: string;
  at: number;
}

/** Outcome of bringing a non-git pair's changes into the project (git_init: merge of the pair branch; cow: checked copy-back). */
export const TASK_PAIR_APPLY_BACK_STATUSES = ['pending', 'applying', 'applied', 'noop', 'conflict', 'failed', 'undone'] as const;
export type TaskPairApplyBackStatus = typeof TASK_PAIR_APPLY_BACK_STATUSES[number];

export interface TaskPairApplyBackState {
  status: TaskPairApplyBackStatus;
  /** Files (project-relative, `/`-separated) touched, or in conflict. */
  files?: string[];
  at: number;
}

/** How a non-git project is handled for this pair (fixed at pair start). */
export interface TaskPairNonGitInfo {
  mode: TaskPairNonGitMode;
  /** The project directory: cloned from (cow) or edited directly (in_place). */
  projectRoot: string;
  /** Why the step before was not used (cow: git init refused; in_place: git init and clone refused), e.g. `git_unavailable`, `clone_unsupported:EXDEV`. */
  fallbackReason?: string;
  /** git_init: what the auto-created repository tracks and what it left out. */
  gitInit?: { created: boolean; trackedFiles: number; trackedBytes: number; ignoredLargeFiles: number; ignoredHeavyDirs: string[]; ms: number };
  /** cow: what the clone cost. */
  clone?: { files: number; logicalBytes: number; ms: number; extraDiskBytes?: number };
  createdAt: number;
  applyBack?: TaskPairApplyBackState;
}

export interface TaskPairWorkspace {
  kind: TaskPairWorkspaceKind;
  /** Present when the project was not a git repository: how it is handled for this pair. */
  nonGit?: TaskPairNonGitInfo;
  path: string;
  /**
   * Absolute directory where the pair's executor and auditor work by default (their turn cwd). Absent = `path`.
   * Set when it is not the workspace itself, e.g. a non-git project edited in place (the project directory).
   */
  workingDir?: string;
  /** Base commit (worktrees only). */
  base?: string;
  /** Branch name when the workspace has one. */
  branch?: string;
  /** Most recently observed commit, refreshed by markers/heartbeats. */
  lastHead?: string;
  lastHeadAt?: number;
  /** Last rewritten head for which the daemon emitted the advisory. */
  lastRebaseNoticeHead?: string;
  /** Previous head retained as the comparison side for that rewrite. */
  lastRebasePreviousHead?: string;
  createdAt: number;
  /**
   * `ended` from DONE/CANCEL until the retention elapses; then `removed`, or
   * `kept` (with why) while a worktree still holds unsaved work.
   */
  status: 'active' | 'ended' | 'removed' | 'kept';
  endedAt?: number;
  keptReason?: string;
  /**
   * When the daemon stripped this ended pair's rebuildable ignored directories
   * (node_modules, build outputs...). Cleared on reopen; the executor then
   * reinstalls what it needs.
   */
  strippedAt?: number;
  /**
   * Paths this worktree lived at before an executor change moved it. A READY
   * or audit material that still names one resolves to `path`
   * (redirectTaskPairWorkspacePath), so nobody is sent to a dead path.
   */
  previousPaths?: string[];
  /**
   * Other worktrees for the same task found next to the authoritative one
   * (e.g. a rebuild by an earlier executor). Registered so nothing forks
   * silently; never used or removed by the daemon.
   */
  duplicatePaths?: string[];
  movedAt?: number;
}

export { redirectTaskPairWorkspacePath } from './task-pair-workspace-path.js';

export interface TaskPairOutput {
  /** Inside the workspace. */
  path: string;
  /** Inside the project directory; the same relative path when absent. */
  dest?: string;
}

/** READY_FOR_AUDIT attributes that name the audit material. */
export const TASK_PAIR_MATERIAL_ATTRS = ['worktree', 'head', 'base', 'path', 'intentionalNote', 'files'] as const;

/** Two commit ids name the same commit when one is a (>=7 hex) prefix of the other. */
export function sameTaskPairCommit(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(left) || !/^[0-9a-f]{7,64}$/.test(right)) return left === right;
  return left.startsWith(right) || right.startsWith(left);
}

/** Delivery round of a pair (1 until Brain opens another with NEXT_ROUND). */
export function taskPairDeliveryRound(pair: Pick<TaskPairState, 'deliveryRound'>): number {
  return pair.deliveryRound && pair.deliveryRound > 1 ? pair.deliveryRound : 1;
}

function materialFromAttrs(attrs: Record<string, string>, now: number): TaskPairMaterial | undefined {
  const material: TaskPairMaterial = { at: now };
  for (const key of TASK_PAIR_MATERIAL_ATTRS) if (attrs[key]) material[key] = attrs[key];
  if (!material.intentionalNote && attrs.note) material.intentionalNote = attrs.note;
  return material.worktree || material.head || material.base || material.path ? material : undefined;
}

function applyWorkspaceAttr(pair: TaskPairState, attrs: Record<string, string>): void {
  const kind = attrs.workspace;
  if (kind && (TASK_PAIR_WORKSPACE_KINDS as readonly string[]).includes(kind)) pair.workspaceKind = kind as TaskPairWorkspaceKind;
  if (attrs.parallel === 'true') pair.parallelInPlace = true;
}

function applyOutputAttr(pair: TaskPairState, attrs: Record<string, string>): void {
  if (attrs.output) pair.output = { path: attrs.output, ...(attrs.dest ? { dest: attrs.dest } : {}) };
}

export type TaskPairIntent =
  | { kind: 'pick_auditor' }
  | { kind: 'pick_executor' }
  | { kind: 'correction'; to: string; judgement: TaskPairVerdictJudgement }
  | { kind: 'done_reminder'; to: string }
  | { kind: 'rework_notice'; to: string; counts: TaskPairSeverityCounts }
  /** Brain explicitly invalidated a prior PASS and reopened this pair. */
  | { kind: 'brain_reopen_notice'; reason?: string }
  /** Brain opened the next delivery round on a passed pair. */
  | { kind: 'next_round_notice'; note?: string }
  | { kind: 'auditor_proposal_nudge'; to: string }
  | { kind: 'convergence_checkpoint_nudge'; to: string }
  /** An audit round opened: tell the auditor where the material is. */
  | { kind: 'audit_request'; to: string }
  | { kind: 'replace_auditor'; reason: 'executor_blocked' }
  | { kind: 'brain_notice'; flag: TaskPairFlag }
  | { kind: 'slot_changed' }
  | { kind: 'queue_settings'; brain: string; maxConcurrency: number }
  /** A non-Brain writer's marker on a closed (cancelled/done) pair was
   *  recorded, not applied -- only Brain DISPATCH/QUEUE reopens one. Tell
   *  them so, rather than leaving the marker silently inert. */
  | { kind: 'closed_pair_notice'; to: string }
  | { kind: 'policy_notice'; to: string; taskId: string; text: string };

export interface TaskPairTransition {
  /** New or updated pair; undefined when the marker only created nothing (recorded). */
  pair?: TaskPairState;
  fromStatus?: TaskPairStatus;
  toStatus?: TaskPairStatus;
  /** Short machine description of what happened, e.g. `status`, `recorded`, `roles`. */
  effect: string;
  unusual: boolean;
  intents: TaskPairIntent[];
  verdict?: TaskPairVerdictJudgementResult;
  /** Existing claim that blocked a CLAIM marker; exposed for actionable conflict reporting. */
  resourceConflict?: TaskPairResourceClaim;
}

export interface TaskPairApplyContext {
  /** Session that wrote the marker, or `daemon`. */
  writer: string;
  /** Project Brain used when a pair is created without a known dispatcher. */
  fallbackBrain: string;
  /** Project default blocking set. */
  projectBlocking?: readonly AuditSeverity[];
  now: number;
  source: TaskPairEventSource;
  /** Named sessions already held by a different non-terminal pair. */
  busySessions?: ReadonlySet<string>;
  /** Full assistant turn, used only for lightweight auditor-proposal enforcement. */
  turnText?: string;
}

export function isTerminalTaskPairStatus(status: TaskPairStatus): boolean {
  return TASK_PAIR_TERMINAL_STATUSES.includes(status);
}

/**
 * Single source of truth for queued-pair order: urgent first, then FIFO by
 * queueOrder. The scheduler's dispatch loop and any queue-position reporting
 * (pair_list/pair_get) MUST share this comparator -- two independent sorts
 * drift the moment `urgent` is involved, showing a position that does not
 * match what will actually run next.
 */
export function compareQueuedTaskPairs(
  a: { queueOrder: number; state: { urgent?: boolean } },
  b: { queueOrder: number; state: { urgent?: boolean } },
): number {
  return (
    Number(b.state.urgent === true) - Number(a.state.urgent === true)
    || a.queueOrder - b.queueOrder
  );
}

export function taskPairRoleOf(pair: TaskPairState | undefined, writer: string): TaskPairRole {
  if (writer === 'daemon') return 'daemon';
  if (!pair) return 'other';
  if (writer === pair.brain) return 'brain';
  if (writer === pair.executor) return 'executor';
  if (writer === pair.auditor) return 'auditor';
  return 'other';
}

/**
 * Pair binding id: what a `pairs`-engine send_message receipt returns (and
 * records on each delivery) as `assignmentId`.
 *
 * Format: `pair:<taskId>:executor` or `pair:<taskId>:auditor`. It names one
 * role slot of one pair, so it stays the same across replays and across a
 * replacement of the session in that slot; the session itself is the
 * delivery `target`. The `pairs` engine has no registry assignments, so this is
 * NOT a legacy registry assignment id and is never looked up there. It exists
 * so every consumer of the `{ taskId, assignmentId }` receipt contract
 * (delegation claim, dispatch card, legacy tools) works on both engines
 * without asking which engine produced it.
 */
export const TASK_PAIR_BINDING_ID_PREFIX = 'pair' as const;
export const TASK_PAIR_BINDING_ROLES = ['executor', 'auditor'] as const;
export type TaskPairBindingRole = typeof TASK_PAIR_BINDING_ROLES[number];

export function taskPairBindingId(taskId: string, role: TaskPairBindingRole): string {
  return `${TASK_PAIR_BINDING_ID_PREFIX}:${taskId}:${role}`;
}

export function parseTaskPairBindingId(value: unknown): { taskId: string; role: TaskPairBindingRole } | undefined {
  if (typeof value !== 'string') return undefined;
  const prefix = `${TASK_PAIR_BINDING_ID_PREFIX}:`;
  if (!value.startsWith(prefix)) return undefined;
  const cut = value.lastIndexOf(':');
  const taskId = value.slice(prefix.length, cut);
  const role = value.slice(cut + 1);
  if (cut < prefix.length || !taskId || !(TASK_PAIR_BINDING_ROLES as readonly string[]).includes(role)) return undefined;
  return { taskId, role: role as TaskPairBindingRole };
}

/** The binding a session holds in a pair, if it is the executor or the auditor. */
export function taskPairBindingOf(pair: TaskPairState | undefined, sessionName: string): string | undefined {
  if (!pair) return undefined;
  if (sessionName === pair.executor) return taskPairBindingId(pair.taskId, 'executor');
  if (sessionName === pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) return taskPairBindingId(pair.taskId, 'auditor');
  return undefined;
}

function hasAudit(pair: TaskPairState): boolean {
  return pair.auditor !== TASK_PAIR_NO_AUDITOR;
}

function addFlag(pair: TaskPairState, flag: TaskPairFlag): void {
  if (!pair.flags.includes(flag)) pair.flags.push(flag);
}

function removeFlag(pair: TaskPairState, flag: TaskPairFlag): void {
  pair.flags = pair.flags.filter((existing) => existing !== flag);
}

/**
 * Single transition helper for every queued -> working path. Keeping this in
 * the shared state machine prevents queue drain, STARTED/WORKING markers and
 * task-bound sends from disagreeing about the panel's elapsed time or leaving
 * stale capacity flags behind.
 */
export function markTaskPairStarted(pair: TaskPairState, now: number): void {
  pair.status = 'working';
  pair.startedAt = now;
  removeFlag(pair, 'waiting_for_capacity');
  removeFlag(pair, 'no_pool_configured');
  delete pair.capacityWaitReason;
}

/**
 * A reply from the pair's Brain resolves a participant's wait, regardless of
 * which side raised it.  Keep this separate from participant progress: a
 * Brain reply is authoritative input, not work performed by the participant.
 */
export function resolveTaskPairBrainWait(
  pair: TaskPairState,
  now: number,
  resolution?: { writer: string; note?: string },
): void {
  removeFlag(pair, 'blocked');
  removeFlag(pair, 'needs_input');
  delete pair.flagSides.blocked;
  delete pair.flagSides.needs_input;
  pair.blockedNote = undefined;
  if (resolution) {
    pair.lastWaitResolution = {
      writer: resolution.writer,
      ...(resolution.note ? { note: resolution.note } : {}),
      at: now,
    };
  }
  if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) markTaskPairStarted(pair, now);
}

function clonePair(pair: TaskPairState): TaskPairState {
  return {
    ...pair,
    flags: [...pair.flags],
    flagSides: { ...pair.flagSides },
    blocking: [...pair.blocking],
    previousAuditors: [...pair.previousAuditors],
    capCounts: { ...pair.capCounts },
    lastWaitResolution: pair.lastWaitResolution ? { ...pair.lastWaitResolution } : undefined,
    lastVerdict: pair.lastVerdict ? { ...pair.lastVerdict, counts: { ...pair.lastVerdict.counts } } : undefined,
    material: pair.material ? { ...pair.material } : undefined,
    workspace: pair.workspace ? { ...pair.workspace } : undefined,
    output: pair.output ? { ...pair.output } : undefined,
    roundBase: pair.roundBase ? { ...pair.roundBase } : undefined,
    materialHold: pair.materialHold ? { ...pair.materialHold } : undefined,
  };
}

function newPair(taskId: string, brain: string, ctx: TaskPairApplyContext, status: TaskPairStatus): TaskPairState {
  return {
    taskId,
    brain,
    status,
    flags: [],
    flagSides: {},
    round: 0,
    blocking: normalizeAuditBlockingSeverities(ctx.projectBlocking),
    blockingSource: 'config',
    previousAuditors: [],
    capCounts: {},
    capRound: 0,
    ...(status !== 'queued' ? { startedAt: ctx.now } : {}),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/** Try to spend one capped message; past the cap set the flag and tell Brain once. */
function spendCap(pair: TaskPairState, reason: TaskPairCappedReason, intents: TaskPairIntent[]): boolean {
  if (pair.capRound !== pair.round) {
    pair.capRound = pair.round;
    pair.capCounts = {};
  }
  const used = pair.capCounts[reason] ?? 0;
  if (used < TASK_PAIR_MESSAGE_CAP_PER_ROUND) {
    pair.capCounts[reason] = used + 1;
    return true;
  }
  const flag = TASK_PAIR_CAPPED_REASONS[reason];
  if (!pair.flags.includes(flag)) {
    addFlag(pair, flag);
    intents.push({ kind: 'brain_notice', flag });
  }
  return false;
}

/** A new round or a Brain action clears the cap flags and counters. */
function resetCaps(pair: TaskPairState): void {
  pair.capCounts = {};
  pair.capRound = pair.round;
  for (const flag of Object.values(TASK_PAIR_CAPPED_REASONS)) removeFlag(pair, flag);
}

function setRolesFromAttrs(pair: TaskPairState, attrs: Record<string, string>, intents: TaskPairIntent[]): void {
  if (attrs.executor) pair.executor = attrs.executor;
  if (attrs.executormodel) pair.executorModel = attrs.executormodel;
  if (attrs.auditor) {
    if (pair.auditor && pair.auditor !== attrs.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) {
      pair.previousAuditors.push(pair.auditor);
    }
    pair.auditor = attrs.auditor;
    removeFlag(pair, 'needs_auditor');
  }
  if (attrs.auditormodel) pair.auditorModel = attrs.auditormodel;
  if (attrs.title) pair.title = attrs.title;
  if (attrs.pool) pair.executorPool = attrs.pool;
  applyWorkspaceAttr(pair, attrs);
  const blocking = parseBlockingAttr(attrs.blocking);
  if (blocking) { pair.blocking = blocking; pair.blockingSource = 'explicit'; }
  if (!pair.auditor) {
    addFlag(pair, 'needs_auditor');
    intents.push({ kind: 'pick_auditor' });
  }
}

function namedParticipantIsBusy(attrs: Record<string, string>, busySessions: ReadonlySet<string> | undefined): boolean {
  if (!busySessions) return false;
  return (attrs.executor !== undefined && busySessions.has(attrs.executor))
    || (attrs.auditor !== undefined && attrs.auditor !== TASK_PAIR_NO_AUDITOR && busySessions.has(attrs.auditor));
}

const PROGRESS_VERBS: readonly TaskPairVerb[] = ['DISPATCH', 'STARTED', 'WORKING', 'READY_FOR_AUDIT', 'PASS', 'REWORK', 'DONE'];

function clearSideFlags(pair: TaskPairState, role: TaskPairRole, all = false): void {
  for (const flag of ['blocked', 'needs_input'] as const) {
    if (all || pair.flagSides[flag] === role) {
      removeFlag(pair, flag);
      delete pair.flagSides[flag];
      pair.blockedNote = undefined;
    }
  }
}

function recorded(pair: TaskPairState | undefined, unusual = true, intents: TaskPairIntent[] = []): TaskPairTransition {
  return { pair: undefined, fromStatus: pair?.status, toStatus: pair?.status, effect: 'recorded', unusual, intents };
}

/**
 * Apply one marker to a pair. Pure: returns the updated pair (never mutates the
 * input) and the daemon intents to execute. Never throws, never refuses.
 */
export function applyTaskPairMarker(
  existing: TaskPairState | undefined,
  marker: Pick<TaskPairMarker, 'knownVerb' | 'taskId' | 'attrs' | 'brief' | 'briefMissing'>,
  ctx: TaskPairApplyContext,
): TaskPairTransition {
  const verb = marker.knownVerb;
  if (!verb) return { ...recorded(existing), effect: 'unrecognized' };
  const intents: TaskPairIntent[] = [];
  const role = taskPairRoleOf(existing, ctx.writer);
  // The project-authoritative Brain is allowed to resolve a participant wait
  // even when a restored pair carries an older Brain session name.  This is
  // intentionally narrower than daemon authority: only the configured
  // fallback Brain identity gets this compatibility path.
  const brainAuthority = role === 'brain' || (!!existing && ctx.writer === ctx.fallbackBrain);
  const roleAuthority = brainAuthority || role === 'daemon';
  const attrs = marker.attrs;
  const fromStatus = existing?.status;

  if (verb === 'QUEUE' && marker.taskId === TASK_PAIR_INFER_TASK_ID) {
    const max = Number.parseInt(attrs.max ?? '', 10);
    if (Number.isFinite(max) && max > 0) {
      intents.push({ kind: 'queue_settings', brain: ctx.writer, maxConcurrency: max });
      return { effect: 'queue_settings', unusual: false, intents };
    }
    return { ...recorded(undefined), effect: 'recorded' };
  }
  // `-` is resolved by ingestion; an unresolved one never names a pair.
  if (marker.taskId === TASK_PAIR_INFER_TASK_ID) return { ...recorded(existing), effect: 'unresolved' };

  // ---- no pair yet ------------------------------------------------------
  if (!existing) {
    switch (verb) {
      case 'QUEUE': {
        const pair = newPair(marker.taskId, ctx.writer, ctx, 'queued');
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        return { pair, toStatus: 'queued', effect: 'created', unusual: false, intents: [{ kind: 'slot_changed' }] };
      }
      case 'DISPATCH': {
        // Owner rule (D-dispatch-default): a genuine (agent/Brain-authored)
        // DISPATCH is capacity-gated exactly like QUEUE -- it starts now only
        // if the daemon's own queue drain finds a free slot and window right
        // away, otherwise it queues in normal order and starts automatically
        // later (see scheduler.ts#runQueueOnce). `implicitDispatch`
        // (send_message with task metadata) is a distinct, narrower mechanism
        // that keeps its original unconditional-start behavior.
        if (ctx.source === 'marker') {
          const pair = newPair(marker.taskId, ctx.writer, ctx, 'queued');
          setRolesFromAttrsQueued(pair, attrs);
          if (marker.brief !== undefined) pair.brief = marker.brief;
          return { pair, toStatus: 'queued', effect: 'created', unusual: false, intents: [{ kind: 'slot_changed' }] };
        }
        const queuedForBusyParticipant = namedParticipantIsBusy(attrs, ctx.busySessions);
        const pair = newPair(marker.taskId, ctx.writer, ctx, queuedForBusyParticipant ? 'queued' : 'working');
        if (queuedForBusyParticipant) setRolesFromAttrsQueued(pair, attrs);
        else setRolesFromAttrs(pair, attrs, intents);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        if (!queuedForBusyParticipant && !pair.executor) intents.push({ kind: 'pick_executor' });
        return { pair, toStatus: pair.status, effect: 'created', unusual: false, intents };
      }
      case 'STARTED':
      case 'WORKING':
      case 'READY_FOR_AUDIT':
      case 'DONE': {
        const pair = newPair(marker.taskId, ctx.fallbackBrain, ctx, 'working');
        pair.executor = ctx.writer;
        setRolesFromAttrs(pair, attrs, intents);
        if (verb === 'READY_FOR_AUDIT' && hasAudit(pair)) {
          pair.status = 'in_audit';
          pair.round = 1;
          const material = materialFromAttrs(attrs, ctx.now);
          if (material) pair.material = material;
          if (pair.auditor) intents.push({ kind: 'audit_request', to: pair.auditor });
        } else if (verb === 'DONE') {
          applyOutputAttr(pair, attrs);
          if (!hasAudit(pair)) pair.status = TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION;
          else {
            pair.status = 'awaiting_audit';
            if (spendCap(pair, 'done_reminder', intents)) intents.push({ kind: 'done_reminder', to: ctx.writer });
          }
        }
        return { pair, toStatus: pair.status, effect: 'created', unusual: true, intents };
      }
      case 'PASS':
      case 'REWORK': {
        return { ...recorded(undefined), intents: [{ kind: 'policy_notice', to: ctx.writer, taskId: marker.taskId,
          text: `No audit round is open for ${marker.taskId}. Brain must dispatch the pair and an executor must submit material with READY_FOR_AUDIT before the auditor can write ${verb}.` }] };
      }
      case 'CHECK':
        return { ...recorded(undefined), effect: 'recorded', intents: [{ kind: 'policy_notice', to: ctx.writer, taskId: marker.taskId,
          text: `No task pair ${marker.taskId} exists for this CHECK marker; it was recorded but not applied.` }] };
      case 'CANCEL':
        return { ...recorded(undefined), intents: [{ kind: 'policy_notice', to: ctx.writer, taskId: marker.taskId,
          text: `Only Brain or the daemon may CANCEL ${marker.taskId}; your marker was recorded but not applied.` }] };
      default:
        return recorded(undefined);
    }
  }

  // A queued pair without an executor leaves the queue only through its Brain
  // or the daemon's dispatch; anyone else's progress is recorded, so no open
  // pair can exist that nobody drives.
  if (existing.status === 'queued' && !existing.executor && !roleAuthority
    && (verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT' || verb === 'DONE')) {
    return recorded(existing);
  }

  // A queued pair starts ONLY through the scheduler's admission (a DISPATCH
  // with source 'queue'): that path checks capacity and busy participants,
  // provisions the pair's workspace and delivers the brief that names it. Any
  // other route to `working` -- a participant's STARTED/WORKING/READY marker,
  // a legacy tool, a Brain send_message bound to the pair -- would flip the
  // status with no workspace and no brief (owner report,
  // tsk_cd_implicit_working_no_workspace). Those are recorded and ask the
  // queue to try to admit the pair now. Brain's own explicit marker stays the
  // deliberate manual override; the daemon then briefs and provisions it.
  if (existing.status === 'queued' && ctx.source !== 'queue'
    && (verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT')
    && (!roleAuthority || ctx.source === 'implicit_dispatch')) {
    return recorded(existing, ctx.source !== 'implicit_dispatch', [{ kind: 'slot_changed' }]);
  }

  // A closed pair (cancelled or done) stays closed for a participant: only
  // the Brain or the daemon (QUEUE/DISPATCH, both already role-gated below)
  // can revive one. A stray READY_FOR_AUDIT/REWORK/STARTED/WORKING from
  // anyone else on a closed pair is recorded as unusual, never reopens it,
  // and tells the writer it is closed instead of leaving the marker
  // silently inert (owner report, tsk_83375afb5a: a non-Brain marker
  // reopened a closed duplicate).
  if ((existing.status === 'cancelled' || existing.status === 'done') && !roleAuthority
    && (verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT' || verb === 'REWORK')) {
    // Capped at one notice per writer per closure (not per round: a closed
    // pair's round never advances again, so a round-scoped cap would either
    // fire once for its whole remaining lifetime regardless of writer, or
    // never actually cap a writer that keeps re-emitting the same marker).
    // D6.9: every daemon message a participant's own marker triggers must be
    // bounded (CC8 audit: an agent re-emitting READY_FOR_AUDIT/REWORK after
    // a lost marker ping-ponged with the daemon without limit).
    if (existing.closedNoticeSentTo?.includes(ctx.writer)) return recorded(existing);
    const pair = clonePair(existing);
    pair.updatedAt = ctx.now;
    pair.closedNoticeSentTo = [...(existing.closedNoticeSentTo ?? []), ctx.writer];
    return {
      pair, fromStatus: existing.status, toStatus: existing.status,
      effect: 'recorded', unusual: true, intents: [{ kind: 'closed_pair_notice', to: ctx.writer }],
    };
  }

  // Brain title reminders use DISPATCH for historical compatibility. A
  // title-only marker is metadata, never lifecycle control, so handle it
  // before cloning/flag clearing/cap resets in the normal state machine.
  const titleOnlyDispatch = verb === 'DISPATCH'
    && Object.keys(attrs).length === 1
    && attrs.title !== undefined
    && (marker.brief === undefined || marker.brief.trim() === '');
  if (titleOnlyDispatch) {
    if (!roleAuthority || !attrs.title.trim()) return recorded(existing);
    const pair = clonePair(existing);
    pair.updatedAt = ctx.now;
    pair.title = attrs.title.trim();
    return {
      pair, fromStatus: existing.status, toStatus: existing.status,
      effect: 'title_updated', unusual: false, intents: [],
    };
  }

  const pair = clonePair(existing);
  pair.updatedAt = ctx.now;
  const terminal = isTerminalTaskPairStatus(pair.status);
  let unusual = role === 'other';
  if ((PROGRESS_VERBS.includes(verb) && !(terminal && verb === 'DISPATCH'))
    || (roleAuthority && (verb === 'QUEUE' || verb === 'REASSIGN'))) {
    clearSideFlags(pair, role, roleAuthority);
  }
  const brainResolutionVerb = roleAuthority && (
    verb === 'STARTED' || verb === 'WORKING' || verb === 'DISPATCH'
      || verb === 'QUEUE' || verb === 'REASSIGN' || verb === 'NEEDS_INPUT'
  );
  if (brainResolutionVerb) {
    resolveTaskPairBrainWait(pair, ctx.now, { writer: ctx.writer, note: attrs.note });
  }

  // Once a pair has earned PASS, or has been closed, participant progress
  // markers are historical noise.  In particular, a delayed
  // READY_FOR_AUDIT after PASS must not reopen an audit round (the owner
  // report observed exactly that sequence).  Only the explicit Brain/daemon
  // lifecycle controls below (DISPATCH/QUEUE/REASSIGN/CANCEL) may change a
  // passed/terminal pair; the executor's DONE-after-PASS remains valid.
  // Keep this guard before any material/round mutation so a late marker is
  // truly record-only and cannot alter the authoritative pair snapshot.
  const guardedAfterPass = pair.status === 'passed' && (
    verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT'
      || verb === 'PASS' || verb === 'REWORK' || verb === TASK_PAIR_CHECK_VERB
  ) && !(role === 'brain' && (verb === 'STARTED' || verb === 'WORKING' || verb === 'REWORK'));
  const guardedAfterClose = terminal && (
    verb === 'STARTED' || verb === 'WORKING' || verb === 'READY_FOR_AUDIT'
      || verb === 'PASS' || verb === 'REWORK' || verb === TASK_PAIR_CHECK_VERB
  );
  if (guardedAfterPass || guardedAfterClose) return recorded(existing);

  const done = (effect: string, extra: Partial<TaskPairTransition> = {}): TaskPairTransition => ({
    pair, fromStatus, toStatus: pair.status, effect, unusual, intents, ...extra,
  });
  const reject = (text: string): TaskPairTransition => {
    if (!spendCap(pair, 'policy_rejection', intents)) return recorded(existing);
    intents.push({ kind: 'policy_notice', to: ctx.writer, taskId: marker.taskId, text });
    return done('recorded', { unusual: true });
  };

  // A merge review may reject an already-audited result after PASS. Brain's
  // explicit WORKING/STARTED/REWORK is the only non-terminal control that may
  // reopen that pair: invalidate the passed material/head first, then require
  // a fresh READY_FOR_AUDIT before another PASS can apply.
  if (pair.status === 'passed' && role === 'brain'
    && (verb === 'STARTED' || verb === 'WORKING' || verb === 'REWORK')) {
    pair.status = verb === 'REWORK' ? 'rework' : 'working';
    pair.material = undefined;
    pair.passRound = undefined;
    pair.lastVerdict = undefined;
    resetCaps(pair);
    intents.push({ kind: 'brain_reopen_notice', reason: attrs.note?.trim() || undefined });
    return done('reopened');
  }

  if (verb === TASK_PAIR_CHECK_VERB) {
    const check = parseTaskPairChecklistCheck(attrs);
    if (!check) return reject('CHECK requires box=implemented|audited, items=1,2,5|all, and optional checked=true|false.');
    const allowed = role === 'brain' || role === 'daemon'
      || (check.box === 'implemented' && role === 'executor')
      || (check.box === 'audited' && role === 'auditor');
    if (!allowed) return reject(`Only the executor may CHECK implemented items and only the auditor may CHECK audited items for ${marker.taskId}; Brain may update either box.`);
    const currentBrief = pair.brief ?? '';
    const applied = applyTaskPairChecklistCheck(currentBrief, check);
    if (applied.indexes.length === 0 || applied.markdown === currentBrief) return done('checklist_unchanged');
    pair.brief = applied.markdown;
    return done('checklist_updated');
  }

  switch (verb) {
    case 'QUEUE': {
      if (!roleAuthority) return recorded(existing);
      if (pair.status === 'queued') {
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        return done('updated');
      }
      if (terminal) {
        pair.status = 'queued';
        pair.closedNoticeSentTo = undefined;
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        unusual = true;
        intents.push({ kind: 'slot_changed' });
        return done('reopened');
      }
      return recorded(existing);
    }
    case 'DISPATCH': {
      // Roles change only through the pair's Brain or the daemon.
      if (!roleAuthority) return recorded(existing);
      if (terminal) {
        return reject(`Task ${marker.taskId} is ${pair.status}; only a title-only DISPATCH may update it. Use a new taskId instead of reviving a terminal pair.`);
      }
      resetCaps(pair);
      if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) {
        const queuedForBusyParticipant = namedParticipantIsBusy(attrs, ctx.busySessions);
        if (queuedForBusyParticipant) setRolesFromAttrsQueued(pair, attrs);
        else setRolesFromAttrs(pair, attrs, intents);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        if (queuedForBusyParticipant) {
          pair.status = 'queued';
          intents.push({ kind: 'slot_changed' });
          return done('dispatched');
        }
        markTaskPairStarted(pair, ctx.now);
        return done('dispatched');
      }
      // A (re)start of a queued/closed pair is capacity-gated exactly like
      // QUEUE, UNLESS this is the daemon's own queue-drain call (source
      // 'queue'): that call only ever fires once #runQueueOnce has already
      // confirmed a free slot and window, so it is the one path allowed to
      // flip straight to 'working' -- gating it too would just re-queue the
      // pair forever and never actually start it.
      if ((pair.status === 'queued' || terminal) && ctx.source !== 'queue') {
        if (terminal) pair.closedNoticeSentTo = undefined;
        setRolesFromAttrsQueued(pair, attrs);
        if (marker.brief !== undefined) pair.brief = marker.brief;
        pair.status = 'queued';
        intents.push({ kind: 'slot_changed' });
        return done('dispatched');
      }
      if (terminal) pair.closedNoticeSentTo = undefined;
      const queuedForBusyParticipant = namedParticipantIsBusy(attrs, ctx.busySessions);
      if (queuedForBusyParticipant) setRolesFromAttrsQueued(pair, attrs);
      else setRolesFromAttrs(pair, attrs, intents);
      if (!queuedForBusyParticipant && !pair.executor) intents.push({ kind: 'pick_executor' });
      if (queuedForBusyParticipant) {
        pair.status = 'queued';
        intents.push({ kind: 'slot_changed' });
        return done('dispatched');
      }
      if (pair.status === 'queued' || terminal) {
        markTaskPairStarted(pair, ctx.now);
        intents.push({ kind: 'slot_changed' });
      }
      return done('dispatched');
    }
    case 'STARTED':
    case 'WORKING': {
      if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION && (role === 'executor' || roleAuthority)) {
        markTaskPairStarted(pair, ctx.now);
        return done('status');
      }
      if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) {
        return reject(`Only the executor or Brain may resume ${marker.taskId} while it awaits Brain's decision; your marker was recorded but not applied.`);
      }
      const startsPair = pair.status === 'queued' || terminal;
      if (pair.status === 'in_audit' || pair.status === 'passed' || terminal) unusual = true;
      if (terminal) intents.push({ kind: 'slot_changed' });
      if (startsPair) markTaskPairStarted(pair, ctx.now);
      else pair.status = 'working';
      return done('status');
    }
    case 'READY_FOR_AUDIT': {
      if (!hasAudit(pair)) return recorded(existing);
      const material = materialFromAttrs(attrs, ctx.now);
      // A delivery round opened by NEXT_ROUND is built on roundBase: the
      // material's base must be that commit (omit base= and the daemon fills
      // it in). Checked before any material/round mutation, like the other
      // rejections. Whether head actually descends from it needs git and is
      // verified by the daemon when it relays the audit request.
      const roundBase = pair.roundBase?.commit;
      if (roundBase && material?.base && !sameTaskPairCommit(material.base, roundBase)) {
        return reject(`Delivery round ${taskPairDeliveryRound(pair)} of ${marker.taskId} is based on ${roundBase}; READY_FOR_AUDIT base=${material.base} does not match. Omit base= or name ${roundBase}, rebase your work onto it, commit, and resend.`);
      }
      // A fresh READY replaces the material, so it lifts a hold; the daemon
      // re-verifies ancestry when it relays this one (below), so the hold can
      // never be bypassed by leaving the head out.
      const resubmitsHeld = !!pair.materialHold;
      pair.materialHold = undefined;
      if (material) pair.material = roundBase && !material.base ? { ...material, base: roundBase } : material;
      else if (pair.workspace?.path) {
        pair.material = { path: pair.workspace.path, ...(pair.workspace.lastHead ? { head: pair.workspace.lastHead } : {}), ...(roundBase ? { base: roundBase } : {}), at: ctx.now };
      }
      if (pair.status === 'in_audit') {
        // A resubmission inside the round with new material is relayed again.
        if ((material || resubmitsHeld) && pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) intents.push({ kind: 'audit_request', to: pair.auditor });
        return done('status');
      }
      if (pair.status === 'queued' || pair.status === 'passed' || terminal) unusual = true;
      if (terminal) intents.push({ kind: 'slot_changed' });
      pair.status = 'in_audit';
      pair.round += 1;
      // A config-derived set tracks the Brain's current config at the start of
      // each new round; an explicit human/marker override never drifts.
      if (taskPairBlockingSource(pair) !== 'explicit') {
        pair.blocking = normalizeAuditBlockingSeverities(ctx.projectBlocking);
        pair.blockingSource = 'config';
      }
      resetCaps(pair);
      removeFlag(pair, 'executor_silent');
      if (!pair.auditor) {
        addFlag(pair, 'needs_auditor');
        intents.push({ kind: 'pick_auditor' });
      } else {
        intents.push({ kind: 'audit_request', to: pair.auditor });
      }
      return done('status');
    }
    case 'PASS':
    case 'REWORK': {
      if (!hasAudit(pair) || pair.status !== 'in_audit' || !pair.material) {
        return reject(`No material-backed audit round is open for ${marker.taskId}. READY_FOR_AUDIT with material is required before PASS or REWORK can apply.`);
      }
      if (role !== 'auditor' && !roleAuthority) {
        return reject(`Only the assigned auditor may write ${verb} for ${marker.taskId}; your marker was recorded but not applied.`);
      }
      if (verb === 'PASS' && pair.materialHold) {
        // The daemon found this round's head does not build on the round
        // base: nothing may PASS it until a fresh READY. REWORK still applies.
        const held = pair.materialHold;
        const blocked = reject(`PASS for ${marker.taskId} was held: the round's material head ${held.head} does not descend from the round base ${held.base}. The executor was asked to send a new READY_FOR_AUDIT; wait for the resent audit request (REWORK still applies).`);
        if (blocked.pair && pair.executor) {
          intents.push({ kind: 'policy_notice', to: pair.executor, taskId: marker.taskId, text: `A PASS for ${marker.taskId} was held: your head ${held.head} does not descend from the round base ${held.base}. Rebase or merge onto ${held.base}, commit, and send a new READY_FOR_AUDIT with the new head.` });
        }
        return blocked;
      }
      const verdict = judgeTaskPairVerdict(verb, attrs, pair.blocking);
      if (verdict.blockingMismatch) unusual = true;
      if (terminal && verb === 'PASS') {
        pair.lastVerdict = { verb, counts: verdict.counts, judgement: verdict.judgement, round: pair.round };
        return done('recorded', { verdict });
      }
      applyVerdict(pair, verb, verdict, ctx.writer, intents, ctx);
      pair.materialHold = undefined;
      if (role === 'brain') resetCapFlagsOnBrainAction(pair);
      return done(isAppliedVerdict(verdict.judgement) ? 'verdict' : 'verdict_held', { verdict });
    }
    case 'NEXT_ROUND': {
      if (!brainAuthority) {
        return reject(`Only Brain may open the next round of ${marker.taskId}; your marker was recorded but not applied.`);
      }
      if (terminal) {
        return reject(`Task ${marker.taskId} is ${pair.status}; a closed pair cannot start another round. Use a new taskId.`);
      }
      if (pair.status !== 'passed') {
        return reject(`NEXT_ROUND applies only to a passed pair (${marker.taskId} is ${pair.status}); the current round is still open.`);
      }
      const named = attrs.base?.trim();
      if (named && !/^[0-9a-f]{7,64}$/i.test(named)) {
        return reject(`NEXT_ROUND base= must be a commit id (7-64 hex characters), got "${named}".`);
      }
      const previousHead = pair.material?.head ?? pair.workspace?.lastHead;
      const commit = named ?? previousHead;
      const deliveryRound = taskPairDeliveryRound(pair) + 1;
      const note = attrs.note?.trim() || undefined;
      // Brain's explicit lifecycle control resolves any participant wait
      // (blocked / needs_input) still set on the passed pair, like its other
      // controls do; only after the checks above, so a rejected marker
      // never clears anything.
      resolveTaskPairBrainWait(pair, ctx.now, { writer: ctx.writer, note });
      pair.deliveryRound = deliveryRound;
      pair.roundBase = commit
        ? {
            commit, source: named ? 'brain' : 'passed_head', deliveryRound, at: ctx.now,
            ...(previousHead ? { previousHead } : {}), ...(note ? { note } : {}),
          }
        : undefined;
      pair.status = 'working';
      // The previous round's verdict and material do not carry over: the new
      // round needs its own READY_FOR_AUDIT and PASS.
      pair.material = undefined;
      pair.passRound = undefined;
      pair.lastVerdict = undefined;
      resetCaps(pair);
      removeFlag(pair, 'executor_silent');
      intents.push({ kind: 'next_round_notice', ...(note ? { note } : {}) });
      return done('next_round');
    }
    case 'DONE': {
      const force = role === 'brain' && isTrue(attrs.force);
      if (terminal) return recorded(existing, false);
      if (force) {
        applyOutputAttr(pair, attrs);
        if (pair.status !== 'passed' && hasAudit(pair)) addFlag(pair, 'unaudited');
        pair.status = 'done';
        intents.push({ kind: 'slot_changed' });
        return done('forced');
      }
      if (hasAudit(pair) && role === 'executor' && pair.status === 'passed') {
        applyOutputAttr(pair, attrs);
        pair.status = 'done';
        intents.push({ kind: 'slot_changed' });
        return done('status');
      }
      if (!hasAudit(pair) && roleAuthority) {
        applyOutputAttr(pair, attrs);
        pair.status = 'done';
        intents.push({ kind: 'slot_changed' });
        return done('status');
      }
      if (!hasAudit(pair) && role === 'executor' && pair.status !== TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) {
        applyOutputAttr(pair, attrs);
        pair.status = TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION;
        return done('reported_to_brain');
      }
      return reject(hasAudit(pair)
        ? 'DONE cannot close or advance an audited pair. The executor may DONE only after an auditor PASS has been applied in a material-backed audit round; Brain may use DONE force=true to accept.'
        : 'Only the executor may report completion. This pair cannot be closed by DONE from another participant; Brain decides with DONE or CANCEL.');
    }
    case 'BLOCKED':
    case 'NEEDS_INPUT': {
      if (terminal) return recorded(existing, false);
      if (roleAuthority) return done('brain_resolved');
      const flag = verb === 'BLOCKED' ? 'blocked' : 'needs_input';
      const freshlyFlagged = !pair.flags.includes(flag) || pair.flagSides[flag] !== role;
      addFlag(pair, flag);
      pair.flagSides[flag] = role;
      pair.blockedNote = attrs.note?.trim() || undefined;
      pair.lastWaitResolution = undefined;
      // Owner evidence: an executor's question left only in its own reply,
      // never sent anywhere, stalled a pair until the owner happened to
      // notice ("make sure NEEDS_INPUT/BLOCKED notes from executors reach
      // Brain as a notice" -- executors specifically). Tell Brain immediately
      // on a fresh executor BLOCKED/NEEDS_INPUT instead of waiting for the
      // side to go silent. An auditor's BLOCKED/NEEDS_INPUT keeps the
      // existing heartbeat escalation only (scheduler.ts#tickPair /
      // #escalateBlocked) -- adding this here too would double the notice.
      if (freshlyFlagged && role === 'executor') intents.push({ kind: 'brain_notice', flag });
      if (verb === 'BLOCKED' && role === 'executor' && isAboutAuditor(attrs) && hasAudit(pair)) {
        if (spendCap(pair, 'blocked_replacement', intents)) intents.push({ kind: 'replace_auditor', reason: 'executor_blocked' });
      }
      return done('flag');
    }
    case 'REASSIGN': {
      if (!roleAuthority || terminal) return recorded(existing);
      if (role === 'brain') resetCapFlagsOnBrainAction(pair);
      if (pair.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) markTaskPairStarted(pair, ctx.now);
      const auditorBefore = pair.auditor;
      setRolesFromAttrs(pair, attrs, intents);
      // A Brain-authorized auditor choice is a durable pin.  Heartbeat
      // REASSIGNs use source=heartbeat and deliberately do not set it.
      if (brainAuthority && attrs.auditor !== undefined) {
        pair.auditorPinned = attrs.auditor === TASK_PAIR_NO_AUDITOR ? undefined : attrs.auditor;
      }
      // Who a queued pair waits for changed: whatever reason named the old session is void, whichever
      // branch below re-queues it (a busy named session re-derives it in the service, an idle one in
      // the queue run this REASSIGN triggers).
      const rolesChanged = attrs.executor !== undefined || attrs.auditor !== undefined;
      if (rolesChanged) {
        delete pair.capacityWaitReason;
        removeFlag(pair, 'waiting_for_capacity');
      }
      if (namedParticipantIsBusy(attrs, ctx.busySessions)) {
        pair.status = 'queued';
        if (rolesChanged) addFlag(pair, 'waiting_for_capacity');
        intents.push({ kind: 'slot_changed' });
      } else if (pair.status === 'queued' && rolesChanged) {
        // Admission must be re-evaluated now, not at the next 30 s sweep.
        intents.push({ kind: 'slot_changed' });
      }
      if (!pair.executor && attrs.executormodel) intents.push({ kind: 'pick_executor' });
      if (attrs.executor) removeFlag(pair, 'executor_silent');
      if (attrs.auditor === TASK_PAIR_NO_AUDITOR && pair.status === 'in_audit') pair.status = 'working';
      return done(auditorBefore !== pair.auditor ? 'reassigned_auditor' : 'reassigned');
    }
    case 'CANCEL': {
      if (!roleAuthority) return reject('Only Brain or the daemon may CANCEL a pair; your marker was recorded but not applied.');
      if (terminal) return recorded(existing, false);
      pair.status = 'cancelled';
      intents.push({ kind: 'slot_changed' });
      return done('status');
    }
    default:
      return recorded(existing);
  }
}

function setRolesFromAttrsQueued(pair: TaskPairState, attrs: Record<string, string>): void {
  if (attrs.executor) pair.executor = attrs.executor;
  if (attrs.executormodel) pair.executorModel = attrs.executormodel;
  if (attrs.auditor) pair.auditor = attrs.auditor;
  if (attrs.auditormodel) pair.auditorModel = attrs.auditormodel;
  if (attrs.title) pair.title = attrs.title;
  if (attrs.pool) pair.executorPool = attrs.pool;
  if (attrs.urgent !== undefined) pair.urgent = isTrue(attrs.urgent);
  applyWorkspaceAttr(pair, attrs);
  const blocking = parseBlockingAttr(attrs.blocking);
  if (blocking) { pair.blocking = blocking; pair.blockingSource = 'explicit'; }
}

function resetCapFlagsOnBrainAction(pair: TaskPairState): void {
  resetCaps(pair);
}

function applyVerdict(
  pair: TaskPairState,
  verb: 'PASS' | 'REWORK',
  verdict: TaskPairVerdictJudgementResult,
  writer: string,
  intents: TaskPairIntent[],
  ctx?: TaskPairApplyContext,
): void {
  pair.lastVerdict = { verb, counts: verdict.counts, judgement: verdict.judgement, round: pair.round };
  if (!isAppliedVerdict(verdict.judgement)) {
    if (spendCap(pair, 'verdict_correction', intents)) {
      intents.push({ kind: 'correction', to: writer, judgement: verdict.judgement });
    }
    return;
  }
  removeFlag(pair, 'verdict_inconsistent');
  if (verb === 'PASS') {
    pair.status = 'passed';
    pair.passRound = pair.round;
  } else {
    const wasRework = pair.status === 'rework';
    pair.status = 'rework';
    if (!wasRework && pair.executor) intents.push({ kind: 'rework_notice', to: pair.executor, counts: verdict.counts });
    const turnText = ctx?.turnText;
    if (ctx?.writer === pair.auditor && turnText && !hasAuditorProposal(turnText) && pair.auditor
      && pair.auditor !== TASK_PAIR_NO_AUDITOR
      && pair.auditorProposalNudgeRound !== pair.round) {
      pair.auditorProposalNudgeRound = pair.round;
      intents.push({ kind: 'auditor_proposal_nudge', to: pair.auditor });
    }
    if (pair.round > 0 && pair.round % 2 === 0 && pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) {
      intents.push({ kind: 'convergence_checkpoint_nudge', to: pair.auditor });
    }
  }
}

/** Deliberately lightweight: require an explicit solution/recommendation cue. */
export function hasAuditorProposal(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:proposed?\s+(?:solution|fix|approach)|recommend(?:ation|ed)?|trade[- ]?off|suggest(?:ed|ion)?|approach)\b|(?:方案|建议|取舍|修复方向)/iu.test(text);
}

function isTrue(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

function isAboutAuditor(attrs: Record<string, string>): boolean {
  return attrs.about === 'auditor' || /\bauditor\b/i.test(attrs.note ?? '');
}

/** The side whose turn it is, or undefined for statuses nobody is nudged in. */
export function taskPairSideToAct(pair: TaskPairState): 'executor' | 'auditor' | undefined {
  switch (pair.status) {
    case 'working':
    case 'rework':
    case 'awaiting_audit':
    case 'passed':
      return 'executor';
    case 'in_audit':
      return hasAudit(pair) ? 'auditor' : 'executor';
    default:
      return undefined;
  }
}

export function formatTaskPairSeverityCounts(counts: TaskPairSeverityCounts): string {
  return AUDIT_SEVERITY_LEVELS.map((level) => `${level.toLowerCase()}=${counts[level]}`).join(' ');
}

/** Closest legacy lifecycle per pair status, so the task console groups pair rows like legacy ones. */
export const TASK_PAIR_CONSOLE_LEGACY_STATUS = {
  queued: 'planned',
  working: 'implementing',
  in_audit: 'auditing',
  awaiting_audit: 'ready_for_audit',
  [TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION]: 'ready_for_audit',
  rework: 'rework',
  passed: 'passed',
  done: 'finalized',
  cancelled: 'cancelled',
} as const satisfies Record<TaskPairStatus, string>;

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

export interface TaskPairEventPayload {
  taskId: string;
  verb: string;
  writer: string;
  role: TaskPairRole;
  source: TaskPairEventSource;
  effect: string;
  fromStatus?: TaskPairStatus;
  toStatus?: TaskPairStatus;
  unusual: boolean;
  /** Existing claim that blocked a CLAIM marker, including holder and expiry. */
  resourceConflict?: TaskPairResourceClaim;
  title?: string;
  executor?: string;
  executorLabel?: string;
  executorModel?: string;
  executorState?: string;
  auditor?: string;
  auditorLabel?: string;
  auditorModel?: string;
  auditorState?: string;
  queuePosition?: number;
  urgent?: boolean;
  round?: number;
  /** Delivery round, present only from the second one (NEXT_ROUND) on. */
  deliveryRound?: number;
  flags?: TaskPairFlag[];
  blocking?: AuditSeverity[];
  severityCounts?: TaskPairSeverityCounts;
  verdictJudgement?: TaskPairVerdictJudgement;
  executorPool?: string;
  auditorPool?: string;
  /** Where the daemon copied a pair's kept deliverable (OUTPUT_SAVED). */
  outputPath?: string;
  /** Why the deliverable could not be copied (OUTPUT_FAILED). */
  outputError?: string;
}

// ---------------------------------------------------------------------------
// Contract body (registered once per session; referenced by id afterwards)
// ---------------------------------------------------------------------------

export function buildTaskPairMarkerContract(): string {
  return [
    `[Contract: ${TASK_PAIR_CONTRACT_ID}]`,
    TASK_PAIR_TITLE_RULE,
    TASK_PAIR_TITLE_MARKER_RULE,
    TASK_PAIR_NATIVE_COLLABORATION_RULE,
    'Supervised tasks are executor+auditor pairs driven by one-line markers you write on their own line in your reply (never inside code fences):',
    `<!-- ${TASK_PAIR_MARKER_TAG} <VERB> <taskId> [key=value | key="quoted value"] -->`,
    `A marker must be in your FINAL reply of the turn: only the last text segment is scanned, so one written before an earlier tool call in the same turn is silently lost. If you need to call a tool first, finish acting, then write the marker(s) in your closing reply. A long brief goes between QUEUE <taskId> ... and its <!-- ${TASK_PAIR_BRIEF_END_TAG} <taskId> --> line, not scattered across earlier turn text.`,
    'Verbs: DISPATCH, QUEUE, STARTED, WORKING, READY_FOR_AUDIT, PASS, REWORK, DONE, BLOCKED, NEEDS_INPUT, REASSIGN, CANCEL, CLAIM, CHECK, NEXT_ROUND. CLAIM <taskId> resource=... mode=exclusive|shared ttl=... [renew=true] claims a shared external resource. CHECK <taskId> box=implemented|audited items=1,2,5|all [checked=false] updates numbered brief boxes; executor may update implemented, auditor audited, Brain either. taskId "-" means your single open task.',
    'Executor: write STARTED once when you begin (never again on later turns; progress needs no marker) and work in the pair\'s workspace (below). When done, send the auditor your validation (full suites for code) with send_message and write READY_FOR_AUDIT naming material; the daemon relays it to the auditor. In a git workspace, commit locally before READY and name that commit as head= so the audit reads a fixed revision; REWORK fixes are new local commits. Only after the assigned auditor applies PASS in a material-backed audit round may the executor report the worktree path and HEAD to Brain (never push any branch) and write DONE (with output= when the result must be kept). DONE before PASS is recorded as unusual and cannot close or advance the pair. Write BLOCKED or NEEDS_INPUT with note="..." when stuck. auditor=none is a real choice, not a lesser one: no audit window is assigned and nothing auto-picks one for you. Do proportionate self-validation instead (full suites for code), commit locally in the worktree (never push any branch), then write DONE straight to Brain with no PASS required; this reports completion but leaves the pair open awaiting Brain\'s decision. The closing reply is relayed to Brain and must state what changed, the worktree path and HEAD or file paths, and your validation result before the DONE marker. Brain ends it with DONE (accept) or CANCEL; further Brain work returns it to working. Brain merges commits into dev and pushes dev.',
    TASK_PAIR_INTEGRATION_RULE,
    TASK_PAIR_NEXT_ROUND_RULE,
    TASK_PAIR_WORKSPACE_RULES,
    'Pairs have no assignmentId, auditAttemptId, auditRevision, immutable bundle, scopeFiles or control-plane binding: never wait for, ask for or block on them.',
    `Auditor: the material is the executor's workspace (a worktree at the named head, or the named task-directory path; read it directly) plus their reported validation; judge by ${AUDIT_CONVERGENCE_CONTRACT_ID}. Your turns start inside that workspace: never write or commit there; put your own scratch files, checks and notes in a temp directory or your own task directory. Reply to the executor with every finding tagged [P0]..[P4]. ${TASK_PAIR_AUDITOR_PROPOSAL_RULE} Then write PASS or REWORK with the blocking set and a count per level, e.g. REWORK <taskId> blocking=P0 p0=1 p1=2. REWORK needs at least one finding at a blocking level; PASS has none. If a genuinely undecidable scope, approach, ownership, unreachable target, or environment issue remains, escalate to Brain with options and a recommendation instead of looping. PASS/REWORK applies only while status is in_audit and material is present; otherwise it is recorded as unusual and cannot advance the pair. After a real PASS, only the executor may DONE. CANCEL and role-changing verbs are Brain/daemon-only; invalid participant markers are recorded as unusual with a bounded notice. Re-audits check only the prior blocking classes plus regressions. If the material cannot be reached (executor limited/offline, workspace unreadable), write NEEDS_INPUT <taskId> note="..." and wait: that is never a P0 or REWORK.`,
    TASK_PAIR_ASK_DONT_JUST_REPLY_RULE,
    TASK_PAIR_CONVERGENCE_CHECKPOINT_RULE,
    TASK_PAIR_ANALYZE_BEFORE_DISPATCH_RULE,
    TASK_PAIR_BRIEF_STRUCTURE_RULE,
    TASK_PAIR_ENVIRONMENT_PREFLIGHT_RULE,
    TASK_PAIR_BOUNDARY_AUDIT_RULE,
    TASK_PAIR_MERGE_VERIFICATION_RULE,
    TASK_PAIR_EXECUTION_DISCIPLINE_RULE,
    TASK_PAIR_READY_SELF_CHECK_RULE,
    TASK_PAIR_SELF_SUFFICIENCY_RULE,
    TASK_PAIR_SCOPE_DECISION_RULE,
    'Automatic pairing policy: multi-step, cross-file, test/real-machine, integration, performance, security or substantial tasks use an executor plus auditor and heartbeat; small edits and queries use one executor with no auditor. Explicit user choices always win. An empty or unconfigured pool asks the user which models to use; never invent a default. Prefer configured Luna→Sol, then Haiku→Sonnet, then DeepSeek Flash→Pro tiers.',
    `Brain: DISPATCH is normally all you need -- the daemon starts it right away if a slot and window are free, otherwise it auto-queues it (status queued, normal FIFO order, urgent=true jumps the queue) and starts it automatically later; no need to pick QUEUE just to defer work. Include title="<short specific title>" in the owner's UI language, for example DISPATCH tsk_demo title="Fix login retry" executor=<session> auditor=<session>. DISPATCH <taskId> title="..." executor=<session> auditor=<session>|none [blocking=P0,P1] [pool=primary|economy] [workspace=dir for non-code work in a git project] [urgent=true], optionally with a brief exactly like QUEUE's: DISPATCH <taskId> ... then the full brief then <!-- ${TASK_PAIR_BRIEF_END_TAG} <taskId> -->; the daemon starts it and delivers the brief either way. QUEUE <taskId> title="..." ... <!-- ${TASK_PAIR_BRIEF_END_TAG} <taskId> --> still works (always enqueues, same mechanics) for compatibility. QUEUE - max=<n> sets your queue limit; REASSIGN <taskId> auditor=<session>; DONE <taskId> force=true accepts/ends from any state and marks an audited unpassed pair unaudited; CANCEL ends from any state. No-auditor DONE reports are open and hold their concurrency slot until you decide with DONE or CANCEL; more work can return them to working. Naming executor=/auditor=<session> replaces the current holder of that role immediately, ignoring the execution pool's role config; if that named session is busy the pair waits for it rather than substituting another. Naming executormodel=/auditormodel=<model> instead steers the next automatic pick or replacement for that role (also ignoring pool roles) but does not by itself replace a role that is already filled -- REASSIGN with the session explicitly for that; no matching session or pool config for a named model replies "no session/config for requested model <model>". A project with no execution pool configured has no built-in default: before dispatching or queueing work there without naming executormodel=/auditormodel=/executor=/auditor= yourself, ask the user which models to use (Settings -> execution pool, or name them on the task) -- an unnamed role in that state picks nothing and waits.`,
    TASK_PAIR_PROJECT_PRECEDENCE_CLAUSE,
    TASK_PAIR_BRAIN_REPORTING_RULE,
    TASK_PAIR_CHECKLIST_RULE,
    TASK_PAIR_RESOURCE_CLAIM_RULE,
  ].join('\n');
}
