import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeSessionResourceRecords,
  registerMcpProcessResource,
  releaseSessionResource,
  startSessionResourceExpirySweep,
  sweepMemoryMcpCpu,
} from '../../src/daemon/session-resource-service.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import type { SessionResourceRecord } from '../../src/daemon/session-resource-registry.js';
import {
  MEMORY_MCP_WATCHDOG,
  SESSION_RESOURCE_RELEASE_REASON,
} from '../../shared/session-resource-lifecycle.js';

const owner = {
  sessionName: 'deck_resource_brain',
  sessionInstanceId: 'instance-a',
  runtimeEpoch: 'epoch-a',
};

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
});

function mcpRecord(resourceId: string): SessionResourceRecord {
  return {
    version: 1,
    resourceId,
    kind: 'mcp',
    owner,
    handle: { type: 'pid', pid: 42, processStart: 'registered-start' },
    createdAt: 1,
    lastUsedAt: 1,
  };
}

function dependencies(record: SessionResourceRecord, exactProcessCurrent: boolean | null) {
  return {
    listResources: vi.fn().mockResolvedValue([record]),
    sampleCpuMillis: vi.fn().mockResolvedValue(null),
    pidHandleIsCurrent: vi.fn().mockResolvedValue(exactProcessCurrent),
    releaseResource: vi.fn().mockResolvedValue({ released: 1, failed: 0 }),
  };
}

describe('memory MCP watchdog process identity', () => {
  it.each([
    ['transient CPU sampler failure while the exact MCP is alive', true],
    ['unverifiable process identity while the PID remains visible', null],
  ])('does not kill or restart on %s', async (_label, exactProcessCurrent) => {
    const record = mcpRecord(`mcp:sample-failure:${String(exactProcessCurrent)}`);
    const deps = dependencies(record, exactProcessCurrent);

    await sweepMemoryMcpCpu(10_000, deps);

    expect(deps.pidHandleIsCurrent).toHaveBeenCalledWith(record.handle);
    expect(deps.releaseResource).not.toHaveBeenCalled();
  });

  it('releases a stale record without restarting the owner after the exact MCP is confirmed gone', async () => {
    const record = mcpRecord('mcp:confirmed-missing');
    const deps = dependencies(record, false);

    await sweepMemoryMcpCpu(10_000, deps);

    expect(deps.releaseResource).toHaveBeenCalledWith(
      record.resourceId,
      owner,
      SESSION_RESOURCE_RELEASE_REASON.PROCESS_MISSING,
    );
  });

  it('does not restart when another sweep already released the missing resource', async () => {
    const record = mcpRecord('mcp:concurrent-release');
    const deps = dependencies(record, false);
    deps.releaseResource.mockResolvedValue({ released: 0, failed: 0 });

    await sweepMemoryMcpCpu(10_000, deps);

  });

  it('records sustained CPU without releasing the live MCP stdio generation', async () => {
    const record = mcpRecord('mcp:sustained-cpu');
    let cpuMs = 0;
    const reportSustainedCpu = vi.fn();
    const deps = {
      ...dependencies(record, true),
      sampleCpuMillis: vi.fn().mockImplementation(async () => {
        cpuMs += 1_000;
        return cpuMs;
      }),
      reportSustainedCpu,
    };

    for (let sample = 0; sample <= MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT; sample += 1) {
      await sweepMemoryMcpCpu(sample * 1_000, deps);
    }

    expect(reportSustainedCpu).toHaveBeenCalledOnce();
    expect(reportSustainedCpu).toHaveBeenCalledWith(record, 1);
    expect(deps.releaseResource).not.toHaveBeenCalled();
    expect('restartOwner' in deps).toBe(false);
  });

  it('terminates a supervised backend spinner so its stable bootstrap can replace it', async () => {
    const record = mcpRecord('mcp-backend:epoch-a:42');
    let cpuMs = 0;
    const deps = {
      ...dependencies(record, true),
      sampleCpuMillis: vi.fn().mockImplementation(async () => {
        cpuMs += 1_000;
        return cpuMs;
      }),
      reportSustainedCpu: vi.fn(),
    };

    for (let sample = 0; sample <= MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT; sample += 1) {
      await sweepMemoryMcpCpu(50_000 + sample * 1_000, deps);
    }

    expect(deps.releaseResource).toHaveBeenCalledOnce();
    expect(deps.releaseResource).toHaveBeenCalledWith(
      record.resourceId,
      owner,
      SESSION_RESOURCE_RELEASE_REASON.SUSTAINED_CPU,
    );
    expect(deps.reportSustainedCpu).not.toHaveBeenCalled();
  });
});

function session(name: string, state: SessionRecord['state']): SessionRecord {
  return {
    name,
    projectName: 'resource-project',
    role: 'w1',
    agentType: 'codex-sdk',
    projectDir: '/tmp/resource-project',
    state,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
  };
}

describe('periodic session resource orphan sweep', () => {
  it('keeps every live query state but excludes stopped/error owners', async () => {
    const records = [
      session('running', 'running'),
      session('idle', 'idle'),
      session('stopped', 'stopped'),
      session('error', 'error'),
    ];
    expect(activeSessionResourceRecords(records).map((record) => record.name)).toEqual(['running', 'idle']);

    vi.useFakeTimers();
    const dependencies = {
      sweepExpired: vi.fn().mockResolvedValue(undefined),
      sweepCpu: vi.fn().mockResolvedValue(undefined),
      orphanSweep: {
        listSessions: vi.fn(() => records),
        sweepOrphans: vi.fn().mockResolvedValue(undefined),
      },
    };
    const stop = startSessionResourceExpirySweep(10, dependencies);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(dependencies.orphanSweep.sweepOrphans).toHaveBeenCalledOnce();
      expect(dependencies.orphanSweep.sweepOrphans.mock.calls[0]?.[0].map((record: SessionRecord) => record.name))
        .toEqual(['running', 'idle', 'stopped', 'error']);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('does not grant orphan authority to the shared default used by controlled nodes', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    children.push(child);
    if (!child.pid) throw new Error('child pid unavailable');
    const resourceId = await registerMcpProcessResource(owner, child.pid, false, 'computer-use-mcp');
    const stop = startSessionResourceExpirySweep(10);
    try {
      // Leave enough time for the old shared default to lazy-import the empty
      // session store and run its destructive orphan pass. The fixed default
      // never imports or consults that store at all.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      stop();
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await releaseSessionResource(resourceId, owner).catch(() => {});
    }
  });

  it('preserves every owner when the daemon provider throws and still runs the other passes', async () => {
    vi.useFakeTimers();
    const reportError = vi.fn();
    const dependencies = {
      sweepExpired: vi.fn().mockResolvedValue(undefined),
      sweepCpu: vi.fn().mockResolvedValue(undefined),
      orphanSweep: {
        listSessions: vi.fn().mockRejectedValue(new Error('store unavailable')),
        sweepOrphans: vi.fn().mockResolvedValue(undefined),
      },
      reportError,
    };
    const stop = startSessionResourceExpirySweep(10, dependencies);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(dependencies.sweepExpired).toHaveBeenCalledOnce();
      expect(dependencies.orphanSweep.sweepOrphans).not.toHaveBeenCalled();
      expect(dependencies.sweepCpu).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith('orphan', expect.any(Error));
    } finally {
      stop();
    }
  });
});
