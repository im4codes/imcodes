import { describe, expect, it, vi } from 'vitest';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import {
  HARD_MAX_PREVIEW_READ_WORKERS,
  PreviewReadPoolError,
  PreviewReadWorkerPool,
  type PreviewReadWorkerThreadLike,
} from '../../src/daemon/file-preview-read-pool.js';
import type { PreviewReadWorkerRequest, PreviewReadWorkerResult } from '../../src/daemon/file-preview-read-types.js';

class ControlledWorker implements PreviewReadWorkerThreadLike {
  messageListener: ((message: PreviewReadWorkerResult) => void) | null = null;
  errorListener: ((error: Error) => void) | null = null;
  exitListener: ((code: number) => void) | null = null;
  posted: PreviewReadWorkerRequest[] = [];

  postMessage(message: PreviewReadWorkerRequest): void {
    this.posted.push(message);
  }

  on(event: 'message', listener: (message: PreviewReadWorkerResult) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'message' | 'error' | 'exit', listener: ((arg: PreviewReadWorkerResult | Error | number) => void)): this {
    if (event === 'message') this.messageListener = listener as (message: PreviewReadWorkerResult) => void;
    if (event === 'error') this.errorListener = listener as (error: Error) => void;
    if (event === 'exit') this.exitListener = listener as (code: number) => void;
    return this;
  }

  async terminate(): Promise<unknown> {
    this.exitListener?.(0);
    return 0;
  }

  emit(message: PreviewReadWorkerResult): void {
    this.messageListener?.(message);
  }

  fail(error = new Error('crash')): void {
    this.errorListener?.(error);
  }
}

function successFor(message: PreviewReadWorkerRequest): PreviewReadWorkerResult {
  return {
    phase: message.phase,
    workerRequestId: message.workerRequestId,
    workerSlotId: message.workerSlotId,
    workerGeneration: message.workerGeneration,
    kind: 'error',
    error: FS_READ_ERROR_CODES.INTERNAL_ERROR,
    sanitized: true,
  };
}

describe('PreviewReadWorkerPool', () => {
  it('defaults to two workers and runs two active jobs concurrently', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new PreviewReadWorkerPool({
      createWorker: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    expect(pool.workersTarget).toBe(2);

    const first = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    const second = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/b.txt' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(workers).toHaveLength(2);
    expect(workers[0]?.posted).toHaveLength(1);
    expect(workers[1]?.posted).toHaveLength(1);
    expect(pool.getSlotViews().filter((slot) => slot.state === 'busy')).toHaveLength(2);

    workers[0]!.emit(successFor(workers[0]!.posted[0]!));
    workers[1]!.emit(successFor(workers[1]!.posted[0]!));

    await expect(first).resolves.toMatchObject({ workerSlotId: 1 });
    await expect(second).resolves.toMatchObject({ workerSlotId: 2 });
    await pool.shutdown();
  });

  it('clamps worker count to the hard max', () => {
    const pool = new PreviewReadWorkerPool({ workersTarget: HARD_MAX_PREVIEW_READ_WORKERS + 10, createWorker: () => new ControlledWorker() });
    expect(pool.workersTarget).toBe(HARD_MAX_PREVIEW_READ_WORKERS);
  });

  it('rejects when the bounded queue is full', async () => {
    const worker = new ControlledWorker();
    const pool = new PreviewReadWorkerPool({ workersTarget: 1, queueCap: 1, createWorker: () => worker });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    const queued = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/b.txt' });
    await expect(pool.dispatch({ phase: 'preflight', rawPath: '/tmp/c.txt' })).rejects.toMatchObject({ reason: 'queue_full' });

    worker.emit(successFor(worker.posted[0]!));
    await expect(active).resolves.toBeDefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    worker.emit(successFor(worker.posted[1]!));
    await expect(queued).resolves.toBeDefined();
    await pool.shutdown();
  });

  it('maps worker crashes to pool errors', async () => {
    const worker = new ControlledWorker();
    const pool = new PreviewReadWorkerPool({ workersTarget: 1, restartBackoffMs: 0, createWorker: () => worker });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    worker.fail();

    await expect(active).rejects.toBeInstanceOf(PreviewReadPoolError);
    await expect(active).rejects.toMatchObject({ reason: 'crashed' });
    await pool.shutdown();
  });

  it('fails fast with unavailable when no worker can start', async () => {
    const pool = new PreviewReadWorkerPool({
      workersTarget: 2,
      restartBackoffMs: 10_000,
      createWorker: () => {
        throw new Error('bootstrap failed');
      },
    });

    await expect(pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(pool.getSlotViews().every((slot) => slot.state === 'restarting')).toBe(true);
    await pool.shutdown();
  });

  it('times out an active job and restarts the worker slot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const workers: ControlledWorker[] = [];
    const pool = new PreviewReadWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 10,
      restartBackoffMs: 1,
      createWorker: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/slow.txt' }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(11);

    await expect(active).resolves.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1);

    expect(workers).toHaveLength(2);
    expect(pool.getSlotViews()[0]).toMatchObject({ state: 'idle', generation: 2 });
    await pool.shutdown();
    vi.useRealTimers();
  });

  it('rejects a queued job whose admission deadline expires before it reaches a worker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const worker = new ControlledWorker();
    const pool = new PreviewReadWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 1_000,
      createWorker: () => worker,
    });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/active.txt' }, { deadlineAt: 1_000 });
    const queued = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/queued.txt' }, { deadlineAt: 5 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(6);

    expect(worker.posted).toHaveLength(1);
    worker.emit(successFor(worker.posted[0]!));
    await expect(active).resolves.toBeDefined();
    await expect(queued).resolves.toMatchObject({ reason: 'timeout' });
    expect(worker.posted).toHaveLength(1);

    await pool.shutdown();
    vi.useRealTimers();
  });

  it('uses remaining admission budget for active watchdog instead of the full active timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pool = new PreviewReadWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 100,
      createWorker: () => new ControlledWorker(),
    });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/slow.txt' }, { deadlineAt: 10 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(11);

    await expect(active).resolves.toMatchObject({ reason: 'timeout' });
    await pool.shutdown();
    vi.useRealTimers();
  });

  it('drains queued jobs as unavailable when timed-out workers cannot restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const workers: ControlledWorker[] = [];
    const pool = new PreviewReadWorkerPool({
      workersTarget: 2,
      activeJobTimeoutMs: 5,
      restartBackoffMs: 10_000,
      createWorker: () => {
        if (workers.length >= 2) throw new Error('restart failed');
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    const first = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' }).catch((error) => error);
    const second = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/b.txt' }).catch((error) => error);
    const queued = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/c.txt' }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(6);

    await expect(first).resolves.toMatchObject({ reason: 'timeout' });
    await expect(second).resolves.toMatchObject({ reason: 'timeout' });
    await expect(queued).resolves.toMatchObject({ reason: 'unavailable' });

    await pool.shutdown();
    vi.useRealTimers();
  });

  it('ignores stale worker-generation results and waits for the active generation', async () => {
    const worker = new ControlledWorker();
    const pool = new PreviewReadWorkerPool({ workersTarget: 1, createWorker: () => worker });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    await flushTimers();
    const posted = worker.posted[0]!;
    worker.emit({
      ...successFor(posted),
      workerGeneration: posted.workerGeneration + 1,
    });
    await flushTimers();

    expect(pool.getSlotViews()[0]).toMatchObject({ state: 'busy', generation: posted.workerGeneration });

    worker.emit(successFor(posted));
    await expect(active).resolves.toMatchObject({ workerGeneration: posted.workerGeneration });
    await pool.shutdown();
  });

  it('recycles a worker after its configured job count without affecting other workers', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new PreviewReadWorkerPool({
      workersTarget: 2,
      workerRecycleJobCount: 1,
      createWorker: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    const first = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    const second = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/b.txt' });
    await flushTimers();

    workers[0]!.emit(successFor(workers[0]!.posted[0]!));
    workers[1]!.emit(successFor(workers[1]!.posted[0]!));
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    await flushTimers();

    expect(workers.length).toBeGreaterThanOrEqual(4);
    expect(pool.getSlotViews().map((slot) => slot.generation)).toEqual([2, 2]);
    await pool.shutdown();
  });
});

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
