import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_RESOURCE_LIFETIME } from '../../shared/session-resource-lifecycle.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const isWin = process.platform === 'win32';
const home = mkdtempSync(join(tmpdir(), 'imcodes-shared-provider-lease-'));
let service: typeof import('../../src/daemon/session-resource-service.js');
let agentRes: typeof import('../../src/agent/providers/agent-process-resource.js');
let registryMod: typeof import('../../src/daemon/session-resource-registry.js');
const children: ChildProcess[] = [];

beforeAll(async () => {
  vi.stubEnv('IMCODES_HOME', home);
  vi.resetModules();
  service = await import('../../src/daemon/session-resource-service.js');
  agentRes = await import('../../src/agent/providers/agent-process-resource.js');
  registryMod = await import('../../src/daemon/session-resource-registry.js');
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function exited(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

function listRegistryFiles(): Array<Record<string, unknown>> {
  const dir = join(home, 'session-resources');
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe.skipIf(isWin)('shared-provider process resource lease & orphan sweep (real processes)', () => {
  it('registers a daemon-shared lease kept alive across individual session teardown, and releases on process exit', async () => {
    const sharedChild = sleeper();
    const sessionChild = sleeper();

    const sharedLease = agentRes.bindSharedProviderProcessResource('cursor-headless', sharedChild);
    await service.registerAgentProcessResource({
      sessionName: 'deck_shared_s1_w1',
      sessionInstanceId: 'inst-s1',
      runtimeEpoch: 'epoch-s1',
    }, sessionChild.pid!);

    await vi.waitFor(() => {
      const records = listRegistryFiles();
      expect(records.some((r) => String(r.resourceId).startsWith('agent-shared:cursor-headless:') && r.lifetime === SESSION_RESOURCE_LIFETIME.SHARED_PROVIDER)).toBe(true);
      expect(records.some((r) => String(r.resourceId).startsWith('agent:epoch-s1:'))).toBe(true);
    });

    // Ending session 1 releases ONLY session 1's child, leaving the shared provider process alive.
    await service.releaseSessionResources({
      name: 'deck_shared_s1_w1',
      sessionInstanceId: 'inst-s1',
      runtimeEpoch: 'epoch-s1',
      state: 'idle',
    } as unknown as SessionRecord);

    expect(await exited(sessionChild)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(sharedChild)).toBe(true);

    // Explicitly releasing (or exiting) removes the shared lease from disk.
    await sharedLease.release();
    await vi.waitFor(() => {
      const records = listRegistryFiles();
      expect(records.some((r) => String(r.resourceId).startsWith('agent-shared:cursor-headless:'))).toBe(false);
    });
  });

  it('reaps orphaned shared-provider process groups when owning daemon is dead while preserving live-daemon shared groups', async () => {
    const liveShared = sleeper();
    const orphanedShared = sleeper();

    // Live daemon lease (bound to current live test process)
    const liveLease = agentRes.bindSharedProviderProcessResource('cursor-headless', liveShared);
    await vi.waitFor(() => {
      expect(listRegistryFiles().some((r) => (r.handle as { pid?: number })?.pid === liveShared.pid)).toBe(true);
    });

    // Simulate a crashed earlier daemon's orphaned shared-provider record on disk.
    const registry = new registryMod.SessionResourceRegistry({ directory: join(home, 'session-resources') });
    await registry.register({
      resourceId: `agent-shared:cursor-headless:dead-daemon:${orphanedShared.pid}`,
      kind: 'agent',
      lifetime: SESSION_RESOURCE_LIFETIME.SHARED_PROVIDER,
      owner: {
        sessionName: '__provider__:cursor-headless',
        sessionInstanceId: 'daemon:999999:000-dead-daemon-start',
        runtimeEpoch: 'dead-daemon',
      },
      handle: {
        type: 'pid',
        pid: orphanedShared.pid!,
        killTree: true,
      },
    });

    const sweep = await service.sweepOrphanedSessionResources([]);
    expect(sweep.released).toBeGreaterThanOrEqual(1);
    expect(await exited(orphanedShared)).toBe(true);
    expect(alive(liveShared)).toBe(true);

    await liveLease.release();
  });
});
