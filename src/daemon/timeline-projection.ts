import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';
import type {
  ProjectionSessionMeta,
  ProjectionWorkerEnvelope,
  ProjectionWorkerRequestMap,
  ProjectionWorkerRequestType,
  ProjectionWorkerResponse,
  TimelineProjectionQuery,
} from './timeline-projection-types.js';

export type TimelineProjectionQueryOpts = Omit<TimelineProjectionQuery, 'sessionId' | 'types'>;

export interface TimelineProjectionLatest {
  epoch: number;
  seq: number;
}

export type TimelineProjectionStatus = 'missing' | 'building' | 'ready' | 'stale' | 'corrupt';

// Read-query timeout for the SQLite projection worker. Bumped from 500ms:
// under main-event-loop saturation the worker's *response* is processed late on
// the main thread (not because SQLite itself is slow), so 500ms produced
// spurious timeouts that used to degrade to the synchronous JSONL fallback. 2s
// tolerates transient contention while still bounding a genuinely stuck worker.
const DEFAULT_QUERY_TIMEOUT_MS = 2_000;
const DEFAULT_WRITE_TIMEOUT_MS = 2_000;
// Self-heal backoff for respawning a crashed projection worker (exponential,
// capped). Replaces the old permanent-disable behaviour.
const WORKER_RESPAWN_BASE_BACKOFF_MS = 1_000;
const WORKER_RESPAWN_MAX_BACKOFF_MS = 30_000;

export function getProjectionDbPath(): string {
  return process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH?.trim()
    || join(homedir(), '.imcodes', 'timeline.sqlite');
}

function getWorkerModuleUrl(): URL {
  const selfPath = fileURLToPath(import.meta.url);
  const ext = extname(selfPath);
  return new URL(ext === '.ts' ? './timeline-projection-worker.ts' : './timeline-projection-worker.js', import.meta.url);
}

class TimelineProjectionClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }>();
  // Self-heal instead of permanent disable. A worker crash / abnormal exit
  // starts an exponential cooldown (cooldownUntil); the next request after it
  // elapses lazily respawns the worker. Previously a single crash set a
  // permanent `permanentlyDisabled` flag that stranded the SQLite fast path for
  // the entire daemon lifetime, forcing every history read down the JSONL
  // fallback — exactly the failure mode this subsystem must never enter now
  // that JSONL is no longer a read fallback.
  private consecutiveFailures = 0;
  private cooldownUntil = 0;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    // Still cooling down from a recent crash — fail fast without respawning so
    // we don't hot-loop spawning workers against a persistent fault.
    if (this.cooldownUntil > Date.now()) return null;
    try {
      const worker = new Worker(getWorkerModuleUrl(), {
        workerData: { dbPath: getProjectionDbPath() },
        // Suppress the node:sqlite ExperimentalWarning at the worker boundary
        // (it fires on first node:sqlite load in every worker thread and floods
        // the log). Done via execArgv rather than a module-level emitWarning
        // shim because adding an import to the worker entry destabilises its
        // loading. ExperimentalWarning is the only experimental warning these
        // SQLite workers can emit, so disabling the type here is safe.
        execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'],
      });
      worker.unref();
      worker.on('message', (message: ProjectionWorkerResponse) => this.handleWorkerMessage(message));
      worker.on('error', (err) => {
        logger.warn({ err }, 'TimelineProjection: worker failed');
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        this.worker = null;
        this.scheduleWorkerCooldown();
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn({ code }, 'TimelineProjection: worker exited unexpectedly');
        }
        this.failAllPending(new Error(`timeline_projection_worker_exit:${code}`));
        this.worker = null;
        if (code !== 0) this.scheduleWorkerCooldown();
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      logger.warn({ err }, 'TimelineProjection: failed to start worker');
      this.scheduleWorkerCooldown();
      return null;
    }
  }

  /** Start (or extend) the respawn cooldown after a worker fault. */
  private scheduleWorkerCooldown(): void {
    this.consecutiveFailures += 1;
    const backoff = Math.min(
      WORKER_RESPAWN_MAX_BACKOFF_MS,
      WORKER_RESPAWN_BASE_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1),
    );
    this.cooldownUntil = Date.now() + backoff;
  }

  private handleWorkerMessage(message: ProjectionWorkerResponse): void {
    // A response of any kind proves the (possibly just-respawned) worker is
    // alive again — clear the crash backoff so future faults start fresh.
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private request<T, TOp extends ProjectionWorkerRequestType>(type: TOp, payload: ProjectionWorkerRequestMap[TOp], timeoutMs: number): Promise<T> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error('timeline_projection_unavailable'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeline_projection_timeout:${type}`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const request: ProjectionWorkerEnvelope<TOp> = { id, type, payload };
      worker.postMessage(request);
    });
  }

  async recordAppendedEvent(event: TimelineEvent): Promise<void> {
    await this.request('recordAppendedEvent', { event }, DEFAULT_WRITE_TIMEOUT_MS).catch((err) => {
      logger.debug({ err, sessionId: event.sessionId, eventId: event.eventId }, 'TimelineProjection: recordAppendedEvent failed');
    });
  }

  async queryHistory(query: ProjectionWorkerRequestMap['queryHistory']): Promise<TimelineEvent[] | null> {
    try {
      const result = await this.request<{ source: 'sqlite'; events: TimelineEvent[] }, 'queryHistory'>('queryHistory', query, DEFAULT_QUERY_TIMEOUT_MS);
      return result.events;
    } catch (err) {
      logger.debug({ err, sessionId: query.sessionId }, 'TimelineProjection: queryHistory unavailable');
      return null;
    }
  }

  async queryLatest(sessionId: string): Promise<TimelineProjectionLatest | null> {
    try {
      return await this.request<TimelineProjectionLatest | null, 'queryLatest'>('queryLatest', { sessionId }, DEFAULT_QUERY_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err, sessionId }, 'TimelineProjection: queryLatest unavailable');
      return null;
    }
  }

  async getLatest(sessionId: string): Promise<TimelineProjectionLatest | null> {
    return this.queryLatest(sessionId);
  }

  async queryCompletedTextTail(sessionId: string, limit = 50): Promise<TimelineEvent[] | null> {
    try {
      const result = await this.request<{ source: 'sqlite'; events: TimelineEvent[] }, 'queryCompletedTextTail'>('queryCompletedTextTail', { sessionId, limit }, DEFAULT_QUERY_TIMEOUT_MS);
      return result.events;
    } catch (err) {
      logger.debug({ err, sessionId }, 'TimelineProjection: queryCompletedTextTail unavailable');
      return null;
    }
  }

  async queryByTypes(query: ProjectionWorkerRequestMap['queryByTypes']): Promise<TimelineEvent[] | null> {
    try {
      const result = await this.request<{ source: 'sqlite'; events: TimelineEvent[] }, 'queryByTypes'>('queryByTypes', query, DEFAULT_QUERY_TIMEOUT_MS);
      return result.events;
    } catch (err) {
      logger.debug({ err, sessionId: query.sessionId, types: query.types }, 'TimelineProjection: queryByTypes unavailable');
      return null;
    }
  }

  async rebuildSession(sessionId: string): Promise<boolean> {
    try {
      return await this.request<boolean, 'rebuildSession'>('rebuildSession', { sessionId }, DEFAULT_WRITE_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err, sessionId }, 'TimelineProjection: rebuildSession failed');
      return false;
    }
  }

  async pruneSessionToAuthoritative(sessionId: string, keepLast = 5000): Promise<void> {
    try {
      await this.request('pruneSessionToAuthoritative', { sessionId, keepLast }, DEFAULT_WRITE_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err, sessionId, keepLast }, 'TimelineProjection: pruneSessionToAuthoritative failed');
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.request('deleteSession', { sessionId }, DEFAULT_WRITE_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err, sessionId }, 'TimelineProjection: deleteSession failed');
    }
  }

  async checkpointIfNeeded(): Promise<void> {
    try {
      await this.request('checkpointIfNeeded', {}, DEFAULT_WRITE_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err }, 'TimelineProjection: checkpointIfNeeded failed');
    }
  }

  /**
   * Wait for in-flight write/query requests to settle without rejecting
   * them. Polls `pending.size` every 10ms up to `timeoutMs`. Use during
   * SIGTERM **before** `shutdown()` so legitimate appends mirror into
   * SQLite instead of being failed with a synthetic shutdown error.
   *
   * Unlike `shutdown()`, this method does NOT terminate the worker.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    const start = Date.now();
    while (this.pending.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (this.pending.size > 0) {
      logger.warn({
        pendingCount: this.pending.size,
        elapsedMs: Date.now() - start,
        timeoutMs,
      }, 'TimelineProjection: drain timed out');
    }
  }

  /** Current number of in-flight worker requests. */
  getPendingCount(): number {
    return this.pending.size;
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    this.failAllPending(new Error('timeline_projection_shutdown'));
    try {
      await worker.terminate();
    } catch (err) {
      logger.debug({ err }, 'TimelineProjection: worker terminate failed');
    }
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
  }
}

export const timelineProjection = new TimelineProjectionClient();

export type {
  ProjectionSessionMeta,
};
