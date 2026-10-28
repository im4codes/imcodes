import { describe, expect, it, vi } from 'vitest';
import { resolveMachineTargetServerId } from '../src/share/machine-access.js';

describe('machine target reference resolution', () => {
  it('maps a canonical controlled-node id to its server id', async () => {
    const queryOne = vi.fn().mockResolvedValue({ id: 'server-1' });
    const db = { queryOne } as never;

    await expect(resolveMachineTargetServerId(db, '8570247167')).resolves.toBe('server-1');
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("node_role = 'controlled'"), ['8570247167']);
  });

  it('fails closed for blank or unknown references', async () => {
    const queryOne = vi.fn().mockResolvedValue(null);
    const db = { queryOne } as never;

    await expect(resolveMachineTargetServerId(db, '   ')).resolves.toBeNull();
    await expect(resolveMachineTargetServerId(db, 'unknown-target')).resolves.toBeNull();
    expect(queryOne).toHaveBeenCalledOnce();
  });
});
