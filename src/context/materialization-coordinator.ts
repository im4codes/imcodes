import type {
  ContextDirtyTarget,
  ContextJobRecord,
  ContextJobTrigger,
  ContextModelConfig,
  ContextNamespace,
  ContextReplicationState,
  ContextTargetRef,
  LocalContextEvent,
  ProcessedContextProjection,
} from '../../shared/context-types.js';
import { isMemoryEligibleEvent } from '../../shared/context-types.js';
import { getContextModelConfig } from './context-model-config.js';
import { CompressionAdmissionClosedError, compressWithSdk, computeTargetTokens, type CompressionResult } from './summary-compressor.js';
import { isMemoryNoiseSummary, isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';
import type {
  IngestContextEventResult,
  LatestRecentSummarySession,
  MaterializationCommitInput,
  MaterializationCommitResult,
  PinnedNote,
  WriteProcessedProjectionInput,
} from '../store/context-store.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { CONTEXT_STORE_RPC_TIMEOUT_MS } from '../../shared/context-store-rpc.js';
import { serializeContextNamespace, serializeContextTarget } from './context-keys.js';
import { countTokens } from './tokenizer.js';
import { loadMemoryConfig, type MemoryConfig } from './memory-config.js';
import { createMemoryConfigResolver, resolveMemoryConfigForNamespace, type MemoryConfigResolver } from './memory-config-resolver.js';
import { computeFingerprint } from '../../shared/memory-fingerprint.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import { redactSummaryPreservingPinned } from '../util/redact-with-pinned-region.js';
import { ensureProjectionEmbeddingForProjection } from './projection-embedding-maintenance.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import {
  decideSkillReviewSchedule,
  type SkillReviewSchedulerPolicy,
  type SkillReviewState,
} from '../../shared/skill-review-scheduler.js';
import type { SkillReviewTrigger } from '../../shared/skill-review-triggers.js';
import {
  MEMORY_FEATURE_FLAGS_BY_NAME,
  memoryFeatureFlagEnvKey,
  resolveMemoryFeatureFlagValue,
} from '../../shared/feature-flags.js';
import {
  getMemoryFeatureConfigStoreDiagnostics,
  getPersistedMemoryFeatureFlagValues,
  getRuntimeMemoryFeatureFlagValues,
} from '../store/memory-feature-config-store.js';

/** Archive-write override hook. The injected test form is synchronous; the
 *  default coordinator implementation routes through the async client and may
 *  return a Promise — callers `await` the result so both shapes are safe. */
type ArchiveEventsForMaterializationFn = (events: LocalContextEvent[], archivedAt?: number) => void | Promise<void>;
/** Atomic materialization commit override hook (sync injected form, async
 *  client-routed default). */
type CommitMaterializationFn = (input: MaterializationCommitInput) => MaterializationCommitResult | Promise<MaterializationCommitResult>;

export interface MaterializationThresholds {
  autoTriggerTokens: number;
  minEventCount: number;
  idleMs: number;
  scheduleMs: number;
  maxBatchTokens: number;
  minIntervalMs: number;
  /** Legacy count-only trigger kept for older tests/configs. Prefer minEventCount + token/idle/schedule. */
  eventCount?: number;
}

export interface MaterializationCoordinatorOptions {
  thresholds?: Partial<MaterializationThresholds>;
  modelConfig?: Partial<ContextModelConfig>;
  /** Project cwd used to discover .imc/memory.yaml; defaults to process.cwd(). */
  memoryConfigCwd?: string;
  /** Explicit memory config override for tests/embedded callers. */
  memoryConfig?: MemoryConfig;
  /** Per-target/project resolver; preferred for multi-project daemons. */
  memoryConfigResolver?: MemoryConfigResolver;
  /** Override the SDK compressor (for testing or environments without SDK access). */
  compressor?: (input: import('./summary-compressor.js').CompressionInput) => Promise<import('./summary-compressor.js').CompressionResult>;
  /** Override archive writes for failure-injection tests. */
  archiveEventsForMaterialization?: ArchiveEventsForMaterializationFn;
  /** Override the atomic materialization commit (for failure/crash-injection tests). */
  commitMaterialization?: CommitMaterializationFn;
  /**
   * Optional post-response skill review scheduler. The coordinator invokes it
   * only after SDK-backed materialization has completed, so auto-creation stays
   * on the existing isolated background path and never enters the send ack or
   * provider-delivery foreground paths.
   */
  skillReviewScheduler?: MaterializationSkillReviewScheduler;
  /** Gate self-learning durable extraction/classification; defaults to the shared feature flag (default off). */
  selfLearningEnabled?: boolean | (() => boolean);
}

export interface MaterializationResult {
  summaryProjection?: ProcessedContextProjection;
  durableProjection?: ProcessedContextProjection;
  replicationQueued: boolean;
  compression?: CompressionResult;
  filteredOut?: boolean;
}

export interface MaterializationSkillReviewJob {
  idempotencyKey: string;
  scopeKey: string;
  responseId: string;
  trigger: SkillReviewTrigger;
  target: ContextTargetRef;
  projectionId: string;
  sourceEventIds: readonly string[];
  nextAttemptAt: number;
  maxAttempts: number;
  createdAt: number;
}

interface SkillReviewTriggerEvidence {
  toolIterationCount: number;
}

export interface MaterializationSkillReviewScheduler {
  featureEnabled: boolean | (() => boolean);
  getState: (scopeKey: string) => SkillReviewState;
  enqueue: (job: MaterializationSkillReviewJob) => void | Promise<void>;
  policy?: Partial<SkillReviewSchedulerPolicy>;
  isShuttingDown?: () => boolean;
}

const DEFAULT_THRESHOLDS: MaterializationThresholds = {
  autoTriggerTokens: 3000,
  minEventCount: 5,
  idleMs: 5 * 60_000,
  scheduleMs: 15 * 60_000,
  maxBatchTokens: 10_000,
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
const MAX_SKILL_REVIEW_EVIDENCE_TARGETS = 256;

export class MaterializationCoordinator {
  readonly thresholds: MaterializationThresholds;
  readonly modelConfig: ContextModelConfig;
  readonly memoryConfig: MemoryConfig;
  private readonly resolveMemoryConfig: MemoryConfigResolver;
  private readonly thresholdOverrides: Partial<MaterializationThresholds>;
  private readonly _compressor: MaterializationCoordinatorOptions['compressor'];
  private readonly _archiveEventsForMaterialization: ArchiveEventsForMaterializationFn;
  private readonly _commitMaterialization: CommitMaterializationFn;
  /** True when a test injected `commitMaterialization` — then we always use the
   *  injected fn and never route to the worker. */
  private readonly _commitMaterializationIsOverride: boolean;
  private readonly _skillReviewScheduler?: MaterializationSkillReviewScheduler;
  private readonly _selfLearningEnabled?: boolean | (() => boolean);
  private readonly skillReviewEvidenceByTarget = new Map<string, SkillReviewTriggerEvidence>();

  constructor(options?: MaterializationCoordinatorOptions) {
    this._compressor = options?.compressor;
    // Default archive/commit paths route through the centralized async client
    // (worker when warm, in-process cold fallback otherwise) — no direct
    // context-store import. Injected test overrides bypass the client entirely.
    this._archiveEventsForMaterialization = options?.archiveEventsForMaterialization
      ?? ((events, archivedAt) => getContextStoreClient().run<void>('archiveEventsForMaterialization', [events, archivedAt ?? Date.now()]));
    // The default commit routes through the async client (worker when warm via
    // runMaterializationCommit; in-process cold fallback here). An injected
    // override bypasses the client entirely.
    this._commitMaterialization = options?.commitMaterialization
      ?? ((input) => getContextStoreClient().run<MaterializationCommitResult>('commitMaterialization', [input], { timeoutMs: CONTEXT_STORE_RPC_TIMEOUT_MS.r4Background }));
    this._commitMaterializationIsOverride = options?.commitMaterialization !== undefined;
    this._skillReviewScheduler = options?.skillReviewScheduler;
    this._selfLearningEnabled = options?.selfLearningEnabled;
    this.resolveMemoryConfig = options?.memoryConfigResolver ?? createMemoryConfigResolver({
      fixedConfig: options?.memoryConfig,
      fallbackCwd: options?.memoryConfigCwd,
    });
    this.memoryConfig = options?.memoryConfig
      ?? (options?.memoryConfigCwd
        ? loadMemoryConfig(options.memoryConfigCwd)
        : resolveMemoryConfigForNamespace({ scope: 'personal', projectId: '__default__' }));
    this.modelConfig = getContextModelConfig(options?.modelConfig);
    // materializationMinIntervalMs from cloud config overrides the threshold default.
    // Project .imc/memory.yaml supplies memory-pipeline defaults underneath
    // explicit constructor overrides.
    this.thresholdOverrides = options?.thresholds ?? {};
    this.thresholds = this.buildThresholds(this.memoryConfig);
    // No store touch in the constructor: the daemon main thread must never open
    // the DB, and routing a prune through the worker here would either spawn it
    // mid-flow (warm-partway WAL race) or no-op when cold. The archive prune is
    // covered by the periodic `scheduleDueTargets` path (worker-routed) and the
    // worker's own archive-backfill timer (task 3.4).
  }

  async ingestEvent(input: Omit<LocalContextEvent, 'id' | 'createdAt'> & Partial<Pick<LocalContextEvent, 'id' | 'createdAt'>>): Promise<{
    event: LocalContextEvent;
    queuedJob?: ContextJobRecord;
    trigger?: ContextJobTrigger;
    filtered?: boolean;
  }> {
    // Only memory-eligible events (assistant.text) count toward materialization
    // triggers; streaming deltas / tool calls / system events are excluded.
    const eligible = isMemoryEligibleEvent(input.eventType);
    const client = getContextStoreClient();
    // ONE aggregate RPC: always record to staging, and (for eligible events) read
    // the dirty target + staged-token upper bound + latest recent-summary
    // timestamp — so per-event ingestion makes a single worker round trip off the
    // daemon main thread instead of 2–3 separate calls. In-process fallback when
    // the worker is not warm.
    const agg = await client.run<IngestContextEventResult>(
      'ingestContextEvent', [input, eligible],
    );
    const event = agg.event;
    if (!eligible) return { event, filtered: true };
    if (!agg.dirtyTarget) return { event };
    // The trigger DECISION uses in-memory threshold/rate-limit state, so it stays
    // here, fed by the data the aggregate already read.
    const trigger = this.decideTrigger(
      agg.dirtyTarget,
      event.createdAt,
      this.thresholdsForTarget(agg.dirtyTarget.target),
      agg.stagedTokenUpperBound,
      agg.latestSummaryUpdatedAt,
    );
    if (!trigger) return { event };
    const jobType = input.target.kind === 'project' ? 'materialize_project' : 'materialize_session';
    const queuedJob = await client.run<ContextJobRecord>(
      'enqueueContextJob', [input.target, jobType, trigger, event.createdAt],
    );
    return { event, queuedJob, trigger };
  }

  async listDirtyTargets(namespace?: ContextNamespace): Promise<ContextDirtyTarget[]> {
    return getContextStoreClient().run<ContextDirtyTarget[]>('listDirtyTargets', [namespace]);
  }

  recordSkillReviewToolIteration(target: ContextTargetRef, count = 1): void {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount <= 0) return;
    const targetKey = serializeContextTarget(target);
    const current = this.skillReviewEvidenceByTarget.get(targetKey)?.toolIterationCount ?? 0;
    if (!this.skillReviewEvidenceByTarget.has(targetKey) && this.skillReviewEvidenceByTarget.size >= MAX_SKILL_REVIEW_EVIDENCE_TARGETS) {
      const oldestKey = this.skillReviewEvidenceByTarget.keys().next().value as string | undefined;
      if (oldestKey) {
        this.skillReviewEvidenceByTarget.delete(oldestKey);
        incrementCounter('mem.skill.evidence_evicted', { reason: 'lru_limit' });
      }
    }
    this.skillReviewEvidenceByTarget.set(targetKey, {
      toolIterationCount: Math.min(1_000_000, current + safeCount),
    });
  }

  recordFilteredSkillReviewToolIteration(reason: 'hidden' | 'error'): void {
    incrementCounter('mem.skill.evidence_filtered', { reason });
  }

  /** Run the atomic materialization commit — in the context-store worker when it
   *  is warm (so the heavy transaction stays off the daemon main thread), else
   *  via the async client's in-process cold fallback (no direct store import). A
   *  test-injected `commitMaterialization` always runs locally. */
  private async runMaterializationCommit(input: MaterializationCommitInput): Promise<MaterializationCommitResult> {
    if (!this._commitMaterializationIsOverride) {
      const client = getContextStoreClient();
      if (client.isReady) {
        try {
          return await client.call<MaterializationCommitResult>(
            'commitMaterialization',
            [input],
            { timeoutMs: CONTEXT_STORE_RPC_TIMEOUT_MS.r4Background },
          );
        } catch {
          // Worker failed/timeout — fall back to the in-process cold path below.
        }
      }
    }
    return this._commitMaterialization(input);
  }

  async materializeTarget(target: ContextTargetRef, trigger: ContextJobTrigger, now = Date.now()): Promise<MaterializationResult> {
    const memoryConfig = this.configForTarget(target);
    const jobType = target.kind === 'project' ? 'materialize_project' : 'materialize_session';
    // Run the whole job lifecycle (create → running → … → completed) on the
    // worker when warm, so the materialization job row is owned by one
    // connection; in-process fallback when not ready.
    const client = getContextStoreClient();
    const job = await client.run<ContextJobRecord>(
      'enqueueContextJob', [target, jobType, trigger, now],
    );
    await client.run<void>(
      'updateContextJob', [job.id, 'running', { attemptIncrement: true, now }],
    );
    // Heavy reads run in the worker when warm (staged events can be large), off
    // the daemon main thread; in-process fallback when not ready.
    const allEvents = await client.run<LocalContextEvent[]>(
      'listContextEvents', [target],
    );
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
      await this._archiveEventsForMaterialization(allEvents, now);
      await client.run<void>('deleteStagedEventsByIds', [sourceEventIds]);
      await client.run<void>('updateContextJob', [job.id, 'completed', { now }]);
      await client.run<void>('clearDirtyTarget', [target]);
      return {
        replicationQueued: false,
        filteredOut: true,
      };
    }

    // Recent summaries are delta-only. Do not feed the previous recent summary
    // back into the compressor, or every small batch snowballs into another
    // full handoff and burns tokens when synced into sub-sessions.
    const previousProjections = (await client.run<ProcessedContextProjection[]>(
      'listProcessedProjections', [target.namespace, 'recent_summary'],
    )).filter((projection) => projection.status !== 'archived' && projection.status !== 'archived_dedup');
    const hadPreviousSummary = previousProjections.length > 0;

    // Compress with SDK (primary → backup). When all SDK attempts fail the
    // compressor still returns a CompressionResult (with `fromSdk: false` and
    // a local-fallback summary string) — but under the current design we
    // DISCARD that fallback text entirely. The coordinator never persists
    // non-SDK summaries, so the "⚠️ Structured summary unavailable" warning
    // can no longer leak into durable memory.
    const compressFn = this._compressor ?? compressWithSdk;
    let compression: CompressionResult;
    try {
      const pinnedNotes = await collectPinnedNotesForNamespace(target.namespace);
      compression = await compressFn({
        events,
        previousSummary: undefined,
        modelConfig: this.modelConfig,
        mode: 'auto',
        targetTokens: memoryConfig.autoMaterializationTargetTokens > 0
          ? memoryConfig.autoMaterializationTargetTokens
          : computeTargetTokens(countTokens(events.map((event) => event.content ?? '').join('\n')), 'auto'),
        maxEventChars: memoryConfig.maxEventChars,
        previousSummaryMaxTokens: memoryConfig.previousSummaryMaxTokens,
        extraRedactPatterns: memoryConfig.extraRedactPatterns,
        pinnedNotes,
        ...(target.sessionName ? {
          watchdogSessionName: target.sessionName,
          watchdogTrigger: trigger,
          watchdogEventCount: events.length,
        } : {}),
      });
    } catch (error) {
      if (error instanceof CompressionAdmissionClosedError) {
        await client.run<void>('updateContextJob', [job.id, 'materialization_failed', { now,
          error: `compression_admission_closed: ${error.reason} — kept raw events for retry`,
        }]);
        incrementCounter('mem.materialization.compression_admission_closed', { reason: error.reason });
        // Round-2 audit (0699ea64-3e6 finding A2/Commit B): admission_closed
        // path used to early-return WITHOUT recording in
        // context_compression_runs, leaving the schema's CHECK enum value
        // 'admission_closed' as dead schema. Operators querying "how often
        // does the upgrade-pending freeze block compactions" couldn't
        // answer it. Now we record an SQLite row so the metric is queryable
        // — but we explicitly do NOT emit a timeline event (would be chat
        // noise: "nothing happened, but here's an event saying so").
        try {
          await client.run<void>('recordCompressionRun', [{
            backend: 'none',
            model: '',
            usedBackup: false,
            fromSdk: false,
            namespaceKey: serializeContextNamespace(target.namespace),
            targetKind: target.kind,
            sessionName: target.sessionName ?? null,
            trigger,
            mode: 'auto',
            eventCount: events.length,
            inputTokens: 0,
            outputTokens: 0,
            targetTokens: 0,
            durationMs: 0,
            outcome: 'admission_closed',
            errorCode: error.reason,
            errorMessage: null,
          }]);
        } catch { /* never escape */ }
        return {
          replicationQueued: false,
        };
      }
      // Compressor itself threw (not just a provider failure the compressor
      // swallowed into a local-fallback result). Treat as fromSdk: false and
      // let the abandonment/retry logic below decide what to do.
      const errMsg = error instanceof Error ? error.message : String(error);
      compression = {
        summary: '',
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
        inputTokens: 0,
        outputTokens: 0,
        targetTokens: 0,
        durationMs: 0,
        errorMessage: errMsg.slice(0, 500),
      };
    }

    // Persist a row in context_compression_runs so operators can query
    // model/token costs later. Best-effort — recording failures must never
    // break compression; recordCompressionRun swallows internally.
    //
    // Round-2 audit (0699ea64-3e6 finding A2/Commit B): when events.length===0
    // the compressor early-returns a fromSdk:false CompressionResult that
    // used to be recorded as outcome='fallback' (because errorCode is also
    // unset). That polluted SUM(outcome='fallback') analytics — those rows
    // weren't real fallbacks, just no-ops. Skip recording + emit entirely
    // for the no-op case; the path produces no projection and no LLM call,
    // so there is nothing useful to log for cost analysis.
    const outcome: 'success' | 'fallback' | 'error' = compression.fromSdk
      ? (compression.usedBackup ? 'fallback' : 'success')
      : (compression.errorCode || compression.errorMessage ? 'error' : 'fallback');
    if (events.length > 0) {
      try {
        await client.run<void>('recordCompressionRun', [{
          backend: compression.backend,
          model: compression.model,
          usedBackup: compression.usedBackup,
          fromSdk: compression.fromSdk,
          namespaceKey: serializeContextNamespace(target.namespace),
          targetKind: target.kind,
          sessionName: target.sessionName ?? null,
          trigger,
          mode: 'auto',
          eventCount: events.length,
          inputTokens: compression.inputTokens ?? 0,
          outputTokens: compression.outputTokens ?? 0,
          targetTokens: compression.targetTokens ?? 0,
          durationMs: compression.durationMs ?? 0,
          outcome,
          errorCode: compression.errorCode ?? null,
          errorMessage: compression.errorMessage ?? null,
        }]);
      } catch {
        // Telemetry must never escape — recordCompressionRun already swallows
        // its own errors, but defense-in-depth.
      }
    }

    // Emit a `memory.compression` timeline event so the user can see in chat
    // history that a compression just ran (web UI renders it COLLAPSED by
    // default, click to expand). Persisted to JSONL via the timeline store.
    // Only emit when we have a session-bound target — namespace-only
    // (project-level) compactions don't have a chat thread to attach to.
    // Same events.length>0 guard as the SQLite recording above.
    if (target.sessionName && events.length > 0) {
      try {
        timelineEmitter.emit(
          target.sessionName,
          'memory.compression',
          {
            backend: compression.backend,
            model: compression.model,
            usedBackup: compression.usedBackup,
            fromSdk: compression.fromSdk,
            trigger,
            mode: 'auto',
            eventCount: events.length,
            inputTokens: compression.inputTokens ?? 0,
            outputTokens: compression.outputTokens ?? 0,
            targetTokens: compression.targetTokens ?? 0,
            durationMs: compression.durationMs ?? 0,
            outcome,
            ...(compression.errorCode ? { errorCode: compression.errorCode } : {}),
          },
          { source: 'daemon', confidence: 'high' },
        );
      } catch {
        // Timeline emit must never escape compression.
      }
    }

    // Only SDK-produced summaries are ever filtered by `isMemoryNoiseSummary`.
    // A fromSdk: false result means "no real summary was produced" — the
    // fallback branch below owns that case; we don't treat it as noise.
    if (compression.fromSdk && isMemoryNoiseSummary(compression.summary)) {
      await client.run<number>('deleteTentativeProjections', [target.namespace, 'recent_summary']);
      await this._archiveEventsForMaterialization(allEvents, now);
      await client.run<void>('deleteStagedEventsByIds', [sourceEventIds]);
      await client.run<void>('updateContextJob', [job.id, 'completed', { now }]);
      await client.run<void>('clearDirtyTarget', [target]);
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
    const priorFailures = await client.run<number>('countConsecutiveFailedJobs', [target]);
    const sdkFailed = !compression.fromSdk;

    if (sdkFailed) {
      // Round-2 audit (0699ea64-3e6 finding android#1/Commit B):
      // `priorFailures >= MAX_SDK_RETRY_ATTEMPTS` was off-by-one — the comparison
      // didn't include the CURRENT failure, so the constant `3` actually meant
      // "permit 3 prior failures + give up on the 4th". Operators reading
      // `attempt 3/3` reasonably expected "next failure ends the batch", but
      // the daemon would still try once more. Counting the current failure
      // (priorFailures + 1) makes the constant match its name.
      const totalFailuresIncludingCurrent = priorFailures + 1;
      const retryBudgetExhausted = totalFailuresIncludingCurrent >= MAX_SDK_RETRY_ATTEMPTS;
      // Any legacy tentative rows from earlier versions of this code get
      // scrubbed here — the new design never writes tentatives, so the only
      // tentative rows that can exist are pre-migration leftovers.
      await client.run<number>('deleteTentativeProjections', [target.namespace, 'recent_summary']);

      if (retryBudgetExhausted) {
        // Abandon batch: delete staged events, clear dirty target so we
        // don't keep re-triggering for the same data. Job status is
        // 'completed' (not 'materialization_failed') so the next fresh
        // batch starts with a clean failure counter.
        await this._archiveEventsForMaterialization(allEvents, now);
        incrementCounter('mem.materialization.retry_exhausted_archived', { source: 'materializeTarget' });
        await client.run<void>('deleteStagedEventsByIds', [sourceEventIds]);
        await client.run<void>('updateContextJob', [job.id, 'completed', { now,
          error: `SDK compression abandoned after ${totalFailuresIncludingCurrent} consecutive failures — events discarded, no summary written`,
        }]);
        await client.run<void>('clearDirtyTarget', [target]);
        return {
          replicationQueued: false,
          compression,
          filteredOut: true,
        };
      }

      // Retry path: keep staged events, leave dirty target in place, mark
      // job materialization_failed so the next trigger retries SDK.
      await client.run<void>('updateContextJob', [job.id, 'materialization_failed', { now,
        error: `SDK compression unavailable (attempt ${totalFailuresIncludingCurrent}/${MAX_SDK_RETRY_ATTEMPTS}) — kept raw events for retry`,
      }]);
      return {
        replicationQueued: false,
        compression,
      };
    }

    // SDK succeeded — commit the real summary. Also scrub any legacy
    // tentative rows that might have been left behind by prior code.
    if (priorFailures > 0) {
      await client.run<number>('deleteTentativeProjections', [target.namespace, 'recent_summary']);
    }

    // Build the summary projection input (written atomically below).
    const summaryInput: WriteProcessedProjectionInput = {
      namespace: target.namespace,
      class: 'recent_summary',
      origin: 'chat_compacted',
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
        hadPreviousSummary,
      },
      createdAt: now,
      updatedAt: now,
    };

    // Optional durable candidate input (best-effort: a build/extraction failure
    // yields no durable input and never blocks the summary commit).
    let durableInput: WriteProcessedProjectionInput | undefined;
    if (this.isSelfLearningEnabled()) {
      try {
        durableInput = buildDurableProjectionInput(target.namespace, events, compression.summary, sourceEventIds, now);
      } catch (error) {
        incrementCounter('mem.materialization.durable_projection_failed', { source: 'materializeTarget' });
        warnOncePerHour('mem.materialization.durable_projection_failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const replicationState = await client.run<ContextReplicationState | undefined>(
      'getReplicationState', [target.namespace],
    );

    // Atomic commit bundle: archive events + write summary (+ durable) + set
    // replication + delete staged + complete job + clear dirty in ONE SQLite
    // transaction. A crash mid-bundle leaves NO half-committed state (no
    // duplicate projection, no lost/orphaned staged events). compressWithSdk
    // already ran above, OUTSIDE any transaction.
    let commit: MaterializationCommitResult;
    try {
      commit = await this.runMaterializationCommit({
        archiveEvents: allEvents,
        archivedAt: now,
        summaryProjection: summaryInput,
        durableProjection: durableInput,
        replication: {
          namespace: target.namespace,
          priorPendingProjectionIds: replicationState?.pendingProjectionIds ?? [],
          lastReplicatedAt: replicationState?.lastReplicatedAt,
          lastError: replicationState?.lastError,
        },
        deleteStagedEventIds: sourceEventIds,
        completeJobId: job.id,
        completedAt: now,
        clearDirty: target,
      });
    } catch (error) {
      // The whole bundle rolled back atomically — staged events remain, so the
      // target re-materializes cleanly on retry (no duplicate).
      await client.run<void>('updateContextJob', [job.id, 'materialization_failed', { now,
        error: `commit_failed: ${error instanceof Error ? error.message : String(error)}`,
      }]);
      incrementCounter('mem.materialization.commit_failed', { source: 'materializeTarget' });
      warnOncePerHour('mem.materialization.commit_failed', { error: error instanceof Error ? error.message : String(error) });
      return {
        replicationQueued: false,
        compression,
      };
    }

    const summaryProjection = commit.summaryProjection;
    const durableProjection = commit.durableProjection;
    // Best-effort write-time embeddings (OUTSIDE the transaction) so the next
    // semantic recall reads a precomputed BLOB. Never awaited — must not add
    // latency to materialization.
    void ensureProjectionEmbeddingForProjection(summaryProjection);
    if (durableProjection) void ensureProjectionEmbeddingForProjection(durableProjection);
    this.schedulePostResponseSkillReview({
      target,
      projectionId: summaryProjection.id,
      sourceEventIds,
      now,
    });

    return {
      summaryProjection,
      durableProjection,
      replicationQueued: true,
      compression,
    };
  }

  async scheduleDueTargets(now = Date.now()): Promise<ContextJobRecord[]> {
    const client = getContextStoreClient();
    // Best-effort archive prune (a prune failure must never block scheduling).
    // Route via `run` (not `fireAndForget`) so we don't eagerly spawn/warm a
    // cold worker mid-flow — `run` reuses the warm worker when present and falls
    // back in-process otherwise, keeping this scheduling pass on one path.
    try {
      await client.run<{ deleted: number; skipped: boolean }>('pruneArchiveIfDue', [this.memoryConfig.archiveRetentionDays, now]);
    } catch {
      // ignore — best-effort
    }
    const queued: ContextJobRecord[] = [];
    for (const target of await client.run<ContextDirtyTarget[]>('listDirtyTargets', [undefined])) {
      const trigger = await this.selectTrigger(target, now);
      if (!trigger) continue;
      const jobType = target.target.kind === 'project' ? 'materialize_project' : 'materialize_session';
      queued.push(await client.run<ContextJobRecord>('enqueueContextJob', [target.target, jobType, trigger, now]));
    }
    return queued;
  }

  async listProcessed(namespace: ContextNamespace): Promise<ProcessedContextProjection[]> {
    return getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace]);
  }

  async materializeDueMasterSummaries(now = Date.now()): Promise<ProcessedContextProjection[]> {
    const client = getContextStoreClient();
    const due: ProcessedContextProjection[] = [];
    for (const item of await client.run<LatestRecentSummarySession[]>('listLatestRecentSummarySessions', [1000])) {
      const itemMemoryConfig = this.resolveMemoryConfig(item.namespace);
      const idleMs = Math.max(0, itemMemoryConfig.masterIdleHours) * 60 * 60 * 1000;
      const lastMasterUpdatedAt = await client.run<number | undefined>('getLatestMasterSummaryUpdatedAt', [item.sessionName, item.namespace]);
      if (lastMasterUpdatedAt !== undefined && lastMasterUpdatedAt >= item.updatedAt) continue;
      if (idleMs > 0 && now - item.updatedAt < idleMs) continue;
      const projection = await materializeMasterSummary(item.sessionName, item.namespace, now, itemMemoryConfig);
      if (projection) due.push(projection);
    }
    return due;
  }


  private schedulePostResponseSkillReview(input: {
    target: ContextTargetRef;
    projectionId: string;
    sourceEventIds: readonly string[];
    now: number;
  }): void {
    const scheduler = this._skillReviewScheduler;
    if (!scheduler) return;
    try {
      const featureEnabled = typeof scheduler.featureEnabled === 'function'
        ? scheduler.featureEnabled()
        : scheduler.featureEnabled;
      const scopeKey = serializeContextNamespace(input.target.namespace);
      const targetKey = serializeContextTarget(input.target);
      const triggerEvidence = this.skillReviewEvidenceByTarget.get(targetKey) ?? { toolIterationCount: 0 };
      const responseId = [...input.sourceEventIds].reverse().find((id) => id.trim().length > 0)
        ?? input.projectionId;
      const decision = decideSkillReviewSchedule({
        featureEnabled,
        delivered: true,
        phase: 'post_response_background',
        trigger: 'tool_iteration_count',
        scopeKey,
        responseId,
        now: input.now,
        state: scheduler.getState(scopeKey),
        policy: scheduler.policy,
        shuttingDown: scheduler.isShuttingDown?.() ?? false,
        triggerEvidence,
      });
      this.skillReviewEvidenceByTarget.delete(targetKey);
      if (decision.action === 'skip') {
        if (decision.reason === 'coalesced') {
          incrementCounter('mem.skill.review_deduped', { source: 'materialization' });
        } else if (decision.reason === 'below_trigger_threshold'
          || decision.reason === 'invalid_trigger'
          || decision.reason === 'not_delivered'
          || decision.reason === 'not_background') {
          incrementCounter('mem.skill.review_not_eligible', { reason: decision.reason });
        } else if (decision.reason !== 'disabled' && decision.reason !== 'shutdown') {
          incrementCounter('mem.skill.review_throttled', { reason: decision.reason });
        }
        return;
      }
      const job: MaterializationSkillReviewJob = {
        idempotencyKey: decision.idempotencyKey,
        scopeKey,
        responseId,
        trigger: 'tool_iteration_count',
        target: input.target,
        projectionId: input.projectionId,
        sourceEventIds: [...input.sourceEventIds],
        nextAttemptAt: decision.nextAttemptAt,
        maxAttempts: decision.maxAttempts,
        createdAt: input.now,
      };
      void Promise.resolve(scheduler.enqueue(job)).catch((error) => {
        incrementCounter('mem.skill.review_failed', { source: 'materialization_enqueue' });
        warnOncePerHour('mem.skill.review_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      incrementCounter('mem.skill.review_failed', { source: 'materialization_schedule' });
      warnOncePerHour('mem.skill.review_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** PURE trigger decision from already-read store data + in-memory thresholds.
   *  Shared by the per-event aggregate path (`ingestEvent`, which passes data
   *  from the `ingestContextEvent` RPC) and the periodic `selectTrigger`. */
  private decideTrigger(
    dirtyTarget: ContextDirtyTarget,
    now: number,
    thresholds: MaterializationThresholds,
    stagedTokenUpperBound: number,
    latestSummaryUpdatedAt: number | undefined,
  ): ContextJobTrigger | undefined {
    // Rate limit: a fresh recent summary suppresses re-fire within minIntervalMs.
    if (latestSummaryUpdatedAt !== undefined && now - latestSummaryUpdatedAt < thresholds.minIntervalMs) return undefined;
    const tokenSum = stagedTokenUpperBound;
    // Force-fire bypasses the event-count floor: this is a memory-safety valve
    // for runaway single/few-event batches with very large tool outputs.
    if (tokenSum >= thresholds.maxBatchTokens) return 'threshold';
    if (thresholds.eventCount !== undefined && dirtyTarget.eventCount >= thresholds.eventCount) return 'threshold';
    // Retry/recovery batches may be small (for example one assistant turn that
    // failed while the compressor was down). Once they are old enough, do not
    // let the min-event floor strand them forever.
    if (dirtyTarget.lastTrigger && now - dirtyTarget.oldestEventAt >= thresholds.scheduleMs) return 'schedule';
    if (dirtyTarget.eventCount < thresholds.minEventCount) return undefined;
    if (tokenSum >= thresholds.autoTriggerTokens) return 'threshold';
    if (now - dirtyTarget.newestEventAt >= thresholds.idleMs) return 'idle';
    if (now - dirtyTarget.oldestEventAt >= thresholds.scheduleMs) return 'schedule';
    // hasProcessedSummary === (latestSummaryUpdatedAt !== undefined)
    if (latestSummaryUpdatedAt !== undefined) return 'schedule';
    return undefined;
  }

  private async selectTrigger(dirtyTarget: ContextDirtyTarget, now: number): Promise<ContextJobTrigger | undefined> {
    const client = getContextStoreClient();
    return this.decideTrigger(
      dirtyTarget,
      now,
      this.thresholdsForTarget(dirtyTarget.target),
      await client.run<number>('estimateStagedTokenUpperBound', [dirtyTarget.target]),
      await client.run<number | undefined>('getLatestRecentSummaryUpdatedAtForTarget', [dirtyTarget.target]),
    );
  }

  async canMaterializeTarget(target: ContextTargetRef, now = Date.now()): Promise<boolean> {
    return !(await this.isRateLimited(target, now));
  }

  private async isRateLimited(target: ContextTargetRef, now: number): Promise<boolean> {
    const thresholds = this.thresholdsForTarget(target);
    const latestSummaryAt = await this.getLatestSummaryUpdatedAt(target);
    return latestSummaryAt !== undefined && now - latestSummaryAt < thresholds.minIntervalMs;
  }

  /** Routed through the worker when warm (in-process cold fallback otherwise) —
   *  the daemon main thread never opens the DB for this admission read. */
  private async getLatestSummaryUpdatedAt(target: ContextTargetRef): Promise<number | undefined> {
    return getContextStoreClient().run<number | undefined>('getLatestRecentSummaryUpdatedAtForTarget', [target]);
  }

  private configForTarget(target: ContextTargetRef): MemoryConfig {
    return this.resolveMemoryConfig(target.namespace, target);
  }

  private thresholdsForTarget(target: ContextTargetRef): MaterializationThresholds {
    return this.buildThresholds(this.configForTarget(target));
  }

  private isSelfLearningEnabled(): boolean {
    if (typeof this._selfLearningEnabled === 'function') return this._selfLearningEnabled();
    if (typeof this._selfLearningEnabled === 'boolean') return this._selfLearningEnabled;
    const flag = MEMORY_FEATURE_FLAGS_BY_NAME.selfLearning;
    const raw = process.env[memoryFeatureFlagEnvKey(flag)];
    return resolveMemoryFeatureFlagValue(flag, {
      runtimeConfigOverride: getRuntimeMemoryFeatureFlagValues(),
      persistedConfig: getPersistedMemoryFeatureFlagValues(),
      environmentStartupDefault: raw == null ? undefined : { [flag]: raw === 'true' || raw === '1' },
      readFailed: !!getMemoryFeatureConfigStoreDiagnostics().lastLoadIssue,
    });
  }

  private buildThresholds(memoryConfig: MemoryConfig): MaterializationThresholds {
    const configMinInterval = this.modelConfig.materializationMinIntervalMs;
    const thresholdOverrides = this.thresholdOverrides;
    return {
      ...DEFAULT_THRESHOLDS,
      autoTriggerTokens: memoryConfig.autoTriggerTokens,
      minEventCount: memoryConfig.minEventCount,
      idleMs: memoryConfig.idleMs,
      scheduleMs: memoryConfig.scheduleMs,
      maxBatchTokens: memoryConfig.maxBatchTokens,
      ...(configMinInterval ? { minIntervalMs: configMinInterval } : {}),
      ...thresholdOverrides,
      ...(thresholdOverrides.eventCount !== undefined && thresholdOverrides.minEventCount === undefined
        ? { minEventCount: 1 }
        : {}),
    };
  }
}


async function collectPinnedNotesForNamespace(namespace: ContextNamespace): Promise<string[]> {
  const namespaceKey = serializeContextNamespace(namespace);
  const notes: string[] = [];
  let tokenTotal = 0;
  for (const note of await getContextStoreClient().run<PinnedNote[]>('listPinnedNotes', [namespaceKey])) {
    const noteTokens = countTokens(note.content);
    if (tokenTotal + noteTokens > 1000) {
      incrementCounter('mem.pinned_notes_overflow', { namespace: namespaceKey });
      warnOncePerHour('pinned_notes_overflow', { namespace: namespaceKey });
      break;
    }
    tokenTotal += noteTokens;
    notes.push(note.content);
  }
  return notes;
}

export async function materializeMasterSummary(sessionName: string, namespace?: ContextNamespace, now = Date.now(), memoryConfig?: MemoryConfig): Promise<ProcessedContextProjection | undefined> {
  const client = getContextStoreClient();
  const resolvedNamespace = namespace ?? await findNamespaceForSessionSummaries(sessionName);
  if (!resolvedNamespace) return undefined;
  const effectiveMemoryConfig = memoryConfig ?? resolveMemoryConfigForNamespace(resolvedNamespace);

  const previousMaster = await findLatestMasterSummary(sessionName, resolvedNamespace);
  const since = previousMaster?.updatedAt ?? 0;
  const batchSummaries = await queryBatchSummariesForMaster(sessionName, resolvedNamespace, since);
  const target: ContextTargetRef = { namespace: resolvedNamespace, kind: 'session', sessionName };
  const archiveEvents = (await client.run<LocalContextEvent[]>('listArchivedEventsForTarget', [target, since, 200])).filter(isHighSignalMasterEvent);
  if (batchSummaries.length === 0 && archiveEvents.length === 0) return previousMaster;

  const sourceEventIds = mergeMasterSourceIds(previousMaster?.sourceEventIds ?? [], [
    ...batchSummaries.flatMap((projection) => projection.sourceEventIds),
    ...archiveEvents.map((event) => event.id),
  ]);
  const namespaceKey = serializeContextNamespace(resolvedNamespace);
  const rawSummary = [
    '## Master Summary',
    '',
    `Session: ${sessionName}`,
    '',
    '## Batch Summaries',
    ...(batchSummaries.length > 0
      ? batchSummaries.slice(0, 20).map((projection) => `- ${projection.summary.split('\n')[0]}`)
      : ['- (none since previous master summary)']),
    '',
    '## High-Signal Events',
    ...(archiveEvents.length > 0
      ? archiveEvents.slice(0, 20).map((event) => `- [${event.eventType}] ${(event.content ?? '').replace(/\s+/g, ' ').slice(0, 240)}`)
      : ['- (none)']),
  ].join('\n');
  const summary = redactSummaryPreservingPinned(rawSummary, effectiveMemoryConfig.extraRedactPatterns);
  const masterProjection = await client.run<ProcessedContextProjection>('writeProcessedProjection', [{
    id: `master:${computeFingerprint(`${namespaceKey}:${sessionName}`)}`,
    namespace: resolvedNamespace,
    class: 'master_summary',
    origin: 'chat_compacted',
    sourceEventIds,
    summary,
    content: {
      sessionName,
      source: 'master_summary',
      batchSummaryCount: batchSummaries.length,
      highSignalEventCount: archiveEvents.length,
      targetTokens: effectiveMemoryConfig.manualCompactTargetTokens > 0
        ? effectiveMemoryConfig.manualCompactTargetTokens
        : computeTargetTokens(countTokens(summary), 'manual'),
    },
    createdAt: previousMaster?.createdAt ?? now,
    updatedAt: now,
  }]);
  // Best-effort, fire-and-forget write-time embedding (see materializeTarget).
  void ensureProjectionEmbeddingForProjection(masterProjection);
  return masterProjection;
}

function mergeMasterSourceIds(prior: string[], incoming: string[]): string[] {
  const out = [...prior];
  for (const id of incoming) if (id && !out.includes(id)) out.push(id);
  while (out.length > 200) out.splice(10, 1);
  return out;
}

async function findNamespaceForSessionSummaries(sessionName: string): Promise<ContextNamespace | undefined> {
  return (await getContextStoreClient().run<LatestRecentSummarySession[]>('listLatestRecentSummarySessions', [1000]))
    .find((item) => item.sessionName === sessionName)?.namespace;
}

async function findLatestMasterSummary(sessionName: string, namespace: ContextNamespace): Promise<ProcessedContextProjection | undefined> {
  return (await getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace, 'master_summary']))
    .filter((projection) => projection.status !== 'archived' && projection.status !== 'archived_dedup')
    .find((projection) => projection.content.sessionName === sessionName);
}

async function queryBatchSummariesForMaster(sessionName: string, namespace: ContextNamespace, since = 0): Promise<ProcessedContextProjection[]> {
  return (await getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace, 'recent_summary']))
    .filter((projection) => projection.status !== 'archived' && projection.status !== 'archived_dedup')
    .filter((projection) => projection.content.sessionName === sessionName && projection.updatedAt > since)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

function isHighSignalMasterEvent(event: LocalContextEvent): boolean {
  if (event.eventType === 'user.message' || event.eventType === 'user.turn') return true;
  if ((event.eventType === 'assistant.text' || event.eventType === 'assistant.turn') && /^##\s+(Problem|Done|Decisions|Next\/Risks|User Problem|Resolution|Key Decisions|User-Pinned Notes|Active State|Active Task|Learned Facts|State Snapshot|Critical Context)/m.test(event.content ?? '')) {
    return true;
  }
  if (event.eventType === 'tool.result') {
    const exitCode = event.metadata?.exitCode;
    return typeof exitCode === 'number' && exitCode !== 0;
  }
  return false;
}

function buildDurableProjectionInput(
  namespace: ContextNamespace,
  events: LocalContextEvent[],
  summary: string,
  sourceEventIds: string[],
  now: number,
): WriteProcessedProjectionInput | undefined {
  const extracted = extractDurableSignalsFromSummary(summary);
  const fallback = extractDurableSignalsFromEvents(events);
  const signals = {
    decisions: extracted.decisions.length > 0 ? extracted.decisions : fallback.decisions,
    constraints: extracted.constraints.length > 0 ? extracted.constraints : fallback.constraints,
    preferences: extracted.preferences.length > 0 ? extracted.preferences : fallback.preferences,
  };
  const candidateCount = signals.decisions.length + signals.constraints.length + signals.preferences.length;
  if (candidateCount === 0) return undefined;
  return {
    namespace,
    class: 'durable_memory_candidate',
    origin: 'agent_learned',
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
  };
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

  const decisionsSection = extractSummarySection(summary, 'Decisions')
    ?? extractSummarySection(summary, 'Key Decisions');
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
