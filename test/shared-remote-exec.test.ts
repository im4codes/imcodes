import { describe, it, expect } from 'vitest';
import {
  validateMachineExecFrame,
  encodeEnrollmentTrailer,
  decodeEnrollmentTrailer,
  isRetrySafeOutcome,
  ENROLLMENT_BLOB_MAX_BODY_BYTES,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  REMOTE_EXEC_CORRELATION_ID_MAX,
} from '../shared/remote-exec.js';

describe('validateMachineExecFrame', () => {
  const base = { correlationId: 'c1', idempotencyKey: 'i1', command: 'echo hi' };
  it('accepts a valid frame and ignores unknown/identity fields', () => {
    const r = validateMachineExecFrame({ ...base, shell: 'sh', timeoutMs: 1000, nodeRole: 'full' });
    expect(r.ok).toBe(true);
  });
  it('rejects unknown shell', () => {
    expect(validateMachineExecFrame({ ...base, shell: 'zsh' }).ok).toBe(false);
  });
  it('rejects NaN / negative / non-integer timeout', () => {
    expect(validateMachineExecFrame({ ...base, timeoutMs: NaN }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: -5 }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: 1.5 }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: REMOTE_EXEC_MAX_TIMEOUT_MS + 1 }).ok).toBe(false);
  });
  it('rejects oversized command and correlationId', () => {
    expect(validateMachineExecFrame({ ...base, command: 'x'.repeat(64 * 1024 + 1) }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, correlationId: 'x'.repeat(REMOTE_EXEC_CORRELATION_ID_MAX + 1) }).ok).toBe(false);
  });
  it('rejects missing required fields', () => {
    expect(validateMachineExecFrame({ correlationId: 'c1', command: 'x' }).ok).toBe(false);
    expect(validateMachineExecFrame(null).ok).toBe(false);
  });
});

describe('enrollment blob fixed-footer codec', () => {
  const blob = { serverUrl: 'https://app.im.codes', enrollToken: 'tok_abc123' };
  it('round-trips through an executable-like tail', () => {
    const trailer = encodeEnrollmentTrailer(blob);
    const fakeExe = Buffer.concat([Buffer.alloc(4096, 0x41), trailer]);
    expect(decodeEnrollmentTrailer(fakeExe)).toEqual(blob);
  });
  it('decodes at the maximum body size (boundary is closed)', () => {
    const big = { serverUrl: 'https://a.b', enrollToken: 't'.repeat(ENROLLMENT_BLOB_MAX_BODY_BYTES - 60) };
    const trailer = encodeEnrollmentTrailer(big);
    expect(decodeEnrollmentTrailer(trailer)).toEqual({ serverUrl: 'https://a.b', enrollToken: big.enrollToken });
  });
  it('encoder rejects an over-max body (no size the reader cannot locate)', () => {
    const huge = { serverUrl: 'https://a.b', enrollToken: 't'.repeat(ENROLLMENT_BLOB_MAX_BODY_BYTES) };
    expect(() => encodeEnrollmentTrailer(huge)).toThrow(/too_large/);
  });
  it('rejects fake magic / truncation / wrong version / garbage', () => {
    expect(decodeEnrollmentTrailer(Buffer.from('not a blob at all'))).toBeNull();
    const trailer = encodeEnrollmentTrailer(blob);
    expect(decodeEnrollmentTrailer(trailer.subarray(0, trailer.length - 5))).toBeNull(); // truncated footer
    const badVersion = Buffer.from(trailer); badVersion[badVersion.length - 1] = 9;
    expect(decodeEnrollmentTrailer(badVersion)).toBeNull();
    expect(decodeEnrollmentTrailer(Buffer.concat([encodeEnrollmentTrailer(blob), Buffer.alloc(10, 0)]))).toBeNull(); // garbage after footer
  });
});

describe('outcome union', () => {
  it('only not_dispatched is retry-safe', () => {
    expect(isRetrySafeOutcome('not_dispatched')).toBe(true);
    expect(isRetrySafeOutcome('dispatched_no_result')).toBe(false);
    expect(isRetrySafeOutcome('completed')).toBe(false);
  });
});
