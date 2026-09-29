import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PROCESS_START_BATCH, ProcessStartReader, type ProcessStartDeps } from '../../src/util/process-start.js';

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
