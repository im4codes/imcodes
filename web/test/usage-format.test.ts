import { describe, it, expect } from 'vitest';
import { formatUsageNumber, formatUsageCost, formatUsageSharePercent } from '../src/util/usage-format.js';

describe('formatUsageSharePercent', () => {
  it('rounds a part to its whole-percent share of the total', () => {
    expect(formatUsageSharePercent(25, 100)).toBe('25%');
    expect(formatUsageSharePercent(1, 3)).toBe('33%');
    expect(formatUsageSharePercent(2, 3)).toBe('67%');
  });

  it('reports 0% and 100% at the extremes rather than rounding them away', () => {
    expect(formatUsageSharePercent(0, 100)).toBe('0%');
    expect(formatUsageSharePercent(100, 100)).toBe('100%');
  });

  it('shows a dash instead of NaN/Infinity when there is nothing to divide by', () => {
    expect(formatUsageSharePercent(5, 0)).toBe('—');
    expect(formatUsageSharePercent(0, 0)).toBe('—');
    expect(formatUsageSharePercent(5, -1)).toBe('—');
  });

  it('shows a dash for non-finite input instead of propagating NaN', () => {
    expect(formatUsageSharePercent(NaN, 100)).toBe('—');
    expect(formatUsageSharePercent(5, NaN)).toBe('—');
    expect(formatUsageSharePercent(Infinity, 100)).toBe('—');
  });
});

// Existing formatters, not previously covered by a dedicated test file.
describe('formatUsageNumber', () => {
  it('renders with locale thousands separators', () => {
    expect(formatUsageNumber(1234567)).toBe(new Intl.NumberFormat().format(1234567));
  });
});

describe('formatUsageCost', () => {
  it('converts integer micros to a USD currency string', () => {
    expect(formatUsageCost(1_000_000, 'unknown')).toBe(
      new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(1),
    );
  });

  it('falls back to the unknown label when cost is null', () => {
    expect(formatUsageCost(null, 'unknown')).toBe('unknown');
  });
});
