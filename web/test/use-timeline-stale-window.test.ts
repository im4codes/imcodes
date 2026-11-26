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
  ingestTimelineEventForCache,
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

function makeDaemon(all: TimelineEvent[], sessionName: string, opts: { ignoreContentFilter?: boolean; windowDelayMs?: number; epoch?: number } = {}): FakeDaemon {
  let handler: ((msg: ServerMessage) => void) | null = null;
  let counter = 0;
  const requests: FakeDaemon['requests'] = [];
  const respond = (requestId: string, events: TimelineEvent[], inRangeCount: number, limit: number, delayMs = 0) => {
    const deliver = () => {
      handler?.({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId,
        epoch: opts.epoch ?? 1,
        events,
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: inRangeCount > limit,
      } as ServerMessage);
    };
    if (delayMs > 0) setTimeout(deliver, delayMs); else queueMicrotask(deliver);
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
      respond(requestId, events, total, limit, textOnly ? 0 : (opts.windowDelayMs ?? 0));
      return requestId;
    }),
    sendTimelinePageRequest: vi.fn(() => 'page-x'),
    supportsTimelineProtocolRevision: vi.fn(() => true),
  } as unknown as WsClient;
  return { ws, requests, emit: (msg) => handler?.(msg) };
}

function installHttp(all: TimelineEvent[], requests: FakeDaemon['requests'], delayMs = 0) {
  fetchSpy.mockImplementation(async (_serverId: string, _session: string, opts: { afterTs?: number; beforeTs?: number; limit?: number } = {}) => {
    const limit = opts.limit ?? 50;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  async function openStale(sessionName: string, total: number, cachedCount: number, options?: Parameters<typeof useTimeline>[3], daemonOpts?: { ignoreContentFilter?: boolean; windowDelayMs?: number; epoch?: number }) {
    const all = makeSession(sessionName, total).map((event) => (daemonOpts?.epoch ? { ...event, epoch: daemonOpts.epoch } : event));
    // The local cache ends long ago (its newest ts is far in the past relative to "now").
    // The cache was written by an earlier daemon epoch when one is requested (the daemon restarted since).
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionName}`, all.slice(0, cachedCount).map((event) => (daemonOpts?.epoch ? { ...event, epoch: 1 } : event)));
    const daemon = makeDaemon(all, sessionName, daemonOpts);
    installHttp(all, daemon.requests, daemonOpts?.windowDelayMs ?? 0);
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

  it('asks for a text tail when the local cache contains only tool events', async () => {
    const sessionName = `deck_stale_tool_only_${Date.now()}`;
    const now = Date.now();
    const tools = Array.from({ length: 288 }, (_, index) => ({
      eventId: `${sessionName}-tool-${index}`,
      sessionId: sessionName,
      ts: now - 288 + index,
      epoch: 1,
      seq: index + 1,
      source: 'daemon' as const,
      confidence: 'high' as const,
      type: (index === 287 ? 'tool.call' : 'tool.result') as TimelineEvent['type'],
      payload: { toolCallId: `${sessionName}-call-${index}`, output: 'x'.repeat(1024) },
    } satisfies TimelineEvent));
    const text: TimelineEvent = {
      eventId: `${sessionName}-text`,
      sessionId: sessionName,
      ts: now + 1,
      epoch: 1,
      seq: 289,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'latest conversation text' },
    };
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, tools);
    const daemon = makeDaemon([...tools, text], sessionName);
    installHttp([...tools, text], daemon.requests);
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));

    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(daemon.requests[0]).toMatchObject({
      via: 'ws',
      limit: TIMELINE_STALE_WINDOW_TAIL_PEEK_LIMIT,
      filter: TIMELINE_HISTORY_CONTENT_FILTERS.TEXT,
    });
    expect(hook.current!.events.some((event) => event.eventId === text.eventId)).toBe(true);
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
    // Reopen checks the newest window once (anchored at the cached head so it does not re-walk 1000..1399),
    // then resumes the recorded hole right at its stitched top.
    expect(httpPages[0]!.beforeTs).toBeUndefined();
    expect(httpPages[0]!.afterTs).toBe(newBlock[newBlock.length - 1]!.ts - 1);
    expect(httpPages[1]!.beforeTs).toBe(newBlock[0]!.ts + 1);
    expect(httpPages[1]!.afterTs).toBe(oldBlock[oldBlock.length - 1]!.ts - 1);
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
  it('the latest messages are on screen after the peek alone, before the (slower) newest window has answered', async () => {
    const sessionName = `deck_stale_peek_first_${Date.now()}`;
    const { all, daemon, hook } = await openStale(sessionName, 2600, 100, undefined, { windowDelayMs: 800 });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const newestText = [...all].reverse().find((event) => event.type === 'assistant.text')!;
    expect(hook.current!.events.some((event) => event.eventId === newestText.eventId)).toBe(true);
    // Only the cache + the 30 peeked messages so far: the window has not landed yet.
    expect(hook.current!.events.length).toBeLessThan(100 + TIMELINE_STALE_WINDOW_TAIL_PEEK_LIMIT + 5);
    expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull();
    // ...and once the window lands the hole is recognised even though the peek already moved the newest cached ts.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).not.toBeNull();
    expect(daemon.requests[0]!.filter).toBe(TIMELINE_HISTORY_CONTENT_FILTERS.TEXT);
  });

  it('a daemon restart since the cache was written (epoch changed) still yields latest first, then the hole newest→oldest', async () => {
    const sessionName = `deck_stale_epoch_${Date.now()}`;
    const { all, hook } = await openStale(sessionName, 1200, 80, undefined, { epoch: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull());
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(80).every((event) => ids.has(event.eventId))).toBe(true);
  });

  it('a visible sub-session window (not the active session) gets the same treatment', async () => {
    const sessionName = `deck_sub_stale_${Date.now()}`;
    const { all, daemon, hook } = await openStale(sessionName, 1200, 80, { isActiveSession: false, isVisible: true, bootstrapWhenVisible: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(`${SERVER_ID}:${sessionName}`)).toBeNull());
    expect(daemon.requests[0]).toMatchObject({ via: 'ws', filter: TIMELINE_HISTORY_CONTENT_FILTERS.TEXT });
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(80).every((event) => ids.has(event.eventId))).toBe(true);
  });

  /** The daemon's envelope trim: the page comes back short, oldest events dropped, flagged like the real `compactTimelineMessageToBudget`. */
  function trimmedPage(events: TimelineEvent[], dropOldest: number) {
    const kept = events.slice(dropOldest);
    return { events: kept, epoch: 1, hasMore: true, payloadTruncated: true, droppedEvents: dropOldest, truncatedEvents: dropOldest, nextCursor: null };
  }

  it('a payload-trimmed hole page neither closes nor forgets the hole: it stays recorded and the filler resumes and closes it', async () => {
    const sessionName = `deck_stale_trim_mid_${Date.now()}`;
    const all = makeSession(sessionName, 1500);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, all.slice(0, 60));
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    const realImpl = fetchSpy.getMockImplementation()! as (...a: unknown[]) => Promise<{ events: TimelineEvent[] }>;
    let descendingPages = 0;
    let trimmedTop: number | null = null;
    let trimmedPageMax = 0;
    fetchSpy.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { beforeTs?: number };
      const page = await realImpl(...args);
      if (opts.beforeTs === undefined) return page;
      descendingPages += 1;
      // The second hole page is delivered trimmed (150 of 200 events kept) exactly once.
      if (descendingPages === 2 && trimmedTop === null) {
        trimmedTop = opts.beforeTs;
        trimmedPageMax = page.events[page.events.length - 1]!.ts;
        return trimmedPage(page.events, 50);
      }
      return page;
    });
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    // Run until the trimmed page has been served, then look at the hole before any retry can fire.
    for (let i = 0; i < 100 && trimmedTop === null; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(trimmedTop).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const gapAfterTrim = getTimelineGap(cacheKey);
    expect(gapAfterTrim).not.toBeNull();
    // The top never moves below what the trimmed page proved (its dropped events are inside its range).
    expect(gapAfterTrim!.upperTs!).toBeGreaterThanOrEqual(trimmedPageMax);
    expect(hook.current!.historyGap).not.toBeNull();

    // Nothing else restarts the fill: the round's own follow-up does, and closes the hole on complete pages.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(60).every((event) => ids.has(event.eventId))).toBe(true);
    expect(hook.current!.events.length).toBe(ids.size);
  });

  it('a hole page that stays trimmed every time is held a bounded number of times, then the fill descends past it instead of wedging', async () => {
    const sessionName = `deck_stale_trim_wedge_${Date.now()}`;
    const all = makeSession(sessionName, 1200);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, all.slice(0, 60));
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);
    const realImpl = fetchSpy.getMockImplementation()! as (...a: unknown[]) => Promise<{ events: TimelineEvent[] }>;
    let wedgeTop: number | null = null;
    let wedgeFetches = 0;
    fetchSpy.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { beforeTs?: number };
      const page = await realImpl(...args);
      if (opts.beforeTs === undefined) return page;
      if (wedgeTop === null) wedgeTop = opts.beforeTs;
      if (opts.beforeTs === wedgeTop) {
        wedgeFetches += 1;
        return trimmedPage(page.events, 50);
      }
      return page;
    });
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());
    // Refetched more than once (the dropped events were given a chance), but not forever.
    expect(wedgeFetches).toBeGreaterThan(1);
    expect(wedgeFetches).toBeLessThanOrEqual(4);
  });

  it('the first HTTP newest-window page being incomplete AND short still records the hole against a stale cache', async () => {
    const sessionName = `deck_stale_trim_open_${Date.now()}`;
    const all = makeSession(sessionName, 900);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, all.slice(0, 60));
    const daemon = makeDaemon(all, sessionName);
    // The WS window never answers: the HTTP catch-up is the only evidence of the hole.
    (daemon.ws as unknown as { sendTimelineHistoryRequest: unknown }).sendTimelineHistoryRequest = vi.fn(() => 'ws-silent');
    installHttp(all, daemon.requests);
    const realImpl = fetchSpy.getMockImplementation()! as (...a: unknown[]) => Promise<{ events: TimelineEvent[] }>;
    let firstServed = false;
    fetchSpy.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[2] ?? {}) as { beforeTs?: number };
      const page = await realImpl(...args);
      if (!firstServed && opts.beforeTs === undefined) {
        firstServed = true;
        return trimmedPage(page.events, 60); // 140 events: incomplete and short
      }
      return page;
    });
    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    for (let i = 0; i < 200 && !firstServed; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(firstServed).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const gap = getTimelineGap(cacheKey);
    expect(gap).not.toBeNull();
    expect(gap!.lowerTs).toBeLessThan(all[59]!.ts);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());
    const ids = new Set(hook.current!.events.map((event) => event.eventId));
    expect(all.slice(60).every((event) => ids.has(event.eventId))).toBe(true);
  });

  it('does not flip loading back to true or drop already-received live events when ws reconnects on a cold long-idle server', async () => {
    const sessionName = `deck_cold_reconnect_${Date.now()}`;
    const all = makeSession(sessionName, 10);
    const daemon = makeDaemon(all, sessionName);
    let connected = false;
    const baseWs = daemon.ws;
    const toggleableWs = new Proxy(baseWs, {
      get(target, prop, receiver) {
        if (prop === 'connected') return connected;
        return Reflect.get(target, prop, receiver);
      },
    }) as WsClient;
    installHttp(all, daemon.requests);

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    const view = render(h(Probe, { sessionName, ws: toggleableWs, hook }));

    // A live WS event arrives while IDB/local snapshot is empty.
    act(() => {
      daemon.emit({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `${sessionName}-live-1`,
          sessionId: sessionName,
          ts: 9_999_999,
          epoch: 2,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'live reply before reconnect' },
        },
      } as ServerMessage);
    });
    await waitFor(() => expect(hook.current!.events.some((e) => e.eventId === `${sessionName}-live-1`)).toBe(true));

    // Reconnect completes (ws.connected flips false -> true). Existing events must stay visible without flipping loading=true.
    connected = true;
    view.rerender(h(Probe, { sessionName, ws: { ...toggleableWs, connected: true } as unknown as WsClient, hook }));
    expect(hook.current!.events.some((e) => e.eventId === `${sessionName}-live-1`)).toBe(true);
    expect(hook.current!.loading).toBe(false);
  });

  it('recovers >= 24 text messages via contentFilter=text fallback against an older daemon returning 200 tool calls and does not loop when total text < 24', async () => {
    const sessionName = `deck_old_daemon_tool_flood_${Date.now()}`;
    const texts: TimelineEvent[] = Array.from({ length: 25 }, (_, i) => ({
      eventId: `${sessionName}-txt-${i}`,
      sessionId: sessionName,
      ts: 1_000 + i * 10,
      epoch: 1,
      seq: i + 1,
      source: 'daemon',
      confidence: 'high',
      type: i % 2 === 0 ? 'user.message' : 'assistant.text',
      payload: { text: `message-${i}` },
    }));
    const tools: TimelineEvent[] = Array.from({ length: 220 }, (_, i) => ({
      eventId: `${sessionName}-tool-${i}`,
      sessionId: sessionName,
      ts: 10_000 + i * 10,
      epoch: 1,
      seq: 100 + i,
      source: 'daemon',
      confidence: 'high',
      type: i % 2 === 0 ? 'tool.call' : 'tool.result',
      payload: { tool: 'Read', output: `out-${i}` },
    }));
    const all = [...texts, ...tools];
    const daemon = makeDaemon(all, sessionName);
    installHttp(all, daemon.requests);

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const textRequests = daemon.requests.filter((r) => r.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT);
    expect(textRequests).toHaveLength(1);
    const renderedTexts = hook.current!.events.filter((e) => e.type === 'user.message' || e.type === 'assistant.text');
    expect(renderedTexts.length).toBeGreaterThanOrEqual(24);

    // Now test a session that genuinely has ONLY 3 text messages + 220 tool calls: must NOT loop.
    cleanup();
    const fewSession = `deck_few_text_${Date.now()}`;
    const fewAll = [...texts.slice(0, 3).map((e) => ({ ...e, sessionId: fewSession })), ...tools.map((e) => ({ ...e, sessionId: fewSession }))];
    const fewDaemon = makeDaemon(fewAll, fewSession);
    installHttp(fewAll, fewDaemon.requests);
    const fewHook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    render(h(Probe, { sessionName: fewSession, ws: fewDaemon.ws, hook: fewHook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const fewTextRequests = fewDaemon.requests.filter((r) => r.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT);
    expect(fewTextRequests).toHaveLength(1);
    expect(fewHook.current!.events.filter((e) => e.type === 'user.message' || e.type === 'assistant.text')).toHaveLength(3);
  });

  it('does not cancel an in-flight text peek when a 200-tool history batch arrives first', async () => {
    const sessionName = `deck_peek_race_${Date.now()}`;
    const now = Date.now();
    const cachedTools: TimelineEvent[] = Array.from({ length: 50 }, (_, i) => ({
      eventId: `${sessionName}-old-tool-${i}`,
      sessionId: sessionName,
      ts: now - 3_600_000 + i * 10,
      epoch: 1,
      seq: i + 1,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: { output: `old-${i}` },
    }));
    const texts: TimelineEvent[] = Array.from({ length: 24 }, (_, i) => ({
      eventId: `${sessionName}-txt-${i}`,
      sessionId: sessionName,
      ts: now - 60_000 + i * 10,
      epoch: 1,
      seq: 100 + i,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `reply-${i}` },
    }));
    const newTools: TimelineEvent[] = Array.from({ length: 210 }, (_, i) => ({
      eventId: `${sessionName}-new-tool-${i}`,
      sessionId: sessionName,
      ts: now - 10_000 + i * 10,
      epoch: 1,
      seq: 200 + i,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: { output: `new-${i}` },
    }));
    const all = [...cachedTools, ...texts, ...newTools];
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionName}`, cachedTools);

    let handler: ((msg: ServerMessage) => void) | null = null;
    let counter = 0;
    const requests: Array<{ requestId: string; filter?: string }> = [];
    const ws = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-x'),
      sendTimelineHistoryRequest: vi.fn((_session: string, _limit: number, _afterTs?: number, _beforeTs?: number, _cursor?: unknown, _budget?: number, filter?: string) => {
        counter += 1;
        const requestId = `race-${counter}`;
        requests.push({ requestId, filter });
        return requestId;
      }),
      sendTimelinePageRequest: vi.fn(() => 'page-x'),
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;
    installHttp(all, []);

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const peekReq = requests.find((r) => r.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT);
    const mainReq = requests.find((r) => !r.filter);
    expect(peekReq).toBeDefined();
    expect(mainReq).toBeDefined();

    // Main 200-tool response arrives FIRST with 0 text and hasMore: true.
    act(() => {
      handler!({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: mainReq!.requestId,
        epoch: 1,
        events: newTools.slice(-200),
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: true,
      } as ServerMessage);
    });

    // Delayed text peek arrives AFTER the main window: must still be accepted!
    act(() => {
      handler!({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName,
        requestId: peekReq!.requestId,
        epoch: 1,
        events: texts,
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: false,
      } as ServerMessage);
    });

    await waitFor(() => {
      expect(hook.current!.events.filter((e) => e.type === 'assistant.text')).toHaveLength(24);
    });
  });

  it('recovers latest 24 text messages even when local cache already holds 24 older text messages (peek-race and non-stale paths)', async () => {
    // Subcase A: stale cache holds 24 older texts; in-flight peek must NOT be cancelled when 200 new tools arrive first.
    const sessionA = `deck_old_cache_peek_race_${Date.now()}`;
    const now = Date.now();
    const oldTexts: TimelineEvent[] = Array.from({ length: 24 }, (_, i) => ({
      eventId: `${sessionA}-old-txt-${i}`,
      sessionId: sessionA,
      ts: now - 3_600_000 + i * 10,
      epoch: 1,
      seq: i + 1,
      source: 'daemon',
      confidence: 'high',
      type: i % 2 === 0 ? 'user.message' : 'assistant.text',
      payload: { text: `old-${i}` },
    }));
    const newTexts: TimelineEvent[] = Array.from({ length: 24 }, (_, i) => ({
      eventId: `${sessionA}-new-txt-${i}`,
      sessionId: sessionA,
      ts: now - 60_000 + i * 10,
      epoch: 1,
      seq: 100 + i,
      source: 'daemon',
      confidence: 'high',
      type: i % 2 === 0 ? 'user.message' : 'assistant.text',
      payload: { text: `new-${i}` },
    }));
    const newTools: TimelineEvent[] = Array.from({ length: 210 }, (_, i) => ({
      eventId: `${sessionA}-new-tool-${i}`,
      sessionId: sessionA,
      ts: now - 10_000 + i * 10,
      epoch: 1,
      seq: 200 + i,
      source: 'daemon',
      confidence: 'high',
      type: 'tool.result',
      payload: { output: `tool-${i}` },
    }));

    __setTimelineCacheForTests(`${SERVER_ID}:${sessionA}`, oldTexts);
    let handlerA: ((msg: ServerMessage) => void) | null = null;
    let counterA = 0;
    const requestsA: Array<{ requestId: string; filter?: string }> = [];
    const wsA = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handlerA = next;
        return () => { handlerA = null; };
      },
      sendTimelineReplayRequest: vi.fn(() => 'replay-a'),
      sendTimelineHistoryRequest: vi.fn((_session: string, _limit: number, _afterTs?: number, _beforeTs?: number, _cursor?: unknown, _budget?: number, filter?: string) => {
        counterA += 1;
        const requestId = `race-a-${counterA}`;
        requestsA.push({ requestId, filter });
        return requestId;
      }),
      sendTimelinePageRequest: vi.fn(() => 'page-a'),
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;
    installHttp([...oldTexts, ...newTexts, ...newTools], []);

    const hookA: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName: sessionA, ws: wsA, hook: hookA }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    const peekReqA = requestsA.find((r) => r.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT);
    const mainReqA = requestsA.find((r) => !r.filter);
    expect(peekReqA).toBeDefined();
    expect(mainReqA).toBeDefined();

    act(() => {
      handlerA!({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: sessionA,
        requestId: mainReqA!.requestId,
        epoch: 1,
        events: newTools.slice(-200),
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: true,
      } as ServerMessage);
    });
    act(() => {
      handlerA!({
        type: TIMELINE_MESSAGES.HISTORY,
        sessionName: sessionA,
        requestId: peekReqA!.requestId,
        epoch: 1,
        events: newTexts,
        status: TIMELINE_RESPONSE_STATUS.OK,
        hasMore: true,
      } as ServerMessage);
    });

    await waitFor(() => {
      const ids = new Set(hookA.current!.events.map((e) => e.eventId));
      expect(newTexts.every((t) => ids.has(t.eventId))).toBe(true);
    });

    // Subcase B: fresh cache holds 24 older texts (so no initial peek ran); older daemon returns 200 new tools + hasMore=true.
    cleanup();
    const sessionB = `deck_old_cache_fallback_${Date.now()}`;
    const freshOldTexts = oldTexts.map((e, i) => ({
      ...e,
      eventId: `${sessionB}-old-txt-${i}`,
      sessionId: sessionB,
      ts: now - 5_000 + i * 10,
    }));
    const bNewTexts = newTexts.map((e, i) => ({
      ...e,
      eventId: `${sessionB}-new-txt-${i}`,
      sessionId: sessionB,
      ts: now - 2_000 + i * 10,
    }));
    const bNewTools = newTools.map((e, i) => ({
      ...e,
      eventId: `${sessionB}-new-tool-${i}`,
      sessionId: sessionB,
      ts: now - 1_000 + i * 10,
    }));
    __setTimelineCacheForTests(`${SERVER_ID}:${sessionB}`, freshOldTexts);
    const daemonB = makeDaemon([...freshOldTexts, ...bNewTexts, ...bNewTools], sessionB);
    installHttp([...freshOldTexts, ...bNewTexts, ...bNewTools], daemonB.requests);
    const hookB: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    render(h(Probe, { sessionName: sessionB, ws: daemonB.ws, hook: hookB }));

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(daemonB.requests.filter((r) => r.filter === TIMELINE_HISTORY_CONTENT_FILTERS.TEXT)).toHaveLength(1);
    await waitFor(() => {
      const ids = new Set(hookB.current!.events.map((e) => e.eventId));
      expect(bNewTexts.every((t) => ids.has(t.eventId))).toBe(true);
    });
  });

  it('paginates multi-page backlog to caught_up when pages have per-event truncatedEvents > 0 and droppedEvents === 0', async () => {
    const sessionName = `deck_trimmed_details_paginate_${Date.now()}`;
    const all = makeSession(sessionName, 700);
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    __setTimelineCacheForTests(cacheKey, all.slice(0, 50));
    const daemon = makeDaemon(all, sessionName);
    (daemon.ws as unknown as { sendTimelineHistoryRequest: unknown }).sendTimelineHistoryRequest = vi.fn(() => 'ws-silent');
    fetchSpy.mockImplementation(async (_serverId: string, _session: string, opts: { afterTs?: number; beforeTs?: number; limit?: number } = {}) => {
      const limit = opts.limit ?? 200;
      daemon.requests.push({ via: 'http', limit, afterTs: opts.afterTs, beforeTs: opts.beforeTs });
      const events = serve(all, limit, opts.afterTs, opts.beforeTs);
      // Every page carries per-event detail trimming (payloadTruncated=true, truncatedEvents=33, droppedEvents=0),
      // matching live daemon responses for active sessions.
      return { events, epoch: 1, hasMore: false, payloadTruncated: true, droppedEvents: 0, truncatedEvents: 33, nextCursor: null };
    });

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());

    const httpPages = daemon.requests.filter((r) => r.via === 'http');
    expect(httpPages.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(hook.current!.events.map((e) => e.eventId));
    expect(all.every((e) => ids.has(e.eventId))).toBe(true);
  });

  it('terminates cleanly without 1.5s infinite loop when a short 1-event gap page stays legacy payloadTruncated', async () => {
    const sessionName = `deck_short_incomplete_no_loop_${Date.now()}`;
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    const lowerTs = 1795514603880;
    const stuckEvent: TimelineEvent = {
      eventId: `${sessionName}-stuck`,
      sessionId: sessionName,
      ts: 1795514603881,
      epoch: 1,
      seq: 50,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'stuck-event' },
    };
    const headEvent: TimelineEvent = {
      eventId: `${sessionName}-head`,
      sessionId: sessionName,
      ts: 1795514609000,
      epoch: 1,
      seq: 51,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'head-event' },
    };
    __setTimelineCacheForTests(cacheKey, [headEvent]);
    setTimelineGap(cacheKey, { lowerTs, upperTs: stuckEvent.ts, createdAt: Date.now() });

    const daemon = makeDaemon([stuckEvent, headEvent], sessionName);
    (daemon.ws as unknown as { sendTimelineHistoryRequest: unknown }).sendTimelineHistoryRequest = vi.fn(() => 'ws-silent');
    let holeFetches = 0;
    fetchSpy.mockImplementation(async (_serverId: string, _session: string, opts: { afterTs?: number; beforeTs?: number; limit?: number } = {}) => {
      if (opts.beforeTs !== undefined) {
        holeFetches += 1;
        // Legacy incomplete response with 1 event (< limit) sitting right above lowerTs
        return { events: [stuckEvent], epoch: 1, hasMore: true, payloadTruncated: true, nextCursor: null };
      }
      return { events: [headEvent], epoch: 1, hasMore: false, nextCursor: null };
    });

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());
    expect(holeFetches).toBeGreaterThanOrEqual(2);
    expect(holeFetches).toBeLessThanOrEqual(4);
  });

  it('never lets cross-epoch or seq-gapped live WS events poison forward-history, replay, or HTTP afterTs cursors (while contiguous live events advance)', async () => {
    const sessionName = `deck_live_cursor_poison_${Date.now()}`;
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    const cached: TimelineEvent[] = Array.from({ length: 10 }, (_, i) => ({
      eventId: `${sessionName}-e${i}`,
      sessionId: sessionName,
      ts: 1_000_000 + i * 100,
      epoch: 1,
      seq: i + 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: `cached-${i}` },
    }));
    __setTimelineCacheForTests(cacheKey, cached);

    const historyCalls: Array<{ limit: number; afterTs?: number; cursor?: unknown }> = [];
    const replayCalls: Array<{ afterSeq: number; epoch: number }> = [];
    let handler: ((msg: ServerMessage) => void) | null = null;
    const ws = {
      connected: true,
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
      sendTimelineHistoryRequest: vi.fn((_s: string, limit: number, afterTs?: number, _beforeTs?: number, cursor?: unknown) => {
        historyCalls.push({ limit, afterTs, cursor });
        return `h-${historyCalls.length}`;
      }),
      sendTimelineReplayRequest: vi.fn((_s: string, afterSeq: number, epoch: number) => {
        replayCalls.push({ afterSeq, epoch });
        return `r-${replayCalls.length}`;
      }),
      sendTimelinePageRequest: vi.fn(() => 'p-1'),
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;
    fetchSpy.mockImplementation(async (_srv: string, _s: string, opts: { afterTs?: number; beforeTs?: number; limit?: number } = {}) => {
      historyCalls.push({ limit: opts.limit ?? 200, afterTs: opts.afterTs });
      return { events: [], epoch: 1, hasMore: false, nextCursor: null };
    });

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws, hook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });

    // Boundary check: contiguous live WS event in same epoch (seq 11 == 10 + 1) DOES advance cursor
    act(() => {
      handler?.({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `${sessionName}-contiguous-11`,
          sessionId: sessionName,
          ts: 1_002_000,
          epoch: 1,
          seq: 11,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'contiguous-11' },
        },
      } as ServerMessage);
    });

    // Cross-epoch live WS event (epoch 2, seq 50, 2 hours later) arrives BEFORE reconnect refresh
    act(() => {
      handler?.({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `${sessionName}-epoch2-live`,
          sessionId: sessionName,
          ts: 8_200_000,
          epoch: 2,
          seq: 50,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'epoch2-live', streaming: false },
        },
      } as ServerMessage);
    });

    // Live event renders immediately, yet cursor stays anchored at verified (epoch 1, seq 11)
    await waitFor(() => expect(hook.current!.events.some((e) => e.eventId === `${sessionName}-epoch2-live`)).toBe(true));

    historyCalls.length = 0;
    replayCalls.length = 0;
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(replayCalls[0]).toEqual({ epoch: 1, afterSeq: 11 });
    expect(historyCalls[0]?.cursor).toEqual({ epoch: 1, afterSeq: 11, direction: 'newer' });
    // HTTP tail backfill must NOT anchor at ts=8_200_000 (the unverified epoch-2 live event)
    const httpCalls = fetchSpy.mock.calls.map((c) => c[2] as { afterTs?: number });
    expect(httpCalls[0]?.afterTs).toBe(1_002_000 - 1);

    // Same-epoch seq jump (seq 90 > 11 + 1) also must not advance verified cursor
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    act(() => {
      handler?.({
        type: TIMELINE_MESSAGES.EVENT,
        event: {
          eventId: `${sessionName}-seq-jump`,
          sessionId: sessionName,
          ts: 9_000_000,
          epoch: 1,
          seq: 90,
          source: 'daemon',
          confidence: 'high',
          type: 'assistant.text',
          payload: { text: 'jumped' },
        },
      } as ServerMessage);
    });
    historyCalls.length = 0;
    await act(async () => {
      handler?.({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as ServerMessage);
    });
    expect(historyCalls[0]?.cursor).toEqual({ epoch: 1, afterSeq: 11, direction: 'newer' });

    // Pre-mount live ingest with { live: true } on cold cache also must not poison initial mount cursor
    cleanup();
    const coldSession = `deck_cold_live_ingest_${Date.now()}`;
    ingestTimelineEventForCache({
      eventId: `${coldSession}-live-early`,
      sessionId: coldSession,
      ts: 5_000_000,
      epoch: 3,
      seq: 77,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'early-live' },
    }, SERVER_ID, { live: true });
    const coldCalls: Array<{ cursor?: unknown }> = [];
    const coldWs = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest: vi.fn((_s: string, _l: number, _a?: number, _b?: number, cursor?: unknown) => {
        coldCalls.push({ cursor });
        return 'cold-h-1';
      }),
      supportsTimelineProtocolRevision: vi.fn(() => true),
    } as unknown as WsClient;
    const coldHook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    render(h(Probe, { sessionName: coldSession, ws: coldWs, hook: coldHook }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(coldCalls.filter((c) => c.cursor !== undefined)).toEqual([]);
  });

  it('older persisted TimelineGap never starves fetching the newest window on reopen and widens to bridge new gaps', async () => {
    const sessionName = `deck_old_gap_new_window_${Date.now()}`;
    const cacheKey = `${SERVER_ID}:${sessionName}`;
    // Timeline has 1200 total events:
    // - 0..99: old cached block (before 15:24)
    // - 100..299: old unfinished gap (15:24..15:43)
    // - 300..499: cached up to 16:19
    // - 500..1199: 700 new events missed over 2 hours (16:19..18:07)
    const all = makeSession(sessionName, 1200);
    const oldBlock = all.slice(0, 100);
    const midBlock = all.slice(300, 500);
    __setTimelineCacheForTests(cacheKey, [...oldBlock, ...midBlock]);
    setTimelineGap(cacheKey, {
      lowerTs: oldBlock[oldBlock.length - 1]!.ts - 1,
      upperTs: midBlock[0]!.ts,
      createdAt: Date.now() - 60_000,
    });

    const daemon = makeDaemon(all, sessionName);
    // Simulate WS returning 0 events (e.g. half-open or delayed) so HTTP must recover the newest 2 hours
    (daemon.ws as unknown as { sendTimelineHistoryRequest: unknown }).sendTimelineHistoryRequest = vi.fn(() => 'ws-empty');
    installHttp(all, daemon.requests);

    const hook: { current: ReturnType<typeof useTimeline> | null } = { current: null };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe, { sessionName, ws: daemon.ws, hook }));

    // First HTTP request MUST ask for the newest window (beforeTs === undefined), NOT the 2-hour-old gap!
    await waitFor(() => {
      const httpPages = daemon.requests.filter((r) => r.via === 'http');
      expect(httpPages.length).toBeGreaterThanOrEqual(1);
    });
    const firstHttp = daemon.requests.find((r) => r.via === 'http')!;
    expect(firstHttp.beforeTs).toBeUndefined();
    await waitFor(() => expect(hook.current!.events.some((e) => e.eventId === all[all.length - 1]!.eventId)).toBe(true));

    // Let the widened gap fill to completion — all events from 100..1199 must be stitched cleanly
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    await waitFor(() => expect(getTimelineGap(cacheKey)).toBeNull());

    const ids = new Set(hook.current!.events.map((e) => e.eventId));
    expect(all.every((e) => ids.has(e.eventId))).toBe(true);
    expect(hook.current!.events.length).toBe(all.length);
  });
});
