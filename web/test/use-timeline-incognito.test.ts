/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import type { TimelineEvent, WsClient } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';
import { TIMELINE_SNAPSHOT_STORAGE_PREFIX } from '../src/local-storage-quota.js';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';
import {
  __getTimelineCacheForTests,
  __resetTimelineCacheForTests,
  __flushTimelineSnapshotsBeforeFreezeForTests,
  registerIncognitoTimelineSession,
  registerNormalTimelineSession,
  syncIncognitoTimelineSessions,
  forgetIncognitoTimelineSessions,
  ingestTimelineEventForCache,
  isIncognitoTimelineSession,
  useTimeline,
} from '../src/hooks/useTimeline.js';

function makeEvent(overrides: Partial<TimelineEvent> & { eventId: string; sessionId: string }): TimelineEvent {
  return {
    seq: 1,
    ts: Date.now(),
    epoch: 1,
    type: 'assistant.text',
    source: 'daemon',
    confidence: 'high',
    payload: { text: overrides.eventId, streaming: false },
    ...overrides,
  };
}

describe('useTimeline incognito lifecycle & persistence isolation (F2)', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    __resetTimelineCacheForTests();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('private -> stop -> normal same (serverId, name) recovers IDB and localStorage persistence without inheriting incognito tombstone', async () => {
    const serverId = `srv-f2-recover-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_reuse_brain';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);

    registerIncognitoTimelineSession(serverId, name, { runtimeEpoch: 1 });
    ingestTimelineEventForCache(makeEvent({
      eventId: 'priv-1',
      sessionId: name,
      epoch: 1,
      seq: 1,
      payload: { text: 'SECRET-PRIVATE-TEXT', streaming: false, incognito: true },
    }), serverId);
    __flushTimelineSnapshotsBeforeFreezeForTests();

    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).toBeNull();

    // Private session closes
    forgetIncognitoTimelineSessions(serverId, name);

    // Late old-private WS frame before normal start must NOT persist
    ingestTimelineEventForCache(makeEvent({
      eventId: 'priv-late-1',
      sessionId: name,
      epoch: 1,
      seq: 2,
      payload: { text: 'SECRET-LATE-T1', streaming: false, incognito: true },
    }), serverId);
    __flushTimelineSnapshotsBeforeFreezeForTests();
    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).toBeNull();

    // Authoritative session_list announces new normal session with same name
    syncIncognitoTimelineSessions(serverId, [{ name, incognito: false }]);

    // Late old-private frame from epoch 1 arriving AFTER normal session starts must be dropped and never pollute normal mode
    ingestTimelineEventForCache(makeEvent({
      eventId: 'priv-late-2',
      sessionId: name,
      epoch: 1,
      seq: 3,
      payload: { text: 'SECRET-LATE-T2', streaming: false, incognito: true },
    }), serverId);

    // New ordinary event in epoch 2 MUST persist cleanly without incognito flags
    ingestTimelineEventForCache(makeEvent({
      eventId: 'norm-1',
      sessionId: name,
      epoch: 2,
      seq: 1,
      payload: { text: 'ORDINARY-NEW-INSTANCE', streaming: false },
    }), serverId);

    await new Promise((resolve) => setTimeout(resolve, 40));
    __flushTimelineSnapshotsBeforeFreezeForTests();

    const stored = putSpy.mock.calls.flatMap(([events]) => events);
    expect(stored.map((e) => e.eventId)).toEqual(['norm-1']);
    expect(stored[0]?.payload).toEqual({ text: 'ORDINARY-NEW-INSTANCE', streaming: false });
    const snapshotRaw = localStorage.getItem(snapKey) ?? '';
    expect(snapshotRaw).toContain('ORDINARY-NEW-INSTANCE');
    expect(snapshotRaw).not.toContain('SECRET-LATE');
  });

  it('normal -> private same (serverId, name) isolates UI from old normal localStorage/IDB without deleting prior normal data', async () => {
    const serverId = `srv-f2-np-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_normal_first_brain';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const priorNorm = makeEvent({
      eventId: 'old-norm-1',
      sessionId: name,
      epoch: 1,
      seq: 1,
      payload: { text: 'PRIOR-NORMAL-HISTORY', streaming: false },
    });
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);
    const getRecentSpy = vi.spyOn(TimelineDB.prototype, 'getRecentEvents').mockResolvedValue([priorNorm]);

    // Pre-existing normal session history in IDB + localStorage snapshot
    ingestTimelineEventForCache(priorNorm, serverId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    __flushTimelineSnapshotsBeforeFreezeForTests();

    expect(localStorage.getItem(snapKey)).toContain('PRIOR-NORMAL-HISTORY');
    expect(putSpy).toHaveBeenCalledTimes(1);
    putSpy.mockClear();
    getRecentSpy.mockClear();

    // Switch session to incognito (simulating normal stopped, new private session started with same name)
    registerIncognitoTimelineSession(serverId, name, { runtimeEpoch: 2 });

    const ws = {
      connected: true,
      onMessage: () => () => {},
      onSessionMessage: () => () => {},
      send: vi.fn(),
      sendTimelineHistoryRequest: vi.fn(),
    } as unknown as WsClient;

    const { result } = renderHook(() => useTimeline(name, ws, serverId, { incognito: true, isActiveSession: true }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Must NOT surface old normal history from IDB or localStorage in incognito mode
    expect(result.current.events.map((e) => e.eventId)).not.toContain('old-norm-1');
    expect(getRecentSpy).not.toHaveBeenCalled();

    // Prior normal user history on disk must still remain intact (not deleted)
    expect(localStorage.getItem(snapKey)).toContain('PRIOR-NORMAL-HISTORY');

    // New optimistic user message in incognito carries incognito: true and does not hit IDB
    act(() => {
      result.current.addOptimisticUserMessage('PRIVATE-PROMPT-ABC', 'cmd-opt-1');
    });
    expect(result.current.events.some((e) => e.payload?.text === 'PRIVATE-PROMPT-ABC' && e.payload?.incognito === true)).toBe(true);
    __flushTimelineSnapshotsBeforeFreezeForTests();
    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).not.toContain('PRIVATE-PROMPT-ABC');
    expect(localStorage.getItem(snapKey)).toContain('PRIOR-NORMAL-HISTORY');
  });

  it('isolates same session name across two different servers cleanly', async () => {
    const name = 'deck_cd_brain';
    const srvA = `srv-A-${Math.random().toString(36).slice(2)}`;
    const srvB = `srv-B-${Math.random().toString(36).slice(2)}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);

    registerIncognitoTimelineSession(srvA, name, { runtimeEpoch: 1 });
    registerNormalTimelineSession(srvB, name, { runtimeEpoch: 1 });

    ingestTimelineEventForCache(makeEvent({
      eventId: 'a-priv',
      sessionId: name,
      payload: { text: 'SRV-A-SECRET', streaming: false, incognito: true },
    }), srvA);

    ingestTimelineEventForCache(makeEvent({
      eventId: 'b-norm',
      sessionId: name,
      payload: { text: 'SRV-B-ORDINARY', streaming: false },
    }), srvB);

    await new Promise((resolve) => setTimeout(resolve, 30));
    __flushTimelineSnapshotsBeforeFreezeForTests();

    const writtenEvents = putSpy.mock.calls.flatMap(([events]) => events);
    const writtenA = writtenEvents.filter((e) => e.sessionId === `${srvA}:${name}`);
    const writtenB = writtenEvents.filter((e) => e.sessionId === `${srvB}:${name}`);
    expect(writtenA).toEqual([]);
    expect(writtenB.map((e) => e.eventId)).toEqual(['b-norm']);
  });

  it('keeps daemon epoch separate from runtimeEpoch across same-daemon close->normal reuse and unchanged session_list refreshes (F2-R2)', async () => {
    const serverId = `srv-f2-r2-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_same_daemon_reuse';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);

    // Active private instance under daemon epoch 123456
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-inst-1', runtimeEpoch: 'priv-rt-1' },
    ]);
    expect(isIncognitoTimelineSession(serverId, name)).toBe(true);

    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-live-1',
      sessionId: name,
      epoch: 123456,
      seq: 1,
      payload: { text: 'LIVE-PRIVATE-TRANSCRIPT', streaming: false, incognito: true },
    }), serverId);

    // Periodic identical session_list must NOT wipe live RAM transcript
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-inst-1', runtimeEpoch: 'priv-rt-1' },
    ]);
    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.eventId)).toEqual(['p-live-1']);
    expect(putSpy).not.toHaveBeenCalled();

    // Stop private session, then start normal session on the SAME daemon epoch 123456
    forgetIncognitoTimelineSessions(serverId, name);
    expect(isIncognitoTimelineSession(serverId, name)).toBe(false);
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: false, sessionInstanceId: 'norm-inst-2', runtimeEpoch: 'norm-rt-2' },
    ]);

    // Stale frame explicitly stamped with old private runtimeEpoch/sessionInstanceId must be dropped
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-stale-inst',
      sessionId: name,
      epoch: 123456,
      seq: 2,
      sessionInstanceId: 'priv-inst-1',
      runtimeEpoch: 'priv-rt-1',
      payload: { text: 'STALE-PRIVATE-LEAK', streaming: false, incognito: true },
    }), serverId);

    // New normal message on SAME daemon epoch 123456 MUST display and persist
    ingestTimelineEventForCache(makeEvent({
      eventId: 'n-same-epoch',
      sessionId: name,
      epoch: 123456,
      seq: 1,
      sessionInstanceId: 'norm-inst-2',
      runtimeEpoch: 'norm-rt-2',
      payload: { text: 'NORMAL-SAME-DAEMON-EPOCH', streaming: false },
    }), serverId);

    await new Promise((resolve) => setTimeout(resolve, 40));
    __flushTimelineSnapshotsBeforeFreezeForTests();

    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.eventId)).toEqual(['n-same-epoch']);
    const stored = putSpy.mock.calls.flatMap(([events]) => events);
    expect(stored.map((e) => e.eventId)).toEqual(['n-same-epoch']);
    expect(localStorage.getItem(snapKey)).toContain('NORMAL-SAME-DAEMON-EPOCH');
    expect(localStorage.getItem(snapKey)).not.toContain('STALE-PRIVATE-LEAK');
  });

  it('drops delayed frames and stale re-registrations from a closed private instance without wiping the new private transcript (F2-R3)', async () => {
    const serverId = `srv-f2-r3-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_priv_reuse_brain';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);

    // 1. Old private instance opens, receives events + coalesced streaming delta, and closes
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-old', runtimeEpoch: 'rt-old' },
    ]);
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-old-1',
      sessionId: name,
      epoch: 123456,
      seq: 1,
      sessionInstanceId: 'priv-old',
      runtimeEpoch: 'rt-old',
      payload: { text: 'OLD-PRIVATE-SECRET', streaming: false, incognito: true },
    }), serverId);
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-old-stream',
      sessionId: name,
      epoch: 123456,
      seq: 2,
      sessionInstanceId: 'priv-old',
      runtimeEpoch: 'rt-old',
      payload: { text: 'OLD-PRIVATE-STREAMING', streaming: true, incognito: true },
    }), serverId);
    forgetIncognitoTimelineSessions(serverId, name);

    // 2. New private instance opens with the same (serverId, sessionName) on the same daemon epoch
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-new', runtimeEpoch: 'rt-new' },
    ]);
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-cur-1',
      sessionId: name,
      epoch: 123456,
      seq: 1,
      sessionInstanceId: 'priv-new',
      runtimeEpoch: 'rt-new',
      payload: { text: 'CURRENT-PRIVATE', streaming: false, incognito: true },
    }), serverId);
    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual(['CURRENT-PRIVATE']);

    // 3. Delayed frame + stale session_list carrying old private identity must both be dropped
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-old-late',
      sessionId: name,
      epoch: 123456,
      seq: 3,
      sessionInstanceId: 'priv-old',
      runtimeEpoch: 'rt-old',
      payload: { text: 'LATE-CLOSED-PRIVATE', streaming: false, incognito: true },
    }), serverId);
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-old-late-stream',
      sessionId: name,
      epoch: 123456,
      seq: 4,
      sessionInstanceId: 'priv-old',
      runtimeEpoch: 'rt-old',
      payload: { text: 'LATE-CLOSED-STREAMING', streaming: true, incognito: true },
    }), serverId);
    registerIncognitoTimelineSession(serverId, name, { sessionInstanceId: 'priv-old', runtimeEpoch: 'rt-old' });

    await new Promise((resolve) => setTimeout(resolve, 40));
    __flushTimelineSnapshotsBeforeFreezeForTests();

    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual(['CURRENT-PRIVATE']);
    expect(isIncognitoTimelineSession(serverId, name)).toBe(true);
    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).toBeNull();
  });

  it('rejects closed private instance frames across mounted WS events, user.message reconciliation, history, and replay batches (F2-R3)', async () => {
    const serverId = `srv-f2-ws-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_priv_ws_brain';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);
    const handlers = new Set<(msg: Record<string, unknown>) => void>();

    const ws = {
      connected: true,
      onMessage: (cb: (msg: Record<string, unknown>) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      onSessionMessage: (_sid: string, cb: (msg: Record<string, unknown>) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      send: vi.fn(),
      sendTimelineHistoryRequest: vi.fn(),
    } as unknown as WsClient;

    const emit = (msg: Record<string, unknown>) => {
      for (const h of handlers) h(msg);
    };

    // Old private instance starts and closes, leaving tombstone for priv-old / rt-old
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-old', runtimeEpoch: 'rt-old' },
    ]);
    const { result } = renderHook(() => useTimeline(name, ws, serverId, { incognito: true, isActiveSession: true }));
    expect(handlers.size).toBeGreaterThan(0);

    // Queue a streaming delta from old instance, then close and launch new private instance before RAF flushes
    act(() => {
      emit({
        type: 'timeline.event',
        event: makeEvent({
          eventId: 'p-old-queued-stream',
          sessionId: name,
          epoch: 123456,
          seq: 1,
          sessionInstanceId: 'priv-old',
          runtimeEpoch: 'rt-old',
          payload: { text: 'OLD-QUEUED-STREAM', streaming: true, incognito: true },
        }),
      });
      forgetIncognitoTimelineSessions(serverId, name);
      syncIncognitoTimelineSessions(serverId, [
        { name, incognito: true, sessionInstanceId: 'priv-new', runtimeEpoch: 'rt-new' },
      ]);
      emit({
        type: 'timeline.event',
        event: makeEvent({
          eventId: 'p-new-live',
          sessionId: name,
          epoch: 123456,
          seq: 1,
          sessionInstanceId: 'priv-new',
          runtimeEpoch: 'rt-new',
          payload: { text: 'CURRENT-PRIVATE', streaming: false, incognito: true },
        }),
      });
      // Late WS live event + inline user.message from closed old private instance
      emit({
        type: 'timeline.event',
        event: makeEvent({
          eventId: 'p-old-ws-late',
          sessionId: name,
          epoch: 123456,
          seq: 2,
          sessionInstanceId: 'priv-old',
          runtimeEpoch: 'rt-old',
          payload: { text: 'LATE-WS-CLOSED-PRIVATE', streaming: false, incognito: true },
        }),
      });
      emit({
        type: 'timeline.event',
        event: makeEvent({
          eventId: 'p-old-user-late',
          sessionId: name,
          epoch: 123456,
          seq: 3,
          type: 'user.message',
          sessionInstanceId: 'priv-old',
          runtimeEpoch: 'rt-old',
          payload: { text: 'LATE-USER-CLOSED-PRIVATE', incognito: true },
        }),
      });
      // History & Replay batches mixing stale closed-private events with valid new-private events
      emit({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: name,
        epoch: 123456,
        hasMore: false,
        events: [
          makeEvent({
            eventId: 'p-old-hist',
            sessionId: name,
            epoch: 123456,
            seq: 4,
            sessionInstanceId: 'priv-old',
            runtimeEpoch: 'rt-old',
            payload: { text: 'LATE-HISTORY-CLOSED-PRIVATE', streaming: false, incognito: true },
          }),
          makeEvent({
            eventId: 'p-new-hist',
            sessionId: name,
            epoch: 123456,
            seq: 2,
            sessionInstanceId: 'priv-new',
            runtimeEpoch: 'rt-new',
            payload: { text: 'NEW-PRIVATE-HISTORY', streaming: false, incognito: true },
          }),
        ],
      });
      emit({
        type: TIMELINE_MESSAGES.REPLAY,
        sessionName: name,
        epoch: 123456,
        truncated: false,
        events: [
          makeEvent({
            eventId: 'p-old-replay',
            sessionId: name,
            epoch: 123456,
            seq: 5,
            sessionInstanceId: 'priv-old',
            runtimeEpoch: 'rt-old',
            payload: { text: 'LATE-REPLAY-CLOSED-PRIVATE', streaming: false, incognito: true },
          }),
          makeEvent({
            eventId: 'p-new-replay',
            sessionId: name,
            epoch: 123456,
            seq: 3,
            sessionInstanceId: 'priv-new',
            runtimeEpoch: 'rt-new',
            payload: { text: 'NEW-PRIVATE-REPLAY', streaming: false, incognito: true },
          }),
        ],
      });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    __flushTimelineSnapshotsBeforeFreezeForTests();

    const texts = result.current.events.map((e) => e.payload?.text);
    expect(texts).toEqual(['CURRENT-PRIVATE', 'NEW-PRIVATE-HISTORY', 'NEW-PRIVATE-REPLAY']);
    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual([
      'CURRENT-PRIVATE',
      'NEW-PRIVATE-HISTORY',
      'NEW-PRIVATE-REPLAY',
    ]);
    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).toBeNull();
  });

  it('continues accepting legacy new private frames without per-instance metadata after closing an older private instance (F2-R3)', () => {
    const serverId = `srv-f2-legacy-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_priv_legacy_brain';
    const cacheKey = `${serverId}:${name}`;

    registerIncognitoTimelineSession(serverId, name, { sessionInstanceId: 'priv-old', runtimeEpoch: 'rt-old' });
    forgetIncognitoTimelineSessions(serverId, name);
    registerIncognitoTimelineSession(serverId, name);

    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-legacy-new',
      sessionId: name,
      epoch: 123456,
      seq: 1,
      payload: { text: 'NEW-PRIVATE-NO-META', streaming: false, incognito: true },
    }), serverId);
    ingestTimelineEventForCache(makeEvent({
      eventId: 'p-old-late-after-nometa',
      sessionId: name,
      epoch: 123456,
      seq: 2,
      sessionInstanceId: 'priv-old',
      runtimeEpoch: 'rt-old',
      payload: { text: 'LATE-OLD-PRIVATE', streaming: false, incognito: true },
    }), serverId);

    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual(['NEW-PRIVATE-NO-META']);
  });

  it('adopts first authoritative identity after metadata-less registration across instanceId-only, runtimeEpoch-only, and both variants without treating it as closed (F2-R4)', () => {
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);
    const variants: Array<{
      label: string;
      meta: { sessionInstanceId?: string; runtimeEpoch?: string };
    }> = [
      { label: 'instance-only', meta: { sessionInstanceId: 'inst-only-1' } },
      { label: 'runtime-only', meta: { runtimeEpoch: 'rt-only-1' } },
      { label: 'both-ids', meta: { sessionInstanceId: 'inst-both-1', runtimeEpoch: 'rt-both-1' } },
    ];

    for (const { label, meta } of variants) {
      __resetTimelineCacheForTests();
      localStorage.clear();
      const serverId = `srv-f2-r4-${label}`;
      const name = `deck_r4_${label}`;
      const cacheKey = `${serverId}:${name}`;

      // Metadata-less registration (same path as useTimeline(..., { incognito: true }) initial render)
      registerIncognitoTimelineSession(serverId, name);
      ingestTimelineEventForCache(makeEvent({
        eventId: `first-${label}`,
        sessionId: name,
        epoch: 123456,
        seq: 1,
        ...meta,
        payload: { text: `FIRST-${label}`, streaming: false, incognito: true },
      }), serverId);

      // Authoritative session_list subsequently publishes the same identity
      syncIncognitoTimelineSessions(serverId, [{ name, incognito: true, ...meta }]);
      __flushTimelineSnapshotsBeforeFreezeForTests();

      expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual([`FIRST-${label}`]);
      expect(isIncognitoTimelineSession(serverId, name)).toBe(true);
      expect(localStorage.getItem(`${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`)).toBeNull();
    }
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('preserves adopted identity through repeated batch filters after metadata-less mount while still rejecting previously closed private instances (F2-R4)', async () => {
    const serverId = `srv-f2-r4-batch-${Math.random().toString(36).slice(2)}`;
    const name = 'deck_r4_batch_brain';
    const cacheKey = `${serverId}:${name}`;
    const snapKey = `${TIMELINE_SNAPSHOT_STORAGE_PREFIX}${cacheKey}`;
    const putSpy = vi.spyOn(TimelineDB.prototype, 'putEvents').mockResolvedValue(undefined);
    const handlers = new Set<(msg: Record<string, unknown>) => void>();

    const ws = {
      connected: true,
      onMessage: (cb: (msg: Record<string, unknown>) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      onSessionMessage: (_sid: string, cb: (msg: Record<string, unknown>) => void) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      send: vi.fn(),
      sendTimelineHistoryRequest: vi.fn(),
    } as unknown as WsClient;

    const emit = (msg: Record<string, unknown>) => {
      for (const h of handlers) h(msg);
    };

    // An earlier private instance existed and closed cleanly
    registerIncognitoTimelineSession(serverId, name, { sessionInstanceId: 'priv-old-r4', runtimeEpoch: 'rt-old-r4' });
    forgetIncognitoTimelineSessions(serverId, name);

    // Mount new private pane before session_list delivers new metadata (registerIncognitoTimelineSession without meta)
    const { result } = renderHook(() => useTimeline(name, ws, serverId, { incognito: true, isActiveSession: true }));

    act(() => {
      emit({
        type: 'timeline.event',
        event: makeEvent({
          eventId: 'cur-evt-1',
          sessionId: name,
          epoch: 123456,
          seq: 1,
          sessionInstanceId: 'priv-cur-r4',
          runtimeEpoch: 'rt-cur-r4',
          payload: { text: 'CURRENT-FIRST', streaming: false, incognito: true },
        }),
      });
      emit({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: name,
        epoch: 123456,
        hasMore: false,
        events: [
          makeEvent({
            eventId: 'old-hist-leak',
            sessionId: name,
            epoch: 123456,
            seq: 1,
            sessionInstanceId: 'priv-old-r4',
            runtimeEpoch: 'rt-old-r4',
            payload: { text: 'OLD-CLOSED-HIST', streaming: false, incognito: true },
          }),
          makeEvent({
            eventId: 'cur-hist-2',
            sessionId: name,
            epoch: 123456,
            seq: 2,
            sessionInstanceId: 'priv-cur-r4',
            runtimeEpoch: 'rt-cur-r4',
            payload: { text: 'CURRENT-HISTORY', streaming: false, incognito: true },
          }),
        ],
      });
      emit({
        type: TIMELINE_MESSAGES.REPLAY,
        sessionName: name,
        epoch: 123456,
        truncated: false,
        events: [
          makeEvent({
            eventId: 'cur-replay-3',
            sessionId: name,
            epoch: 123456,
            seq: 3,
            sessionInstanceId: 'priv-cur-r4',
            runtimeEpoch: 'rt-cur-r4',
            payload: { text: 'CURRENT-REPLAY', streaming: false, incognito: true },
          }),
        ],
      });
    });

    // Matching session_list arrives after repeated filters/batches
    syncIncognitoTimelineSessions(serverId, [
      { name, incognito: true, sessionInstanceId: 'priv-cur-r4', runtimeEpoch: 'rt-cur-r4' },
    ]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    __flushTimelineSnapshotsBeforeFreezeForTests();

    expect(result.current.events.map((e) => e.payload?.text)).toEqual([
      'CURRENT-FIRST',
      'CURRENT-HISTORY',
      'CURRENT-REPLAY',
    ]);
    expect(__getTimelineCacheForTests(cacheKey)?.map((e) => e.payload?.text)).toEqual([
      'CURRENT-FIRST',
      'CURRENT-HISTORY',
      'CURRENT-REPLAY',
    ]);
    expect(putSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(snapKey)).toBeNull();
  });
});
