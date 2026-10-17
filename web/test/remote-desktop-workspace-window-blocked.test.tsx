/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentChildren } from 'preact';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';

/**
 * The third silent opener: the workspace's "+" picker has a per-row "open in its own window" button. It used the REAL window opener (not
 * mocked here) and used to drop a blocked window on the floor.
 */
const api = vi.hoisted(() => ({
  listControllableMachines: vi.fn(),
  getRemoteDesktopWall: vi.fn(),
  mutateRemoteDesktopWall: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../src/api/machines.js', () => ({ listControllableMachines: api.listControllableMachines }));
vi.mock('../src/api/remote-desktop-wall.js', () => ({
  getRemoteDesktopWall: api.getRemoteDesktopWall,
  mutateRemoteDesktopWall: api.mutateRemoteDesktopWall,
}));
vi.mock('../src/components/RemoteDesktopWallTile.js', () => ({ RemoteDesktopWallTile: () => <div /> }));
vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ id, children }: { id: string; children: ComponentChildren }) => <div data-testid={id}>{children}</div>,
}));
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({
  RemoteDesktopPanel: ({ machine }: { machine: { serverId: string } }) => <div data-testid={`panel-${machine.serverId}`} />,
}));

import type { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import { RemoteDesktopWindowBlockedNotice } from '../src/components/RemoteDesktopWindowBlockedNotice.js';
import { RemoteDesktopWorkspace } from '../src/components/RemoteDesktopWorkspace.js';
import { __resetMachinesForTests } from '../src/hooks/useMachines.js';
import { resetRemoteDesktopWindowNoticeForTests } from '../src/remote-desktop-window-notice.js';
import { createRemoteDesktopWorkspaceState, openRemoteDesktopWorkspaceHost } from '../src/remote-desktop-workspace-state.js';
import { stubDisplayMode } from './support/display-mode.js';

function machine(serverId: string) {
  return {
    serverId, refName: serverId, displayName: serverId.toUpperCase(), os: 'win', online: true, execEnabled: true,
    accessRole: 'owner' as const, capabilities: [REMOTE_DESKTOP_CAPABILITY],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetMachinesForTests();
});

describe('the workspace picker\'s open-in-its-own-window button', () => {
  it('tells the user when the browser blocks the window', async () => {
    resetRemoteDesktopWindowNoticeForTests();
    const displayMode = stubDisplayMode('browser');
    api.getRemoteDesktopWall.mockResolvedValue({ revision: 0, layout: 'grid', hostIds: [], hosts: [] });
    api.listControllableMachines.mockResolvedValue([machine('c')]);
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const manager = { connection: vi.fn(() => ({ releaseAll: vi.fn() })), releaseInput: vi.fn(), stop: vi.fn(), stopAll: vi.fn() } as unknown as RemoteDesktopConnectionManager;
    const state = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), machine('a'));
    try {
      render(<>
        <RemoteDesktopWorkspace
          state={state}
          manager={manager}
          allowStandaloneWindow
          onOpenHost={vi.fn()}
          onActivateTab={vi.fn()}
          onCloseHost={vi.fn()}
          onReorderHost={vi.fn()}
          onCloseWorkspace={vi.fn()}
        />
        <RemoteDesktopWindowBlockedNotice />
      </>);
      fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.workspace_add' }));
      await screen.findByRole('menu', { name: 'remote_desktop.workspace_picker' });
      const windowButton = await screen.findByRole('menuitem', { name: 'remote_desktop.open_new_window' });
      expect(screen.queryByTestId('remote-desktop-window-blocked')).toBeNull();
      fireEvent.click(windowButton);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(String(opened.mock.calls[0]![0])).toContain('remoteDesktopServer=c');
      expect((await screen.findByTestId('remote-desktop-window-blocked')).textContent).toContain('remote_desktop.window_blocked');
    } finally {
      displayMode.restore();
    }
  });
});
