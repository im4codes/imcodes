import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const STORE_DIR = join(homedir(), '.imcodes');
const STORE_PATH = join(STORE_DIR, 'sessions.json');
const DEBOUNCE_MS = 500;

export type SessionState = 'running' | 'idle' | 'error' | 'stopped';

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
  /** tmux pane ID (e.g. "%42") recorded at session creation. Used for pipe-pane streaming. */
  paneId?: string;
  /** CC session UUID used with --session-id / --resume for deterministic JSONL path. */
  ccSessionId?: string;
  /** Codex session UUID extracted from rollout filename, used for `codex resume <UUID>`. */
  codexSessionId?: string;
  /** Gemini session UUID obtained from stream-json init event, used for `gemini --resume <UUID>`. */
  geminiSessionId?: string;
  /** Parent main session name (e.g. `deck_proj_brain`) — links sub-sessions to their parent. */
  parentSession?: string;
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
  const { detectStatusAsync } = await import('../agent/detect.js');
  const { timelineEmitter } = await import('../daemon/timeline-emitter.js');
  for (const s of Object.values(store.sessions)) {
    if (s.state !== 'running') continue;
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
      // Emit to timeline so frontend gets the corrected state
      timelineEmitter.emit(s.name, 'session.state', { state: newState });
    }
  }
  scheduleWrite();
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
