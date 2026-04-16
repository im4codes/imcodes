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
import { buildLocalFallbackSummary, compressWithSdk, type CompressionResult } from './summary-compressor.js';
import {
  clearDirtyTarget,
  countConsecutiveFailedJobs,
  deleteTentativeProjections,
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
  /** Override the SDK compressor (for testing or environments without SDK access). */
  compressor?: (input: import('./summary-compressor.js').CompressionInput) => Promise<import('./summary-compressor.js').CompressionResult>;
}

export interface MaterializationResult {
  summaryProjection: ProcessedContextProjection;
  durableProjection?: ProcessedContextProjection;
  replicationQueued: boolean;
  compression?: CompressionResult;
}

const DEFAULT_THRESHOLDS: MaterializationThresholds = {
  idleMs: 5 * 60_000,
  eventCount: 5,
  scheduleMs: 15 * 60_000,
  minIntervalMs: 10_000,
};

/**
 * Max consecutive SDK failures before committing the local fallback.
 * Beyond this, we accept the fallback summary and delete staged events
 * to avoid unbounded growth.
 */
const MAX_SDK_RETRY_ATTEMPTS = 3;

export class MaterializationCoordinator {
  readonly thresholds: MaterializationThresholds;
  readonly modelConfig: ContextModelConfig;
  private readonly _compressor: MaterializationCoordinatorOptions['compressor'];

  constructor(options?: MaterializationCoordinatorOptions) {
    this._compressor = options?.compressor;
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

  async materializeTarget(target: ContextTargetRef, trigger: ContextJobTrigger, now = Date.now()): Promise<MaterializationResult> {
    const jobType = target.kind === 'project' ? 'materialize_project' : 'materialize_session';
    const job = enqueueContextJob(target, jobType, trigger, now);
    updateContextJob(job.id, 'running', { attemptIncrement: true, now });
    const allEvents = listContextEvents(target);
    // Only memory-eligible events are used for summary generation.
    // Streaming deltas, tool calls/results, and system events are excluded.
    const events = allEvents.filter((e) => isMemoryEligibleEvent(e.eventType));
    const sourceEventIds = allEvents.map((event) => event.id);

    // Fetch previous summary for iterative update (like Hermes's _previous_summary)
    const previousProjections = listProcessedProjections(target.namespace, 'recent_summary');
    const previousSummary = previousProjections.length > 0 ? previousProjections[0].summary : undefined;

    // Compress with SDK (primary → backup → local fallback)
    const compressFn = this._compressor ?? compressWithSdk;
    let compression: CompressionResult;
    try {
      compression = await compressFn({
        events,
        previousSummary,
        modelConfig: this.modelConfig,
        targetTokens: 500,
      });
    } catch {
      // SDK completely failed — use local fallback summary
      compression = {
        summary: buildLocalFallback(events, previousSummary),
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
      };
    }

    // Decide whether this is a "final commit" or a "tentative save".
    // - SDK succeeded → commit (delete raw events, clear dirty, mark completed)
    // - SDK failed but retry budget remaining → tentative save (keep raw events,
    //   mark materialization_failed so next trigger retries with SDK)
    // - SDK failed AND retry budget exhausted → commit the fallback anyway
    //   (accept the coarse local summary to avoid unbounded growth)
    const priorFailures = countConsecutiveFailedJobs(target);
    const sdkFailed = !compression.fromSdk;
    const retryBudgetExhausted = priorFailures >= MAX_SDK_RETRY_ATTEMPTS;
    const shouldRetry = sdkFailed && !retryBudgetExhausted;

    // Remove prior tentative summaries before writing the new result.
    // - SDK succeeded on retry → replace tentative with proper summary
    // - SDK still failed → replace prior tentative with new tentative
    // - Retry budget exhausted → replace tentative with committed fallback
    if (priorFailures > 0) {
      deleteTentativeProjections(target.namespace, 'recent_summary');
    }

    const summaryProjection = writeProcessedProjection({
      namespace: target.namespace,
      class: 'recent_summary',
      sourceEventIds,
      summary: compression.summary,
      content: {
        trigger,
        targetKind: target.kind,
        sessionName: target.sessionName,
        primaryContextBackend: this.modelConfig.primaryContextBackend,
        primaryContextModel: this.modelConfig.primaryContextModel,
        backupContextBackend: this.modelConfig.backupContextBackend,
        backupContextModel: this.modelConfig.backupContextModel,
        compressionModel: compression.model,
        compressionBackend: compression.backend,
        compressionUsedBackup: compression.usedBackup,
        compressionFromSdk: compression.fromSdk,
        eventCount: events.length,
        hadPreviousSummary: !!previousSummary,
        tentative: shouldRetry,                    // marked as tentative when retrying
        retryAttempt: shouldRetry ? priorFailures + 1 : undefined,
      },
      createdAt: now,
      updatedAt: now,
    });
    const durableProjection = buildDurableProjection(target.namespace, events, now);

    // Only queue for replication if this is a final commit (not tentative)
    if (!shouldRetry) {
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
    } else {
      // Tentative: keep staged events for next retry. Don't clear dirty target.
      updateContextJob(job.id, 'materialization_failed', { now,
        error: `SDK compression unavailable (attempt ${priorFailures + 1}/${MAX_SDK_RETRY_ATTEMPTS}) — kept raw events for retry`,
      });
    }

    return {
      summaryProjection,
      durableProjection,
      replicationQueued: !shouldRetry,
      compression,
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

// Local fallback — reused when SDK compression is not called (e.g. tests, offline).
// Delegates to summary-compressor's shared fallback to keep logic in one place.
function buildLocalFallback(events: LocalContextEvent[], previousSummary?: string): string {
  return buildLocalFallbackSummary(events, previousSummary);
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

  if (decisions.length > 0) {
    lines.push(`- Key decisions: ${decisions.join('; ')}`);
  }
  if (constraints.length > 0) {
    lines.push(`- Constraints: ${constraints.join('; ')}`);
  }
  if (preferences.length > 0) {
    lines.push(`- Preferences: ${preferences.join('; ')}`);
  }
  return lines.join('\n');
}
