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

/** Run a wezterm cli command and return trimmed stdout. */
async function weztermRun(...args: string[]): Promise<string> {
  const { stdout } = await execFile('wezterm', ['cli', ...args], { windowsHide: true });
  return stdout.trim();
}

export interface WeztermNewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Create a new WezTerm pane via `wezterm cli spawn`.
 * Returns the pane_id (parsed from stdout).
 */
export async function weztermNewSession(
  name: string,
  command?: string,
  opts?: WeztermNewSessionOptions,
): Promise<string> {
  const args: string[] = ['spawn'];
  if (opts?.cwd) args.push('--cwd', opts.cwd);
  if (command) args.push('--', command);
  // wezterm cli spawn prints the pane_id to stdout
  const raw = await weztermRun(...args);
  const paneId = raw.trim();
  registerPane(name, paneId);

  // Set environment variables on the pane via send-text if needed.
  // WezTerm CLI spawn does not support -e flag for env vars natively,
  // so we prepend env exports to the command or handle them externally.
  // For now, env vars are baked into the command string by the caller.
  // TODO: If WezTerm adds --env support, use it here.

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
