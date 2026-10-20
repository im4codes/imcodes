import { describe, expect, it, vi } from 'vitest';
import {
  isPreConnectNetworkError,
  preConnectRetryDelayMs,
  withPreConnectRetry,
} from '../../src/util/pre-connect-retry.js';

function fetchFailed(cause: Error): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause });
}

function connectTimeout(): TypeError {
  return fetchFailed(Object.assign(
    new Error('Connect Timeout Error (attempted address: relay.example:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
  ));
}

describe('isPreConnectNetworkError', () => {
  it.each([
    ['undici connect timeout', connectTimeout()],
    ['DNS EAI_AGAIN', fetchFailed(Object.assign(new Error('getaddrinfo EAI_AGAIN relay.example'), { code: 'EAI_AGAIN' }))],
    ['DNS ENOTFOUND', fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND relay.example'), { code: 'ENOTFOUND' }))],
    ['connection refused', fetchFailed(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
    ['unreachable host', fetchFailed(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }))],
    ['TLS dropped before handshake', fetchFailed(Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' },
    ))],
  ])('classifies %s as pre-connect', (_label, err) => {
    expect(isPreConnectNetworkError(err)).toBe(true);
  });

  it.each([
    ['plain error', new Error('boom')],
    ['size mismatch', new Error('size_mismatch')],
    ['http status error', new Error('relay_fetch_503')],
    ['reset after the request started', fetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))],
    ['abort timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['non-error', 'ECONNREFUSED'],
    ['null', null],
  ])('does not classify %s', (_label, err) => {
    expect(isPreConnectNetworkError(err)).toBe(false);
  });

  it('stops walking a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isPreConnectNetworkError(a)).toBe(false);
  });
});

describe('preConnectRetryDelayMs', () => {
  it('doubles from the base and caps at the maximum', () => {
    expect([1, 2, 3, 4, 5].map((n) => preConnectRetryDelayMs(n, 500, 4_000))).toEqual([500, 1_000, 2_000, 4_000, 4_000]);
  });
});

describe('withPreConnectRetry', () => {
  it('returns after pre-connect failures clear, sleeping with exponential backoff', async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(connectTimeout())
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withPreConnectRetry(op, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000, sleep })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(op.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it('gives up after maxAttempts and rethrows the last pre-connect error', async () => {
    const last = connectTimeout();
    const op = vi.fn().mockRejectedValueOnce(connectTimeout()).mockRejectedValueOnce(last);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withPreConnectRetry(op, { maxAttempts: 2, sleep })).rejects.toBe(last);
    expect(op).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors immediately without retrying', async () => {
    const boom = new Error('relay_fetch_503');
    const op = vi.fn().mockRejectedValue(boom);
    const sleep = vi.fn();
    await expect(withPreConnectRetry(op, { maxAttempts: 5, sleep })).rejects.toBe(boom);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a non-positive maxAttempts as a single attempt', async () => {
    const op = vi.fn().mockRejectedValue(connectTimeout());
    await expect(withPreConnectRetry(op, { maxAttempts: 0, sleep: vi.fn() })).rejects.toThrow('fetch failed');
    expect(op).toHaveBeenCalledTimes(1);
  });
});
