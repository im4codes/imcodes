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
  if (command) baseArgs.push('--', command);

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
  await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', '\n');
}

/** Send a raw key to a WezTerm pane (e.g. ctrl-c). */
export async function weztermSendKey(name: string, key: string): Promise<void> {
  const paneId = requirePaneId(name);
  // WezTerm send-text with --no-paste sends raw bytes
  await weztermRun('send-text', '--pane-id', paneId, '--no-paste', '--', key);
}

/**
 * Capture the content of a WezTerm pane via `wezterm cli get-text`.
 * Returns lines as a string array.
 */
export async function weztermCapturePane(name: string, lines = 50): Promise<string[]> {
  const paneId = requirePaneId(name);
  const raw = await weztermRun('get-text', '--pane-id', paneId);
  const allLines = raw.split('\n');
  // Return last N lines to match tmux capturePane behavior
  return allLines.slice(-lines);
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

/** Capture visible pane content with ANSI escape codes (for terminal streaming). */
export async function weztermCapturePaneVisible(name: string): Promise<string> {
  const paneId = requirePaneId(name);
  try {
    return await weztermRun('get-text', '--pane-id', paneId, '--escapes');
  } catch {
    // --escapes may not be supported in all WezTerm versions, fall back to plain
    return await weztermRun('get-text', '--pane-id', paneId);
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

/**
 * Polling-based terminal stream for WezTerm (no pipe-pane equivalent).
 * Periodically captures visible pane content and emits it as a readable stream.
 */
export function startWeztermPollingStream(name: string): {
  stream: import('stream').Readable;
  cleanup: () => Promise<void>;
} {
  const { Readable } = require('stream') as typeof import('stream');
  const stream = new Readable({ read() {} });
  let stopped = false;
  let lastContent = '';
  const paneId = nameToPane.get(name);

  const poll = async () => {
    while (!stopped && paneId) {
      try {
        let content: string;
        try {
          content = await weztermRun('get-text', '--pane-id', paneId, '--escapes');
        } catch {
          content = await weztermRun('get-text', '--pane-id', paneId);
        }
        if (content !== lastContent) {
          lastContent = content;
          stream.push(content + '\n');
        }
      } catch {
        // pane gone or WezTerm not running
        if (!stopped) stream.push(null);
        return;
      }
      await new Promise<void>((r) => setTimeout(r, 100)); // ~10fps
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
