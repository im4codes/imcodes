import { Worker } from 'node:worker_threads';
import logger from '../util/logger.js';
import { getProjectionDbPath } from './timeline-projection.js';
import { TIMELINE_HISTORY_ERROR_REASONS, type TimelineHistoryErrorReason } from '../../shared/timeline-history-errors.js';
import {
  DEFAULT_TIMELINE_HISTORY_POOL_QUEUE_CAP,
  DEFAULT_TIMELINE_HISTORY_WORKERS_TARGET,
  HARD_MAX_TIMELINE_HISTORY_WORKERS,
  MIN_TIMELINE_HISTORY_WORKERS_TARGET,
  isTimelineHistoryWorkerResultFor,
  withTimelineHistoryWorkerIdentity,
  type TimelineHistoryBuildJobInput,
  type TimelineHistoryWorkerGeneration,
  type TimelineHistoryWorkerIdentity,
  type TimelineHistoryWorkerRequest,
  type TimelineHistoryWorkerRequestId,
  type TimelineHistoryWorkerResult,
  type TimelineHistoryWorkerSlotId,
  type TimelineHistoryWorkerSuccess,
} from './timeline-history-worker-types.js';

export type TimelineHistoryPoolErrorReason = TimelineHistoryErrorReason;

export class TimelineHistoryPoolError extends Error {
  constructor(readonly reason: TimelineHistoryPoolErrorReason, message = reason) {
    super(message);
    this.name = 'TimelineHistoryPoolError';
  }
}

export interface TimelineHistoryWorkerThreadLike {
  postMessage(message: TimelineHistoryWorkerRequest): void;
  on(event: 'message', listener: (message: TimelineHistoryWorkerResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<unknown>;
  unref?(): void;
}

export interface TimelineHistoryWorkerPoolOptions {
  workersTarget?: number;
  queueCap?: number;
  activeJobTimeoutMs?: number | null;
  restartBackoffMs?: number;
  clock?: { now(): number };
  createWorker?: (slotId: TimelineHistoryWorkerSlotId, generation: TimelineHistoryWorkerGeneration) => TimelineHistoryWorkerThreadLike;
}

interface WorkerSlot {
  slotId: TimelineHistoryWorkerSlotId;
  generation: TimelineHistoryWorkerGeneration;
  state: 'idle' | 'busy' | 'restarting' | 'dead';
  worker: TimelineHistoryWorkerThreadLike | null;
  currentJob: ActiveJob | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

interface ActiveJob {
  input: TimelineHistoryBuildJobInput;
  identity: TimelineHistoryWorkerIdentity;
  deadlineAt: number | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  resolve: (result: TimelineHistoryWorkerSuccess) => void;
  reject: (error: TimelineHistoryPoolError) => void;
}

interface QueuedJob {
  input: TimelineHistoryBuildJobInput;
  deadlineAt: number | null;
  resolve: (result: TimelineHistoryWorkerSuccess) => void;
  reject: (error: TimelineHistoryPoolError) => void;
}

export interface TimelineHistoryDispatchOptions {
  deadlineAt?: number;
}

export const DEFAULT_TIMELINE_HISTORY_ACTIVE_JOB_TIMEOUT_MS = 4_000;
export const DEFAULT_TIMELINE_HISTORY_RESTART_BACKOFF_MS = 250;

function getWorkerModuleUrl(): URL {
  return new URL('./timeline-history-worker-bootstrap.mjs', import.meta.url);
}

function clampWorkersTarget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_TIMELINE_HISTORY_WORKERS_TARGET;
  return Math.min(
    HARD_MAX_TIMELINE_HISTORY_WORKERS,
    Math.max(MIN_TIMELINE_HISTORY_WORKERS_TARGET, Math.trunc(value as number)),
  );
}

function createNodeWorker(): TimelineHistoryWorkerThreadLike {
  const worker = new Worker(getWorkerModuleUrl(), {
    workerData: { dbPath: getProjectionDbPath() },
  });
  worker.unref();
  return worker as TimelineHistoryWorkerThreadLike;
}

export class TimelineHistoryWorkerPool {
  readonly workersTarget: number;
  readonly queueCap: number;
  private readonly activeJobTimeoutMs: number | null;
  private readonly restartBackoffMs: number;
  private readonly clock: { now(): number };
  private readonly createWorker: (slotId: TimelineHistoryWorkerSlotId, generation: TimelineHistoryWorkerGeneration) => TimelineHistoryWorkerThreadLike;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedJob[] = [];
  private nextWorkerRequestId: TimelineHistoryWorkerRequestId = 1;
  private started = false;
  private shuttingDown = false;

  constructor(options: TimelineHistoryWorkerPoolOptions = {}) {
    this.workersTarget = clampWorkersTarget(options.workersTarget);
    this.queueCap = Math.max(0, Math.trunc(options.queueCap ?? DEFAULT_TIMELINE_HISTORY_POOL_QUEUE_CAP));
    this.activeJobTimeoutMs = options.activeJobTimeoutMs === undefined
      ? DEFAULT_TIMELINE_HISTORY_ACTIVE_JOB_TIMEOUT_MS
      : options.activeJobTimeoutMs === null
        ? null
        : Math.max(1, Math.trunc(options.activeJobTimeoutMs));
    this.restartBackoffMs = Math.max(0, Math.trunc(options.restartBackoffMs ?? DEFAULT_TIMELINE_HISTORY_RESTART_BACKOFF_MS));
    this.clock = options.clock ?? { now: () => Date.now() };
    this.createWorker = options.createWorker ?? (() => createNodeWorker());
    if (options.workersTarget !== undefined && options.workersTarget !== this.workersTarget) {
      logger.warn({ requested: options.workersTarget, effective: this.workersTarget }, 'TimelineHistoryWorkerPool: workersTarget clamped');
    }
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  async dispatch(input: TimelineHistoryBuildJobInput, options: TimelineHistoryDispatchOptions = {}): Promise<TimelineHistoryWorkerSuccess> {
    if (this.shuttingDown) throw new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.SHUTDOWN);
    const deadlineAt = Number.isFinite(options.deadlineAt ?? NaN) ? Math.trunc(options.deadlineAt as number) : null;
    if (deadlineAt !== null && deadlineAt <= this.clock.now()) throw new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT);
    this.ensureStarted();
    if (this.queue.length >= this.queueCap) throw new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL);
    return await new Promise<TimelineHistoryWorkerSuccess>((resolve, reject) => {
      this.queue.push({ input, deadlineAt, resolve, reject });
      this.pump();
    });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let index = 0; index < this.workersTarget; index += 1) {
      const slot: WorkerSlot = {
        slotId: index + 1,
        generation: 0,
        state: 'dead',
        worker: null,
        currentJob: null,
        restartTimer: null,
        stopping: false,
      };
      this.slots.push(slot);
      this.startSlot(slot);
    }
  }

  private startSlot(slot: WorkerSlot): void {
    if (this.shuttingDown) return;
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
    slot.generation += 1;
    slot.state = 'restarting';
    slot.stopping = false;
    const generation = slot.generation;
    try {
      const worker = this.createWorker(slot.slotId, generation);
      worker.unref?.();
      worker.on('message', (message) => this.handleWorkerMessage(slot, generation, message));
      worker.on('error', (error) => this.handleWorkerFailure(slot, generation, error));
      worker.on('exit', (code) => {
        if (slot.stopping) return;
        this.handleWorkerFailure(slot, generation, new Error(`timeline_history_worker_exit:${code}`));
      });
      slot.worker = worker;
      slot.state = 'idle';
      logger.debug({ slotId: slot.slotId, generation }, 'TimelineHistoryWorkerPool: worker started');
      this.pump();
    } catch (error) {
      logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'TimelineHistoryWorkerPool: worker startup failed');
      slot.worker = null;
      slot.state = 'dead';
      this.scheduleRestart(slot);
    }
  }

  private handleWorkerMessage(slot: WorkerSlot, generation: TimelineHistoryWorkerGeneration, message: TimelineHistoryWorkerResult): void {
    if (slot.generation !== generation || slot.state === 'dead') return;
    const active = slot.currentJob;
    if (!active || !isTimelineHistoryWorkerResultFor(message, active.identity)) return;
    this.clearActiveTimer(active);
    slot.currentJob = null;
    slot.state = 'idle';
    if (message.kind === 'success') active.resolve(message);
    else active.reject(new TimelineHistoryPoolError(message.reason));
    this.pump();
  }

  private handleWorkerFailure(slot: WorkerSlot, generation: TimelineHistoryWorkerGeneration, error: Error): void {
    if (slot.generation !== generation || slot.stopping) return;
    logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'TimelineHistoryWorkerPool: worker failed');
    const active = slot.currentJob;
    if (active) {
      this.clearActiveTimer(active);
      active.reject(new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.CRASHED));
    }
    slot.currentJob = null;
    slot.worker = null;
    slot.state = 'restarting';
    this.scheduleRestart(slot);
  }

  private scheduleRestart(slot: WorkerSlot): void {
    if (this.shuttingDown || slot.restartTimer) return;
    this.drainQueueIfNoLiveCapacity();
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.startSlot(slot);
    }, this.restartBackoffMs);
    slot.restartTimer.unref?.();
  }

  private pump(): void {
    if (this.shuttingDown || this.queue.length === 0) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.state !== 'idle' || !slot.worker || slot.currentJob) continue;
      const queued = this.queue.shift();
      if (!queued) return;
      if (queued.deadlineAt !== null && queued.deadlineAt <= this.clock.now()) {
        queued.reject(new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT));
        continue;
      }
      const identity: TimelineHistoryWorkerIdentity = {
        workerRequestId: this.nextWorkerRequestId++,
        workerSlotId: slot.slotId,
        workerGeneration: slot.generation,
      };
      const active: ActiveJob = { ...queued, identity, timeoutTimer: null };
      slot.currentJob = active;
      slot.state = 'busy';
      try {
        slot.worker.postMessage(withTimelineHistoryWorkerIdentity(queued.input, identity));
        this.armActiveTimer(slot, active);
      } catch (error) {
        this.clearActiveTimer(active);
        slot.currentJob = null;
        queued.reject(new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.UNAVAILABLE));
        this.handleWorkerFailure(slot, slot.generation, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private armActiveTimer(slot: WorkerSlot, active: ActiveJob): void {
    if (this.activeJobTimeoutMs === null && active.deadlineAt === null) return;
    const timeoutMs = this.getTimeoutMs(active.deadlineAt);
    if (timeoutMs <= 0) {
      this.handleActiveTimeout(slot, active.identity);
      return;
    }
    active.timeoutTimer = setTimeout(() => this.handleActiveTimeout(slot, active.identity), timeoutMs);
    active.timeoutTimer.unref?.();
  }

  private clearActiveTimer(active: ActiveJob): void {
    if (!active.timeoutTimer) return;
    clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
  }

  private getTimeoutMs(deadlineAt: number | null): number {
    const activeTimeout = this.activeJobTimeoutMs ?? Number.MAX_SAFE_INTEGER;
    if (deadlineAt === null) return activeTimeout;
    return Math.min(activeTimeout, deadlineAt - this.clock.now());
  }

  private handleActiveTimeout(slot: WorkerSlot, identity: TimelineHistoryWorkerIdentity): void {
    const active = slot.currentJob;
    if (!active || !sameIdentity(active.identity, identity)) return;
    this.clearActiveTimer(active);
    active.reject(new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT));
    slot.currentJob = null;
    const worker = slot.worker;
    slot.worker = null;
    slot.state = 'restarting';
    slot.stopping = true;
    void worker?.terminate().catch((error) => {
      logger.debug({ errorKind: describeError(error), slotId: slot.slotId }, 'TimelineHistoryWorkerPool: timed-out worker terminate failed');
    }).finally(() => {
      slot.stopping = false;
      this.scheduleRestart(slot);
    });
  }

  private drainQueueIfNoLiveCapacity(): void {
    if (this.queue.length === 0) return;
    const hasLiveCapacity = this.slots.some((slot) => slot.state === 'idle' || slot.state === 'busy');
    if (hasLiveCapacity) return;
    const error = new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.UNAVAILABLE);
    while (this.queue.length > 0) this.queue.shift()?.reject(error);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const error = new TimelineHistoryPoolError(TIMELINE_HISTORY_ERROR_REASONS.SHUTDOWN);
    while (this.queue.length > 0) this.queue.shift()?.reject(error);
    const terminations: Promise<unknown>[] = [];
    for (const slot of this.slots) {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
      const active = slot.currentJob;
      if (active) {
        this.clearActiveTimer(active);
        active.reject(error);
      }
      slot.currentJob = null;
      const worker = slot.worker;
      slot.worker = null;
      slot.state = 'dead';
      slot.stopping = true;
      if (worker) {
        terminations.push(worker.terminate().catch((terminateError) => {
          logger.debug({ errorKind: describeError(terminateError), slotId: slot.slotId }, 'TimelineHistoryWorkerPool: terminate failed');
        }));
      }
    }
    await Promise.allSettled(terminations);
    this.slots.length = 0;
    this.started = false;
    this.shuttingDown = false;
  }
}

function sameIdentity(a: TimelineHistoryWorkerIdentity, b: TimelineHistoryWorkerIdentity): boolean {
  return a.workerRequestId === b.workerRequestId
    && a.workerSlotId === b.workerSlotId
    && a.workerGeneration === b.workerGeneration;
}

function describeError(error: unknown): string {
  if (error instanceof TimelineHistoryPoolError) return error.reason;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function shouldUseTimelineHistoryWorkerPool(): boolean {
  if (process.env.IMCODES_TIMELINE_HISTORY_WORKER_POOL === '0') return false;
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return false;
  return true;
}

let defaultTimelineHistoryWorkerPool: TimelineHistoryWorkerPool | null = null;

export function getDefaultTimelineHistoryWorkerPool(): TimelineHistoryWorkerPool {
  defaultTimelineHistoryWorkerPool ??= new TimelineHistoryWorkerPool();
  return defaultTimelineHistoryWorkerPool;
}

export async function shutdownDefaultTimelineHistoryWorkerPoolForDaemon(): Promise<void> {
  await getDefaultTimelineHistoryWorkerPool().shutdown();
}

export function __resetTimelineHistoryWorkerPoolForTests(): void {
  const current = defaultTimelineHistoryWorkerPool;
  defaultTimelineHistoryWorkerPool = null;
  current?.shutdown().catch(() => {});
}
