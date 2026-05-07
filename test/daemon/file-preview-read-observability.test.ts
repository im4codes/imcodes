import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import {
  __resetPreviewReadMetricsForTests,
  getPreviewReadMetricsSnapshot,
} from '../../src/daemon/file-preview-read-observability.js';
import { PreviewReadAdmissionController } from '../../src/daemon/file-preview-read-admission.js';
import { PreviewReadCoordinator, type PreviewReadCoordinatorErrorCodes } from '../../src/daemon/file-preview-read-coordinator.js';
import {
  PreviewReadWorkerPool,
  type PreviewReadWorkerThreadLike,
} from '../../src/daemon/file-preview-read-pool.js';
import type {
  PreviewReadPreflightSuccess,
  PreviewReadWorkerJobInput,
  PreviewReadWorkerRequest,
  PreviewReadWorkerResult,
} from '../../src/daemon/file-preview-read-types.js';

const errorCodes: PreviewReadCoordinatorErrorCodes = {
  queueFull: FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
  timeout: FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT,
  unavailable: FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE,
  crashed: FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED,
  staleRead: FS_READ_ERROR_CODES.STALE_READ,
  invalidRequest: FS_READ_ERROR_CODES.INVALID_REQUEST,
  internalError: FS_READ_ERROR_CODES.INTERNAL_ERROR,
};

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

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function preflight(): PreviewReadPreflightSuccess {
  return {
    phase: 'preflight',
    workerRequestId: 1,
    workerSlotId: 1,
    workerGeneration: 1,
    kind: 'success',
    realPath: '/real/shared.txt',
    startSignature: '1000:11',
    size: 11,
    mtimeMs: 1000,
    fileName: 'shared.txt',
    classification: { previewKind: 'text', extension: 'txt', sizeLimitBytes: 100 * 1024 * 1024 },
  };
}

function makeCoordinator(pool: {
  dispatch(input: PreviewReadWorkerJobInput): Promise<PreviewReadWorkerResult>;
  getQueueDepth(): number;
  shutdown(): Promise<void>;
}, responses: Array<Record<string, unknown>>, admission = new PreviewReadAdmissionController({ tEstimateMs: 1 })) {
  return new PreviewReadCoordinator<Record<string, unknown>>({
    errorCodes,
    pool,
    admission,
    send: (response) => { responses.push(response); },
    assembleResult: ({ request }) => ({ requestId: request.requestId, path: request.rawPath, status: 'ok' }),
    assembleError: ({ requestId, rawPath, error }) => ({ requestId, path: rawPath, status: 'error', error }),
  });
}

describe('preview-read observability', () => {
  beforeEach(() => {
    __resetPreviewReadMetricsForTests();
  });

  it('records pool lifecycle, queue, crash, restart, recycle, and shutdown counters without path labels', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new PreviewReadWorkerPool({
      workersTarget: 1,
      queueCap: 1,
      workerRecycleJobCount: 1,
      restartBackoffMs: 0,
      createWorker: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    const active = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    const queued = pool.dispatch({ phase: 'preflight', rawPath: '/tmp/b.txt' });
    await expect(pool.dispatch({ phase: 'preflight', rawPath: '/tmp/c.txt' })).rejects.toMatchObject({ reason: 'queue_full' });
    workers[0]!.fail();
    await expect(active).rejects.toMatchObject({ reason: 'crashed' });
    await expect(queued).rejects.toMatchObject({ reason: 'unavailable' });
    await pool.shutdown();

    const recycleWorkers: ControlledWorker[] = [];
    const recyclePool = new PreviewReadWorkerPool({
      workersTarget: 1,
      workerRecycleJobCount: 1,
      createWorker: () => {
        const worker = new ControlledWorker();
        recycleWorkers.push(worker);
        return worker;
      },
    });
    const recycled = recyclePool.dispatch({ phase: 'preflight', rawPath: '/tmp/recycle.txt' });
    await flush();
    const posted = recycleWorkers[0]!.posted[0]!;
    recycleWorkers[0]!.emit({
      phase: posted.phase,
      workerRequestId: posted.workerRequestId,
      workerSlotId: posted.workerSlotId,
      workerGeneration: posted.workerGeneration,
      kind: 'error',
      error: FS_READ_ERROR_CODES.INTERNAL_ERROR,
      sanitized: true,
    });
    await expect(recycled).resolves.toBeDefined();
    await flush();
    await recyclePool.shutdown();

    const metrics = getPreviewReadMetricsSnapshot();
    expect(metrics.worker_startup).toBeGreaterThanOrEqual(2);
    expect(metrics.queue_full).toBe(1);
    expect(metrics.worker_crash).toBe(1);
    expect(metrics.worker_restart).toBe(1);
    expect(metrics.worker_recycle).toBe(1);
    expect(metrics.worker_shutdown).toBeGreaterThanOrEqual(0);
    expect(Object.keys(metrics)).not.toContain('/tmp/a.txt');
  });

  it('records timeout, stale, shutdown drain, and sanitized internal-error counters', async () => {
    vi.useFakeTimers();
    const timeoutResponses: Array<Record<string, unknown>> = [];
    const timeoutPool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>(() => {})),
    };
    const timeoutCoordinator = makeCoordinator(
      timeoutPool,
      timeoutResponses,
      new PreviewReadAdmissionController({ deadlineMs: 10, safetyMarginMs: 0, tEstimateMs: 1 }),
    );

    timeoutCoordinator.submit({ requestId: 'timeout', path: '/tmp/a.txt' });
    await vi.advanceTimersByTimeAsync(11);
    await flush();
    await timeoutCoordinator.shutdown();
    vi.useRealTimers();

    const drainResponses: Array<Record<string, unknown>> = [];
    const drainPool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>(() => {})),
    };
    const drainCoordinator = makeCoordinator(drainPool, drainResponses);
    drainCoordinator.submit({ requestId: 'drain', path: '/tmp/drain.txt' });
    await drainCoordinator.shutdown();

    const staleResponses: Array<Record<string, unknown>> = [];
    const stalePool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput) => input.phase === 'preflight'
        ? preflight()
        : {
          ...preflight(),
          phase: 'snapshot' as const,
          workerRequestId: 2,
          endSignature: '2000:11',
          payload: { mode: 'text' as const, content: 'mixed' },
        }),
    };
    makeCoordinator(stalePool, staleResponses).submit({ requestId: 'stale', path: '/tmp/a.txt' });
    await flush();
    await flush();

    const internalResponses: Array<Record<string, unknown>> = [];
    const internalPool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        phase: 'preflight',
        workerRequestId: 1,
        workerSlotId: 1,
        workerGeneration: 1,
        kind: 'error',
        error: FS_READ_ERROR_CODES.INTERNAL_ERROR,
        sanitized: true,
      } as PreviewReadWorkerResult)),
    };
    makeCoordinator(internalPool, internalResponses).submit({ requestId: 'internal', path: '/tmp/a.txt' });
    await flush();

    const metrics = getPreviewReadMetricsSnapshot();
    expect(metrics.timeout).toBe(1);
    expect(metrics.shutdown_drain).toBe(1);
    expect(metrics.stale_read).toBe(1);
    expect(metrics.sanitized_internal_error).toBe(1);
  });
});
