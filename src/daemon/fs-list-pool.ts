import { Worker } from 'node:worker_threads';
import logger from '../util/logger.js';
import { recordFsWorkerMetric } from './latency-tracer.js';
import {
  DEFAULT_FS_LIST_POOL_QUEUE_CAP,
  DEFAULT_FS_LIST_WORKERS_TARGET,
  HARD_MAX_FS_LIST_WORKERS,
  MIN_FS_LIST_WORKERS_TARGET,
  isFsListWorkerResultFor,
  withFsListWorkerIdentity,
  type FsListBuildJobInput,
  type FsListWorkerGeneration,
  type FsListWorkerIdentity,
  type FsListWorkerRequest,
  type FsListWorkerRequestId,
  type FsListWorkerResult,
  type FsListWorkerSlotId,
  type FsListWorkerSuccess,
} from './fs-list-worker-types.js';

export type FsListPoolErrorReason = 'queue_full' | 'unavailable' | 'crashed' | 'shutdown' | 'timeout' | 'worker_internal';

export class FsListPoolError extends Error {
  constructor(readonly reason: FsListPoolErrorReason, message = reason) {
    super(message);
    this.name = 'FsListPoolError';
  }
}

export interface FsListWorkerThreadLike {
  postMessage(message: FsListWorkerRequest): void;
  on(event: 'message', listener: (message: FsListWorkerResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<unknown>;
  unref?(): void;
}

export interface FsListWorkerPoolOptions {
  workersTarget?: number;
  queueCap?: number;
  activeJobTimeoutMs?: number | null;
  restartBackoffMs?: number;
  clock?: { now(): number };
  createWorker?: (slotId: FsListWorkerSlotId, generation: FsListWorkerGeneration) => FsListWorkerThreadLike;
  onStaleResultDropped?: (event: Record<string, unknown>) => void;
}

export interface FsListDispatchOptions {
  deadlineAt?: number;
}

interface WorkerSlot {
  slotId: FsListWorkerSlotId;
  generation: FsListWorkerGeneration;
  state: 'idle' | 'busy' | 'restarting' | 'dead';
  worker: FsListWorkerThreadLike | null;
  currentJob: ActiveJob | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

interface ActiveJob {
  input: FsListBuildJobInput;
  identity: FsListWorkerIdentity;
  deadlineAt: number | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  resolve: (result: FsListWorkerSuccess) => void;
  reject: (error: FsListPoolError) => void;
}

interface QueuedJob {
  input: FsListBuildJobInput;
  deadlineAt: number | null;
  resolve: (result: FsListWorkerSuccess) => void;
  reject: (error: FsListPoolError) => void;
}

export const DEFAULT_FS_LIST_ACTIVE_JOB_TIMEOUT_MS = 15_000;
export const DEFAULT_FS_LIST_RESTART_BACKOFF_MS = 250;

function getWorkerModuleUrl(): URL {
  return new URL('./fs-list-worker-bootstrap.mjs', import.meta.url);
}

function clampWorkersTarget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_FS_LIST_WORKERS_TARGET;
  return Math.min(
    HARD_MAX_FS_LIST_WORKERS,
    Math.max(MIN_FS_LIST_WORKERS_TARGET, Math.trunc(value as number)),
  );
}

function createNodeWorker(): FsListWorkerThreadLike {
  const worker = new Worker(getWorkerModuleUrl());
  worker.unref();
  return worker as FsListWorkerThreadLike;
}

export class FsListWorkerPool {
  readonly workersTarget: number;
  readonly queueCap: number;
  private readonly activeJobTimeoutMs: number | null;
  private readonly restartBackoffMs: number;
  private readonly clock: { now(): number };
  private readonly createWorker: (slotId: FsListWorkerSlotId, generation: FsListWorkerGeneration) => FsListWorkerThreadLike;
  private readonly onStaleResultDropped?: (event: Record<string, unknown>) => void;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedJob[] = [];
  private nextWorkerRequestId: FsListWorkerRequestId = 1;
  private started = false;
  private shuttingDown = false;

  constructor(options: FsListWorkerPoolOptions = {}) {
    this.workersTarget = clampWorkersTarget(options.workersTarget);
    this.queueCap = Math.max(0, Math.trunc(options.queueCap ?? DEFAULT_FS_LIST_POOL_QUEUE_CAP));
    this.activeJobTimeoutMs = options.activeJobTimeoutMs === undefined
      ? DEFAULT_FS_LIST_ACTIVE_JOB_TIMEOUT_MS
      : options.activeJobTimeoutMs === null
        ? null
        : Math.max(1, Math.trunc(options.activeJobTimeoutMs));
    this.restartBackoffMs = Math.max(0, Math.trunc(options.restartBackoffMs ?? DEFAULT_FS_LIST_RESTART_BACKOFF_MS));
    this.clock = options.clock ?? { now: () => Date.now() };
    this.createWorker = options.createWorker ?? (() => createNodeWorker());
    this.onStaleResultDropped = options.onStaleResultDropped;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  async dispatch(input: FsListBuildJobInput, options: FsListDispatchOptions = {}): Promise<FsListWorkerSuccess> {
    if (this.shuttingDown) throw new FsListPoolError('shutdown');
    const deadlineAt = Number.isFinite(options.deadlineAt ?? NaN) ? Math.trunc(options.deadlineAt as number) : null;
    if (deadlineAt !== null && deadlineAt <= this.clock.now()) throw new FsListPoolError('timeout');
    this.ensureStarted();
    if (this.queue.length >= this.queueCap) throw new FsListPoolError('queue_full');
    return await new Promise<FsListWorkerSuccess>((resolve, reject) => {
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
      worker.on('error', (error) => {
        if (slot.worker !== worker) return;
        this.handleWorkerFailure(slot, generation, error);
      });
      worker.on('exit', (code) => {
        if (slot.stopping || slot.worker !== worker) return;
        this.handleWorkerFailure(slot, generation, new Error(`fs_list_worker_exit:${code}`));
      });
      slot.worker = worker;
      slot.state = 'idle';
      this.pump();
    } catch (error) {
      logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'FsListWorkerPool: worker startup failed');
      slot.worker = null;
      slot.state = 'dead';
      this.scheduleRestart(slot);
    }
  }

  private handleWorkerMessage(slot: WorkerSlot, generation: FsListWorkerGeneration, message: FsListWorkerResult): void {
    if (slot.generation !== generation || slot.state === 'dead') {
      this.recordStaleResultDropped(slot, generation, message, 'stale_worker_generation');
      return;
    }
    const active = slot.currentJob;
    if (!active) {
      this.recordStaleResultDropped(slot, generation, message, 'no_active_job');
      return;
    }
    if (!isFsListWorkerResultFor(message, active.identity)) {
      this.recordStaleResultDropped(slot, generation, message, 'identity_mismatch');
      return;
    }
    this.clearActiveTimer(active);
    slot.currentJob = null;
    slot.state = 'idle';
    if (message.kind === 'success') active.resolve(message);
    else active.reject(new FsListPoolError(message.reason));
    this.pump();
  }

  private recordStaleResultDropped(
    slot: WorkerSlot,
    listenerGeneration: FsListWorkerGeneration,
    message: FsListWorkerResult,
    reason: string,
  ): void {
    const event = {
      reason,
      slotId: slot.slotId,
      currentGeneration: slot.generation,
      listenerGeneration,
      workerRequestId: typeof message.workerRequestId === 'number' ? message.workerRequestId : undefined,
      workerSlotId: typeof message.workerSlotId === 'number' ? message.workerSlotId : undefined,
      workerGeneration: typeof message.workerGeneration === 'number' ? message.workerGeneration : undefined,
    };
    if (this.onStaleResultDropped) this.onStaleResultDropped(event);
    else {
      recordFsWorkerMetric({
        commandType: 'fs.ls',
        cacheStatus: 'stale_result_dropped',
        terminalReason: 'stale_result_dropped',
        ...event,
      });
    }
  }

  private handleWorkerFailure(slot: WorkerSlot, generation: FsListWorkerGeneration, error: Error): void {
    if (slot.generation !== generation || slot.stopping) return;
    logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'FsListWorkerPool: worker failed');
    const active = slot.currentJob;
    if (active) {
      this.clearActiveTimer(active);
      active.reject(new FsListPoolError('crashed'));
    }
    slot.currentJob = null;
    slot.worker = null;
    slot.state = 'restarting';
    this.scheduleRestart(slot);
  }

  private scheduleRestart(slot: WorkerSlot): void {
    if (this.shuttingDown || slot.stopping || slot.restartTimer) return;
    slot.restartTimer = setTimeout(() => this.startSlot(slot), this.restartBackoffMs);
    slot.restartTimer.unref?.();
  }

  private pump(): void {
    if (this.shuttingDown) return;
    for (const slot of this.slots) {
      if (slot.state !== 'idle' || !slot.worker || slot.currentJob) continue;
      const queued = this.takeNextLiveJob();
      if (!queued) return;
      const identity: FsListWorkerIdentity = {
        workerRequestId: this.nextWorkerRequestId++,
        workerSlotId: slot.slotId,
        workerGeneration: slot.generation,
      };
      const active: ActiveJob = { ...queued, identity, timeoutTimer: null };
      slot.currentJob = active;
      slot.state = 'busy';
      this.armActiveTimeout(slot, active);
      try {
        slot.worker.postMessage(withFsListWorkerIdentity(queued.input, identity));
      } catch (error) {
        this.clearActiveTimer(active);
        slot.currentJob = null;
        slot.worker = null;
        slot.state = 'restarting';
        queued.reject(new FsListPoolError('unavailable'));
        logger.warn({ errorKind: describeError(error), slotId: slot.slotId }, 'FsListWorkerPool: postMessage failed');
        this.scheduleRestart(slot);
      }
    }
  }

  private takeNextLiveJob(): QueuedJob | null {
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      if (queued.deadlineAt !== null && queued.deadlineAt <= this.clock.now()) {
        queued.reject(new FsListPoolError('timeout'));
        continue;
      }
      return queued;
    }
    return null;
  }

  private armActiveTimeout(slot: WorkerSlot, active: ActiveJob): void {
    if (this.activeJobTimeoutMs === null && active.deadlineAt === null) return;
    const now = this.clock.now();
    const delays = [
      this.activeJobTimeoutMs,
      active.deadlineAt === null ? null : active.deadlineAt - now,
    ].filter((value): value is number => typeof value === 'number');
    const delay = Math.max(1, Math.min(...delays));
    active.timeoutTimer = setTimeout(() => this.handleActiveTimeout(slot, active), delay);
    active.timeoutTimer.unref?.();
  }

  private handleActiveTimeout(slot: WorkerSlot, active: ActiveJob): void {
    if (slot.currentJob !== active) return;
    slot.currentJob = null;
    active.reject(new FsListPoolError('timeout'));
    const oldWorker = slot.worker;
    if (oldWorker) {
      slot.stopping = true;
      void oldWorker.terminate().catch(() => {});
    }
    slot.worker = null;
    slot.state = 'restarting';
    slot.stopping = false;
    this.scheduleRestart(slot);
  }

  private clearActiveTimer(active: ActiveJob): void {
    if (!active.timeoutTimer) return;
    clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const error = new FsListPoolError('shutdown');
    for (const queued of this.queue.splice(0)) queued.reject(error);
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      const active = slot.currentJob;
      if (active) {
        this.clearActiveTimer(active);
        active.reject(error);
      }
      slot.currentJob = null;
      slot.stopping = true;
      const worker = slot.worker;
      slot.worker = null;
      slot.state = 'dead';
      if (worker) await worker.terminate().catch(() => {});
    }));
  }
}

function describeError(error: unknown): string {
  if (error instanceof FsListPoolError) return error.reason;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function shouldUseFsListWorkerPool(): boolean {
  if (process.env.IMCODES_FS_LIST_WORKER_POOL === '0') return false;
  if (process.env.IMCODES_FS_LIST_WORKER_POOL === '1') return true;
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return false;
  return true;
}

let defaultFsListWorkerPool: FsListWorkerPool | null = null;

export function getDefaultFsListWorkerPool(): FsListWorkerPool {
  defaultFsListWorkerPool ??= new FsListWorkerPool();
  return defaultFsListWorkerPool;
}

export async function shutdownDefaultFsListWorkerPoolForDaemon(): Promise<void> {
  await getDefaultFsListWorkerPool().shutdown();
}

export function __resetFsListWorkerPoolForTests(): void {
  const current = defaultFsListWorkerPool;
  defaultFsListWorkerPool = null;
  current?.shutdown().catch(() => {});
}
