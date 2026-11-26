/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE, REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import { RemoteDesktopWallTile } from '../src/components/RemoteDesktopWallTile.js';
import { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import type { RemoteDesktopClientHooks, RemoteDesktopSnapshot } from '../src/remote-desktop-client.js';
import { applyUiScale } from '../src/ui-scale.js';

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
    expect(result.container.querySelectorAll('button')).toHaveLength(1);
    const nameBar = result.container.querySelector('.remote-desktop-wall-tile-title');
    expect(nameBar?.textContent).toBe('A');
    expect(nameBar?.getAttribute('title')).toBe('A');
    expect(nameBar?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('remote_desktop.wall_health_connecting');
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
    const video = screen.getByLabelText('remote_desktop.video_label:A') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 360 });
    await waitFor(() => expect(video.srcObject).not.toBeNull());
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
    fireEvent.click(screen.getByRole('menuitemradio', { name: /remote_desktop\.display_name:2/ }));
    expect(selectDisplay).toHaveBeenCalledWith('two');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'remote_desktop.wall_open_host:A' }), { clientX: 40, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'remote_desktop.wall_remove:A' }));
    expect(onRemove).toHaveBeenCalledWith('host-a');
  });

  it('shows failed state and retries only after a tile or global retry request', async () => {
    const hooks: RemoteDesktopClientHooks[] = [];
    let allocations = 0;
    let starts = 0;
    const manager = new RemoteDesktopConnectionManager({
      createClient: (_serverId, nextHooks) => {
        allocations += 1;
        hooks.push(nextHooks);
        return {
          current: initial,
          start: async () => { starts += 1; },
          setMode: vi.fn(), selectDisplay: () => true,
          setDisplayMode: () => true, setDisplayScale: () => true,
          requestUnlock: () => true, requestRemoteClipboard: async () => null,
          acknowledgePresentedFrame: () => true,
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
    const retryable = vi.fn();
    const result = render(<RemoteDesktopWallTile
      host={host}
      manager={manager}
      wallVisible
      retryGeneration={0}
      onRetryableChange={retryable}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
    />);
    await waitFor(() => expect(starts).toBe(1));

    hooks.at(-1)?.onSnapshot({
      ...initial(),
      state: REMOTE_DESKTOP_STATE.FAILED,
    });
    const retryButton = await screen.findByRole('button', { name: 'remote_desktop.retry' });
    expect(screen.getByRole('status').textContent).toContain('remote_desktop.wall_health_failed');
    await waitFor(() => expect(retryable).toHaveBeenLastCalledWith('host-a', true));
    fireEvent.click(retryButton);
    await waitFor(() => expect(allocations).toBe(2));

    hooks.at(-1)?.onSnapshot({
      ...initial(),
      state: REMOTE_DESKTOP_STATE.FAILED,
    });
    result.rerender(<RemoteDesktopWallTile
      host={host}
      manager={manager}
      wallVisible
      retryGeneration={1}
      onRetryableChange={retryable}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
    />);
    await waitFor(() => expect(allocations).toBe(3));
  });

  it('acknowledges presented frames only via requestVideoFrameCallback when available, binds to active host/stream, and transitions connecting -> live after ACK', async () => {
    const hooksByServer = new Map<string, RemoteDesktopClientHooks>();
    const snapshotsByServer = new Map<string, RemoteDesktopSnapshot>();
    const nextStateOnAckByServer = new Map<string, RemoteDesktopSnapshot['state']>([
      ['server-a', REMOTE_DESKTOP_STATE.DIRECT],
      ['server-b', REMOTE_DESKTOP_STATE.RELAYED],
      ['server-b2', REMOTE_DESKTOP_STATE.DIRECT],
    ]);
    const emitSnapshot = (serverId: string, next: RemoteDesktopSnapshot) => {
      snapshotsByServer.set(serverId, next);
      hooksByServer.get(serverId)?.onSnapshot(next);
    };
    const ackCalls: Array<{ serverId: string; width: number; height: number }> = [];
    const frameCallbacks = new Map<number, VideoFrameRequestCallback>();
    let nextCallbackId = 0;
    const cancelSpy = vi.fn((id: number) => {
      frameCallbacks.delete(id);
    });
    const rVfcSpy = vi.fn((cb: VideoFrameRequestCallback) => {
      const id = nextCallbackId++;
      frameCallbacks.set(id, cb);
      return id;
    });

    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      writable: true,
      value: rVfcSpy,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      writable: true,
      value: cancelSpy,
    });

    const manager = new RemoteDesktopConnectionManager({
      createClient: (serverId, hooks) => {
        hooksByServer.set(serverId, hooks);
        snapshotsByServer.set(serverId, initial());
        return {
          current: () => snapshotsByServer.get(serverId) ?? initial(),
          start: async () => {},
          setMode: vi.fn(),
          selectDisplay: () => true,
          setDisplayMode: () => true,
          setDisplayScale: () => true,
          requestUnlock: () => true,
          requestRemoteClipboard: async () => null,
          acknowledgePresentedFrame: (width, height) => {
            ackCalls.push({ serverId, width, height });
            const cur = snapshotsByServer.get(serverId) ?? initial();
            const nextState = nextStateOnAckByServer.get(serverId) ?? REMOTE_DESKTOP_STATE.DIRECT;
            if (cur.state !== nextState) {
              emitSnapshot(serverId, { ...cur, state: nextState });
            }
            return true;
          },
          pointerMove: vi.fn(),
          pointerButton: () => true,
          pointerClick: () => true,
          wheel: () => true,
          key: () => true,
          text: () => true,
          releaseAll: vi.fn(),
          releasePointerButtons: vi.fn(),
          stop: vi.fn(),
        };
      },
    });

    const host = {
      hostId: 'host-a',
      remoteDesktopHostId: 'host-a',
      serverId: 'server-a',
      refName: 'a',
      displayName: 'A',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
    };

    try {
      const view = render(
        <RemoteDesktopWallTile
          host={host}
          manager={manager}
          wallVisible
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      const video = screen.getByLabelText('remote_desktop.video_label:A') as HTMLVideoElement;
      const setDims = (w: number, h: number) => {
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: w });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: h });
      };

      // Before a stream exists, rVFC must not arm
      expect(frameCallbacks.size).toBe(0);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      // Start from CONNECTING + non-null streamA (server awaits first frame ACK before transport becomes ready)
      const streamA = { id: 'stream-a' } as MediaStream;
      emitSnapshot('server-a', {
        ...initial(),
        state: REMOTE_DESKTOP_STATE.CONNECTING,
        stream: streamA,
      });
      await waitFor(() => expect(frameCallbacks.size).toBe(1));
      expect(video.srcObject).toBe(streamA);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      // When rVFC is present, positive-dimension loadeddata/timeupdate MUST NOT ack or mark live
      setDims(1280, 720);
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      expect(ackCalls).toEqual([]);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      // Zero dimensions must never call acknowledgePresentedFrame or update lastFrameAt (even if transport is DIRECT)
      emitSnapshot('server-a', {
        ...initial(),
        state: REMOTE_DESKTOP_STATE.DIRECT,
        stream: streamA,
      });
      setDims(0, 0);
      const firstId = Array.from(frameCallbacks.keys())[0]!;
      const zeroCb = frameCallbacks.get(firstId)!;
      frameCallbacks.delete(firstId);
      zeroCb(10, { presentationTime: 10, expectedDisplayTime: 10, width: 0, height: 0, mediaTime: 0, presentedFrames: 1 } as VideoFrameCallbackMetadata);
      expect(ackCalls).toEqual([]);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      setDims(1280, 0);
      const secondId = Array.from(frameCallbacks.keys())[0]!;
      const zeroHeightCb = frameCallbacks.get(secondId)!;
      frameCallbacks.delete(secondId);
      zeroHeightCb(12, { presentationTime: 12, expectedDisplayTime: 12, width: 1280, height: 0, mediaTime: 0.004, presentedFrames: 2 } as VideoFrameCallbackMetadata);
      setDims(0, 720);
      const thirdId = Array.from(frameCallbacks.keys())[0]!;
      const zeroWidthCb = frameCallbacks.get(thirdId)!;
      frameCallbacks.delete(thirdId);
      zeroWidthCb(14, { presentationTime: 14, expectedDisplayTime: 14, width: 0, height: 720, mediaTime: 0.008, presentedFrames: 3 } as VideoFrameCallbackMetadata);
      expect(ackCalls).toEqual([]);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      // Return to CONNECTING + streamA, paint positive frame via rVFC -> mock emits DIRECT on ACK -> live
      emitSnapshot('server-a', {
        ...initial(),
        state: REMOTE_DESKTOP_STATE.CONNECTING,
        stream: streamA,
      });
      setDims(1280, 720);
      const activeId = Array.from(frameCallbacks.keys())[0]!;
      const liveCb = frameCallbacks.get(activeId)!;
      frameCallbacks.delete(activeId);
      liveCb(20, { presentationTime: 20, expectedDisplayTime: 20, width: 1280, height: 720, mediaTime: 0.016, presentedFrames: 4 } as VideoFrameCallbackMetadata);
      expect(ackCalls).toEqual([{ serverId: 'server-a', width: 1280, height: 720 }]);
      await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('live'));

      // Paused states cancel rVFC and ignore stale callbacks
      const stalePrePauseId = Array.from(frameCallbacks.keys())[0]!;
      const stalePrePauseCb = frameCallbacks.get(stalePrePauseId)!;
      view.rerender(
        <RemoteDesktopWallTile
          host={host}
          manager={manager}
          wallVisible
          pressurePaused
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(stalePrePauseId));
      stalePrePauseCb(30, { presentationTime: 30, expectedDisplayTime: 30, width: 1280, height: 720, mediaTime: 0.032, presentedFrames: 5 } as VideoFrameCallbackMetadata);
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      expect(ackCalls).toHaveLength(1);

      // Unpause re-arms cleanly
      view.rerender(
        <RemoteDesktopWallTile
          host={host}
          manager={manager}
          wallVisible
          pressurePaused={false}
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      await waitFor(() => expect(frameCallbacks.size).toBe(1));
      const hostACallbackId = Array.from(frameCallbacks.keys())[0]!;
      const hostACb = frameCallbacks.get(hostACallbackId)!;

      // Switch to host-b BEFORE host-b publishes any stream: stale host-a callback & media events MUST NOT ACK
      const hostB = {
        hostId: 'host-b',
        remoteDesktopHostId: 'host-b',
        serverId: 'server-b',
        refName: 'b',
        displayName: 'B',
        online: true,
        execEnabled: true,
        accessRole: 'owner' as const,
      };
      view.rerender(
        <RemoteDesktopWallTile
          host={hostB}
          manager={manager}
          wallVisible
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(hostACallbackId));
      expect(frameCallbacks.size).toBe(0);
      expect(video.srcObject).toBeNull();
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      hostACb(40, { presentationTime: 40, expectedDisplayTime: 40, width: 1280, height: 720, mediaTime: 0.048, presentedFrames: 6 } as VideoFrameCallbackMetadata);
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      expect(ackCalls).toHaveLength(1);

      // Explicitly push streamB for host-b -> loads streamB, stays connecting until frame paints, then ACKs only server-b
      const streamB = { id: 'stream-b' } as MediaStream;
      emitSnapshot('server-b', {
        ...initial(),
        state: REMOTE_DESKTOP_STATE.CONNECTING,
        stream: streamB,
      });
      await waitFor(() => expect(frameCallbacks.size).toBe(1));
      expect(video.srcObject).toBe(streamB);
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      const hostBCallbackId = Array.from(frameCallbacks.keys())[0]!;
      const hostBCb = frameCallbacks.get(hostBCallbackId)!;
      frameCallbacks.delete(hostBCallbackId);
      hostBCb(50, { presentationTime: 50, expectedDisplayTime: 50, width: 1280, height: 720, mediaTime: 0.064, presentedFrames: 7 } as VideoFrameCallbackMetadata);
      expect(ackCalls).toEqual([
        { serverId: 'server-a', width: 1280, height: 720 },
        { serverId: 'server-b', width: 1280, height: 720 },
      ]);
      await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('live'));

      // Same canonical host (remoteDesktopHostId: 'host-b') switching serverId -> 'server-b2'
      const preSwitchId = Array.from(frameCallbacks.keys())[0]!;
      const preSwitchCb = frameCallbacks.get(preSwitchId)!;
      const hostB2 = {
        ...hostB,
        serverId: 'server-b2',
      };
      view.rerender(
        <RemoteDesktopWallTile
          host={hostB2}
          manager={manager}
          wallVisible
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(preSwitchId));
      expect(frameCallbacks.size).toBe(0);
      expect(video.srcObject).toBeNull();
      expect(video.closest('article')?.dataset.health).toBe('connecting');

      // Stale pre-switch callback and media events must not ACK server-b or server-b2 before streamB2 exists
      preSwitchCb(55, { presentationTime: 55, expectedDisplayTime: 55, width: 1280, height: 720, mediaTime: 0.07, presentedFrames: 8 } as VideoFrameCallbackMetadata);
      fireEvent.loadedData(video);
      fireEvent.timeUpdate(video);
      expect(ackCalls).toHaveLength(2);

      // Push streamB2 for server-b2 and present first frame -> ACKs only server-b2 and transitions to live
      const streamB2 = { id: 'stream-b2' } as MediaStream;
      emitSnapshot('server-b2', {
        ...initial(),
        state: REMOTE_DESKTOP_STATE.CONNECTING,
        stream: streamB2,
      });
      await waitFor(() => expect(frameCallbacks.size).toBe(1));
      expect(video.srcObject).toBe(streamB2);
      const hostB2CbId = Array.from(frameCallbacks.keys())[0]!;
      const hostB2Cb = frameCallbacks.get(hostB2CbId)!;
      frameCallbacks.delete(hostB2CbId);
      hostB2Cb(58, { presentationTime: 58, expectedDisplayTime: 58, width: 1280, height: 720, mediaTime: 0.075, presentedFrames: 9 } as VideoFrameCallbackMetadata);
      expect(ackCalls).toEqual([
        { serverId: 'server-a', width: 1280, height: 720 },
        { serverId: 'server-b', width: 1280, height: 720 },
        { serverId: 'server-b2', width: 1280, height: 720 },
      ]);
      await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('live'));

      // Unmount cancels callbackId cleanly (including id===0 earlier) and ignores stale callbacks
      const unmountCbId = Array.from(frameCallbacks.keys())[0]!;
      const unmountCb = frameCallbacks.get(unmountCbId)!;
      view.unmount();
      expect(cancelSpy).toHaveBeenCalledWith(unmountCbId);
      unmountCb(60, { presentationTime: 60, expectedDisplayTime: 60, width: 1280, height: 720, mediaTime: 0.08, presentedFrames: 10 } as VideoFrameCallbackMetadata);
      fireEvent.timeUpdate(video);
      expect(ackCalls).toHaveLength(3);
    } finally {
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback;
      delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback;
    }
  });

  it('acknowledges presented frames via loadeddata and timeupdate when requestVideoFrameCallback is absent and tolerates hidden/unmounted mocks without acknowledgePresentedFrame', async () => {
    let hook: RemoteDesktopClientHooks | null = null;
    let currentSnapshot = initial();
    const ackSpy = vi.fn(() => {
      if (currentSnapshot.state !== REMOTE_DESKTOP_STATE.RELAYED) {
        currentSnapshot = { ...currentSnapshot, state: REMOTE_DESKTOP_STATE.RELAYED };
        hook?.onSnapshot(currentSnapshot);
      }
      return true;
    });
    const managerWithAck = new RemoteDesktopConnectionManager({
      createClient: (_serverId, nextHooks) => {
        hook = nextHooks;
        return {
          current: () => currentSnapshot,
          start: async () => {},
          setMode: vi.fn(),
          selectDisplay: () => true,
          setDisplayMode: () => true,
          setDisplayScale: () => true,
          requestUnlock: () => true,
          requestRemoteClipboard: async () => null,
          acknowledgePresentedFrame: ackSpy,
          pointerMove: vi.fn(),
          pointerButton: () => true,
          pointerClick: () => true,
          wheel: () => true,
          key: () => true,
          text: () => true,
          releaseAll: vi.fn(),
          releasePointerButtons: vi.fn(),
          stop: vi.fn(),
        };
      },
    });
    const host = {
      hostId: 'host-fallback',
      remoteDesktopHostId: 'host-fallback',
      serverId: 'server-fallback',
      refName: 'fb',
      displayName: 'Fallback',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
    };

    const view = render(
      <RemoteDesktopWallTile
        host={host}
        manager={managerWithAck}
        wallVisible
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const fallbackStream = { id: 'fallback-stream' } as MediaStream;
    currentSnapshot = {
      ...initial(),
      state: REMOTE_DESKTOP_STATE.CONNECTING,
      stream: fallbackStream,
    };
    (hook as RemoteDesktopClientHooks | null)?.onSnapshot(currentSnapshot);

    const video = screen.getByLabelText('remote_desktop.video_label:Fallback') as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject).toBe(fallbackStream));
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 0 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 0 });
    fireEvent.loadedData(video);
    expect(ackSpy).toHaveBeenCalledTimes(0);
    expect(video.closest('article')?.dataset.health).toBe('connecting');

    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 });

    fireEvent.loadedData(video);
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenLastCalledWith(1920, 1080);
    await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('live'));

    fireEvent.timeUpdate(video);
    expect(ackSpy).toHaveBeenCalledTimes(2);
    expect(ackSpy).toHaveBeenLastCalledWith(1920, 1080);

    // Hidden document pauses tile and ignores timeupdate
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('paused'));
    fireEvent.timeUpdate(video);
    expect(ackSpy).toHaveBeenCalledTimes(2);

    // !wallVisible pauses tile
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    view.rerender(
      <RemoteDesktopWallTile
        host={host}
        manager={managerWithAck}
        wallVisible={false}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await waitFor(() => expect(video.closest('article')?.dataset.health).toBe('paused'));
    fireEvent.loadedData(video);
    expect(ackSpy).toHaveBeenCalledTimes(2);
    view.unmount();

    // Offscreen IntersectionObserver (isIntersecting=false) pauses tile and blocks frame acks
    let intersectionCb: IntersectionObserverCallback | null = null;
    const origIntersection = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) { intersectionCb = cb; }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    } as unknown as typeof IntersectionObserver;
    try {
      const offView = render(
        <RemoteDesktopWallTile
          host={host}
          manager={managerWithAck}
          wallVisible
          onOpen={vi.fn()}
          onRemove={vi.fn()}
        />,
      );
      const offVideo = screen.getByLabelText('remote_desktop.video_label:Fallback') as HTMLVideoElement;
      Object.defineProperty(offVideo, 'videoWidth', { configurable: true, value: 1280 });
      Object.defineProperty(offVideo, 'videoHeight', { configurable: true, value: 720 });
      (intersectionCb as IntersectionObserverCallback | null)?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await waitFor(() => expect(offVideo.closest('article')?.dataset.health).toBe('paused'));
      fireEvent.loadedData(offVideo);
      fireEvent.timeUpdate(offVideo);
      expect(ackSpy).toHaveBeenCalledTimes(2);
      offView.unmount();
    } finally {
      globalThis.IntersectionObserver = origIntersection;
    }

    // Optional chaining tolerates legacy mock connections lacking acknowledgePresentedFrame
    const optionalManager = new RemoteDesktopConnectionManager({
      createClient: () => ({
        current: initial,
        start: async () => {},
        setMode: vi.fn(),
        selectDisplay: () => true,
        setDisplayMode: () => true,
        setDisplayScale: () => true,
        requestUnlock: () => true,
        requestRemoteClipboard: async () => null,
        pointerMove: vi.fn(),
        pointerButton: () => true,
        pointerClick: () => true,
        wheel: () => true,
        key: () => true,
        text: () => true,
        releaseAll: vi.fn(),
        releasePointerButtons: vi.fn(),
        stop: vi.fn(),
      } as unknown as ReturnType<NonNullable<ConstructorParameters<typeof RemoteDesktopConnectionManager>[0]['createClient']>>),
    });
    const optView = render(
      <RemoteDesktopWallTile
        host={host}
        manager={optionalManager}
        wallVisible
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const optVideo = screen.getByLabelText('remote_desktop.video_label:Fallback') as HTMLVideoElement;
    Object.defineProperty(optVideo, 'videoWidth', { configurable: true, value: 800 });
    Object.defineProperty(optVideo, 'videoHeight', { configurable: true, value: 600 });
    expect(() => fireEvent.loadedData(optVideo)).not.toThrow();
    optView.unmount();
  });

  it.each(['chrome', 'webkit'] as const)('positions wall context menu in pre-zoom CSS px under 125% uiScale (%s)', (regime) => {
    const z = applyUiScale(125);
    const origRootRect = document.documentElement.getBoundingClientRect;
    const origInnerW = window.innerWidth;
    const origInnerH = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const rootW = regime === 'chrome' ? 1000 : 1000 / z;
    const rootH = regime === 'chrome' ? 800 : 800 / z;
    document.documentElement.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: rootW, bottom: rootH, width: rootW, height: rootH, toJSON: () => ({}),
    });

    const manager = new RemoteDesktopConnectionManager({
      createClient: () => ({
        current: initial,
        start: async () => {},
        setMode: vi.fn(),
        selectDisplay: () => true,
        setDisplayMode: () => true,
        setDisplayScale: () => true,
        requestUnlock: () => true,
        requestRemoteClipboard: async () => null,
        acknowledgePresentedFrame: () => true,
        pointerMove: vi.fn(),
        pointerButton: () => true,
        pointerClick: () => true,
        wheel: () => true,
        key: () => true,
        text: () => true,
        releaseAll: vi.fn(),
        releasePointerButtons: vi.fn(),
        stop: vi.fn(),
      } as unknown as ReturnType<NonNullable<ConstructorParameters<typeof RemoteDesktopConnectionManager>[0]['createClient']>>),
    });
    const host = {
      hostId: 'host-z', remoteDesktopHostId: 'host-z', serverId: 'server-z',
      refName: 'z', displayName: 'ZoomHost', online: true, execEnabled: true, accessRole: 'owner' as const,
      os: 'win', platform: 'win', capabilities: [],
    };
    const view = render(
      <RemoteDesktopWallTile
        host={host}
        manager={manager}
        wallVisible
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    try {
      const tile = view.container.querySelector('.remote-desktop-wall-tile') as HTMLElement;
      const rectScale = regime === 'chrome' ? z : 1;
      tile.getBoundingClientRect = () => ({
        x: 200 * rectScale,
        y: 120 * rectScale,
        left: 200 * rectScale,
        top: 120 * rectScale,
        right: 440 * rectScale,
        bottom: 300 * rectScale,
        width: 240 * rectScale,
        height: 180 * rectScale,
        toJSON: () => ({}),
      });

      // Right-click at visual viewport (250, 150) -> CSS (200, 120)
      fireEvent.contextMenu(tile, { clientX: 250, clientY: 150 });
      const menu = document.body.querySelector('.remote-desktop-wall-context-menu') as HTMLElement;
      expect(menu).not.toBeNull();
      expect(parseFloat(menu.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(menu.style.top)).toBeCloseTo(120, 1);

      // Keyboard ContextMenu opens at tile CSS origin (200, 120)
      const picBtn = view.container.querySelector('.remote-desktop-wall-picture') as HTMLElement;
      fireEvent.keyDown(picBtn, { key: 'ContextMenu' });
      expect(parseFloat(menu.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(menu.style.top)).toBeCloseTo(120, 1);
    } finally {
      view.unmount();
      document.documentElement.getBoundingClientRect = origRootRect;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origInnerW });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInnerH });
      applyUiScale(100);
    }
  });
});
