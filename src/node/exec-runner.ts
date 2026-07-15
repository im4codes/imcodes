// Controlled-node one-shot command executor. Pure child_process (no node-pty),
// so it packages cleanly into the self-contained exe. Runs a single shell
// command with a hard timeout and captured, byte-capped stdout/stderr.
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  REMOTE_EXEC_MAX_CHUNK_BYTES,
  type RemoteExecRequest,
  type RemoteExecResult,
  type RemoteExecOutputChunk,
  type RemoteExecShell,
} from '../../shared/remote-exec.js';

/**
 * Node-side minimum timeout (matches the spec lower bound on every supported
 * platform). The shared wire validator also enforces 1..MAX at the trust
 * boundary; this constant is the local safety floor so an out-of-band caller
 * (tests, future seam) cannot starve the timer.
 */
export const MIN_TIMEOUT_MS = REMOTE_EXEC_MIN_TIMEOUT_MS;

/** OS default shell: powershell on Windows (the remote-assist target), sh elsewhere. */
export function defaultRemoteExecShell(platform: NodeJS.Platform = process.platform): RemoteExecShell {
  return platform === 'win32' ? 'powershell' : 'sh';
}

/**
 * Every controlled-node command speaks UTF-8 on the relay wire. Keep the
 * child environment deterministic too, including tools that choose their
 * stdio encoding from locale variables instead of the parent shell.
 */
export function utf8ExecEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    // Python on Windows otherwise follows the active ANSI code page even
    // when its parent shell has switched the console to code page 65001.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

const WINDOWS_UTF8_PREAMBLE = '$OutputEncoding=[System.Text.Encoding]::UTF8; '
  + '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; '
  + '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
const CMD_COMMAND_ENV = 'IMCODES_REMOTE_EXEC_COMMAND';

interface ShellInvocation {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Resolve the executable + argv for a one-shot command in the requested shell. */
export function shellInvocation(shell: RemoteExecShell, command: string): ShellInvocation {
  switch (shell) {
    case 'powershell':
      // Windows consoles default to an OEM/ANSI code page (for example GBK).
      // Set every PowerShell/native-process console encoding surface before
      // the caller's untouched command runs.
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `${WINDOWS_UTF8_PREAMBLE} ${command}`,
        ],
      };
    case 'cmd':
      // cmd.exe parses its /c argument using the inherited OEM code page
      // before an inline `chcp 65001` can run, so non-ASCII command text is
      // already corrupted by then. Carry the untouched Unicode command in the
      // environment, establish UTF-8 in a small ASCII-only PowerShell launcher,
      // and only then create the real cmd.exe process. The caller still gets
      // cmd syntax, streams, and exit status without any encoding boilerplate.
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `${WINDOWS_UTF8_PREAMBLE} & cmd.exe /d /s /c $env:${CMD_COMMAND_ENV}; exit $LASTEXITCODE`,
        ],
        env: { [CMD_COMMAND_ENV]: command },
      };
    case 'bash':
      return { file: 'bash', args: ['-lc', command] };
    case 'sh':
    default:
      return { file: 'sh', args: ['-c', command] };
  }
}

function clampTimeout(ms: number | undefined): number {
  const requested = typeof ms === 'number' && Number.isFinite(ms) ? ms : REMOTE_EXEC_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(MIN_TIMEOUT_MS, requested), REMOTE_EXEC_MAX_TIMEOUT_MS);
}

/**
 * Run one command locally and resolve a RemoteExecResult. Never rejects — a
 * spawn failure or timeout is reported as `ok: false` with an `error`, so the
 * relay always has a well-formed result to return to the caller.
 *
 * Signal close semantics:
 *   - POSIX: kill the whole process group (negative pid) since the child was
 *     spawned `detached: true`.
 *   - Windows: `child.kill()` calls `TerminateProcess` on a single PID — it
 *     does NOT walk the process tree, so a `child.exe` that itself spawns
 *     powershell.exe would leak. We use `taskkill /F /T /PID <pid>` which
 *     walks the Job tree and is the supported way to tear down the whole
 *     graph. If `taskkill` is not on PATH (extremely unusual), we fall back
 *     to `child.kill('SIGKILL')` which is best-effort.
 */
function emitOutputChunks(
  text: string,
  stream: RemoteExecOutputChunk['stream'],
  nextSeq: () => number,
  onChunk?: (chunk: RemoteExecOutputChunk) => void,
): void {
  if (!text || !onChunk) return;
  let chars: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (chars.length === 0) return;
    try { onChunk({ seq: nextSeq(), stream, chunk: chars.join('') }); } catch { /* progress is best-effort */ }
    chars = [];
    bytes = 0;
  };
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes > 0 && bytes + charBytes > REMOTE_EXEC_MAX_CHUNK_BYTES) flush();
    chars.push(char);
    bytes += charBytes;
  }
  flush();
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let chars = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    chars += char.length;
  }
  return text.slice(0, chars);
}

export function runRemoteExec(
  req: RemoteExecRequest,
  opts: { signal?: AbortSignal; onChunk?: (chunk: RemoteExecOutputChunk) => void } = {},
): Promise<RemoteExecResult> {
  const startedAt = Date.now();
  const shell = req.shell ?? defaultRemoteExecShell();
  if (req.timeoutMs !== undefined
    && (!Number.isInteger(req.timeoutMs) || req.timeoutMs < REMOTE_EXEC_MIN_TIMEOUT_MS || req.timeoutMs > REMOTE_EXEC_MAX_TIMEOUT_MS)) {
    return Promise.resolve({
      requestId: req.requestId,
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      error: 'invalid timeoutMs',
    });
  }
  const timeoutMs = clampTimeout(req.timeoutMs);
  const { file, args, env: invocationEnv } = shellInvocation(shell, req.command);

  return new Promise<RemoteExecResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let chunkSeq = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const appendDecoded = (decoded: string, isErr: boolean): void => {
      if (!decoded) return;
      const used = isErr ? errBytes : outBytes;
      const room = REMOTE_EXEC_MAX_OUTPUT_BYTES - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const text = takeUtf8Prefix(decoded, room);
      if (text.length < decoded.length) truncated = true;
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (isErr) {
        stderr += text;
        errBytes += textBytes;
      } else {
        stdout += text;
        outBytes += textBytes;
      }
      emitOutputChunks(text, isErr ? 'stderr' : 'stdout', () => chunkSeq++, opts.onChunk);
    };

    const capture = (chunk: Buffer, isErr: boolean): void => {
      // StringDecoder preserves UTF-8 code points split across child-process
      // `data` events. The byte cap is applied to decoded output, so neither a
      // split code point nor an invalid byte sequence can inflate the result
      // beyond the shared stdout/stderr boundary.
      appendDecoded((isErr ? stderrDecoder : stdoutDecoder).write(chunk), isErr);
    };

    // On unix, run the command as its own process-group leader (detached) so a
    // timeout can kill the WHOLE tree. Killing only the shell leaves children
    // (e.g. `sleep`) alive holding the stdout pipe open, which delays 'close'
    // until the grandchild exits — so the timeout would not actually free the
    // slot. Killing the negative pid (the group) tears the tree down at once.
    //
    // On Windows there is no process group, so we cannot use negative pid. We
    // rely on the Job object that Node's libuv creates when stdio is piped;
    // `taskkill /F /T` walks that Job and kills every process attached to it.
    const isWin = process.platform === 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: req.cwd,
        env: { ...utf8ExecEnvironment(), ...invocationEnv },
        windowsHide: true,
        detached: !isWin,
      });
    } catch (err) {
      resolve({
        requestId: req.requestId,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        error: `spawn failed: ${(err as Error).message}`,
      });
      return;
    }

    const killTree = (): void => {
      if (isWin) {
        if (typeof child.pid === 'number') {
          try {
            execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
            return;
          } catch {
            // taskkill not on PATH or the Job is already gone — fall through.
          }
        }
      } else if (typeof child.pid === 'number') {
        // Negative pid → the whole process group (see detached spawn above).
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
      }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timer.unref?.();

    // Abort (e.g. the controlled node's WS dropped) → kill the whole tree.
    const onAbort = (): void => { aborted = true; killTree(); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Flush a final partial sequence. Valid UTF-8 is preserved; malformed or
      // incomplete trailing bytes become the standard replacement character
      // instead of disappearing silently from the terminal result.
      appendDecoded(stdoutDecoder.end(), false);
      appendDecoded(stderrDecoder.end(), true);
      const error = spawnError ?? (aborted ? 'aborted' : (timedOut ? `timed out after ${timeoutMs}ms` : undefined));
      // Windows taskkill can report a numeric close code even though the
      // command was forcibly terminated. Failed result frames require a null
      // exitCode; otherwise the server rejects the frame and the caller waits
      // until the relay deadline instead of receiving node_timeout promptly.
      const reportedExitCode = error ? null : exitCode;
      resolve({
        requestId: req.requestId,
        ok: !error,
        exitCode: reportedExitCode,
        stdout,
        stderr,
        ...(truncated ? { truncated: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };

    child.stdout?.on('data', (d: Buffer) => capture(d, false));
    child.stderr?.on('data', (d: Buffer) => capture(d, true));
    child.on('error', (e: Error) => finish(null, `spawn error: ${e.message}`));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal && !timedOut && !aborted ? `process terminated by signal ${signal}` : undefined);
    });
  });
}
