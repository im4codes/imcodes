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


describe('unchanged completed text does not get recopied on an unrelated tail update', () => {
  it('reuses the display projection without rescanning stable answer text', () => {
    const text = 'stable long answer\n\n\n'.repeat(6_000);
    const events = [event(9000, 'user.message'), event(9001, 'assistant.text', { text })];
    const first = __buildViewItemsForTests(events, true);
    expect(first).toHaveLength(2);
    expect(first[1]?.text).toContain('stable long answer');
    const replace = String.prototype.replace;
    let rescans = 0;
    const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (this: string, ...args: Parameters<typeof replace>) {
      if (String(this).length > 100_000 && String(this).startsWith('stable long answer')) rescans++;
      return replace.apply(this, args);
    });
    try {
      for (let i = 0; i < 3; i++) __buildViewItemsForTests([...events, event(9010 + i, 'tool.call')], true);
    } finally { spy.mockRestore(); }
    expect(rescans).toBe(0);
  });

  it('does not build a full-text signature to stabilize an unchanged row', () => {
    const text = 'stable long answer '.repeat(6_000);
    const events = [event(9100, 'user.message'), event(9101, 'assistant.text', { text })];
    const initial = __buildViewItemsForTests(events, true);
    expect(initial).toHaveLength(2);
    expect(initial[1]?.text).toBe(text.trim());
    const join = Array.prototype.join;
    let signatures = 0;
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: unknown[], separator?: string) {
      if (separator === '|' && this.includes(text.trim())) signatures++;
      return join.call(this, separator);
    });
    try {
      for (let i = 0; i < 3; i++) {
        const next = __buildViewItemsForTests([...events, event(9110 + i, 'tool.call')], true);
        expect(next[1]).toBe(initial[1]);
      }
    } finally { spy.mockRestore(); }
    expect(signatures).toBe(0);
  });
});

describe('incremental item invalidation', () => {
  it('keeps unrelated rows but updates final/streaming and automation', () => {
    const stable = event(9200, 'user.message');
    const row = event(9201, 'assistant.text', { text: 'same answer', streaming: true });
    const before = __buildViewItemsForTests([stable, row], true);
    const final = { ...row, payload: { ...row.payload, streaming: false } };
    const next = __buildViewItemsForTests([stable, final], true);
    expect(next[0]).toBe(before[0]);
    expect(next[1]).not.toBe(before[1]);
    expect(next[1].assistantStreaming).toBe(false);
    const automated = { ...final, payload: { ...final.payload, automation: true } };
    expect(__buildViewItemsForTests([stable, automated], true)[1].assistantAutomation).toBe(true);
    const edited = { ...final, payload: { ...final.payload, text: 'edited answer' } };
    expect(__buildViewItemsForTests([stable, edited], true)[1].text).toBe('edited answer');
    expect(__buildViewItemsForTests([stable, final], true)[1].text).toBe('same answer');
  });

  it('invalidates tool replacement/order and preserves preference boundaries', () => {
    const call = event(9300, 'tool.call', { toolCallId: 'cache-tool', tool: 'shell', input: 'before' });
    const result = event(9301, 'tool.result', { toolCallId: 'cache-tool', tool: 'shell', output: 'before' });
    const initial = __buildViewItemsForTests([call, result], true);
    const replacement = { ...result, payload: { ...result.payload, output: 'after' } };
    const changed = __buildViewItemsForTests([call, replacement], true);
    expect(changed[0]).not.toBe(initial[0]);
    expect(changed[0].event?.payload._resultPayloadOutput).toBe('after');
    const simple = __buildViewItemsForTests([call, replacement], false);
    expect(simple[0].type).toBe('tool-activity');
    const reordered = __buildViewItemsForTests([replacement, call], true);
    expect(reordered[0].toolEvents).toEqual([replacement, call]);
    expect(__buildViewItemsForTests([call, replacement], true)[0].event?.payload._resultPayloadOutput).toBe('after');
  });
});
