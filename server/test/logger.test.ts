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

  it('emits error diagnostics (not "err":{}) while scrubbing the preview token (N4)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn(
      { err: new Error('GET http://127.0.0.1:5173/x?preview_access_token=secretXYZ failed') },
      'preview proxy failed',
    );

    const raw = spy.mock.calls[0][0] as string;
    // (a) observability restored: the error message text reaches the log
    expect(raw).toContain('failed');
    expect(raw).not.toContain('"err":{}');
    // (b) the secret value never reaches the sink
    expect(raw).not.toContain('secretXYZ');
    // (c) err serializes with a structured message field
    const payload = JSON.parse(raw) as { err: { message: string } };
    expect(typeof payload.err.message).toBe('string');
    expect(payload.err.message).toContain('failed');
  });

  // Dedicated NON-preview err-format snapshot: the N4 redact change is GLOBAL —
  // every server `logger.*({ err })` now serializes Error as {name,message,stack}
  // (NOT the old `{}` from Object.entries skipping non-enumerable props), and
  // carries enumerable own props (e.g. a node/undici `code`) through redaction.
  // This mirrors the generic errors logged across non-preview paths
  // (session-mgmt / embedding / passkey), independent of the preview scope.
  it('serializes a generic non-preview Error as {name,message,stack} with enumerable own props (global N4 format)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = Object.assign(new Error('database connection refused'), { code: 'ECONNREFUSED' });
    logger.error({ err, op: 'session.persist' }, 'persist failed');

    const payload = JSON.parse(spy.mock.calls[0][0] as string) as {
      err: { name: string; message: string; stack?: string; code?: string };
      op: string;
    };
    expect(payload.err.name).toBe('Error');
    expect(payload.err.message).toBe('database connection refused');
    expect(typeof payload.err.stack).toBe('string'); // diagnostics preserved, not "err":{}
    expect(payload.err.code).toBe('ECONNREFUSED');    // enumerable own prop carried through
    expect(payload.op).toBe('session.persist');       // sibling context intact
  });
});
