/**
 * @vitest-environment jsdom
 *
 * Referential stability of merged tool events.
 *
 * `buildViewItems` re-runs on every incoming timeline event. It used to rebuild
 * each merged call+result pair as a fresh object, so every already-settled tool
 * call in the history got a new identity on every streamed token and the
 * `ChatEvent` memo missed for the entire visible list.
 *
 * Measured in a CPU-throttled browser (200 rendered items, 100 streamed events):
 *
 *   before   117-126 ChatEvent bodies executed per incoming event
 *   after    2
 *   blocked  56s -> 11s
 *
 * DOM mutations were 3 per event in BOTH cases — the rendered output was always
 * identical, so this never showed up as visible churn. The cost was pure wasted
 * component execution, which is why it only bit slow machines.
 *
 * This pins the property that produced that win.
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineEvent } from '../src/ws-client.js';

const { translationCalls, viewMode } = vi.hoisted(() => ({
  translationCalls: { n: 0 },
  // Developer view renders each tool call as its own ChatEvent (where merged
  // identity is observable); Simple view collapses them into the activity chip
  // (where `_toolFailed` is observable). The two properties need both modes.
  viewMode: { developer: true },
}));
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
    value: viewMode.developer, rawValue: viewMode.developer, loaded: true, loading: false, stale: false,
    error: null, save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import {
  ChatView,
  __buildViewItemsForTests,
  __resetMergedToolEventCacheForTests,
} from '../src/components/ChatView.js';

function toolPair(seq: number): TimelineEvent[] {
  return [
    {
      eventId: `call-${seq}`, type: 'tool.call', sessionId: 's0', ts: 1000 + seq * 2,
      epoch: 1, seq: seq * 2, source: 'daemon', confidence: 'high',
      payload: { tool: 'Read', toolCallId: `c${seq}`, input: { file_path: `/a/${seq}.ts` } },
    },
    {
      eventId: `result-${seq}`, type: 'tool.result', sessionId: 's0', ts: 1001 + seq * 2,
      epoch: 1, seq: seq * 2 + 1, source: 'daemon', confidence: 'high',
      payload: { toolCallId: `c${seq}`, output: `ok ${seq}` },
    },
  ] as TimelineEvent[];
}

function textEvent(seq: number): TimelineEvent {
  return {
    eventId: `text-${seq}`, type: 'assistant.text', sessionId: 's0', ts: 5000 + seq,
    epoch: 1, seq: 1000 + seq, source: 'daemon', confidence: 'high',
    payload: { text: `chunk ${seq}` },
  } as TimelineEvent;
}

describe('merged tool event identity', () => {
  beforeEach(() => {
    __resetMergedToolEventCacheForTests();
    translationCalls.n = 0;
    viewMode.developer = true;
  });
  afterEach(() => cleanup());

  it('returns the identical merged object when the same pair is rebuilt', () => {
    // `buildViewItems` runs again on every incoming event. Settled pairs must
    // come back as the SAME object, or every ChatEvent in view loses its memo.
    const history = Array.from({ length: 5 }, (_, i) => toolPair(i)).flat();

    const first = __buildViewItemsForTests(history, true);
    // A new event arriving does not change any settled pair.
    const second = __buildViewItemsForTests([...history, textEvent(0)], true);

    // Consecutive tool calls collapse into a `tool-group` item, so the merged
    // events live in `toolEvents` rather than on `event`.
    const mergedOf = (items: ReturnType<typeof __buildViewItemsForTests>) => items
      .flatMap((item) => [...(item.toolEvents ?? []), ...(item.event ? [item.event] : [])])
      .filter((event) => event.payload?._merged === true);

    const a = mergedOf(first);
    const b = mergedOf(second);
    expect(a.length).toBe(5);
    expect(b.length).toBe(5);
    for (let i = 0; i < a.length; i++) {
      expect(b[i], `merged pair ${i} was rebuilt as a new object`).toBe(a[i]);
    }
  });

  it('does not hand back a stale merge when the pairing changes', () => {
    const [call, result] = toolPair(0);
    const pickMerged = (items: ReturnType<typeof __buildViewItemsForTests>) => items
      .flatMap((item) => [...(item.toolEvents ?? []), ...(item.event ? [item.event] : [])])
      .find((event) => event.payload?._merged === true);
    const settled = pickMerged(__buildViewItemsForTests([call, result], true));
    expect(settled?.payload._toolFailed).toBe(false);

    const laterResult = {
      ...result, eventId: 'result-0b', payload: { toolCallId: 'c0', error: 'EACCES denied' },
    } as TimelineEvent;
    const reMerged = pickMerged(__buildViewItemsForTests([call, laterResult], true));

    expect(reMerged).not.toBe(settled);
    expect(reMerged?.payload._toolFailed).toBe(true);
    expect(reMerged?.payload._toolError).toBe('EACCES denied');
  });

  it('rebuilds the merged event when its source result actually changes', () => {
    // Stability must not become staleness. The compact tool row does not print
    // the ✗ status text, so assert on something the merged payload actually
    // drives: the Simple-view failure counter, which reads `_toolFailed` off the
    // merged event.
    viewMode.developer = false;
    const [call, result] = toolPair(0);
    const { container, rerender } = render(
      <ChatView events={[call, result]} loading={false} sessionId="s0" />,
    );
    act(() => {});
    expect(container.querySelector('.chat-tool-activity-stat.is-failed')).toBeNull();

    const laterResult = {
      ...result, eventId: 'result-0b', payload: { toolCallId: 'c0', error: 'EACCES denied' },
    } as TimelineEvent;
    rerender(
      <ChatView events={[call, laterResult]} loading={false} sessionId="s0" />,
    );
    act(() => {});

    // A cached-forever merge would keep reporting the old success.
    expect(container.querySelector('.chat-tool-activity-stat.is-failed')?.textContent).toBe('×1');
  });
});
