/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '@shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '@shared/remote-desktop-platform.js';

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
vi.mock('../src/api/machines.js', () => ({ listControllableMachines: api.listControllableMachines }));
vi.mock('../src/api/remote-desktop-wall.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRemoteDesktopWall: api.getRemoteDesktopWall,
  mutateRemoteDesktopWall: api.mutateRemoteDesktopWall,
}));
vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ id, children }: { id: string; children: ComponentChildren }) => <div data-testid={id}>{children}</div>,
}));
vi.mock('../src/components/RemoteDesktopWallTile.js', () => ({
  RemoteDesktopWallTile: ({ host, retryGeneration, onRetryableChange, onOpen, onRemove }: {
    host: { hostId: string; displayName: string };
    retryGeneration: number;
    onRetryableChange(hostId: string, retryable: boolean): void;
    onOpen(host: unknown): void;
    onRemove(hostId: string): void;
  }) => <div data-testid={`tile-${host.hostId}`}>
    <button type="button" onClick={() => onOpen(host)}>{`open:${host.displayName}`}</button>
    <button type="button" onClick={() => onRemove(host.hostId)}>{`remove:${host.displayName}`}</button>
    <button type="button" onClick={() => onRetryableChange(host.hostId, true)}>{`fail:${host.displayName}`}</button>
    <span data-testid={`retry-generation-${host.hostId}`}>{retryGeneration}</span>
  </div>,
}));

import { RemoteDesktopWall } from '../src/components/RemoteDesktopWall.js';
import type { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';

const wallCss = readFileSync(
  resolve(__dirname, '../src/components/remote-desktop-workspace.css'),
  'utf8',
);

function machine(id: string) {
  return {
    hostId: id, remoteDesktopHostId: id, serverId: id, refName: id,
    displayName: id.toUpperCase(), online: true, execEnabled: true,
    accessRole: 'owner' as const, capabilities: [REMOTE_DESKTOP_CAPABILITY],
  };
}

function macMachine(id: string, complete: boolean) {
  return {
    ...machine(id),
    os: complete ? 'mac' : 'win',
    capabilities: complete ? [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ] : [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
    ],
  };
}

describe('RemoteDesktopWall', () => {
  beforeEach(() => {
    window.localStorage.removeItem('imcodes.remoteDesktopWall.mobileColumns');
    api.getRemoteDesktopWall.mockResolvedValue({ revision: 0, layout: 'grid', hostIds: [], hosts: [] });
    api.listControllableMachines.mockResolvedValue([machine('a'), machine('b')]);
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('starts as an independent four-slot canvas and always reserves one add slot', async () => {
    const manager = { stop: vi.fn() } as unknown as RemoteDesktopConnectionManager;
    const result = render(<RemoteDesktopWall
      manager={manager}
      retainedHostKeys={new Set()}
      onOpenHost={vi.fn()}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'remote_desktop.wall_add' })).toHaveLength(4));
    expect(result.container.querySelector('.remote-desktop-workspace')).toBeNull();

    api.getRemoteDesktopWall.mockResolvedValueOnce({
      revision: 2, layout: 'grid', hostIds: ['a', 'b'], hosts: [machine('a'), machine('b')],
    });
    const second = render(<RemoteDesktopWall
      manager={manager}
      retainedHostKeys={new Set()}
      onOpenHost={vi.fn()}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);
    await waitFor(() => expect(second.container.querySelectorAll('.remote-desktop-wall-add-slot')).toHaveLength(2));
  });

  it('adds through CAS, opens full management on left click, and removes only the selected membership', async () => {
    const initial = { revision: 3, layout: 'grid' as const, hostIds: ['a'], hosts: [machine('a')] };
    api.getRemoteDesktopWall.mockResolvedValue(initial);
    api.mutateRemoteDesktopWall.mockImplementation(async (mutation: { operation: string; hostIds: string[] }) => ({
      revision: 4,
      layout: 'grid',
      hostIds: mutation.hostIds,
      hosts: mutation.hostIds.map(machine),
    }));
    const openHost = vi.fn();
    const manager = { stop: vi.fn() } as unknown as RemoteDesktopConnectionManager;
    render(<RemoteDesktopWall
      manager={manager}
      retainedHostKeys={new Set()}
      onOpenHost={openHost}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);
    fireEvent.click(await screen.findByText('open:A'));
    expect(openHost).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'a' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'remote_desktop.wall_add' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /B/ }));
    await waitFor(() => expect(api.mutateRemoteDesktopWall).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'add', expectedRevision: 3, hostIds: ['a', 'b'],
    })));

    fireEvent.click(screen.getByText('remove:A'));
    await waitFor(() => expect(manager.stop).toHaveBeenCalledWith('a'));
  });

  it('uses the real capability gate: complete macOS opens and incomplete macOS stays absent', async () => {
    api.listControllableMachines.mockResolvedValue([
      macMachine('mac-complete', true),
      macMachine('mac-incomplete', false),
    ]);
    render(<RemoteDesktopWall
      manager={{ stop: vi.fn() } as unknown as RemoteDesktopConnectionManager}
      retainedHostKeys={new Set()}
      onOpenHost={vi.fn()}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'remote_desktop.wall_add' }))[0]);
    expect(await screen.findByRole('button', { name: /MAC-COMPLETE/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /MAC-INCOMPLETE/ })).toBeNull();
  });

  it('enables global retry only for tiles that reported a retryable disconnect', async () => {
    api.getRemoteDesktopWall.mockResolvedValue({
      revision: 2, layout: 'grid', hostIds: ['a'], hosts: [machine('a')],
    });
    render(<RemoteDesktopWall
      manager={{ stop: vi.fn() } as unknown as RemoteDesktopConnectionManager}
      retainedHostKeys={new Set()}
      onOpenHost={vi.fn()}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);
    const retryAll = await screen.findByRole('button', {
      name: 'remote_desktop.wall_retry_all:0',
    });
    expect((retryAll as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'fail:A' }));
    await waitFor(() => expect((screen.getByRole('button', {
      name: 'remote_desktop.wall_retry_all:1',
    }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.wall_retry_all:1' }));
    expect(screen.getByTestId('retry-generation-a').textContent).toBe('1');
  });

  it('offers a dedicated browser-window handoff from the wall titlebar', async () => {
    const openStandalone = vi.fn();
    render(<RemoteDesktopWall
      manager={{ stop: vi.fn() } as unknown as RemoteDesktopConnectionManager}
      retainedHostKeys={new Set()}
      onOpenStandalone={openStandalone}
      onOpenHost={vi.fn()}
      onHostKeysChange={vi.fn()}
      onClose={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole('button', {
      name: 'remote_desktop.wall_open_new_window',
    }));
    expect(openStandalone).toHaveBeenCalledTimes(1);
  });

  it('defaults mobile layout to one column and remembers an explicit two-column choice', async () => {
    api.getRemoteDesktopWall.mockResolvedValue({
      revision: 3,
      layout: 'grid',
      hostIds: ['a', 'b', 'c'],
      hosts: [machine('a'), machine('b'), machine('c')],
    });
    const props = {
      manager: { stop: vi.fn() } as unknown as RemoteDesktopConnectionManager,
      retainedHostKeys: new Set<string>(),
      onOpenHost: vi.fn(),
      onHostKeysChange: vi.fn(),
      onClose: vi.fn(),
    };
    const first = render(<RemoteDesktopWall {...props} />);
    const grid = await waitFor(() => {
      const element = first.container.querySelector('.remote-desktop-wall-grid');
      expect(element).toBeTruthy();
      return element!;
    });

    expect(grid.getAttribute('data-mobile-columns')).toBe('1');
    expect((grid as HTMLElement).style.getPropertyValue('--remote-desktop-wall-columns')).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.wall_use_two_columns' }));
    expect(grid.getAttribute('data-mobile-columns')).toBe('2');
    expect(window.localStorage.getItem('imcodes.remoteDesktopWall.mobileColumns')).toBe('2');
    expect(screen.getByRole('button', { name: 'remote_desktop.wall_use_one_column' })).toBeDefined();

    first.unmount();
    const restored = render(<RemoteDesktopWall {...props} />);
    await waitFor(() => expect(
      restored.container.querySelector('.remote-desktop-wall-grid')?.getAttribute('data-mobile-columns'),
    ).toBe('2'));
  });

  it('packs mobile rows at the top and uses compact spacing in two-column mode', () => {
    const mobileCss = wallCss.slice(wallCss.indexOf('@media (max-width: 700px)'));
    expect(mobileCss).toMatch(/\.remote-desktop-wall-grid\s*\{[^}]*min-height:\s*0;[^}]*grid-auto-rows:\s*auto;[^}]*align-content:\s*start;/s);
    expect(mobileCss).toMatch(/\.remote-desktop-wall-grid\[data-mobile-columns="1"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(mobileCss).toMatch(/\.remote-desktop-wall-grid\[data-mobile-columns="2"\]\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*gap:\s*4px;/s);
    expect(mobileCss).toMatch(/data-mobile-columns="2"\]\s+\.remote-desktop-wall-tile-title\s*\{[^}]*min-height:\s*18px;[^}]*font-size:\s*9px;/s);
  });
});
