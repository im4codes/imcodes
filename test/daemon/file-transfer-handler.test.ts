import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FS_GENERIC_ERROR_CODES } from '../../shared/fs-error-codes.js';
import { FILE_TRANSFER_LIMITS, FILE_TRANSFER_MSG, FILE_TRANSFER_RELAY_HEADER } from '../../shared/transport/file-transfer.js';

async function loadFileTransferHandler(
  fakeHome: string,
  options?: { maxFileSize?: number; limits?: Partial<Record<keyof typeof FILE_TRANSFER_LIMITS, number>> },
) {
  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('IMCODES_HOME', path.join(fakeHome, '.imcodes'));
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => fakeHome };
  });
  if (options?.maxFileSize !== undefined || options?.limits) {
    vi.doMock('../../shared/transport/file-transfer.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../shared/transport/file-transfer.js')>();
      return {
        ...actual,
        FILE_TRANSFER_LIMITS: {
          ...actual.FILE_TRANSFER_LIMITS,
          ...options.limits,
          ...(options.maxFileSize !== undefined ? { MAX_FILE_SIZE: options.maxFileSize } : {}),
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
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(rootDir, { recursive: true, force: true });
  });

  it.runIf(process.env.IMC_BIG_TRANSFER === '1')('real-stream 15KiB and 500MiB repeat/relay transfers preserve bytes', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      const total = fetchCount++ === 0 ? 15 * 1024 : 500 * 1024 * 1024;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= total) { controller.close(); return; }
          const chunk = new Uint8Array(Math.min(1024 * 1024, total - sent));
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': String(total) } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();
    await transfer.handleFileUploadFetch({
      type: 'file.upload_fetch', uploadId: 'small', clientUploadId: 'small-transfer-proof',
      filename: 'small.bin', originalName: 'small.bin', size: 15 * 1024,
      downloadUrl: 'https://relay.example/small',
    }, done.serverLink as never);
    const clientUploadId = 'big-transfer-repeat-proof';
    const first = Date.now();
    await transfer.handleFileUploadFetch({
      type: 'file.upload_fetch', uploadId: 'big-1', clientUploadId,
      filename: 'big.bin', originalName: 'big.bin', size: 500 * 1024 * 1024,
      downloadUrl: 'https://relay.example/big',
    }, done.serverLink as never);
    const firstMs = Date.now() - first;
    const second = Date.now();
    await transfer.handleFileUploadFetch({
      type: 'file.upload_fetch', uploadId: 'big-2', clientUploadId,
      filename: 'big.bin', originalName: 'big.bin', size: 500 * 1024 * 1024,
      downloadUrl: 'https://relay.example/big',
    }, done.serverLink as never);
    const secondMs = Date.now() - second;
    const attachment = transfer.lookupAttachmentByClientUploadId(clientUploadId);
    expect(attachment?.size).toBe(500 * 1024 * 1024);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(done.sent.filter((entry) => (entry as { type?: string }).type === 'file.upload_done')).toHaveLength(3);
    const digest = createHash('sha256').update(await readFile(attachment!.daemonPath)).digest('hex');
    expect(digest).toBe(createHash('sha256').update(Buffer.alloc(500 * 1024 * 1024)).digest('hex'));
    expect(firstMs).toBeGreaterThan(0);
    expect(secondMs).toBeLessThan(1_000);
  }, 180_000);

  it.runIf(process.env.IMC_BIG_TRANSFER === '1')('real-stream stuck claim returns a terminal error instead of hanging', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const done = createServerLinkMock();
    const clientUploadId = 'big-transfer-stuck-claim';
    const claim = transfer.tryClaimClientUpload(clientUploadId);
    expect(claim).not.toBeNull();
    const start = Date.now();
    await transfer.handleFileUploadFetch({
      type: 'file.upload_fetch', uploadId: 'stuck', clientUploadId,
      filename: 'stuck.bin', originalName: 'stuck.bin', size: 500 * 1024 * 1024,
      downloadUrl: 'https://relay.example/stuck',
    }, done.serverLink as never);
    expect(Date.now() - start).toBeGreaterThanOrEqual(transfer.CLIENT_UPLOAD_CLAIM_WAIT_TIMEOUT_MS);
    expect(done.sent).toEqual([expect.objectContaining({ type: 'file.upload_error', uploadId: 'stuck' })]);
    transfer.releaseClientUploadClaim(clientUploadId, claim!);
  }, 180_000);

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

  it('resolves a direct source only from a minted handle after revalidating its canonical file', async () => {
    const filePath = path.join(rootDir, 'project', 'direct.bin');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'direct bytes');

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'direct.bin', 'application/octet-stream', 12);

    await expect(transfer.resolveDirectFileDownloadSource(handle.id)).resolves.toMatchObject({
      readPath: await realpath(filePath),
      filename: 'direct.bin',
      mime: 'application/octet-stream',
      size: 12,
    });
    await expect(transfer.resolveDirectFileDownloadSource('/etc/passwd')).rejects.toThrow('not_found');
  });

  it('fails closed when a minted direct source is replaced before the stream starts', async () => {
    const filePath = path.join(rootDir, 'project', 'replaced.bin');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'before');

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'replaced.bin', 'application/octet-stream', 6);
    await unlink(filePath);
    // Filesystems may reuse an inode immediately, so make the replacement
    // size differ as well; the minted handle binds both identity components.
    await writeFile(filePath, 'after!!');

    await expect(transfer.resolveDirectFileDownloadSource(handle.id)).rejects.toThrow('download_failed');
  });

  it('returns small files inline (file.download_done) instead of using the relay', async () => {
    const filePath = path.join(rootDir, 'project', 'small.txt');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'hello inline');

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'small.txt', 'text/plain', 'hello inline'.length);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const inline = createServerLinkMock();

    await transfer.handleFileDownloadStream(
      {
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
        downloadId: 'download-inline',
        attachmentId: handle.id,
        uploadUrl: 'https://relay.example/download-staged/download-inline?token=secret',
      },
      inline.serverLink as never,
    );

    // Small file → single inline reply over WS, NO relay PUT.
    expect(inline.sent).toEqual([
      expect.objectContaining({
        type: 'file.download_done',
        downloadId: 'download-inline',
        content: Buffer.from('hello inline').toString('base64'),
        mime: 'text/plain',
        filename: 'small.txt',
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams LARGE downloads to the relay upload URL without sending base64 content over WS', async () => {
    const filePath = path.join(rootDir, 'project', 'large.bin');
    // Must exceed the inline threshold so it takes the relay path, not inline.
    const content = Buffer.alloc(FILE_TRANSFER_LIMITS.DOWNLOAD_INLINE_MAX_BYTES + 1024, 7);
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

  it('resumes a relay download from the requested offset', async () => {
    const filePath = path.join(rootDir, 'project', 'resume.bin');
    const content = Buffer.alloc(FILE_TRANSFER_LIMITS.DOWNLOAD_INLINE_MAX_BYTES + 4096);
    for (let i = 0; i < content.length; i += 1) content[i] = i % 251;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);

    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'resume.bin', 'application/octet-stream', content.length);
    let putBody: Buffer | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      putBody = Buffer.concat(chunks);
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const streamed = createServerLinkMock();
    const offset = 1_000_003;

    await transfer.handleFileDownloadStream(
      {
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
        downloadId: 'download-resume',
        attachmentId: handle.id,
        uploadUrl: 'https://relay.example/download-staged/download-resume?token=secret',
        offset,
      },
      streamed.serverLink as never,
    );

    // READY still describes the whole file, and says where this body starts.
    expect(streamed.sent).toEqual([
      expect.objectContaining({
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM_READY,
        size: content.length,
        offset,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/download-staged/download-resume?token=secret',
      expect.objectContaining({
        headers: expect.objectContaining({
          'content-length': String(content.length - offset),
          [FILE_TRANSFER_RELAY_HEADER.OFFSET]: String(offset),
        }),
      }),
    );
    expect(putBody?.equals(content.subarray(offset))).toBe(true);
  });

  it('refuses an offset past the end of the file', async () => {
    const filePath = path.join(rootDir, 'project', 'short.bin');
    const content = Buffer.alloc(FILE_TRANSFER_LIMITS.DOWNLOAD_INLINE_MAX_BYTES + 10, 1);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    const transfer = await loadFileTransferHandler(fakeHome);
    const handle = transfer.createProjectFileHandle(filePath, 'short.bin', 'application/octet-stream', content.length);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const failed = createServerLinkMock();

    await transfer.handleFileDownloadStream(
      {
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
        downloadId: 'download-past-end',
        attachmentId: handle.id,
        uploadUrl: 'https://relay.example/download-staged/download-past-end?token=secret',
        offset: content.length + 1,
      },
      failed.serverLink as never,
    );

    expect(failed.sent).toEqual([expect.objectContaining({ type: 'file.download_error', downloadId: 'download-past-end' })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('relay upload fetch rides out connect-phase network failures', () => {
    function connectTimeout(): TypeError {
      return Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(
          new Error('Connect Timeout Error (attempted address: relay.example:443, timeout: 10000ms)'),
          { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
        ),
      });
    }

    async function runUploadFetch(
      fetchMock: ReturnType<typeof vi.fn>,
      uploadId: string,
    ): Promise<ReturnType<typeof createServerLinkMock>> {
      // Real timers with the spaced pre-connect backoff shrunk to 1ms: no fake
      // clock to desynchronise from the handler's real file I/O.
      const transfer = await loadFileTransferHandler(fakeHome, {
        limits: { RELAY_PRE_CONNECT_BASE_DELAY_MS: 1, RELAY_PRE_CONNECT_MAX_DELAY_MS: 1 },
      });
      vi.stubGlobal('fetch', fetchMock);
      const done = createServerLinkMock();
      await transfer.handleFileUploadFetch({
        type: 'file.upload_fetch', uploadId, clientUploadId: `client-${uploadId}`,
        filename: `${uploadId}.bin`, originalName: `${uploadId}.bin`, size: 5,
        downloadUrl: 'https://relay.example/upload-staged/x?token=secret',
      }, done.serverLink as never);
      return done;
    }

    it('succeeds after more consecutive connect timeouts than the old three-attempt loop allowed', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(connectTimeout())
        .mockRejectedValueOnce(connectTimeout())
        .mockRejectedValueOnce(connectTimeout())
        .mockRejectedValueOnce(connectTimeout())
        .mockImplementation(async () => new Response('hello', { status: 200, headers: { 'content-length': '5' } }));
      const done = await runUploadFetch(fetchMock, 'relay-flaky');
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(done.sent.some((m) => (m as { type?: string }).type === 'file.upload_done')).toBe(true);
      expect(done.sent.some((m) => (m as { type?: string }).type === 'file.upload_error')).toBe(false);
    });

    it('reports one terminal error after exactly RELAY_PRE_CONNECT_MAX_ATTEMPTS fetches on a dead network', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => { throw connectTimeout(); });
      const done = await runUploadFetch(fetchMock, 'relay-dead');
      expect(fetchMock).toHaveBeenCalledTimes(FILE_TRANSFER_LIMITS.RELAY_PRE_CONNECT_MAX_ATTEMPTS);
      const errors = done.sent.filter((m) => (m as { type?: string }).type === 'file.upload_error');
      expect(errors).toHaveLength(1);
      expect(done.sent.some((m) => (m as { type?: string }).type === 'file.upload_done')).toBe(false);
    });

    it('keeps the original three-attempt policy for HTTP failures (no pre-connect retry)', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 503 }));
      const done = await runUploadFetch(fetchMock, 'relay-503');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(done.sent.filter((m) => (m as { type?: string }).type === 'file.upload_error')).toHaveLength(1);
    });
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

  it('stores id-backed uploads under an id directory using the original filename', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const done = createServerLinkMock();
    const id = '0123456789abcdef0123456789abcdef';
    await transfer.handleFileUpload({
      type: 'file.upload',
      uploadId: 'upload-nested',
      filename: id,
      originalName: '截图 2026.png',
      mime: 'image/png',
      size: 5,
      content: Buffer.from('hello').toString('base64'),
    }, done.serverLink as never);
    const attachment = (done.sent.find((entry) => (entry as { type?: string }).type === 'file.upload_done') as { attachment: { daemonPath: string; id: string; originalName: string } }).attachment;
    expect(attachment.id).toBe(id);
    expect(attachment.originalName).toBe('截图 2026.png');
    expect(attachment.daemonPath).toContain(path.join(id, '截图 2026.png'));
    await expect(readFile(attachment.daemonPath, 'utf8')).resolves.toBe('hello');
    await transfer.handleFileDelete({ type: FILE_TRANSFER_MSG.DELETE, requestId: 'delete-nested', attachmentId: id }, done.serverLink as never);
    await expect(stat(path.dirname(attachment.daemonPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts the legacy id-plus-extension filename while retaining the new id directory layout', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const done = createServerLinkMock();
    const id = 'fedcba9876543210fedcba9876543210';
    await transfer.handleFileUpload({
      type: 'file.upload',
      uploadId: 'upload-legacy-shaped',
      filename: `${id}.png`,
      originalName: 'image.png',
      sanitizedName: 'image.png',
      mime: 'image/png',
      size: 5,
      content: Buffer.from('hello').toString('base64'),
    }, done.serverLink as never);
    const attachment = (done.sent.find((entry) => (entry as { type?: string }).type === 'file.upload_done') as { attachment: { id: string; daemonPath: string } }).attachment;
    expect(attachment.id).toBe(id);
    expect(attachment.daemonPath).toContain(path.join(id, 'image.png'));
    await expect(readFile(attachment.daemonPath, 'utf8')).resolves.toBe('hello');
  });

  it('keeps duplicate original names in distinct id directories', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const first = createServerLinkMock();
    const second = createServerLinkMock();
    const originalName = '报价单 v2.xlsx';
    const payload = Buffer.from('same-name');
    await transfer.handleFileUpload({
      type: 'file.upload', uploadId: 'upload-duplicate-1', filename: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originalName, sanitizedName: originalName, size: payload.length, content: payload.toString('base64'),
    }, first.serverLink as never);
    await transfer.handleFileUpload({
      type: 'file.upload', uploadId: 'upload-duplicate-2', filename: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      originalName, sanitizedName: originalName, size: payload.length, content: payload.toString('base64'),
    }, second.serverLink as never);
    const a = (first.sent.find((entry) => (entry as { type?: string }).type === 'file.upload_done') as { attachment: { daemonPath: string } }).attachment;
    const b = (second.sent.find((entry) => (entry as { type?: string }).type === 'file.upload_done') as { attachment: { daemonPath: string } }).attachment;
    expect(a.daemonPath).not.toBe(b.daemonPath);
    expect(a.daemonPath).toContain(path.join('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', originalName));
    expect(b.daemonPath).toContain(path.join('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', originalName));
    await expect(readFile(a.daemonPath)).resolves.toEqual(payload);
    await expect(readFile(b.daemonPath)).resolves.toEqual(payload);
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

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/upload-staged/upload-fetch?token=reusable',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

  it('resumes a broken relay upload fetch from the bytes already written', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('he'));
        setTimeout(() => controller.error(new TypeError('link_lost')), 20);
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(broken, { status: 200 }))
      .mockResolvedValueOnce(new Response('llo', {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-4/5' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();

    await transfer.handleFileUploadFetch({
      type: 'file.upload_fetch',
      uploadId: 'upload-fetch-resume',
      filename: 'resume.txt',
      originalName: 'resume.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: 'https://relay.example/upload-staged/upload-fetch-resume?token=reusable',
    }, done.serverLink as never);

    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      headers: { Range: 'bytes=2-' },
    }));
    await expect(readFile(path.join(fakeHome, '.imcodes', 'uploads', 'resume.txt'), 'utf8')).resolves.toBe('hello');
    expect(done.sent).toContainEqual(expect.objectContaining({ type: 'file.upload_done', uploadId: 'upload-fetch-resume' }));
  });

  it('lists child directories and regular files through the bounded remote file browser', async () => {
    const parent = path.join(rootDir, 'directory-picker');
    await mkdir(path.join(parent, 'visible'), { recursive: true });
    await mkdir(path.join(parent, '.hidden'), { recursive: true });
    await writeFile(path.join(parent, 'report.txt'), 'downloadable file');
    const transfer = await loadFileTransferHandler(fakeHome);
    const result = createServerLinkMock();

    await transfer.handleFileDirectoryList({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
      requestId: 'directory-list-1',
      path: parent,
    }, result.serverLink);

    expect(result.sent).toEqual([{
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'directory-list-1',
      path: parent,
      resolvedPath: await realpath(parent),
      entries: [
        { name: '.hidden', path: path.join(await realpath(parent), '.hidden'), isDir: true, hidden: true },
        { name: 'visible', path: path.join(await realpath(parent), 'visible'), isDir: true, hidden: false },
        { name: 'report.txt', path: path.join(await realpath(parent), 'report.txt'), isDir: false, hidden: false },
      ],
    }]);
  });

  it('answers a listing query with metadata and a truncation report, ordered before the cut', async () => {
    const parent = path.join(rootDir, 'directory-query');
    await mkdir(parent, { recursive: true });
    for (let index = 0; index < 600; index += 1) await writeFile(path.join(parent, `f-${String(index).padStart(4, '0')}.txt`), 'x');
    const newest = path.join(parent, 'zz-newest.txt');
    await writeFile(newest, 'abcd');
    await utimes(newest, new Date('2031-01-01T00:00:00Z'), new Date('2031-01-01T00:00:00Z'));
    const transfer = await loadFileTransferHandler(fakeHome);
    const result = createServerLinkMock();

    await transfer.handleFileDirectoryList({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
      requestId: 'directory-query-1',
      path: parent,
      query: { sort: { key: 'modified', direction: 'desc', dirsFirst: true } },
    }, result.serverLink);

    const message = result.sent[0] as { entries: Array<Record<string, unknown>>; truncated?: boolean; total?: number };
    expect(message.entries).toHaveLength(512);
    expect(message.entries[0]).toMatchObject({ name: 'zz-newest.txt', size: 4, mtimeMs: Date.parse('2031-01-01T00:00:00Z') });
    expect(message.truncated).toBe(true);
    expect(message.total).toBe(601);
  });

  it('answers a malformed listing query with an error, never a listing', async () => {
    const parent = path.join(rootDir, 'directory-query-bad');
    await mkdir(parent, { recursive: true });
    const transfer = await loadFileTransferHandler(fakeHome);
    const result = createServerLinkMock();

    await transfer.handleFileDirectoryList({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST,
      requestId: 'directory-query-2',
      path: parent,
      query: { sort: { key: 'modified', direction: 'desc', dirsFirst: true }, nameFilter: 'x'.repeat(300) },
    }, result.serverLink);

    expect(result.sent).toHaveLength(1);
    expect(result.sent[0]).toMatchObject({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST_ERROR, requestId: 'directory-query-2' });
  });

  it('commits a relay upload into the selected existing directory without overwrite', async () => {
    const destinationDirectory = path.join(rootDir, 'remote-destination');
    await mkdir(destinationDirectory, { recursive: true });
    const transfer = await loadFileTransferHandler(fakeHome);
    const fetchMock = vi.fn().mockResolvedValue(new Response('hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();

    await transfer.handleFileUploadFetch({
      type: FILE_TRANSFER_MSG.UPLOAD_FETCH,
      uploadId: 'upload-to-directory',
      clientUploadId: 'client-upload-to-directory',
      filename: 'abcdef1234567890.txt',
      originalName: 'report.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: 'https://relay.example/staged',
      destinationDirectory,
    }, done.serverLink as never);

    await expect(stat(path.join(destinationDirectory, 'report.txt'))).resolves.toMatchObject({ size: 5 });
    expect(done.sent).toContainEqual(expect.objectContaining({
      type: FILE_TRANSFER_MSG.UPLOAD_DONE,
      uploadId: 'upload-to-directory',
      attachment: expect.objectContaining({
        source: 'local',
        daemonPath: await realpath(path.join(destinationDirectory, 'report.txt')),
        originalName: 'report.txt',
      }),
    }));

    const refused = createServerLinkMock();
    await transfer.handleFileUploadFetch({
      type: FILE_TRANSFER_MSG.UPLOAD_FETCH,
      uploadId: 'upload-existing-destination',
      filename: 'abcdef1234567891.txt',
      originalName: 'report.txt',
      size: 5,
      downloadUrl: 'https://relay.example/staged-again',
      destinationDirectory,
    }, refused.serverLink as never);
    expect(refused.sent).toContainEqual(expect.objectContaining({
      type: FILE_TRANSFER_MSG.UPLOAD_ERROR,
      uploadId: 'upload-existing-destination',
    }));
    await expect(stat(path.join(destinationDirectory, 'report.txt'))).resolves.toMatchObject({ size: 5 });
  });

  it('commits a direct upload into the same validated destination seam', async () => {
    const destinationDirectory = path.join(rootDir, 'direct-destination');
    const stagedPath = path.join(rootDir, 'direct-upload.part');
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(stagedPath, 'hello');
    const transfer = await loadFileTransferHandler(fakeHome);

    const attachment = await transfer.finalizeDirectUploadedFile({
      clientUploadId: 'client-direct-directory',
      filename: 'direct-staged.txt',
      originalName: 'report.txt',
      mime: 'text/plain',
      resolved: stagedPath,
      size: 5,
      destinationDirectory,
    });

    const destination = path.join(destinationDirectory, 'report.txt');
    await expect(stat(destination)).resolves.toMatchObject({ size: 5 });
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(attachment).toMatchObject({
      source: 'local',
      daemonPath: await realpath(destination),
      originalName: 'report.txt',
      size: 5,
    });
    expect(transfer.lookupAttachmentByClientUploadId('client-direct-directory')).toMatchObject({
      id: attachment.id,
      daemonPath: await realpath(destination),
    });
  });

  it('deletes a completed upload and its metadata while refusing local project handles', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const uploaded = createServerLinkMock();
    await transfer.handleFileUpload({
      type: 'file.upload',
      uploadId: 'upload-delete',
      filename: 'delete-me.txt',
      originalName: 'delete-me.txt',
      size: 5,
      content: Buffer.from('hello').toString('base64'),
    }, uploaded.serverLink as never);

    const uploadPath = path.join(fakeHome, '.imcodes', 'uploads', 'delete-me.txt');
    await expect(stat(uploadPath)).resolves.toMatchObject({ size: 5 });
    await expect(stat(`${uploadPath}.meta.json`)).resolves.toBeDefined();
    const legacyDownload = await transfer.resolveDirectFileDownloadSource('delete-me.txt');
    expect(legacyDownload.filename).toBe('delete-me.txt');
    await expect(readFile(legacyDownload.readPath, 'utf8')).resolves.toBe('hello');

    const deleted = createServerLinkMock();
    await transfer.handleFileDelete({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-request',
      attachmentId: 'delete-me.txt',
    }, deleted.serverLink as never);
    expect(deleted.sent).toEqual([{ type: FILE_TRANSFER_MSG.DELETE_DONE, requestId: 'delete-request' }]);
    await expect(stat(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(`${uploadPath}.meta.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    const projectPath = path.join(rootDir, 'project-file.txt');
    await writeFile(projectPath, 'keep');
    const validated = await transfer.validateProjectFilePath(projectPath);
    const local = transfer.createProjectFileHandleFromValidatedPath(validated, 'project-file.txt', 'text/plain', 4);
    const refused = createServerLinkMock();
    await transfer.handleFileDelete({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-local',
      attachmentId: local.id,
    }, refused.serverLink as never);
    expect(refused.sent).toEqual([{
      type: FILE_TRANSFER_MSG.DELETE_ERROR,
      requestId: 'delete-local',
      error: 'forbidden',
    }]);
    await expect(stat(projectPath)).resolves.toMatchObject({ size: 4 });
  });

  it('refuses a local registry entry even when its path is inside the upload root', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const uploaded = createServerLinkMock();
    await transfer.handleFileUpload({
      type: 'file.upload',
      uploadId: 'upload-source-guard',
      filename: 'source-guard.txt',
      originalName: 'source-guard.txt',
      size: 4,
      content: Buffer.from('keep').toString('base64'),
    }, uploaded.serverLink as never);

    const uploadPath = path.join(fakeHome, '.imcodes', 'uploads', 'source-guard.txt');
    const entry = transfer.lookupAttachmentById('source-guard.txt');
    expect(entry).toBeDefined();
    entry!.source = 'local';

    const refused = createServerLinkMock();
    await transfer.handleFileDelete({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-source-guard',
      attachmentId: 'source-guard.txt',
    }, refused.serverLink as never);

    expect(refused.sent).toEqual([{
      type: FILE_TRANSFER_MSG.DELETE_ERROR,
      requestId: 'delete-source-guard',
      error: 'forbidden',
    }]);
    await expect(stat(uploadPath)).resolves.toMatchObject({ size: 4 });
  });

  it('refuses an upload-labeled registry entry whose path is outside the upload root', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const projectPath = path.join(rootDir, 'outside-upload-root.txt');
    await writeFile(projectPath, 'keep');
    const validated = await transfer.validateProjectFilePath(projectPath);
    const handle = transfer.createProjectFileHandleFromValidatedPath(
      validated,
      'outside-upload-root.txt',
      'text/plain',
      4,
    );
    const entry = transfer.lookupAttachmentById(handle.id);
    expect(entry).toBeDefined();
    entry!.source = 'upload';

    const refused = createServerLinkMock();
    await transfer.handleFileDelete({
      type: FILE_TRANSFER_MSG.DELETE,
      requestId: 'delete-path-guard',
      attachmentId: handle.id,
    }, refused.serverLink as never);

    expect(refused.sent).toEqual([{
      type: FILE_TRANSFER_MSG.DELETE_ERROR,
      requestId: 'delete-path-guard',
      error: 'forbidden',
    }]);
    await expect(stat(projectPath)).resolves.toMatchObject({ size: 4 });
  });

  it('waits for an ambiguous direct attempt and reuses its committed attachment instead of uploading twice', async () => {
    const transfer = await loadFileTransferHandler(fakeHome);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const done = createServerLinkMock();
    const clientUploadId = 'client_upload_ambiguous_1234';
    const claim = transfer.tryClaimClientUpload(clientUploadId);
    expect(claim).not.toBeNull();

    const relay = transfer.handleFileUploadFetch({
      type: 'file.upload_fetch',
      uploadId: 'upload-fallback',
      clientUploadId,
      filename: 'relay.txt',
      originalName: 'source.txt',
      size: 5,
      downloadUrl: 'https://relay.example/upload-staged/upload-fallback?token=reusable',
    }, done.serverLink as never);

    await vi.waitFor(() => expect(transfer.waitForClientUploadClaim(clientUploadId)).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    const directPath = path.join(fakeHome, '.imcodes', 'uploads', 'direct.txt');
    await transfer.finalizeDirectUploadedFile({
      clientUploadId,
      filename: 'direct.txt',
      originalName: 'source.txt',
      resolved: directPath,
      size: 5,
    });
    transfer.releaseClientUploadClaim(clientUploadId, claim!);
    await relay;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(done.sent).toEqual([expect.objectContaining({
      type: 'file.upload_done',
      uploadId: 'upload-fallback',
      attachment: expect.objectContaining({ id: 'direct.txt', size: 5 }),
    })]);
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
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://relay.example/upload-staged/upload-fetch-retry?token=reusable',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(done.sent).toContainEqual(expect.objectContaining({
      type: 'file.upload_done',
      uploadId: 'upload-fetch-retry',
    }));
  });

  it('creates a short-lived handle for one explicit regular path', async () => {
    const filePath = path.join(rootDir, 'report.txt');
    await writeFile(filePath, 'hello');
    const transfer = await loadFileTransferHandler(fakeHome);
    const done = createServerLinkMock();

    await transfer.handleFilePathHandle({
      type: FILE_TRANSFER_MSG.PATH_HANDLE,
      requestId: 'path-handle-1',
      path: filePath,
    }, done.serverLink);

    expect(done.sent).toEqual([expect.objectContaining({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      requestId: 'path-handle-1',
      attachment: expect.objectContaining({ daemonPath: await realpath(filePath), size: 5, downloadable: true }),
      sourceIdentity: expect.objectContaining({ size: 5, device: expect.any(Number), inode: expect.any(Number) }),
    })]);
  });

  it('rejects symlinks and sensitive credential paths without echoing the path', async () => {
    const target = path.join(rootDir, 'target.txt');
    const linked = path.join(rootDir, 'linked.txt');
    await writeFile(target, 'hello');
    await symlink(target, linked);
    const deniedDir = path.join(fakeHome, '.ssh');
    const denied = path.join(deniedDir, 'id_rsa');
    await mkdir(deniedDir, { recursive: true });
    await writeFile(denied, 'secret');
    const transfer = await loadFileTransferHandler(fakeHome);

    for (const [requestId, filePath, expected] of [
      ['path-symlink', linked, 'not_regular_file'],
      ['path-sensitive', denied, 'forbidden_path'],
    ] as const) {
      const result = createServerLinkMock();
      await transfer.handleFilePathHandle({ type: FILE_TRANSFER_MSG.PATH_HANDLE, requestId, path: filePath }, result.serverLink);
      expect(result.sent).toEqual([{ type: FILE_TRANSFER_MSG.PATH_HANDLE_ERROR, requestId, error: expected }]);
      expect(JSON.stringify(result.sent)).not.toContain(filePath);
    }
  });

  it('invalidates a local handle when its path is replaced before download', async () => {
    const filePath = path.join(rootDir, 'replace-me.txt');
    await writeFile(filePath, 'first');
    const transfer = await loadFileTransferHandler(fakeHome);
    const minted = createServerLinkMock();
    await transfer.handleFilePathHandle({ type: FILE_TRANSFER_MSG.PATH_HANDLE, requestId: 'path-replace', path: filePath }, minted.serverLink);
    const attachmentId = (minted.sent[0] as { attachment: { id: string } }).attachment.id;
    await unlink(filePath);
    await writeFile(filePath, 'second');

    const downloaded = createServerLinkMock();
    await transfer.handleFileDownload({ type: FILE_TRANSFER_MSG.DOWNLOAD, downloadId: 'download-replace', attachmentId }, downloaded.serverLink);
    expect(downloaded.sent).toEqual([{ type: FILE_TRANSFER_MSG.DOWNLOAD_ERROR, downloadId: 'download-replace', message: 'download_failed' }]);
  });
});
