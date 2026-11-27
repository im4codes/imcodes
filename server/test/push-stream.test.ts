import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_PLATFORM_IOS,
} from '../../shared/push-notifications.js';
import { GLOBAL_TASK_PG_NOTIFY_MAX_BYTES } from '../../shared/global-task-mode.js';

const mockDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../src/security/authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/security/authorization.js')>();
  return {
    ...actual,
    requireAuth: () => async (c: any, next: any) => {
      const authHeader = c.req.header('Authorization');
      if (authHeader === 'Bearer valid-user-1') {
        c.set('userId', 'user-1');
        c.set('role', 'owner');
        c.set('keyId', 'key-1');
        return next();
      }
      if (authHeader === 'Bearer valid-user-1-key-a') {
        c.set('userId', 'user-1');
        c.set('role', 'member');
        c.set('keyId', 'key-a');
        return next();
      }
      if (authHeader === 'Bearer valid-user-1-key-b') {
        c.set('userId', 'user-1');
        c.set('role', 'member');
        c.set('keyId', 'key-b');
        return next();
      }
      if (authHeader === 'Bearer valid-user-jwt') {
        c.set('userId', 'user-1');
        c.set('role', 'owner');
        c.set('authIssuedAt', Math.floor(Date.now() / 1000));
        return next();
      }
      if (authHeader === 'Bearer valid-user-2') {
        c.set('userId', 'user-2');
        c.set('role', 'owner');
        c.set('keyId', 'key-2');
        return next();
      }
      return c.json({ error: 'unauthorized' }, 401);
    },
  };
});

import { dispatchPush, pushRoutes } from '../src/routes/push.js';
import { GlobalTaskHub, globalTaskHub } from '../src/services/global-task-hub.js';
import { closeRevokedPushStreams } from '../src/ws/account-watch.js';
import { WsBridge } from '../src/ws/bridge.js';
import { sha256Hex, signJwt } from '../src/security/crypto.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../src/security/account-session-jwt.js';
import {
  MAX_PUSH_STREAMS_PER_USER,
  PUSH_STREAM_MAX_BUFFERED_CHUNKS,
  PushStreamHub,
  pushStreamHub,
} from '../src/services/push-stream-hub.js';

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = {
    DB: mockDb,
  };
  return next();
});
app.route('/api/push', pushRoutes);

describe('GET /api/push/stream and pushStreamHub', () => {
  let notifyPushNotificationSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pushStreamHub.stop();
    notifyPushNotificationSpy = vi.spyOn(globalTaskHub, 'notifyPushNotification').mockResolvedValue();
  });

  afterEach(() => {
    notifyPushNotificationSpy.mockRestore();
    pushStreamHub.stop();
    vi.useRealTimers();
  });

  it('rejects unauthenticated requests, JWT-only sessions, disabled users (403), and transient DB failures (503)', async () => {
    const unauth = await app.request('/api/push/stream');
    expect(unauth.status).toBe(401);

    const jwtOnly = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-jwt' },
    });
    expect(jwtOnly.status).toBe(401);

    mockDb.queryOne.mockResolvedValueOnce({ status: 'disabled', sessions_valid_after: 0 });
    const disabled = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1' },
    });
    expect(disabled.status).toBe(403);

    mockDb.queryOne.mockRejectedValueOnce(new Error('PG connection timeout'));
    const transientErr = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1' },
    });
    expect(transientErr.status).toBe(503);
  });

  it('streams SSE headers, initial comment, dispatched events without push_tokens, and cleans up on abort', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 })
      .mockResolvedValueOnce({ id: 'key-1' });

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

    // Empty push_tokens row for active user on allowed server + enabled notification type -> delivers via SSE stream without incrementing token badge_count
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
      data: { serverId: 'srv-1', session: 'deck_proj_brain', type: 'session.idle' },
    });

    // Disabled notification type (task_pair_audit) is filtered before publish
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
    expect(mockDb.query).toHaveBeenCalledTimes(2); // 1 allowed dispatch SELECT + 1 filtered SELECT, zero badge_count UPDATE

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
    expect(notifyPushNotificationSpy).toHaveBeenCalledTimes(3); // task_complete (srv-1), remote_desktop (srv-muted), suppressed mobile

    // Aborting signal removes subscriber immediately
    abortController.abort();
    await reader.cancel().catch(() => {});
    expect(pushStreamHub.subscriberCount('user-1')).toBe(0);
  });

  it('P0-1: delivers SSE across two isolated replica hubs with zero phantom badge increments when no token matches, and keeps oversized session.error within PG NOTIFY byte cap', async () => {
    const streamHubA = new PushStreamHub();
    const streamHubB = new PushStreamHub();
    const globalHubA = new GlobalTaskHub({ pushStreamHub: streamHubA });
    const globalHubB = new GlobalTaskHub({ pushStreamHub: streamHubB });

    // Simulate PG LISTEN active on replica A and enforce realistic PG NOTIFY payload byte cap
    vi.spyOn(globalHubA, 'isPgListening').mockReturnValue(true);
    const receivedOnB: string[] = [];
    streamHubB.subscribe('user-multi', {
      send: (frame) => {
        receivedOnB.push(frame);
        return true;
      },
      close: () => {},
    });
    expect(streamHubA.hasSubscribers('user-multi')).toBe(false);
    expect(streamHubB.hasSubscribers('user-multi')).toBe(true);

    const notifiedPayloads: string[] = [];
    const replicaDb = {
      query: vi.fn()
        // 1) Tokenless SSE-only user -> delivered to Pod B, zero badge_count UPDATE
        .mockResolvedValueOnce([{
          user_status: 'active',
          push_enabled_server_ids: ['srv-a'],
          push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
          token: null,
          platform: null,
          notification_types: null,
        }])
        // 2) Negative badge control: iOS token enabled ONLY for task_complete, global allows task_pair_done, 0 SSE everywhere -> zero badge_count UPDATE
        .mockResolvedValueOnce([{
          user_status: 'active',
          push_enabled_server_ids: ['srv-a'],
          push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE],
          token: 'ios-tok-only-a',
          platform: PUSH_PLATFORM_IOS,
          notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE],
        }])
        // 3) Oversized 9500-byte session.error without explicit eventId -> bounded ID + body delivered to Pod B
        .mockResolvedValueOnce([{
          user_status: 'active',
          push_enabled_server_ids: ['srv-a'],
          push_notification_types: [...DEFAULT_PUSH_NOTIFICATION_TYPES],
          token: null,
          platform: null,
          notification_types: null,
        }]),
      queryOne: vi.fn(),
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('pg_notify')) {
          const payload = String(params[1]);
          if (Buffer.byteLength(payload, 'utf8') > GLOBAL_TASK_PG_NOTIFY_MAX_BYTES) {
            throw new Error(`pg_notify payload string too long (${Buffer.byteLength(payload, 'utf8')} bytes)`);
          }
          notifiedPayloads.push(payload);
          await globalHubA.handleNotifyPayload(payload, replicaDb as never);
          await globalHubB.handleNotifyPayload(payload, replicaDb as never);
        }
        return { changes: 1 };
      }),
    } as any;

    await dispatchPush(
      {
        userId: 'user-multi',
        serverId: 'srv-a',
        eventId: 'evt-cross-1',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        title: 'Pod A · proj',
        body: 'Delivered to Pod B',
        data: { serverId: 'srv-a', session: 'deck_proj_brain' },
      },
      { DB: replicaDb } as never,
      undefined,
      { globalHub: globalHubA },
    );
    expect(receivedOnB).toHaveLength(1);
    expect(receivedOnB[0]).toContain('"id":"evt-cross-1"');

    // Negative badge control: PG LISTEN true + no SSE subscribers + no matching token -> ZERO badge_count UPDATE
    await dispatchPush(
      {
        userId: 'user-ios-only-a',
        serverId: 'srv-a',
        eventId: 'evt-unmatched-b',
        type: PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
        title: 'Pod A · pair',
        body: 'Unmatched token type',
        data: { serverId: 'srv-a', session: 'deck_proj_brain' },
      },
      { DB: replicaDb } as never,
      undefined,
      { globalHub: globalHubA },
    );

    // 9500-byte error body with fallback ID (no eventId) -> still fits <= 4000 bytes and arrives on Pod B with serverId/session
    await dispatchPush(
      {
        userId: 'user-multi',
        serverId: 'srv-a',
        type: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        title: 'Pod A · error',
        body: `Error: ${'X'.repeat(9500)}`,
        data: { serverId: 'srv-a', session: 'deck_proj_err', type: 'session.error' },
      },
      { DB: replicaDb } as never,
      undefined,
      { globalHub: globalHubA },
    );

    const badgeQueries = replicaDb.query.mock.calls.filter(([sql]: [string]) => sql.includes('badge_count'));
    expect(badgeQueries).toHaveLength(0);
    expect(receivedOnB).toHaveLength(2);
    expect(receivedOnB[1]).toContain('"serverId":"srv-a"');
    expect(receivedOnB[1]).toContain('"session":"deck_proj_err"');
    for (const raw of notifiedPayloads) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);
    }
  });

  it('P0-2: delivers SSE on real WsBridge session.idle and task_pair.event entries even while mobile WebSocket stays OPEN in background', async () => {
    const receivedFrames: string[] = [];
    pushStreamHub.subscribe('user-ws-bg', {
      send: (frame) => {
        receivedFrames.push(frame);
        return true;
      },
      close: () => {},
    });

    const mockBridgeDb = {
      queryOne: vi.fn(async () => ({ user_id: 'user-ws-bg', name: 'my-host' })),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM users')) {
          return [{
            user_status: 'active',
            push_enabled_server_ids: ['srv-ws-1'],
            push_notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE],
            token: 'apns-tok-1',
            platform: 'ios',
            notification_types: [PUSH_NOTIFICATION_TYPE_TASK_COMPLETE, PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE],
          }];
        }
        if (sql.includes('badge_count')) {
          return [{ badge_count: 1 }];
        }
        return [];
      }),
      execute: vi.fn(async () => ({ changes: 1 })),
    } as any;

    const bridge = WsBridge.get('srv-ws-1');
    const mobileWs = new EventEmitter() as any;
    mobileWs.readyState = 1; // WebSocket.OPEN
    mobileWs.send = vi.fn();
    mobileWs.close = vi.fn();

    bridge.handleBrowserConnection(mobileWs, 'user-ws-bg', mockBridgeDb, true);

    const mockEnv = { DB: mockBridgeDb } as any; // no APNS/FCM/JPUSH keys, no PUSH_RELAY_URL -> would throw or fetch if token push attempted
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      await (bridge as any).dispatchEventPush(mockBridgeDb, mockEnv, {
        type: 'session.idle',
        session: 'deck_proj_brain',
        lastText: 'Finished work while app backgrounded',
        eventId: 'evt-bg-idle-1',
      });

      await (bridge as any).dispatchTaskPairPush(
        mockBridgeDb,
        mockEnv,
        'deck_proj_brain',
        {
          taskId: 'tsk_bg_1',
          title: 'Background pair',
          verb: 'DONE',
          toStatus: 'done',
          round: 1,
        },
        'evt-bg-pair-1',
        Date.now(),
      );

      // Both task status (session.idle) AND pair hook (task_pair.event) delivered to SSE despite open mobile WS,
      // while legacy token push remained suppressed (no fetch calls).
      expect(receivedFrames).toHaveLength(2);
      expect(receivedFrames[0]).toContain('Finished work while app backgrounded');
      expect(receivedFrames[1]).toContain('tsk_bg_1');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(notifyPushNotificationSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      mobileWs.emit('close');
      bridge.dispose();
    }
  });

  it('P0-5: enforces native API-key-only auth with real requireAuth middleware, revokes key A while keeping key B, and closes expired grace keys', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 })
      .mockResolvedValueOnce({ id: 'key-a' })
      .mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 })
      .mockResolvedValueOnce({ id: 'key-b' });

    const abortA = new AbortController();
    const abortB = new AbortController();
    const resA = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1-key-a' },
      signal: abortA.signal,
    });
    const resB = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1-key-b' },
      signal: abortB.signal,
    });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(pushStreamHub.subscriberCount('user-1')).toBe(2);

    const readerA = resA.body!.getReader();
    const readerB = resB.body!.getReader();
    await readerA.read(); // : connected
    await readerB.read(); // : connected

    // Revoke key-a -> only key-a closes, key-b stays connected
    await globalTaskHub.notifyPushCredentialRevoked(mockDb as never, { userId: 'user-1', keyId: 'key-a' });
    expect(pushStreamHub.subscriberCount('user-1')).toBe(1);
    const afterRevokeA = await readerA.read();
    expect(afterRevokeA.done).toBe(true);

    // key-b still receives events
    pushStreamHub.publish('user-1', { id: 'evt-key-b', title: 'B', body: 'Still alive' });
    const chunkB = await readerB.read();
    expect(new TextDecoder().decode(chunkB.value)).toContain('evt-key-b');

    // Grace expiry check via account-watch closes remaining expired key-b stream
    mockDb.query.mockResolvedValueOnce([{ id: 'key-b' }]);
    const closedExpired = await closeRevokedPushStreams(mockDb as never, pushStreamHub, Date.now());
    expect(closedExpired).toBe(1);
    expect(pushStreamHub.subscriberCount('user-1')).toBe(0);
    const afterExpireB = await readerB.read();
    expect(afterExpireB.done).toBe(true);

    // Verify real unmocked requireAuth middleware rejects JWT Bearer, expired JWT, and revoked API key while allowing active API key
    const { Hono: RealHono } = await import('hono');
    const authMod = await vi.importActual<typeof import('../src/security/authorization.js')>('../src/security/authorization.js');
    const jwtKey = 'test-signing-key-32-bytes-minimum!!';
    const validKey = 'deck_real_api_key_active';
    const validKeyHash = sha256Hex(validKey);
    const realDb = {
      queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM api_keys') && sql.includes('key_hash')) {
          return params?.[0] === validKeyHash ? { id: 'real-key-id', user_id: 'real-u1', user_status: 'active' } : null;
        }
        if (sql.includes('SELECT status, sessions_valid_after FROM users')) {
          return { status: 'active', sessions_valid_after: 0 };
        }
        if (sql.includes('FROM api_keys')) {
          return params?.[0] === 'real-key-id' ? { id: 'real-key-id' } : null;
        }
        return null;
      }),
      query: vi.fn(async () => []),
      execute: vi.fn(async () => ({ changes: 1 })),
    };
    const realApp = new RealHono();
    realApp.use('/*', async (c, next) => {
      (c as any).env = { DB: realDb, JWT_SIGNING_KEY: jwtKey };
      return next();
    });
    realApp.use('/api/push/stream', authMod.requireAuth({ refuseDaemonCredential: true }));
    realApp.get('/api/push/stream', (c) => {
      const keyId = c.get('keyId' as never) as string | undefined;
      if (!keyId) return c.json({ error: 'unauthorized' }, 401);
      return c.json({ ok: true, keyId }, 200);
    });

    const signedJwt = signJwt({ sub: 'real-u1', type: ACCOUNT_SESSION_JWT_TYPE, iat: Math.floor(Date.now() / 1000) }, jwtKey, 3600);
    const expiredJwt = signJwt({ sub: 'real-u1', type: ACCOUNT_SESSION_JWT_TYPE, iat: Math.floor(Date.now() / 1000) - 7200 }, jwtKey, -10);
    expect((await realApp.request('/api/push/stream', { headers: { Authorization: `Bearer ${signedJwt}` } })).status).toBe(401);
    expect((await realApp.request('/api/push/stream', { headers: { Authorization: `Bearer ${expiredJwt}` } })).status).toBe(401);
    expect((await realApp.request('/api/push/stream', { headers: { Authorization: 'Bearer deck_revoked_key' } })).status).toBe(401);
    expect((await realApp.request('/api/push/stream', { headers: { Authorization: `Bearer ${validKey}` } })).status).toBe(200);
  });

  it('P0-6: closes slow stalled SSE reader at bounded backpressure threshold without blocking healthy reader', async () => {
    mockDb.queryOne
      .mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 })
      .mockResolvedValueOnce({ id: 'key-a' })
      .mockResolvedValueOnce({ status: 'active', sessions_valid_after: 0 })
      .mockResolvedValueOnce({ id: 'key-b' });

    const resSlow = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1-key-a' },
    });
    const resFast = await app.request('/api/push/stream', {
      headers: { Authorization: 'Bearer valid-user-1-key-b' },
    });
    const slowReader = resSlow.body!.getReader();
    const fastReader = resFast.body!.getReader();
    const decoder = new TextDecoder();
    // Drain initial : connected on fastReader only; leave slowReader unread
    expect(decoder.decode((await fastReader.read()).value)).toBe(': connected\n\n');
    expect(pushStreamHub.subscriberCount('user-1')).toBe(2);

    const fastEvents: string[] = [];
    for (let i = 0; i < PUSH_STREAM_MAX_BUFFERED_CHUNKS + 4; i += 1) {
      pushStreamHub.publish('user-1', { id: `bp-${i}`, title: 'T', body: `msg-${i}` });
      const chunk = await fastReader.read();
      fastEvents.push(decoder.decode(chunk.value));
    }

    // Slow reader was automatically closed & unsubscribed; fast reader received every single event
    expect(pushStreamHub.subscriberCount('user-1')).toBe(1);
    expect(fastEvents).toHaveLength(PUSH_STREAM_MAX_BUFFERED_CHUNKS + 4);

    // Cancel slowReader so buffered queued chunks release cleanly
    await slowReader.cancel().catch(() => {});
    await fastReader.cancel().catch(() => {});
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
