import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { QwenAuthType } from '../../shared/qwen-auth.js';

const STORE_DIR = join(homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'sessions.json');
const DEBOUNCE_MS = 500;

export type SessionState = 'running' | 'idle' | 'error' | 'stopped';

// TODO: import from '../agent/session-runtime.js' when available
type RuntimeType = 'process' | 'transport';

export interface SessionRecord {
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
  /** Human-readable auth limit from `qwen auth status` (e.g. Up to 1,000 requests/day). */
  qwenAuthLimit?: string;
  /** Qwen models available for the current auth source. */
  qwenAvailableModels?: string[];
  /** Generic display model override for UI footer/header. */
  modelDisplay?: string;
  /** Generic commercial/plan badge label (e.g. Free, Paid, BYO). */
  planLabel?: string;
  /** Generic permission/sandbox badge label (e.g. all, ask). */
  permissionLabel?: string;
  /** Generic quota/limit badge label (e.g. 1000/day, 60/min). */
  quotaLabel?: string;
  /** Generic quota progress label (e.g. today 12/1000 · 1m 1/60). */
  quotaUsageLabel?: string;
  /** Parent main session name (e.g. `deck_proj_brain`) — links sub-sessions to their parent. */
  parentSession?: string;
  /** Runtime type — 'process' for tmux, 'transport' for network-backed. Defaults to 'process' for backward compat. */
  runtimeType?: RuntimeType;
  /** Transport provider ID (e.g. 'openclaw', 'minimax'). Only set for transport sessions. */
  providerId?: string;
  /** Provider-side session ID/key. For OpenClaw this is the OC session key. */
  providerSessionId?: string;
  /** Session description — used for persona/system prompt injection. */
  description?: string;
  /** CC env preset name — persisted so respawn can re-inject the same env vars. */
  ccPreset?: string;
  /** Human-readable label for UI display (e.g. "OC:main", "discord:#general"). */
  label?: string;
  /** True for sessions created by the user (not auto-synced from provider).
   *  User-created sessions must not be deleted/stopped by sync or health checks. */
  userCreated?: boolean;
}

export interface SessionStore {
  sessions: Record<string, SessionRecord>;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let store: SessionStore = { sessions: {} };

export async function loadStore(): Promise<SessionStore> {
  await mkdir(STORE_DIR, { recursive: true });
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    store = JSON.parse(raw) as SessionStore;
  } catch {
    store = { sessions: {} };
  }
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
    await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
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
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}
