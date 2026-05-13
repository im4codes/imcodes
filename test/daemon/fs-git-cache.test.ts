import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { homedir } from 'node:os';
import * as fsp from 'node:fs/promises';
import * as childProcess from 'node:child_process';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: vi.fn(),
    realpath: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const exec = vi.fn();
  const execFile = vi.fn();
  (exec as any)[Symbol.for('nodejs.util.promisify.custom')] = (command: string, options?: unknown) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(command, options, (err: Error | null, stdout = '', stderr = '') => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  (execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[], options?: unknown) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, options, (err: Error | null, stdout = '', stderr = '') => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  return {
    ...actual,
    exec,
    execFile,
  };
});

import { handleWebCommand, __resetFsGitCachesForTests } from '../../src/daemon/command-handler.js';
import { FsGitStatusWorkerPool, __setDefaultFsGitStatusWorkerPoolForTests, type FsGitStatusWorkerThreadLike } from '../../src/daemon/fs-git-status-pool.js';
import type { FsGitStatusWorkerRequest, FsGitStatusWorkerResult } from '../../src/daemon/fs-git-status-worker-types.js';

const mockRealpath = vi.mocked(fsp.realpath);
const mockReadFile = vi.mocked(fsp.readFile);
const mockStat = vi.mocked(fsp.stat);
const mockWriteFile = vi.mocked(fsp.writeFile);
const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);

class FakeFsGitStatusWorker implements FsGitStatusWorkerThreadLike {
  readonly messages: FsGitStatusWorkerRequest[] = [];
  readonly listeners = new Map<string, Function[]>();

  postMessage(message: FsGitStatusWorkerRequest): void {
    this.messages.push(message);
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
        files: [],
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

class ManualFsGitStatusWorker implements FsGitStatusWorkerThreadLike {
  readonly messages: FsGitStatusWorkerRequest[] = [];
  readonly listeners = new Map<string, Function[]>();

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

  complete(index = 0, files: Array<{ path: string; code: string; additions?: number; deletions?: number }> = []): void {
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

  crash(): void {
    this.emit('error', new Error('worker crashed'));
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class UnavailableFsGitStatusWorker extends ManualFsGitStatusWorker {
  override postMessage(): void {
    throw new Error('postMessage unavailable');
  }
}

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStats(kind: 'file' | 'dir', mtimeMs: number, size = 0) {
  return {
    mtimeMs,
    size,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  } as unknown as fsp.Stats;
}

function setupRepoMocks(repoRoot: string, filePath?: string) {
  const gitDir = path.join(repoRoot, '.git');
  const headPath = path.join(gitDir, 'HEAD');
  const refPath = path.join(gitDir, 'refs', 'heads', 'main');
  const indexPath = path.join(gitDir, 'index');

  mockRealpath.mockImplementation(async (target) => String(target));
  mockReadFile.mockImplementation(async (target) => {
    if (String(target) === headPath) return 'ref: refs/heads/main\n' as any;
    return '' as any;
  });
  mockStat.mockImplementation(async (target) => {
    const normalized = String(target);
    if (normalized === gitDir) return makeStats('dir', 10);
    if (normalized === headPath) return makeStats('file', 11, 20);
    if (normalized === refPath) return makeStats('file', 12, 21);
    if (normalized === indexPath) return makeStats('file', 13, 22);
    if (filePath && normalized === filePath) return makeStats('file', 14, 30);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

describe('fs git cache handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    __resetFsGitCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('single-flights repo status requests and reuses cached numstat data', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0?? new.txt\0', '');
        return {} as any;
      }
      if (command === 'git diff --numstat -z HEAD') {
        callback(null, ['3\t1\tsrc/a.ts', '5\t0\tnew.txt', ''].join('\0'), '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${String(command)}`), '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'req-1', includeStats: true }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'req-2', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0]?.[0]).toBe('git status --porcelain=v1 -z -u');
    expect(mockExec.mock.calls[1]?.[0]).toBe('git diff --numstat -z HEAD');
    expect(sent).toHaveLength(2);
    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M', additions: 3, deletions: 1 },
      { path: '/home/k/project/new.txt', code: '??', additions: 5, deletions: 0 },
    ]);
    expect((sent[1] as any).files).toEqual((sent[0] as any).files);
  });

  it('skips numstat work when git status is requested without stats', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${String(command)}`), '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'req-plain' }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec.mock.calls[0]?.[0]).toBe('git status --porcelain=v1 -z -u');
    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M' },
    ]);
  });

  it('caches file diffs by file signature and repo signature', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/foo.ts';
    setupRepoMocks(repoRoot, filePath);
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') {
        callback(null, '+const x = 1;\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-1' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-2' }, mockServerLink as any);
    await flushAsync();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('git');
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual(['diff', 'HEAD', '--', 'foo.ts']);
    expect((sent[0] as any).diff).toBe('+const x = 1;\n');
    expect((sent[1] as any).diff).toBe('+const x = 1;\n');
  });

  it('starts fresh fs.read work when file freshness changes and stale late completion cannot replace the active cache', async () => {
    const filePath = '/home/k/project/notes.md';
    const first = createDeferred<string>();
    let currentFileStats = makeStats('file', 14, 30);
    let readCount = 0;

    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockImplementation(async (target) => {
      if (String(target) === filePath) return currentFileStats;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (target) => {
      if (String(target) !== filePath) return '' as any;
      readCount += 1;
      if (readCount === 1) return await first.promise as any;
      return 'fresh content' as any;
    });

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'read-1' }, mockServerLink as any);
    await flushAsync();
    expect(readCount).toBe(1);

    currentFileStats = makeStats('file', 20, 45);
    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'read-2' }, mockServerLink as any);
    await flushAsync();
    expect(readCount).toBe(2);
    expect((sent.find((msg: any) => msg.requestId === 'read-2') as any)?.content).toBe('fresh content');

    first.resolve('stale content');
    await flushAsync();

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'read-3' }, mockServerLink as any);
    await flushAsync();

    expect(readCount).toBe(2);
    expect((sent.find((msg: any) => msg.requestId === 'read-3') as any)?.content).toBe('fresh content');
  });

  it('starts fresh diff work after file freshness changes and ignores stale late completions', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/foo.ts';
    setupRepoMocks(repoRoot, filePath);
    const first = createDeferred<{ stdout: string; stderr: string }>();

    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') {
        const callIndex = mockExecFile.mock.calls.filter((call) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'diff' && call[1][1] === 'HEAD').length;
        if (callIndex === 1) {
          void first.promise.then(
            ({ stdout, stderr }) => callback(null, stdout, stderr),
            (err) => callback(err, '', ''),
          );
          return {} as any;
        }
        callback(null, '+new diff\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-1' }, mockServerLink as any);
    await flushAsync();
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    mockStat.mockImplementation(async (target) => {
      const normalized = String(target);
      if (normalized === path.join(repoRoot, '.git')) return makeStats('dir', 10);
      if (normalized === path.join(repoRoot, '.git', 'HEAD')) return makeStats('file', 11, 20);
      if (normalized === path.join(repoRoot, '.git', 'refs', 'heads', 'main')) return makeStats('file', 12, 21);
      if (normalized === path.join(repoRoot, '.git', 'index')) return makeStats('file', 13, 22);
      if (normalized === filePath) return makeStats('file', 20, 99);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-2' }, mockServerLink as any);
    await flushAsync();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect((sent.find((msg: any) => msg.requestId === 'diff-2') as any)?.diff).toBe('+new diff\n');

    first.resolve({ stdout: '+old diff\n', stderr: '' });
    await flushAsync();
    expect((sent.find((msg: any) => msg.requestId === 'diff-1') as any)?.diff).toBe('+old diff\n');

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-3' }, mockServerLink as any);
    await flushAsync();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect((sent.find((msg: any) => msg.requestId === 'diff-3') as any)?.diff).toBe('+new diff\n');
  });

  it('starts fresh repo status work after repo freshness changes', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    const first = createDeferred<{ stdout: string; stderr: string }>();

    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (command === 'git status --porcelain=v1 -z -u') {
        const callIndex = mockExec.mock.calls.filter((call) => call[0] === 'git status --porcelain=v1 -z -u').length;
        if (callIndex === 1) {
          void first.promise.then(
            ({ stdout, stderr }) => callback(null, stdout, stderr),
            (err) => callback(err, '', ''),
          );
          return {} as any;
        }
        callback(null, 'M  src/b.ts\0', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-1' }, mockServerLink as any);
    await flushAsync();
    expect(mockExec).toHaveBeenCalledTimes(1);

    mockStat.mockImplementation(async (target) => {
      const normalized = String(target);
      if (normalized === path.join(repoRoot, '.git')) return makeStats('dir', 10);
      if (normalized === path.join(repoRoot, '.git', 'HEAD')) return makeStats('file', 11, 20);
      if (normalized === path.join(repoRoot, '.git', 'refs', 'heads', 'main')) return makeStats('file', 12, 21);
      if (normalized === path.join(repoRoot, '.git', 'index')) return makeStats('file', 30, 22);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-2' }, mockServerLink as any);
    await flushAsync();
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect((sent.find((msg: any) => msg.requestId === 'status-2') as any)?.files).toEqual([
      { path: '/home/k/project/src/b.ts', code: 'M' },
    ]);

    first.resolve({ stdout: 'M  src/a.ts\0', stderr: '' });
    await flushAsync();

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-3' }, mockServerLink as any);
    await flushAsync();
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect((sent.find((msg: any) => msg.requestId === 'status-3') as any)?.files).toEqual([
      { path: '/home/k/project/src/b.ts', code: 'M' },
    ]);
  });

  it('reuses the cached repo signature when repo freshness has not changed', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${String(command)}`), '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-cache-1' }, mockServerLink as any);
    await flushAsync();
    const headPath = path.join(repoRoot, '.git', 'HEAD');
    const headReadsAfterFirst = mockReadFile.mock.calls.filter((call) => String(call[0]) === headPath).length;

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-cache-2' }, mockServerLink as any);
    await flushAsync();
    const headReadsAfterSecond = mockReadFile.mock.calls.filter((call) => String(call[0]) === headPath).length;

    expect(headReadsAfterFirst).toBeGreaterThan(0);
    expect(headReadsAfterSecond).toBe(headReadsAfterFirst);
  });

  it('returns diffs for deleted tracked files without requiring realpath on the file itself', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/deleted.ts';
    setupRepoMocks(repoRoot);
    mockRealpath.mockImplementation(async (target) => {
      const normalized = String(target);
      if (normalized === filePath) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return normalized as any;
    });
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && Array.isArray(args) && args[0] === 'diff' && args[1] === 'HEAD') {
        callback(null, 'diff --git a/deleted.ts b/deleted.ts\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-deleted' }, mockServerLink as any);
    await flushAsync();

    expect((sent[0] as any).status).toBe('ok');
    expect((sent[0] as any).diff).toContain('deleted.ts');
  });

  it('passes git diff paths as argv literals instead of shell command strings', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/$(echo hacked).ts';
    setupRepoMocks(repoRoot, filePath);
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-literal' }, mockServerLink as any);
    await flushAsync();

    expect(mockExecFile).toHaveBeenCalled();
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('git');
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual(['diff', 'HEAD', '--', '$(echo hacked).ts']);
  });

  it('normalizes rename status and numstat to the current logical path', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'R  old name.ts\0new name.ts\0', '');
        return {} as any;
      }
      if (command === 'git diff --numstat -z HEAD') {
        callback(null, '7\t2\t\0old name.ts\0new name.ts\0', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-rename', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/new name.ts', code: 'R', additions: 7, deletions: 2 },
    ]);
  });

  it('preserves quoted and escaped paths consistently across status and numstat', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  dir with spaces/file\t\"quoted\".ts\0', '');
        return {} as any;
      }
      if (command === 'git diff --numstat -z HEAD') {
        callback(null, '4\t1\tdir with spaces/file\t\"quoted\".ts\0', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-quoted', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/dir with spaces/file\t"quoted".ts', code: 'M', additions: 4, deletions: 1 },
    ]);
  });

  it('returns an empty ok response outside a git repo', async () => {
    const projectRoot = '/home/k/project';
    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    handleWebCommand({ type: 'fs.git_status', path: projectRoot, requestId: 'status-empty', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect((sent[0] as any)).toMatchObject({ status: 'ok', files: [] });
  });

  it('preserves forbidden-path behavior for git status and git diff', async () => {
    const sshRoot = path.join(homedir(), '.ssh');
    const forbiddenFile = path.join(sshRoot, 'config');
    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockResolvedValue(makeStats('file', 10, 10));

    handleWebCommand({ type: 'fs.git_status', path: sshRoot, requestId: 'status-forbidden' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_diff', path: forbiddenFile, requestId: 'diff-forbidden' }, mockServerLink as any);
    await flushAsync();

    expect((sent.find((msg: any) => msg.requestId === 'status-forbidden') as any)?.error).toBe('forbidden_path');
    expect((sent.find((msg: any) => msg.requestId === 'diff-forbidden') as any)?.error).toBe('forbidden_path');
  });

  it('returns worker_timeout once and ignores late git worker success', async () => {
    vi.useFakeTimers();
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: 10,
      restartBackoffMs: 60_000,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-timeout' }, mockServerLink as any);
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.messages).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(11);
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'fs.git_status_response',
        requestId: 'status-timeout',
        status: 'error',
        error: 'worker_timeout',
        files: [],
      });

      worker.complete(0, [{ path: '/home/k/project/late.ts', code: 'M' }]);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(sent).toHaveLength(1);
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('maps git status worker crash to worker_unavailable', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      restartBackoffMs: 60_000,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-crash' }, mockServerLink as any);
      await flushAsync();
      expect(worker.messages).toHaveLength(1);
      worker.crash();
      await flushAsync();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'fs.git_status_response',
        requestId: 'status-crash',
        status: 'error',
        error: 'worker_unavailable',
        files: [],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('maps git status worker unavailable to worker_unavailable', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new UnavailableFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      restartBackoffMs: 60_000,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-unavailable' }, mockServerLink as any);
      await flushAsync();

      expect(worker.messages).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'fs.git_status_response',
        requestId: 'status-unavailable',
        status: 'error',
        error: 'worker_unavailable',
        files: [],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('rejects forbidden git status paths before worker dispatch', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const sshRoot = path.join(homedir(), '.ssh');
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockResolvedValue(makeStats('dir', 10));

    try {
      handleWebCommand({ type: 'fs.git_status', path: sshRoot, requestId: 'status-forbidden-worker' }, mockServerLink as any);
      await flushAsync();

      expect(worker.messages).toHaveLength(0);
      expect(sent[0]).toMatchObject({
        type: 'fs.git_status_response',
        requestId: 'status-forbidden-worker',
        status: 'error',
        error: 'forbidden_path',
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('coalesces identical in-flight git status worker requests', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: null,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-coalesce-1', includeStats: true }, mockServerLink as any);
      await flushAsync();
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-coalesce-2', includeStats: true }, mockServerLink as any);
      await flushAsync();

      expect(worker.messages).toHaveLength(1);
      expect(worker.messages[0]).toMatchObject({ includeStats: true, requestedPath: repoRoot });

      worker.complete(0, [{ path: '/home/k/project/src/a.ts', code: 'M', additions: 2, deletions: 1 }]);
      await flushAsync();

      expect(sent).toHaveLength(2);
      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId: 'status-coalesce-1',
          status: 'ok',
          files: [{ path: '/home/k/project/src/a.ts', code: 'M', additions: 2, deletions: 1 }],
        }),
        expect.objectContaining({
          requestId: 'status-coalesce-2',
          status: 'ok',
          files: [{ path: '/home/k/project/src/a.ts', code: 'M', additions: 2, deletions: 1 }],
        }),
      ]));
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('keeps includeStats true and false git status worker jobs separate', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 2,
      activeJobTimeoutMs: null,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-plain-worker' }, mockServerLink as any);
      await flushAsync();
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-rich-worker', includeStats: true }, mockServerLink as any);
      await flushAsync();

      expect(worker.messages).toHaveLength(2);
      expect(worker.messages.map((message) => message.includeStats)).toEqual([false, true]);

      worker.complete(0, [{ path: '/home/k/project/src/a.ts', code: 'M' }]);
      worker.complete(1, [{ path: '/home/k/project/src/a.ts', code: 'M', additions: 3, deletions: 1 }]);
      await flushAsync();

      expect(sent.find((msg: any) => msg.requestId === 'status-plain-worker')).toMatchObject({
        status: 'ok',
        files: [{ path: '/home/k/project/src/a.ts', code: 'M' }],
      });
      expect(sent.find((msg: any) => msg.requestId === 'status-rich-worker')).toMatchObject({
        status: 'ok',
        files: [{ path: '/home/k/project/src/a.ts', code: 'M', additions: 3, deletions: 1 }],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('reuses a stale-but-valid git status cache entry when the worker queue is full', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const firstWorker = new ManualFsGitStatusWorker();
    const firstPool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: null,
      createWorker: () => firstWorker,
    });
    const saturatedPool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => new FakeFsGitStatusWorker(),
    });
    let now = 1_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(firstPool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-cache-prime', includeStats: true }, mockServerLink as any);
      await flushAsync();
      expect(firstWorker.messages).toHaveLength(1);
      firstWorker.complete(0, [{ path: '/home/k/project/cached.ts', code: 'M', additions: 1, deletions: 0 }]);
      await flushAsync();
      expect(sent.find((msg: any) => msg.requestId === 'status-cache-prime')).toMatchObject({ status: 'ok' });

      now += 6_000;
      __setDefaultFsGitStatusWorkerPoolForTests(saturatedPool);
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-cache-stale', includeStats: true }, mockServerLink as any);
      await flushAsync();

      expect(sent.find((msg: any) => msg.requestId === 'status-cache-stale')).toMatchObject({
        status: 'ok',
        files: [{ path: '/home/k/project/cached.ts', code: 'M', additions: 1, deletions: 0 }],
      });
    } finally {
      dateNowSpy.mockRestore();
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await firstPool.shutdown();
      await saturatedPool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('keeps attached git status siblings eligible after one request times out', async () => {
    vi.useFakeTimers();
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: null,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-timeout-first' }, mockServerLink as any);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      expect(worker.messages).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(9_000);
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-timeout-sibling' }, mockServerLink as any);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      expect(worker.messages).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_001);
      await flushMicrotasks();
      expect(sent).toEqual([
        expect.objectContaining({
          requestId: 'status-timeout-first',
          status: 'error',
          error: 'worker_timeout',
          files: [],
        }),
      ]);

      worker.complete(0, [{ path: '/home/k/project/late.ts', code: 'M' }]);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();

      expect(sent).toHaveLength(2);
      expect(sent[1]).toMatchObject({
        requestId: 'status-timeout-sibling',
        status: 'ok',
        files: [{ path: '/home/k/project/late.ts', code: 'M' }],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('returns queue_full when git status inflight fan-out is capped', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const worker = new ManualFsGitStatusWorker();
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      activeJobTimeoutMs: null,
      createWorker: () => worker,
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-fanout-1' }, mockServerLink as any);
      await flushAsync();
      expect(worker.messages).toHaveLength(1);

      for (let index = 2; index <= 33; index += 1) {
        handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: `status-fanout-${index}` }, mockServerLink as any);
      }
      await flushAsync();

      expect(worker.messages).toHaveLength(1);
      expect(sent).toEqual([
        expect.objectContaining({
          requestId: 'status-fanout-33',
          status: 'error',
          error: 'worker_queue_full',
          files: [],
        }),
      ]);

      worker.complete(0, [{ path: '/home/k/project/shared.ts', code: 'M' }]);
      await flushAsync();

      expect(sent).toHaveLength(33);
      expect(sent.filter((msg: any) => msg.status === 'ok')).toHaveLength(32);
      expect(sent.find((msg: any) => msg.requestId === 'status-fanout-32')).toMatchObject({
        status: 'ok',
        files: [{ path: '/home/k/project/shared.ts', code: 'M' }],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('returns worker_queue_full for git status worker saturation without inline git fallback', async () => {
    const previousFlag = process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
    const repoRoot = '/home/k/project';
    const pool = new FsGitStatusWorkerPool({
      workersTarget: 1,
      queueCap: 0,
      createWorker: () => new FakeFsGitStatusWorker(),
    });
    process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = '1';
    __setDefaultFsGitStatusWorkerPoolForTests(pool);
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      callback(null, 'M  should-not-run.ts\0', '');
      return {} as any;
    });

    try {
      handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-queue-full', includeStats: true }, mockServerLink as any);
      await flushAsync();

      expect(mockExec).not.toHaveBeenCalled();
      expect((sent[0] as any)).toMatchObject({
        type: 'fs.git_status_response',
        requestId: 'status-queue-full',
        status: 'error',
        error: 'worker_queue_full',
        files: [],
      });
    } finally {
      if (previousFlag === undefined) delete process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL;
      else process.env.IMCODES_FS_GIT_STATUS_WORKER_POOL = previousFlag;
      await pool.shutdown();
      __setDefaultFsGitStatusWorkerPoolForTests(null);
    }
  });

  it('keeps the changed-file list usable when numstat is unavailable', async () => {
    const repoRoot = '/home/k/project';
    setupRepoMocks(repoRoot);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      callback(new Error('unsupported numstat'), '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-nostat', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M' },
    ]);
  });

  it('invalidates cached repo status after fs.write succeeds', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/foo.ts';
    setupRepoMocks(repoRoot, filePath);

    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (command === 'git status --porcelain=v1 -z -u') {
        callback(null, 'M  foo.ts\0', '');
        return {} as any;
      }
      if (command === 'git diff --numstat -z HEAD') {
        callback(null, '1\t0\tfoo.ts\0', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-1', includeStats: true }, mockServerLink as any);
    await flushAsync();
    expect(mockExec).toHaveBeenCalledTimes(2);

    mockStat.mockImplementation(async (target) => {
      const normalized = String(target);
      if (normalized === path.join(repoRoot, '.git')) return makeStats('dir', 10);
      if (normalized === path.join(repoRoot, '.git', 'HEAD')) return makeStats('file', 11, 20);
      if (normalized === path.join(repoRoot, '.git', 'refs', 'heads', 'main')) return makeStats('file', 12, 21);
      if (normalized === path.join(repoRoot, '.git', 'index')) return makeStats('file', 13, 22);
      if (normalized === filePath) return makeStats('file', 15, 31);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockWriteFile.mockResolvedValue(undefined);

    handleWebCommand({ type: 'fs.write', path: filePath, content: 'updated', requestId: 'write-1' }, mockServerLink as any);
    await flushAsync();

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-2', includeStats: true }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(4);
    expect((sent.find((msg: any) => msg.requestId === 'write-1') as any)?.status).toBe('ok');
  });
});
