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

    it('rejects non-array enabledServerIds with 400', async () => {
      const res = await app.request('/api/push/preferences', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enabledServerIds: 'srv-a',
        }),
      });
      expect(res.status).toBe(400);
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

    it('suppresses server push when push_enabled_server_ids is empty (default)', async () => {
      const mockEnv = {
        DB: mockDb,
        JPUSH_APP_KEY: 'mock-key',
        JPUSH_MASTER_SECRET: 'mock-secret',
      } as any;

      mockDb.query.mockResolvedValueOnce([
        {
          token: 'dev-token-default',
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
      expect(mockDb.query).toHaveBeenCalledTimes(1); // no badge increment

      fetchSpy.mockRestore();
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
});
