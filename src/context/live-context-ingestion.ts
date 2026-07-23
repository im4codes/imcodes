import { createHash } from 'node:crypto';
import type { ContextTargetRef, LocalContextEvent } from '../../shared/context-types.js';
import type { TimelineEvent } from '../daemon/timeline-event.js';
import { preferTimelineEvent } from '../shared/timeline/merge.js';
import type { SessionRecord } from '../store/session-store.js';
import { ContextStoreError, getContextStoreClient } from '../store/context-store-worker-client.js';
import { CONTEXT_STORE_RPC_ERROR, CONTEXT_STORE_RPC_SELF_HEAL, CONTEXT_STORE_RPC_TIMEOUT_MS } from '../../shared/context-store-rpc.js';
import type { TransportContextBootstrap } from '../agent/runtime-context-bootstrap.js';
import { MaterializationCoordinator, type MaterializationCoordinatorOptions } from './materialization-coordinator.js';
import { isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';
import { createMemoryConfigResolver, rememberMemoryConfigProjectDir } from './memory-config-resolver.js';
import { scheduleMarkdownMemoryIngest } from './md-ingest-worker.js';
import { subscribeRuntimeMemoryCacheInvalidation } from './runtime-memory-cache-bus.js';
import { serializeContextTarget } from './context-keys.js';
import { incrementCounter } from '../util/metrics.js';
import { isSessionModelSwitchCommandText } from '../../shared/session-control-commands.js';

const BOOTSTRAP_CACHE_MS = 30_000;
const INGEST_RETRY_BUFFER_MAX_EVENTS = 256;
/**
 * Wall-clock TTL for a buffered retry entry. INVARIANT (audit H-A): this MUST
 * outlast a full worker self-heal outage, else an event buffered at the START of
 * an outage is TTL-dropped just as the worker recovers — systematic ingest loss
 * across a single self-heal cycle. Worst-case outage from a hung worker = up to
 * `consecutiveTimeoutsBeforeRespawn` awaited R4 timeouts (the longest tier)
 * BEFORE the watchdog respawns + the respawn cooldown it then holds + warmup.
 * Derive it from the self-heal constants (NOT a bare literal) so the invariant
 * cannot silently regress if the cooldown is retuned. Was previously a bare
 * `60_000` === `respawnCooldownMs`, which violated this invariant.
 */
export const INGEST_RETRY_WALL_CLOCK_TTL_MS =
  CONTEXT_STORE_RPC_SELF_HEAL.respawnCooldownMs
  + CONTEXT_STORE_RPC_SELF_HEAL.consecutiveTimeoutsBeforeRespawn * CONTEXT_STORE_RPC_TIMEOUT_MS.r4Background
  + 30_000;
const INGEST_RETRY_BACKOFF_BASE_MS = 250;
const INGEST_RETRY_BACKOFF_MAX_MS = 5_000;
const INGEST_RETRY_DRAIN_MAX_SESSIONS_CONCURRENT = 8;

type FlushRetryBufferResult = { status: 'drained' } | { status: 'blocked'; error: unknown };

interface PreparedTimelineIngest {
  event: TimelineEvent;
  target: ContextTargetRef;
  mapped: Pick<LocalContextEvent, 'eventType' | 'content' | 'metadata'>;
  createdAt: number;
  stableEventId: string;
}

type PreparedTimelineAction =
  | { kind: 'ingest'; prepared: PreparedTimelineIngest }
  | { kind: 'prepare'; event: TimelineEvent; scheduleMarkdownIngest: boolean }
  | { kind: 'idle'; event: TimelineEvent; target: ContextTargetRef }
  | { kind: 'toolEvidence'; event: TimelineEvent; target: ContextTargetRef; filteredReason: 'hidden' | 'error' | null }
  | { kind: 'noop'; event: TimelineEvent };

type RetryableTimelineAction = Exclude<PreparedTimelineAction, { kind: 'noop' }>;

export type LiveContextMaterializationAdmissionReason = 'shutdown' | 'upgrade-pending' | 'test-reset';

let materializationAdmissionClosedReason: LiveContextMaterializationAdmissionReason | null = null;

export function closeLiveContextMaterializationAdmission(reason: LiveContextMaterializationAdmissionReason): void {
  materializationAdmissionClosedReason = reason;
}

export function reopenLiveContextMaterializationAdmission(): void {
  materializationAdmissionClosedReason = null;
}

export function isLiveContextMaterializationAdmissionOpen(): boolean {
  return materializationAdmissionClosedReason === null;
}

export interface LiveContextIngestionOptions extends MaterializationCoordinatorOptions {
  sessionLookup: (sessionName: string) => SessionRecord | undefined;
  resolveBootstrap: (record: SessionRecord) => Promise<TransportContextBootstrap>;
  shouldIngestTimelineEvent?: (event: TimelineEvent, session: SessionRecord) => boolean;
  onError?: (error: unknown, event: TimelineEvent) => void;
}

interface GetBootstrapOptions {
  scheduleMarkdownIngest?: boolean;
}

type BootstrapCacheEntry = {
  recordUpdatedAt: number;
  expiresAt: number;
  value: TransportContextBootstrap;
};

interface BufferedTimelineEvent {
  action: RetryableTimelineAction;
  firstEnqueuedAt: number;
  nextAttemptAt: number;
  backoffMs: number;
  lastError: unknown;
}

function contextStoreBackgroundErrorCode(error: unknown): string | undefined {
  return error instanceof ContextStoreError
    ? error.code
    : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
}

function isRetryableContextStoreBackgroundError(error: unknown): boolean {
  const code = contextStoreBackgroundErrorCode(error);
  return code === CONTEXT_STORE_RPC_ERROR.unavailable
    || code === CONTEXT_STORE_RPC_ERROR.timeout
    || code === CONTEXT_STORE_RPC_ERROR.workerError
    || code === CONTEXT_STORE_RPC_ERROR.workerExit
    || code === CONTEXT_STORE_RPC_ERROR.overloaded;
}

export class LiveContextIngestion {
  readonly coordinator: MaterializationCoordinator;

  private readonly sessionLookup: LiveContextIngestionOptions['sessionLookup'];
  private readonly resolveBootstrap: LiveContextIngestionOptions['resolveBootstrap'];
  private readonly shouldIngestTimelineEvent?: LiveContextIngestionOptions['shouldIngestTimelineEvent'];
  private readonly onError?: LiveContextIngestionOptions['onError'];
  private readonly sessionWork = new Map<string, Promise<void>>();
  private readonly bootstrapCache = new Map<string, BootstrapCacheEntry>();
  private readonly retryBuffer = new Map<string, BufferedTimelineEvent[]>();
  private readonly retryDrainTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribeCacheInvalidation: () => void;

  constructor(options: LiveContextIngestionOptions) {
    const memoryConfigResolver = options.memoryConfigResolver ?? (options.memoryConfig ? undefined : createMemoryConfigResolver({
      projectDirResolver: (_namespace, target) => {
        const sessionName = target?.kind === 'session' ? target.sessionName : undefined;
        return sessionName ? options.sessionLookup(sessionName)?.projectDir : undefined;
      },
      fallbackCwd: options.memoryConfigCwd,
    }));
    this.coordinator = new MaterializationCoordinator({
      ...options,
      ...(memoryConfigResolver ? { memoryConfigResolver } : {}),
    });
    this.sessionLookup = options.sessionLookup;
    this.resolveBootstrap = options.resolveBootstrap;
    this.shouldIngestTimelineEvent = options.shouldIngestTimelineEvent;
    this.onError = options.onError;
    this.unsubscribeCacheInvalidation = subscribeRuntimeMemoryCacheInvalidation(() => {
      this.bootstrapCache.clear();
    });
  }

  handleTimelineEvent(event: TimelineEvent): Promise<void> {
    return this.enqueueSessionWork(event.sessionId, async () => {
      let action: PreparedTimelineAction;
      try {
        action = await this.prepareTimelineAction(event);
      } catch (error) {
        this.enqueuePrepareRetryableEvent(event, error, { scheduleMarkdownIngest: true });
        return;
      }

      if (action.kind === 'noop') return;
      if (action.kind === 'toolEvidence') {
        await this.executeTimelineAction(action);
        return;
      }

      const preFlush = await this.flushRetryBuffer(event.sessionId);
      if (preFlush.status === 'blocked') {
        this.enqueueRetryableAction(action, preFlush.error);
        return;
      }
      try {
        await this.executeTimelineAction(action);
      } catch (error) {
        this.enqueueRetryableAction(action, error);
        return;
      }
      await this.flushRetryBuffer(event.sessionId);
    });
  }

  dispose(): void {
    this.unsubscribeCacheInvalidation();
    this.bootstrapCache.clear();
    for (const timer of this.retryDrainTimers.values()) clearTimeout(timer);
    this.retryDrainTimers.clear();
    for (const queue of this.retryBuffer.values()) {
      for (const entry of queue) {
        incrementCounter('mem.ingest.buffer.disposed_drop');
        this.onError?.(entry.lastError, timelineActionEvent(entry.action));
      }
    }
    this.retryBuffer.clear();
    this.sessionWork.clear();
  }

  async flushDueTargets(now = Date.now()): Promise<void> {
    if (!isLiveContextMaterializationAdmissionOpen()) return;
    for (const job of await this.coordinator.scheduleDueTargets(now)) {
      await this.coordinator.materializeTarget(job.target, job.trigger, now);
    }
    await this.coordinator.materializeDueMasterSummaries(now);
  }

  async flushAllRetryBuffers(options: { forceDue?: boolean } = {}): Promise<void> {
    const sessionIds = [...this.retryBuffer.keys()];
    for (let index = 0; index < sessionIds.length; index += INGEST_RETRY_DRAIN_MAX_SESSIONS_CONCURRENT) {
      const batch = sessionIds.slice(index, index + INGEST_RETRY_DRAIN_MAX_SESSIONS_CONCURRENT);
      await Promise.all(batch.map((sessionId) => this.enqueueSessionWork(sessionId, async () => {
        await this.flushRetryBuffer(sessionId, { forceDue: options.forceDue });
      })));
    }
  }

  async backfillSessionFromEvents(sessionName: string, events: TimelineEvent[]): Promise<void> {
    const session = this.sessionLookup(sessionName);
    if (!session || events.length === 0) return;
    const backfillEvents = dedupeTimelineEventsByLogicalId(events);
    let bootstrap: TransportContextBootstrap;
    try {
      bootstrap = await this.getBootstrap(session, { scheduleMarkdownIngest: false });
    } catch (error) {
      if (isRetryableContextStoreBackgroundError(error)) {
        this.enqueuePrepareBackfillEvents(backfillEvents, session, error);
        return;
      }
      throw error;
    }
    const target = toSessionTarget(session.name, bootstrap);
    try {
      if (await this.hasAnyActivity(target)) return;
    } catch (error) {
      if (isRetryableContextStoreBackgroundError(error)) {
        this.enqueuePreparedBackfillEvents(backfillEvents, session, target, error);
        return;
      }
      throw error;
    }

    let lastTs = Date.now();
    let staged = 0;
    for (let index = 0; index < backfillEvents.length; index += 1) {
      const event = backfillEvents[index];
      if (this.shouldIngestTimelineEvent && !this.shouldIngestTimelineEvent(event, session)) continue;
      const mapped = mapTimelineEvent(event);
      if (!mapped) continue;
      const prepared = this.prepareTimelineIngest(event, target, mapped);
      try {
        await this.processPreparedTimelineIngest(prepared);
        staged += 1;
        lastTs = event.ts;
      } catch (error) {
        if (isRetryableContextStoreBackgroundError(error)) {
          this.enqueuePreparedBackfillEvents(backfillEvents, session, target, error, index);
          break;
        }
        throw error;
      }
    }
    if (staged > 0) {
      if (isLiveContextMaterializationAdmissionOpen() && await this.coordinator.canMaterializeTarget(target, lastTs)) {
        await this.coordinator.materializeTarget(target, 'recovery', lastTs);
      }
    }
  }

  private async prepareTimelineAction(
    event: TimelineEvent,
    options: GetBootstrapOptions = {},
  ): Promise<PreparedTimelineAction> {
    const session = this.sessionLookup(event.sessionId);
    if (!session) return { kind: 'noop', event };
    if (this.shouldIngestTimelineEvent && !this.shouldIngestTimelineEvent(event, session)) return { kind: 'noop', event };
    const bootstrap = await this.getBootstrap(session, options);
    const target = toSessionTarget(session.name, bootstrap);

    if (event.type === 'session.state') {
      return { kind: 'idle', event, target };
    }

    if (event.type === 'tool.result') {
      return {
        kind: 'toolEvidence',
        event,
        target,
        filteredReason: toolResultEvidenceFilteredReason(event),
      };
    }

    const mapped = mapTimelineEvent(event);
    if (!mapped) return { kind: 'noop', event };
    return {
      kind: 'ingest',
      prepared: this.prepareTimelineIngest(event, target, mapped),
    };
  }

  private async executeTimelineAction(action: PreparedTimelineAction): Promise<void> {
    switch (action.kind) {
      case 'noop':
        return;
      case 'idle': {
        const { event, target } = action;
      const state = typeof event.payload.state === 'string' ? event.payload.state : '';
      if (state === 'idle'
        && isLiveContextMaterializationAdmissionOpen()
        && await this.hasDirtyTarget(target)
        && await this.coordinator.canMaterializeTarget(target, event.ts)) {
        await this.coordinator.materializeTarget(target, 'idle', event.ts);
      }
      return;
      }
      case 'toolEvidence':
      if (action.filteredReason) {
        this.coordinator.recordFilteredSkillReviewToolIteration(action.filteredReason);
      } else {
        this.coordinator.recordSkillReviewToolIteration(action.target);
      }
      return;
      case 'prepare': {
        const preparedAction = await this.prepareTimelineAction(action.event, {
          scheduleMarkdownIngest: action.scheduleMarkdownIngest,
        });
        if (preparedAction.kind === 'prepare') return;
        await this.executeTimelineAction(preparedAction);
        return;
      }
      case 'ingest': {
    const result = await this.processPreparedTimelineIngest(action.prepared);
    if (result.trigger === 'threshold'
      && isLiveContextMaterializationAdmissionOpen()
      && await this.coordinator.canMaterializeTarget(action.prepared.target, action.prepared.event.ts)) {
      await this.coordinator.materializeTarget(action.prepared.target, 'threshold', action.prepared.event.ts);
    }
        return;
      }
    }
  }


  private enqueuePrepareRetryableEvent(
    event: TimelineEvent,
    error: unknown,
    options: { scheduleMarkdownIngest: boolean },
  ): boolean {
    if (!isRetryableContextStoreBackgroundError(error)) {
      this.onError?.(error, event);
      return false;
    }
    return this.enqueueRetryableAction({
      kind: 'prepare',
      event,
      scheduleMarkdownIngest: options.scheduleMarkdownIngest,
    }, error);
  }

  private enqueueRetryableAction(
    action: RetryableTimelineAction,
    error: unknown,
  ): boolean {
    if (!isRetryableContextStoreBackgroundError(error)) {
      this.onError?.(error, timelineActionEvent(action));
      return false;
    }
    return this.enqueueRetryableEntry(action, error);
  }

  private enqueuePreparedRetryableEvent(
    prepared: PreparedTimelineIngest,
    error: unknown,
    _attempts = 0,
  ): boolean {
    return this.enqueueRetryableEntry({ kind: 'ingest', prepared }, error);
  }

  private enqueueRetryableEntry(
    action: RetryableTimelineAction,
    error: unknown,
    options: { firstEnqueuedAt?: number; nextAttemptAt?: number; backoffMs?: number } = {},
  ): boolean {
    const event = timelineActionEvent(action);
    if (!isRetryableContextStoreBackgroundError(error)) {
      this.onError?.(error, event);
      return false;
    }
    const queue = this.retryBuffer.get(event.sessionId) ?? [];
    if (queue.length >= INGEST_RETRY_BUFFER_MAX_EVENTS) {
      const dropped = queue.shift();
      if (dropped) {
        incrementCounter('mem.ingest.buffer.overflow_drop', { policy: 'drop_oldest' });
        this.onError?.(dropped.lastError, timelineActionEvent(dropped.action));
      }
    }
    const now = Date.now();
    queue.push({
      action,
      firstEnqueuedAt: options.firstEnqueuedAt ?? now,
      nextAttemptAt: options.nextAttemptAt ?? now,
      backoffMs: options.backoffMs ?? INGEST_RETRY_BACKOFF_BASE_MS,
      lastError: error,
    });
    this.retryBuffer.set(event.sessionId, queue);
    this.scheduleRetryDrainForSession(event.sessionId);
    return true;
  }

  private enqueuePreparedBackfillEvents(
    events: TimelineEvent[],
    session: SessionRecord,
    target: ContextTargetRef,
    error: unknown,
    startIndex = 0,
  ): void {
    for (let retryIndex = startIndex; retryIndex < events.length; retryIndex += 1) {
      const retryEvent = events[retryIndex];
      if (this.shouldIngestTimelineEvent && !this.shouldIngestTimelineEvent(retryEvent, session)) continue;
      const retryMapped = mapTimelineEvent(retryEvent);
      if (!retryMapped) continue;
      this.enqueueRetryableEntry(
        {
          kind: 'ingest',
          prepared: this.prepareTimelineIngest(retryEvent, target, retryMapped),
        },
        error,
      );
    }
  }

  private enqueuePrepareBackfillEvents(
    events: TimelineEvent[],
    session: SessionRecord,
    error: unknown,
    startIndex = 0,
  ): void {
    for (let retryIndex = startIndex; retryIndex < events.length; retryIndex += 1) {
      const retryEvent = events[retryIndex];
      if (this.shouldIngestTimelineEvent && !this.shouldIngestTimelineEvent(retryEvent, session)) continue;
      if (!mapTimelineEvent(retryEvent)) continue;
      this.enqueueRetryableEntry(
        { kind: 'prepare', event: retryEvent, scheduleMarkdownIngest: false },
        error,
      );
    }
  }

  private async flushRetryBuffer(
    sessionId: string,
    options: { forceDue?: boolean } = {},
  ): Promise<FlushRetryBufferResult> {
    const queue = this.retryBuffer.get(sessionId);
    if (!queue || queue.length === 0) return { status: 'drained' };
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const now = Date.now();
      if (!options.forceDue && entry.nextAttemptAt > now) {
        queue.unshift(entry);
        this.retryBuffer.set(sessionId, queue);
        this.scheduleRetryDrainForSession(sessionId, entry.nextAttemptAt - now);
        return { status: 'blocked', error: entry.lastError };
      }
      if (now - entry.firstEnqueuedAt > INGEST_RETRY_WALL_CLOCK_TTL_MS) {
        incrementCounter('mem.ingest.buffer.ttl_expired_drop');
        this.onError?.(entry.lastError, timelineActionEvent(entry.action));
        continue;
      }
      try {
        await this.executeTimelineAction(entry.action);
      } catch (error) {
        if (isRetryableContextStoreBackgroundError(error)) {
          const nextBackoffMs = Math.min(entry.backoffMs * 2, INGEST_RETRY_BACKOFF_MAX_MS);
          const nextAttemptAt = Date.now() + entry.backoffMs;
          incrementCounter('mem.ingest.buffer.transient_retry');
          queue.unshift({
            ...entry,
            nextAttemptAt,
            backoffMs: nextBackoffMs,
            lastError: error,
          });
          this.retryBuffer.set(sessionId, queue);
          this.scheduleRetryDrainForSession(sessionId, entry.backoffMs);
          return { status: 'blocked', error };
        }
        this.onError?.(error, timelineActionEvent(entry.action));
      }
    }
    this.retryBuffer.delete(sessionId);
    return { status: 'drained' };
  }

  private enqueueSessionWork(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.sessionWork.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.sessionWork.set(sessionId, next);
    return next;
  }

  private scheduleRetryDrainForSession(sessionId: string, delayMs = INGEST_RETRY_BACKOFF_BASE_MS): void {
    if (this.retryDrainTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.retryDrainTimers.delete(sessionId);
      void this.enqueueSessionWork(sessionId, async () => {
        await this.flushRetryBuffer(sessionId);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.retryDrainTimers.set(sessionId, timer);
  }

  private prepareTimelineIngest(
    event: TimelineEvent,
    target: ContextTargetRef,
    mapped: Pick<LocalContextEvent, 'eventType' | 'content' | 'metadata'>,
  ): PreparedTimelineIngest {
    return {
      event,
      target,
      mapped,
      createdAt: event.ts,
      stableEventId: stableContextEventId(event, target, mapped),
    };
  }

  private async processPreparedTimelineIngest(prepared: PreparedTimelineIngest): Promise<Awaited<ReturnType<MaterializationCoordinator['ingestEvent']>>> {
    return this.coordinator.ingestEvent({
      id: prepared.stableEventId,
      target: prepared.target,
      eventType: prepared.mapped.eventType,
      content: prepared.mapped.content,
      metadata: prepared.mapped.metadata,
      createdAt: prepared.createdAt,
    });
  }

  private async getBootstrap(
    session: SessionRecord,
    options: GetBootstrapOptions = {},
  ): Promise<TransportContextBootstrap> {
    const cached = this.bootstrapCache.get(session.name);
    if (cached && cached.recordUpdatedAt === session.updatedAt && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.resolveBootstrap(session);
    rememberMemoryConfigProjectDir(value.namespace, session.projectDir);
    if (options.scheduleMarkdownIngest !== false) {
      scheduleMarkdownMemoryIngest({ projectDir: session.projectDir, namespace: value.namespace });
    }
    this.bootstrapCache.set(session.name, {
      recordUpdatedAt: session.updatedAt,
      expiresAt: Date.now() + BOOTSTRAP_CACHE_MS,
      value,
    });
    return value;
  }

  private async hasDirtyTarget(target: ContextTargetRef): Promise<boolean> {
    return (await this.coordinator.listDirtyTargets(target.namespace)).some((entry) =>
      entry.target.kind === target.kind && entry.target.sessionName === target.sessionName,
    );
  }

  private async hasAnyActivity(target: ContextTargetRef): Promise<boolean> {
    if (await this.hasDirtyTarget(target)) return true;
    // Target-specific activity gate: avoid suppressing backfill for one
    // session just because another target in the same namespace has summaries.
    const client = getContextStoreClient();
    if (await client.run<number | undefined>('getLatestRecentSummaryUpdatedAtForTarget', [target]) !== undefined) return true;
    if ((await client.run<LocalContextEvent[]>('listContextEvents', [target])).length > 0) return true;
    return (await client.run<LocalContextEvent[]>('listArchivedEventsForTarget', [target, 0, 1])).length > 0;
  }
}


// When an explicit `eventId` is present, the staged id is derived ONLY from
// `{ target, eventId }` — the timeline `type`/mapped event type are deliberately
// EXCLUDED. This is the spec-mandated idempotency contract (spec
// context-store-access): live/retry/backfill replays of the same logical
// `eventId` MUST collapse to the same staged id even when replayed timeline
// metadata differs. Excluding the type is the contract, NOT a missing-type bug;
// adding the type back would break replay idempotency.
function stableContextEventId(
  event: TimelineEvent,
  target: ContextTargetRef,
  mapped: Pick<LocalContextEvent, 'eventType' | 'content' | 'metadata'>,
): string {
  const targetKey = serializeContextTarget(target);
  const eventId = event.eventId?.trim();
  if (eventId) {
    return `timeline:${createHash('sha256').update(JSON.stringify({
      target: targetKey,
      eventId,
    })).digest('hex').slice(0, 48)}`;
  }
  const source = JSON.stringify({
    target: targetKey,
    sessionId: event.sessionId,
    ts: event.ts,
    seq: event.seq,
    epoch: event.epoch,
    timelineType: event.type,
    type: mapped.eventType,
    content: mapped.content ?? '',
  });
  return `timeline:${createHash('sha256').update(source).digest('hex').slice(0, 48)}`;
}

function dedupeTimelineEventsByLogicalId(events: TimelineEvent[]): TimelineEvent[] {
  const output: TimelineEvent[] = [];
  const byLogicalId = new Map<string, number>();
  for (const event of events) {
    const eventId = event.eventId?.trim();
    if (!eventId) {
      output.push(event);
      continue;
    }
    const key = `${event.sessionId}\0${event.type}\0${eventId}`;
    const existingIndex = byLogicalId.get(key);
    if (existingIndex === undefined) {
      byLogicalId.set(key, output.length);
      output.push(event);
      continue;
    }
    // Reuse the shared same-eventId comparator so backfill dedupe matches the
    // timeline emitter/replay semantics: full/non-streaming/final wins over a
    // newer streaming/preview version (a weaker ts/seq-only pick would select
    // the newer streaming delta, which mapTimelineEvent then drops → lost event).
    output[existingIndex] = preferTimelineEvent(output[existingIndex]!, event);
  }
  return output;
}

function timelineActionEvent(action: PreparedTimelineAction): TimelineEvent {
  return action.kind === 'ingest' ? action.prepared.event : action.event;
}

function toolResultEvidenceFilteredReason(event: TimelineEvent): 'hidden' | 'error' | null {
  if (event.hidden === true || event.payload.hidden === true) return 'hidden';
  if (event.payload.error !== undefined && event.payload.error !== null && event.payload.error !== false) return 'error';
  const exitCode = event.payload.exit_code ?? event.payload.exitCode ?? event.payload.code;
  if (typeof exitCode === 'number' && exitCode !== 0) return 'error';
  if (event.payload.success === false) return 'error';
  return null;
}

function toSessionTarget(sessionName: string, bootstrap: TransportContextBootstrap): ContextTargetRef {
  return {
    namespace: bootstrap.namespace,
    kind: 'session',
    sessionName,
  };
}

function mapTimelineEvent(event: TimelineEvent): Pick<LocalContextEvent, 'eventType' | 'content' | 'metadata'> | null {
  switch (event.type) {
    case 'user.message': {
      if (event.payload.memoryExcluded === true) return null;
      const text = stringifyContent(event.payload.text);
      if (text && isSessionModelSwitchCommandText(text)) return null;
      return {
        eventType: 'user.turn',
        content: text,
        metadata: { timelineType: event.type },
      };
    }
    case 'assistant.text': {
      const text = stringifyContent(event.payload.text);
      if (event.payload.streaming === true || event.payload.memoryExcluded === true) return null;
      if (isMemoryNoiseTurn(text)) return null;
      return {
        eventType: 'assistant.turn',
        content: text,
        metadata: { timelineType: event.type, streaming: false },
      };
    }
    case 'assistant.thinking':
      return {
        eventType: 'assistant.thinking',
        content: stringifyContent(event.payload.text),
        metadata: { timelineType: event.type },
      };
    case 'tool.call':
    case 'tool.result':
      return null;
    case 'ask.question':
      return {
        eventType: 'question',
        content: stringifyContent(event.payload.text ?? event.payload.question),
        metadata: { timelineType: event.type },
      };
    default:
      return null;
  }
}

function stringifyContent(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
