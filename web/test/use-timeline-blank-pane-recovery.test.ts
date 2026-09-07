/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../src/ws-client.js';
import { TimelineDB } from '../src/timeline-db.js';

vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: vi.fn(),
  fetchTimelineTextTailHttp: vi.fn(),
}));

import {
  __resetLocalHistoryPruneStateForTests,
  __resetTimelineCacheForTests,
  useTimeline,
} from '../src/hooks/useTimeline.js';

/**
 * The blank pane, end to end, at the hook boundary.
 *
 * The bounded first-paint window comes back full of legacy last-value signals,
 * so the pane paints with nothing renderable in it. The drain that frees the
 * window runs AFTER that read, and nothing re-reads on its own — so without an
 * explicit re-read the fix only helps the NEXT time the session is opened.
 *
 * This pins the recovery for the mount that is already on screen, with no
 * network at all: `ws` is null and both HTTP helpers are mocked, so the only
 * thing that can turn this pane green is local storage being re-read.
 */

function signal(i: number): TimelineEvent {
  return {
    eventId: `sig-${i}`,
    sessionId: 's',
    ts: 1_000 + i,
    epoch: 1,
    seq: i,
    source: 'daemon',
    confidence: 'high',
    type: 'session.state',
    payload: { state: 'idle' },
  } as unknown as TimelineEvent;
}

function message(text: string): TimelineEvent {
  return {
    eventId: `msg-${text}`,
    sessionId: 's',
    ts: 500,
    epoch: 1,
    seq: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text },
  } as unknown as TimelineEvent;
}

describe('a pane whose window is all signals recovers on the SAME mount', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    __resetLocalHistoryPruneStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-reads after the drain instead of waiting for the next open', async () => {
    const sessionName = 'deck_blank_pane';
    const serverId = 'srv-blank';

    // Model the store, not a call sequence: the bootstrap legitimately reads
    // more than once (scoped key, then the bare-key phase-2 heal), so keying
    // the fixture off call ORDER would be testing the harness.
    const scopedKey = `${serverId}:${sessionName}`;
    // A FULL window. 8 rows would sit under the 300-row retention bound and
    // never exercise the trim that decides which events survive the merge —
    // which is exactly where the stale signals win.
    const starved = Array.from({ length: 300 }, (_, i) => signal(i));
    let windowFreed = false;
    // Record what each scoped read SAW. Asserting on the sequence is robust to
    // how fast the repair lands; asserting "still blank at T milliseconds"
    // would fail precisely because the fix works quickly.
    const reads: string[] = [];
    const getRecent = vi.spyOn(TimelineDB.prototype, 'getRecentEvents')
      .mockImplementation(async (key: string) => {
        if (key !== scopedKey) return [];
        reads.push(windowFreed ? 'freed' : 'starved');
        return windowFreed ? [message('recovered by the drain')] : starved;
      });

    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 8, epoch: 1 });
    vi.spyOn(TimelineDB.prototype, 'memoryOnly', 'get').mockReturnValue(false);
    vi.spyOn(TimelineDB.prototype, 'pruneOldEvents').mockResolvedValue({ deleted: 0, done: true });
    // The drain is what frees the window, so it is what flips the fixture.
    const drain = vi.spyOn(TimelineDB.prototype, 'drainLegacySignals')
      .mockImplementation(async () => {
        windowFreed = true;
        // Production always reports WHICH rows it deleted; the cache evicts
        // exactly those. A mock without them would not exercise the eviction.
        return { deleted: starved.length, done: true, deletedIds: starved.map((e) => e.eventId) };
      });

    function Probe() {
      // No ws: nothing but local storage can populate this pane.
      const { events } = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return h(
        'div',
        { 'data-testid': 'blank-pane' },
        events.filter((e) => e.type === 'assistant.text')
          .map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));

    // Well under the ordinary 5s idle delay: a pane that is already wrong on
    // screen must not have to wait that out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(drain).toHaveBeenCalled();

    // The pane's FIRST look at local storage was the starved window — i.e. it
    // really did paint blank — and a later look saw the freed one.
    expect(reads[0], 'the first paint should have read the starved window').toBe('starved');
    expect(reads, 'the window was never re-read after the drain').toContain('freed');

    // Same mount, no reopen, no network.
    expect(screen.getByTestId('blank-pane').textContent).toBe('recovered by the drain');
    expect(getRecent.mock.calls.filter((call) => call[0] === scopedKey).length)
      .toBeGreaterThan(1);
  });

  it('keeps current signals when the refreshed window carries none', async () => {
    // `getRecentEvents` deliberately returns conversation with an EMPTY signal
    // set when the signals sub-read fails, and a live signal can also arrive
    // between that read and the merge. Evicting "everything absent from the
    // refreshed window" would wipe current state off the UI in both cases.
    // Only the rows the drain actually deleted may be removed.
    const sessionName = 'deck_signal_survives';
    const serverId = 'srv-signal';
    const scopedKey = `${serverId}:${sessionName}`;

    const legacy = Array.from({ length: 300 }, (_, i) => signal(i));
    const live = signal(9_999); // current value, NOT part of the drained batch
    let windowFreed = false;
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents')
      .mockImplementation(async (key: string) => {
        if (key !== scopedKey) return [];
        // After the drain the window carries conversation but NO signals.
        return windowFreed ? [message('back again')] : [...legacy, live];
      });
    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 1, epoch: 1 });
    vi.spyOn(TimelineDB.prototype, 'memoryOnly', 'get').mockReturnValue(false);
    vi.spyOn(TimelineDB.prototype, 'pruneOldEvents').mockResolvedValue({ deleted: 0, done: true });
    vi.spyOn(TimelineDB.prototype, 'drainLegacySignals').mockImplementation(async () => {
      windowFreed = true;
      return { deleted: legacy.length, done: true, deletedIds: legacy.map((e) => e.eventId) };
    });

    function Probe() {
      const { events } = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return h(
        'div',
        { 'data-testid': 'signal-pane' },
        events.map((e) => e.eventId).join(','),
      );
    }

    render(h(Probe));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });

    const rendered = screen.getByTestId('signal-pane').textContent ?? '';
    expect(rendered, 'the conversation did not surface').toContain('msg-back again');
    expect(
      rendered.split(',').includes('sig-9999'),
      'the current signal was evicted even though the drain never deleted it',
    ).toBe(true);
    // The drained legacy rows are gone.
    expect(rendered.split(',').includes('sig-0')).toBe(false);
  });

  it('still evicts drained rows when the refreshed read comes back empty', async () => {
    // A read can legitimately return nothing (transient IDB failure). Bailing
    // out early on that would leave rows we KNOW were deleted sitting in the
    // cache, where they keep occupying the newest-N window.
    const sessionName = 'deck_empty_refresh';
    const serverId = 'srv-empty-refresh';
    const scopedKey = `${serverId}:${sessionName}`;

    const legacy = Array.from({ length: 300 }, (_, i) => signal(i));
    let windowFreed = false;
    vi.spyOn(TimelineDB.prototype, 'getRecentEvents')
      .mockImplementation(async (key: string) => {
        if (key !== scopedKey) return [];
        return windowFreed ? [] : legacy;
      });
    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 1, epoch: 1 });
    vi.spyOn(TimelineDB.prototype, 'memoryOnly', 'get').mockReturnValue(false);
    vi.spyOn(TimelineDB.prototype, 'pruneOldEvents').mockResolvedValue({ deleted: 0, done: true });
    vi.spyOn(TimelineDB.prototype, 'drainLegacySignals').mockImplementation(async () => {
      windowFreed = true;
      return { deleted: legacy.length, done: true, deletedIds: legacy.map((e) => e.eventId) };
    });

    function Probe() {
      const { events } = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return h('div', { 'data-testid': 'empty-refresh-pane' }, String(events.length));
    }

    render(h(Probe));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });

    expect(
      screen.getByTestId('empty-refresh-pane').textContent,
      'rows known to be deleted were left in the cache',
    ).toBe('0');
  });

  it('does not re-read when the drain deleted nothing', async () => {
    const sessionName = 'deck_healthy_pane';
    const serverId = 'srv-healthy';

    const scopedKey = `${serverId}:${sessionName}`;
    const getRecent = vi.spyOn(TimelineDB.prototype, 'getRecentEvents')
      .mockImplementation(async (key: string) => (
        key === scopedKey ? [message('already fine')] : []
      ));
    vi.spyOn(TimelineDB.prototype, 'open').mockResolvedValue();
    vi.spyOn(TimelineDB.prototype, 'getLastSeqAndEpoch').mockResolvedValue({ seq: 1, epoch: 1 });
    vi.spyOn(TimelineDB.prototype, 'memoryOnly', 'get').mockReturnValue(false);
    vi.spyOn(TimelineDB.prototype, 'pruneOldEvents').mockResolvedValue({ deleted: 0, done: true });
    vi.spyOn(TimelineDB.prototype, 'drainLegacySignals').mockResolvedValue({ deleted: 0, done: true });

    function Probe() {
      const { events } = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return h('div', { 'data-testid': 'healthy-pane' }, String(events.length));
    }

    render(h(Probe));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.resolve();
    });

    // A healthy session must not pay for an extra full window read on every
    // sweep — the re-read is strictly a repair path.
    expect(getRecent.mock.calls.filter((call) => call[0] === scopedKey)).toHaveLength(1);
  });
});
