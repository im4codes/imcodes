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
  (exec as any)[Symbol.for('nodejs.util.promisify.custom')] = (command: string, options?: unknown) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(command, options, (err: Error | null, stdout = '', stderr = '') => {
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
  };
});

import { handleWebCommand, __resetFsGitCachesForTests } from '../../src/daemon/command-handler.js';

const mockRealpath = vi.mocked(fsp.realpath);
const mockReadFile = vi.mocked(fsp.readFile);
const mockStat = vi.mocked(fsp.stat);
const mockWriteFile = vi.mocked(fsp.writeFile);
const mockExec = vi.mocked(childProcess.exec);

const sent: unknown[] = [];
const mockServerLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

const flushAsync = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

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
      if (command === 'git status --porcelain -u') {
        callback(null, 'M  src/a.ts\n?? new.txt\n', '');
        return {} as any;
      }
      if (command === 'git diff --numstat HEAD') {
        callback(null, '3\t1\tsrc/a.ts\n5\t0\tnew.txt\n', '');
        return {} as any;
      }
      callback(new Error(`unexpected command: ${String(command)}`), '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'req-1' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'req-2' }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0]?.[0]).toBe('git status --porcelain -u');
    expect(mockExec.mock.calls[1]?.[0]).toBe('git diff --numstat HEAD');
    expect(sent).toHaveLength(2);
    expect((sent[0] as any).files).toEqual([
      { path: '/home/k/project/src/a.ts', code: 'M', additions: 3, deletions: 1 },
      { path: '/home/k/project/new.txt', code: '??', additions: 5, deletions: 0 },
    ]);
    expect((sent[1] as any).files).toEqual((sent[0] as any).files);
  });

  it('caches file diffs by file signature and repo signature', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/foo.ts';
    setupRepoMocks(repoRoot, filePath);
    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (String(command).startsWith('git diff HEAD --')) {
        callback(null, '+const x = 1;\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-1' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.git_diff', path: filePath, requestId: 'diff-2' }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(String(mockExec.mock.calls[0]?.[0])).toContain('git diff HEAD --');
    expect((sent[0] as any).diff).toBe('+const x = 1;\n');
    expect((sent[1] as any).diff).toBe('+const x = 1;\n');
  });

  it('invalidates cached repo status after fs.write succeeds', async () => {
    const repoRoot = '/home/k/project';
    const filePath = '/home/k/project/foo.ts';
    setupRepoMocks(repoRoot, filePath);

    mockExec.mockImplementation((command: any, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (command === 'git status --porcelain -u') {
        callback(null, 'M  foo.ts\n', '');
        return {} as any;
      }
      if (command === 'git diff --numstat HEAD') {
        callback(null, '1\t0\tfoo.ts\n', '');
        return {} as any;
      }
      callback(null, '', '');
      return {} as any;
    });

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-1' }, mockServerLink as any);
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

    handleWebCommand({ type: 'fs.git_status', path: repoRoot, requestId: 'status-2' }, mockServerLink as any);
    await flushAsync();

    expect(mockExec).toHaveBeenCalledTimes(4);
    expect((sent.find((msg: any) => msg.requestId === 'write-1') as any)?.status).toBe('ok');
  });
});
