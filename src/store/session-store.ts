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
    // Reset all session states to idle on daemon startup.
    // Actual states will be re-detected by watchers/hooks once they start.
    // Without this, stale "running" states from before restart persist and
    // cause UI animations to trigger when agents are actually idle.
    for (const s of Object.values(store.sessions)) {
      if (s.state === 'running') s.state = 'idle';
    }
  } catch {
    store = { sessions: {} };
  }
  return store;
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
