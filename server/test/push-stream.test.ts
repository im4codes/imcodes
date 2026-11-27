import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
} from '../../shared/push-notifications.js';

const mockDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (authHeader === 'Bearer valid-user-1') {
      c.set('userId', 'user-1');
      c.set('role', 'owner');
      return next();
    }
    if (authHeader === 'Bearer valid-user-2') {
      c.set('userId', 'user-2');
      c.set('role', 'owner');
      return next();
    }
    return c.json({ error: 'unauthorized' }, 401);
  },
}));

const { notifyPushNotificationMock } = vi.hoisted(() => ({
  notifyPushNotificationMock: vi.fn(async () => {}),
}));

vi.mock('../src/services/global-task-hub.js', () => ({
  globalTaskHub: {
    notifyPushNotification: notifyPushNotificationMock,
  },
}));

import { dispatchPush, pushRoutes } from '../src/routes/push.js';
import { MAX_PUSH_STREAMS_PER_USER, pushStreamHub } from '../src/services/push-stream-hub.js';

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = {
    DB: mockDb,
  };
  return next();
});
app.route('/api/push', pushRoutes);

describe('GET /api/push/stream and pushStreamHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushStreamHub.stop();
  });

  afterEach(() => {
    pushStreamHub.stop();
    vi.useRealTimers();
  });

  it('rejects unauthenticated requests with 401 and disabled users with 403', async () => {
    const unauth = await app.request('/api/push/stream');
    expect(unauth.status).toBe(401);

    mockDb.queryOne.mockResolvedValueOnce({ status: 'disabled', sessions_valid_after: 0 });
    const disabled = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1' },
    });
    expect(disabled.status).toBe(403);
  });

  it('streams SSE headers, initial comment, dispatched events without push_tokens, and cleans up on abort', async () => {
    mockDb.queryOne.mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 });

    const abortController = new AbortController();
    const res = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1' },
      signal: abortController.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(pushStreamHub.subscriberCount('user-1')).toBe(1);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toBe(': connected\n\n');

    // Empty push_tokens row for active user on allowed server + enabled notification type -> delivers via SSE stream
    mockDb.query
      .mockResolvedValueOnce([{
        user_status: 'active',
        push_enabled_server_ids: ['srv-1'],
        push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
        token: null,
        platform: null,
        notification_types: null,
      }])
      .mockResolvedValueOnce([{ badge_count: 3 }]);

    await dispatchPush({
      userId: 'user-1',
      serverId: 'srv-1',
      eventId: 'evt-1',
      type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      title: 'host · proj · codex',
      body: 'Build succeeded',
      data: { serverId: 'srv-1', session: 'deck_proj_brain', type: 'session.idle' },
    }, { DB: mockDb } as never);

    const eventChunk = await reader.read();
    expect(eventChunk.done).toBe(false);
    const frame = decoder.decode(eventChunk.value);
    expect(frame).toContain('id: evt-1\n');
    expect(frame).toContain('event: push\n');
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
    expect(JSON.parse(dataLine.slice(6))).toEqual({
      id: 'evt-1',
      title: 'host · proj · codex',
      body: 'Build succeeded',
      type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      badge: 3,
      data: { serverId: 'srv-1', session: 'deck_proj_brain', type: 'session.idle' },
    });

    // Disabled notification type (task_pair_audit) is filtered before badge increment / publish
    mockDb.query.mockResolvedValueOnce([{
      user_status: 'active',
      push_enabled_server_ids: ['srv-1'],
      push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
      token: null,
      platform: null,
      notification_types: null,
    }]);
    await dispatchPush({
      userId: 'user-1',
      serverId: 'srv-1',
      type: PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
      title: 'audit',
      body: 'intermediate',
    }, { DB: mockDb } as never);
    expect(mockDb.query).toHaveBeenCalledTimes(3); // 1 dispatch SELECT + 1 badge UPDATE + 1 filtered SELECT

    // Muted server filters regular notifications, while remote_desktop bypasses server mute
    mockDb.query.mockResolvedValueOnce([{
      user_status: 'active',
      push_enabled_server_ids: ['srv-1'],
      push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
      token: null,
      platform: null,
      notification_types: null,
    }]);
    await dispatchPush({
      userId: 'user-1',
      serverId: 'srv-muted',
      type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      title: 'muted',
      body: 'should not deliver',
    }, { DB: mockDb } as never);
    expect(pushStreamHub.subscriberCount('user-1')).toBe(1);

    mockDb.query
      .mockResolvedValueOnce([{
        user_status: 'active',
        push_enabled_server_ids: ['srv-1'],
        push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
        token: null,
        platform: null,
        notification_types: null,
      }])
      .mockResolvedValueOnce([{ badge_count: 4 }]);
    await dispatchPush({
      userId: 'user-1',
      serverId: 'srv-muted',
      eventId: 'evt-rd-1',
      type: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
      title: 'Security',
      body: 'Remote desktop unlocked',
      data: { serverId: 'srv-muted' },
    }, { DB: mockDb } as never);
    const rdChunk = await reader.read();
    expect(decoder.decode(rdChunk.value)).toContain('id: evt-rd-1\n');

    // Mobile suppression skips pushStreamHub without blocking desktop if allowed
    mockDb.query.mockResolvedValueOnce([{
      user_status: 'active',
      push_enabled_server_ids: ['srv-1'],
      push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
      token: null,
      platform: null,
      notification_types: null,
    }]);
    await dispatchPush({
      userId: 'user-1',
      serverId: 'srv-1',
      type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      title: 'Suppressed mobile',
      body: 'Mobile already viewing',
      suppressMobilePush: true,
    }, { DB: mockDb } as never);
    expect(notifyPushNotificationMock).toHaveBeenCalledTimes(3); // task_complete (srv-1), remote_desktop (srv-muted), suppressed mobile

    // Aborting signal removes subscriber immediately
    abortController.abort();
    await reader.cancel().catch(() => {});
    expect(pushStreamHub.subscriberCount('user-1')).toBe(0);
  });

  it('evicts the oldest subscriber when exceeding MAX_PUSH_STREAMS_PER_USER and removes failed writers', async () => {
    const closed: number[] = [];
    const received: number[] = [];
    for (let i = 0; i < MAX_PUSH_STREAMS_PER_USER + 2; i += 1) {
      pushStreamHub.subscribe('user-cap', {
        send: () => {
          received.push(i);
          return i !== MAX_PUSH_STREAMS_PER_USER; // make one fail on write
        },
        close: () => {
          closed.push(i);
        },
      });
    }

    expect(pushStreamHub.subscriberCount('user-cap')).toBe(MAX_PUSH_STREAMS_PER_USER);
    expect(closed).toEqual([0, 1]);

    const delivered = pushStreamHub.publish('user-cap', {
      id: 'cap-1',
      title: 'T',
      body: 'B',
    });
    // Subscriber MAX_PUSH_STREAMS_PER_USER returned false and was auto-removed & closed
    expect(delivered).toBe(MAX_PUSH_STREAMS_PER_USER - 1);
    expect(closed).toContain(MAX_PUSH_STREAMS_PER_USER);
    expect(pushStreamHub.subscriberCount('user-cap')).toBe(MAX_PUSH_STREAMS_PER_USER - 1);
  });
});
