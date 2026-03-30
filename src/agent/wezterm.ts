/**
 * WezTerm CLI wrapper functions for the terminal backend abstraction.
 *
 * All functions use `execFile('wezterm', ['cli', ...])` — no shell interpolation.
 * Name→pane_id mapping is maintained via a module-level Map and persisted to
 * the session store via `SessionRecord.paneId`.
 *
 * Reconciliation: WezTerm pane validity is verified by the existing health poller
 * (which calls isPaneAlive/sessionExists). No separate reconcile mechanism is needed.
 * On daemon startup, restoreWeztermPane() in tmux.ts rehydrates the name→pane_id map
 * from persisted SessionRecord.paneId values.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';

const execFile = promisify(execFileCb);

// ── Name → pane_id mapping ─────────────────────────────────────────────────────

/** In-memory cache: session name → WezTerm pane_id (numeric string). */
const nameToPane = new Map<string, string>();

/** Register a name→pane_id mapping (called after spawn or during reconcile). */
export function registerPane(name: string, paneId: string): void {
  nameToPane.set(name, paneId);
}

/** Unregister a name→pane_id mapping (called on kill). */
export function unregisterPane(name: string): void {
  nameToPane.delete(name);
}

/** Look up the WezTerm pane_id for a session name. Throws if not found. */
export function requirePaneId(name: string): string {
  const id = nameToPane.get(name);
  if (!id) throw new Error(`WezTerm pane_id not found for session: ${name}`);
  return id;
}

// ── WezTerm CLI wrappers ────────────────────────────────────────────────────────

/** Ensure WezTerm multiplexer is running. Auto-starts if not. */
let weztermServerChecked = false;
async function ensureWeztermServer(): Promise<void> {
  if (weztermServerChecked) return;
  try {
    await execFile('wezterm', ['cli', 'list', '--format', 'json'], { windowsHide: true });
    weztermServerChecked = true;
    return;
  } catch {
    // Not running — start it
  }
  const { spawn: spawnProc } = await import('child_process');
  const child = spawnProc('wezterm', ['start', '--daemonize'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  // Wait up to 10s for multiplexer to become available
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await execFile('wezterm', ['cli', 'list', '--format', 'json'], { windowsHide: true });
      weztermServerChecked = true;
      return;
    } catch { /* not ready yet */ }
  }
  throw new Error('WezTerm multiplexer did not start within 10 seconds');
}

/** Run a wezterm cli command and return trimmed stdout. */
async function weztermRun(...args: string[]): Promise<string> {
  await ensureWeztermServer();
  const { stdout } = await execFile('wezterm', ['cli', ...args], { windowsHide: true });
  return stdout.trim();
}

export interface WeztermNewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Find the first existing WezTerm window_id, or return null if none exist.
 * Used to spawn new tabs inside an existing window instead of creating new windows.
 */
async function findExistingWindowId(): Promise<number | null> {
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ window_id: number }>;
    if (panes.length > 0) return panes[0].window_id;
  } catch { /* no windows */ }
  return null;
}

/**
 * Create a new WezTerm pane via `wezterm cli spawn`.
 * Returns the pane_id (parsed from stdout).
 *
 * Strategy:
 * 1. If an existing window is found, spawn a new tab in it (--window-id).
 * 2. If no window exists, spawn with --new-window to create one.
 *
 * This avoids the "pane-id was not specified and $WEZTERM_PANE is not set"
 * error that occurs when running `wezterm cli spawn` without context.
 */
export async function weztermNewSession(
  name: string,
  command?: string,
  opts?: WeztermNewSessionOptions,
): Promise<string> {
  await ensureWeztermServer();

  const baseArgs: string[] = [];
  if (opts?.cwd) baseArgs.push('--cwd', opts.cwd);

  // On Windows, wezterm cli spawn passes args directly to CreateProcess (no shell).
  // Shell commands (set, cd /d, &&) won't work. Write to a temp .bat file instead.
  let tmpBat: string | null = null;
  if (command && process.platform === 'win32') {
    const batDir = path.join(os.homedir(), '.imcodes', 'tmp');
    fs.mkdirSync(batDir, { recursive: true });
    tmpBat = path.join(batDir, `session-${name}.bat`);
    fs.writeFileSync(tmpBat, `@echo off\r\n${command}\r\n`, 'utf8');
    baseArgs.push('--', tmpBat);
  } else if (command) {
    baseArgs.push('--', command);
  }

  let raw: string;
  const windowId = await findExistingWindowId();
  if (windowId !== null) {
    raw = await weztermRun('spawn', '--window-id', String(windowId), ...baseArgs);
  } else {
    raw = await weztermRun('spawn', '--new-window', ...baseArgs);
  }
  const paneId = raw.trim();
  if (!paneId) {
    throw new Error(`WezTerm spawn returned empty pane_id for session: ${name}`);
  }
  registerPane(name, paneId);
  return paneId;
}

/** Kill a WezTerm pane. No-op if pane doesn't exist. */
export async function weztermKillSession(name: string): Promise<void> {
  const paneId = nameToPane.get(name);
  if (!paneId) return;
  try {
    await weztermRun('kill-pane', '--pane-id', paneId);
  } catch {
    // pane may not exist
  }
  unregisterPane(name);
}

/** Check if a WezTerm pane exists (is in the list output). */
export async function weztermSessionExists(name: string): Promise<boolean> {
  const paneId = nameToPane.get(name);
  if (!paneId) return false;
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ pane_id: number }>;
    return panes.some((p) => String(p.pane_id) === paneId);
  } catch {
    return false;
  }
}

/** List all tracked WezTerm session names. Returns empty if WezTerm is not available. */
export async function weztermListSessions(): Promise<string[]> {
  if (nameToPane.size === 0) return []; // no tracked sessions — skip WezTerm probe
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ pane_id: number }>;
    const livePaneIds = new Set(panes.map((p) => String(p.pane_id)));
    const result: string[] = [];
    for (const [name, paneId] of nameToPane) {
      if (livePaneIds.has(paneId)) result.push(name);
    }
    return result;
  } catch {
    return [];
  }
}

/** Send text literally to a WezTerm pane (no Enter). */
export async function weztermSendText(name: string, text: string): Promise<void> {
  const paneId = requirePaneId(name);
  await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', text);
}

/** Send Enter key to a WezTerm pane. */
export async function weztermSendEnter(name: string): Promise<void> {
  const paneId = requirePaneId(name);
  // Use stdin pipe to send \r — avoids Windows argv mangling of control characters
  const { spawn: spawnProc } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawnProc('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.stdin!.write('\r');
    child.stdin!.end();
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.on('error', reject);
  });
}

// Map tmux key names → escape sequences / raw bytes for WezTerm
const TMUX_KEY_TO_ESCAPE: Record<string, string> = {
  'Enter': '\r',
  'Escape': '\x1b',
  'BSpace': '\x7f',
  'Up': '\x1b[A',
  'Down': '\x1b[B',
  'Right': '\x1b[C',
  'Left': '\x1b[D',
  'Home': '\x1b[H',
  'End': '\x1b[F',
  'DC': '\x1b[3~',    // Delete
  'IC': '\x1b[2~',    // Insert
  'PPage': '\x1b[5~', // Page Up
  'NPage': '\x1b[6~', // Page Down
  'BTab': '\x1b[Z',   // Shift+Tab
  'Tab': '\t',
  'Space': ' ',
  'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
  'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
  'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
};

/** Send a key to a WezTerm pane. Maps tmux key names to escape sequences.
 *  Uses stdin pipe for control characters to avoid Windows argv mangling. */
export async function weztermSendKey(name: string, key: string): Promise<void> {
  const paneId = requirePaneId(name);
  const mapped = TMUX_KEY_TO_ESCAPE[key]
    ?? (key.match(/^C-([a-z])$/) ? String.fromCharCode(key.charCodeAt(2) - 96) : null)
    ?? key;
  // For printable single chars (like '1'), use argv; for control/escape chars, use stdin pipe
  if (mapped.length === 1 && mapped.charCodeAt(0) >= 32 && mapped.charCodeAt(0) < 127) {
    await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', mapped);
  } else {
    await weztermSendViaStdin(paneId, mapped);
  }
}

/** Send raw bytes to a WezTerm pane via stdin pipe (avoids argv control char issues). */
async function weztermSendViaStdin(paneId: string, data: string): Promise<void> {
  const { spawn: spawnProc } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawnProc('wezterm', ['cli', 'send-text', '--pane-id', paneId, '--no-paste'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.stdin!.write(data);
    child.stdin!.end();
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`wezterm send-text exit ${code}`)));
    child.on('error', reject);
  });
}

/**
 * Send raw terminal input to a WezTerm pane.
 * Handles xterm escape sequences, ctrl keys, and regular text.
 * WezTerm's send-text --no-paste accepts raw bytes directly.
 */
export async function weztermSendRawInput(name: string, data: string): Promise<void> {
  const paneId = requirePaneId(name);

  // Ctrl+C rate limiting
  if (data === '\x03') {
    const now = Date.now();
    const key = `ctrlc-${name}`;
    const last = (weztermSendRawInput as any)[key] as number | undefined;
    if (last && now - last < 1500) return; // rate limit
    (weztermSendRawInput as any)[key] = now;
  }

  // Use stdin pipe for all raw input — avoids Windows argv mangling of control chars
  await weztermSendViaStdin(paneId, data);
}

/**
 * Capture the content of a WezTerm pane via `wezterm cli get-text`.
 * Returns lines as a string array.
 */
export async function weztermCapturePane(name: string, lines = 50): Promise<string[]> {
  const paneId = requirePaneId(name);
  // Use --start-line/--end-line to avoid capturing full scrollback (major perf win on Windows)
  try {
    const raw = await weztermRun('get-text', '--pane-id', paneId, '--start-line', '0', '--end-line', String(lines));
    return raw.split('\n');
  } catch {
    // Fallback for older WezTerm without --start-line support
    const raw = await weztermRun('get-text', '--pane-id', paneId);
    return raw.split('\n').slice(-lines);
  }
}

/**
 * Respawn a WezTerm pane by killing the current process and spawning a new one.
 * WezTerm does not have a native respawn — we send the command to the existing pane.
 */
export async function weztermRespawnPane(name: string, command: string): Promise<void> {
  const paneId = requirePaneId(name);
  // Kill current process in the pane, then send the new command
  // Send ctrl-c first, then the new command
  await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', '\x03');
  await new Promise<void>((r) => setTimeout(r, 200));
  await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', command + '\r');
}

/** Get the current working directory of a WezTerm pane. */
export async function weztermGetPaneCwd(name: string): Promise<string> {
  const paneId = requirePaneId(name);
  const raw = await weztermRun('list', '--format', 'json');
  const panes = JSON.parse(raw) as Array<{ pane_id: number; cwd: string }>;
  const pane = panes.find((p) => String(p.pane_id) === paneId);
  return pane?.cwd ?? '';
}

/** Get the WezTerm pane ID for a session name. */
export async function weztermGetPaneId(name: string): Promise<string> {
  return requirePaneId(name);
}

/** Check if a WezTerm pane is still alive. */
export async function weztermIsPaneAlive(name: string): Promise<boolean> {
  const paneId = nameToPane.get(name);
  if (!paneId) return false;
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ pane_id: number; is_active: boolean }>;
    return panes.some((p) => String(p.pane_id) === paneId);
  } catch {
    return false;
  }
}

/** Get the PIDs of processes running in a WezTerm pane. */
export async function weztermGetPanePids(name: string): Promise<string[]> {
  const paneId = nameToPane.get(name);
  if (!paneId) return [];
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ pane_id: number; pid?: number }>;
    const pane = panes.find((p) => String(p.pane_id) === paneId);
    if (pane?.pid) return [String(pane.pid)];
    return [];
  } catch {
    return [];
  }
}

/** Get pane dimensions by session name. Uses cached values when possible. */
export async function weztermGetPaneSize(name: string): Promise<{ cols: number; rows: number }> {
  const paneId = nameToPane.get(name);
  if (!paneId) return { cols: 80, rows: 24 };
  return getPaneDimensions(paneId);
}

/** Capture visible pane content with ANSI escape codes (for terminal streaming).
 *  Uses --start-line/--end-line to avoid capturing scrollback (major perf win on Windows). */
export async function weztermCapturePaneVisible(name: string, rows = 50): Promise<string> {
  const paneId = requirePaneId(name);
  try {
    return await weztermRun('get-text', '--pane-id', paneId, '--escapes', '--start-line', '0', '--end-line', String(rows));
  } catch {
    try {
      return await weztermRun('get-text', '--pane-id', paneId, '--start-line', '0', '--end-line', String(rows));
    } catch {
      return await weztermRun('get-text', '--pane-id', paneId);
    }
  }
}

/** Resize a WezTerm pane to the given dimensions. */
export async function weztermResizePane(name: string, cols: number, rows: number): Promise<void> {
  const paneId = requirePaneId(name);
  try {
    await weztermRun('set-pane-size', '--pane-id', paneId, '--cols', String(cols), '--rows', String(rows));
  } catch {
    // set-pane-size may not be available in older WezTerm — silently skip
  }
}

// Cached pane dimensions: paneId → { cols, rows }
const paneDimCache = new Map<string, { cols: number; rows: number; ts: number }>();
const DIM_CACHE_TTL_MS = 10_000;

async function getPaneDimensions(paneId: string): Promise<{ cols: number; rows: number }> {
  const cached = paneDimCache.get(paneId);
  if (cached && Date.now() - cached.ts < DIM_CACHE_TTL_MS) return cached;
  try {
    const raw = await weztermRun('list', '--format', 'json');
    const panes = JSON.parse(raw) as Array<{ pane_id: number; size?: { cols: number; rows: number }; cols?: number; rows?: number }>;
    const pane = panes.find((p) => String(p.pane_id) === paneId);
    const cols = pane?.size?.cols ?? pane?.cols ?? 80;
    const rows = pane?.size?.rows ?? pane?.rows ?? 24;
    const dim = { cols, rows, ts: Date.now() };
    paneDimCache.set(paneId, dim);
    return dim;
  } catch {
    return { cols: 80, rows: 24 };
  }
}

/**
 * Polling-based terminal stream for WezTerm (no pipe-pane equivalent).
 * Optimizations:
 *  - Uses --start-line 0 --end-line <rows> to skip scrollback (saves 1-3s on Windows)
 *  - No --escapes for polling (plain text is faster; escapes only for snapshots)
 *  - Adaptive polling: 250ms when content is changing, 1000ms when idle
 */
export function startWeztermPollingStream(name: string): {
  stream: import('stream').Readable;
  cleanup: () => Promise<void>;
} {
  const stream = new Readable({ read() {} });
  let stopped = false;
  let lastContent = '';
  const paneId = nameToPane.get(name);
  let idleCount = 0;

  const poll = async () => {
    while (!stopped && paneId) {
      try {
        const dim = await getPaneDimensions(paneId);
        const content = await weztermRun(
          'get-text', '--pane-id', paneId,
          '--start-line', '0', '--end-line', String(dim.rows),
        );
        if (content !== lastContent) {
          lastContent = content;
          idleCount = 0;
          stream.push(content + '\n');
        } else {
          idleCount++;
        }
      } catch {
        if (!stopped) stream.push(null);
        return;
      }
      // Adaptive interval: 250ms when active, ramp up to 1000ms when idle
      const interval = idleCount < 3 ? 250 : idleCount < 10 ? 500 : 1000;
      await new Promise<void>((r) => setTimeout(r, interval));
    }
  };

  void poll();

  return {
    stream,
    cleanup: async () => {
      stopped = true;
      try { stream.push(null); } catch { /* already ended */ }
    },
  };
}
