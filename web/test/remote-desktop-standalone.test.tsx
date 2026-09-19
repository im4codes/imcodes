/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_INPUT_CAPABILITY, REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '@shared/remote-desktop-access.js';
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

// Mirrors remote-desktop-wall-standalone.test.tsx's own mock of the SAME
// component: the wrapper's job is seeding/closing hosts in the workspace
// state, not rendering the tab bar or the panels inside it, so the mock only
// needs to expose the state it was handed and the callbacks that mutate it.
vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({
  RemoteDesktopWorkspace: ({ state, standalone, onOpenHost, onCloseHost, onCloseWorkspace }: {
    state: { orderedHostKeys: readonly string[]; hosts: Record<string, { machine: { displayName: string } }> };
    standalone?: boolean;
    onOpenHost(machine: unknown): void;
    onCloseHost(hostKey: string): void;
    onCloseWorkspace(): void;
  }) => <div data-testid="standalone-desktop" data-standalone={String(standalone === true)}>
    {state.orderedHostKeys.map((key) => state.hosts[key]?.machine.displayName).join(',')}
    <button type="button" onClick={() => onOpenHost({
      serverId: 'desktop-2', refName: 'desktop-2', displayName: 'Desktop Two',
      online: true, execEnabled: true, capabilities: [REMOTE_DESKTOP_CAPABILITY],
    })}>add-host</button>
    {state.orderedHostKeys.map((key) => (
      <button key={key} type="button" onClick={() => onCloseHost(key)}>close-host-{key}</button>
    ))}
    <button type="button" onClick={onCloseWorkspace}>close-workspace</button>
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
  REMOTE_DESKTOP_INPUT_CAPABILITY,
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

  it('seeds the workspace with its own machine, supports adding a second one, and only closes the window once every host is gone', async () => {
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
    await waitFor(() => expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop One'));
    // Its own browser window: the workspace fills it instead of floating a
    // remembered-size panel inside it.
    expect(result.getByTestId('standalone-desktop').getAttribute('data-standalone')).toBe('true');

    // The "+" the report asked for: adding a second remote desktop into the
    // SAME popped-out window, not just viewing the one it was opened for.
    fireEvent.click(result.getByText('add-host'));
    expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop One,Desktop Two');

    // Closing one of two hosts must not close the window that still has a
    // live second one.
    act(() => result.getByText('close-host-desktop-1').click());
    expect(close).not.toHaveBeenCalled();
    expect(result.getByTestId('standalone-desktop').textContent).not.toContain('Desktop One');
    expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop Two');

    // Closing the last remaining host closes the browser window, matching
    // what the single-panel version always did on its one panel's close.
    act(() => result.getByText('close-host-desktop-2').click());
    expect(close).toHaveBeenCalledTimes(1);

    result.unmount();
    expect(stopAll).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.STANDALONE_UNMOUNT);
  });

  it('also closes the window when every host is closed at once via close-workspace', async () => {
    listControllableMachines.mockResolvedValue([{
      serverId: 'desktop-1',
      refName: 'desktop-ref',
      displayName: 'Desktop One',
      online: true,
      execEnabled: true,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    }]);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const result = render(<RemoteDesktopStandalone serverId="desktop-1" />);
    await waitFor(() => expect(result.getByTestId('standalone-desktop').textContent).toContain('Desktop One'));

    act(() => result.getByText('close-workspace').click());
    expect(close).toHaveBeenCalledTimes(1);
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
      .toContain('Mac Complete'));
    complete.unmount();

    const incomplete = render(<RemoteDesktopStandalone serverId="mac-incomplete" retryWindowMs={0} />);
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
    const result = render(<RemoteDesktopStandalone serverId="desktop-1" retryWindowMs={0} />);

    await waitFor(() => expect(result.getByRole('alert').textContent).toBe('controlled_nodes.error_generic'));
    expect(result.queryByTestId('standalone-desktop')).toBeNull();
  });

  it('keeps looking while the host is briefly unusable instead of failing on one sample', async () => {
    const eligible = {
      serverId: 'mac-complete',
      refName: 'mac-complete',
      displayName: 'Mac Complete',
      os: 'mac',
      online: true,
      execEnabled: true,
      capabilities: MAC_COMPLETE,
    };
    listControllableMachines
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([{ ...eligible, capabilities: [REMOTE_DESKTOP_SESSION_CAPABILITY] }])
      .mockResolvedValue([eligible]);
    const result = render(
      <RemoteDesktopStandalone serverId="mac-complete" retryWindowMs={5_000} retryIntervalMs={10} />,
    );
    await waitFor(() => expect(result.getByTestId('standalone-desktop').textContent)
      .toContain('Mac Complete'));
    expect(listControllableMachines).toHaveBeenCalledTimes(3);
    expect(result.queryByRole('alert')).toBeNull();
  });

  it('offers a manual retry once the window is spent', async () => {
    listControllableMachines.mockResolvedValueOnce([]).mockResolvedValue([{
      serverId: 'mac-complete',
      refName: 'mac-complete',
      displayName: 'Mac Complete',
      os: 'mac',
      online: true,
      execEnabled: true,
      capabilities: MAC_COMPLETE,
    }]);
    const result = render(<RemoteDesktopStandalone serverId="mac-complete" retryWindowMs={0} />);
    await waitFor(() => expect(result.getByRole('alert')).toBeTruthy());
    act(() => { result.getByRole('button', { name: 'remote_desktop.retry' }).click(); });
    await waitFor(() => expect(result.getByTestId('standalone-desktop')).toBeTruthy());
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
