import { describe, it, expect } from 'vitest';
import { redactObject, isSensitiveKey, isSensitiveValue, REDACTED } from '../../shared/logging/redact.js';

describe('shared redactObject', () => {
  it('detects sensitive keys and values', () => {
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('normal')).toBe(false);
    expect(isSensitiveValue('deck_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isSensitiveValue('plain')).toBe(false);
  });

  it('recursively redacts objects and arrays', () => {
    expect(redactObject({
      authorization: 'Bearer token',
      nested: { ok: 'yes', my_secret: 'x' },
      arr: ['plain', 'deck_0123456789abcdef0123456789abcdef', { password: 'pw' }],
    })).toEqual({
      authorization: REDACTED,
      nested: { ok: 'yes', my_secret: REDACTED },
      arr: ['plain', REDACTED, { password: REDACTED }],
    });
  });
});
