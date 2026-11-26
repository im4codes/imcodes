import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { PushError, resetFcmAuthCacheForTesting, sendFcm, type PushPayload } from '../src/routes/push.js';

const payload: PushPayload = {
  userId: 'user-1',
  title: 'Build complete',
  body: 'The task is ready',
  data: { count: '3', optional: undefined as unknown as string },
};

let privateKeyPem = '';
let serviceAccount = '';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(pair.privateKey);
  serviceAccount = JSON.stringify({
    project_id: 'demo-project',
    client_email: 'push@demo-project.iam.gserviceaccount.com',
    private_key: privateKeyPem.replace(/\n/g, '\\n'),
  });
});

beforeEach(() => {
  resetFcmAuthCacheForTesting();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FCM HTTP v1', () => {
  it('exchanges a service-account JWT and sends a string-only HTTP v1 message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: 'access-1', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, {}));

    await sendFcm('device-1', payload, serviceAccount);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect((tokenInit as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    expect((sendInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer access-1' });
    const body = JSON.parse(String((sendInit as RequestInit).body));
    expect(body.message).toMatchObject({
      token: 'device-1',
      notification: { title: payload.title, body: payload.body },
      android: { priority: 'HIGH', notification: { sound: 'default' } },
      data: { count: '3' },
    });
    expect(body.message.data.optional).toBeUndefined();
  });

  it('accepts base64 service-account JSON and merges concurrent token requests', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: 'shared-access', expires_in: 3600 }))
      .mockResolvedValue(response(200, {}));
    const encoded = Buffer.from(serviceAccount).toString('base64');

    await Promise.all([
      sendFcm('device-a', payload, encoded, 'override-project'),
      sendFcm('device-b', payload, encoded, 'override-project'),
    ]);

    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/projects/override-project/messages:send'))).toHaveLength(2);
  });

  it('invalidates the cached token and retries once on FCM 401', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: 'expired', expires_in: 3600 }))
      .mockResolvedValueOnce(response(401, { error: { status: 'UNAUTHENTICATED' } }))
      .mockResolvedValueOnce(response(200, { access_token: 'fresh', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, {}));

    await sendFcm('device-1', payload, serviceAccount);

    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(2);
    expect((fetchMock.mock.calls[3][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });

  it('marks only confirmed unregistered devices as dead tokens', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: 'access-1', expires_in: 3600 }))
      .mockResolvedValueOnce(response(410, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
    await expect(sendFcm('dead-device', payload, serviceAccount)).rejects.toMatchObject({ unregistered: true });
    expect(await fetchMock.mock.calls[1][1]).toBeTruthy();

    resetFcmAuthCacheForTesting();
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: 'access-2', expires_in: 3600 }))
      .mockResolvedValueOnce(response(400, { error: { status: 'INVALID_ARGUMENT' } }));
    await expect(sendFcm('valid-device', payload, serviceAccount)).rejects.toMatchObject({ unregistered: false });
  });

  it('fails safely for malformed service-account configuration', async () => {
    await expect(sendFcm('device-1', payload, '{not-json}')).rejects.toThrow('not valid JSON');
    await expect(sendFcm('device-1', payload, JSON.stringify({ project_id: 'only-project' }))).rejects.toThrow('requires project_id');
  });
});

expect(PushError).toBeDefined();
