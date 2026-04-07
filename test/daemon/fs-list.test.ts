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

// ── Mock fs/promises ───────────────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  realpath: vi.fn(),
}));
const mockReaddir = vi.mocked(fsp.readdir);
const mockRealpath = vi.mocked(fsp.realpath);

// ── Pull the handler function out of command-handler indirectly ────────────
// We test via handleWebCommand to keep the test at the public API level.
import { handleWebCommand } from '../../src/daemon/command-handler.js';

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
