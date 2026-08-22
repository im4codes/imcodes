/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import type { MachineListItem } from '../../src/api/machines.js';

const refetch = vi.fn(async (): Promise<MachineListItem[] | null> => null);
let machines: MachineListItem[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    machines,
    filtered: machines,
    loaded: true,
    loading: false,
    error: null,
    stale: false,
    refetch,
  }),
}));

import { ControlledNodeQuickMenu } from '../../src/components/ControlledNodeQuickMenu.js';

afterEach(() => {
  cleanup();
  machines = [];
  vi.clearAllMocks();
});

function node(overrides: Partial<MachineListItem>): MachineListItem {
  return {
    serverId: 'node-1',
    refName: 'desktop-one',
    displayName: 'Desktop One',
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner',
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
    ...overrides,
  };
}

describe('ControlledNodeQuickMenu', () => {
  it('lists every node and opens an eligible desktop without management', async () => {
    const online = node({});
    machines = [
      online,
      node({ serverId: 'node-2', refName: 'offline-two', displayName: 'Offline Two', online: false }),
      node({ serverId: 'node-3', refName: 'linux-three', displayName: 'Linux Three', os: 'linux' }),
    ];
    const onOpenRemoteDesktop = vi.fn();
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={onOpenRemoteDesktop} />);

    const trigger = screen.getByRole('button', { name: 'controlled_nodes.machines_title' });
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Desktop One')).toBeTruthy();
    expect(screen.getByText('Offline Two')).toBeTruthy();
    expect(screen.getByText('Linux Three')).toBeTruthy();

    const remoteButtons = screen.getAllByRole('menuitem', { name: /remote_desktop\.open/ });
    expect(remoteButtons).toHaveLength(3);
    expect((remoteButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((remoteButtons[1] as HTMLButtonElement).disabled).toBe(true);
    expect((remoteButtons[2] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(remoteButtons[0]);
    expect(onOpenRemoteDesktop).toHaveBeenCalledWith(online);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('closes on Escape and restores focus to the chevron', async () => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'controlled_nodes.machines_title' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
