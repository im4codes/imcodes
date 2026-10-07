/**
 * macOS filesystem delegation: how the root controlled node asks the signed aiDesk.to app to touch a path that only the app's
 * TCC identity (Full Disk Access) may touch.
 *
 * The node is a root LaunchDaemon whose binary has no bundle identity, so a Full Disk Access grant for it shows up in System
 * Settings as a bare executable. The remote-desktop app (`to.aidesk.app`) already is the identity the user sees and trusts. The node
 * keeps deciding WHICH paths may be read (the file-preview path policy); the app only supplies the TCC identity, and runs as the
 * user, so it can read nothing a root process could not.
 *
 * Transport: no socket. The node writes a small request file that only root can have created (the helper checks ownership), then
 * runs `aidesk-agent --aidesk-fs-request <file>` in the user's session and reads the answer from stdout.
 *
 * Request file (UTF-8, `key=value` lines; no parser dependency in the native helper):
 *   v=1
 *   op=list
 *   path_hex=<hex of the UTF-8 path>
 *   created_ms=<unix ms>
 *   expires_ms=<unix ms>
 *   nonce=<hex>
 *
 * Answer (stdout, one record per line; names and paths are hex so no byte can break the framing):
 *   IMCODES-FS-V1
 *   realpath <hex>
 *   entry <d|f|o> <hex name>      (list; `o` = neither a regular file nor a directory)
 *   end <entry count> <truncated 0|1>
 * or
 *   IMCODES-FS-V1
 *   error <reason>
 */

import protocol from './macos-fs-delegate.json' with { type: 'json' };

// The values both the TypeScript side and the app's packaging script (scripts/build-aidesk-app.mjs, which cannot import TypeScript)
// need live in macos-fs-delegate.json, the one place they are written.
export const MACOS_FS_DELEGATE_PROTOCOL_VERSION: number = protocol.protocolVersion;
/** Info.plist integer the app carries when it implements this protocol. Absent = an older app: use the node's own reads. */
export const MACOS_FS_DELEGATE_INFO_PLIST_VERSION_KEY: string = protocol.infoPlistVersionKey;
/** Info.plist string: the operations the app implements, space separated. */
export const MACOS_FS_DELEGATE_INFO_PLIST_OPS_KEY: string = protocol.infoPlistOpsKey;

export const MACOS_FS_DELEGATE_OP = {
  LIST: 'list',
} as const;
export type MacosFsDelegateOp = typeof MACOS_FS_DELEGATE_OP[keyof typeof MACOS_FS_DELEGATE_OP];
/** Operations the shipped app implements (what its Info.plist advertises; shared with the packaging script through the JSON). */
export const MACOS_FS_DELEGATE_APP_OPS: readonly string[] = protocol.appOps;
/** Operations this node knows how to request (the app advertises the ones it implements). */
export const MACOS_FS_DELEGATE_NODE_OPS: readonly MacosFsDelegateOp[] = [MACOS_FS_DELEGATE_OP.LIST];

/** The app executable inside the aiDesk bundle, and the flag that makes it answer one request. */
export const MACOS_FS_DELEGATE_REQUEST_FLAG: string = protocol.requestFlag;

/**
 * Where the node writes request files: `<root>/<uid>/<name>.req`. Every directory in the tree is root-owned (0755) and the files are
 * root-owned 0644, so the user the helper runs as can read a request but never create one. Rooted outside the per-user remote-desktop
 * runtime directories on purpose: those can be user-owned, which would void the ownership check.
 */
export const MACOS_FS_DELEGATE_RUNTIME_ROOT: string = protocol.runtimeRoot;
/** The directory from which the helper starts requiring root ownership of the chain down to the request directory. */
export const MACOS_FS_DELEGATE_TRUSTED_CHAIN_START: string = protocol.trustedChainStart;

export const MACOS_FS_DELEGATE_LIMITS = {
  /** A request is valid for at most this long after it was created, and may not claim to expire later than now + this. */
  REQUEST_TTL_MS: 10_000,
  /** A creation time this far ahead of the helper's clock is a rolled-back or forged clock. */
  MAX_CLOCK_SKEW_MS: 1_000,
  /** The node gives the whole helper run this long (spawn through exit). */
  RUN_TIMEOUT_MS: 10_000,
  /** Stdout the node accepts from one run. */
  MAX_STDOUT_BYTES: 4 * 1024 * 1024,
  /** The helper ends itself after this long however it is stuck; strictly less than RUN_TIMEOUT_MS. */
  HELPER_SELF_TIMEOUT_MS: 8_000,
  /** Entries the helper emits (the node trims to its own wire limit afterwards). */
  MAX_ENTRIES: 20_000,
  /** Longest absolute path accepted in a request. */
  MAX_PATH_BYTES: 4_096,
  /** Concurrent helper runs per node. */
  MAX_CONCURRENT_RUNS: 2,
} as const;

/** Stable reason codes a helper answer (`error <reason>`) or the node's client can carry. They are logged and never contain more than a path. */
export const MACOS_FS_DELEGATE_REASON = {
  // helper-side
  BAD_USAGE: 'bad_usage',
  BAD_REQUEST_FILE: 'bad_request_file',
  REQUEST_DIR_UNTRUSTED: 'request_dir_untrusted',
  REQUEST_OWNER_UNTRUSTED: 'request_owner_untrusted',
  REQUEST_EXPIRED: 'request_expired',
  REQUEST_EXPIRY_TOO_FAR: 'request_expiry_too_far',
  REQUEST_CREATED_IN_FUTURE: 'request_created_in_future',
  UNSUPPORTED_VERSION: 'unsupported_version',
  UNSUPPORTED_OP: 'unsupported_op',
  BAD_PATH: 'bad_path',
  PERMISSION_DENIED: 'permission_denied',
  NOT_FOUND: 'not_found',
  NOT_DIRECTORY: 'not_directory',
  SYMLINK_REFUSED: 'symlink_refused',
  CHANGED_DURING_READ: 'changed_during_read',
  IO_ERROR: 'io_error',
  // node-side
  APP_UNAVAILABLE: 'app_unavailable',
  APP_TOO_OLD: 'app_too_old',
  NO_USER_SESSION: 'no_user_session',
  SPAWN_FAILED: 'spawn_failed',
  TIMEOUT: 'timeout',
  BAD_ANSWER: 'bad_answer',
  BUSY: 'busy',
  POLICY_FORBIDDEN: 'policy_forbidden',
} as const;
export type MacosFsDelegateReason = typeof MACOS_FS_DELEGATE_REASON[keyof typeof MACOS_FS_DELEGATE_REASON];

export const MACOS_FS_DELEGATE_ANSWER_MAGIC = 'IMCODES-FS-V1';

export type MacosFsDelegateEntryKind = 'd' | 'f' | 'o';

export interface MacosFsDelegateListAnswer {
  ok: true;
  realPath: string;
  entries: Array<{ name: string; kind: MacosFsDelegateEntryKind }>;
  truncated: boolean;
}
export interface MacosFsDelegateErrorAnswer {
  ok: false;
  reason: string;
}
export type MacosFsDelegateAnswer = MacosFsDelegateListAnswer | MacosFsDelegateErrorAnswer;

export interface MacosFsDelegateRequest {
  op: MacosFsDelegateOp;
  path: string;
  nonce: string;
  createdMs: number;
  expiresMs: number;
}

const REASON_RE = /^[a-z0-9_]{1,64}$/u;
const HEX_RE = /^(?:[0-9a-f]{2})*$/u;

export function hexEncodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

export function hexDecodeUtf8(value: string): string | null {
  if (!HEX_RE.test(value)) return null;
  return Buffer.from(value, 'hex').toString('utf8');
}

/** The request file's exact bytes. */
export function serializeMacosFsDelegateRequest(request: MacosFsDelegateRequest): string {
  return [
    `v=${MACOS_FS_DELEGATE_PROTOCOL_VERSION}`,
    `op=${request.op}`,
    `path_hex=${hexEncodeUtf8(request.path)}`,
    `created_ms=${Math.trunc(request.createdMs)}`,
    `expires_ms=${Math.trunc(request.expiresMs)}`,
    `nonce=${request.nonce}`,
    '',
  ].join('\n');
}

/** Parse a helper's stdout. Anything that is not exactly the documented framing is `null` (the caller falls back to its own reads). */
export function parseMacosFsDelegateAnswer(stdout: string): MacosFsDelegateAnswer | null {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== MACOS_FS_DELEGATE_ANSWER_MAGIC) return null;
  if (lines.length === 2 && lines[1]!.startsWith('error ')) {
    const reason = lines[1]!.slice('error '.length);
    return REASON_RE.test(reason) ? { ok: false, reason } : null;
  }
  let realPath: string | null = null;
  const entries: MacosFsDelegateListAnswer['entries'] = [];
  let end: { count: number; truncated: boolean } | null = null;
  for (const line of lines.slice(1)) {
    if (end) return null; // nothing may follow `end`
    if (line.startsWith('realpath ')) {
      if (realPath !== null) return null;
      realPath = hexDecodeUtf8(line.slice('realpath '.length));
      if (realPath === null || realPath.length === 0) return null;
    } else if (line.startsWith('entry ')) {
      const match = /^entry ([dfo]) ([0-9a-f]+)$/u.exec(line);
      if (!match) return null;
      const name = hexDecodeUtf8(match[2]!);
      if (name === null || name.length === 0 || name.includes('/') || name.includes('\0')) return null;
      entries.push({ name, kind: match[1] as MacosFsDelegateEntryKind });
    } else if (line.startsWith('end ')) {
      const match = /^end (\d{1,9}) ([01])$/u.exec(line);
      if (!match) return null;
      end = { count: Number(match[1]), truncated: match[2] === '1' };
    } else {
      return null;
    }
  }
  if (realPath === null || end === null || end.count !== entries.length) return null;
  return { ok: true, realPath, entries, truncated: end.truncated };
}

/** The ops an app advertises in its Info.plist (`AideskFsDelegateOps`), restricted to the ones this node can request. */
export function parseMacosFsDelegateOps(version: unknown, ops: unknown): readonly MacosFsDelegateOp[] {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < MACOS_FS_DELEGATE_PROTOCOL_VERSION) return [];
  if (typeof ops !== 'string') return [];
  const advertised = new Set(ops.split(/\s+/u).filter(Boolean));
  return MACOS_FS_DELEGATE_NODE_OPS.filter((op) => advertised.has(op));
}
