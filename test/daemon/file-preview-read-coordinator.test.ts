import { describe, expect, it, vi } from 'vitest';
import { FS_READ_ERROR_CODES } from '../../shared/fs-read-error-codes.js';
import { PreviewReadAdmissionController } from '../../src/daemon/file-preview-read-admission.js';
import {
  PreviewReadCoordinator,
  shouldUseInProcessPreviewReadPoolForTests,
  type PreviewReadCoordinatorErrorCodes,
} from '../../src/daemon/file-preview-read-coordinator.js';
import { PreviewReadPoolError, type PreviewReadWorkerDispatchOptions } from '../../src/daemon/file-preview-read-pool.js';
import type {
  ExternalRequestRecord,
  PreviewReadAssembleErrorInput,
  PreviewReadAssembleResultInput,
} from '../../src/daemon/file-preview-read-coordinator.js';
import type {
  PreviewReadPreflightSuccess,
  PreviewReadSnapshotSuccess,
  PreviewReadWorkerJobInput,
  PreviewReadWorkerResult,
} from '../../src/daemon/file-preview-read-types.js';

type TestResponse = {
  requestId: string;
  path: string;
  status: 'ok' | 'error';
  resolvedPath?: string;
  content?: string;
  error?: string;
};

const errorCodes: PreviewReadCoordinatorErrorCodes = {
  queueFull: FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
  timeout: FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT,
  unavailable: FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE,
  crashed: FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED,
  staleRead: FS_READ_ERROR_CODES.STALE_READ,
  invalidRequest: FS_READ_ERROR_CODES.INVALID_REQUEST,
  internalError: FS_READ_ERROR_CODES.INTERNAL_ERROR,
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function preflight(rawPath: string): PreviewReadPreflightSuccess {
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
    classification: {
      previewKind: 'text',
      extension: 'txt',
      sizeLimitBytes: 100 * 1024 * 1024,
      mimeType: rawPath.endsWith('.txt') ? 'text/plain' : undefined,
    },
  };
}

function snapshot(endSignature = '1000:11'): PreviewReadSnapshotSuccess {
  return {
    phase: 'snapshot',
    workerRequestId: 2,
    workerSlotId: 1,
    workerGeneration: 1,
    kind: 'success',
    realPath: '/real/shared.txt',
    startSignature: '1000:11',
    endSignature,
    size: 11,
    mtimeMs: 1000,
    fileName: 'shared.txt',
    classification: { previewKind: 'text', extension: 'txt', sizeLimitBytes: 100 * 1024 * 1024 },
    payload: { mode: 'text', content: 'hello world' },
  };
}

function makeCoordinator(pool: {
  dispatch(input: PreviewReadWorkerJobInput, options?: PreviewReadWorkerDispatchOptions): Promise<PreviewReadWorkerResult>;
  getQueueDepth(): number;
  shutdown(): Promise<void>;
}, responses: TestResponse[], admission = new PreviewReadAdmissionController({ tEstimateMs: 1 }), options: { attachedCap?: number } = {}) {
  return new PreviewReadCoordinator<TestResponse>({
    errorCodes,
    pool,
    admission,
    ...(options.attachedCap ? { attachedCap: options.attachedCap } : {}),
    send: (response) => {
      responses.push(response);
    },
    assembleResult(input: PreviewReadAssembleResultInput): TestResponse {
      const payload = input.snapshot.payload;
      return {
        requestId: input.request.requestId,
        path: input.request.rawPath,
        resolvedPath: input.snapshot.realPath,
        status: 'ok',
        content: payload.mode === 'text' ? payload.content : undefined,
      };
    },
    assembleError(input: PreviewReadAssembleErrorInput): TestResponse {
      return {
        requestId: input.requestId,
        path: input.rawPath,
        resolvedPath: input.resolvedPath,
        status: 'error',
        error: input.error,
      };
    },
  });
}

describe('PreviewReadCoordinator', () => {
  it('suppresses missing requestId and returns invalid_request for invalid path', async () => {
    const responses: TestResponse[] = [];
    const pool = { dispatch: vi.fn(), getQueueDepth: () => 0, shutdown: vi.fn(async () => {}) };
    const coordinator = makeCoordinator(pool as never, responses);

    expect(coordinator.submit({ path: '/tmp/a.txt' })).toMatchObject({ suppressed: true });
    expect(coordinator.submit({ requestId: 'bad', path: '' })).toMatchObject({ invalid: true });
    await flush();

    expect(pool.dispatch).not.toHaveBeenCalled();
    expect(responses).toEqual([{ requestId: 'bad', path: '', status: 'error', error: FS_READ_ERROR_CODES.INVALID_REQUEST }]);
  });

  it('fans out canonical aliases to one snapshot and preserves each raw path', async () => {
    let finishSnapshot: ((value: PreviewReadWorkerResult) => void) | null = null;
    const finishPreflights: Array<() => void> = [];
    const dispatches: PreviewReadWorkerJobInput[] = [];
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput) => {
        dispatches.push(input);
        if (input.phase === 'preflight') {
          return await new Promise<PreviewReadWorkerResult>((resolve) => {
            finishPreflights.push(() => resolve(preflight(input.rawPath)));
          });
        }
        return await new Promise<PreviewReadWorkerResult>((resolve) => { finishSnapshot = resolve; });
      }),
    };
    const coordinator = makeCoordinator(pool, responses);

    coordinator.submit({ requestId: 'r1', path: '/alias/one.txt' });
    coordinator.submit({ requestId: 'r2', path: '/alias/two.txt' });
    await flush();
    await flush();

    expect(dispatches.filter((input) => input.phase === 'preflight')).toHaveLength(2);
    finishPreflights[0]?.();
    await flush();
    expect(dispatches.filter((input) => input.phase === 'snapshot')).toHaveLength(1);
    finishPreflights[1]?.();
    for (
      let i = 0;
      i < 10 && coordinator.getExternalRequest('r2')?.attachmentState?.phase !== 'snapshot';
      i += 1
    ) {
      await flush();
    }
    expect(dispatches.filter((input) => input.phase === 'snapshot')).toHaveLength(1);

    finishSnapshot?.(snapshot());
    await flush();
    await coordinator.fanout.flush();

    expect(responses).toEqual([
      { requestId: 'r1', path: '/alias/one.txt', resolvedPath: '/real/shared.txt', status: 'ok', content: 'hello world' },
      { requestId: 'r2', path: '/alias/two.txt', resolvedPath: '/real/shared.txt', status: 'ok', content: 'hello world' },
    ]);
    expect(coordinator.getExternalRequest('r1')).toBeNull();
    expect(coordinator.getExternalRequest('r2')).toBeNull();
  });

  it('returns stale_read and does not cache when snapshot freshness changes', async () => {
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput) => input.phase === 'preflight' ? preflight(input.rawPath) : snapshot('2000:12')),
    };
    const coordinator = makeCoordinator(pool, responses);

    coordinator.submit({ requestId: 'r1', path: '/alias/one.txt' });
    await flush();
    await flush();

    expect(responses).toEqual([
      {
        requestId: 'r1',
        path: '/alias/one.txt',
        resolvedPath: '/real/shared.txt',
        status: 'error',
        error: FS_READ_ERROR_CODES.STALE_READ,
      },
    ]);
  });

  it('fails fast on deterministic admission rejection', async () => {
    const responses: TestResponse[] = [];
    const pool = { dispatch: vi.fn(), getQueueDepth: () => 0, shutdown: vi.fn(async () => {}) };
    const coordinator = makeCoordinator(
      pool as never,
      responses,
      new PreviewReadAdmissionController({ queueCap: 0, tEstimateMs: 1 }),
    );

    expect(coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' }).accepted).toBe(false);
    await flush();

    expect(pool.dispatch).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({
      requestId: 'r1',
      status: 'error',
      error: FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
    });
  });

  it('maps pool crashes to visible preview_worker_crashed responses', async () => {
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        throw new PreviewReadPoolError('crashed');
      }),
    };
    const coordinator = makeCoordinator(pool, responses);

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    await flush();

    expect(responses).toEqual([{
      requestId: 'r1',
      path: '/tmp/a.txt',
      status: 'error',
      error: FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED,
    }]);
  });

  it('rejects additional attachments when the preflight fan-out cap is reached', async () => {
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>(() => {})),
    };
    const coordinator = new PreviewReadCoordinator<TestResponse>({
      errorCodes,
      pool,
      admission: new PreviewReadAdmissionController({ tEstimateMs: 1 }),
      attachedCap: 1,
      send: (response) => { responses.push(response); },
      assembleResult(input: PreviewReadAssembleResultInput): TestResponse {
        return { requestId: input.request.requestId, path: input.request.rawPath, status: 'ok' };
      },
      assembleError(input: PreviewReadAssembleErrorInput): TestResponse {
        return {
          requestId: input.requestId,
          path: input.rawPath,
          resolvedPath: input.resolvedPath,
          status: 'error',
          error: input.error,
        };
      },
    });

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    coordinator.submit({ requestId: 'r2', path: '/tmp/a.txt' });
    await flush();

    expect(responses).toEqual([{
      requestId: 'r2',
      path: '/tmp/a.txt',
      status: 'error',
      error: FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
    }]);
    await coordinator.shutdown();
  });

  it('times out pending work and ignores late completion', async () => {
    vi.useFakeTimers();
    const responses: TestResponse[] = [];
    let finishPreflight: ((value: PreviewReadWorkerResult) => void) | null = null;
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>((resolve) => { finishPreflight = resolve; })),
    };
    const coordinator = makeCoordinator(
      pool,
      responses,
      new PreviewReadAdmissionController({ deadlineMs: 10, safetyMarginMs: 0, tEstimateMs: 1 }),
    );

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    await vi.advanceTimersByTimeAsync(11);
    await flush();

    expect(responses).toEqual([{ requestId: 'r1', path: '/tmp/a.txt', status: 'error', error: FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT }]);

    finishPreflight?.(preflight('/tmp/a.txt'));
    await flush();
    expect(responses).toHaveLength(1);
    vi.useRealTimers();
  });

  it('does not write a late snapshot into active cache after every request timed out', async () => {
    vi.useFakeTimers();
    let finishSnapshot: ((value: PreviewReadWorkerResult) => void) | null = null;
    const dispatches: PreviewReadWorkerJobInput[] = [];
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput) => {
        dispatches.push(input);
        if (input.phase === 'preflight') return preflight(input.rawPath);
        return await new Promise<PreviewReadWorkerResult>((resolve) => { finishSnapshot = resolve; });
      }),
    };
    const coordinator = makeCoordinator(
      pool,
      responses,
      new PreviewReadAdmissionController({ deadlineMs: 10, safetyMarginMs: 0, tEstimateMs: 1 }),
    );

    coordinator.submit({ requestId: 'r1', path: '/alias/one.txt' });
    await flush();
    await vi.advanceTimersByTimeAsync(11);
    await coordinator.fanout.flush();

    expect(responses).toEqual([{
      requestId: 'r1',
      path: '/alias/one.txt',
      status: 'error',
      error: FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT,
    }]);

    finishSnapshot?.(snapshot());
    await flush();
    await coordinator.fanout.flush();
    expect(responses).toHaveLength(1);

    coordinator.submit({ requestId: 'r2', path: '/alias/one.txt' });
    await flush();

    expect(dispatches.filter((input) => input.phase === 'preflight')).toHaveLength(2);
    expect(dispatches.filter((input) => input.phase === 'snapshot')).toHaveLength(2);
    await coordinator.shutdown();
    vi.useRealTimers();
  });

  it('does not cache a snapshot that completes after invalidation', async () => {
    let finishSnapshot: ((value: PreviewReadWorkerResult) => void) | null = null;
    const dispatches: PreviewReadWorkerJobInput[] = [];
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput) => {
        dispatches.push(input);
        if (input.phase === 'preflight') return preflight(input.rawPath);
        return await new Promise<PreviewReadWorkerResult>((resolve) => { finishSnapshot = resolve; });
      }),
    };
    const coordinator = makeCoordinator(pool, responses);

    coordinator.submit({ requestId: 'r1', path: '/alias/one.txt' });
    await flush();
    await flush();
    coordinator.invalidatePath('/real/shared.txt');
    finishSnapshot?.(snapshot());
    await flush();
    await coordinator.fanout.flush();

    expect(responses).toHaveLength(1);
    expect(dispatches.filter((input) => input.phase === 'snapshot')).toHaveLength(1);

    coordinator.submit({ requestId: 'r2', path: '/alias/one.txt' });
    await flush();
    await flush();

    expect(dispatches.filter((input) => input.phase === 'preflight')).toHaveLength(2);
    expect(dispatches.filter((input) => input.phase === 'snapshot')).toHaveLength(2);
    await coordinator.shutdown();
  });

  it('shutdown drains active requests with unavailable responses', async () => {
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>(() => {})),
    };
    const coordinator = makeCoordinator(pool, responses);

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    await coordinator.shutdown();
    await flush();

    expect(responses[0]).toMatchObject({
      requestId: 'r1',
      path: '/tmp/a.txt',
      status: 'error',
      error: FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE,
    });
  });

  it('records external request state for admission deadlines', () => {
    const responses: TestResponse[] = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async () => await new Promise<PreviewReadWorkerResult>(() => {})),
    };
    const coordinator = makeCoordinator(pool, responses, new PreviewReadAdmissionController({ deadlineMs: 1234, safetyMarginMs: 0, tEstimateMs: 1 }));

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    const record = coordinator.getExternalRequest('r1') as ExternalRequestRecord;

    expect(record.rawPath).toBe('/tmp/a.txt');
    expect(record.deadlineAt - record.admittedAt).toBe(1234);
    expect(record.terminal).toBe(false);
  });

  it('passes the same admission deadline to preflight and snapshot dispatch without adding it to worker input', async () => {
    const responses: TestResponse[] = [];
    const dispatches: Array<{ input: PreviewReadWorkerJobInput; options?: PreviewReadWorkerDispatchOptions }> = [];
    const pool = {
      getQueueDepth: () => 0,
      shutdown: vi.fn(async () => {}),
      dispatch: vi.fn(async (input: PreviewReadWorkerJobInput, options?: PreviewReadWorkerDispatchOptions) => {
        dispatches.push({ input, options });
        return input.phase === 'preflight' ? preflight(input.rawPath) : snapshot();
      }),
    };
    const coordinator = makeCoordinator(
      pool,
      responses,
      new PreviewReadAdmissionController({ deadlineMs: 1234, safetyMarginMs: 0, tEstimateMs: 1 }),
    );

    coordinator.submit({ requestId: 'r1', path: '/tmp/a.txt' });
    await flush();
    await flush();
    await coordinator.fanout.flush();

    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.input).toMatchObject({ phase: 'preflight', rawPath: '/tmp/a.txt' });
    expect(dispatches[1]?.input).toMatchObject({ phase: 'snapshot' });
    expect(dispatches[0]?.options?.deadlineAt).toEqual(expect.any(Number));
    expect(dispatches[1]?.options?.deadlineAt).toBe(dispatches[0]?.options?.deadlineAt);
    expect(dispatches[0]?.input).not.toHaveProperty('deadlineAt');
    expect(dispatches[1]?.input).not.toHaveProperty('deadlineAt');
    expect(responses[0]).toMatchObject({ requestId: 'r1', status: 'ok' });
  });

  it('does not use the in-process test worker when NODE_ENV=test is the only test signal', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    const previousVitestWorkerId = process.env.VITEST_WORKER_ID;
    try {
      process.env.NODE_ENV = 'test';
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;

      expect(shouldUseInProcessPreviewReadPoolForTests()).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousVitestWorkerId === undefined) delete process.env.VITEST_WORKER_ID;
      else process.env.VITEST_WORKER_ID = previousVitestWorkerId;
    }
  });
});
