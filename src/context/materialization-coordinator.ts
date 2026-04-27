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
import { compressWithSdk, type CompressionResult } from './summary-compressor.js';
import { isMemoryNoiseSummary, isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';
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
  summaryProjection?: ProcessedContextProjection;
  durableProjection?: ProcessedContextProjection;
  replicationQueued: boolean;
  compression?: CompressionResult;
  filteredOut?: boolean;
}

const DEFAULT_THRESHOLDS: MaterializationThresholds = {
  idleMs: 5 * 60_000,
  // Raised from 5 → 20 to cut compression frequency. With spark-class
  // models priced per input token, summary-bloat (see PREVIOUS_SUMMARY_MAX_CHARS
  // in summary-compressor.ts) was making each call expensive; firing on every
  // 5 assistant turns burned the daily quota inside hours. 20-turn batches
  // still capture meaningful work units (a typical task ≈ 10–30 turns) while
  // reducing call count ~4×.
  eventCount: 20,
  scheduleMs: 15 * 60_000,
  minIntervalMs: 10_000,
};

/**
 * Max consecutive SDK failures before we abandon the current batch.
 * Beyond this, staged events are discarded and NO projection is written —
 * the previous real summary (if any) stays intact. This prevents the
 * "structured summary unavailable" local fallback from ever being
 * persisted to memory, which would otherwise compound across failures
 * (each new fallback prepends the previous one via `previousSummary`,
 * producing the nested "--- Updated ---" chains observed in the field).
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
    const events = allEvents.filter((e) => {
      if (!isMemoryEligibleEvent(e.eventType)) return false;
      if ((e.eventType === 'assistant.text' || e.eventType === 'assistant.turn') && isMemoryNoiseTurn(e.content)) return false;
      return true;
    });
    const sourceEventIds = allEvents.map((event) => event.id);
    const hadNoiseAssistantTurn = allEvents.some((event) =>
      (event.eventType === 'assistant.text' || event.eventType === 'assistant.turn') && isMemoryNoiseTurn(event.content),
    );
    const hasUsableAssistantTurn = events.some((event) => event.eventType === 'assistant.text' || event.eventType === 'assistant.turn');

    if (hadNoiseAssistantTurn && !hasUsableAssistantTurn) {
      deleteStagedEventsByIds(sourceEventIds);
      updateContextJob(job.id, 'completed', { now });
      clearDirtyTarget(target);
      return {
        replicationQueued: false,
        filteredOut: true,
      };
    }

    // Fetch previous summary for iterative update (like Hermes's _previous_summary)
    const previousProjections = listProcessedProjections(target.namespace, 'recent_summary');
    const previousSummary = previousProjections.length > 0 ? previousProjections[0].summary : undefined;

    // Compress with SDK (primary → backup). When all SDK attempts fail the
    // compressor still returns a CompressionResult (with `fromSdk: false` and
    // a local-fallback summary string) — but under the current design we
    // DISCARD that fallback text entirely. The coordinator never persists
    // non-SDK summaries, so the "⚠️ Structured summary unavailable" warning
    // can no longer leak into durable memory.
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
      // Compressor itself threw (not just a provider failure the compressor
      // swallowed into a local-fallback result). Treat as fromSdk: false and
      // let the abandonment/retry logic below decide what to do.
      compression = {
        summary: '',
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
      };
    }

    // Only SDK-produced summaries are ever filtered by `isMemoryNoiseSummary`.
    // A fromSdk: false result means "no real summary was produced" — the
    // fallback branch below owns that case; we don't treat it as noise.
    if (compression.fromSdk && isMemoryNoiseSummary(compression.summary)) {
      deleteTentativeProjections(target.namespace, 'recent_summary');
      deleteStagedEventsByIds(sourceEventIds);
      updateContextJob(job.id, 'completed', { now });
      clearDirtyTarget(target);
      return {
        replicationQueued: false,
        compression,
        filteredOut: true,
      };
    }

    // Three outcomes for the current batch:
    //   1. SDK succeeded                           → commit the real summary
    //   2. SDK failed, retry budget remaining      → keep staged events,
    //                                                 mark job failed for retry.
    //                                                 NO projection is written —
    //                                                 prior committed summary
    //                                                 (if any) remains untouched.
    //   3. SDK failed, retry budget exhausted      → abandon batch: discard
    //                                                 staged events, clear dirty
    //                                                 target, mark job completed.
    //                                                 NO projection is written;
    //                                                 the last real summary
    //                                                 (if any) stays intact.
    //
    // Rationale: the local-fallback summary text contains a user-visible
    // "⚠️ Structured summary unavailable" warning plus raw conversation
    // transcripts, and `buildLocalFallbackSummary` prepends the previous
    // summary + "--- Updated ---" on every call. Persisting it caused the
    // warning to compound across retries, polluting the memory store with
    // nested error banners. Choosing to store nothing on failure matches
    // the user intent: "a period of backend downtime means a gap in memory,
    // not a scar."
    const priorFailures = countConsecutiveFailedJobs(target);
    const sdkFailed = !compression.fromSdk;

    if (sdkFailed) {
      const retryBudgetExhausted = priorFailures >= MAX_SDK_RETRY_ATTEMPTS;
      // Any legacy tentative rows from earlier versions of this code get
      // scrubbed here — the new design never writes tentatives, so the only
      // tentative rows that can exist are pre-migration leftovers.
      deleteTentativeProjections(target.namespace, 'recent_summary');

      if (retryBudgetExhausted) {
        // Abandon batch: delete staged events, clear dirty target so we
        // don't keep re-triggering for the same data. Job status is
        // 'completed' (not 'materialization_failed') so the next fresh
        // batch starts with a clean failure counter.
        deleteStagedEventsByIds(sourceEventIds);
        updateContextJob(job.id, 'completed', { now,
          error: `SDK compression abandoned after ${priorFailures} consecutive failures — events discarded, no summary written`,
        });
        clearDirtyTarget(target);
        return {
          replicationQueued: false,
          compression,
          filteredOut: true,
        };
      }

      // Retry path: keep staged events, leave dirty target in place, mark
      // job materialization_failed so the next trigger retries SDK.
      updateContextJob(job.id, 'materialization_failed', { now,
        error: `SDK compression unavailable (attempt ${priorFailures + 1}/${MAX_SDK_RETRY_ATTEMPTS}) — kept raw events for retry`,
      });
      return {
        replicationQueued: false,
        compression,
      };
    }

    // SDK succeeded — commit the real summary. Also scrub any legacy
    // tentative rows that might have been left behind by prior code.
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
      },
      createdAt: now,
      updatedAt: now,
    });
    const durableProjection = buildDurableProjection(
      target.namespace,
      events,
      compression.summary,
      sourceEventIds,
      now,
    );

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

function buildDurableProjection(
  namespace: ContextNamespace,
  events: LocalContextEvent[],
  summary: string,
  sourceEventIds: string[],
  now: number,
): ProcessedContextProjection | undefined {
  const extracted = extractDurableSignalsFromSummary(summary);
  const fallback = extractDurableSignalsFromEvents(events);
  const signals = {
    decisions: extracted.decisions.length > 0 ? extracted.decisions : fallback.decisions,
    constraints: extracted.constraints.length > 0 ? extracted.constraints : fallback.constraints,
    preferences: extracted.preferences.length > 0 ? extracted.preferences : fallback.preferences,
  };
  const candidateCount = signals.decisions.length + signals.constraints.length + signals.preferences.length;
  if (candidateCount === 0) return undefined;
  return writeProcessedProjection({
    namespace,
    class: 'durable_memory_candidate',
    sourceEventIds,
    summary: buildDurableSummary(signals),
    content: {
      candidateKinds: [
        ...(signals.decisions.length > 0 ? ['decision'] : []),
        ...(signals.constraints.length > 0 ? ['constraint'] : []),
        ...(signals.preferences.length > 0 ? ['preference'] : []),
      ],
      count: candidateCount,
      durableSignals: signals,
      source: extracted.decisions.length > 0 || extracted.constraints.length > 0 || extracted.preferences.length > 0
        ? 'summary'
        : 'events',
    },
    createdAt: now,
    updatedAt: now,
  });
}

function extractDurableSignalsFromEvents(events: LocalContextEvent[]): DurableSignals {
  const grouped = new Map<string, string[]>();
  for (const event of events) {
    if (event.eventType !== 'decision' && event.eventType !== 'constraint' && event.eventType !== 'preference') continue;
    const content = event.content?.trim();
    if (!content) continue;
    const items = grouped.get(event.eventType) ?? [];
    if (!items.includes(content)) items.push(content);
    grouped.set(event.eventType, items);
  }

  return {
    decisions: grouped.get('decision') ?? [],
    constraints: grouped.get('constraint') ?? [],
    preferences: grouped.get('preference') ?? [],
  };
}

type DurableSignals = {
  decisions: string[];
  constraints: string[];
  preferences: string[];
};

function extractDurableSignalsFromSummary(summary: string): DurableSignals {
  const signals: DurableSignals = { decisions: [], constraints: [], preferences: [] };

  const decisionsSection = extractSummarySection(summary, 'Key Decisions');
  if (decisionsSection) {
    const lines = decisionsSection
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const normalized = line.replace(/^[*-]\s*/, '').trim();
      if (!normalized) continue;
      if (/^key decisions?:/i.test(normalized)) {
        pushDurableItems(signals.decisions, normalized.replace(/^key decisions?:/i, '').trim());
        continue;
      }
      if (/^constraints?:/i.test(normalized)) {
        pushDurableItems(signals.constraints, normalized.replace(/^constraints?:/i, '').trim());
        continue;
      }
      if (/^preferences?:/i.test(normalized)) {
        pushDurableItems(signals.preferences, normalized.replace(/^preferences?:/i, '').trim());
        continue;
      }
      pushUnique(signals.decisions, normalized);
    }
  }

  // User-Pinned Notes: content the user explicitly asked us to remember
  // (in any language — the compressor prompt recognises the INTENT, not a
  // keyword list). Each non-empty line is promoted to a durable preference
  // verbatim so "记住 X" survives both compression AND the durable-memory
  // promotion filter. Preferences is the right bucket because these are
  // user-authored instructions that persist across sessions; decisions and
  // constraints have implementation-specific semantics the user didn't
  // necessarily intend.
  const pinnedSection = extractSummarySection(summary, 'User-Pinned Notes');
  if (pinnedSection) {
    const lines = pinnedSection
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      // Strip leading bullet markers but otherwise keep the line EXACTLY as
      // the compressor produced it — the compressor is already instructed
      // to preserve the user's original words.
      const normalized = line.replace(/^[*-]\s*/, '').trim();
      if (!normalized) continue;
      pushUnique(signals.preferences, normalized);
    }
  }

  return signals;
}

/** Extract the body of a `## <title>` section up to the next `## ` or EOF. */
function extractSummarySection(summary: string, title: string): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, 'i');
  const match = summary.match(re);
  return match?.[1]?.trim() ?? null;
}

function pushDurableItems(bucket: string[], value: string): void {
  if (!value) return;
  for (const part of value.split(/\s*;\s*/)) {
    pushUnique(bucket, part.trim());
  }
}

function pushUnique(bucket: string[], value: string): void {
  if (!value || bucket.includes(value)) return;
  bucket.push(value);
}

function buildDurableSummary(signals: DurableSignals): string {
  const decisions = signals.decisions;
  const constraints = signals.constraints;
  const preferences = signals.preferences;

  const lines: string[] = [];

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
