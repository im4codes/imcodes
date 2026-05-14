import { Worker } from 'node:worker_threads';
import logger from '../util/logger.js';
import { recordFsWorkerMetric } from './latency-tracer.js';
import {
  DEFAULT_FS_GIT_STATUS_POOL_QUEUE_CAP,
  DEFAULT_FS_GIT_STATUS_WORKERS_TARGET,
  HARD_MAX_FS_GIT_STATUS_WORKERS,
  MIN_FS_GIT_STATUS_WORKERS_TARGET,
  isFsGitStatusWorkerResultFor,
  withFsGitStatusWorkerIdentity,
  type FsGitStatusBuildJobInput,
  type FsGitStatusWorkerGeneration,
  type FsGitStatusWorkerIdentity,
  type FsGitStatusWorkerRequest,
  type FsGitStatusWorkerRequestId,
  type FsGitStatusWorkerResult,
  type FsGitStatusWorkerSlotId,
  type FsGitStatusWorkerSuccess,
} from './fs-git-status-worker-types.js';

export type FsGitStatusPoolErrorReason = 'queue_full' | 'unavailable' | 'crashed' | 'shutdown' | 'timeout' | 'worker_internal' | 'git_unavailable';

export class FsGitStatusPoolError extends Error {
  constructor(readonly reason: FsGitStatusPoolErrorReason, message = reason) {
    super(message);
    this.name = 'FsGitStatusPoolError';
  }
}

export interface FsGitStatusWorkerThreadLike {
  postMessage(message: FsGitStatusWorkerRequest): void;
  on(event: 'message', listener: (message: FsGitStatusWorkerResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<unknown>;
  unref?(): void;
}

export interface FsGitStatusWorkerPoolOptions {
  workersTarget?: number;
  queueCap?: number;
  activeJobTimeoutMs?: number | null;
  restartBackoffMs?: number;
  clock?: { now(): number };
  createWorker?: (slotId: FsGitStatusWorkerSlotId, generation: FsGitStatusWorkerGeneration) => FsGitStatusWorkerThreadLike;
  onStaleResultDropped?: (event: Record<string, unknown>) => void;
}

export interface FsGitStatusDispatchOptions {
  deadlineAt?: number;
}

interface WorkerSlot {
  slotId: FsGitStatusWorkerSlotId;
  generation: FsGitStatusWorkerGeneration;
  state: 'idle' | 'busy' | 'restarting' | 'dead';
  worker: FsGitStatusWorkerThreadLike | null;
  currentJob: ActiveJob | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

interface ActiveJob {
  input: FsGitStatusBuildJobInput;
  identity: FsGitStatusWorkerIdentity;
  deadlineAt: number | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  resolve: (result: FsGitStatusWorkerSuccess) => void;
  reject: (error: FsGitStatusPoolError) => void;
}

interface QueuedJob {
  input: FsGitStatusBuildJobInput;
  deadlineAt: number | null;
  resolve: (result: FsGitStatusWorkerSuccess) => void;
  reject: (error: FsGitStatusPoolError) => void;
}

export const DEFAULT_FS_GIT_STATUS_ACTIVE_JOB_TIMEOUT_MS = 15_000;
export const DEFAULT_FS_GIT_STATUS_RESTART_BACKOFF_MS = 250;

function getWorkerModuleUrl(): URL {
  return new URL('./fs-git-status-worker-bootstrap.mjs', import.meta.url);
}

function clampWorkersTarget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_FS_GIT_STATUS_WORKERS_TARGET;
  return Math.min(
    HARD_MAX_FS_GIT_STATUS_WORKERS,
    Math.max(MIN_FS_GIT_STATUS_WORKERS_TARGET, Math.trunc(value as number)),
  );
}

function createNodeWorker(): FsGitStatusWorkerThreadLike {
  const worker = new Worker(getWorkerModuleUrl());
  worker.unref();
  return worker as FsGitStatusWorkerThreadLike;
}

export class FsGitStatusWorkerPool {
  readonly workersTarget: number;
  readonly queueCap: number;
  private readonly activeJobTimeoutMs: number | null;
  private readonly restartBackoffMs: number;
  private readonly clock: { now(): number };
  private readonly createWorker: (slotId: FsGitStatusWorkerSlotId, generation: FsGitStatusWorkerGeneration) => FsGitStatusWorkerThreadLike;
  private readonly onStaleResultDropped?: (event: Record<string, unknown>) => void;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedJob[] = [];
  private nextWorkerRequestId: FsGitStatusWorkerRequestId = 1;
  private started = false;
  private shuttingDown = false;

  constructor(options: FsGitStatusWorkerPoolOptions = {}) {
    this.workersTarget = clampWorkersTarget(options.workersTarget);
    this.queueCap = Math.max(0, Math.trunc(options.queueCap ?? DEFAULT_FS_GIT_STATUS_POOL_QUEUE_CAP));
    this.activeJobTimeoutMs = options.activeJobTimeoutMs === undefined
      ? DEFAULT_FS_GIT_STATUS_ACTIVE_JOB_TIMEOUT_MS
      : options.activeJobTimeoutMs === null
        ? null
        : Math.max(1, Math.trunc(options.activeJobTimeoutMs));
    this.restartBackoffMs = Math.max(0, Math.trunc(options.restartBackoffMs ?? DEFAULT_FS_GIT_STATUS_RESTART_BACKOFF_MS));
    this.clock = options.clock ?? { now: () => Date.now() };
    this.createWorker = options.createWorker ?? (() => createNodeWorker());
    this.onStaleResultDropped = options.onStaleResultDropped;
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  async dispatch(input: FsGitStatusBuildJobInput, options: FsGitStatusDispatchOptions = {}): Promise<FsGitStatusWorkerSuccess> {
    if (this.shuttingDown) throw new FsGitStatusPoolError('shutdown');
    const deadlineAt = Number.isFinite(options.deadlineAt ?? NaN) ? Math.trunc(options.deadlineAt as number) : null;
    if (deadlineAt !== null && deadlineAt <= this.clock.now()) throw new FsGitStatusPoolError('timeout');
    this.ensureStarted();
    if (this.queue.length >= this.queueCap) throw new FsGitStatusPoolError('queue_full');
    return await new Promise<FsGitStatusWorkerSuccess>((resolve, reject) => {
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
        this.handleWorkerFailure(slot, generation, new Error(`fs_git_status_worker_exit:${code}`));
      });
      slot.worker = worker;
      slot.state = 'idle';
      this.pump();
    } catch (error) {
      logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'FsGitStatusWorkerPool: worker startup failed');
      slot.worker = null;
      slot.state = 'dead';
      this.scheduleRestart(slot);
    }
  }

  private handleWorkerMessage(slot: WorkerSlot, generation: FsGitStatusWorkerGeneration, message: FsGitStatusWorkerResult): void {
    if (slot.generation !== generation || slot.state === 'dead') {
      this.recordStaleResultDropped(slot, generation, message, 'stale_worker_generation');
      return;
    }
    const active = slot.currentJob;
    if (!active) {
      this.recordStaleResultDropped(slot, generation, message, 'no_active_job');
      return;
    }
    if (!isFsGitStatusWorkerResultFor(message, active.identity)) {
      this.recordStaleResultDropped(slot, generation, message, 'identity_mismatch');
      return;
    }
    this.clearActiveTimer(active);
    slot.currentJob = null;
    slot.state = 'idle';
    if (message.kind === 'success') active.resolve(message);
    else active.reject(new FsGitStatusPoolError(message.reason));
    this.pump();
  }

  private recordStaleResultDropped(
    slot: WorkerSlot,
    listenerGeneration: FsGitStatusWorkerGeneration,
    message: FsGitStatusWorkerResult,
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
        commandType: 'fs.git_status',
        cacheStatus: 'stale_result_dropped',
        terminalReason: 'stale_result_dropped',
        ...event,
      });
    }
  }

  private handleWorkerFailure(slot: WorkerSlot, generation: FsGitStatusWorkerGeneration, error: Error): void {
    if (slot.generation !== generation || slot.stopping) return;
    logger.warn({ errorKind: describeError(error), slotId: slot.slotId, generation }, 'FsGitStatusWorkerPool: worker failed');
    const active = slot.currentJob;
    if (active) {
      this.clearActiveTimer(active);
      active.reject(new FsGitStatusPoolError('crashed'));
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
      const identity: FsGitStatusWorkerIdentity = {
        workerRequestId: this.nextWorkerRequestId++,
        workerSlotId: slot.slotId,
        workerGeneration: slot.generation,
      };
      const active: ActiveJob = { ...queued, identity, timeoutTimer: null };
      slot.currentJob = active;
      slot.state = 'busy';
      this.armActiveTimeout(slot, active);
      try {
        slot.worker.postMessage(withFsGitStatusWorkerIdentity(queued.input, identity));
      } catch (error) {
        this.clearActiveTimer(active);
        slot.currentJob = null;
        slot.worker = null;
        slot.state = 'restarting';
        queued.reject(new FsGitStatusPoolError('unavailable'));
        logger.warn({ errorKind: describeError(error), slotId: slot.slotId }, 'FsGitStatusWorkerPool: postMessage failed');
        this.scheduleRestart(slot);
      }
    }
  }

  private takeNextLiveJob(): QueuedJob | null {
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      if (queued.deadlineAt !== null && queued.deadlineAt <= this.clock.now()) {
        queued.reject(new FsGitStatusPoolError('timeout'));
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
    active.reject(new FsGitStatusPoolError('timeout'));
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
    const error = new FsGitStatusPoolError('shutdown');
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
  if (error instanceof FsGitStatusPoolError) return error.reason;
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function shouldUseFsGitStatusWorkerPool(): boolean {
  if (process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL === '0') return false;
  if (process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL === '1') return true;
  if (process.env.VITEST === 'true' || process.env.VITEST_WORKER_ID !== undefined) return false;
  return true;
}

let defaultFsGitStatusWorkerPool: FsGitStatusWorkerPool | null = null;

export function getDefaultFsGitStatusWorkerPool(): FsGitStatusWorkerPool {
  defaultFsGitStatusWorkerPool ??= new FsGitStatusWorkerPool();
  return defaultFsGitStatusWorkerPool;
}

export function __setDefaultFsGitStatusWorkerPoolForTests(pool: FsGitStatusWorkerPool | null): void {
  defaultFsGitStatusWorkerPool = pool;
}

export async function shutdownDefaultFsGitStatusWorkerPoolForDaemon(): Promise<void> {
  await getDefaultFsGitStatusWorkerPool().shutdown();
}

export function __resetFsGitStatusWorkerPoolForTests(): void {
  const current = defaultFsGitStatusWorkerPool;
  defaultFsGitStatusWorkerPool = null;
  current?.shutdown().catch(() => {});
}
