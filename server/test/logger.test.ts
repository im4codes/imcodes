import { describe, it, expect, vi, afterEach } from 'vitest';
import logger from '../src/util/logger.js';

describe('server logger redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts sensitive keys and nested values', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info({
      api_key: 'secret-key',
      nested: {
        authorization: 'Bearer abc',
        ok: 'visible',
      },
    }, 'msg');

    const payload = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload.api_key).toBe('[REDACTED]');
    expect(payload.nested).toEqual({ authorization: '[REDACTED]', ok: 'visible' });
  });

  it('redacts deck-style sensitive values inside arrays', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info({
      values: ['ok', 'deck_0123456789abcdef0123456789abcdef'],
    }, 'msg');

    const payload = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload.values).toEqual(['ok', '[REDACTED]']);
  });
});
