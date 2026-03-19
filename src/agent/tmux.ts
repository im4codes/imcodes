import { exec as execCb, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Socket as NetSocket } from 'net';
import type { Readable } from 'stream';

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

/** Run a raw tmux command. */
export async function tmuxExec(args: string): Promise<string> {
  const { stdout } = await exec(`tmux ${args}`);
  return stdout.trim();
}

/**
 * Capture the visible content of a tmux pane (scrollback history).
 * Returns lines as a string array.
 */
export async function capturePane(session: string, lines = 50): Promise<string[]> {
  const raw = await tmuxExec(`capture-pane -p -t ${session} -S -${lines}`);
  return raw.split('\n');
}

/**
 * Capture only the currently visible pane with ANSI color codes.
 * Used for terminal streaming — gives exactly the rows the user sees.
 */
export async function capturePaneVisible(session: string): Promise<string> {
  return tmuxExec(`capture-pane -e -p -t ${session}`);
}

/**
 * Capture scrollback history (above the visible area) with ANSI colors.
 * -S -N starts N lines before visible top; -E -1 ends at the line before visible row 0.
 */
export async function capturePaneHistory(session: string, lines = 1000): Promise<string> {
  return tmuxExec(`capture-pane -e -p -t ${session} -S -${lines} -E -1`);
}

/** Send a string of keys to a tmux pane (newline = Enter). */
/**
 * Send text then Enter to a tmux session.
 * For small strings, uses `send-keys -l`.
 * For large strings, uses `load-buffer -` (stdin) + `paste-buffer` to avoid shell/arg limits.
 */
export async function sendKeys(session: string, keys: string): Promise<void> {
  if (keys.length > 8000) {
    // Large string: use unique named tmux buffer to avoid ARG_MAX limits and concurrent overwrites
    const bufferName = `buf_${session}_${Date.now()}`;
    const { spawn } = await import('child_process');
    const proc = spawn('tmux', ['load-buffer', '-b', bufferName, '-']);
    proc.stdin.write(keys);
    proc.stdin.end();
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tmux load-buffer failed with code ${code}`))));
      proc.on('error', reject);
    });
    await tmuxExec(`paste-buffer -p -t ${session} -b ${bufferName}`);
    await tmuxExec(`delete-buffer -b ${bufferName}`).catch(() => {});
  } else {
    const escaped = keys.replace(/'/g, "'\\''");
    await tmuxExec(`send-keys -t ${session} -l -- '${escaped}'`);
  }
  await new Promise<void>((r) => setTimeout(r, 80));
  await tmuxExec(`send-keys -t ${session} Enter`);
}

/** @deprecated Use sendKeys — kept as alias for backward compat. */
export const sendKeysDelayedEnter = sendKeys;

/** Send raw keys without appending Enter (e.g. for Ctrl-C). */
export async function sendKey(session: string, key: string): Promise<void> {
  await tmuxExec(`send-keys -t ${session} ${key}`);
}

export interface NewSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Create a new detached tmux session. Throws if it already exists. */
export async function newSession(name: string, command?: string, opts?: NewSessionOptions): Promise<void> {
  const cwdArg = opts?.cwd ? `-c ${JSON.stringify(opts.cwd)}` : '';
  const envArgs = opts?.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  // Quote the command with single quotes so the outer /bin/sh does NOT interpret
  // shell operators (&&, ||, etc.) — tmux receives the full string and runs it
  // via $SHELL -c internally.
  const cmdArg = command ? `-- '${command.replace(/'/g, "'\\''")}'` : '';
  await tmuxExec(`new-session -d -s ${name} ${cwdArg} ${envArgs} ${cmdArg}`.trim());
}

/** Kill a tmux session by name. Does not throw if it doesn't exist. */
export async function killSession(name: string): Promise<void> {
  try {
    await tmuxExec(`kill-session -t ${name}`);
  } catch {
    // session may not exist
  }
}

/** List all tmux sessions. Returns session names. */
export async function listSessions(): Promise<string[]> {
  try {
    const raw = await tmuxExec(`list-sessions -F '#{session_name}'`);
    return raw.split('\n').filter(Boolean);
  } catch (e: any) {
    // tmux returns 1 if there are no sessions
    const err = String(e.stderr || e.message || '');
    if (err.includes('no sessions') || err.includes('no server running')) return [];
    throw e;
  }
}

/** Check if a tmux session exists. */
export async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(name);
}

/** Resize a tmux session window to the given dimensions. */
export async function resizeSession(name: string, cols: number, rows: number): Promise<void> {
  await tmuxExec(`resize-window -t ${name} -x ${cols} -y ${rows}`);
}

/** Get the pane size (cols x rows) of a tmux session. */
export async function getPaneSize(session: string): Promise<{ cols: number; rows: number }> {
  try {
    const raw = await tmuxExec(`display-message -p -t ${session} '#{pane_width} #{pane_height}'`);
    const [cols, rows] = raw.split(' ').map(Number);
    return { cols: cols || 80, rows: rows || 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

/** Read the tmux paste buffer (used for CC /copy output). */
export async function showBuffer(): Promise<string> {
  return tmuxExec('show-buffer');
}

/** Get the pane ID of the first pane in a tmux session (e.g. "%42"). */
export async function getPaneId(session: string): Promise<string> {
  return tmuxExec(`display-message -p -t ${session} '#{pane_id}'`);
}

/** Get the current working directory of the first pane of a session. */
export async function getPaneCwd(session: string): Promise<string> {
  const raw = await tmuxExec(`display-message -p -t ${session} '#{pane_current_path}'`);
  return raw.trim();
}

/** Get the start command of the first pane of a session. */
export async function getPaneStartCommand(session: string): Promise<string> {
  const raw = await tmuxExec(`display-message -p -t ${session} '#{pane_start_command}'`);
  return raw.trim();
}

/** Delete the tmux paste buffer (clipboard cleanup after CC /copy). */
export async function deleteBuffer(): Promise<void> {
  try {
    await tmuxExec('delete-buffer');
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

/**
 * Send raw terminal input to a tmux session.
 * Maps xterm escape sequences to tmux key names; literal text uses -l flag.
 * Used for keyboard passthrough from the browser terminal.
 */
export async function sendRawInput(session: string, data: string): Promise<void> {
  // Check escape sequence map first
  const tmuxKey = XTERM_KEY_MAP[data];
  if (tmuxKey) {
    await tmuxExec(`send-keys -t ${session} ${tmuxKey}`);
    return;
  }

  // Ctrl+A..Z: \x01..\x1a
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96); // 1→'a', 2→'b', ...
      await tmuxExec(`send-keys -t ${session} C-${letter}`);
      return;
    }
  }

  // Unknown escape sequence — skip
  if (data.startsWith('\x1b')) return;

  // Regular printable text — send literally (no Enter appended)
  const escaped = data.replace(/'/g, "'\\''");
  await tmuxExec(`send-keys -t ${session} -l -- '${escaped}'`);
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
const SESSION_PATTERN = /^deck_([a-z0-9A-Z0-9_]+_(brain|w\d+)|sub_[a-z0-9_]+)$/;

/** Cached pipe-pane capability (tmux >= 2.6 supports -O). */
let pipePaneCapability: boolean | null = null;

/** Fixed path to the pipe-writer helper script. */
const PIPE_WRITER_SCRIPT = path.join(__dirname, '../../scripts/pipe-writer.sh');

/**
 * Check if tmux supports `pipe-pane -O` (requires tmux >= 2.6).
 * Result is cached after first call.
 */
export async function checkPipePaneCapability(): Promise<boolean> {
  if (pipePaneCapability !== null) return pipePaneCapability;
  try {
    const { stdout } = await exec('tmux -V');
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
const activePipes = new Map<string, { paneId: string; fifoPath: string; dir: string; fd: number }>();

/**
 * Start a `tmux pipe-pane -O` raw PTY stream for a session.
 * Uses a PID-scoped FIFO with O_RDWR|O_NONBLOCK to avoid blocking/premature-EOF.
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
  let stream: NetSocket | null = null;

  try {
    // Create FIFO with 0600 permissions
    await execFile('mkfifo', ['-m', '0600', fifoPath]);

    // Open FIFO with O_RDWR|O_NONBLOCK:
    // - O_RDWR: process holds both read and write ends → no blocking on open, and
    //   write-end stays open preventing premature EOF before pipe-pane connects.
    // - O_NONBLOCK: required to avoid the open() syscall itself ever blocking.
    // Do NOT use fs.createReadStream here — it uses thread-pool blocking read() which
    // cannot be interrupted by destroy() when no data is available.
    // Instead, wrap with net.Socket: FIFOs are epoll-pollable on Linux, so net.Socket
    // uses non-blocking I/O multiplexing (handles EAGAIN correctly, destroy() works).
    // Use fs.openSync to get a raw fd (no FileHandle GC issue).
    fd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

    // Wrap fd in a net.Socket (epoll-based, handles EAGAIN → wait, not error)
    stream = new NetSocket({ fd, readable: true, writable: false, allowHalfOpen: true });

    // Build pipe-pane command: fixed helper script + shell-quoted FIFO path
    const cmd = shellQuote(PIPE_WRITER_SCRIPT) + ' ' + shellQuote(fifoPath);

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
          // Stop pipe-pane (suppress errors — pane may be gone)
          await execFile('tmux', ['pipe-pane', '-t', info.paneId]).catch(() => {});
          stream?.destroy();
          await fsp.unlink(info.fifoPath).catch(() => {});
          await fsp.rmdir(info.dir).catch(() => {});
        }
      },
    };

    activePipes.set(session, { paneId, fifoPath, dir, fd });
    return handle;
  } catch (err) {
    // Rollback
    stream?.destroy();
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
