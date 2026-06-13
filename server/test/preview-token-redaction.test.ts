import { describe, it, expect } from 'vitest';
import { redactObject, scrubSensitiveQueryParams, REDACTED } from '../../shared/logging/redact.js';
import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from '../../shared/preview-types.js';

describe('scrubSensitiveQueryParams', () => {
  it('redacts a single preview_access_token value', () => {
    expect(scrubSensitiveQueryParams('https://h/app?preview_access_token=deadbeef')).toBe(
      'https://h/app?preview_access_token=[REDACTED]',
    );
  });

  it('uses the canonical query-param key name', () => {
    const url = `https://h/app?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=SECRET`;
    expect(scrubSensitiveQueryParams(url)).toBe(`https://h/app?${PREVIEW_ACCESS_TOKEN_QUERY_PARAM}=[REDACTED]`);
  });

  it('preserves other params and their order', () => {
    expect(
      scrubSensitiveQueryParams('https://x/app?a=1&preview_access_token=deadbeef&b=2'),
    ).toBe('https://x/app?a=1&preview_access_token=[REDACTED]&b=2');
  });

  it('redacts repeated occurrences', () => {
    expect(
      scrubSensitiveQueryParams('?preview_access_token=one&x=y&preview_access_token=two'),
    ).toBe('?preview_access_token=[REDACTED]&x=y&preview_access_token=[REDACTED]');
  });

  it('redacts an empty value (key=)', () => {
    expect(scrubSensitiveQueryParams('https://h/p?preview_access_token=&b=2')).toBe(
      'https://h/p?preview_access_token=[REDACTED]&b=2',
    );
  });

  it('terminates the value at & # whitespace and quote', () => {
    expect(scrubSensitiveQueryParams('?preview_access_token=abc#frag')).toBe('?preview_access_token=[REDACTED]#frag');
    expect(scrubSensitiveQueryParams('GET ?preview_access_token=abc HTTP')).toBe('GET ?preview_access_token=[REDACTED] HTTP');
    expect(scrubSensitiveQueryParams('"https://h/p?preview_access_token=abc"')).toBe('"https://h/p?preview_access_token=[REDACTED]"');
  });

  it('redacts access_token and token defense-in-depth keys', () => {
    expect(scrubSensitiveQueryParams('?access_token=abc')).toBe('?access_token=[REDACTED]');
    expect(scrubSensitiveQueryParams('?token=abc')).toBe('?token=[REDACTED]');
  });

  it('leaves strings without the key untouched', () => {
    expect(scrubSensitiveQueryParams('https://h/app?a=1&b=2')).toBe('https://h/app?a=1&b=2');
    expect(scrubSensitiveQueryParams('plain text, no query params')).toBe('plain text, no query params');
  });

  it('does not redact a bare key with no =', () => {
    expect(scrubSensitiveQueryParams('see preview_access_token in docs')).toBe('see preview_access_token in docs');
  });
});

describe('redactObject query-param scrubbing', () => {
  it('scrubs a preview_access_token embedded in a url string value', () => {
    expect(redactObject({ url: 'http://h/p?x=1&preview_access_token=SECRET&y=2' })).toEqual({
      url: 'http://h/p?x=1&preview_access_token=[REDACTED]&y=2',
    });
  });

  it('still redacts a sensitive key (access_token) via key-based rule', () => {
    expect(redactObject({ access_token: 'whatever-value' })).toEqual({ access_token: REDACTED });
  });

  it('still redacts a deck_<hex> value via value-based rule', () => {
    expect(redactObject({ note: 'deck_0123456789abcdef0123456789abcdef' })).toEqual({ note: REDACTED });
  });

  it('scrubs nested object string values', () => {
    expect(
      redactObject({ ctx: { msg: 'proxy to http://h/p?preview_access_token=SECRET&q=1' } }),
    ).toEqual({ ctx: { msg: 'proxy to http://h/p?preview_access_token=[REDACTED]&q=1' } });
  });

  it('scrubs array-of-strings values', () => {
    expect(
      redactObject({ urls: ['http://h/a?preview_access_token=t1', 'http://h/b?q=2'] }),
    ).toEqual({ urls: ['http://h/a?preview_access_token=[REDACTED]', 'http://h/b?q=2'] });
  });
});

describe('redactObject camelCase token-key footguns (F1/N5)', () => {
  it('redacts a bare previewAccessToken value (camelCase key)', () => {
    const out = JSON.stringify(redactObject({ previewAccessToken: 'secretXYZ' }));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('secretXYZ');
  });

  it('redacts a bare accessToken value (camelCase key)', () => {
    const out = redactObject({ accessToken: 'secretXYZ' });
    expect(out.accessToken).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('secretXYZ');
  });

  it('does NOT redact safe-by-design token debug keys (no collateral)', () => {
    // tokenId (auth.ts:515) and a hash prefix must stay verbatim — a broad
    // /token/i would wrongly nuke these.
    expect(redactObject({ tokenId: 'abc123', hashPrefix: 'def456' })).toEqual({
      tokenId: 'abc123',
      hashPrefix: 'def456',
    });
  });
});

describe('redactObject Error handling (N4)', () => {
  it('preserves diagnostics from a nested cause Error while scrubbing tokens', () => {
    const err = Object.assign(new Error('x?preview_access_token=t1'), {
      code: 'ECONN',
      cause: new Error('y?token=t2'),
    });
    const out = redactObject({ err });
    const serialized = JSON.stringify(out);

    const redactedErr = out.err as Record<string, unknown>;
    // diagnostics retained
    expect(redactedErr.code).toBe('ECONN');
    expect(redactedErr.message).toContain('x?preview_access_token=');
    const cause = redactedErr.cause as Record<string, unknown>;
    expect(typeof cause.message).toBe('string');
    expect(cause.message as string).toContain('y?token=');
    // tokens scrubbed everywhere
    expect(serialized).not.toContain('t1');
    expect(serialized).not.toContain('t2');
    expect(serialized).toContain(REDACTED);
  });

  it('does not collapse a plain Error to {} (message + stack survive)', () => {
    const out = redactObject({ err: new Error('boom') }) as { err: Record<string, unknown> };
    expect(out.err.message).toBe('boom');
    expect(out.err.name).toBe('Error');
    expect(typeof out.err.stack).toBe('string');
  });
});
