/**
 * Tests for fs.write command handler in command-handler.ts.
 * Exercises handleFsWrite: sandbox validation, size limit, parent-not-found,
 * mtime conflict detection, successful write, and mtime returned.
 * Also verifies handleFsRead includes mtime in successful responses.
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
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

const mockRealpath = vi.mocked(fsp.realpath);
const mockStat = vi.mocked(fsp.stat);
const mockReadFile = vi.mocked(fsp.readFile);
const mockWriteFile = vi.mocked(fsp.writeFile);

import { handleWebCommand } from '../../src/daemon/command-handler.js';

/** Flush the microtask + macrotask queue so async handlers complete. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('fs.write handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns forbidden_path when path is outside allowed roots', async () => {
    const forbiddenPath = '/root/secret.txt';
    // File doesn't exist → goes to parent check
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Parent realpath resolves to forbidden location
    mockRealpath.mockResolvedValue('/root' as unknown as string);

    handleWebCommand({ type: 'fs.write', path: forbiddenPath, content: 'hello', requestId: 'req-forbidden' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-forbidden',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('returns forbidden_path when existing file realpath is outside allowed roots', async () => {
    const forbiddenPath = '/root/existing.txt';
    // File exists
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    // Realpath resolves to forbidden location
    mockRealpath.mockResolvedValue('/root/existing.txt' as unknown as string);

    handleWebCommand({ type: 'fs.write', path: forbiddenPath, content: 'hello', requestId: 'req-forbidden-existing' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-forbidden-existing',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('returns file_too_large when content exceeds 1MB', async () => {
    const allowedPath = path.join(homedir(), 'big-file.txt');
    const largeContent = 'x'.repeat(1_048_577); // > 1MB

    handleWebCommand({ type: 'fs.write', path: allowedPath, content: largeContent, requestId: 'req-toolarge' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-toolarge',
      status: 'error',
      error: 'file_too_large',
    });
  });

  it('uses Buffer.byteLength for size check (not string.length)', async () => {
    // A string of CJK characters: each is 3 bytes in UTF-8
    // 349526 chars × 3 bytes = 1048578 bytes > 1MB
    const allowedPath = path.join(homedir(), 'cjk-file.txt');
    const cjkContent = '中'.repeat(349526);
    expect(Buffer.byteLength(cjkContent, 'utf-8')).toBeGreaterThan(1_048_576);

    handleWebCommand({ type: 'fs.write', path: allowedPath, content: cjkContent, requestId: 'req-cjk-toolarge' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-cjk-toolarge',
      status: 'error',
      error: 'file_too_large',
    });
  });

  it('returns parent_not_found when parent directory does not exist', async () => {
    const noParentPath = path.join(homedir(), 'nonexistent-dir', 'file.txt');
    // File doesn't exist
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Parent realpath throws (parent doesn't exist)
    mockRealpath.mockRejectedValue(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));

    handleWebCommand({ type: 'fs.write', path: noParentPath, content: 'hello', requestId: 'req-noparent' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-noparent',
      status: 'error',
      error: 'parent_not_found',
    });
  });

  it('writes successfully and returns new mtime', async () => {
    const filePath = path.join(homedir(), 'test-write.txt');
    const content = 'hello world';
    const newMtime = 1700000000000;

    // File exists
    mockStat
      .mockResolvedValueOnce({ mtimeMs: 1000 } as fsp.Stats)  // initial stat for existence check
      .mockResolvedValueOnce({ mtimeMs: newMtime } as fsp.Stats); // post-write stat
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockWriteFile.mockResolvedValue(undefined);

    handleWebCommand({ type: 'fs.write', path: filePath, content, requestId: 'req-ok' }, mockServerLink as any);
    await flushAsync();

    expect(mockWriteFile).toHaveBeenCalledWith(filePath, content, 'utf-8');
    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-ok',
      status: 'ok',
      mtime: newMtime,
    });
  });

  it('symlink escape — realpath of existing file outside allowed roots is rejected', async () => {
    // A path that looks allowed but resolves to outside roots via symlink
    const symlinkPath = path.join(homedir(), 'link-to-secret.txt');
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    // Symlink resolves to outside home
    mockRealpath.mockResolvedValue('/etc/passwd' as unknown as string);

    handleWebCommand({ type: 'fs.write', path: symlinkPath, content: 'evil', requestId: 'req-symlink' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-symlink',
      status: 'error',
      error: 'forbidden_path',
    });
  });
});

describe('fs.write mtime conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
  });

  it('passes when expectedMtime matches disk mtime', async () => {
    const filePath = path.join(homedir(), 'test-match.txt');
    const content = 'updated content';
    const mtime = 1700000000000;
    const newMtime = 1700000001000;

    mockStat
      .mockResolvedValueOnce({ mtimeMs: mtime } as fsp.Stats)
      .mockResolvedValueOnce({ mtimeMs: mtime } as fsp.Stats)  // conflict check
      .mockResolvedValueOnce({ mtimeMs: newMtime } as fsp.Stats); // post-write
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockWriteFile.mockResolvedValue(undefined);

    handleWebCommand({ type: 'fs.write', path: filePath, content, requestId: 'req-match', expectedMtime: mtime }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-match',
      status: 'ok',
      mtime: newMtime,
    });
  });

  it('returns conflict when expectedMtime does not match disk', async () => {
    const filePath = path.join(homedir(), 'test-conflict.txt');
    const content = 'my changes';
    const expectedMtime = 1700000000000;
    const diskMtime = 1700000005000; // different — file was modified
    const diskContent = 'disk content';

    mockStat
      .mockResolvedValueOnce({ mtimeMs: diskMtime } as fsp.Stats) // existence check
      .mockResolvedValueOnce({ mtimeMs: diskMtime } as fsp.Stats); // conflict check
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockReadFile.mockResolvedValue(diskContent as unknown as Buffer);

    handleWebCommand({ type: 'fs.write', path: filePath, content, requestId: 'req-conflict', expectedMtime }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-conflict',
      status: 'conflict',
      diskContent,
      diskMtime,
    });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('caps diskContent at 1MB in conflict response', async () => {
    const filePath = path.join(homedir(), 'test-large-conflict.txt');
    const content = 'my changes';
    const expectedMtime = 1700000000000;
    const diskMtime = 1700000005000;
    // Large disk content: > 1MB bytes
    const largeDiskContent = 'a'.repeat(1_100_000);

    mockStat
      .mockResolvedValueOnce({ mtimeMs: diskMtime } as fsp.Stats)
      .mockResolvedValueOnce({ mtimeMs: diskMtime } as fsp.Stats);
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockReadFile.mockResolvedValue(largeDiskContent as unknown as Buffer);

    handleWebCommand({ type: 'fs.write', path: filePath, content, requestId: 'req-large-conflict', expectedMtime }, mockServerLink as any);
    await flushAsync();

    const resp = sent[0] as any;
    expect(resp.status).toBe('conflict');
    expect(resp.diskContent).toHaveLength(1_048_576);
  });
});

describe('fs.read handler — mtime field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
  });

  it('includes mtime in successful text read response', async () => {
    const filePath = path.join(homedir(), 'test-read.txt');
    const mtime = 1700000000000;

    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockStat.mockResolvedValue({ size: 100, mtimeMs: mtime } as fsp.Stats);
    mockReadFile.mockResolvedValue('hello world' as unknown as Buffer);

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-read-mtime' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.read_response',
      requestId: 'req-read-mtime',
      status: 'ok',
      mtime,
    });
  });
});
