/**
 * Tests for fs.ls command handler in command-handler.ts.
 * Exercises the handleFsList logic: allowlist enforcement, dir listing,
 * includeFiles flag, hidden-file sorting, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import path from 'path';
import * as fsp from 'node:fs/promises';

// ── Minimal ServerLink mock ────────────────────────────────────────────────
const sent: unknown[] = [];
const mockServerLink = {
  send: vi.fn((msg: unknown) => { sent.push(msg); }),
  sendBinary: vi.fn(),
};

const mockPreviewCoordinator = vi.hoisted(() => ({
  handle: vi.fn(),
  invalidate: vi.fn(),
}));

// ── Mock fs/promises ───────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));
const mockReaddir = vi.mocked(fsp.readdir);
const mockReadFile = vi.mocked(fsp.readFile);
const mockRealpath = vi.mocked(fsp.realpath);
const mockStat = vi.mocked(fsp.stat);

vi.mock('../../src/daemon/file-preview-read-coordinator.js', () => ({
  getDefaultPreviewReadCoordinator: vi.fn(() => mockPreviewCoordinator),
  __resetPreviewReadCoordinatorForTests: vi.fn(),
}), { virtual: true });

// ── Pull the handler function out of command-handler indirectly ────────────
// We test via handleWebCommand to keep the test at the public API level.
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';

// Helper: make a Dirent-like object
function makeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  } as unknown as fsp.Dirent<string>;
}

/** Flush the microtask + macrotask queue so async handlers complete. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('fs.ls handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    // Restore send implementation after clearAllMocks resets it
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    mockPreviewCoordinator.handle.mockImplementation(() => {});
    mockStat.mockResolvedValue({ mtimeMs: 1, size: 0 } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists all accessible Windows drive roots when browsing :drives: on Windows', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockReaddir.mockImplementation(async (dir: any) => {
      if (dir === 'C:\\' || dir === 'D:\\') return [] as any;
      throw new Error('ENOENT');
    });

    try {
      handleWebCommand({ type: 'fs.ls', path: ':drives:', requestId: 'req-win-drives' }, mockServerLink as any);
      await flushAsync();
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-win-drives',
        status: 'ok',
        resolvedPath: '__imcodes_windows_drives__',
      });
      expect((sent[0] as any).entries).toEqual([
        { name: 'C:\\', path: 'C:\\', isDir: true, hidden: false },
        { name: 'D:\\', path: 'D:\\', isDir: true, hidden: false },
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('expands ~ to home directory on Windows (NOT to drives list)', async () => {
    // Regression: ~ must always mean home, not drives.
    // Drives are accessed via the explicit `:drives:` sentinel.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const home = homedir();
    mockRealpath.mockResolvedValue(home as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('Documents', true), makeDirent('Desktop', true)] as any);

    try {
      handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-win-home' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      // Should be home, NOT __imcodes_windows_drives__
      expect(resp.resolvedPath).toBe(home);
      expect(resp.resolvedPath).not.toBe('__imcodes_windows_drives__');
      expect(resp.entries.map((e: any) => e.name)).toEqual(expect.arrayContaining(['Documents', 'Desktop']));
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('expands ~ to home directory on Linux', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const home = homedir();
    mockRealpath.mockResolvedValue(home as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('projects', true)] as any);

    try {
      handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-lin-home' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      expect(resp.resolvedPath).toBe(home);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it(':drives: sentinel returns error on non-Windows platforms', async () => {
    // The drives sentinel should not be a magic root on Linux/Mac;
    // it should fall through to normal path handling and fail safely.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockRealpath.mockRejectedValue(new Error('ENOENT'));

    try {
      handleWebCommand({ type: 'fs.ls', path: ':drives:', requestId: 'req-lin-drives' }, mockServerLink as any);
      await flushAsync();
      const resp = sent[0] as any;
      expect(resp.status).toBe('error');
      // Must NOT pretend drives exist on non-Windows
      expect(resp.resolvedPath).not.toBe('__imcodes_windows_drives__');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('returns forbidden_path for denied directories like ~/.ssh', async () => {
    const denied = path.join(homedir(), '.ssh');
    mockRealpath.mockResolvedValue(denied as unknown as string);

    handleWebCommand({ type: 'fs.ls', path: denied, requestId: 'req-1' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-1',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('lists directories only when includeFiles is false', async () => {
    const testDir = path.join(homedir(), 'test-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
      makeDirent('.git', true),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-2', includeFiles: false }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries.map((e: any) => e.name)).toEqual(['src', '.git']);
    // README.md should not appear
    expect(resp.entries.every((e: any) => e.isDir)).toBe(true);
  });

  it('optionally attaches OpenSpec task stats while preserving plain fs.ls behavior', async () => {
    const changesDir = path.join(homedir(), 'repo', 'openspec', 'changes');
    mockRealpath.mockResolvedValue(changesDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('change-a', true),
      makeDirent('change-b', true),
      makeDirent('notes.md', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockReadFile.mockImplementation(async (target) => {
      const value = String(target);
      if (value.endsWith(path.join('change-a', 'tasks.md'))) {
        return [
          '- [x] Completed task',
          '- [ ] Remaining task',
          '```md',
          '- [ ] ignored fenced checkbox',
          '```',
        ].join('\n') as any;
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    handleWebCommand({ type: 'fs.ls', path: changesDir, requestId: 'req-openspec-plain', includeFiles: false }, mockServerLink as any);
    await flushAsync();
    expect((sent[0] as any).entries.every((entry: any) => entry.openSpecTaskStats === undefined)).toBe(true);
    expect(mockReadFile).not.toHaveBeenCalled();

    handleWebCommand({
      type: 'fs.ls',
      path: changesDir,
      requestId: 'req-openspec-tasks',
      includeFiles: false,
      includeOpenSpecTaskStats: true,
    }, mockServerLink as any);
    await flushAsync();

    const resp = sent[1] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries.find((entry: any) => entry.name === 'change-a').openSpecTaskStats).toEqual({
      total: 2,
      checked: 1,
      unchecked: 1,
    });
    expect(resp.entries.find((entry: any) => entry.name === 'change-b').openSpecTaskStats).toEqual({
      total: 0,
      checked: 0,
      unchecked: 0,
    });
  });

  it('keeps non-preview fs.ls responsive while preview worker slots are blocked', async () => {
    const testDir = path.join(homedir(), 'responsive-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([makeDirent('src', true)] as unknown as fsp.Dirent<string>[]);
    const blockedPreviewReads: Array<{ path: unknown; requestId: unknown }> = [];
    mockPreviewCoordinator.handle.mockImplementation((previewPath: unknown, requestId: unknown) => {
      blockedPreviewReads.push({ path: previewPath, requestId });
    });

    handleWebCommand({ type: 'fs.read', path: path.join(testDir, 'huge.bin'), requestId: 'read-pending' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.read', path: path.join(testDir, 'huge-2.bin'), requestId: 'read-pending-2' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'ls-responsive', includeFiles: false }, mockServerLink as any);
    await flushAsync();

    expect(blockedPreviewReads).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'ls-responsive',
      status: 'ok',
      entries: [{ name: 'src', isDir: true }],
    });
  });

  it('reuses a hot directory listing cache for repeated requests', async () => {
    const testDir = path.join(homedir(), 'cached-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-cache-1', includeFiles: true }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-cache-2', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    expect(mockReaddir).toHaveBeenCalledTimes(1);
    expect((sent[0] as any).status).toBe('ok');
    expect((sent[1] as any).status).toBe('ok');
    expect((sent[1] as any).entries.map((e: any) => e.name)).toEqual(['src', 'README.md']);
  });

  it('includes files when includeFiles is true', async () => {
    const testDir = path.join(homedir(), 'test-dir');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-3', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    const names = resp.entries.map((e: any) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
  });

  it('includes downloadId for allowed files when includeMetadata is true', async () => {
    const testDir = path.join(homedir(), 'metadata-allowed-dir');
    const filePath = path.join(testDir, 'README.md');
    mockRealpath.mockImplementation(async (target) => String(target));
    mockReaddir.mockResolvedValue([
      makeDirent('README.md', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 42, mtimeMs: 101 } as fsp.Stats);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-allowed', includeFiles: true, includeMetadata: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries).toHaveLength(1);
    expect(resp.entries[0]).toMatchObject({
      name: 'README.md',
      path: filePath,
      size: 42,
      mime: 'text/markdown',
    });
    expect(resp.entries[0].downloadId).toEqual(expect.any(String));
  });

  it('omits downloadId for denied metadata entries without failing the listing', async () => {
    const testDir = path.join(homedir(), 'metadata-denied-dir');
    const filePath = path.join(testDir, 'id_rsa');
    const deniedRealPath = path.join(homedir(), '.ssh', 'id_rsa');
    mockRealpath.mockImplementation(async (target) => {
      const value = String(target);
      if (value === filePath) return deniedRealPath;
      return value;
    });
    mockReaddir.mockResolvedValue([
      makeDirent('id_rsa', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 99, mtimeMs: 202 } as fsp.Stats);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-denied', includeFiles: true, includeMetadata: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('ok');
    expect(resp.entries).toHaveLength(1);
    expect(resp.entries[0]).toMatchObject({
      name: 'id_rsa',
      path: filePath,
      size: 99,
    });
    expect(resp.entries[0].downloadId).toBeUndefined();
  });

  it('omits downloadId for Windows realpath fallback entries without failing the listing', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const testDir = path.join(homedir(), 'metadata-fallback-dir');
    mockRealpath.mockRejectedValue(new Error('expected reparse fallback'));
    mockReaddir.mockResolvedValue([
      makeDirent('fallback.txt', false),
    ] as unknown as fsp.Dirent<string>[]);
    mockStat.mockResolvedValue({ size: 7, mtimeMs: 303 } as fsp.Stats);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-meta-fallback', includeFiles: true, includeMetadata: true }, mockServerLink as any);
      await flushAsync();

      const resp = sent[0] as any;
      expect(resp.status).toBe('ok');
      expect(resp.entries).toHaveLength(1);
      expect(resp.entries[0]).toMatchObject({
        name: 'fallback.txt',
        size: 7,
      });
      expect(resp.entries[0].downloadId).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('fails closed for Windows realpath fallback when includeMetadata is false', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const testDir = path.join(homedir(), 'plain-fallback-dir');
    mockRealpath.mockRejectedValue(new Error('expected reparse fallback'));
    mockReaddir.mockResolvedValue([
      makeDirent('fallback.txt', false),
    ] as unknown as fsp.Dirent<string>[]);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-plain-fallback', includeFiles: true, includeMetadata: false }, mockServerLink as any);
      await flushAsync();

      expect(mockReaddir).not.toHaveBeenCalled();
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-plain-fallback',
        status: 'error',
        error: 'forbidden_path',
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('sorts: directories first, hidden last within each group', async () => {
    const testDir = path.join(homedir(), 'sorted-test');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockResolvedValue([
      makeDirent('b-file.txt', false),
      makeDirent('.hidden-file', false),
      makeDirent('z-dir', true),
      makeDirent('.hidden-dir', true),
      makeDirent('a-dir', true),
    ] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-4', includeFiles: true }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    const names: string[] = resp.entries.map((e: any) => e.name);
    // dirs before files
    const firstFileIdx = names.findIndex((n: string) => !resp.entries[names.indexOf(n)].isDir);
    const lastDirIdx = [...resp.entries].reverse().findIndex((e: any) => e.isDir);
    const lastDirActualIdx = resp.entries.length - 1 - lastDirIdx;
    expect(firstFileIdx).toBeGreaterThan(lastDirActualIdx);
    // visible dirs before hidden dirs
    expect(names.indexOf('a-dir')).toBeLessThan(names.indexOf('z-dir'));
    expect(names.indexOf('z-dir')).toBeLessThan(names.indexOf('.hidden-dir'));
  });

  it('returns error when readdir throws', async () => {
    const testDir = path.join(homedir(), 'no-access');
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

    handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-5' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.ls_response',
      requestId: 'req-5',
      status: 'error',
      error: 'EACCES: permission denied',
    });
  });

  it('does not send a late ok response after fs.ls times out', async () => {
    vi.useFakeTimers();
    const testDir = path.join(homedir(), 'slow-dir');
    let resolveReaddir!: (value: fsp.Dirent<string>[]) => void;
    mockRealpath.mockResolvedValue(testDir as unknown as string);
    mockReaddir.mockReturnValue(new Promise((resolve) => {
      resolveReaddir = resolve as (value: fsp.Dirent<string>[]) => void;
    }) as unknown as ReturnType<typeof fsp.readdir>);

    try {
      handleWebCommand({ type: 'fs.ls', path: testDir, requestId: 'req-timeout', includeFiles: true }, mockServerLink as any);
      await vi.advanceTimersByTimeAsync(10_001);
      await Promise.resolve();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'fs.ls_response',
        requestId: 'req-timeout',
        status: 'error',
        error: FS_GENERIC_ERROR_CODES.FS_LIST_TIMEOUT,
      });

      resolveReaddir([makeDirent('late.txt', false)] as unknown as fsp.Dirent<string>[]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expands ~ to homedir', async () => {
    const expandedHome = homedir();
    mockRealpath.mockResolvedValue(expandedHome as unknown as string);
    mockReaddir.mockResolvedValue([] as unknown as fsp.Dirent<string>[]);

    handleWebCommand({ type: 'fs.ls', path: '~', requestId: 'req-6' }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.resolvedPath).toBe(expandedHome);
    expect(resp.status).toBe('ok');
  });

  it('silently ignores messages missing path or requestId', async () => {
    handleWebCommand({ type: 'fs.ls', path: '/tmp' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.ls', requestId: 'x' }, mockServerLink as any);
    // Small delay — no response should arrive
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });
});
