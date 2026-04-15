import type {
  ContextDirtyTarget,
  ContextJobRecord,
  ContextJobTrigger,
  ContextModelConfig,
  ContextNamespace,
  ContextTargetRef,
  LocalContextEvent,
  ProcessedContextProjection,
} from '../../shared/context-types.js';
import { getContextModelConfig } from './context-model-config.js';
import {
  clearDirtyTarget,
  enqueueContextJob,
  getReplicationState,
  listContextEvents,
  listDirtyTargets,
  listProcessedProjections,
  recordContextEvent,
  setReplicationState,
  updateContextJob,
  writeProcessedProjection,
} from '../store/context-store.js';

export interface MaterializationThresholds {
  idleMs: number;
  eventCount: number;
  scheduleMs: number;
  minIntervalMs: number;
}

export interface MaterializationCoordinatorOptions {
  thresholds?: Partial<MaterializationThresholds>;
  modelConfig?: Partial<ContextModelConfig>;
}

export interface MaterializationResult {
  summaryProjection: ProcessedContextProjection;
  durableProjection?: ProcessedContextProjection;
  replicationQueued: boolean;
}

const DEFAULT_THRESHOLDS: MaterializationThresholds = {
  idleMs: 5 * 60_000,
  eventCount: 5,
  scheduleMs: 15 * 60_000,
  minIntervalMs: 10_000,
};

export class MaterializationCoordinator {
  readonly thresholds: MaterializationThresholds;
  readonly modelConfig: ContextModelConfig;

  constructor(options?: MaterializationCoordinatorOptions) {
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...options?.thresholds,
    };
    this.modelConfig = getContextModelConfig(options?.modelConfig);
  }

  ingestEvent(input: Omit<LocalContextEvent, 'id' | 'createdAt'> & Partial<Pick<LocalContextEvent, 'id' | 'createdAt'>>): {
    event: LocalContextEvent;
    queuedJob?: ContextJobRecord;
    trigger?: ContextJobTrigger;
  } {
    const event = recordContextEvent(input);
    const dirtyTarget = this.findDirtyTarget(input.target);
    if (!dirtyTarget) return { event };
    const trigger = this.selectTrigger(dirtyTarget, event.createdAt);
    if (!trigger) return { event };
    const jobType = input.target.kind === 'project' ? 'materialize_project' : 'materialize_session';
    const queuedJob = enqueueContextJob(input.target, jobType, trigger, event.createdAt);
    return { event, queuedJob, trigger };
  }

  listDirtyTargets(namespace?: ContextNamespace): ContextDirtyTarget[] {
    return listDirtyTargets(namespace);
  }

  materializeTarget(target: ContextTargetRef, trigger: ContextJobTrigger, now = Date.now()): MaterializationResult {
    const jobType = target.kind === 'project' ? 'materialize_project' : 'materialize_session';
    const job = enqueueContextJob(target, jobType, trigger, now);
    updateContextJob(job.id, 'running', { attemptIncrement: true, now });
    const events = listContextEvents(target);
    const sourceEventIds = events.map((event) => event.id);
    const summary = buildSummary(events);
    const summaryProjection = writeProcessedProjection({
      namespace: target.namespace,
      class: 'recent_summary',
      sourceEventIds,
      summary,
      content: {
        trigger,
        targetKind: target.kind,
        sessionName: target.sessionName,
        primaryContextBackend: this.modelConfig.primaryContextBackend,
        primaryContextModel: this.modelConfig.primaryContextModel,
        backupContextBackend: this.modelConfig.backupContextBackend,
        backupContextModel: this.modelConfig.backupContextModel,
        eventCount: events.length,
      },
      createdAt: now,
      updatedAt: now,
    });
    const durableProjection = buildDurableProjection(target.namespace, events, now);
    const replicationState = getReplicationState(target.namespace);
    const pendingProjectionIds = [
      ...(replicationState?.pendingProjectionIds ?? []),
      summaryProjection.id,
      ...(durableProjection ? [durableProjection.id] : []),
    ];
    setReplicationState(target.namespace, {
      pendingProjectionIds: Array.from(new Set(pendingProjectionIds)),
      lastReplicatedAt: replicationState?.lastReplicatedAt,
      lastError: replicationState?.lastError,
    });
    updateContextJob(job.id, 'completed', { now });
    clearDirtyTarget(target);
    return {
      summaryProjection,
      durableProjection,
      replicationQueued: true,
    };
  }

  scheduleDueTargets(now = Date.now()): ContextJobRecord[] {
    const queued: ContextJobRecord[] = [];
    for (const target of listDirtyTargets()) {
      const trigger = this.selectTrigger(target, now);
      if (!trigger) continue;
      const jobType = target.target.kind === 'project' ? 'materialize_project' : 'materialize_session';
      queued.push(enqueueContextJob(target.target, jobType, trigger, now));
    }
    return queued;
  }

  listProcessed(namespace: ContextNamespace): ProcessedContextProjection[] {
    return listProcessedProjections(namespace);
  }

  private findDirtyTarget(target: ContextTargetRef): ContextDirtyTarget | undefined {
    return listDirtyTargets(target.namespace).find((entry) =>
      entry.target.kind === target.kind && entry.target.sessionName === target.sessionName,
    );
  }

  private selectTrigger(dirtyTarget: ContextDirtyTarget, now: number): ContextJobTrigger | undefined {
    if (this.isRateLimited(dirtyTarget.target, now)) return undefined;
    if (dirtyTarget.eventCount >= this.thresholds.eventCount) return 'threshold';
    if (this.hasProcessedSummary(dirtyTarget.target)) return 'schedule';
    if (now - dirtyTarget.newestEventAt >= this.thresholds.idleMs) return 'idle';
    if (now - dirtyTarget.oldestEventAt >= this.thresholds.scheduleMs) return 'schedule';
    return undefined;
  }

  canMaterializeTarget(target: ContextTargetRef, now = Date.now()): boolean {
    return !this.isRateLimited(target, now);
  }

  private isRateLimited(target: ContextTargetRef, now: number): boolean {
    const latestSummaryAt = this.getLatestSummaryUpdatedAt(target);
    return latestSummaryAt !== undefined && now - latestSummaryAt < this.thresholds.minIntervalMs;
  }

  private hasProcessedSummary(target: ContextTargetRef): boolean {
    return this.getLatestSummaryUpdatedAt(target) !== undefined;
  }

  private getLatestSummaryUpdatedAt(target: ContextTargetRef): number | undefined {
    const projections = listProcessedProjections(target.namespace, 'recent_summary');
    for (const projection of projections) {
      const targetKind = typeof projection.content.targetKind === 'string' ? projection.content.targetKind : undefined;
      const sessionName = typeof projection.content.sessionName === 'string' ? projection.content.sessionName : undefined;
      if (target.kind === 'project') {
        if (targetKind === 'project') return projection.updatedAt;
        continue;
      }
      if (targetKind === 'session' && sessionName === target.sessionName) return projection.updatedAt;
    }
    return undefined;
  }
}

function buildSummary(events: LocalContextEvent[]): string {
  if (events.length === 0) return 'No staged events available.';
  const userTurns = events
    .filter((event) => event.eventType === 'user.turn')
    .map((event) => event.content?.trim())
    .filter((value): value is string => !!value);
  const assistantTurns = events
    .filter((event) => event.eventType === 'assistant.turn')
    .map((event) => event.content?.trim())
    .filter((value): value is string => !!value);
  const decisions = events
    .filter((event) => event.eventType === 'decision' || event.eventType === 'constraint' || event.eventType === 'preference')
    .map((event) => event.content?.trim())
    .filter((value): value is string => !!value);

  const lines: string[] = [];
  if (userTurns.length > 0) {
    lines.push(`User intent: ${userTurns[userTurns.length - 1]}`);
  }
  if (assistantTurns.length > 0) {
    lines.push(`Current outcome: ${assistantTurns[assistantTurns.length - 1]}`);
  }
  if (decisions.length > 0) {
    lines.push(`Key constraints: ${decisions.slice(-2).join(' | ')}`);
  }
  lines.push(`Compressed from ${events.length} event${events.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

function buildDurableProjection(namespace: ContextNamespace, events: LocalContextEvent[], now: number): ProcessedContextProjection | undefined {
  const candidateEvents = events.filter((event) => event.eventType === 'decision' || event.eventType === 'constraint' || event.eventType === 'preference');
  if (candidateEvents.length === 0) return undefined;
  return writeProcessedProjection({
    namespace,
    class: 'durable_memory_candidate',
    sourceEventIds: candidateEvents.map((event) => event.id),
    summary: candidateEvents.map((event) => event.content ?? event.eventType).join('\n'),
    content: {
      candidateKinds: candidateEvents.map((event) => event.eventType),
      count: candidateEvents.length,
    },
    createdAt: now,
    updatedAt: now,
  });
}
