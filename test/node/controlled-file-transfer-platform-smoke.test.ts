import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_TRANSFER_MSG } from '../../shared/transport/file-transfer.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:os');
  vi.doUnmock('../../src/util/logger.js');
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('controlled file transfer native-platform smoke', () => {
  it('downloads relay bytes into staging, mints an explicit handle, and returns identical bytes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'imcodes-controlled-file-smoke-')));
    roots.push(root);
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const payload = Buffer.from(Array.from({ length: 4097 }, (_, index) => (index * 31) & 0xff));

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => home };
    });
    vi.doMock('../../src/util/logger.js', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const transfer = await import('../../src/daemon/file-transfer-handler.js');

    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/artifact') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
        response.end(payload);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server port');
      const uploadMessages: Record<string, unknown>[] = [];
      await transfer.handleFileUploadFetch({
        type: FILE_TRANSFER_MSG.UPLOAD_FETCH,
        uploadId: 'platform-smoke-upload',
        filename: `${'a'.repeat(32)}.bin`,
        originalName: 'platform-smoke.bin',
        mime: 'application/octet-stream',
        size: payload.length,
        downloadUrl: `http://127.0.0.1:${address.port}/artifact`,
      }, { send: (message) => uploadMessages.push(message as Record<string, unknown>) });

      const uploaded = uploadMessages.find((message) => message.type === FILE_TRANSFER_MSG.UPLOAD_DONE);
      expect(uploaded).toBeTruthy();
      const uploadedAttachment = uploaded!.attachment as { daemonPath: string; id: string };
      expect(sha256(await readFile(uploadedAttachment.daemonPath))).toBe(sha256(payload));

      const handleMessages: Record<string, unknown>[] = [];
      await transfer.handleFilePathHandle({
        type: FILE_TRANSFER_MSG.PATH_HANDLE,
        requestId: 'platform-smoke-handle',
        path: uploadedAttachment.daemonPath,
      }, { send: (message) => handleMessages.push(message as Record<string, unknown>) });
      const handled = handleMessages.find((message) => message.type === FILE_TRANSFER_MSG.PATH_HANDLE_DONE);
      expect(handled).toBeTruthy();
      const handle = handled!.attachment as { id: string };

      const downloadMessages: Record<string, unknown>[] = [];
      await transfer.handleFileDownload({
        type: FILE_TRANSFER_MSG.DOWNLOAD,
        downloadId: 'platform-smoke-download',
        attachmentId: handle.id,
      }, { send: (message) => downloadMessages.push(message as Record<string, unknown>) });
      const downloaded = downloadMessages.find((message) => message.type === FILE_TRANSFER_MSG.DOWNLOAD_DONE);
      expect(downloaded).toBeTruthy();
      expect(sha256(Buffer.from(String(downloaded!.content), 'base64'))).toBe(sha256(payload));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
