import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PROCESS_START_BATCH,
  ProcessCpuReader,
  ProcessStartReader,
  parseProcStatCpuMillis,
  parsePsCpuTimeMillis,
  type ProcessStartDeps,
} from '../../src/util/process-start.js';

const execFileAsync = promisify(execFileCallback);
const OWN_PID = 4242;

interface Call { command: string; args: string[] }

function makeDeps(
  respond: (call: Call) => { stdout: string } | { error: { stdout?: string } },
  platform: NodeJS.Platform = 'linux',
): { deps: ProcessStartDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      platform,
      ownPid: OWN_PID,
      async readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      async execFile(command, args) {
        const call = { command, args };
        calls.push(call);
        const result = respond(call);
        if ('error' in result) throw Object.assign(new Error('exit 1'), result.error);
        return result;
      },
    },
  };
}

const psTable = (rows: Record<number, string>) => Object.entries(rows).map(([pid, start]) => `  ${pid} ${start}`).join('\n');

describe('ProcessStartReader', () => {
  it('shares one ps spawn across a burst of reads instead of one spawn per pid (the orphan-sweep pattern)', async () => {
    const { deps, calls } = makeDeps(() => ({ stdout: psTable({ 11: 'Wed Sep 30 03:44:12 2026', 12: 'Wed Sep 30 03:44:13 2026', 13: 'Wed Sep 30 03:44:14 2026' }) }));
    const reader = new ProcessStartReader(deps);
    const pids = [11, 12, 13];
    const perPidSpawnsBefore = pids.length;
    const values = await Promise.all(pids.map((pid) => reader.read(pid)));
    expect(values).toEqual(['Wed Sep 30 03:44:12 2026', 'Wed Sep 30 03:44:13 2026', 'Wed Sep 30 03:44:14 2026']);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['-o', 'pid=,lstart=', '-p', '11,12,13']);
    expect(perPidSpawnsBefore / calls.length).toBe(3);
  });

  it('resolves only the pid that is gone to undefined when ps exits 1 with partial output', async () => {
    const { deps } = makeDeps(() => ({ error: { stdout: psTable({ 21: 'Wed Sep 30 03:44:12 2026' }) } }));
    const reader = new ProcessStartReader(deps);
    const [alive, gone] = await Promise.all([reader.read(21), reader.read(22)]);
    expect(alive).toBe('Wed Sep 30 03:44:12 2026');
    expect(gone).toBeUndefined();
  });

  it('resolves everything to undefined when the spawn fails outright (fail-safe, same as the old per-pid failure)', async () => {
    const { deps } = makeDeps(() => ({ error: {} }));
    const reader = new ProcessStartReader(deps);
    expect(await Promise.all([reader.read(31), reader.read(32)])).toEqual([undefined, undefined]);
  });

  it('never caches a foreign pid: a reused pid reports the NEW process start, not the dead one', async () => {
    let start = 'Wed Sep 30 03:00:00 2026';
    const { deps, calls } = makeDeps(() => ({ stdout: psTable({ 41: start }) }));
    const reader = new ProcessStartReader(deps);
    expect(await reader.read(41)).toBe('Wed Sep 30 03:00:00 2026');
    start = 'Wed Sep 30 03:05:00 2026';
    expect(await reader.read(41)).toBe('Wed Sep 30 03:05:00 2026');
    expect(calls).toHaveLength(2);
  });

  it("reads this process's own start once: it cannot change while the process runs", async () => {
    const { deps, calls } = makeDeps(() => ({ stdout: psTable({ [OWN_PID]: 'Wed Sep 30 02:00:00 2026' }) }));
    const reader = new ProcessStartReader(deps);
    expect(await Promise.all([reader.read(OWN_PID), reader.read(OWN_PID)])).toEqual(['Wed Sep 30 02:00:00 2026', 'Wed Sep 30 02:00:00 2026']);
    expect(await reader.read(OWN_PID)).toBe('Wed Sep 30 02:00:00 2026');
    expect(calls).toHaveLength(1);
  });

  it('does not memoize a failed own-pid read', async () => {
    let fail = true;
    const { deps, calls } = makeDeps(() => (fail ? { error: {} } : { stdout: psTable({ [OWN_PID]: 'Wed Sep 30 02:00:00 2026' }) }));
    const reader = new ProcessStartReader(deps);
    expect(await reader.read(OWN_PID)).toBeUndefined();
    fail = false;
    expect(await reader.read(OWN_PID)).toBe('Wed Sep 30 02:00:00 2026');
    expect(calls).toHaveLength(2);
  });

  it('never lets a malformed pid poison the shared spawn', async () => {
    const { deps, calls } = makeDeps(() => ({ stdout: psTable({ 51: 'Wed Sep 30 03:44:12 2026' }) }));
    const reader = new ProcessStartReader(deps);
    const values = await Promise.all([reader.read(51), reader.read(Number.NaN), reader.read(-3), reader.read(0), reader.read(1.5)]);
    expect(values).toEqual(['Wed Sep 30 03:44:12 2026', undefined, undefined, undefined, undefined]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.at(-1)).toBe('51');
  });

  it('splits a very large burst into bounded ps invocations', async () => {
    const { deps, calls } = makeDeps((call) => ({ stdout: psTable(Object.fromEntries(call.args.at(-1)!.split(',').map((pid) => [Number(pid), 'Wed Sep 30 03:44:12 2026']))) }));
    const reader = new ProcessStartReader(deps);
    const pids = Array.from({ length: PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN * 2 + 5 }, (_, i) => 100 + i);
    const values = await Promise.all(pids.map((pid) => reader.read(pid)));
    expect(values.every((value) => value === 'Wed Sep 30 03:44:12 2026')).toBe(true);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.args.at(-1)!.split(',').length).toBeLessThanOrEqual(PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN);
  });

  it('uses one PowerShell spawn for many pids on Windows and keeps the tick-count format', async () => {
    const { deps, calls } = makeDeps(() => ({ stdout: '61 638000000000000001\r\n62 638000000000000002\r\ngarbage line\r\n' }), 'win32');
    const reader = new ProcessStartReader(deps);
    const [a, b, c] = await Promise.all([reader.read(61), reader.read(62), reader.read(63)]);
    expect([a, b, c]).toEqual(['638000000000000001', '638000000000000002', undefined]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell.exe');
    expect(calls[0].args.at(-1)).toContain('Get-Process -Id 61,62,63 ');
    expect(calls[0].args.at(-1)).toContain('.StartTime.ToUniversalTime().Ticks');
    expect(calls[0].args.at(-1)).not.toContain('"');
  });
});

describe.skipIf(process.platform === 'win32')('ProcessStartReader against the real ps', () => {
  it('returns byte-identical values to the previous per-pid `ps -o lstart= -p` (persisted records compare against them)', async () => {
    const children = [spawn('sleep', ['30']), spawn('sleep', ['30']), spawn('sleep', ['30'])];
    try {
      const pids = [process.pid, process.ppid, ...children.map((child) => child.pid!)];
      const legacy = await Promise.all(pids.map(async (pid) => {
        try { return (await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 })).stdout.trim() || undefined; } catch { return undefined; }
      }));
      const reader = new ProcessStartReader();
      const batched = await Promise.all(pids.map((pid) => reader.read(pid)));
      expect(batched).toEqual(legacy);
      expect(batched.filter((value) => value !== undefined).length).toBeGreaterThanOrEqual(4);
      const missing = await reader.read(2_147_483_000);
      expect(missing).toBeUndefined();
    } finally {
      for (const child of children) child.kill('SIGKILL');
    }
  });

  it('keeps a live pid comparable across reads (identity is stable, so the pid-reuse comparison stays meaningful)', async () => {
    const child = spawn('sleep', ['30']);
    try {
      const reader = new ProcessStartReader();
      const first = await reader.read(child.pid!);
      const second = await reader.read(child.pid!);
      expect(first).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

/** A `/proc/<pid>/stat` line: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... */
const procStat = (pid: number, comm: string, utime: number, stime: number) =>
  `${pid} (${comm}) S 1 1 1 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 12345 1000000 100 18446744073709551615`;

function makeCpuDeps(
  platform: NodeJS.Platform,
  files: Record<number, string | { code: string }>,
  psStdout: (call: Call) => { stdout: string } | { error: { stdout?: string } } = () => ({ error: {} }),
): { deps: ProcessStartDeps; calls: Call[]; reads: string[] } {
  const calls: Call[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    deps: {
      platform,
      ownPid: OWN_PID,
      async readFile(path) {
        reads.push(path);
        const entry = files[Number(/\/proc\/(\d+)\/stat/.exec(path)![1])];
        if (typeof entry === 'string') return entry;
        throw Object.assign(new Error(entry?.code ?? 'ENOENT'), { code: entry?.code ?? 'ENOENT' });
      },
      async execFile(command, args) {
        const call = { command, args };
        calls.push(call);
        const result = psStdout(call);
        if ('error' in result) throw Object.assign(new Error('exit 1'), result.error);
        return result;
      },
    },
  };
}

describe('cpu time parsers', () => {
  it('parses ps time= in every shape it prints', () => {
    expect(parsePsCpuTimeMillis('0:05')).toBe(5_000);
    expect(parsePsCpuTimeMillis('01:02:03')).toBe(3_723_000);
    expect(parsePsCpuTimeMillis('1-02:03:04')).toBe(((24 + 2) * 3600 + 3 * 60 + 4) * 1_000);
    expect(parsePsCpuTimeMillis('0:05.25')).toBe(5_250);
    expect(parsePsCpuTimeMillis('garbage')).toBeNull();
  });
  it('sums utime+stime from /proc even when comm contains spaces and parentheses', () => {
    expect(parseProcStatCpuMillis(procStat(77, 'node', 250, 50))).toBe(3_000);
    expect(parseProcStatCpuMillis(procStat(77, 'my (odd) proc name', 100, 0))).toBe(1_000);
    expect(parseProcStatCpuMillis('not a stat line')).toBeNull();
  });
});

describe('ProcessCpuReader', () => {
  it('reads /proc on Linux with no spawn at all, and a vanished pid is simply absent', async () => {
    const { deps, calls, reads } = makeCpuDeps('linux', { 11: procStat(11, 'a', 100, 100), 12: procStat(12, 'b', 0, 0) });
    const cpu = await new ProcessCpuReader(deps).read([11, 12, 13]);
    expect([...cpu]).toEqual([[11, 2_000], [12, 0]]);
    expect(calls).toHaveLength(0);
    expect(reads).toHaveLength(3);
  });

  it('answers a whole tick with ONE ps on macOS, including partial output when a pid is gone', async () => {
    const { deps, calls } = makeCpuDeps('darwin', {}, () => ({ error: { stdout: '  21 0:01.50\n  22 1-00:00:00\n' } }));
    const pids = [21, 22, 23];
    const perPidSpawnsBefore = pids.length;
    const cpu = await new ProcessCpuReader(deps).read(pids);
    expect([...cpu]).toEqual([[21, 1_500], [22, 86_400_000]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['-o', 'pid=,time=', '-p', '21,22,23']);
    expect(perPidSpawnsBefore / calls.length).toBe(3);
  });

  it('falls back to one ps for pids /proc could not answer for a reason other than the process being gone', async () => {
    const { deps, calls } = makeCpuDeps('linux', { 31: procStat(31, 'a', 100, 0), 32: { code: 'EACCES' }, 33: { code: 'ENOENT' } },
      () => ({ stdout: '  32 0:07\n' }));
    const cpu = await new ProcessCpuReader(deps).read([31, 32, 33]);
    expect([...cpu]).toEqual([[31, 1_000], [32, 7_000]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.at(-1)).toBe('32');
  });

  it('uses one PowerShell spawn on Windows with an invariant-culture number and no double quotes', async () => {
    const { deps, calls } = makeCpuDeps('win32', {}, () => ({ stdout: '41 1234.5\r\n42 0\r\nnoise\r\n' }));
    const cpu = await new ProcessCpuReader(deps).read([41, 42, 43]);
    expect([...cpu]).toEqual([[41, 1_234.5], [42, 0]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('powershell.exe');
    const script = calls[0].args.at(-1)!;
    expect(script).toContain('Get-Process -Id 41,42,43 ');
    expect(script).toContain('TotalProcessorTime.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)');
    expect(script).not.toContain('"');
  });

  it('drops malformed and duplicate pids and bounds each spawn', async () => {
    const seen: number[] = [];
    const { deps, calls } = makeCpuDeps('darwin', {}, (call) => {
      const list = call.args.at(-1)!.split(',').map(Number);
      seen.push(list.length);
      return { stdout: list.map((pid) => `${pid} 0:01`).join('\n') };
    });
    const pids = [Number.NaN, -1, 0, 1.5, 5, 5, ...Array.from({ length: PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN + 10 }, (_, i) => 1_000 + i)];
    const cpu = await new ProcessCpuReader(deps).read(pids);
    expect(cpu.size).toBe(PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN + 11);
    expect(seen).toEqual([PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN, 11]);
    expect(calls).toHaveLength(2);
  });

  it('returns nothing when the spawn fails outright, like the old per-pid sampler returning null', async () => {
    const { deps } = makeCpuDeps('darwin', {}, () => ({ error: {} }));
    expect((await new ProcessCpuReader(deps).read([51, 52])).size).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('ProcessCpuReader against the real OS', () => {
  it('agrees with the previous per-pid `ps -o time=` sampler for live processes and drops a killed one', async () => {
    const busy = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<1500){}; setTimeout(()=>{},30000)'], { stdio: 'ignore' });
    const idle = spawn('sleep', ['30'], { stdio: 'ignore' });
    const doomed = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      doomed.kill('SIGKILL');
      await new Promise((resolve) => doomed.once('exit', resolve));
      const pids = [busy.pid!, idle.pid!, process.pid, doomed.pid!];
      const legacy = new Map<number, number>();
      for (const pid of pids) {
        try {
          const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 2_000 });
          const ms = parsePsCpuTimeMillis(stdout);
          if (ms !== null) legacy.set(pid, ms);
        } catch { /* gone */ }
      }
      const batched = await new ProcessCpuReader().read(pids);
      expect([...batched.keys()].sort()).toEqual([...legacy.keys()].sort());
      expect(batched.has(doomed.pid!)).toBe(false);
      for (const [pid, legacyMs] of legacy) {
        // ps prints whole seconds on Linux and hundredths on macOS; /proc is 10 ms ticks. Same quantity, finer or equal resolution.
        expect(Math.abs(batched.get(pid)! - legacyMs), `pid ${pid}`).toBeLessThanOrEqual(1_100);
      }
      expect(batched.get(busy.pid!)!).toBeGreaterThan(batched.get(idle.pid!)!);
    } finally {
      busy.kill('SIGKILL'); idle.kill('SIGKILL'); doomed.kill('SIGKILL');
    }
  });
});
