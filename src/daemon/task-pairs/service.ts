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
import { SUPERVISION_ID_PREFIXES } from '../../../shared/supervision-durable-identity.js';
import { timelineEmitter } from '../timeline-emitter.js';
import type { TimelineEvent } from '../timeline-event.js';
import logger from '../../util/logger.js';
import {
  TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS,
  TASK_PAIR_INFER_TASK_ID,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_TIMELINE_EVENT,
  TASK_PAIR_TITLE_EVENT_VERB,
  TASK_PAIR_TITLE_GENERATED_EFFECT,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_RETENTION_MS,
  applyTaskPairMarker,
  isTerminalTaskPairStatus,
  mayContainTaskPairMarker,
  scanTaskPairMarkers,
  stripTaskPairMarkersForDisplay,
  taskPairRoleOf,
  type TaskPairEventPayload,
  type TaskPairEventSource,
  type TaskPairIntent,
  type TaskPairMarker,
  type TaskPairState,
  type TaskPairTransition,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { brainUiLocale, isPairsEngineProject, projectBrainSession, projectOfSession } from './engine.js';
import { noteTaskPairFocus, sendTaskPairMessage, taskPairFocusOf } from './delivery.js';
import { resolveTaskPairMaterial } from './material.js';
import { copyTaskPairOutput, provisionTaskPairWorkspace, releaseTaskPairWorkspace, type TaskPairWorkspaceRevisionSource } from './workspace.js';
import { clearTaskPairProviderError, noteTaskPairProviderError } from './provider-errors.js';
import { generateTaskPairTitle } from './title-generator.js';
import { getSession, listSessions } from '../../store/session-store.js';
import { resolveProjectAuthoritativeSupervisionSnapshot } from '../supervision-snapshot.js';
import { resolveSupervisionAuditBlockingSeverities } from '../../../shared/supervision-config.js';
import {
  buildAuditRequestMessage,
  buildAuditorAssignmentMessage,
  buildExecutorPairBrief,
  buildOutputFailedLine,
  buildWorkspaceKeptLine,
  buildBrainNoticeMessage,
  buildCorrectionMessage,
  buildDoneReminderMessage,
  buildNoAuditorDoneNotice,
  buildPassDoneNoticeMessage,
  buildReworkNoticeMessage,
} from './messages.js';

/** Intents that need the pool, the heartbeat or the queue (see scheduler.ts). */
export interface TaskPairScheduler {
  onIntent(project: string, pair: TaskPairState, intent: TaskPairIntent): void | Promise<void>;
  /** Drain a Brain's queue after a capacity setting changes. */
  runQueue?(project: string, brain: string): void | Promise<void>;
  /** A consistent PASS was applied (economy-review bookkeeping). */
  flagEconomyUnreviewed?(project: string, taskId: string): void;
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

const WORKSPACE_REVISION_SOURCE_LABEL: Record<TaskPairWorkspaceRevisionSource, string> = {
  branch: 'its own branch',
  lastHead: 'the last observed head',
  materialHead: "the material relay's head",
  base: 'the recorded base',
  default: "the project's default branch",
  directory: 'a fresh task directory',
};

export async function ensureTaskPairWorkspaceAvailable(project: string, taskId: string): Promise<void> {
  const store = getTaskPairStore();
  const stored = store.getPair(project, taskId);
  if (!stored || !stored.state.executor || !stored.state.workspace) return;
  const workspace = stored.state.workspace;
  const present = await stat(workspace.path).then(() => true).catch(() => false);
  if (present) return;
  const provision = await provisionTaskPairWorkspace(project, stored.state).catch(() => ({ ok: false as const, detail: 'workspace rebuild failed' }));
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
  const rebuilt = { kind: provision.kind, path: provision.path, ...(provision.base ? { base: provision.base } : {}), ...(provision.branch ? { branch: provision.branch } : {}), createdAt: now, status: 'active' as const };
  const next = { ...stored.state, workspace: rebuilt, workspaceRecoveryEscalatedAt: undefined, updatedAt: now };
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
    // Re-read: resolveTaskPairMaterial was an async gap, and something else
    // (endWorkspace ending the pair, a self-heal rebuild) may have mutated the
    // workspace while it ran. Merge lastHead onto FRESH state, never onto the
    // snapshot captured before the gap -- writing that back would silently
    // clobber whatever changed (e.g. reopen an 'ended' workspace to 'active').
    const latest = store.getPair(project, taskId);
    const latestWorkspace = latest?.state.workspace;
    if (!latest || !latestWorkspace || latestWorkspace.status === 'removed') return;
    store.savePair(project, { ...latest.state, workspace: { ...latestWorkspace, lastHead: material.head, lastHeadAt: now }, updatedAt: Math.max(latest.state.updatedAt, now) });
  } catch (error) {
    // Best-effort cache refresh: the async gap above can outlive the pair's
    // store (test teardown, daemon shutdown). Losing lastHead is harmless --
    // it is re-derived on the next marker -- but an unhandled rejection here
    // is not.
    logger.warn({ err: error, taskId }, 'task-pair: workspace head refresh failed');
  }
}

export class TaskPairService {
  #unsubscribe?: () => void;
  #scheduler?: TaskPairScheduler;
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
    this.#unsubscribe = timelineEmitter.on((event) => {
      // Activity is stamped synchronously so a heartbeat cannot race a just
      // emitted message/tool event. Marker parsing remains deferred off the
      // provider/watcher call stack.
      if (event.type === 'session.state') {
        noteTaskPairProviderError(event);
      } else if (event.type === 'user.message' || event.type === 'tool.call' || event.type === 'tool.result') {
        if (!(event.type === 'user.message' && (event.payload as Record<string, unknown>).automation === true)) {
          this.recordActivity(event.sessionId, event.ts ?? Date.now());
        }
      } else if (event.type === 'assistant.text') {
        this.recordActivity(event.sessionId, event.ts ?? Date.now());
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

  /** Unsubscribes first (no new background work starts), then drains whatever was already in flight. */
  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.waitForIdle();
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
    const matches = getTaskPairStore().pairsForSession(target).filter((stored) => {
      const state = stored.state;
      return state.brain === sender && TASK_PAIR_OPEN_STATUSES.includes(state.status)
        && (state.executor === target || state.auditor === target);
    });
    return matches.length === 1 ? matches[0]!.state.taskId : undefined;
  }

  handleTimelineEvent(event: TimelineEvent): void {
    if (event.type !== 'assistant.text') return;
    const payload = event.payload as Record<string, unknown>;
    if (payload.streaming === true || payload.automation === true || payload.memoryExcluded === true) return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const writer = event.sessionId;
    const project = projectOfSession(writer);
    if (!project || !isPairsEngineProject(project)) return;
    const now = event.ts ?? Date.now();
    clearTaskPairProviderError(writer);
    this.recordProgress(writer, now, text);
    this.backfillTitlesOnce(project);
    if (!mayContainTaskPairMarker(text)) return;
    this.ingestText(project, writer, text, event.eventId, now);
  }

  ingestText(project: string, writer: string, text: string, turnId: string, now = Date.now()): TaskPairTransition[] {
    const { markers } = scanTaskPairMarkers(text);
    const results: TaskPairTransition[] = [];
    for (const marker of markers) {
      results.push(this.applyMarker({
        project, writer, marker, source: 'marker', eventId: `${turnId}:${marker.markerIndex}`, now, turnText: text,
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
    const store = getTaskPairStore();
    const now = input.now ?? Date.now();
    if (store.hasEvent(input.eventId)) return { effect: 'replayed', unusual: false, intents: [] };
    const taskId = this.resolveTaskId(input.project, input.writer, input.marker.taskId, input.marker.knownVerb);
    const existing = taskId && taskId !== TASK_PAIR_INFER_TASK_ID ? store.getPair(input.project, taskId) : undefined;
    // Read on both pair creation (newPair()) and a config-derived pair's next
    // round (READY_FOR_AUDIT starting a new round, applyTaskPairMarker), so
    // an open pair picks up a Brain config change without a restart.
    const projectBlocking = taskId
      ? resolveSupervisionAuditBlockingSeverities(
          resolveProjectAuthoritativeSupervisionSnapshot(input.project, listSessions()),
        )
      : undefined;
    const transition = taskId
      ? applyTaskPairMarker(existing?.state, { ...input.marker, taskId }, {
          writer: input.writer,
          fallbackBrain: projectBrainSession(input.project),
          projectBlocking,
          now,
          source: input.source,
        })
      : { effect: 'unresolved', unusual: true, intents: [] as TaskPairIntent[] } satisfies TaskPairTransition;
    const role = taskPairRoleOf(existing?.state ?? transition.pair, input.writer);
    const recorded = store.recordEvent({
      id: input.eventId,
      project: input.project,
      taskId: taskId ?? input.marker.taskId,
      writer: input.writer,
      role,
      verb: input.marker.knownVerb ?? input.marker.verb,
      attrs: input.marker.attrs,
      effect: transition.effect,
      unusual: transition.unusual,
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
            workspace: { ...workspace, status: 'active' as const, endedAt: undefined, keptReason: undefined },
          }
        : transition.pair;
      stored = store.savePair(input.project, pairToSave, {
        liveness: this.#livenessAfterMarker(existing?.liveness, transition, role, now),
      });
      this.#track(refreshTaskPairWorkspaceHead(input.project, stored.state.taskId));
    }
    this.#emitEvent(input, taskId ?? input.marker.taskId, role, transition, stored?.state ?? existing?.state);
    const holdsAutoPickAuditor = input.suppressAutoPickAuditor
      && transition.intents.some((intent) => intent.kind === 'pick_auditor');
    const immediateIntents = holdsAutoPickAuditor
      ? transition.intents.filter((intent) => intent.kind !== 'pick_auditor')
      : transition.intents;
    this.#track(this.#executeIntents(input.project, stored?.state, immediateIntents));
    if (holdsAutoPickAuditor && stored) this.#track(this.#gracePickAuditor(input.project, stored.state.taskId));
    // A pair Brain opens (DISPATCH marker, plain or task-tagged dispatch) tells
    // its participants what a pair is. The queue sends its own brief. A
    // REASSIGN that hands the executor role to someone new tells them too --
    // pre-fix a REASSIGN never briefed the new executor at all, who got no
    // title, brief or workspace (owner report, tsk_cd_upgrade_starvation).
    // A DISPATCH that landed on `queued` (no free slot/window right now, or a
    // brand new pair the queue drain has not resolved yet) has no participant
    // to brief -- the queue runner briefs it once it actually starts.
    if (stored && input.source !== 'queue' && transition.toStatus !== 'queued'
      && ((input.marker.knownVerb === 'DISPATCH' && (transition.effect === 'created' || transition.effect === 'dispatched'))
        || (input.marker.knownVerb === 'REASSIGN' && !!input.marker.attrs.executor
          && (transition.effect === 'reassigned' || transition.effect === 'reassigned_auditor')))) {
      this.#track(this.briefParticipants(input.project, stored.state.taskId));
    }
    // A QUEUE/DISPATCH marker's `title=` is always deliberately authored
    // (there is no other source for it), so only a brand new queued pair
    // that named no title is a candidate: generate one from its brief,
    // best-effort. A DISPATCH/QUEUE from `implicitDispatch` (source
    // `implicit_dispatch`) already conflated an explicit title with a
    // mechanically derived one by the time it reaches here -- that
    // distinction, and the matching generation call, is handled by the
    // caller (send-tool.ts) instead.
    if (stored && input.source === 'marker' && (input.marker.knownVerb === 'QUEUE' || input.marker.knownVerb === 'DISPATCH')
      && transition.effect === 'created' && !input.marker.attrs.title && stored.state.brief) {
      this.maybeGenerateTitle(input.project, stored.state.taskId, stored.state.brief);
    }
    // A pair that just ended (DONE, CANCEL, DONE force=true): its workspace
    // starts its retention and a deliverable named on DONE is kept.
    if (stored && transition.toStatus && isTerminalTaskPairStatus(transition.toStatus)
      && (!transition.fromStatus || !isTerminalTaskPairStatus(transition.fromStatus))) {
      this.#track(this.endWorkspace(input.project, stored.state.taskId, now));
    }
    if (stored && transition.toStatus === 'passed' && transition.fromStatus !== 'passed') {
      this.#scheduler?.flagEconomyUnreviewed?.(input.project, stored.state.taskId);
    }
    // A no-auditor pair has no PASS for Brain to learn about instead: relay
    // the executor's own closing-reply prose (the marker line stripped out)
    // as the completion notice, so Brain never has to poll a pair it can't
    // watch an auditor finish for it.
    if (stored && input.marker.knownVerb === 'DONE' && transition.toStatus === 'done'
      && transition.fromStatus !== 'done' && stored.state.auditor === TASK_PAIR_NO_AUDITOR
      && input.writer !== stored.state.brain) {
      const summary = input.turnText ? stripTaskPairMarkersForDisplay(input.turnText) : '';
      this.#track(sendTaskPairMessage(
        stored.state.brain, stored.state.taskId, 'brain-line-done-no-auditor',
        buildNoAuditorDoneNotice(stored.state, summary),
      ));
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

  /** send_message with task metadata: creates a missing pair, otherwise record only. */
  implicitDispatch(input: {
    project?: string; sender: string; target: string; taskId: string; auditor?: string; title?: string; eventId: string;
    /** Owner rule (design D-pool-sync): a bound `task.requestedExecutionType.model` on the initial send_message dispatch, kept so a later automatic executor replacement still honors it instead of falling back to the allowlist. */
    executorModel?: string;
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
      // Record only: ordinary traffic (materials to the auditor, replies,
      // Brain messages) never changes a pair's roles or status.
      const state = existing.state;
      const counterpart = input.sender === state.executor ? state.auditor
        : input.sender === state.auditor ? state.executor
          : undefined;
      const unusual = input.sender !== state.brain && input.target !== counterpart;
      const at = Date.now();
      store.recordEvent({
        id: input.eventId, project, taskId: input.taskId, writer: input.sender,
        role: taskPairRoleOf(state, input.sender), verb: 'SEND', attrs: { target: input.target },
        effect: 'recorded', unusual, source: 'implicit_dispatch', fromStatus: state.status, toStatus: state.status,
        at,
      });
      // A task-tagged send is progress on that pair, and its target now works on it.
      this.recordPairProgress(project, input.taskId, input.sender, at);
      noteTaskPairFocus(input.target, input.taskId);
      return { effect: 'recorded', unusual, intents: [] };
    }
    return this.applyMarker({
      project,
      writer: input.sender,
      marker: {
        verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: input.taskId,
        attrs: {
          executor: input.target,
          ...(input.auditor ? { auditor: input.auditor } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.executorModel ? { executormodel: input.executorModel } : {}),
        },
        ...(input.brief ? { brief: input.brief } : {}),
      },
      source: 'implicit_dispatch',
      eventId: input.eventId,
      // Only when named the auditor is applied immediately as before; a bare
      // dispatch with none holds the auto-pick for the grace window unless
      // this send itself carried a real objective (clearly new work, no
      // reason to wait).
      ...(!input.auditor && !input.hasObjective ? { suppressAutoPickAuditor: true } : {}),
    });
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
  recordActivity(writer: string, now: number): void {
    const pairs = getTaskPairStore().pairsForSession(writer)
      .filter((pair) => TASK_PAIR_OPEN_STATUSES.includes(pair.state.status));
    for (const pair of pairs) this.#stampActivity(pair, writer, now);
  }

  #stampProgress(pair: StoredTaskPair, writer: string, now: number): void {
    const liveness = { ...pair.liveness };
    if (pair.state.executor === writer) {
      liveness.progressExecutorAt = now;
      liveness.activityExecutorAt = now;
      liveness.silenceExecutor = 0;
      liveness.bothIdleNudgedAt = undefined;
    }
    if (pair.state.auditor === writer) {
      liveness.progressAuditorAt = now;
      liveness.activityAuditorAt = now;
      liveness.silenceAuditor = 0;
      liveness.bothIdleNudgedAt = undefined;
    }
    getTaskPairStore().saveLiveness(pair.project, pair.state.taskId, liveness);
  }

  #stampActivity(pair: StoredTaskPair, writer: string, now: number): void {
    const liveness = { ...pair.liveness };
    if (pair.state.executor === writer) {
      liveness.activityExecutorAt = now;
      liveness.silenceExecutor = 0;
      liveness.bothIdleNudgedAt = undefined;
    }
    if (pair.state.auditor === writer) {
      liveness.activityAuditorAt = now;
      liveness.silenceAuditor = 0;
      liveness.bothIdleNudgedAt = undefined;
    }
    getTaskPairStore().saveLiveness(pair.project, pair.state.taskId, liveness);
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
    if (role === 'executor') { next.progressExecutorAt = now; next.silenceExecutor = 0; }
    if (role === 'auditor') { next.progressAuditorAt = now; next.silenceAuditor = 0; }
    if (role === 'executor') next.activityExecutorAt = now;
    if (role === 'auditor') next.activityAuditorAt = now;
    next.bothIdleNudgedAt = undefined;
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
    emitTaskPairTimelineEvent({
      taskId,
      verb: input.marker.knownVerb ?? input.marker.verb,
      writer: input.writer,
      role,
      source: input.source,
      effect: transition.effect,
      ...(transition.fromStatus ? { fromStatus: transition.fromStatus } : {}),
      ...(transition.toStatus ?? pair?.status ? { toStatus: transition.toStatus ?? pair?.status } : {}),
      unusual: transition.unusual,
      ...(transition.verdict ? { severityCounts: transition.verdict.counts, verdictJudgement: transition.verdict.judgement } : {}),
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
            await sendTaskPairMessage(intent.to, pair.taskId, 'closed-pair', `${pair.taskId} is ${pair.status} -- only Brain can reopen it (DISPATCH or QUEUE). Your marker was recorded but not applied.`);
            break;
          case 'rework_notice':
            await sendTaskPairMessage(intent.to, pair.taskId, 'rework', buildReworkNoticeMessage(pair, intent.counts));
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
              await sendTaskPairMessage(intent.to, pair.taskId, 'audit-request', buildAuditRequestMessage(pair, material));
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
      if (current.workspace.status === 'active') return current;
      const { endedAt: _endedAt, keptReason: _keptReason, ...workspace } = current.workspace;
      // A reopen starts a fresh retention window; the next terminal transition
      // must not inherit the previous terminal timestamp or keep reason.
      const reopened: TaskPairState = {
        ...current,
        workspace: { ...workspace, status: 'active', endedAt: undefined, keptReason: undefined },
      };
      store.savePair(project, reopened);
      return reopened;
    }
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
        createdAt: Date.now(),
        status: 'active',
      },
    };
    store.savePair(project, next);
    return next;
  }

  /**
   * The pair ended: its workspace starts the retention period (the sweep
   * removes it later), and a deliverable named on DONE is copied into the
   * project directory and shown to the user.
   */
  async endWorkspace(project: string, taskId: string, now: number): Promise<void> {
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

  #lastSweepAt = 0;

  /**
   * Remove the workspaces of pairs that ended at least the retention period
   * ago. A worktree that still holds unsaved work is kept (Brain is told once)
   * and retried on later sweeps. Runs at most hourly unless forced.
   */
  async sweepWorkspaces(now: number, options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && now - this.#lastSweepAt < 60 * 60_000) return;
    this.#lastSweepAt = now;
    const store = getTaskPairStore();
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
          await sendTaskPairMessage(next.brain, pair.taskId, 'brain-workspace-kept', buildWorkspaceKeptLine(next, released.reason));
        }
      } catch (error) {
        logger.warn({ err: error, taskId: pair.taskId }, 'task-pair: workspace sweep failed');
      }
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
    try {
      const pair = await this.ensureWorkspace(project, taskId);
      if (!pair) return;
      if (pair.executor) await sendTaskPairMessage(pair.executor, pair.taskId, 'pair-brief', buildExecutorPairBrief(pair));
      if (pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR) {
        await sendTaskPairMessage(pair.auditor, pair.taskId, 'auditor-assigned', buildAuditorAssignmentMessage(pair));
      }
    } catch (error) {
      logger.warn({ err: error, taskId }, 'task-pair: participant brief failed');
    }
  }

  /**
   * Best-effort: kicks off background generation of a short, localized title
   * for a pair that has no deliberately-authored one, from `sourceText` (the
   * QUEUE brief, the send_message objective, or a generic placeholder title
   * worth replacing). Never blocks the caller and never throws; a no-op when
   * `sourceText` is empty, the project's Brain has no configured UI locale
   * (headless/legacy callers keep the mechanical fallback untouched, exactly
   * as the retired legacy supervision prompts did), or generation fails.
   */
  maybeGenerateTitle(project: string, taskId: string, sourceText: string | undefined): void {
    if (!sourceText?.trim()) return;
    this.#track(this.#generateAndApplyTitle(project, taskId, sourceText));
  }

  async #generateAndApplyTitle(project: string, taskId: string, sourceText: string): Promise<void> {
    try {
      const locale = brainUiLocale(project);
      if (!locale) return;
      const before = getTaskPairStore().getPair(project, taskId)?.state;
      if (!before || isTerminalTaskPairStatus(before.status)) return;
      const titleAtStart = before.title;
      const generated = await generateTaskPairTitle(sourceText, locale);
      if (!generated) return;
      // Re-read: generation is a long-lived await. Never clobber a title a
      // marker (an explicit title=, a reassignment, a reopen) set meanwhile,
      // and never resurrect a pair that ended in the meantime.
      const latest = getTaskPairStore().getPair(project, taskId)?.state;
      if (!latest || isTerminalTaskPairStatus(latest.status) || latest.title !== titleAtStart) return;
      const next: TaskPairState = { ...latest, title: generated, updatedAt: Date.now() };
      getTaskPairStore().savePair(project, next);
      this.#recordTitleGeneratedEvent(project, next);
    } catch (error) {
      logger.warn({ err: error, taskId }, 'task-pair: title generation failed');
    }
  }

  #recordTitleGeneratedEvent(project: string, pair: TaskPairState): void {
    const at = Date.now();
    const eventId = `title:${pair.taskId}:${at}`;
    getTaskPairStore().recordEvent({
      id: eventId, project, taskId: pair.taskId, writer: 'daemon', role: 'daemon', verb: TASK_PAIR_TITLE_EVENT_VERB,
      attrs: { title: pair.title ?? '' }, effect: TASK_PAIR_TITLE_GENERATED_EFFECT, unusual: false,
      source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, at,
    });
    emitTaskPairDaemonEvent(pair, {
      eventId, verb: TASK_PAIR_TITLE_EVENT_VERB, effect: TASK_PAIR_TITLE_GENERATED_EFFECT,
      source: 'heartbeat', fromStatus: pair.status, toStatus: pair.status, unusual: false,
    });
  }

  #backfilledTitleProjects = new Set<string>();

  /**
   * Once per project per daemon run *after* the project has a configured UI
   * locale: every open pair with no title, or with a known non-informative
   * placeholder title (shared/task-pair.ts), gets a background generation
   * pass from whatever source text it has (its QUEUE brief, or -- for an
   * imported placeholder with nothing richer recorded -- its own generic
   * title, which is still worth showing translated). A pair with neither a
   * brief nor a title is left alone: there is no text to generate from.
   *
   * Not latched until a locale is actually known: the daemon can see a
   * project's very first timeline event before the browser has sent one
   * (`uiLocale` arrives on `session.send`, see command-handler.ts), and a
   * project that latched "done" on that first, locale-less call would never
   * get a real backfill pass for the rest of the run.
   */
  backfillTitlesOnce(project: string): void {
    if (this.#backfilledTitleProjects.has(project)) return;
    if (!brainUiLocale(project)) return;
    this.#backfilledTitleProjects.add(project);
    for (const stored of getTaskPairStore().listActivePairs(project)) {
      const pair = stored.state;
      const isGenericTitle = pair.title !== undefined
        && (TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS as readonly string[]).includes(pair.title);
      if (pair.title !== undefined && !isGenericTitle) continue;
      const sourceText = pair.brief ?? (isGenericTitle ? pair.title : undefined);
      this.maybeGenerateTitle(project, pair.taskId, sourceText);
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
  base: Omit<TaskPairEventPayload, 'title' | 'executor' | 'auditor' | 'round' | 'flags' | 'blocking' | 'executorPool' | 'auditorPool'>,
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
      flags: pair.flags,
      blocking: pair.blocking,
      ...(pair.executorPool ? { executorPool: pair.executorPool } : {}),
      ...(pair.auditorPool ? { auditorPool: pair.auditorPool } : {}),
      ...(pair.executorModel ? { executorModel: pair.executorModel } : {}),
      ...(pair.auditor === TASK_PAIR_NO_AUDITOR ? { auditorModel: TASK_PAIR_NO_AUDITOR } : pair.auditorModel ? { auditorModel: pair.auditorModel } : {}),
    } : {}),
  };
  for (const [role, session] of [['executor', pair?.executor], ['auditor', pair?.auditor]] as const) {
    if (!session || session === TASK_PAIR_NO_AUDITOR) continue;
    const record = getSession(session);
    if (role === 'executor') {
      if (record?.label) payload.executorLabel = record.label;
      const model = record?.activeModel?.trim() || record?.requestedModel?.trim();
      if (model) payload.executorModel = model;
      if (record?.state) payload.executorState = record.state;
    } else {
      if (record?.label) payload.auditorLabel = record.label;
      const model = record?.activeModel?.trim() || record?.requestedModel?.trim();
      if (model) payload.auditorModel = model;
      if (record?.state) payload.auditorState = record.state;
    }
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
  event: Pick<TaskPairEventPayload, 'verb' | 'effect' | 'source' | 'fromStatus' | 'toStatus' | 'unusual' | 'outputPath' | 'outputError'> & { eventId: string },
): void {
  const { eventId, ...rest } = event;
  emitTaskPairTimelineEvent({ taskId: pair.taskId, writer: 'daemon', role: 'daemon', ...rest }, pair, eventId);
}

export const taskPairService = new TaskPairService();
