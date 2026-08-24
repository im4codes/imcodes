/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({
  canOpenRemoteDesktop: (machine: { online: boolean }) => machine.online,
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

function machine(id: string) {
  return {
    hostId: id, remoteDesktopHostId: id, serverId: id, refName: id,
    displayName: id.toUpperCase(), online: true, execEnabled: true,
    accessRole: 'owner' as const, capabilities: ['remote-desktop-v1' as const],
  };
}

describe('RemoteDesktopWall', () => {
  beforeEach(() => {
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
});
