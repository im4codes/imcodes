import { describe, expect, it } from 'vitest';
import { mergeSourceIds } from '../../src/store/source-id-merge.js';

describe('mergeSourceIds', () => {
  it('preserves sticky head, dedupes, and caps tail FIFO', () => {
    const prior = Array.from({ length: 205 }, (_, i) => `p${i}`);
    const merged = mergeSourceIds(prior, ['p1', 'n1', 'n2'], 200, 10);
    expect(merged.slice(0, 10)).toEqual(prior.slice(0, 10));
    expect(merged).toHaveLength(200);
    expect(merged).toContain('n1');
    expect(merged).toContain('n2');
    expect(merged.filter((id) => id === 'p1')).toHaveLength(1);
  });
});
