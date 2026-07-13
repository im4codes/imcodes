import { describe, it, expect } from 'vitest';
import {
  validateMachineExecFrame,
  validateMachineExecResultFrame,
  decodeMachineExecHttpEnvelope,
  encodeMachineExecHttpEnvelope,
  enrollmentOsFromNodePlatform,
  encodeEnrollmentTrailer,
  decodeEnrollmentTrailer,
  decodeEnrollmentTrailerWithRange,
  isRetrySafeOutcome,
  ENROLLMENT_BLOB_MAX_BODY_BYTES,
  ENROLLMENT_MAX_TRAILER_BYTES,
  ENROLLMENT_REDEEM_VERSION_V2,
  ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN,
  isEnrollmentNodeTokenHash,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  REMOTE_EXEC_MAX_ERROR_BYTES,
  REMOTE_EXEC_CORRELATION_ID_MAX,
  MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES,
  MACHINE_EXEC_HTTP_PROTOCOL,
  MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
  MACHINE_LIST_MAX_ITEMS,
  type EnrollRedeemV2Request,
  type EnrollRedeemV2Response,
} from '../shared/remote-exec.js';
import { DAEMON_MSG } from '../shared/daemon-events.js';
import { DAEMON_COMMAND_TYPES } from '../shared/daemon-command-types.js';

describe('validateMachineExecFrame', () => {
  const base = { type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId: 'c1', idempotencyKey: 'i1', command: 'echo hi' };
  it('accepts a valid strict frame', () => {
    const r = validateMachineExecFrame({ ...base, shell: 'sh', timeoutMs: REMOTE_EXEC_MIN_TIMEOUT_MS });
    expect(r.ok).toBe(true);
  });
  it('rejects unknown/identity fields and wrong transport type', () => {
    expect(validateMachineExecFrame({ ...base, nodeRole: 'full' })).toEqual({ ok: false, error: 'unknown_field:nodeRole' });
    expect(validateMachineExecFrame({ ...base, serverId: 'forged' }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, type: 'wrong' }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, type: DAEMON_COMMAND_TYPES.MACHINE_EXEC }).ok).toBe(true);
  });
  it('rejects unknown shell', () => {
    expect(validateMachineExecFrame({ ...base, shell: 'zsh' }).ok).toBe(false);
  });
  it('rejects NaN / below-min / non-integer timeout', () => {
    expect(validateMachineExecFrame({ ...base, timeoutMs: NaN }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: REMOTE_EXEC_MIN_TIMEOUT_MS - 1 }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: 1.5 }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, timeoutMs: REMOTE_EXEC_MAX_TIMEOUT_MS + 1 }).ok).toBe(false);
  });
  it('rejects oversized command and correlationId', () => {
    expect(validateMachineExecFrame({ ...base, command: 'x'.repeat(64 * 1024 + 1) }).ok).toBe(false);
    expect(validateMachineExecFrame({ ...base, correlationId: 'x'.repeat(REMOTE_EXEC_CORRELATION_ID_MAX + 1) }).ok).toBe(false);
  });
  it('rejects missing required fields', () => {
    expect(validateMachineExecFrame({ correlationId: 'c1', idempotencyKey: 'i1', command: 'x' }).ok).toBe(false);
    expect(validateMachineExecFrame({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, correlationId: 'c1', command: 'x' }).ok).toBe(false);
    expect(validateMachineExecFrame([]).ok).toBe(false);
    expect(validateMachineExecFrame(null).ok).toBe(false);
  });
});

describe('validateMachineExecResultFrame', () => {
  const base = {
    type: DAEMON_MSG.MACHINE_EXEC_RESULT,
    correlationId: 'c1',
    ok: true,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 12,
  };

  it('accepts the strict flat result shape and strips the transport type', () => {
    const result = validateMachineExecResultFrame({ ...base, truncated: false, timedOut: false });
    expect(result).toEqual({
      ok: true,
      value: {
        correlationId: 'c1', ok: true, exitCode: 0, stdout: 'ok', stderr: '',
        truncated: false, timedOut: false, durationMs: 12,
      },
    });
  });

  it('rejects unknown and identity-bearing fields', () => {
    expect(validateMachineExecResultFrame({ ...base, serverId: 'forged' })).toEqual({ ok: false, error: 'unknown_field:serverId' });
    expect(validateMachineExecResultFrame({ ...base, nodeRole: 'full' }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, requestId: 'legacy' }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, type: 'wrong' }).ok).toBe(false);
    const { type: _type, ...withoutType } = base;
    expect(validateMachineExecResultFrame(withoutType)).toEqual({ ok: false, error: 'invalid_type' });
  });

  it('requires boolean status and a nullable safe-integer exitCode', () => {
    expect(validateMachineExecResultFrame({ ...base, ok: 'yes' }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, exitCode: null }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, exitCode: 1.5 }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, exitCode: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, truncated: 1 }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, timedOut: 'false' }).ok).toBe(false);
  });

  it('enforces UTF-8 byte caps on stdout, stderr, and error', () => {
    const atOutputCap = 'a'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES);
    expect(validateMachineExecResultFrame({ ...base, stdout: atOutputCap }).ok).toBe(true);
    expect(validateMachineExecResultFrame({ ...base, stdout: `${atOutputCap}a` }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, stderr: '界'.repeat(Math.floor(REMOTE_EXEC_MAX_OUTPUT_BYTES / 3) + 1) }).ok).toBe(false);
    const failure = { ...base, ok: false, exitCode: null, error: 'e'.repeat(REMOTE_EXEC_MAX_ERROR_BYTES) };
    expect(validateMachineExecResultFrame(failure).ok).toBe(true);
    expect(validateMachineExecResultFrame({ ...failure, error: '界'.repeat(Math.floor(REMOTE_EXEC_MAX_ERROR_BYTES / 3) + 1) }).ok).toBe(false);
  });

  it('requires a nonnegative finite safe-integer duration', () => {
    for (const durationMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateMachineExecResultFrame({ ...base, durationMs }).ok).toBe(false);
    }
    expect(validateMachineExecResultFrame({ ...base, durationMs: 0 }).ok).toBe(true);
  });

  it('enforces success, timeout, and spawn/busy cross-field invariants', () => {
    expect(validateMachineExecResultFrame({ ...base, ok: true, exitCode: 0, timedOut: false }).ok).toBe(true);
    expect(validateMachineExecResultFrame({ ...base, ok: true, exitCode: 0, error: '' })).toEqual({ ok: false, error: 'ok_forbids_error' });
    expect(validateMachineExecResultFrame({ ...base, ok: true, exitCode: 0, error: 'unexpected' }).ok).toBe(false);
    expect(validateMachineExecResultFrame({ ...base, ok: true, exitCode: 0, timedOut: true }).ok).toBe(false);
    expect(validateMachineExecResultFrame({
      ...base,
      ok: false,
      exitCode: null,
      timedOut: true,
      error: 'timeout',
    }).ok).toBe(true);
    expect(validateMachineExecResultFrame({
      ...base,
      ok: false,
      exitCode: null,
      timedOut: false,
      error: 'spawn failed',
    }).ok).toBe(true);
    expect(validateMachineExecResultFrame({
      ...base,
      ok: false,
      exitCode: null,
      timedOut: false,
      error: '',
    })).toEqual({ ok: false, error: 'failure_requires_error' });
    expect(validateMachineExecResultFrame({
      ...base,
      ok: false,
      exitCode: null,
      timedOut: false,
    }).ok).toBe(false);
    expect(validateMachineExecResultFrame({
      ...base,
      ok: false,
      exitCode: 1,
      timedOut: false,
      error: 'spawn failed',
    }).ok).toBe(false);
  });
});

describe('canonical enrollment OS vocabulary', () => {
  it('maps Node platforms to v2 wire values and rejects unsupported platforms', () => {
    expect(enrollmentOsFromNodePlatform('win32')).toBe('win');
    expect(enrollmentOsFromNodePlatform('darwin')).toBe('mac');
    expect(enrollmentOsFromNodePlatform('linux')).toBe('linux');
    expect(() => enrollmentOsFromNodePlatform('aix')).toThrow(/unsupported_enrollment_platform/);
  });
});

describe('enrollment blob fixed-footer codec', () => {
  const blob = { serverUrl: 'https://app.im.codes', enrollToken: 'tok_abc123' };
  it('round-trips through an executable-like tail', () => {
    const trailer = encodeEnrollmentTrailer(blob);
    const fakeExe = Buffer.concat([Buffer.alloc(4096, 0x41), trailer]);
    expect(decodeEnrollmentTrailer(fakeExe)).toEqual(blob);
  });
  it('decodeEnrollmentTrailerWithRange returns exact trailer bounds', () => {
    const prefix = Buffer.alloc(4096, 0x41);
    const trailer = encodeEnrollmentTrailer(blob);
    const fakeExe = Buffer.concat([prefix, trailer]);
    const decoded = decodeEnrollmentTrailerWithRange(fakeExe.subarray(4096), 4096);
    expect(decoded?.blob).toEqual(blob);
    expect(decoded?.trailerStart).toBe(4096);
    expect(decoded?.trailerLength).toBe(trailer.length);
    expect(fakeExe.subarray(0, decoded!.trailerStart).equals(prefix)).toBe(true);
  });
  it('ENROLLMENT_MAX_TRAILER_BYTES is never zero', () => {
    expect(ENROLLMENT_MAX_TRAILER_BYTES).toBeGreaterThan(0);
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

describe('machine-exec HTTP envelope', () => {
  it('version-tags completed and non-dispatched outcomes with canonical reasons', () => {
    expect(encodeMachineExecHttpEnvelope('not_dispatched')).toEqual({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'not_dispatched',
      reason: 'target_unavailable',
    });
    expect(encodeMachineExecHttpEnvelope('completed', {
      requestId: 'r1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 5,
    })).toMatchObject({
      version: 1,
      outcome: 'completed',
      reason: 'completed',
      ok: true,
      stdout: 'ok',
      timedOut: false,
      truncated: false,
    });
  });

  it('strictly decodes protocol/version/reason and rejects old or inconsistent envelopes', () => {
    const completed = encodeMachineExecHttpEnvelope('completed', {
      requestId: 'r1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 5,
    });
    expect(decodeMachineExecHttpEnvelope(completed)).toEqual({ ok: true, value: completed });
    expect(decodeMachineExecHttpEnvelope({ ...completed, protocol: 'old' })).toEqual({ ok: false, error: 'invalid_protocol' });
    expect(decodeMachineExecHttpEnvelope({ ...completed, version: 0 })).toEqual({ ok: false, error: 'invalid_version' });
    expect(decodeMachineExecHttpEnvelope({ ...completed, reason: 'target_unavailable' })).toEqual({ ok: false, error: 'reason_outcome_mismatch' });
    expect(decodeMachineExecHttpEnvelope({ ...completed, extra: true })).toEqual({ ok: false, error: 'unknown_field:extra' });
    expect(decodeMachineExecHttpEnvelope({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'not_dispatched',
      reason: 'relay_deadline',
    })).toEqual({ ok: false, error: 'reason_outcome_mismatch' });
    expect(decodeMachineExecHttpEnvelope({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'completed',
      reason: 'completed',
    })).toEqual({ ok: false, error: 'missing_result_fields' });
    expect(decodeMachineExecHttpEnvelope({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'not_dispatched',
      reason: 'target_unavailable',
      ok: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
    })).toEqual({ ok: false, error: 'forbidden_result_fields' });
    const { timedOut: _timedOut, ...missingTimedOut } = completed;
    expect(decodeMachineExecHttpEnvelope(missingTimedOut)).toEqual({ ok: false, error: 'missing_result_field:timedOut' });
    const { truncated: _truncated, ...missingTruncated } = completed;
    expect(decodeMachineExecHttpEnvelope(missingTruncated)).toEqual({ ok: false, error: 'missing_result_field:truncated' });
  });

  it('enforces outcome-to-result cross-field matrix', () => {
    const completedResult = {
      requestId: 'r1',
      ok: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 5,
    };
    const timeoutResult = {
      requestId: 'r1',
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      durationMs: 1000,
      error: 'timeout',
    };
    const spawnResult = {
      requestId: 'r1',
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
      error: 'spawn failed',
    };

    const completed = encodeMachineExecHttpEnvelope('completed', completedResult);
    const timeout = encodeMachineExecHttpEnvelope('node_timeout', timeoutResult);
    const spawn = encodeMachineExecHttpEnvelope('spawn_error', spawnResult);
    expect(decodeMachineExecHttpEnvelope(completed).ok).toBe(true);
    expect(decodeMachineExecHttpEnvelope(timeout).ok).toBe(true);
    expect(decodeMachineExecHttpEnvelope(spawn).ok).toBe(true);

    expect(() => encodeMachineExecHttpEnvelope('node_timeout', spawnResult)).toThrow(/result_outcome_mismatch/);
    expect(() => encodeMachineExecHttpEnvelope('spawn_error', timeoutResult)).toThrow(/result_outcome_mismatch/);
    expect(decodeMachineExecHttpEnvelope({ ...timeout, outcome: 'spawn_error', reason: 'spawn_error' })).toEqual({ ok: false, error: 'result_outcome_mismatch' });
    expect(decodeMachineExecHttpEnvelope({ ...spawn, outcome: 'node_timeout', reason: 'node_timeout' })).toEqual({ ok: false, error: 'result_outcome_mismatch' });
  });

  it('only explicit pre-dispatch reasons can encode not_dispatched', () => {
    expect(encodeMachineExecHttpEnvelope('not_dispatched', undefined, 'invalid_request')).toMatchObject({
      protocol: MACHINE_EXEC_HTTP_PROTOCOL,
      version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
      outcome: 'not_dispatched',
      reason: 'invalid_request',
    });
    expect(() => encodeMachineExecHttpEnvelope('not_dispatched', undefined, 'relay_deadline')).toThrow(/invalid_machine_exec_http_reason/);
  });
});

describe('machine list contract', () => {
  it('has an explicit bounded maximum item count', () => {
    expect(MACHINE_LIST_MAX_ITEMS).toBeGreaterThan(0);
    expect(MACHINE_LIST_MAX_ITEMS).toBeLessThanOrEqual(500);
  });

  it('exports a response byte cap based on worst-case JSON escaping', () => {
    expect(MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES).toBeGreaterThan(REMOTE_EXEC_MAX_OUTPUT_BYTES * 2);
    const worstCase = JSON.stringify({
      stdout: '\u0000'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES),
      stderr: '\u0000'.repeat(REMOTE_EXEC_MAX_OUTPUT_BYTES),
      error: '\u0000'.repeat(REMOTE_EXEC_MAX_ERROR_BYTES),
    });
    expect(Buffer.byteLength(worstCase, 'utf8')).toBeLessThanOrEqual(MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES);
  });
});

describe('D-A v2 enrollment contract', () => {
  it('v2 request requires installId and nodeTokenHash', () => {
    const req: EnrollRedeemV2Request = {
      version: ENROLLMENT_REDEEM_VERSION_V2,
      enrollToken: 'tok',
      installId: 'inst-1',
      nodeTokenHash: 'a'.repeat(ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN),
      hostname: 'box',
      os: 'linux',
      arch: 'x64',
    };
    expect(req.version).toBe(2);
    expect(isEnrollmentNodeTokenHash(req.nodeTokenHash)).toBe(true);
  });

  it('v2 response type excludes a recoverable raw token', () => {
    const res: EnrollRedeemV2Response = {
      serverId: 'srv-1',
      nodeRole: 'controlled',
      refName: 'box-abcd',
    };
    expect(res).not.toHaveProperty('token');
  });
});
