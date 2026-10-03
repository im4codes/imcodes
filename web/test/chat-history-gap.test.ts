import { describe, expect, it } from 'vitest';
import { HISTORY_GAP_MARKER_KEY, insertHistoryGapMarker, placeHistoryGapMarker, viewItemStartTs } from '../src/components/chat-history-gap.js';

interface Item { key: string; type: string; ts?: number; event?: { ts: number }; toolEvents?: { ts: number }[] }
const marker: Item = { key: HISTORY_GAP_MARKER_KEY, type: 'history-gap' };
const ev = (key: string, ts: number): Item => ({ key, type: 'event', event: { ts } });

describe('history gap marker placement', () => {
  const items = [ev('a', 100), ev('b', 200), { key: 'blk', type: 'assistant-block', ts: 300 }, ev('c', 900), ev('d', 1000)];
  const insert = (list: Item[], gap: { upperTs: number | null } | null) => insertHistoryGapMarker(list, placeHistoryGapMarker(list, gap), marker);

  it('puts the marker between the older cached block and the stitched newest block', () => {
    expect(placeHistoryGapMarker(items, { upperTs: 900 })).toEqual({ kind: 'inline', index: 3 });
    expect(insert(items, { upperTs: 900 }).map((item) => item.key)).toEqual(['a', 'b', 'blk', HISTORY_GAP_MARKER_KEY, 'c', 'd']);
  });

  it('returns the very same array when there is no hole to mark (memoised consumers stay put)', () => {
    expect(insert(items, null)).toBe(items);
    expect(insert(items, { upperTs: null })).toBe(items);
    expect(insert([], { upperTs: 5 })).toEqual([]);
  });

  it('is a top-of-list placement (never an inline row) when everything listed already belongs to the newest block', () => {
    expect(placeHistoryGapMarker(items, { upperTs: 50 })).toEqual({ kind: 'above' });
    expect(insert(items, { upperTs: 50 })).toBe(items);
  });

  it('does not invent a position when nothing at or above the stitched block is listed', () => {
    expect(placeHistoryGapMarker(items, { upperTs: 5000 })).toEqual({ kind: 'none' });
  });

  it('positions by the first timestamp of tool groups and skips items that carry none', () => {
    const list: Item[] = [ev('a', 100), { key: 'noTs', type: 'event' }, { key: 'tools', type: 'tool-group', toolEvents: [{ ts: 800 }, { ts: 850 }] }, ev('z', 999)];
    expect(insert(list, { upperTs: 800 }).map((item) => item.key)).toEqual(['a', 'noTs', HISTORY_GAP_MARKER_KEY, 'tools', 'z']);
    expect(viewItemStartTs({ key: 'x', type: 'event' } as Item)).toBeUndefined();
  });

  it('the marker key can never be an event id (reader-anchor capture only looks at event rows)', () => {
    expect(HISTORY_GAP_MARKER_KEY).toBe('history-gap');
  });
});
