import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import type { QwenAuthType } from '../../shared/qwen-auth.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import type { SessionContextBootstrapState } from '../../shared/session-context-bootstrap.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { EXECUTION_CLONE_KIND, type ExecutionCloneMetadata } from '../../shared/execution-clone.js';

const DEBOUNCE_MS = 500;

function storeDir(): string {
  return join(homedir(), '.imcodes');
}

function storePath(): string {
  return join(storeDir(), 'sessions.json');
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
  /** Generic reasoning/thinking effort for supported providers. */
  effort?: TransportEffortLevel;
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
  /** CC env preset name — persisted so respawn can re-inject the same env vars. */
  ccPreset?: string;
  /** Context window override carried by a provider preset (e.g. MiniMax 200K). */
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
  /** Execution-clone metadata. Present ONLY for ephemeral execution-clone
   *  sub-sessions (`kind: 'execution_clone'`). First-class field — NEVER stored
   *  inside `transportConfig` (the transport-identity scrubber would strip
   *  identity-like keys). Read by the health-poller clone-skip, the clone GC
   *  sweep, the daemon→server metadata sync, and authorized status surfaces.
   *  Persisted in the FIRST session-store upsert so a crash between create and
   *  sync still leaves a sweepable record. */
  executionCloneMetadata?: ExecutionCloneMetadata;
}

export interface SessionStore {
  sessions: Record<string, SessionRecord>;
}

export interface LoadStoreOptions {
  /**
   * Probe terminal-backed sessions after loading. Disable for short-lived
   * read-only consumers such as MCP tool calls that only need a fresh
   * persisted snapshot.
   */
  probe?: boolean;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeTimerPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let pendingWrite: Promise<void> | null = null;
let store: SessionStore = { sessions: {} };

function isPersistableSessionRecord(record: SessionRecord): boolean {
  return !isKnownTestSessionLike({
    name: record.name,
    projectName: record.projectName,
    projectDir: record.projectDir,
    parentSession: record.parentSession,
  });
}

function serializeStore(): string {
  const persistableSessions = Object.fromEntries(
    Object.entries(store.sessions).filter(([, record]) => isPersistableSessionRecord(record)),
  );
  return JSON.stringify({ sessions: persistableSessions }, null, 2);
}

function pruneNonPersistableSessions(): boolean {
  const before = Object.keys(store.sessions).length;
  store.sessions = Object.fromEntries(
    Object.entries(store.sessions).filter(([, record]) => isPersistableSessionRecord(record)),
  );
  return Object.keys(store.sessions).length !== before;
}

export async function loadStore(options: LoadStoreOptions = {}): Promise<SessionStore> {
  await drainPendingWritesForRead();
  await mkdir(storeDir(), { recursive: true });
  try {
    const raw = await readFile(storePath(), 'utf8');
    store = JSON.parse(raw) as SessionStore;
  } catch (err) {
    // Reset to an empty store ONLY when the file genuinely doesn't exist. A
    // transient read/parse failure (a concurrent writer truncating the file
    // mid-read, an empty read while another process rewrites it, or an IO
    // hiccup under load) must NOT wipe every session — keep the last good
    // in-memory store. Otherwise a reload (e.g. send_message's refresh) can
    // momentarily expose zero sessions, which surfaced as flaky CI:
    // `send_message` intermittently returned status:'error' (target not found).
    if ((err as { code?: string } | null)?.code === 'ENOENT') {
      store = { sessions: {} };
    }
  }
  // Read-only consumers (probe:false — e.g. an MCP tool refreshing its send
  // targets) return the freshly-read snapshot as-is: NO prune/reconcile/probe
  // and NO scheduleWrite. Such a consumer does not own sessions.json, and
  // letting it write back its (possibly stale) in-memory store would clobber
  // the daemon's external writes — intermittently dropping a just-added session
  // and failing send_message (flaky CI at the memory-mcp send-refresh path).
  if (options.probe === false) return store;
  if (pruneNonPersistableSessions()) scheduleWrite();
  if (reconcilePersistedSessions()) scheduleWrite();
  // Probe actual state of each session via terminal detection.
  // Without this, stale "running" states from before daemon restart persist
  // and cause UI animations to trigger for idle agents.
  void probeSessionStates();
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
async function probeSessionStates(): Promise<void> {
  try {
    const { detectStatusAsync } = await import('../agent/detect.js');
    const { timelineEmitter } = await import('../daemon/timeline-emitter.js');
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
        try { timelineEmitter.emit(s.name, 'session.state', { state: newState }); } catch { /* emitter may not be ready */ }
      }
    }
    if (mutated) scheduleWrite();
  } catch { /* probeSessionStates is best-effort — don't crash daemon */ }
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimerPath = storePath();
  writeTimer = setTimeout(() => {
    const targetPath = writeTimerPath ?? storePath();
    writeTimer = null;
    writeTimerPath = null;
    void enqueueWrite(true, targetPath);
  }, DEBOUNCE_MS);
}

async function writeStoreToDisk(bestEffort: boolean, targetPath = storePath()): Promise<void> {
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, serializeStore(), 'utf8');
  } catch (error) {
    if (!bestEffort) throw error;
    // Tests may tear down temp HOME dirs while a debounced write is pending.
    // Losing that best-effort write is fine; a later flush/load will recreate it.
  }
}

function enqueueWrite(bestEffort: boolean, targetPath = storePath()): Promise<void> {
  const queued = writeQueue.then(
    () => writeStoreToDisk(bestEffort, targetPath),
    () => writeStoreToDisk(bestEffort, targetPath),
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
    const targetPath = writeTimerPath ?? storePath();
    clearTimeout(writeTimer);
    writeTimer = null;
    writeTimerPath = null;
    void enqueueWrite(true, targetPath);
  }
  if (pendingWrite) await pendingWrite.catch(() => {});
  await writeQueue;
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
  const normalizedError = record.state === 'error' && typeof record.error === 'string' && record.error.trim()
    ? record.error.trim()
    : undefined;
  // The store, not an incoming rebuild/sync payload, owns logical identity.
  // Persisted hydration bypasses upsert and keeps its stored id; every truly
  // absent name is therefore a new logical instance even if a stale caller
  // accidentally carries the deleted record's old id.
  const sessionInstanceId = existing?.sessionInstanceId ?? createSessionInstanceId();
  const runtimeAuthorityChanged = existing ? didRuntimeAuthorityChange(existing, record) : false;
  const runtimeEpoch = !existing
    ? createRuntimeEpoch()
    : isUsableSessionIdentity(record.runtimeEpoch)
    && record.runtimeEpoch !== existing.runtimeEpoch
    ? record.runtimeEpoch
    : !runtimeAuthorityChanged && isUsableSessionIdentity(existing.runtimeEpoch)
      ? existing.runtimeEpoch
      : createRuntimeEpoch();
  store.sessions[record.name] = {
    ...record,
    sessionInstanceId,
    runtimeEpoch,
    ...(normalizedError ? { error: normalizedError } : { error: undefined }),
    ...(executionCloneMetadata !== undefined ? { executionCloneMetadata } : {}),
    updatedAt: Date.now(),
  };
  scheduleWrite();
}

export function removeSession(name: string): void {
  delete store.sessions[name];
  scheduleWrite();
}

export function listSessions(projectName?: string): SessionRecord[] {
  const all = Object.values(store.sessions);
  return projectName ? all.filter((s) => s.projectName === projectName) : all;
}

/** Find a session by its provider session ID (for transport sessions). */
export function findSessionByProviderSessionId(providerSessionId: string): SessionRecord | undefined {
  return Object.values(store.sessions).find((s) => s.providerSessionId === providerSessionId);
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
  scheduleWrite();
}

export async function flushStore(): Promise<void> {
  const targetPath = writeTimerPath ?? storePath();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    writeTimerPath = null;
  }
  await enqueueWrite(false, targetPath);
}
