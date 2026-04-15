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
import { isMemoryEligibleEvent } from '../../shared/context-types.js';
import { getContextModelConfig } from './context-model-config.js';
import {
  clearDirtyTarget,
  enqueueContextJob,
  getReplicationState,
  deleteStagedEventsByIds,
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
    this.modelConfig = getContextModelConfig(options?.modelConfig);
    // materializationMinIntervalMs from cloud config overrides the threshold default
    const configMinInterval = this.modelConfig.materializationMinIntervalMs;
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(configMinInterval ? { minIntervalMs: configMinInterval } : {}),
      ...options?.thresholds,
    };
  }

  ingestEvent(input: Omit<LocalContextEvent, 'id' | 'createdAt'> & Partial<Pick<LocalContextEvent, 'id' | 'createdAt'>>): {
    event: LocalContextEvent;
    queuedJob?: ContextJobRecord;
    trigger?: ContextJobTrigger;
    filtered?: boolean;
  } {
    // Always record to local staging (visible in Raw Events tab)
    const event = recordContextEvent(input);
    // Only memory-eligible events (assistant.text) count toward materialization triggers.
    // Streaming deltas, tool calls/results, and system events are excluded.
    if (!isMemoryEligibleEvent(input.eventType)) {
      return { event, filtered: true };
    }
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
    const allEvents = listContextEvents(target);
    // Only memory-eligible events are used for summary generation.
    // Streaming deltas, tool calls/results, and system events are excluded.
    const events = allEvents.filter((e) => isMemoryEligibleEvent(e.eventType));
    const sourceEventIds = allEvents.map((event) => event.id);
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
    deleteStagedEventsByIds(sourceEventIds);
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
  const turnPairs = buildTurnPairs(events);
  const decisions = events
    .filter((event) => event.eventType === 'decision' || event.eventType === 'constraint' || event.eventType === 'preference')
    .map((event) => event.content?.trim())
    .filter((value): value is string => !!value);

  // Structured summary: problem → resolution → key decisions
  const sections: string[] = [];
  if (turnPairs.length > 0) {
    const latest = turnPairs[turnPairs.length - 1];
    sections.push(`- User problem: ${latest.user}`);
    if (latest.assistant) {
      sections.push(`- Resolution: ${latest.assistant}`);
    }
    // If there were multiple turns, note the earlier ones as context
    if (turnPairs.length > 1) {
      const earlier = turnPairs.slice(0, -1).map((p) => p.user).join('; ');
      sections.push(`- Prior context: ${earlier}`);
    }
  }
  if (decisions.length > 0) {
    sections.push(`- Key decisions: ${decisions.join('; ')}`);
  }
  // Fallback: include raw event content when no structured pairs/decisions were extracted
  if (turnPairs.length === 0 && decisions.length === 0) {
    for (const event of events) {
      const content = event.content?.trim();
      if (content) {
        sections.push(`- [${event.eventType}] ${content.length > 500 ? content.slice(0, 500) + '…' : content}`);
      }
    }
  }
  sections.push(`\nCompressed from ${events.length} event${events.length === 1 ? '' : 's'}.`);
  return sections.join('\n');
}

function buildTurnPairs(events: LocalContextEvent[]): Array<{ user: string; assistant?: string }> {
  const pairs: Array<{ user: string; assistant?: string }> = [];
  for (const event of events) {
    const content = event.content?.trim();
    if (!content) continue;
    if (event.eventType === 'user.turn' || event.eventType === 'user.message') {
      pairs.push({ user: content });
      continue;
    }
    // assistant.text is the canonical final-message event type;
    // assistant.turn is legacy but still accepted for backward compatibility
    if (event.eventType === 'assistant.text' || event.eventType === 'assistant.turn') {
      const openPair = [...pairs].reverse().find((pair) => !pair.assistant);
      if (openPair) {
        openPair.assistant = content;
      }
    }
  }
  return pairs;
}

function buildDurableProjection(namespace: ContextNamespace, events: LocalContextEvent[], now: number): ProcessedContextProjection | undefined {
  const candidateEvents = events.filter((event) => event.eventType === 'decision' || event.eventType === 'constraint' || event.eventType === 'preference');
  if (candidateEvents.length === 0) return undefined;
  return writeProcessedProjection({
    namespace,
    class: 'durable_memory_candidate',
    sourceEventIds: candidateEvents.map((event) => event.id),
    summary: buildDurableSummary(candidateEvents),
    content: {
      candidateKinds: candidateEvents.map((event) => event.eventType),
      count: candidateEvents.length,
    },
    createdAt: now,
    updatedAt: now,
  });
}

function buildDurableSummary(events: LocalContextEvent[]): string {
  const grouped = new Map<string, string[]>();
  for (const event of events) {
    const content = event.content?.trim();
    if (!content) continue;
    const items = grouped.get(event.eventType) ?? [];
    if (!items.includes(content)) items.push(content);
    grouped.set(event.eventType, items);
  }

  const lines: string[] = [];
  const preferences = grouped.get('preference') ?? [];
  const constraints = grouped.get('constraint') ?? [];
  const decisions = grouped.get('decision') ?? [];

  if (preferences.length > 0) {
    lines.push(`Durable preferences: ${preferences.slice(-2).join(' | ')}`);
  }
  if (constraints.length > 0) {
    lines.push(`Durable constraints: ${constraints.slice(-2).join(' | ')}`);
  }
  if (decisions.length > 0) {
    lines.push(`Pinned decisions: ${decisions.slice(-2).join(' | ')}`);
  }
  lines.push(`Compressed from ${events.length} durable signal${events.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}
