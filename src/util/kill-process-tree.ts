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
  /**
   * The target leads its own POSIX process group and session, because whoever
   * spawned it passed `detached: true`.
   *
   * This is asserted by the creator of the group and is NEVER inferred. It is
   * what lets teardown reach a descendant whose parent already died: a
   * reparented process loses its PPID (it becomes 1) but keeps its PGID, and
   * the parentage walk below can only see PPID.
   */
  ownsProcessGroup?: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * How many live processes are in process group `pgid`.
 *
 * Only `pgid` is read, because that is the one field every POSIX `ps` agrees
 * on. An earlier version of this also required `sid === pgid` as a second
 * factor; macOS `ps` has no `sid` keyword at all and reports `sess` as 0 for
 * every process, so that check could never succeed there and would have
 * silently disabled group reaping on the platform the daemon itself runs on.
 */
async function groupMemberCount(pgid: number): Promise<number> {
  if (process.platform === 'win32') return 0;
  try {
    const { stdout } = await execFileP('ps', ['-A', '-o', 'pid,pgid'], { timeout: 5_000 });
    let members = 0;
    for (const line of stdout.split('\n').slice(1)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      if (Number(match[2]) === pgid) members += 1;
    }
    return members;
  } catch {
    return 0;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* group already empty */
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onDone);
      child.off('exit', onDone);
      resolve(exited);
    };
    const onDone = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    // BOTH events, and 'exit' is the one that matters. 'close' fires only once
    // every stdio pipe has been flushed and released, and those pipes can be
    // held open by exactly the descendants this teardown is about to SIGKILL —
    // an inherited stdout keeps the parent's 'close' pending long after the
    // leader is gone. Waiting for 'close' alone therefore burns the whole grace
    // window on a process that already died, delaying the escalation that would
    // free those pipes in the first place. A leader that has exited is finished
    // as far as teardown is concerned.
    child.once('close', onDone);
    child.once('exit', onDone);
  });
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
    if (child) {
      const exitedPromise = waitForChildExit(child, opts?.gracefulMs ?? 1_000);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const exited = await exitedPromise;
      if (!exited) {
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

  // A group signal is the only thing that reaches a descendant whose parent
  // already exited: the parentage walk below reads PPID, and reparenting is
  // exactly the event that destroys PPID. Signal the group FIRST, so the whole
  // group is already terminating before any parent gets the chance to exit and
  // scatter its children to init.
  //
  // Once the leader is gone its pid could in principle have been recycled, so
  // the group is only signalled while it still holds a member reporting
  // `pgid === sid === rootPid`. While the leader is alive its pid cannot be
  // recycled at all — Node holds the child until it reaps it — so that case
  // needs no proof.
  // Honoured only when we hold the ChildProcess handle. A bare pid carries no
  // proof of anything: the caller cannot know the slot was not recycled, and
  // group-signalling a stranger is exactly the failure mode this must not
  // introduce. With the handle, Node owns the wait, so an unreaped child's pid
  // is provably still ours.
  // SNAPSHOT BEFORE ANY SIGNAL.
  //
  // This ordering is load-bearing and was wrong in an earlier revision. A
  // descendant that created its OWN session or process group is not a member
  // of our group, so the group signal never reaches it. And the moment the
  // wrapper exits it reparents to init, which erases the PPID link `ps` walks.
  // Signalling first therefore destroyed the only identity that could still
  // find such a grandchild — the very case this module's header warns about,
  // where an SDK wrapper detaches its own native child.
  //
  // The instant before the first signal is the one moment both identities
  // coexist, so the snapshot is taken there. The group sweep is retained
  // afterwards because it still covers same-group descendants, including any
  // forked after this snapshot.
  const descendants = await collectDescendantPids(rootPid);
  const orderedDescendants = [...descendants].reverse();

  const ownsGroup = opts?.ownsProcessGroup === true && child != null;
  let groupProven = false;
  if (ownsGroup) {
    const leaderAlive = child
      ? (child.exitCode == null && child.signalCode == null)
      : pidAlive(rootPid);
    if (leaderAlive) {
      // Node has not reaped the child, so the kernel cannot hand its pid to
      // anyone else. The group id is provably still ours.
      groupProven = true;
    } else if (!pidAlive(rootPid)) {
      // The leader is gone AND its pid slot is free. A process group can only
      // carry id G if the process whose pid is G once led it, and joining an
      // existing group requires being in that group's session. With no live
      // process holding pid rootPid, nothing unrelated can be leading group
      // rootPid, so whatever remains in it descends from our leader.
      groupProven = (await groupMemberCount(rootPid)) > 0;
    }
    // Remaining case: the pid was recycled by a live unrelated process. Refuse
    // the group signal outright rather than guess.
    if (groupProven) signalGroup(rootPid, 'SIGTERM');
  }

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

  // Deliberately NOT unref'd, so the escalation window holds the runtime open
  // until the SIGKILL sweep below has run.
  //
  // Honest scope: this is hardening, not a demonstrated fix. Mutation testing
  // in an isolated subprocess and on Linux 211 both showed the escalation still
  // completing with the timer unref'd, because the `ps` children spawned above
  // keep the loop alive across the window. A bare multi-case script was once
  // observed exiting with node code 13 on an unsettled await here, so the
  // failure mode is real but shape-dependent and was not reproduced.
  await new Promise<void>((resolve) => { setTimeout(resolve, gracefulMs); });

  // SIGKILL sweep. The group goes first for the same reason as above, and it
  // also covers anything forked AFTER the snapshot was taken, which the
  // descendant list structurally cannot.
  if (groupProven) signalGroup(rootPid, 'SIGKILL');
  for (const pid of orderedDescendants) {
    if (!pidAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // `child.killed` only means "kill() was called successfully", not "the
  // process exited". Probe the pid instead so TERM-ignoring SDK wrappers don't
  // leave the runtime permanently busy.
  if (pidAlive(rootPid)) {
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    } else {
      try { process.kill(rootPid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}
