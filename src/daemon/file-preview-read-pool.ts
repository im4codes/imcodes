import { Worker } from 'node:worker_threads';
import logger from '../util/logger.js';
import { PREVIEW_READ_METRICS, recordPreviewReadMetric } from './file-preview-read-observability.js';
import {
  DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP,
  DEFAULT_PREVIEW_READ_WORKERS_TARGET,
  HARD_MAX_PREVIEW_READ_WORKERS,
  MIN_PREVIEW_READ_WORKERS_TARGET,
  isPreviewReadWorkerResultFor,
  withPreviewReadWorkerIdentity,
  type PreviewReadWorkerGeneration,
  type PreviewReadWorkerIdentity,
  type PreviewReadWorkerJobInput,
  type PreviewReadWorkerRequest,
  type PreviewReadWorkerRequestId,
  type PreviewReadWorkerResult,
  type PreviewReadWorkerSlotId,
} from './file-preview-read-types.js';

export {
  DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP,
  DEFAULT_PREVIEW_READ_WORKERS_TARGET,
  HARD_MAX_PREVIEW_READ_WORKERS,
  MIN_PREVIEW_READ_WORKERS_TARGET,
} from './file-preview-read-types.js';
export const DEFAULT_PREVIEW_READ_WORKER_RESTART_BACKOFF_MS = 250;
export const DEFAULT_PREVIEW_READ_WORKER_RECYCLE_JOB_COUNT = 50;
export const DEFAULT_PREVIEW_READ_ACTIVE_JOB_TIMEOUT_MS = 18_000;

export type PreviewReadWorkerSlotStateName = 'idle' | 'busy' | 'restarting' | 'dead';
export type PreviewReadPoolErrorReason = 'queue_full' | 'unavailable' | 'crashed' | 'shutdown' | 'stale_result' | 'timeout';

export class PreviewReadPoolError extends Error {
  constructor(readonly reason: PreviewReadPoolErrorReason, message = reason) {
    super(message);
    this.name = 'PreviewReadPoolError';
  }
}

export interface PreviewReadWorkerThreadLike {
  postMessage(message: PreviewReadWorkerRequest): void;
  on(event: 'message', listener: (message: PreviewReadWorkerResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<unknown>;
  unref?(): void;
}

export interface PreviewReadWorkerSlotView {
  slotId: PreviewReadWorkerSlotId;
  generation: PreviewReadWorkerGeneration;
  state: PreviewReadWorkerSlotStateName;
  currentJob: PreviewReadWorkerIdentity | null;
  jobCount: number;
}

interface WorkerSlot {
  slotId: PreviewReadWorkerSlotId;
  generation: PreviewReadWorkerGeneration;
  state: PreviewReadWorkerSlotStateName;
  worker: PreviewReadWorkerThreadLike | null;
  currentJob: ActiveJob | null;
  jobCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

interface ActiveJob {
  input: PreviewReadWorkerJobInput;
  deadlineAt: number | null;
  identity: PreviewReadWorkerIdentity;
  resolve: (result: PreviewReadWorkerResult) => void;
  reject: (error: PreviewReadPoolError) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

interface QueuedJob {
  input: PreviewReadWorkerJobInput;
  deadlineAt: number | null;
  resolve: (result: PreviewReadWorkerResult) => void;
  reject: (error: PreviewReadPoolError) => void;
}

export interface PreviewReadWorkerDispatchOptions {
  deadlineAt?: number;
}

export interface PreviewReadWorkerPoolOptions {
  workersTarget?: number;
  queueCap?: number;
  restartBackoffMs?: number;
  activeJobTimeoutMs?: number | null;
  workerRecycleJobCount?: number | null;
  clock?: { now(): number };
  createWorker?: (slotId: PreviewReadWorkerSlotId, generation: PreviewReadWorkerGeneration) => PreviewReadWorkerThreadLike;
}

function getWorkerModuleUrl(): URL {
  return new URL('./file-preview-read-worker-bootstrap.mjs', import.meta.url);
}

export function clampPreviewReadWorkersTarget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PREVIEW_READ_WORKERS_TARGET;
  return Math.min(
    HARD_MAX_PREVIEW_READ_WORKERS,
    Math.max(MIN_PREVIEW_READ_WORKERS_TARGET, Math.trunc(value as number)),
  );
}

function createNodeWorker(): PreviewReadWorkerThreadLike {
  const worker = new Worker(getWorkerModuleUrl());
  worker.unref();
  return worker as PreviewReadWorkerThreadLike;
}

export class PreviewReadWorkerPool {
  readonly workersTarget: number;
  readonly queueCap: number;
  private readonly restartBackoffMs: number;
  private readonly activeJobTimeoutMs: number | null;
  private readonly workerRecycleJobCount: number | null;
  private readonly clock: { now(): number };
  private readonly createWorker: (slotId: PreviewReadWorkerSlotId, generation: PreviewReadWorkerGeneration) => PreviewReadWorkerThreadLike;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedJob[] = [];
  private nextWorkerRequestId: PreviewReadWorkerRequestId = 1;
  private started = false;
  private shuttingDown = false;

  constructor(options: PreviewReadWorkerPoolOptions = {}) {
    this.workersTarget = clampPreviewReadWorkersTarget(options.workersTarget);
    this.queueCap = Math.max(0, Math.trunc(options.queueCap ?? DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP));
    this.restartBackoffMs = Math.max(0, Math.trunc(options.restartBackoffMs ?? DEFAULT_PREVIEW_READ_WORKER_RESTART_BACKOFF_MS));
    this.activeJobTimeoutMs = options.activeJobTimeoutMs === undefined
      ? DEFAULT_PREVIEW_READ_ACTIVE_JOB_TIMEOUT_MS
      : options.activeJobTimeoutMs === null
        ? null
        : Math.max(1, Math.trunc(options.activeJobTimeoutMs));
    this.workerRecycleJobCount = options.workerRecycleJobCount === undefined
      ? DEFAULT_PREVIEW_READ_WORKER_RECYCLE_JOB_COUNT
      : options.workerRecycleJobCount === null
        ? null
        : Math.max(1, Math.trunc(options.workerRecycleJobCount));
    this.clock = options.clock ?? { now: () => Date.now() };
    this.createWorker = options.createWorker ?? (() => createNodeWorker());
    if (options.workersTarget !== undefined && options.workersTarget !== this.workersTarget) {
      logger.warn({ requested: options.workersTarget, effective: this.workersTarget }, 'PreviewReadWorkerPool: workersTarget clamped');
    }
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getSlotViews(): PreviewReadWorkerSlotView[] {
    return this.slots.map((slot) => ({
      slotId: slot.slotId,
      generation: slot.generation,
      state: slot.state,
      currentJob: slot.currentJob?.identity ?? null,
      jobCount: slot.jobCount,
    }));
  }

  isAvailable(): boolean {
    return !this.shuttingDown && (!this.started || this.slots.some((slot) => slot.state === 'idle' || slot.state === 'busy'));
  }

  async dispatch(input: PreviewReadWorkerJobInput, options: PreviewReadWorkerDispatchOptions = {}): Promise<PreviewReadWorkerResult> {
    if (this.shuttingDown) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_UNAVAILABLE);
      throw new PreviewReadPoolError('shutdown');
    }
    const deadlineAt = normalizeDispatchDeadline(options.deadlineAt);
    if (this.isDeadlineExpired(deadlineAt)) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.TIMEOUT);
      throw new PreviewReadPoolError('timeout');
    }
    this.ensureStarted();
    if (!this.isAvailable()) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_UNAVAILABLE);
      throw new PreviewReadPoolError('unavailable');
    }
    if (this.queue.length >= this.queueCap) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.QUEUE_FULL);
      throw new PreviewReadPoolError('queue_full');
    }
    return await new Promise<PreviewReadWorkerResult>((resolve, reject) => {
      this.queue.push({ input, deadlineAt, resolve, reject });
      this.pump();
    });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.workersTarget; i++) {
      const slot: WorkerSlot = {
        slotId: i + 1,
        generation: 0,
        state: 'dead',
	        worker: null,
	        currentJob: null,
        jobCount: 0,
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
        if (code !== 0) {
          this.handleWorkerFailure(slot, generation, new Error(`preview_read_worker_exit:${code}`));
        } else {
          this.handleWorkerFailure(slot, generation, new Error('preview_read_worker_exit'));
        }
      });
      slot.worker = worker;
      slot.state = 'idle';
      recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_STARTUP);
      logger.debug({ slotId: slot.slotId, generation }, 'PreviewReadWorkerPool: worker started');
      this.pump();
    } catch (error) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_UNAVAILABLE);
      logger.warn({ errorKind: describeWorkerError(error), slotId: slot.slotId, generation }, 'PreviewReadWorkerPool: worker startup failed');
      slot.worker = null;
      slot.state = 'dead';
      this.scheduleRestart(slot);
    }
  }

  private handleWorkerMessage(
    slot: WorkerSlot,
    generation: PreviewReadWorkerGeneration,
    message: PreviewReadWorkerResult,
  ): void {
    if (slot.generation !== generation || slot.state === 'dead') return;
    const current = slot.currentJob;
    if (!current) return;
    if (!isPreviewReadWorkerResultFor(message, current.identity)) return;
    this.clearActiveJobTimer(current);
    slot.currentJob = null;
    slot.state = 'idle';
    slot.jobCount += 1;
    current.resolve(message);
    if (this.workerRecycleJobCount !== null && slot.jobCount >= this.workerRecycleJobCount) {
      this.recycleSlot(slot);
      return;
    }
    this.pump();
  }

  private handleWorkerFailure(slot: WorkerSlot, generation: PreviewReadWorkerGeneration, error: Error): void {
    if (slot.generation !== generation || slot.stopping) return;
    recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_CRASH);
    logger.warn({ errorKind: describeWorkerError(error), slotId: slot.slotId, generation }, 'PreviewReadWorkerPool: worker failed');
    const active = slot.currentJob;
    if (active) this.clearActiveJobTimer(active);
    slot.currentJob = null;
    slot.worker = null;
    slot.state = 'restarting';
    if (active) active.reject(new PreviewReadPoolError('crashed'));
    this.scheduleRestart(slot);
  }

  private scheduleRestart(slot: WorkerSlot): void {
    if (this.shuttingDown) return;
    if (slot.restartTimer) return;
    recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_RESTART);
    slot.state = 'restarting';
    this.drainQueueIfNoLiveCapacity();
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.startSlot(slot);
    }, this.restartBackoffMs);
    slot.restartTimer.unref?.();
  }

  private recycleSlot(slot: WorkerSlot): void {
    const worker = slot.worker;
    recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_RECYCLE);
    slot.worker = null;
    slot.state = 'restarting';
    slot.jobCount = 0;
    slot.stopping = true;
    void worker?.terminate().catch((error) => {
      logger.debug({ errorKind: describeWorkerError(error), slotId: slot.slotId }, 'PreviewReadWorkerPool: recycle terminate failed');
    }).finally(() => {
      slot.stopping = false;
      this.startSlot(slot);
    });
  }

  private pump(): void {
    if (this.shuttingDown || this.queue.length === 0) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.state !== 'idle' || !slot.worker || slot.currentJob) continue;
      const queued = this.queue.shift();
      if (!queued) return;
      if (this.isDeadlineExpired(queued.deadlineAt)) {
        recordPreviewReadMetric(PREVIEW_READ_METRICS.TIMEOUT);
        queued.reject(new PreviewReadPoolError('timeout'));
        this.pump();
        return;
      }
      const identity: PreviewReadWorkerIdentity = {
        workerRequestId: this.nextWorkerRequestId++,
        workerSlotId: slot.slotId,
        workerGeneration: slot.generation,
      };
      const active: ActiveJob = { ...queued, identity, timeoutTimer: null };
      slot.currentJob = active;
      slot.state = 'busy';
      try {
        slot.worker.postMessage(withPreviewReadWorkerIdentity(queued.input, identity));
        this.armActiveJobTimer(slot, active);
      } catch (error) {
        this.clearActiveJobTimer(active);
        slot.currentJob = null;
        queued.reject(new PreviewReadPoolError('unavailable'));
        this.handleWorkerFailure(slot, slot.generation, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const unavailable = new PreviewReadPoolError('shutdown');
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued?.reject(unavailable);
    }
    const terminations: Promise<unknown>[] = [];
    for (const slot of this.slots) {
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      const active = slot.currentJob;
      if (active) this.clearActiveJobTimer(active);
      slot.currentJob = null;
      if (active) active.reject(unavailable);
      const worker = slot.worker;
      slot.worker = null;
      slot.state = 'dead';
      slot.stopping = true;
      if (worker) {
        recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_SHUTDOWN);
        terminations.push(worker.terminate().catch((error) => {
          logger.debug({ errorKind: describeWorkerError(error), slotId: slot.slotId }, 'PreviewReadWorkerPool: terminate failed');
        }));
      }
    }
    await Promise.allSettled(terminations);
    this.slots.length = 0;
    this.started = false;
    this.shuttingDown = false;
  }

  private armActiveJobTimer(slot: WorkerSlot, active: ActiveJob): void {
    if (this.activeJobTimeoutMs === null && active.deadlineAt === null) return;
    const timeoutMs = this.getActiveJobTimeoutMs(active.deadlineAt);
    if (timeoutMs <= 0) {
      this.handleActiveJobTimeout(slot, active.identity);
      return;
    }
    active.timeoutTimer = setTimeout(() => {
      this.handleActiveJobTimeout(slot, active.identity);
    }, timeoutMs);
    active.timeoutTimer.unref?.();
  }

  private clearActiveJobTimer(active: ActiveJob): void {
    if (!active.timeoutTimer) return;
    clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
  }

  private handleActiveJobTimeout(slot: WorkerSlot, identity: PreviewReadWorkerIdentity): void {
    const active = slot.currentJob;
    if (!active || !sameWorkerIdentity(active.identity, identity)) return;
    this.clearActiveJobTimer(active);
    recordPreviewReadMetric(PREVIEW_READ_METRICS.TIMEOUT);
    active.reject(new PreviewReadPoolError('timeout'));
    slot.currentJob = null;
    const worker = slot.worker;
    slot.worker = null;
    slot.state = 'restarting';
    slot.stopping = true;
    void worker?.terminate().catch((error) => {
      logger.debug({ errorKind: describeWorkerError(error), slotId: slot.slotId }, 'PreviewReadWorkerPool: timed-out worker terminate failed');
    }).finally(() => {
      slot.stopping = false;
      this.scheduleRestart(slot);
    });
  }

  private isDeadlineExpired(deadlineAt: number | null): boolean {
    return deadlineAt !== null && deadlineAt <= this.clock.now();
  }

  private getActiveJobTimeoutMs(deadlineAt: number | null): number {
    if (deadlineAt === null) return this.activeJobTimeoutMs ?? 0;
    const remainingMs = deadlineAt - this.clock.now();
    if (this.activeJobTimeoutMs === null) return remainingMs;
    return Math.min(this.activeJobTimeoutMs, remainingMs);
  }

  private drainQueueIfNoLiveCapacity(): void {
    if (this.shuttingDown || this.queue.length === 0) return;
    const hasLiveCapacity = this.slots.some((slot) => slot.state === 'idle' || slot.state === 'busy');
    if (hasLiveCapacity) return;
    recordPreviewReadMetric(PREVIEW_READ_METRICS.WORKER_UNAVAILABLE);
    const unavailable = new PreviewReadPoolError('unavailable');
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(unavailable);
    }
  }
}

function normalizeDispatchDeadline(deadlineAt: number | undefined): number | null {
  return Number.isFinite(deadlineAt ?? NaN) ? Math.trunc(deadlineAt as number) : null;
}

function sameWorkerIdentity(a: PreviewReadWorkerIdentity, b: PreviewReadWorkerIdentity): boolean {
  return a.workerRequestId === b.workerRequestId
    && a.workerSlotId === b.workerSlotId
    && a.workerGeneration === b.workerGeneration;
}

function describeWorkerError(error: unknown): string {
  if (error instanceof PreviewReadPoolError) return error.reason;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}
