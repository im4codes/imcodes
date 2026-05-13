import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FsGitStatusPoolError,
  FsGitStatusWorkerPool,
  type FsGitStatusWorkerThreadLike,
} from '../../src/daemon/fs-git-status-pool.js';
import type { FsGitStatusWorkerRequest, FsGitStatusWorkerResult } from '../../src/daemon/fs-git-status-worker-types.js';

class FakeFsGitStatusWorker implements FsGitStatusWorkerThreadLike {
  readonly listeners = new Map<string, Function[]>();
  readonly messages: FsGitStatusWorkerRequest[] = [];
  constructor(private readonly mode: 'success' | 'hang' = 'success') {}

  postMessage(message: FsGitStatusWorkerRequest): void {
    this.messages.push(message);
    if (this.mode !== 'success') return;
    setTimeout(() => {
      this.emit('message', {
        workerRequestId: message.workerRequestId,
        workerSlotId: message.workerSlotId,
        workerGeneration: message.workerGeneration,
        kind: 'success',
        repoRoot: message.repoRoot,
        repoSignature: message.repoSignature,
        requestedPath: message.requestedPath,
        includeStats: message.includeStats,
        files: [{ path: `${message.repoRoot}/src/a.ts`, code: 'M' }],
      } satisfies FsGitStatusWorkerResult);
    }, 0);
  }

  on(event: 'message' | 'error' | 'exit', listener: Function): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  async terminate(): Promise<void> {}
  unref(): void {}

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class ControlledFsGitStatusWorker implements FsGitStatusWorkerThreadLike {
  readonly listeners = new Map<string, Function[]>();
  readonly messages: FsGitStatusWorkerRequest[] = [];

  postMessage(message: FsGitStatusWorkerRequest): void {
    this.messages.push(message);
  }

  on(event: 'message' | 'error' | 'exit', listener: Function): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  async terminate(): Promise<void> {}
  unref(): void {}

  complete(index: number, files: Array<{ path: string; code: string }> = []): void {
    const message = this.messages[index];
    expect(message).toBeDefined();
    this.emit('message', {
      workerRequestId: message.workerRequestId,
      workerSlotId: message.workerSlotId,
      workerGeneration: message.workerGeneration,
      kind: 'success',
      repoRoot: message.repoRoot,
      repoSignature: message.repoSignature,
      requestedPath: message.requestedPath,
      includeStats: message.includeStats,
      files,
    } satisfies FsGitStatusWorkerResult);
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

describe('fs git status worker pool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches git status work to a worker with identity metadata', async () => {
    const worker = new FakeFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      createWorker: () => worker,
    });

    const result = await pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-1',
      requestedPath: '/tmp/project',
      includeStats: true,
    });

    expect(result.kind).toBe('success');
    expect(result.files).toEqual([{ path: '/tmp/project/src/a.ts', code: 'M' }]);
    expect(worker.messages[0]).toMatchObject({
      workerRequestId: 1,
      workerSlotId: 1,
      workerGeneration: 1,
      repoRoot: '/tmp/project',
      includeStats: true,
    });
    await pool.shutdown();
  });

  it('returns queue_full without falling back to inline git work', async () => {
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => new FakeFsGitStatusWorker(),
    });

    await expect(pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-1',
      requestedPath: '/tmp/project',
      includeStats: false,
    })).rejects.toMatchObject({ reason: 'queue_full' } satisfies Partial<FsGitStatusPoolError>);
    await pool.shutdown();
  });

  it('keeps one active child-process job per worker while later jobs wait in queue', async () => {
    const worker = new ControlledFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      queueCap: 2,
      createWorker: () => worker,
    });

    const first = pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-1',
      requestedPath: '/tmp/project',
      includeStats: false,
    });
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    expect(pool.getQueueDepth()).toBe(0);

    const second = pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-2',
      requestedPath: '/tmp/project/src',
      includeStats: false,
    });
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    expect(pool.getQueueDepth()).toBe(1);

    worker.complete(0, [{ path: '/tmp/project/a.ts', code: 'M' }]);
    await expect(first).resolves.toMatchObject({
      repoSignature: 'sig-1',
      files: [{ path: '/tmp/project/a.ts', code: 'M' }],
    });
    expect(worker.messages).toHaveLength(2);
    expect(pool.getQueueDepth()).toBe(0);

    worker.complete(1, [{ path: '/tmp/project/src/b.ts', code: 'M' }]);
    await expect(second).resolves.toMatchObject({
      repoSignature: 'sig-2',
      files: [{ path: '/tmp/project/src/b.ts', code: 'M' }],
    });
    await pool.shutdown();
  });

  it('treats queueCap zero as saturated before posting any worker job', async () => {
    const worker = new ControlledFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => worker,
    });

    await expect(pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-1',
      requestedPath: '/tmp/project',
      includeStats: false,
    })).rejects.toMatchObject({ reason: 'queue_full' } satisfies Partial<FsGitStatusPoolError>);
    expect(worker.messages).toHaveLength(0);
    await pool.shutdown();
  });

  it('times out a hanging worker and rejects the request terminally', async () => {
    vi.useFakeTimers();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 10,
      createWorker: () => new FakeFsGitStatusWorker('hang'),
    });

    const pending = pool.dispatch({
      repoRoot: '/tmp/project',
      repoSignature: 'sig-1',
      requestedPath: '/tmp/project',
      includeStats: false,
    });
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'timeout' } satisfies Partial<FsGitStatusPoolError>);

    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    await pool.shutdown();
  });
});
