/**
 * Unit tests for sendJpush() — pure HTTP request shape / error code handling.
 * Mocks global fetch; no DB required. Covers:
 *   - URL, Basic auth header, JSON body structure
 *   - badge_set_num + badge_class emitted when payload.badge is set
 *   - JPush error codes 1003 / 1011 / 1020 → unregistered=true
 *   - Other 4xx/5xx and code 2002 quota errors → unregistered=false
 *
 * Integration coverage for dispatchPush (DB token lookup + dead-token deletion)
 * is added to push-notification.integration.test.ts in a follow-up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendJpush, JPUSH_API_URL } from '../src/routes/push.js';

function mockFetchOnce(status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(text, { status, headers: { 'content-type': 'application/json' } }),
  );
}

describe('sendJpush', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('request shape', () => {
    beforeEach(() => {
      mockFetchOnce(200, { sendno: '0', msg_id: 'mid-1' });
    });

    it('POSTs to JPush v3 push API with Basic auth derived from appKey:masterSecret', async () => {
      await sendJpush(
        'reg_id_abc',
        { userId: 'u1', title: 'Hi', body: 'You have a message', data: { sessionId: 's1' } },
        'appkey-XYZ',
        'master-SECRET-123',
      );

      const fetchMock = vi.mocked(global.fetch);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(JPUSH_API_URL);
      expect(init?.method).toBe('POST');

      const headers = init?.headers as Record<string, string>;
      const expectedAuth = 'Basic ' + Buffer.from('appkey-XYZ:master-SECRET-123').toString('base64');
      expect(headers.Authorization).toBe(expectedAuth);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends a v3-push body with android platform, registration_id audience, and notification fields', async () => {
      await sendJpush(
        'reg_id_abc',
        { userId: 'u1', title: 'Title', body: 'Body text', data: { k: 'v' } },
        'k',
        's',
      );

      const init = vi.mocked(global.fetch).mock.calls[0][1]!;
      const parsed = JSON.parse(init.body as string);
      expect(parsed).toMatchObject({
        platform: ['android'],
        audience: { registration_id: ['reg_id_abc'] },
        notification: {
          android: {
            title: 'Title',
            alert: 'Body text',
            extras: { k: 'v' },
            priority: 2,
            category: 'msg',
          },
        },
        options: { time_to_live: 86400 },
      });
    });

    it('emits badge_set_num + badge_class when payload.badge is provided', async () => {
      await sendJpush('rid', { userId: 'u', title: 't', body: 'b', badge: 7 }, 'k', 's');
      const init = vi.mocked(global.fetch).mock.calls[0][1]!;
      const parsed = JSON.parse(init.body as string);
      expect(parsed.notification.android.badge_set_num).toBe(7);
      expect(typeof parsed.notification.android.badge_class).toBe('string');
    });

    it('omits badge fields entirely when payload.badge is undefined', async () => {
      await sendJpush('rid', { userId: 'u', title: 't', body: 'b' }, 'k', 's');
      const init = vi.mocked(global.fetch).mock.calls[0][1]!;
      const parsed = JSON.parse(init.body as string);
      expect(parsed.notification.android).not.toHaveProperty('badge_set_num');
      expect(parsed.notification.android).not.toHaveProperty('badge_class');
    });

    it('defaults extras to {} when payload.data is absent', async () => {
      await sendJpush('rid', { userId: 'u', title: 't', body: 'b' }, 'k', 's');
      const init = vi.mocked(global.fetch).mock.calls[0][1]!;
      const parsed = JSON.parse(init.body as string);
      expect(parsed.notification.android.extras).toEqual({});
    });
  });

  describe('error handling', () => {
    it.each([
      [1003, 'invalid registration_id format'],
      [1011, 'no valid users'],
      [1020, 'registration_id does not exist'],
    ])('marks unregistered=true on JPush code %i (%s)', async (code, label) => {
      mockFetchOnce(400, { error: { code, message: label } });
      const err = await sendJpush('bad', { userId: 'u', title: 't', body: 'b' }, 'k', 's').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { unregistered?: boolean }).unregistered).toBe(true);
      expect((err as Error).message).toContain(`code=${code}`);
    });

    it('marks unregistered=false on quota-exceeded code 2002', async () => {
      mockFetchOnce(429, { error: { code: 2002, message: 'quota exceeded' } });
      const err = await sendJpush('rid', { userId: 'u', title: 't', body: 'b' }, 'k', 's').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { unregistered?: boolean }).unregistered).toBe(false);
    });

    it('marks unregistered=false on 5xx upstream failure', async () => {
      mockFetchOnce(502, 'upstream timeout');
      const err = await sendJpush('rid', { userId: 'u', title: 't', body: 'b' }, 'k', 's').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { unregistered?: boolean }).unregistered).toBe(false);
      expect((err as Error).message).toContain('JPush 502');
    });

    it('marks unregistered=false on non-JSON error body', async () => {
      mockFetchOnce(500, '<html>nginx 500</html>');
      const err = await sendJpush('rid', { userId: 'u', title: 't', body: 'b' }, 'k', 's').catch((e) => e);
      expect((err as { unregistered?: boolean }).unregistered).toBe(false);
    });
  });
});
