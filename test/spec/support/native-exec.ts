// Async twins of the synchronous child-process helpers, for LONG native
// compile/link/run steps in the macOS + common-core spec family.
//
// Why this exists. These suites shell out to `xcrun clang++` and then run the
// resulting sanitizer binaries. Done synchronously, a single call blocks the
// Vitest worker thread for 20-40s on a cold cache. Two things follow, and we
// measured both:
//
//   1. The per-test timeout fires (default 20s) even though the compile would
//      have succeeded, so assertions that never ran are reported as failures.
//   2. Worse, the worker cannot service Vitest's RPC while blocked, so the run
//      emits `[vitest-worker]: Timeout calling "onTaskUpdate"` and the PROCESS
//      EXITS 1 even when every assertion passed. A CI gating on exit code goes
//      red on a green suite.
//
// Raising the timeout alone fixes (1) and not (2): the event loop is still
// starved. These helpers keep the child asynchronous so the worker keeps
// answering RPC, while preserving the exact argv / env / cwd / stdout / stderr
// / exit-status semantics the callers already assert on.

import { execFile } from 'node:child_process';

export interface NativeExecResult {
  /** Exit code, or null when the child was killed by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

export interface NativeExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes. Native builds are chatty under -Werror; default generously. */
  maxBuffer?: number;
  /** Written to the child's stdin, then EOF — the spawnSync `input` option. */
  input?: string;
}

/**
 * Async twin of `spawnSync(file, args, { encoding: 'utf8' })`.
 *
 * Never rejects: a non-zero exit is reported through `status`, exactly as
 * spawnSync does, so existing `expect(result.status).toBe(0)` assertions keep
 * their meaning.
 */
export function runNative(
  file: string,
  args: readonly string[],
  options: NativeExecOptions = {},
): Promise<NativeExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & {
          code?: number | string;
          signal?: NodeJS.Signals;
        }) | null;
        const code = failure && typeof failure.code === 'number' ? failure.code : null;
        resolve({
          status: failure ? code : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          signal: failure?.signal ?? null,
        });
      },
    );
    // spawnSync/execFileSync hand the child an already-EOF stdin. execFile
    // opens a stdin pipe and leaves it OPEN, so any child that reads to EOF
    // (our compiled probe CLIs do) blocks forever and hangs the whole run.
    // Closing it here restores the synchronous semantics exactly.
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

/**
 * Async twin of `execFileSync(file, args, ...)`: resolves with stdout, and
 * REJECTS on a non-zero exit, so callers relying on the throw keep that
 * behaviour. The thrown error carries stdout/stderr like the sync form.
 */
export async function runNativeOrThrow(
  file: string,
  args: readonly string[],
  options: NativeExecOptions = {},
): Promise<string> {
  const result = await runNative(file, args, options);
  if (result.status !== 0) {
    const error = new Error(
      `${file} exited ${result.status ?? `signal ${result.signal}`}\n${result.stdout}\n${result.stderr}`,
    ) as Error & { status: number | null; stdout: string; stderr: string };
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
