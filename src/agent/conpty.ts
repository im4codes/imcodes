/**
 * ConPTY session manager — Windows backend using node-pty.
 *
 * This module is only imported when BACKEND === 'conpty' (Windows).
 * It is self-contained and does NOT import from tmux.ts.
 *
 * Architecture:
 *   Agent → ConPTY (node-pty) → onData callback → ring buffer + subscribers
 *   Subscribers are wrapped in Readable streams by tmux.ts for terminal streaming.
 */

import { execSync } from 'child_process';

import logger from '../util/logger.js';
import { TMUX_KEY_TO_ESCAPE } from './key-map.js';

// ── node-pty type shim (package installed at runtime, not in devDependencies) ───

/** Minimal IPty interface matching node-pty's actual shape. */
interface IPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
}

/** Minimal node-pty module shape. */
interface NodePtyModule {
  spawn(file: string, args: string[], options: {
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    useConpty?: boolean;
  }): IPty;
}

// ── node-pty lazy loader ────────────────────────────────────────────────────────

let nodePty: NodePtyModule | null = null;

async function getNodePty(): Promise<NodePtyModule> {
  if (!nodePty) {
    // Use a variable to prevent TypeScript from resolving the module at compile time.
    // node-pty is a runtime dependency (installed on Windows only).
    const moduleName = 'node-pty';
    nodePty = await import(moduleName) as unknown as NodePtyModule;
  }
  return nodePty;
}

// ── Command parser ──────────────────────────────────────────────────────────────

/** Parse a command string into binary + args, handling quoted strings. */
function parseCommand(cmd: string): { file: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"') { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return { file: tokens[0] ?? cmd, args: tokens.slice(1) };
}

// ── Session state ───────────────────────────────────────────────────────────────

const MAX_LINES = 500;

/** Max bytes to keep in the raw screen buffer for snapshot/capturePaneVisible. */
const MAX_SCREEN_BUFFER = 64 * 1024; // 64KB

interface ConptySession {
  pty: IPty;
  ringBuffer: string[];              // last MAX_LINES lines for capturePane
  rawBuffer: string;                 // partial line accumulator
  screenBuffer: string;              // recent raw output (with ANSI) for snapshot
  onDataCallbacks: Set<(data: string) => void>;
  exited: boolean;                   // set true on onExit (NOT based on exitCode)
  exitCode: number | null;
  cols: number;                      // cached from spawn/resize
  rows: number;                      // cached from spawn/resize
  cwd: string;                       // cached from spawn (no runtime CWD query available)
}

const sessions = new Map<string, ConptySession>();

// ── Ring buffer helper ──────────────────────────────────────────────────────────

/**
 * Feed incoming data into the session's ring buffer.
 * Complete lines (ending with \n) are pushed to ringBuffer.
 * Partial lines accumulate in rawBuffer.
 */
function feedRingBuffer(session: ConptySession, data: string): void {
  session.rawBuffer += data;
  const parts = session.rawBuffer.split('\n');
  // Last element is the incomplete partial line (may be empty string)
  session.rawBuffer = parts.pop() ?? '';
  for (const line of parts) {
    session.ringBuffer.push(line);
    // Cap at MAX_LINES
    if (session.ringBuffer.length > MAX_LINES) {
      session.ringBuffer.shift();
    }
  }
}

// ── Exported functions ──────────────────────────────────────────────────────────

/**
 * Spawn a new ConPTY session via node-pty.
 * Wraps `cmd` in `cmd.exe /c <cmd>` so driver command strings are interpreted correctly.
 */
export async function conptyNewSession(
  name: string,
  cmd: string,
  opts?: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number },
): Promise<void> {
  const { spawn } = await getNodePty();

  const cols = opts?.cols ?? 200;
  const rows = opts?.rows ?? 50;
  // Normalize cwd: forward slashes → backslashes on Windows (node-pty's CreateProcess requires native paths)
  const rawCwd = opts?.cwd ?? process.cwd();
  const cwd = process.platform === 'win32' ? rawCwd.replace(/\//g, '\\') : rawCwd;

  // Strip redundant cwdPrefix from the command string.
  // Drivers prepend `cd /d "C:\path" && ` or `cd "path" && ` for tmux/wezterm,
  // but ConPTY sets cwd via pty.spawn({ cwd }) — the cd prefix is redundant
  // and causes double-escaping issues under cmd.exe /c.
  let cleanCmd = cmd;
  const cdMatch = cleanCmd.match(/^cd\s+(?:\/d\s+)?(?:"[^"]*"|[^\s&]+)\s*&&\s*/i);
  if (cdMatch) {
    cleanCmd = cleanCmd.slice(cdMatch[0].length);
  }

  // Parse command into binary + args. Spawn directly (no cmd.exe /c wrapper)
  // to avoid double echo: cmd.exe's ENABLE_ECHO_INPUT + child shell's own echo.
  // Fall back to cmd.exe /c only for commands containing shell operators (&&, |, >).
  const needsShell = /[&|><^]/.test(cleanCmd);
  const { file, args } = needsShell
    ? { file: 'cmd.exe', args: ['/c', cleanCmd] }
    : parseCommand(cleanCmd);

  const pty = spawn(file, args, {
    cwd,
    env: { ...process.env, ...opts?.env } as Record<string, string>,
    cols,
    rows,
    useConpty: true,
  });

  const session: ConptySession = {
    pty,
    ringBuffer: [],
    rawBuffer: '',
    screenBuffer: '',
    onDataCallbacks: new Set(),
    exited: false,
    exitCode: null,
    cols,
    rows,
    cwd,
  };

  pty.onData((data: string) => {
    feedRingBuffer(session, data);
    // Keep recent raw output for snapshot (capturePaneVisible)
    session.screenBuffer += data;
    if (session.screenBuffer.length > MAX_SCREEN_BUFFER) {
      session.screenBuffer = session.screenBuffer.slice(-MAX_SCREEN_BUFFER);
    }
    for (const cb of session.onDataCallbacks) {
      try { cb(data); } catch { /* don't let subscriber errors crash the session */ }
    }
  });

  pty.onExit(({ exitCode }: { exitCode: number }) => {
    session.exited = true;
    session.exitCode = exitCode;
    logger.debug({ name, exitCode }, 'conpty session exited');
  });

  sessions.set(name, session);
  logger.debug({ name, pid: pty.pid, cols, rows, cwd }, 'conpty session spawned');
}

/**
 * Kill a ConPTY session, terminating the entire process tree on Windows.
 * No-op if the session does not exist.
 */
export function conptyKillSession(name: string): void {
  const session = sessions.get(name);
  if (!session) return;

  // Kill entire process tree on Windows before pty.kill()
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${session.pty.pid}`, { stdio: 'ignore' });
    } catch {
      // Process may already be dead — ignore
    }
  }

  try {
    session.pty.kill();
  } catch {
    // Already dead — ignore
  }

  sessions.delete(name);
  logger.debug({ name }, 'conpty session killed');
}

/** Check if a ConPTY session exists in the in-memory map. */
export function conptySessionExists(name: string): boolean {
  return sessions.has(name);
}

/** List all tracked ConPTY session names. */
export function conptyListSessions(): string[] {
  return [...sessions.keys()];
}

/** Send text literally to a ConPTY session (no Enter). */
export function conptySendText(name: string, text: string): void {
  const session = sessions.get(name);
  if (!session) return;
  session.pty.write(text);
}

/** Send Enter (carriage return) to a ConPTY session. */
export function conptySendEnter(name: string): void {
  const session = sessions.get(name);
  if (!session) return;
  session.pty.write('\r');
}

/**
 * Send a key (by tmux key name) to a ConPTY session.
 * Looks up the key in the shared TMUX_KEY_TO_ESCAPE map;
 * falls back to writing the key string directly if not found.
 */
export function conptySendKey(name: string, key: string): void {
  const session = sessions.get(name);
  if (!session) return;
  const escape = TMUX_KEY_TO_ESCAPE[key];
  if (escape) {
    session.pty.write(escape);
  } else {
    const ctrlMatch = key.match(/^C-([a-z])$/);
    if (ctrlMatch) {
      session.pty.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
    } else {
      session.pty.write(key);
    }
  }
}

/**
 * Get the raw screen buffer (recent PTY output with ANSI codes).
 * Used by capturePaneVisible for snapshot delivery.
 * Returns empty string if session not found.
 */
export function conptyGetScreenBuffer(name: string): string {
  const session = sessions.get(name);
  if (!session) return '';
  return session.screenBuffer;
}

/**
 * Clear and reset the screen buffer (e.g. after resize).
 */
export function conptyClearScreenBuffer(name: string): void {
  const session = sessions.get(name);
  if (session) session.screenBuffer = '';
}

/**
 * Capture the last N lines from the ring buffer.
 * Returns empty array if session not found.
 */
export function conptyCapturePane(name: string, lines?: number): string[] {
  const session = sessions.get(name);
  if (!session) return [];
  return session.ringBuffer.slice(-(lines ?? 50));
}

/**
 * Subscribe to raw PTY output for a ConPTY session.
 * Returns an unsubscribe function.
 */
export function conptySubscribe(name: string, callback: (data: string) => void): () => void {
  const session = sessions.get(name);
  if (!session) return () => {};
  session.onDataCallbacks.add(callback);
  return () => session.onDataCallbacks.delete(callback);
}

/**
 * Resize a ConPTY session's PTY dimensions.
 * Updates the cached cols/rows for conptyGetPaneSize().
 */
export function conptyResize(name: string, cols: number, rows: number): void {
  const session = sessions.get(name);
  if (!session) return;
  session.pty.resize(cols, rows);
  session.cols = cols;
  session.rows = rows;
}

/**
 * Get the cached PTY dimensions (from last spawn or resize).
 * Returns default 200x50 if session not found.
 */
export function conptyGetPaneSize(name: string): { cols: number; rows: number } {
  const session = sessions.get(name);
  if (!session) return { cols: 200, rows: 50 };
  return { cols: session.cols, rows: session.rows };
}

/**
 * Get the PID of the node-pty process for a session.
 * Throws if session not found.
 */
export function conptyGetPid(name: string): number {
  const session = sessions.get(name);
  if (!session) throw new Error(`ConPTY session not found: ${name}`);
  return session.pty.pid;
}

/**
 * Check if a ConPTY session's PTY process is still alive.
 * Returns false if the session does not exist.
 */
export function conptyIsPaneAlive(name: string): boolean {
  const session = sessions.get(name);
  if (!session) return false;
  return !session.exited;
}

/**
 * Get the cached spawn CWD for a ConPTY session.
 * NOTE: node-pty has no runtime getCwd() — this returns the initial spawn CWD only.
 * SessionRecord.projectDir is the authoritative source for the project directory.
 */
export function conptyGetPaneCwd(name: string): string {
  const session = sessions.get(name);
  if (!session) return '';
  return session.cwd;
}

/**
 * Get the PIDs of processes running in a ConPTY session.
 * Returns a single-element array with the PTY PID (no full tree enumeration).
 */
export function conptyGetPanePids(name: string): string[] {
  const session = sessions.get(name);
  if (!session) return [];
  return [String(session.pty.pid)];
}

/**
 * Respawn a ConPTY session: kill the existing PTY and spawn a new one
 * with the same session name and the original CWD.
 *
 * This is a backend-only operation — stream subscribers are NOT preserved.
 * terminal-streamer's handlePipeClose() → scheduleRebind() handles re-attachment.
 */
export async function conptyRespawnPane(name: string, cmd: string): Promise<void> {
  const session = sessions.get(name);
  const oldCwd = session?.cwd;

  // Kill existing (also removes from map)
  conptyKillSession(name);

  // Spawn new session with same name and preserved CWD
  await conptyNewSession(name, cmd, { cwd: oldCwd });
  logger.debug({ name, cmd }, 'conpty session respawned');
}
