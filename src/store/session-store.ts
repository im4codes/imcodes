import { statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import type { QwenAuthType } from '../../shared/qwen-auth.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import {
  isDelegationLimitActive,
  observeProviderLimitSignal,
  type DelegationLimitState,
  type ProviderLimitSignal,
} from '../../shared/delegation-availability.js';
import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import type { SessionContextBootstrapState } from '../../shared/session-context-bootstrap.js';
import type { CrossVendorHandoffSessionState } from '../../shared/cross-vendor-handoff.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import {
  SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION,
  SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY,
  SESSIONS_JSON_COMPAT_EXPORT_MIN_INTERVAL_MS,
  isSessionsJsonCompatExportEnabled,
} from '../../shared/session-store-compat.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { EXECUTION_CLONE_KIND, type ExecutionCloneMetadata } from '../../shared/execution-clone.js';
import { isMarkedSessionLaunchIdentity } from '../../shared/session-resource-lifecycle.js';
import { emitSessionStateProbeCorrection } from './session-state-probe-events.js';
import {
  SESSION_DB_FILE,
  SESSION_DB_LEGACY_IMPORT_DONE,
  SESSION_DB_META_LEGACY_IMPORT,
  EmptyStoreRefusal,
  closeSessionDb,
  commitSessionChanges,
  countSessionRows,
  countSnapshotRows,
  importLegacySessions,
  markLegacyImportDone,
  openSessionDbForWrite,
  openSessionDbReadOnly,
  readSessionDbMeta,
  readSessionPayloads,
  readSnapshotPayloads,
  snapshotSessionDb,
  type SessionDbHandle,
  type SessionDbRow,
} from './session-store-db.js';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { assertNotRealImcodesPathInTests, isRealImcodesPath, isUnderTestRunner } from '../util/test-home-guard.js';
import { readInstanceLockMetadata, isRecordedProcessIdentityCurrent, type DaemonProcessIdentity } from '../daemon/instance-lock.js';
import logger from '../util/logger.js';
import { SESSION_ERROR_WORKING_DIRECTORY_NOT_FOUND } from '../../shared/session-errors.js';

const DEBOUNCE_MS = 500;
const SESSION_STORE_DISK_VERSION = 2;
/** The pre-SQLite snapshot: read once by the migration, then frozen under this suffix. */
const LEGACY_JSON_FILE = 'sessions.json';
const LEGACY_JSON_FROZEN_SUFFIX = '.migrated-to-sqlite';
const LEGACY_JSON_BACKUP_COUNT = 5;
/**
 * Records mutated in place through getSession() (no store call announces them)
 * are picked up by a full compare of every row against what was last written.
 * That compare serialises the whole store (~3 ms at 300 sessions, in yielding
 * slices), so it runs at most this often on a flush, and always on an explicit flushStore() (shutdown).
 */
const FULL_SWEEP_INTERVAL_MS = 5_000;
/** The sweep serialises in slices of at most this long, yielding between them. */
let sweepSliceMs = 2;
/** An online snapshot of the database is taken at most this often; the newest few are kept. */
let backupIntervalMs = 60 * 60 * 1000;
const SESSION_DB_BACKUP_COUNT = 3;

/** Test seams. */
export function setSessionStoreSweepSliceMsForTests(ms: number | undefined): void {
  sweepSliceMs = ms ?? 2;
}
export function setSessionStoreBackupIntervalMsForTests(ms: number | undefined): void {
  backupIntervalMs = ms ?? 60 * 60 * 1000;
}

function storeDir(): string {
  return join(homedir(), '.imcodes');
}

function dbPath(): string {
  return join(storeDir(), SESSION_DB_FILE);
}

function legacyJsonPath(): string {
  return join(storeDir(), LEGACY_JSON_FILE);
}

export type SessionState = 'running' | 'idle' | 'error' | 'stopped';

// TODO: import from '../agent/session-runtime.js' when available
type RuntimeType = 'process' | 'transport';

export interface SessionRecord extends SessionContextBootstrapState {
  name: string;
  /**
   * Stable identity for this logical session record. It survives daemon and
   * runtime restarts, but is regenerated after a true remove/recreate.
   * Optional at the type boundary so legacy snapshots and callers can be
   * migrated by the authoritative store.
   */
  sessionInstanceId?: string;
  /**
   * Identity of the current process/provider authority. It changes when that
   * authority is replaced, while ordinary state/model updates preserve it.
   * Optional only for legacy/read compatibility; authoritative upserts fill it.
   */
  runtimeEpoch?: string;
  projectName: string;
  role: 'brain' | `w${number}`;
  agentType: string;
  agentVersion?: string;
  projectDir: string;
  state: SessionState;
  /** Human-readable reason for the current error state. Cleared on non-error states. */
  error?: string;
  restarts: number;
  restartTimestamps: number[];
  createdAt: number;
  updatedAt: number;
  /** Opaque backend-specific terminal pane handle (tmux: "%42", WezTerm: numeric pane_id).
   *  Recorded at session creation. Used for pipe-pane streaming (tmux) and name→pane mapping (WezTerm). */
  paneId?: string;
  /** CC session UUID used with --session-id / --resume for deterministic JSONL path. */
  ccSessionId?: string;
  /** Codex session UUID extracted from rollout filename, used for `codex resume <UUID>`. */
  codexSessionId?: string;
  /** Gemini session UUID obtained from stream-json init event, used for `gemini --resume <UUID>`. */
  geminiSessionId?: string;
  /** OpenCode session ID used for `opencode -s <ID>` deterministic resume/history lookup. */
  opencodeSessionId?: string;
  /** Qwen model ID used for transport sends (`qwen --model <ID>`). */
  qwenModel?: string;
  /** When true, next Qwen session restore must start a fresh conversation (not --resume).
   *  Set after cancel to prevent resuming a stuck tool-call loop. */
  qwenFreshOnResume?: boolean;
  /** Qwen auth source detected from local CLI config/status. */
  qwenAuthType?: QwenAuthType;
  /** Human-readable auth limit text from `qwen auth status`. */
  qwenAuthLimit?: string;
  /** Qwen models available for the current auth source. */
  qwenAvailableModels?: string[];
  /** Copilot models reported by `client.listModels()` (full SDK list, not the
   *  hardcoded fallback). Hydrated by `buildSessionList` for `copilot-sdk`
   *  agent sessions so the web model picker can show every supported model. */
  copilotAvailableModels?: string[];
  /** Cursor models reported by `cursor-agent --list-models`. Hydrated by
   *  `buildSessionList` for `cursor-headless` agent sessions. */
  cursorAvailableModels?: string[];
  /** Codex SDK models reported by the app-server `model/list` RPC. Hydrated
   *  for `codex-sdk` sessions so the web picker can reflect the live model set. */
  codexAvailableModels?: string[];
  /** Generic display model override for UI footer/header. */
  modelDisplay?: string;
  /** User-requested transport model persisted for restart/rebuild/cross-device restore. */
  requestedModel?: string;
  /** Active/effective transport model persisted from runtime/provider state. */
  activeModel?: string;
  /** Generic commercial/plan badge label (e.g. Free, Paid, BYO). */
  planLabel?: string;
  /** Generic permission/sandbox badge label (e.g. all, ask). */
  permissionLabel?: string;
  /** Generic quota/limit badge label (e.g. 1000/day, 60/min). */
  quotaLabel?: string;
  /** Generic quota progress label (e.g. today 12/1000 · 1m 1/60). */
  quotaUsageLabel?: string;
  /** Structured quota metadata for client-side countdown rendering. */
  quotaMeta?: ProviderQuotaMeta;
  /**
   * Codex pay-as-you-go usage credit balance (bought once the plan's
   * included 5h/weekly quota runs out) — decimal string, e.g. "12.50".
   * DIFFERENT from the rate-limit "reset credits" affordance
   * (shared/codex-reset-credits.ts), which is never persisted on the
   * session record. See shared/codex-credit-history.ts.
   */
  codexCreditsBalance?: string;
  codexCreditsHasCredits?: boolean;
  codexCreditsUnlimited?: boolean;
  /**
   * Machine-readable provider limit, from a canonical {@link ProviderLimitSignal}.
   *
   * Persisted deliberately. A limit that lived only in memory would be
   * forgotten on every daemon restart, and an orchestrator would go straight
   * back to handing work to an account that is still being refused. Distinct
   * from `quotaMeta`, which is display telemetry and carries no verdict:
   * `usedPercent` is undefined while Claude is healthy, so it cannot answer
   * "are we being refused" and must never be thresholded into one.
   *
   * Cleared by a healthy structured signal, and treated as expired -- not
   * cleared -- once `retryAt` or the bounded fallback passes.
   */
  providerLimit?: DelegationLimitState;
  /** Generic reasoning/thinking effort for supported providers. */
  effort?: TransportEffortLevel;
  /**
   * Provider service tier for this session, when it has one. Persisted so a
   * viewer that reconnects still learns the session is on Codex's Fast tier.
   */
  serviceTier?: string;
  /** Provider-specific transport settings that must not expand the top-level schema. */
  transportConfig?: Record<string, unknown>;
  /** Parent main session name (e.g. `deck_proj_brain`) — links sub-sessions to their parent. */
  parentSession?: string;
  /** Runtime type — 'process' for tmux, 'transport' for network-backed. Defaults to 'process' for backward compat. */
  runtimeType?: RuntimeType;
  /** Transport provider ID (e.g. 'openclaw', 'minimax'). Only set for transport sessions. */
  providerId?: string;
  /** Provider-side session ID/key. For OpenClaw this is the OC session key. */
  providerSessionId?: string;
  /** Provider-side durable resume/session identifier for shared local-sdk providers. */
  providerResumeId?: string;
  /** Session description — used for persona/system prompt injection. */
  description?: string;
  /** Effective synchronized user/project/session identity contract. */
  identityPrompt?: string;
  /** SHA-256 of the explicit startup identity used for deterministic Agent reuse. */
  provisionedIdentityHash?: string;
  /** CC env preset name — persisted so respawn can re-inject the same env vars. */
  ccPreset?: string;
  /** Context window override carried by a provider preset (for example MiniMax-M3 1M). */
  presetContextWindow?: number;
  /** Shell/script launch binary (e.g. "/bin/bash", "fish"). CONFIG, not identity —
   *  inherited by execution clones and synced to the server `sub_sessions.shell_bin`
   *  column. Only meaningful for `shell`/`script` agent sessions. Host-normalized at
   *  launch so a cross-OS path is dropped rather than executed. */
  shellBin?: string | null;
  /** Human-readable label for UI display (e.g. "OC:main", "discord:#general"). */
  label?: string;
  /** True for sessions created by the user (not auto-synced from provider).
   *  User-created sessions must not be deleted/stopped by sync or health checks. */
  userCreated?: boolean;
  /** True once the transport runtime has already injected its "startup memory"
   *  (related-past-work preamble) into the provider context for this session.
   *  Persisted so daemon restart / session restart do NOT re-inject history
   *  into an existing conversation. Reset on /clear (fresh conversation) or
   *  genuine new-session creation. */
  startupMemoryInjected?: boolean;
  /** Ring buffer of per-turn memory-ID sets that have been injected into
   *  this session's recall prompts (most recent first, bounded by
   *  RECENT_INJECTION_HISTORY_SIZE). Persisted so daemon restart does not
   *  re-dedup from zero and re-inject the same memories into an agent that
   *  already has them in its own conversation history.
   *
   *  Semantics match the in-memory Map in recent-injection-history.ts:
   *  1 turn = 1 inner array (regardless of how many IDs it carries).
   *  Wiped on `/clear` / fresh-restart alongside the runtime state. */
  recentInjectionHistory?: string[][];
  /** Content fingerprints of project recent-summary entries already delivered
   *  to this conversation. Unlike recentInjectionHistory this is an exact
   *  conversation-lifetime ledger: it prevents startup/subsequent summary
   *  synchronization from repeating after daemon restart. Cleared only for a
   *  genuinely fresh conversation (`/clear` / fresh restart). */
  summarySyncFingerprints?: string[];
  /** Cross-vendor continuity ledger and at-most-once pending handoff pack. */
  crossVendorHandoff?: CrossVendorHandoffSessionState;
  /** Execution-clone metadata. Present ONLY for ephemeral execution-clone
   *  sub-sessions (`kind: 'execution_clone'`). First-class field — NEVER stored
   *  inside `transportConfig` (the transport-identity scrubber would strip
   *  identity-like keys). Read by the health-poller clone-skip, the clone GC
   *  sweep, the daemon→server metadata sync, and authorized status surfaces.
   *  Persisted in the FIRST session-store upsert so a crash between create and
   *  sync still leaves a sweepable record. */
  executionCloneMetadata?: ExecutionCloneMetadata;
  /**
   * Durable, instance-bound demand that every runtime serving this session
   * withholds provider-native agent tools (shared/native-collaboration-policy.ts
   * SESSION_FENCE). Set when the session takes supervised authority it could not
   * yet prove; never cleared by an incidental record rebuild, and meaningless
   * for any other instance that reuses the name.
   */
  nativeAgentFenceRequired?: { sessionInstanceId: string; requiredAt: number };
  /**
   * The native-agent fence a PROCESS runtime was actually launched with, bound
   * to the exact instance and runtime epoch it was decided for. A proof from an
   * older epoch or another instance proves nothing about the live runtime.
   */
  nativeAgentLaunchFence?: {
    fence: 'disabled' | 'provider_default';
    sessionInstanceId: string;
    runtimeEpoch: string;
    decidedAt: number;
  };
}

export interface SessionStore {
  sessions: Record<string, SessionRecord>;
}

interface PersistedSessionRecord extends Omit<SessionRecord, 'identityPrompt'> {
  identityPromptRef?: string;
}

/** The pre-SQLite sessions.json shape, read only by the one-time migration and the unmigrated read-only fallback. */
interface PersistedSessionStoreV2 {
  version: typeof SESSION_STORE_DISK_VERSION;
  sessions: Record<string, PersistedSessionRecord>;
  identityPrompts: Record<string, string>;
}

export interface LoadStoreOptions {
  /**
   * Probe terminal-backed sessions after loading. Disable for short-lived
   * read-only consumers such as MCP tool calls that only need a fresh
   * persisted snapshot.
   */
  probe?: boolean;
}

export interface SessionStoreWriteAuthority {
  identity: DaemonProcessIdentity;
  metadataPath: string;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeTimerPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pendingWrite: Promise<void> | null = null;
let store: SessionStore = { sessions: {} };
let storeLoaded = false;
let storeWriteAuthority: SessionStoreWriteAuthority | null = null;
/** The writer connection: only a process with write authority ever opens one. */
let writerDb: SessionDbHandle | null = null;
/** name -> payload of every row as last committed by (or loaded into) this process. */
let committedPayloads = new Map<string, string>();
/** Sessions changed through the store API since the last commit: the only rows a normal flush touches. */
const dirtyNames = new Set<string>();
let lastFullSweepAt = 0;
let fullSweepRequested = true;
let lastBackupAt = 0;
let backupInFlight: Promise<void> | null = null;
let allowEmptyStoreWrite = false;
let warnedReadOnlyWrite = false;
/** sessions.json compatibility export (shared/session-store-compat.ts): write-only, off the main thread. */
let compatExportPending = false;
let compatExportTimer: ReturnType<typeof setTimeout> | null = null;
let lastCompatExportAt = 0;
let compatExportChain: Promise<void> = Promise.resolve();
/**
 * Set once by the daemon after its startup load: from then on this process's
 * in-memory store is the authority for the persisted sessions, and a read-only
 * refresh (`loadStore({ probe: false })`, e.g. the in-daemon send_message
 * target list) must never replace it with whatever happens to be on disk.
 * Replacing it let a foreign/partial snapshot silently wipe the daemon's live
 * main sessions, which the daemon then persisted.
 */
let storeAuthoritative = false;

export function markSessionStoreAuthoritative(
  identity?: DaemonProcessIdentity,
  metadataPath = join(resolveImcodesHome(), 'daemon.lock.json'),
): void {
  storeAuthoritative = true;
  if (identity) {
    storeWriteAuthority = { identity, metadataPath };
    warnedReadOnlyWrite = false;
  }
}

/** The daemon calls this immediately after acquiring its instance lock. */
export function configureSessionStoreWriteAuthority(
  identity: DaemonProcessIdentity,
  metadataPath = join(resolveImcodesHome(), 'daemon.lock.json'),
): void {
  storeWriteAuthority = { identity, metadataPath };
  warnedReadOnlyWrite = false;
}

/** Explicit administrative action allowing an empty store to replace a non-empty snapshot. */
export function authorizeEmptySessionStoreWrite(): void {
  allowEmptyStoreWrite = true;
}

/** Test seam: return to the non-authoritative (consumer) default. */
export function resetSessionStoreAuthorityForTests(): void {
  storeAuthoritative = false;
  storeWriteAuthority = null;
  storeLoaded = false;
  allowEmptyStoreWrite = false;
  warnedReadOnlyWrite = false;
  closeSessionDb(writerDb);
  writerDb = null;
  committedPayloads = new Map();
  dirtyNames.clear();
  lastFullSweepAt = 0;
  fullSweepRequested = true;
  lastBackupAt = 0;
  resetCompatExportForTests();
  sweepSliceMs = 2;
  backupIntervalMs = 60 * 60 * 1000;
}

function isPersistableSessionRecord(record: SessionRecord): boolean {
  return !isKnownTestSessionLike({
    name: record.name,
    projectName: record.projectName,
    projectDir: record.projectDir,
    parentSession: record.parentSession,
  });
}

function testSessionWouldTouchRealStore(targetPath: string): boolean {
  return isRealImcodesPath(targetPath) && sessionValues().some((record) => isKnownTestSessionLike({
    name: record.name,
    projectName: record.projectName,
    projectDir: record.projectDir,
    parentSession: record.parentSession,
  }));
}

/**
 * @param verifyProcess false skips the process-identity probe (a synchronous `ps`/PowerShell
 * spawn, ~5 ms on macOS and seconds on a loaded Windows host) and keeps the cheap lock-metadata
 * ownership check. Only the write-only compatibility export uses that: it follows a database
 * write that already passed the full check, and must not double the probes per flush.
 */
function hasWriteAuthority(targetPath: string, verifyProcess = true): boolean {
  assertNotRealImcodesPathInTests(targetPath, SESSION_DB_FILE);
  if (testSessionWouldTouchRealStore(targetPath)) {
    throw new Error(`refusing to persist test-looking sessions in the real ~/.imcodes (${targetPath})`);
  }
  // Vitest and explicitly marked test processes are allowed to exercise the
  // real persistence implementation, but only inside an isolated HOME.
  if (isUnderTestRunner() && !isRealImcodesPath(targetPath)) return true;
  const authority = storeWriteAuthority;
  if (!authority) {
    if (!warnedReadOnlyWrite) {
      warnedReadOnlyWrite = true;
      logger.warn({ targetPath }, 'Session store is read-only: process does not own the daemon instance lock');
    }
    return false;
  }
  const lock = readInstanceLockMetadata(authority.metadataPath);
  if (!lock
    || lock.pid !== authority.identity.pid
    || lock.startToken !== authority.identity.startToken
    || (verifyProcess && !isRecordedProcessIdentityCurrent(authority.identity))) {
    if (!warnedReadOnlyWrite) {
      warnedReadOnlyWrite = true;
      logger.warn({ targetPath }, 'Session store write refused: daemon lock ownership changed');
    }
    return false;
  }
  return true;
}

/** The newest non-empty pre-SQLite rotated backup (sessions.json.1-.5): a migration source when sessions.json is missing or empty. */
async function readNewestLegacyJsonBackup(jsonPath: string): Promise<{ store: SessionStore; legacy: boolean } | null> {
  for (let index = 1; index <= LEGACY_JSON_BACKUP_COUNT; index += 1) {
    try {
      const raw = await readFile(`${jsonPath}.${index}`, 'utf8');
      const hydrated = hydrateStore(JSON.parse(raw));
      if (hydrated && Object.keys(hydrated.store.sessions).length > 0) return hydrated;
    } catch {
      // A missing or partially-written older backup is skipped; startup must
      // never fail just because one historical snapshot is corrupt.
    }
  }
  return null;
}

/** One session as a database row. The record is stored whole, as compact JSON. */
function rowFromRecord(name: string, record: SessionRecord): SessionDbRow | null {
  let payload: string;
  try {
    payload = JSON.stringify(record);
  } catch (error) {
    // One unserialisable record must not stop every other session persisting.
    logger.error({ err: error, session: name }, 'Session record cannot be serialised; skipped');
    return null;
  }
  return {
    name,
    projectName: typeof record.projectName === 'string' ? record.projectName : '',
    parentSession: typeof record.parentSession === 'string' ? record.parentSession : null,
    agentType: typeof record.agentType === 'string' ? record.agentType : '',
    state: typeof record.state === 'string' ? record.state : '',
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    payload,
  };
}

/** Rows read from the database, as records. A row that no longer parses is skipped, never fatal. */
function recordsFromPayloads(payloads: Map<string, string>): Record<string, SessionRecord> {
  const sessions: Record<string, SessionRecord> = {};
  for (const [name, payload] of payloads) {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (isObjectRecord(parsed)) sessions[name] = parsed as unknown as SessionRecord;
    } catch (error) {
      logger.error({ err: error, session: name }, 'Session row is not valid JSON; skipped');
    }
  }
  return sessions;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hydrateStore(value: unknown): { store: SessionStore; legacy: boolean } | null {
  if (!isObjectRecord(value) || !isObjectRecord(value.sessions)) return null;

  if (value.version === SESSION_STORE_DISK_VERSION && isObjectRecord(value.identityPrompts)) {
    const sessions: Record<string, SessionRecord> = {};
    for (const [name, rawRecord] of Object.entries(value.sessions)) {
      if (!isObjectRecord(rawRecord)) continue;
      const { identityPromptRef, identityPrompt: inlineIdentityPrompt, ...record } = rawRecord;
      const hydratedRecord = { ...record } as unknown as SessionRecord;
      // Accept an inline value only for a mixed transitional snapshot. A
      // missing or malformed reference must never become an identity prompt.
      if (typeof inlineIdentityPrompt === 'string') {
        hydratedRecord.identityPrompt = inlineIdentityPrompt;
      } else if (
        typeof identityPromptRef === 'string'
        && Object.prototype.hasOwnProperty.call(value.identityPrompts, identityPromptRef)
        && typeof value.identityPrompts[identityPromptRef] === 'string'
      ) {
        hydratedRecord.identityPrompt = value.identityPrompts[identityPromptRef];
      }
      sessions[name] = hydratedRecord;
    }
    return { store: { sessions }, legacy: false };
  }

  // Legacy snapshots stored identityPrompt inline on every session. Keep
  // them readable and rewrite them to the compact schema on the daemon-owned
  // load path. Read-only consumers (probe:false) remain strictly read-only.
  return { store: { sessions: value.sessions as Record<string, SessionRecord> }, legacy: true };
}

function pruneNonPersistableSessions(): boolean {
  const before = Object.keys(store.sessions).length;
  store.sessions = Object.fromEntries(
    Object.entries(store.sessions).filter(([, record]) => isPersistableSessionRecord(record)),
  );
  return Object.keys(store.sessions).length !== before;
}

/** The writer connection for `targetPath`, opened (and the schema created) on first use. */
function writerHandle(targetPath: string): SessionDbHandle {
  if (writerDb && writerDb.path === targetPath) return writerDb;
  // HOME rotates between test workers: what was committed to another database says nothing about this one.
  closeSessionDb(writerDb);
  writerDb = null;
  committedPayloads = new Map();
  dirtyNames.clear();
  fullSweepRequested = true;
  lastBackupAt = 0;
  writerDb = openSessionDbForWrite(targetPath);
  return writerDb;
}

/**
 * One-time import of the pre-SQLite sessions.json, on the first start of a
 * build that has the database. Atomic (rows and the "imported" marker commit
 * together), idempotent, and safe to retry after an interruption. The file is
 * frozen under a new name afterwards as a rollback export and never read again.
 * An unreadable file is reported and left exactly where it is.
 */
async function migrateLegacyJson(handle: SessionDbHandle): Promise<void> {
  if (readSessionDbMeta(handle, SESSION_DB_META_LEGACY_IMPORT) === SESSION_DB_LEGACY_IMPORT_DONE) return;
  const jsonPath = legacyJsonPath();
  let source: { store: SessionStore; legacy: boolean } | null = null;
  let unreadable = false;
  let sourceIsFile = false;
  try {
    const raw = await readFile(jsonPath, 'utf8');
    try {
      source = hydrateStore(JSON.parse(raw));
      sourceIsFile = source !== null;
      if (!source) unreadable = true;
    } catch {
      unreadable = true;
    }
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT') unreadable = true;
  }
  if (unreadable) {
    logger.error({ jsonPath }, 'sessions.json could not be read for migration to SQLite; it is left untouched');
  }
  if (!source || Object.keys(source.store.sessions).length === 0) {
    const backup = await readNewestLegacyJsonBackup(jsonPath);
    if (backup) {
      source = backup;
      sourceIsFile = false;
      logger.warn({ jsonPath }, 'sessions.json was missing or empty; migrating the newest non-empty backup instead');
    }
  }
  // Retry on the next start rather than record "nothing to migrate" for a file we could not read.
  if (unreadable && (!source || Object.keys(source.store.sessions).length === 0)) return;
  const rows: SessionDbRow[] = [];
  for (const [name, record] of Object.entries(source?.store.sessions ?? {})) {
    if (!isObjectRecord(record)) continue;
    const row = rowFromRecord(name, record as unknown as SessionRecord);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    markLegacyImportDone(handle);
  } else {
    const result = importLegacySessions(handle, rows);
    if ('imported' in result) logger.info({ imported: result.imported }, 'Migrated sessions.json to SQLite');
    else logger.warn({ skipped: result.skipped }, 'sessions.json import skipped');
  }
  if (sourceIsFile) {
    try { await rename(jsonPath, `${jsonPath}${LEGACY_JSON_FROZEN_SUFFIX}`); } catch { /* frozen export is best effort; the marker already says the file is never read again */ }
  }
}

/** An empty database with a usable snapshot beside it: restore the newest non-empty one. */
function restoreFromDatabaseSnapshot(handle: SessionDbHandle, targetPath: string): Map<string, string> | null {
  for (let index = 1; index <= SESSION_DB_BACKUP_COUNT; index += 1) {
    const snapshot = `${targetPath}.bak.${index}`;
    if (!countSnapshotRows(snapshot)) continue;
    const payloads = readSnapshotPayloads(snapshot);
    if (!payloads || payloads.size === 0) continue;
    const upserts: SessionDbRow[] = [];
    for (const [name, payload] of payloads) {
      try {
        const row = rowFromRecord(name, JSON.parse(payload) as SessionRecord);
        if (row) upserts.push(row);
      } catch { /* a bad row in an old snapshot is skipped */ }
    }
    if (upserts.length === 0) continue;
    commitSessionChanges(handle, { upserts, deletes: [], allowEmpty: true });
    logger.warn({ snapshot, restored: upserts.length }, 'Session store was empty; restored the newest non-empty database snapshot');
    return new Map(upserts.map((row) => [row.name, row.payload]));
  }
  return null;
}

/** Read-only consumers: the database when it has been migrated, else the pre-SQLite file (never written). */
async function readWithoutAuthority(targetPath: string): Promise<Record<string, SessionRecord> | null> {
  const reader = openSessionDbReadOnly(targetPath);
  try {
    if (reader && readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT) === SESSION_DB_LEGACY_IMPORT_DONE) {
      return recordsFromPayloads(readSessionPayloads(reader));
    }
  } finally {
    closeSessionDb(reader);
  }
  // Not migrated yet (an older daemon still owns sessions.json).
  const jsonPath = legacyJsonPath();
  assertNotRealImcodesPathInTests(jsonPath, LEGACY_JSON_FILE);
  try {
    const hydrated = hydrateStore(JSON.parse(await readFile(jsonPath, 'utf8')));
    if (hydrated && Object.keys(hydrated.store.sessions).length > 0) return hydrated.store.sessions;
    const backup = await readNewestLegacyJsonBackup(jsonPath);
    return backup ? backup.store.sessions : hydrated ? hydrated.store.sessions : null;
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') {
      const backup = await readNewestLegacyJsonBackup(jsonPath);
      return backup ? backup.store.sessions : {};
    }
    throw err;
  }
}

export async function loadStore(options: LoadStoreOptions = {}): Promise<SessionStore> {
  // Bind every asynchronous consequence of this load to the same store path.
  // HOME is stable in production, but test workers deliberately rotate it;
  // a delayed startup probe must never write an old snapshot into the next
  // authority's database after that rotation.
  const targetPath = dbPath();
  assertNotRealImcodesPathInTests(targetPath, SESSION_DB_FILE);
  // The authoritative owner already holds the newest state; a read-only refresh
  // there is a no-op rather than a disk overwrite of live memory.
  if (options.probe === false && storeAuthoritative) return store;
  await drainPendingWritesForRead();
  const canWrite = hasWriteAuthority(targetPath);
  let dirty = false;
  try {
    if (canWrite) {
      await mkdir(dirname(targetPath), { recursive: true });
      const handle = writerHandle(targetPath);
      await migrateLegacyJson(handle);
      let payloads = readSessionPayloads(handle);
      if (payloads.size === 0) {
        const restored = restoreFromDatabaseSnapshot(handle, targetPath);
        if (restored) { payloads = restored; dirty = true; }
      }
      committedPayloads = payloads;
      store = { sessions: recordsFromPayloads(payloads) };
      scheduleCompatExport(targetPath, true); // older processes see the migrated sessions at once
    } else {
      const sessions = await readWithoutAuthority(targetPath);
      if (sessions) store = { sessions };
    }
  } catch (err) {
    // Reset to an empty store ONLY when nothing is stored. A transient read
    // failure (a locked database, an IO hiccup under load) must NOT wipe every
    // session -- keep the last good in-memory store. Otherwise a reload (e.g.
    // send_message's refresh) can momentarily expose zero sessions, which
    // surfaced as flaky CI: `send_message` intermittently returned
    // status:'error' (target not found).
    logger.warn({ err, targetPath }, 'Session store read failed; keeping the last good in-memory store');
  }
  storeLoaded = true;
  if (dirty) fullSweepRequested = true;
  // Read-only consumers (probe:false -- e.g. an MCP tool refreshing its send
  // targets) return the freshly-read snapshot as-is: NO prune/reconcile/probe
  // and NO scheduleWrite. Such a consumer does not own the store, and letting
  // it write back its (possibly stale) in-memory copy would clobber the
  // daemon's writes -- intermittently dropping a just-added session and failing
  // send_message (flaky CI at the memory-mcp send-refresh path).
  if (options.probe === false) return store;
  if (dirty) scheduleWrite(targetPath);
  if (pruneNonPersistableSessions()) { fullSweepRequested = true; scheduleWrite(targetPath); }
  if (reconcilePersistedSessions()) { fullSweepRequested = true; scheduleWrite(targetPath); }
  // Probe actual state of each session via terminal detection.
  // Without this, stale "running" states from before daemon restart persist
  // and cause UI animations to trigger for idle agents.
  void probeSessionStates(targetPath);
  return store;
}

/**
 * Reconcile persisted records on daemon startup:
 *
 *  1) Backfill `runtimeType` for records persisted before that field existed.
 *     CRITICAL: without this, transport SDK sessions (`claude-code-sdk`,
 *     `codex-sdk`, etc.) read back with `runtimeType === undefined`. The
 *     lifecycle health poller and `restartSession` then treat them as
 *     tmux-backed and cycle them into `state: 'error'` on every daemon
 *     restart (because there is no tmux pane to attach).
 *
 *  2) Auto-recover `state: 'error'` to `stopped`. The error state is reached
 *     only when the restart budget (3 restarts / 5 min) is exhausted. By the
 *     time a fresh daemon process has loaded, the rate window has elapsed and
 *     the proximate cause (often "tmux pane killed when previous daemon
 *     OOM'd") no longer applies. Letting sessions retry once more avoids
 *     requiring manual web-UI intervention after every daemon crash.
 *
 * Returns true when any record was mutated and the store needs flushing.
 */
function reconcilePersistedSessions(): boolean {
  let mutated = false;
  for (const session of Object.values(store.sessions)) {
    if (!isUsableSessionIdentity(session.sessionInstanceId)) {
      session.sessionInstanceId = createSessionInstanceId();
      mutated = true;
    }
    if (!isUsableSessionIdentity(session.runtimeEpoch)) {
      session.runtimeEpoch = createRuntimeEpoch();
      mutated = true;
    }
    if (!session.runtimeType && typeof session.agentType === 'string') {
      session.runtimeType = getSessionRuntimeType(session.agentType);
      mutated = true;
    }
    // A missing working directory is a durable user-actionable condition. Do
    // not silently turn it back into `stopped` on every daemon boot: restore
    // would retry the same invalid path forever (notably ConPTY error 267 on
    // Windows). The user can fix the directory and then explicitly restart.
    const hasMissingWorkingDirectoryError = session.state === 'error'
      && typeof session.error === 'string'
      && session.error.startsWith(`${SESSION_ERROR_WORKING_DIRECTORY_NOT_FOUND}:`);
    if (hasMissingWorkingDirectoryError) {
      continue;
    }
    if (session.state === 'error') {
      session.state = 'stopped';
      delete session.error;
      session.restarts = 0;
      session.restartTimestamps = [];
      session.updatedAt = Date.now();
      mutated = true;
    } else if (session.error) {
      delete session.error;
      session.updatedAt = Date.now();
      mutated = true;
    }
  }
  return mutated;
}

/** After loadStore, detect actual state of each session from terminal and emit corrections. */
async function probeSessionStates(targetPath: string): Promise<void> {
  try {
    const { detectStatusAsync } = await import('../agent/detect.js');
    let mutated = false;
    for (const s of Object.values(store.sessions)) {
      if (s.state !== 'running') continue;
      if (s.runtimeType === 'transport') {
        // Transport sessions don't use tmux — skip terminal-based detection
        continue;
      }
      let newState: 'idle' | 'running' = 'running';
      try {
        const status = await detectStatusAsync(s.name, s.agentType as import('../agent/detect.js').AgentType);
        newState = status === 'idle' ? 'idle' : 'running';
      } catch {
        // tmux session may not exist — mark idle
        newState = 'idle';
      }
      if (newState !== s.state) {
        s.state = newState;
        s.updatedAt = Date.now();
        mutated = true;
        markDirty(s.name);
        emitSessionStateProbeCorrection(s.name, newState);
      }
    }
    if (mutated) scheduleWrite(targetPath);
  } catch { /* probeSessionStates is best-effort — don't crash daemon */ }
}

function scheduleWrite(targetPath = dbPath()): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimerPath = targetPath;
  writeTimer = setTimeout(() => {
    const targetPath = writeTimerPath ?? dbPath();
    writeTimer = null;
    writeTimerPath = null;
    void enqueueWrite(true, targetPath);
  }, DEBOUNCE_MS);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Record a change made through the store API: this row is rewritten by the next flush. */
function markDirty(name: string): void {
  dirtyNames.add(name);
}

/**
 * Serialise every persistable record, in slices that yield to the event loop,
 * and return the names whose payload differs from what was last committed.
 * This is what finds records mutated in place through getSession(), which no
 * store call announces.
 */
async function findChangedSessions(): Promise<Set<string>> {
  const changed = new Set<string>();
  let sliceStart = performance.now();
  for (const [name, record] of Object.entries(store.sessions)) {
    if (!isPersistableSessionRecord(record)) continue;
    const row = rowFromRecord(name, record);
    if (row && committedPayloads.get(name) !== row.payload) changed.add(name);
    if (performance.now() - sliceStart >= sweepSliceMs) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
  return changed;
}

/**
 * Persist what changed: upsert the changed rows and delete the removed ones in
 * one transaction. A normal flush touches only the sessions the store API marked
 * dirty. `sweep` additionally compares every record with its committed row, so
 * an in-place mutation is never lost -- the sweep is what an explicit
 * flushStore() (shutdown) and the periodic full check use.
 */
async function writeStoreToDisk(bestEffort: boolean, targetPath = dbPath(), forceSweep = false): Promise<void> {
  // Outside the best-effort catch on purpose: a test reaching the real store
  // must fail loudly, never be swallowed as a lost write.
  if (!hasWriteAuthority(targetPath)) return;
  const sweep = forceSweep || fullSweepRequested || Date.now() - lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS;
  const drained = new Set<string>();
  try {
    const handle = writerHandle(targetPath);
    const swept = sweep ? await findChangedSessions() : new Set<string>();

    // From here to the commit nothing awaits: the rows reflect one instant, and a
    // mutation made while the sweep yielded is in `dirtyNames` and is included.
    const names = new Set<string>([...dirtyNames, ...swept]);
    for (const name of dirtyNames) drained.add(name);
    dirtyNames.clear();
    const upserts: SessionDbRow[] = [];
    const deletes: string[] = [];
    for (const name of names) {
      const record = store.sessions[name];
      if (record && isPersistableSessionRecord(record)) {
        const row = rowFromRecord(name, record);
        if (row && committedPayloads.get(name) !== row.payload) upserts.push(row);
      } else if (committedPayloads.has(name)) {
        deletes.push(name);
      }
    }
    if (sweep) {
      for (const name of committedPayloads.keys()) {
        if (names.has(name)) continue;
        const record = store.sessions[name];
        if (!record || !isPersistableSessionRecord(record)) deletes.push(name);
      }
    }
    if (upserts.length > 0 || deletes.length > 0) {
      commitSessionChanges(handle, { upserts, deletes, allowEmpty: allowEmptyStoreWrite });
      for (const row of upserts) committedPayloads.set(row.name, row.payload);
      for (const name of deletes) committedPayloads.delete(name);
      allowEmptyStoreWrite = false;
      scheduleCompatExport(targetPath);
    }
    if (sweep) { lastFullSweepAt = Date.now(); fullSweepRequested = false; }
    maybeStartSnapshot(handle, targetPath);
  } catch (error) {
    if (error instanceof EmptyStoreRefusal) {
      logger.error({ targetPath, sessions: committedPayloads.size }, 'Refusing to overwrite a non-empty session store with an empty snapshot');
      return;
    }
    // Nothing was committed: keep the rows dirty so the next flush retries them.
    for (const name of drained) dirtyNames.add(name);
    if (sweep) fullSweepRequested = true;
    if (!bestEffort) throw error;
    // Tests may tear down temp HOME dirs while a debounced write is pending.
    // Losing that best-effort write is fine; a later flush/load will recreate it.
  }
}

/**
 * A consistent online snapshot of the database, at most once per interval, the
 * newest few kept. Replaces the five whole-file copies the JSON store rotated
 * on every flush. Never blocks the flush: the copy runs on its own.
 */
function maybeStartSnapshot(handle: SessionDbHandle, targetPath: string): void {
  if (backupInFlight || committedPayloads.size === 0) return;
  if (lastBackupAt === 0) {
    try { lastBackupAt = statSync(`${targetPath}.bak.1`).mtimeMs; } catch { lastBackupAt = 1; }
  }
  if (Date.now() - lastBackupAt < backupIntervalMs) return;
  lastBackupAt = Date.now();
  const temporary = `${targetPath}.bak.tmp`;
  const inFlight: Promise<void> = (async () => {
    try {
      await rm(temporary, { force: true });
      await snapshotSessionDb(handle, temporary);
      for (let index = SESSION_DB_BACKUP_COUNT; index >= 2; index -= 1) {
        try { await rename(`${targetPath}.bak.${index - 1}`, `${targetPath}.bak.${index}`); } catch { /* absent */ }
      }
      await rename(temporary, `${targetPath}.bak.1`);
    } catch (error) {
      logger.warn({ err: error, targetPath }, 'Session store snapshot failed');
      await rm(temporary, { force: true }).catch(() => {});
    }
  })().finally(() => { if (backupInFlight === inFlight) backupInFlight = null; });
  backupInFlight = inFlight;
}

// --- sessions.json compatibility export (shared/session-store-compat.ts) -------------------------
// Write-only: nothing in this build ever reads it back except the one-time migration. It is
// built from the payloads already committed to the database (string concatenation, no
// re-stringify) and written by a persistent worker thread, atomically (tmp + rename), with
// no rotation, so the main thread pays only for handing the strings over.

interface CompatExportJob { path: string; tmp: string; head: string; parts: string[]; tail: string }

const COMPAT_WORKER_SOURCE = `
  const { parentPort } = require('node:worker_threads');
  const fs = require('node:fs');
  parentPort.on('message', (job) => {
    try {
      fs.writeFileSync(job.tmp, job.head + job.parts.join(',') + job.tail, { mode: 0o600 });
      fs.renameSync(job.tmp, job.path);
      parentPort.postMessage({ id: job.id, ok: true });
    } catch (error) {
      try { fs.unlinkSync(job.tmp); } catch (_) { /* never created */ }
      parentPort.postMessage({ id: job.id, ok: false, error: String(error && error.message || error) });
    }
  });
`;

/** Observability for tests and the perf bench: exports completed and the main-thread cost of the last one. */
const compatExportStats = { completed: 0, lastMainThreadMs: 0 };
export function sessionsJsonCompatExportStatsForTests(): { completed: number; lastMainThreadMs: number } {
  return { ...compatExportStats };
}

let compatWorker: Worker | null = null;
let compatJobSeq = 0;
const compatJobs = new Map<number, (result: { ok: boolean; error?: string }) => void>();

function settleCompatJobs(result: { ok: boolean; error?: string }): void {
  for (const settle of compatJobs.values()) settle(result);
  compatJobs.clear();
}

/** The worker keeps the process alive exactly while an export is in flight (a flush awaiting it must not be cut off), never otherwise. */
function releaseCompatWorkerIfIdle(worker: Worker): void {
  if (compatJobs.size === 0) worker.unref();
}

function compatWorkerRun(job: CompatExportJob): Promise<{ ok: boolean; error?: string }> {
  if (!compatWorker) {
    // execArgv: [] -- the worker must not inherit `--input-type=module` / `--import tsx` from a parent started with them.
    const worker = new Worker(COMPAT_WORKER_SOURCE, { eval: true, execArgv: [] });
    worker.on('message', (message: { id: number; ok: boolean; error?: string }) => {
      const settle = compatJobs.get(message.id);
      compatJobs.delete(message.id);
      settle?.(message);
      releaseCompatWorkerIfIdle(worker);
    });
    worker.on('error', (error) => {
      if (compatWorker === worker) compatWorker = null;
      settleCompatJobs({ ok: false, error: String(error?.message ?? error) });
    });
    worker.on('exit', () => {
      if (compatWorker === worker) compatWorker = null;
      settleCompatJobs({ ok: false, error: 'compat export worker exited' });
    });
    // AFTER the listeners: adding a 'message' listener re-refs the port, and a ref'd worker keeps the process alive.
    worker.unref(); // never keeps the daemon, a cli process or a test process alive
    compatWorker = worker;
  }
  const id = ++compatJobSeq;
  return new Promise((resolve) => {
    compatJobs.set(id, resolve);
    compatWorker!.ref(); // in flight: do not let the process exit under a pending flush
    compatWorker!.postMessage({ id, ...job });
  });
}

/** Ask for an export: coalesced to at most one per interval, and only ever after committed changes. */
function scheduleCompatExport(targetPath: string, immediate = false): void {
  if (!isSessionsJsonCompatExportEnabled()) return;
  compatExportPending = true;
  if (compatExportTimer) return;
  const wait = immediate ? 0 : Math.max(0, lastCompatExportAt + SESSIONS_JSON_COMPAT_EXPORT_MIN_INTERVAL_MS - Date.now());
  compatExportTimer = setTimeout(() => {
    compatExportTimer = null;
    void runCompatExport(targetPath);
  }, wait);
  compatExportTimer.unref?.();
}

function runCompatExport(targetPath: string): Promise<void> {
  const run = async (): Promise<void> => {
    if (!compatExportPending) return;
    try {
      if (!isSessionsJsonCompatExportEnabled()) { compatExportPending = false; return; }
      // Same ownership as any other write (a process that lost the lock must not touch the file),
      // without a second process-identity probe: the database write it follows already ran one.
      if (!hasWriteAuthority(targetPath, false)) return;
      // Bound to the store this export was scheduled for, exactly like every other write:
      // HOME rotates between test workers and a late export must never land in the next one.
      const jsonPath = join(dirname(targetPath), LEGACY_JSON_FILE);
      assertNotRealImcodesPathInTests(jsonPath, LEGACY_JSON_FILE);
      compatExportPending = false;
      lastCompatExportAt = Date.now();
      const mainStart = performance.now();
      const parts: string[] = [];
      for (const [name, payload] of committedPayloads) parts.push(`${JSON.stringify(name)}:${payload}`);
      const marker = JSON.stringify({
        format: SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION,
        source: SESSION_DB_FILE,
        note: 'write-only compatibility copy for older builds; the database is the source of truth and this file is never read back',
      });
      const pending = compatWorkerRun({
        path: jsonPath,
        tmp: `${jsonPath}.${process.pid}.${randomUUID()}.tmp`,
        head: `{"version":${SESSION_STORE_DISK_VERSION},"${SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY}":${marker},"sessions":{`,
        parts,
        tail: '},"identityPrompts":{}}',
      });
      compatExportStats.lastMainThreadMs = performance.now() - mainStart; // building + handing over; the write is in the worker
      const result = await pending;
      if (result.ok) compatExportStats.completed += 1;
      if (!result.ok) {
        compatExportPending = true; // retry on the next flush
        logger.warn({ error: result.error, jsonPath }, 'sessions.json compatibility export failed');
      }
    } catch (error) {
      logger.warn({ err: error }, 'sessions.json compatibility export failed');
    }
  };
  compatExportChain = compatExportChain.then(run, run);
  return compatExportChain;
}

/** Shutdown / explicit flush: export what is pending now instead of waiting for the interval. */
async function flushCompatExport(targetPath: string): Promise<void> {
  if (compatExportTimer) { clearTimeout(compatExportTimer); compatExportTimer = null; }
  if (compatExportPending) await runCompatExport(targetPath);
  else await compatExportChain;
}

function resetCompatExportForTests(): void {
  if (compatExportTimer) clearTimeout(compatExportTimer);
  compatExportTimer = null;
  compatExportPending = false;
  lastCompatExportAt = 0;
  compatExportChain = Promise.resolve();
  compatExportStats.completed = 0;
  compatExportStats.lastMainThreadMs = 0;
  const worker = compatWorker;
  compatWorker = null;
  settleCompatJobs({ ok: false, error: 'reset' });
  void worker?.terminate();
}

/** Test seam: resolves when every requested export has been written. */
export async function waitForCompatExportForTests(): Promise<void> {
  if (compatExportTimer) { clearTimeout(compatExportTimer); compatExportTimer = null; await runCompatExport(dbPath()); }
  await compatExportChain;
}

/** Test seam: the writer connection (null before the first write-authorised load). */
export function sessionStoreWriterConnectionForTests(): SessionDbHandle['db'] | null {
  return writerDb?.db ?? null;
}

/** Test seam: resolves when a started snapshot has finished. */
export async function waitForSessionStoreSnapshotForTests(): Promise<void> {
  if (backupInFlight) await backupInFlight;
}

function enqueueWrite(bestEffort: boolean, targetPath = dbPath(), forceSweep = false): Promise<void> {
  const queued = writeQueue.then(
    () => writeStoreToDisk(bestEffort, targetPath, forceSweep),
    () => writeStoreToDisk(bestEffort, targetPath, forceSweep),
  );
  const tracked = queued.finally(() => {
    if (pendingWrite === tracked) pendingWrite = null;
  });
  pendingWrite = tracked;
  writeQueue = tracked.catch(() => {});
  return tracked;
}

async function drainPendingWritesForRead(): Promise<void> {
  if (writeTimer) {
    const targetPath = writeTimerPath ?? dbPath();
    clearTimeout(writeTimer);
    writeTimer = null;
    writeTimerPath = null;
    void enqueueWrite(true, targetPath);
  }
  if (pendingWrite) await pendingWrite.catch(() => {});
  await writeQueue;
}

/**
 * Object.values() on a ~300-key dictionary costs ~27 us and listSessions is
 * called constantly; the values array is rebuilt only when the key set or a
 * record object changes (upsert/remove replace records; load/prune replace the
 * whole map, which the identity check catches). Callers always receive a copy.
 */
let sessionValuesCache: { sessions: Record<string, SessionRecord>; values: SessionRecord[] } | null = null;

function sessionValues(): SessionRecord[] {
  if (!sessionValuesCache || sessionValuesCache.sessions !== store.sessions) {
    sessionValuesCache = { sessions: store.sessions, values: Object.values(store.sessions) };
  }
  return sessionValuesCache.values;
}

export function getSession(name: string): SessionRecord | undefined {
  return store.sessions[name];
}

function isUsableSessionIdentity(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createSessionInstanceId(): string {
  return randomUUID();
}

export function createRuntimeEpoch(): string {
  return randomUUID();
}

function didRuntimeAuthorityChange(existing: SessionRecord, incoming: SessionRecord): boolean {
  if (incoming.runtimeType && existing.runtimeType && incoming.runtimeType !== existing.runtimeType) return true;

  // A pane/provider route is the concrete runtime authority exposed by the
  // current process and transport implementations. A newly discovered or
  // changed handle therefore creates a new epoch; metadata-only writes do not.
  if (incoming.paneId && incoming.paneId !== existing.paneId) return true;
  if (incoming.providerSessionId && incoming.providerSessionId !== existing.providerSessionId) return true;

  // tmux respawn-pane retains its pane id. The restart counter is the explicit
  // authority-replacement signal for that path.
  if (incoming.restarts > existing.restarts) return true;
  return false;
}

export function upsertSession(record: SessionRecord): void {
  const existing = store.sessions[record.name];
  // Sticky execution-clone marker (P0). `upsertSession` REPLACES the whole
  // record, but incidental record rebuilds — sub-session launch, provider-id
  // capture by watchers, model/state/quota refresh, server→daemon reconcile —
  // construct a fresh SessionRecord and OMIT `executionCloneMetadata`. Without
  // this guard the clone loses its `kind: execution_clone` marker right after
  // launch, which silently disables the health-poller skip, the GC sweep, the
  // per-run cap count, the daemon→server identity scrub, and destroy authz.
  // Preserve the marker from the existing clone record when the incoming record
  // omits it. Legitimate metadata mutations (completedAt / cleanupState /
  // destroyRequestedAt) pass the field explicitly and still overwrite; nothing
  // demotes a clone except destroy (`removeSession`), so preserve-if-omitted is
  // safe and is the single robust fix across every upsert site.
  const executionCloneMetadata = record.executionCloneMetadata
    ?? (existing?.executionCloneMetadata?.kind === EXECUTION_CLONE_KIND
      ? existing.executionCloneMetadata
      : undefined);
  // The native-agent fence demand is sticky exactly like the clone marker: an
  // incidental rebuild that omits it must not silently re-open native agents.
  const normalizedError = record.state === 'error' && typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : undefined;
  // The store, not an incoming rebuild/sync payload, owns logical identity.
  // Persisted hydration bypasses upsert and keeps its stored id; every truly
  // absent name is therefore a new logical instance even if a stale caller
  // accidentally carries the deleted record's old id.
  const sessionInstanceId = existing?.sessionInstanceId
    ?? (isMarkedSessionLaunchIdentity(record) && isUsableSessionIdentity(record.sessionInstanceId)
      ? record.sessionInstanceId
      : createSessionInstanceId());
  const runtimeAuthorityChanged = existing ? didRuntimeAuthorityChange(existing, record) : false;
  const runtimeEpoch = !existing
    ? isMarkedSessionLaunchIdentity(record) && isUsableSessionIdentity(record.runtimeEpoch)
      ? record.runtimeEpoch
      : createRuntimeEpoch()
    : isUsableSessionIdentity(record.runtimeEpoch)
    && record.runtimeEpoch !== existing.runtimeEpoch
    ? record.runtimeEpoch
    : !runtimeAuthorityChanged && isUsableSessionIdentity(existing.runtimeEpoch)
      ? existing.runtimeEpoch
      : createRuntimeEpoch();
  const nativeAgentFenceRequired = [record.nativeAgentFenceRequired, existing?.nativeAgentFenceRequired]
    .find((marker) => marker?.sessionInstanceId === sessionInstanceId);
  // A launch-fence proof survives only for the exact instance AND epoch it was
  // decided for; any other value is dropped rather than carried forward.
  const nativeAgentLaunchFence = [record.nativeAgentLaunchFence, existing?.nativeAgentLaunchFence]
    .find((proof) => proof?.sessionInstanceId === sessionInstanceId && proof.runtimeEpoch === runtimeEpoch);
  const { nativeAgentFenceRequired: _requestedMarker, nativeAgentLaunchFence: _requestedProof, ...incoming } = record;
  store.sessions[record.name] = {
    ...incoming,
    sessionInstanceId,
    runtimeEpoch,
    ...(nativeAgentFenceRequired ? { nativeAgentFenceRequired } : {}),
    ...(nativeAgentLaunchFence ? { nativeAgentLaunchFence } : {}),
    ...(normalizedError ? { error: normalizedError } : { error: undefined }),
    ...(executionCloneMetadata !== undefined ? { executionCloneMetadata } : {}),
    updatedAt: Date.now(),
  };
  sessionValuesCache = null;
  markDirty(record.name);
  scheduleWrite();
}

export function removeSession(name: string): void {
  delete store.sessions[name];
  sessionValuesCache = null;
  markDirty(name);
  scheduleWrite();
}

export function listSessions(projectName?: string): SessionRecord[] {
  const all = sessionValues();
  return projectName ? all.filter((s) => s.projectName === projectName) : all.slice();
}

/** Find a session by its provider session ID (for transport sessions). */
export function findSessionByProviderSessionId(providerSessionId: string): SessionRecord | undefined {
  return sessionValues().find((s) => s.providerSessionId === providerSessionId);
}

/**
 * Apply a canonical provider limit signal to one session.
 *
 * The ONLY writer of `providerLimit`. Routing every adapter through one
 * mutator is what makes "a limit can only come from provider-native evidence"
 * checkable: there is a single place to audit rather than one per provider.
 *
 * Returns true when the stored state changed, so a caller can emit a
 * notification exactly once instead of on every repeated signal -- providers
 * re-send the same rate-limit event freely, and one notification per event
 * would be a storm.
 */
/**
 * What a signal does to a record's stored limit. PURE -- no store access.
 *
 * Extracted so the store mutator and any caller that must fold the limit into a
 * WHOLE-RECORD write share one decision. Two implementations would be two
 * answers, and the one that ran last would win silently.
 */
export function resolveProviderLimitUpdate(
  previous: DelegationLimitState | undefined,
  signal: ProviderLimitSignal | null | undefined,
  nowMs: number,
): { changed: false } | { changed: true; value: DelegationLimitState | undefined } {
  const observation = observeProviderLimitSignal(signal, nowMs);

  if (observation.kind === 'noEvidence') {
    // Neither sets nor clears. An unrecognised, low-confidence, or merely
    // WARNING signal must not un-limit an account that is still being refused.
    return { changed: false };
  }
  if (observation.kind === 'healthy') {
    return previous === undefined ? { changed: false } : { changed: true, value: undefined };
  }

  const next = observation.state;
  // Re-observing an ALREADY ACTIVE limit is not a change. Without this the
  // limit's own clock would restart on every repeated event and the window
  // would never expire.
  if (previous
    && isDelegationLimitActive(previous, nowMs)
    && previous.reason === next.reason
    && previous.retryAt === next.retryAt) {
    return { changed: false };
  }
  return { changed: true, value: next };
}

/**
 * Apply a canonical provider limit signal onto a record IN PLACE.
 *
 * Used by whole-record writers, which must fold the limit into the SAME object
 * they are about to persist. Applying it to the store separately and then
 * upserting a record snapshotted beforehand silently reverted the limit --
 * `quotaMeta` and `limitSignal` arrive on one `SessionInfoUpdate`, so the very
 * event that reported a refusal also carried the display field whose write
 * erased it. The failure was invisible: the store briefly held the right value.
 *
 * Returns true when the record changed.
 */
export function mergeProviderLimitSignal(
  record: { providerLimit?: DelegationLimitState },
  signal: ProviderLimitSignal | null | undefined,
  nowMs = Date.now(),
): boolean {
  const update = resolveProviderLimitUpdate(record.providerLimit, signal, nowMs);
  if (!update.changed) return false;
  if (update.value === undefined) delete record.providerLimit;
  else record.providerLimit = update.value;
  return true;
}


export function updateSessionState(name: string, state: SessionState, error?: string): void {
  const s = store.sessions[name];
  if (!s) return;
  s.state = state;
  const normalizedError = state === 'error' && typeof error === 'string' && error.trim()
    ? error.trim()
    : undefined;
  if (normalizedError) s.error = normalizedError;
  else delete s.error;
  s.updatedAt = Date.now();
  markDirty(name);
  scheduleWrite();
}

export async function flushStore(): Promise<void> {
  // A CLI stop/status process can import lifecycle.shutdown without ever
  // loading the daemon store or acquiring its lock. It must not flush the
  // initial empty in-memory value over the live daemon's sessions.
  if (!storeLoaded && !isUnderTestRunner()) return;
  const targetPath = writeTimerPath ?? dbPath();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    writeTimerPath = null;
  }
  await enqueueWrite(false, targetPath, true);
  await flushCompatExport(targetPath);
}
