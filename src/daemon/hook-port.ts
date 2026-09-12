/**
 * hook-port — publish and resolve the daemon hook server's local endpoint.
 *
 * See `shared/hook-authority.ts` for the incident this fixes and for the
 * MANDATORY two-file layout (`hook-port` stays digits-only for already-installed
 * readers; owner identity lives in the `hook-authority.json` sidecar).
 *
 * Contract implemented here:
 *  - ONE atomic publisher (`publishHookAuthority`): sidecar first, then the bare
 *    port file, each tmp + rename, mode 0600.
 *  - The publisher is FENCED: it refuses to overwrite a record owned by a
 *    different process that is still authoritative, reusing the daemon instance
 *    lock's `ownerRemainsAuthoritative` predicate (which fails closed on an
 *    indeterminate probe).
 *  - The publisher REFUSES to touch the machine-global record from a test
 *    process unless the test injected its own paths. A fixture that escaped to
 *    the real `~/.imcodes/hook-port` is what broke the installed CLI, so this is
 *    enforced in production code rather than left to per-test discipline.
 *  - Resolution VERIFIES the owner over `HOOK_IDENTITY_HOOK_PATH` instead of
 *    trusting a TCP connect, and does NOT scan: the daemon republishes on
 *    (re)bind and on unexpected listener loss, so the record is the authority.
 *    Widening the scan was explicitly rejected — an over-wide scan is what let a
 *    wrong listener be adopted in the first place.
 *  - Failures use the `HOOK_AUTHORITY_ERROR` taxonomy, never a
 *    `daemon_memory_worker_*` code.
 *
 * Kept dependency-light (node builtins + `instance-lock` liveness helpers,
 * themselves builtin-only) so the stdio MCP process and the `imcodes send` CLI
 * can import it without pulling in the daemon module graph.
 */
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync,
  readdirSync, statSync, linkSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {
  HOOK_AUTHORITY_ERROR,
  HOOK_AUTHORITY_LOCK_CAPABILITY_SUFFIX,
  HOOK_AUTHORITY_LOCK_DIR_NAME,
  HOOK_AUTHORITY_LOCK_EPOCH_SUFFIX,
  HOOK_AUTHORITY_LOCK_FILE_NAME,
  HOOK_AUTHORITY_LOCK_GENERATION_FILE_NAME,
  HOOK_AUTHORITY_LOCK_RELEASED_SUFFIX,
  HOOK_AUTHORITY_LOCK_TEMP_PREFIX,
  HOOK_AUTHORITY_RECORD_VERSION,
  HOOK_AUTHORITY_SIDECAR_FILE_NAME,
  HOOK_IDENTITY_HOOK_PATH,
  HOOK_PORT_FILE_NAME,
  isHookIdentityResponse,
  parseHookAuthorityLockHolder,
  parseHookAuthoritySidecar,
  parseHookPortFile,
  sameHookAuthorityOwner,
  serializeHookAuthorityRecord,
  serializeHookPortFile,
  type HookAuthorityError,
  type HookAuthorityLockHolder,
  type HookAuthorityOwner,
  type HookAuthorityRecord,
  type HookAuthorityResolution,
  type HookAuthorityState,
  type HookIdentityResponse,
} from '../../shared/hook-authority.js';
import {
  currentDaemonProcessIdentity,
  ownerRemainsAuthoritative,
  probeProcessLiveness,
  readInstanceLockMetadata,
  type DaemonProcessIdentity,
  type ProcessLiveness,
} from './instance-lock.js';

/** First port the hook server tries to bind; it increments on conflict. */
export const DEFAULT_HOOK_PORT = 51913;

/**
 * Bounded wait for the cross-process publication lock. Short, because the
 * critical section is two small file writes.
 *
 * There is deliberately NO age or stability threshold: a holder is taken over
 * only on positive proof its process is gone. When that proof is unavailable
 * for the whole wait, publication fails closed with `publishLockUnavailable`.
 */
export const HOOK_PUBLISH_LOCK = {
  maxAttempts: 40,
  retryDelayMs: 25,
} as const;

/** Bounded retry for an in-place rebind after the listener is lost.
 *  A single attempt is not enough: every candidate port can be momentarily
 *  occupied (a racing process, a socket still in TIME_WAIT), and giving up would
 *  leave the machine with no hook endpoint until the daemon restarts. */
export const HOOK_REBIND_RETRY = {
  maxAttempts: 6,
  baseDelayMs: 250,
  capDelayMs: 10_000,
} as const;

/** Instance-lock metadata file the publish fence consults. Same file the daemon
 *  single-owner lock already uses. */
export const DAEMON_INSTANCE_LOCK_FILE_NAME = 'daemon.lock.json';

/** How many ports the SERVER walks upward when its preferred port is taken.
 *  Shared with `hook-server.ts` so the bind window is defined once.
 *  NOTE: a BIND retry span, not a client discovery span — clients do not scan. */
export const HOOK_BIND_RETRY_SPAN = 20;

/** The imcodes state directory. Honors `IMCODES_HOME` exactly like the rest of
 *  the daemon (e.g. `session-resource-registry.ts`), which is what lets a test
 *  or a child process point the whole record set at a temp dir. */
export function imcodesHomeDir(): string {
  return process.env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes');
}

/** Paths of the authority pair. Resolved at CALL time, never captured at module
 *  load, so a process that sets `IMCODES_HOME`/`HOME` later is still honored. */
export function hookPortFilePath(home = imcodesHomeDir()): string {
  return join(home, HOOK_PORT_FILE_NAME);
}
export function hookAuthoritySidecarPath(home = imcodesHomeDir()): string {
  return join(home, HOOK_AUTHORITY_SIDECAR_FILE_NAME);
}
/** Legacy single-file lock: read-only in this build. */
export function hookAuthorityLockPath(home = imcodesHomeDir()): string {
  return join(home, HOOK_AUTHORITY_LOCK_FILE_NAME);
}
/** Epoch lock directory: the only publication lock this build writes. */
export function hookAuthorityLockDirPath(home = imcodesHomeDir()): string {
  return join(home, HOOK_AUTHORITY_LOCK_DIR_NAME);
}

/** @deprecated Prefer `hookPortFilePath()`; kept for existing importers. */
export const HOOK_PORT_FILE = hookPortFilePath();

/**
 * Thrown when the hook endpoint cannot be resolved. `reason` is a
 * `HOOK_AUTHORITY_ERROR` code and the message leads with it.
 *
 * Exists specifically so endpoint-authority drift is never surfaced as a
 * `daemon_memory_worker_*` failure again.
 */
export class HookAuthorityUnavailableError extends Error {
  readonly reason: HookAuthorityError;
  readonly operation: string;
  readonly detail?: string;
  constructor(reason: HookAuthorityError, operation: string, detail?: string) {
    super(detail ? `${reason}: ${operation} (${detail})` : `${reason}: ${operation}`);
    this.name = 'HookAuthorityUnavailableError';
    this.reason = reason;
    this.operation = operation;
    if (detail !== undefined) this.detail = detail;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Outcome of reading one authority file.
 *
 * The distinction between `absent` and `error` is SECURITY-RELEVANT. A single
 * `catch -> null` collapsed them, so a sidecar that EXISTED but could not be
 * read (EACCES, EMFILE, EIO, a transient I/O fault) was indistinguishable from
 * a genuinely absent pre-upgrade sidecar - and `absent` selects the legacy
 * branch, which authorises a bare port from a TCP-connect probe alone and
 * returns `owner: null`. That is a fail-OPEN on the exact evidence the fence
 * exists to protect: an unreadable sidecar would let a foreign listener be
 * adopted. Only true nonexistence may be reported as `absent`.
 */
export type AuthorityFileRead =
  | { kind: 'ok'; text: string }
  | { kind: 'absent' }
  | { kind: 'error'; code: string };

/** errno values that genuinely mean "this path does not exist". Everything
 *  else - notably EACCES and EISDIR - means the file is PRESENT but unusable. */
const ABSENT_ERROR_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function readAuthorityFile(path: string): AuthorityFileRead {
  try {
    return { kind: 'ok', text: readFileSync(path, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return ABSENT_ERROR_CODES.has(code) ? { kind: 'absent' } : { kind: 'error', code };
  }
}

/** Combined view of `hook-port` + `hook-authority.json`.
 *
 *  Each irreconcilable case gets its OWN state instead of collapsing into
 *  `legacy`: `legacy` is accepted on a bare TCP probe for pre-upgrade
 *  compatibility, so folding a corrupt or disagreeing sidecar into it silently
 *  traded authenticated ownership for connect-only trust. See
 *  `HookAuthorityState` for the full rationale. */
export interface ReadHookAuthorityStateDeps {
  /** injectable so an I/O failure can be exercised without relying on chmod
   *  semantics (which differ for root and across filesystems) */
  readFile?: (path: string) => AuthorityFileRead;
}

export function readHookAuthorityState(
  home = imcodesHomeDir(),
  deps: ReadHookAuthorityStateDeps = {},
): HookAuthorityState {
  const read = deps.readFile ?? readAuthorityFile;

  const portRead = read(hookPortFilePath(home));
  // Only true nonexistence is `absent`; an unreadable port file is present and
  // unusable, which is `hook_authority_unreadable`, not "nothing published".
  if (portRead.kind === 'absent') return { kind: 'absent' };
  if (portRead.kind === 'error') return { kind: 'invalid' };
  const port = parseHookPortFile(portRead.text);
  if (port === null) return { kind: 'invalid' };

  const sidecarRead = read(hookAuthoritySidecarPath(home));
  // A sidecar FILE that does not exist at all is the only genuine legacy case.
  if (sidecarRead.kind === 'absent') return { kind: 'legacy', port };
  // A sidecar that exists but cannot be READ is structured evidence we failed
  // to obtain - it must fail closed exactly like unparseable bytes, never fall
  // through to the connect-only legacy path.
  if (sidecarRead.kind === 'error') return { kind: 'sidecarUnreadable', port };

  const sidecar = parseHookAuthoritySidecar(sidecarRead.text);
  // Present and broken is NOT the same as absent.
  if (!sidecar) return { kind: 'sidecarUnreadable', port };
  // Torn pair, or a legacy writer rewrote the bare port under a live sidecar.
  if (sidecar.port !== port) return { kind: 'portMismatch', port, record: sidecar };
  return { kind: 'record', record: sidecar };
}

/** The recorded port regardless of record shape, or null when absent/malformed.
 *  Callers that need owner verification MUST use `resolveHookAuthority`. */
export function readSavedHookPort(home = imcodesHomeDir()): number | null {
  const state = readHookAuthorityState(home);
  if (state.kind === 'record') return state.record.port;
  // The BARE port is what every installed reader uses, so it remains the
  // preferred-port hint even when the sidecar is broken or disagrees. This is a
  // hint for the next bind, never an authorisation - `resolveHookAuthority`
  // still fails closed on those states.
  if (state.kind === 'legacy'
    || state.kind === 'sidecarUnreadable'
    || state.kind === 'portMismatch') return state.port;
  return null;
}

// ── Probing ──────────────────────────────────────────────────────────────────

/** True when something is accepting TCP connections on 127.0.0.1:port.
 *  Proves liveness of *a* listener only — never ownership. Used solely on the
 *  legacy compatibility path and for publish fencing. */
export function probeHookPort(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Ask the listener who it is. Returns null when nothing answers or the answer
 *  is not a valid identity payload (e.g. an older daemon without the route). */
export function fetchHookIdentity(port: number, timeoutMs = 1000): Promise<HookIdentityResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: HookIdentityResponse | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request(
      {
        // No connection pooling. Node >= 19 enables keepAlive on
        // `http.globalAgent`, so a socket pooled to a daemon generation that has
        // since been replaced would be reused here and fail - which is exactly
        // the "endpoint looks dead but is healthy" class of bug this module
        // exists to eliminate. A one-shot probe must always dial fresh.
        agent: false,
        host: '127.0.0.1',
        port,
        path: HOOK_IDENTITY_HOOK_PATH,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          // The identity payload is tiny; refuse to buffer a hostile responder.
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body);
            finish(isHookIdentityResponse(parsed) ? parsed : null);
          } catch {
            finish(null);
          }
        });
        response.on('error', () => finish(null));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
    request.end('{}');
  });
}

// ── Publishing (the ONLY writer) ─────────────────────────────────────────────

export interface PublishHookAuthorityDeps {
  /** state directory; defaults to `IMCODES_HOME` or `~/.imcodes` */
  home?: string;
  owner?: HookAuthorityOwner;
  now?: () => number;
  probeLiveness?: (pid: number) => ProcessLiveness;
  probeListener?: (port: number) => Promise<boolean>;
  readState?: (home: string) => HookAuthorityState;
  writeFile?: (path: string, contents: string) => void;
  /** escape hatch for the containment guards; set ONLY by callers that have
   *  already pointed `home` at a temp directory. */
  allowGlobalWriteInTests?: boolean;
  /** injectable so the guard itself is testable */
  isTestRuntime?: () => boolean;
  /** reads the daemon instance-lock owner for the primary publish fence */
  readLockOwner?: (home: string) => DaemonProcessIdentity | null;
  /**
   * Test barrier invoked AFTER the authorize snapshot and BEFORE the
   * publication lock is taken.
   *
   * This is the only point at which a stale publisher can be suspended while a
   * successor takes over, which is what makes the check/write interleaving
   * reproducible. It is deliberately outside the critical section: pausing
   * while holding the lock would merely serialize, and would not prove that a
   * resumed stale publisher is REFUSED.
   */
  afterAuthorize?: () => Promise<void>;
  /**
   * Test barrier invoked while HOLDING the publication lock, after the
   * daemon-lock identity CAS and before the commit.
   *
   * `afterAuthorize` cannot express the reported interleaving: a publisher
   * suspended there holds nothing. This one suspends a publisher that has
   * already authorized AND already taken the mutex, which is the only state
   * from which a successor take-over can produce a stale write - and therefore
   * the only state that proves the commit-point lock re-validation is
   * load-bearing.
   */
  beforeCommit?: () => Promise<void>;
  /**
   * Test barrier invoked after ALL lock validation (including the decision that
   * a previous holder is dead) and immediately before the atomic claim. This is
   * the "final validation -> act" gap in which a successor can install itself.
   */
  beforeClaim?: (barrier: PublicationLockBarrier) => Promise<void>;
  /**
   * Test barrier invoked right after a successful claim and before history is
   * pruned: the gap in which the lock directory can be deleted and re-claimed.
   */
  afterClaim?: (barrier: PublicationLockBarrier) => Promise<void>;
  /**
   * Test barrier invoked immediately after the final commit proof succeeded
   * and before the first authority write: the proof -> write gap.
   */
  afterProof?: () => Promise<void>;
  /** Test barrier invoked between the sidecar write and the port write. */
  betweenWrites?: () => Promise<void>;
  /**
   * Test barrier invoked immediately before the lock is released - the same
   * gap on the release side.
   */
  beforeRelease?: (barrier: PublicationLockBarrier) => Promise<void>;
}

export interface PublishHookAuthorityResult {
  published: boolean;
  record?: HookAuthorityRecord;
  reason?: HookAuthorityError;
  /** identity of the owner that blocked the publish, when fenced */
  heldBy?: HookAuthorityOwner;
}

function runningUnderTestRunner(): boolean {
  return Boolean(process.env.VITEST ?? process.env.VITEST_WORKER_ID);
}

/** Instance-lock owner for `home`, or null when no lock is recorded. */
function defaultLockOwner(home: string): DaemonProcessIdentity | null {
  const metadata = readInstanceLockMetadata(join(home, DAEMON_INSTANCE_LOCK_FILE_NAME));
  return metadata ? { pid: metadata.pid, startToken: metadata.startToken } : null;
}

/** Handle for a held publication lock: the epoch we claimed and the
 *  acquisition nonce recorded in it. */
interface PublicationLock {
  dir: string;
  /** the namespace instance this acquisition belongs to; every name it creates
   *  or removes carries it */
  generation: string;
  epoch: number;
  nonce: string;
}

/** Information handed to the lock barriers. */
export interface PublicationLockBarrier {
  epoch: number;
}

const GENERATION_TOKEN = /^[0-9a-f]{32}$/;
const EPOCH_LOCK_NAME = /^([0-9a-f]{32})\.(\d+)\.lock$/;
const EPOCH_RELEASED_NAME = /^([0-9a-f]{32})\.(\d+)\.[0-9a-f]+\.released$/;
const EPOCH_CAPABILITY_NAME = /^([0-9a-f]{32})\.(\d+)\.[0-9a-f]+\.d$/;
/** Bounded attempts to revoke lower capabilities before failing closed. */
const CAPABILITY_REVOKE_ATTEMPTS = 5;
/** Temps older than this cannot belong to an in-flight claim (a claim is a few
 *  synchronous syscalls), so pruning them cannot race a claimant. */
const STALE_CLAIM_TEMP_MS = 60_000;

function epochLockName(generation: string, epoch: number): string {
  return `${generation}.${epoch}${HOOK_AUTHORITY_LOCK_EPOCH_SUFFIX}`;
}

/** The released marker is bound to the ACQUISITION, not merely the epoch: if the
 *  lock directory is ever wiped externally and epoch numbers restart, a stale
 *  holder's release still names only its own nonce and cannot release the new
 *  holder of the same epoch number. */
function capabilityDirName(generation: string, epoch: number, nonce: string): string {
  return `${generation}.${epoch}.${nonce}${HOOK_AUTHORITY_LOCK_CAPABILITY_SUFFIX}`;
}

export function publicationCapabilityDir(lock: { dir: string; generation: string; epoch: number; nonce: string }): string {
  return join(lock.dir, capabilityDirName(lock.generation, lock.epoch, lock.nonce));
}

function epochReleasedName(generation: string, epoch: number, nonce: string): string {
  return `${generation}.${epoch}.${nonce}${HOOK_AUTHORITY_LOCK_RELEASED_SUFFIX}`;
}

type GenerationRead =
  | { kind: 'ok'; generation: string }
  /** the directory vanished underneath us: re-evaluate */
  | { kind: 'raced' }
  | { kind: 'corrupt' }
  | { kind: 'error'; code: string };

function readGeneration(dir: string): GenerationRead | { kind: 'absent' } {
  const raw = readAuthorityFile(join(dir, HOOK_AUTHORITY_LOCK_GENERATION_FILE_NAME));
  if (raw.kind === 'absent') return { kind: 'absent' };
  if (raw.kind === 'error') return { kind: 'error', code: raw.code };
  const token = raw.text.trim();
  return GENERATION_TOKEN.test(token) ? { kind: 'ok', generation: token } : { kind: 'corrupt' };
}

/**
 * The generation of the CURRENT directory instance, creating it if this is a
 * fresh directory. Creation is `link()` of a complete private temp, so exactly
 * one token ever wins for a given directory instance and it is never replaced.
 */
function ensureGeneration(dir: string): GenerationRead {
  const existing = readGeneration(dir);
  if (existing.kind !== 'absent') return existing;
  const token = randomBytes(16).toString('hex');
  const temp = join(dir, `${HOOK_AUTHORITY_LOCK_TEMP_PREFIX}${process.pid}.gen.${token}`);
  try {
    writeFileSync(temp, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // `link`, not `rename`: never replaces a token another creator already
    // installed. Safety does not rest on this - a publisher whose generation was
    // replaced fails the commit-point nonce check - but it avoids a pointless
    // lost publication when two processes initialise the same fresh directory.
    linkSync(temp, join(dir, HOOK_AUTHORITY_LOCK_GENERATION_FILE_NAME));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (ABSENT_ERROR_CODES.has(code)) return { kind: 'raced' };
    if (code !== 'EEXIST') throw error; // lost the creation race: read the winner
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
  const settled = readGeneration(dir);
  return settled.kind === 'absent' ? { kind: 'raced' } : settled;
}

type LegacyLockView =
  | { kind: 'absent' }
  | { kind: 'holder'; holder: HookAuthorityOwner }
  | { kind: 'unparseable' }
  | { kind: 'error'; code: string };

/**
 * Read the legacy single-file lock. READ ONLY: nothing in this build writes,
 * rewrites or removes it.
 *
 * A valid older-format holder keeps its full `{pid, startToken}` identity and is
 * treated exactly like any other holder - never recoverable by age or by how
 * long it has looked unchanged. Bytes that name no process fail closed.
 */
function readLegacyLock(home: string): LegacyLockView {
  const raw = readAuthorityFile(hookAuthorityLockPath(home));
  if (raw.kind === 'absent') return { kind: 'absent' };
  if (raw.kind === 'error') return { kind: 'error', code: raw.code };
  const parsed = parseHookAuthorityLockHolder(raw.text);
  return parsed.kind === 'unparseable' ? { kind: 'unparseable' } : { kind: 'holder', holder: parsed.holder };
}

type EpochView =
  | { kind: 'empty' }
  | { kind: 'epoch'; epoch: number; holder: HookAuthorityLockHolder; released: boolean }
  /** the highest epoch vanished between listing and reading (pruned by a
   *  higher holder): re-evaluate immediately */
  | { kind: 'raced' }
  /** epoch content that names no acquisition; this build's writer cannot
   *  produce it (entries appear by `link()` of a complete temp) */
  | { kind: 'corrupt'; epoch: number }
  | { kind: 'error'; code: string };

/** The lock state of ONE generation. Entries of any other generation - leftovers
 *  from before a directory reset, or a stale actor's late claim into the new
 *  instance - are invisible: they are not locks of this namespace. */
function readEpochView(dir: string, generation: string): EpochView {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return ABSENT_ERROR_CODES.has(code) ? { kind: 'empty' } : { kind: 'error', code };
  }
  let max = -1;
  for (const name of names) {
    const match = EPOCH_LOCK_NAME.exec(name);
    if (!match || match[1] !== generation) continue;
    const epoch = Number(match[2]);
    if (Number.isSafeInteger(epoch) && epoch > max) max = epoch;
  }
  if (max < 0) return { kind: 'empty' };

  const raw = readAuthorityFile(join(dir, epochLockName(generation, max)));
  if (raw.kind === 'absent') return { kind: 'raced' };
  if (raw.kind === 'error') return { kind: 'error', code: raw.code };
  const parsed = parseHookAuthorityLockHolder(raw.text);
  if (parsed.kind !== 'holder') return { kind: 'corrupt', epoch: max };
  const released = names.includes(epochReleasedName(generation, max, parsed.holder.nonce));
  return { kind: 'epoch', epoch: max, holder: parsed.holder, released };
}

/**
 * Atomically claim epoch `epoch`, or return null if it is already taken.
 *
 * The record is written in full to a private temp and then `link()`ed to the
 * epoch name. `link` never replaces an existing name (EEXIST), so a claim can
 * only ever CREATE; it cannot displace a holder, and the entry is complete the
 * instant it exists. The temp is a name only this call knows, so removing it
 * affects nobody.
 */
function claimEpoch(
  dir: string,
  generation: string,
  epoch: number,
  owner: HookAuthorityOwner,
  now: () => number,
): PublicationLock | null {
  const nonce = randomBytes(16).toString('hex');
  const temp = join(dir, `${HOOK_AUTHORITY_LOCK_TEMP_PREFIX}${process.pid}.${nonce}`);
  const holder: HookAuthorityLockHolder = { ...owner, nonce, acquiredAt: now() };
  const capability = join(dir, capabilityDirName(generation, epoch, nonce));
  // ONE classifier for every syscall: the directory can vanish before any of
  // them, and in each case nothing was claimed.
  try {
    writeFileSync(temp, `${JSON.stringify(holder)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Created before the claim so every visible claim already has a revocable
    // capability. The ordering is tidy rather than load-bearing: a claimer
    // suspended between claim and capability can only write after passing the
    // commit proof, and a successor's higher epoch (or a new generation) makes
    // that proof fail, so a capability created late is never used.
    mkdirSync(capability, { mode: 0o700 });
    linkSync(temp, join(dir, epochLockName(generation, epoch)));
    return { dir, generation, epoch, nonce };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    // EEXIST: someone else holds this epoch. ENOENT/ENOTDIR: directory removed.
    if (code === 'EEXIST' || ABSENT_ERROR_CODES.has(code)) {
      // Our never-claimed capability is a unique name only we know.
      rmSync(capability, { recursive: true, force: true });
      return null;
    }
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Remove history of OUR generation strictly below the epoch we hold.
 *
 * Needs no validation, and cannot act on anyone else's namespace after a reset,
 * because every name it may remove carries our generation token: a name is
 * never reused within a generation (epochs only increase) and never shared
 * across generations (tokens are random and embedded). If the directory was
 * deleted and recreated while we were suspended, the new instance has a
 * different token, so nothing in it matches and nothing is removed - the
 * previous revision's `<E>.lock` names matched across instances, which let a
 * stale high-epoch actor prune a live successor's `1.lock`.
 *
 * Within our generation, our own `<epoch>` entry is never removed, so the
 * highest epoch can never be lowered or replaced.
 */
function pruneEpochsBelow(dir: string, generation: string, epoch: number, now: () => number): boolean {
  if (!revokeCapabilitiesBelow(dir, generation, epoch)) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of names) {
    const lock = EPOCH_LOCK_NAME.exec(name) ?? EPOCH_RELEASED_NAME.exec(name);
    let removable = false;
    if (lock) {
      removable = lock[1] === generation && Number(lock[2]) < epoch;
    } else if (name.startsWith(HOOK_AUTHORITY_LOCK_TEMP_PREFIX)) {
      try {
        removable = now() - statSync(join(dir, name)).mtimeMs > STALE_CLAIM_TEMP_MS;
      } catch {
        removable = false;
      }
    }
    if (!removable) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* concurrently pruned */
    }
  }
  return true;
}

/**
 * Revoke the publish capability of every LOWER epoch of our generation, and
 * prove it: returns true only once none remains.
 *
 * Must complete before this acquisition commits. A stale holder that passed its
 * commit proof and was then suspended stages and renames through its own
 * capability; once that directory is gone its write fails instead of replacing
 * ours. If revocation cannot be proven (for example a permission error inside a
 * stale capability) the caller fails closed rather than commit next to a writer
 * that may still be able to publish.
 */
function revokeCapabilitiesBelow(dir: string, generation: string, epoch: number): boolean {
  for (let attempt = 0; attempt < CAPABILITY_REVOKE_ATTEMPTS; attempt += 1) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // The whole namespace is gone, and every capability with it.
      return ABSENT_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '');
    }
    const stale = names.filter((name) => {
      const match = EPOCH_CAPABILITY_NAME.exec(name);
      return match !== null && match[1] === generation && Number(match[2]) < epoch;
    });
    if (stale.length === 0) return true;
    for (const name of stale) {
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch {
        /* retried, then proven or failed closed below */
      }
    }
  }
  return false;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === 'function') timer.unref();
});

/**
 * Take the cross-process publication lock, or return null when it cannot be
 * taken SAFELY within the bounded wait.
 *
 * A lock is taken over ONLY on positive proof its holder process is gone
 * (`ownerRemainsAuthoritative` false, which it never is for an indeterminate
 * probe). Age, a matching `{pid, startToken}`, and "looked unchanged for a
 * while" are never reasons. Unreadable or unattributable lock state fails
 * closed.
 *
 * Taking over never removes anything: it claims the NEXT epoch. That is the
 * point of the epoch form - see `HOOK_AUTHORITY_LOCK_DIR_NAME`.
 */
async function acquirePublicationLock(
  home: string,
  owner: HookAuthorityOwner,
  probeLiveness: (pid: number) => ProcessLiveness,
  now: () => number,
  beforeClaim?: (barrier: PublicationLockBarrier) => Promise<void>,
  afterClaim?: (barrier: PublicationLockBarrier) => Promise<void>,
): Promise<PublicationLock | null> {
  const dir = hookAuthorityLockDirPath(home);

  for (let attempt = 0; attempt < HOOK_PUBLISH_LOCK.maxAttempts; attempt += 1) {
    // Re-created every attempt: the directory may have been removed.
    mkdirSync(dir, { recursive: true });
    // An older build's single-file lock is respected, never modified.
    const legacy = readLegacyLock(home);
    if (legacy.kind === 'error' || legacy.kind === 'unparseable') return null;
    if (legacy.kind === 'holder'
      && ownerRemainsAuthoritative(legacy.holder, probeLiveness(legacy.holder.pid))) {
      await sleepMs(HOOK_PUBLISH_LOCK.retryDelayMs);
      continue;
    }

    const current = ensureGeneration(dir);
    if (current.kind === 'raced') continue;
    if (current.kind !== 'ok') return null; // corrupt or unreadable namespace: fail closed
    const { generation } = current;

    const view = readEpochView(dir, generation);
    if (view.kind === 'raced') continue;
    if (view.kind === 'error' || view.kind === 'corrupt') return null;

    let next = 1;
    if (view.kind === 'epoch') {
      if (!view.released
        && ownerRemainsAuthoritative(view.holder, probeLiveness(view.holder.pid))) {
        await sleepMs(HOOK_PUBLISH_LOCK.retryDelayMs);
        continue;
      }
      next = view.epoch + 1;
    }

    // Barrier: validation is complete and nothing has been claimed yet. A
    // contender suspended here that resumes after a successor claimed `next`
    // gets EEXIST and re-evaluates - it has no removal to get wrong.
    if (beforeClaim) await beforeClaim({ epoch: next });

    const claimed = claimEpoch(dir, generation, next, owner, now);
    if (claimed) {
      // Barrier: claimed, not yet pruned - the gap in which the directory can be
      // reset and re-claimed by a successor.
      if (afterClaim) await afterClaim({ epoch: next });
      if (!pruneEpochsBelow(dir, generation, next, now)) {
        // Could not revoke a predecessor's capability: do not commit beside it.
        await releasePublicationLock(claimed);
        return null;
      }
      return claimed;
    }
  }
  return null;
}

/**
 * Whether this acquisition still holds the lock at the commit point.
 *
 * The acquisition nonce of the highest epoch must be ours: a successor that
 * took over after this process was declared dead holds a higher epoch with a
 * different nonce. Epoch equality and the released marker are deliberately not
 * re-checked here - nonces are unique, so "highest nonce is mine" already
 * implies "highest epoch is mine", and nobody but this acquisition creates its
 * released marker. A live older-format holder that appeared mid-transaction
 * also voids the commit.
 */
function holdsPublicationLock(
  lock: PublicationLock,
  home: string,
  probeLiveness: (pid: number) => ProcessLiveness,
): boolean {
  const legacy = readLegacyLock(home);
  if (legacy.kind === 'error' || legacy.kind === 'unparseable') return false;
  if (legacy.kind === 'holder'
    && ownerRemainsAuthoritative(legacy.holder, probeLiveness(legacy.holder.pid))) {
    return false;
  }
  // Read (never create) the CURRENT generation. After a reset it is a different
  // token, the view is of the new namespace, and its holder's nonce cannot be
  // ours - so comparing the nonce of the current generation's holder already
  // verifies "same generation"; a separate token comparison would be redundant.
  const current = readGeneration(lock.dir);
  if (current.kind !== 'ok') return false;
  const view = readEpochView(lock.dir, current.generation);
  return view.kind === 'epoch' && view.holder.nonce === lock.nonce;
}

/**
 * Release by CREATING this acquisition's released marker.
 *
 * No validation, and no removal: the marker's name embeds our epoch and nonce,
 * so creating it can only ever release our own acquisition. A stale actor whose
 * lock was taken over leaves an inert marker beside an epoch nobody holds any
 * more, and the successor's entry is untouched.
 */
async function releasePublicationLock(
  lock: PublicationLock,
  beforeRelease?: (barrier: PublicationLockBarrier) => Promise<void>,
): Promise<void> {
  if (beforeRelease) await beforeRelease({ epoch: lock.epoch });
  try {
    writeFileSync(join(lock.dir, epochReleasedName(lock.generation, lock.epoch, lock.nonce)), '', {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
  } catch {
    /* already released, or the directory was removed externally */
  }
}

/** Whether the daemon-lock identity changed between the authorize snapshot and
 *  the commit point. ANY change fails the transaction closed. */
function lockOwnerChanged(
  snapshot: DaemonProcessIdentity | null,
  current: DaemonProcessIdentity | null,
): boolean {
  if (snapshot === null && current === null) return false;
  if (snapshot === null || current === null) return true;
  return !sameHookAuthorityOwner(snapshot, current);
}

/** The acquisition's publish capability was revoked (a successor took over,
 *  or the lock namespace was reset) between its proof and its write. */
class PublishCapabilityRevokedError extends Error {
  constructor(readonly target: string) {
    super(`hook authority publish capability revoked before writing ${target}`);
    this.name = 'PublishCapabilityRevokedError';
  }
}

/**
 * Replace `target` with `contents` ONLY while this acquisition's capability
 * still exists.
 *
 * Stage inside the capability (never created here - no `recursive`), then one
 * `rename` out. Revocation removes the capability, so after it both steps fail
 * with ENOENT. A rename that wins the race with revocation necessarily lands
 * before the successor commits (it revokes first), so the successor's commit
 * supersedes it.
 */
function writeThroughCapability(lock: PublicationLock, target: string, contents: string): void {
  const staged = join(publicationCapabilityDir(lock), `${basename(target)}.staged`);
  try {
    writeFileSync(staged, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(staged, target);
  } catch (error) {
    if (ABSENT_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw new PublishCapabilityRevokedError(target);
    }
    try {
      unlinkSync(staged);
    } catch {
      /* nothing staged */
    }
    throw error;
  }
}

/**
 * Publish this process as the hook endpoint owner.
 *
 * Guard (fixture containment): a test-runner process MUST NOT write the
 * machine-global record. Eight suites call `startHookServer()` for real, and
 * without a sandboxed home each one overwrote the live daemon's `hook-port`.
 * Tests that legitimately need the files inject `home` (a temp dir) and set
 * `allowGlobalWriteInTests`.
 *
 * Fencing:
 *  - sidecar `record` owned by ANOTHER pid that `ownerRemainsAuthoritative`
 *    still vouches for ⇒ refuse (`publishFenced`);
 *  - sidecar `record` owned by this same `{pid,startToken}` ⇒ overwrite (this is
 *    the rebind / republish path);
 *  - owner provably gone ⇒ overwrite;
 *  - `legacy` bare port with no identity ⇒ overwrite only when it is our own
 *    port or nothing is listening there; a live listener on a different port is
 *    still somebody's endpoint, so refuse;
 *  - absent / malformed ⇒ overwrite.
 *
 * Write order: sidecar FIRST, then the bare port. If the process dies between
 * them the sidecar port disagrees with the bare port, and
 * `readHookAuthorityState` downgrades to `legacy` rather than trusting a
 * mismatched identity.
 */
export async function publishHookAuthority(
  port: number,
  deps: PublishHookAuthorityDeps = {},
): Promise<PublishHookAuthorityResult> {
  const home = deps.home ?? imcodesHomeDir();
  const owner = deps.owner ?? currentDaemonProcessIdentity();
  const readState = deps.readState ?? ((target: string) => readHookAuthorityState(target));
  const probeLiveness = deps.probeLiveness ?? probeProcessLiveness;
  const probeListener = deps.probeListener ?? ((candidate: number) => probeHookPort(candidate));
  const isTestRuntime = deps.isTestRuntime ?? runningUnderTestRunner;
  const now = deps.now ?? Date.now;

  const targetsGlobalRecord = home === imcodesHomeDir();

  // ── Guard 2 (PRIMARY, environment-independent): instance-lock ownership.
  //
  // Only the process holding the daemon instance lock serves the machine's hook
  // endpoint, so only it may publish the record. This replaces an earlier
  // VITEST-env guard that a real escape proved insufficient: a test can spawn
  // the daemon / stdio MCP as a CHILD process, and that child does NOT inherit
  // `VITEST`, so it ran as "production", kept the real HOME, and republished
  // over the live daemon's record mid-suite. Ownership is a property of the
  // machine, not of the environment, so it cannot be lost across a spawn.
  // ── Guard 1 (containment): an in-process test runner never writes the
  // machine-global record.
  //
  // Evaluated FIRST so the reported reason is accurate. When a live daemon lock
  // exists on the developer machine, the ownership guard below would otherwise
  // answer `publishFenced` for a test process - and a caller cannot then tell
  // "a test deliberately did not publish" from "we must not own this endpoint",
  // which are opposite instructions for startup convergence.
  if (isTestRuntime() && !deps.allowGlobalWriteInTests && targetsGlobalRecord) {
    return { published: false, reason: HOOK_AUTHORITY_ERROR.publishSuppressedForTests };
  }

  const lockOwner = (deps.readLockOwner ?? defaultLockOwner)(home);
  /**
   * This process is the machine's PROVEN hook publisher: the daemon instance
   * lock names exactly this `{pid, startToken}`.
   *
   * This is the strongest authentication available locally, and it must OUTRANK
   * the unauthenticated compatibility fences below. Previously it did not: the
   * legacy fence refused publication whenever any live listener sat on the old
   * recorded port, so an unauthenticated stale or foreign listener on 51915
   * could indefinitely block the authoritative live daemon from publishing
   * 51941 - recreating the very incident this work exists to fix.
   *
   * Note this grants no power over OTHER processes: nothing is killed, and a
   * non-owner is still fenced by exact `{pid, startToken}` identity.
   */
  const isProvenLockOwner = lockOwner !== null && sameHookAuthorityOwner(lockOwner, owner);

  if (targetsGlobalRecord && !deps.allowGlobalWriteInTests) {
    if (lockOwner && !isProvenLockOwner) {
      if (ownerRemainsAuthoritative(lockOwner, probeLiveness(lockOwner.pid))) {
        return {
          published: false,
          reason: HOOK_AUTHORITY_ERROR.publishFenced,
          heldBy: { pid: lockOwner.pid, startToken: lockOwner.startToken },
        };
      }
    }
  }

  // ── Barrier: the only suspension point, and it is OUTSIDE the critical
  // section on purpose (see `afterAuthorize`).
  if (deps.afterAuthorize) await deps.afterAuthorize();

  // ── Critical section. Everything from here to the commit is serialized
  // across processes and re-validated, because publication is a
  // read-authorize-write TRANSACTION over two files and it contains an
  // `await`. Atomic per-file renames alone do not prevent a stale publisher
  // from authorizing, pausing, and then overwriting a successor's record.
  const publicationLock = await acquirePublicationLock(
    home, owner, probeLiveness, now, deps.beforeClaim, deps.afterClaim,
  );
  if (!publicationLock) {
    return { published: false, reason: HOOK_AUTHORITY_ERROR.publishLockUnavailable };
  }

  try {
    // ── Commit-point re-validation (CAS on ownership identity).
    //
    // ANY change to the exact daemon-lock identity between the snapshot and
    // here means authority moved while we were suspended, so this transaction
    // is stale and MUST NOT commit - even if we were the proven owner when we
    // started.
    const lockOwnerAtCommit = (deps.readLockOwner ?? defaultLockOwner)(home);
    if (lockOwnerChanged(lockOwner, lockOwnerAtCommit)) {
      return {
        published: false,
        reason: HOOK_AUTHORITY_ERROR.publishFenced,
        ...(lockOwnerAtCommit
          ? { heldBy: { pid: lockOwnerAtCommit.pid, startToken: lockOwnerAtCommit.startToken } }
          : {}),
      };
    }
    // NOTE: no second ownership fence here on purpose. Given the identity CAS
    // above, this point is reachable only when snapshot === current, and the
    // pre-barrier guard already refused that exact case with the same data and
    // the same predicate. A fence here would be unreachable, and a mutation
    // test proved it: disabling it changed nothing. Unreachable defence makes
    // it impossible to tell which check is actually load-bearing, so the CAS is
    // left as the single authority on "did ownership move under us".

    // Record state is re-read INSIDE the lock; the snapshot taken before the
    // barrier is never used for the fence decision.
    const existing = readState(home);
    // The proven lock owner may always REPAIR the record - that is the whole
    // point of holding the lock. Every fence below is for publishers that
    // cannot prove ownership.
    if (!isProvenLockOwner) {
      if (existing.kind === 'record' && !sameHookAuthorityOwner(existing.record, owner)) {
        if (ownerRemainsAuthoritative(existing.record, probeLiveness(existing.record.pid))) {
          return {
            published: false,
            reason: HOOK_AUTHORITY_ERROR.publishFenced,
            heldBy: { pid: existing.record.pid, startToken: existing.record.startToken },
          };
        }
      } else if (existing.kind === 'portMismatch'
        && !sameHookAuthorityOwner(existing.record, owner)
        && ownerRemainsAuthoritative(existing.record, probeLiveness(existing.record.pid))) {
        // A live foreign owner is mid-publish or was torn; do not race it.
        return {
          published: false,
          reason: HOOK_AUTHORITY_ERROR.publishFenced,
          heldBy: { pid: existing.record.pid, startToken: existing.record.startToken },
        };
      } else if ((existing.kind === 'legacy' || existing.kind === 'sidecarUnreadable')
        && existing.port !== port) {
        // No usable identity recorded, so endpoint liveness is the only signal
        // a NON-owner has. A proven lock owner never reaches this branch.
        if (await probeListener(existing.port)) {
          return { published: false, reason: HOOK_AUTHORITY_ERROR.publishFenced };
        }
      }
    }

    if (deps.beforeCommit) await deps.beforeCommit();

    // ── Commit-point MUTUAL-EXCLUSION re-validation (CAS on the lock itself).
    //
    // Holding the lock at acquisition is not the same as holding it at the
    // commit. This transaction contains awaits (the record re-read, the
    // listener probe), and a successor may LEGITIMATELY recover the lock in
    // between once this process has been declared dead. The daemon-lock
    // identity CAS above cannot catch that: it compares a snapshot taken
    // before the suspension, so a publisher suspended AFTER passing it still
    // passes it.
    //
    // Requiring our exact acquisition (nonce + file object) to still be the
    // recorded holder is what makes a resumed stale publisher write nothing.
    // It is the LAST statement before the writes, with no await after it, so
    // the check and the commit are one step.
    if (!holdsPublicationLock(publicationLock, home, probeLiveness)) {
      return { published: false, reason: HOOK_AUTHORITY_ERROR.publishLockLost };
    }

    if (deps.afterProof) await deps.afterProof();

    // Writes go THROUGH this acquisition's capability (see
    // HOOK_AUTHORITY_LOCK_CAPABILITY_SUFFIX). The proof above is necessary but,
    // across processes, a proof can go stale before the write; the capability
    // is what makes a stale write fail rather than replace a successor's file.
    const writeFile = deps.writeFile
      ?? ((target: string, contents: string) => writeThroughCapability(publicationLock, target, contents));

    const record: HookAuthorityRecord = {
      version: HOOK_AUTHORITY_RECORD_VERSION,
      port,
      pid: owner.pid,
      startToken: owner.startToken,
      publishedAt: now(),
    };
    try {
      writeFile(hookAuthoritySidecarPath(home), serializeHookAuthorityRecord(record));
      if (deps.betweenWrites) await deps.betweenWrites();
      // MUST remain digits-only: every not-yet-upgraded daemon/CLI on this
      // machine parses this file and nothing else.
      writeFile(hookPortFilePath(home), serializeHookPortFile(port));
    } catch (error) {
      if (error instanceof PublishCapabilityRevokedError) {
        return { published: false, reason: HOOK_AUTHORITY_ERROR.publishLockLost };
      }
      throw error;
    }
    return { published: true, record };
  } finally {
    await releasePublicationLock(publicationLock, deps.beforeRelease);
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolveHookPortDeps {
  home?: string;
  readState?: (home: string) => HookAuthorityState;
  /** forwarded to `readHookAuthorityState` when `readState` is not overridden */
  readFile?: (path: string) => AuthorityFileRead;
  fetchIdentity?: (port: number) => Promise<HookIdentityResponse | null>;
  probeListener?: (port: number) => Promise<boolean>;
  probeLiveness?: (pid: number) => ProcessLiveness;
}

/**
 * Resolve the live hook endpoint with OWNER VERIFICATION.
 *
 * Deliberately scan-free. Every failure is attributable:
 *  - nothing published      → `daemon_hook_unavailable`
 *  - malformed bytes        → `hook_authority_unreadable`
 *  - owner gone, or another process answers → `stale_hook_authority`
 *  - owner still authoritative but silent   → `daemon_hook_unavailable`
 */
export async function resolveHookAuthority(
  deps: ResolveHookPortDeps = {},
): Promise<HookAuthorityResolution> {
  const home = deps.home ?? imcodesHomeDir();
  const readState = deps.readState
    ?? ((target: string) => readHookAuthorityState(target, deps.readFile ? { readFile: deps.readFile } : {}));
  const fetchIdentity = deps.fetchIdentity ?? ((port: number) => fetchHookIdentity(port));
  const probeListener = deps.probeListener ?? ((port: number) => probeHookPort(port));
  const probeLiveness = deps.probeLiveness ?? probeProcessLiveness;

  const state = readState(home);
  if (state.kind === 'absent') {
    return { ok: false, reason: HOOK_AUTHORITY_ERROR.hookUnavailable, detail: 'no hook-port record' };
  }
  if (state.kind === 'invalid') {
    return { ok: false, reason: HOOK_AUTHORITY_ERROR.unreadable };
  }

  // Structured sidecar evidence that cannot be reconciled MUST fail closed with
  // a determinate reason. Falling through to the legacy connect-only path here
  // is what let a corrupt sidecar or a torn pair bypass owner verification.
  if (state.kind === 'sidecarUnreadable') {
    return {
      ok: false,
      reason: HOOK_AUTHORITY_ERROR.unreadable,
      detail: `hook-port ${state.port} has an authority sidecar that could not be read or parsed`,
    };
  }
  if (state.kind === 'portMismatch') {
    return {
      ok: false,
      reason: HOOK_AUTHORITY_ERROR.staleHookAuthority,
      detail: `authority sidecar names port ${state.record.port} but hook-port says ${state.port}`,
    };
  }

  if (state.kind === 'legacy') {
    // Pre-upgrade daemon with NO sidecar at all: there is no identity route to
    // ask, so accept the recorded port iff it answers, and NEVER move to a
    // different port. This is the ONLY connect-only path that remains.
    if (await probeListener(state.port)) {
      return { ok: true, port: state.port, owner: null };
    }
    return {
      ok: false,
      reason: HOOK_AUTHORITY_ERROR.staleHookAuthority,
      detail: `legacy hook-port ${state.port} does not answer`,
    };
  }

  const { record } = state;
  const identity = await fetchIdentity(record.port);
  if (identity && sameHookAuthorityOwner(identity, record)) {
    if (identity.port !== record.port) {
      return {
        ok: false,
        reason: HOOK_AUTHORITY_ERROR.staleHookAuthority,
        detail: `owner reports port ${identity.port}, record says ${record.port}`,
      };
    }
    return { ok: true, port: record.port, owner: { pid: record.pid, startToken: record.startToken } };
  }

  if (identity) {
    return {
      ok: false,
      reason: HOOK_AUTHORITY_ERROR.staleHookAuthority,
      detail: `port ${record.port} is owned by pid ${identity.pid}, record says pid ${record.pid}`,
    };
  }

  // Nobody answered the identity route. If the recorded owner is provably gone
  // the record is stale; if it is (or may be) alive, the endpoint is merely
  // unavailable right now — never invalidate a live daemon's record.
  if (!ownerRemainsAuthoritative(record, probeLiveness(record.pid))) {
    return {
      ok: false,
      reason: HOOK_AUTHORITY_ERROR.staleHookAuthority,
      detail: `recorded owner pid ${record.pid} is gone`,
    };
  }
  return {
    ok: false,
    reason: HOOK_AUTHORITY_ERROR.hookUnavailable,
    detail: `recorded owner pid ${record.pid} did not answer ${HOOK_IDENTITY_HOOK_PATH}`,
  };
}

/** Back-compatible port-only resolution. Prefer `resolveHookAuthority` when the
 *  caller needs to report WHY the hook is unreachable. */
export async function resolveLiveHookPort(deps: ResolveHookPortDeps = {}): Promise<number | null> {
  const resolution = await resolveHookAuthority(deps);
  return resolution.ok ? resolution.port : null;
}
