import { describe, it, expect, vi, afterEach } from 'vitest';
import logger from '../../worker/src/util/logger.js';

describe('worker logger redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts sensitive keys before writing warn logs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn({
      password: 'super-secret',
      nested: { api_key: 'secret-key' },
    }, 'warn-msg');

    const payload = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.nested).toEqual({ api_key: '[REDACTED]' });
  });
});
