/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/components/RemoteDesktopWall.js', () => ({
  RemoteDesktopWall: ({ standalone, onOpenHost, onClose }: {
    standalone: boolean;
    onOpenHost(machine: unknown): void;
    onClose(hostKeys: readonly string[]): void;
  }) => <div data-testid="standalone-wall">
    {String(standalone)}
    <button type="button" onClick={() => onOpenHost({
      hostId: 'host-a', remoteDesktopHostId: 'host-a', serverId: 'server-a',
      refName: 'a', displayName: 'A', online: true, execEnabled: true, accessRole: 'owner',
    })}>open-host</button>
    <button type="button" onClick={() => onClose(['host-a'])}>close-wall</button>
  </div>,
}));

vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({
  RemoteDesktopWorkspace: ({ state, onCloseWorkspace }: {
    state: { orderedHostKeys: readonly string[] };
    onCloseWorkspace(): void;
  }) => <div data-testid="standalone-wall-manager">
    {state.orderedHostKeys.join(',')}
    <button type="button" onClick={onCloseWorkspace}>close-manager</button>
  </div>,
}));

import { RemoteDesktopWallStandalone } from '../src/components/RemoteDesktopWallStandalone.js';
import {
  buildRemoteDesktopWallWindowUrl,
  isRemoteDesktopWallWindow,
  openRemoteDesktopWallWindow,
} from '../src/remote-desktop-window.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('remote desktop wall standalone window', () => {
  it('keeps the wall independent and opens a reusable manager only after selecting a tile', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<RemoteDesktopWallStandalone />);
    expect(screen.getByTestId('standalone-wall').textContent).toContain('true');
    expect(screen.queryByTestId('standalone-wall-manager')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'open-host' }));
    expect(screen.getByTestId('standalone-wall-manager').textContent).toContain('host-a');
    fireEvent.click(screen.getByRole('button', { name: 'close-manager' }));
    expect(screen.queryByTestId('standalone-wall-manager')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close-wall' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded dedicated query and severs the popup opener', () => {
    const url = buildRemoteDesktopWallWindowUrl(
      'https://example.test/app?keep=1&remoteDesktopServer=server-a#session',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('keep')).toBe('1');
    expect(parsed.searchParams.get('remoteDesktopServer')).toBeNull();
    expect(isRemoteDesktopWallWindow(parsed.search)).toBe(true);
    expect(parsed.hash).toBe('');

    const popup = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);
    expect(openRemoteDesktopWallWindow()).toBe(popup);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('remoteDesktopWall=1'),
      '_blank',
      'popup,width=1440,height=900',
    );
    expect(popup.opener).toBeNull();
  });
});
