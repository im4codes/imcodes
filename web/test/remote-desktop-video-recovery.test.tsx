/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE, REMOTE_DESKTOP_STATE } from '@shared/remote-desktop.js';
import type { RemoteDesktopSnapshot } from '../src/remote-desktop-client.js';
import type {
  RemoteDesktopConnectionManager,
  RemoteDesktopManagedConnection,
  RemoteDesktopSnapshotListener,
} from '../src/remote-desktop-connection-manager.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: vi.fn(),
  getApiBaseUrl: () => 'https://im.example.test',
  getUserPref: vi.fn(async () => null),
  saveUserPref: vi.fn(async () => undefined),
}));

vi.mock('../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
  primeVoiceGesture: vi.fn(() => true),
  triggerHapticFeedback: vi.fn(async () => undefined),
  startListening: vi.fn(async () => false),
  stopListening: vi.fn(async () => undefined),
  onAudioLevel: vi.fn(),
  pickLocale: vi.fn(() => 'en-US'),
}));

vi.mock('../src/native.js', () => ({
  isNative: () => false,
}));

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => undefined) },
}));

vi.mock('../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

import { RemoteDesktopPanel } from '../src/components/RemoteDesktopPanel.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeMachine(serverId = 'host-ios-1') {
  return {
    serverId,
    refName: serverId,
    displayName: 'Test Windows Host',
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner' as const,
    capabilities: ['remote-desktop-v1' as const],
  };
}

function makeMediaStream(trackState: MediaStreamTrackState = 'live'): {
  stream: MediaStream;
  track: MediaStreamTrack;
} {
  const listeners = new Map<string, Set<EventListener>>();
  const track = {
    kind: 'video',
    readyState: trackState,
    addEventListener: vi.fn((type: string, fn: EventListener) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    }),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function makeSnapshot(overrides: Partial<RemoteDesktopSnapshot> = {}): RemoteDesktopSnapshot {
  return {
    state: REMOTE_DESKTOP_STATE.DIRECT,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 1,
    inputEnabled: true,
    route: 'direct',
    displays: [
      {
        id: 'display-1',
        label: 'Display 1',
        primary: true,
        available: true,
        width: 1920,
        height: 1080,
        dpiScale: 1,
        rotation: 0,
      },
    ],
    selectedDisplayId: 'display-1',
    layoutRevision: 1,
    stream: null,
    streamGeneration: 0,
    durationMs: 0,
    reconnectCount: 0,
    ...overrides,
  };
}

function createFakeConnectionManager(initialSnapshot: RemoteDesktopSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set<RemoteDesktopSnapshotListener>();
  const retry = vi.fn();
  const managedConnection: RemoteDesktopManagedConnection = {
    hostKey: 'host-ios-1',
    serverId: 'host-ios-1',
    current: () => snapshot,
    start: vi.fn(async () => undefined),
    setMode: vi.fn(),
    selectDisplay: vi.fn(() => true),
    setDisplayMode: vi.fn(() => true),
    setDisplayScale: vi.fn(() => true),
    requestUnlock: vi.fn(() => true),
    setQualityPreference: vi.fn(() => true),
    requestRemoteClipboard: vi.fn(async () => null),
    acknowledgePresentedFrame: vi.fn(() => true),
    pointerMove: vi.fn(),
    pointerButton: vi.fn(() => true),
    pointerClick: vi.fn(() => true),
    wheel: vi.fn(() => true),
    key: vi.fn(() => true),
    tapChords: vi.fn(() => true),
    text: vi.fn(() => true),
    pasteText: vi.fn(() => true),
    releaseAll: vi.fn(),
    reconcileModifiers: vi.fn(),
    noteMetaChordKey: vi.fn(),
    releasePointerButtons: vi.fn(),
    stop: vi.fn(),
    retry,
    subscribe: (_presentation, listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const manager = {
    presentation: vi.fn(() => managedConnection),
  } as unknown as RemoteDesktopConnectionManager;

  const pushSnapshot = (next: Partial<RemoteDesktopSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  return { manager, retry, pushSnapshot };
}

function configureVideoMetrics(
  video: HTMLVideoElement,
  options: {
    paused?: boolean;
    readyState?: number;
    videoWidth?: number;
    videoHeight?: number;
    playImpl?: () => Promise<void>;
    rvfc?: (cb: VideoFrameRequestCallback) => number;
    cancelRvfc?: (id: number) => void;
  },
) {
  if ('paused' in options) {
    Object.defineProperty(video, 'paused', { configurable: true, value: options.paused });
  }
  if ('readyState' in options) {
    Object.defineProperty(video, 'readyState', { configurable: true, value: options.readyState });
  }
  if ('videoWidth' in options) {
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: options.videoWidth });
  }
  if ('videoHeight' in options) {
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: options.videoHeight });
  }
  if (options.playImpl) {
    Object.defineProperty(video, 'play', { configurable: true, value: options.playImpl });
  }
  if (options.rvfc) {
    Object.defineProperty(video, 'requestVideoFrameCallback', { configurable: true, value: options.rvfc });
  }
  if (options.cancelRvfc) {
    Object.defineProperty(video, 'cancelVideoFrameCallback', { configurable: true, value: options.cancelRvfc });
  }
}

describe('remote desktop iOS minimize/restore and reconnect video recovery', () => {
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    HTMLMediaElement.prototype.play = originalPlay;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('hides minimized workspace and inactive tabs offscreen without display: none', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/components/remote-desktop-workspace.css'), 'utf8');
    expect(css).not.toMatch(/\.remote-desktop-workspace\s*>\s*\.remote-desktop-panel\[hidden\][^}]*display:\s*none/i);
    expect(css).not.toMatch(/\.remote-desktop-workspace-window\[hidden\][^}]*display:\s*none/i);
    expect(css).toMatch(/\.remote-desktop-workspace\s*>\s*\.remote-desktop-panel\[hidden\][\s\S]*visibility:\s*hidden\s*!important/);
    expect(css).toMatch(/\.remote-desktop-workspace\s*>\s*\.remote-desktop-panel\[hidden\][\s\S]*pointer-events:\s*none\s*!important/);
    expect(css).toMatch(/\.remote-desktop-workspace-window\[hidden\][\s\S]*visibility:\s*hidden\s*!important/);
    expect(css).toMatch(/\.remote-desktop-workspace-window\[hidden\][\s\S]*left:\s*-99999px\s*!important/);
  });

  it('calls play() on srcObject attach, remounts <video> on streamGeneration reconnect, and rebinds effects', () => {
    const observedElements: Element[] = [];
    const disconnectedCount = { value: 0 };
    globalThis.ResizeObserver = class {
      observe = vi.fn((el: Element) => {
        observedElements.push(el);
      });
      unobserve = vi.fn();
      disconnect = vi.fn(() => {
        disconnectedCount.value += 1;
      });
    } as unknown as typeof ResizeObserver;

    const playMock = vi.fn(async () => undefined);
    HTMLMediaElement.prototype.play = playMock;

    const { stream: stream1 } = makeMediaStream('live');
    const { stream: stream2 } = makeMediaStream('live');
    const { stream: stream2b } = makeMediaStream('live');
    const { manager, pushSnapshot } = createFakeConnectionManager(makeSnapshot({
      stream: stream1,
      streamGeneration: 1,
    }));

    const view = render(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );

    const video1 = view.container.querySelector('video') as HTMLVideoElement;
    expect(video1).not.toBeNull();
    expect(video1.srcObject).toBe(stream1);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(observedElements).toContain(video1);

    // Reconnect: streamGeneration advances -> mounts a brand-new <video>, clears old srcObject, calls play() & re-observes.
    act(() => {
      pushSnapshot({ stream: stream2, streamGeneration: 2 });
    });

    const video2 = view.container.querySelector('video') as HTMLVideoElement;
    expect(video2).not.toBeNull();
    expect(video2).not.toBe(video1);
    expect(video1.srcObject).toBeNull();
    expect(video2.srcObject).toBe(stream2);
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(observedElements).toContain(video2);

    // Same-peer stream update (same streamGeneration): reuses existing <video> element without remount.
    act(() => {
      pushSnapshot({ stream: stream2b, streamGeneration: 2 });
    });

    const videoAfterQualityUpdate = view.container.querySelector('video') as HTMLVideoElement;
    expect(videoAfterQualityUpdate).toBe(video2);
    expect(video2.srcObject).toBe(stream2b);
    expect(playMock).toHaveBeenCalledTimes(3);
  });

  it('recovers stalled <video> at most once on minimize->restore when live tracks produce no frame, and leaves healthy video intact', () => {
    const playMock = vi.fn(async () => undefined);
    HTMLMediaElement.prototype.play = playMock;

    const { stream } = makeMediaStream('live');
    const { manager, retry } = createFakeConnectionManager(makeSnapshot({
      stream,
      streamGeneration: 1,
    }));

    const view = render(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );

    const video1 = view.container.querySelector('video') as HTMLVideoElement;
    configureVideoMetrics(video1, { paused: true, readyState: 0, videoWidth: 0, videoHeight: 0 });
    playMock.mockClear();

    // Minimize -> hidden
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible={false}
        inputActive={false}
        onClose={vi.fn()}
      />,
    );
    expect(view.container.querySelector('.remote-desktop-panel')?.getAttribute('aria-hidden')).toBe('true');

    // Restore -> calls play(), then remounts <video> ONCE after 500ms if still wedged.
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );
    expect(playMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    const video2 = view.container.querySelector('video') as HTMLVideoElement;
    expect(video2).not.toBe(video1);
    expect(video2.srcObject).toBe(stream);
    expect(playMock).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();

    // Advancing further time must NOT cause repeated remounts for the same restore transition.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.container.querySelector('video')).toBe(video2);
    expect(playMock).toHaveBeenCalledTimes(2);
  });

  it('does not remount healthy or empty streams on restore or visibilitychange, and cancels pending timers if hidden again', () => {
    const playMock = vi.fn(async () => undefined);
    HTMLMediaElement.prototype.play = playMock;

    // Case A: Healthy static stream (readyState >= 2, videoWidth > 0, !paused) without rVFC -> never remounts.
    const { stream } = makeMediaStream('live');
    const { manager, pushSnapshot, retry } = createFakeConnectionManager(makeSnapshot({
      stream,
      streamGeneration: 1,
    }));

    const view = render(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible={false}
        inputActive={false}
        onClose={vi.fn()}
      />,
    );

    const video1 = view.container.querySelector('video') as HTMLVideoElement;
    configureVideoMetrics(video1, { paused: false, readyState: 4, videoWidth: 1920, videoHeight: 1080 });
    playMock.mockClear();

    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );
    expect(playMock).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(view.container.querySelector('video')).toBe(video1);

    // Case B: Wedged restore cancelled immediately by re-minimizing before 500ms -> no remount while hidden.
    configureVideoMetrics(video1, { paused: true, readyState: 0, videoWidth: 0, videoHeight: 0 });
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible={false}
        inputActive={false}
        onClose={vi.fn()}
      />,
    );
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible={false}
        inputActive={false}
        onClose={vi.fn()}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(view.container.querySelector('video')).toBe(video1);

    // Case C: App foreground (visibilitychange -> visible) while hidden stays no-op.
    playMock.mockClear();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(playMock).not.toHaveBeenCalled();

    // Case D: Stream null (disconnected/connecting) while visible -> visibilitychange does not remount or retry.
    act(() => {
      pushSnapshot({ stream: null });
    });
    view.rerender(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(1000);
    });
    expect(view.container.querySelector('video')).toBe(video1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('recovers foregrounded iOS app via rVFC frame check or single retry() when all tracks are ended', () => {
    const playMock = vi.fn(async () => undefined);
    HTMLMediaElement.prototype.play = playMock;

    let nextRvfcId = 1;
    let pendingRvfc: VideoFrameRequestCallback | null = null;
    const cancelRvfc = vi.fn();

    const { stream: liveStream, track: liveTrack } = makeMediaStream('live');
    const { manager, pushSnapshot, retry } = createFakeConnectionManager(makeSnapshot({
      stream: liveStream,
      streamGeneration: 1,
    }));

    const view = render(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        visible
        inputActive
        onClose={vi.fn()}
      />,
    );

    const video1 = view.container.querySelector('video') as HTMLVideoElement;
    configureVideoMetrics(video1, {
      paused: false,
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      rvfc: vi.fn((cb: VideoFrameRequestCallback) => {
        pendingRvfc = cb;
        return nextRvfcId++;
      }),
      cancelRvfc,
    });
    playMock.mockClear();

    // App goes background -> foreground, rVFC produces a frame -> NO remount.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(pendingRvfc).not.toBeNull();
    act(() => {
      pendingRvfc?.(100, {} as VideoFrameCallbackMetadata);
      vi.advanceTimersByTime(600);
    });
    expect(view.container.querySelector('video')).toBe(video1);

    // Next foreground: rVFC never fires within 500ms -> remounts <video> once.
    pendingRvfc = null;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(500);
    });
    const video2 = view.container.querySelector('video') as HTMLVideoElement;
    expect(video2).not.toBe(video1);
    expect(retry).not.toHaveBeenCalled();

    // When all video tracks are ended on restore/foreground -> calls retry() once per dead stream.
    (liveTrack as { readyState: MediaStreamTrackState }).readyState = 'ended';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(retry).toHaveBeenCalledTimes(1);

    // After retry produces a new stream that later ends, retry() can run once for the new stream too.
    const { stream: deadStream2 } = makeMediaStream('ended');
    act(() => {
      pushSnapshot({ stream: deadStream2, streamGeneration: 2 });
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
