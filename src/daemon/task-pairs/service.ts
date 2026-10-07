/**
 * Marker ingestion for the `pairs` supervision engine.
 *
 * One listener on the daemon timeline sees every final assistant turn of every
 * session, transport and process alike. It runs after the turn was emitted and
 * never touches relay, send acknowledgement, queue drain, `/stop` or control
 * responses; a failure here is logged and dropped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { SUPERVISION_ID_PREFIXES } from '../../../shared/supervision-durable-identity.js';
import { timelineEmitter } from '../timeline-emitter.js';
import type { TimelineEvent } from '../timeline-event.js';
import { timelineStore } from '../timeline-store.js';
import logger from '../../util/logger.js';
import {
  TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS,
  TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
  TASK_PAIR_INFER_TASK_ID,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_PARTICIPANT_STATUSES,
  TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION,
  TASK_PAIR_DISK_LEVEL_META_KEY,
  TASK_PAIR_DISK_NOTICE_TASK_ID,
  TASK_PAIR_TIMELINE_EVENT,
  TASK_PAIR_MATERIAL_EVENT_VERB,
  TASK_PAIR_MATERIAL_HELD_EFFECT,
  TASK_PAIR_DUPLICATE_READY_EFFECT,
  TASK_PAIR_IDEMPOTENT_STARTED_EFFECT,
  TASK_PAIR_TITLE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_REPAIR_STATUSES,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_RETENTION_MS,
  TASK_PAIR_WORKSPACE_KEPT_DIGEST_INTERVAL_MS,
  TASK_PAIR_WORKSPACE_KEPT_DIGEST_MAX_LISTED,
  TASK_PAIR_WORKSPACE_KEPT_DIGEST_REASON,
  TASK_PAIR_WORKSPACE_KEPT_DIGEST_TASK_ID,
  TASK_PAIR_WORKSPACE_KEPT_MAX_OUTSTANDING,
  TASK_PAIR_WORKSPACE_KEPT_MAX_PER_SWEEP,
  TASK_PAIR_WORKSPACE_KEPT_NOTICE_VERSION,
  TASK_PAIR_WORKSPACE_KEPT_REASON,
  taskPairWorkspaceKeptDigestMetaKey,
  TASK_PAIR_TERMINAL_FLUSH_FIELD,
  isComplexSupervisionTaskBrief,
  applyTaskPairMarker,
  resolveTaskPairBrainWait,
  isTerminalTaskPairStatus,
  redirectTaskPairWorkspacePath,
  mayContainTaskPairMarker,
  scanTaskPairMarkers,
  stripTaskPairMarkersForDisplay,
  sameTaskPairCommit,
  taskPairRoleOf,
  type TaskPairDiskLevel,
  type TaskPairEventPayload,
  type TaskPairEventSource,
  type TaskPairIntent,
  type TaskPairMarker,
  type TaskPairState,
  type TaskPairResourceMode,
  type TaskPairResourceClaim,
  type TaskPairTransition,
} from '../../../shared/task-pair.js';
import { parseTaskPairChecklist, updateTaskPairChecklist } from '../../../shared/task-pair-checklist.js';
import { parseTaskPairAuditDetails } from '../../../shared/task-pair-notification.js';
import { flushTaskPairStoreLiveness, getTaskPairStore, livenessChangedBeyondActivityTimestamps, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { brainUiLocale, isPairsEngineProject, projectBrainSession, projectOfSession } from './engine.js';
import { inspectToolCallForPairMainCheckoutWrite } from './main-checkout-write-guard.js';
import { noteTaskPairFocus, sendTaskPairMessage, taskPairFocusOf, taskPairMessageIdPrefix, type TaskPairDeliveryResult } from './delivery.js';
import { brainNoticeForCard } from './brain-notice.js';
import type { ArmBrainDecisionFollowUp } from './brain-decision-followup.js';
import { checkStaleBaseNotice } from './integration-drift.js';
import { resolveTaskPairMaterial, verifyTaskPairRoundBase } from './material.js';
import { formatPossibleSilentRevertWarning, inspectPossibleSilentRevert, isRewrittenHead } from './rebase-revert-guard.js';
import { applyBackCow, hasUnfinishedApplyBack, rollbackApplyBack, undoApplyBack } from './non-git.js';
import { mergePairIntoProject } from './git-init.js';
import { copyTaskPairOutput, describeKeptTaskPairWorkspace, gitBranch as gitBranchOf, listTaskPairSiblingWorktrees, provisionTaskPairWorkspace, releaseTaskPairWorkspace, rehomeTaskPairWorkspace, type TaskPairWorkspaceRevisionSource } from './workspace.js';
import { clearTaskPairProviderError, noteTaskPairProviderError } from './provider-errors.js';
import {
  classifyDiskLevel, diskLevelRank, isDiskLevel, readWorktreeVolumeSpace, stripHeavyIgnoredDirs, stripHeavyNamedDirs, taskPairHygieneDeps,
} from './workspace-hygiene.js';
import { resolveSupervisionWorktreesRoot } from '../supervision-worktree-inspector.js';
import { isUsableTaskPairTitle, taskPairTitlePlaceholder } from './title-generator.js';
import { getSession, listSessions } from '../../store/session-store.js';
import { resolveProjectAuthoritativeSupervisionSnapshot } from '../supervision-snapshot.js';
import { resolveSupervisionAuditBlockingSeverities } from '../../../shared/supervision-config.js';
import {
  buildAuditRequestMessage,
  buildAuditorAssignmentMessage,
  buildExecutorPairBrief,
  buildOutputFailedLine,
  buildWorkspaceDuplicateNotice,
  buildWorkspaceKeptDigestLine,
  buildWorkspaceKeptLine,
  buildWorkspaceMoveFailedLine,
  buildWorkspaceMovedNotice,
  buildBrainNoticeMessage,
  buildCorrectionMessage,
  buildDiskPressureMessage,
  buildDoneReminderMessage,
  buildNoAuditorDoneNotice,
  buildPassDoneNoticeMessage,
  buildReworkNoticeMessage,
  buildBrainReopenNoticeMessage,
  buildUntitledTaskTitleRequest,
  buildAuditorProposalNudgeMessage,
  buildConvergenceCheckpointMessage,
  buildHeldWaitReason,
  buildNonGitFinishLine,
  buildNonGitModeLine,
  buildNextRoundNoticeMessage,
  buildRoundBaseAuditLine,
  buildRoundBaseMismatchAuditorMessage,
  buildRoundBaseMismatchExecutorMessage,
} from './messages.js';

/** Intents that need the pool, the heartbeat or the queue (see scheduler.ts). */
export interface TaskPairScheduler {
  onIntent(project: string, pair: TaskPairState, intent: TaskPairIntent): void | Promise<void>;
  /** Drain a Brain's queue after a capacity setting changes. */
  runQueue?(project: string, brain: string): void | Promise<void>;
  /** A consistent PASS was applied (economy-review bookkeeping). */
  flagEconomyUnreviewed?(project: string, taskId: string): void;
  /** Re-arm/clear the single aggregate Brain heartbeat after liveness changes. */
  publishBadges?(): void;
  /**
   * The liveness a Brain reply at `at` nets out to for this pair (pure): the wait is
   * cleared and the reminder refresh re-arms it for the same state, so a reply during
   * a fresh wait only moves the activity clocks.
   */
  brainReplyLiveness?(stored: StoredTaskPair, at: number): TaskPairLiveness;
  /** A notice asking Brain to decide `taskIds` was handed to its session: follow up once if the turn that gets it decides nothing. */
  armBrainDecisionFollowUp?(input: ArmBrainDecisionFollowUp): void;
}

export interface ApplyMarkerInput {
  project: string;
  writer: string;
  marker: Pick<TaskPairMarker, 'verb' | 'knownVerb' | 'taskId' | 'attrs' | 'brief' | 'briefMissing'>;
  source: TaskPairEventSource;
  /** Stable id for this marker occurrence: replaying it is a no-op. */
  eventId: string;
  now?: number;
  /**
   * The full assistant turn text this marker was scanned from, markers not
   * stripped. Only a real user-authored turn (`ingestText`) has one; a
   * synthetic marker minted by the daemon itself (dispatch, reassign, queue
   * drain) has no prose to relay and omits it. Used to relay the executor's
   * own closing summary to Brain when a no-auditor pair reaches DONE.
   */
  turnText?: string;
  /**
   * A DISPATCH this creates with no auditor named gets one held for a short
   * grace window instead of an immediate auto-pick, in case the Brain's own
   * marker for the same taskId (naming the intended auditor) is still in
   * flight. Set only for a pair minted without real task metadata (a plain
   * send_message notice/relay) -- one opened from an explicit objective picks
   * an auditor immediately, same as before.
   */
  suppressAutoPickAuditor?: boolean;
  /** Structured MCP callers await delivery themselves so they can return receipts. */
  suppressAutomaticBrief?: boolean;
  /** Runtime assistant-timeline ingestion rejects new Brain pairs unless pair_create was used. */
  requireStructuredPairCreate?: boolean;
}

export interface TaskPairBriefDelivery {
  role: 'executor' | 'auditor';
  target: string;
  status: TaskPairDeliveryResult;
}

/** How long a DISPATCH suppressed by `suppressAutoPickAuditor` waits for a
 *  race-arriving Brain marker before falling back to the normal auto-pick.
 *  Read fresh on every call (not frozen at module load) so tests can override
 *  it via IMCODES_IMPLICIT_AUDITOR_GRACE_MS regardless of import order. */
function resolveImplicitAuditorGraceMs(): number {
  const raw = parseInt(process.env.IMCODES_IMPLICIT_AUDITOR_GRACE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

/** The text names this task id as a whole token (so `T1` is not found in `T10`; trailing punctuation is fine). */
function mentionsTaskId(text: string, taskId: string): boolean {
  if (!text || !text.includes(taskId)) return false;
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, 'u').test(text);
}

const TASK_PAIR_MARKER_DEDUP_WINDOW_MS = 15_000;
/** Workspace-kept notices are one-shot; failed/unreadable delivery gets a small durable retry budget. */
const TASK_PAIR_WORKSPACE_KEPT_REMINDER_MAX_ATTEMPTS = 3;
const TASK_PAIR_WORKSPACE_KEPT_REMINDER_RETRY_MS = 15 * 60_000;
/** How long a new worktree waits for a low-disk reclaim before it is created anyway. */
const DISK_PREFLIGHT_WAIT_MS = 90_000;
/** Heartbeat free-space check cadence: statfs is cheap, the reclaim it may start is not. */
const DISK_CHECK_INTERVAL_MS = 60_000;

function stableMarkerAttrs(attrs: Record<string, string>): string {
  return JSON.stringify(Object.entries(attrs)
    .filter(([key]) => !key.startsWith('__'))
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** Marker attributes that explain why a pair was cancelled, if supplied. */
function cancellationReason(attrs: Record<string, string>): string | undefined {
  for (const key of ['reason', 'note', 'cause', 'why']) {
    const value = attrs[key]?.trim();
    if (value) return value.slice(0, 500);
  }
  return undefined;
}

function isDuplicateVerdictMarker(
  store: ReturnType<typeof getTaskPairStore>,
  existing: StoredTaskPair | undefined,
  input: ApplyMarkerInput,
  now: number,
): boolean {
  const verb = input.marker.knownVerb;
  if (!existing || (verb !== 'PASS' && verb !== 'REWORK' && verb !== 'READY_FOR_AUDIT')) return false;
  const head = input.marker.attrs.head
    ?? existing.state.material?.head
    ?? '';
  const round = String(existing.state.round);
  const attrs = stableMarkerAttrs(input.marker.attrs);
  return store.listEvents(existing.project, existing.state.taskId, 200).some((event) => {
    if (event.writer !== input.writer || event.verb !== verb) return false;
    if (now - event.at < 0 || now - event.at > TASK_PAIR_MARKER_DEDUP_WINDOW_MS) return false;
    if ((event.attrs.__round ?? '') !== round || (event.attrs.__head ?? '') !== head) return false;
    // Only a copy of the marker that produced the CURRENT state is a
    // duplicate: after an intervening transition (READY -> REWORK -> READY)
    // an identical-looking marker is a new, legitimate round.
    if (event.toStatus && event.toStatus !== existing.state.status) return false;
    return stableMarkerAttrs(event.attrs) === attrs;
  });
}

function isLikelyValidationReport(text: string | undefined): boolean {
  const value = text?.trim() ?? '';
  if (!value) return false;
  return /\b(?:validation|test(?:s|ing)?|typecheck|lint|build|suite)\b/iu.test(value)
    && /\b(?:pass(?:ed)?|fail(?:ed)?|success(?:ful)?|result|output|skip(?:ped)?)\b/iu.test(value);
}

function readyHasValidationReport(store: ReturnType<typeof getTaskPairStore>, stored: StoredTaskPair, attrs: Record<string, string>): boolean {
  if (Object.entries(attrs).some(([key, value]) => /report|validation/iu.test(key) && value.trim().length > 0)) return true;
  const auditor = stored.state.auditor;
  const executor = stored.state.executor;
  if (!auditor || auditor === TASK_PAIR_NO_AUDITOR || !executor) return true;
  // READY advances the round, while the executor normally sends the report
  // immediately before READY. Accept either the newly opened round or its
  // predecessor; a later report in the current round is also valid.
  const acceptedRounds = new Set([String(stored.state.round), String(Math.max(0, stored.state.round - 1))]);
  return store.listEvents(stored.project, stored.state.taskId, 500).some((event) => (
    event.verb === 'SEND'
    && event.writer === executor
    && event.attrs.target === auditor
    && acceptedRounds.has(event.attrs.__round ?? '')
    && Object.entries(event.attrs).some(([key, value]) => key !== 'target' && key !== '__round' && value.trim().length > 0
      && /report|validation/iu.test(key))
  ));
}

function readyMarkerForPair(pair: TaskPairState): string {
  const workspace = pair.workspace;
  if (workspace?.nonGit?.mode === 'cow') return `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} path=${workspace.path} -->`;
  if (workspace?.nonGit?.mode === 'in_place') return `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} path=${workspace.nonGit.projectRoot} files=<comma separated changed files> -->`;
  if (workspace?.kind === 'worktree') {
    return `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} worktree=${workspace.path} head=${workspace.lastHead ?? pair.material?.head ?? '<commit>'} base=${workspace.base ?? pair.material?.base ?? '<commit>'} -->`;
  }
  return `<!-- IMCODES_TASK READY_FOR_AUDIT ${pair.taskId} path=${workspace?.path ?? pair.material?.path ?? '<task-directory>'} -->`;
}

const WORKSPACE_REVISION_SOURCE_LABEL: Record<TaskPairWorkspaceRevisionSource, string> = {
  branch: 'its own branch',
  lastHead: 'the last observed head',
  materialHead: "the material relay's head",
  base: 'the recorded base',
  default: "the project's default branch",
  directory: 'a fresh task directory',
  clone: 'a copy-on-write clone of the project',
};

/**
 * A READY written after the worktree moved under a new executor may still name
 * the old path (the executor's own memory of it): store the current one, so the
 * pair never carries material that points at a dead path.
 */
function redirectMaterialToCurrentWorkspace(pair: TaskPairState): TaskPairState {
  const { material, workspace } = pair;
  if (!material || !workspace?.previousPaths?.length) return pair;
  const worktree = material.worktree ? redirectTaskPairWorkspacePath(workspace, material.worktree) : undefined;
  const path = material.path ? redirectTaskPairWorkspacePath(workspace, material.path) : undefined;
  if (worktree === material.worktree && path === material.path) return pair;
  return { ...pair, material: { ...material, ...(worktree ? { worktree } : {}), ...(path ? { path } : {}) } };
}

export async function ensureTaskPairWorkspaceAvailable(project: string, taskId: string): Promise<void> {
  const store = getTaskPairStore();
  const stored = store.getPair(project, taskId);
  if (!stored || !stored.state.executor) return;
  // A started pair with no workspace at all (its start skipped admission, or
  // provisioning failed then): give it one, once, instead of returning here and
  // leaving its executor to work wherever it happens to be.
  if (!stored.state.workspace) {
    await taskPairService.provisionMissingWorkspace(project, taskId);
    return;
  }
  // An executor change (REASSIGN, limit failover, restart-recovered queue start)
  // leaves the worktree under the previous executor: settle it before deciding
  // whether the path is missing.
  await taskPairService.settleWorkspaceOwner(project, taskId, { notify: true });
  const settled = store.getPair(project, taskId);
  if (!settled || !settled.state.workspace) return;
  const workspace = settled.state.workspace;
  const present = await stat(workspace.path).then(() => true).catch(() => false);
  if (present) return;
  const provision = await provisionTaskPairWorkspace(project, settled.state).catch(() => ({ ok: false as const, detail: 'workspace rebuild failed' }));
  if (!provision.ok) {
    if (!stored.state.workspaceRecoveryEscalatedAt) {
      const result = await sendTaskPairMessage(stored.state.brain, taskId, 'brain-workspace-unrecoverable', `Workspace for ${taskId} is missing and could not be rebuilt. Recovery sources exhausted; inspect the original branch/commit or provide a new workspace.`);
      if (result === 'sent' || result === 'queued' || result === 'skipped_pending') {
        store.savePair(project, { ...stored.state, workspaceRecoveryEscalatedAt: Date.now(), updatedAt: Date.now() });
      }
    }
    return;
  }
  const now = Date.now();
  const rebuilt = {
    kind: provision.kind, path: provision.path, ...(provision.base ? { base: provision.base } : {}), ...(provision.branch ? { branch: provision.branch } : {}),
    ...(provision.nonGit ? { nonGit: provision.nonGit } : {}), ...(provision.workingDir ? { workingDir: provision.workingDir } : {}),
    createdAt: now, status: 'active' as const,
  };
  const next = { ...settled.state, workspace: rebuilt, workspaceRecoveryEscalatedAt: undefined, updatedAt: now };
  store.savePair(project, next);
  const notice = `Workspace for ${taskId} was rebuilt from ${WORKSPACE_REVISION_SOURCE_LABEL[provision.source]}: ${provision.path}`;
  await sendTaskPairMessage(stored.state.executor, taskId, 'workspace-rebuilt', notice);
  if (stored.state.auditor && stored.state.auditor !== 'none') await sendTaskPairMessage(stored.state.auditor, taskId, 'workspace-rebuilt', notice);
}

export async function refreshTaskPairWorkspaceHead(project: string, taskId: string): Promise<void> {
  try {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    const workspace = stored?.state.workspace;
    if (!stored || !workspace || workspace.kind !== 'worktree' || workspace.status === 'removed') return;
    const material = await resolveTaskPairMaterial(stored.state);
    if (!material.head) return;
    const now = Date.now();
    if (workspace.lastHead === material.head && workspace.lastHeadAt) return;
    const previousHead = workspace.lastHead;
    // Re-read: resolveTaskPairMaterial was an async gap, and something else
    // (endWorkspace ending the pair, a self-heal rebuild) may have mutated the
    // workspace while it ran. Merge lastHead onto FRESH state, never onto the
    // snapshot captured before the gap -- writing that back would silently
    // clobber whatever changed (e.g. reopen an 'ended' workspace to 'active').
    const latest = store.getPair(project, taskId);
    const latestWorkspace = latest?.state.workspace;
    if (!latest || !latestWorkspace || latestWorkspace.status === 'removed') return;
    const nextWorkspace = {
      ...latestWorkspace,
      lastHead: material.head,
      lastHeadAt: now,
    };
    store.savePair(project, { ...latest.state, workspace: nextWorkspace, updatedAt: Math.max(latest.state.updatedAt, now) }, {
      liveness: { ...latest.liveness, lastMaterialAt: now },
    });
    // Head persistence and marker/audit handoff must never wait for the
    // warning-only rewrite probe. Capture the old head and material, then do
    // the bounded git inspection asynchronously after the durable write.
    if (previousHead && previousHead !== material.head) {
      queueWorkspaceRewriteCheck(project, latest.state, taskId, material, previousHead);
    }
  } catch (error) {
    // Best-effort cache refresh: the async gap above can outlive the pair's
    // store (test teardown, daemon shutdown). Losing lastHead is harmless --
    // it is re-derived on the next marker -- but an unhandled rejection here
    // is not.
    logger.warn({ err: error, taskId }, 'task-pair: workspace head refresh failed');
  }
}

/** Detect a rewritten head after persistence; advisory work is fail-open and never blocks READY. */
function queueWorkspaceRewriteCheck(
  project: string,
  pair: TaskPairState,
  taskId: string,
  material: Awaited<ReturnType<typeof resolveTaskPairMaterial>>,
  previousHead: string,
): void {
  void (async () => {
    if (!await isRewrittenHead(material.worktree!, previousHead, material.head!)) return;
    const store = getTaskPairStore();
    const latest = store.getPair(project, taskId);
    const workspace = latest?.state.workspace;
    if (!latest || !workspace || workspace.status === 'removed' || workspace.lastRebaseNoticeHead === material.head) return;
    store.savePair(project, {
      ...latest.state,
      workspace: {
        ...workspace,
        lastRebaseNoticeHead: material.head,
        lastRebasePreviousHead: previousHead,
      },
      updatedAt: Math.max(latest.state.updatedAt, Date.now()),
    });
    queueRebaseWarning(latest.state, taskId, material, previousHead);
  })().catch((error) => logger.warn({ err: error, taskId }, 'task-pair: rewrite probe failed'));
}

/** Run the advisory after state delivery; never delay marker/audit handoff. */
function queueRebaseWarning(
  pair: TaskPairState,
  taskId: string,
  material: Awaited<ReturnType<typeof resolveTaskPairMaterial>>,
  previousHead: string,
): void {
  void (async () => {
    const warning = formatPossibleSilentRevertWarning(await inspectPossibleSilentRevert({
      ...material,
      base: previousHead,
      ownershipBase: material.base,
      ownershipHead: previousHead,
    }));
    if (!warning) return;
    if (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) {
      await sendTaskPairMessage(pair.auditor, taskId, 'rebase-revert-warning', warning);
    }
    await sendTaskPairMessage(pair.brain, taskId, 'rebase-revert-warning', warning);
  })().catch((error) => logger.warn({ err: error, taskId }, 'task-pair: rebase advisory failed'));
}

/** Audit requests are sent first; this only catches a rewrite observed between refreshes. */
function queueAuditRebaseWarning(project: string, pair: TaskPairState, material: Awaited<ReturnType<typeof resolveTaskPairMaterial>>): void {
  void (async () => {
    const workspace = getTaskPairStore().getPair(project, pair.taskId)?.state.workspace;
    if (!workspace || workspace.kind !== 'worktree' || !material.head) return;
    if (workspace.lastRebaseNoticeHead === material.head) return;
    const previousHead = workspace.lastHead;
    if (!previousHead || previousHead === material.head || !(await isRewrittenHead(workspace.path, previousHead, material.head))) return;
    const latest = getTaskPairStore().getPair(project, pair.taskId);
    if (!latest?.state.workspace || latest.state.workspace.lastRebaseNoticeHead === material.head) return;
    getTaskPairStore().savePair(project, {
      ...latest.state,
      workspace: {
        ...latest.state.workspace,
        lastHead: material.head,
        lastHeadAt: Date.now(),
        lastRebaseNoticeHead: material.head,
        lastRebasePreviousHead: previousHead,
      },
      updatedAt: Date.now(),
    });
    queueRebaseWarning(latest.state, pair.taskId, material, previousHead);
  })().catch((error) => logger.warn({ err: error, taskId: pair.taskId }, 'task-pair: audit rebase advisory failed'));
}

let terminalStreamRecoveryStarted = false;

export function resetTaskPairTerminalStreamRecoveryForTests(): void {
  terminalStreamRecoveryStarted = false;
}

export class TaskPairService {
  static readonly TITLE_REQUEST_RETRY_MS = 5 * 60_000;
  #titleRequestFlushes = new Map<string, Promise<void>>();
  #unsubscribe?: () => void;
  #scheduler?: TaskPairScheduler;
  /** Bounded notices for unknown task ids, which have no pair state for persisted caps. */
  #policyNoticeKeys = new Set<string>();
  #recentBrainDispatch = new Map<string, { taskId: string; at: number }>();
  /**
   * Background work `applyMarker` starts and does not await (running intents,
   * briefing participants, ending a workspace) -- each can still be mid-flight,
   * awaiting its own I/O, after the call that started it has returned. Tracked
   * here so `waitForIdle` (called by `dispose`, and by tests before they close
   * the store) can drain it instead of leaving it to resolve against a store
   * that already closed, which would otherwise throw as an unhandled rejection
   * -- or, in a test, land on the next test's assertions.
   */
  #pending = new Set<Promise<unknown>>();

  /** Track a fire-and-forget background operation so it can be drained later. */
  #track<T>(promise: Promise<T>): void {
    this.#pending.add(promise);
    // Attaching a handler here -- regardless of whether anything ever drains
    // the set -- is what stops Node from treating a late rejection as
    // unhandled, even if it settles long after the caller moved on.
    promise.finally(() => this.#pending.delete(promise)).catch(() => { /* already logged at the call site */ });
  }

  /** Number of background operations still in flight (diagnostics/tests). */
  claimResource(input: { project: string; taskId: string; owner: string; resource: string; mode: TaskPairResourceMode; ttlMs: number; now?: number }): any {
    const store = getTaskPairStore(); const pair = store.getPair(input.project, input.taskId);
    if (!pair || ![pair.state.brain, pair.state.executor, pair.state.auditor].includes(input.owner)) return { ok: false, conflict: undefined };
    const result = store.tryClaimResource(input); if (!result.ok) return result;
    const next = { ...pair.state, resourceClaims: store.listResourceClaimsForPair(input.project, input.taskId, input.now), updatedAt: input.now ?? Date.now() };
    store.savePair(input.project, next); return { ok: true, claim: result.claim, pair: next };
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Waits for every currently-tracked background operation, draining transitively (settling one can start another). */
  async waitForIdle(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  init(): void {
    if (this.#unsubscribe) return;
    // A daemon restarted mid-copy-back / mid-merge: roll back what was half done and run it again.
    this.#track(this.#resumeNonGitFinishes().catch((error: unknown) => logger.warn({ err: error }, 'task-pair: non-git finish resume failed')));
    // A provider may have emitted a terminal replacement just before this
    // daemon restarted. Re-scan only the recent, explicitly flagged terminal
    // stream snapshots; live chunks and ordinary history are never parsed.
    if (!terminalStreamRecoveryStarted) {
      terminalStreamRecoveryStarted = true;
      this.#track(this.#recoverTerminalStreamMarkers().catch((error: unknown) => logger.warn({ err: error }, 'task-pair: terminal stream recovery failed')));
    }
    this.#unsubscribe = timelineEmitter.on((event) => {
      // Activity is stamped synchronously so a heartbeat cannot race a just
      // emitted message/tool event. Marker parsing remains deferred off the
      // provider/watcher call stack.
      if (event.type === 'session.state') {
        noteTaskPairProviderError(event);
      } else if (event.type === 'user.message' || event.type === 'tool.call' || event.type === 'tool.result') {
        // A participant's git write in the main checkout is reported at once; a pre-tool hook (claude-code-sdk) refuses it earlier.
        // Own try/catch and first: neither this check nor the activity stamp may prevent the other.
        if (event.type === 'tool.call') {
          try { inspectToolCallForPairMainCheckoutWrite(event.sessionId, event.payload); } catch (error) { logger.warn({ err: error, session: event.sessionId }, 'task-pair: main-checkout write check failed'); }
        }
        this.recordActivity(event.sessionId, event.ts ?? Date.now(), {
          automation: (event.payload as Record<string, unknown>).automation === true,
        });
      } else if (event.type === 'assistant.text') {
        // Daemon-authored automation (including task-pair delivery and
        // recovery notices) is not participant progress. Counting it as
        // activity re-arms the both-idle fast poll and can create a new nudge
        // every threshold interval while both participants remain silent.
        this.recordActivity(event.sessionId, event.ts ?? Date.now(), {
          automation: (event.payload as Record<string, unknown>).automation === true,
        });
        setImmediate(() => {
          try {
            this.handleTimelineEvent(event);
          } catch (error) {
            logger.warn({ err: error, session: event.sessionId }, 'task-pair: marker ingestion failed');
          }
        });
      }
    });
  }

  async #recoverTerminalStreamMarkers(): Promise<void> {
    const cutoff = Date.now() - 15 * 60_000;
    const sessions = listSessions();
    for (const session of sessions) {
      const project = projectOfSession(session.name);
      if (!project || !isPairsEngineProject(project)) continue;
      let events: TimelineEvent[];
      try {
        events = await timelineStore.readCompletedTextTail(session.name, 50);
      } catch {
        // Projection startup can lag daemon startup; the JSONL reader is a
        // bounded fallback and preserves the same explicit-flag filter.
        events = timelineStore.read(session.name, { limit: 50 });
      }
      for (const event of events) {
        // Only replay a snapshot produced by an earlier daemon epoch. This
        // keeps a service re-init in the same process from re-ingesting a
        // currently live terminal event while still recovering a pre-restart
        // cancellation.
        if (event.type !== 'assistant.text' || event.ts < cutoff || event.epoch === timelineEmitter.epoch) continue;
        const payload = event.payload as Record<string, unknown>;
        if (payload[TASK_PAIR_TERMINAL_FLUSH_FIELD] !== true) continue;
        this.handleTimelineEvent(event);
      }
    }
  }

  /** Unsubscribes first (no new background work starts), then drains whatever was already in flight. */
  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.waitForIdle();
    // Activity stamps deferred in memory reach the database before exit.
    flushTaskPairStoreLiveness();
  }

  setScheduler(scheduler: TaskPairScheduler | undefined): void {
    this.#scheduler = scheduler;
  }

  /** Returns and consumes a marker DISPATCH seen immediately before send_message. */
  recentBrainDispatch(project: string, brain: string, target: string): string | undefined {
    const key = `${project}\u0000${brain}\u0000${target}`;
    const focus = this.#recentBrainDispatch.get(key);
    if (!focus || Date.now() - focus.at > 10_000) return undefined;
    this.#recentBrainDispatch.delete(key);
    return focus.taskId;
  }

  /**
   * (a) An existing OPEN pair the message text names, when the sender is
   * that pair's Brain or a participant of it. An explicit reference like
   * this is unambiguous regardless of whether the send also carries real
   * task metadata of its own, so callers check it unconditionally.
   */
  resolveMentionedOpenPair(project: string, sender: string, text: string): string | undefined {
    for (const stored of getTaskPairStore().listActivePairs(project)) {
      const state = stored.state;
      if (!TASK_PAIR_OPEN_STATUSES.includes(state.status)) continue;
      if (sender !== state.brain && sender !== state.executor && sender !== state.auditor) continue;
      if (mentionsTaskId(text, state.taskId)) return state.taskId;
    }
    return undefined;
  }

  /**
   * (b) The one open pair of this Brain whose executor or auditor slot the
   * target already holds -- a message to a session already working on a
   * pair continues that pair rather than starting a new task. More than one
   * match is ambiguous (which one continues?) and returns undefined.
   *
   * Only for a send with no real task metadata of its own (a plain
   * send_message, or one carrying no objective): an EXPLICIT new objective
   * is "clearly new work" (see bullet 2) even for a target already busy with
   * something else, and must still open its own pair -- callers must not
   * call this when the send itself names an objective.
   */
  resolveSingleParticipantOpenPair(sender: string, target: string): string | undefined {
    // This lookup is the continuation path for a plain Brain send.  It must
    // cover every durable non-terminal state, not only states that consume a
    // concurrency slot: queued, passed, and awaiting-brain-decision pairs
    // still own their executor/auditor until an explicit terminal decision.
    const matches = getTaskPairStore().pairsForSession(target).filter((stored) => {
      const state = stored.state;
      return state.brain === sender && TASK_PAIR_PARTICIPANT_STATUSES.includes(state.status)
        && (state.executor === target || state.auditor === target);
    });
    return matches.length === 1 ? matches[0]!.state.taskId : undefined;
  }

  handleTimelineEvent(event: TimelineEvent): void {
    if (event.type !== 'assistant.text') return;
    const payload = event.payload as Record<string, unknown>;
    const terminalFlush = payload[TASK_PAIR_TERMINAL_FLUSH_FIELD] === true;
    if (payload.streaming === true || ((payload.automation === true || payload.memoryExcluded === true) && !terminalFlush)) return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const writer = event.sessionId;
    const project = projectOfSession(writer);
    if (!project || !isPairsEngineProject(project)) return;
    const now = event.ts ?? Date.now();
    clearTaskPairProviderError(writer);
    this.recordProgress(writer, now, text);
    this.backfillTitlesOnce(project);
    if (!mayContainTaskPairMarker(text)) return;
    // Marker parsing remains a compatibility lifecycle path; new Brain work
    // is fail-closed at the pair-aware send_message/MCP entry points.
    this.ingestText(project, writer, text, event.eventId, now);
  }

  ingestText(project: string, writer: string, text: string, turnId: string, now = Date.now(), requireStructuredPairCreate = false): TaskPairTransition[] {
    const { markers } = scanTaskPairMarkers(text);
    const results: TaskPairTransition[] = [];
    for (const marker of markers) {
      results.push(this.applyMarker({
        project, writer, marker, source: 'marker', eventId: `${turnId}:${marker.markerIndex}`, now, turnText: text,
        ...(requireStructuredPairCreate ? { requireStructuredPairCreate: true } : {}),
      }));
    }
    return results;
  }

  /** Resolve `-` to the writer's single non-terminal pair in the project. */
  resolveTaskId(project: string, writer: string, taskId: string, verb?: string): string | undefined {
    if (taskId !== TASK_PAIR_INFER_TASK_ID) return taskId;
    if (verb === 'QUEUE') return taskId;
    const own = getTaskPairStore().listActivePairs(project).filter((pair) => (
      pair.state.executor === writer || pair.state.auditor === writer
    ));
    return own.length === 1 ? own[0]!.state.taskId : undefined;
  }

  applyMarker(input: ApplyMarkerInput): TaskPairTransition {
    // Persist the configured thinking level on the pair at the point a role
    // is named.  This is the durable fallback for queue/replay paths where a
    // later session-list refresh may no longer contain the participant.
    // Explicit marker attributes win; live session config is authoritative
    // when the marker omitted the optional field.
    const executor = input.marker.attrs.executor;
    const auditor = input.marker.attrs.auditor;
    const executorThinking = executor && executor !== TASK_PAIR_NO_AUDITOR ? getSession(executor)?.effort?.trim() : undefined;
    const auditorThinking = auditor && auditor !== TASK_PAIR_NO_AUDITOR ? getSession(auditor)?.effort?.trim() : undefined;
    if ((executorThinking && !input.marker.attrs.executorthinking) || (auditorThinking && !input.marker.attrs.auditorthinking)) {
      input = {
        ...input,
        marker: {
          ...input.marker,
          attrs: {
            ...input.marker.attrs,
            ...(executorThinking && !input.marker.attrs.executorthinking ? { executorthinking: executorThinking } : {}),
            ...(auditorThinking && !input.marker.attrs.auditorthinking ? { auditorthinking: auditorThinking } : {}),
          },
        },
      };
    }
    const store = getTaskPairStore();
    const now = input.now ?? Date.now();
    if (store.hasEvent(input.eventId)) return { effect: 'replayed', unusual: false, intents: [] };
    const taskId = this.resolveTaskId(input.project, input.writer, input.marker.taskId, input.marker.knownVerb);
    const existing = taskId && taskId !== TASK_PAIR_INFER_TASK_ID ? store.getPair(input.project, taskId) : undefined;
    if (input.marker.knownVerb === 'CLAIM' && existing) {
      const resource = input.marker.attrs.resource?.trim();
      const mode = input.marker.attrs.mode === 'shared' || input.marker.attrs.mode === 'exclusive' ? input.marker.attrs.mode : undefined;
      const raw = Number(input.marker.attrs.ttl ?? 1800000); const ttlMs = Number.isFinite(raw) ? Math.max(60000, Math.min(86400000, raw < 1000 ? raw * 1000 : raw)) : 1800000;
      const claimed = resource && mode ? this.claimResource({ project: input.project, taskId: existing.state.taskId, owner: input.writer, resource, mode, ttlMs, now }) : { ok: false };
      const effect = claimed.ok ? 'resource_claimed' : 'resource_conflict';
      const resourceConflict = !claimed.ok && 'conflict' in claimed ? claimed.conflict : undefined;
      store.recordEvent({ id: input.eventId, project: input.project, taskId: existing.state.taskId, writer: input.writer, role: taskPairRoleOf(existing.state, input.writer), verb: 'CLAIM', attrs: input.marker.attrs, effect, unusual: !claimed.ok, source: input.source, fromStatus: existing.state.status, toStatus: existing.state.status, at: now });
      const transition = { pair: claimed.ok ? claimed.pair : existing.state, fromStatus: existing.state.status, toStatus: existing.state.status, effect, unusual: !claimed.ok, intents: [], ...(resourceConflict ? { resourceConflict } : {}) } as TaskPairTransition;
      this.#emitEvent(input, existing.state.taskId, taskPairRoleOf(existing.state, input.writer), transition, transition.pair); return transition;
    }
    // A marker can be observed twice (the assistant reply and a relay copy).
    // Treat an identical participant verdict/material marker in the same round
    // as one occurrence, while allowing a later round or a different head to
    // advance normally.
    if (isDuplicateVerdictMarker(store, existing, input, now)) {
      return { effect: 'replayed', unusual: false, intents: [] };
    }
    // Read on both pair creation (newPair()) and a config-derived pair's next
    // round (READY_FOR_AUDIT starting a new round, applyTaskPairMarker), so
    // an open pair picks up a Brain config change without a restart.
    const projectBlocking = taskId
      ? resolveSupervisionAuditBlockingSeverities(
          resolveProjectAuthoritativeSupervisionSnapshot(input.project, listSessions()),
        )
      : undefined;
    const namedSessions = [input.marker.attrs.executor, input.marker.attrs.auditor]
      .filter((session): session is string => !!session && session !== TASK_PAIR_NO_AUDITOR);
    const busySessions = new Set(namedSessions.filter((session) => store.isParticipantOfOpenPair(session, taskId)));
    const transition = taskId
      ? applyTaskPairMarker(existing?.state, { ...input.marker, taskId }, {
          writer: input.writer,
          fallbackBrain: projectBrainSession(input.project),
          projectBlocking,
          now,
          source: input.source,
          turnText: input.turnText,
          ...(input.requireStructuredPairCreate ? { requireStructuredPairCreate: true } : {}),
          ...(busySessions.size > 0 ? { busySessions } : {}),
        })
      : { effect: 'unresolved', unusual: true, intents: [] as TaskPairIntent[] } satisfies TaskPairTransition;
    const role = taskPairRoleOf(existing?.state ?? transition.pair, input.writer);
    // An executor that writes STARTED again while its pair is already working
    // changes nothing: no event row, no pair rewrite, no console push, no git
    // head refresh. It still counts as the executor's progress, so it is
    // stamped like any other activity (throttled, in memory first).
    if (existing && this.#isIdempotentStarted(input, existing, transition, role)) {
      store.saveLivenessActivityStamp(input.project, existing.state.taskId, this.#livenessAfterMarker(existing.liveness, transition, role, now));
      return { effect: TASK_PAIR_IDEMPOTENT_STARTED_EFFECT, fromStatus: 'working', toStatus: 'working', unusual: false, intents: [] };
    }
    // The same READY_FOR_AUDIT again while its round is open changes nothing:
    // no event row, no pair rewrite, no relay to the auditor. It is still the
    // executor's activity, so it is stamped like any other.
    if (existing && transition.effect === TASK_PAIR_DUPLICATE_READY_EFFECT) {
      store.saveLivenessActivityStamp(input.project, existing.state.taskId, this.#livenessAfterMarker(existing.liveness, transition, role, now));
      return { effect: TASK_PAIR_DUPLICATE_READY_EFFECT, fromStatus: existing.state.status, toStatus: existing.state.status, unusual: false, intents: [] };
    }
    const eventPair = transition.pair ?? existing?.state;
    const eventHead = input.marker.attrs.head ?? existing?.state.material?.head ?? eventPair?.material?.head ?? '';
    const eventRound = input.marker.knownVerb === 'READY_FOR_AUDIT'
      ? String(eventPair?.round ?? existing?.state.round ?? '')
      : String(existing?.state.round ?? eventPair?.round ?? '');
    const eventAttrs = (input.marker.knownVerb === 'PASS' || input.marker.knownVerb === 'REWORK' || input.marker.knownVerb === 'READY_FOR_AUDIT')
      ? { ...input.marker.attrs, __round: eventRound, __head: eventHead }
      : input.marker.attrs;
    const recorded = store.recordEvent({
      id: input.eventId,
      project: input.project,
      taskId: taskId ?? input.marker.taskId,
      writer: input.writer,
      role,
      verb: input.marker.knownVerb ?? input.marker.verb,
      attrs: eventAttrs,
      effect: transition.effect,
      unusual: transition.unusual,
      ...(transition.resourceConflict ? { resourceConflict: transition.resourceConflict } : {}),
      source: input.source,
      ...(transition.fromStatus ? { fromStatus: transition.fromStatus } : {}),
      ...(transition.toStatus ? { toStatus: transition.toStatus } : {}),
      at: now,
    });
    if (!recorded) return { effect: 'replayed', unusual: false, intents: [] };
    let stored: StoredTaskPair | undefined = existing;
    if (transition.pair) {
      // Any marker that reopens a terminal pair (STARTED/WORKING/QUEUE,
      // READY_FOR_AUDIT, or a new verdict) must also reopen its retained
      // workspace. These paths do not pass through ensureWorkspace, so clear
      // the old retention timestamp here before the next terminal transition.
      const reopensWorkspace = existing?.state.workspace
        && existing.state.workspace.status !== 'removed'
        && isTerminalTaskPairStatus(existing.state.status)
        && transition.toStatus !== undefined
        && !isTerminalTaskPairStatus(transition.toStatus);
      const workspace = transition.pair.workspace;
      const pairToSave = reopensWorkspace && workspace
        ? {
            ...transition.pair,
            workspace: { ...workspace, status: 'active' as const, endedAt: undefined, keptReason: undefined, strippedAt: undefined },
          }
        : transition.pair;
      stored = store.savePair(input.project, redirectMaterialToCurrentWorkspace(pairToSave), {
        liveness: this.#livenessAfterMarker(existing?.liveness, transition, role, now),
      });
      if (busySessions.size > 0) stored = this.#noteParticipantConflicts(input.project, stored, busySessions);
      this.#track(refreshTaskPairWorkspaceHead(input.project, stored.state.taskId));
    }
    // A head handed to audit or PASSed on a base far behind the integration branch: warn once (background, never a gate).
    if (stored && transition.pair && !isTerminalTaskPairStatus(stored.state.status)) {
      const staleStage = input.marker.knownVerb === 'READY_FOR_AUDIT' && transition.toStatus === 'in_audit' ? 'ready'
        : input.marker.knownVerb === 'PASS' && transition.toStatus === 'passed' ? 'pass' : undefined;
      if (staleStage) this.#track(checkStaleBaseNotice(input.project, stored.state.taskId, staleStage));
    }
    if (stored && transition.pair && this.#shouldAutoTickChecklist(input.marker.knownVerb, transition, stored.state)) {
      stored = this.#autoTickChecklist(input.project, stored, input.eventId, now, input.marker.knownVerb!);
      transition.pair = stored.state;
    }
    // READY is intentionally accepted even when the executor forgot to send
    // the exact-revision validation report.  Nudge once per round immediately
    // so the auditor does not sit in a material-backed round with no evidence.
    if (stored && input.marker.knownVerb === 'READY_FOR_AUDIT'
      && transition.toStatus === 'in_audit'
      && input.writer === stored.state.executor
      && !readyHasValidationReport(store, stored, input.marker.attrs)) {
      const key = `validation-report:${stored.state.round}`;
      if (!stored.liveness.notified.includes(key)) {
        store.saveLiveness(input.project, stored.state.taskId, {
          ...stored.liveness,
          notified: [...stored.liveness.notified, key],
        });
        this.#track(sendTaskPairMessage(
          input.writer,
          stored.state.taskId,
          'validation-report',
          `READY_FOR_AUDIT for ${stored.state.taskId} was accepted, but no validation report was sent to the auditor in round ${stored.state.round}. Please send your exact-head validation report to ${stored.state.auditor ?? 'the auditor'} now.`,
        ));
      }
    }
    if (stored && input.marker.attrs.title && stored.state.brain === input.writer
      && isUsableTaskPairTitle(input.marker.attrs.title, stored.state.taskId)) {
      this.#clearTitleRequest(stored.state.brain, stored.state.taskId);
    }
    if (stored && (input.marker.knownVerb === 'QUEUE' || input.marker.knownVerb === 'DISPATCH')
      && (transition.effect === 'created' || transition.effect === 'dispatched' || transition.effect === 'reopened')) {
      this.ensureTaskPairTitle(
        input.project,
        stored.state.taskId,
        stored.state.brief ?? (input.turnText ? stripTaskPairMarkersForDisplay(input.turnText) : undefined),
        input.writer,
        { emitEvent: false },
      );
    }
    this.#emitEvent(input, taskId ?? input.marker.taskId, role, transition, stored?.state ?? existing?.state);
    const holdsAutoPickAuditor = input.suppressAutoPickAuditor
      && transition.intents.some((intent) => intent.kind === 'pick_auditor');
    // A named participant held by another pair is deliberately parked. Do
    // not recursively ask a queue runner to dispatch it immediately; the
    // holding pair's terminal slot change (or the next heartbeat) will retry.
    const busyQueued = busySessions.size > 0 && stored?.state.status === 'queued';
    const immediateIntents = transition.intents.filter((intent) => (
      !(holdsAutoPickAuditor && intent.kind === 'pick_auditor')
      && !(busyQueued && intent.kind === 'slot_changed')
    ));
    this.#track(this.#executeIntents(input.project, stored?.state, immediateIntents));
    // A terminal transition always frees its named participant and must wake
    // queue admission immediately, even when the transition's slot_changed
    // intent was suppressed because this pair had observed a stale binding.
    if (stored && transition.toStatus && isTerminalTaskPairStatus(transition.toStatus)
      && transition.fromStatus && !isTerminalTaskPairStatus(transition.fromStatus)) {
      if (this.#scheduler?.runQueue) this.#track(Promise.resolve(this.#scheduler.runQueue(input.project, stored.state.brain)));
    }
    if (holdsAutoPickAuditor && stored) this.#track(this.#gracePickAuditor(input.project, stored.state.taskId));
    // A pair Brain opens (DISPATCH marker, plain or task-tagged dispatch) tells
    // its participants what a pair is. The queue sends its own brief. A
    // REASSIGN that hands the executor role to someone new tells them too --
    // pre-fix a REASSIGN never briefed the new executor at all, who got no
    // title, brief or workspace (owner report, tsk_cd_upgrade_starvation).
    // A DISPATCH that landed on `queued` (no free slot/window right now, or a
    // brand new pair the queue drain has not resolved yet) has no participant
    // to brief -- the queue runner briefs it once it actually starts.
    if (stored && !input.suppressAutomaticBrief && input.source !== 'queue' && transition.toStatus !== 'queued'
      && ((input.marker.knownVerb === 'DISPATCH' && (transition.effect === 'created' || transition.effect === 'dispatched'))
        || (input.marker.knownVerb === 'REASSIGN' && !!input.marker.attrs.executor
          && (transition.effect === 'reassigned' || transition.effect === 'reassigned_auditor')))) {
      this.#track(this.briefParticipants(input.project, stored.state.taskId));
    }
    // Brain's explicit marker can still start a queued pair by hand. It must end
    // up exactly like an admitted pair: workspace provisioned, brief delivered.
    if (stored && !input.suppressAutomaticBrief && input.source !== 'queue' && transition.fromStatus === 'queued'
      && transition.toStatus && transition.toStatus !== 'queued' && !isTerminalTaskPairStatus(transition.toStatus)) {
      this.#track(this.briefParticipants(input.project, stored.state.taskId));
    }
    // A pair that just ended (DONE, CANCEL, DONE force=true): its workspace
    // starts its retention and a deliverable named on DONE is kept.
    if (stored && transition.toStatus && isTerminalTaskPairStatus(transition.toStatus)
      && (!transition.fromStatus || !isTerminalTaskPairStatus(transition.fromStatus))) {
      const released = store.releaseResourceClaims(input.project, stored.state.taskId, now);
      if (released.length) {
        const cleanup = { releasedAt: now, resources: released.map((claim) => claim.resource), checklist: released.map((claim) => 'Confirm cleanup of ' + claim.resource + '; do not delete resources owned by another pair.') };
        stored = store.savePair(input.project, { ...stored.state, resourceClaims: [], resourceCleanup: cleanup, updatedAt: now }); transition.pair = stored.state;
        this.#track(sendTaskPairMessage(stored.state.executor ?? stored.state.brain, stored.state.taskId, 'resource-cleanup', 'Claims released for ' + stored.state.taskId + '. Cleanup checklist: ' + cleanup.checklist.join(' | ')));
      }
      this.#track(this.endWorkspace(input.project, stored.state.taskId, now));
    }
    if (stored && transition.toStatus === 'passed' && transition.fromStatus !== 'passed') {
      this.#scheduler?.flagEconomyUnreviewed?.(input.project, stored.state.taskId);
    }
    // A no-auditor pair has no PASS for Brain to learn about instead: relay
    // the executor's own closing-reply prose (the marker line stripped out)
    // as the completion notice, so Brain never has to poll a pair it can't
    // watch an auditor finish for it.
    if (stored && input.marker.knownVerb === 'DONE' && transition.toStatus === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION
      && transition.fromStatus !== TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION && stored.state.auditor === TASK_PAIR_NO_AUDITOR
      && input.writer !== stored.state.brain) {
      const summary = input.turnText ? stripTaskPairMarkersForDisplay(input.turnText) : '';
      const brain = stored.state.brain;
      const taskId = stored.state.taskId;
      this.#track(sendTaskPairMessage(brain, taskId, 'brain-line-done-no-auditor', buildNoAuditorDoneNotice(stored.state, summary))
        .then((result) => this.#scheduler?.armBrainDecisionFollowUp?.({
          brain, taskIds: [taskId], messageIdPrefix: taskPairMessageIdPrefix(taskId, 'brain-line-done-no-auditor'), result,
        })));
    }
    // An audited pair's PASS (and, as a backstop, its later DONE) gets Brain
    // a notice with the verdict and material by itself -- owner report: two
    // PASSed pairs sat unintegrated for hours because Brain relied on the
    // executor remembering to say so (mirrors the no-auditor DONE relay
    // above). Exactly one per pair per round: whichever transition catches
    // it first.
    if (stored && stored.state.auditor && stored.state.auditor !== TASK_PAIR_NO_AUDITOR
      && input.writer !== stored.state.brain
      && ((transition.toStatus === 'passed' && transition.fromStatus !== 'passed')
        || (input.marker.knownVerb === 'DONE' && transition.toStatus === 'done' && transition.fromStatus !== 'done'))) {
      const key = `pass-done-notice:${stored.state.round}`;
      if (!stored.liveness.notified.includes(key)) {
        store.saveLiveness(input.project, stored.state.taskId, { ...stored.liveness, notified: [...stored.liveness.notified, key] });
        this.#track(sendTaskPairMessage(
          stored.state.brain, stored.state.taskId, 'brain-line-pass-done',
          buildPassDoneNoticeMessage(stored.state),
        ));
      }
    }
    if (input.marker.knownVerb === 'DISPATCH' && transition.pair?.executor
      && input.writer === transition.pair.brain) {
      this.#recentBrainDispatch.set(`${input.project}\u0000${transition.pair.brain}\u0000${transition.pair.executor}`, { taskId: transition.pair.taskId, at: Date.now() });
    }
    return transition;
  }

  #shouldAutoTickChecklist(
    verb: TaskPairMarker['knownVerb'],
    transition: TaskPairTransition,
    pair: TaskPairState,
  ): boolean {
    if (!pair.brief) return false;
    if (verb === 'READY_FOR_AUDIT' && transition.toStatus === 'in_audit') {
      return parseTaskPairChecklist(pair.brief).some((item) => !item.implemented);
    }
    if (verb === 'PASS' && transition.toStatus === 'passed') return true;
    return verb === 'DONE'
      && pair.auditor === TASK_PAIR_NO_AUDITOR
      && (transition.toStatus === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION || transition.toStatus === 'done');
  }

  #autoTickChecklist(
    project: string,
    stored: StoredTaskPair,
    parentEventId: string,
    now: number,
    markerVerb: string,
  ): StoredTaskPair {
    const store = getTaskPairStore();
    let current = stored;
    const reason = markerVerb === 'READY_FOR_AUDIT'
      ? 'ready_for_audit_backstop'
      : markerVerb === 'PASS'
        ? 'pass_backstop'
        : 'done_backstop';
    const boxes = markerVerb === 'PASS' ? ['implemented', 'audited'] as const : ['implemented'] as const;
    for (const box of boxes) {
      const items = parseTaskPairChecklist(current.state.brief ?? '')
        .filter((item) => !item[box])
        .map((item) => item.index);
      if (items.length === 0) continue;
      const previous = current.state;
      const markdown = updateTaskPairChecklist(previous.brief ?? '', items, box, true);
      if (markdown === (previous.brief ?? '')) continue;
      const next = { ...previous, brief: markdown, updatedAt: now };
      current = store.savePair(project, next, { liveness: current.liveness });
      const eventId = `${parentEventId}:checklist-auto:${box}`;
      const role = taskPairRoleOf(previous, 'daemon');
      const notice = `Daemon checklist backstop (${reason}) filled ${box} items ${items.join(',')}; no participant CHECK was received for these items before ${markerVerb}.`;
      if (store.recordEvent({
        id: eventId,
        project,
        taskId: previous.taskId,
        writer: 'daemon',
        role,
        verb: TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
        attrs: { box, items: items.join(','), checked: 'true', reason, notice },
        effect: 'checklist_auto_tick',
        unusual: false,
        source: 'daemon',
        fromStatus: previous.status,
        toStatus: next.status,
        at: now,
      })) {
        emitTaskPairDaemonEvent(current.state, {
          eventId,
          verb: TASK_PAIR_CHECKLIST_AUTO_TICK_VERB,
          effect: 'checklist_auto_tick',
          source: 'daemon',
          fromStatus: previous.status,
          toStatus: next.status,
          unusual: false,
          checklistAutoTickReason: reason,
          checklistAutoTickNotice: notice,
        });
      }
    }
    return current;
  }

  /** Keep an explicitly named participant queued and tell its Brain once per holder pair. */
  #noteParticipantConflicts(project: string, stored: StoredTaskPair, busySessions: ReadonlySet<string>): StoredTaskPair {
    const store = getTaskPairStore();
    const conflicts = store.listActivePairs()
      .filter((candidate) => candidate.project !== project || candidate.state.taskId !== stored.state.taskId)
      .filter((candidate) => busySessions.has(candidate.state.executor ?? '') || busySessions.has(candidate.state.auditor ?? ''))
      .filter((candidate) => !isTerminalTaskPairStatus(candidate.state.status));
    if (conflicts.length === 0) return stored;
    const details = conflicts.map((candidate) => {
      const held = [candidate.state.executor, candidate.state.auditor]
        .filter((session): session is string => !!session && busySessions.has(session));
      const ageMs = Math.max(0, Date.now() - candidate.state.updatedAt);
      const age = ageMs < 60_000 ? `${Math.floor(ageMs / 1_000)}s`
        : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m`
          : `${Math.floor(ageMs / 3_600_000)}h`;
      return `${held.join('/')} held by ${candidate.state.taskId} (status ${candidate.state.status}, age ${age})`;
    });
    const current = stored.state;
    // The wait reason is computed here too: this arrival suppresses the immediate queue run
    // (see #executeIntents), which is what normally writes it, so without it the pair would keep
    // showing no reason, or the reason of whatever it waited for before (a REASSIGN onto a held
    // session), until the next 30 s sweep. Whenever the holder named now differs from the stored
    // reason, the stored one is replaced. Same wording as the scheduler's (buildHeldWaitReason).
    const firstConflict = conflicts[0]!;
    const firstHeld = [firstConflict.state.executor, firstConflict.state.auditor]
      .find((session): session is string => !!session && busySessions.has(session));
    const heldReason = firstHeld ? buildHeldWaitReason(firstHeld, firstConflict.state, Date.now()) : undefined;
    const needsFlag = current.status === 'queued' && !current.flags.includes('waiting_for_capacity');
    const heldSessionChanged = heldReason !== undefined
      && !current.capacityWaitReason?.startsWith(`waiting for ${firstHeld} (busy in ${firstConflict.state.taskId}`);
    const needsReason = current.status === 'queued' && heldSessionChanged;
    const nextState = needsFlag || needsReason
      ? {
          ...current,
          flags: needsFlag ? [...current.flags, 'waiting_for_capacity' as const] : current.flags,
          ...(needsReason ? { capacityWaitReason: heldReason } : {}),
          updatedAt: Date.now(),
        }
      : current;
    const fresh = conflicts;
    const freshKeys = fresh
      .map((candidate) => `participant_busy:${candidate.state.taskId}`)
      .filter((key) => !stored.liveness.notified.includes(key));
    const liveness = freshKeys.length > 0
      ? { ...stored.liveness, notified: [...stored.liveness.notified, ...freshKeys] }
      : stored.liveness;
    const saved = nextState !== current || liveness !== stored.liveness
      ? store.savePair(project, nextState, { liveness })
      : stored;
    if (freshKeys.length > 0) {
      this.#track(sendTaskPairMessage(
        saved.state.brain,
        saved.state.taskId,
        'participant-busy',
        `Named participant conflict: ${details.join('; ')}. ${saved.state.taskId} remains queued and will start when the holding pair ends.`,
      ));
    }
    return saved;
  }

  /**
   * Id for a pair the Brain opened through send_message without naming one.
   * With a seed (caller + idempotency key) the id is derived from it, so a
   * replayed send lands on the same pair instead of opening a second one.
   */
  mintTaskId(project: string, seed?: string): string {
    const store = getTaskPairStore();
    const idFor = (entropy: string) => `${SUPERVISION_ID_PREFIXES.task}_${
      createHash('sha256').update(`${project}\0${entropy}`).digest('hex').slice(0, 10)}`;
    if (seed) return idFor(`seed:${seed}`);
    for (;;) {
      const id = idFor(randomUUID());
      if (!store.getPair(project, id)) return id;
    }
  }

  /** Ask the queue to try to admit waiting pairs now (its normal, capacity-checked path). */
  #requestQueueAdmission(project: string, brain: string): void {
    const runQueue = this.#scheduler?.runQueue;
    if (runQueue) this.#track(Promise.resolve(runQueue.call(this.#scheduler, project, brain)));
  }

  /**
   * Compatibility ingestion for task metadata. The runtime pairs timeline
   * rejects new Brain pairs through this path; structured pair_create is the
   * only creation route. Existing-pair continuation remains supported.
   */
  implicitDispatch(input: {
    project?: string; sender: string; target: string; taskId: string; auditor?: string; title?: string; titleExplicit?: boolean; eventId: string;
    /** Optional report metadata carried by executor -> auditor sends. */
    reportAttrs?: Record<string, string>;
    message?: string;
    /** Owner rule (design D-pool-sync): a bound `task.requestedExecutionType.model` on the initial send_message dispatch, kept so a later automatic executor replacement still honors it instead of falling back to the allowlist. */
    executorModel?: string;
    auditorModel?: string;
    executionPool?: 'primary' | 'economy';
    suppressAutomaticBrief?: boolean;
    /** True only for the structured pair_create MCP operation. */
    structuredPairCreate?: true;
    /** True only for a send carrying real task metadata (task.objective).
     *  A pair minted for a plain send_message (no metadata) has none of the
     *  Brain's own task description -- see suppressAutoPickAuditor. */
    hasObjective?: boolean;
    /** The send's own text (objective, or the plain message as a fallback):
     *  stored as the pair's brief when this creates a new pair with none, so
     *  pair_task_get and a later re-dispatch/REASSIGN still have the actual
     *  brief to hand the executor -- not just a title (owner report,
     *  tsk_cd_pair_implicit_duplicates: stored an empty brief). Never
     *  overwrites an existing pair's brief (the `existing` branch above
     *  never reaches this call at all). */
    brief?: string;
  }): TaskPairTransition | undefined {
    const project = input.project ?? projectOfSession(input.sender) ?? projectOfSession(input.target);
    if (!project || !isPairsEngineProject(project)) return undefined;
    const store = getTaskPairStore();
    const existing = store.getPair(project, input.taskId);
    if (existing) {
      this.ensureTaskPairTitle(project, input.taskId, input.brief ?? existing.state.brief ?? existing.state.title, input.sender, { mechanicalTitle: input.titleExplicit !== true });
      if (input.sender === existing.state.brain
        && (input.target === existing.state.executor
          || (existing.state.auditor && existing.state.auditor !== TASK_PAIR_NO_AUDITOR && input.target === existing.state.auditor))) {
        const resolved = this.resolveBrainReply(project, input.taskId, input.sender, input.target, input.eventId);
        if (resolved) {
          noteTaskPairFocus(input.target, input.taskId);
          return resolved;
        }
      }
      // A queued pair is NOT started by a task-bound send (owner report,
      // tsk_cd_implicit_working_no_workspace): a status flip here skipped
      // admission -- no capacity check, no workspace, no brief -- and left a
      // "working" pair whose executor had nowhere to work. The message itself
      // is still delivered (this is only bookkeeping); the queue admits the pair
      // through its one path, and the request below makes that happen now
      // when there is capacity instead of at the next heartbeat.
      const queuedExecutorTraffic = existing.state.status === 'queued'
        && (input.sender === existing.state.executor || input.target === existing.state.executor);
      if (queuedExecutorTraffic) this.#requestQueueAdmission(project, existing.state.brain);
      // Record only: ordinary traffic (materials to the auditor, replies,
      // Brain messages) never changes a pair's roles or status.
      const state = existing.state;
      if (input.sender === state.brain && state.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION) {
        const resumed = this.applyMarker({
          project, writer: input.sender,
          marker: { verb: 'WORKING', knownVerb: 'WORKING', taskId: input.taskId, attrs: {} },
          source: 'implicit_dispatch', eventId: input.eventId,
        });
        noteTaskPairFocus(input.target, input.taskId);
        return resumed;
      }
      const counterpart = input.sender === state.executor ? state.auditor
        : input.sender === state.auditor ? state.executor
          : undefined;
      const unusual = input.sender !== state.brain && input.target !== counterpart;
      const at = Date.now();
      const report = input.reportAttrs ?? (isLikelyValidationReport(input.message) ? { report: 'true' } : undefined);
      const summaryHash = input.message?.trim()
        ? createHash('sha256').update(input.message.trim()).digest('hex').slice(0, 16)
        : undefined;
      const partnerRelay = input.target === state.brain && !!counterpart && !!summaryHash
        && store.listEvents(project, input.taskId, 100).some((event) => (
          event.verb === 'SEND'
          && event.writer === counterpart
          && event.attrs.target === state.brain
          && event.attrs.__round === String(state.round)
          && event.attrs.__summaryHash === summaryHash
          && at - event.at >= 0
          && at - event.at <= TASK_PAIR_MARKER_DEDUP_WINDOW_MS
        ));
      const sendAttrs = {
        target: input.target,
        ...(report ?? {}),
        ...(summaryHash ? { __summaryHash: summaryHash } : {}),
        __round: String(state.round),
      };
      store.recordEvent({
        id: input.eventId, project, taskId: input.taskId, writer: input.sender,
        role: taskPairRoleOf(state, input.sender), verb: 'SEND', attrs: sendAttrs,
        effect: partnerRelay ? 'relay_suppressed' : 'recorded', unusual: partnerRelay ? false : unusual,
        source: 'implicit_dispatch', fromStatus: state.status, toStatus: state.status,
        at,
      });
      // A report sent to the auditor is useful evidence, but it does not open
      // the material-backed audit round.  Remind both sides exactly once in
      // the current round: the executor gets the marker format, while the
      // auditor is told to wait for READY rather than ask Brain.
      const reportBeforeReady = !!report
        && input.sender === state.executor
        && input.target === state.auditor
        && state.auditor !== undefined
        && state.auditor !== TASK_PAIR_NO_AUDITOR
        && !store.listEvents(project, input.taskId, 500).some((event) => (
          event.verb === 'READY_FOR_AUDIT' && event.attrs.__round === String(state.round)
        ));
      if (reportBeforeReady) {
        const key = `ready-marker-reminder:${state.round}`;
        if (!existing.liveness.notified.includes(key)) {
          const nextLiveness = { ...existing.liveness, notified: [...existing.liveness.notified, key] };
          store.saveLiveness(project, input.taskId, nextLiveness);
          const ready = readyMarkerForPair(state);
          void sendTaskPairMessage(
            input.sender,
            input.taskId,
            'ready-marker-reminder',
            `Validation report received for ${state.taskId}, but this round is not in audit yet. Send READY_FOR_AUDIT now with the exact workspace/head/base: ${ready}`,
          );
          void sendTaskPairMessage(
            state.auditor!,
            input.taskId,
            'ready-marker-wait',
            `Validation report received for ${state.taskId}. Wait for the executor's READY_FOR_AUDIT marker for round ${state.round}; do not ask Brain for the audit window.`,
          );
        }
      }
      // A task-tagged send is progress on that pair, and its target now works on it.
      this.recordPairProgress(project, input.taskId, input.sender, at);
      noteTaskPairFocus(input.target, input.taskId);
      return { effect: 'recorded', unusual, intents: [] };
    }
    const transition = this.applyMarker({
      project,
      writer: input.sender,
      marker: {
        verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: input.taskId,
        attrs: {
          executor: input.target,
          ...(input.auditor ? { auditor: input.auditor } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.executorModel ? { executormodel: input.executorModel } : {}),
          ...(input.auditorModel ? { auditormodel: input.auditorModel } : {}),
          ...(input.executionPool ? { pool: input.executionPool } : {}),
        },
        ...(input.brief ? { brief: input.brief } : {}),
      },
      source: input.structuredPairCreate ? 'mcp' : 'implicit_dispatch',
      eventId: input.eventId,
      suppressAutomaticBrief: input.suppressAutomaticBrief,
      // Only when named the auditor is applied immediately as before; a bare
      // dispatch with none holds the auto-pick for the grace window unless
      // this send itself carried a real objective (clearly new work, no
      // reason to wait).
      // A task-bound objective is audited only when it crosses the shared
      // complexity threshold. Small requests remain lightweight unless the
      // user explicitly named an auditor.
      ...(!input.auditor && (!input.hasObjective || !isComplexSupervisionTaskBrief(input.brief))
        ? { suppressAutoPickAuditor: true } : {}),
    });
    this.ensureTaskPairTitle(project, input.taskId, input.brief, input.sender, { mechanicalTitle: input.titleExplicit !== true });
    return transition;
  }

  /** Resolve participant waits from an authoritative Brain reply. */
  resolveBrainReply(
    project: string,
    taskId: string,
    writer: string,
    target: string,
    messageId: string,
  ): TaskPairTransition | undefined {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.brain !== writer
      || (target !== stored.state.executor
        && (stored.state.auditor === undefined || stored.state.auditor === TASK_PAIR_NO_AUDITOR || target !== stored.state.auditor))) return undefined;
    const hadWait = stored.state.flags.includes('blocked')
      || stored.state.flags.includes('needs_input')
      || stored.state.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION;
    if (!hadWait) return undefined;
    const now = Date.now();
    const next = { ...stored.state, flags: [...stored.state.flags], flagSides: { ...stored.state.flagSides }, updatedAt: now };
    resolveTaskPairBrainWait(next, now);
    const liveness = {
      ...stored.liveness,
      brainLastActivityAt: now,
      brainWaitKey: undefined,
      brainWaitStartedAt: undefined,
      brainReminderCount: 0,
      brainReminderLastAt: undefined,
      brainReminderDue: undefined,
      brainReminderResolvedAt: now,
      brainReminderLastDecisionAt: undefined,
      brainReminderLastDecisionReason: undefined,
    };
    store.savePair(project, next, { liveness });
    const eventId = `brain-resolved:${messageId}`;
    if (!store.recordEvent({
      id: eventId, project, taskId, writer, role: 'brain', verb: 'BRAIN_RESOLVED',
      attrs: { messageId, target }, effect: 'brain_resolved', unusual: false,
      source: 'implicit_dispatch', fromStatus: stored.state.status, toStatus: next.status, at: now,
    })) return { effect: 'replayed', unusual: false, intents: [] };
    emitTaskPairDaemonEvent(next, {
      eventId, verb: 'BRAIN_RESOLVED', effect: 'brain_resolved', source: 'implicit_dispatch',
      fromStatus: stored.state.status, toStatus: next.status, unusual: false,
    });
    this.#scheduler?.publishBadges?.();
    return { pair: next, fromStatus: stored.state.status, toStatus: next.status, effect: 'brain_resolved', unusual: false, intents: [] };
  }

  /**
   * Final assistant output is progress for the pair it is about: every pair
   * whose task id it names; otherwise the writer's only open pair; otherwise
   * the pair the writer was last messaged about. A session in several pairs
   * that works on one of them does not keep the others looking alive.
   */
  recordProgress(writer: string, now: number, text = ''): void {
    const own = getTaskPairStore().pairsForSession(writer)
      .filter((pair) => pair.state.executor === writer || pair.state.auditor === writer);
    const named = own.filter((pair) => mentionsTaskId(text, pair.state.taskId));
    const open = own.filter((pair) => TASK_PAIR_OPEN_STATUSES.includes(pair.state.status));
    const focus = taskPairFocusOf(writer);
    const targets = named.length > 0 ? named
      : open.length === 1 ? open
        : open.filter((pair) => pair.state.taskId === focus);
    for (const pair of targets) this.#stampProgress(pair, writer, now);
  }

  /** Progress by one participant on one known pair (a task-tagged call or send). */
  recordPairProgress(project: string, taskId: string, writer: string, now: number): void {
    const pair = getTaskPairStore().getPair(project, taskId);
    if (pair) this.#stampProgress(pair, writer, now);
  }

  /** Record non-marker activity for every open pair the participant owns. */
  recordActivity(writer: string, now: number, options: { automation?: boolean } = {}): void {
    if (options.automation === true) return;
    // Runs for every tool event, user message and streamed delta of every
    // session: pairsForSession is an in-memory lookup and #stampActivity only
    // hits SQLite when something beyond an activity timestamp changed or the
    // pair was last written more than an interval ago.
    const pairs = getTaskPairStore().pairsForSession(writer)
      .filter((pair) => TASK_PAIR_OPEN_STATUSES.includes(pair.state.status));
    let brainStateChanged = false;
    for (const pair of pairs) {
      const material = this.#stampActivity(pair, writer, now);
      if (material && pair.state.brain === writer) brainStateChanged = true;
    }
    // Badges follow pair/reminder state, not the activity clock: a Brain
    // reply that clears a reminder is a material change, a bare timestamp
    // refresh is not.
    if (brainStateChanged) this.#scheduler?.publishBadges?.();
  }

  #stampProgress(pair: StoredTaskPair, writer: string, now: number): void {
    const liveness = { ...pair.liveness };
    liveness.lastMaterialAt = now;
    if (pair.state.brain === writer) {
      liveness.brainLastActivityAt = now;
      liveness.brainWaitKey = undefined;
      liveness.brainWaitStartedAt = undefined;
      liveness.brainReminderCount = 0;
      liveness.brainReminderResolvedAt = now;
      liveness.brainReminderDue = undefined;
      liveness.brainReminderLastAt = undefined;
    }
    if (pair.state.executor === writer) {
      liveness.progressExecutorAt = now;
      liveness.activityExecutorAt = now;
      liveness.silenceExecutor = 0;
      liveness.executorEscalationAt = undefined;
      liveness.executorEscalationReminderCount = 0;
      liveness.executorEscalationLastAt = undefined;
      liveness.bothIdleNudgedAt = undefined;
      liveness.bothIdleNudgeCount = undefined;
    }
    if (pair.state.auditor === writer) {
      liveness.progressAuditorAt = now;
      liveness.activityAuditorAt = now;
      liveness.silenceAuditor = 0;
      liveness.bothIdleNudgedAt = undefined;
      liveness.bothIdleNudgeCount = undefined;
    }
    const nextState = pair.state.executor === writer && pair.state.flags.includes('executor_silent')
      ? { ...pair.state, flags: pair.state.flags.filter((flag) => flag !== 'executor_silent'), updatedAt: now }
      : pair.state;
    // A stamp that changes no pair state is only liveness: it goes through the
    // throttled path instead of rewriting the whole pair row (brief included)
    // and pushing a console delta for every final assistant message.
    if (nextState === pair.state) getTaskPairStore().saveLivenessActivityStamp(pair.project, pair.state.taskId, liveness);
    else getTaskPairStore().savePair(pair.project, nextState, { liveness });
  }

  /** Returns true when the stamp changed more than an activity timestamp. */
  #stampActivity(pair: StoredTaskPair, writer: string, now: number): boolean {
    const liveness = { ...pair.liveness };
    liveness.lastMaterialAt = now;
    // Any real Brain reply resolves the current wait immediately.  A later
    // state transition starts a new wait key and therefore a fresh 5-minute
    // cadence; this is deliberately durable so a restart cannot re-remind.
    const foldBrainReply = pair.state.brain === writer && !!this.#scheduler?.brainReplyLiveness;
    if (pair.state.brain === writer) {
      liveness.brainLastActivityAt = now;
      if (!foldBrainReply) {
        liveness.brainWaitKey = undefined;
        liveness.brainWaitStartedAt = undefined;
        liveness.brainReminderCount = 0;
        liveness.brainReminderResolvedAt = now;
        liveness.brainReminderDue = undefined;
        liveness.brainReminderLastAt = undefined;
      }
    }
    if (pair.state.executor === writer) {
      liveness.activityExecutorAt = now;
      liveness.silenceExecutor = 0;
      liveness.executorEscalationAt = undefined;
      liveness.executorEscalationReminderCount = 0;
      liveness.executorEscalationLastAt = undefined;
      liveness.bothIdleNudgedAt = undefined;
      liveness.bothIdleNudgeCount = undefined;
    }
    if (pair.state.auditor === writer) {
      liveness.activityAuditorAt = now;
      liveness.silenceAuditor = 0;
      liveness.bothIdleNudgedAt = undefined;
      liveness.bothIdleNudgeCount = undefined;
    }
    // Clearing executor_silent is a state change: persist it immediately.
    // Plain activity timestamps go through the throttled stamp path.
    if (pair.state.executor === writer && pair.state.flags.includes('executor_silent')) {
      const nextState = { ...pair.state, flags: pair.state.flags.filter((flag) => flag !== 'executor_silent'), updatedAt: now };
      getTaskPairStore().savePair(pair.project, nextState, { liveness });
      return true;
    }
    // A Brain reply clears the wait and the badge refresh right after it re-arms
    // the same wait for the same state. Fold the two: only when the net result
    // differs beyond the activity clocks (a reminder was already sent, a due
    // flag was set) is this a material change worth a write and a badge pass.
    const net = foldBrainReply ? this.#scheduler!.brainReplyLiveness!({ ...pair, liveness }, now) : liveness;
    const material = livenessChangedBeyondActivityTimestamps(pair.liveness, net);
    getTaskPairStore().saveLivenessActivityStamp(pair.project, pair.state.taskId, net);
    return material;
  }

  /** A repeated STARTED from the current executor of a working pair whose transition is a strict no-op. */
  #isIdempotentStarted(input: ApplyMarkerInput, existing: StoredTaskPair, transition: TaskPairTransition, role: string): boolean {
    if (input.marker.knownVerb !== 'STARTED' || input.source !== 'marker' || role !== 'executor') return false;
    if (existing.state.status !== 'working') return false;
    if (transition.effect !== 'status' || transition.fromStatus !== 'working' || transition.toStatus !== 'working') return false;
    if (transition.unusual || transition.intents.length > 0 || !transition.pair) return false;
    return JSON.stringify({ ...existing.state, updatedAt: 0 }) === JSON.stringify({ ...transition.pair, updatedAt: 0 });
  }

  #livenessAfterMarker(
    liveness: TaskPairLiveness | undefined,
    transition: TaskPairTransition,
    role: string,
    now: number,
  ): TaskPairLiveness {
    const next: TaskPairLiveness = liveness
      ? { ...liveness, notified: [...liveness.notified] }
      : { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: now, progressAuditorAt: now, activityExecutorAt: now, activityAuditorAt: now, lastTickAt: now, notified: [] };
    const phase = transition.toStatus ?? transition.pair?.status;
    if (phase && next.phase !== phase) {
      next.phase = phase;
      next.phaseStartedAt = now;
      next.stageStallPromptAt = undefined;
      next.stageStallEscalatedAt = undefined;
    } else if (phase && next.phaseStartedAt === undefined) {
      next.phase = phase;
      next.phaseStartedAt = now;
    }
    next.lastMaterialAt = now;
    if (role === 'executor') { next.progressExecutorAt = now; next.silenceExecutor = 0; }
    if (role === 'auditor') { next.progressAuditorAt = now; next.silenceAuditor = 0; }
    if (role === 'executor') next.activityExecutorAt = now;
    if (role === 'auditor') next.activityAuditorAt = now;
    if (role === 'executor') {
      next.executorEscalationAt = undefined;
      next.executorEscalationReminderCount = 0;
      next.executorEscalationLastAt = undefined;
    }
    if (role === 'brain') {
      next.brainLastActivityAt = now;
      next.brainWaitKey = undefined;
      next.brainWaitStartedAt = undefined;
      next.brainReminderCount = 0;
      next.brainReminderResolvedAt = now;
      next.brainReminderDue = undefined;
      next.brainReminderLastAt = undefined;
    }
    next.bothIdleNudgedAt = undefined;
    next.bothIdleNudgeCount = undefined;
    // A finished pair that is worked on again is no longer "integrated" or reminded about: its next DONE starts over.
    if (transition.toStatus !== undefined && transition.toStatus !== 'done') {
      next.integrationKey = undefined;
      next.integrationReminderCount = undefined;
      next.integrationReminderLastAt = undefined;
      next.integrationIntegratedAt = undefined;
    }
    // A new delivery round starts both sides with a clean slate: the pair
    // sat idle in `passed`, and neither that nor the previous round's silence
    // may count against the new round.
    if (transition.effect === 'next_round') {
      next.silenceExecutor = 0;
      next.silenceAuditor = 0;
      next.progressExecutorAt = now;
      next.progressAuditorAt = now;
      next.activityExecutorAt = now;
      next.activityAuditorAt = now;
      next.executorEscalationAt = undefined;
      next.executorEscalationReminderCount = 0;
      next.executorEscalationLastAt = undefined;
    }
    // A new auditor starts with a clean slate.
    if (transition.effect === 'reassigned_auditor') {
      next.silenceAuditor = 0;
      next.progressAuditorAt = now;
      next.activityAuditorAt = now;
    }
    return next;
  }

  #emitEvent(
    input: ApplyMarkerInput,
    taskId: string,
    role: TaskPairEventPayload['role'],
    transition: TaskPairTransition,
    pair: TaskPairState | undefined,
  ): void {
    const noticeText = input.turnText ? stripTaskPairMarkersForDisplay(input.turnText).trim().slice(0, 4000) : '';
    const auditDetails = noticeText ? parseTaskPairAuditDetails(noticeText) : undefined;
    emitTaskPairTimelineEvent({
      taskId,
      verb: input.marker.knownVerb ?? input.marker.verb,
      writer: input.writer,
      role,
      source: input.source,
      effect: transition.effect,
      ...(transition.fromStatus ? { fromStatus: transition.fromStatus } : {}),
      ...(transition.toStatus ?? pair?.status ? { toStatus: transition.toStatus ?? pair?.status } : {}),
      ...(transition.toStatus === 'cancelled' ? {
        cancelActor: input.writer,
        cancelSource: input.source,
        ...(cancellationReason(input.marker.attrs) ? { cancelReason: cancellationReason(input.marker.attrs) } : {}),
        cancelProvenanceTrusted: true,
      } : {}),
      unusual: transition.unusual,
      ...(transition.resourceConflict ? { resourceConflict: transition.resourceConflict } : {}),
      ...(transition.verdict ? { severityCounts: transition.verdict.counts, verdictJudgement: transition.verdict.judgement } : {}),
      ...(noticeText ? { noticeText } : {}),
      ...(pair?.blockedNote ? { blockedNote: pair.blockedNote } : {}),
      ...(auditDetails ? { auditDetails } : {}),
    }, pair, input.eventId);
  }

  async #executeIntents(project: string, pair: TaskPairState | undefined, intents: readonly TaskPairIntent[]): Promise<void> {
    for (const intent of intents) {
      if (intent.kind === 'queue_settings') {
        getTaskPairStore().setMaxConcurrency(intent.brain, intent.maxConcurrency);
        // Avoid creating an empty run while this turn is still ingesting its
        // following QUEUE/DISPATCH markers; that would defer the first real
        // queue event and let a later urgent item overtake it.
        const hasQueued = getTaskPairStore().listActivePairs(project).some((stored) => (
          stored.state.brain === intent.brain && stored.state.status === 'queued'
        ));
        if (hasQueued) await this.#scheduler?.runQueue?.(project, intent.brain);
        continue;
      }
      if (intent.kind === 'policy_notice') {
        const key = `${intent.taskId}\u0000${intent.to}`;
        if (pair) {
          await sendTaskPairMessage(intent.to, pair.taskId, 'policy-rejection', intent.text);
        } else if (!this.#policyNoticeKeys.has(key)) {
          this.#policyNoticeKeys.add(key);
          if (this.#policyNoticeKeys.size > 500) this.#policyNoticeKeys.delete(this.#policyNoticeKeys.values().next().value!);
          await sendTaskPairMessage(intent.to, intent.taskId, 'policy-rejection', intent.text);
        }
        continue;
      }
      if (!pair) continue;
      try {
        switch (intent.kind) {
          case 'correction':
            await sendTaskPairMessage(intent.to, pair.taskId, 'correction', buildCorrectionMessage(pair, intent.judgement));
            break;
          case 'done_reminder':
            await sendTaskPairMessage(intent.to, pair.taskId, 'done-reminder', buildDoneReminderMessage(pair));
            break;
          case 'closed_pair_notice':
            await sendTaskPairMessage(intent.to, pair.taskId, 'closed-pair', `${pair.taskId} is ${pair.status} -- only Brain can reopen it. Your marker was recorded but not applied.`);
            break;
          case 'rework_notice':
            await sendTaskPairMessage(intent.to, pair.taskId, 'rework', buildReworkNoticeMessage(pair, intent.counts));
            break;
          case 'brain_reopen_notice': {
            const recipients = [pair.executor, pair.auditor]
              .filter((target): target is string => !!target && target !== TASK_PAIR_NO_AUDITOR);
            await Promise.all([...new Set(recipients)].map((target) => sendTaskPairMessage(
              target, pair.taskId, 'brain-reopen', buildBrainReopenNoticeMessage(pair, intent.reason),
            )));
            break;
          }
          case 'next_round_notice': {
            const recipients = [pair.executor, pair.auditor]
              .filter((target): target is string => !!target && target !== TASK_PAIR_NO_AUDITOR);
            await Promise.all([...new Set(recipients)].map((target) => sendTaskPairMessage(
              target, pair.taskId, 'next-round', buildNextRoundNoticeMessage(pair, intent.note),
            )));
            break;
          }
          case 'auditor_proposal_nudge':
            await sendTaskPairMessage(intent.to, pair.taskId, 'auditor-proposal-nudge', buildAuditorProposalNudgeMessage(pair));
            break;
          case 'convergence_checkpoint_nudge':
            await sendTaskPairMessage(intent.to, pair.taskId, 'convergence-checkpoint', buildConvergenceCheckpointMessage(pair));
            break;
          case 'brain_notice':
            await sendTaskPairMessage(pair.brain, pair.taskId, `brain-${intent.flag}`, buildBrainNoticeMessage(pair, intent.flag));
            break;
          case 'audit_request': {
            const material = await resolveTaskPairMaterial(pair);
            if (material.source === 'pending' || (!material.worktree && !material.path)) {
              if (pair.executor) await sendTaskPairMessage(pair.executor, pair.taskId, 'material-pending', `Material is pending for ${pair.taskId}; resend READY_FOR_AUDIT with worktree=<absolute path> head=<commit> (or path=<task directory>).`);
              await sendTaskPairMessage(intent.to, pair.taskId, 'audit-request', `Material pending for ${pair.taskId}; the executor must resend READY_FOR_AUDIT with an explicit workspace path and head.`);
            } else {
              const roundBase = await verifyTaskPairRoundBase(pair, material);
              if (roundBase.status === 'not_ancestor') {
                // The state machine cannot run git; a head that does not build
                // on this round's base is sent back instead of audited.
                this.#holdMaterialOutsideBase(project, pair, roundBase.head, roundBase.base);
                if (pair.executor) await sendTaskPairMessage(pair.executor, pair.taskId, 'material-base-mismatch', buildRoundBaseMismatchExecutorMessage(pair, roundBase.head, roundBase.base));
                await sendTaskPairMessage(intent.to, pair.taskId, 'audit-request', buildRoundBaseMismatchAuditorMessage(pair, roundBase.head, roundBase.base));
              } else {
                await sendTaskPairMessage(intent.to, pair.taskId, 'audit-request', buildAuditRequestMessage(pair, material, buildRoundBaseAuditLine(pair, roundBase)));
                queueAuditRebaseWarning(project, pair, material);
              }
            }
            break;
          }
          default:
            await this.#scheduler?.onIntent(project, pair, intent);
        }
      } catch (error) {
        logger.warn({ err: error, taskId: pair.taskId, intent: intent.kind }, 'task-pair: intent failed');
      }
    }
  }

  /** Fires the `pick_auditor` intent held by `suppressAutoPickAuditor` if the
   *  grace window elapses with no real auditor -- i.e. the Brain's marker
   *  never arrived (or arrived with no auditor of its own), same outcome as
   *  an ordinary immediate pick, just delayed. */
  async #gracePickAuditor(project: string, taskId: string): Promise<void> {
    const graceMs = resolveImplicitAuditorGraceMs();
    // A real setTimeout, even at 0ms, waits for Node's timer phase, which can
    // lag behind microtasks/setImmediate under load -- exactly the busy-daemon
    // scenario this feature exists for. Skip it entirely when grace is
    // disabled instead of racing that phase.
    if (graceMs > 0) {
      await new Promise<void>((resolve) => {
        // #track (the caller) covers a bounded drain on shutdown/dispose; this
        // must not ALSO hold the process open on its own in the meantime.
        setTimeout(resolve, graceMs).unref();
      });
    }
    const latest = getTaskPairStore().getPair(project, taskId);
    if (!latest || latest.state.auditor) return;
    await this.#executeIntents(project, latest.state, [{ kind: 'pick_auditor' }]);
  }

  #settleInFlight = new Map<string, Promise<TaskPairState | undefined>>();
  #settleReported = new Set<string>();
  /** A deferred move (busy session / process inside) is retried at most once a minute: the process probe is not free. */
  #settleBackoffUntil = new Map<string, number>();

  /**
   * Keep one authoritative workspace under the pair's CURRENT executor: after
   * an executor change the worktree is moved under the new executor (see
   * rehomeTaskPairWorkspace), a same-task worktree found beside it is
   * registered as a duplicate, and the pair's material naming the old path is
   * rewritten to the new one. Serialised per pair (the brief and the heartbeat
   * both call it) and idempotent: an unchanged pair costs two path compares.
   * Returns the pair as stored afterwards.
   */
  settleWorkspaceOwner(project: string, taskId: string, options: { notify: boolean }): Promise<TaskPairState | undefined> {
    const key = `${project}\u0000${taskId}`;
    const running = this.#settleInFlight.get(key);
    if (running) return running;
    const promise = this.#settleWorkspaceOwner(project, taskId, options).finally(() => { this.#settleInFlight.delete(key); });
    this.#settleInFlight.set(key, promise);
    return promise;
  }

  async #settleWorkspaceOwner(project: string, taskId: string, options: { notify: boolean }): Promise<TaskPairState | undefined> {
    const store = getTaskPairStore();
    const current = store.getPair(project, taskId)?.state;
    const workspace = current?.workspace;
    if (!current || !workspace || workspace.kind !== 'worktree' || workspace.status === 'removed' || !current.executor) return current;
    const backoffKey = `${project}\u0000${taskId}`;
    if ((this.#settleBackoffUntil.get(backoffKey) ?? 0) > Date.now()) return current;
    const result = await rehomeTaskPairWorkspace(current);
    if (result.action === 'deferred') this.#settleBackoffUntil.set(backoffKey, Date.now() + 60_000);
    else if (result.action === 'failed') this.#settleBackoffUntil.set(backoffKey, Date.now() + 5 * 60_000);
    else this.#settleBackoffUntil.delete(backoffKey);
    if (result.action === 'unchanged') return current;
    const latest = store.getPair(project, taskId)?.state;
    if (!latest) return undefined;
    // A newer executor change, or a rebuild, landed while git ran: this result describes a stale pair.
    if (latest.executor !== current.executor || latest.workspace?.path !== workspace.path) return latest;
    const now = Date.now();
    const reportOnce = (kind: string, detail: string): boolean => {
      const reportKey = `${project}\u0000${taskId}\u0000${kind}\u0000${detail}`;
      if (this.#settleReported.has(reportKey)) return false;
      this.#settleReported.add(reportKey);
      return true;
    };
    switch (result.action) {
      case 'moved':
      case 'adopted': {
        const previousPaths = [...new Set([...(latest.workspace.previousPaths ?? []), result.from])];
        // The executor may have branched off the detached start since the workspace was recorded: keep the branch current.
        const branch = result.action === 'moved' ? result.branch : await gitBranchOf(result.to);
        const moved = { ...latest.workspace, path: result.to, previousPaths, movedAt: now, ...(branch ? { branch } : {}) };
        const siblings = await listTaskPairSiblingWorktrees({ ...latest, workspace: moved }).catch(() => [] as string[]);
        const next: TaskPairState = {
          ...latest,
          workspace: { ...moved, ...(siblings.length ? { duplicatePaths: siblings } : { duplicatePaths: undefined }) },
          ...(latest.material ? { material: {
            ...latest.material,
            ...(latest.material.worktree ? { worktree: redirectTaskPairWorkspacePath(moved, latest.material.worktree) } : {}),
            ...(latest.material.path ? { path: redirectTaskPairWorkspacePath(moved, latest.material.path) } : {}),
          } } : {}),
          updatedAt: Math.max(latest.updatedAt, now),
        };
        store.savePair(project, next);
        this.#recordWorkspaceEvent(project, next, result.action === 'moved' ? TASK_PAIR_WORKSPACE_EFFECTS.MOVED : TASK_PAIR_WORKSPACE_EFFECTS.ADOPTED, { from: result.from, to: result.to }, {}, false);
        if (options.notify) {
          const text = buildWorkspaceMovedNotice(next, result.from, result.to, result.action === 'adopted');
          if (next.executor) await sendTaskPairMessage(next.executor, taskId, 'workspace-moved', text);
          if (next.auditor && next.auditor !== TASK_PAIR_NO_AUDITOR) await sendTaskPairMessage(next.auditor, taskId, 'workspace-moved', text);
        }
        if (siblings.length && reportOnce('duplicate', siblings.join('|'))) {
          await sendTaskPairMessage(next.brain, taskId, 'brain-workspace-duplicate', buildWorkspaceDuplicateNotice(next));
        }
        return next;
      }
      case 'duplicate': {
        const already = latest.workspace.duplicatePaths?.includes(result.duplicate);
        if (already) return latest;
        const next: TaskPairState = {
          ...latest,
          workspace: { ...latest.workspace, duplicatePaths: [...new Set([...(latest.workspace.duplicatePaths ?? []), result.duplicate])] },
          updatedAt: Math.max(latest.updatedAt, now),
        };
        store.savePair(project, next);
        this.#recordWorkspaceEvent(project, next, TASK_PAIR_WORKSPACE_EFFECTS.DUPLICATE, { kept: result.kept, duplicate: result.duplicate }, {}, true);
        const text = buildWorkspaceDuplicateNotice(next);
        if (options.notify && next.executor) await sendTaskPairMessage(next.executor, taskId, 'workspace-duplicate', text);
        if (reportOnce('duplicate', result.duplicate)) await sendTaskPairMessage(next.brain, taskId, 'brain-workspace-duplicate', text);
        return next;
      }
      case 'deferred':
        // Not an error: both sides are mid-work. One timeline entry per pair and holder, then quiet retries.
        if (reportOnce('deferred', `${result.reason}:${result.detail}`)) {
          this.#recordWorkspaceEvent(project, latest, TASK_PAIR_WORKSPACE_EFFECTS.MOVE_DEFERRED, { reason: result.reason, detail: result.detail }, {}, false);
        }
        return latest;
      case 'failed':
        if (reportOnce('failed', result.detail)) {
          this.#recordWorkspaceEvent(project, latest, TASK_PAIR_WORKSPACE_EFFECTS.MOVE_FAILED, { detail: result.detail }, {}, true);
          await sendTaskPairMessage(latest.brain, taskId, 'brain-workspace-move-failed', buildWorkspaceMoveFailedLine(latest, result.detail));
        }
        return latest;
    }
  }

  /**
   * The pair's workspace, created once per pair and recorded on it; a reopened
   * pair takes its ended workspace back. Returns the pair as stored afterwards
   * (re-read: markers may have landed while git ran).
   */
  async ensureWorkspace(project: string, taskId: string): Promise<TaskPairState | undefined> {
    const store = getTaskPairStore();
    const current = store.getPair(project, taskId)?.state;
    if (!current || !current.executor || isTerminalTaskPairStatus(current.status)) return current;
    if (current.workspace && current.workspace.status !== 'removed') {
      // The brief that follows an executor change carries the path itself, so
      // the move needs no separate notice here.
      const settled = (await this.settleWorkspaceOwner(project, taskId, { notify: false })) ?? current;
      const existing = settled.workspace;
      if (!existing || existing.status === 'active') return settled;
      const { endedAt: _endedAt, keptReason: _keptReason, strippedAt: _strippedAt, ...workspace } = existing;
      // A reopen starts a fresh retention window; the next terminal transition
      // must not inherit the previous terminal timestamp or keep reason.
      const reopened: TaskPairState = {
        ...settled,
        workspace: { ...workspace, status: 'active', endedAt: undefined, keptReason: undefined, strippedAt: undefined },
      };
      store.savePair(project, reopened);
      return reopened;
    }
    // Before a new worktree is created: make room from finished pairs if the
    // volume is short. Never blocks provisioning for long or fails it.
    await this.checkDiskPressure(Date.now(), { force: true, waitMs: DISK_PREFLIGHT_WAIT_MS }).catch(() => undefined);
    const provision = await provisionTaskPairWorkspace(project, current).catch((error: unknown) => ({
      ok: false as const, detail: error instanceof Error ? error.message : 'workspace provisioning failed',
    }));
    const latest = store.getPair(project, taskId);
    if (!latest) return undefined;
    if (!provision.ok) {
      logger.warn({ taskId, detail: provision.detail }, 'task-pair: executor workspace not created');
      return latest.state;
    }
    const next: TaskPairState = {
      ...latest.state,
      workspace: {
        kind: provision.kind,
        path: provision.path,
        ...(provision.base ? { base: provision.base } : {}),
        ...(provision.branch ? { branch: provision.branch } : {}),
        ...(provision.nonGit ? { nonGit: provision.nonGit } : {}),
        ...(provision.workingDir ? { workingDir: provision.workingDir } : {}),
        createdAt: Date.now(),
        status: 'active',
      },
    };
    store.savePair(project, next);
    if (provision.nonGit) {
      this.#recordWorkspaceEvent(project, next, TASK_PAIR_WORKSPACE_EFFECTS.NON_GIT_MODE, { mode: provision.nonGit.mode, ...(provision.nonGit.fallbackReason ? { reason: provision.nonGit.fallbackReason } : {}) }, {}, false);
      const line = provision.brainNotice ?? buildNonGitModeLine(next, provision.nonGit);
      if (line) await sendTaskPairMessage(next.brain, taskId, 'brain-non-git-mode', line);
    }
    return next;
  }

  /**
   * Repair pass: a started, open pair that has no workspace gets one now, and its
   * participants are told where it is; when it cannot be created, Brain hears
   * about it once. Legacy-imported pairs keep their own worktrees and are left alone.
   */
  async provisionMissingWorkspace(project: string, taskId: string): Promise<void> {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.legacyTaskId || !stored.state.executor || stored.state.workspace) return;
    if (!TASK_PAIR_WORKSPACE_REPAIR_STATUSES.includes(stored.state.status)) return;
    const pair = await this.ensureWorkspace(project, taskId);
    const workspace = pair?.workspace;
    if (pair && workspace) {
      const latest = store.getPair(project, taskId);
      if (latest?.state.workspaceRecoveryEscalatedAt) store.savePair(project, { ...latest.state, workspaceRecoveryEscalatedAt: undefined, updatedAt: Date.now() });
      this.#recordWorkspaceEvent(project, pair, TASK_PAIR_WORKSPACE_EFFECTS.PROVISIONED_LATE, { path: workspace.path, kind: workspace.kind }, {}, true);
      const notice = `${pair.taskId} had no workspace when it started. Its workspace is now ready at ${workspace.path}. Work and commit there; if you began elsewhere, move that work into it.`;
      if (pair.executor) await sendTaskPairMessage(pair.executor, pair.taskId, 'workspace-provisioned', notice);
      if (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) await sendTaskPairMessage(pair.auditor, pair.taskId, 'workspace-provisioned', notice);
      return;
    }
    const latest = store.getPair(project, taskId);
    if (!latest || latest.state.workspace || latest.state.workspaceRecoveryEscalatedAt) return;
    const result = await sendTaskPairMessage(latest.state.brain, taskId, 'brain-workspace-unprovisioned', `${taskId} is ${latest.state.status} but has no workspace and the daemon could not create one. Check the project directory and disk space, or provide a workspace; this notice is sent once.`);
    if (result === 'sent' || result === 'queued' || result === 'skipped_pending') {
      const current = store.getPair(project, taskId);
      if (current) store.savePair(project, { ...current.state, workspaceRecoveryEscalatedAt: Date.now(), updatedAt: Date.now() });
    }
  }

  /**
   * The pair ended: its workspace starts the retention period (the sweep
   * removes it later), and a deliverable named on DONE is copied into the
   * project directory and shown to the user.
   */
  async endWorkspace(project: string, taskId: string, now: number): Promise<void> {
    await this.#endWorkspaceRetention(project, taskId, now);
    // A non-git project's pair brings its work into the project first (git_init: merge; cow: checked copy-back).
    await this.finishNonGitWorkspace(project, taskId);
    // After the deliverable copy: an `output=` path may live inside a directory
    // that is about to be stripped.
    await this.#stripClosedWorkspace(project, taskId);
  }

  async #endWorkspaceRetention(project: string, taskId: string, now: number): Promise<void> {
    const store = getTaskPairStore();
    const pair = store.getPair(project, taskId)?.state;
    // Ending is scheduled after the marker is persisted.  A Brain can reopen
    // the pair before this asynchronous continuation runs; never apply the
    // old terminal transition to that new open state.
    if (!pair || !isTerminalTaskPairStatus(pair.status) || pair.updatedAt !== now) return;
    try {
      let next = pair;
      if (pair.workspace && pair.workspace.status !== 'removed') {
        next = { ...pair, workspace: { ...pair.workspace, status: 'ended', endedAt: now } };
        store.savePair(project, next);
      }
      if (next.status !== 'done' || !next.output) return;
      const beforeCopy = store.getPair(project, taskId)?.state;
      if (!beforeCopy || !isTerminalTaskPairStatus(beforeCopy.status)
        || beforeCopy.updatedAt !== now || beforeCopy.workspace?.endedAt !== now) return;
      const copied = await copyTaskPairOutput(next);
      // Reopening can happen while the copy is in flight.  Do not publish a
      // stale workspace event or notify Brain for a newer pair generation.
      const latest = store.getPair(project, taskId)?.state;
      if (!latest || !isTerminalTaskPairStatus(latest.status)
        || latest.updatedAt !== now || latest.workspace?.endedAt !== now) return;
      const effect = copied.ok ? TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED : TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED;
      this.#recordWorkspaceEvent(project, latest, effect, {
        output: next.output.path,
        ...(copied.ok ? { dest: copied.dest } : { reason: copied.reason }),
      }, copied.ok ? { outputPath: copied.dest } : { outputError: copied.reason }, !copied.ok);
      if (!copied.ok) await sendTaskPairMessage(latest.brain, taskId, 'brain-output-failed', buildOutputFailedLine(latest, copied.reason));
    } catch (error) {
      logger.warn({ err: error, taskId }, 'task-pair: ending the workspace failed');
    }
  }

  #nonGitLocks = new Map<string, Promise<unknown>>();

  #withNonGitLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#nonGitLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#nonGitLocks.set(key, next);
    void next.finally(() => { if (this.#nonGitLocks.get(key) === next) this.#nonGitLocks.delete(key); }).catch(() => undefined);
    return next;
  }

  /**
   * DONE on a non-git project's pair: bring its work into the project. git_init: merge the pair branch into the project's
   * branch (refusing files with uncommitted user edits). cow: copy the changed files back (refusing files the project changed
   * since the clone; overwritten files backed up). in_place: nothing to do (the edits are already there). Idempotent and
   * retried by the hourly sweep while it is refused; Brain is told each time the outcome changes, never on a repeat.
   */
  async finishNonGitWorkspace(project: string, taskId: string): Promise<void> {
    const store = getTaskPairStore();
    const pair = store.getPair(project, taskId)?.state;
    const workspace = pair?.workspace;
    const nonGit = workspace?.nonGit;
    if (!pair || !workspace || !nonGit || pair.status !== 'done' || (nonGit.mode !== 'git_init' && nonGit.mode !== 'cow') || workspace.status === 'removed') return;
    const previous = nonGit.applyBack?.status;
    if (previous === 'applied' || previous === 'noop' || previous === 'undone') return;
    await this.#withNonGitLock(`${nonGit.mode}:${nonGit.projectRoot}`, async () => {
      const again = store.getPair(project, taskId)?.state;
      if (!again?.workspace?.nonGit || again.status !== 'done') return;
      const before = again.workspace.nonGit.applyBack;
      if (before && (before.status === 'applied' || before.status === 'noop' || before.status === 'undone')) return;
      this.#saveApplyBack(project, taskId, { status: 'applying', at: Date.now() });
      let outcome: { status: 'applied' | 'noop' | 'conflict' | 'failed'; files: string[]; detail?: string };
      try {
        if (nonGit.mode === 'git_init') {
          const merged = await mergePairIntoProject(nonGit.projectRoot, workspace.path, taskId);
          outcome = merged.status === 'merged' ? { status: 'applied', files: merged.files, detail: merged.fastForward ? 'fast-forward' : 'merge commit' }
            : merged.status === 'noop' ? { status: 'noop', files: [], detail: merged.detail }
              : merged.status === 'failed' ? { status: 'failed', files: [], detail: merged.detail }
                : { status: 'conflict', files: merged.files, detail: merged.detail };
        } else {
          // An apply that a restart cut short is rolled back first; then it runs again from the exact pre-apply state.
          if (await hasUnfinishedApplyBack(workspace.path)) await rollbackApplyBack(workspace.path);
          const applied = await applyBackCow(workspace.path);
          outcome = applied.status === 'applied' ? { status: 'applied', files: applied.files, ...(applied.deleted.length ? { detail: `${applied.deleted.length} deleted` } : {}) }
            : applied.status === 'noop' ? { status: 'noop', files: [] }
              : applied.status === 'conflict' ? { status: 'conflict', files: applied.conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`) }
                : { status: 'failed', files: applied.files, detail: `${applied.detail}${applied.rolledBack ? ' (rolled back)' : ' (rollback incomplete)'}` };
        }
      } catch (error) {
        outcome = { status: 'failed', files: [], detail: error instanceof Error ? error.message : 'unexpected error' };
      }
      const repeat = before?.status === outcome.status && (before.files ?? []).join('\n') === outcome.files.join('\n');
      this.#saveApplyBack(project, taskId, { status: outcome.status, files: outcome.files, at: Date.now() });
      if (repeat && outcome.status !== 'applied') return; // a refused merge retried by the sweep: no second notice for the same thing
      const latest = store.getPair(project, taskId)?.state;
      if (!latest) return;
      const effect = outcome.status === 'applied' ? TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_APPLIED
        : outcome.status === 'noop' ? TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_NOOP
          : outcome.status === 'conflict' ? TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_CONFLICT : TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_FAILED;
      this.#recordWorkspaceEvent(project, latest, effect, { mode: nonGit.mode, files: String(outcome.files.length) }, {}, outcome.status === 'conflict' || outcome.status === 'failed');
      await sendTaskPairMessage(latest.brain, taskId, 'brain-non-git-finish', buildNonGitFinishLine(latest, nonGit.mode === 'git_init' ? 'git_init' : 'cow', outcome));
    });
  }

  #saveApplyBack(project: string, taskId: string, applyBack: NonNullable<NonNullable<TaskPairState['workspace']>['nonGit']>['applyBack']): void {
    const store = getTaskPairStore();
    const latest = store.getPair(project, taskId)?.state;
    if (!latest?.workspace?.nonGit) return;
    store.savePair(project, { ...latest, workspace: { ...latest.workspace, nonGit: { ...latest.workspace.nonGit, applyBack } } });
  }

  /** Undo a copy-back from its backup (cow only: a git_init merge is undone with git). Files the user changed since are left alone. */
  async undoNonGitApply(project: string, taskId: string): Promise<{ ok: boolean; detail: string; skipped?: string[] }> {
    const store = getTaskPairStore();
    const pair = store.getPair(project, taskId)?.state;
    const nonGit = pair?.workspace?.nonGit;
    if (!pair?.workspace || !nonGit || nonGit.mode !== 'cow') return { ok: false, detail: 'only a COW workspace has a backup to undo from (a merged git_init pair is undone with git revert)' };
    if (nonGit.applyBack?.status !== 'applied') return { ok: false, detail: `nothing to undo (apply-back status ${nonGit.applyBack?.status ?? 'none'})` };
    const result = await this.#withNonGitLock(`cow:${nonGit.projectRoot}`, () => undoApplyBack(pair.workspace!.path));
    this.#saveApplyBack(project, taskId, { status: 'undone', files: result.restored.concat(result.removed), at: Date.now() });
    const latest = store.getPair(project, taskId)?.state ?? pair;
    this.#recordWorkspaceEvent(project, latest, TASK_PAIR_WORKSPACE_EFFECTS.APPLY_BACK_UNDONE, { restored: String(result.restored.length), removed: String(result.removed.length) }, {}, result.skipped.length > 0);
    return { ok: result.ok, detail: `restored ${result.restored.length}, removed ${result.removed.length}${result.skipped.length ? `, left alone ${result.skipped.length} (changed since)` : ''}`, skipped: result.skipped.map((entry) => entry.path) };
  }

  /** After a restart (and hourly): finish or retry the copy-back / merge of every finished non-git pair that has not landed. */
  async #resumeNonGitFinishes(): Promise<void> {
    const store = getTaskPairStore();
    for (const stored of store.listEndedWorkspacePairs()) {
      const nonGit = stored.state.workspace?.nonGit;
      if (!nonGit || (nonGit.mode !== 'git_init' && nonGit.mode !== 'cow') || stored.state.status !== 'done') continue;
      const status = nonGit.applyBack?.status;
      if (status === 'applied' || status === 'noop' || status === 'undone') continue;
      await this.finishNonGitWorkspace(stored.project, stored.state.taskId);
    }
  }

  #lastSweepAt = 0;

  /** The retention event itself, so a restart cannot re-arm a delivered notice and a later pair/retention event cannot inherit its suppression. */
  #workspaceKeptKey(pair: TaskPairState, reason: string): string {
    const workspace = pair.workspace!;
    return `${workspace.path}\u0000${workspace.endedAt ?? pair.updatedAt}\u0000${reason}\u0000${TASK_PAIR_WORKSPACE_KEPT_NOTICE_VERSION}`;
  }

  /** Has this kept workspace still to be announced (never delivered, attempts left, retry interval over)? */
  #workspaceKeptNoticeDue(project: string, pair: TaskPairState, now: number, reason: string): boolean {
    if (!pair.workspace) return false;
    const current = getTaskPairStore().getPair(project, pair.taskId);
    if (!current) return false;
    const previous = current.liveness;
    const same = previous.workspaceKeptReminderKey === this.#workspaceKeptKey(pair, reason);
    if (same && previous.workspaceKeptReminderDeliveredAt !== undefined) return false;
    if ((same ? (previous.workspaceKeptReminderCount ?? 0) : 0) >= TASK_PAIR_WORKSPACE_KEPT_REMINDER_MAX_ATTEMPTS) return false;
    return !(same && previous.workspaceKeptReminderLastAt !== undefined
      && now - previous.workspaceKeptReminderLastAt < TASK_PAIR_WORKSPACE_KEPT_REMINDER_RETRY_MS);
  }

  /**
   * Deliver one retained-workspace notice, with bounded retry when the Brain was offline/unreadable. What to do with
   * the workspace is Brain's judgement for this task: the message carries what it needs and lists the options.
   */
  async #notifyWorkspaceKept(project: string, pair: TaskPairState, now: number, reason: string): Promise<void> {
    if (!this.#workspaceKeptNoticeDue(project, pair, now, reason)) return;
    const store = getTaskPairStore();
    const previous = store.getPair(project, pair.taskId)!.liveness;
    const key = this.#workspaceKeptKey(pair, reason);
    const same = previous.workspaceKeptReminderKey === key;
    const count = same ? (previous.workspaceKeptReminderCount ?? 0) : 0;
    const detail = await describeKeptTaskPairWorkspace(pair).catch(() => ({}));
    const result = await sendTaskPairMessage(pair.brain, pair.taskId, TASK_PAIR_WORKSPACE_KEPT_REASON, buildWorkspaceKeptLine(pair, reason, { now, ...detail }));
    const delivered = result === 'sent' || result === 'queued' || result === 'skipped_pending';
    store.saveLiveness(project, pair.taskId, {
      ...store.getPair(project, pair.taskId)?.liveness ?? previous,
      workspaceKeptReminderKey: key,
      workspaceKeptReminderCount: count + 1,
      workspaceKeptReminderLastAt: now,
      ...(delivered ? { workspaceKeptReminderDeliveredAt: now } : { workspaceKeptReminderDeliveredAt: undefined }),
    });
  }

  /**
   * Announce the workspaces this sweep kept, without flooding Brain. Each is a decision for Brain, so each keeps its
   * own message -- but a sweep sends a Brain at most MAX_PER_SWEEP of them, and none while MAX_OUTSTANDING announced
   * ones are still open (a Brain that has not acted on those is not given more). The rest wait for later sweeps and
   * are summarised in one message, at most once a day.
   */
  async #announceKeptWorkspaces(kept: ReadonlyArray<{ project: string; pair: TaskPairState; reason: string }>, now: number): Promise<void> {
    if (kept.length === 0) return;
    const store = getTaskPairStore();
    const groups = new Map<string, { project: string; brain: string; items: Array<{ pair: TaskPairState; reason: string }> }>();
    for (const entry of kept) {
      if (!this.#workspaceKeptNoticeDue(entry.project, entry.pair, now, entry.reason)) continue;
      const key = `${entry.project}\u0000${entry.pair.brain}`;
      const group = groups.get(key) ?? { project: entry.project, brain: entry.pair.brain, items: [] };
      group.items.push({ pair: entry.pair, reason: entry.reason });
      groups.set(key, group);
    }
    const endedAt = (pair: TaskPairState): number => pair.workspace?.endedAt ?? pair.updatedAt;
    for (const group of groups.values()) {
      const open = store.listEndedWorkspacePairs().filter((stored) => {
        const workspace = stored.state.workspace;
        return stored.project === group.project && stored.state.brain === group.brain && workspace?.status === 'kept'
          && stored.liveness.workspaceKeptReminderDeliveredAt !== undefined
          && stored.liveness.workspaceKeptReminderKey?.endsWith(`\u0000${TASK_PAIR_WORKSPACE_KEPT_NOTICE_VERSION}`) === true;
      });
      const allowance = Math.max(0, Math.min(TASK_PAIR_WORKSPACE_KEPT_MAX_PER_SWEEP, TASK_PAIR_WORKSPACE_KEPT_MAX_OUTSTANDING - open.length));
      const due = group.items.sort((a, b) => endedAt(a.pair) - endedAt(b.pair));
      for (const item of due.slice(0, allowance)) await this.#notifyWorkspaceKept(group.project, item.pair, now, item.reason);
      const deferred = due.slice(allowance);
      if (deferred.length === 0) continue;
      const metaKey = taskPairWorkspaceKeptDigestMetaKey(group.project, group.brain);
      const last = Number(store.getMeta(metaKey));
      if (Number.isFinite(last) && last > 0 && now - last < TASK_PAIR_WORKSPACE_KEPT_DIGEST_INTERVAL_MS) continue;
      const result = await sendTaskPairMessage(group.brain, TASK_PAIR_WORKSPACE_KEPT_DIGEST_TASK_ID, TASK_PAIR_WORKSPACE_KEPT_DIGEST_REASON, buildWorkspaceKeptDigestLine({
        deferred: deferred.map((item) => ({
          taskId: item.pair.taskId, title: item.pair.title, reason: item.reason, endedDays: Math.max(0, Math.floor((now - endedAt(item.pair)) / (24 * 60 * 60_000))),
        })),
        announcedOpen: open.map((stored) => ({ taskId: stored.state.taskId, title: stored.state.title })),
        maxListed: TASK_PAIR_WORKSPACE_KEPT_DIGEST_MAX_LISTED,
      }));
      if (result === 'sent' || result === 'queued' || result === 'skipped_pending') store.setMeta(metaKey, String(now));
    }
  }

  /**
   * Remove the workspaces of pairs that ended at least the retention period
   * ago. A worktree that still holds unsaved work is kept (Brain is told once)
   * and retried on later sweeps. Runs at most hourly unless forced.
   */
  async sweepWorkspaces(now: number, options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && now - this.#lastSweepAt < 60 * 60_000) return;
    this.#lastSweepAt = now;
    const store = getTaskPairStore();
    this.#track(this.#resumeNonGitFinishes().catch((error: unknown) => logger.warn({ err: error }, 'task-pair: non-git finish retry failed')));
    // Pairs that ended before stripping existed, or whose strip failed or was
    // interrupted by a restart, are stripped now -- in the background: a
    // backlog of large trees must not hold the heartbeat.
    this.#stripBacklogInBackground();
    const keptThisSweep: Array<{ project: string; pair: TaskPairState; reason: string }> = [];
    for (const stored of store.listEndedWorkspacePairs()) {
      const pair = stored.state;
      const workspace = pair.workspace;
      if (!workspace || !isTerminalTaskPairStatus(pair.status)) continue;
      if (now - (workspace.endedAt ?? pair.updatedAt) < TASK_PAIR_WORKSPACE_RETENTION_MS) continue;
      try {
        const releaseDeps = {
          beforeRemove: () => {
            const current = store.getPair(stored.project, pair.taskId)?.state;
            return Boolean(current?.workspace
              && (current.workspace.status === 'ended' || current.workspace.status === 'kept')
              && isTerminalTaskPairStatus(current.status)
              && current.workspace.endedAt === workspace.endedAt
              && now - (current.workspace.endedAt ?? current.updatedAt) >= TASK_PAIR_WORKSPACE_RETENTION_MS);
          },
        };
        const released = await releaseTaskPairWorkspace(pair, releaseDeps);
        if (released.action === 'absent' || released.action === 'skipped') continue;
        const latest = store.getPair(stored.project, pair.taskId)?.state ?? pair;
        if (!latest.workspace || !isTerminalTaskPairStatus(latest.status)) continue;
        const firstKeep = released.action === 'kept' && latest.workspace.status !== 'kept';
        const next: TaskPairState = {
          ...latest,
          workspace: released.action === 'kept'
            ? { ...latest.workspace, status: 'kept', keptReason: released.reason }
            : { ...latest.workspace, status: 'removed' },
        };
        store.savePair(stored.project, next);
        if (released.action === 'removed') {
          this.#recordWorkspaceEvent(stored.project, next, TASK_PAIR_WORKSPACE_EFFECTS.REMOVED, { path: workspace.path }, {}, false);
        } else if (firstKeep) {
          this.#recordWorkspaceEvent(stored.project, next, TASK_PAIR_WORKSPACE_EFFECTS.KEPT, { path: workspace.path, reason: released.reason }, {}, true);
          // The worktree GC backstop removes it too once the work is saved.
          const { getSupervisionTaskRegistry } = await import('../supervision-state-store.js');
          getSupervisionTaskRegistry().requestWorktreeGc(stored.project);
        }
        if (released.action === 'kept') keptThisSweep.push({ project: stored.project, pair: next, reason: released.reason });
      } catch (error) {
        logger.warn({ err: error, taskId: pair.taskId }, 'task-pair: workspace sweep failed');
      }
    }
    try {
      await this.#announceKeptWorkspaces(keptThisSweep, now);
    } catch (error) {
      logger.warn({ err: error }, 'task-pair: kept-workspace announcement failed');
    }
  }

  /**
   * A definite "head is not a descendant of the round base": besides
   * withholding the audit relay, hold PASS on the pair itself (persisted, so a
   * restart keeps it) until a fresh READY replaces the material. A separate
   * state field rather than clearing pair.material: the "no material -> no
   * verdict" rule would also block the auditor's REWORK, which must stay
   * possible, and a new pair flag would have to be threaded through every
   * flag enumeration. Re-read first: a newer READY may already have replaced
   * the material while git was running.
   */
  #holdMaterialOutsideBase(project: string, pair: TaskPairState, head: string, base: string): void {
    const store = getTaskPairStore();
    const latest = store.getPair(project, pair.taskId)?.state;
    if (!latest || latest.status !== 'in_audit' || latest.materialHold) return;
    if (!latest.material?.head || !sameTaskPairCommit(latest.material.head, head)) return;
    const at = Date.now();
    const next: TaskPairState = { ...latest, materialHold: { reason: 'round_base_not_ancestor', head, base, at }, updatedAt: at };
    store.savePair(project, next);
    const eventId = `material:${pair.taskId}:${TASK_PAIR_MATERIAL_HELD_EFFECT}:${at}`;
    store.recordEvent({
      id: eventId, project, taskId: pair.taskId, writer: 'daemon', role: 'daemon', verb: TASK_PAIR_MATERIAL_EVENT_VERB,
      attrs: { head, base }, effect: TASK_PAIR_MATERIAL_HELD_EFFECT, unusual: true, source: 'heartbeat', fromStatus: next.status, toStatus: next.status, at,
    });
    emitTaskPairDaemonEvent(next, {
      eventId, verb: TASK_PAIR_MATERIAL_EVENT_VERB, effect: TASK_PAIR_MATERIAL_HELD_EFFECT, source: 'heartbeat', fromStatus: next.status, toStatus: next.status, unusual: true,
    });
  }

  #stripBacklogRun?: Promise<void>;

  #stripBacklogInBackground(): void {
    if (this.#stripBacklogRun) return;
    const run = (async () => {
      const store = getTaskPairStore();
      for (const stored of store.listEndedWorkspacePairs()) {
        if (stored.state.workspace?.strippedAt !== undefined) continue;
        await this.#stripClosedWorkspace(stored.project, stored.state.taskId);
      }
    })().catch((error: unknown) => logger.warn({ err: error }, 'task-pair: workspace strip backlog failed'))
      .finally(() => { if (this.#stripBacklogRun === run) this.#stripBacklogRun = undefined; });
    this.#stripBacklogRun = run;
    this.#track(run);
  }

  /**
   * A finished pair's rebuildable, git-ignored heavy directories go at once
   * (node_modules, build outputs); its commits, tracked files and uncommitted
   * work stay for the retention sweep to judge. Returns true when it stripped.
   * An open or reopened pair is never touched: eligibility is re-read before
   * every directory.
   */
  async #stripClosedWorkspace(project: string, taskId: string): Promise<boolean> {
    const store = getTaskPairStore();
    const pair = store.getPair(project, taskId)?.state;
    const workspace = pair?.workspace;
    if (!pair || !workspace || (workspace.kind !== 'worktree' && workspace.kind !== 'dir') || !isTerminalTaskPairStatus(pair.status)) return false;
    if (workspace.status !== 'ended' && workspace.status !== 'kept') return false;
    if (workspace.strippedAt !== undefined) return false;
    const endedAt = workspace.endedAt;
    const stillEligible = (): boolean => {
      const current = store.getPair(project, taskId)?.state;
      return Boolean(current?.workspace
        && isTerminalTaskPairStatus(current.status)
        && (current.workspace.status === 'ended' || current.workspace.status === 'kept')
        && current.workspace.endedAt === endedAt
        && current.workspace.strippedAt === undefined);
    };
    try {
      const deps = taskPairHygieneDeps();
      const output = pair.output?.path;
      const keepPaths = [...(deps.keepPaths ?? []), ...(output ? [isAbsolute(output) ? output : resolvePath(workspace.path, output)] : [])];
      // A git worktree strips what git reports as ignored; a plain task directory has no ignore list, so only directories
      // named in the shared heavy list go, never a file.
      const result = workspace.kind === 'dir'
        ? await stripHeavyNamedDirs(workspace.path, { remove: deps.remove, stillEligible, keepPaths })
        : await stripHeavyIgnoredDirs(workspace.path, { ...deps, stillEligible, keepPaths });
      // Unreadable git state: leave it unstripped so a later sweep retries.
      // A directory that could not be removed leaves the pair unstripped, so the next sweep retries it.
      if (!result.ok || result.aborted || result.skipped.some((entry) => entry.reason === 'error') || !stillEligible()) return false;
      const latest = store.getPair(project, taskId)?.state;
      if (!latest?.workspace) return false;
      store.savePair(project, { ...latest, workspace: { ...latest.workspace, strippedAt: Date.now() } });
      if (result.removed.length > 0) logger.info({ taskId, removed: result.removed.length }, 'task-pair: stripped finished workspace');
      return true;
    } catch (error) {
      logger.warn({ err: error, taskId }, 'task-pair: workspace strip failed');
      return false;
    }
  }

  #diskRun?: Promise<void>;
  #lastDiskCheckAt = 0;

  /**
   * Free-space guard for the worktree volume. Below the low threshold, finished
   * pairs are stripped oldest first until it recovers; Brain hears one message
   * per threshold crossing (not per heartbeat). Open pairs are never touched.
   * `waitMs` bounds how long the caller waits for the reclaim (0: not at all).
   */
  async checkDiskPressure(now: number, options: { force?: boolean; waitMs?: number } = {}): Promise<void> {
    const waitMs = options.waitMs ?? 0;
    const wait = async (run: Promise<void>): Promise<void> => {
      if (waitMs <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    };
    if (this.#diskRun) return wait(this.#diskRun);
    if (!options.force && now - this.#lastDiskCheckAt < DISK_CHECK_INTERVAL_MS) return;
    this.#lastDiskCheckAt = now;
    const run = this.#runDiskCheck()
      .catch((error: unknown) => logger.warn({ err: error }, 'task-pair: disk check failed'))
      .finally(() => { if (this.#diskRun === run) this.#diskRun = undefined; });
    this.#diskRun = run;
    this.#track(run);
    return wait(run);
  }

  async #runDiskCheck(): Promise<void> {
    const store = getTaskPairStore();
    const deps = taskPairHygieneDeps();
    const root = deps.worktreesRoot ?? resolveSupervisionWorktreesRoot(process.env);
    const before = await readWorktreeVolumeSpace(root, deps);
    if (!before) return;
    const storedLevel = store.getMeta(TASK_PAIR_DISK_LEVEL_META_KEY);
    const announced: TaskPairDiskLevel = isDiskLevel(storedLevel) ? storedLevel : 'ok';
    const level = classifyDiskLevel(before, announced);
    if (level === 'ok') {
      if (announced !== 'ok') store.setMeta(TASK_PAIR_DISK_LEVEL_META_KEY, 'ok');
      return;
    }
    // Finished pairs only, oldest first. Their eligibility is re-checked per directory.
    const closed = store.listEndedWorkspacePairs()
      .filter((stored) => (stored.state.workspace?.kind === 'worktree' || stored.state.workspace?.kind === 'dir') && stored.state.workspace.strippedAt === undefined)
      .sort((a, b) => (a.state.workspace?.endedAt ?? a.state.updatedAt) - (b.state.workspace?.endedAt ?? b.state.updatedAt));
    let after = before;
    const strippedBrains = new Set<string>();
    let strippedPairs = 0;
    for (const stored of closed) {
      if (await this.#stripClosedWorkspace(stored.project, stored.state.taskId)) {
        strippedPairs += 1;
        strippedBrains.add(stored.state.brain);
      }
      const reading = await readWorktreeVolumeSpace(root, deps);
      if (reading) after = reading;
      if (classifyDiskLevel(after, level) === 'ok') break;
    }
    const settled = classifyDiskLevel(after, level);
    // Persist before announcing: a failed send must not repeat next heartbeat.
    store.setMeta(TASK_PAIR_DISK_LEVEL_META_KEY, settled);
    if (diskLevelRank(level) <= diskLevelRank(announced)) return;
    const brains = new Set<string>();
    for (const stored of store.listActivePairs()) if (isPairsEngineProject(stored.project)) brains.add(stored.state.brain);
    if (brains.size === 0) for (const brain of strippedBrains) brains.add(brain);
    const text = buildDiskPressureMessage({
      level, freeBeforeBytes: before.freeBytes, freeAfterBytes: after.freeBytes, totalBytes: before.totalBytes, strippedPairs,
    });
    for (const brain of brains) {
      await sendTaskPairMessage(brain, TASK_PAIR_DISK_NOTICE_TASK_ID, 'brain-disk-pressure', text);
    }
  }

  #recordWorkspaceEvent(
    project: string,
    pair: TaskPairState,
    effect: string,
    attrs: Record<string, string>,
    payload: Pick<TaskPairEventPayload, 'outputPath' | 'outputError'>,
    unusual: boolean,
  ): void {
    const at = Date.now();
    const eventId = `workspace:${pair.taskId}:${effect}:${at}`;
    getTaskPairStore().recordEvent({
      id: eventId, project, taskId: pair.taskId, writer: 'daemon', role: 'daemon', verb: TASK_PAIR_WORKSPACE_EVENT_VERB,
      attrs, effect, unusual, source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, at,
    });
    emitTaskPairDaemonEvent(pair, {
      eventId, verb: TASK_PAIR_WORKSPACE_EVENT_VERB, effect, source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, unusual, ...payload,
    });
  }

  /** Tell a pair's executor and auditor what the pair is and where the work lives. */
  async briefParticipants(project: string, taskId: string): Promise<void> {
    await this.briefParticipantsWithReceipts(project, taskId);
  }

  /** Deliver the canonical pair briefs and expose per-participant outcomes to
   * structured callers. Existing marker/scheduler callers continue to use the
   * void wrapper above. */
  async briefParticipantsWithReceipts(
    project: string,
    taskId: string,
    roles?: ReadonlySet<TaskPairBriefDelivery['role']>,
  ): Promise<TaskPairBriefDelivery[]> {
    const deliveries: TaskPairBriefDelivery[] = [];
    try {
      const pair = await this.ensureWorkspace(project, taskId);
      if (!pair) return deliveries;
      if (pair.executor && (!roles || roles.has('executor'))) {
        const status = await sendTaskPairMessage(pair.executor, pair.taskId, 'pair-brief', buildExecutorPairBrief(pair));
        deliveries.push({ role: 'executor', target: pair.executor, status });
      }
      if (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR && (!roles || roles.has('auditor'))) {
        const status = await sendTaskPairMessage(pair.auditor, pair.taskId, 'auditor-assigned', buildAuditorAssignmentMessage(pair));
        deliveries.push({ role: 'auditor', target: pair.auditor, status });
      }
    } catch (error) {
      logger.warn({ err: error, taskId }, 'task-pair: participant brief failed');
      const state = getTaskPairStore().getPair(project, taskId)?.state;
      if (state?.executor) deliveries.push({ role: 'executor', target: state.executor, status: 'failed' });
      if (state?.auditor && state.auditor !== TASK_PAIR_NO_AUDITOR) deliveries.push({ role: 'auditor', target: state.auditor, status: 'failed' });
    }
    return deliveries;
  }

  /**
   * Enforce the title invariant at every pair entry point. The placeholder is
   * saved synchronously so the task panel never falls back to a raw id. The
   * daemon asks the project's Brain for the title; it never calls a provider
   * itself and never delays dispatch.
   */
  ensureTaskPairTitle(
    project: string,
    taskId: string,
    sourceText: string | undefined,
    _creator?: string,
    options: { mechanicalTitle?: boolean; emitEvent?: boolean } = {},
  ): void {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored) return;
    const source = sourceText?.trim() || `Supervised task ${taskId}`;
    if (isUsableTaskPairTitle(stored.state.title, taskId, source, options.mechanicalTitle === true)) return;
    const locale = brainUiLocale(project);
    const placeholder = locale
      ? taskPairTitlePlaceholder(locale)
      : TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[1];
    let pair = stored.state;
    if (pair.title !== placeholder) {
      pair = { ...pair, title: placeholder, updatedAt: Date.now() };
      store.savePair(project, pair);
      if (options.emitEvent !== false) this.#recordTitleEvent(project, pair, 'title_placeholder');
    }
    // A Brain request must be authored in the owner's UI language.  When the
    // locale has not arrived yet, persist the pending id but wait for the
    // later backfill pass rather than sending an English/unknown-language
    // request.
    if (locale) this.#queueTitleRequest(project, pair.brain, pair.taskId, locale);
  }

  #titleMetaKey(brain: string): string {
    return `task_pair_title_request:${brain}`;
  }

  #readTitleRequest(brain: string): { pending: string[]; lastAttemptAt?: number } {
    const raw = getTaskPairStore().getMeta(this.#titleMetaKey(brain));
    if (!raw) return { pending: [] };
    try {
      const parsed = JSON.parse(raw) as { pending?: unknown; lastAttemptAt?: unknown };
      return {
        pending: Array.isArray(parsed.pending) ? parsed.pending.map(String).filter(Boolean) : [],
        ...(Number.isFinite(Number(parsed.lastAttemptAt)) ? { lastAttemptAt: Number(parsed.lastAttemptAt) } : {}),
      };
    } catch {
      return { pending: [] };
    }
  }

  #writeTitleRequest(brain: string, state: { pending: string[]; lastAttemptAt?: number }): void {
    getTaskPairStore().setMeta(this.#titleMetaKey(brain), JSON.stringify(state));
  }

  #clearTitleRequest(brain: string, taskId: string): void {
    const state = this.#readTitleRequest(brain);
    if (!state.pending.includes(taskId)) return;
    state.pending = state.pending.filter((id) => id !== taskId);
    this.#writeTitleRequest(brain, state);
  }

  #queueTitleRequest(project: string, brain: string, taskId: string, locale?: string): void {
    const state = this.#readTitleRequest(brain);
    if (!state.pending.includes(taskId)) state.pending.push(taskId);
    this.#writeTitleRequest(brain, state);
    const key = `${project}\0${brain}`;
    if (this.#titleRequestFlushes.has(key)) return;
    // Defer one microtask so several markers in the same assistant turn are
    // coalesced into one Brain request instead of racing separate sends.
    const promise = Promise.resolve()
      .then(() => this.#flushTitleRequest(brain, locale))
      .finally(() => this.#titleRequestFlushes.delete(key));
    this.#titleRequestFlushes.set(key, promise);
    this.#track(promise);
  }

  async #flushTitleRequest(brain: string, locale?: string): Promise<void> {
    const record = getSession(brain);
    if (!record || record.state === 'stopped' || record.state === 'error') return;
    const state = this.#readTitleRequest(brain);
    if (state.pending.length === 0) return;
    const now = Date.now();
    if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < TaskPairService.TITLE_REQUEST_RETRY_MS) return;
    state.lastAttemptAt = now;
    this.#writeTitleRequest(brain, state);
    // A pair can become terminal after its title request was queued.  Filter
    // the durable batch at send time as well as at enqueue time so a delayed
    // reminder never asks Brain to revive a cancelled/done pair.
    const activeIds = new Set(getTaskPairStore().listActivePairs()
      .filter((storedPair) => storedPair.state.brain === brain)
      .map((storedPair) => storedPair.state.taskId));
    const pending = state.pending.filter((taskId) => activeIds.has(taskId));
    if (pending.length !== state.pending.length) {
      state.pending = pending;
      this.#writeTitleRequest(brain, state);
    }
    if (pending.length === 0) return;
    const ids = pending.slice(0, 100);
    await sendTaskPairMessage(
      brain,
      'title-request',
      'title-request',
      buildUntitledTaskTitleRequest(ids, locale),
    );
  }

  /** Brain-only title setter used by pair_task_update and title markers. */
  setTaskPairTitle(project: string, taskId: string, title: string, writer: string): StoredTaskPair | undefined {
    const store = getTaskPairStore();
    const stored = store.getPair(project, taskId);
    if (!stored || stored.state.brain !== writer || !isUsableTaskPairTitle(title, taskId)) return undefined;
    const next = { ...stored.state, title: title.trim(), updatedAt: Date.now() };
    store.savePair(project, next);
    this.#recordTitleEvent(project, next, 'title_generated');
    this.#clearTitleRequest(next.brain, taskId);
    return store.getPair(project, taskId);
  }

  #recordTitleEvent(project: string, pair: TaskPairState, effect: 'title_placeholder' | 'title_generated'): void {
    const at = Date.now();
    const eventId = `title:${pair.taskId}:${effect}:${at}`;
    getTaskPairStore().recordEvent({
      id: eventId, project, taskId: pair.taskId, writer: 'daemon', role: 'daemon', verb: TASK_PAIR_TITLE_EVENT_VERB,
      attrs: { title: pair.title ?? '' }, effect, unusual: false,
      source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, at,
    });
    emitTaskPairDaemonEvent(pair, {
      eventId, verb: TASK_PAIR_TITLE_EVENT_VERB, effect,
      source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, unusual: false,
    });
  }

  #backfilledTitleProjects = new Set<string>();

  /** Back-fill missing/mechanical titles once per project per daemon run. */
  backfillTitlesOnce(project: string): void {
    if (this.#backfilledTitleProjects.has(project)) return;
    // Wait for the browser to persist the owner's UI locale; otherwise the
    // neutral placeholder would be latched forever and could not be localized
    // when the first session.send arrives.
    if (!brainUiLocale(project)) return;
    this.#backfilledTitleProjects.add(project);
    for (const stored of getTaskPairStore().listActivePairs(project)) {
      const pair = stored.state;
      if (isUsableTaskPairTitle(pair.title, pair.taskId, pair.brief, true)) continue;
      this.ensureTaskPairTitle(project, pair.taskId, pair.brief ?? pair.title, pair.brain, { mechanicalTitle: true });
    }
  }

  /** Test/diagnostic view of a project's pairs. */
  listPairs(project: string): StoredTaskPair[] {
    return getTaskPairStore().listPairs(project);
  }

  isActive(pair: TaskPairState): boolean {
    return !isTerminalTaskPairStatus(pair.status);
  }
}

/**
 * Project one pair event onto the timelines of the writer and every
 * participant (executor, auditor, Brain), with the pair's current roles.
 */
export function emitTaskPairTimelineEvent(
  base: Omit<TaskPairEventPayload, 'title' | 'executor' | 'auditor' | 'round' | 'deliveryRound' | 'flags' | 'blocking' | 'executorPool' | 'auditorPool'>,
  pair: TaskPairState | undefined,
  eventId: string,
): void {
  const payload: TaskPairEventPayload = {
    ...base,
    ...(pair ? {
      ...(pair.title ? { title: pair.title } : {}),
      ...(pair.executor ? { executor: pair.executor } : {}),
      ...(pair.auditor ? { auditor: pair.auditor } : {}),
      round: pair.round,
      ...(pair.deliveryRound && pair.deliveryRound > 1 ? { deliveryRound: pair.deliveryRound } : {}),
      flags: pair.flags,
      blocking: pair.blocking,
      ...(pair.executorPool ? { executorPool: pair.executorPool } : {}),
      ...(pair.auditorPool ? { auditorPool: pair.auditorPool } : {}),
      ...(pair.executorModel ? { executorModel: pair.executorModel } : {}),
      ...(pair.executorThinking ? { executorThinking: pair.executorThinking } : {}),
      ...(pair.auditor === TASK_PAIR_NO_AUDITOR ? { auditorModel: TASK_PAIR_NO_AUDITOR } : pair.auditorModel ? { auditorModel: pair.auditorModel } : {}),
      ...(pair.auditorThinking ? { auditorThinking: pair.auditorThinking } : {}),
    } : {}),
  };
  for (const [role, session] of [['executor', pair?.executor], ['auditor', pair?.auditor]] as const) {
    if (!session || session === TASK_PAIR_NO_AUDITOR) continue;
    const record = getSession(session);
    if (role === 'executor') {
      if (record?.label) payload.executorLabel = record.label;
      const model = record?.activeModel?.trim() || record?.requestedModel?.trim();
      if (model) payload.executorModel = model;
      if (record?.effort) payload.executorThinking = record.effort;
      if (record?.state) payload.executorState = record.state;
    } else {
      if (record?.label) payload.auditorLabel = record.label;
      const model = record?.activeModel?.trim() || record?.requestedModel?.trim();
      if (model) payload.auditorModel = model;
      if (record?.effort) payload.auditorThinking = record.effort;
      if (record?.state) payload.auditorState = record.state;
    }
  }
  // A pair waiting on Brain: say what became of the last notice to Brain, so
  // the card is not mistaken for a delivery (it only projects the event).
  if (pair?.status === TASK_PAIR_STATUS_AWAITING_BRAIN_DECISION && pair.brain) {
    const owner = getTaskPairStore().pairsForSession(pair.brain).find((stored) => stored.state.taskId === pair.taskId && stored.state.brain === pair.brain);
    const brainNotice = brainNoticeForCard(owner);
    if (brainNotice) payload.brainNotice = brainNotice;
  }
  const targets = new Set<string>(base.writer === 'daemon' ? [] : [base.writer]);
  for (const session of [pair?.executor, pair?.auditor, pair?.brain]) {
    if (session && session !== TASK_PAIR_NO_AUDITOR) targets.add(session);
  }
  for (const session of targets) {
    timelineEmitter.emit(session, TASK_PAIR_TIMELINE_EVENT, payload as unknown as Record<string, unknown>, {
      source: 'daemon', confidence: 'high', eventId: `${TASK_PAIR_TIMELINE_EVENT}:${eventId}:${session}`,
    });
  }
}

/** A daemon-authored pair event (not a marker), e.g. a data correction. */
export function emitTaskPairDaemonEvent(
  pair: TaskPairState,
  event: Pick<TaskPairEventPayload, 'verb' | 'effect' | 'source' | 'fromStatus' | 'toStatus' | 'unusual' | 'outputPath' | 'outputError' | 'checklistAutoTickReason' | 'checklistAutoTickNotice'> & { eventId: string },
): void {
  const { eventId, ...rest } = event;
  emitTaskPairTimelineEvent({ taskId: pair.taskId, writer: 'daemon', role: 'daemon', ...rest }, pair, eventId);
}

export const taskPairService = new TaskPairService();
