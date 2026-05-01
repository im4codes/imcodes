import type { ContextTargetRef, LocalContextEvent } from '../../shared/context-types.js';
import type { TimelineEvent } from '../daemon/timeline-event.js';
import type { SessionRecord } from '../store/session-store.js';
import { listProcessedProjections } from '../store/context-store.js';
import type { TransportContextBootstrap } from '../agent/runtime-context-bootstrap.js';
import { MaterializationCoordinator, type MaterializationCoordinatorOptions } from './materialization-coordinator.js';
import { isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';
import { createMemoryConfigResolver, rememberMemoryConfigProjectDir } from './memory-config-resolver.js';
import { scheduleMarkdownMemoryIngest } from './md-ingest-worker.js';
import { subscribeRuntimeMemoryCacheInvalidation } from './runtime-memory-cache-bus.js';

const BOOTSTRAP_CACHE_MS = 30_000;

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
  onError?: (error: unknown, event: TimelineEvent) => void;
}

type BootstrapCacheEntry = {
  recordUpdatedAt: number;
  expiresAt: number;
  value: TransportContextBootstrap;
};

export class LiveContextIngestion {
  readonly coordinator: MaterializationCoordinator;

  private readonly sessionLookup: LiveContextIngestionOptions['sessionLookup'];
  private readonly resolveBootstrap: LiveContextIngestionOptions['resolveBootstrap'];
  private readonly onError?: LiveContextIngestionOptions['onError'];
  private readonly sessionWork = new Map<string, Promise<void>>();
  private readonly bootstrapCache = new Map<string, BootstrapCacheEntry>();
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
    this.onError = options.onError;
    this.unsubscribeCacheInvalidation = subscribeRuntimeMemoryCacheInvalidation(() => {
      this.bootstrapCache.clear();
    });
  }

  handleTimelineEvent(event: TimelineEvent): Promise<void> {
    const previous = this.sessionWork.get(event.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.processTimelineEvent(event))
      .catch((error) => {
        this.onError?.(error, event);
      });
    this.sessionWork.set(event.sessionId, next);
    return next;
  }

  dispose(): void {
    this.unsubscribeCacheInvalidation();
    this.bootstrapCache.clear();
    this.sessionWork.clear();
  }

  async flushDueTargets(now = Date.now()): Promise<void> {
    if (!isLiveContextMaterializationAdmissionOpen()) return;
    for (const job of this.coordinator.scheduleDueTargets(now)) {
      await this.coordinator.materializeTarget(job.target, job.trigger, now);
    }
    await this.coordinator.materializeDueMasterSummaries(now);
  }

  async backfillSessionFromEvents(sessionName: string, events: TimelineEvent[]): Promise<void> {
    const session = this.sessionLookup(sessionName);
    if (!session || events.length === 0) return;
    const bootstrap = await this.getBootstrap(session);
    const target = toSessionTarget(session.name, bootstrap);
    if (this.hasAnyActivity(target)) return;

    let lastTs = Date.now();
    let staged = 0;
    for (const event of events) {
      const mapped = mapTimelineEvent(event);
      if (!mapped) continue;
      staged += 1;
      lastTs = event.ts;
      this.coordinator.ingestEvent({
        target,
        eventType: mapped.eventType,
        content: mapped.content,
        metadata: mapped.metadata,
        createdAt: event.ts,
      });
    }
    if (staged > 0) {
      if (isLiveContextMaterializationAdmissionOpen() && this.coordinator.canMaterializeTarget(target, lastTs)) {
        await this.coordinator.materializeTarget(target, 'recovery', lastTs);
      }
    }
  }

  private async processTimelineEvent(event: TimelineEvent): Promise<void> {
    const session = this.sessionLookup(event.sessionId);
    if (!session) return;
    const bootstrap = await this.getBootstrap(session);
    const target = toSessionTarget(session.name, bootstrap);

    if (event.type === 'session.state') {
      const state = typeof event.payload.state === 'string' ? event.payload.state : '';
      if (state === 'idle'
        && isLiveContextMaterializationAdmissionOpen()
        && this.hasDirtyTarget(target)
        && this.coordinator.canMaterializeTarget(target, event.ts)) {
        await this.coordinator.materializeTarget(target, 'idle', event.ts);
      }
      return;
    }

    if (event.type === 'tool.result') {
      const filteredReason = toolResultEvidenceFilteredReason(event);
      if (filteredReason) {
        this.coordinator.recordFilteredSkillReviewToolIteration(filteredReason);
      } else {
        this.coordinator.recordSkillReviewToolIteration(target);
      }
      return;
    }

    const mapped = mapTimelineEvent(event);
    if (!mapped) return;
    const result = this.coordinator.ingestEvent({
      target,
      eventType: mapped.eventType,
      content: mapped.content,
      metadata: mapped.metadata,
      createdAt: event.ts,
    });
    if (result.trigger === 'threshold'
      && isLiveContextMaterializationAdmissionOpen()
      && this.coordinator.canMaterializeTarget(target, event.ts)) {
      await this.coordinator.materializeTarget(target, 'threshold', event.ts);
    }
  }

  private async getBootstrap(session: SessionRecord): Promise<TransportContextBootstrap> {
    const cached = this.bootstrapCache.get(session.name);
    if (cached && cached.recordUpdatedAt === session.updatedAt && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.resolveBootstrap(session);
    rememberMemoryConfigProjectDir(value.namespace, session.projectDir);
    scheduleMarkdownMemoryIngest({ projectDir: session.projectDir, namespace: value.namespace });
    this.bootstrapCache.set(session.name, {
      recordUpdatedAt: session.updatedAt,
      expiresAt: Date.now() + BOOTSTRAP_CACHE_MS,
      value,
    });
    return value;
  }

  private hasDirtyTarget(target: ContextTargetRef): boolean {
    return this.coordinator.listDirtyTargets(target.namespace).some((entry) =>
      entry.target.kind === target.kind && entry.target.sessionName === target.sessionName,
    );
  }

  private hasAnyActivity(target: ContextTargetRef): boolean {
    return this.hasDirtyTarget(target) || listProcessedProjections(target.namespace).length > 0;
  }
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
    case 'user.message':
      return {
        eventType: 'user.turn',
        content: stringifyContent(event.payload.text),
        metadata: { timelineType: event.type },
      };
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
