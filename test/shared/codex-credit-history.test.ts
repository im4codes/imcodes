import { describe, expect, it } from 'vitest';
import {
  deriveCodexCreditConsumptionEvents,
  formatCodexCreditBalance,
  isMeaningfulCodexCreditsPayload,
  type CodexCreditSnapshot,
} from '../../shared/codex-credit-history.js';

describe('formatCodexCreditBalance', () => {
  it('formats a decimal-string balance as a two-decimal dollar amount', () => {
    expect(formatCodexCreditBalance('12.5')).toBe('$12.50');
    expect(formatCodexCreditBalance('0')).toBe('$0.00');
    expect(formatCodexCreditBalance('100')).toBe('$100.00');
  });

  it('shows the infinity glyph for an unlimited account regardless of the reported balance', () => {
    expect(formatCodexCreditBalance('0', true)).toBe('∞');
    expect(formatCodexCreditBalance('99', true)).toBe('∞');
  });

  it('falls back to $0.00 for a missing balance and to the raw string for a non-numeric one', () => {
    expect(formatCodexCreditBalance(undefined)).toBe('$0.00');
    expect(formatCodexCreditBalance(null)).toBe('$0.00');
    expect(formatCodexCreditBalance('not-a-number')).toBe('not-a-number');
  });
});

describe('isMeaningfulCodexCreditsPayload', () => {
  it('accepts a complete credits object', () => {
    expect(isMeaningfulCodexCreditsPayload({ hasCredits: false, unlimited: false, balance: '0' })).toBe(true);
  });

  it('rejects a missing or partial payload', () => {
    expect(isMeaningfulCodexCreditsPayload(undefined)).toBe(false);
    expect(isMeaningfulCodexCreditsPayload(null)).toBe(false);
    expect(isMeaningfulCodexCreditsPayload({ hasCredits: false, unlimited: false })).toBe(false);
    expect(isMeaningfulCodexCreditsPayload({ hasCredits: false, balance: '0' })).toBe(false);
    expect(isMeaningfulCodexCreditsPayload({ hasCredits: 'false', unlimited: false, balance: '0' } as never)).toBe(false);
  });
});

describe('deriveCodexCreditConsumptionEvents', () => {
  const snapshot = (capturedAt: number, balance: string): CodexCreditSnapshot => ({
    capturedAt,
    balance,
    hasCredits: true,
    unlimited: false,
  });

  it('turns a balance decrease between time-adjacent snapshots into one spend event', () => {
    // Newest first, as listCodexCreditSnapshots / the RESPONSE message returns them.
    const events = deriveCodexCreditConsumptionEvents([
      snapshot(3_000, '5.00'),
      snapshot(2_000, '7.50'),
      snapshot(1_000, '10.00'),
    ]);
    expect(events).toEqual([
      { atCapturedAt: 3_000, fromBalance: '7.50', toBalance: '5.00', spent: '2.50' },
      { atCapturedAt: 2_000, fromBalance: '10.00', toBalance: '7.50', spent: '2.50' },
    ]);
  });

  it('never reports a top-up (balance increase) or an unchanged balance as consumption', () => {
    expect(deriveCodexCreditConsumptionEvents([
      snapshot(2_000, '10.00'),
      snapshot(1_000, '5.00'),
    ])).toEqual([]);
    expect(deriveCodexCreditConsumptionEvents([
      snapshot(2_000, '5.00'),
      snapshot(1_000, '5.00'),
    ])).toEqual([]);
  });

  it('skips a pair it cannot parse as numbers rather than throwing', () => {
    expect(deriveCodexCreditConsumptionEvents([
      snapshot(2_000, 'unlimited'),
      snapshot(1_000, '5.00'),
    ])).toEqual([]);
  });

  it('produces no events for zero or one snapshot', () => {
    expect(deriveCodexCreditConsumptionEvents([])).toEqual([]);
    expect(deriveCodexCreditConsumptionEvents([snapshot(1_000, '5.00')])).toEqual([]);
  });
});
