import { describe, expect, it } from 'vitest';
import { HISTORY_GAP_MARKER_KEY, insertHistoryGapMarker, viewItemStartTs } from '../src/components/chat-history-gap.js';

interface Item { key: string; type: string; ts?: number; event?: { ts: number }; toolEvents?: { ts: number }[] }
const marker: Item = { key: HISTORY_GAP_MARKER_KEY, type: 'history-gap' };
const ev = (key: string, ts: number): Item => ({ key, type: 'event', event: { ts } });

describe('insertHistoryGapMarker', () => {
  const items = [ev('a', 100), ev('b', 200), { key: 'blk', type: 'assistant-block', ts: 300 }, ev('c', 900), ev('d', 1000)];

  it('puts the marker between the older cached block and the stitched newest block', () => {
    const out = insertHistoryGapMarker(items, { upperTs: 900 }, marker);
    expect(out.map((item) => item.key)).toEqual(['a', 'b', 'blk', HISTORY_GAP_MARKER_KEY, 'c', 'd']);
  });

  it('returns the very same array when there is no hole to mark (memoised consumers stay put)', () => {
    expect(insertHistoryGapMarker(items, null, marker)).toBe(items);
    expect(insertHistoryGapMarker(items, { upperTs: null }, marker)).toBe(items);
    expect(insertHistoryGapMarker([], { upperTs: 5 }, marker)).toEqual([]);
  });

  it('sits at the top when everything listed is already part of the newest block', () => {
    const out = insertHistoryGapMarker(items, { upperTs: 50 }, marker);
    expect(out[0]).toBe(marker);
    expect(out).toHaveLength(items.length + 1);
  });

  it('does not invent a position when nothing at or above the stitched block is listed', () => {
    expect(insertHistoryGapMarker(items, { upperTs: 5000 }, marker)).toBe(items);
  });

  it('positions by the first timestamp of tool groups and skips items that carry none', () => {
    const list: Item[] = [ev('a', 100), { key: 'noTs', type: 'event' }, { key: 'tools', type: 'tool-group', toolEvents: [{ ts: 800 }, { ts: 850 }] }, ev('z', 999)];
    expect(insertHistoryGapMarker(list, { upperTs: 800 }, marker).map((item) => item.key)).toEqual(['a', 'noTs', HISTORY_GAP_MARKER_KEY, 'tools', 'z']);
    expect(viewItemStartTs({ key: 'x', type: 'event' } as Item)).toBeUndefined();
  });

  it('the marker key can never be an event id (reader-anchor capture only looks at event rows)', () => {
    expect(HISTORY_GAP_MARKER_KEY).toBe('history-gap');
  });
});
