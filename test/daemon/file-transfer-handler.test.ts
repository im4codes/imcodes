import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FILE_TRANSFER_LIMITS, FILE_TRANSFER_MSG } from '../../shared/transport/file-transfer.js';

async function loadFileTransferHandler(fakeHome: string, options?: { maxFileSize?: number }) {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => fakeHome };
  });
  if (options?.maxFileSize !== undefined) {
    vi.doMock('../../shared/transport/file-transfer.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../shared/transport/file-transfer.js')>();
      return {
        ...actual,
        FILE_TRANSFER_LIMITS: {
          ...actual.FILE_TRANSFER_LIMITS,
          MAX_FILE_SIZE: options.maxFileSize,
        },
      };
    });
  }
  vi.doMock('../../src/util/logger.js', () => ({
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));
  return await import('../../src/daemon/file-transfer-handler.js');
}

function createServerLinkMock() {
  const sent: unknown[] = [];
  return {
    sent,
    serverLink: {
      send: vi.fn((msg: unknown) => {
        sent.push(msg);
      }),
      sendBinary: vi.fn(),
    },
  };
}

describe('file-transfer local handle hardening', () => {
  let rootDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'imcodes-file-transfer-')));
    fakeHome = path.join(rootDir, 'home');
    await mkdir(fakeHome, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock('node:os');
    vi.doUnmock('../../shared/transport/file-transfer.js');
    vi.doUnmock('../../src/util/logger.js');
    vi.resetModules();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('registers allowed validated handles, including binary and too-large files', async () => {
    const projectDir = path.join(rootDir, 'project');
    const filePath = path.join(projectDir, 'artifact.bin');
    await mkdir(projectDir, { recursive: true });
    await writeFile(filePath, Buffer.from([0, 1, 2, 3]));

    const transfer = await loadFileTransferHandler(fakeHome);
    const validated = await transfer.validateProjectFilePath(filePath);
    const canonical = await realpath(filePath);

    const binaryHandle = transfer.createProjectFileHandleFromValidatedPath(
      validated,
      'artifact.bin',
      'application/octet-stream',
      4,
    );
    const hugeHandle = transfer.createProjectFileHandleFromValidatedPath(
      validated,
      'artifact-huge.bin',
      'application/octet-stream',
      101 * 1024 * 1024,
    );

    expect(binaryHandle).toMatchObject({
      source: 'local',
      daemonPath: canonical,
      downloadable: true,
      size: 4,
    });
    expect(hugeHandle).toMatchObject({
      source: 'local',
      daemonPath: canonical,
      downloadable: true,
      size: 101 * 1024 * 1024,
    });
    expect(transfer.lookupAttachmentById(binaryHandle.id)?.daemonPath).toBe(canonical);
    expect(transfer.lookupAttachmentById(hugeHandle.id)?.daemonPath).toBe(canonical);
  });

  it('rejects denied canonical paths without registering handles', async () => {
    const deniedDir = path.join(fakeHome, '.ssh');
    const deniedFile = path.join(deniedDir, 'id_rsa');
    await mkdir(deniedDir, { recursive: true });
    await writeFile(deniedFile, 'secret');

    const transfer = await loadFileTransferHandler(fakeHome);
    const deniedRealPath = await realpath(deniedFile);

    expect(() => transfer.createProjectFileHandle(deniedFile, 'id_rsa')).toThrow('forbidden_path');
    expect(transfer.lookupAttachment(deniedRealPath)).toBeUndefined();

    expect(() =>
      transfer.createProjectFileHandleFromValidatedPath(deniedRealPath as never, 'id_rsa'),
    ).toThrow('forbidden_path');
    expect(transfer.lookupAttachment(deniedRealPath)).toBeUndefined();
  });

  it('returns null for denied or fallback tolerant handle creation', async () => {
    const deniedDir = path.join(fakeHome, '.gnupg');
    const deniedFile = path.join(deniedDir, 'private.key');
    const allowedFile = path.join(rootDir, 'project', 'README.md');
    await mkdir(deniedDir, { recursive: true });
    await mkdir(path.dirname(allowedFile), { recursive: true });
    await writeFile(deniedFile, 'secret');
    await writeFile(allowedFile, 'hello');

    const transfer = await loadFileTransferHandler(fakeHome);
    const allowedRealPath = await realpath(allowedFile);

    await expect(transfer.tryCreateProjectFileHandle(deniedFile, 'private.key')).resolves.toBeNull();
    await expect(
      transfer.tryCreateProjectFileHandle(allowedFile, 'README.md', 'text/markdown', 5, { usedFallback: true }),
    ).resolves.toBeNull();
    expect(transfer.lookupAttachment(allowedRealPath)).toBeUndefined();
  });

  it('sanitizes local download read failures', async () => {
    const filePath = path.join(rootDir, 'project', 'missing.txt');
    const dirPath = path.join(rootDir, 'project', 'directory-handle');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'hello');
    await mkdir(dirPath);

    const transfer = await loadFileTransferHandler(fakeHome);
    const missingHandle = transfer.createProjectFileHandle(filePath, 'missing.txt', 'text/plain', 5);
    await unlink(filePath);

    const missing = createServerLinkMock();
    await transfer.handleFileDownload(
      { type: 'file.download', downloadId: 'download-missing', attachmentId: missingHandle.id },
      missing.serverLink as never,
    );
    expect(missing.sent[0]).toMatchObject({
      type: 'file.download_error',
      downloadId: 'download-missing',
      message: 'not_found',
    });

    const failedHandle = transfer.createProjectFileHandle(dirPath, 'directory-handle');
    const failed = createServerLinkMock();
    await transfer.handleFileDownload(
      { type: 'file.download', downloadId: 'download-failed', attachmentId: failedHandle.id },
      failed.serverLink as never,
    );
    expect(failed.sent[0]).toMatchObject({
      type: 'file.download_error',
      downloadId: 'download-failed',
      message: 'download_failed',
    });
    expect(JSON.stringify(failed.sent[0])).not.toContain(dirPath);
  });

  it('keeps local expiry errors stable', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const filePath = path.join(rootDir, 'project', 'expired.txt');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'hello');

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'expired.txt', 'text/plain', 5);

    vi.mocked(Date.now).mockReturnValue(now + FILE_TRANSFER_LIMITS.HANDLE_TTL_MS + 1);
    const expired = createServerLinkMock();
    await transfer.handleFileDownload(
      { type: 'file.download', downloadId: 'download-expired', attachmentId: handle.id },
      expired.serverLink as never,
    );

    expect(expired.sent[0]).toMatchObject({
      type: 'file.download_error',
      downloadId: 'download-expired',
      message: 'expired',
    });
  });

  it('streams downloads to the relay upload URL without sending base64 content over WS', async () => {
    const filePath = path.join(rootDir, 'project', 'large.bin');
    const content = Buffer.alloc(64 * 1024, 7);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'large.bin', 'application/octet-stream', content.length);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const streamed = createServerLinkMock();

    await transfer.handleFileDownloadStream(
      {
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
        downloadId: 'download-stream',
        attachmentId: handle.id,
        uploadUrl: 'https://relay.example/download-staged/download-stream?token=secret',
      },
      streamed.serverLink as never,
    );

    expect(streamed.sent).toEqual([
      expect.objectContaining({
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM_READY,
        downloadId: 'download-stream',
        filename: 'large.bin',
        mime: 'application/octet-stream',
        size: content.length,
      }),
    ]);
    expect(JSON.stringify(streamed.sent)).not.toContain('content');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/download-staged/download-stream?token=secret',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-type': 'application/octet-stream',
          'content-length': String(content.length),
          'x-imcodes-filename': encodeURIComponent('large.bin'),
        }),
        duplex: 'half',
      }),
    );
  });

  it('rejects legacy uploads over the active single-frame cap', async () => {
    const transfer = await loadFileTransferHandler(fakeHome, { maxFileSize: 4 });
    const failed = createServerLinkMock();

    await transfer.handleFileUpload(
      {
        type: 'file.upload',
        uploadId: 'upload-too-large',
        filename: 'safe.txt',
        size: 5,
        content: Buffer.from('hello').toString('base64'),
      },
      failed.serverLink as never,
    );

    expect(failed.sent[0]).toMatchObject({
      type: 'file.upload_error',
      uploadId: 'upload-too-large',
      message: FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE,
    });
  });

  it('rejects legacy upload payloads whose decoded byte count does not match the declared size', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const failed = createServerLinkMock();

    await transfer.handleFileUpload(
      {
        type: 'file.upload',
        uploadId: 'upload-size-mismatch',
        filename: 'safe.txt',
        size: 99,
        content: Buffer.from('hello').toString('base64'),
      },
      failed.serverLink as never,
    );

    expect(failed.sent[0]).toMatchObject({
      type: 'file.upload_error',
      uploadId: 'upload-size-mismatch',
      message: 'size_mismatch',
    });
  });

  it('downloads relay-staged uploads over HTTP and registers the attachment', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();

    await transfer.handleFileUploadFetch(
      {
        type: 'file.upload_fetch',
        uploadId: 'upload-fetch',
        filename: 'safe.txt',
        originalName: 'safe.txt',
        mime: 'text/plain',
        size: 5,
        downloadUrl: 'https://relay.example/upload-staged/upload-fetch?token=reusable',
      },
      done.serverLink as never,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/upload-staged/upload-fetch?token=reusable');
    expect(done.sent).toContainEqual(expect.objectContaining({
      type: 'file.upload_progress',
      uploadId: 'upload-fetch',
      loaded: 0,
      total: 5,
    }));
    expect(done.sent).toContainEqual(expect.objectContaining({
      type: 'file.upload_done',
      uploadId: 'upload-fetch',
      attachment: expect.objectContaining({
        id: 'safe.txt',
        originalName: 'safe.txt',
        mime: 'text/plain',
        size: 5,
        downloadable: true,
      }),
    }));
  });

  it('retries relay-staged upload downloads with the same URL before failing', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('try again', { status: 503 }))
      .mockResolvedValueOnce(new Response('hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();

    await transfer.handleFileUploadFetch(
      {
        type: 'file.upload_fetch',
        uploadId: 'upload-fetch-retry',
        filename: 'retry.txt',
        size: 5,
        downloadUrl: 'https://relay.example/upload-staged/upload-fetch-retry?token=reusable',
      },
      done.serverLink as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://relay.example/upload-staged/upload-fetch-retry?token=reusable');
    expect(done.sent).toContainEqual(expect.objectContaining({
      type: 'file.upload_done',
      uploadId: 'upload-fetch-retry',
    }));
  });
});
