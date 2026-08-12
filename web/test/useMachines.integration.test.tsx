/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineListItem } from '../src/api/machines.js';

const listControllableMachines = vi.fn<() => Promise<MachineListItem[]>>();

vi.mock('../src/api/machines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/machines.js')>();
  return {
    ...actual,
    listControllableMachines: () => listControllableMachines(),
  };
});

import { __resetMachinesForTests, useMachines } from '../src/hooks/useMachines.js';

function Probe() {
  const { machines, loaded, refetch } = useMachines();
  const state = !loaded ? 'loading' : machines[0]?.online ? 'online' : 'offline';
  return (
    <div>
      <span>{state}</span>
      <button type="button" onClick={() => { void refetch(); }}>refresh</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  __resetMachinesForTests();
  vi.clearAllMocks();
});

describe('useMachines refetch integration', () => {
  it('reloads the real shared resource and publishes offline-to-online presence', async () => {
    listControllableMachines
      .mockResolvedValueOnce([{
        serverId: 'node-1', refName: 'node-1', displayName: 'Node 1', online: false, execEnabled: true,
      }])
      .mockResolvedValueOnce([{
        serverId: 'node-1', refName: 'node-1', displayName: 'Node 1', online: true, execEnabled: true,
      }]);

    render(<Probe />);
    await screen.findByText('offline');
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await screen.findByText('online');

    expect(listControllableMachines).toHaveBeenCalledTimes(2);
  });
});
