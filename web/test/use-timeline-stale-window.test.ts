/**
 * @vitest-environment jsdom
 *
 * A chat window reopened after a long time (stale local cache, big gap to the live head) must show the
 * latest messages first and then fill the gap from NEWEST to OLDEST, without holes or duplicates, and
 * resume where it stopped after a reload/reconnect. The fake daemon below serves history exactly as the
 * real one does: the NEWEST `limit` events of `(afterTs, beforeTs)` (ORDER BY ts DESC), optionally text-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchSpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));

import { render, screen, cleanup, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { ServerMessage, TimelineEvent, WsClient } from '../src/ws-client.js';
import { TIMELINE_HISTORY_CONTENT_FILTERS, TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS, TIMELINE_STALE_WINDOW_TAIL_PEEK_LIMIT } from '../../shared/timeline-protocol.js';
import {
  __resetTimelineCacheForTests,
  __setStaleWindowPeekMinAgeMsForTests,
  __setTimelineCacheForTests,
  useTimeline,
} from '../src/hooks/useTimeline.js';
import { getTimelineGap, setTimelineGap } from '../src/timeline/catchup/gap-store.js';

const SERVER_ID = 'srv-stale';
const PAGE = 200;

function makeSession(name: string, total: number, startTs = 1_000_000): TimelineEvent[] {
  // 1 text message in 4 events, the rest tool noise: realistic for an agent window.
  return Array.from({ length: total }, (_, i) => ({
    eventId: `${name}-e${i}`,
    sessionId: name,
    ts: startTs + i * 10,
    epoch: 1,
    seq: i + 1,
    source: 'daemon' as const,
    confidence: 'high' as const,
    type: (i % 4 === 0 ? 'assistant.text' : 'tool.result') as TimelineEvent['type'],
    payload: { text: `m${i}` },
  }));
}

interface FakeDaemon {
  ws: WsClient;
  /** Every history request in the order it went on the wire, WS and HTTP alike. */
  requests: Array<{ via: 'ws' | 'http'; limit: number; afterTs?: number; beforeTs?: number; filter?: string }>;
  emit: (msg: ServerMessage) => void;
}

/** newest `limit` events with afterTs < ts < beforeTs (ORDER BY ts DESC LIMIT n, then ascending), as the real daemon. */
function serve(all: TimelineEvent[], limit: number, afterTs?: number, beforeTs?: number, textOnly = false): TimelineEvent[] {
  const inRange = all
    .filter((event) => (afterTs === undefined || event.ts > afterTs) && (beforeTs === undefined || event.ts < beforeTs))
    .filter((event) => !textOnly || event.type === 'assistant.text' || event.type === 'user.message');
  return inRange.slice(Math.max(0, inRange.length - limit));
}

function makeDaemon(all: TimelineEvent[], sessionName: string, opts: { ignoreContentFilter?: boolean } = {}): FakeDaemon {
  let handler: ((msg: ServerMessage) => void) | null = null;
  let counter = 0;
  const requests: FakeDaemon['requests'] = [];
  const respond = (requestId: string, events: TimelineEvent[], inRangeCount: number, limit: number) => {
    queueMicrotask(() => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId,
        epoch: 1,
        events,
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: inRangeCount > limit,
      } as ServerMessage);
    });
  };
  const ws = {
    connected: true,
    onMessage: (next: (msg: ServerMessage) => void) => {
      handler = next;
      return () => { handler = null; };
    },
    sendTimelineReplayRequest: vi.fn(() => 'replay-x'),
    sendTimelineHistoryRequest: vi.fn((_session: string, limit: number, afterTs?: number, beforeTs?: number, _cursor?: unknown, _budget?: number, filter?: string) => {
      counter += 1;
      const requestId = `ws-${counter}`;
      requests.push({ via: 'ws', limit, afterTs, beforeTs, filter });
      const textOnly = filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT && !opts.ignoreContentFilter;
      const events = serve(all, limit, afterTs, beforeTs, textOnly);
      const total = all.filter((event) => (afterTs === undefined || event.ts > afterTs) && (beforeTs === undefined || event.ts < beforeTs)
        && (!textOnly || event.type === 'assistant.text')).length;
      respond(requestId, events, total, limit);
      return requestId;
    }),
    sendTimelinePageRequest: vi.fn(() => 'page-x'),
    supportsTimelineProtocolRevision: vi.fn(() => true),
  } as unknown as WsClient;
  return { ws, requests, emit: (msg) => handler?.(msg) };
}

function installHttp(all: TimelineEvent[], requests: FakeDaemon['requests']) {
  fetchSpy.mockImplementation(async (_serverId: string, _session: string, opts: { afterTs?: number; beforeTs?: number; limit?: number } = {}) => {
    const limit = opts.limit ?? 50;
    requests.push({ via: 'http', limit, afterTs: opts.afterTs, beforeTs: opts.beforeTs });
    const events = serve(all, limit, opts.afterTs, opts.beforeTs);
    return { events, epoch: 1, hasMore: false, nextCursor: null };
  });
}

function Probe(props: { sessionName: string; ws: WsClient; hook: { current: ReturnType<typeof useTimeline> | null }; options?: Parameters<typeof useTimeline>[3] }) {
  const value = useTimeline(props.sessionName, props.ws, SERVER_ID, props.options ?? { isActiveSession: true });
  props.hook.current = value;
  return h('div', { 'data-testid': 'probe' }, `${value.events.length}`);
}

describe('useTimeline — stale window: latest first, then newest→oldest', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    fetchSpy.mockReset();
    fetchTextTailSpy.mockReset();
    fetchTextTailSpy.mockResolvedValue(null);
    __setStaleWindowPeekMinAgeMsForTests(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function openStale(sessionName: string, total: number, cachedCount: number, options?: Parameters<typeof useTimeline>[3], daemonOpts?: { ignoreContentFilter?: boolean }) {
    const all = makeSession(sessionName, total);
    // The local cache ends long ago (its newest ts is far in the past relative to "now").
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionName}`, all.slice(0, cachedCount));
    const daemon = makeDaemon(all, sessionName, daemonOpts);
    installHttp(all, daemon.requests);
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook, options }));
    return { all, daemon, hook };
  }

  it('shows the newest messages first via a tiny text-only peek, then fills the gap newest→oldest without holes or duplicates', async () => {
    const sessionName = `deck_stale_big_${Date.now()}`;
    const { all, daemon, hook } = await openStale(sessionName, 2600, 100);

    // The cache paints first (as today), then the peek is the FIRST thing asked of the daemon.
    expect(hook.current!.events.length).toBe(100);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(daemon.requests[0]).toMatchObject({
      via: 'ws',
      limit: TIMELINE_STALE_WINDOW_TAIL_PEEK_LIMIT,
      filter: TIMELINE_HISTORY_CONTENT_FILTERS.TEXT,
    });
    // ...and the latest message is on screen right after that one round trip, before any window/backfill page.
    const newest = all[all.length - 1]!;
    const newestText = [...all].reverse().find((event) => event.type === 'assistant.text')!;
    expect(hook.current!.events.some((event) => event.eventId === newestText.eventId)).toBe(true);
    expect(newest).toBeDefined();

    // Let the window and the backfill run to completion.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull());

    // Backfill pages walk DOWN: each HTTP page's upper bound is below the previous page's.
    const httpPages = daemon.requests.filter((request) => request.via === 'http');
    expect(httpPages.length).toBeGreaterThanOrEqual(2);
    const upperBounds = httpPages.map((request) => request.beforeTs ?? Infinity);
    for (let i = 1; i < upperBounds.length; i += 1) expect(upperBounds[i]!).toBeLessThan(upperBounds[i - 1]!);
    // ...against ONE fixed floor: the cache cursor captured at open, not "the newest cached ts" (the tail moved it).
    const floors = new Set(httpPages.map((request) => request.afterTs));
    expect(floors.size).toBe(1);
    expect([...floors][0]).toBeLessThan(all[99]!.ts);

    // Stitched: every event between the cache and the head is present exactly once, in order.
    const ids = hook.current!.events.map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = all.slice(100).map((event) => event.eventId);
    const missing = expected.filter((id) => !ids.includes(id));
    // The window keeps at most 2000 events (newest first): anything beyond is older than the retained window, never a hole inside it.
    const firstPresent = ids.indexOf(expected[expected.length - 1]!) >= 0 ? Math.min(...expected.filter((id) => ids.includes(id)).map((id) => expected.indexOf(id))) : 0;
    expect(expected.slice(firstPresent).every((id) => ids.includes(id))).toBe(true);
    expect(missing.length).toBe(firstPresent);
    // Rendered order is time order.
    const tsList = hook.current!.events.map((event) => event.ts);
    expect([...tsList].sort((a, b) => a - b)).toEqual(tsList);
  });

  it('records the hole (floor + stitched top) as soon as the newest window proves it, so every window and a reload can resume it', async () => {
    const sessionName = `deck_stale_gap_record_${Date.now()}`;
    const { all, hook } = await openStale(sessionName, 1200, 50);
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    const gap = getTimelineGap(`${SERVER_ID}:${sessionName}`);
    expect(gap).not.toBeNull();
    expect(gap!.lowerTs).toBeLessThan(all[49]!.ts);
    expect(gap!.upperTs).not.toBeNull();
    expect(hook.current!.historyGap).toEqual(gap);
  });

  it('a small gap (less than one page) behaves as before: no peek, one delta, no recorded hole', async () => {
    const sessionName = `deck_stale_small_${Date.now()}`;
    const all = makeSession(sessionName, 130);
    // Cache newest event is fresh (just now): not a stale window.
    const fresh = all.map((event, i) => ({ ...event, ts: Date.now() - (all.length - i) * 10 }));
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionName}`, fresh.slice(0, 120));
    const daemon = makeDaemon(fresh, sessionName);
    installHttp(fresh, daemon.requests);
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(daemon.requests.some((request) => request.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT)).toBe(false);
    expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull();
    expect(hook.current!.historyGap).toBeNull();
    expect(hook.current!.events.length).toBe(130);
  });

  it('an old cache with a small gap: the newest window already contains the cursor, so no hole is recorded', async () => {
    const sessionName = `deck_stale_old_small_${Date.now()}`;
    const { all, hook, daemon } = await openStale(sessionName, 160, 150);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull();
    expect(new Set(hook.current!.events.map((event) => event.eventId)).size).toBe(all.length);
    // The peek is harmless here (its messages are already cached or part of the window).
    expect(daemon.requests.filter((request) => request.via === 'http').every((request) => (request.beforeTs ?? Infinity) === Infinity)).toBe(true);
  });

  it('an empty cache asks for the latest window only (no peek, no hole), exactly as today', async () => {
    const sessionName = `deck_stale_empty_${Date.now()}`;
    const all = makeSession(sessionName, 500);
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(daemon.requests.some((request) => request.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT)).toBe(false);
    expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull();
    expect(hook.current!.events.length).toBeGreaterThan(0);
  });

  it('version skew: a daemon that ignores contentFilter answers the peek with a mixed newest-30; everything still stitches', async () => {
    const sessionName = `deck_stale_skew_${Date.now()}`;
    const { all, hook } = await openStale(sessionName, 900, 60, undefined, { ignoreContentFilter: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull());
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(60).every((event) => ids.has(event.eventId))).toBe(true);
  });

  it('resumes a recorded hole from its stitched top after a reload (backfill continues, does not restart)', async () => {
    const sessionName = `deck_stale_resume_${Date.now()}`;
    const all = makeSession(sessionName, 1400);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    // State a reload finds: the cache holds the old block AND the newest block, plus a recorded hole between.
    const oldBlock = all.slice(0, 80);
    const newBlock = all.slice(1000);
    __setTimelineCacheForTests(cacheKey, [...oldBlock, ...newBlock]);
    setTimelineGap(cacheKey, { lowerTs: oldBlock[oldBlock.length - 1]!.ts - 1, upperTs: newBlock[0]!.ts });
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());

    const httpPages = daemon.requests.filter((request) => request.via === 'http');
    // The first page of the resumed backfill starts AT the recorded top, not at the newest event.
    expect(httpPages[0]!.beforeTs).toBe(newBlock[0]!.ts + 1);
    expect(httpPages[0]!.afterTs).toBe(oldBlock[oldBlock.length - 1]!.ts - 1);
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(80).every((event) => ids.has(event.eventId))).toBe(true);
  });

  it('a hidden/minimized window does not run the backfill until it is shown', async () => {
    const sessionName = `deck_stale_hidden_${Date.now()}`;
    const { daemon, hook } = await openStale(sessionName, 1500, 60, { isActiveSession: false, isVisible: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(daemon.requests.filter((request) => request.via === 'http')).toHaveLength(0);
    expect(hook.current!.events.length).toBe(60);
  });

  it('two windows on the same session share one hole and one filler', async () => {
    const sessionName = `deck_stale_two_${Date.now()}`;
    const all = makeSession(sessionName, 1500);
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionName}`, all.slice(0, 60));
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    const first: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    const second: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h('div', null,
      h(Probe, { sessionName, ws: daemon.ws, hook: first }),
      h(Probe, { sessionName, ws: daemon.ws, hook: second })));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull());
    const httpPages = daemon.requests.filter((request) => request.via === 'http');
    // Page upper bounds never repeat: no second filler re-walked the hole.
    const uppers = httpPages.map((request) => request.beforeTs ?? Infinity);
    expect(new Set(uppers).size).toBe(uppers.length);
    expect(first.current!.events.length).toBe(second.current!.events.length);
  });

  it('a page that is unavailable mid-backfill keeps the hole recorded so the next trigger continues from the last stitched page', async () => {
    const sessionName = `deck_stale_fail_${Date.now()}`;
    const all = makeSession(sessionName, 1800);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, all.slice(0, 60));
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    let httpCalls = 0;
    const realImpl = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (...args: unknown[]) => {
      httpCalls += 1;
      // Page 1 (newest window) and page 2 succeed; everything after fails (daemon offline mid-backfill).
      if (httpCalls > 2) return null;
      return (realImpl as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    const gap = getTimelineGap(cacheKey);
    expect(gap).not.toBeNull();
    // Two pages were stitched: the recorded top moved below the first window's oldest event.
    const firstWindowOldest = all[all.length - 1 - (PAGE - 1)]!;
    expect(gap!.upperTs!).toBeLessThan(firstWindowOldest.ts + 1);
    expect(screen.getByTestId('probe')).toBeDefined();
  });
});
