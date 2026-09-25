import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_HOSTED_RELEASE,
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

  it('age-gates known stopped owners but fail-safe preserves unknown remote owners', async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const registry = new SessionResourceRegistry({ directory, now: () => now, cleanup });
    const stoppedOwner = owner('stopped-instance');
    const remoteOwner = {
      sessionName: 'deck_remote_live',
      sessionInstanceId: 'remote-instance',
      runtimeEpoch: 'remote-epoch',
    };
    await registry.register({ resourceId: 'mcp:stopped', kind: 'mcp', owner: stoppedOwner, handle: { type: 'pid', pid: 301 } });
    await registry.register({ resourceId: 'mcp:remote', kind: 'mcp', owner: remoteOwner, handle: { type: 'pid', pid: 302 } });

    expect(await registry.sweepOrphans([], {
      eligibleOwners: [stoppedOwner],
      minimumAgeMs: 60_000,
    })).toMatchObject({ released: 0, preserved: 2 });

    now += 60_001;
    expect(await registry.sweepOrphans([], {
      eligibleOwners: [stoppedOwner],
      minimumAgeMs: 60_000,
    })).toMatchObject({ released: 1, preserved: 1, failed: 0 });
    expect((await registry.list()).map((record) => record.resourceId)).toEqual(['mcp:remote']);
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'mcp:stopped' }), 'orphaned');
  });

  it('preserves an active PID resource when process-identity sampling is uncertain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const pidHandleIsCurrent = vi.fn().mockResolvedValue(null);
    const registry = new SessionResourceRegistry({
      directory,
      now: () => 10_000,
      cleanup,
      pidHandleIsCurrent,
    });
    await registry.register({
      resourceId: 'mcp:uncertain',
      kind: 'mcp',
      owner: owner('live-instance'),
      handle: { type: 'pid', pid: 404, processStart: 'registered-start' },
    });

    expect(await registry.sweepOrphans([owner('live-instance')])).toMatchObject({
      released: 0,
      preserved: 1,
      failed: 0,
    });
    expect(pidHandleIsCurrent).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
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

  it('replaces a crash-left tmux owner only when live pane and owner identity prove the new authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    let liveIdentity = { paneId: '%1', sessionInstanceId: 'old-instance', runtimeEpoch: 'epoch-a' };
    const registry = new SessionResourceRegistry({
      directory,
      now: () => 1_000,
      cleanup,
      resolveTmuxIdentity: async () => liveIdentity,
    });
    const prior = owner('old-instance');
    const successor = { ...owner('new-instance'), runtimeEpoch: 'epoch-b' };
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: prior,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    });

    liveIdentity = { paneId: '%2', sessionInstanceId: 'new-instance', runtimeEpoch: 'epoch-b' };
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: successor,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%2' },
    })).resolves.toMatchObject({ owner: successor, handle: { paneId: '%2' } });
    expect(await registry.list()).toEqual([
      expect.objectContaining({ resourceId: 'tmux:deck_alpha_w1', owner: successor, handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%2' } }),
    ]);
    liveIdentity = { paneId: '%2', sessionInstanceId: 'foreign-instance', runtimeEpoch: 'epoch-a' };
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner('foreign-instance'),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%3' },
    })).rejects.toThrow('session_resource_owner_conflict');
    expect((await registry.list())[0]).toMatchObject({ owner: successor, handle: { paneId: '%2' } });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('accepts a recycled tmux pane id only when the live owner tuple matches the successor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    let liveIdentity = { paneId: '%0', sessionInstanceId: 'old-instance', runtimeEpoch: 'epoch-a' };
    const registry = new SessionResourceRegistry({
      directory,
      cleanup,
      resolveTmuxIdentity: async () => liveIdentity,
    });
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner('old-instance'),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%0' },
    });
    const successor = { ...owner('new-instance'), runtimeEpoch: 'epoch-b' };

    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: successor,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%0' },
    })).rejects.toThrow('session_resource_owner_conflict');
    liveIdentity = { paneId: '%0', sessionInstanceId: 'new-instance', runtimeEpoch: 'epoch-b' };
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: successor,
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%0' },
    })).resolves.toMatchObject({ owner: successor });
  });

  it('fails closed and releases the registry lock when live tmux identity lookup is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const registry = new SessionResourceRegistry({
      directory,
      cleanup,
      tmuxIdentityTimeoutMs: 5,
      resolveTmuxIdentity: async () => new Promise(() => {}),
    });
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner('old-instance'),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    });
    await expect(registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner('new-instance'),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%2' },
    })).rejects.toThrow('session_resource_owner_conflict');
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it('releases only child resources during an in-place tmux respawn', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({ resourceId: 'mcp:old', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 601 } });
    await registry.register({
      resourceId: 'tmux:deck_alpha_w1', kind: 'tmux', owner: owner(),
      handle: { type: 'tmux', name: 'deck_alpha_w1', paneId: '%1' },
    });
    expect(await registry.releaseOwnerKinds(owner(), ['mcp', 'browser', 'container'], 'session_completed', PROVIDER_HOSTED_RELEASE.REAP_ALL_EPOCHS))
      .toMatchObject({ released: 1, failed: 0 });
    expect((await registry.list()).map((record) => record.resourceId)).toEqual(['tmux:deck_alpha_w1']);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  // Production incident (Cx1, 2026-09-25): relaunching a codex-sdk session ran
  // this exact child cleanup under the old owner and SIGTERMed the MCP server
  // of the Codex thread the new runtime then resumed. Codex never respawns a
  // loaded thread's MCP server, so every IM tool call returned "Transport closed".
  it('keeps a provider-hosted MCP through relaunch child cleanup but still reaps runtime-bound children', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({
      resourceId: 'mcp-bootstrap:epoch-a:701', kind: 'mcp', owner: owner(),
      handle: { type: 'pid', pid: 701 }, lifetime: 'provider_host',
    });
    await registry.register({
      resourceId: 'mcp-backend:epoch-a:702', kind: 'mcp', owner: owner(),
      handle: { type: 'pid', pid: 702 }, lifetime: 'provider_host',
    });
    await registry.register({ resourceId: 'mcp:epoch-a:703', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 703 } });
    await registry.register({ resourceId: 'browser:epoch-a:704', kind: 'browser', owner: owner(), handle: { type: 'pid', pid: 704 } });

    expect(await registry.releaseOwnerKinds(owner(), ['mcp', 'browser', 'container', 'agent'], 'session_completed', PROVIDER_HOSTED_RELEASE.KEEP))
      .toMatchObject({ released: 2, failed: 0 });
    expect(cleanup.mock.calls.map(([record]) => record.resourceId).sort())
      .toEqual(['browser:epoch-a:704', 'mcp:epoch-a:703']);
    expect((await registry.list()).map((record) => record.resourceId))
      .toEqual(['mcp-backend:epoch-a:702', 'mcp-bootstrap:epoch-a:701']);
  });

  it('orphan sweep keeps a live provider-hosted MCP of a stopped owner and drops it only once its pid is gone', async () => {
    // A cron turn into a `stopped` codex-sdk session resumes its thread; the
    // sweep used to reap the thread's fresh MCP server after the 60s grace.
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const pidHandleIsCurrent = vi.fn().mockResolvedValue(true);
    const registry = new SessionResourceRegistry({ directory, now: () => 100_000, cleanup, pidHandleIsCurrent });
    const stopped = owner('stopped-instance');
    await registry.register({
      resourceId: 'mcp-bootstrap:epoch-a:801', kind: 'mcp', owner: stopped,
      handle: { type: 'pid', pid: 801, processStart: 'start-801' }, lifetime: 'provider_host',
    });
    await registry.register({
      resourceId: 'mcp:epoch-a:802', kind: 'mcp', owner: stopped,
      handle: { type: 'pid', pid: 802, processStart: 'start-802' },
    });

    expect(await registry.sweepOrphans([], { eligibleOwners: [stopped] }))
      .toMatchObject({ released: 1, preserved: 1, failed: 0 });
    expect(cleanup.mock.calls.map(([record]) => record.resourceId)).toEqual(['mcp:epoch-a:802']);

    pidHandleIsCurrent.mockResolvedValue(false);
    expect(await registry.sweepOrphans([], { eligibleOwners: [stopped] }))
      .toMatchObject({ released: 1, preserved: 0, failed: 0 });
    expect(await registry.list()).toEqual([]);
  });

  // Re-audit P1: a hosted child keeps the epoch its host thread was loaded
  // under. After a relaunch (epoch-a -> epoch-b) every path that ends this
  // instance's use of the thread must still reap it; only a relaunch that
  // resumes the SAME loaded thread may keep it.
  describe('provider-hosted MCP registered under an earlier epoch of the same instance', () => {
    const epoch = (runtimeEpoch: string, sessionInstanceId = 'instance-a') => ({
      sessionName: 'deck_alpha_w1', sessionInstanceId, runtimeEpoch,
    });
    async function relaunchedFixture() {
      const fx = await fixture();
      // Thread loaded under epoch-a; the session has since been relaunched to epoch-b.
      await fx.registry.register({
        resourceId: 'mcp-bootstrap:epoch-a:1101', kind: 'mcp', owner: epoch('epoch-a'),
        handle: { type: 'pid', pid: 1101 }, lifetime: 'provider_host',
      });
      await fx.registry.register({
        resourceId: 'mcp-backend:epoch-a:1102', kind: 'mcp', owner: epoch('epoch-a'),
        handle: { type: 'pid', pid: 1102 }, lifetime: 'provider_host',
      });
      // Must never be touched: another instance of the same name, and another session.
      await fx.registry.register({
        resourceId: 'mcp-bootstrap:other-instance:1103', kind: 'mcp', owner: epoch('epoch-z', 'instance-z'),
        handle: { type: 'pid', pid: 1103 }, lifetime: 'provider_host',
      });
      await fx.registry.register({
        resourceId: 'mcp-bootstrap:other-session:1104', kind: 'mcp',
        owner: { sessionName: 'deck_beta_w1', sessionInstanceId: 'instance-a', runtimeEpoch: 'epoch-a' },
        handle: { type: 'pid', pid: 1104 }, lifetime: 'provider_host',
      });
      return fx;
    }
    const survivors = ['mcp-bootstrap:other-instance:1103', 'mcp-bootstrap:other-session:1104'];

    it('stop/delete (releaseOwner at the current epoch) reaps the old-epoch hosted pair', async () => {
      const { registry, cleanup } = await relaunchedFixture();
      expect(await registry.releaseOwner(epoch('epoch-b'), 'session_completed')).toMatchObject({ released: 2, failed: 0 });
      expect(cleanup.mock.calls.map(([record]) => record.resourceId).sort())
        .toEqual(['mcp-backend:epoch-a:1102', 'mcp-bootstrap:epoch-a:1101']);
      expect((await registry.list()).map((record) => record.resourceId)).toEqual(survivors);
    });

    it('a reset / agent-switch relaunch (REAP_ALL_EPOCHS) reaps the abandoned thread\'s hosted pair', async () => {
      const { registry } = await relaunchedFixture();
      expect(await registry.releaseOwnerKinds(epoch('epoch-b'), ['mcp'], 'session_completed', PROVIDER_HOSTED_RELEASE.REAP_ALL_EPOCHS))
        .toMatchObject({ released: 2, failed: 0 });
      expect((await registry.list()).map((record) => record.resourceId)).toEqual(survivors);
    });

    it('a relaunch that resumes the same loaded thread (KEEP) reaps no hosted child of any epoch', async () => {
      const { registry, cleanup } = await relaunchedFixture();
      await registry.register({
        resourceId: 'mcp-bootstrap:epoch-b:1105', kind: 'mcp', owner: epoch('epoch-b'),
        handle: { type: 'pid', pid: 1105 }, lifetime: 'provider_host',
      });
      expect(await registry.releaseOwnerKinds(epoch('epoch-b'), ['mcp'], 'session_completed', PROVIDER_HOSTED_RELEASE.KEEP))
        .toMatchObject({ released: 0, failed: 0 });
      expect(cleanup).not.toHaveBeenCalled();
      expect(await registry.list()).toHaveLength(5);
    });

    it('epoch change / daemon restart: the sweep reaps a dead old-epoch hosted row but keeps a live one', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
      roots.push(directory);
      const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
      const dead = new Set([1201]);
      let now = 1_000;
      const registry = new SessionResourceRegistry({
        directory, now: () => now, cleanup,
        pidHandleIsCurrent: vi.fn(async (handle) => !dead.has(handle.pid)),
      });
      for (const pid of [1201, 1202]) {
        await registry.register({
          resourceId: `mcp-bootstrap:epoch-a:${pid}`, kind: 'mcp', owner: epoch('epoch-a'),
          handle: { type: 'pid', pid, processStart: `start-${pid}` }, lifetime: 'provider_host',
        });
      }
      now += 60_001;
      // The session store only knows the CURRENT epoch; the row keeps its load epoch.
      const current = epoch('epoch-b');
      expect(await registry.sweepOrphans([current], { eligibleOwners: [current], minimumAgeMs: 60_000 }))
        .toMatchObject({ released: 1, preserved: 1, failed: 0 });
      expect(cleanup.mock.calls.map(([record]) => record.resourceId)).toEqual(['mcp-bootstrap:epoch-a:1201']);
      expect((await registry.list()).map((record) => record.resourceId)).toEqual(['mcp-bootstrap:epoch-a:1202']);
    });

    it('rejects a release without an explicit hosted policy value', async () => {
      const { registry } = await fixture();
      await expect(registry.releaseOwnerKinds(owner(), ['mcp'], 'session_completed', 'maybe' as never))
        .rejects.toThrow('invalid_session_resource_release');
    });
  });

  it('still releases a provider-hosted MCP on explicit session stop/delete', async () => {
    const { registry, cleanup } = await fixture();
    await registry.register({
      resourceId: 'mcp-bootstrap:epoch-a:901', kind: 'mcp', owner: owner(),
      handle: { type: 'pid', pid: 901 }, lifetime: 'provider_host',
    });
    expect(await registry.releaseOwner(owner(), 'session_completed')).toMatchObject({ released: 1, failed: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects an unknown lifetime and provider_host on anything but an MCP pid, including stored records', async () => {
    const { registry, directory } = await fixture();
    await expect(registry.register({
      resourceId: 'mcp:x', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 11 }, lifetime: 'forever' as never,
    })).rejects.toThrow('invalid_session_resource_registration');
    await expect(registry.register({
      resourceId: 'browser:x', kind: 'browser', owner: owner(), handle: { type: 'pid', pid: 12 }, lifetime: 'provider_host',
    })).rejects.toThrow('session_resource_lifetime_not_supported');
    await writeFile(join(directory, 'forged.json'), JSON.stringify({
      version: 1, resourceId: 'mcp:forged', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 13 },
      createdAt: 1, lastUsedAt: 1, lifetime: 'forever',
    }));
    expect(await registry.list()).toEqual([]);
  });

  it('records each MCP release with target pid, reason and owner in the lifecycle log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-resource-ledger-'));
    roots.push(directory);
    const logPath = join(directory, 'logs', 'mcp-lifecycle.log');
    const cleanup = vi.fn<SessionResourceCleanup>(async () => {});
    const registry = new SessionResourceRegistry({ directory, now: () => 1_000, cleanup, lifecycleLogPath: logPath });
    await registry.register({ resourceId: 'mcp:epoch-a:1001', kind: 'mcp', owner: owner(), handle: { type: 'pid', pid: 1001 } });
    await registry.register({ resourceId: 'browser:epoch-a:1002', kind: 'browser', owner: owner(), handle: { type: 'pid', pid: 1002 } });

    await registry.releaseOwner(owner(), 'session_completed');

    const events = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({
      event: 'resource_released',
      resourceId: 'mcp:epoch-a:1001',
      targetPid: 1001,
      reason: 'session_completed',
      outcome: 'released',
      lifetime: 'runtime',
      session: 'deck_alpha_w1',
      sessionInstanceId: 'instance-a',
      runtimeEpoch: 'epoch-a',
    })]);
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
