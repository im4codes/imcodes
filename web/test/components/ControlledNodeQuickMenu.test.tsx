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
  it('lists every node and resolves eligibility without trusting OS metadata', async () => {
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

    // The whole row is the control: no separate per-row button any more.
    expect(screen.queryByRole('menuitem', { name: /remote_desktop\.open/ })).toBeNull();
    const rows = screen.getAllByRole('menuitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('aria-disabled')).toBeNull();
    expect(rows[1].getAttribute('aria-disabled')).toBe('true');
    expect(rows[1].getAttribute('title')).toBe('controlled_nodes.offline');
    // A reported OS label is descriptive. The legacy capability itself is the
    // understood Windows profile, so contradictory metadata cannot revoke it.
    expect(rows[2].getAttribute('aria-disabled')).toBeNull();

    // A disabled row does nothing and keeps the menu open.
    fireEvent.click(rows[1]);
    expect(onOpenRemoteDesktop).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(rows[0]);
    expect(onOpenRemoteDesktop).toHaveBeenCalledWith(online);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('explains an online node with remote exec disabled', async () => {
    machines = [node({ execEnabled: false })];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    const row = await screen.findByRole('menuitem', { name: /Desktop One/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toBe('controlled_nodes.exec_off');
  });

  it('keeps the wall entry and closes when it is chosen', async () => {
    machines = [node({})];
    const onWall = vi.fn();
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} onOpenRemoteDesktopWall={onWall} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /remote_desktop\.workspace_wall/ }));
    expect(onWall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('closes on an outside pointer press', async () => {
    machines = [node({})];
    render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('portals into the fullscreen element when it holds the trigger', async () => {
    machines = [node({})];
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => host });
    try {
      render(<ControlledNodeQuickMenu onOpenRemoteDesktop={() => {}} />, { container: host });
      fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
      const menu = await screen.findByRole('menu');
      expect(host.contains(menu)).toBe(true);
    } finally {
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      host.remove();
    }
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

describe('ControlledNodeQuickMenu group tabs', () => {
  const open = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'controlled_nodes.machines_title' }));
  };

  it('carries the same counted tabs as the machines page', async () => {
    // Same control, same numbers, both built from one place: a count here
    // that disagreed with the one on the machines tab would make people
    // distrust both.
    machines = [
      node({ serverId: 'own', displayName: 'Own', accessRole: 'owner', teamIds: ['team-1'], teamNames: ['Ops'] }),
      node({ serverId: 'their', displayName: 'Theirs', accessRole: 'viewer', teamIds: ['team-1'], teamNames: ['Ops'] }),
      node({ serverId: 'loose', displayName: 'Loose', accessRole: 'owner' }),
    ];
    render(<ControlledNodeQuickMenu />);
    open();

    const countOf = (id: string): string | null | undefined => document
      .querySelector(`[data-testid="controlled-node-quick-group-${id}"] .controlled-nodes-team-chip-count`)
      ?.textContent;
    await waitFor(() => expect(countOf('direct')).toBe('2'));
    expect(countOf('team-1')).toBe('2');
    expect(countOf('all')).toBe('3');

    // Your own grouped machine is right there on the default tab.
    expect(document.body.textContent).toContain('Own');
    expect(document.body.textContent).toContain('Loose');
    expect(document.body.textContent).not.toContain('Theirs');

    fireEvent.click(document.querySelector('[data-testid="controlled-node-quick-group-team-1"]') as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toContain('Theirs'));
    expect(document.body.textContent).toContain('Own');
    expect(document.body.textContent).not.toContain('Loose');
    // Rows under a group chip are still the click targets.
    expect(screen.getAllByRole('menuitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Own'),
      expect.stringContaining('Theirs'),
    ]);
  });

  it('offers no group tabs when nothing is grouped', () => {
    machines = [node({ serverId: 'loose', displayName: 'Loose', accessRole: 'owner' })];
    render(<ControlledNodeQuickMenu />);
    open();
    expect(document.querySelector('[data-testid="controlled-node-quick-group-direct"]')).toBeNull();
  });
});
