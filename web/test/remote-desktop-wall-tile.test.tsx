/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE, REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { RemoteDesktopWallTile } from '../src/components/RemoteDesktopWallTile.js';
import { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import type { RemoteDesktopClientHooks, RemoteDesktopSnapshot } from '../src/remote-desktop-client.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => (
    values ? `${key}:${Object.values(values).join(':')}` : key
  ) }),
}));

function initial(): RemoteDesktopSnapshot {
  return {
    state: REMOTE_DESKTOP_STATE.AUTHORIZING,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    inputEpoch: 0,
    inputEnabled: false,
    displays: [],
    layoutRevision: 0,
    stream: null,
  };
}

describe('RemoteDesktopWallTile', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('reuses the ordinary tab manager owner and stays a view-only presentation', async () => {
    let allocations = 0;
    let starts = 0;
    let pointerMoves = 0;
    let hook: RemoteDesktopClientHooks | null = null;
    const manager = new RemoteDesktopConnectionManager({
      createClient: (_serverId, hooks) => {
        allocations += 1;
        hook = hooks;
        let value = initial();
        return {
          current: () => value,
          start: async () => { starts += 1; },
          setMode: vi.fn(), selectDisplay: () => true, setDisplayMode: () => true,
          setDisplayScale: () => true, requestUnlock: () => true,
          requestRemoteClipboard: async () => null, acknowledgePresentedFrame: () => true,
          pointerMove: () => { pointerMoves += 1; }, pointerButton: () => true,
          pointerClick: () => true, wheel: () => true, key: () => true, text: () => true,
          releaseAll: vi.fn(), releasePointerButtons: vi.fn(), stop: vi.fn(),
          emit: (next: RemoteDesktopSnapshot) => { value = next; hooks.onSnapshot(next); },
        };
      },
    });
    const host = {
      hostId: 'host-a', remoteDesktopHostId: 'host-a', serverId: 'server-a',
      refName: 'a', displayName: 'A', online: true, execEnabled: true, accessRole: 'owner' as const,
    };
    const tabPresentation = {};
    const ordinary = manager.presentation(host, tabPresentation);
    ordinary.subscribe(tabPresentation, () => {}, { controlsInput: true });
    await ordinary.start();

    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const result = render(<RemoteDesktopWallTile
      host={host}
      manager={manager}
      wallVisible
      onOpen={onOpen}
      onRemove={onRemove}
    />);
    await waitFor(() => expect(starts).toBe(1));
    expect(allocations).toBe(1);
    expect(hook).not.toBeNull();
    // The existing input owner remains the only presentation able to control.
    manager.presentation(host, {}).pointerMove(0.5, 0.5);
    expect(pointerMoves).toBe(0);
    expect(result.container.querySelectorAll('button')).toHaveLength(0);
    expect(result.container.querySelector('header')).toBeNull();
    expect(result.container.querySelector('footer')).toBeNull();
    expect(result.container.querySelector('dl')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.wall_open_host:A' }));
    expect(onOpen).toHaveBeenCalledWith(host);

    (hook as RemoteDesktopClientHooks | null)?.onSnapshot({
      ...initial(),
      state: REMOTE_DESKTOP_STATE.DIRECT,
      stream: {} as MediaStream,
      route: 'direct',
      quality: {
        preset: '360p5', encoderClass: 'hardware', width: 640, height: 360,
        fps: 5, bitrateBps: 800_000, droppedFrames: 0, rttMs: 20,
      },
    });
    const video = screen.getByLabelText('remote_desktop.video_label:A');
    fireEvent.loadedData(video);
    await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('live'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('paused'));
  });

  it('opens a right-click management menu for display switching and removal', async () => {
    let hook: RemoteDesktopClientHooks | null = null;
    const selectDisplay = vi.fn(() => true);
    const manager = new RemoteDesktopConnectionManager({
      createClient: (_serverId, hooks) => {
        hook = hooks;
        return {
          current: initial, start: async () => {}, setMode: vi.fn(), selectDisplay,
          setDisplayMode: () => true, setDisplayScale: () => true, requestUnlock: () => true,
          requestRemoteClipboard: async () => null, acknowledgePresentedFrame: () => true,
          pointerMove: vi.fn(), pointerButton: () => true, pointerClick: () => true,
          wheel: () => true, key: () => true, text: () => true,
          releaseAll: vi.fn(), releasePointerButtons: vi.fn(), stop: vi.fn(),
        };
      },
    });
    const host = {
      hostId: 'host-a', remoteDesktopHostId: 'host-a', serverId: 'server-a',
      refName: 'a', displayName: 'A', online: true, execEnabled: true, accessRole: 'owner' as const,
    };
    const onRemove = vi.fn();
    render(<RemoteDesktopWallTile host={host} manager={manager} wallVisible onOpen={vi.fn()} onRemove={onRemove} />);
    (hook as RemoteDesktopClientHooks | null)?.onSnapshot({
      ...initial(),
      displays: [
        { id: 'one', label: 'Display 1', primary: true, available: true, width: 1920, height: 1080, dpiScale: 1, rotation: 0 },
        { id: 'two', label: 'Display 2', primary: false, available: true, width: 1280, height: 720, dpiScale: 1, rotation: 0 },
      ],
      selectedDisplayId: 'one',
    });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'remote_desktop.wall_open_host:A' }), { clientX: 40, clientY: 50 });
    await screen.findByRole('menu', { name: 'remote_desktop.wall_manage:A' });
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'remote_desktop.retry' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Display 2/ }));
    expect(selectDisplay).toHaveBeenCalledWith('two');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'remote_desktop.wall_open_host:A' }), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'remote_desktop.wall_remove:A' }));
    expect(onRemove).toHaveBeenCalledWith('host-a');
  });
});
