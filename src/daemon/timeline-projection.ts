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

const DEFAULT_QUERY_TIMEOUT_MS = 75;
const DEFAULT_WRITE_TIMEOUT_MS = 2_000;

function getProjectionDbPath(): string {
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
  private permanentlyDisabled = false;

  private ensureWorker(): Worker | null {
    if (this.permanentlyDisabled) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(getWorkerModuleUrl(), {
        workerData: { dbPath: getProjectionDbPath() },
      });
      worker.unref();
      worker.on('message', (message: ProjectionWorkerResponse) => this.handleWorkerMessage(message));
      worker.on('error', (err) => {
        logger.warn({ err }, 'TimelineProjection: worker failed');
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        this.worker = null;
        this.permanentlyDisabled = true;
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn({ code }, 'TimelineProjection: worker exited unexpectedly');
        }
        this.failAllPending(new Error(`timeline_projection_worker_exit:${code}`));
        this.worker = null;
        if (code !== 0) this.permanentlyDisabled = true;
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      logger.warn({ err }, 'TimelineProjection: failed to start worker');
      this.permanentlyDisabled = true;
      return null;
    }
  }

  private handleWorkerMessage(message: ProjectionWorkerResponse): void {
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
      logger.debug({ err, sessionId: query.sessionId }, 'TimelineProjection: queryHistory fallback to JSONL');
      return null;
    }
  }

  async queryLatest(sessionId: string): Promise<TimelineProjectionLatest | null> {
    try {
      return await this.request<TimelineProjectionLatest | null, 'queryLatest'>('queryLatest', { sessionId }, DEFAULT_QUERY_TIMEOUT_MS);
    } catch (err) {
      logger.debug({ err, sessionId }, 'TimelineProjection: queryLatest fallback to JSONL');
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
      logger.debug({ err, sessionId }, 'TimelineProjection: queryCompletedTextTail fallback to JSONL');
      return null;
    }
  }

  async queryByTypes(query: ProjectionWorkerRequestMap['queryByTypes']): Promise<TimelineEvent[] | null> {
    try {
      const result = await this.request<{ source: 'sqlite'; events: TimelineEvent[] }, 'queryByTypes'>('queryByTypes', query, DEFAULT_QUERY_TIMEOUT_MS);
      return result.events;
    } catch (err) {
      logger.debug({ err, sessionId: query.sessionId, types: query.types }, 'TimelineProjection: queryByTypes fallback to JSONL');
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
    this.permanentlyDisabled = false;
  }
}

export const timelineProjection = new TimelineProjectionClient();

export type {
  ProjectionSessionMeta,
};
