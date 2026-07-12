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
export const REMOTE_EXEC_MAX_TIMEOUT_MS = 600_000;
/** Hard cap on captured stdout/stderr each; excess is truncated (flagged). */
export const REMOTE_EXEC_MAX_OUTPUT_BYTES = 1_000_000;
/**
 * A controlled node is considered "online" in DB-backed listings when its last
 * heartbeat is within this window (F1: list presence reads the DB, not per-pod
 * WsBridge). Kept > the daemon heartbeat interval so a healthy node never flaps.
 */
export const MACHINE_PRESENCE_STALENESS_MS = 90_000;
/** Envelope input bounds (server is the trust boundary; both ends validate). */
export const REMOTE_EXEC_MAX_COMMAND_BYTES = 64 * 1024;
export const REMOTE_EXEC_MAX_CWD_BYTES = 4096;
export const REMOTE_EXEC_CORRELATION_ID_MAX = 128;
export const REMOTE_EXEC_IDEMPOTENCY_KEY_MAX = 128;

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
  os?: string;
  online: boolean;
  nodeRole: NodeRole;
  lastSeenMs?: number;
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

/** Payload a controlled node POSTs to redeem its enrollment token (D-A). */
export interface EnrollRedeemRequest {
  enrollToken: string;
  /** Durable, client-generated id making redemption idempotent across retries (D-A). */
  installId?: string;
  /** sha256(nodeToken) — under D-A the raw nodeToken never leaves the node. */
  nodeTokenHash?: string;
  hostname: string;
  os: string;
}

/**
 * Server response after a successful redeem. Under D-A the node keeps its own
 * client-generated `nodeToken` and the server persists only `nodeTokenHash`;
 * `token` remains for the transitional path where the server still issues one.
 */
export interface EnrollRedeemResponse {
  serverId: string;
  token: string;
  nodeRole: typeof NODE_ROLE.CONTROLLED;
  refName?: string;
  displayName?: string;
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
  try {
    const parsed = JSON.parse(tail.toString('utf8', bodyStart, bodyEnd)) as Partial<EnrollmentBlob>;
    if (typeof parsed?.serverUrl === 'string' && typeof parsed?.enrollToken === 'string'
      && /^https?:\/\//.test(parsed.serverUrl) && parsed.enrollToken.length > 0) {
      return { serverUrl: parsed.serverUrl.replace(/\/+$/, ''), enrollToken: parsed.enrollToken };
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
  idempotencyKey: string;
  command: string;
  shell?: RemoteExecShell;
  cwd?: string;
  timeoutMs?: number;
}

export type EnvelopeValidation<T> = { ok: true; value: T } | { ok: false; error: string };

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Validate an inbound MACHINE_EXEC frame (used by BOTH node and server). */
export function validateMachineExecFrame(raw: unknown): EnvelopeValidation<MachineExecFrame> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not_an_object' };
  const r = raw as Record<string, unknown>;
  const correlationId = r.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length < 1 || correlationId.length > REMOTE_EXEC_CORRELATION_ID_MAX) {
    return { ok: false, error: 'invalid_correlationId' };
  }
  const idempotencyKey = r.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > REMOTE_EXEC_IDEMPOTENCY_KEY_MAX) {
    return { ok: false, error: 'invalid_idempotencyKey' };
  }
  const command = r.command;
  if (typeof command !== 'string' || command.length === 0 || byteLen(command) > REMOTE_EXEC_MAX_COMMAND_BYTES) {
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
    if (typeof r.cwd !== 'string' || byteLen(r.cwd) > REMOTE_EXEC_MAX_CWD_BYTES) {
      return { ok: false, error: 'invalid_cwd' };
    }
    cwd = r.cwd;
  }
  let timeoutMs: number | undefined;
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== 'number' || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > REMOTE_EXEC_MAX_TIMEOUT_MS) {
      return { ok: false, error: 'invalid_timeoutMs' };
    }
    timeoutMs = r.timeoutMs;
  }
  return { ok: true, value: { correlationId, idempotencyKey, command, shell, cwd, timeoutMs } };
}
