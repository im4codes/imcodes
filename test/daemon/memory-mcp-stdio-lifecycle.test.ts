/**
 * Subprocess lifecycle coverage for the memory MCP stdio server.
 *
 * Production incident: eighteen `imcodes memory mcp` children with PPID=1, the
 * oldest alive more than three days.
 *
 * The obvious explanation was measured and REJECTED before these tests were
 * written. A clean stdin EOF already terminates the server today — the CPU
 * sampler is `unref`'d and the resource registry only writes files, so the loop
 * drains and the process exits by itself. An EOF handler alone would have fixed
 * nothing.
 *
 * The leaked shape is the other one: the parent dies while a different process
 * still holds the write end of the child's stdin, so EOF never arrives and the
 * loop never drains. `spawnOrphanedByParentLoss` reproduces exactly that, and
 * it is the test that fails without the parent-liveness guard.
 *
 * Real subprocesses with an isolated HOME, so this exercises OS-level pipe and
 * reparenting behaviour and never touches the developer's `~/.imcodes`.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../src/agent/providers/getDefaultMcpServers.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdempotentShutdown, installMcpStdioLifecycle } from '../../src/daemon/mcp-stdio-lifecycle.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const isWin = process.platform === 'win32';
const describeOrSkip = isWin ? describe.skip : describe;

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'lifecycle-test', version: '0' },
  },
})}\n`;

/**
 * The exact script real MCP launches run, reused here so this test cannot pass
 * against a production chain that has stopped declaring its parent.
 */
function productionLaunchScript(): string {
  const script = IMCODES_MEMORY_MCP_LAUNCH_ARGS[1] ?? '';
  expect(IMCODES_MEMORY_MCP_LAUNCH_COMMAND, 'this repro assumes the POSIX wrapper').toBe('sh');
  expect(script, 'single-quoting it below would break otherwise').not.toContain("'");
  return script;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
    child.once('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });
}

/** Resolves once the server has answered on stdout, i.e. it is connected and idling. */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.includes('"jsonrpc"')) { clearTimeout(timer); resolve(true); }
    });
    child.once('exit', () => { clearTimeout(timer); resolve(false); });
  });
}

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), 'imcodes-mcp-life-'));
}

function mcpArgs(): string[] {
  return ['--import', 'tsx', join(repoRoot, 'src/index.ts'), 'memory', 'mcp'];
}

function childEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    IMCODES_HOME: home,
    ...extra,
  };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describeOrSkip('memory MCP stdio lifecycle (subprocess)', () => {
  it('exits when its parent dies even though stdin never reaches EOF', async () => {
    // The production shape. `sleep` keeps the write end of the server's stdin
    // open, so killing the shell orphans the server WITHOUT an EOF. Before the
    // parent-liveness guard this process survived indefinitely; that is the
    // defect the incident found eighteen times over.
    const home = isolatedHome();
    const pidFile = join(home, 'server.pid');
    // `$!` after a pipeline is the LAST member — the server. Writing it from
    // inside the shell is exact; scraping `pgrep -f` is not, because the `sh -c`
    // wrapper carries the same string on its own command line and a stale
    // process from an earlier run matches too. An earlier draft did exactly
    // that and "failed" for a reason unrelated to the code under test.
    const outFile = join(home, 'server.out');
    // Feed one real initialize, then hold the pipe open with `sleep`. The
    // response in `outFile` is proof the server is CONNECTED, which matters:
    // the pid file appears the instant the shell forks, and killing the parent
    // before the guard is installed captures an already-reparented ppid that
    // can never change again. An earlier draft did exactly that and failed for
    // a reason that had nothing to do with the fix.
    const script = `{ printf '%s\\n' ${JSON.stringify(INITIALIZE.trim())}; sleep 300; } | `
      + `${JSON.stringify(process.execPath)} `
      + `${mcpArgs().map((a) => JSON.stringify(a)).join(' ')} >${JSON.stringify(outFile)} 2>&1 & `
      + `echo $! > ${JSON.stringify(pidFile)}; wait`;
    const holderAndServer = spawn('sh', ['-c', script], {
      cwd: repoRoot,
      env: childEnv(home, { IMCODES_MCP_PARENT_POLL_MS: '500' }),
      stdio: 'ignore',
    });
    let serverPid = 0;
    let holderPid = 0;
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && serverPid === 0) {
        try {
          const raw = Number(readFileSync(pidFile, 'utf8').trim());
          if (Number.isFinite(raw) && raw > 0 && pidAlive(raw)) serverPid = raw;
        } catch { /* the shell has not written it yet */ }
        if (serverPid === 0) await new Promise((r) => { const t = setTimeout(r, 250); t.unref?.(); });
      }
      expect(serverPid, 'the orphan repro must actually start a server').toBeGreaterThan(0);

      const connected = await (async () => {
        const stop = Date.now() + 60_000;
        while (Date.now() < stop) {
          try {
            if (readFileSync(outFile, 'utf8').includes('"jsonrpc"')) return true;
          } catch { /* not written yet */ }
          await new Promise((r) => { const t = setTimeout(r, 250); t.unref?.(); });
        }
        return false;
      })();
      expect(connected, 'the guard must be installed before the parent is killed').toBe(true);

      // Kill ONLY the parent shell — NOT the process group. Killing the group
      // would take the `sleep` with it, close the pipe, deliver a clean EOF and
      // let the server exit for the wrong reason, which is exactly how an
      // earlier draft of this test passed against the unfixed build.
      if (holderAndServer.pid) process.kill(holderAndServer.pid, 'SIGKILL');

      const gone = await new Promise<boolean>((resolve) => {
        const stop = Date.now() + 45_000;
        const tick = () => {
          if (!pidAlive(serverPid)) { resolve(true); return; }
          if (Date.now() > stop) { resolve(false); return; }
          const t = setTimeout(tick, 250); t.unref?.();
        };
        tick();
      });
      expect(gone, 'a server whose parent died must not outlive it, EOF or no EOF').toBe(true);
    } finally {
      for (const pid of [serverPid, holderPid]) {
        if (pid > 0 && pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 120_000);

  it('exits when it was already reparented before it ever ran, stdin still held', async () => {
    // The shape PPID alone cannot see. If the owner dies between spawn and the
    // child's first instruction, the child's own snapshot is ALREADY the
    // reparent target, so every later poll compares that value against itself
    // and the guard can never fire -- no matter how early the snapshot is
    // taken. A spawner that declares its identity closes it: a declared parent
    // that is not the observed one is proof of reparenting.
    //
    // A FIFO rather than a pipeline, so `$$` really is this server's parent:
    // in `a | b &` the members are forked by an intermediate subshell, and
    // declaring the wrong pid would make this test pass for a false reason.
    const home = isolatedHome();
    const pidFile = join(home, 'server.pid');
    const outFile = join(home, 'server.out');
    const fifo = join(home, 'stdin.fifo');
    const script = `mkfifo ${JSON.stringify(fifo)}; `
      + `{ printf '%s\\n' ${JSON.stringify(INITIALIZE.trim())}; sleep 300; } > ${JSON.stringify(fifo)} & `
      // The PRODUCTION launch script, verbatim -- not a hand-written stand-in.
      // R2's mechanism was only ever fed by a test writing the variable
      // itself, which is exactly why it protected nothing real.
      + `sh -c '${productionLaunchScript()}' ${JSON.stringify(process.execPath)} `
      + `${mcpArgs().map((a) => JSON.stringify(a)).join(' ')} `
      + `< ${JSON.stringify(fifo)} > ${JSON.stringify(outFile)} 2>&1 & `
      + `echo $! > ${JSON.stringify(pidFile)}; wait`;
    const owner = spawn('sh', ['-c', script], {
      cwd: repoRoot,
      env: childEnv(home, { IMCODES_MCP_PARENT_POLL_MS: '250' }),
      stdio: 'ignore',
    });
    let serverPid = 0;
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && serverPid === 0) {
        try {
          const raw = Number(readFileSync(pidFile, 'utf8').trim());
          if (Number.isFinite(raw) && raw > 0) serverPid = raw;
        } catch { /* not written yet */ }
        if (serverPid === 0) await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
      }
      expect(serverPid, 'the repro must actually start a server').toBeGreaterThan(0);

      // Freeze the server before it can run, so "already reparented before it
      // ever looked" is a PROVEN state rather than a won race. Racing the kill
      // would sometimes reparent after the snapshot and pass through the
      // ordinary PPID-change branch, testing the wrong mechanism.
      process.kill(serverPid, 'SIGSTOP');
      expect(
        (() => { try { return readFileSync(outFile, 'utf8'); } catch { return ''; } })(),
        'the guard must not have armed yet, or this is the startup-window test again',
      ).not.toContain('parent liveness guard armed');

      // `sleep` holds the FIFO's write end, so no EOF is ever delivered.
      if (owner.pid) process.kill(owner.pid, 'SIGKILL');
      // Reparenting has now completed while the server was frozen. Only a
      // declared parent identity can reveal it: its own first observation of
      // process.ppid will already be the reparent target.
      process.kill(serverPid, 'SIGCONT');

      // Two different failures used to share one 45s deadline: "the guard never
      // armed" and "it armed and the process still would not go". Under CI load
      // the server can simply be slow to reach the guard, and the run then
      // reported a leak it had no evidence for. Waiting for the guard first
      // separates them, and each says which one happened.
      const armed = await waitFor(
        () => { try { return readFileSync(outFile, 'utf8').includes('parent liveness guard armed'); } catch { return false; } },
        60_000,
      );
      expect(armed, 'the guard never armed, so nothing about leaking was tested').toBe(true);

      const gone = await waitFor(() => !pidAlive(serverPid), 20_000);
      expect(gone, 'a process born already reparented must not become the leak').toBe(true);
    } finally {
      if (serverPid > 0 && pidAlive(serverPid)) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 120_000);

  it('exits when its parent dies BEFORE the server is ready, stdin still held', async () => {
    // The hole this rework closes. The test above waits for the initialize
    // response before killing the parent, so it only ever proved the
    // ready-state shape. If the owner dies during `loadStore()` /
    // `registerMcpProcessResource()`, this process is reparented first: a
    // snapshot taken after those awaits reads the reparent target, every later
    // poll reads the same value, and the guard can never fire. The gate here is
    // the armed line on stderr -- emitted before any awaited startup work, and
    // strictly earlier than any JSON-RPC response.
    const home = isolatedHome();
    const pidFile = join(home, 'server.pid');
    const outFile = join(home, 'server.out');
    // Pre-readiness is guaranteed BY CONSTRUCTION. `sleep` holds the write end
    // of the pipe open but never sends `initialize`, so this server cannot
    // answer anything, ever. An earlier draft instead asserted the same
    // property after gating on the armed line, and claimed in a comment that
    // the store load was "slow enough" to keep the process pre-ready. It was
    // not: the armed line is only observable by polling a file, by which time
    // the server had already answered, and the test failed under audit. A
    // property that has to be raced is not a property.
    const script = `sleep 300 | `
      + `${JSON.stringify(process.execPath)} `
      + `${mcpArgs().map((a) => JSON.stringify(a)).join(' ')} >${JSON.stringify(outFile)} 2>&1 & `
      + `echo $! > ${JSON.stringify(pidFile)}; wait`;
    const holderAndServer = spawn('sh', ['-c', script], {
      cwd: repoRoot,
      env: childEnv(home, { IMCODES_MCP_PARENT_POLL_MS: '250' }),
      stdio: 'ignore',
    });
    let serverPid = 0;
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && serverPid === 0) {
        try {
          const raw = Number(readFileSync(pidFile, 'utf8').trim());
          if (Number.isFinite(raw) && raw > 0 && pidAlive(raw)) serverPid = raw;
        } catch { /* the shell has not written it yet */ }
        if (serverPid === 0) await new Promise((r) => { const t = setTimeout(r, 100); t.unref?.(); });
      }
      expect(serverPid, 'the repro must actually start a server').toBeGreaterThan(0);

      // Armed, but NOT ready: this is the window the leak lived in.
      const armed = await (async () => {
        const stop = Date.now() + 60_000;
        while (Date.now() < stop) {
          try {
            if (readFileSync(outFile, 'utf8').includes('parent liveness guard armed')) return true;
          } catch { /* not written yet */ }
          await new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); });
        }
        return false;
      })();
      expect(armed, 'the guard must arm before any awaited startup work').toBe(true);

      expect(
        readFileSync(outFile, 'utf8').includes('"jsonrpc"'),
        'nothing was ever sent, so readiness is impossible; this cannot degenerate into the ready-state test',
      ).toBe(false);

      // Kill ONLY the parent shell. `sleep` survives and keeps the write end of
      // stdin open, so no EOF is delivered and parent liveness is the only
      // thing that can end this process.
      if (holderAndServer.pid) process.kill(holderAndServer.pid, 'SIGKILL');
      // Reparenting has now happened while the server was frozen mid-startup.
      process.kill(serverPid, 'SIGCONT');

      const gone = await new Promise<boolean>((resolve) => {
        const stop = Date.now() + 45_000;
        const tick = () => {
          if (!pidAlive(serverPid)) { resolve(true); return; }
          if (Date.now() > stop) { resolve(false); return; }
          const t = setTimeout(tick, 250); t.unref?.();
        };
        tick();
      });
      expect(gone, 'a parent that dies during startup must still not leak this process').toBe(true);
    } finally {
      if (serverPid > 0 && pidAlive(serverPid)) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 120_000);

  it('still exits on a clean stdin EOF', async () => {
    const home = isolatedHome();
    const child = spawn(process.execPath, mcpArgs(), {
      cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(home),
    });
    try {
      child.stdin?.write(INITIALIZE);
      expect(await waitForReady(child, 60_000)).toBe(true);
      child.stdin?.end();
      expect(await waitForExit(child, 15_000), 'EOF must still terminate the server').not.toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 90_000);

  it('keeps running while its parent is alive and stdin is open', async () => {
    // The counterweight: an over-eager guard would trade a leak for an outage.
    const home = isolatedHome();
    const child = spawn(process.execPath, mcpArgs(), {
      cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(home, { IMCODES_MCP_PARENT_POLL_MS: '250' }),
    });
    try {
      child.stdin?.write(INITIALIZE);
      expect(await waitForReady(child, 60_000)).toBe(true);
      expect(
        await waitForExit(child, 4_000),
        'the guard must not fire while the original parent is still alive',
      ).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }, 90_000);
});

/** Poll a condition to a deadline, so slow and stuck stay distinguishable. */
async function waitFor(ready: () => boolean, budgetMs: number): Promise<boolean> {
  const stop = Date.now() + budgetMs;
  while (Date.now() < stop) {
    if (ready()) return true;
    await new Promise((resolve) => { const t = setTimeout(resolve, 250); t.unref?.(); });
  }
  return ready();
}

describe('installMcpStdioLifecycle', () => {
  function fakeStdin() {
    const listeners = new Map<string, Array<() => void>>();
    return {
      on(event: 'end' | 'close', listener: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      off(event: 'end' | 'close', listener: () => void) {
        listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
        return this;
      },
      emit(event: 'end' | 'close') { for (const l of [...(listeners.get(event) ?? [])]) l(); },
      count(event: 'end' | 'close') { return (listeners.get(event) ?? []).length; },
    };
  }

  it('shuts down on stdin EOF alone, with no parent change and no tick', async () => {
    // Without this, deleting the EOF wiring changes no test outcome: the
    // process happens to exit anyway because the loop drains. That accident is
    // one un-unref'd timer away from disappearing, so the wiring is asserted
    // directly rather than left to luck.
    const stdin = fakeStdin();
    let shutdowns = 0;
    let exits = 0;
    installMcpStdioLifecycle({
      stdin,
      shutdown: async () => { shutdowns += 1; },
      exit: () => { exits += 1; },
      getParentPid: () => 42,
      initialParentPid: 42,
      setIntervalFn: () => ({}),
    });
    stdin.emit('end');
    await new Promise((r) => { const t = setTimeout(r, 0); t.unref?.(); });
    expect(shutdowns, 'EOF alone must tear the server down').toBe(1);
    expect(exits).toBe(1);
  });

  it('ignores a poll callback that was already queued when the guard stopped', async () => {
    // `clearInterval` does not cancel a callback that is already queued, so the
    // once-only guard — not listener removal — is what prevents a second
    // teardown. The fake therefore keeps the tick callable after clear.
    const stdin = fakeStdin();
    let shutdowns = 0;
    let tick: (() => void) | null = null;
    let ppid = 100;
    installMcpStdioLifecycle({
      stdin,
      shutdown: async () => { shutdowns += 1; },
      exit: () => {},
      getParentPid: () => ppid,
      initialParentPid: 100,
      setIntervalFn: (handler) => { tick = handler; return {}; },
      clearIntervalFn: () => { /* a queued callback survives clearInterval */ },
    });
    ppid = 1;
    stdin.emit('end');
    tick?.();
    tick?.();
    await new Promise((r) => { const t = setTimeout(r, 0); t.unref?.(); });
    expect(shutdowns, 'a late queued tick must not start a second teardown').toBe(1);
  });

  it('shuts down once when EOF and parent loss race in the same turn', async () => {
    const stdin = fakeStdin();
    let shutdowns = 0;
    let exits = 0;
    let tick: (() => void) | null = null;
    let ppid = 100;
    installMcpStdioLifecycle({
      stdin,
      shutdown: async () => { shutdowns += 1; },
      exit: () => { exits += 1; },
      getParentPid: () => ppid,
      initialParentPid: 100,
      setIntervalFn: (handler) => { tick = handler; return {}; },
      clearIntervalFn: () => { tick = null; },
    });

    ppid = 1;
    stdin.emit('end');
    stdin.emit('close');
    tick?.();
    await new Promise((r) => { const t = setTimeout(r, 0); t.unref?.(); });

    expect(shutdowns, 'teardown must run exactly once however many triggers fire').toBe(1);
    expect(exits).toBe(1);
    expect(stdin.count('end'), 'listeners are removed so a late event cannot re-enter').toBe(0);
  });

  it('does not shut down while the parent pid is unchanged', async () => {
    const stdin = fakeStdin();
    let shutdowns = 0;
    let tick: (() => void) | null = null;
    installMcpStdioLifecycle({
      stdin,
      shutdown: async () => { shutdowns += 1; },
      exit: () => {},
      // A launcher legitimately running as init would make a `ppid === 1`
      // test fire immediately; only a CHANGE proves the parent is gone.
      getParentPid: () => 1,
      initialParentPid: 1,
      setIntervalFn: (handler) => { tick = handler; return {}; },
    });
    tick?.();
    tick?.();
    await new Promise((r) => { const t = setTimeout(r, 0); t.unref?.(); });
    expect(shutdowns).toBe(0);
  });

  it('unrefs its poll so the guard never keeps the process alive', () => {
    const stdin = fakeStdin();
    let unrefed = false;
    installMcpStdioLifecycle({
      stdin,
      shutdown: async () => {},
      exit: () => {},
      getParentPid: () => 5,
      initialParentPid: 5,
      setIntervalFn: () => ({ unref: () => { unrefed = true; } }),
    });
    expect(unrefed).toBe(true);
  });

  it('disposes without shutting down', () => {
    const stdin = fakeStdin();
    let shutdowns = 0;
    let cleared = false;
    const dispose = installMcpStdioLifecycle({
      stdin,
      shutdown: async () => { shutdowns += 1; },
      exit: () => {},
      getParentPid: () => 7,
      initialParentPid: 7,
      setIntervalFn: () => ({}),
      clearIntervalFn: () => { cleared = true; },
    });
    dispose();
    stdin.emit('end');
    expect(shutdowns, 'a disposed guard must not react to a later EOF').toBe(0);
    expect(cleared).toBe(true);
  });
});

describe('createIdempotentShutdown', () => {
  it('releases once and closes once however many callers arrive', async () => {
    let releases = 0;
    let closes = 0;
    const { release, shutdown } = createIdempotentShutdown({
      release: async () => { releases += 1; },
      close: () => { closes += 1; },
    });
    await Promise.all([shutdown(), shutdown(), release(), shutdown()]);
    expect(releases, 'the resource must be released exactly once').toBe(1);
    expect(closes, 'the transport must be closed exactly once').toBe(1);
  });

  it('still closes when release rejects, and swallows a synchronously throwing close', async () => {
    let closes = 0;
    const { shutdown } = createIdempotentShutdown({
      release: async () => { throw new Error('release failed'); },
      // Throws SYNCHRONOUSLY: `Promise.resolve(fn())` cannot catch this, so an
      // earlier draft let it escape teardown entirely.
      close: () => { closes += 1; throw new Error('close failed'); },
    });
    // Teardown is total. A failed release must not strand the transport, and
    // neither failure may surface as a rejection that outlives the process.
    await expect(shutdown()).resolves.toBeUndefined();
    expect(closes, 'the transport is closed even though release rejected').toBe(1);

    // The standalone release still reports its own failure to its caller.
    const direct = createIdempotentShutdown({
      release: async () => { throw new Error('release failed'); },
      close: () => {},
    });
    await expect(direct.release()).rejects.toThrow('release failed');
  });
});
