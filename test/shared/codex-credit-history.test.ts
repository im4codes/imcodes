import { describe, expect, it } from 'vitest';
import {
  deriveCodexCreditConsumptionEvents,
  formatCodexCreditBalance,
  isMeaningfulCodexCreditsPayload,
  type CodexCreditSnapshot,
} from '../../shared/codex-credit-history.js';

describe('formatCodexCreditBalance', () => {
  // The Codex app-server reports a CREDIT count (the CLI labels it "Balance credits"), not USD:
  // "62500" used to render as "$62500.00" (owner report).
  it('shows a credit count as a grouped integer with no currency symbol', () => {
    expect(formatCodexCreditBalance('62500')).toBe('62,500');
    expect(formatCodexCreditBalance('0')).toBe('0');
    expect(formatCodexCreditBalance('100')).toBe('100');
    expect(formatCodexCreditBalance('999')).toBe('999');
    expect(formatCodexCreditBalance('1000')).toBe('1,000');
    expect(formatCodexCreditBalance('1234567')).toBe('1,234,567');
  });

  it('keeps decimals only when the value has a fractional part', () => {
    expect(formatCodexCreditBalance('12.5')).toBe('12.5');
    expect(formatCodexCreditBalance('12.50')).toBe('12.5');
    expect(formatCodexCreditBalance('12.00')).toBe('12');
    expect(formatCodexCreditBalance('1234.567')).toBe('1,234.567');
    expect(formatCodexCreditBalance('0.25')).toBe('0.25');
    expect(formatCodexCreditBalance('62500.0')).toBe('62,500');
  });

  it('never renders a currency symbol', () => {
    for (const value of ['62500', '12.5', '0', '1e5', 'not-a-number', '']) {
      expect(formatCodexCreditBalance(value)).not.toContain('$');
    }
  });

  it('keeps every digit of a huge count (no float rounding) and handles padding, sign and whitespace', () => {
    expect(formatCodexCreditBalance('123456789012345678901234567890')).toBe('123,456,789,012,345,678,901,234,567,890');
    expect(formatCodexCreditBalance('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(formatCodexCreditBalance('007')).toBe('7');
    expect(formatCodexCreditBalance('000')).toBe('0');
    expect(formatCodexCreditBalance('-1500')).toBe('-1,500');
    expect(formatCodexCreditBalance('-0')).toBe('0');
    expect(formatCodexCreditBalance('  62500 ')).toBe('62,500');
  });

  it('shows the infinity glyph for an unlimited account regardless of the reported balance', () => {
    expect(formatCodexCreditBalance('0', true)).toBe('∞');
    expect(formatCodexCreditBalance('99', true)).toBe('∞');
    expect(formatCodexCreditBalance(undefined, true)).toBe('∞');
  });

  it('shows 0 for a missing or empty balance and passes a non-numeric string through unchanged', () => {
    expect(formatCodexCreditBalance(undefined)).toBe('0');
    expect(formatCodexCreditBalance(null)).toBe('0');
    expect(formatCodexCreditBalance('')).toBe('0');
    expect(formatCodexCreditBalance('not-a-number')).toBe('not-a-number');
  });

  it('formats an exponent form through Number instead of passing it through', () => {
    expect(formatCodexCreditBalance('1e5')).toBe('100,000');
  });

  it('formats a consumption amount the same way (a spend of 2.50 credits is "2.5", of 20.00 is "20")', () => {
    expect(formatCodexCreditBalance('2.50')).toBe('2.5');
    expect(formatCodexCreditBalance('20.00')).toBe('20');
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
