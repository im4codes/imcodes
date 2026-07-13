// Controlled-node one-shot command executor. Pure child_process (no node-pty),
// so it packages cleanly into the self-contained exe. Runs a single shell
// command with a hard timeout and captured, byte-capped stdout/stderr.
import { execFileSync, spawn } from 'node:child_process';
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  type RemoteExecRequest,
  type RemoteExecResult,
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

/** Resolve the executable + argv for a one-shot command in the requested shell. */
export function shellInvocation(shell: RemoteExecShell, command: string): { file: string; args: string[] } {
  switch (shell) {
    case 'powershell':
      // Force UTF-8 for captured (piped) output: Windows consoles default to the
      // OEM/ANSI codepage (e.g. gb2312), which mojibakes non-ASCII over the relay.
      // Setting $OutputEncoding + [Console]::OutputEncoding at the top makes all
      // subsequent output UTF-8 so the daemon captures it cleanly.
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
        ],
      };
    case 'cmd':
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
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
export function runRemoteExec(req: RemoteExecRequest, opts: { signal?: AbortSignal } = {}): Promise<RemoteExecResult> {
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
  const { file, args } = shellInvocation(shell, req.command);

  return new Promise<RemoteExecResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;

    const capture = (chunk: Buffer, isErr: boolean): void => {
      const used = isErr ? errBytes : outBytes;
      const room = REMOTE_EXEC_MAX_OUTPUT_BYTES - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (chunk.length > room) truncated = true;
      let text = slice.toString('utf8');
      // A cap can split a multi-byte code point; Buffer decoding would insert
      // U+FFFD (three encoded bytes) and make the returned payload exceed the
      // byte cap. Drop only that incomplete trailing character.
      while (Buffer.byteLength(text, 'utf8') > slice.length) text = text.slice(0, -1);
      if (isErr) {
        stderr += text;
        errBytes += slice.length;
      } else {
        stdout += text;
        outBytes += slice.length;
      }
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
      child = spawn(file, args, { cwd: req.cwd, windowsHide: true, detached: !isWin });
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
      const error = spawnError ?? (aborted ? 'aborted' : (timedOut ? `timed out after ${timeoutMs}ms` : undefined));
      resolve({
        requestId: req.requestId,
        ok: !error,
        exitCode,
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
