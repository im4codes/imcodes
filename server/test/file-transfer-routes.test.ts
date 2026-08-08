import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  FILE_TRANSFER_LIMITS,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
  FILE_TRANSFER_PATH_MAX_BYTES,
  FILE_TRANSFER_MSG,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
} from '../../shared/transport/file-transfer.js';
import { DIRECT_FILE_TRANSFER_CAPABILITY } from '../../shared/direct-file-transfer.js';
import {
  MACHINE_DIRECT_FILE_TRANSFER_CAPABILITY,
  MACHINE_DIRECT_FILE_FETCH_CAPABILITY,
  MACHINE_DIRECT_FILE_TRANSFER_LIMITS,
  MACHINE_DIRECT_FILE_TRANSFER_MSG,
} from '../../shared/machine-direct-file-transfer.js';

const { sendFileTransferRequestMock, isDaemonConnectedMock, hasDaemonCapabilityMock, daemonConnectionGenerationMock, mockResolveServerMemberAccessOrShareDeny, mockResolveHttpShareAccessForCoveredSession, queryOneMock } = vi.hoisted(() => ({
  sendFileTransferRequestMock: vi.fn(),
  isDaemonConnectedMock: vi.fn(),
  hasDaemonCapabilityMock: vi.fn(),
  daemonConnectionGenerationMock: vi.fn(),
  mockResolveServerMemberAccessOrShareDeny: vi.fn(),
  mockResolveHttpShareAccessForCoveredSession: vi.fn(),
  queryOneMock: vi.fn(),
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
      DB: { queryOne: queryOneMock },
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'full', exec_enabled: true, revoked_at: null });
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

  it('mints an explicit-path handle only for a FULL source and capable controlled target', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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

  it('singlecasts bounded machine-direct control without receiving file bytes', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
    const request = {
      type: MACHINE_DIRECT_FILE_TRANSFER_MSG.REQUEST,
      requestId: 'r'.repeat(32), clientUploadId: 'c'.repeat(32), capability: 'A'.repeat(43),
      candidates: [{ host: '8.8.8.8', port: 53 }], originalName: 'x', size: 1, expiresAt: Date.now() + 10_000,
    };
    const browser = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer browser', 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(browser.status).toBe(403);
    queryOneMock.mockResolvedValue({ user_id: 'other-user', node_role: 'controlled', exec_enabled: true, revoked_at: null });
    const crossAccount = await makeApp().request('/api/server/controlled-1/machine-direct-upload', {
      method: 'POST', headers: { Authorization: 'Bearer source', 'X-Server-Id': 'full-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, candidates: [{ host: '192.168.2.145', port: 1234 }] }),
    });
    expect(crossAccount.status).toBe(403);
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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

  it('denies controlled-node file access from browser-style auth before dispatch', async () => {
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
    const res = await makeApp().request('/api/server/controlled-1/machine-file-handle', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/report.txt' }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'scoped_auth' });
    expect(sendFileTransferRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-account', { user_id: 'other', node_role: 'controlled', exec_enabled: true, revoked_at: null }, true, true, 403, 'target_forbidden'],
    ['revoked', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: 1 }, true, true, 403, 'target_forbidden'],
    ['disabled', { user_id: 'user-1', node_role: 'controlled', exec_enabled: false, revoked_at: null }, true, true, 403, 'exec_disabled'],
    ['offline', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null }, false, true, 503, 'daemon_offline'],
    ['missing capability', { user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null }, true, false, 409, 'capability_unavailable'],
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
    queryOneMock.mockResolvedValue({ user_id: 'user-1', node_role: 'controlled', exec_enabled: true, revoked_at: null });
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
      originalName: 'hello.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: expect.stringContaining('/api/server/srv-1/upload-staged/'),
      clientUploadId: 'client_upload_1234',
    }));
    expect(sendFileTransferRequestMock.mock.calls[0]?.[2]).toBe(FILE_TRANSFER_LIMITS.UPLOAD_TIMEOUT_MS);
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY);
    expect(sendFileTransferRequestMock.mock.calls[0]?.[1]).not.toHaveProperty('content');
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
    expect(hasDaemonCapabilityMock).toHaveBeenCalledWith(DIRECT_FILE_TRANSFER_CAPABILITY);
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
    queryOneMock.mockReset().mockResolvedValue({ user_id: 'user-1', node_role: 'full', exec_enabled: true, revoked_at: null });
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
