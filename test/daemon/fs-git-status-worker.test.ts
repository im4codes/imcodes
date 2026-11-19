import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fsp from 'node:fs/promises';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFile = vi.fn();
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
    execFile,
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import { scanFsGitStatusSnapshot } from '../../src/daemon/fs-git-status-worker.js';
import { FS_GIT_STATUS_MAX_FILES } from '../../src/shared/transport/fs.js';

const mockExecFile = vi.mocked(childProcess.execFile);
const mockReaddir = vi.mocked(fsp.readdir);

describe('fs git status worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockReset();
  });

  it('runs git status and optional numstat off the daemon hot path', async () => {
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && args.join(' ') === 'status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0?? new.txt\0', '');
        return {} as any;
      }
      if (file === 'git' && args.join(' ') === 'diff --numstat -z HEAD') {
        callback(null, ['3\t1\tsrc/a.ts', '5\t0\tnew.txt', ''].join('\0'), '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`), '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      repoSignature: 'sig-1',
      requestedPath: '/home/k/project',
      includeStats: true,
    });

    expect(result.files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M', additions: 3, deletions: 1 },
      { path: '/home/k/project/new.txt', code: '??', additions: 5, deletions: 0 },
    ]);
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['diff', '--numstat', '-z', 'HEAD'],
    ]);
  });

  it('skips numstat work and checks only direct children for lightweight ignored status', async () => {
    mockReaddir.mockResolvedValue([{ name: 'dist' }, { name: 'src' }] as any);
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && args.join(' ') === 'status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      if (file === 'git' && args.join(' ') === 'check-ignore -z -- dist src') {
        callback(null, 'dist\0', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`), '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      repoSignature: 'sig-1',
      requestedPath: '/home/k/project',
      includeStats: false,
    });

    expect(result.files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M' },
      { path: '/home/k/project/dist', code: '!!' },
    ]);
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['check-ignore', '-z', '--', 'dist', 'src'],
    ]);
  });

  it('normalizes renamed and escaped paths consistently across status and numstat', async () => {
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && args.join(' ') === 'status --porcelain=v1 -z -u') {
        callback(null, 'D  deleted.ts\0R  old name.ts\0dir/file\\t\\"quoted\\".ts\0', '');
        return {} as any;
      }
      if (file === 'git' && args.join(' ') === 'diff --numstat -z HEAD') {
        callback(null, '7\t2\t\0old name.ts\0dir/file\\t\\"quoted\\".ts\0', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`), '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      repoSignature: 'sig-1',
      requestedPath: '/home/k/project',
      includeStats: true,
    });

    expect(result.files).toEqual([
      { path: '/home/k/project/deleted.ts', code: 'D' },
      { path: '/home/k/project/dir/file\t"quoted".ts', code: 'R', additions: 7, deletions: 2 },
    ]);
  });

  it('falls back to plain numstat and keeps status usable when stats fail', async () => {
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && args.join(' ') === 'status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      if (file === 'git' && args.join(' ') === 'diff --numstat -z HEAD') {
        callback(new Error('no HEAD'), '', '');
        return {} as any;
      }
      if (file === 'git' && args.join(' ') === 'diff --numstat -z') {
        callback(null, '', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`), '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      repoSignature: 'sig-1',
      requestedPath: '/home/k/project',
      includeStats: true,
    });

    expect(result.files).toEqual([{ path: '/home/k/project/src/a.ts', code: 'M' }]);
    expect(result.totalCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['diff', '--numstat', '-z', 'HEAD'],
      ['diff', '--numstat', '-z'],
    ]);
  });

  it('caps large entry lists while preserving tracked changes first and exact totalCount', async () => {
    const untracked = Array.from({ length: FS_GIT_STATUS_MAX_FILES + 50 }, (_, idx) => `?? untracked-${idx}.txt`).join('\0');
    const tracked = Array.from({ length: 5 }, (_, idx) => `M  src/tracked-${idx}.ts`).join('\0');
    const porcelain = `${untracked}\0${tracked}\0`;

    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const argv = args as string[];
      if (argv[0] === 'status') {
        cb?.(null, porcelain, '');
        return {} as any;
      }
      if (argv[0] === 'diff') {
        cb?.(null, '3\t1\tsrc/tracked-0.ts\0', '');
        return {} as any;
      }
      cb?.(null, '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      requestedPath: '/home/k/project',
      includeStats: true,
    });

    expect(result.totalCount).toBe(FS_GIT_STATUS_MAX_FILES + 55);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(FS_GIT_STATUS_MAX_FILES);
    expect(result.files.slice(0, 5).map((entry) => entry.code)).toEqual(['M', 'M', 'M', 'M', 'M']);
    expect(result.files[0]).toEqual({
      path: '/home/k/project/src/tracked-0.ts',
      code: 'M',
      additions: 3,
      deletions: 1,
    });
  });

  it('supports summaryOnly fast-path without running numstat or check-ignore', async () => {
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const argv = args as string[];
      if (argv[0] === 'status') {
        cb?.(null, 'M  src/a.ts\0?? src/b.ts\0M  other/c.ts\0', '');
        return {} as any;
      }
      cb?.(new Error(`unexpected command: ${argv.join(' ')}`), '', '');
      return {} as any;
    });

    const fullRepoSummary = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      requestedPath: '/home/k/project',
      includeStats: true,
      summaryOnly: true,
    });
    expect(fullRepoSummary.files).toEqual([]);
    expect(fullRepoSummary.totalCount).toBe(3);
    expect(fullRepoSummary.truncated).toBe(true);
    expect(fullRepoSummary.summaryOnly).toBe(true);

    const subdirSummary = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      requestedPath: '/home/k/project/src',
      includeStats: true,
      summaryOnly: true,
    });
    expect(subdirSummary.files).toEqual([]);
    expect(subdirSummary.totalCount).toBe(2);
    expect(subdirSummary.truncated).toBe(true);
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['status', '--porcelain=v1', '-z', '-u'],
    ]);
  });

  it('skips fallback numstat retry on maxBuffer error', async () => {
    mockExecFile.mockImplementation((_file, args, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const argv = args as string[];
      if (argv[0] === 'status') {
        cb?.(null, 'M  src/a.ts\0', '');
        return {} as any;
      }
      if (argv[0] === 'diff' && argv[3] === 'HEAD') {
        cb?.(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '');
        return {} as any;
      }
      cb?.(new Error('should not retry'), '', '');
      return {} as any;
    });

    const result = await scanFsGitStatusSnapshot({
      repoRoot: '/home/k/project',
      requestedPath: '/home/k/project',
      includeStats: true,
    });

    expect(result.files).toEqual([{ path: '/home/k/project/src/a.ts', code: 'M' }]);
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['diff', '--numstat', '-z', 'HEAD'],
    ]);
  });
});
