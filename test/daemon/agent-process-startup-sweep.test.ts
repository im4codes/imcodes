import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionResourceRegistry,
  cleanupSessionResource,
  type SessionResourceCleanup,
} from '../../src/daemon/session-resource-registry.js';
import { SESSION_RESOURCE_KIND } from '../../shared/session-resource-lifecycle.js';

/**
 * Crash recovery for a session-owned agent process group.
 *
 * In-process teardown reaps the group through `killProcessTree`. If the daemon
 * itself dies — crash, SIGKILL, power — nothing runs that teardown, and the
 * group survives on PPID=1. That is the residual the incident left behind.
 *
 * The registry already had the right authority: a PID handle stamped with the
 * process start time, which the sweep re-reads and compares before signalling
 * anything. These cases prove the AGENT kind participates in that sweep, that a
 * real group is actually reaped, and — the part that matters most — that the
 * fingerprint is what grants permission, so a recycled pid is refused.
 */

const POSIX = process.platform !== 'win32';
const roots: string[] = [];
const strays: number[] = [];

const owner = (sessionInstanceId = 'instance-a') => ({
  sessionName: 'deck_alpha_w1', sessionInstanceId, runtimeEpoch: 'epoch-a',
});

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cleanup?: SessionResourceCleanup) {
  const directory = await mkdtemp(join(tmpdir(), 'imcodes-agent-sweep-'));
  roots.push(directory);
  const spy = vi.fn<SessionResourceCleanup>(cleanup ?? (async () => {}));
  const registry = new SessionResourceRegistry({ directory, now: () => 1_000, cleanup: spy });
  return { registry, cleanup: spy };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function firstPid(stream: NodeJS.ReadableStream | null): Promise<number> {
  if (!stream) throw new Error('no stdout');
  for await (const chunk of stream) {
    const pid = Number(String(chunk).trim().split('\n')[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  throw new Error('no pid announced');
}

describe('agent process group survives into the startup sweep', () => {
  it('an agent lease is swept when its owner is gone and preserved when it is live', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({
      resourceId: 'agent:epoch-a:401',
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('crashed-instance'),
      handle: { type: 'pid', pid: 401, killTree: true },
    });
    await registry.register({
      resourceId: 'agent:epoch-a:402',
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('live-instance'),
      handle: { type: 'pid', pid: 402, killTree: true },
    });

    const swept = await registry.sweepOrphans([owner('live-instance')]);
    expect(swept).toMatchObject({ released: 1, preserved: 1, failed: 0 });
    expect((await registry.list()).map((item) => item.resourceId)).toEqual(['agent:epoch-a:402']);
    expect(cleanup.mock.calls.map(([record]) => record.resourceId)).toEqual(['agent:epoch-a:401']);
  });

  it.skipIf(!POSIX)('reaps the whole group of a crashed session, not just the leader', async () => {
    // Real processes and the REAL cleanup: a spy would prove the record was
    // visited, not that anything died.
    const { registry } = await fixture(cleanupSessionResource);
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const orphan = await firstPid(child.stdout);
    strays.push(orphan, child.pid!);

    await registry.register({
      resourceId: `agent:epoch-a:${child.pid}`,
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('crashed-instance'),
      handle: { type: 'pid', pid: child.pid!, killTree: true },
    });

    // The daemon died without tearing down: nothing signalled this group.
    const swept = await registry.sweepOrphans([]);
    expect(swept).toMatchObject({ released: 1, failed: 0 });
    await settle(400);

    expect(alive(child.pid!), 'the group leader is reaped').toBe(false);
    expect(orphan, 'a real descendant existed').toBeGreaterThan(0);
    expect(alive(orphan), 'and so is the descendant it forked').toBe(false);
  });

  it.skipIf(!POSIX)('refuses to signal when the recorded fingerprint no longer matches', async () => {
    // The PID-reuse case. The pid is alive and in the record, but it is not the
    // process we registered, so the sweep must leave it completely alone.
    const { registry } = await fixture(cleanupSessionResource);
    const bystander = spawn('bash', ['-c', 'sleep 600'], { stdio: 'ignore' });
    strays.push(bystander.pid!);
    await settle(150);

    await registry.register({
      resourceId: `agent:epoch-a:${bystander.pid}`,
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('crashed-instance'),
      // A start time that is deliberately not this process's.
      handle: { type: 'pid', pid: bystander.pid!, processStart: 'Thu Jan  1 00:00:00 1970', killTree: true },
    });

    await registry.sweepOrphans([]);
    await settle(300);

    expect(
      alive(bystander.pid!),
      'a pid whose fingerprint disagrees is a different process and must not be signalled',
    ).toBe(true);
  });

  it.skipIf(!POSIX)('refuses to signal a pid handle that carries no fingerprint at all', async () => {
    const { registry } = await fixture(cleanupSessionResource);
    const bystander = spawn('bash', ['-c', 'sleep 600'], { stdio: 'ignore' });
    strays.push(bystander.pid!);

    // `register()` normally stamps processStart, so bypass it to build the
    // un-fingerprinted record a legacy ledger could still contain.
    await registry.register({
      resourceId: `agent:epoch-a:${bystander.pid}`,
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('crashed-instance'),
      handle: { type: 'pid', pid: bystander.pid!, killTree: true },
    });
    const record = (await registry.list()).find((item) => item.handle.type === 'pid');
    expect(record, 'the lease exists').toBeTruthy();
    await cleanupSessionResource(
      { ...record!, handle: { type: 'pid', pid: bystander.pid!, killTree: true } },
      'orphaned',
    );
    await settle(250);

    expect(
      alive(bystander.pid!),
      'no fingerprint means no authority, so nothing is signalled',
    ).toBe(true);
  });

  it.skipIf(!POSIX)('group-reaps survivors when the recorded leader is already gone', async () => {
    // The exact incident shape reaching startup: the leader exited on its own,
    // its descendants reparented to 1, and the group id is all that is left.
    const { registry } = await fixture(cleanupSessionResource);
    const child = spawn('bash', ['-c', 'sleep 600 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const orphan = await firstPid(child.stdout);
    strays.push(orphan);
    const leaderPid = child.pid!;

    await registry.register({
      resourceId: `agent:epoch-a:${leaderPid}`,
      kind: SESSION_RESOURCE_KIND.AGENT,
      owner: owner('crashed-instance'),
      handle: { type: 'pid', pid: leaderPid, killTree: true },
    });

    process.kill(leaderPid, 'SIGKILL');
    await once(child, 'exit');
    await settle(200);
    expect(alive(orphan), 'the descendant outlived its leader').toBe(true);

    await registry.sweepOrphans([]);
    await settle(400);

    expect(alive(orphan), 'the group is reaped from its recorded id alone').toBe(false);
  });
});
