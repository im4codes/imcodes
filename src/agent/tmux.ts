import { execFile as execFileCb, execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { promisify } from 'util';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';

import {
  weztermNewSession,
  weztermKillSession,
  weztermSessionExists,
  weztermListSessions,
  weztermSendText,
  weztermSendEnter,
  weztermSendKey,
  weztermCapturePane,
  weztermRespawnPane,
  weztermGetPaneCwd,
  weztermGetPaneId,
  weztermIsPaneAlive,
  weztermGetPanePids,
  weztermCapturePaneVisible,
  weztermResizePane,
  weztermSendRawInput,
  weztermGetPaneSize,
  startWeztermPollingStream,
  registerPane,
} from './wezterm.js';
import { registerTempFile, removeTrackedTempFile } from '../store/temp-file-store.js';

const execFile = promisify(execFileCb);

// ── Backend detection ───────────────────────────────────────────────────────────

export type TerminalBackend = 'tmux' | 'wezterm' | 'conpty';

/**
 * Error thrown when a tmux-only feature is called on an unsupported backend.
 * Callers can catch this to degrade gracefully.
 */
export class UnsupportedBackendError extends Error {
  public readonly backend: TerminalBackend;
  public readonly feature: string;
  constructor(backend: TerminalBackend, feature: string) {
    super(`Feature "${feature}" is not supported on the "${backend}" backend`);
    this.name = 'UnsupportedBackendError';
    this.backend = backend;
    this.feature = feature;
  }
}

/**
 * Detect the terminal multiplexer backend. Runs once at module load (sync).
 *
 * Priority: $IMCODES_MUX env → win32 platform → `which tmux` → `which wezterm` → error.
 */
function detectBackend(): TerminalBackend {
  // 1. Explicit override via env
  const envMux = process.env.IMCODES_MUX;
  if (envMux === 'tmux' || envMux === 'wezterm') return envMux;
  if (envMux === 'conpty') {
    if (process.platform !== 'win32' && !process.env.IMCODES_TEST) {
      throw new Error('IMCODES_MUX=conpty is only supported on Windows');
    }
    return 'conpty';
  }

  // 2. Windows defaults to ConPTY
  if (process.platform === 'win32') {
    try {
      const req = createRequire(import.meta.url);
      req.resolve('node-pty');
      return 'conpty';
    } catch {
      throw new Error('node-pty not found. Reinstall imcodes.');
    }
  }

  // 3. Probe for tmux
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' });
    return 'tmux';
  } catch { /* not found */ }

  // 4. Probe for wezterm
  try {
    execFileSync('which', ['wezterm'], { stdio: 'ignore' });
    return 'wezterm';
  } catch { /* not found */ }

  throw new Error(
    'No terminal multiplexer found. Install tmux (Linux/macOS), or set $IMCODES_MUX.',
  );
}

/** The backend for this daemon process. Detected once at module load. */
export const BACKEND: TerminalBackend = detectBackend();

// ── Lazy-load ConPTY module ──────────────────────────────────────────────────────
// Avoids crash when node-pty is not installed (non-Windows setups).
let _conpty: typeof import('./conpty.js') | null = null;
async function conpty() {
  if (!_conpty) _conpty = await import('./conpty.js');
  return _conpty;
}

// ── Require tmux backend helper ─────────────────────────────────────────────────

function requireTmux(feature: string): void {
  if (BACKEND !== 'tmux') throw new UnsupportedBackendError(BACKEND, feature);
}

// ── tmux internals (unchanged) ──────────────────────────────────────────────────

/** Ensure tmux server is running. Auto-starts if dead. */
let tmuxServerChecked = false;
let tmuxServerCheckInFlight: Promise<void> | null = null;
function getTmuxErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const e = error as { stderr?: unknown; message?: unknown };
  return String(e.stderr || e.message || '');
}

function isRecoverableTmuxServerError(error: unknown): boolean {
  const stderr = getTmuxErrorText(error);
  return (
    stderr.includes('no server running')
    || stderr.includes('No such file or directory')
    || stderr.includes('error connecting')
    || stderr.includes('server exited unexpectedly')
  );
}

function isDuplicateInitSessionError(error: unknown): boolean {
  return getTmuxErrorText(error).includes('duplicate session: imcodes_init');
}

async function ensureTmuxServer(): Promise<void> {
  if (tmuxServerChecked) return;
  if (tmuxServerCheckInFlight) {
    await tmuxServerCheckInFlight;
    return;
  }
  tmuxServerCheckInFlight = (async () => {
  try {
    await execFile('tmux', ['list-sessions']);
    tmuxServerChecked = true;
  } catch (e: any) {
    const stderr = getTmuxErrorText(e);
    if (isRecoverableTmuxServerError(e)) {
      // tmux server is dead — start it
      try {
        await execFile('tmux', ['new-session', '-d', '-s', 'imcodes_init']);
      } catch (initError) {
        if (!isDuplicateInitSessionError(initError)) throw initError;
      }
      // Kill the temp session, server stays alive
      await execFile('tmux', ['kill-session', '-t', 'imcodes_init']).catch(() => {});
      tmuxServerChecked = true;
    } else if (stderr.includes('no sessions')) {
      // Server running but no sessions — fine
      tmuxServerChecked = true;
    } else {
      throw e;
    }
  }
  })();
  try {
    await tmuxServerCheckInFlight;
  } finally {
    tmuxServerCheckInFlight = null;
  }
}

/** Run a tmux command with array args (no shell — safe from injection). */
async function tmuxRun(...args: string[]): Promise<string> {
  await ensureTmuxServer();
  try {
    const { stdout } = await execFile('tmux', args);
    return stdout.trim();
  } catch (error) {
    if (!isRecoverableTmuxServerError(error)) throw error;
    // tmux exits when the last session dies. Under rapid create/kill loops,
    // a cached "server exists" assumption can race with the server shutting
    // down between commands. Re-prime once, then retry the original command.
    tmuxServerChecked = false;
    await ensureTmuxServer();
    const { stdout } = await execFile('tmux', args);
    return stdout.trim();
  }
}

// ── Raw send primitives (backend-dispatched) ────────────────────────────────────

/** Send text literally to a session (no Enter). Backend-dispatched. */
async function rawSendText(session: string, text: string): Promise<void> {
  if (BACKEND === 'wezterm') {
    await weztermSendText(session, text);
  } else {
    await tmuxRun('send-keys', '-t', session, '-l', '--', text);
  }
}

/** Send Enter key to a session. Backend-dispatched. */
async function rawSendEnter(session: string): Promise<void> {
  if (BACKEND === 'wezterm') {
    await weztermSendEnter(session);
  } else {
    await tmuxRun('send-keys', '-t', session, 'Enter');
  }
}

// ── Portable exports (backend-dispatched) ───────────────────────────────────────

/**
 * Capture the visible content of a pane (scrollback history).
 * Returns lines as a string array.
 */
export async function capturePane(session: string, lines = 50): Promise<string[]> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyCapturePane(session, lines);
  }
  if (BACKEND === 'wezterm') return weztermCapturePane(session, lines);
  const raw = await tmuxRun('capture-pane', '-p', '-t', session, '-S', `-${lines}`);
  return raw.split('\n');
}

/**
 * Capture only the currently visible pane with ANSI color codes.
 * Used for terminal streaming — gives exactly the rows the user sees.
 */
export async function capturePaneVisible(session: string): Promise<string> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyCapturePane(session, 50).join('\n');
  }
  if (BACKEND === 'wezterm') {
    return weztermCapturePaneVisible(session);
  }
  return tmuxRun('capture-pane', '-e', '-p', '-t', session);
}

/**
 * Capture scrollback history (above the visible area) with ANSI colors.
 * -S -N starts N lines before visible top; -E -1 ends at the line before visible row 0.
 */
export async function capturePaneHistory(session: string, lines = 1000): Promise<string> {
  requireTmux('capturePaneHistory');
  return tmuxRun('capture-pane', '-e', '-p', '-t', session, '-S', `-${lines}`, '-E', '-1');
}

/**
 * Get the content of the line where the cursor is currently positioned.
 * Useful for detecting if an agent is at an input prompt (cursor on ">" or "›" line).
 */
export async function getCursorLine(session: string): Promise<string> {
  requireTmux('getCursorLine');
  const cursorY = parseInt(await tmuxRun('display-message', '-t', session, '-p', '#{cursor_y}'), 10);
  const lines = (await tmuxRun('capture-pane', '-p', '-t', session)).split('\n');
  return lines[cursorY] ?? '';
}

export interface SendKeysOptions {
  /** @deprecated No longer needed — long text handling is automatic. */
  chunked?: boolean;
  /** Project directory — used to place temp files inside the project for sandboxed agents (Gemini). */
  cwd?: string;
}

/**
 * Send text then Enter to a session.
 *
 * **Default (no cwd)** — for CC and agents that handle bracketed paste:
 * - Short text (≤200, single line): `send-keys -l`
 * - Long text: `load-buffer` + `paste-buffer` (bracketed paste, content sent directly)
 *
 * **With cwd** — for sandboxed agents (Gemini) that can't handle paste-buffer or /tmp:
 * - Write to temp file in project dir, send "read <path>" instruction
 * - 30m auto-cleanup persisted in ~/.imcodes/temp-files.json
 *
 * Always sends Enter after text. Long text gets a 3s safety-net Enter.
 */
export async function sendKeys(session: string, keys: string, opts?: SendKeysOptions): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    const isLong = keys.length > 200 || keys.includes('\n');
    await c.conptySendText(session, keys);
    // Delay before Enter — keep a minimum floor so the foreground app has time
    // to consume the preceding text before Enter lands.
    const delay = isLong ? 500 : Math.max(180, Math.min(80 + Math.floor(keys.length / 10) * 5, 1000));
    await new Promise<void>((r) => setTimeout(r, delay));
    await c.conptySendEnter(session);
    // Safety net: 3s delayed Enter for long text (empty-line Enter is a no-op)
    if (isLong) {
      setTimeout(async () => {
        try { c.conptySendEnter(session); } catch { /* ignore */ }
      }, 3_000);
    }
    return;
  }

  const isLong = keys.length > 200 || keys.includes('\n');

  if (isLong) {
    // Write to temp file + send read instruction
    // With cwd: file in project dir (Gemini sandbox), without: os.tmpdir() (CC etc.)
    const hash = createHash('md5').update(session + Date.now()).digest('hex').slice(0, 8);
    const fileName = `.imcodes-prompt-${hash}.md`;
    const filePath = opts?.cwd ? path.join(opts.cwd, fileName) : path.join(os.tmpdir(), fileName);
    await fsp.writeFile(filePath, keys, { encoding: 'utf-8', mode: 0o600 });
    const now = Date.now();
    await registerTempFile({
      path: filePath,
      createdAt: now,
      expiresAt: now + (30 * 60_000),
      reason: 'sendKeys',
    });
    const instruction = `Read and execute all instructions in @${filePath}`;
    await rawSendText(session, instruction);
    setTimeout(async () => {
      try { await fsp.unlink(filePath); } catch { /* already deleted */ }
      try { await removeTrackedTempFile(filePath); } catch { /* ignore */ }
    }, 30 * 60_000);
  } else {
    // Short text: simple send (no shell quoting needed with execFile)
    await rawSendText(session, keys);
  }

  // Delay before Enter — keep a minimum floor so the foreground app has time
  // to consume the preceding text before Enter lands.
  const delay = isLong ? 500 : Math.max(180, Math.min(80 + Math.floor(keys.length / 10) * 5, 1000));
  await new Promise<void>((r) => setTimeout(r, delay));
  await rawSendEnter(session);

  // Safety net: 3s delayed Enter for ALL sends (empty-line Enter is a no-op for idle agents)
  setTimeout(async () => {
    try { await rawSendEnter(session); } catch { /* ignore */ }
  }, 3_000);
}

/** @deprecated Use sendKeys — kept as alias for backward compat. */
export const sendKeysDelayedEnter = sendKeys;

/** Send raw keys without appending Enter (e.g. for Ctrl-C). */
export async function sendKey(session: string, key: string): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    await c.conptySendKey(session, key);
    return;
  }
  if (BACKEND === 'wezterm') {
    await weztermSendKey(session, key);
  } else {
    await tmuxRun('send-keys', '-t', session, key);
  }
}

export interface NewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Create a new detached session. Throws if it already exists. */
export async function newSession(name: string, command?: string, opts?: NewSessionOptions): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    await c.conptyNewSession(name, command ?? '', opts);
    return;
  }
  if (BACKEND === 'wezterm') {
    // WezTerm: env vars are not natively supported via spawn flags.
    // Build a command string that sets env vars before the actual command.
    let fullCommand = command;
    if (opts?.env && Object.keys(opts.env).length > 0) {
      const isWin = process.platform === 'win32';
      const exports = Object.entries(opts.env)
        .map(([k, v]) => isWin ? `set "${k}=${v}"` : `export ${k}=${shellQuote(v)}`)
        .join(isWin ? ' && ' : '; ');
      const sep = isWin ? ' && ' : '; ';
      fullCommand = command ? `${exports}${sep}${command}` : exports;
    }
    const paneId = await weztermNewSession(name, fullCommand, { cwd: opts?.cwd });
    // Persist pane_id to session store — callers (session-manager) call upsertSession
    // with paneId after newSession returns. We register it in wezterm.ts internally.
    // The paneId is available via getPaneId() for the caller to persist.
    void paneId;
    return;
  }

  const args = ['new-session', '-d', '-s', name];
  if (opts?.cwd) args.push('-c', opts.cwd);
  if (opts?.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  if (command) args.push('--', command);
  await tmuxRun(...args);
  // Keep the tmux session alive after the process exits so daemon restarts
  // can detect it and reconnect instead of launching a fresh session.
  try {
    await tmuxRun('set-option', '-t', name, 'remain-on-exit', 'on');
  } catch {
    // Non-fatal: session was created but remain-on-exit couldn't be set
  }
}

/** Kill a session by name. Does not throw if it doesn't exist. */
export async function killSession(name: string): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    c.conptyKillSession(name);
    return;
  }
  if (BACKEND === 'wezterm') {
    await weztermKillSession(name);
    return;
  }
  try {
    await tmuxRun('kill-session', '-t', name);
  } catch {
    // session may not exist
  }
}

/** List all sessions. Returns session names. */
export async function listSessions(): Promise<string[]> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyListSessions();
  }
  if (BACKEND === 'wezterm') return weztermListSessions();
  try {
    const raw = await tmuxRun('list-sessions', '-F', '#{session_name}');
    return raw.split('\n').filter(Boolean);
  } catch (e: any) {
    const err = String(e.stderr || e.message || '');
    if (err.includes('no sessions') || err.includes('no server running') || err.includes('No such file or directory') || err.includes('error connecting')) return [];
    throw e;
  }
}

/** Check if a session exists. */
export async function sessionExists(name: string): Promise<boolean> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptySessionExists(name);
  }
  if (BACKEND === 'wezterm') return weztermSessionExists(name);
  const sessions = await listSessions();
  return sessions.includes(name);
}

/** Check if the pane process in a session is still alive (not dead from remain-on-exit). */
export async function isPaneAlive(name: string): Promise<boolean> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyIsPaneAlive(name);
  }
  if (BACKEND === 'wezterm') return weztermIsPaneAlive(name);
  try {
    const raw = await tmuxRun('list-panes', '-t', name, '-F', '#{pane_dead}');
    return raw.trim() === '0';
  } catch {
    return false;
  }
}

/** Respawn a dead pane (remain-on-exit) with a new command. */
export async function respawnPane(name: string, command: string, opts?: { env?: Record<string, string> }): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    await c.conptyRespawnPane(name, command, opts);
    return;
  }
  if (BACKEND === 'wezterm') {
    await weztermRespawnPane(name, command);
    return;
  }
  await tmuxRun('respawn-pane', '-t', name, '-k', command);
}

/** Resize a session window to the given dimensions. */
export async function resizeSession(name: string, cols: number, rows: number): Promise<void> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    c.conptyClearScreenBuffer(name);
    c.conptyResize(name, cols, rows);
    return;
  }
  if (BACKEND === 'wezterm') {
    await weztermResizePane(name, cols, rows);
    return;
  }
  await tmuxRun('resize-window', '-t', name, '-x', String(cols), '-y', String(rows));
}

/** Get the pane size (cols x rows) of a session. */
export async function getPaneSize(session: string): Promise<{ cols: number; rows: number }> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyGetPaneSize(session);
  }
  if (BACKEND === 'wezterm') {
    return weztermGetPaneSize(session);
  }
  try {
    const raw = await tmuxRun('display-message', '-p', '-t', session, '#{pane_width} #{pane_height}');
    const [cols, rows] = raw.split(' ').map(Number);
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

/** Read the tmux paste buffer (used for CC /copy output). tmux-only. */
export async function showBuffer(): Promise<string> {
  requireTmux('showBuffer');
  return tmuxRun('show-buffer');
}

/** Get the pane ID of the first pane in a session (opaque backend-specific identifier). */
export async function getPaneId(session: string): Promise<string> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return String(c.conptyGetPid(session));
  }
  if (BACKEND === 'wezterm') return weztermGetPaneId(session);
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_id}');
}

/** Get the current working directory of the first pane of a session. */
export async function getPaneCwd(session: string): Promise<string> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyGetPaneCwd(session);
  }
  if (BACKEND === 'wezterm') return weztermGetPaneCwd(session);
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_current_path}');
}

/** Get the start command of the first pane of a session. */
export async function getPaneStartCommand(session: string): Promise<string> {
  requireTmux('getPaneStartCommand');
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_start_command}');
}

/** Delete the tmux paste buffer (clipboard cleanup after CC /copy). tmux-only. */
export async function deleteBuffer(): Promise<void> {
  requireTmux('deleteBuffer');
  try {
    await tmuxRun('delete-buffer');
  } catch {
    // buffer may not exist
  }
}

/**
 * Get the PIDs of processes running in a session's panes.
 * Backend-dispatched. Replaces direct `tmux list-panes` calls from callers.
 */
export async function getPanePids(name: string): Promise<string[]> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    return c.conptyGetPanePids(name);
  }
  if (BACKEND === 'wezterm') return weztermGetPanePids(name);
  try {
    const raw = await tmuxRun('list-panes', '-t', name, '-F', '#{pane_pid}');
    return raw.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Restore the WezTerm name→pane_id mapping from a persisted SessionRecord.
 * Called during daemon startup / session reconcile for WezTerm backend.
 * No-op on tmux backend.
 */
export function restoreWeztermPane(name: string, paneId: string): void {
  if (BACKEND === 'wezterm') {
    registerPane(name, paneId);
  }
  // conpty and tmux: no-op
}

// Map xterm.js escape sequences → tmux key names
const XTERM_KEY_MAP: Record<string, string> = {
  '\x1b[A': 'Up',   '\x1b[B': 'Down',
  '\x1b[C': 'Right','\x1b[D': 'Left',
  '\x1b[F': 'End',  '\x1b[H': 'Home',
  '\x1b[1~': 'Home','\x1b[3~': 'DC',
  '\x1b[4~': 'End', '\x1b[5~': 'PPage',
  '\x1b[6~': 'NPage','\x1b[2~': 'IC',
  '\x1b[Z': 'BTab',
  '\r': 'Enter',    '\x7f': 'BSpace',
  '\x1b': 'Escape',
  '\x1bOP': 'F1',   '\x1bOQ': 'F2',
  '\x1bOR': 'F3',   '\x1bOS': 'F4',
  '\x1b[15~': 'F5', '\x1b[17~': 'F6',
  '\x1b[18~': 'F7', '\x1b[19~': 'F8',
  '\x1b[20~': 'F9', '\x1b[21~': 'F10',
  '\x1b[23~': 'F11','\x1b[24~': 'F12',
};

// ── Ctrl+C rate limiting ──────────────────────────────────────────────────────
// Rapid Ctrl+C (>2 within 3s) can kill the session. Track per-session timestamps.
const ctrlCHistory = new Map<string, number[]>();
const CTRL_C_WINDOW_MS = 3000;
const CTRL_C_MAX = 2;

function isCtrlCRateLimited(session: string): boolean {
  const now = Date.now();
  let times = ctrlCHistory.get(session);
  if (!times) {
    times = [];
    ctrlCHistory.set(session, times);
  }
  // Prune old entries
  while (times.length > 0 && now - times[0] > CTRL_C_WINDOW_MS) times.shift();
  if (times.length >= CTRL_C_MAX) return true;
  times.push(now);
  return false;
}

/**
 * Send raw terminal input to a session.
 * Maps xterm escape sequences to tmux key names; literal text uses -l flag.
 * Used for keyboard passthrough from the browser terminal.
 * tmux-only — xterm→tmux key translation is tmux-specific.
 */
export async function sendRawInput(session: string, data: string): Promise<void> {
  // Ctrl+C rate limiting — applies to ALL backends
  if (data.length === 1 && data.charCodeAt(0) === 3) {
    if (isCtrlCRateLimited(session)) return;
  }

  if (BACKEND === 'conpty') {
    const c = await conpty();
    c.conptySendText(session, data);
    return;
  }

  if (BACKEND === 'wezterm') {
    await weztermSendRawInput(session, data);
    return;
  }

  // Check escape sequence map first
  const tmuxKey = XTERM_KEY_MAP[data];
  if (tmuxKey) {
    await tmuxRun('send-keys', '-t', session, tmuxKey);
    return;
  }

  // Ctrl+A..Z: \x01..\x1a
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      await tmuxRun('send-keys', '-t', session, `C-${letter}`);
      return;
    }
  }

  // Unknown escape sequence — skip
  if (data.startsWith('\x1b')) return;

  // Regular printable text — send literally (no shell quoting needed with execFile)
  await tmuxRun('send-keys', '-t', session, '-l', '--', data);
}

// ── pipe-pane streaming (tmux-only) ─────────────────────────────────────────────

/** Shell-quote a string using single-quote wrapping. */
function shellQuote(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/** Validates the FIFO path against strict character whitelist. */
function validateFifoPath(p: string): boolean {
  return /^[A-Za-z0-9/_.\-]+$/.test(p);
}

/** Valid session name pattern for pipe-pane. */
const SESSION_PATTERN = /^deck_([a-z0-9A-Z0-9_\-]+_(brain|w\d+)|sub_[a-z0-9_\-]+)$/;

/** Cached pipe-pane capability (tmux >= 2.6 supports -O). */
let pipePaneCapability: boolean | null = null;


/**
 * Check if tmux supports `pipe-pane -O` (requires tmux >= 2.6).
 * Result is cached after first call. tmux-only.
 */
export async function checkPipePaneCapability(): Promise<boolean> {
  if (BACKEND === 'conpty') return true;
  requireTmux('checkPipePaneCapability');
  if (pipePaneCapability !== null) return pipePaneCapability;
  try {
    const { stdout } = await execFile('tmux', ['-V']);
    const match = stdout.trim().match(/^tmux\s+(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      pipePaneCapability = major > 2 || (major === 2 && minor >= 6);
    } else {
      pipePaneCapability = false;
    }
  } catch {
    pipePaneCapability = false;
  }
  return pipePaneCapability;
}

interface PipePaneHandle {
  /** Readable stream delivering raw PTY bytes from the FIFO. */
  stream: Readable;
  cleanup: () => Promise<void>;
}

/** Track active pipe-pane handles: session → handle info for cleanup. */
const activePipes = new Map<string, { paneId: string; fifoPath: string; dir: string; fd: number; stream: Readable; needsManualClose: boolean; catProc?: import('child_process').ChildProcess }>();

/** Destroy a pipe stream and close its fd if needed. */
function destroyPipeStream(stream: Readable, fd: number, needsManualClose: boolean, catProc?: import('child_process').ChildProcess): void {
  stream.destroy();
  if (catProc) {
    try { catProc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // On macOS with cat subprocess: fd is managed by us (O_WRONLY keepalive), close it.
  // On Linux: net.Socket.destroy() closes the fd internally — calling closeSync again
  // risks closing a reused fd number.
  if (needsManualClose && fd >= 0) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Start a `tmux pipe-pane -O` raw PTY stream for a session. tmux-only.
 * Uses a PID-scoped FIFO: O_RDWR on macOS (blocking reads in libuv thread pool),
 * O_RDWR|O_NONBLOCK on Linux (epoll-based non-blocking via net.Socket).
 * Returns a ReadStream and a cleanup function.
 */
export async function startPipePaneStream(session: string, paneId: string): Promise<PipePaneHandle> {
  if (BACKEND === 'conpty') {
    const c = await conpty();
    const { Readable } = await import('stream');
    const readable = new Readable({ read() {}, highWaterMark: 0 });
    const unsub = c.conptySubscribe(session, (data: string) => {
      readable.push(data);
    });
    return {
      stream: readable,
      cleanup: async () => {
        unsub();
        readable.push(null);
      },
    };
  }

  if (BACKEND === 'wezterm') {
    return startWeztermPollingStream(session);
  }

  if (!SESSION_PATTERN.test(session)) {
    throw new Error(`Invalid session name for pipe-pane: ${session}`);
  }

  // Stop any existing pipe for this session
  await stopPipePaneStream(session).catch(() => {});

  // Create PID-scoped temp dir
  const tmpPrefix = path.join(os.tmpdir(), `imcodes-pty-${process.pid}-`);
  const dir = await fsp.mkdtemp(tmpPrefix);
  const fifoPath = path.join(dir, 'stream.fifo');

  if (!validateFifoPath(fifoPath)) {
    await fsp.rmdir(dir).catch(() => {});
    throw new Error(`FIFO path failed character validation: ${fifoPath}`);
  }

  let fd = -1;
  let stream: Readable | null = null;
  let needsManualClose = false;
  let catProc: import('child_process').ChildProcess | undefined;

  try {
    // Create FIFO with 0600 permissions
    await execFile('mkfifo', ['-m', '0600', fifoPath]);

    // Spawn `cat` to read the FIFO — its stdout is a regular pipe that
    // libuv handles natively on all platforms (kqueue + epoll).
    // We keep a write-end fd open (O_RDWR|O_NONBLOCK) to prevent cat from
    // getting EOF when tmux hasn't written yet.
    //
    // Why not net.Socket({ fd }) directly on the FIFO?
    // - macOS: kqueue does not reliably deliver read-ready events for FIFOs.
    // - Linux: net.Socket on a FIFO fd is undocumented (libuv treats it as
    //   UV_NAMED_PIPE by accident). Under load the single 64KB FIFO buffer
    //   fills before the event loop drains it, blocking tmux's pipe-pane
    //   writer and causing visible input lag. The cat subprocess adds a
    //   second 64KB pipe buffer (128KB total) and converts the read into a
    //   well-tested libuv pipe path.
    fd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const cat = spawn('cat', [fifoPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    const catReady = new Promise<void>((resolve, reject) => {
      cat.once('spawn', () => resolve());
      cat.once('error', (err) => reject(err));
    });
    cat.on('error', (err) => {
      if (stream && !stream.destroyed) stream.destroy(err);
    });
    await catReady;
    if (!cat.stdout) {
      throw new Error('pipe-pane cat reader missing stdout pipe');
    }
    stream = cat.stdout;
    needsManualClose = true;
    catProc = cat;

    // Inline cat command — no external script needed
    const cmd = 'cat > ' + shellQuote(fifoPath);

    // Start pipe-pane -O (output only, not existing history)
    await execFile('tmux', ['pipe-pane', '-O', '-t', paneId, cmd]);

    // Startup success: pipe-pane exit 0 + verify stream hasn't errored (setImmediate)
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        // If stream emitted error synchronously before setImmediate, it would have thrown.
        // Check stream.destroyed to detect immediate close.
        if (stream!.destroyed) {
          reject(new Error('Pipe stream closed immediately after pipe-pane start'));
        } else {
          resolve();
        }
      });
    });

    const handle: PipePaneHandle = {
      stream,
      cleanup: async () => {
        const info = activePipes.get(session);
        if (info) {
          activePipes.delete(session);
          await execFile('tmux', ['pipe-pane', '-t', info.paneId]).catch(() => {});
          destroyPipeStream(info.stream, info.fd, info.needsManualClose, info.catProc);
          await fsp.unlink(info.fifoPath).catch(() => {});
          await fsp.rmdir(info.dir).catch(() => {});
        }
      },
    };

    activePipes.set(session, { paneId, fifoPath, dir, fd, stream, needsManualClose, catProc });
    return handle;
  } catch (err) {
    // Rollback: destroy stream + close fd if needed, clean up files
    if (stream) { destroyPipeStream(stream, fd, needsManualClose, catProc); }
    else {
      if (catProc) {
        try { catProc.kill('SIGTERM'); } catch { /* ignore */ }
      }
      if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    await execFile('tmux', ['pipe-pane', '-t', paneId]).catch(() => {});
    await fsp.unlink(fifoPath).catch(() => {});
    await fsp.rmdir(dir).catch(() => {});
    throw err;
  }
}

/**
 * Stop an active pipe-pane stream for a session. tmux-only.
 * No-op if no active stream exists.
 */
export async function stopPipePaneStream(session: string): Promise<void> {
  // ConPTY: cleanup is handled by startPipePaneStream's cleanup fn; no-op here.
  if (BACKEND === 'conpty') return;
  requireTmux('stopPipePaneStream');
  const info = activePipes.get(session);
  if (!info) return;
  activePipes.delete(session);
  await execFile('tmux', ['pipe-pane', '-t', info.paneId]).catch(() => {});
  destroyPipeStream(info.stream, info.fd, info.needsManualClose, info.catProc);
  await fsp.unlink(info.fifoPath).catch(() => {});
  await fsp.rmdir(info.dir).catch(() => {});
}

/**
 * Clean up any FIFO temp dirs leftover from a previous daemon run with the same PID.
 * Only removes dirs scoped to the current process.pid.
 */
export async function cleanupOrphanFifos(): Promise<void> {
  if (BACKEND === 'conpty') return;
  const tmpDir = os.tmpdir();
  const prefix = `imcodes-pty-${process.pid}-`;
  try {
    const entries = await fsp.readdir(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const dirPath = path.join(tmpDir, entry);
        await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
