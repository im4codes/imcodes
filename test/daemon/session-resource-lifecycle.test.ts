import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionResourceRegistry,
  type SessionResourceCleanup,
} from '../../src/daemon/session-resource-registry.js';

const roots: string[] = [];
const processGroups: number[] = [];
const owner = (sessionInstanceId = 'instance-a') => ({
  sessionName: 'deck_alpha_w1', sessionInstanceId, runtimeEpoch: 'epoch-a',
});

afterEach(async () => {
  for (const pid of processGroups.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already reclaimed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(now = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
  roots.push(directory);
  const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
  const registry = new SessionResourceRegistry({ directory, now: () => now, cleanup });
  return { registry, cleanup, directory };
}

describe('session resource lifecycle', () => {
  it('registers stable owner identity and releases every resource idempotently on session completion', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({ resourceId: 'mcp:101', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 101 } });
    await registry.register({ resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner(), handle: { type: 'tmux', name: 'deck_alpha_w1' } });
    await registry.register({ resourceId: 'browser:202', kind: 'browser', owner: owner(), handle: { type: 'pid', pid: 202 }, ttlMs: 1_000, idleTimeoutMs: 500 });
    await registry.register({ resourceId: 'container:abc', kind: 'container', owner: owner(), handle: { type: 'podman', containerId: 'abc' }, ttlMs: 1_000, idleTimeoutMs: 500 });

    expect((await registry.list()).map((item) => [item.kind, item.owner.sessionInstanceId])).toEqual([
      ['browser', 'instance-a'], ['container', 'instance-a'], ['mcp', 'instance-a'], ['tmux', 'instance-a'],
    ]);
    expect(await registry.releaseOwner(owner(), 'session_completed')).toMatchObject({ released: 4, failed: 0 });
    expect(await registry.releaseOwner(owner(), 'session_completed')).toMatchObject({ released: 0, failed: 0 });
    expect(cleanup).toHaveBeenCalledTimes(4);
  });

  it('startup orphan sweep preserves an exact live owner but cleans crash or owner-reuse leases', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({ resourceId: 'browser:old', kind: 'browser', owner: owner('old-instance'), handle: { type: 'pid', pid: 301 } });
    await registry.register({ resourceId: 'browser:live', kind: 'browser', owner: owner('live-instance'), handle: { type: 'pid', pid: 302 } });
    await registry.register({ resourceId: 'mcp:gone', kind: 'mcp', owner: { sessionName: 'deck_alpha_gone', sessionInstanceId: 'gone', runtimeEpoch: 'gone' }, handle: { type: 'pid', pid: 303 } });

    const swept = await registry.sweepOrphans([owner('live-instance')]);
    expect(swept).toMatchObject({ released: 2, preserved: 1, failed: 0 });
    expect((await registry.list()).map((item) => item.resourceId)).toEqual(['browser:live']);
    expect(cleanup.mock.calls.map(([record]) => record.resourceId).sort()).toEqual(['browser:old', 'mcp:gone']);
  });

  it('rebinds the same logical tmux pane to a successor epoch without permitting owner reuse', async () => {
    const { registry } = await fixture();
    const prior = owner();
    const successor = { ...prior, runtimeEpoch: 'epoch-b' };
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: prior,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    });
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: successor,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    })).resolves.toMatchObject({ owner: successor });
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner('reused-instance'),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    })).rejects.toThrow('session_resource_owner_conflict');
  });

  it('releases only child resources during an in-place tmux respawn', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({ resourceId: 'mcp:old', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 601 } });
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner(),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    });
    expect(await registry.releaseOwnerKinds(owner(), ['mcp', 'browser', 'container'], 'session_completed'))
      .toMatchObject({ released: 1, failed: 0 });
    expect((await registry.list()).map((record) => record.resourceId)).toEqual(['tmux:deck_alpha_w1']);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('expires browser/container by absolute or idle TTL while touch cannot extend the hard deadline', async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ttl-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const registry = new SessionResourceRegistry({ directory, now: () => now, cleanup });
    await registry.register({ resourceId: 'browser:ttl', kind: 'browser', owner: owner(), handle: { type: 'pid', pid: 401 }, ttlMs: 1_000, idleTimeoutMs: 400 });
    now = 1_300;
    await registry.touch('browser:ttl');
    now = 1_650;
    expect(await registry.sweepExpired()).toMatchObject({ released: 0 });
    now = 1_701;
    expect(await registry.sweepExpired()).toMatchObject({ released: 1 });

    await registry.register({ resourceId: 'container:ttl', kind: 'container', owner: owner(), handle: { type: 'podman', containerId: 'ttl' }, ttlMs: 500, idleTimeoutMs: 5_000 });
    now = 2_202;
    expect(await registry.sweepExpired()).toMatchObject({ released: 1 });
  });

  it('recovers a crash-left registry lock without allowing cross-owner release', async () => {
    const { registry, directory } = await fixture();
    await writeFile(join(directory, '.registry.lock'), JSON.stringify({ pid: 2_147_483_647, processStart: 'gone', token: 'stale' }));
    await registry.register({ resourceId: 'mcp:locked', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 501 } });
    await expect(registry.releaseResource('mcp:locked', owner('other'), 'session_completed'))
      .rejects.toThrow('session_resource_owner_mismatch');
    expect((await registry.list()).map((record) => record.resourceId)).toEqual(['mcp:locked']);
  });

  it.runIf(process.platform !== 'win32')('reclaims the full detached browser process group', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-tree-'));
    roots.push(directory);
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    if (!child.pid) throw new Error('spawn did not return pid');
    processGroups.push(child.pid);
    const registry = new SessionResourceRegistry({ directory });
    await registry.register({
      resourceId: `browser:${child.pid}`,
      kind: 'browser',
      owner: owner(),
      handle: { type: 'pid', pid: child.pid, killTree: true },
      ttlMs: 1_000,
      idleTimeoutMs: 500,
    });
    expect(await registry.releaseOwner(owner(), 'session_completed')).toMatchObject({ released: 1, failed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(-child.pid!, 0)).toThrow();
    processGroups.splice(processGroups.indexOf(child.pid), 1);
  });
});
