import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { FILE_TRANSFER_LIMITS } from '../../shared/transport/file-transfer.js';

const { sendFileTransferRequestMock, isDaemonConnectedMock } = vi.hoisted(() => ({
  sendFileTransferRequestMock: vi.fn(),
  isDaemonConnectedMock: vi.fn(),
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
    }),
  },
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
    isDaemonConnectedMock.mockReturnValue(true);
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

  it('relays a valid legacy upload with base64 content', async () => {
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
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'file.upload',
        originalName: 'hello.txt',
        mime: 'text/plain',
        size: 5,
        content: Buffer.from('hello').toString('base64'),
      }),
      FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS,
    );
  });
});
