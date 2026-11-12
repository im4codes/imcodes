/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import type { TimelineEvent, WsClient } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';
import { TIMELINE_SNAPSHOT_STORAGE_PREFIX } from '../src/local-storage-quota.js';
import {
  __resetTimelineCacheForTests,
  __flushTimelineSnapshotsBeforeFreezeForTests,
  registerIncognitoTimelineSession,
  registerNormalTimelineSession,
  syncIncognitoTimelineSessions,
  forgetIncognitoTimelineSessions,
  ingestTimelineEventForCache,
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
});
