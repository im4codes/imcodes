import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { QwenAuthType } from '../../shared/qwen-auth.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import type { ProviderQuotaMeta } from '../../shared/provider-quota.js';
import type { SessionContextBootstrapState } from '../../shared/session-context-bootstrap.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';

const STORE_DIR = join(homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'sessions.json');
const DEBOUNCE_MS = 500;

export type SessionState = 'running' | 'idle' | 'error' | 'stopped';

// TODO: import from '../agent/session-runtime.js' when available
type RuntimeType = 'process' | 'transport';

export interface SessionRecord extends SessionContextBootstrapState {
  name: string;
  projectName: string;
  role: 'brain' | `w${number}`;
  agentType: string;
  agentVersion?: string;
  projectDir: string;
  state: SessionState;
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
}

export interface SessionStore {
  sessions: Record<string, SessionRecord>;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
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

export async function loadStore(): Promise<SessionStore> {
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    store = JSON.parse(raw) as SessionStore;
  } catch {
    store = { sessions: {} };
  }
  if (pruneNonPersistableSessions()) scheduleWrite();
  // Probe actual state of each session via terminal detection.
  // Without this, stale "running" states from before daemon restart persist
  // and cause UI animations to trigger for idle agents.
  void probeSessionStates();
  return store;
}

/** After loadStore, detect actual state of each session from terminal and emit corrections. */
async function probeSessionStates(): Promise<void> {
  try {
    const { detectStatusAsync } = await import('../agent/detect.js');
    const { timelineEmitter } = await import('../daemon/timeline-emitter.js');
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
        try { timelineEmitter.emit(s.name, 'session.state', { state: newState }); } catch { /* emitter may not be ready */ }
      }
    }
    scheduleWrite();
  } catch { /* probeSessionStates is best-effort — don't crash daemon */ }
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    try {
      await mkdir(STORE_DIR, { recursive: true });
      await writeFile(STORE_PATH, serializeStore(), 'utf8');
    } catch {
      // Tests may tear down temp HOME dirs while a debounced write is pending.
      // Losing that best-effort write is fine; a later flush/load will recreate it.
    }
    writeTimer = null;
  }, DEBOUNCE_MS);
}

export function getSession(name: string): SessionRecord | undefined {
  return store.sessions[name];
}

export function upsertSession(record: SessionRecord): void {
  store.sessions[record.name] = { ...record, updatedAt: Date.now() };
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

export function updateSessionState(name: string, state: SessionState): void {
  const s = store.sessions[name];
  if (!s) return;
  s.state = state;
  s.updatedAt = Date.now();
  scheduleWrite();
}

export async function flushStore(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_PATH, serializeStore(), 'utf8');
}
