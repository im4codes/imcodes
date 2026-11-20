import http from 'node:http';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  DEFAULT_PUSH_ENABLED_SERVER_IDS,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_JPUSH,
  classifyTaskPairNotificationType,
  sanitizePushEnabledServerIds,
  resolveEffectivePushEnabledServerIds,
  isPushEnabledForServer,
  shouldBypassServerPushMute,
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
      expect(json.enabledServerIds).toEqual(DEFAULT_PUSH_ENABLED_SERVER_IDS);
    });

    it('returns empty array when user explicitly configured empty preferences', async () => {
      mockDb.queryOne.mockResolvedValueOnce({
        notification_types: [],
      });

      const res = await app.request('/api/push/preferences', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.types).toEqual([]);
    });

    it('returns saved preferences for the user including enabledServerIds', async () => {
      mockDb.queryOne
        .mockResolvedValueOnce({
          notification_types: ['task_complete', 'task_pair_done', 'remote_desktop'],
        })
        .mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-1', 'srv-2'],
        });

      const res = await app.request('/api/push/preferences', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.types).toEqual(['task_complete', 'task_pair_done', 'remote_desktop']);
      expect(json.enabledServerIds).toEqual(['srv-1', 'srv-2']);
    });

    it('queries by specific token when token query param is provided and still returns enabledServerIds', async () => {
      mockDb.queryOne
        .mockResolvedValueOnce({
          notification_types: ['task_pair_audit'],
        })
        .mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-token-shared'],
        });

      const res = await app.request('/api/push/preferences?token=dev-token-abc', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.types).toEqual(['task_pair_audit']);
      expect(json.enabledServerIds).toEqual(['srv-token-shared']);
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

    it('returns 500 if database update fails', async () => {
      mockDb.execute.mockRejectedValueOnce(new Error('injected DB outage'));

      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          types: ['task_complete'],
        }),
      });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('failed to update push preferences');
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
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $2 AND token = $3'),
        [['task_pair_audit'], 'user-123', 'token-xyz'],
      );
    });

    it('updates enabledServerIds alone without touching notification_types', async () => {
      mockDb.execute.mockResolvedValueOnce({ changes: 1 });

      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabledServerIds: [' srv-a ', '', 'srv-b', 'srv-a', 123],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, enabledServerIds: ['srv-a', 'srv-b'] });
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(mockDb.execute).toHaveBeenCalledWith(
        'UPDATE users SET push_enabled_server_ids = $1 WHERE id = $2',
        [['srv-a', 'srv-b'], 'user-123'],
      );
    });

    it('rejects non-array non-null enabledServerIds with 400 and allows null reset', async () => {
      const badRes = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabledServerIds: 'srv-a',
        }),
      });
      expect(badRes.status).toBe(400);

      mockDb.execute.mockResolvedValueOnce({ changes: 1 });
      const nullRes = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabledServerIds: null,
        }),
      });
      expect(nullRes.status).toBe(200);
      expect(await nullRes.json()).toEqual({ ok: true, enabledServerIds: null });
      expect(mockDb.execute).toHaveBeenCalledWith(
        'UPDATE users SET push_enabled_server_ids = $1 WHERE id = $2',
        [null, 'user-123'],
      );
    });

    it('updates both types and enabledServerIds when both are provided', async () => {
      mockDb.execute.mockResolvedValue({ changes: 1 });

      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          types: ['task_complete'],
          enabledServerIds: ['srv-1'],
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        ok: true,
        types: ['task_complete'],
        enabledServerIds: ['srv-1'],
      });
      expect(mockDb.execute).toHaveBeenCalledTimes(2);
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
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
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

    it('does not dispatch any notifications or increment badge when user explicitly set notification_types to empty array', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-empty',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: [], // explicitly empty
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await dispatchPush(
        {
          userId: 'user-123',
          title: 'Task complete',
          body: 'Task done',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        },
        mockEnv,
      );

      // Even for task_complete, explicitly empty settings must suppress push and badge update
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1); // only SELECT tokens, no UPDATE badge_count

      fetchSpy.mockRestore();
    });

    it('suppresses server push when user explicitly saved empty push_enabled_server_ids [] (even with 1 server)', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-explicit-empty',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          push_enabled_server_ids: [],
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'srv-1',
          title: 'Task complete',
          body: 'Done',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          data: { serverId: 'srv-1' },
        },
        mockEnv,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1); // no extra queries or badge increment

      fetchSpy.mockRestore();
    });

    it('auto-allows 1 accessible server and suppresses >1 servers when push_enabled_server_ids is NULL', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      // 1 accessible server -> NULL auto-allows that single server
      mockDb.query
        .mockResolvedValueOnce([
          {
            token: 'dev-token-null',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
            push_enabled_server_ids: null,
          },
        ])
        .mockResolvedValueOnce([{ id: 'srv-only', node_role: 'full' }]) // getFullServersByUserId ownRows
        .mockResolvedValueOnce([]) // getFullServersByUserId teamRows
        .mockResolvedValueOnce([]) // listAccessibleControlledMachines
        .mockResolvedValueOnce([{ badge_count: 1 }]); // badge_count update

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'srv-only',
          title: 'Single server',
          body: 'Auto enabled',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        },
        mockEnv,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2 accessible servers -> NULL auto-suppresses all servers until manually checked
      mockDb.query
        .mockResolvedValueOnce([
          {
            token: 'dev-token-null',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
            push_enabled_server_ids: null,
          },
        ])
        .mockResolvedValueOnce([
          { id: 'srv-only', node_role: 'full' },
          { id: 'srv-two', node_role: 'full' },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'srv-only',
          title: 'Multi server',
          body: 'Should be suppressed',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        },
        mockEnv,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });

    it('resolves shared effective enabledServerIds rules cleanly', () => {
      expect(resolveEffectivePushEnabledServerIds(null, [])).toEqual([]);
      expect(resolveEffectivePushEnabledServerIds(null, ['srv-1'])).toEqual(['srv-1']);
      expect(resolveEffectivePushEnabledServerIds(null, ['srv-1', 'srv-2'])).toEqual([]);
      expect(resolveEffectivePushEnabledServerIds([], ['srv-1'])).toEqual([]);
      expect(resolveEffectivePushEnabledServerIds(['srv-2'], ['srv-1', 'srv-2'])).toEqual(['srv-2']);
      expect(isPushEnabledForServer(null, 'srv-1', ['srv-1'])).toBe(true);
      expect(isPushEnabledForServer(null, 'srv-1', ['srv-1', 'srv-2'])).toBe(false);
      expect(isPushEnabledForServer([], 'srv-1', ['srv-1'])).toBe(false);
    });

    it('dispatches push for checked server while suppressing unchecked server and ignoring deleted IDs', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      // Server A is allowed (alongside a deleted/unknown server ID)
      mockDb.query
        .mockResolvedValueOnce([
          {
            token: 'dev-token-1',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
            push_enabled_server_ids: ['deleted-srv-99', 'srv-a'],
          },
        ])
        .mockResolvedValueOnce([{ badge_count: 1 }]);

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'srv-a',
          title: 'Server A',
          body: 'Allowed',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          data: { serverId: 'srv-a' },
        },
        mockEnv,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Server B is not in push_enabled_server_ids (only data.serverId provided)
      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-1',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          push_enabled_server_ids: ['deleted-srv-99', 'srv-a'],
        },
      ]);

      await dispatchPush(
        {
          userId: 'user-123',
          title: 'Server B',
          body: 'Suppressed',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          data: { serverId: 'srv-b' },
        },
        mockEnv,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });

    it('sanitizes enabledServerIds cleanly', () => {
      expect(sanitizePushEnabledServerIds(null)).toEqual([]);
      expect(sanitizePushEnabledServerIds(['  srv-1  ', '', 'srv-2', 'srv-1', 42, 'x'.repeat(200)])).toEqual([
        'srv-1',
        'srv-2',
      ]);
    });

    it('shouldBypassServerPushMute returns true only for remote_desktop', () => {
      expect(shouldBypassServerPushMute(PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP)).toBe(true);
      expect(shouldBypassServerPushMute(PUSH_NOTIFICATION_TYPE_TASK_COMPLETE)).toBe(false);
      expect(shouldBypassServerPushMute(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE)).toBe(false);
      expect(shouldBypassServerPushMute(null)).toBe(false);
      expect(shouldBypassServerPushMute(undefined)).toBe(false);
    });

    it('dispatches remote_desktop alerts despite muted/mismatched/multi-server null push_enabled_server_ids while preserving serverId', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      for (const caseCfg of [
        { label: 'explicit empty []', enabled: [] as string[], types: DEFAULT_PUSH_NOTIFICATION_TYPES },
        { label: 'mismatch allowlist', enabled: ['other-srv'], types: [PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP] },
        { label: 'null >1 servers default', enabled: null, types: null },
      ]) {
        mockDb.query.mockReset();
        fetchSpy.mockClear();
        mockDb.query
          .mockResolvedValueOnce([
            {
              token: 'jpush-rd-token',
              platform: PUSH_PLATFORM_ANDROID_JPUSH,
              notification_types: caseCfg.types,
              push_enabled_server_ids: caseCfg.enabled,
            },
          ])
          .mockResolvedValueOnce([{ badge_count: 1 }]);

        await dispatchPush(
          {
            userId: 'user-123',
            serverId: 'muted-srv-1',
            title: 'Remote unlock alert',
            body: 'Unlocked',
            type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
            data: { serverId: 'muted-srv-1', type: 'auto_unlock_succeeded' },
          },
          mockEnv,
        );

        expect(fetchSpy, caseCfg.label).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
        expect(body.notification.android.extras).toEqual({
          serverId: 'muted-srv-1',
          type: 'auto_unlock_succeeded',
        });
        expect(body.notification.android.priority).toBe(2);
      }

      fetchSpy.mockRestore();
    });

    it('suppresses remote_desktop alerts when global notification_types disables remote_desktop (or is [])', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      for (const types of [[PUSH_NOTIFICATION_TYPE_TASK_COMPLETE], [] as string[]]) {
        mockDb.query.mockReset();
        mockDb.query.mockResolvedValueOnce([
          {
            token: 'jpush-rd-disabled',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: types,
            push_enabled_server_ids: [],
          },
        ]);

        await dispatchPush(
          {
            userId: 'user-123',
            serverId: 'muted-srv-1',
            title: 'Remote unlock alert',
            body: 'Should be suppressed globally',
            type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
            data: { serverId: 'muted-srv-1', type: 'auto_unlock_succeeded' },
          },
          mockEnv,
        );

        expect(mockDb.query).toHaveBeenCalledTimes(1); // no badge_count increment
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('filters mixed device tokens by remote_desktop preference even when server is muted, while keeping task_complete suppressed', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      // Mixed tokens on muted server: only token-a enables remote_desktop
      mockDb.query
        .mockResolvedValueOnce([
          {
            token: 'token-a',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
            push_enabled_server_ids: ['other-srv'],
          },
          {
            token: 'token-b',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE],
            push_enabled_server_ids: ['other-srv'],
          },
        ])
        .mockResolvedValueOnce([{ badge_count: 1 }]);

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'muted-srv-1',
          title: 'Remote unlock alert',
          body: 'Only token A',
          type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
          data: { serverId: 'muted-srv-1', type: 'auto_unlock_succeeded' },
        },
        mockEnv,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(sentBody.audience.registration_id).toEqual(['token-a']);

      // Regular non-exempt notification on the exact same muted server stays suppressed
      mockDb.query.mockResolvedValueOnce([
        {
          token: 'token-a',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          push_enabled_server_ids: ['other-srv'],
        },
      ]);

      await dispatchPush(
        {
          userId: 'user-123',
          serverId: 'muted-srv-1',
          title: 'Task complete',
          body: 'Still muted',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          data: { serverId: 'muted-srv-1' },
        },
        mockEnv,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });
  });

  describe('POST /api/push/relay', () => {
    it('relays payload.type and retains priority 2 for remote_desktop', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      const res = await app.request('/api/push/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'jpush-reg-id',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          title: '🚨 [最高安全警示] 远程桌面自动解锁',
          body: 'Auto unlock detected',
          type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
        }),
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse(call[1]!.body as string);
      expect(body.notification.android.priority).toBe(2);

      fetchSpy.mockRestore();
    });

    it('rejects invalid APNs device tokens before constructing HTTP/2 :path', async () => {
      const secretApp = new Hono();
      secretApp.use('/*', async (c, next) => {
        (c as any).env = {
          DB: mockDb,
          APNS_KEY: 'dummy-key',
          APNS_KEY_ID: 'kid-1',
          APNS_TEAM_ID: 'team-1',
        };
        return next();
      });
      secretApp.route('/api/push', pushRoutes);

      for (const badToken of ['../../etc/passwd', 'not-hex-token!', 'abcd', 'a'.repeat(201)]) {
        const res = await secretApp.request('/api/push/relay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: badToken,
            platform: PUSH_PLATFORM_IOS,
            title: 'Test',
            body: 'Hello',
          }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_apns_device_token' });
      }
    });

    it('enforces PUSH_RELAY_SECRET when configured and rate-limits /api/push/relay', async () => {
      const secretApp = new Hono();
      secretApp.use('/*', async (c, next) => {
        (c as any).env = {
          DB: mockDb,
          JPUSH_APP_KEY: 'mock-key',
          JPUSH_MASTER_SECRET: 'mock-secret',
          PUSH_RELAY_SECRET: 'relay-top-secret-token',
        };
        return next();
      });
      secretApp.route('/api/push', pushRoutes);

      const unauthRes = await secretApp.request('/api/push/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'jpush-reg-id',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          title: 'Alert',
          body: 'Test',
        }),
      });
      expect(unauthRes.status).toBe(401);

      const wrongSecretRes = await secretApp.request('/api/push/relay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-secret',
        },
        body: JSON.stringify({
          token: 'jpush-reg-id',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          title: 'Alert',
          body: 'Test',
        }),
      });
      expect(wrongSecretRes.status).toBe(401);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );
      try {
        const okRes = await secretApp.request('/api/push/relay', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer relay-top-secret-token',
          },
          body: JSON.stringify({
            token: 'jpush-reg-id',
            platform: PUSH_PLATFORM_ANDROID_JPUSH,
            title: 'Alert',
            body: 'Test',
          }),
        });
        expect(okRes.status).toBe(200);

        // Exhaust remaining per-IP relay rate limit budget -> 429
        let hitLimit = false;
        for (let i = 0; i < 65; i += 1) {
          const r = await secretApp.request('/api/push/relay', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer relay-top-secret-token',
            },
            body: JSON.stringify({
              token: 'jpush-reg-id',
              platform: PUSH_PLATFORM_ANDROID_JPUSH,
              title: 'Alert',
              body: 'Test',
            }),
          });
          if (r.status === 429) {
            hitLimit = true;
            break;
          }
          expect(r.status).toBe(200);
        }
        expect(hitLimit).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('classifyTaskPairNotificationType', () => {
    it('returns task_pair_done for valid completion transition', () => {
      expect(classifyTaskPairNotificationType({ toStatus: 'done', fromStatus: 'passed' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE);
      expect(classifyTaskPairNotificationType({ verb: 'DONE', effect: 'status', toStatus: 'done', fromStatus: 'passed' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE);
    });

    it('rejects invalid or rejected DONE (unusual=true)', () => {
      expect(classifyTaskPairNotificationType({ verb: 'DONE', unusual: true, toStatus: 'working' })).toBeNull();
      expect(classifyTaskPairNotificationType({ verb: 'DONE', effect: 'rejected', unusual: true })).toBeNull();
    });

    it('rejects redundant metadata/notice events when already in done', () => {
      expect(classifyTaskPairNotificationType({ toStatus: 'done', fromStatus: 'done' })).toBeNull();
    });

    it('returns task_pair_paused for manual pause or awaiting decision', () => {
      expect(classifyTaskPairNotificationType({ verb: 'PAUSE', effect: 'scheduled' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED);
      expect(classifyTaskPairNotificationType({ scheduling: { manual: true, epoch: 2 } })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED);
      expect(classifyTaskPairNotificationType({ toStatus: 'awaiting_brain_decision', fromStatus: 'working' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED);
      expect(classifyTaskPairNotificationType({ verb: 'NEEDS_DECISION' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_PAUSED);
    });

    it('returns task_pair_audit for intermediate audit states', () => {
      expect(classifyTaskPairNotificationType({ verb: 'READY_FOR_AUDIT', toStatus: 'in_audit', fromStatus: 'working' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT);
      expect(classifyTaskPairNotificationType({ verb: 'PASS', toStatus: 'passed', fromStatus: 'in_audit' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT);
      expect(classifyTaskPairNotificationType({ verb: 'REWORK', toStatus: 'rework', fromStatus: 'in_audit' })).toBe(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT);
    });

    it('rejects duplicate or no-op audit events', () => {
      expect(classifyTaskPairNotificationType({ verb: 'READY_FOR_AUDIT', effect: 'duplicate_ready' })).toBeNull();
      expect(classifyTaskPairNotificationType({ effect: 'in_audit_guarded' })).toBeNull();
    });
  });

  describe('WsBridge task pair push deduplication and multi-session suppression', () => {
    it('dispatches only once when multiple copies of the same event arrive from executor, auditor, and brain', async () => {
      const { WsBridge } = await import('../src/ws/bridge.js');
      const bridge = WsBridge.get('test-server-id');

      // Mock server lookup
      mockDb.queryOne.mockResolvedValue({
        id: 'test-server-id',
        name: 'test-machine',
        user_id: 'user-123',
      });

      // Mock token query and badge update
      mockDb.query.mockResolvedValue([
        {
          token: 'dev-token',
          platform: PUSH_PLATFORM_ANDROID_JPUSH,
          notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          push_enabled_server_ids: ['test-server-id'],
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sendno: '1', msg_id: '123' }), { status: 200 }),
      );

      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const pausePayload = {
        taskId: 'tsk_pause_test',
        verb: 'PAUSE',
        effect: 'scheduled',
        scheduling: { manual: true, epoch: 1 },
        title: 'Task Pause Test',
        round: 1,
      };

      // 1st copy (executor)
      await (bridge as any).dispatchTaskPairPush(mockDb, mockEnv, 'executor-session', pausePayload);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2nd copy (auditor)
      await (bridge as any).dispatchTaskPairPush(mockDb, mockEnv, 'auditor-session', pausePayload);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // STILL 1, suppressed!

      // 3rd copy (brain)
      await (bridge as any).dispatchTaskPairPush(mockDb, mockEnv, 'brain-session', pausePayload);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // STILL 1, suppressed!

      fetchSpy.mockRestore();
    });

    it('does not dispatch for premature unusual DONE markers', async () => {
      const { WsBridge } = await import('../src/ws/bridge.js');
      const bridge = WsBridge.get('test-server-id-2');

      mockDb.queryOne.mockResolvedValue({
        id: 'test-server-id-2',
        name: 'test-machine',
        user_id: 'user-123',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      const invalidDonePayload = {
        taskId: 'tsk_invalid_done',
        verb: 'DONE',
        effect: 'rejected',
        unusual: true,
        toStatus: 'working',
        round: 1,
      };

      await (bridge as any).dispatchTaskPairPush(mockDb, mockEnv, 'executor-session', invalidDonePayload);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('PC-only / desktop notification sync and dispatchPush fallback', () => {
    it('reads and persists notification types on users for PC-only users without push_tokens and seeds newly registered tokens', async () => {
      mockDb.queryOne
        .mockResolvedValueOnce(null) // no push_tokens row
        .mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-pc-1'],
          push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT],
        });

      const getRes = await app.request('/api/push/preferences', {
        headers: { Authorization: 'Bearer valid-user-token' },
      });
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual({
        ok: true,
        types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT],
        defaultTypes: DEFAULT_PUSH_NOTIFICATION_TYPES,
        enabledServerIds: ['srv-pc-1'],
      });

      mockDb.execute.mockResolvedValue({ changes: 1 });
      const postRes = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          types: [PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
        }),
      });
      expect(postRes.status).toBe(200);
      expect(mockDb.execute).toHaveBeenCalledWith(
        'UPDATE users SET push_notification_types = $1 WHERE id = $2',
        [[PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP], 'user-123'],
      );

      // New iOS token registration without explicit notificationTypes inherits users.push_notification_types
      mockDb.execute.mockClear();
      mockDb.queryOne.mockResolvedValueOnce({
        push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
      });
      mockDb.execute.mockResolvedValueOnce({ rowCount: 1 });
      const regRes = await app.request('/api/push/register', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: 'ios-synced-token',
          platform: PUSH_PLATFORM_IOS,
        }),
      });
      expect(regRes.status).toBe(200);
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO push_tokens'),
        expect.arrayContaining([
          'user-123',
          'ios-synced-token',
          PUSH_PLATFORM_IOS,
          [PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
        ]),
      );
    });

    it('emits desktop notification via globalTaskHub when push_tokens is empty without incrementing badge_count, and honors mutes & inactive users', async () => {
      const { globalTaskHub } = await import('../src/services/global-task-hub.js');
      const notifySpy = vi.spyOn(globalTaskHub, 'notifyPushNotification').mockResolvedValue();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const mockEnv = { DB: mockDb } as any;

      try {
        // 1. Active PC-only user with srv-pc-1 allowed -> emits desktop notification, no badge increment, no mobile fetch
        mockDb.query.mockResolvedValueOnce([]); // no push_tokens
        mockDb.queryOne.mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-pc-1'],
          push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
        });
        await dispatchPush({
          userId: 'user-pc-1',
          serverId: 'srv-pc-1',
          title: 'PC Machine · proj',
          body: 'Build complete',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          eventId: 'evt-pc-1',
          data: { serverId: 'srv-pc-1', session: 'deck_proj_brain', type: 'session.idle' },
        }, mockEnv);
        expect(notifySpy).toHaveBeenCalledTimes(1);
        expect(notifySpy).toHaveBeenCalledWith(mockDb, expect.objectContaining({
          userId: 'user-pc-1',
          eventId: 'evt-pc-1',
          serverId: 'srv-pc-1',
          session: 'deck_proj_brain',
          notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        }));
        expect(fetchSpy).not.toHaveBeenCalled();

        // 2. Muted server suppresses task_complete, but remote_desktop bypasses server mute
        notifySpy.mockClear();
        mockDb.query.mockResolvedValueOnce([]);
        mockDb.queryOne.mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-pc-1'],
          push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
        });
        await dispatchPush({
          userId: 'user-pc-1',
          serverId: 'srv-muted',
          title: 'Muted Server',
          body: 'Should not fire',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        }, mockEnv);
        expect(notifySpy).not.toHaveBeenCalled();

        mockDb.query.mockResolvedValueOnce([]);
        mockDb.queryOne.mockResolvedValueOnce({
          push_enabled_server_ids: ['srv-pc-1'],
          push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP],
        });
        await dispatchPush({
          userId: 'user-pc-1',
          serverId: 'srv-muted',
          title: 'Security Alert',
          body: 'Auto unlock',
          type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
          eventId: 'evt-rd-1',
        }, mockEnv);
        expect(notifySpy).toHaveBeenCalledTimes(1);

        // 3. Disabled / non-existent user receives zero desktop notifications
        notifySpy.mockClear();
        mockDb.query.mockResolvedValueOnce([]);
        mockDb.queryOne.mockResolvedValueOnce(null);
        await dispatchPush({
          userId: 'user-disabled',
          serverId: 'srv-pc-1',
          title: 'Should drop',
          body: 'Disabled user',
          type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
        }, mockEnv);
        expect(notifySpy).not.toHaveBeenCalled();

        // 4. suppressMobilePush still delivers desktop notification without incrementing badge_count or calling mobile providers
        notifySpy.mockClear();
        mockDb.query.mockClear();
        mockDb.query.mockResolvedValueOnce([
          {
            token: 'ios-tok-1',
            platform: PUSH_PLATFORM_IOS,
            notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
            push_enabled_server_ids: ['srv-pc-1'],
            push_notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          },
        ]);
        await dispatchPush({
          userId: 'user-both',
          serverId: 'srv-pc-1',
          title: 'Both Active',
          body: 'Mobile open + PC open',
          type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          suppressMobilePush: true,
        }, mockEnv);
        expect(notifySpy).toHaveBeenCalledTimes(1);
        expect(mockDb.query).toHaveBeenCalledTimes(1); // only initial token select, no badge_count UPDATE
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        notifySpy.mockRestore();
        fetchSpy.mockRestore();
      }
    });

    it('P0-4: sends PUSH_RELAY_CLIENT_SECRET with redirect:error to explicitly configured PUSH_RELAY_URL, authenticates end-to-end against POST /api/push/relay, and never leaks secret to default app.im.codes', async () => {
      const relayApp = new Hono();
      relayApp.use('/*', async (c, next) => {
        (c as any).set('clientIp', '203.0.113.44');
        (c as any).env = {
          DB: mockDb,
          PUSH_RELAY_SECRET: 'shared-relay-secret-v1',
          JPUSH_APP_KEY: 'relay-jpush-key',
          JPUSH_MASTER_SECRET: 'relay-jpush-secret',
        };
        return next();
      });
      relayApp.route('/api/push', pushRoutes);

      const seenCalls: Array<{ url: string; auth: string | null; redirect: string | undefined; relayStatus?: number }> = [];
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const auth = headers.get('Authorization');
        if (url === 'https://relay.example.test/api/push/relay') {
          const relayRes = await relayApp.request('/api/push/relay', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(auth ? { Authorization: auth } : {}),
            },
            body: typeof init?.body === 'string' ? init.body : undefined,
          });
          seenCalls.push({ url, auth, redirect: init?.redirect, relayStatus: relayRes.status });
          return relayRes;
        }
        if (url.includes('api.jpush.cn')) {
          return new Response(JSON.stringify({ sendno: '1', msg_id: 'ok-1' }), { status: 200 });
        }
        seenCalls.push({ url, auth, redirect: init?.redirect });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const validPushRow = {
        token: 'jpush-reg-end2end-1',
        platform: PUSH_PLATFORM_ANDROID_JPUSH,
        notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
        push_enabled_server_ids: ['srv-relay-1'],
        push_notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
      };

      try {
        // 1. Matching PUSH_RELAY_CLIENT_SECRET authenticates cleanly against PUSH_RELAY_SECRET
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 1 }]);
        await dispatchPush(
          { userId: 'u-relay', serverId: 'srv-relay-1', title: 'Hi', body: 'Matched', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_URL: 'https://relay.example.test/',
            PUSH_RELAY_CLIENT_SECRET: 'shared-relay-secret-v1',
          } as any,
        );
        expect(seenCalls[0]).toMatchObject({
          url: 'https://relay.example.test/api/push/relay',
          auth: 'Bearer shared-relay-secret-v1',
          redirect: 'error',
          relayStatus: 200,
        });

        // 2. Mismatched PUSH_RELAY_CLIENT_SECRET is rejected (401) by relay endpoint
        seenCalls.length = 0;
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 2 }]);
        await dispatchPush(
          { userId: 'u-relay', serverId: 'srv-relay-1', title: 'Hi', body: 'Mismatch', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_URL: 'https://relay.example.test',
            PUSH_RELAY_CLIENT_SECRET: 'wrong-secret',
          } as any,
        );
        expect(seenCalls[0]).toMatchObject({
          url: 'https://relay.example.test/api/push/relay',
          auth: 'Bearer wrong-secret',
          redirect: 'error',
          relayStatus: 401,
        });

        // 3. Default relay destination (PUSH_RELAY_URL unset) NEVER receives PUSH_RELAY_CLIENT_SECRET
        seenCalls.length = 0;
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 3 }]);
        await dispatchPush(
          { userId: 'u-relay', serverId: 'srv-relay-1', title: 'Hi', body: 'Default', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_CLIENT_SECRET: 'should-never-leave-host',
          } as any,
        );
        expect(seenCalls[0]).toMatchObject({
          url: 'https://app.im.codes/api/push/relay',
          auth: null,
          redirect: undefined,
        });
      } finally {
        fetchSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });

    it('P0-4 redirect compat: keyless relay follows 307/308 POST redirects while authenticated PUSH_RELAY_CLIENT_SECRET refuses redirects before leaking credentials', async () => {
      const targetRequests: Array<{ url?: string; auth?: string; body: string }> = [];
      const targetServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          targetRequests.push({
            url: req.url,
            auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()));
      const targetPort = (targetServer.address() as { port: number }).port;

      let redirectStatus = 308;
      const redirectServer = http.createServer((_req, res) => {
        res.statusCode = redirectStatus;
        res.setHeader('Location', `http://127.0.0.1:${targetPort}/api/push/relay`);
        res.end();
      });
      await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', () => resolve()));
      const redirectPort = (redirectServer.address() as { port: number }).port;

      const validPushRow = {
        token: 'jpush-redirect-test-1',
        platform: PUSH_PLATFORM_ANDROID_JPUSH,
        notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
        push_enabled_server_ids: ['srv-redir-1'],
        push_notification_types: DEFAULT_PUSH_NOTIFICATION_TYPES,
      };

      try {
        // 1. Keyless relay (no PUSH_RELAY_CLIENT_SECRET) follows 308/307 POST redirects
        redirectStatus = 308;
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 1 }]);
        await dispatchPush(
          { userId: 'u-redir', serverId: 'srv-redir-1', title: 'R308', body: 'Keyless', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_URL: `http://127.0.0.1:${redirectPort}`,
          } as any,
        );
        expect(targetRequests).toHaveLength(1);
        expect(targetRequests[0]?.auth).toBeUndefined();

        redirectStatus = 307;
        targetRequests.length = 0;
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 2 }]);
        await dispatchPush(
          { userId: 'u-redir', serverId: 'srv-redir-1', title: 'R307', body: 'Keyless', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_URL: `http://127.0.0.1:${redirectPort}`,
          } as any,
        );
        expect(targetRequests).toHaveLength(1);
        expect(targetRequests[0]?.auth).toBeUndefined();

        // 2. Authenticated relay (PUSH_RELAY_CLIENT_SECRET set) refuses 307/308 redirects BEFORE contacting target
        targetRequests.length = 0;
        mockDb.query.mockResolvedValueOnce([validPushRow]);
        mockDb.query.mockResolvedValueOnce([{ badge_count: 3 }]);
        await dispatchPush(
          { userId: 'u-redir', serverId: 'srv-redir-1', title: 'SecretR308', body: 'Blocked', type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE },
          {
            DB: mockDb as any,
            PUSH_RELAY_URL: `http://127.0.0.1:${redirectPort}`,
            PUSH_RELAY_CLIENT_SECRET: 'do-not-leak-on-redirect',
          } as any,
        );
        expect(targetRequests).toHaveLength(0);
      } finally {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
        await new Promise<void>((resolve) => targetServer.close(() => resolve()));
      }
    });
  });
});
