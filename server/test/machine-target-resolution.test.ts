import { describe, expect, it, vi } from 'vitest';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { resolveMachineTargetServerId } from '../src/share/machine-access.js';

function fakeDb(rows: Array<{ id: string; node_id: string | null; node_role: string | null; revoked_at: number | null }>) {
  return { query: vi.fn().mockResolvedValue(rows) } as never;
}

describe('machine target reference resolution', () => {
  it('maps a canonical controlled-node id to its server id', async () => {
    const query = vi.fn().mockResolvedValue([
      { id: 'server-1', node_id: '8570247167', node_role: NODE_ROLE.CONTROLLED, revoked_at: null },
    ]);
    const db = { query } as never;

    await expect(resolveMachineTargetServerId(db, '8570247167')).resolves.toBe('server-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining("node_role = 'controlled'"), ['8570247167']);
  });

  it('fails closed for blank or unknown references', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const db = { query } as never;

    await expect(resolveMachineTargetServerId(db, '   ')).resolves.toBeNull();
    await expect(resolveMachineTargetServerId(db, 'unknown-target')).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ['revoked canonical node', [
      { id: 'server-1', node_id: '8570247167', node_role: NODE_ROLE.CONTROLLED, revoked_at: 123 },
    ]],
    ['revoked exact id with active alias collision', [
      { id: '8570247167', node_id: null, node_role: 'full', revoked_at: 123 },
      { id: 'server-1', node_id: '8570247167', node_role: NODE_ROLE.CONTROLLED, revoked_at: null },
    ]],
    ['active exact id with distinct canonical alias collision', [
      { id: '8570247167', node_id: null, node_role: 'full', revoked_at: null },
      { id: 'server-1', node_id: '8570247167', node_role: NODE_ROLE.CONTROLLED, revoked_at: null },
    ]],
  ])('fails closed for %s', async (_name, rows) => {
    await expect(resolveMachineTargetServerId(fakeDb(rows), '8570247167')).resolves.toBeNull();
  });
});
