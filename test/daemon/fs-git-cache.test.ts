import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
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

const mockRealpath = vi.mocked(fsp.realpath);
const mockReadFile = vi.mocked(fsp.readFile);
const mockStat = vi.mocked(fsp.stat);
const mockWriteFile = vi.mocked(fsp.writeFile);
const mockExec = vi.mocked(childProcess.exec);
const mockExecFile = vi.mocked(childProcess.execFile);

const sent: unknown[] = [];
const mockServerLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

const flushAsync = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
    const sshRoot = '/home/k/.ssh';
    const forbiddenFile = '/home/k/.ssh/config';
    mockRealpath.mockImplementation(async (target) => String(target));
    mockStat.mockResolvedValue(makeStats('file', 10, 10));

    handleWebCommand({ type: 'fs.git_status', path: sshRoot, requestId: 'status-forbidden' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_diff', path: forbiddenFile, requestId: 'diff-forbidden' }, mockServerLink as any);
    await flushAsync();

    expect((sent.find((msg: any) => msg.requestId === 'status-forbidden') as any)?.error).toBe('forbidden_path');
    expect((sent.find((msg: any) => msg.requestId === 'diff-forbidden') as any)?.error).toBe('forbidden_path');
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
