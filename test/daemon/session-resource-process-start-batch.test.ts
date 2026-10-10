import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The orphan sweep asks "is this pid still the process we registered?" for
 * every PID record at once. That used to be one `ps` fork per record, on the
 * daemon's main thread; a real profile showed ~0.5 s of it per 120 s plus
 * 276 ms busy segments. The sweep now shares one `ps`, and must still tell a
 * live process from a dead one and from a reused pid.
 */

const spawned = vi.hoisted(() => ({ ps: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = ((...args: unknown[]) => (actual.execFile as (...a: unknown[]) => unknown)(...args)) as unknown as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (command: string, args: string[], options: unknown) => {
    if (command === 'ps') spawned.ps.push(args);
    return (promisify(actual.execFile) as unknown as (...a: unknown[]) => Promise<unknown>)(command, args, options);
  };
  return { ...actual, execFile };
});

const { spawn } = await import('node:child_process');
const { SessionResourceRegistry } = await import('../../src/daemon/session-resource-registry.js');
const { sweepMemoryMcpCpu } = await import('../../src/daemon/session-resource-service.js');
const { readProcessCpuMillis } = await import('../../src/util/process-start.js');
const execFileAsync = promisify((await import('node:child_process')).execFile);

const owner = { sessionName: 'deck_e2e_procstart_w1', sessionInstanceId: 'instance-a', runtimeEpoch: 'epoch-a' };
const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(count: number) {
  const directory = await mkdtemp(join(tmpdir(), 'imcodes-procstart-'));
  roots.push(directory);
  const cleanup = vi.fn(async () => {});
  const registry = new SessionResourceRegistry({ directory, now: () => 10_000, cleanup });
  const pids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(child);
    pids.push(child.pid!);
    await registry.register({ resourceId: `mcp:${child.pid}`, kind: 'mcp', owner, handle: { type: 'pid', pid: child.pid! } });
  }
  return { registry, cleanup, pids };
}

describe.skipIf(process.platform === 'win32')('orphan sweep process-identity checks', () => {
  it('uses one ps for every PID record instead of one per record, and still preserves live ones', async () => {
    const records = 25;
    const { registry, cleanup } = await fixture(records);
    spawned.ps.length = 0;
    const result = await registry.sweepOrphans([owner], { eligibleOwners: [owner] });
    expect(result).toMatchObject({ released: 0, failed: 0, preserved: records });
    expect(cleanup).not.toHaveBeenCalled();
    expect(spawned.ps).toHaveLength(1);
    expect(records / spawned.ps.length).toBe(25);
  });

  it('still releases exactly the record whose process exited, from the same single ps', async () => {
    const { registry, cleanup, pids } = await fixture(6);
    children[2].kill('SIGKILL');
    await new Promise((resolve) => children[2].once('exit', resolve));
    spawned.ps.length = 0;
    const result = await registry.sweepOrphans([owner], { eligibleOwners: [owner] });
    expect(result).toMatchObject({ released: 1, failed: 0, preserved: 5 });
    expect(cleanup.mock.calls.map(([record]) => (record as { resourceId: string }).resourceId)).toEqual([`mcp:${pids[2]}`]);
    expect(spawned.ps).toHaveLength(1);
  });

  it('still recognises a reused pid: the live start time is compared every sweep, never remembered', async () => {
    const { registry, cleanup, pids } = await fixture(2);
    expect(await registry.sweepOrphans([owner], { eligibleOwners: [owner] })).toMatchObject({ released: 0, preserved: 2 });
    // The pid now belongs to a different process: same pid, different recorded start.
    await registry.releaseResource(`mcp:${pids[0]}`, owner, 'test_pid_reuse');
    await registry.register({
      resourceId: `mcp:${pids[0]}`, kind: 'mcp', owner,
      handle: { type: 'pid', pid: pids[0], processStart: 'Thu Jan  1 00:00:00 1970' },
    });
    cleanup.mockClear();
    const result = await registry.sweepOrphans([owner], { eligibleOwners: [owner] });
    expect(result).toMatchObject({ released: 1, preserved: 1 });
    expect(cleanup.mock.calls.map(([record]) => (record as { resourceId: string }).resourceId)).toEqual([`mcp:${pids[0]}`]);
  });

  it("reads the daemon's own start once for the registry lock instead of forking ps on every mutation", async () => {
    const { registry, pids } = await fixture(1);
    spawned.ps.length = 0;
    await registry.touch(`mcp:${pids[0]}`); // first lock acquisition reads the daemon's own start
    const afterFirst = spawned.ps.filter((args) => args.at(-1) === String(process.pid)).length;
    for (let i = 0; i < 5; i += 1) await registry.touch(`mcp:${pids[0]}`);
    expect(spawned.ps.filter((args) => args.at(-1) === String(process.pid)).length).toBe(afterFirst);
  });
});

describe.skipIf(process.platform === 'win32')('memory MCP CPU watchdog spawns', () => {
  it('samples a tick of MCP pids with at most ONE ps (none on Linux), where the old sampler forked one ps per pid', async () => {
    const pids: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      children.push(child);
      pids.push(child.pid!);
    }
    const records = pids.map((pid) => ({
      version: 1 as const, resourceId: `mcp:cpu-${pid}`, kind: 'mcp' as const, owner,
      handle: { type: 'pid' as const, pid, processStart: 'x' }, createdAt: 1, lastUsedAt: 1,
    }));

    // Baseline: the previous per-pid sampler, replayed against the same fixture.
    spawned.ps.length = 0;
    for (const pid of pids) await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 2_000 });
    const legacySpawns = spawned.ps.filter((args) => args.includes('time=')).length;
    expect(legacySpawns).toBe(12);

    spawned.ps.length = 0;
    const releaseResource = vi.fn();
    await sweepMemoryMcpCpu(1_000, {
      listResources: async () => records,
      sampleCpuMillisBatch: readProcessCpuMillis,
      pidHandleIsCurrent: vi.fn(async () => true),
      releaseResource: releaseResource as never,
    });
    const batchedSpawns = spawned.ps.length;
    expect(batchedSpawns).toBeLessThanOrEqual(1);
    expect(releaseResource).not.toHaveBeenCalled();
    expect(legacySpawns / Math.max(1, batchedSpawns)).toBeGreaterThanOrEqual(12);
  });
});
