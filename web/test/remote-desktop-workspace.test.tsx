/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentChildren } from 'preact';

const api = vi.hoisted(() => ({
  listControllableMachines: vi.fn(),
  getRemoteDesktopWall: vi.fn(),
  mutateRemoteDesktopWall: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${Object.values(values).join(':')}`
      : key,
  }),
}));

vi.mock('../src/api/machines.js', () => ({
  listControllableMachines: api.listControllableMachines,
}));

vi.mock('../src/api/remote-desktop-wall.js', () => ({
  getRemoteDesktopWall: api.getRemoteDesktopWall,
  mutateRemoteDesktopWall: api.mutateRemoteDesktopWall,
}));

vi.mock('../src/components/RemoteDesktopWallTile.js', () => ({
  RemoteDesktopWallTile: ({ host }: {
    host: { hostId: string; displayName: string };
  }) => <div>{`wall:${host.displayName}`}</div>,
}));

vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ id, children }: { id: string; children: ComponentChildren }) => (
    <div data-testid={id}>{children}</div>
  ),
}));

vi.mock('../src/components/RemoteDesktopPanel.js', () => ({
  canOpenRemoteDesktop: (machine: { online: boolean }) => machine.online,
  RemoteDesktopPanel: ({ machine, active, inputActive }: {
    machine: { serverId: string };
    active: boolean;
    inputActive: boolean;
  }) => <div data-testid={`panel-${machine.serverId}`}>{String(active)}:{String(inputActive)}</div>,
}));

import type { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import { RemoteDesktopWorkspace } from '../src/components/RemoteDesktopWorkspace.js';
import {
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
} from '../src/remote-desktop-workspace-state.js';

function machine(serverId: string) {
  return {
    serverId,
    refName: serverId,
    displayName: serverId.toUpperCase(),
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner' as const,
    capabilities: ['remote-desktop-v1' as const],
  };
}

function setupManager() {
  const events: string[] = [];
  const releaseAll = vi.fn(() => events.push('release:a'));
  const manager = {
    connection: vi.fn(() => ({ releaseAll })),
    releaseInput: vi.fn(() => releaseAll()),
    stop: vi.fn((hostKey: string) => events.push(`stop:${hostKey}`)),
    stopAll: vi.fn(() => events.push('stop:all')),
  } as unknown as RemoteDesktopConnectionManager;
  return { manager, events, releaseAll };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

api.getRemoteDesktopWall.mockResolvedValue({ revision: 0, layout: 'grid', hostIds: [], hosts: [] });

describe('RemoteDesktopWorkspace', () => {
  it('keeps sibling presentations mounted and releases active input before tab transfer', () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    state = openRemoteDesktopWorkspaceHost(state, machine('b'));
    const { manager, events } = setupManager();
    const activate = vi.fn((tabId: string) => events.push(`activate:${tabId}`));
    const reorder = vi.fn();
    render(<RemoteDesktopWorkspace
      state={state}
      manager={manager}
      onOpenHost={vi.fn()}
      onActivateTab={activate}
      onCloseHost={vi.fn()}
      onReorderHost={reorder}
      onCloseWorkspace={vi.fn()}
    />);

    expect(screen.getByTestId('panel-a').textContent).toBe('false:false');
    expect(screen.getByTestId('panel-b').textContent).toBe('true:true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'B' }), { key: 'ArrowLeft' });
    expect(events).toEqual(['release:a', 'activate:a']);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'B' }), { key: 'ArrowLeft', altKey: true });
    expect(reorder).toHaveBeenCalledWith('b', -1);
  });

  it('stops only the exact host selected by its integrated tab close control', () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    state = openRemoteDesktopWorkspaceHost(state, machine('b'));
    const { manager, events } = setupManager();
    const closeHost = vi.fn();
    render(<RemoteDesktopWorkspace
      state={state}
      manager={manager}
      onOpenHost={vi.fn()}
      onActivateTab={vi.fn()}
      onCloseHost={closeHost}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.workspace_close_tab:B' }));
    expect(events).toEqual(['stop:b']);
    expect(closeHost).toHaveBeenCalledWith('b');
  });

  it('keeps the sole manager owner alive when closing a tab still represented on the wall', async () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    const { manager } = setupManager();
    render(<RemoteDesktopWorkspace
      state={state}
      manager={manager}
      onOpenHost={vi.fn()}
      onActivateTab={vi.fn()}
      onCloseHost={vi.fn()}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
      wallHostKeys={new Set(['a'])}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.workspace_close_tab:A' }));
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it('routes the mobile selector through the same release-before-activate action', () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    state = openRemoteDesktopWorkspaceHost(state, machine('b'));
    const { manager, events } = setupManager();
    render(<RemoteDesktopWorkspace
      state={state}
      manager={manager}
      onOpenHost={vi.fn()}
      onActivateTab={(tabId) => events.push(`activate:${tabId}`)}
      onCloseHost={vi.fn()}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
    />);

    const selector = screen.getByLabelText('remote_desktop.workspace_select') as HTMLSelectElement;
    selector.value = 'a';
    fireEvent.input(selector);
    expect(events).toEqual(['release:a', 'activate:a']);
  });

  it('opens a picker selection through the shared upsert callback', async () => {
    api.listControllableMachines.mockResolvedValue([machine('c')]);
    const { manager } = setupManager();
    const openHost = vi.fn();
    const state = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), machine('a'));
    render(<RemoteDesktopWorkspace
      state={state}
      manager={manager}
      onOpenHost={openHost}
      onActivateTab={vi.fn()}
      onCloseHost={vi.fn()}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.workspace_add' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /C/ })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /C/ }));
    expect(openHost).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'c' }));
  });

  it('renders only the compact tab strip and keeps the add control adjacent to it', () => {
    let state = createRemoteDesktopWorkspaceState();
    state = openRemoteDesktopWorkspaceHost(state, machine('a'));
    state = openRemoteDesktopWorkspaceHost(state, machine('b'));
    const { manager } = setupManager();
    const props = {
      state,
      manager,
      onOpenHost: vi.fn(),
      onActivateTab: vi.fn(),
      onCloseHost: vi.fn(),
      onReorderHost: vi.fn(),
      onCloseWorkspace: vi.fn(),
    };
    const result = render(<RemoteDesktopWorkspace {...props} />);
    expect(screen.getByTestId('panel-a')).toBeDefined();
    expect(screen.getByTestId('panel-b')).toBeDefined();
    expect(result.container.querySelector('.remote-desktop-workspace-header')).toBeNull();
    expect(result.container.querySelector('.remote-desktop-minimized-dock')).toBeNull();
    const tabbar = result.container.querySelector('.remote-desktop-workspace-tabbar');
    const tablist = tabbar?.querySelector('[role="tablist"]');
    const add = screen.getByRole('button', { name: 'remote_desktop.workspace_add' });
    expect(tablist?.nextElementSibling).toBe(add);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.stopAll).not.toHaveBeenCalled();
  });
});
