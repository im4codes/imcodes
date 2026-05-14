import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';
import * as fsp from 'node:fs/promises';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';

const fsListPoolMock = vi.hoisted(() => {
  class MockFsListPoolError extends Error {
    constructor(readonly reason: string) {
      super(reason);
      this.name = 'FsListPoolError';
    }
  }
  return {
    dispatch: vi.fn(),
    FsListPoolError: MockFsListPoolError,
  };
});

const mockPreviewCoordinator = vi.hoisted(() => ({
  handle: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    realpath: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock('../../src/daemon/fs-list-pool.js', () => ({
  FsListPoolError: fsListPoolMock.FsListPoolError,
  getDefaultFsListWorkerPool: vi.fn(() => ({ dispatch: fsListPoolMock.dispatch })),
  shouldUseFsListWorkerPool: vi.fn(() => true),
}));

vi.mock('../../src/daemon/file-preview-read-coordinator.js', () => ({
  getDefaultPreviewReadCoordinator: vi.fn(() => mockPreviewCoordinator),
  __resetPreviewReadCoordinatorForTests: vi.fn(),
}), { virtual: true });

import { handleWebCommand, __resetFsGitCachesForTests } from '../../src/daemon/command-handler.js';

const mockRealpath = vi.mocked(fsp.realpath);
const mockStat = vi.mocked(fsp.stat);

const sent: unknown[] = [];
const mockServerLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

const flushAsync = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const flushMicrotasks = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

type FsListSuccessForTest = {
  kind: 'success';
  resolvedPath: string;
  dirSignature: string;
  entries: Array<Record<string, unknown>>;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDirStats(mtimeMs = 1, size = 0) {
  return {
    mtimeMs,
    size,
    isDirectory: () => true,
    isFile: () => false,
  } as unknown as fsp.Stats;
}

describe('fs.ls worker handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsListPoolMock.dispatch.mockReset();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    __resetFsGitCachesForTests();
    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockResolvedValue(makeDirStats());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces identical in-flight fs.ls worker listings', async () => {
    const dir = path.join(homedir(), 'project');
    const pending = createDeferred<FsListSuccessForTest>();
    fsListPoolMock.dispatch.mockReturnValueOnce(pending.promise);

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-coalesce-1', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-coalesce-2', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);
    pending.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '1:0',
      entries: [{ name: 'src', path: path.join(dir, 'src'), isDir: true }],
    });
    await flushAsync();

    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'ls-coalesce-1', status: 'ok' }),
      expect.objectContaining({ requestId: 'ls-coalesce-2', status: 'ok' }),
    ]));
  });

  it('starts fresh fs.ls worker work when directory freshness changes', async () => {
    const dir = path.join(homedir(), 'project-freshness');
    const first = createDeferred<FsListSuccessForTest>();
    const second = createDeferred<FsListSuccessForTest>();
    let currentMtime = 1;
    mockStat.mockImplementation(async () => makeDirStats(currentMtime));
    fsListPoolMock.dispatch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-old', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);

    currentMtime = 2;
    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-new', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(2);

    second.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '2:0',
      entries: [{ name: 'fresh.txt', path: path.join(dir, 'fresh.txt'), isDir: false }],
    });
    await flushAsync();
    expect(sent.find((msg: any) => msg.requestId === 'ls-new')).toMatchObject({
      status: 'ok',
      entries: [expect.objectContaining({ name: 'fresh.txt' })],
    });

    first.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '1:0',
      entries: [{ name: 'old.txt', path: path.join(dir, 'old.txt'), isDir: false }],
    });
    await flushAsync();
    expect(sent.find((msg: any) => msg.requestId === 'ls-old')).toMatchObject({
      status: 'ok',
      entries: [expect.objectContaining({ name: 'old.txt' })],
    });
  });

  it('does not cache an fs.ls worker completion admitted under stale freshness', async () => {
    const dir = path.join(homedir(), 'project-stale-complete');
    const first = createDeferred<FsListSuccessForTest>();
    let currentMtime = 1;
    mockStat.mockImplementation(async () => makeDirStats(currentMtime));
    fsListPoolMock.dispatch
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        kind: 'success',
        resolvedPath: dir,
        dirSignature: '2:0',
        entries: [{ name: 'fresh.txt', path: path.join(dir, 'fresh.txt'), isDir: false }],
      });

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-stale-first', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);

    currentMtime = 2;
    first.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '2:0',
      entries: [{ name: 'stale.txt', path: path.join(dir, 'stale.txt'), isDir: false }],
    });
    await flushAsync();

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-stale-second', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(2);
    expect(sent.find((msg: any) => msg.requestId === 'ls-stale-second')).toMatchObject({
      status: 'ok',
      entries: [expect.objectContaining({ name: 'fresh.txt' })],
    });
  });

  it('reuses a stale-but-valid fs.ls cache entry when the worker queue is full', async () => {
    const dir = path.join(homedir(), 'project-stale-cache');
    let now = 1_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    fsListPoolMock.dispatch
      .mockResolvedValueOnce({
        kind: 'success',
        resolvedPath: dir,
        dirSignature: '1:0',
        entries: [{ name: 'cached.txt', path: path.join(dir, 'cached.txt'), isDir: false }],
      })
      .mockRejectedValueOnce(new fsListPoolMock.FsListPoolError('queue_full'));

    try {
      handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-cache-prime', includeFiles: true }, mockServerLink as any);
      await flushAsync();
      expect(sent.find((msg: any) => msg.requestId === 'ls-cache-prime')).toMatchObject({ status: 'ok' });

      now += 6_000;
      handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-cache-stale', includeFiles: true }, mockServerLink as any);
      await flushAsync();

      expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(2);
      expect(sent.find((msg: any) => msg.requestId === 'ls-cache-stale')).toMatchObject({
        status: 'ok',
        entries: [expect.objectContaining({ name: 'cached.txt' })],
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('keeps attached fs.ls siblings eligible after one request times out', async () => {
    vi.useFakeTimers();
    const dir = path.join(homedir(), 'project-sibling-timeout');
    const pending = createDeferred<FsListSuccessForTest>();
    fsListPoolMock.dispatch.mockReturnValueOnce(pending.promise);

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-timeout-first', includeFiles: true }, mockServerLink as any);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_000);
    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-timeout-sibling', includeFiles: true }, mockServerLink as any);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();
    expect(sent).toEqual([
      expect.objectContaining({
        requestId: 'ls-timeout-first',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT,
      }),
    ]);

    pending.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '1:0',
      entries: [{ name: 'late-but-valid.txt', path: path.join(dir, 'late-but-valid.txt'), isDir: false }],
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      requestId: 'ls-timeout-sibling',
      status: 'ok',
      entries: [expect.objectContaining({ name: 'late-but-valid.txt' })],
    });
  });

  it('returns queue_full when fs.ls inflight fan-out is capped', async () => {
    const dir = path.join(homedir(), 'project-fanout-cap');
    const pending = createDeferred<FsListSuccessForTest>();
    fsListPoolMock.dispatch.mockReturnValueOnce(pending.promise);

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-fanout-1', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);

    for (let index = 2; index <= 33; index += 1) {
      handleWebCommand({ type: 'fs.ls', path: dir, requestId: `ls-fanout-${index}`, includeFiles: true }, mockServerLink as any);
    }
    await flushAsync();

    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      expect.objectContaining({
        requestId: 'ls-fanout-33',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL,
      }),
    ]);

    pending.resolve({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: '1:0',
      entries: [{ name: 'shared.txt', path: path.join(dir, 'shared.txt'), isDir: false }],
    });
    await flushAsync();

    expect(sent).toHaveLength(33);
    expect(sent.filter((msg: any) => msg.status === 'ok')).toHaveLength(32);
    expect(sent.find((msg: any) => msg.requestId === 'ls-fanout-32')).toMatchObject({
      status: 'ok',
      entries: [expect.objectContaining({ name: 'shared.txt' })],
    });
  });

  it('returns worker_queue_full as a terminal fs.ls response', async () => {
    const dir = path.join(homedir(), 'project');
    fsListPoolMock.dispatch.mockRejectedValueOnce(new fsListPoolMock.FsListPoolError('queue_full'));

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-queue-full', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    expect(fsListPoolMock.dispatch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'ls-queue-full',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FS_LIST_WORKER_QUEUE_FULL,
    });
  });

  it('does not send a late worker success after the fs.ls handler deadline', async () => {
    vi.useFakeTimers();
    const dir = path.join(homedir(), 'slow-project');
    let resolveDispatch!: (value: {
      kind: 'success';
      resolvedPath: string;
      dirSignature: string;
      entries: Array<Record<string, unknown>>;
    }) => void;
    fsListPoolMock.dispatch.mockReturnValueOnce(new Promise((resolve) => {
      resolveDispatch = resolve;
    }));

    handleWebCommand({ type: 'fs.ls', path: dir, requestId: 'ls-timeout', includeFiles: true }, mockServerLink as any);
    await vi.advanceTimersByTimeAsync(10_001);
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'ls-timeout',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT,
    });

    resolveDispatch({
      kind: 'success',
      resolvedPath: dir,
      dirSignature: 'late',
      entries: [{ name: 'late.txt', path: path.join(dir, 'late.txt'), isDir: false }],
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  it('rejects forbidden fs.ls paths before worker dispatch', async () => {
    const denied = path.join(homedir(), '.ssh');
    mockRealpath.mockResolvedValue(denied as unknown as string);

    handleWebCommand({ type: 'fs.ls', path: denied, requestId: 'ls-forbidden-worker' }, mockServerLink as any);
    await flushAsync();

    expect(fsListPoolMock.dispatch).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'ls-forbidden-worker',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
  });
});
