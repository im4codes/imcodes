import { describe, expect, it } from 'vitest';
import { itemKeysUnchanged, snapshotItemKeys } from '../src/components/chat-view-item-keys.js';

const items = (...keys: string[]) => keys.map((key) => ({ key }));
const signature = (generation: number, list: Array<{ key: string }>) => `${generation}:${list.map((item) => item.key).join('\u0001')}`;

describe('itemKeysUnchanged', () => {
  it('is false without a previous snapshot, true for identical keys and generation', () => {
    const list = items('a', 'b', 'c');
    expect(itemKeysUnchanged(null, 0, list)).toBe(false);
    expect(itemKeysUnchanged(snapshotItemKeys(0, list), 0, items('a', 'b', 'c'))).toBe(true);
  });

  // Counterexamples: every way the old string signature changed must still register.
  it.each([
    ['generation bump', 1, ['a', 'b', 'c']],
    ['item appended', 0, ['a', 'b', 'c', 'd']],
    ['item removed', 0, ['a', 'b']],
    ['middle key replaced (same length)', 0, ['a', 'x', 'c']],
    ['reordered', 0, ['a', 'c', 'b']],
  ])('detects a change: %s', (_label, generation, keys) => {
    const previous = snapshotItemKeys(0, items('a', 'b', 'c'));
    expect(itemKeysUnchanged(previous, generation as number, items(...(keys as string[])))).toBe(false);
  });

  it('agrees with the old string signature on a randomized sequence of edits', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let list = items(...Array.from({ length: 30 }, (_, i) => `k${i}`));
    let previous = snapshotItemKeys(0, list);
    let previousSignature = signature(0, list);
    let generation = 0;
    for (let step = 0; step < 500; step += 1) {
      const roll = random();
      const next = [...list];
      if (roll < 0.25) next.push({ key: `k${1000 + step}` });
      else if (roll < 0.4 && next.length > 1) next.splice(Math.floor(random() * next.length), 1);
      else if (roll < 0.5) next[Math.floor(random() * next.length)] = { key: `r${step}` };
      else if (roll < 0.55) generation += 1;
      const expectedUnchanged = signature(generation, next) === previousSignature;
      expect(itemKeysUnchanged(previous, generation, next), `step ${step}`).toBe(expectedUnchanged);
      if (!expectedUnchanged) { previous = snapshotItemKeys(generation, next); previousSignature = signature(generation, next); }
      list = next;
    }
  });

  it('is cheaper than building the signature string (2,000 items x 3,000 streaming updates)', () => {
    const list = items(...Array.from({ length: 2_000 }, (_, i) => `event-${i}-some-longer-key-suffix`));
    const previousSnapshot = snapshotItemKeys(0, list);
    const previousSignature = signature(0, list);
    const time = (fn: () => void) => { const t = performance.now(); for (let i = 0; i < 3_000; i += 1) fn(); return performance.now() - t; };
    let sink = 0;
    const oldMs = Math.min(time(() => { sink += signature(0, list) === previousSignature ? 1 : 0; }), time(() => { sink += signature(0, list) === previousSignature ? 1 : 0; }));
    const newMs = Math.min(time(() => { sink += itemKeysUnchanged(previousSnapshot, 0, list) ? 1 : 0; }), time(() => { sink += itemKeysUnchanged(previousSnapshot, 0, list) ? 1 : 0; }));
    console.log(JSON.stringify({ items: 2000, updates: 3000, oldSignatureMs: +oldMs.toFixed(1), inPlaceCompareMs: +newMs.toFixed(1), speedup: +(oldMs / newMs).toFixed(1) }));
    expect(sink).toBeGreaterThan(0);
    expect(newMs).toBeLessThan(oldMs);
  });
});
