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

import { dirname, join } from 'path';

import logger from '../util/logger.js';
import { terminalStageTrace } from '../util/terminal-stage-trace.js';
import { TMUX_KEY_TO_ESCAPE } from './key-map.js';
import { SESSION_RESOURCE_OWNER_ENV } from '../../shared/session-resource-lifecycle.js';
import { execFileOffMain as execFile } from '../util/exec-helper.js';
import { getWindowsEnvValue, mergeWindowsEnv } from './transport-paths.js';
import {
  materializeWindowsExecutableForConpty,
  resolveWindowsExecutableForConpty,
  resolveWindowsTargetForConpty,
  type ResolvedWinTargetPlan,
  type ResolvedWindowsTarget,
  type WinExecutableCommand,
  type WinLaunchSpec,
} from './win-launch.js';

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
  killedByCaller?: boolean;
  cols: number;                      // cached from spawn/resize
  rows: number;                      // cached from spawn/resize
  cwd: string;                       // cached from spawn (no runtime CWD query available)
  sessionInstanceId?: string;        // resource owner tuple injected at spawn
  runtimeEpoch?: string;
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
 * Build the environment for Windows PTY spawn.
 * Ensures Node and npm global bin directories are on PATH so that
 * npm-installed .cmd shims (claude, codex, etc.) resolve correctly.
 */
function buildWindowsEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env = mergeWindowsEnv(process.env, extraEnv);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[pathKey] ?? '';
  const entries = current.split(';').filter(Boolean);

  const nodeDir = dirname(process.execPath);
  if (nodeDir && !entries.some((entry) => entry.toLowerCase() === nodeDir.toLowerCase())) {
    entries.unshift(nodeDir);
  }

  const appData = getWindowsEnvValue(env, 'APPDATA');
  const npmBin = appData ? join(appData, 'npm') : '';
  if (npmBin && !entries.some((entry) => entry.toLowerCase() === npmBin.toLowerCase())) {
    // Append global npm bin AFTER explicit PATH/Path entries so caller overrides win.
    entries.push(npmBin);
  }

  env[pathKey] = entries.join(';');
  return env;
}

export function resolveConptySpawnEnv(extraEnv?: Record<string, string>): Record<string, string> {
  return (process.platform === 'win32' || process.env.IMCODES_MUX === 'conpty')
    ? buildWindowsEnv(extraEnv)
    : mergeWindowsEnv(process.env, extraEnv);
}

export function preflightConptyWinLaunch(
  winLaunch: WinLaunchSpec | undefined,
  env?: Record<string, string>,
): ResolvedWinTargetPlan | undefined {
  if (!winLaunch) return undefined;
  const winPlatform = (process.platform === 'win32' || process.env.IMCODES_MUX === 'conpty')
    ? 'win32'
    : process.platform;
  const spawnEnv = resolveConptySpawnEnv(env);
  const primary = resolveWindowsTargetForConpty(winLaunch.primary, spawnEnv, winPlatform);
  const fallback = winLaunch.fallback
    ? resolveWindowsTargetForConpty(winLaunch.fallback, spawnEnv, winPlatform)
    : undefined;
  return { primary, ...(fallback ? { fallback } : {}) };
}

function spawnConptyCommand(
  spawn: NodePtyModule['spawn'],
  cmd: string,
  cmdExe: string,
  cwd: string,
  spawnEnv: Record<string, string>,
  cols: number,
  rows: number,
  winCmd?: WinExecutableCommand,
  preparedTarget?: ResolvedWindowsTarget,
): IPty {
  if (winCmd) {
    const winPlatform = (process.platform === 'win32' || process.env.IMCODES_MUX === 'conpty')
      ? 'win32'
      : process.platform;
    const resolved = preparedTarget
      ? materializeWindowsExecutableForConpty(winCmd, preparedTarget, winPlatform)
      : resolveWindowsExecutableForConpty(winCmd, spawnEnv, winPlatform);
    if (resolved.kind === 'direct') {
      return spawn(resolved.file, resolved.args, {
        cwd,
        env: spawnEnv,
        cols,
        rows,
        useConpty: true,
      });
    }
    return spawn(cmdExe, ['/d', '/s', '/c', resolved.commandLine], {
      cwd,
      env: spawnEnv,
      cols,
      rows,
      useConpty: true,
    });
  }
  return spawn(cmdExe, ['/c', cmd], {
    cwd,
    env: spawnEnv,
    cols,
    rows,
    useConpty: true,
  });
}

function attachConptyListeners(
  session: ConptySession,
  name: string,
  pty: IPty,
  respawnFallback?: () => IPty,
): void {
  pty.onData((data: string) => {
    if (session.pty !== pty) return;
    terminalStageTrace('conpty_read', name);
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
    if (session.pty !== pty) return;
    if (!session.killedByCaller && exitCode !== 0 && respawnFallback) {
      try {
        const fallbackPty = respawnFallback();
        session.pty = fallbackPty;
        attachConptyListeners(session, name, fallbackPty);
        return;
      } catch (err) {
        logger.debug({ name, err: err instanceof Error ? err.message : String(err) }, 'conpty fallback spawn failed');
      }
    }
    session.exited = true;
    session.exitCode = exitCode;
    logger.debug({ name, exitCode }, 'conpty session exited');
  });
}

/**
 * Spawn a new ConPTY session via node-pty.
 * When `winLaunch` is present, resolves native binaries and npm `.cmd` shims to
 * direct argv spawn so `cmd.exe /c` never parses or expands user model values.
 */
export async function conptyNewSession(
  name: string,
  cmd: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    winLaunch?: WinLaunchSpec;
    preparedWinTargets?: ResolvedWinTargetPlan;
  },
): Promise<void> {
  const { spawn } = await getNodePty();

  const cols = opts?.cols ?? 200;
  const rows = opts?.rows ?? 50;
  // Normalize cwd: backslashes → forward slashes. node-pty on some versions calls
  // path.resolve() internally which can fail with error 267 (ERROR_DIRECTORY) when
  // passed Windows-style backslash paths.
  const rawCwd = opts?.cwd ?? process.cwd();
  const cwd = process.platform === 'win32' ? rawCwd.replace(/\\/g, '/') : rawCwd;

  const spawnEnv = resolveConptySpawnEnv(opts?.env);

  // Use absolute path to cmd.exe — when the daemon is launched via a Windows
  // Scheduled Task or Startup shortcut the environment may be restricted and
  // CreateProcess cannot resolve a bare 'cmd.exe' through PATH.
  const cmdExe = process.platform === 'win32'
    ? (getWindowsEnvValue(spawnEnv, 'COMSPEC') ?? `${getWindowsEnvValue(spawnEnv, 'SystemRoot') ?? 'C:\\Windows'}\\system32\\cmd.exe`)
    : 'cmd.exe';

  // Strip redundant cwdPrefix from the command string.
  // Drivers prepend `cd /d "C:\path" && ` or `cd "path" && ` for tmux/wezterm,
  // but ConPTY sets cwd via pty.spawn({ cwd }) — the cd prefix is redundant.
  let cleanCmd = cmd;
  const cdMatch = cleanCmd.match(/^cd\s+(?:\/d\s+)?(?:"[^"]*"|[^\s&]+)\s*&&\s*/i);
  if (cdMatch) {
    cleanCmd = cleanCmd.slice(cdMatch[0].length);
  }

  const fallbackSpec = opts?.winLaunch?.fallback;

  const pty = spawnConptyCommand(
    spawn,
    cleanCmd,
    cmdExe,
    cwd,
    spawnEnv,
    cols,
    rows,
    opts?.winLaunch?.primary,
    opts?.preparedWinTargets?.primary,
  );

  const session: ConptySession = {
    pty,
    ringBuffer: [],
    rawBuffer: '',
    screenBuffer: '',
    onDataCallbacks: new Set(),
    exited: false,
    exitCode: null,
    killedByCaller: false,
    cols,
    rows,
    cwd,
    sessionInstanceId: opts?.env?.[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID],
    runtimeEpoch: opts?.env?.[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH],
  };

  attachConptyListeners(
    session,
    name,
    pty,
    fallbackSpec
      ? () => spawnConptyCommand(spawn, cleanCmd, cmdExe, cwd, spawnEnv, cols, rows, fallbackSpec, opts?.preparedWinTargets?.fallback)
      : undefined,
  );

  sessions.set(name, session);
  logger.debug({ name, pid: pty.pid, cols, rows, cwd }, 'conpty session spawned');
}

/**
 * Kill a ConPTY session, terminating the entire process tree on Windows.
 * No-op if the session does not exist.
 */
export async function conptyKillSession(name: string): Promise<void> {
  const session = sessions.get(name);
  if (!session) return;
  session.killedByCaller = true;

  // Kill the entire process tree without blocking the daemon event loop. The
  // old execSync taskkill could stall heartbeats/control for several seconds.
  if (process.platform === 'win32') {
    try {
      await execFile('taskkill.exe', ['/F', '/T', '/PID', String(session.pty.pid)], {
        windowsHide: true,
        timeout: 2_000,
      });
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
  if (session.exited) return;  // pty already exited — resize would throw
  try {
    session.pty.resize(cols, rows);
  } catch (err) {
    // node-pty throws "Cannot resize a pty that has already exited" if the
    // exit event hasn't propagated yet.  Swallow it instead of letting it
    // become an uncaught exception that takes the daemon down.
    logger.debug({ name, err: err instanceof Error ? err.message : String(err) }, 'conptyResize: ignored error on dead pty');
    session.exited = true;
    return;
  }
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

/** Return the owner tuple injected into a live ConPTY pane, if present. */
export function conptyGetSessionResourceIdentity(name: string): {
  paneId: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
} | null | undefined {
  const session = sessions.get(name);
  if (!session || session.exited) return undefined;
  if (!session.sessionInstanceId || !session.runtimeEpoch) return null;
  return {
    paneId: String(session.pty.pid),
    sessionInstanceId: session.sessionInstanceId,
    runtimeEpoch: session.runtimeEpoch,
  };
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
export async function conptyRespawnPane(
  name: string,
  cmd: string,
  opts?: { env?: Record<string, string>; winLaunch?: WinLaunchSpec; preparedWinTargets?: ResolvedWinTargetPlan },
): Promise<void> {
  const preparedWinTargets = opts?.preparedWinTargets ?? preflightConptyWinLaunch(opts?.winLaunch, opts?.env);
  const session = sessions.get(name);
  const oldCwd = session?.cwd;

  // Kill existing (also removes from map)
  await conptyKillSession(name);

  // Spawn new session with same name, preserved CWD, and injected env vars
  await conptyNewSession(name, cmd, {
    cwd: oldCwd,
    env: opts?.env,
    winLaunch: opts?.winLaunch,
    ...(preparedWinTargets ? { preparedWinTargets } : {}),
  });
  logger.debug({ name, cmd }, 'conpty session respawned');
}
