import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));

import { __buildViewItemsForTests, __buildViewItemsTailForTests, __resetIncrementalViewModelCacheForTests } from '../src/components/ChatView';
import { __resetRunKeysForTests, claimRunKey } from '../src/components/chat-run-keys';
import type { TimelineEvent } from '../src/ws-client';

const event = (i: number, type = 'assistant.text', extra: Record<string, unknown> = {}): TimelineEvent => ({
  eventId: `e${i}`, type, ts: 1000 + i, epoch: 1, seq: i, sessionId: 's', source: 'daemon', confidence: 'high',
  payload: { text: `m${i}`, streaming: false, ...extra },
}) as unknown as TimelineEvent;
const run = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => event(from + i));
const keysOf = (events: TimelineEvent[]) => __buildViewItemsForTests(events, true).map((item) => item.key);

describe('merged-run keys stay stable', () => {
  beforeEach(() => { __resetRunKeysForTests(); __resetIncrementalViewModelCacheForTests(); });

  it('a run keeps its key while its oldest events drop out of the retained list', () => {
    const first = keysOf(run(0, 50));
    expect(first).toHaveLength(1);
    // the event cap drops e0, then e1, ... one per appended message
    for (let dropped = 1; dropped <= 20; dropped += 1) {
      expect(keysOf(run(dropped, 50 + dropped))).toEqual(first);
    }
  });

  it('a run cut by the tail derivation window keeps its key as the window slides with every append', () => {
    // runs of 7 assistant messages between user messages; the window edge falls inside a run
    const events = (n: number) => Array.from({ length: n }, (_, i) => event(i, i % 8 === 0 ? 'user.message' : 'assistant.text'));
    const keyOfBlockHolding = (n: number, eventId: string) => __buildViewItemsTailForTests(events(n), true, 60).items
      .find((item) => item.eventIds?.includes(eventId))!.key;
    const before = keyOfBlockHolding(641, 'e310');
    // e310 stays inside the window up to n = 646
    for (let n = 642; n <= 646; n += 1) expect(keyOfBlockHolding(n, 'e310')).toBe(before);
  });

  it('appending to the run (a streaming chunk replaces its event, a new message joins it) keeps the key', () => {
    const base = run(0, 10);
    const key = keysOf(base)[0];
    const growing = [...base.slice(0, 9), event(9, 'assistant.text', { text: 'longer', streaming: true })];
    expect(keysOf(growing)).toEqual([key]);
    expect(keysOf([...growing, event(10)])).toEqual([key]);
    expect(keysOf([...growing.slice(0, 9), event(9, 'assistant.text', { text: 'longer', streaming: false }), event(10)])).toEqual([key]);
  });

  it('a tool call inside the turn splits the run: the part with the original first event keeps the key, the other is a new row', () => {
    const base = run(0, 10);
    const [key] = keysOf(base);
    const split = [...base.slice(0, 5), event(100, 'tool.call', { tool: 'shell', input: 'x', toolCallId: 'c1' }), event(101, 'tool.result', { tool: 'shell', output: 'ok', toolCallId: 'c1' }), ...base.slice(5)]
      .map((e, i) => ({ ...e, ts: 1000 + i, seq: i }) as TimelineEvent);
    const keys = keysOf(split);
    expect(keys[0]).toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(2);
  });

  it('a new message after a user turn is a new row (not a remount of an existing one)', () => {
    const one = keysOf([event(0, 'user.message'), ...run(1, 4)]);
    const two = keysOf([event(0, 'user.message'), ...run(1, 4), event(4, 'user.message'), ...run(5, 7)]);
    expect(two.slice(0, one.length)).toEqual(one);
    expect(two.length).toBe(one.length + 2);
  });

  it('two rows never share a key', () => {
    const used = new Set<string>();
    const a = claimRunKey('assistant-block', 'x', ['x', 'y'], used);
    const b = claimRunKey('assistant-block', 'z', ['y2', 'z'], used);
    expect(a).not.toBe(b);
    // a split: y (remembered under 'x') now starts a separate run
    const used2 = new Set<string>();
    const first = claimRunKey('assistant-block', 'x', ['x'], used2);
    const second = claimRunKey('assistant-block', 'y', ['y'], used2);
    expect(first).toBe('x');
    expect(second).toBe('y');
  });
});
