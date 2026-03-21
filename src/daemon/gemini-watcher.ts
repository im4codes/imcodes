/**
 * Watches Gemini CLI conversation JSON files for structured events.
 */

import { watch, readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import { capturePane } from '../agent/tmux.js';
import { detectStatus } from '../agent/detect.js';
import logger from '../util/logger.js';
import { updateSessionState } from '../store/session-store.js';

const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');
const POLL_INTERVAL_MS = 1500; // Balanced: responsive enough without causing state flicker
const IDLE_LOCK_MS = 2000;    // After emitting idle, ignore terminal noise for this long
// Running lock removed — the "new data = always running" rule (pollTick new-data path)
// now prevents tool-gap idle transitions more reliably than a time-based lock.
const RETRY_DELAY_MS = 100;

// ── Path helpers ───────────────────────────────────────────────────────────────

async function findSessionFile(sessionUuid: string): Promise<string | null> {
  const prefix = sessionUuid.slice(0, 8);
  let slugs: string[];
  try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return null; }
  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith(`-${prefix}.json`)) return join(chatsDir, entry);
    }
  }
  return null;
}

async function findLatestSessionFile(excludeClaimed = true): Promise<string | null> {
  let slugs: string[];
  try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return null; }
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;
      const fullPath = join(chatsDir, entry);
      if (excludeClaimed && claimedFiles.has(fullPath)) continue;
      try {
        const s = await stat(fullPath);
        if (s.mtimeMs > bestMtime) { bestMtime = s.mtimeMs; bestPath = fullPath; }
      } catch {}
    }
  }
  return bestPath;
}

// ── Message parsing ────────────────────────────────────────────────────────────

function parseMessage(sessionName: string, msg: any, hist?: any, streaming = false): void {
  const stableId = (suffix: string) => {
    if (!hist) return undefined;
    const n = hist.counts.get(suffix) ?? 0;
    hist.counts.set(suffix, n + 1);
    return `${hist.idPrefix}${suffix}:${n}`;
  };
  const stableTs = hist?.ts;

  if (msg.type === 'user') {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.text?.trim()) {
        timelineEmitter.emit(sessionName, 'user.message', { text: block.text }, { source: 'daemon', confidence: 'high', eventId: stableId('um'), ts: stableTs });
      }
    }
  } else if (msg.type === 'gemini') {
    if (msg.thoughts) {
      for (const t of msg.thoughts) {
        const text = t.description ?? t.subject;
        if (text?.trim()) timelineEmitter.emit(sessionName, 'assistant.thinking', { text }, { source: 'daemon', confidence: 'high', eventId: stableId('th'), ts: stableTs });
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!tc.name) continue;
        const input = extractToolInput(tc.name, tc.args);
        timelineEmitter.emit(sessionName, 'tool.call', { tool: tc.name, ...(input ? { input } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tc'), ts: stableTs });
        const output = tc.result?.[0]?.functionResponse?.response?.output;
        timelineEmitter.emit(sessionName, 'tool.result', { ...(tc.status === 'error' ? { error: output ?? 'error' } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tr'), ts: stableTs });
      }
    }
    if (typeof msg.content === 'string' && msg.content.trim()) {
      timelineEmitter.emit(sessionName, 'assistant.text', { text: msg.content, streaming }, { source: 'daemon', confidence: 'high', eventId: stableId('at'), ts: stableTs });
    }
  }
}

function extractToolInput(name: string, args?: any): string {
  if (!args) return '';
  const val = args.command ?? args.path ?? args.file_path ?? args.query ?? args.objective ?? '';
  return String(val).split('\n')[0] ?? '';
}

// ── Per-session watcher state ──────────────────────────────────────────────────

export interface WatcherState {
  sessionUuid: string;
  activeFile: string | null;
  seenCount: number;
  lastUpdated: string;
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  /** Current emitted state — single source of truth for what was last sent to timeline. */
  currentState?: 'running' | 'idle';
  idleDebounceTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp of last idle emit — used for idle lock (ignore terminal noise shortly after idle). */
  lastIdleEmitTs?: number;
  _lastRotationCheck?: number;
  _terminalThinkingEmitted?: boolean;
  lastConversationStatus?: 'running' | 'idle' | null;
  /** Consecutive poll ticks where JSON inferred idle. Prevents tool-call gap false idles. */
  idleConfirmCount?: number;
}

const watchers = new Map<string, WatcherState>();
const claimedFiles = new Map<string, string>(); // filePath → sessionName

export function preClaimFile(sessionName: string, filePath: string): void {
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) { claimedFiles.delete(fp); break; } }
  claimedFiles.set(filePath, sessionName);
}

// ── Terminal-based thinking detection ─────────────────────────────────────────
// Supplements JSON watching: when the JSON file hasn't changed but the terminal
// shows activity (spinner, "esc to cancel"), emit assistant.thinking so the
// web UI chat mode reflects that Gemini is working.

async function terminalThinkingCheck(sessionName: string, state: WatcherState): Promise<void> {
  let lines: string[];
  try {
    lines = await capturePane(sessionName);
  } catch {
    return; // session may not exist yet
  }

  const status = detectStatus(lines, 'gemini');

  if (status === 'idle') {
    // Strong idle: both JSON and terminal agree on idle — skip confirm count + running lock
    if (state.lastConversationStatus === 'idle') {
      state.idleConfirmCount = 2; // force past threshold
      if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }
      state._terminalThinkingEmitted = false;
      transitionState(sessionName, state, 'idle', true); // force bypasses running lock
      return;
    }
    // Terminal shows idle but JSON doesn't — debounce before transitioning
    if (state.currentState === 'running' && !state.idleDebounceTimer) {
      state.idleDebounceTimer = setTimeout(() => {
        state.idleDebounceTimer = undefined;
        if (!state.stopped) {
          state._terminalThinkingEmitted = false;
          transitionState(sessionName, state, 'idle');
        }
      }, 3000);
    }
    return;
  }

  // Terminal shows activity — but only transition state if JSON hasn't already settled on idle.
  // JSON is the authoritative source; terminal is supplementary for thinking hints only.
  if (state.lastConversationStatus === 'idle') {
    // JSON says idle — terminal may show residual activity (prompt redraw, lingering "esc to cancel").
    // Emit thinking hint for UI but do NOT change session.state — prevents idle/running oscillation.
    if (!state._terminalThinkingEmitted) {
      state._terminalThinkingEmitted = true;
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'terminal-parse', confidence: 'low' });
    }
    return;
  }

  // JSON is not idle (running or unknown) — terminal activity confirms running state
  if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }
  transitionState(sessionName, state, 'running');
  if (!state._terminalThinkingEmitted) {
    state._terminalThinkingEmitted = true;
    timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'terminal-parse', confidence: 'medium' });
  }
}

/**
 * Unified state transition — all idle/running changes MUST go through here.
 * Prevents flicker by deduplicating and enforcing bidirectional locks.
 */
function transitionState(sessionName: string, state: WatcherState, next: 'running' | 'idle', force = false): void {
  if (state.currentState === next) return; // already in this state
  if (!force) {
    // Idle lock: don't transition to running if we just emitted idle (terminal noise)
    if (next === 'running' && state.lastIdleEmitTs && (Date.now() - state.lastIdleEmitTs) < IDLE_LOCK_MS) return;
  }
  state.currentState = next;
  if (next === 'idle') state.lastIdleEmitTs = Date.now();
  timelineEmitter.emit(sessionName, 'session.state', { state: next });
  updateSessionState(sessionName, next);
}

function hasPendingTools(msg: any): boolean {
  return !!msg.toolCalls?.some((tc: any) => !tc.status || (tc.status !== 'success' && tc.status !== 'error'));
}

function hasGeminiContent(msg: any): boolean {
  return typeof msg.content === 'string' && msg.content.trim().length > 0;
}

function inferConversationStatus(conv: any): 'running' | 'idle' | null {
  const messages = Array.isArray(conv?.messages) ? conv.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.type === 'info') continue;
    if (msg.type === 'user') return 'running';
    if (msg.type !== 'gemini') continue;
    if (hasPendingTools(msg)) return 'running';
    if (msg.thoughts?.length && !hasGeminiContent(msg)) return 'running';
    if (hasGeminiContent(msg)) return 'idle';
    return 'running';
  }
  return null;
}

// ── Core poll logic ────────────────────────────────────────────────────────────

async function readConversation(filePath: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readFile(filePath, 'utf8');
      if (!raw.trim()) continue;
      return JSON.parse(raw);
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return null;
}

export async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) {
    const found = state.sessionUuid ? await findSessionFile(state.sessionUuid) : await findLatestSessionFile();
    if (found) { state.activeFile = found; claimedFiles.set(found, sessionName); } else return;
  }

  const conv = await readConversation(state.activeFile!);
  if (!conv) return;
  const conversationStatus = inferConversationStatus(conv);
  state.lastConversationStatus = conversationStatus;

  if (conv.lastUpdated === state.lastUpdated && conv.messages.length === state.seenCount) {
    if (conversationStatus === 'idle') {
      state.idleConfirmCount = (state.idleConfirmCount ?? 0) + 1;
      // Require consecutive idle confirmations to prevent tool-call gap false idles
      if (state.idleConfirmCount >= 2 && !state.idleDebounceTimer) {
        transitionState(sessionName, state, 'idle');
      }
      return;
    }
    state.idleConfirmCount = 0;
    // JSON unchanged — supplement with terminal-based detection.
    // Gemini CLI may be thinking/working without writing to JSON yet.
    await terminalThinkingCheck(sessionName, state);
    return;
  }

  const lastIdx = conv.messages.length - 1;
  const isUpdate = conv.messages.length === state.seenCount && lastIdx >= 0;
  const messagesToProcess = isUpdate ? [conv.messages[lastIdx]] : conv.messages.slice(state.seenCount);

  state.seenCount = conv.messages.length;
  state.lastUpdated = conv.lastUpdated;
  state._terminalThinkingEmitted = false; // Reset: JSON has content now, terminal-based thinking no longer needed

  for (let i = 0; i < messagesToProcess.length; i++) {
    const msg = messagesToProcess[i];
    if (state.stopped) break;
    const msgIdx = isUpdate ? lastIdx : (state.seenCount - messagesToProcess.length + i);
    const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    const hist = { ts: isNaN(ts) ? Date.now() : ts, idPrefix: `g:${sessionName}:${msgIdx}:`, counts: new Map() };
    parseMessage(sessionName, msg, hist, isUpdate);
  }

  // JSON just changed → agent is actively working.
  // Always reset idle confirm count and transition to running.
  // NEVER transition to idle on the "new data" path — tool-call gaps
  // briefly show idle in JSON, but more data will arrive shortly.
  // Only the "unchanged JSON" path (above) can transition to idle.
  state.idleConfirmCount = 0;
  if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }
  if (conversationStatus === 'running') {
    transitionState(sessionName, state, 'running');
  } else {
    // JSON says idle but just changed — treat as running (tool gap)
    transitionState(sessionName, state, 'running');
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function startWatching(sessionName: string, sessionUuid: string): Promise<void> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = { sessionUuid, activeFile: null, seenCount: 0, lastUpdated: '', abort: new AbortController(), stopped: false };
  watchers.set(sessionName, state);

  const found = await findSessionFile(sessionUuid);
  if (found) {
    state.activeFile = found; claimedFiles.set(found, sessionName);
    const conv = await readConversation(found);
    if (conv) {
      state.seenCount = conv.messages.length;
      state.lastUpdated = conv.lastUpdated;
      state.lastConversationStatus = inferConversationStatus(conv);
      if (state.lastConversationStatus === 'idle') {
        transitionState(sessionName, state, 'idle');
      }
    }
  }

  state.pollTimer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      if (now - (state._lastRotationCheck || 0) > 30000 && state.sessionUuid) {
        state._lastRotationCheck = now;
        const currentFile = await findSessionFile(state.sessionUuid);
        if (currentFile && currentFile !== state.activeFile) {
          logger.info({ sessionName, new: currentFile }, 'gemini-watcher: date rotation detected');
          if (state.activeFile) claimedFiles.delete(state.activeFile);
          state.activeFile = currentFile; claimedFiles.set(currentFile, sessionName);
          void watchGeminiDir(sessionName, state);
        }
      }
      await pollTick(sessionName, state);
    })();
  }, POLL_INTERVAL_MS);

  void watchGeminiDir(sessionName, state);
}

/**
 * Watch for a NEW Gemini session file to appear (not in the given snapshot).
 * Once discovered, extract its UUID and notify the callback.
 */
export async function startWatchingDiscovered(
  sessionName: string,
  snapshot: Set<string>,
  onDiscovered?: (uuid: string) => void,
): Promise<void> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = { sessionUuid: '', activeFile: null, seenCount: 0, lastUpdated: '', abort: new AbortController(), stopped: false };
  watchers.set(sessionName, state);

  state.pollTimer = setInterval(() => {
    void (async () => {
      if (!state.activeFile) {
        // Find a file NOT in the snapshot
        let slugs: string[];
        try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return; }
        for (const slug of slugs) {
          const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
          let entries: string[];
          try { entries = await readdir(chatsDir); } catch { continue; }
          for (const entry of entries) {
            if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;
            const fullPath = join(chatsDir, entry);
            if (!snapshot.has(fullPath) && !claimedFiles.has(fullPath)) {
              // Discovered!
              const conv = await readConversation(fullPath);
              if (conv && conv.sessionId) {
                state.activeFile = fullPath;
                claimedFiles.set(fullPath, sessionName);
                state.sessionUuid = conv.sessionId;
                onDiscovered?.(conv.sessionId);
                void watchGeminiDir(sessionName, state);
                break;
              }
            }
          }
          if (state.activeFile) break;
        }
      }
      if (state.activeFile) await pollTick(sessionName, state);
    })();
  }, POLL_INTERVAL_MS);
}

export async function startWatchingLatest(sessionName: string): Promise<void> { return startWatching(sessionName, ''); }

export function isWatching(sessionName: string): boolean { return watchers.has(sessionName); }

/** Snapshot all current Gemini session file paths — used as baseline for new-file detection. */
export async function snapshotSessionFiles(): Promise<Set<string>> {
  const result = new Set<string>();
  let slugs: string[];
  try { slugs = await readdir(GEMINI_TMP_DIR); } catch { return result; }
  for (const slug of slugs) {
    const chatsDir = join(GEMINI_TMP_DIR, slug, 'chats');
    let entries: string[];
    try { entries = await readdir(chatsDir); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('session-') && entry.endsWith('.json')) result.add(join(chatsDir, entry));
    }
  }
  return result;
}

export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true; state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.idleDebounceTimer) clearTimeout(state.idleDebounceTimer);
  watchers.delete(sessionName);
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) claimedFiles.delete(fp); }
}

async function watchGeminiDir(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;
  const dir = state.activeFile.substring(0, state.activeFile.lastIndexOf('/'));
  const filename = state.activeFile.substring(state.activeFile.lastIndexOf('/') + 1);
  try {
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as any) {
      if (state.stopped) break;
      if (event.filename === filename) await pollTick(sessionName, state);
    }
  } catch {}
}
