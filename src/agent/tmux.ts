import { execFile as execFileCb, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';

const execFile = promisify(execFileCb);

/** Ensure tmux server is running. Auto-starts if dead. */
let tmuxServerChecked = false;
async function ensureTmuxServer(): Promise<void> {
  if (tmuxServerChecked) return;
  try {
    await execFile('tmux', ['list-sessions']);
    tmuxServerChecked = true;
  } catch (e: any) {
    const stderr = String(e.stderr || e.message || '');
    if (stderr.includes('no server running') || stderr.includes('No such file or directory') || stderr.includes('error connecting')) {
      // tmux server is dead — start it
      await execFile('tmux', ['new-session', '-d', '-s', 'imcodes_init']);
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
}

/** Run a tmux command with array args (no shell — safe from injection). */
async function tmuxRun(...args: string[]): Promise<string> {
  await ensureTmuxServer();
  const { stdout } = await execFile('tmux', args);
  return stdout.trim();
}

/**
 * Capture the visible content of a tmux pane (scrollback history).
 * Returns lines as a string array.
 */
export async function capturePane(session: string, lines = 50): Promise<string[]> {
  const raw = await tmuxRun('capture-pane', '-p', '-t', session, '-S', `-${lines}`);
  return raw.split('\n');
}

/**
 * Capture only the currently visible pane with ANSI color codes.
 * Used for terminal streaming — gives exactly the rows the user sees.
 */
export async function capturePaneVisible(session: string): Promise<string> {
  return tmuxRun('capture-pane', '-e', '-p', '-t', session);
}

/**
 * Capture scrollback history (above the visible area) with ANSI colors.
 * -S -N starts N lines before visible top; -E -1 ends at the line before visible row 0.
 */
export async function capturePaneHistory(session: string, lines = 1000): Promise<string> {
  return tmuxRun('capture-pane', '-e', '-p', '-t', session, '-S', `-${lines}`, '-E', '-1');
}

/**
 * Get the content of the line where the cursor is currently positioned.
 * Useful for detecting if an agent is at an input prompt (cursor on ">" or "›" line).
 */
export async function getCursorLine(session: string): Promise<string> {
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
 * Send text then Enter to a tmux session.
 *
 * **Default (no cwd)** — for CC and agents that handle bracketed paste:
 * - Short text (≤200, single line): `send-keys -l`
 * - Long text: `load-buffer` + `paste-buffer` (bracketed paste, content sent directly)
 *
 * **With cwd** — for sandboxed agents (Gemini) that can't handle paste-buffer or /tmp:
 * - Write to temp file in project dir, send "read <path>" instruction
 * - 60s auto-cleanup
 *
 * Always sends Enter after text. Long text gets a 3s safety-net Enter.
 */
export async function sendKeys(session: string, keys: string, opts?: SendKeysOptions): Promise<void> {
  const isLong = keys.length > 200 || keys.includes('\n');

  if (isLong) {
    // Write to temp file + send read instruction
    // With cwd: file in project dir (Gemini sandbox), without: /tmp (CC etc.)
    const hash = createHash('md5').update(session + Date.now()).digest('hex').slice(0, 8);
    const fileName = `.imcodes-prompt-${hash}.md`;
    const filePath = opts?.cwd ? path.join(opts.cwd, fileName) : `/tmp/${fileName}`;
    await fsp.writeFile(filePath, keys, { encoding: 'utf-8', mode: 0o600 });
    const instruction = `Read and execute all instructions in @${filePath}`;
    await tmuxRun('send-keys', '-t', session, '-l', '--', instruction);
    setTimeout(() => fsp.unlink(filePath).catch(() => {}), 120_000);
  } else {
    // Short text: simple send-keys (no shell quoting needed with execFile)
    await tmuxRun('send-keys', '-t', session, '-l', '--', keys);
  }

  // Delay before Enter
  const delay = isLong ? 500 : Math.min(80 + Math.floor(keys.length / 10) * 5, 1000);
  await new Promise<void>((r) => setTimeout(r, delay));
  await tmuxRun('send-keys', '-t', session, 'Enter');

  // Safety net: 3s delayed Enter for long text (empty-line Enter is a no-op)
  if (isLong) {
    setTimeout(async () => {
      try { await tmuxRun('send-keys', '-t', session, 'Enter'); } catch { /* ignore */ }
    }, 3_000);
  }
}

const CHUNK_SIZE = 800;
/** Inter-chunk delay (ms). Agents without bracketed paste need time to consume each chunk. */
const CHUNK_DELAY_MS = 50;
/** Inter-line delay (ms). Enter key needs extra settle time for non-bracketed-paste agents. */
const LINE_DELAY_MS = 120;

/** Send large text in chunks via send-keys -l, splitting newlines into separate Enter keys. */
async function sendKeysChunked(session: string, text: string): Promise<void> {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let offset = 0; offset < line.length; offset += CHUNK_SIZE) {
      const chunk = line.slice(offset, offset + CHUNK_SIZE);
      await tmuxRun('send-keys', '-t', session, '-l', '--', chunk);
      if (offset + CHUNK_SIZE < line.length) {
        await new Promise<void>((r) => setTimeout(r, CHUNK_DELAY_MS));
      }
    }
    if (i < lines.length - 1) {
      await tmuxRun('send-keys', '-t', session, 'Enter');
      await new Promise<void>((r) => setTimeout(r, LINE_DELAY_MS));
    }
  }
}

/** @deprecated Use sendKeys — kept as alias for backward compat. */
export const sendKeysDelayedEnter = sendKeys;

/** Send raw keys without appending Enter (e.g. for Ctrl-C). */
export async function sendKey(session: string, key: string): Promise<void> {
  await tmuxRun('send-keys', '-t', session, key);
}

export interface NewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Create a new detached tmux session. Throws if it already exists. */
export async function newSession(name: string, command?: string, opts?: NewSessionOptions): Promise<void> {
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

/** Kill a tmux session by name. Does not throw if it doesn't exist. */
export async function killSession(name: string): Promise<void> {
  try {
    await tmuxRun('kill-session', '-t', name);
  } catch {
    // session may not exist
  }
}

/** List all tmux sessions. Returns session names. */
export async function listSessions(): Promise<string[]> {
  try {
    const raw = await tmuxRun('list-sessions', '-F', '#{session_name}');
    return raw.split('\n').filter(Boolean);
  } catch (e: any) {
    const err = String(e.stderr || e.message || '');
    if (err.includes('no sessions') || err.includes('no server running') || err.includes('No such file or directory') || err.includes('error connecting')) return [];
    throw e;
  }
}

/** Check if a tmux session exists. */
export async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(name);
}

/** Check if the pane process in a tmux session is still alive (not dead from remain-on-exit). */
export async function isPaneAlive(name: string): Promise<boolean> {
  try {
    const raw = await tmuxRun('list-panes', '-t', name, '-F', '#{pane_dead}');
    return raw.trim() === '0';
  } catch {
    return false;
  }
}

/** Respawn a dead pane (remain-on-exit) with a new command. */
export async function respawnPane(name: string, command: string): Promise<void> {
  await tmuxRun('respawn-pane', '-t', name, '-k', command);
}

/** Resize a tmux session window to the given dimensions. */
export async function resizeSession(name: string, cols: number, rows: number): Promise<void> {
  await tmuxRun('resize-window', '-t', name, '-x', String(cols), '-y', String(rows));
}

/** Get the pane size (cols x rows) of a tmux session. */
export async function getPaneSize(session: string): Promise<{ cols: number; rows: number }> {
  try {
    const raw = await tmuxRun('display-message', '-p', '-t', session, '#{pane_width} #{pane_height}');
    const [cols, rows] = raw.split(' ').map(Number);
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

/** Read the tmux paste buffer (used for CC /copy output). */
export async function showBuffer(): Promise<string> {
  return tmuxRun('show-buffer');
}

/** Get the pane ID of the first pane in a tmux session (e.g. "%42"). */
export async function getPaneId(session: string): Promise<string> {
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_id}');
}

/** Get the current working directory of the first pane of a session. */
export async function getPaneCwd(session: string): Promise<string> {
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_current_path}');
}

/** Get the start command of the first pane of a session. */
export async function getPaneStartCommand(session: string): Promise<string> {
  return tmuxRun('display-message', '-p', '-t', session, '#{pane_start_command}');
}

/** Delete the tmux paste buffer (clipboard cleanup after CC /copy). */
export async function deleteBuffer(): Promise<void> {
  try {
    await tmuxRun('delete-buffer');
  } catch {
    // buffer may not exist
  }
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
 * Send raw terminal input to a tmux session.
 * Maps xterm escape sequences to tmux key names; literal text uses -l flag.
 * Used for keyboard passthrough from the browser terminal.
 */
export async function sendRawInput(session: string, data: string): Promise<void> {
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
      if (code === 3 && isCtrlCRateLimited(session)) return;
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

// ── pipe-pane streaming ───────────────────────────────────────────────────────

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
 * Result is cached after first call.
 */
export async function checkPipePaneCapability(): Promise<boolean> {
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
 * Start a `tmux pipe-pane -O` raw PTY stream for a session.
 * Uses a PID-scoped FIFO: O_RDWR on macOS (blocking reads in libuv thread pool),
 * O_RDWR|O_NONBLOCK on Linux (epoll-based non-blocking via net.Socket).
 * Returns a ReadStream and a cleanup function.
 */
export async function startPipePaneStream(session: string, paneId: string): Promise<PipePaneHandle> {
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
    stream = cat.stdout!;
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
    else if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    await execFile('tmux', ['pipe-pane', '-t', paneId]).catch(() => {});
    await fsp.unlink(fifoPath).catch(() => {});
    await fsp.rmdir(dir).catch(() => {});
    throw err;
  }
}

/**
 * Stop an active pipe-pane stream for a session.
 * No-op if no active stream exists.
 */
export async function stopPipePaneStream(session: string): Promise<void> {
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
