import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  FILE_TRANSFER_LIMITS,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from '../../shared/transport/file-transfer.js';

const { sendFileTransferRequestMock, isDaemonConnectedMock, hasDaemonCapabilityMock, mockResolveServerMemberAccessOrShareDeny } = vi.hoisted(() => ({
  sendFileTransferRequestMock: vi.fn(),
  isDaemonConnectedMock: vi.fn(),
  hasDaemonCapabilityMock: vi.fn(),
  mockResolveServerMemberAccessOrShareDeny: vi.fn(),
}));

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    if (!c.req.header('Authorization')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    c.set('userId', 'user-1');
    return next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      isDaemonConnected: isDaemonConnectedMock,
      sendFileTransferRequest: sendFileTransferRequestMock,
      hasDaemonCapability: hasDaemonCapabilityMock,
    }),
  },
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
}));

vi.mock('../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: (bytes: number) => 'a'.repeat(bytes * 2),
}));

import { fileTransferRoutes } from '../src/routes/file-transfer.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    (c as never as { env: { DB: unknown } }).env = { DB: {} };
    return next();
  });
  app.route('/api/server', fileTransferRoutes);
  return app;
}

describe('file-transfer upload route', () => {
  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset();
    hasDaemonCapabilityMock.mockReset();
    isDaemonConnectedMock.mockReturnValue(true);
    hasDaemonCapabilityMock.mockReturnValue(true);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    sendFileTransferRequestMock.mockResolvedValue({
      type: 'file.upload_done',
      attachment: {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt',
        source: 'upload',
        daemonPath: '/tmp/upload.txt',
        downloadable: true,
      },
    });
  });

  it('rejects share-only uploads with the direct-surface reason before daemon relay', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    const form = new FormData();
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const res = await makeApp().request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: form,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-direct-surface-denied' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('rejects oversized legacy uploads from content-length before daemon relay', async () => {
    const res = await makeApp().request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE + 1024 * 1024 + 1),
      },
      body: '--x\r\n',
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'file_too_large',
      maxBytes: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE,
    });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('stages an upload for daemon HTTP fetch without relaying file bytes over WS', async () => {
    const app = makeApp();
    sendFileTransferRequestMock.mockImplementationOnce(async (_requestId, message) => {
      const uploadMessage = message as { downloadUrl: string };
      const fetchUrl = new URL(uploadMessage.downloadUrl);

      const first = await app.request(`${fetchUrl.pathname}${fetchUrl.search}`);
      await expect(first.text()).resolves.toBe('hello');
      const retry = await app.request(`${fetchUrl.pathname}${fetchUrl.search}`);
      await expect(retry.text()).resolves.toBe('hello');

      return {
        type: 'file.upload_done',
        attachment: {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt',
          source: 'upload',
          daemonPath: '/tmp/upload.txt',
          downloadable: true,
        },
      };
    });

    const form = new FormData();
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const res = await app.request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: form,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      attachment: {
        serverId: 'srv-1',
        daemonPath: '/tmp/upload.txt',
      },
    });
    expect(sendFileTransferRequestMock.mock.calls[0]?.[0]).toEqual(expect.any(String));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      type: 'file.upload_fetch',
      originalName: 'hello.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: expect.stringContaining('/api/server/srv-1/upload-staged/'),
    }));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[2]).toBe(FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS);
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY);
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('content');
  });

  it('cleans relay-staged uploads after a successful daemon fetch grace window', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      sendFileTransferRequestMock.mockImplementationOnce(async (_requestId, message) => {
        const uploadMessage = message as { downloadUrl: string };
        const fetchUrl = new URL(uploadMessage.downloadUrl);
        const stagedPath = `${fetchUrl.pathname}${fetchUrl.search}`;

        const first = await app.request(stagedPath);
        expect(first.status).toBe(200);
        await expect(first.text()).resolves.toBe('hello');

        await vi.advanceTimersByTimeAsync(30_001);
        const expired = await app.request(stagedPath);
        expect(expired.status).toBe(404);

        return {
          type: 'file.upload_done',
          attachment: {
            id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt',
            source: 'upload',
            daemonPath: '/tmp/upload.txt',
            downloadable: true,
          },
        };
      });

      const form = new FormData();
      form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

      const res = await app.request('/api/server/srv-1/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body: form,
      });

      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to legacy base64 upload when daemon has no relay fetch capability', async () => {
    hasDaemonCapabilityMock.mockReturnValue(false);

    const form = new FormData();
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const res = await makeApp().request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: form,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      attachment: {
        serverId: 'srv-1',
        daemonPath: '/tmp/upload.txt',
      },
    });
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      type: 'file.upload',
      originalName: 'hello.txt',
      mime: 'text/plain',
      size: 5,
      content: Buffer.from('hello').toString('base64'),
    }));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('downloadUrl');
  });

  it('streams daemon fetch progress for browsers that opt in', async () => {
    sendFileTransferRequestMock.mockImplementationOnce(async (_requestId, _message, _timeoutMs, onProgress) => {
      onProgress?.({
        type: 'file.upload_progress',
        uploadId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        loaded: 3,
        total: 6,
      });
      return {
        type: 'file.upload_done',
        attachment: {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt',
          source: 'upload',
          daemonPath: '/tmp/upload.txt',
          downloadable: true,
        },
      };
    });

    const form = new FormData();
    form.append('file', new File(['hello!'], 'hello.txt', { type: 'text/plain' }));

    const res = await makeApp().request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        Accept: 'application/x-ndjson',
      },
      body: form,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ type: 'file.upload_progress', loaded: 0, total: 6 }),
      expect.objectContaining({ type: 'file.upload_progress', loaded: 3, total: 6 }),
      expect.objectContaining({
        type: 'file.upload_done',
        ok: true,
        attachment: expect.objectContaining({
          serverId: 'srv-1',
          daemonPath: '/tmp/upload.txt',
        }),
      }),
    ]);
  });
});

describe('file-transfer download route', () => {
  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset();
    hasDaemonCapabilityMock.mockReset();
    isDaemonConnectedMock.mockReturnValue(true);
    hasDaemonCapabilityMock.mockReturnValue(true);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
  });

  it('starts the browser download when the daemon PUT starts even if bridge ready never resolves', async () => {
    const app = makeApp();
    let stagedPut: Promise<Response> | undefined;

    sendFileTransferRequestMock.mockImplementationOnce((_requestId, message) => {
      const downloadMessage = message as { type: string; uploadUrl: string };
      expect(downloadMessage.type).toBe(FILE_TRANSFER_MSG.DOWNLOAD_STREAM);
      const uploadUrl = new URL(downloadMessage.uploadUrl);
      stagedPut = app.request(`${uploadUrl.pathname}${uploadUrl.search}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '5',
          'x-imcodes-filename': encodeURIComponent('hello.txt'),
        },
        body: 'hello',
      });
      return new Promise(() => {});
    });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('content-disposition')).toContain('hello.txt');
    await expect(res.text()).resolves.toBe('hello');
    await expect(stagedPut).resolves.toMatchObject({ status: 200 });
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM,
        attachmentId: 'abc123',
        uploadUrl: expect.stringContaining('/api/server/srv-1/download-staged/'),
      }),
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
    );
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY);
  });

  it('falls back to the base64 download when the streamed relay fails to deliver bytes', async () => {
    const app = makeApp();
    // 1st WS call = DOWNLOAD_STREAM (relay) → reject to simulate a relay that
    // never delivers (the production "stuck downloading" failure mode).
    // 2nd WS call = file.download (legacy base64 fallback) → succeed.
    sendFileTransferRequestMock
      .mockImplementationOnce((_requestId: string, message: unknown) => {
        expect((message as { type: string }).type).toBe(FILE_TRANSFER_MSG.DOWNLOAD_STREAM);
        return Promise.reject(new Error('relay_upload_502'));
      })
      .mockImplementationOnce((_requestId: string, message: unknown) => {
        expect((message as { type: string }).type).toBe('file.download');
        return Promise.resolve({
          content: Buffer.from('hello world').toString('base64'),
          mime: 'text/plain',
          filename: 'hello.txt',
        });
      });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('hello.txt');
    await expect(res.text()).resolves.toBe('hello world');
    // Both the relay attempt and the base64 fallback were issued.
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a genuine not_found from the relay without a pointless base64 retry', async () => {
    const app = makeApp();
    sendFileTransferRequestMock.mockImplementationOnce((_requestId: string, message: unknown) => {
      expect((message as { type: string }).type).toBe(FILE_TRANSFER_MSG.DOWNLOAD_STREAM);
      return Promise.resolve({ type: 'file.download_error', message: 'not_found' });
    });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(404);
    // A genuine missing-handle error must NOT trigger a base64 fallback.
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(1);
  });

  it('returns a small file INLINE (file.download_done over WS) in one round-trip — no relay PUT, no fallback', async () => {
    const app = makeApp();
    // The daemon returns small files inline over the WS RPC instead of streaming
    // through the relay. The server must return those bytes directly — the fast
    // path that makes tiny files instant instead of waiting on the relay.
    sendFileTransferRequestMock.mockImplementationOnce((_requestId: string, message: unknown) => {
      expect((message as { type: string }).type).toBe(FILE_TRANSFER_MSG.DOWNLOAD_STREAM);
      return Promise.resolve({
        type: 'file.download_done',
        content: Buffer.from('hi there').toString('base64'),
        mime: 'text/plain',
        filename: 'note.txt',
      });
    });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('note.txt');
    await expect(res.text()).resolves.toBe('hi there');
    // Exactly one WS call: no relay PUT and no base64 fallback round-trip.
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(1);
  });
});
