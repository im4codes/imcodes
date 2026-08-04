/**
 * @vitest-environment jsdom
 *
 * Multi-window render isolation.
 *
 * With many sub-session windows open on a low-spec machine the whole browser tab
 * would wedge — unresponsive to the point that even a reload was not serviced.
 * The measured cause was not a loop or a deadlock: every timeline event
 * re-rendered EVERY mounted ChatView, including windows whose own session had
 * received nothing. A benchmark over real components showed a window on an idle
 * session re-rendering once per event delivered to a different session (40/40),
 * so per-event cost scaled with the number of open windows. On a fast machine
 * that is merely wasteful; on a slow one the event queue never drains.
 *
 * This pins the property that makes it O(1): a window whose inputs did not
 * change must not re-render at all.
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';

// Render counter. `useTranslation()` runs once per ChatView body execution, so
// counting it counts ChatView renders — an outer wrapper cannot be used, since
// the wrapper still re-renders even when the memo boundary skips ChatView.
const { translationCalls } = vi.hoisted(() => ({ translationCalls: { n: 0 } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => {
    translationCalls.n++;
    return { t: (key: string) => key.split('.').pop() ?? key };
  },
}));
vi.mock('../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/api.js', () => ({ downloadAttachment: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: () => null,
  usePref: () => ({
    value: false, rawValue: false, loaded: true, loading: false, stale: false,
    error: null, save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import { ChatView } from '../src/components/ChatView.js';

function makeEvent(sessionId: string, seq: number): TimelineEvent {
  return {
    eventId: `${sessionId}-${seq}`,
    type: 'assistant.text',
    sessionId,
    ts: 1000 + seq,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    payload: { text: `chunk ${seq}` },
  } as TimelineEvent;
}

describe('ChatView multi-window render isolation', () => {
  afterEach(() => cleanup());

  /** Render cost of streaming `STREAM` events into session 0 with `windows` open. */
  function measure(windows: number, STREAM = 20): number {
    // Each window shows its own session, as sub-session windows do.
    const lists: TimelineEvent[][] = Array.from({ length: windows }, (_, w) => [makeEvent(`s${w}`, 0)]);
    function App() {
      return (
        <div>
          {Array.from({ length: windows }, (_, k) => (
            <ChatView key={k} events={lists[k]} loading={false} sessionId={`s${k}`} />
          ))}
        </div>
      );
    }
    const { rerender, unmount } = render(<App />);
    act(() => {});
    translationCalls.n = 0;
    // Only session 0 produces events. The parent re-renders each time, which is
    // exactly what a live timeline does.
    for (let i = 1; i <= STREAM; i++) {
      lists[0] = [...lists[0], makeEvent('s0', i)];
      act(() => { rerender(<App />); });
    }
    const cost = translationCalls.n;
    unmount();
    return cost;
  }

  it('keeps per-event cost flat as more windows open', () => {
    // Absolute counts are meaningless (each ChatView render also renders inner
    // components), so compare shapes: cost with 8 windows must stay close to
    // cost with 1. Before the memo boundary it was ~8x, which is what made a
    // low-spec tab stop draining its event queue.
    const one = measure(1);
    const eight = measure(8);

    expect(one).toBeGreaterThan(0);
    expect(
      eight,
      `8 windows cost ${eight} vs ${one} for 1 — idle windows are still re-rendering`,
    ).toBeLessThan(one * 2);
  });

  it('still re-renders a window when its own events change', () => {
    // The isolation must not be so aggressive that real updates are dropped.
    let events: TimelineEvent[] = [makeEvent('s0', 0)];
    function App() {
      return <ChatView events={events} loading={false} sessionId="s0" />;
    }
    const { rerender } = render(<App />);
    act(() => {});
    translationCalls.n = 0;

    events = [...events, makeEvent('s0', 1)];
    act(() => { rerender(<App />); });

    expect(translationCalls.n).toBeGreaterThan(0);
  });
});
