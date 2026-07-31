import { describe, expect, it } from 'vitest';
import { isTransientRequestFailure } from '../../shared/request-failure.js';

describe('isTransientRequestFailure', () => {
  it('recognizes fetch failures and nested socket causes', () => {
    expect(isTransientRequestFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientRequestFailure(new Error('request failed', {
      cause: { code: 'ECONNRESET' },
    }))).toBe(true);
  });

  it('does not classify authentication or application failures as transient transport failures', () => {
    expect(isTransientRequestFailure(new Error('401 unauthorized'))).toBe(false);
    expect(isTransientRequestFailure(new Error('invalid request payload'))).toBe(false);
  });

  it('handles cyclic causes without looping', () => {
    const cyclic: Record<string, unknown> = { message: 'application failure' };
    cyclic.cause = cyclic;
    expect(isTransientRequestFailure(cyclic)).toBe(false);
  });
});
