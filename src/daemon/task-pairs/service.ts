/**
 * Marker ingestion for the `pairs` supervision engine.
 *
 * One listener on the daemon timeline sees every final assistant turn of every
 * session, transport and process alike. It runs after the turn was emitted and
 * never touches relay, send acknowledgement, queue drain, `/stop` or control
 * responses; a failure here is logged and dropped.
 */
import { createHash, randomUUID } from 'node:crypto';
import { SUPERVISION_ID_PREFIXES } from '../../../shared/supervision-durable-identity.js';
import { timelineEmitter } from '../timeline-emitter.js';
import type { TimelineEvent } from '../timeline-event.js';
import logger from '../../util/logger.js';
import {
  TASK_PAIR_INFER_TASK_ID,
  TASK_PAIR_NO_AUDITOR,
  TASK_PAIR_OPEN_STATUSES,
  TASK_PAIR_TIMELINE_EVENT,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
  TASK_PAIR_WORKSPACE_RETENTION_MS,
  applyTaskPairMarker,
  isTerminalTaskPairStatus,
  mayContainTaskPairMarker,
  scanTaskPairMarkers,
  taskPairRoleOf,
  type TaskPairEventPayload,
  type TaskPairEventSource,
  type TaskPairIntent,
  type TaskPairMarker,
  type TaskPairState,
  type TaskPairTransition,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair, type TaskPairLiveness } from './store.js';
import { isPairsEngineProject, projectBrainSession, projectOfSession } from './engine.js';
import { noteTaskPairFocus, sendTaskPairMessage, taskPairFocusOf } from './delivery.js';
import { resolveTaskPairMaterial } from './material.js';
import { copyTaskPairOutput, provisionTaskPairWorkspace, releaseTaskPairWorkspace } from './workspace.js';
import { clearTaskPairProviderError, noteTaskPairProviderError } from './provider-errors.js';
import {
  buildAuditRequestMessage,
  buildAuditorAssignmentMessage,
  buildExecutorPairBrief,
  buildOutputFailedLine,
  buildWorkspaceKeptLine,
  buildBrainNoticeMessage,
  buildCorrectionMessage,
  buildDoneReminderMessage,
  buildReworkNoticeMessage,
} from './messages.js';

/** Intents that need the pool, the heartbeat or the queue (see scheduler.ts). */
export interface TaskPairScheduler {
  onIntent(project: string, pair: TaskPairState, intent: TaskPairIntent): void | Promise<void>;
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
}

/** The text names this task id as a whole token (so `T1` is not found in `T10`; trailing punctuation is fine). */
function mentionsTaskId(text: string, taskId: string): boolean {
  if (!text || !text.includes(taskId)) return false;
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, 'u').test(text);
}

export class TaskPairService {
  #unsubscribe?: () => void;
  #scheduler?: TaskPairScheduler;

  init(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = timelineEmitter.on((event) => {
      // Cheap filter inline; all store work runs after the emit returns, off
      // the relay/watcher call stack (design D3). Replays stay idempotent.
      if (event.type === 'session.state') {
        noteTaskPairProviderError(event);
        return;
      }
      if (event.type !== 'assistant.text') return;
      setImmediate(() => {
        try {
          this.handleTimelineEvent(event);
        } catch (error) {
          logger.warn({ err: error, session: event.sessionId }, 'task-pair: marker ingestion failed');
        }
      });
    });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  setScheduler(scheduler: TaskPairScheduler | undefined): void {
    this.#scheduler = scheduler;
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
    if (!mayContainTaskPairMarker(text)) return;
    this.ingestText(project, writer, text, event.eventId, now);
  }

  ingestText(project: string, writer: string, text: string, turnId: string, now = Date.now()): TaskPairTransition[] {
    const { markers } = scanTaskPairMarkers(text);
    const results: TaskPairTransition[] = [];
    for (const marker of markers) {
      results.push(this.applyMarker({
        project, writer, marker, source: 'marker', eventId: `${turnId}:${marker.markerIndex}`, now,
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
    const transition = taskId
      ? applyTaskPairMarker(existing?.state, { ...input.marker, taskId }, {
          writer: input.writer,
          fallbackBrain: projectBrainSession(input.project),
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
      stored = store.savePair(input.project, transition.pair, {
        liveness: this.#livenessAfterMarker(existing?.liveness, transition, role, now),
      });
    }
    this.#emitEvent(input, taskId ?? input.marker.taskId, role, transition, stored?.state ?? existing?.state);
    void this.#executeIntents(input.project, stored?.state, transition.intents);
    // A pair Brain opens (DISPATCH marker, plain or task-tagged dispatch) tells
    // its participants what a pair is. The queue sends its own brief.
    if (stored && input.source !== 'queue' && input.marker.knownVerb === 'DISPATCH'
      && (transition.effect === 'created' || transition.effect === 'dispatched')) {
      void this.briefParticipants(input.project, stored.state.taskId);
    }
    // A pair that just ended (DONE, CANCEL, DONE force=true): its workspace
    // starts its retention and a deliverable named on DONE is kept.
    if (stored && transition.toStatus && isTerminalTaskPairStatus(transition.toStatus)
      && (!transition.fromStatus || !isTerminalTaskPairStatus(transition.fromStatus))) {
      void this.endWorkspace(input.project, stored.state.taskId, now);
    }
    if (stored && transition.toStatus === 'passed' && transition.fromStatus !== 'passed') {
      this.#scheduler?.flagEconomyUnreviewed?.(input.project, stored.state.taskId);
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
  implicitDispatch(input: { project?: string; sender: string; target: string; taskId: string; auditor?: string; title?: string; eventId: string }): TaskPairTransition | undefined {
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
        },
      },
      source: 'implicit_dispatch',
      eventId: input.eventId,
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

  #stampProgress(pair: StoredTaskPair, writer: string, now: number): void {
    const liveness = { ...pair.liveness };
    if (pair.state.executor === writer) { liveness.progressExecutorAt = now; liveness.silenceExecutor = 0; }
    if (pair.state.auditor === writer) { liveness.progressAuditorAt = now; liveness.silenceAuditor = 0; }
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
      : { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: now, progressAuditorAt: now, lastTickAt: now, notified: [] };
    if (role === 'executor') { next.progressExecutorAt = now; next.silenceExecutor = 0; }
    if (role === 'auditor') { next.progressAuditorAt = now; next.silenceAuditor = 0; }
    // A new auditor starts with a clean slate.
    if (transition.effect === 'reassigned_auditor') { next.silenceAuditor = 0; next.progressAuditorAt = now; }
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
          case 'rework_notice':
            await sendTaskPairMessage(intent.to, pair.taskId, 'rework', buildReworkNoticeMessage(pair, intent.counts));
            break;
          case 'brain_notice':
            await sendTaskPairMessage(pair.brain, pair.taskId, `brain-${intent.flag}`, buildBrainNoticeMessage(pair, intent.flag));
            break;
          case 'audit_request': {
            const material = await resolveTaskPairMaterial(pair);
            await sendTaskPairMessage(intent.to, pair.taskId, 'audit-request', buildAuditRequestMessage(pair, material));
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
      const reopened: TaskPairState = { ...current, workspace: { ...workspace, status: 'active' } };
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
    if (!pair) return;
    try {
      let next = pair;
      if (pair.workspace?.status === 'active') {
        next = { ...pair, workspace: { ...pair.workspace, status: 'ended', endedAt: now } };
        store.savePair(project, next);
      }
      if (next.status !== 'done' || !next.output) return;
      const copied = await copyTaskPairOutput(next);
      const latest = store.getPair(project, taskId)?.state ?? next;
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
        const released = await releaseTaskPairWorkspace(pair);
        if (released.action === 'absent') continue;
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
    } : {}),
  };
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
