/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

const fetchHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchHistoryMock,
  fetchTimelineTextTailHttp: vi.fn(async () => null),
}));

import type { TimelineEvent } from '../src/ws-client.js';
import {
  __resetTimelineCacheForTests,
  __setTimelineCacheForTests,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';

function event(eventId: string, ts: number, text: string, sessionId = 'deck_pin_context'): TimelineEvent {
  return {
    eventId,
    sessionId,
    ts,
    epoch: 1,
    seq: ts,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text },
  };
}

describe('useTimeline pinned-message context loading', () => {
  beforeEach(() => {
    cleanup();
    __resetTimelineCacheForTests();
    fetchHistoryMock.mockReset();
  });
  afterEach(cleanup);

  it('loads bounded events before and after an old pinned event and merges them into the view', async () => {
    const sessionName = 'deck_pin_context';
    const serverId = 'srv-pin-context';
    ingestTimelineEventForCache(event('recent', 10_000, 'recent'), serverId);
    fetchHistoryMock
      .mockResolvedValueOnce({
        events: [event('before', 990, 'before'), event('anchor', 1_000, 'anchor')],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [event('anchor', 1_000, 'anchor'), event('after', 1_010, 'after')],
        hasMore: false,
      });

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return <div data-testid="events">{timeline.events.map((item) => item.eventId).join('|')}</div>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('events').textContent).toContain('recent'));

    let located = false;
    await act(async () => {
      located = await timeline!.loadMessageContext('anchor', 1_000);
    });
    expect(located).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId('events').textContent).toContain('before|anchor|after');
    });
    expect(fetchHistoryMock).toHaveBeenNthCalledWith(1, serverId, sessionName, expect.objectContaining({ beforeTs: 1_001 }));
    expect(fetchHistoryMock).toHaveBeenNthCalledWith(2, serverId, sessionName, expect.objectContaining({ afterTs: 999 }));
  });

  it('fails closed when the pinned event no longer exists', async () => {
    let timeline: ReturnType<typeof useTimeline> | null = null;
    fetchHistoryMock.mockResolvedValue({ events: [], hasMore: false });
    function Probe() {
      timeline = useTimeline('deck_pin_context', null, 'srv-pin-context', { isActiveSession: false });
      return <div>probe</div>;
    }
    render(<Probe />);
    await act(async () => {
      await expect(timeline!.loadMessageContext('missing', 5_000)).resolves.toBe(false);
    });
  });

  it('keeps an old pinned context beside a full 2000-event recent window', async () => {
    const sessionName = 'deck_pin_context';
    const serverId = 'srv-pin-context';
    const recent = Array.from({ length: 2_000 }, (_, index) => (
      event(`recent-${index}`, 10_000 + index, `recent ${index}`)
    ));
    __setTimelineCacheForTests(`${serverId}:${sessionName}`, recent);
    fetchHistoryMock
      .mockResolvedValueOnce({
        events: [event('old-before', 990, 'before'), event('old-anchor', 1_000, 'anchor')],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        events: [event('old-anchor', 1_000, 'anchor'), event('old-after', 1_010, 'after')],
        hasMore: false,
      });

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, null, serverId, { isActiveSession: false });
      return (
        <div data-testid="events">
          {timeline.events.some((item) => item.eventId === 'old-anchor') ? 'anchor-present' : 'anchor-missing'}
          {'|'}
          {timeline.events.length}
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('events').textContent).toBe('anchor-missing|2000'));

    await act(async () => {
      await expect(timeline!.loadMessageContext('old-anchor', 1_000)).resolves.toBe(true);
    });

    await waitFor(() => expect(screen.getByTestId('events').textContent).toBe('anchor-present|2003'));
  });

  it('does not oscillate when the first window containing a successor is already too dense', async () => {
    const sessionName = 'deck_pin_dense';
    fetchHistoryMock.mockImplementation(async (
      _serverId: string,
      _sessionName: string,
      options: { afterTs?: number; beforeTs?: number },
    ) => {
      if (options.afterTs === undefined) {
        return { events: [event('dense-anchor', 1_000, 'anchor', sessionName)], hasMore: false };
      }
      const upper = options.beforeTs ?? 0;
      if (upper > 220_000) {
        return { events: [event('dense-anchor', 1_000, 'anchor', sessionName)], hasMore: true };
      }
      if (upper > 200_000) {
        return {
          events: [
            event('dense-anchor', 1_000, 'anchor', sessionName),
            event('dense-successor', 200_000, 'successor', sessionName),
          ],
          hasMore: false,
        };
      }
      return { events: [event('dense-anchor', 1_000, 'anchor', sessionName)], hasMore: false };
    });

    let timeline: ReturnType<typeof useTimeline> | null = null;
    function Probe() {
      timeline = useTimeline(sessionName, null, 'srv-pin-context', { isActiveSession: false });
      return <div data-testid="events">{timeline.events.map((item) => item.eventId).join('|')}</div>;
    }
    render(<Probe />);

    await act(async () => {
      await expect(timeline!.loadMessageContext('dense-anchor', 1_000)).resolves.toBe(true);
    });
    await waitFor(() => expect(screen.getByTestId('events').textContent).toContain('dense-anchor|dense-successor'));
    expect(fetchHistoryMock.mock.calls.length).toBeLessThan(10);
  });
});
