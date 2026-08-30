/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '@shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_STOP_ORIGIN,
} from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '@shared/remote-desktop-platform.js';

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
  RemoteDesktopPanel: ({ machine, standalone, onClose }: {
    machine: { displayName: string };
    standalone: boolean;
    onClose(): void;
  }) => <div data-testid="standalone-desktop">
    {machine.displayName}:{standalone ? 'full-panel' : 'embedded'}
    <button onClick={onClose}>stop-standalone</button>
  </div>,
}));

import { RemoteDesktopStandalone } from '../src/components/RemoteDesktopStandalone.js';
import { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import {
  buildRemoteDesktopWindowUrl,
  isRemoteDesktopWallWindow,
  readRemoteDesktopWindowServerId,
} from '../src/remote-desktop-window.js';

const MAC_COMPLETE = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const;

afterEach(() => {
  cleanup();
  document.getElementById('splash')?.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('remote desktop standalone window', () => {
  it('removes the static HTML splash that otherwise masks the direct-entry desktop', () => {
    listControllableMachines.mockReturnValue(new Promise(() => {}));
    const splash = document.createElement('div');
    splash.id = 'splash';
    document.body.append(splash);

    const result = render(<RemoteDesktopStandalone serverId="desktop-1" />);

    expect(document.getElementById('splash')).toBeNull();
    expect(result.getByRole('status').textContent).toBe('controlled_nodes.loading');
  });

  it('loads the selected machine and closes only its own browser window', async () => {
    listControllableMachines.mockResolvedValue([{
      serverId: 'desktop-1',
      refName: 'desktop-ref',
      displayName: 'Desktop One',
      online: true,
      execEnabled: true,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    }]);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const stopAll = vi.spyOn(RemoteDesktopConnectionManager.prototype, 'stopAll');
    const result = render(<RemoteDesktopStandalone serverId="desktop-1" />);

    expect(result.getByRole('status').textContent).toBe('controlled_nodes.loading');
    await waitFor(() => expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop One:full-panel'));

    act(() => result.getByText('stop-standalone').click());
    expect(close).toHaveBeenCalledTimes(1);
    result.unmount();
    expect(stopAll).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.STANDALONE_UNMOUNT);
  });

  it('uses the real capability gate for complete and incomplete macOS profiles', async () => {
    listControllableMachines.mockResolvedValue([{
      serverId: 'mac-complete',
      refName: 'mac-complete',
      displayName: 'Mac Complete',
      os: 'mac',
      online: true,
      execEnabled: true,
      capabilities: MAC_COMPLETE,
    }, {
      serverId: 'mac-incomplete',
      refName: 'mac-incomplete',
      displayName: 'Mac Incomplete',
      os: 'mac',
      online: true,
      execEnabled: true,
      capabilities: [
        REMOTE_DESKTOP_SESSION_CAPABILITY,
        REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      ],
    }]);

    const complete = render(<RemoteDesktopStandalone serverId="mac-complete" />);
    await waitFor(() => expect(complete.getByTestId('standalone-desktop').textContent)
      .toContain('Mac Complete:full-panel'));
    complete.unmount();

    const incomplete = render(<RemoteDesktopStandalone serverId="mac-incomplete" />);
    await waitFor(() => expect(incomplete.getByRole('alert').textContent)
      .toBe('controlled_nodes.error_generic'));
    expect(incomplete.queryByTestId('standalone-desktop')).toBeNull();
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
    expect(parsed.searchParams.get('remoteDesktopWall')).toBeNull();
    expect(readRemoteDesktopWindowServerId(parsed.search)).toBe('desktop_1-abc');
    expect(isRemoteDesktopWallWindow(parsed.search)).toBe(false);
    expect(parsed.hash).toBe('');
    expect(readRemoteDesktopWindowServerId('?remoteDesktopServer=../bad')).toBeNull();
  });
});
