import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';

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

import { scanFsGitStatusSnapshot } from '../../src/daemon/fs-git-status-worker.js';

const mockExecFile = vi.mocked(childProcess.execFile);

describe('fs git status worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('skips numstat work for lightweight tree status', async () => {
    mockExecFile.mockImplementation((file: any, args: any, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      if (file === 'git' && args.join(' ') === 'status --porcelain=v1 -z -u') {
        callback(null, 'M  src/a.ts\0', '');
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

    expect(result.files).toEqual([{ path: '/home/k/project/src/a.ts', code: 'M' }]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
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
    expect(mockExecFile.mock.calls.map((call) => call[1])).toEqual([
      ['status', '--porcelain=v1', '-z', '-u'],
      ['diff', '--numstat', '-z', 'HEAD'],
      ['diff', '--numstat', '-z'],
    ]);
  });
});
