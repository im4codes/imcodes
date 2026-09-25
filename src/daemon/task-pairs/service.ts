/**
 * Marker ingestion for the `pairs` supervision engine.
 *
 * One listener on the daemon timeline sees every final assistant turn of every
 * session, transport and process alike. It runs after the turn was emitted and
 * never touches relay, send acknowledgement, queue drain, `/stop` or control
 * responses; a failure here is logged and dropped.
 */
import { timelineEmitter } from '../timeline-emitter.js';
import type { TimelineEvent } from '../timeline-event.js';
import logger from '../../util/logger.js';
import {
  TASK_PAIR_INFER_TASK_ID,
  TASK_PAIR_TIMELINE_EVENT,
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
import { sendTaskPairMessage } from './delivery.js';
import {
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

export class TaskPairService {
  #unsubscribe?: () => void;
  #scheduler?: TaskPairScheduler;

  init(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = timelineEmitter.on((event) => {
      // Cheap filter inline; all store work runs after the emit returns, off
      // the relay/watcher call stack (design D3). Replays stay idempotent.
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
    this.recordProgress(writer, now);
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
    if (stored && transition.toStatus === 'passed' && transition.fromStatus !== 'passed') {
      this.#scheduler?.flagEconomyUnreviewed?.(input.project, stored.state.taskId);
    }
    return transition;
  }

  /** send_message with task metadata: creates a missing pair, otherwise record only. */
  implicitDispatch(input: { project?: string; sender: string; target: string; taskId: string; auditor?: string; eventId: string }): TaskPairTransition | undefined {
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
      store.recordEvent({
        id: input.eventId, project, taskId: input.taskId, writer: input.sender,
        role: taskPairRoleOf(state, input.sender), verb: 'SEND', attrs: { target: input.target },
        effect: 'recorded', unusual, source: 'implicit_dispatch', fromStatus: state.status, toStatus: state.status,
        at: Date.now(),
      });
      return { effect: 'recorded', unusual, intents: [] };
    }
    return this.applyMarker({
      project,
      writer: input.sender,
      marker: {
        verb: 'DISPATCH', knownVerb: 'DISPATCH', taskId: input.taskId,
        attrs: { executor: input.target, ...(input.auditor ? { auditor: input.auditor } : {}) },
      },
      source: 'implicit_dispatch',
      eventId: input.eventId,
    });
  }

  /** Any final assistant output is progress for the side that wrote it. */
  recordProgress(writer: string, now: number): void {
    const store = getTaskPairStore();
    for (const pair of store.pairsForSession(writer)) {
      const liveness = { ...pair.liveness };
      if (pair.state.executor === writer) { liveness.progressExecutorAt = now; liveness.silenceExecutor = 0; }
      if (pair.state.auditor === writer) { liveness.progressAuditorAt = now; liveness.silenceAuditor = 0; }
      store.saveLiveness(pair.project, pair.state.taskId, liveness);
    }
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
    const payload: TaskPairEventPayload = {
      taskId,
      verb: input.marker.knownVerb ?? input.marker.verb,
      writer: input.writer,
      role,
      source: input.source,
      effect: transition.effect,
      ...(transition.fromStatus ? { fromStatus: transition.fromStatus } : {}),
      ...(transition.toStatus ?? pair?.status ? { toStatus: transition.toStatus ?? pair?.status } : {}),
      unusual: transition.unusual,
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
      ...(transition.verdict ? { severityCounts: transition.verdict.counts, verdictJudgement: transition.verdict.judgement } : {}),
    };
    const targets = new Set<string>(input.writer === 'daemon' ? [] : [input.writer]);
    for (const session of [pair?.executor, pair?.auditor, pair?.brain]) {
      if (session && session !== 'none') targets.add(session);
    }
    for (const session of targets) {
      timelineEmitter.emit(session, TASK_PAIR_TIMELINE_EVENT, payload as unknown as Record<string, unknown>, {
        source: 'daemon', confidence: 'high', eventId: `${TASK_PAIR_TIMELINE_EVENT}:${input.eventId}:${session}`,
      });
    }
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
          default:
            await this.#scheduler?.onIntent(project, pair, intent);
        }
      } catch (error) {
        logger.warn({ err: error, taskId: pair.taskId, intent: intent.kind }, 'task-pair: intent failed');
      }
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

export const taskPairService = new TaskPairService();
