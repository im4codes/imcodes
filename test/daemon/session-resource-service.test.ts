import { describe, expect, it, vi } from 'vitest';
import { sweepMemoryMcpCpu } from '../../src/daemon/session-resource-service.js';
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
});
