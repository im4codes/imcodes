/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listControllableMachines } = vi.hoisted(() => ({
  listControllableMachines: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/api/machines.js', () => ({
  listControllableMachines,
}));

vi.mock('../src/components/RemoteDesktopPanel.js', () => ({
  canOpenRemoteDesktop: (machine: { online: boolean }) => machine.online,
  RemoteDesktopPanel: ({ machine, standalone, onClose }: {
    machine: { displayName: string };
    standalone?: boolean;
    onClose(): void;
  }) => (
    <div data-testid="standalone-desktop">
      {machine.displayName}:{String(standalone)}
      <button onClick={onClose}>stop-standalone</button>
    </div>
  ),
}));

import { RemoteDesktopStandalone } from '../src/components/RemoteDesktopStandalone.js';
import {
  buildRemoteDesktopWindowUrl,
  readRemoteDesktopWindowServerId,
} from '../src/remote-desktop-window.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('remote desktop standalone window', () => {
  it('loads the selected machine and closes only its own browser window', async () => {
    listControllableMachines.mockResolvedValue([{
      serverId: 'desktop-1',
      refName: 'desktop-ref',
      displayName: 'Desktop One',
      online: true,
      execEnabled: true,
    }]);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const result = render(<RemoteDesktopStandalone serverId="desktop-1" />);

    expect(result.getByRole('status').textContent).toBe('controlled_nodes.loading');
    await waitFor(() => expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop One:true'));

    act(() => result.getByText('stop-standalone').click());
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the requested machine is unavailable', async () => {
    listControllableMachines.mockResolvedValue([{
      serverId: 'desktop-1',
      displayName: 'Desktop One',
      online: false,
    }]);
    const result = render(<RemoteDesktopStandalone serverId="desktop-1" />);

    await waitFor(() => expect(result.getByRole('alert').textContent).toBe('controlled_nodes.error_generic'));
    expect(result.queryByTestId('standalone-desktop')).toBeNull();
  });

  it('round-trips only bounded machine ids through the standalone URL', () => {
    const url = buildRemoteDesktopWindowUrl('desktop_1-abc', 'https://example.test/app?keep=1#chat');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('keep')).toBe('1');
    expect(readRemoteDesktopWindowServerId(parsed.search)).toBe('desktop_1-abc');
    expect(parsed.hash).toBe('');
    expect(readRemoteDesktopWindowServerId('?remoteDesktopServer=../bad')).toBeNull();
  });
});
