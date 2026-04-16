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
import { updateSessionState, getSession, upsertSession } from '../store/session-store.js';
import { resolveContextWindow } from '../util/model-context.js';
import { registerWatcherControl, unregisterWatcherControl, refreshSessionWatcher, type WatcherControl } from './watcher-controls.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '../../shared/file-change.js';
import { normalizeGeminiFileChange } from './file-change-normalizer.js';

const GEMINI_TMP_DIR = join(homedir(), '.gemini', 'tmp');
const POLL_INTERVAL_MS = 1500; // Balanced: responsive enough without causing state flicker
const IDLE_LOCK_MS = 2000;    // After emitting idle, ignore terminal noise for this long
const RUNNING_LOCK_MS = 3000; // After emitting running, don't transition to idle for this long
const RETRY_DELAY_MS = 100;
const pendingGeminiFileTools = new Map<string, { id: string; name: string; args?: unknown; ts?: number }>();
const completedGeminiFileTools = new Set<string>();
const MAX_TRACKED_GEMINI_FILE_TOOLS = 512;

function rememberCompletedGeminiFileTool(key: string): void {
  completedGeminiFileTools.add(key);
  if (completedGeminiFileTools.size <= MAX_TRACKED_GEMINI_FILE_TOOLS) return;
  const overflow = completedGeminiFileTools.size - MAX_TRACKED_GEMINI_FILE_TOOLS;
  let removed = 0;
  for (const existing of completedGeminiFileTools) {
    completedGeminiFileTools.delete(existing);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function rememberPendingGeminiFileTool(
  key: string,
  value: { id: string; name: string; args?: unknown; ts?: number },
): void {
  pendingGeminiFileTools.set(key, value);
  if (pendingGeminiFileTools.size <= MAX_TRACKED_GEMINI_FILE_TOOLS) return;
  const oldestKey = pendingGeminiFileTools.keys().next().value;
  if (oldestKey) pendingGeminiFileTools.delete(oldestKey);
}

function clearGeminiFileToolTracking(sessionName: string): void {
  for (const key of pendingGeminiFileTools.keys()) {
    if (key.startsWith(`${sessionName}:`)) pendingGeminiFileTools.delete(key);
  }
  for (const key of completedGeminiFileTools) {
    if (key.startsWith(`${sessionName}:`)) completedGeminiFileTools.delete(key);
  }
}

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
  const watcher = watchers.get(sessionName);
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
        if (text?.trim()) {
          if (watcher) watcher.turnHadAssistantText = true;
          timelineEmitter.emit(sessionName, 'assistant.thinking', { text }, { source: 'daemon', confidence: 'high', eventId: stableId('th'), ts: stableTs });
        }
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!tc.name) continue;
        const toolKey = `${sessionName}:${tc.id}`;
        const normalizedToolName = String(tc.name).toLowerCase();
        const looksLikeFileTool = normalizedToolName !== 'run_shell_command'
          && /(?:write|edit|file|rename|delete|patch|save)/i.test(normalizedToolName);
        if (completedGeminiFileTools.has(toolKey)) continue;
        if (looksLikeFileTool && tc.status === 'running') {
          rememberPendingGeminiFileTool(toolKey, { id: tc.id, name: tc.name, args: tc.args, ts: stableTs });
          continue;
        }

        const pending = pendingGeminiFileTools.get(toolKey);
        if (tc.status !== 'running') pendingGeminiFileTools.delete(toolKey);
        const effectiveArgs = tc.args ?? pending?.args;
        const input = extractToolInput(tc.name, tc.args);
        const normalized = tc.status !== 'error'
          ? normalizeGeminiFileChange({
            toolName: tc.name,
            toolCallId: tc.id,
            args: effectiveArgs,
            result: tc.result?.[0]?.functionResponse?.response,
            status: tc.status,
          })
          : null;
        if (normalized) {
          rememberCompletedGeminiFileTool(toolKey);
          const effectiveInput = extractToolInput(tc.name, effectiveArgs);
          timelineEmitter.emit(sessionName, 'tool.call', { tool: tc.name, ...(effectiveInput ? { input: effectiveInput } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tc'), ts: pending?.ts ?? stableTs, hidden: true });
          const rawOutput = tc.result?.[0]?.functionResponse?.response?.output;
          timelineEmitter.emit(sessionName, 'tool.result', {
            ...(tc.status === 'error' ? { error: rawOutput ?? 'error' } : {}),
            ...(typeof rawOutput === 'string' && rawOutput.trim() ? { output: rawOutput.length > 200 ? rawOutput.slice(0, 197) + '...' : rawOutput } : {}),
          }, { source: 'daemon', confidence: 'high', eventId: stableId('tr'), ts: stableTs, hidden: true });
          timelineEmitter.emit(sessionName, TIMELINE_EVENT_FILE_CHANGE, { batch: normalized }, { source: 'daemon', confidence: 'high', eventId: stableId('fc'), ts: stableTs });
          continue;
        }
        if (looksLikeFileTool) {
          rememberCompletedGeminiFileTool(toolKey);
        }
        const shouldEmitDeferredCall = !!pending || looksLikeFileTool;
        if (shouldEmitDeferredCall) {
          const effectiveInput = extractToolInput(tc.name, effectiveArgs);
          timelineEmitter.emit(sessionName, 'tool.call', { tool: tc.name, ...(effectiveInput ? { input: effectiveInput } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tc'), ts: pending?.ts ?? stableTs });
        }
        if (shouldEmitDeferredCall && (tc.status === 'complete' || tc.status === 'success' || tc.status === 'error')) {
          const rawOutput = tc.result?.[0]?.functionResponse?.response?.output;
          const isErr = tc.status === 'error';
          const truncOutput = !isErr && typeof rawOutput === 'string' && rawOutput.trim()
            ? (rawOutput.length > 200 ? rawOutput.slice(0, 197) + '...' : rawOutput)
            : undefined;
          timelineEmitter.emit(sessionName, 'tool.result', { ...(isErr ? { error: rawOutput ?? 'error' } : {}), ...(truncOutput ? { output: truncOutput } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tr'), ts: stableTs });
          continue;
        }
        timelineEmitter.emit(sessionName, 'tool.call', { tool: tc.name, ...(input ? { input } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tc'), ts: stableTs });
        const rawOutput = tc.result?.[0]?.functionResponse?.response?.output;
        const isErr = tc.status === 'error';
        const truncOutput = !isErr && typeof rawOutput === 'string' && rawOutput.trim()
          ? (rawOutput.length > 200 ? rawOutput.slice(0, 197) + '...' : rawOutput)
          : undefined;
        timelineEmitter.emit(sessionName, 'tool.result', { ...(isErr ? { error: rawOutput ?? 'error' } : {}), ...(truncOutput ? { output: truncOutput } : {}) }, { source: 'daemon', confidence: 'high', eventId: stableId('tr'), ts: stableTs });
      }
    }
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (watcher) watcher.turnHadAssistantText = true;
      timelineEmitter.emit(sessionName, 'assistant.text', { text: msg.content, streaming }, { source: 'daemon', confidence: 'high', eventId: stableId('at'), ts: stableTs });
    }
    // Emit usage.update from Gemini's per-message token counts
    const tokens = msg.tokens;
    if (tokens && typeof tokens.input === 'number') {
      const model = msg.model as string | undefined;
      timelineEmitter.emit(sessionName, 'usage.update', {
        inputTokens: tokens.input,
        cacheTokens: tokens.cached ?? 0,
        outputTokens: tokens.output ?? 0,
        contextWindow: resolveContextWindow(undefined, model),
        ...(model ? { model } : {}),
      }, { source: 'daemon', confidence: 'high', eventId: stableId('uu'), ts: stableTs });
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
  /** Separate AbortController for the current fs.watch — aborted on rotation without killing the session. */
  watchAbort: AbortController;
  stopped: boolean;
  /** Re-entrancy guard — prevents overlapping pollTick executions. */
  polling: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  /** Current emitted state — single source of truth for what was last sent to timeline. */
  currentState?: 'running' | 'idle';
  idleDebounceTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp of last idle emit — used for idle lock (ignore terminal noise shortly after idle). */
  lastIdleEmitTs?: number;
  /** Timestamp of last running emit — used for running lock (prevent rapid running→idle). */
  lastRunningEmitTs?: number;
  _lastRotationCheck?: number;
  _terminalThinkingEmitted?: boolean;
  lastConversationStatus?: 'running' | 'idle' | null;
  /** Consecutive poll ticks where JSON inferred idle. Prevents tool-call gap false idles. */
  idleConfirmCount?: number;
  /** Consecutive terminal frames showing a leading braille spinner. 2+ = confirmed working. */
  spinnerFrameCount?: number;
  /** Last known mtime of activeFile — used as cheap change check before full read. */
  _lastMtimeMs?: number;
  /** Last known file size — supplements mtime to catch same-ms writes. */
  _lastSize?: number;
  /** Last known inode — detects atomic file replacement (write-to-temp + rename). */
  _lastIno?: number;
  /** Content length of the last processed message — detects real content growth vs metadata-only updates. */
  _lastMsgLen?: number;
  /** Consecutive readConversation failures — triggers file rescan after threshold. */
  _readFailCount?: number;
  /** Last time assertSpinnerGate was called — cooldown to avoid 400ms burst every 1.5s. */
  _lastSpinnerGateTs?: number;
  /** Whether the current running turn produced visible assistant text/thought text. */
  turnHadAssistantText?: boolean;
  /** Prevent repeated retrack attempts for the same no-text running→idle turn. */
  noTextRetrackAttempted?: boolean;
}

const watchers = new Map<string, WatcherState>();

function watcherControl(sessionName: string): WatcherControl {
  return {
    refresh: () => refreshTrackedSession(sessionName),
  };
}
const claimedFiles = new Map<string, string>(); // filePath → sessionName

export function preClaimFile(sessionName: string, filePath: string): void {
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) { claimedFiles.delete(fp); break; } }
  claimedFiles.set(filePath, sessionName);
}

// ── Terminal-based thinking detection ─────────────────────────────────────────
// Supplements JSON watching: when the JSON file hasn't changed but the terminal
// shows activity (spinner, "esc to cancel"), emit assistant.thinking so the
// web UI chat mode reflects that Gemini is working.

/** Check if the last non-empty line starts with a braille spinner char (col 0). */
function hasLeadingSpinner(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const ch = line.charAt(0);
    return ch >= '\u2800' && ch <= '\u28FF';
  }
  return false;
}

const SPINNER_CONFIRM_READS = 5;
const SPINNER_CONFIRM_INTERVAL_MS = 80;

/** Burst-read capture-pane N times to confirm spinner presence. ~400ms total. */
async function confirmSpinner(sessionName: string): Promise<boolean> {
  let hits = 0;
  for (let i = 0; i < SPINNER_CONFIRM_READS; i++) {
    try {
      const lines = await capturePane(sessionName);
      if (hasLeadingSpinner(lines)) hits++;
    } catch { /* session gone */ }
    if (i < SPINNER_CONFIRM_READS - 1) {
      await new Promise(r => setTimeout(r, SPINNER_CONFIRM_INTERVAL_MS));
    }
  }
  // Require majority (3/5) to confirm — tolerates occasional capture miss
  return hits >= 3;
}

const SPINNER_GATE_COOLDOWN_MS = 3_000; // Skip burst if last gate was < 3s ago and state unchanged

/**
 * Burst-confirm spinner presence. This is the SINGLE GATE for all idle/running
 * decisions — every path must call this before transitioning state.
 * Returns true if spinner is confirmed active (= agent is working).
 *
 * Cooldown: if the last gate check was recent and state is still 'running',
 * skip the expensive 5-read burst to reduce tmux I/O load.
 */
async function assertSpinnerGate(sessionName: string, state: WatcherState): Promise<boolean> {
  const now = Date.now();
  // If recently confirmed running and still in running state, skip burst
  if (state._lastSpinnerGateTs && state.currentState === 'running' &&
      (now - state._lastSpinnerGateTs) < SPINNER_GATE_COOLDOWN_MS) {
    return true; // trust recent confirmation
  }
  const confirmed = await confirmSpinner(sessionName);
  if (confirmed) {
    state._lastSpinnerGateTs = now;
    if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }
    state.spinnerFrameCount = SPINNER_CONFIRM_READS;
    state.idleConfirmCount = 0;
    transitionState(sessionName, state, 'running', true); // spinner is ground truth
    if (!state._terminalThinkingEmitted) {
      state._terminalThinkingEmitted = true;
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'terminal-spinner', confidence: 'high' });
    }
  } else {
    state.spinnerFrameCount = 0;
    state._lastSpinnerGateTs = undefined; // Clear cooldown so next check does full burst
  }
  return confirmed;
}

async function terminalThinkingCheck(sessionName: string, state: WatcherState): Promise<void> {
  let lines: string[];
  try {
    lines = await capturePane(sessionName);
  } catch {
    return; // session may not exist yet
  }

  const status = detectStatus(lines, 'gemini');
  const spinnerVisible = hasLeadingSpinner(lines);

  // ── Spinner visible on first frame OR about to declare idle → burst-confirm ──
  if (spinnerVisible || status === 'idle') {
    if (await assertSpinnerGate(sessionName, state)) return; // spinner confirmed → running
  }

  // ── No spinner confirmed — proceed with idle/running logic ─────────────
  if (status === 'idle') {
    if (state.lastConversationStatus === 'idle') {
      state.idleConfirmCount = 2;
      if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }
      state._terminalThinkingEmitted = false;
      if (watchers.has(sessionName) && state.currentState === 'running' && !state.turnHadAssistantText && !state.noTextRetrackAttempted) {
        state.noTextRetrackAttempted = true;
        await refreshSessionWatcher(sessionName);
        return;
      }
      // Both terminal and JSON agree idle — high confidence, but still respect running lock
      // to prevent flicker when JSON is stale (hasn't updated after user sent a message)
      transitionState(sessionName, state, 'idle');
      return;
    }
    // JSON says running (last message is user type, or pending tool call) —
    // agent MUST respond. Trust JSON over terminal; don't debounce to idle.
    if (state.lastConversationStatus === 'running') {
      return;
    }
    // JSON status unknown/null — terminal idle might be correct, use debounce
    if (state.currentState === 'running' && !state.idleDebounceTimer) {
      state.idleDebounceTimer = setTimeout(() => {
        state.idleDebounceTimer = undefined;
        if (!state.stopped) {
          state._terminalThinkingEmitted = false;
          if (watchers.has(sessionName) && state.currentState === 'running' && !state.turnHadAssistantText && !state.noTextRetrackAttempted) {
            state.noTextRetrackAttempted = true;
            void refreshSessionWatcher(sessionName);
          } else {
            transitionState(sessionName, state, 'idle');
          }
        }
      }, 3000);
    }
    return;
  }

  // Terminal shows activity but spinner not confirmed — use JSON as tiebreaker
  if (state.lastConversationStatus === 'idle') {
    if (!state._terminalThinkingEmitted) {
      state._terminalThinkingEmitted = true;
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'terminal-parse', confidence: 'low' });
    }
    return;
  }

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
  if (watchers.has(sessionName) && next === 'idle' && state.currentState === 'running' && !state.turnHadAssistantText && !state.noTextRetrackAttempted) {
    state.noTextRetrackAttempted = true;
    void refreshSessionWatcher(sessionName);
    return;
  }
  if (!force) {
    // Idle lock: don't transition to running if we just emitted idle (terminal noise)
    if (next === 'running' && state.lastIdleEmitTs && (Date.now() - state.lastIdleEmitTs) < IDLE_LOCK_MS) return;
    // Running lock: don't transition to idle if we just emitted running (prevents flicker)
    if (next === 'idle' && state.lastRunningEmitTs && (Date.now() - state.lastRunningEmitTs) < RUNNING_LOCK_MS) return;
  }
  state.currentState = next;
  if (next === 'running') {
    state.turnHadAssistantText = false;
    state.noTextRetrackAttempted = false;
  }
  if (next === 'idle') state.lastIdleEmitTs = Date.now();
  if (next === 'running') state.lastRunningEmitTs = Date.now();
  logger.debug({ sessionName, state: next, activeFile: state.activeFile, seenCount: state.seenCount }, 'gemini-watcher: state transition');
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

async function readConversation(filePath: string, sessionName?: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readFile(filePath, 'utf8');
      if (!raw.trim()) continue;
      return JSON.parse(raw);
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  // All retries exhausted — log so we can diagnose tracking failures
  logger.warn({ sessionName, filePath }, 'gemini-watcher: readConversation exhausted retries');
  return null;
}

export async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  // Re-entrancy guard — prevent overlapping pollTick from fs.watch + poll timer
  if (state.polling) return;
  state.polling = true;
  try {
    await pollTickInner(sessionName, state);
  } finally {
    state.polling = false;
  }
}

async function pollTickInner(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) {
    const found = state.sessionUuid ? await findSessionFile(state.sessionUuid) : await findLatestSessionFile();
    if (found) { state.activeFile = found; claimedFiles.set(found, sessionName); } else return;
  }

  // Cheap change check: skip full read if file mtime, size, AND inode haven't changed.
  // Inode check catches atomic file replacement (write-to-temp + rename).
  try {
    const s = await stat(state.activeFile!);
    const mtimeUnchanged = state._lastMtimeMs !== undefined && s.mtimeMs === state._lastMtimeMs;
    const sizeUnchanged = state._lastSize !== undefined && s.size === state._lastSize;
    // Inode change = atomic file replacement. Only triggers re-read when both old and new ino are known.
    const inodeChanged = state._lastIno !== undefined && s.ino !== undefined && s.ino !== state._lastIno;
    if (mtimeUnchanged && sizeUnchanged && !inodeChanged) {
      // File truly unchanged — terminal spinner is ground truth.
      // terminalThinkingCheck handles all state transitions via assertSpinnerGate.
      await terminalThinkingCheck(sessionName, state);
      return;
    }
    state._lastMtimeMs = s.mtimeMs;
    state._lastSize = s.size;
    state._lastIno = s.ino;
  } catch {
    // stat failed — fall through to full read attempt
  }

  const conv = await readConversation(state.activeFile!, sessionName);
  if (!conv) {
    // Parse failed — Gemini is likely mid-write. Track consecutive failures.
    state._readFailCount = (state._readFailCount ?? 0) + 1;
    if (state._readFailCount >= 5) {
      // Too many consecutive failures — file may be corrupt or replaced.
      // Reset activeFile to trigger rediscovery on next tick.
      logger.warn({ sessionName, file: state.activeFile, failures: state._readFailCount }, 'gemini-watcher: too many read failures, triggering file rescan');
      state.activeFile = null;
      state._readFailCount = 0;
    } else if (state.currentState !== 'running') {
      transitionState(sessionName, state, 'running');
    }
    return;
  }
  state._readFailCount = 0;
  const conversationStatus = inferConversationStatus(conv);
  state.lastConversationStatus = conversationStatus;

  if (conv.lastUpdated === state.lastUpdated && conv.messages.length === state.seenCount) {
    // JSON unchanged — terminal spinner is ground truth.
    // terminalThinkingCheck handles all state transitions via assertSpinnerGate.
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

  // JSON just changed → agent may be actively working.
  // Reset idle confirm count and debounce timer.
  state.idleConfirmCount = 0;
  if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }

  // Track last message content length to distinguish real content growth from
  // metadata-only updates (e.g. lastUpdated timestamp changing without new content).
  const lastMsg = conv.messages[conv.messages.length - 1];
  const lastMsgLen = typeof lastMsg?.content === 'string' ? lastMsg.content.length : -1;
  const prevMsgLen = state._lastMsgLen;
  state._lastMsgLen = lastMsgLen;

  // Detect real content growth vs metadata-only updates.
  // prevMsgLen === undefined means _lastMsgLen was never seeded (shouldn't happen
  // after the startWatching fix, but guard against it). Only count as "content grew"
  // when both values are known numbers and the length actually increased.
  const contentGrew = prevMsgLen !== undefined && lastMsgLen > prevMsgLen;

  if (conversationStatus === 'running') {
    transitionState(sessionName, state, 'running');
  } else if (!isUpdate || contentGrew) {
    // New messages arrived or last message's content is actively growing
    // (streaming). Bias toward running so the unchanged path (terminal
    // check) can confirm idle on the next tick.
    transitionState(sessionName, state, 'running');
  }
  // else: metadata-only update (lastUpdated changed, content length stable).
  // Don't bounce to running — let current state stand.
}

// ── File rotation helper ────────────────────────────────────────────────────────

/**
 * Switch to a new active file after rotation. Resets tracking state and restarts
 * the fs.watch on the new file's directory.
 */
function activateFile(sessionName: string, state: WatcherState, newFile: string): void {
  // Clean up old file claim
  if (state.activeFile) claimedFiles.delete(state.activeFile);

  // Abort the old fs.watch watcher (separate from session abort)
  state.watchAbort.abort();
  state.watchAbort = new AbortController();

  // Switch file and reset tracking counters
  state.activeFile = newFile;
  claimedFiles.set(newFile, sessionName);
  state.seenCount = 0;
  state.lastUpdated = '';
  state._lastMtimeMs = undefined;
  state._lastSize = undefined;
  state._lastIno = undefined;
  state._readFailCount = 0;
  state._terminalThinkingEmitted = false;
  state.idleConfirmCount = 0;
  if (state.idleDebounceTimer) { clearTimeout(state.idleDebounceTimer); state.idleDebounceTimer = undefined; }

  // Start fresh watcher on new file's directory
  void watchGeminiDir(sessionName, state);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function startWatching(sessionName: string, sessionUuid: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = {
    sessionUuid, activeFile: null, seenCount: 0, lastUpdated: '',
    abort: new AbortController(), watchAbort: new AbortController(),
    stopped: false, polling: false,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);

  const found = await findSessionFile(sessionUuid);
  if (found) {
    state.activeFile = found; claimedFiles.set(found, sessionName);
    const conv = await readConversation(found, sessionName);
    if (conv) {
      state.seenCount = conv.messages.length;
      state.lastUpdated = conv.lastUpdated;
      state.lastConversationStatus = inferConversationStatus(conv);
      // Seed _lastMsgLen so the first pollTick "changed file" path doesn't
      // treat a metadata-only update (lastUpdated timestamp) as new content.
      const lastMsg = conv.messages[conv.messages.length - 1];
      state._lastMsgLen = typeof lastMsg?.content === 'string' ? lastMsg.content.length : -1;
      if (state.lastConversationStatus === 'idle') {
        transitionState(sessionName, state, 'idle');
      }
    }
  }

  state.pollTimer = setInterval(() => {
    void (async () => {
      // Periodic rotation check (every 10s)
      const now = Date.now();
      if (now - (state._lastRotationCheck || 0) > 10000 && state.sessionUuid) {
        state._lastRotationCheck = now;
        const currentFile = await findSessionFile(state.sessionUuid);
        if (currentFile && currentFile !== state.activeFile) {
          logger.info({ sessionName, newFile: currentFile, oldFile: state.activeFile }, 'gemini-watcher: date rotation detected');
          activateFile(sessionName, state, currentFile);
          // Don't pre-mark messages as seen — let pollTickInner process them
          // naturally. activateFile already set seenCount=0, so the next poll
          // will emit all messages from the new file.
          const conv = await readConversation(currentFile, sessionName);
          if (conv) {
            state.lastConversationStatus = inferConversationStatus(conv);
          }
        }
      }
      await pollTick(sessionName, state);
    })();
  }, POLL_INTERVAL_MS);

  void watchGeminiDir(sessionName, state);
  return control;
}

/**
 * Watch for a NEW Gemini session file to appear (not in the given snapshot).
 * Once discovered, extract its UUID and notify the callback.
 */
export async function startWatchingDiscovered(
  sessionName: string,
  snapshot: Set<string>,
  onDiscovered?: (uuid: string) => void,
): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = {
    sessionUuid: '', activeFile: null, seenCount: 0, lastUpdated: '',
    abort: new AbortController(), watchAbort: new AbortController(),
    stopped: false, polling: false,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);

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
              const conv = await readConversation(fullPath, sessionName);
              if (conv && conv.sessionId) {
                state.activeFile = fullPath;
                claimedFiles.set(fullPath, sessionName);
                state.sessionUuid = conv.sessionId;
                state.seenCount = conv.messages?.length ?? 0;
                state.lastUpdated = conv.lastUpdated ?? '';
                state.lastConversationStatus = inferConversationStatus(conv);
                const lm = conv.messages?.[conv.messages.length - 1];
                state._lastMsgLen = typeof lm?.content === 'string' ? lm.content.length : -1;
                // Persist to local session store so daemon restarts can use the UUID
                const sess = getSession(sessionName);
                if (sess && !sess.geminiSessionId) {
                  upsertSession({ ...sess, geminiSessionId: conv.sessionId, updatedAt: Date.now() });
                  logger.info({ sessionName, geminiSessionId: conv.sessionId }, 'gemini-watcher: persisted discovered session ID to store');
                }
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
  return control;
}

export async function startWatchingLatest(sessionName: string): Promise<WatcherControl> { return startWatching(sessionName, ''); }

export function isWatching(sessionName: string): boolean { return watchers.has(sessionName); }

/**
 * Force the registered watcher to immediately run its normal poll/scan cycle for
 * this session. Uses the watcher's existing session identity and file tracking.
 */
export async function refreshTrackedSession(sessionName: string): Promise<boolean> {
  const state = watchers.get(sessionName);
  if (!state || state.stopped) return false;
  await pollTick(sessionName, state);
  return true;
}

export async function retrackLatestSessionFile(sessionName: string): Promise<boolean> {
  const state = watchers.get(sessionName);
  if (!state || state.stopped) return false;
  if (!state.sessionUuid) {
    state.noTextRetrackAttempted = true;
    if (state.currentState === 'running' && !state.stopped) transitionState(sessionName, state, 'idle', true);
    return false;
  }

  let found: string | null = null;
  try {
    found = await findSessionFile(state.sessionUuid);
  } catch {
    found = null;
  }
  if (!found || found === state.activeFile) {
    state.noTextRetrackAttempted = true;
    if (state.currentState === 'running' && !state.stopped) transitionState(sessionName, state, 'idle', true);
    return false;
  }

  logger.info({ sessionName, oldFile: state.activeFile, newFile: found }, 'gemini-watcher: retracking latest session file after no-text turn');
  activateFile(sessionName, state, found);
  await pollTick(sessionName, state);
  return true;
}

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
  state.stopped = true;
  state.abort.abort();       // kills session-level resources
  state.watchAbort.abort();  // kills current fs.watch
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.idleDebounceTimer) clearTimeout(state.idleDebounceTimer);
  watchers.delete(sessionName);
  clearGeminiFileToolTracking(sessionName);
  unregisterWatcherControl(sessionName);
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) claimedFiles.delete(fp); }
}

async function watchGeminiDir(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;
  const dir = state.activeFile.substring(0, state.activeFile.lastIndexOf('/'));
  const filename = state.activeFile.substring(state.activeFile.lastIndexOf('/') + 1);
  try {
    // Use the per-watcher AbortController so rotation can kill just this watcher
    const watcher = watch(dir, { persistent: false, signal: state.watchAbort.signal });
    for await (const event of watcher as any) {
      if (state.stopped) break;
      if (event.filename === filename) await pollTick(sessionName, state);
    }
  } catch (err: any) {
    // AbortError is expected on rotation/stop — only log unexpected errors
    if (err?.name !== 'AbortError' && !state.stopped) {
      logger.warn({ sessionName, err }, 'gemini-watcher: fs.watch error');
    }
  }
}
