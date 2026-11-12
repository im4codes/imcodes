import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_JPUSH,
} from '../../shared/push-notifications.js';

const mockDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (authHeader === 'Bearer valid-user-token') {
      c.set('userId', 'user-123');
      c.set('role', 'user');
      return next();
    }
    return c.json({ error: 'unauthorized' }, 401);
  },
}));

import { pushRoutes, dispatchPush } from '../src/routes/push.js';

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = {
    DB: mockDb,
    JPUSH_APP_KEY: 'mock-key',
    JPUSH_MASTER_SECRET: 'mock-secret',
  };
  return next();
});
app.route('/api/push', pushRoutes);

describe('push preferences and registration routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/push/preferences', () => {
    it('returns 401 if unauthenticated', async () => {
      const res = await app.request('/api/push/preferences');
      expect(res.status).toBe(401);
    });

    it('returns default notification types when no preferences stored in DB', async () => {
      mockDb.queryOne.mockResolvedValueOnce(null);

      const res = await app.request('/api/push/preferences', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.types).toEqual(DEFAULT_PUSH_NOTIFICATION_TYPES);
      expect(json.defaultTypes).toEqual(DEFAULT_PUSH_NOTIFICATION_TYPES);
    });

    it('returns saved preferences for the user', async () => {
      mockDb.queryOne.mockResolvedValueOnce({
        notification_types: ['task_complete', 'task_pair_done', 'remote_desktop'],
      });

      const res = await app.request('/api/push/preferences', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.types).toEqual(['task_complete', 'task_pair_done', 'remote_desktop']);
    });

    it('queries by specific token when token query param is provided', async () => {
      mockDb.queryOne.mockResolvedValueOnce({
        notification_types: ['task_pair_audit'],
      });

      const res = await app.request('/api/push/preferences?token=dev-token-abc', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.types).toEqual(['task_pair_audit']);
      expect(mockDb.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $1 AND token = $2'),
        ['user-123', 'dev-token-abc'],
      );
    });
  });

  describe('POST /api/push/preferences', () => {
    it('returns 401 if unauthenticated', async () => {
      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: ['task_complete'] }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 if types is missing or not an array', async () => {
      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notTypes: true }),
      });
      expect(res.status).toBe(400);
    });

    it('sanitizes notification types and updates all tokens for the user when token is omitted', async () => {
      mockDb.execute.mockResolvedValueOnce({ rowCount: 2 });

      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          types: ['task_complete', 'invalid_hack', 'task_pair_paused', 'remote_desktop'],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.types).toEqual(['task_complete', 'task_pair_paused', 'remote_desktop']);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE push_tokens SET notification_types = $1 WHERE user_id = $2'),
        [['task_complete', 'task_pair_paused', 'remote_desktop'], 'user-123'],
      );
    });

    it('updates specific token when token is provided', async () => {
      mockDb.execute.mockResolvedValueOnce({ rowCount: 1 });

      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'token-xyz',
          types: ['task_pair_audit'],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $2 AND token = $3'),
        [['task_pair_audit'], 'user-123', 'token-xyz'],
      );
    });
  });

  describe('POST /api/push/register', () => {
    it('accepts explicit notificationTypes and persists them', async () => {
      mockDb.execute.mockResolvedValueOnce({ rowCount: 1 });

      const res = await app.request('/api/push/register', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'ios-device-token-1',
          platform: PUSH_PLATFORM_IOS,
          notificationTypes: ['task_complete', 'remote_desktop'],
        }),
      });
      expect(res.status).toBe(200);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO push_tokens'),
        expect.arrayContaining(['user-123', 'ios-device-token-1', PUSH_PLATFORM_IOS, ['task_complete', 'remote_desktop']]),
      );
    });

    it('defaults notificationTypes to DEFAULT_PUSH_NOTIFICATION_TYPES when omitted', async () => {
      mockDb.execute.mockResolvedValueOnce({ rowCount: 1 });

      const res = await app.request('/api/push/register', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'ios-device-token-2',
          platform: PUSH_PLATFORM_IOS,
        }),
      });
      expect(res.status).toBe(200);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO push_tokens'),
        expect.arrayContaining(['user-123', 'ios-device-token-2', PUSH_PLATFORM_IOS, DEFAULT_PUSH_NOTIFICATION_TYPES]),
      );
    });
  });

  describe('dispatchPush category filtering', () => {
    it('filters out devices whose notification_types do not include payload.type', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      // Two devices: device A has default types (no audit); device B has audit enabled
      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-default',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
        },
        {
          token: 'dev-token-audit',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: ['task_pair_audit'],
        },
      ]);
      // Mock badge update
      mockDb.query.mockResolvedValueOnce([{ badge_count: 5 }]);

      // Mock global fetch for JPush
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      // Dispatch audit notification
      await dispatchPush(
        {
          userId: 'user-123',
          title: 'Audit event',
          body: 'Task in audit',
          type: PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
        },
        mockEnv,
      );

      // Only dev-token-audit should have received the push
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);
      expect(body.audience.registration_id).toEqual(['dev-token-audit']);

      fetchSpy.mockRestore();
    });

    it('does not increment badge or send push if no devices match the category', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-default',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES, // no task_pair_audit
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await dispatchPush(
        {
          userId: 'user-123',
          title: 'Audit event',
          body: 'Task in audit',
          type: PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
        },
        mockEnv,
      );

      // fetch should NOT be called, and badge count query should NOT be run
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1); // only the SELECT tokens query, no UPDATE badge_count query

      fetchSpy.mockRestore();
    });
  });
});
