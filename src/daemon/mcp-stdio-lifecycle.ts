/**
 * Parent-loss and EOF shutdown for stdio MCP servers.
 *
 * Production incident: eighteen `imcodes memory mcp` children were found with
 * PPID=1, the oldest alive for more than three days.
 *
 * Two mechanisms were measured on the authorized Linux host before this module
 * was written, because the obvious explanation turned out to be wrong:
 *
 *  - A clean stdin EOF ALREADY terminates the server. The CPU sampler is
 *    `unref`'d and the resource registry only writes files, so once stdin ends
 *    the loop drains and the process exits on its own. Adding an EOF handler
 *    alone would therefore have fixed nothing.
 *  - The orphans are the OTHER shape: the parent dies while some other process
 *    still holds the write end of the child's stdin, so EOF never arrives and
 *    the loop never drains. Reproduced directly: kill the parent shell of
 *    `sleep 300 | mcp-server` and the server outlives it indefinitely.
 *
 * So the load-bearing guard here is parent liveness, not EOF. EOF is still
 * wired because relying on "the loop happens to drain" is an accident of the
 * current handle set — one future `setInterval` without `unref` would silently
 * restore the leak.
 *
 * Liveness is decided by comparing against the parent observed AT STARTUP, not
 * against a constant such as PID 1. A launcher that legitimately runs as init
 * would make a `ppid === 1` test fire immediately, trading a leak for an
 * outage; only a CHANGE proves the original parent is gone.
 */

/**
 * The parent observed at module evaluation, before any awaited startup work.
 *
 * DO NOT move this read later. Reparenting destroys PPID: if the owner dies
 * while the server is still awaiting its store load or resource registration,
 * a snapshot taken after those awaits already reads the reparent target, and
 * every later poll reads the same value -- so the guard can never fire and the
 * leak returns exactly as reported. Module evaluation is the earliest point
 * this module controls, and it precedes all of that work.
 *
 * The residual window -- an owner that dies between spawn and this line -- is
 * not closable from inside the child, because a process legitimately launched
 * by an init-like parent is indistinguishable from a reparented one by PPID
 * alone. `expectedParentPid` closes it for any spawner that can declare its
 * own identity.
 */
export const MCP_PROCESS_START_PARENT_PID = process.ppid;

/**
 * Env var through which a spawner declares its own pid to this server.
 *
 * Defined here, beside the guard that consumes it, so the launch side and the
 * check side cannot drift apart. R2 shipped the check with no producer at all:
 * the mechanism existed, no real launch ever set it, and it protected nothing.
 */
export const IMCODES_MCP_PARENT_PID_ENV = 'IMCODES_MCP_PARENT_PID';

/** Minimal surface of the stream this module listens on, so tests can fake it. */
export interface McpStdioLifecycleStream {
  on(event: 'end' | 'close', listener: () => void): unknown;
  off?(event: 'end' | 'close', listener: () => void): unknown;
}

export interface McpStdioLifecycleOptions {
  stdin: McpStdioLifecycleStream;
  /** Idempotent teardown. Invoked at most once by this module. */
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  /** Current parent pid; injectable so tests do not have to fork. */
  getParentPid: () => number;
  /** Parent observed at startup. A change means the original parent exited. */
  initialParentPid: number;
  /**
   * Parent identity declared by the spawner, when it can supply one.
   *
   * Checked once at install: a mismatch proves this process was already
   * reparented before it ever looked, which PPID alone cannot show. Absent,
   * the snapshot above is the only authority -- deliberately, because exiting
   * on a bare `ppid === 1` would kill a server whose launcher really is init.
   */
  expectedParentPid?: number;
  /** Called once the guard is armed, so a caller can report it. */
  onArmed?: (parentPid: number) => void;
  /** Bounded poll period. Defaults to 30s: a leaked process wastes a machine
   *  for days, so detection latency is irrelevant next to the cost of polling. */
  parentPollMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (handle: unknown) => void;
}

export const DEFAULT_MCP_PARENT_POLL_MS = 30_000;

/**
 * Wire EOF and parent-loss shutdown. Returns a disposer that removes the
 * listeners and stops the poll without running shutdown, for callers that tear
 * down on their own terms.
 */
export function installMcpStdioLifecycle(options: McpStdioLifecycleOptions): () => void {
  const pollMs = Math.max(1, Math.trunc(options.parentPollMs ?? DEFAULT_MCP_PARENT_POLL_MS));
  const setIntervalFn = options.setIntervalFn
    ?? ((handler, ms) => setInterval(handler, ms) as unknown as { unref?: () => void });
  const clearIntervalFn = options.clearIntervalFn
    ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let timer: { unref?: () => void } | null = null;
  let triggered = false;

  const stop = () => {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    options.stdin.off?.('end', onEnd);
    options.stdin.off?.('close', onClose);
  };

  // `shutdown` is documented idempotent, but this module must not depend on
  // that: EOF and a parent-loss tick can land in the same turn of the loop.
  const trigger = () => {
    if (triggered) return;
    triggered = true;
    stop();
    void options.shutdown()
      .catch(() => { /* teardown is best-effort; exiting still matters */ })
      .finally(() => options.exit(0));
  };

  function onEnd(): void { trigger(); }
  function onClose(): void { trigger(); }

  options.stdin.on('end', onEnd);
  options.stdin.on('close', onClose);

  timer = setIntervalFn(() => {
    if (options.getParentPid() !== options.initialParentPid) trigger();
  }, pollMs);
  // Never let the guard itself be the reason the process stays alive.
  timer.unref?.();

  options.onArmed?.(options.initialParentPid);

  // A declared parent that is not the observed one means this process was
  // reparented before it could take its own snapshot. Polling would compare
  // the post-reparent value against itself forever, so decide it here instead.
  if (options.expectedParentPid !== undefined
    && options.getParentPid() !== options.expectedParentPid) {
    trigger();
  }

  return stop;
}

/**
 * One teardown, however many triggers arrive.
 *
 * EOF, a parent-loss tick and a signal can all land in the same turn of the
 * loop, and `clearInterval` does not cancel a callback that is already queued.
 * Memoising both halves is what keeps a second arrival from releasing the
 * resource twice or racing a second `close()`.
 */
export function createIdempotentShutdown(parts: {
  release: () => Promise<void>;
  close: () => Promise<void> | void;
}): { release: () => Promise<void>; shutdown: () => Promise<void> } {
  let released: Promise<void> | null = null;
  let closed: Promise<void> | null = null;
  const release = (): Promise<void> => {
    released ??= parts.release();
    return released;
  };
  // Teardown is total: it always attempts the close and never rejects. A
  // failing release must not strand the transport, and a `close()` that throws
  // SYNCHRONOUSLY must not escape — `Promise.resolve(fn())` cannot catch that,
  // because the throw happens before the wrapping.
  const shutdown = async (): Promise<void> => {
    try { await release(); } catch { /* release is best-effort during teardown */ }
    closed ??= (async () => { try { await parts.close(); } catch { /* best-effort */ } })();
    await closed;
  };
  return { release, shutdown };
}
