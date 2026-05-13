import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FsListPoolError,
  FsListWorkerPool,
  type FsListWorkerThreadLike,
} from '../../src/daemon/fs-list-pool.js';
import type { FsListWorkerRequest, FsListWorkerResult } from '../../src/daemon/fs-list-worker-types.js';

class FakeFsListWorker implements FsListWorkerThreadLike {
  readonly listeners = new Map<string, Function[]>();
  readonly messages: FsListWorkerRequest[] = [];
  constructor(private readonly mode: 'success' | 'hang' = 'success') {}

  postMessage(message: FsListWorkerRequest): void {
    this.messages.push(message);
    if (this.mode !== 'success') return;
    setTimeout(() => {
      this.emit('message', {
        workerRequestId: message.workerRequestId,
        workerSlotId: message.workerSlotId,
        workerGeneration: message.workerGeneration,
        kind: 'success',
        resolvedPath: message.realPath,
        dirSignature: '1:0',
        entries: [],
      } satisfies FsListWorkerResult);
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

class ControlledFsListWorker implements FsListWorkerThreadLike {
  readonly listeners = new Map<string, Function[]>();
  readonly messages: FsListWorkerRequest[] = [];

  postMessage(message: FsListWorkerRequest): void {
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
}

describe('fs list worker pool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches fs list work to a worker with identity metadata', async () => {
    const worker = new FakeFsListWorker();
    const pool = new FsListWorkerPool({
      workersTarget: 1,
      createWorker: () => worker,
    });

    const result = await pool.dispatch({
      realPath: '/tmp/project',
      includeFiles: true,
      includeMetadata: false,
    });

    expect(result.kind).toBe('success');
    expect(result.resolvedPath).toBe('/tmp/project');
    expect(worker.messages[0]).toMatchObject({
      workerRequestId: 1,
      workerSlotId: 1,
      workerGeneration: 1,
      realPath: '/tmp/project',
    });
    await pool.shutdown();
  });

  it('returns queue_full without falling back to inline directory scans', async () => {
    const pool = new FsListWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => new FakeFsListWorker(),
    });

    await expect(pool.dispatch({
      realPath: '/tmp/project',
      includeFiles: true,
      includeMetadata: false,
    })).rejects.toMatchObject({ reason: 'queue_full' } satisfies Partial<FsListPoolError>);
    await pool.shutdown();
  });

  it('treats queueCap zero as terminal saturation before posting worker work', async () => {
    const worker = new ControlledFsListWorker();
    const pool = new FsListWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => worker,
    });

    await expect(pool.dispatch({
      realPath: '/tmp/project',
      includeFiles: true,
      includeMetadata: false,
    })).rejects.toMatchObject({ reason: 'queue_full' } satisfies Partial<FsListPoolError>);
    expect(worker.messages).toHaveLength(0);
    await pool.shutdown();
  });

  it('times out a hanging worker and rejects the request terminally', async () => {
    vi.useFakeTimers();
    const pool = new FsListWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 10,
      createWorker: () => new FakeFsListWorker('hang'),
    });

    const pending = pool.dispatch({
      realPath: '/tmp/project',
      includeFiles: true,
      includeMetadata: false,
    });
    const rejection = expect(pending).rejects.toMatchObject({ reason: 'timeout' } satisfies Partial<FsListPoolError>);

    await vi.advanceTimersByTimeAsync(11);
    await rejection;
    await pool.shutdown();
  });
});
