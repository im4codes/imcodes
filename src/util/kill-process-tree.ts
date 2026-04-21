/**
 * killProcessTree — reliable process-tree teardown.
 *
 * Motivation
 * ----------
 * Several SDKs we shell out to (codex, claude, qwen) are shipped as node
 * wrappers that internally fork a native binary (e.g. the musl `codex`
 * app-server). If we only `child.kill('SIGTERM')` the node wrapper, the
 * native grandchild survives and leaks memory indefinitely. Observed in
 * production: 20+ orphaned codex app-server pairs accumulating ~2GB after
 * a few hours of rate-limit probes.
 *
 * Sending to a process group (`process.kill(-pid, ...)`) only works when
 * (a) the parent was spawned with `detached: true`, AND (b) the node
 * wrapper did not detach its own grandchild into a separate session. The
 * second condition is outside our control — some SDK wrappers do detach
 * their native binary, which breaks group-signalling entirely.
 *
 * This helper walks the descendant tree via `ps(1)` at kill time, sends
 * SIGTERM to every pid (leaves first so parents don't immediately fork a
 * replacement), waits `gracefulMs`, and SIGKILLs any survivors. On
 * Windows it delegates to `taskkill /T /F` which handles the tree natively.
 *
 * Safe to call when the pid is already dead — all kernel errors are
 * swallowed. Returns when the terminal SIGKILL sweep has been issued
 * (not when the kernel has finished reaping — that is observable via the
 * original spawn's 'exit' event if the caller needs it).
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function isChildProcess(value: unknown): value is ChildProcess {
  // Note: do NOT require `pid` here. Unit tests use mock children that
  // implement `kill` but not `pid`; we still want to route those through
  // the mock-friendly `child.kill()` path (which hits the descendant-less
  // fallback branch in killProcessTree).
  return !!value
    && typeof value === 'object'
    && 'kill' in value
    && typeof (value as ChildProcess).kill === 'function';
}

/**
 * Collect every descendant pid of `rootPid`. Does NOT include rootPid itself.
 * Returns [] on Windows (taskkill handles the tree natively) or on any
 * execFile failure — the fallback is a best-effort single-process kill in
 * `killProcessTree`, which is still better than leaving nothing alive.
 */
export async function collectDescendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    // `-A` = every process; `-o pid,ppid` = those two columns; no header thanks
    // to `=` trick on macOS/Linux ps. We use plain `-o pid,ppid` since `=`
    // formatting differs across ps implementations; we strip the header row.
    const { stdout } = await execFileP('ps', ['-A', '-o', 'pid,ppid'], { timeout: 5_000 });
    const byParent = new Map<number, number[]>();
    for (const line of stdout.split('\n').slice(1)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const list = byParent.get(ppid);
      if (list) list.push(pid);
      else byParent.set(ppid, [pid]);
    }
    const out: number[] = [];
    const visited = new Set<number>();
    const walk = (pid: number) => {
      if (visited.has(pid)) return; // defensive — ps output shouldn't cycle
      visited.add(pid);
      const kids = byParent.get(pid);
      if (!kids) return;
      for (const kid of kids) {
        out.push(kid);
        walk(kid);
      }
    };
    walk(rootPid);
    return out;
  } catch {
    return [];
  }
}

export interface KillProcessTreeOptions {
  /** Time between SIGTERM sweep and the SIGKILL fallback, in ms. Default 1000. */
  gracefulMs?: number;
}

/**
 * Tree-kill a process and all of its descendants.
 *
 * Accepts either a raw pid or a `ChildProcess` instance. Prefer passing the
 * `ChildProcess` when you have it — that way the wrapper is terminated via
 * `child.kill()` (which unit tests can mock) while descendants are still
 * reaped through `process.kill()` after a `ps` walk.
 *
 * Semantics (POSIX):
 *   1. Walk `ps -A -o pid,ppid` to enumerate descendants.
 *   2. SIGTERM every descendant leaves-first, then the wrapper.
 *   3. Wait `gracefulMs` (default 1000).
 *   4. SIGKILL any pid still alive (probed via `kill(pid, 0)`).
 *
 * On Windows: `taskkill /T /F /pid <rootPid>` — the OS walks the tree.
 *
 * Never throws — all errors are swallowed because they indicate the target
 * is already gone, which is the desired end state.
 */
export async function killProcessTree(
  target: number | ChildProcess | undefined,
  opts?: KillProcessTreeOptions,
): Promise<void> {
  if (target == null) return;
  const child: ChildProcess | null = isChildProcess(target) ? target : null;
  const rootPid: number | undefined = typeof target === 'number'
    ? target
    : child?.pid;
  if (rootPid == null || !Number.isInteger(rootPid) || rootPid <= 0) {
    // No pid means we can't walk `ps` — but if we were given a ChildProcess
    // we can still ask it to terminate via its own `kill()` method. This
    // keeps mock-based tests (where child.pid is undefined) working.
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts?.gracefulMs ?? 1_000);
        timer.unref?.();
      });
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }
    return;
  }
  const gracefulMs = opts?.gracefulMs ?? 1_000;

  if (process.platform === 'win32') {
    try {
      await execFileP('taskkill', ['/pid', String(rootPid), '/T', '/F'], { timeout: 5_000 });
    } catch {
      /* already gone or taskkill unavailable */
    }
    return;
  }

  const descendants = await collectDescendantPids(rootPid);
  const orderedDescendants = [...descendants.reverse()];

  // SIGTERM leaves first so parents don't immediately fork replacements.
  for (const pid of orderedDescendants) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Prefer `child.kill()` for the wrapper so unit tests that mock
  // `node:child_process.spawn` can observe the signal on the mock instance.
  // The underlying kernel effect is identical to `process.kill(pid, SIGTERM)`.
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  } else {
    try { process.kill(rootPid, 'SIGTERM'); } catch { /* already gone */ }
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, gracefulMs);
    timer.unref?.();
  });

  // SIGKILL sweep.
  for (const pid of orderedDescendants) {
    try { process.kill(pid, 0); } catch { continue; } // already reaped
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (child) {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  } else {
    try { process.kill(rootPid, 0); } catch { return; }
    try { process.kill(rootPid, 'SIGKILL'); } catch { /* gone */ }
  }
}
