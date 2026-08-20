import { describe, expect, it } from 'vitest';
import { formatByteRate, formatByteSize } from '../src/util/byte-size.js';

describe('byte size and rate formatting', () => {
  it('scales through the units a transfer actually spans', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2.0 KB');
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatByteSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });

  it('refuses to invent a rate it does not have', () => {
    // A fetch reports progress without a size, so there is no rate to show —
    // an em dash is honest where "0 B/s" would read as a stalled transfer.
    expect(formatByteRate(0)).toBe('—');
    expect(formatByteRate(Number.NaN)).toBe('—');
    expect(formatByteRate(-1)).toBe('—');
    expect(formatByteRate(1536)).toBe('1.5 KB/s');
  });

  it('never renders a negative or non-finite size', () => {
    expect(formatByteSize(-5)).toBe('0 B');
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
