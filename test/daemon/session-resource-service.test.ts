import { describe, expect, it, vi } from 'vitest';
import { sweepMemoryMcpCpu } from '../../src/daemon/session-resource-service.js';
import type { SessionResourceRecord } from '../../src/daemon/session-resource-registry.js';

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
    restartOwner: vi.fn().mockResolvedValue(undefined),
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
    expect(deps.restartOwner).not.toHaveBeenCalled();
  });

  it('releases and restarts only after the exact registered process is confirmed gone', async () => {
    const record = mcpRecord('mcp:confirmed-missing');
    const deps = dependencies(record, false);

    await sweepMemoryMcpCpu(10_000, deps);

    expect(deps.releaseResource).toHaveBeenCalledWith(record.resourceId, owner, 'process_missing');
    expect(deps.restartOwner).toHaveBeenCalledWith(owner, 'process_missing');
  });

  it('does not restart when another sweep already released the missing resource', async () => {
    const record = mcpRecord('mcp:concurrent-release');
    const deps = dependencies(record, false);
    deps.releaseResource.mockResolvedValue({ released: 0, failed: 0 });

    await sweepMemoryMcpCpu(10_000, deps);

    expect(deps.restartOwner).not.toHaveBeenCalled();
  });
});
