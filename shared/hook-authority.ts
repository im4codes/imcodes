/**
 * Hook endpoint authority — the SINGLE SOURCE OF TRUTH for the on-disk contract
 * that tells local clients (the stdio memory-MCP child, `imcodes send`, the
 * peer-audit CLI) which port the LIVE daemon hook server listens on, and WHICH
 * daemon process owns it.
 *
 * ## Field incident this fixes
 *
 * The record used to be a bare decimal port written by TWO separate non-atomic
 * implementations, with no owner identity and no fencing:
 *   - any in-process test that called `startHookServer()` without a sandboxed
 *     home bound a different free port and overwrote the REAL
 *     `~/.imcodes/hook-port` (observed: live daemon on 51941, file said 51915);
 *   - readers trusted a bare TCP connect ("something answered");
 *   - when the saved port did not answer, readers swept a FIXED 20-port window
 *     from 51913 plus `saved-19..saved`, which for 51915 is 51896..51932 and
 *     therefore could never reach 51941.
 * The resulting failure was reported as `daemon_memory_worker_unavailable`,
 * blaming the memory worker for pure endpoint drift.
 *
 * ## Backward-compatible two-file layout (MANDATORY)
 *
 * `hook-port` KEEPS its legacy format: a bare decimal port, nothing else.
 * Already-installed daemons and CLIs parse only digits, so writing JSON there
 * breaks every not-yet-upgraded reader on the machine. (This was tried and did
 * break the installed CLI — hence this rule is load-bearing, not stylistic.)
 *
 * Owner identity therefore lives in a SIDECAR, `hook-authority.json`:
 *   - old readers keep reading `hook-port` and behave exactly as before;
 *   - new readers read the sidecar, verify the owner, and fall back to the
 *     legacy bare port when the sidecar is absent (pre-upgrade daemon);
 *   - publishers write the sidecar FIRST, then the bare port, both atomically.
 */

/** Current sidecar schema version. */
export const HOOK_AUTHORITY_RECORD_VERSION = 1;

/** Legacy, compatibility-critical file: a bare decimal port and nothing else.
 *  MUST NOT be given any other format. */
export const HOOK_PORT_FILE_NAME = 'hook-port';

/** Sidecar carrying owner identity. Safe to add: an old reader never opens it. */
export const HOOK_AUTHORITY_SIDECAR_FILE_NAME = 'hook-authority.json';

/**
 * Cross-process publication lock - LEGACY single-file form.
 *
 * Atomic renames make each FILE write atomic, but publication is a
 * read-authorize-write TRANSACTION spanning two files, and it contains an
 * `await`, so it must be serialized.
 *
 * Earlier builds serialized it with this single pathname. That form cannot be
 * made ownership-safe with portable primitives: releasing or reclaiming it means
 * removing a SHARED name, and `unlink` acts on whatever the name resolves to at
 * that instant, so any "check it is still mine, then unlink" sequence can delete
 * a successor installed in the gap. It is therefore no longer written or removed
 * by anyone. It is only READ, so a still-running older publisher that holds it
 * is respected (see `parseHookAuthorityLockHolder`).
 */
export const HOOK_AUTHORITY_LOCK_FILE_NAME = 'hook-authority.lock';

/**
 * Cross-process publication lock - EPOCH form (the only form written).
 *
 * A directory of strictly increasing, never-reused epoch entries:
 *   `<E>.lock`      holder record of epoch E, installed by `link()` from a
 *                   private temp, so it appears atomically, complete, and can
 *                   never overwrite an existing epoch (EEXIST);
 *   `<E>.released`  created by the holder of E when it is done.
 *
 * The holder is the creator of the HIGHEST epoch, unless that epoch is
 * released. Acquiring means claiming `<max+1>.lock`; recovering a dead holder
 * means the same thing. No actor ever removes or rewrites a name another actor
 * could currently be relying on, which removes the pathname ABA by construction
 * rather than by a validation that can go stale.
 */
export const HOOK_AUTHORITY_LOCK_DIR_NAME = 'hook-authority.lock.d';
export const HOOK_AUTHORITY_LOCK_EPOCH_SUFFIX = '.lock';
export const HOOK_AUTHORITY_LOCK_RELEASED_SUFFIX = '.released';
export const HOOK_AUTHORITY_LOCK_TEMP_PREFIX = 'tmp.';
/**
 * Generation token of an epoch namespace: 32 random hex chars, created once per
 * lock directory INSTANCE by `link()` (never overwritten, never removed by this
 * build) and embedded in EVERY entry name as `<generation>.<E>.lock` /
 * `<generation>.<E>.<nonce>.released`.
 *
 * Epoch numbers restart if the directory is deleted and recreated. Without the
 * token a stale actor from the old instance could name - and prune - an entry
 * of the new one (`1.lock` means both). With it, names can never collide across
 * instances, so every mutation an actor can make is confined to its own
 * generation by construction.
 */
export const HOOK_AUTHORITY_LOCK_GENERATION_FILE_NAME = 'generation';

/**
 * Publish CAPABILITY of one acquisition: a directory
 * `<generation>.<E>.<nonce>.d` created (non-recursively) BEFORE epoch E is
 * claimed and never created again by anyone.
 *
 * Every authority write is staged inside it and moved out with a single
 * `rename`. A successor removes every lower-epoch capability of its generation
 * before it commits, and a lock-directory reset removes all of them. After that
 * a stale acquisition's staged source no longer exists, so its write fails with
 * ENOENT instead of replacing the successor's files. This is what fences the
 * proof -> write gap: the right to write is revoked, not merely re-checked.
 */
export const HOOK_AUTHORITY_LOCK_CAPABILITY_SUFFIX = '.d';

/**
 * Holder recorded in a publication lock.
 *
 * `{pid, startToken}` identifies the holder PROCESS - the only thing that can
 * ever justify recovering its lock, and only on positive proof it is gone.
 *
 * `nonce` identifies the ACQUISITION. Two publishers inside one process share
 * `{pid, startToken}` exactly, so only the nonce can say "this epoch is MINE";
 * the commit point requires it.
 */
export interface HookAuthorityLockHolder extends HookAuthorityOwner {
  acquiredAt: number;
  /** unique per ACQUISITION (not per process) */
  nonce: string;
}

/** Holder recorded by an older build in the legacy single-file lock: full
 *  process identity, no acquisition nonce. */
export type HookAuthorityLegacyLockHolder = HookAuthorityOwner & { acquiredAt: number };

export function isHookAuthorityLockHolder(value: unknown): value is HookAuthorityLockHolder {
  if (!isHookAuthorityLegacyLockHolder(value)) return false;
  const candidate = value as Partial<HookAuthorityLockHolder>;
  return typeof candidate.nonce === 'string' && candidate.nonce.length > 0;
}

export function isHookAuthorityLegacyLockHolder(value: unknown): value is HookAuthorityLegacyLockHolder {
  if (!isHookAuthorityOwner(value)) return false;
  const candidate = value as Partial<HookAuthorityLegacyLockHolder>;
  return typeof candidate.acquiredAt === 'number' && Number.isFinite(candidate.acquiredAt);
}

/**
 * Parse lock bytes WITHOUT discarding a valid older-format holder.
 *
 * A nonce-less record is not "ambiguous": it names a real process by
 * `{pid, startToken}`, and that process may still be mid-transaction. Folding it
 * into an unparseable/ambiguous bucket (as a previous revision did) turned a
 * live writer into something recoverable by waiting, which is exactly how two
 * publishers overlap. Only bytes that name no process at all are `unparseable`.
 */
export type ParsedHookAuthorityLockHolder =
  | { kind: 'holder'; holder: HookAuthorityLockHolder }
  | { kind: 'legacyHolder'; holder: HookAuthorityLegacyLockHolder }
  | { kind: 'unparseable' };

export function parseHookAuthorityLockHolder(text: string): ParsedHookAuthorityLockHolder {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return { kind: 'unparseable' };
  }
  if (isHookAuthorityLockHolder(value)) return { kind: 'holder', holder: value };
  if (isHookAuthorityLegacyLockHolder(value)) {
    return {
      kind: 'legacyHolder',
      holder: { pid: value.pid, startToken: value.startToken, acquiredAt: value.acquiredAt },
    };
  }
  return { kind: 'unparseable' };
}

/** POST route the hook server exposes so a client can verify the owner.
 *  POST because the hook server answers 404 to every non-POST method. */
export const HOOK_IDENTITY_HOOK_PATH = '/hook-identity';

/** Owner identity of the publishing process. Mirrors `DaemonProcessIdentity`
 *  in `src/daemon/instance-lock.ts` (pid + start token) so the same
 *  liveness/fencing predicates apply, without `shared/` importing from `src/`. */
export interface HookAuthorityOwner {
  pid: number;
  /** scheme-prefixed process start token (`linux:` / `ps:` / `windows:` /
   *  `runtime:`) — defeats PID reuse. */
  startToken: string;
}

export interface HookAuthorityRecord extends HookAuthorityOwner {
  version: typeof HOOK_AUTHORITY_RECORD_VERSION;
  port: number;
  publishedAt: number;
}

/** Body returned by `HOOK_IDENTITY_HOOK_PATH`. */
export interface HookIdentityResponse extends HookAuthorityOwner {
  version: typeof HOOK_AUTHORITY_RECORD_VERSION;
  port: number;
}

/**
 * Hook endpoint authority error taxonomy.
 *
 * Deliberately DISTINCT from the `daemon_memory_worker_*` codes: a hook
 * endpoint that drifted, went stale, or is owned by another process is an
 * ENDPOINT problem, and reporting it as a memory-worker problem sent the field
 * investigation to the wrong subsystem. Nothing here may be mapped back onto a
 * `daemon_memory_worker_*` code.
 */
export const HOOK_AUTHORITY_ERROR = {
  /** no record at all, or the recorded owner is live but not answering */
  hookUnavailable: 'daemon_hook_unavailable',
  /** a record exists but does not describe the live endpoint: the owner is
   *  gone, or a DIFFERENT process answers the recorded port */
  staleHookAuthority: 'stale_hook_authority',
  /** the record bytes are present but malformed / out of range */
  unreadable: 'hook_authority_unreadable',
  /** publish refused: the record belongs to a different, still-live owner */
  publishFenced: 'hook_authority_publish_fenced',
  /** publish refused: a test/fixture tried to write the machine-global record */
  publishSuppressedForTests: 'hook_authority_publish_suppressed_for_tests',
  /** publish refused: the cross-process publication lock could not be taken
   *  within its bounded wait, so the transaction was not attempted */
  publishLockUnavailable: 'hook_authority_publish_lock_unavailable',
  /** publish abandoned: the publication lock instance this transaction
   *  acquired was no longer ours at the commit point (a successor legitimately
   *  took over while we were suspended), so nothing was written */
  publishLockLost: 'hook_authority_publish_lock_lost',
} as const;
export type HookAuthorityError =
  (typeof HOOK_AUTHORITY_ERROR)[keyof typeof HOOK_AUTHORITY_ERROR];

/** Errors a caller may retry after the daemon republishes; the rest need
 *  daemon/operator action instead of a blind retry. */
export const RETRYABLE_HOOK_AUTHORITY_ERRORS: ReadonlySet<HookAuthorityError> = new Set([
  HOOK_AUTHORITY_ERROR.hookUnavailable,
  HOOK_AUTHORITY_ERROR.staleHookAuthority,
]);

export function isValidHookPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 1024 && port < 65536;
}

function isValidStartToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 256;
}

export function isHookAuthorityOwner(value: unknown): value is HookAuthorityOwner {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HookAuthorityOwner>;
  return Number.isSafeInteger(candidate.pid) && (candidate.pid as number) > 0
    && isValidStartToken(candidate.startToken);
}

export function isHookAuthorityRecord(value: unknown): value is HookAuthorityRecord {
  if (!isHookAuthorityOwner(value)) return false;
  const candidate = value as Partial<HookAuthorityRecord>;
  return candidate.version === HOOK_AUTHORITY_RECORD_VERSION
    && isValidHookPort(candidate.port)
    && typeof candidate.publishedAt === 'number'
    && Number.isFinite(candidate.publishedAt);
}

export function isHookIdentityResponse(value: unknown): value is HookIdentityResponse {
  if (!isHookAuthorityOwner(value)) return false;
  const candidate = value as Partial<HookIdentityResponse>;
  return candidate.version === HOOK_AUTHORITY_RECORD_VERSION && isValidHookPort(candidate.port);
}

/** Two identities describe the same daemon generation. PID alone is NOT enough
 *  (PIDs are reused), so the start token must match exactly. */
export function sameHookAuthorityOwner(a: HookAuthorityOwner, b: HookAuthorityOwner): boolean {
  return a.pid === b.pid && a.startToken === b.startToken;
}

// ── `hook-port` (legacy format, compatibility-critical) ──────────────────────

/** The ONLY permitted serialization of `hook-port`: digits + newline.
 *  Every installed reader in the field parses exactly this. */
export function serializeHookPortFile(port: number): string {
  return `${port}\n`;
}

/**
 * Parse `hook-port`.
 *
 * Digits-only is the contract; `parseInt` prefixes (`"51915abc"`) are rejected
 * so a torn write is never trusted. A JSON payload is tolerated on READ only —
 * an intermediate build wrote one, and being able to recover the port from it
 * beats failing closed — but `serializeHookPortFile` never produces it.
 */
export function parseHookPortFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const port = (parsed as { port?: unknown } | null)?.port;
      return isValidHookPort(port) ? port : null;
    } catch {
      return null;
    }
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  return isValidHookPort(port) ? port : null;
}

/** True when these bytes are the legacy digits-only form an old reader accepts. */
export function isLegacyCompatibleHookPortFile(raw: string): boolean {
  return /^\d+\s*$/.test(raw) && isValidHookPort(Number.parseInt(raw.trim(), 10));
}

// ── `hook-authority.json` (sidecar) ──────────────────────────────────────────

export function serializeHookAuthorityRecord(record: HookAuthorityRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseHookAuthoritySidecar(raw: string): HookAuthorityRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isHookAuthorityRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Combined on-disk view of the authority pair.
 *
 * The distinction between these states is load-bearing. An earlier version
 * collapsed every "not a clean record" case into `legacy`, and `legacy` is
 * accepted on a bare TCP probe for pre-upgrade compatibility. That meant a
 * CORRUPTED sidecar, a TORN pair, or a legacy overwrite silently downgraded
 * authenticated state to connect-only trust, bypassing pid/startToken
 * ownership entirely - the exact trust this module exists to remove.
 *
 * Genuine legacy compatibility therefore applies ONLY when there is no
 * structured sidecar evidence at all. Any sidecar evidence that cannot be
 * reconciled MUST fail closed with a determinate reason.
 *
 *  - `record`            — sidecar present, valid, and agrees with the bare
 *                          port: owner-verifiable.
 *  - `legacy`            — bare port only, NO sidecar file: pre-upgrade daemon.
 *  - `sidecarUnreadable` — a sidecar file exists but cannot be parsed.
 *  - `portMismatch`      — sidecar is valid but names a different port than the
 *                          bare file (torn write, or a legacy writer clobbered
 *                          the bare port).
 *  - `invalid`           — the bare port file itself is unusable.
 *  - `absent`            — nothing published.
 */
export type HookAuthorityState =
  | { kind: 'record'; record: HookAuthorityRecord }
  | { kind: 'legacy'; port: number }
  | { kind: 'sidecarUnreadable'; port: number }
  | { kind: 'portMismatch'; port: number; record: HookAuthorityRecord }
  | { kind: 'invalid' }
  | { kind: 'absent' };

/** True when the state carries structured sidecar evidence, i.e. the legacy
 *  connect-only compatibility path MUST NOT be used. */
export function hasStructuredSidecarEvidence(state: HookAuthorityState): boolean {
  return state.kind === 'record'
    || state.kind === 'sidecarUnreadable'
    || state.kind === 'portMismatch';
}

/** Outcome of resolving the live hook endpoint. */
export type HookAuthorityResolution =
  | {
    ok: true;
    port: number;
    /** null when accepted through the legacy bare-port compatibility path
     *  (owner identity unavailable). */
    owner: HookAuthorityOwner | null;
  }
  | { ok: false; reason: HookAuthorityError; detail?: string };
