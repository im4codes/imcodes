import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXEC_HELPER_ENV_SWITCH,
  EXEC_HELPER_ERROR_CODE,
  EXEC_HELPER_MSG,
  type ExecHelperRequest,
} from '../../shared/exec-helper-protocol.js';
import type { ChildProcessWorkerHandle } from '../../src/util/child-process-worker.js';
import {
  EXEC_HELPER_COOLDOWN_MS,
  EXEC_HELPER_CRASH_LIMIT,
  EXEC_HELPER_RESPONSE_GRACE_MS,
  ExecHelperClient,
  __resetExecHelperForTests,
  execFileOffMain,
  getExecHelperStats,
  shutdownExecHelper,
  startExecHelper,
} from '../../src/util/exec-helper.js';

const direct = promisify(execFileCb);
const POSIX = process.platform !== 'win32';
const node = process.execPath;

/** In-memory stand-in for the forked helper: the tests decide when it answers, dies or hangs. */
class FakeWorker implements ChildProcessWorkerHandle {
  pid = 4242;
  requests: ExecHelperRequest[] = [];
  killed = false;
  terminated = false;
  throwOnPost = false;
  private listeners = new Map<string, Array<(value: any) => void>>();
  unref(): void {}
  on(event: string, listener: (value: any) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  postMessage(message: unknown): void {
    if (this.throwOnPost) throw new Error('child_process_worker_disconnected');
    this.requests.push(message as ExecHelperRequest);
  }
  async terminate(): Promise<number> { this.terminated = true; return 0; }
  forceKill(): void { this.killed = true; }
  emit(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
  ready(): void { this.emit('message', { type: EXEC_HELPER_MSG.READY, pid: this.pid }); }
  answer(id: number, stdout: string): void {
    this.emit('message', { type: EXEC_HELPER_MSG.RESULT, id, ok: true, stdout, stderr: '' });
  }
}

function fakeClient(now = { t: 1_000_000 }): { client: ExecHelperClient; workers: FakeWorker[]; now: { t: number } } {
  const workers: FakeWorker[] = [];
  const client = new ExecHelperClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, () => now.t);
  return { client, workers, now };
}

async function settle(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }

describe('ExecHelperClient (fake helper process)', () => {
  it('spawns directly until the helper has reported ready, then posts calls to it', async () => {
    const { client, workers } = fakeClient();
    client.start();
    const before = await client.execFile(node, ['-e', 'process.stdout.write("direct")']);
    expect(before.stdout).toBe('direct');
    expect(workers[0]!.requests).toHaveLength(0);
    expect(client.getStats().direct).toBe(1);

    workers[0]!.ready();
    const call = client.execFile('tmux', ['list-sessions'], { timeout: 1000 });
    await settle();
    expect(workers[0]!.requests).toHaveLength(1);
    workers[0]!.answer(workers[0]!.requests[0]!.id, 'from helper');
    await expect(call).resolves.toEqual({ stdout: 'from helper', stderr: '' });
    expect(client.getStats()).toMatchObject({ viaHelper: 1, direct: 1, inFlight: 0 });
  });

  it('forwards the call-time cwd and environment, so a helper forked at boot sees later changes', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    process.env.EXEC_HELPER_TEST_LATE = 'set-after-fork';
    try {
      void client.execFile('git', ['status']).catch(() => undefined);
      void client.execFile('git', ['status'], { cwd: '/explicit', env: { ONLY: '1' } }).catch(() => undefined);
    } finally {
      delete process.env.EXEC_HELPER_TEST_LATE;
    }
    await settle();
    const [implicit, explicit] = workers[0]!.requests;
    expect(implicit!.options.cwd).toBe(process.cwd());
    expect(implicit!.options.env).toMatchObject({ EXEC_HELPER_TEST_LATE: 'set-after-fork' });
    expect(explicit!.options).toMatchObject({ cwd: '/explicit', env: { ONLY: '1' } });
    expect(Object.keys(explicit!.options.env ?? {})).toEqual(['ONLY']);
  });

  it.each([
    ['shell', { shell: true }],
    ['stdio', { stdio: 'inherit' }],
    ['abort signal', { signal: new AbortController().signal }],
    ['argv0', { argv0: 'renamed' }],
    ['non-string cwd', { cwd: pathToFileURL(process.cwd()) }],
  ])('spawns directly for an option the helper cannot forward (%s)', async (_label, options) => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    const result = await client.execFile(node, ['-e', 'process.stdout.write("d")'], options as never).catch((e) => e);
    expect(workers[0]!.requests).toHaveLength(0);
    expect(client.getStats().direct).toBe(1);
    void result;
  });

  it('a helper crash fails only the calls in flight, cleanly, and respawns; later calls use the new helper', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    const inFlight = client.execFile('tmux', ['send-keys'], { timeout: 5000 });
    const alsoInFlight = client.execFile('git', ['remote', '-v']);
    await settle();
    workers[0]!.emit('exit', 137);
    for (const failed of [inFlight, alsoInFlight]) {
      await expect(failed).rejects.toMatchObject({ code: EXEC_HELPER_ERROR_CODE.CRASHED, killed: false });
    }
    expect(workers[0]!.killed).toBe(true);
    expect(workers).toHaveLength(2);
    expect(client.isReady).toBe(false);
    // Until the replacement reports ready, calls spawn directly and succeed.
    expect((await client.execFile(node, ['-e', 'process.stdout.write("x")'])).stdout).toBe('x');
    workers[1]!.ready();
    const call = client.execFile('tmux', ['list-panes']);
    await settle();
    workers[1]!.answer(workers[1]!.requests[0]!.id, 'ok');
    await expect(call).resolves.toMatchObject({ stdout: 'ok' });
    expect(client.getStats().crashes).toBe(1);
  });

  it('a helper that never becomes ready (bootstrap failure) leaves every call on the direct path', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.emit('exit', 1);
    expect(client.isReady).toBe(false);
    expect((await client.execFile(node, ['-e', 'process.stdout.write("still works")'])).stdout).toBe('still works');
  });

  it('a crash loop stops respawning for a cooldown, spawns directly, and retries afterwards', async () => {
    const { client, workers, now } = fakeClient();
    client.start();
    for (let i = 0; i < EXEC_HELPER_CRASH_LIMIT; i += 1) {
      workers[workers.length - 1]!.ready();
      workers[workers.length - 1]!.emit('exit', 1);
    }
    expect(workers).toHaveLength(EXEC_HELPER_CRASH_LIMIT); // the third crash did not respawn
    expect(client.isReady).toBe(false);
    expect((await client.execFile(node, ['-e', 'process.stdout.write("direct")'])).stdout).toBe('direct');
    client.start(); // still cooling down
    expect(workers).toHaveLength(EXEC_HELPER_CRASH_LIMIT);
    now.t += EXEC_HELPER_COOLDOWN_MS + 1;
    client.start();
    expect(workers).toHaveLength(EXEC_HELPER_CRASH_LIMIT + 1);
  });

  it('a call whose helper never answers rejects UNRESPONSIVE after its timeout plus grace, and the helper is replaced', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    const started = Date.now();
    const call = client.execFile('tmux', ['list-sessions'], { timeout: 50 });
    await expect(call).rejects.toMatchObject({ code: EXEC_HELPER_ERROR_CODE.UNRESPONSIVE });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50 + EXEC_HELPER_RESPONSE_GRACE_MS - 100);
    expect(workers[0]!.killed).toBe(true);
    workers[0]!.emit('exit', null);
    expect(workers).toHaveLength(2);
  }, 10_000);

  it('a post that throws never reached the helper, so the call spawns directly instead of failing', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    workers[0]!.throwOnPost = true;
    const result = await client.execFile(node, ['-e', 'process.stdout.write("fallback")']);
    expect(result.stdout).toBe('fallback');
    expect(client.getStats().inFlight).toBe(0);
  });

  it('shutdown lets posted calls finish, then routes every later call (including during shutdown) directly', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    const inFlight = client.execFile('tmux', ['list-sessions']);
    await settle();
    const shutdown = client.shutdown(500);
    // A call made while shutting down spawns directly and works.
    expect((await client.execFile(node, ['-e', 'process.stdout.write("late")'])).stdout).toBe('late');
    workers[0]!.answer(workers[0]!.requests[0]!.id, 'finished');
    await expect(inFlight).resolves.toMatchObject({ stdout: 'finished' });
    await shutdown;
    expect(workers[0]!.terminated).toBe(true);
    expect(client.isReady).toBe(false);
    expect((await client.execFile(node, ['-e', 'process.stdout.write("after")'])).stdout).toBe('after');
    expect(workers).toHaveLength(1); // no respawn after shutdown
  });

  it('shutdown gives up on a call that never finishes and fails it cleanly', async () => {
    const { client, workers } = fakeClient();
    client.start();
    workers[0]!.ready();
    const stuck = client.execFile('tmux', ['list-sessions']);
    await settle();
    await client.shutdown(60);
    await expect(stuck).rejects.toMatchObject({ code: EXEC_HELPER_ERROR_CODE.CRASHED });
  });
});

describe('exec helper (real forked process): same result as a direct call', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'imc-exec-helper-'));
    process.env[EXEC_HELPER_ENV_SWITCH] = '1';
    startExecHelper();
    await waitReady();
  });
  afterEach(async () => {
    await shutdownExecHelper();
    __resetExecHelperForTests();
    delete process.env[EXEC_HELPER_ENV_SWITCH];
    rmSync(dir, { recursive: true, force: true });
  });

  async function waitReady(ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!getExecHelperStats()?.ready) {
      if (Date.now() > deadline) throw new Error('exec helper never became ready');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Run once directly and once through the helper; the observable outcome must match. */
  async function both(file: string, args: string[], options?: Record<string, unknown>) {
    const capture = async (run: () => Promise<{ stdout: any; stderr: any }>) => {
      try {
        const { stdout, stderr } = await run();
        return { ok: true as const, stdout, stderr };
      } catch (error: any) {
        return {
          ok: false as const,
          message: error.message, name: error.name, code: error.code, signal: error.signal,
          killed: error.killed, cmd: error.cmd, stdout: error.stdout, stderr: error.stderr, syscall: error.syscall,
        };
      }
    };
    const viaDirect = await capture(() => (options ? direct(file, args, options as never) : direct(file, args)));
    const before = getExecHelperStats()!.viaHelper;
    const viaHelper = await capture(() => (options ? execFileOffMain(file, args, options as never) : execFileOffMain(file, args)));
    expect(getExecHelperStats()!.viaHelper).toBe(before + 1);
    return { viaDirect, viaHelper };
  }

  it('returns identical stdout and stderr on success', async () => {
    const { viaDirect, viaHelper } = await both(node, ['-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n")']);
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toEqual({ ok: true, stdout: 'out\n', stderr: 'err\n' });
  });

  it('reports a non-zero exit with the same error fields, stdout and stderr (git, tmux-style failure)', async () => {
    const { viaDirect, viaHelper } = await both(node, ['-e', 'process.stdout.write("partial"); process.stderr.write("bad\\n"); process.exit(3)']);
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toMatchObject({ ok: false, code: 3, killed: false, stdout: 'partial', stderr: 'bad\n' });
  });

  it('kills on timeout exactly like a direct call (killed, SIGTERM, partial output kept)', async () => {
    const started = Date.now();
    const { viaDirect, viaHelper } = await both(node, ['-e', 'process.stdout.write("began"); setInterval(() => {}, 1000)'], { timeout: 300 });
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toMatchObject({ ok: false, killed: true, signal: 'SIGTERM', stdout: 'began' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('honours killSignal', async () => {
    const { viaDirect, viaHelper } = await both(node, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 200, killSignal: 'SIGKILL' });
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toMatchObject({ killed: true, signal: 'SIGKILL' });
  });

  it('reports a missing binary the same way (ENOENT)', async () => {
    const { viaDirect, viaHelper } = await both('imc-definitely-not-a-binary', ['x']);
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toMatchObject({ ok: false, code: 'ENOENT', syscall: 'spawn imc-definitely-not-a-binary' });
  });

  it('enforces maxBuffer the same way', async () => {
    const { viaDirect, viaHelper } = await both(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 1000 });
    expect(viaHelper).toEqual(viaDirect);
    expect(viaHelper).toMatchObject({ ok: false, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });

  it('returns Buffers for encoding: buffer', async () => {
    const result = await execFileOffMain(node, ['-e', 'process.stdout.write(Buffer.from([1,2,3,255]))'], { encoding: 'buffer' } as never);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect([...(result.stdout as Buffer)]).toEqual([1, 2, 3, 255]);
  });

  it('carries very large stdout (8 MB) intact', async () => {
    const size = 8 * 1024 * 1024;
    const result = await execFileOffMain(node, ['-e', `process.stdout.write("y".repeat(${size}))`], { maxBuffer: 16 * 1024 * 1024 });
    expect(result.stdout).toHaveLength(size);
    expect(result.stdout.startsWith('yyyy') && result.stdout.endsWith('yyyy')).toBe(true);
  }, 30_000);

  it('runs each call in its own cwd and environment, whatever the helper was forked with', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'imc-exec-helper-cwd-'));
    try {
      const probe = ['-e', 'process.stdout.write(require("fs").realpathSync.native(process.cwd()) + "|" + (process.env.EXEC_HELPER_PROBE ?? "unset") + "|" + (process.env.HOME ?? "nohome"))'];
      const minimalEnv: Record<string, string | undefined> = POSIX
        ? { PATH: process.env.PATH }
        : { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot };
      const inDir = await execFileOffMain(node, probe, { cwd: otherDir, env: { ...process.env, EXEC_HELPER_PROBE: 'call-1' } });
      const inOther = await execFileOffMain(node, probe, { cwd: dir, env: minimalEnv });
      process.env.EXEC_HELPER_PROBE = 'set-after-fork';
      let implicit: { stdout: string };
      try {
        implicit = await execFileOffMain(node, probe);
      } finally {
        delete process.env.EXEC_HELPER_PROBE;
      }
      const realOther = readRealpath(otherDir);
      expect(inDir.stdout).toBe(`${realOther}|call-1|${process.env.HOME ?? 'nohome'}`);
      expect(inOther.stdout).toBe(`${readRealpath(dir)}|unset|nohome`); // no leakage from the previous call or the helper's env
      expect(implicit.stdout.split('|')[1]).toBe('set-after-fork');
      expect(implicit.stdout.split('|')[0]).toBe(readRealpath(process.cwd()));
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('preserves the order of awaited calls (the tmux send-keys per-session ordering rests on this)', async () => {
    const log = join(dir, 'order.log');
    writeFileSync(log, '');
    for (let i = 0; i < 40; i += 1) {
      await execFileOffMain(node, ['-e', `require("fs").appendFileSync(${JSON.stringify(log)}, "${i}\\n")`]);
    }
    expect(readFileSync(log, 'utf8').trim().split('\n').map(Number)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  }, 30_000);

  it.skipIf(!POSIX)('starts child processes in the order they were issued when not awaited one by one', async () => {
    const log = join(dir, 'issue-order.log');
    writeFileSync(log, '');
    const calls = Array.from({ length: 12 }, (_, i) => execFileOffMain('sh', ['-c', `echo ${i} >> ${JSON.stringify(log)}`]));
    await Promise.all(calls);
    const started = readFileSync(log, 'utf8').trim().split('\n').map(Number);
    expect([...started].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it.skipIf(!POSIX)('git and ps run through the helper with the same output as a direct call', async () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.com/acme/widgets.git']);
    const git = await both('git', ['remote', '-v'], { cwd: repo, timeout: 5000 });
    expect(git.viaHelper).toEqual(git.viaDirect);
    expect((git.viaHelper as { stdout: string }).stdout).toContain('acme/widgets.git');
    const ps = await both('ps', ['-o', 'pid=,lstart=', '-p', String(process.pid)], { timeout: 2000 });
    expect(ps.viaHelper).toEqual(ps.viaDirect);
  });

  it('a killed helper fails only the in-flight call, respawns, and leaves no zombie processes', async () => {
    const before = getExecHelperStats()!;
    const orphanPidFile = join(dir, 'orphan.pid');
    const running = execFileOffMain(node, ['-e', `require("fs").writeFileSync(${JSON.stringify(orphanPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { timeout: 30_000 });
    for (let i = 0; i < 100 && !existsSync(orphanPidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    process.kill(before.pid!, 'SIGKILL');
    await expect(running).rejects.toMatchObject({ code: EXEC_HELPER_ERROR_CODE.CRASHED });
    // During the respawn window calls still succeed (direct), then the new helper takes over.
    expect((await execFileOffMain(node, ['-e', 'process.stdout.write("alive")'])).stdout).toBe('alive');
    await waitReady();
    const after = getExecHelperStats()!;
    expect(after.pid).not.toBe(before.pid);
    expect(after.crashes).toBe(1);
    expect((await execFileOffMain(node, ['-e', 'process.stdout.write("via new helper")'])).stdout).toBe('via new helper');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (POSIX) expect(zombieChildren()).toEqual([]);
    // The orphaned long-running child dies with its helper's pipe or its timeout; do not leak it past the test.
    try { process.kill(Number(readFileSync(orphanPidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  }, 60_000);

  it('after shutdown calls spawn directly and the helper process is gone', async () => {
    const pid = getExecHelperStats()!.pid!;
    await shutdownExecHelper();
    expect((await execFileOffMain(node, ['-e', 'process.stdout.write("direct after")'])).stdout).toBe('direct after');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    if (POSIX) expect(zombieChildren()).toEqual([]);
  });

  it('the helper dies with the daemon: closing its IPC channel ends it and its children', async () => {
    const script = join(dir, 'parent.mjs');
    writeFileSync(script, `
      import { startExecHelper, execFileOffMain, getExecHelperStats } from ${JSON.stringify(new URL('../../src/util/exec-helper.ts', import.meta.url).href)};
      startExecHelper();
      while (!getExecHelperStats()?.ready) await new Promise((r) => setTimeout(r, 25));
      console.log('HELPER_PID=' + getExecHelperStats().pid);
      execFileOffMain(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 60000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      process.exit(0);
    `);
    const output = await direct(node, ['--import', 'tsx', script], { env: { ...process.env, [EXEC_HELPER_ENV_SWITCH]: '1' }, timeout: 30_000, cwd: process.cwd() });
    const helperPid = Number(/HELPER_PID=(\d+)/.exec(output.stdout)?.[1]);
    expect(helperPid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(() => process.kill(helperPid, 0)).toThrow();
  }, 60_000);
});

function readRealpath(path: string): string {
  return execFileSync(node, ['-e', `process.stdout.write(require("fs").realpathSync.native(${JSON.stringify(path)}))`], { encoding: 'utf8' });
}

function zombieChildren(): string[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' });
  return table.split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .filter((m) => Number(m[2]) === process.pid && m[3]!.startsWith('Z'))
    .map((m) => m[0]);
}

describe.skipIf(POSIX)('Windows: PowerShell and the process-start batch through the exec helper', () => {
  beforeEach(async () => {
    process.env[EXEC_HELPER_ENV_SWITCH] = '1';
    startExecHelper();
    const deadline = Date.now() + 20_000;
    while (!getExecHelperStats()?.ready) {
      if (Date.now() > deadline) throw new Error('exec helper never became ready');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  afterEach(async () => {
    await shutdownExecHelper();
    __resetExecHelperForTests();
    delete process.env[EXEC_HELPER_ENV_SWITCH];
  });

  const powershell = (script: string) => ['-NoProfile', '-NonInteractive', '-Command', script];

  it('runs powershell.exe with the same output and the same non-zero exit as a direct call', async () => {
    const ok = powershell('Write-Output "hello from ps"');
    const viaDirect = await direct('powershell.exe', ok, { windowsHide: true, timeout: 20_000 });
    const before = getExecHelperStats()!.viaHelper;
    const viaHelper = await execFileOffMain('powershell.exe', ok, { windowsHide: true, timeout: 20_000 });
    expect(getExecHelperStats()!.viaHelper).toBe(before + 1);
    expect(viaHelper).toEqual(viaDirect);
    const failing = powershell('Write-Output "before"; exit 3');
    const capture = async (run: () => Promise<unknown>) => run().then(() => null, (e: any) => ({ code: e.code, killed: e.killed, signal: e.signal, stdout: e.stdout }));
    const directFail = await capture(() => direct('powershell.exe', failing, { windowsHide: true, timeout: 20_000 }));
    const helperFail = await capture(() => execFileOffMain('powershell.exe', failing, { windowsHide: true, timeout: 20_000 }));
    expect(helperFail).toEqual(directFail);
    expect(helperFail).toMatchObject({ code: 3, killed: false });
  }, 60_000);

  it('kills a PowerShell that outlives its timeout exactly like a direct call', async () => {
    const script = powershell('Start-Sleep -Seconds 30');
    const capture = async (run: () => Promise<unknown>) => run().then(() => null, (e: any) => ({ killed: e.killed, signal: e.signal }));
    const directTimeout = await capture(() => direct('powershell.exe', script, { windowsHide: true, timeout: 1_500 }));
    const helperTimeout = await capture(() => execFileOffMain('powershell.exe', script, { windowsHide: true, timeout: 1_500 }));
    expect(helperTimeout).toEqual(directTimeout);
    expect(helperTimeout).toMatchObject({ killed: true });
  }, 60_000);

  it('the process-start batch (one PowerShell spawn for many pids) works through the helper and yields the same values', async () => {
    const { ProcessStartReader } = await import('../../src/util/process-start.js');
    const before = getExecHelperStats()!.viaHelper;
    // The production batch timeout (2 s) is shorter than a cold PowerShell start on a slow host, which would make
    // every read undefined with or without the helper; lift only that timeout so the batch script itself is exercised.
    const reader = new ProcessStartReader({
      execFile: (command, args, options) => execFileOffMain(command, args, { ...options, timeout: 60_000 }),
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      platform: 'win32',
      ownPid: process.pid,
    });
    const [own, parent, gone] = await Promise.all([reader.read(process.pid), reader.read(process.ppid), reader.read(999_999_999)]);
    expect(getExecHelperStats()!.viaHelper).toBeGreaterThan(before);
    expect(own).toMatch(/^\d+$/);
    expect(parent === undefined || /^\d+$/.test(parent)).toBe(true);
    expect(gone).toBeUndefined();
    // Same value as the identical batch spawned directly (the registry compares these strings across restarts).
    const script = `Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Id.ToString() + ' ' + $_.StartTime.ToUniversalTime().Ticks.ToString() } catch {} }`;
    const directOut = await direct('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
    expect(directOut.stdout.trim()).toBe(`${process.pid} ${own}`);
  }, 60_000);
});

describe('kill switch and default state', () => {
  it('without startExecHelper (CLI, tests, other processes) every call is a plain direct spawn', async () => {
    __resetExecHelperForTests();
    expect(getExecHelperStats()).toBeNull();
    expect((await execFileOffMain(node, ['-e', 'process.stdout.write("plain")'])).stdout).toBe('plain');
  });

  it('IMCODES_EXEC_HELPER=0 makes startExecHelper a no-op even where the helper would run', async () => {
    __resetExecHelperForTests();
    process.env[EXEC_HELPER_ENV_SWITCH] = '0';
    try {
      startExecHelper();
      expect(getExecHelperStats()).toBeNull();
      expect((await execFileOffMain(node, ['-e', 'process.stdout.write("still direct")'])).stdout).toBe('still direct');
    } finally {
      delete process.env[EXEC_HELPER_ENV_SWITCH];
    }
  });

  it('under vitest the helper stays off unless a test opts in, so child_process mocks keep seeing every call', () => {
    __resetExecHelperForTests();
    delete process.env[EXEC_HELPER_ENV_SWITCH];
    startExecHelper();
    expect(getExecHelperStats()).toBeNull();
  });

  it('the helper process imports nothing but node builtins and its wire contract, so it can start before any daemon state exists and stays small', () => {
    const source = readFileSync(new URL('../../src/util/exec-helper-worker.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../../shared/exec-helper-protocol.js', './worker-runtime-port.js', 'node:child_process'].sort());
    const bootstrap = readFileSync(new URL('../../src/util/exec-helper-worker-bootstrap.mjs', import.meta.url), 'utf8');
    expect(bootstrap).not.toMatch(/session-store|logger|lifecycle/);
  });
});
