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
  lstat: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

const mockLstat = vi.mocked(fsp.lstat);
const mockRealpath = vi.mocked(fsp.realpath);
const mockRename = vi.mocked(fsp.rename);
const mockRm = vi.mocked(fsp.rm);
const mockStat = vi.mocked(fsp.stat);
const mockReadFile = vi.mocked(fsp.readFile);
const mockWriteFile = vi.mocked(fsp.writeFile);

import { handleWebCommand, __resetFsGitCachesForTests } from '../../src/daemon/command-handler.js';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FS_TRANSPORT_MSG } from '../../shared/fs-transport-messages.js';
import { FS_WRITE_ERROR } from '../../src/shared/transport/fs.js';

/** Flush the microtask + macrotask queue so async handlers complete. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('fs.write handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    mockLstat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    __resetFsGitCachesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns forbidden_path when path is in a denied directory like ~/.ssh', async () => {
    const forbiddenPath = path.join(homedir(), '.ssh', 'secret.txt');
    // File doesn't exist → goes to parent check
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Parent realpath resolves to denied directory
    mockRealpath.mockResolvedValue(path.join(homedir(), '.ssh') as unknown as string);

    handleWebCommand({ type: 'fs.write', path: forbiddenPath, content: 'hello', requestId: 'req-forbidden' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-forbidden',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('returns forbidden_path when existing file realpath is in denied directory', async () => {
    const forbiddenPath = path.join(homedir(), '.ssh', 'authorized_keys');
    // File exists
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    // Realpath resolves to denied directory
    mockRealpath.mockResolvedValue(path.join(homedir(), '.ssh', 'authorized_keys') as unknown as string);

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

  it('creates a file atomically when createOnly is true', async () => {
    const filePath = path.join(homedir(), 'new-create-only.txt');
    const parentPath = path.dirname(filePath);
    const content = '';
    const newMtime = 1700000000100;

    mockStat
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ mtimeMs: newMtime } as fsp.Stats);
    mockRealpath
      .mockResolvedValueOnce(parentPath as unknown as string)
      .mockResolvedValueOnce(filePath as unknown as string);
    mockWriteFile.mockResolvedValue(undefined);

    handleWebCommand({ type: 'fs.write', path: filePath, content, requestId: 'req-create-only', createOnly: true }, mockServerLink as any);
    await flushAsync();

    expect(mockWriteFile).toHaveBeenCalledWith(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-create-only',
      status: 'ok',
      mtime: newMtime,
    });
  });

  it('does not overwrite an existing file when createOnly is true', async () => {
    const filePath = path.join(homedir(), 'existing-create-only.txt');

    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    mockRealpath.mockResolvedValue(filePath as unknown as string);

    handleWebCommand({ type: 'fs.write', path: filePath, content: '', requestId: 'req-existing-create-only', createOnly: true }, mockServerLink as any);
    await flushAsync();

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-existing-create-only',
      status: 'error',
      error: FS_WRITE_ERROR.FILE_EXISTS,
    });
  });

  it('reports file_exists if a createOnly write loses the creation race', async () => {
    const filePath = path.join(homedir(), 'race-create-only.txt');
    const parentPath = path.dirname(filePath);

    mockStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockRealpath.mockResolvedValueOnce(parentPath as unknown as string);
    mockWriteFile.mockRejectedValueOnce(Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' }));

    handleWebCommand({ type: 'fs.write', path: filePath, content: '', requestId: 'req-create-race', createOnly: true }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-create-race',
      status: 'error',
      error: FS_WRITE_ERROR.FILE_EXISTS,
    });
  });

  it('sanitizes unexpected write errors instead of returning raw host paths', async () => {
    const filePath = path.join(homedir(), 'raw-error.txt');
    const rawError = new Error(`EACCES: permission denied, open '${path.join(homedir(), '.ssh', 'id_rsa')}'`);

    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockWriteFile.mockRejectedValue(rawError);

    handleWebCommand({ type: 'fs.write', path: filePath, content: 'updated', requestId: 'req-raw-error' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-raw-error',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR,
    });
    expect(JSON.stringify(sent[0])).not.toContain('.ssh');
    expect(JSON.stringify(sent[0])).not.toContain('EACCES');
  });

  it('returns invalid_request error (not silent hang) when path is missing', async () => {
    handleWebCommand({ type: 'fs.write', content: 'hello', requestId: 'req-no-path' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-no-path',
      status: 'error',
      error: 'invalid_request',
    });
  });

  it('returns invalid_request error when content is missing', async () => {
    handleWebCommand({ type: 'fs.write', path: '/tmp/test.txt', requestId: 'req-no-content' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-no-content',
      status: 'error',
      error: 'invalid_request',
    });
  });

  it('silently returns (no crash) when requestId is also missing', async () => {
    // No requestId means we can't send a response, but we shouldn't crash
    handleWebCommand({ type: 'fs.write', path: '/tmp/test.txt', content: 'hello' }, mockServerLink as any);
    await flushAsync();

    // No response sent (no requestId to respond to)
    expect(sent).toHaveLength(0);
  });

  it('symlink escape — realpath of file resolving into ~/.ssh is rejected', async () => {
    // A path that looks allowed but resolves to denied dir via symlink
    const symlinkPath = path.join(homedir(), 'link-to-secret.txt');
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as fsp.Stats);
    // Symlink resolves into .ssh
    mockRealpath.mockResolvedValue(path.join(homedir(), '.ssh', 'id_rsa') as unknown as string);

    handleWebCommand({ type: 'fs.write', path: symlinkPath, content: 'evil', requestId: 'req-symlink' }, mockServerLink as any);
    await flushAsync();

    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-symlink',
      status: 'error',
      error: 'forbidden_path',
    });
  });

  it('fails closed when a new target appears as a symlink after the initial existence check', async () => {
    const filePath = path.join(homedir(), 'new-link-to-secret.txt');
    const parentPath = path.dirname(filePath);

    mockStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockRealpath.mockResolvedValueOnce(parentPath as unknown as string);
    mockLstat.mockResolvedValueOnce({ isSymbolicLink: () => true } as fsp.Stats);

    handleWebCommand({ type: 'fs.write', path: filePath, content: 'evil', requestId: 'req-new-symlink' }, mockServerLink as any);
    await flushAsync();

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: 'fs.write_response',
      requestId: 'req-new-symlink',
      status: 'error',
      error: FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH,
    });
    expect(JSON.stringify(sent[0])).not.toContain('.ssh');
  });
});

describe('fs.rename and fs.delete handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    mockServerLink.send.mockImplementation((msg: unknown) => { sent.push(msg); });
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    __resetFsGitCachesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renames an allowed file when the destination does not exist', async () => {
    const oldPath = path.join(homedir(), 'project', 'old.txt');
    const newPath = path.join(homedir(), 'project', 'new.txt');
    mockLstat.mockImplementation(async (target) => {
      if (String(target) === oldPath) return { isSymbolicLink: () => false } as fsp.Stats;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({ type: FS_TRANSPORT_MSG.RENAME, path: oldPath, newPath, requestId: 'rename-ok' }, mockServerLink as any);
    await flushAsync();

    expect(mockRename).toHaveBeenCalledWith(oldPath, newPath);
    expect(sent[0]).toMatchObject({
      type: FS_TRANSPORT_MSG.RENAME_RESPONSE,
      requestId: 'rename-ok',
      status: 'ok',
      path: oldPath,
      newPath,
    });
  });

  it('does not overwrite an existing destination while renaming', async () => {
    const oldPath = path.join(homedir(), 'project', 'old.txt');
    const newPath = path.join(homedir(), 'project', 'new.txt');
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({ type: FS_TRANSPORT_MSG.RENAME, path: oldPath, newPath, requestId: 'rename-exists' }, mockServerLink as any);
    await flushAsync();

    expect(mockRename).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: FS_TRANSPORT_MSG.RENAME_RESPONSE,
      requestId: 'rename-exists',
      status: 'error',
      error: 'file_exists',
    });
  });

  it('deletes an allowed file or directory recursively after the browser has confirmed', async () => {
    const targetPath = path.join(homedir(), 'project', 'old.txt');
    mockLstat.mockResolvedValue({ isSymbolicLink: () => false } as fsp.Stats);
    mockRealpath.mockImplementation(async (target) => String(target));

    handleWebCommand({ type: FS_TRANSPORT_MSG.DELETE, path: targetPath, requestId: 'delete-ok' }, mockServerLink as any);
    await flushAsync();

    expect(mockRm).toHaveBeenCalledWith(targetPath, { recursive: true, force: false });
    expect(sent[0]).toMatchObject({
      type: FS_TRANSPORT_MSG.DELETE_RESPONSE,
      requestId: 'delete-ok',
      status: 'ok',
      path: targetPath,
    });
  });

  it('refuses to delete symbolic links', async () => {
    const targetPath = path.join(homedir(), 'project', 'link.txt');
    mockLstat.mockResolvedValue({ isSymbolicLink: () => true } as fsp.Stats);

    handleWebCommand({ type: FS_TRANSPORT_MSG.DELETE, path: targetPath, requestId: 'delete-link' }, mockServerLink as any);
    await flushAsync();

    expect(mockRm).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: FS_TRANSPORT_MSG.DELETE_RESPONSE,
      requestId: 'delete-link',
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
    __resetFsGitCachesForTests();
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
    __resetFsGitCachesForTests();
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

  it('reuses cached text content when file signature is unchanged', async () => {
    const filePath = path.join(homedir(), 'cached-read.txt');
    const mtime = 1700000000000;
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockStat.mockResolvedValue({ size: 100, mtimeMs: mtime } as fsp.Stats);
    mockReadFile.mockResolvedValue('hello cache' as unknown as Buffer);

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-read-1' }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-read-2' }, mockServerLink as any);
    await flushAsync();

    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect((sent[1] as any).content).toBe('hello cache');
  });

  it('single-flights concurrent reads for the same file', async () => {
    const filePath = path.join(homedir(), 'inflight-read.txt');
    const mtime = 1700000000000;
    let release: ((value: string) => void) | null = null;
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockStat.mockResolvedValue({ size: 100, mtimeMs: mtime } as fsp.Stats);
    mockReadFile.mockImplementation(() => new Promise((resolve) => { release = resolve as (value: string) => void; }) as any);

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-inflight-1' }, mockServerLink as any);
    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-inflight-2' }, mockServerLink as any);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mockReadFile).toHaveBeenCalledTimes(1);

    release?.('shared content');
    await flushAsync();

    expect(sent).toHaveLength(2);
    expect((sent[0] as any).content).toBe('shared content');
    expect((sent[1] as any).content).toBe('shared content');
  });

  it('invalidates cached reads after fs.write succeeds', async () => {
    const filePath = path.join(homedir(), 'cache-invalidated.txt');
    mockRealpath.mockResolvedValue(filePath as unknown as string);
    mockStat
      .mockResolvedValueOnce({ size: 100, mtimeMs: 1000 } as fsp.Stats)
      .mockResolvedValueOnce({ size: 100, mtimeMs: 1000 } as fsp.Stats)
      .mockResolvedValueOnce({ mtimeMs: 2000 } as fsp.Stats)
      .mockResolvedValueOnce({ size: 120, mtimeMs: 3000 } as fsp.Stats);
    mockReadFile
      .mockResolvedValueOnce('before write' as unknown as Buffer)
      .mockResolvedValueOnce('after write' as unknown as Buffer);
    mockWriteFile.mockResolvedValue(undefined);

    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-pre-write' }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.write', path: filePath, content: 'updated', requestId: 'req-write-ok' }, mockServerLink as any);
    await flushAsync();
    handleWebCommand({ type: 'fs.read', path: filePath, requestId: 'req-post-write' }, mockServerLink as any);
    await flushAsync();

    expect(mockReadFile).toHaveBeenCalledTimes(2);
    expect((sent.find((msg: any) => msg.requestId === 'req-post-write') as any)?.content).toBe('after write');
  });
});
