import { DAEMON_MSG } from './daemon-events.js';
import { DAEMON_COMMAND_TYPES } from './daemon-command-types.js';

// Remote-exec / controlled-node protocol shared by daemon (source + controlled
// node), server relay, and the exe build pipeline.
//
// Model: a bound machine ("server" row) is either a FULL daemon (runs local
// agents, can CONTROL other machines) or a passive CONTROLLED node. A controlled
// node can ONLY be controlled and return data — it can never control anything.
// This capability is enforced server-side on the credential's `node_role`, so a
// leaked/extracted controlled-node token is inert for control: the server
// rejects any control API (e.g. /api/machine/exec) from a controlled credential.
//
// Command surface is intentionally minimal: a single one-shot shell command that
// returns captured stdout/stderr/exit code. No interactive PTY, so the controlled
// node needs only child_process (no node-pty) and packages cleanly into a
// self-contained exe.

/** Role of a bound machine. Enforced authoritatively on the server credential. */
export const NODE_ROLE = {
  /** Standard daemon: runs local agents and may control CONTROLLED nodes. */
  FULL: 'full',
  /** Passive node: may only be controlled and return data; controls nothing. */
  CONTROLLED: 'controlled',
} as const;
export type NodeRole = (typeof NODE_ROLE)[keyof typeof NODE_ROLE];

export function isNodeRole(value: unknown): value is NodeRole {
  return value === NODE_ROLE.FULL || value === NODE_ROLE.CONTROLLED;
}

/** Shell used to run a one-shot remote command. Default per-OS resolved by node. */
export const REMOTE_EXEC_SHELLS = ['powershell', 'cmd', 'bash', 'sh'] as const;
export type RemoteExecShell = (typeof REMOTE_EXEC_SHELLS)[number];

export const REMOTE_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const REMOTE_EXEC_MIN_TIMEOUT_MS = 1_000;
export const REMOTE_EXEC_MAX_TIMEOUT_MS = 600_000;
/** Hard cap on captured stdout/stderr each; excess is truncated (flagged). */
export const REMOTE_EXEC_MAX_OUTPUT_BYTES = 1_000_000;
/**
 * A controlled node is considered "online" in DB-backed listings when its last
 * heartbeat is within this window (F1: list presence reads the DB, not per-pod
 * WsBridge). Kept > the daemon heartbeat interval so a healthy node never flaps.
 */
export const MACHINE_PRESENCE_STALENESS_MS = 90_000;
/** Explicit maximum returned by list_machines / GET /api/machines. */
export const MACHINE_LIST_MAX_ITEMS = 200;
/** Envelope input bounds (server is the trust boundary; both ends validate). */
export const REMOTE_EXEC_MAX_COMMAND_BYTES = 64 * 1024;
export const REMOTE_EXEC_MAX_CWD_BYTES = 4096;
export const REMOTE_EXEC_CORRELATION_ID_MAX = 128;
export const REMOTE_EXEC_IDEMPOTENCY_KEY_MAX = 128;
/** Diagnostic error returned by the node; bounded independently from stdout/stderr. */
export const REMOTE_EXEC_MAX_ERROR_BYTES = 4096;
/** Worst-case JSON string escaping can expand each UTF-8 byte to a six-byte \\uXXXX sequence. */
export const MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES =
  (REMOTE_EXEC_MAX_OUTPUT_BYTES * 2 + REMOTE_EXEC_MAX_ERROR_BYTES) * 6 + 4096;

/**
 * End-to-end exec outcome, preserved from node → relay → MCP (never collapsed to
 * `{stdout, stderr, exitCode}`). Only `not_dispatched` is retry-safe;
 * `dispatched_no_result` is INDETERMINATE (the command MAY have run as SYSTEM/root).
 */
export const REMOTE_EXEC_OUTCOMES = [
  'not_dispatched',
  'dispatched_no_result',
  'completed',
  'node_timeout',
  'spawn_error',
] as const;
export type RemoteExecOutcome = (typeof REMOTE_EXEC_OUTCOMES)[number];

/** True for outcomes where the command definitively did NOT run (safe to retry). */
export function isRetrySafeOutcome(outcome: RemoteExecOutcome): boolean {
  return outcome === 'not_dispatched';
}

/** Server → controlled node: run one command locally and return the result. */
export interface RemoteExecRequest {
  /** Correlation id for the pending-RPC round trip. */
  requestId: string;
  command: string;
  /** Omit to use the node's OS default (powershell on Windows, sh elsewhere). */
  shell?: RemoteExecShell;
  cwd?: string;
  timeoutMs?: number;
}

/** Controlled node → server: outcome of a RemoteExecRequest. */
export interface RemoteExecResult {
  requestId: string;
  /** True when the process spawned AND exited (any exit code); false on spawn error/timeout. */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout/stderr hit REMOTE_EXEC_MAX_OUTPUT_BYTES and were cut. */
  truncated?: boolean;
  /** True when the command was killed for exceeding its timeout. */
  timedOut?: boolean;
  durationMs: number;
  /** Populated when ok === false (spawn failure, timeout, unsupported shell). */
  error?: string;
}

/** A controllable machine as surfaced to the source agent (list_machines). */
export interface MachineSummary {
  serverId: string;
  name: string;
  os?: EnrollmentOs;
  online: boolean;
  nodeRole: NodeRole;
  lastSeenMs?: number;
}

export function canonicalMachineOs(value: unknown): EnrollmentOs | undefined {
  return (typeof value === 'string' && (ENROLLMENT_OSES as readonly string[]).includes(value))
    ? value as EnrollmentOs
    : undefined;
}

// ── Enrollment (pre-paired exe) ──────────────────────────────────────────────
//
// The prebuilt controlled-node exe is generic. At download time the server
// appends a small blob to the exe tail carrying the server URL and a one-time,
// short-TTL enrollment token. On first run the exe reads its own tail, redeems
// the token for a persistent controlled-node credential (server_id + token),
// then burns the enrollment token. A leaked installer is therefore only useful
// within the TTL and only for a single claim.

/** Marker delimiting the appended enrollment blob at the exe tail. */
export const ENROLLMENT_BLOB_MAGIC = 'IMCODESENROLLv1';

export interface EnrollmentBlob {
  serverUrl: string;
  enrollToken: string;
}

/** D-A v2 redeem protocol version — explicit, not inferred from optional fields. */
export const ENROLLMENT_REDEEM_VERSION_V2 = 2 as const;

/** Canonical OS vocabulary used by v2 enrollment and artifact selection. */
export const ENROLLMENT_OSES = ['win', 'mac', 'linux'] as const;
export type EnrollmentOs = (typeof ENROLLMENT_OSES)[number];

/**
 * Convert Node's `process.platform` vocabulary to the enrollment wire vocabulary.
 * Unsupported platforms fail closed rather than leaking a value the server cannot
 * bind to a verified artifact.
 */
export function enrollmentOsFromNodePlatform(platform: string): EnrollmentOs {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  throw new Error(`unsupported_enrollment_platform:${platform}`);
}

/** sha256(nodeToken) hex length (lowercase hex, no prefix). */
export const ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN = 64;

/** Node POST body for D-A v2 redeem — all identity fields required. */
export interface EnrollRedeemV2Request {
  version: typeof ENROLLMENT_REDEEM_VERSION_V2;
  enrollToken: string;
  installId: string;
  nodeTokenHash: string;
  hostname: string;
  os: EnrollmentOs;
  arch: string;
}

/** Server response for D-A v2 — MUST NOT include a recoverable raw token. */
export interface EnrollRedeemV2Response {
  serverId: string;
  nodeRole: typeof NODE_ROLE.CONTROLLED;
  refName?: string;
  displayName?: string;
}

export interface EnrollmentTrailerRange {
  blob: EnrollmentBlob;
  /** Absolute byte offset in the executable where the trailer begins. */
  trailerStart: number;
  /** Trailer byte length (JSON body + footer). */
  trailerLength: number;
}

/** Validate a normalized lowercase hex sha256 nodeTokenHash. */
export function isEnrollmentNodeTokenHash(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === ENROLLMENT_NODE_TOKEN_HASH_HEX_LEN
    && /^[0-9a-f]{64}$/.test(value);
}

// ── Enrollment blob fixed-footer framing (D-A / 10.4) ────────────────────────
//
// Layout appended to the prebuilt executable tail:
//   [ body (JSON) | uint32LE bodyLength | MAGIC | uint8 version ]
// The reader takes a bounded tail, checks the trailing version + MAGIC, reads the
// 4-byte length, and slices the body — random-access, no full-file load, and no
// unclosed boundary (the encoder rejects a body the reader could not locate).

export const ENROLLMENT_BLOB_VERSION = 1;
/** Max JSON body bytes the encoder accepts (and the reader can locate). */
export const ENROLLMENT_BLOB_MAX_BODY_BYTES = 32 * 1024;
// ENROLLMENT_BLOB_MAGIC is ASCII, so byte length === code-unit length (avoids a
// top-level Buffer reference so this module stays importable in the browser).
const ENROLLMENT_MAGIC_BYTE_LENGTH = ENROLLMENT_BLOB_MAGIC.length;
/** Bytes to read from the executable tail to locate the blob. */
export const ENROLLMENT_MAX_TRAILER_BYTES =
  ENROLLMENT_BLOB_MAX_BODY_BYTES + ENROLLMENT_MAGIC_BYTE_LENGTH + 4 + 1;

/** Encode the fixed-footer trailer to append to a prebuilt executable. */
export function encodeEnrollmentTrailer(blob: EnrollmentBlob): Buffer {
  const body = Buffer.from(JSON.stringify(blob), 'utf8');
  if (body.length > ENROLLMENT_BLOB_MAX_BODY_BYTES) throw new Error('enrollment_blob_too_large');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  const magic = Buffer.from(ENROLLMENT_BLOB_MAGIC, 'ascii');
  const version = Buffer.from([ENROLLMENT_BLOB_VERSION]);
  return Buffer.concat([body, len, magic, version]);
}

/**
 * Decode the enrollment blob from a bounded executable tail (the last
 * `<= ENROLLMENT_MAX_TRAILER_BYTES` bytes). Returns null if absent/malformed.
 */
export function decodeEnrollmentTrailer(tail: Buffer): EnrollmentBlob | null {
  const decoded = decodeEnrollmentTrailerWithRange(tail);
  return decoded?.blob ?? null;
}

/**
 * Decode the enrollment blob and its exact byte range within the executable.
 * `tailFileOffset` is the absolute file offset of `tail[0]` (defaults to 0 for
 * buffers that start at file origin). Never reads beyond the bounded tail window.
 */
export function decodeEnrollmentTrailerWithRange(
  tail: Buffer,
  tailFileOffset = 0,
): EnrollmentTrailerRange | null {
  const magicLen = ENROLLMENT_MAGIC_BYTE_LENGTH;
  const footerLen = 4 + magicLen + 1;
  if (tail.length < footerLen) return null;
  const version = tail[tail.length - 1];
  if (version !== ENROLLMENT_BLOB_VERSION) return null;
  const magicStart = tail.length - 1 - magicLen;
  if (tail.toString('ascii', magicStart, magicStart + magicLen) !== ENROLLMENT_BLOB_MAGIC) return null;
  const bodyLen = tail.readUInt32LE(magicStart - 4);
  const bodyEnd = magicStart - 4;
  const bodyStart = bodyEnd - bodyLen;
  if (bodyStart < 0 || bodyLen <= 0 || bodyLen > ENROLLMENT_BLOB_MAX_BODY_BYTES) return null;
  const trailerLength = bodyLen + footerLen;
  const trailerStartInTail = bodyStart;
  const trailerStart = tailFileOffset + trailerStartInTail;
  try {
    const parsed = JSON.parse(tail.toString('utf8', bodyStart, bodyEnd)) as Partial<EnrollmentBlob>;
    if (typeof parsed?.serverUrl === 'string' && typeof parsed?.enrollToken === 'string'
      && /^https?:\/\//.test(parsed.serverUrl) && parsed.enrollToken.length > 0) {
      return {
        blob: { serverUrl: parsed.serverUrl.replace(/\/+$/, ''), enrollToken: parsed.enrollToken },
        trailerStart,
        trailerLength,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── MACHINE_EXEC / MACHINE_EXEC_RESULT flat wire envelope + validator (10.5) ──
//
// The wire frame is FLAT: `type` and business fields at the same level. Any
// identity/role field in the frame is IGNORED (the server derives authority from
// the DB). The server is the trust boundary and MUST validate before dispatch.

export interface MachineExecFrame {
  correlationId: string;
  /**
   * Reserved wire-compatibility nonce. The relay owns this value and currently
   * sets it to `correlationId`; it is not a durable deduplication key and MUST
   * NOT be interpreted as an exactly-once or retry guarantee.
   */
  idempotencyKey: string;
  command: string;
  shell?: RemoteExecShell;
  cwd?: string;
  timeoutMs?: number;
}

/** Controlled node → server flat result envelope (without transport identity). */
export interface MachineExecResultFrame {
  correlationId: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs: number;
  error?: string;
}

export type EnvelopeValidation<T> = { ok: true; value: T } | { ok: false; error: string };

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const MACHINE_EXEC_REQUEST_KEYS = new Set([
  'type',
  'correlationId',
  'idempotencyKey',
  'command',
  'shell',
  'cwd',
  'timeoutMs',
]);

/** Validate an inbound MACHINE_EXEC frame (used by BOTH node and server). */
export function validateMachineExecFrame(raw: unknown): EnvelopeValidation<MachineExecFrame> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'not_an_object' };
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!MACHINE_EXEC_REQUEST_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  }
  if (r.type !== DAEMON_COMMAND_TYPES.MACHINE_EXEC) {
    return { ok: false, error: 'invalid_type' };
  }
  const correlationId = r.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length < 1 || correlationId.length > REMOTE_EXEC_CORRELATION_ID_MAX) {
    return { ok: false, error: 'invalid_correlationId' };
  }
  const idempotencyKey = r.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > REMOTE_EXEC_IDEMPOTENCY_KEY_MAX) {
    return { ok: false, error: 'invalid_idempotencyKey' };
  }
  const command = r.command;
  if (typeof command !== 'string' || command.length === 0 || utf8ByteLength(command) > REMOTE_EXEC_MAX_COMMAND_BYTES) {
    return { ok: false, error: 'invalid_command' };
  }
  let shell: RemoteExecShell | undefined;
  if (r.shell !== undefined) {
    if (typeof r.shell !== 'string' || !(REMOTE_EXEC_SHELLS as readonly string[]).includes(r.shell)) {
      return { ok: false, error: 'invalid_shell' };
    }
    shell = r.shell as RemoteExecShell;
  }
  let cwd: string | undefined;
  if (r.cwd !== undefined) {
    if (typeof r.cwd !== 'string' || utf8ByteLength(r.cwd) > REMOTE_EXEC_MAX_CWD_BYTES) {
      return { ok: false, error: 'invalid_cwd' };
    }
    cwd = r.cwd;
  }
  let timeoutMs: number | undefined;
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== 'number' || !Number.isInteger(r.timeoutMs) || r.timeoutMs < REMOTE_EXEC_MIN_TIMEOUT_MS || r.timeoutMs > REMOTE_EXEC_MAX_TIMEOUT_MS) {
      return { ok: false, error: 'invalid_timeoutMs' };
    }
    timeoutMs = r.timeoutMs;
  }
  return { ok: true, value: { correlationId, idempotencyKey, command, shell, cwd, timeoutMs } };
}

const MACHINE_EXEC_RESULT_KEYS = new Set([
  'type',
  'correlationId',
  'ok',
  'exitCode',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
  'durationMs',
  'error',
]);

/**
 * Strictly validate an inbound MACHINE_EXEC_RESULT frame. The canonical `type`
 * is required at the WS boundary; synthetic callers must inject it before using
 * this validator. Identity and unknown fields are rejected rather than silently
 * trusted or relayed.
 */
export function validateMachineExecResultFrame(raw: unknown): EnvelopeValidation<MachineExecResultFrame> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'not_an_object' };
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!MACHINE_EXEC_RESULT_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  }
  if (r.type !== DAEMON_MSG.MACHINE_EXEC_RESULT) {
    return { ok: false, error: 'invalid_type' };
  }
  const correlationId = r.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length < 1 || correlationId.length > REMOTE_EXEC_CORRELATION_ID_MAX) {
    return { ok: false, error: 'invalid_correlationId' };
  }
  if (typeof r.ok !== 'boolean') return { ok: false, error: 'invalid_ok' };
  if (r.exitCode !== null && (typeof r.exitCode !== 'number' || !Number.isSafeInteger(r.exitCode))) {
    return { ok: false, error: 'invalid_exitCode' };
  }
  if (typeof r.stdout !== 'string' || utf8ByteLength(r.stdout) > REMOTE_EXEC_MAX_OUTPUT_BYTES) {
    return { ok: false, error: 'invalid_stdout' };
  }
  if (typeof r.stderr !== 'string' || utf8ByteLength(r.stderr) > REMOTE_EXEC_MAX_OUTPUT_BYTES) {
    return { ok: false, error: 'invalid_stderr' };
  }
  if (r.truncated !== undefined && typeof r.truncated !== 'boolean') {
    return { ok: false, error: 'invalid_truncated' };
  }
  if (r.timedOut !== undefined && typeof r.timedOut !== 'boolean') {
    return { ok: false, error: 'invalid_timedOut' };
  }
  if (typeof r.durationMs !== 'number' || !Number.isSafeInteger(r.durationMs) || r.durationMs < 0) {
    return { ok: false, error: 'invalid_durationMs' };
  }
  if (r.error !== undefined && (typeof r.error !== 'string' || utf8ByteLength(r.error) > REMOTE_EXEC_MAX_ERROR_BYTES)) {
    return { ok: false, error: 'invalid_error' };
  }
  const timedOut = r.timedOut === true;
  const hasErrorField = r.error !== undefined;
  const hasNonEmptyError = typeof r.error === 'string' && r.error.length > 0;
  if (r.ok) {
    if (r.exitCode === null) return { ok: false, error: 'ok_requires_exitCode' };
    if (timedOut) return { ok: false, error: 'ok_forbids_timeout' };
    if (hasErrorField) return { ok: false, error: 'ok_forbids_error' };
  } else {
    if (r.exitCode !== null) return { ok: false, error: 'failure_requires_null_exitCode' };
    if (!hasNonEmptyError) return { ok: false, error: 'failure_requires_error' };
  }
  return {
    ok: true,
    value: {
      correlationId,
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.truncated !== undefined ? { truncated: r.truncated } : {}),
      ...(r.timedOut !== undefined ? { timedOut: r.timedOut } : {}),
      durationMs: r.durationMs,
      ...(r.error !== undefined ? { error: r.error } : {}),
    },
  };
}

export const MACHINE_EXEC_HTTP_PROTOCOL = 'imcodes.machine_exec.http' as const;
export const MACHINE_EXEC_HTTP_ENVELOPE_VERSION = 1 as const;

export const MACHINE_EXEC_HTTP_REASONS = [
  'completed',
  'scoped_auth',
  'invalid_request',
  'target_forbidden',
  'exec_disabled',
  'intent_unavailable',
  'target_unavailable',
  'relay_deadline',
  'node_timeout',
  'spawn_error',
  'invalid_result',
] as const;
export type MachineExecHttpReason = (typeof MACHINE_EXEC_HTTP_REASONS)[number];

export interface MachineExecHttpEnvelope {
  protocol: typeof MACHINE_EXEC_HTTP_PROTOCOL;
  version: typeof MACHINE_EXEC_HTTP_ENVELOPE_VERSION;
  outcome: RemoteExecOutcome;
  reason: MachineExecHttpReason;
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs?: number;
  error?: string;
}

const MACHINE_EXEC_HTTP_RESULT_KEYS = [
  'ok',
  'exitCode',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
  'durationMs',
  'error',
] as const;

export function reasonForRemoteExecOutcome(outcome: RemoteExecOutcome): MachineExecHttpReason {
  if (outcome === 'not_dispatched') return 'target_unavailable';
  if (outcome === 'dispatched_no_result') return 'relay_deadline';
  if (outcome === 'node_timeout') return 'node_timeout';
  if (outcome === 'spawn_error') return 'spawn_error';
  return 'completed';
}

const MACHINE_EXEC_HTTP_PRE_DISPATCH_REASONS = new Set<MachineExecHttpReason>([
  'scoped_auth',
  'invalid_request',
  'target_forbidden',
  'exec_disabled',
  'intent_unavailable',
  'target_unavailable',
]);

function isMachineExecHttpReason(value: unknown): value is MachineExecHttpReason {
  return typeof value === 'string' && (MACHINE_EXEC_HTTP_REASONS as readonly string[]).includes(value);
}

function isRemoteExecOutcome(value: unknown): value is RemoteExecOutcome {
  return typeof value === 'string' && (REMOTE_EXEC_OUTCOMES as readonly string[]).includes(value);
}

function validateMachineExecHttpReasonForOutcome(outcome: RemoteExecOutcome, reason: MachineExecHttpReason): boolean {
  if (outcome === 'not_dispatched') return MACHINE_EXEC_HTTP_PRE_DISPATCH_REASONS.has(reason);
  if (outcome === 'dispatched_no_result') return reason === 'relay_deadline' || reason === 'invalid_result';
  if (outcome === 'node_timeout') return reason === 'node_timeout';
  if (outcome === 'spawn_error') return reason === 'spawn_error';
  return reason === 'completed';
}

function validateMachineExecHttpResultForOutcome(outcome: RemoteExecOutcome, result: MachineExecResultFrame): boolean {
  if (outcome === 'completed') return result.ok === true && result.exitCode !== null && result.timedOut === false && result.error === undefined;
  if (outcome === 'node_timeout') return result.ok === false && result.exitCode === null && result.timedOut === true && typeof result.error === 'string' && result.error.length > 0;
  if (outcome === 'spawn_error') return result.ok === false && result.exitCode === null && result.timedOut === false && typeof result.error === 'string' && result.error.length > 0;
  return false;
}

export function encodeMachineExecHttpEnvelope(
  outcome: RemoteExecOutcome,
  result?: RemoteExecResult,
  reason: MachineExecHttpReason = reasonForRemoteExecOutcome(outcome),
): MachineExecHttpEnvelope {
  if (!validateMachineExecHttpReasonForOutcome(outcome, reason)) {
    throw new Error(`invalid_machine_exec_http_reason:${outcome}:${reason}`);
  }
  const normalized = result ? validateMachineExecResultFrame({
    type: DAEMON_MSG.MACHINE_EXEC_RESULT,
    correlationId: 'http-envelope',
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated ?? false,
    timedOut: result.timedOut ?? false,
    durationMs: result.durationMs,
    error: result.error,
  }) : undefined;
  if (result && !normalized?.ok) throw new Error(`invalid_machine_exec_http_result:${normalized?.error}`);
  if (outcome === 'completed' || outcome === 'node_timeout' || outcome === 'spawn_error') {
    if (!normalized?.ok) throw new Error(`missing_machine_exec_http_result:${outcome}`);
    if (!validateMachineExecHttpResultForOutcome(outcome, normalized.value)) {
      throw new Error(`machine_exec_http_result_outcome_mismatch:${outcome}`);
    }
  } else if (result) {
    throw new Error(`forbidden_machine_exec_http_result:${outcome}`);
  }
  return {
    protocol: MACHINE_EXEC_HTTP_PROTOCOL,
    version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
    outcome,
    reason,
    ...(result
      ? {
          ok: result.ok,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut ?? false,
          truncated: result.truncated ?? false,
          durationMs: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        }
      : {}),
  };
}

const MACHINE_EXEC_HTTP_ENVELOPE_KEYS = new Set([
  'protocol',
  'version',
  'outcome',
  'reason',
  'ok',
  'exitCode',
  'stdout',
  'stderr',
  'truncated',
  'timedOut',
  'durationMs',
  'error',
]);

export function decodeMachineExecHttpEnvelope(raw: unknown): EnvelopeValidation<MachineExecHttpEnvelope> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'not_an_object' };
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!MACHINE_EXEC_HTTP_ENVELOPE_KEYS.has(key)) return { ok: false, error: `unknown_field:${key}` };
  }
  if (r.protocol !== MACHINE_EXEC_HTTP_PROTOCOL) return { ok: false, error: 'invalid_protocol' };
  if (r.version !== MACHINE_EXEC_HTTP_ENVELOPE_VERSION) return { ok: false, error: 'invalid_version' };
  if (!isRemoteExecOutcome(r.outcome)) return { ok: false, error: 'invalid_outcome' };
  if (!isMachineExecHttpReason(r.reason)) return { ok: false, error: 'invalid_reason' };
  if (!validateMachineExecHttpReasonForOutcome(r.outcome, r.reason)) return { ok: false, error: 'reason_outcome_mismatch' };
  const hasResult = r.ok !== undefined || r.exitCode !== undefined || r.stdout !== undefined || r.stderr !== undefined
    || r.truncated !== undefined || r.timedOut !== undefined || r.durationMs !== undefined || r.error !== undefined;
  const resultRequired = r.outcome === 'completed' || r.outcome === 'node_timeout' || r.outcome === 'spawn_error';
  if (!resultRequired && hasResult) return { ok: false, error: 'forbidden_result_fields' };
  if (resultRequired && !hasResult) return { ok: false, error: 'missing_result_fields' };
  if (hasResult) {
    for (const key of MACHINE_EXEC_HTTP_RESULT_KEYS) {
      if (r[key] === undefined && key !== 'error') {
        return { ok: false, error: `missing_result_field:${key}` };
      }
    }
    const frame = validateMachineExecResultFrame({
      type: DAEMON_MSG.MACHINE_EXEC_RESULT,
      correlationId: 'http-envelope',
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      error: r.error,
    });
    if (!frame.ok) return { ok: false, error: frame.error };
    if (!validateMachineExecHttpResultForOutcome(r.outcome, frame.value)) {
      return { ok: false, error: 'result_outcome_mismatch' };
    }
  }
  return { ok: true, value: r as unknown as MachineExecHttpEnvelope };
}
