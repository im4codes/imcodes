/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_STOP_ORIGIN,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '@shared/remote-desktop.js';
import {
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
} from '@shared/transport/file-transfer.js';
import { SESSION_STOP_COMMAND } from '@shared/session-control-commands.js';
import { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } from '@shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} from '@shared/remote-desktop-platform.js';
import { DEFAULT_QUICK_PHRASES } from '../src/quick-commands.js';

// A complete v3 macOS session profile, resolved by
// resolveRemoteDesktopSessionProfile the same way RemoteDesktopPanel itself
// resolves it: this is what makes the command bridge choose Command over
// Control for an Apple controller's shortcuts.
const MAC_TARGET_CAPABILITIES = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const;
const LINUX_TARGET_CAPABILITIES = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const pointerButton = vi.fn(() => true);
const pointerClick = vi.fn(() => true);
const pointerMove = vi.fn();
const wheel = vi.fn(() => true);
const releaseAll = vi.fn();
const releasePointerButtons = vi.fn();
const acknowledgePresentedFrame = vi.fn(() => true);
const setDisplayMode = vi.fn(() => true);
const setDisplayScale = vi.fn(() => true);
const setMode = vi.fn(() => true);
const key = vi.fn(() => true);
const tapChords = vi.fn(() => true);
const text = vi.fn(() => true);
const textByServer = vi.fn<(serverId: string, value: string) => boolean>(() => true);
const requestRemoteClipboard = vi.fn(async () => 'selected remotely');
const selectDisplay = vi.fn(() => true);
const setQualityPreference = vi.fn(() => true);
const stop = vi.fn();
const directTransferMocks = vi.hoisted(() => ({
  uploadFileWithDirectFallback: vi.fn(),
  downloadPreviewWithDirectFallback: vi.fn(),
  selectPreviewDownloadDestination: vi.fn().mockResolvedValue(null),
}));
const { uploadFileWithDirectFallback } = directTransferMocks;
const fileApiMocks = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  createMachineFileHandle: vi.fn(),
}));
const directoryAdapters = vi.hoisted(() => [] as Array<{
  serverId: string;
  destroy: ReturnType<typeof vi.fn>;
}>);
const clientHooks: Array<{ onSnapshot(value: unknown): void }> = [];
const clientStarts: number[] = [];
let atomicButtonClickAdvertised = true;

vi.mock('../src/remote-desktop-client.js', () => ({
  RemoteDesktopClient: class {
    constructor(readonly serverId: string, hooks: { onSnapshot(value: unknown): void }) {
      clientHooks.push(hooks);
      queueMicrotask(() => hooks.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: true,
        atomicButtonClick: atomicButtonClickAdvertised,
        route: 'direct',
        displays: [
          {
            id: 'display-primary', label: 'Display 1', primary: true, available: true,
            width: 1920, height: 1080, dpiScale: 2.25, rotation: 0,
          },
          {
            id: 'display-second', label: 'Display 2', primary: false, available: true,
            width: 2560, height: 1440, dpiScale: 1.5, rotation: 0,
          },
        ],
        selectedDisplayId: 'display-primary',
        layoutRevision: 1,
        stream: null,
      }));
    }
    current = () => ({
      state: REMOTE_DESKTOP_STATE.AUTHORIZING,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      durationMs: 0,
      reconnectCount: 0,
    });
    start = vi.fn(async (reconnectAttempt = 0) => { clientStarts.push(reconnectAttempt); });
    stop = stop;
    releaseAll = releaseAll;
    releasePointerButtons = releasePointerButtons;
    acknowledgePresentedFrame = acknowledgePresentedFrame;
    pointerButton = pointerButton;
    pointerClick = pointerClick;
    pointerMove = pointerMove;
    wheel = wheel;
    key = key;
    tapChords = tapChords;
    text = (value: string) => {
      text(value);
      return textByServer(this.serverId, value);
    };
    setMode = setMode;
    selectDisplay = selectDisplay;
    setDisplayMode = setDisplayMode;
    setDisplayScale = setDisplayScale;
    requestUnlock = vi.fn(() => true);
    setQualityPreference = setQualityPreference;
    requestRemoteClipboard = requestRemoteClipboard;
  },
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: fileApiMocks.downloadAttachment,
}));

vi.mock('../src/direct-file-transfer.js', () => {
  const DIRECT_FILE_TRANSFER_ERROR = { CANCELED: 'canceled' } as const;
  class DirectFileTransferFailure extends Error {
    constructor(readonly code: string, readonly retryable = true, message = code) {
      super(message);
      this.name = 'DirectFileTransferFailure';
    }
  }
  return {
    // Keep this mock aligned with the panel's presentation-state import. The
    // production helper owns these strings; the test only substitutes transport
    // execution, not the panel's transfer-row state machine.
    FILE_UPLOAD_TRANSPORT_MODE: {
      CONNECTING: 'connecting',
      DIRECT: 'direct',
      FALLING_BACK: 'falling_back',
      RELAY: 'relay',
    },
    FILE_DOWNLOAD_TRANSPORT_MODE: {
      CONNECTING: 'connecting',
      DIRECT: 'direct',
      FALLING_BACK: 'falling_back',
      HTTP: 'http',
      BROWSER: 'browser',
    },
    DIRECT_FILE_TRANSFER_ERROR,
    DirectFileTransferFailure,
    uploadFileWithDirectFallback: directTransferMocks.uploadFileWithDirectFallback,
    downloadPreviewWithDirectFallback: directTransferMocks.downloadPreviewWithDirectFallback,
    selectPreviewDownloadDestination: directTransferMocks.selectPreviewDownloadDestination,
    isFileUploadCanceled: (error: unknown) => (
      (error instanceof DirectFileTransferFailure && error.code === DIRECT_FILE_TRANSFER_ERROR.CANCELED)
      || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
    ),
  };
});

vi.mock('../src/api/machines.js', () => ({
  createMachineFileHandle: fileApiMocks.createMachineFileHandle,
  listMachineDirectories: vi.fn(),
}));

vi.mock('../src/machine-directory-ws-adapter.js', () => ({
  MachineDirectoryWsAdapter: class {
    readonly destroy = vi.fn();
    constructor(readonly serverId: string) {
      directoryAdapters.push(this);
    }
    asWsClient() { return {}; }
  },
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: (props: {
    onCurrentPathChange?(path: string): void;
    onSelectedPathChange?(path: string | null, isDirectory: boolean): void;
  }) => (
    <div data-testid="remote-file-browser">
      <button
        type="button"
        onClick={() => {
          props.onCurrentPathChange?.('C:\\Users\\admin\\Desktop');
          props.onSelectedPathChange?.('C:\\Users\\admin\\Desktop\\report.txt', false);
        }}
      >select-remote-file</button>
    </div>
  ),
}));

import { RemoteDesktopPanel } from '../src/components/RemoteDesktopPanel.js';
import { RemoteDesktopWorkspace } from '../src/components/RemoteDesktopWorkspace.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';
import { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import { REMOTE_DESKTOP_QUALITY_STORAGE_KEY } from '../src/remote-desktop-quality-preference.js';
import {
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
} from '../src/remote-desktop-workspace-state.js';
import {
  REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT,
  clearRemoteDesktopBrowserDiagnostics,
  readRemoteDesktopBrowserDiagnostics,
} from '../src/remote-desktop-browser-diagnostics.js';
import {
  DIRECT_FILE_TRANSFER_ERROR,
  DirectFileTransferFailure,
} from '../src/direct-file-transfer.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  directTransferMocks.selectPreviewDownloadDestination.mockReset().mockResolvedValue(null);
  directTransferMocks.downloadPreviewWithDirectFallback.mockReset();
  vi.useRealTimers();
  clientHooks.length = 0;
  clientStarts.length = 0;
  directoryAdapters.length = 0;
  atomicButtonClickAdvertised = true;
  localStorage.removeItem('rcc_float_remote-desktop-server-1');
  localStorage.removeItem('imcodes.web.remote-desktop.zoom.v1.server-1');
  localStorage.removeItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY);
  delete (document as Document & { fullscreenElement?: Element | null }).fullscreenElement;
});

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  values: { pointerId: number; clientX: number; clientY: number },
): void {
  const eventName = type === 'pointerdown' && !('onpointerdown' in target)
    ? 'PointerDown'
    : type === 'pointermove' && !('onpointermove' in target)
      ? 'PointerMove'
      : type === 'pointerup' && !('onpointerup' in target)
        ? 'PointerUp'
        : type;
  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: 'touch' },
    button: { value: 0 },
  });
  target.dispatchEvent(event);
}

function mousePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerenter' | 'pointerleave' | 'lostpointercapture',
  values: { pointerId: number; clientX: number; clientY: number; button?: number; metaKey?: boolean },
): void {
  const eventName = type === 'pointerdown' && !('onpointerdown' in target)
    ? 'PointerDown'
    : type === 'pointermove' && !('onpointermove' in target)
      ? 'PointerMove'
    : type === 'pointerup' && !('onpointerup' in target)
      ? 'PointerUp'
      : type === 'pointerenter' && !('onpointerenter' in target)
        ? 'PointerEnter'
        : type === 'pointerleave' && !('onpointerleave' in target)
          ? 'PointerLeave'
      : type === 'pointercancel' && !('onpointercancel' in target)
        ? 'PointerCancel'
        : type === 'lostpointercapture' && !('onlostpointercapture' in target)
          ? 'LostPointerCapture'
      : type;
  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
    button: values.button ?? 0,
    metaKey: values.metaKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: 'mouse' },
  });
  target.dispatchEvent(event);
}

function nativeMousePointerMove(
  target: EventTarget,
  values: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  });
  target.dispatchEvent(event);
}

function nativeMouseMove(
  target: EventTarget,
  values: { clientX: number; clientY: number },
): void {
  target.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
  }));
}

async function renderPanel(
  ws?: { targetsServer(serverId: string): boolean },
  capabilities: string[] = [REMOTE_DESKTOP_CAPABILITY],
  panelProps: {
    allowStandaloneWindow?: boolean;
    onClose?: () => void;
    connectionManager?: RemoteDesktopConnectionManager;
    standalone?: boolean;
    embedded?: boolean;
    active?: boolean;
    inputActive?: boolean;
    quickData?: UseQuickDataResult;
  } = {},
) {
  const result = render(<RemoteDesktopPanel
    machine={{
      serverId: 'server-1',
      refName: 'controlled-1',
      displayName: 'Windows',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities,
    }}
    ws={ws as never}
    onClose={panelProps.onClose ?? vi.fn()}
    allowStandaloneWindow={panelProps.allowStandaloneWindow}
    standalone={panelProps.standalone}
    embedded={panelProps.embedded}
    active={panelProps.active}
    inputActive={panelProps.inputActive}
    quickData={panelProps.quickData}
    connectionManager={panelProps.connectionManager}
  />);
  await act(async () => { await Promise.resolve(); });
  const stage = result.container.querySelector('.remote-desktop-stage') as HTMLDivElement;
  const video = result.container.querySelector('video') as HTMLVideoElement;
  Object.defineProperties(stage, {
    clientWidth: { value: 400, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  Object.defineProperties(video, {
    offsetWidth: { value: 400, configurable: true },
    offsetHeight: { value: 300, configurable: true },
    videoWidth: { value: 1920, configurable: true },
    videoHeight: { value: 1080, configurable: true },
  });
  stage.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
    width: 400, height: 300, toJSON: () => ({}),
  });
  video.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
    width: 400, height: 300, toJSON: () => ({}),
  });
  return { ...result, stage, video };
}

describe('RemoteDesktopPanel mobile gestures', () => {
  it('shows a dimmed last presented frame during a transient media gap and clears it at authority loss', async () => {
    let presentedCallback: VideoFrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: VideoFrameRequestCallback) => {
      presentedCallback = callback;
      return 71;
    });
    const cancelFrame = vi.fn();
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage, clearRect } as unknown as CanvasRenderingContext2D);
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: { configurable: true, value: requestFrame },
      cancelVideoFrameCallback: { configurable: true, value: cancelFrame },
    });
    clearRemoteDesktopBrowserDiagnostics('server-1');
    try {
      const track = Object.assign(new EventTarget(), {
        muted: false,
        readyState: 'live' as MediaStreamTrackState,
      });
      const stream = {
        getVideoTracks: () => [track],
      } as unknown as MediaStream;
      const rendered = await renderPanel();
      act(() => clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: true,
        route: 'direct',
        displays: [{
          id: 'display-primary', label: 'Display 1', primary: true, available: true,
          width: 1920, height: 1080, dpiScale: 2.25, rotation: 0,
        }],
        selectedDisplayId: 'display-primary',
        layoutRevision: 1,
        stream,
      }));
      act(() => presentedCallback?.(100, {} as VideoFrameCallbackMetadata));
      expect(drawImage).toHaveBeenCalled();

      track.muted = true;
      act(() => track.dispatchEvent(new Event('mute')));
      const fallback = rendered.container.querySelector('.remote-desktop-last-frame');
      expect(fallback?.classList.contains('is-visible')).toBe(true);
      expect(rendered.container.querySelector('.remote-desktop-media-recovery')?.textContent)
        .toBe('remote_desktop.media_recovering');

      track.muted = false;
      act(() => track.dispatchEvent(new Event('unmute')));
      expect(fallback?.classList.contains('is-visible')).toBe(true);
      act(() => presentedCallback?.(200, {} as VideoFrameCallbackMetadata));
      expect(fallback?.classList.contains('is-visible')).toBe(false);
      act(() => rendered.video.dispatchEvent(new Event('waiting')));
      expect(fallback?.classList.contains('is-visible')).toBe(true);
      act(() => presentedCallback?.(1_200, {} as VideoFrameCallbackMetadata));
      expect(fallback?.classList.contains('is-visible')).toBe(false);
      expect(readRemoteDesktopBrowserDiagnostics('server-1').map((event) => event.type))
        .toEqual(expect.arrayContaining([
          REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FRAME,
          REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FALLBACK_SHOWN,
          REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FALLBACK_HIDDEN,
        ]));

      act(() => clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.FAILED,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: false,
        displays: [],
        layoutRevision: 1,
        // Preserve the MediaStream object to prove the terminal authority
        // gate itself clears pixels; stream replacement has a separate RED.
        stream,
        terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
      }));
      expect(fallback?.classList.contains('is-visible')).toBe(false);
      expect(clearRect).toHaveBeenCalled();
      expect((fallback as HTMLCanvasElement).width).toBe(1);
    } finally {
      getContext.mockRestore();
      delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
      delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
    }
  });

  it('never carries a cached sensitive frame across a route stream replacement', async () => {
    let presentedCallback: VideoFrameRequestCallback | undefined;
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: {
        configurable: true,
        value: (callback: VideoFrameRequestCallback) => { presentedCallback = callback; return 81; },
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const clearRect = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), clearRect,
    } as unknown as CanvasRenderingContext2D);
    try {
      const firstTrack = Object.assign(new EventTarget(), { muted: false, readyState: 'live' });
      const first = { getVideoTracks: () => [firstTrack] } as unknown as MediaStream;
      const second = { getVideoTracks: () => [Object.assign(new EventTarget(), {
        muted: false, readyState: 'live',
      })] } as unknown as MediaStream;
      const rendered = await renderPanel();
      const snapshot = {
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 0,
        inputEnabled: false,
        route: 'direct',
        displays: [],
        layoutRevision: 1,
      };
      act(() => clientHooks[0]!.onSnapshot({ ...snapshot, stream: first }));
      act(() => presentedCallback?.(100, {} as VideoFrameCallbackMetadata));
      firstTrack.muted = true;
      act(() => firstTrack.dispatchEvent(new Event('mute')));
      await act(async () => { await Promise.resolve(); });
      expect(rendered.container.querySelector('.remote-desktop-last-frame')?.classList
        .contains('is-visible')).toBe(true);

      act(() => clientHooks[0]!.onSnapshot({ ...snapshot, stream: second }));
      const fallback = rendered.container.querySelector('.remote-desktop-last-frame') as HTMLCanvasElement;
      expect(fallback.classList.contains('is-visible')).toBe(false);
      expect(fallback.width).toBe(1);
      expect(clearRect).toHaveBeenCalled();
    } finally {
      getContext.mockRestore();
      delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
      delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
    }
  });

  it('clears only the affected workspace host when Server authority is terminally lost', async () => {
    const onAuthorityLost = vi.fn();
    render(<RemoteDesktopPanel
      machine={{
        serverId: 'server-1',
        refName: 'controlled-1',
        displayName: 'Windows',
        os: 'win',
        online: true,
        execEnabled: true,
        accessRole: 'owner',
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }}
      connectionManager={new RemoteDesktopConnectionManager()}
      onClose={vi.fn()}
      onAuthorityLost={onAuthorityLost}
    />);
    await act(async () => { await Promise.resolve(); });

    act(() => clientHooks[0].onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      durationMs: 0,
      reconnectCount: 0,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    }));
    expect(onAuthorityLost).toHaveBeenCalledTimes(1);
  });

  it('remembers the stream quality per server and reopens with the same choice', async () => {
    const machine = (serverId: string) => ({
      serverId,
      refName: serverId,
      displayName: 'Windows',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    });
    const trigger = (result: ReturnType<typeof render>) => result.getByRole('button', {
      name: /remote_desktop\.quality_label: /,
    });
    const first = render(<RemoteDesktopPanel machine={machine('server-1')} onClose={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    // Nothing saved yet: the default, and it is what the client is told.
    expect(trigger(first).getAttribute('aria-label')).toContain('quality_short_smooth');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate' },
      { latencyGuard: true },
    );

    // One compact dropdown, not a row of buttons.
    await act(async () => { fireEvent.click(trigger(first)); await Promise.resolve(); });
    await act(async () => {
      fireEvent.click(first.getByRole('radio', { name: /quality_short_sharp/ }));
      await Promise.resolve();
    });
    expect(first.queryByRole('radio', { name: /quality_short_sharp/ })).toBeNull();
    expect(trigger(first).getAttribute('aria-label')).toContain('quality_short_sharp');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 0, maxFps: 30, maxBitrateBps: 0, priority: 'resolution' },
      { latencyGuard: true },
    );
    first.unmount();

    // Reopened later: the same server comes back with the same choice and
    // applies it to the new connection straight away.
    setQualityPreference.mockClear();
    const reopened = render(<RemoteDesktopPanel machine={machine('server-1')} onClose={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(trigger(reopened).getAttribute('aria-label')).toContain('quality_short_sharp');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 0, maxFps: 30, maxBitrateBps: 0, priority: 'resolution' },
      { latencyGuard: true },
    );

    // Another server keeps its own setting, even in the same panel.
    reopened.rerender(<RemoteDesktopPanel machine={machine('server-2')} onClose={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(trigger(reopened).getAttribute('aria-label')).toContain('quality_short_smooth');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 1080, maxFps: 30, maxBitrateBps: 0, priority: 'framerate' },
      { latencyGuard: true },
    );
  });

  it('rebinds the directory picker adapter when a canonical host changes execution endpoint', async () => {
    const connectionManager = new RemoteDesktopConnectionManager();
    const machine = (serverId: string) => ({
      serverId,
      remoteDesktopHostId: 'canonical-host',
      refName: serverId,
      displayName: 'Windows',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    });
    const result = render(<RemoteDesktopPanel
      machine={machine('endpoint-a')}
      connectionManager={connectionManager}
      onClose={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });

    expect(directoryAdapters.map((adapter) => adapter.serverId)).toEqual(['endpoint-a']);
    result.rerender(<RemoteDesktopPanel
      machine={machine('endpoint-b')}
      connectionManager={connectionManager}
      onClose={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });

    expect(directoryAdapters.map((adapter) => adapter.serverId)).toEqual(['endpoint-a', 'endpoint-b']);
    expect(directoryAdapters[0].destroy).toHaveBeenCalledTimes(1);
    expect(clientHooks).toHaveLength(2);
    connectionManager.stopAll(REMOTE_DESKTOP_STOP_ORIGIN.APP_UNMOUNT);
  });

  it('remounts its presentation without replacing the workspace connection', async () => {
    const connectionManager = new RemoteDesktopConnectionManager();
    const first = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      connectionManager,
    });
    expect(clientHooks).toHaveLength(1);
    expect(clientStarts).toEqual([0]);

    first.unmount();
    expect(stop).not.toHaveBeenCalled();
    expect(releaseAll).toHaveBeenCalledTimes(1);

    const remounted = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      connectionManager,
    });
    expect(clientHooks).toHaveLength(1);
    expect(clientStarts).toEqual([0]);

    remounted.unmount();
    connectionManager.stopAll(REMOTE_DESKTOP_STOP_ORIGIN.APP_UNMOUNT);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('opens the same controlled machine in an independent browser window', async () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      allowStandaloneWindow: true,
      onClose,
    });

    act(() => (result.getByRole('button', {
      name: 'remote_desktop.open_new_window',
    }) as HTMLButtonElement).click());

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(new URL(String(url)).searchParams.get('remoteDesktopServer')).toBe('server-1');
    expect(target).toBe('_blank');
    expect(features).toContain('popup');
    expect(opened.opener).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the current desktop connected when the standalone popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      allowStandaloneWindow: true,
      onClose,
    });

    act(() => (result.getByRole('button', {
      name: 'remote_desktop.open_new_window',
    }) as HTMLButtonElement).click());

    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not offer standalone windows on mobile', async () => {
    const result = await renderPanel();

    expect(result.queryByRole('button', {
      name: 'remote_desktop.open_new_window',
    })).toBeNull();
  });

  it('keeps window controls in the toolbar without a second title or minimized dock', async () => {
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      onClose,
    });

    expect(result.container.querySelector('.remote-desktop-header')).toBeNull();
    expect(result.container.querySelector('.remote-desktop-minimized-dock')).toBeNull();
    const maximize = result.getByRole('button', { name: 'window.maximize' });
    expect(maximize.classList.contains('subsession-minimize-btn')).toBe(true);
    act(() => (maximize as HTMLButtonElement).click());
    expect(result.getByRole('button', { name: 'window.restore' })).toBeTruthy();

    const stopButton = result.container.querySelector('.remote-desktop-stop');
    expect(stopButton?.classList.contains('subsession-close-btn')).toBe(true);
  });

  it('hides connection diagnostics behind the Nerd toggle by default', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => clientHooks.at(-1)?.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: true,
      route: 'direct',
      displays: [],
      layoutRevision: 1,
      stream: null,
      viewerCount: 2,
      controllerCount: 1,
    }));

    expect(container.querySelector('.remote-desktop-header')).toBeNull();
    expect(container.querySelector('.remote-desktop-presence')).toBeNull();
    // "优化连接中" belongs to the connecting overlay in the middle of the
    // screen, not to the footer, where it sat beside every stacked toolbar and
    // said nothing about a session that was already up.
    expect(container.querySelector('.remote-desktop-connection-summary')?.textContent)
      .not.toContain('remote_desktop.connection_optimizing');
    // Presence and link are readable without asking for them.
    expect(container.querySelector('[data-viewer-count]')?.closest('.remote-desktop-stats')).not.toBeNull();
    expect(container.querySelector('[data-controller-count]')?.closest('.remote-desktop-stats')).not.toBeNull();
    expect(container.querySelector('.remote-desktop-stats')?.textContent).toContain('remote_desktop.route');
    expect(container.querySelector('.remote-desktop-stats')?.textContent).toContain('remote_desktop.duration');
    expect(container.querySelector('.remote-desktop-diagnostics')).toBeNull();
    const toggle = getByRole('button', { name: 'remote_desktop.nerd_stats_show' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    act(() => (toggle as HTMLButtonElement).click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.remote-desktop-diagnostics')).not.toBeNull();
  });

  it('uses the compact toolbar as the drag handle and keeps eight-way resize', async () => {
    Object.defineProperties(window, {
      innerWidth: { value: 1600, configurable: true },
      innerHeight: { value: 1000, configurable: true },
    });
    const { container, getByTestId } = await renderPanel();
    const shell = getByTestId('floating-panel-remote-desktop-server-1') as HTMLDivElement;
    const toolbar = container.querySelector('.remote-desktop-toolbar') as HTMLElement;
    const initialLeft = Number.parseFloat(String(shell.style.left));
    const initialTop = Number.parseFloat(String(shell.style.top));
    const initialWidth = Number.parseFloat(String(shell.style.width));

    act(() => {
      toolbar.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 100,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 260, clientY: 140,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(Number.parseFloat(String(shell.style.left))).toBe(initialLeft + 60);
    expect(Number.parseFloat(String(shell.style.top))).toBe(initialTop + 40);

    const southeast = getByTestId('floating-resize-se');
    act(() => {
      southeast.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: 0, clientY: 0,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 80, clientY: 60,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(Number.parseFloat(String(shell.style.width))).toBe(initialWidth + 80);
    expect(container.querySelectorAll('[data-testid^="floating-resize-"]')).toHaveLength(8);
  });

  it('reuses direct file transfer progress/mode and cancels without touching the desktop peer', async () => {
    uploadFileWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
      onProgress?(progress: number): void;
      signal: AbortSignal;
    }) => {
      options.onMode?.('direct');
      options.onProgress?.(33);
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('upload_canceled', 'AbortError'));
        }, { once: true });
      });
    });
    const ws = { targetsServer: vi.fn(() => true) };
    const { container, getByRole } = await renderPanel(ws);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['payload'], 'report.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(uploadFileWithDirectFallback).not.toHaveBeenCalled();
    act(() => (getByRole('button', { name: 'remote_desktop.send_to_remote' }) as HTMLButtonElement).click());

    await vi.waitFor(() => expect(container.textContent).toContain('upload.transport.direct'));
    expect((container.querySelector('progress') as HTMLProgressElement).value).toBe(33);
    expect(ws.targetsServer).toHaveBeenCalledWith('server-1');
    expect(pointerMove).not.toHaveBeenCalled();

    act(() => (getByRole('button', { name: 'remote_desktop.cancel_transfer' }) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_canceled'));
  });

  it('keeps relay fallback visible in the remote-panel transfer row', async () => {
    uploadFileWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
      onProgress?(progress: number): void;
    }) => {
      options.onMode?.('falling_back');
      options.onMode?.('relay');
      options.onProgress?.(100);
      return { ok: true, attachment: { id: 'attachment-1' } };
    });
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['payload'], 'relay.txt')],
      configurable: true,
    });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    act(() => (getByRole('button', { name: 'remote_desktop.send_to_remote' }) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.textContent).toContain('upload.transport.relay'));
    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_done'));
  });

  it('uses the embedded remote file selection for an explicit fetch action', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'handle-1' });
    fileApiMocks.downloadAttachment.mockResolvedValue(undefined);
    const { getByRole } = await renderPanel(undefined, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(fileApiMocks.createMachineFileHandle).toHaveBeenCalledWith(
      'server-1',
      'C:\\Users\\admin\\Desktop\\report.txt',
      expect.any(AbortSignal),
    ));
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledWith(
      'server-1',
      'handle-1',
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('routes a panel fetch through the direct-first download helper before browser fallback', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'direct-handle-1' });
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue({
      handle: { createWritable: vi.fn() },
    });
    directTransferMocks.downloadPreviewWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
      onProgress?(progress: { loadedBytes: number; totalBytes: number | null }): void;
    }) => {
      options.onMode?.('direct');
      options.onProgress?.({ loadedBytes: 4, totalBytes: 8 });
    });
    const ws = { targetsServer: vi.fn(() => true) };
    const { container, getByRole } = await renderPanel(ws, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement).click(); });

    await vi.waitFor(() => expect(directTransferMocks.downloadPreviewWithDirectFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        ws,
        serverId: 'server-1',
        previewHandle: 'direct-handle-1',
        suggestedName: 'report.txt',
        signal: expect.any(AbortSignal),
      }),
    ));
    expect(directTransferMocks.selectPreviewDownloadDestination).toHaveBeenCalledWith('report.txt');
    expect(directTransferMocks.selectPreviewDownloadDestination.mock.invocationCallOrder[0]).toBeLessThan(
      fileApiMocks.createMachineFileHandle.mock.invocationCallOrder[0]!,
    );
    expect(container.textContent).toContain('upload.transport.direct');
    expect(fileApiMocks.downloadAttachment).not.toHaveBeenCalled();
  });

  it('offers Show in folder, and no web-address Open file, on a finished fetch saved through the picker', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'open-handle-1' });
    const savedHandle = {
      createWritable: vi.fn(),
      getFile: vi.fn(async () => new File(['report'], 'report.txt', { type: 'text/plain' })),
    };
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue({ handle: savedHandle });
    directTransferMocks.downloadPreviewWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
    }) => {
      options.onMode?.('direct');
    });
    const picker = vi.fn(async () => []);
    (globalThis as typeof globalThis & { showOpenFilePicker?: unknown }).showOpenFilePicker = picker;
    const open = vi.spyOn(window, 'open');
    try {
      const ws = { targetsServer: vi.fn(() => true) };
      const { container, getByRole, findByRole, queryByRole } = await renderPanel(ws, [
        REMOTE_DESKTOP_CAPABILITY,
        FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
        FILE_TRANSFER_DIRECTORY_CAPABILITY,
      ]);
      act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
      act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });
      act(() => { (getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement).click(); });
      await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_done'));

      expect(queryByRole('button', { name: 'downloads.open_file' })).toBeNull();
      const folder = await findByRole('button', { name: 'downloads.open_folder' });
      expect(folder.getAttribute('title')).toBe('downloads.open_folder_hint');
      act(() => { (folder as HTMLButtonElement).click(); });
      expect(picker).toHaveBeenCalledWith({ startIn: savedHandle });
      expect(open).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as typeof globalThis & { showOpenFilePicker?: unknown }).showOpenFilePicker;
      open.mockRestore();
    }
  });

  it('offers no open buttons for a fetch handed to the browser download manager', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'browser-handle-1' });
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue(null);
    directTransferMocks.downloadPreviewWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
    }) => {
      options.onMode?.('browser');
    });
    const ws = { targetsServer: vi.fn(() => true) };
    const { container, getByRole, queryByRole } = await renderPanel(ws, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_done'));

    expect(queryByRole('button', { name: 'downloads.open_file' })).toBeNull();
    expect(queryByRole('button', { name: 'downloads.open_folder' })).toBeNull();
  });

  it('classifies a canceled direct fetch as canceled instead of failed', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'cancel-handle-1' });
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue({
      handle: { createWritable: vi.fn() },
    });
    directTransferMocks.downloadPreviewWithDirectFallback.mockImplementation(async (options: {
      signal: AbortSignal;
    }) => await new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DirectFileTransferFailure(DIRECT_FILE_TRANSFER_ERROR.CANCELED, false));
      }, { once: true });
    }));
    const ws = { targetsServer: vi.fn(() => true) };
    const { container, getByRole } = await renderPanel(ws, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement).click(); });

    await vi.waitFor(() => expect(directTransferMocks.downloadPreviewWithDirectFallback).toHaveBeenCalled());
    act(() => { (getByRole('button', { name: 'remote_desktop.cancel_transfer' }) as HTMLButtonElement).click(); });

    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_canceled'));
    expect(container.textContent).not.toContain('remote_desktop.file_transfer_failed');
  });

  it('does not enable fetch from directory metadata without path-handle authority', async () => {
    const { getByRole } = await renderPanel(undefined, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_DIRECTORY_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('button', { name: 'select-remote-file' }) as HTMLButtonElement).click(); });

    const fetch = getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement;
    expect(fetch.disabled).toBe(true);
    act(() => fetch.click());
    expect(fileApiMocks.createMachineFileHandle).not.toHaveBeenCalled();
  });

  it('keeps exact-path fetch available for path-handle nodes without directory browsing', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'legacy-handle-1' });
    fileApiMocks.downloadAttachment.mockResolvedValue(undefined);
    const { container, getByRole } = await renderPanel(undefined, [
      REMOTE_DESKTOP_CAPABILITY,
      FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
    ]);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });

    expect(container.querySelector('[data-testid="remote-file-browser"]')).toBeNull();
    const fetch = getByRole('button', { name: 'remote_desktop.fetch_to_local' }) as HTMLButtonElement;
    expect(fetch.disabled).toBe(true);
    const exactPath = getByRole('textbox', { name: 'remote_desktop.fetch_path' }) as HTMLInputElement;
    act(() => {
      exactPath.value = 'C:\\Users\\admin\\Desktop\\legacy-report.txt';
      exactPath.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(fetch.disabled).toBe(false);
    act(() => fetch.click());

    await vi.waitFor(() => expect(fileApiMocks.createMachineFileHandle).toHaveBeenCalledWith(
      'server-1',
      'C:\\Users\\admin\\Desktop\\legacy-report.txt',
      expect.any(AbortSignal),
    ));
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledWith(
      'server-1',
      'legacy-handle-1',
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('shows bounded connection diagnostics without rendering signaling or authority secrets', async () => {
    const { container } = await renderPanel();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: true,
      route: 'relay',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 1920, height: 1080, dpiScale: 1.5, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 1,
      quality: {
        preset: '1080p30', encoderClass: 'software', width: 1920, height: 1080,
        fps: 29, bitrateBps: 4_200_000, droppedFrames: 3, rttMs: 24,
      },
      stream: null,
      durationMs: 12_000,
      reconnectCount: 2,
      capabilityVersion: REMOTE_DESKTOP_CAPABILITY,
      // These are deliberately outside the snapshot contract and therefore
      // must not become a rendering escape hatch for sensitive diagnostics.
      sdp: 'secret-sdp-marker',
      iceCredential: 'secret-turn-marker',
      rawCapability: 'secret-capability-marker',
      inputHistory: 'KeyA',
    }));
    // Resolution, frame rate and bitrate are always on: they are how you tell a
    // usable session from a bad one, so they must not need a toggle first.
    const stats = container.querySelector('.remote-desktop-stats');
    expect(stats?.textContent).toContain('1920×1080');
    expect(stats?.textContent).toContain('29 FPS');
    expect(stats?.textContent).toContain('4.2 Mbps · 24 ms');
    expect(stats?.textContent).toContain('remote_desktop.encoder');
    expect(stats?.textContent).toContain('remote_desktop.quality');
    expect(stats?.textContent).toContain('remote_desktop.dropped_frames');
    expect(container.querySelector('.remote-desktop-diagnostics')).toBeNull();
    act(() => (container.querySelector('.remote-desktop-nerd-toggle') as HTMLButtonElement).click());
    // Checked across the WHOLE footer, not just the nerd panel: moving fields
    // into an always-visible row would otherwise be a way to leak past a test
    // that only ever looked inside the panel.
    const footer = container.querySelector('.remote-desktop-footer');
    expect(footer?.textContent).not.toContain('secret-sdp-marker');
    expect(footer?.textContent).not.toContain('secret-turn-marker');
    expect(footer?.textContent).not.toContain('secret-capability-marker');
    expect(footer?.textContent).not.toContain('KeyA');
  });

  it('shows each handshake and media step while the desktop connection advances', async () => {
    const { container } = await renderPanel();
    const snapshot = {
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
    };
    const assertCurrentStep = (key: string) => {
      const progress = container.querySelector('.remote-desktop-connection-progress');
      expect(progress?.querySelectorAll('li')).toHaveLength(4);
      // Four dots, not four rows of text -- and one dot per stage, so the
      // count cannot drift away from REMOTE_DESKTOP_CONNECTION_STEPS.
      expect(progress?.querySelectorAll('.remote-desktop-connection-dot')).toHaveLength(4);
      // The heading is the one line of prose here.
      expect(progress?.querySelector('strong')?.textContent)
        .toContain('remote_desktop.connection_optimizing');
      // The stage name stays reachable for screen readers and on hover.
      expect(progress?.querySelector('[aria-current="step"]')?.textContent).toContain(key);
      expect(progress?.querySelector('[aria-current="step"]')?.getAttribute('title')).toBe(key);
    };

    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.AUTHORIZING }));
    assertCurrentStep('remote_desktop.connection_steps.authorize');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.PREPARING }));
    assertCurrentStep('remote_desktop.connection_steps.worker');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.CONNECTING }));
    assertCurrentStep('remote_desktop.connection_steps.negotiate');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.DIRECT, route: 'direct' }));
    assertCurrentStep('remote_desktop.connection_steps.media');

    const stream = {} as MediaStream;
    act(() => clientHooks[0]!.onSnapshot({
      ...snapshot,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      stream,
    }));
    assertCurrentStep('remote_desktop.connection_steps.media');
    act(() => {
      (container.querySelector('video') as HTMLVideoElement)
        .dispatchEvent(new Event('loadeddata'));
    });
    expect(container.querySelector('.remote-desktop-connection-progress')).toBeNull();
    const inputSurface = container.querySelector('[data-testid="remote-desktop-input-surface"]');
    expect(inputSurface).not.toBeNull();
    pointerMove.mockClear();
    act(() => {
      nativeMouseMove(inputSurface!, { clientX: 200, clientY: 150 });
      nativeMouseMove(inputSurface!, { clientX: 300, clientY: 150 });
    });
    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('owns non-bubbling hover movement on the painted video input surface', async () => {
    const { container, video } = await renderPanel();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 2,
      inputEnabled: true,
      route: 'direct',
      displays: [],
      layoutRevision: 1,
      stream: {} as MediaStream,
    }));
    act(() => video.dispatchEvent(new Event('loadeddata')));
    const inputSurface = container.querySelector('[data-testid="remote-desktop-input-surface"]');
    expect(inputSurface).not.toBeNull();
    pointerMove.mockClear();

    act(() => {
      inputSurface!.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: false,
        cancelable: true,
        clientX: 200,
        clientY: 150,
      }));
      inputSurface!.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: false,
        cancelable: true,
        clientX: 300,
        clientY: 150,
      }));
    });

    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('keeps monitor and mode controls keyboard-focusable while viewing', async () => {
    const { getByRole } = await renderPanel();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 2,
      inputEnabled: false,
      route: 'direct',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 1920, height: 1080, dpiScale: 1.5, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 2,
      stream: null,
    }));

    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });
    const controlButton = getByRole('button', { name: 'remote_desktop.control_mode' });
    displayTab.focus();
    expect(document.activeElement).toBe(displayTab);
    controlButton.focus();
    expect(document.activeElement).toBe(controlButton);
    expect((controlButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens each display resolution menu by context gesture and switches a fixed 720p-4K mode', async () => {
    const { getByRole, getAllByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });
    act(() => {
      displayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      }));
    });
    expect(getByRole('menu')).not.toBeNull();
    const modes = getAllByRole('menuitemradio').filter((mode) => (
      mode.textContent?.includes('×')
    ));
    expect(modes.map((mode) => mode.textContent)).toEqual([
      '720p1280×720',
      '1080p1920×1080',
      '1440p2560×1440',
      '4K3840×2160',
    ]);
    act(() => { (modes[3] as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-primary', 3840, 2160);

    act(() => {
      displayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      }));
    });
    act(() => { (getByRole('menuitemradio', { name: '150% DPI' }) as HTMLButtonElement).click(); });
    expect(setDisplayScale).toHaveBeenCalledWith('display-primary', 150);

    const secondDisplayTab = getByRole('tab', { name: 'remote_desktop.display_name' });
    act(() => {
      secondDisplayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 80,
        clientY: 50,
      }));
    });
    const secondModes = getAllByRole('menuitemradio').filter((mode) => (
      mode.textContent?.includes('×')
    ));
    act(() => { (secondModes[0] as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-second', 1280, 720);
  });

  it('focuses the stage for physical keyboard input and supports explicit copy and paste', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'local clipboard'),
        writeText: vi.fn(async () => {}),
      },
    });
    const { stage, getByRole } = await renderPanel();
    mousePointer(stage, 'pointerdown', {
      pointerId: 60, clientX: 200, clientY: 150,
    });
    expect(document.activeElement).toBe(stage);
    const escapedRemoteKey = vi.fn();
    document.addEventListener('keydown', escapedRemoteKey);
    act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyA',
      key: 'a',
    })));
    document.removeEventListener('keydown', escapedRemoteKey);
    expect(escapedRemoteKey).not.toHaveBeenCalled();
    expect(key).toHaveBeenCalledWith('KeyA', 'a', true, false, {
      control: false,
      alt: false,
    });

    key.mockClear();
    const selectAll = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyA',
      key: 'a',
      ctrlKey: true,
    });
    act(() => stage.dispatchEvent(selectAll));
    expect(selectAll.defaultPrevented).toBe(true);
    expect(key).toHaveBeenCalledWith('KeyA', 'a', true, false, {
      control: true,
      alt: false,
    });

    key.mockClear();
    const escape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Escape',
      key: 'Escape',
    });
    act(() => stage.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(key).toHaveBeenCalledWith('Escape', 'Escape', true, false, {
      control: false,
      alt: false,
    });
    expect(setMode).not.toHaveBeenCalled();

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: vi.fn(() => 'pasted from event') },
    });
    act(() => stage.dispatchEvent(pasteEvent));
    expect(text).toHaveBeenCalledWith('pasted from event');

    await act(async () => {
      (getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(text).toHaveBeenCalledWith('local clipboard');

    await act(async () => {
      (getByRole('button', { name: 'common.copy' }) as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected remotely');
  });

  it('defers Cmd+V on an Apple controller to the native paste event instead of prompting via readText()', async () => {
    // Safari/WebKit shows its own "Paste" confirmation callout every time
    // navigator.clipboard.readText() is called, even from inside the
    // keydown handler itself -- something a real Cmd+V paste never needs.
    // Leaving the keystroke alone lets the OS's own paste reach the browser
    // as a native `paste` event instead, with no extra confirmation.
    const readText = vi.fn(async () => 'should not be read');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    try {
      const { stage } = await renderPanel();
      const cmdV = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyV',
        key: 'v',
        metaKey: true,
      });
      act(() => stage.dispatchEvent(cmdV));
      expect(readText).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalledWith('KeyV', expect.anything(), expect.anything(), expect.anything(), expect.anything());
      // The keystroke was left alone (not preventDefault'd, not forwarded),
      // so it also never reaches the remote -- only the native paste event
      // that follows a real Cmd+V does.
      expect(cmdV.defaultPrevented).toBe(false);

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: { getData: vi.fn(() => 'pasted via native event') },
      });
      act(() => stage.dispatchEvent(pasteEvent));
      expect(text).toHaveBeenCalledWith('pasted via native event');
    } finally {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('still reads the clipboard directly for Ctrl+V on a non-Apple controller', async () => {
    const readText = vi.fn(async () => 'from readText');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    const { stage } = await renderPanel();
    const ctrlV = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyV',
      key: 'v',
      ctrlKey: true,
    });
    await act(async () => {
      stage.dispatchEvent(ctrlV);
      await Promise.resolve();
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith('from readText');
    expect(ctrlV.defaultPrevented).toBe(true);
  });

  it('shows a clipboard result as a floating toast that fades on its own', async () => {
    // The toolbar used to reserve a permanent min-width column for this text,
    // empty most of the time. It is now only in the DOM while a result is
    // actually showing, and clears itself instead of sitting stale forever.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'local clipboard'),
        writeText: vi.fn(async () => {}),
      },
    });
    const { container, getByRole } = await renderPanel();
    expect(container.querySelector('.remote-desktop-clipboard-toast')).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      (getByRole('button', { name: 'common.copy' }) as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    const toast = container.querySelector('.remote-desktop-clipboard-toast');
    expect(toast?.textContent).toBe('remote_desktop.clipboard_copied');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_800); });
    expect(container.querySelector('.remote-desktop-clipboard-toast')).toBeNull();
  });

  it('keeps the mobile IME focused and commits composed text once', async () => {
    const { container, getByRole } = await renderPanel();
    const keyboardButton = getByRole('button', { name: 'remote_desktop.mobile_keyboard' });
    const stylesheet = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
      'utf8',
    );
    expect(keyboardButton.textContent).toBe('⌨');
    expect(keyboardButton.closest('.remote-desktop-stage')).not.toBeNull();
    expect(keyboardButton.closest('.remote-desktop-toolbar')).toBeNull();
    expect(stylesheet).toMatch(/\.remote-desktop-keyboard-trigger\s*\{[^}]*position:\s*absolute[^}]*right:\s*12px[^}]*bottom:\s*12px[^}]*display:\s*none/);
    expect(stylesheet).toMatch(/\.remote-desktop-keyboard-trigger:not\(\[hidden\]\)\s*\{[^}]*display:\s*grid/);

    pointerButton.mockClear();
    fireEvent.pointerDown(keyboardButton, { pointerId: 91, pointerType: 'touch' });
    fireEvent.pointerUp(keyboardButton, { pointerId: 91, pointerType: 'touch' });
    expect(pointerButton).not.toHaveBeenCalled();
    act(() => { (keyboardButton as HTMLButtonElement).click(); });
    expect((keyboardButton as HTMLButtonElement).hidden).toBe(true);

    const input = getByRole('textbox', { name: 'remote_desktop.mobile_text_input' }) as HTMLTextAreaElement;
    // Focus/composition target only -- what is typed lands on the remote
    // screen, so this element itself must never render as a visible box.
    expect(input.classList.contains('remote-desktop-mobile-hidden-input')).toBe(true);
    input.focus();
    expect(document.activeElement).toBe(input);

    input.value = 'a';
    act(() => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a' })));
    expect(text).toHaveBeenCalledWith('a');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);

    text.mockClear();
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    input.value = 'ni';
    act(() => input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: 'ni',
      isComposing: true,
    })));
    expect(text).not.toHaveBeenCalled();
    expect(input.value).toBe('ni');
    const composingDelete = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
      isComposing: true,
    });
    act(() => input.dispatchEvent(composingDelete));
    expect(composingDelete.defaultPrevented).toBe(false);
    expect(key).not.toHaveBeenCalled();

    input.value = '你';
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
      await Promise.resolve();
    });
    expect(text.mock.calls).toEqual([['你']]);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);

    input.value = 'b';
    act(() => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'b' })));
    expect(text.mock.calls).toEqual([['你'], ['b']]);
    expect(document.activeElement).toBe(input);

    key.mockClear();
    const deleteBackward = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    });
    act(() => input.dispatchEvent(deleteBackward));
    expect(deleteBackward.defaultPrevented).toBe(true);
    expect(key.mock.calls).toEqual([
      ['Backspace', 'Backspace', true, false, { control: false, alt: false }],
      ['Backspace', 'Backspace', false, false, { control: false, alt: false }],
    ]);
    expect(text.mock.calls).toEqual([['你'], ['b']]);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('.remote-desktop-mobile-keyboard')).not.toBeNull();
  });

  it('clears the mobile IME input on a failed send, so a stuck value cannot poison every later keystroke', async () => {
    const { getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    const input = getByRole('textbox', { name: 'remote_desktop.mobile_text_input' }) as HTMLTextAreaElement;

    // A transient failure (data channel momentarily not open, a
    // protocol_error fail(), or any other transient client.text() false)
    // used to leave the DOM value behind -- an uncontrolled <textarea> whose
    // value survives a failed send keeps re-submitting that SAME stale value
    // on every later keystroke (onInput reads the accumulated DOM value, not
    // just what was newly typed), indistinguishable from typing never
    // reaching the remote session again for the rest of the session.
    textByServer.mockReturnValueOnce(false);
    input.value = 'a';
    act(() => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'a' })));
    expect(text).toHaveBeenCalledWith('a');
    expect(input.value).toBe('');

    // The next keystroke must be exactly the new character, not the failed
    // one re-appended to whatever the stale accumulated DOM value would have
    // been had it not been cleared above.
    text.mockClear();
    input.value = 'b';
    act(() => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'b' })));
    expect(text.mock.calls).toEqual([['b']]);
    expect(input.value).toBe('');

    // Same guarantee through the IME composition-commit path -- the one a
    // real CJK character actually takes (compositionend, not plain input).
    text.mockClear();
    textByServer.mockReturnValueOnce(false);
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    input.value = '中';
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
      await Promise.resolve();
    });
    expect(text.mock.calls).toEqual([['中']]);
    expect(input.value).toBe('');
  });

  it('docks the mobile keyboard below the stage instead of layering it on top', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });

    const stage = container.querySelector('.remote-desktop-stage');
    const keyboard = container.querySelector('.remote-desktop-mobile-keyboard');
    expect(keyboard).not.toBeNull();
    // A sibling of the stage, not a child of it -- so it takes its own space
    // in the panel layout instead of covering the video.
    expect(stage!.contains(keyboard)).toBe(false);
    expect(getByRole('textbox', { name: 'remote_desktop.mobile_text_input' })).toBeDefined();

    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
    });
    expect(container.querySelector('[aria-label="remote_desktop.mobile_text_input"]')).toBeNull();
    expect(container.querySelector('.remote-desktop-computer-keyboard')).not.toBeNull();

    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
    expect(getByRole('textbox', { name: 'remote_desktop.mobile_text_input' })).toBeDefined();
  });

  it('keeps the remote screen at its size while the mobile keyboard is open', async () => {
    const { container, getByRole } = await renderPanel();
    const stage = container.querySelector('.remote-desktop-stage') as HTMLElement;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 640 });
    const video = () => container.querySelector('.remote-desktop-stage video') as HTMLVideoElement;
    expect(video().style.width).toBe('');

    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    // Fitted into the stage as it was, not into what the keyboard leaves.
    expect(video().style.width).toBe('390px');
    expect(video().style.height).toBe('640px');
    expect(stage.classList.contains('is-keyboard-locked')).toBe(true);

    act(() => { (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(video().style.width).toBe('');
    expect(stage.classList.contains('is-keyboard-locked')).toBe(false);
  });

  it('gives the remote screen the hint and statistics space while the mobile keyboard is open', async () => {
    const { container, getByRole, queryByRole } = await renderPanel();
    const stylesheet = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
      'utf8',
    );
    expect(container.querySelector('.remote-desktop-touch-hint')).not.toBeNull();
    expect(container.querySelector('.remote-desktop-stats')).not.toBeNull();

    act(() => {
      (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
    });

    // Neither surface should merely become transparent: hidden removes the
    // footer grid row from layout and from the accessibility tree while the
    // phone keyboard is taking up the viewport.
    expect((container.querySelector('.remote-desktop-touch-hint') as HTMLElement).hidden).toBe(true);
    expect((container.querySelector('.remote-desktop-footer') as HTMLElement).hidden).toBe(true);
    expect(stylesheet).toMatch(/\.remote-desktop-touch-hint\[hidden\],[\s\S]*?\.remote-desktop-footer\[hidden\]\s*\{[^}]*display:\s*none/);
    expect(queryByRole('button', { name: 'remote_desktop.nerd_stats_show' })).toBeNull();

    // The compact computer-keyboard tab consumes screen space too, so the
    // same space-saving contract stays active when switching keyboard modes.
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
    });
    expect((container.querySelector('.remote-desktop-touch-hint') as HTMLElement).hidden).toBe(true);
    expect((container.querySelector('.remote-desktop-footer') as HTMLElement).hidden).toBe(true);

    act(() => {
      (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
    });
    expect((container.querySelector('.remote-desktop-touch-hint') as HTMLElement).hidden).toBe(false);
    expect((container.querySelector('.remote-desktop-footer') as HTMLElement).hidden).toBe(false);
  });

  it('auto-collapses the whole toolbar for the mobile keyboard and lets it be expanded and folded again', async () => {
    const { container, getByRole, queryByRole } = await renderPanel();
    const stylesheet = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
      'utf8',
    );
    const toolbar = container.querySelector('.remote-desktop-toolbar') as HTMLElement;
    const keyboardButton = getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement;
    expect(toolbar.hidden).toBe(false);
    expect(queryByRole('button', { name: 'remote_desktop.expand_toolbar' })).toBeNull();

    act(() => keyboardButton.click());
    expect(toolbar.hidden).toBe(true);
    const expand = getByRole('button', { name: 'remote_desktop.expand_toolbar' });
    expect(expand.getAttribute('aria-controls')).toBe(toolbar.id);
    expect(expand.getAttribute('aria-expanded')).toBe('false');

    act(() => (expand as HTMLButtonElement).click());
    expect(toolbar.hidden).toBe(false);
    const collapse = getByRole('button', { name: 'remote_desktop.collapse_toolbar' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');

    act(() => (collapse as HTMLButtonElement).click());
    expect(toolbar.hidden).toBe(true);
    const expandAgain = getByRole('button', { name: 'remote_desktop.expand_toolbar' });
    act(() => (expandAgain as HTMLButtonElement).click());
    expect(toolbar.hidden).toBe(false);

    act(() => {
      (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
    });
    expect(toolbar.hidden).toBe(false);
    expect(queryByRole('button', { name: 'remote_desktop.expand_toolbar' })).toBeNull();
    expect(queryByRole('button', { name: 'remote_desktop.collapse_toolbar' })).toBeNull();

    // Every fresh keyboard opening starts compact, even if the toolbar was
    // expanded during the previous keyboard session.
    act(() => keyboardButton.click());
    expect(toolbar.hidden).toBe(true);

    expect(stylesheet).toMatch(/\.remote-desktop-toolbar\[hidden\]\s*\{[^}]*display:\s*none/);
    expect(stylesheet).toMatch(/\.remote-desktop-toolbar-toggle\s*\{[^}]*width:\s*100%[^}]*min-height:\s*28px/);
    expect(stylesheet).toMatch(/\.is-toolbar-expanded \.remote-desktop-toolbar-toggle\s*\{[^}]*position:\s*absolute/);
  });

  it('pushes the remote screen up above the OS keyboard instead of letting it cover it', async () => {
    const visualViewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    try {
      const { container, getByRole } = await renderPanel();
      act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
      const panel = () => container.querySelector('.remote-desktop-panel') as HTMLElement;
      const keyboard = () => container.querySelector('.remote-desktop-mobile-keyboard') as HTMLElement;
      expect(panel().style.height).toBe('');

      // The OS keyboard (iOS: overlaying, not resizing, the page) covers the
      // bottom 300px. The whole panel ends above it, so the stage is re-fitted
      // into what stays visible and the keyboard row sits directly on top.
      act(() => {
        visualViewport.height = 400;
        visualViewport.dispatchEvent(new Event('resize'));
      });
      expect(panel().style.height).toBe('calc(100% - 300px)');
      // The remote-desktop workspace lays the panel out as a `flex: 1` item,
      // which ignores `height`; only a max-height actually shortens it there.
      expect(panel().style.maxHeight).toBe('calc(100% - 300px)');
      expect(keyboard().style.position).toBe('');

      act(() => {
        visualViewport.height = 700;
        visualViewport.dispatchEvent(new Event('resize'));
      });
      expect(panel().style.height).toBe('');
      expect(panel().style.maxHeight).toBe('');
    } finally {
      if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
      else delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
      else delete (window as unknown as { innerHeight?: number }).innerHeight;
    }
  });

  it('sends Backspace and Return from the phone keyboard even with nothing typed', async () => {
    const { getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    const input = getByRole('textbox', { name: 'remote_desktop.mobile_text_input' }) as HTMLTextAreaElement;
    const sentKeys = () => key.mock.calls
      .filter((call) => (call as unknown[])[2] === true)
      .map((call) => (call as unknown[])[0]);
    key.mockClear();

    // iOS, and Gboard in an empty field, report these as real keys and never
    // follow up with an input event -- there is nothing to delete.
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true, cancelable: true })); });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })); });
    expect(sentKeys()).toEqual(['Backspace', 'Enter']);

    // A key still inside an IME composition is left to that path.
    await new Promise((resolve) => setTimeout(resolve, 200));
    key.mockClear();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); });
    expect(sentKeys()).toEqual([]);

    // Return reported only as an input event is Return too, and once.
    act(() => { input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })); });
    expect(sentKeys()).toEqual(['Enter']);
    key.mockClear();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true })); });
    act(() => { input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true })); });
    expect(sentKeys()).toEqual(['Enter']);
  });

  it('switches the letter keys between lowercase and capitals, and sends a capital with Shift', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
    const letter = (name: string) => [...container.querySelectorAll('.remote-desktop-computer-keyboard button')]
      .find((button) => button.textContent === name) as HTMLButtonElement | undefined;
    expect(letter('a')).toBeDefined();
    expect(letter('A')).toBeUndefined();

    const caseKey = getByRole('button', { name: 'remote_desktop.computer_key_case' }) as HTMLButtonElement;
    act(() => caseKey.click());
    expect(caseKey.getAttribute('aria-pressed')).toBe('true');
    expect(letter('A')).toBeDefined();
    expect(letter('a')).toBeUndefined();

    key.mockClear();
    act(() => letter('A')!.click());
    const presses = key.mock.calls.map((call) => {
      const [code, value, down] = call as unknown as [string, string, boolean];
      return `${down ? 'down' : 'up'}:${code}:${value}`;
    });
    expect(presses).toEqual(['down:ShiftLeft:Shift', 'down:KeyA:A', 'up:KeyA:A', 'up:ShiftLeft:Shift']);

    act(() => caseKey.click());
    expect(letter('a')).toBeDefined();
  });
  it('sends a standalone computer-keyboard key, then one chord per combo-mode cycle', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
    });
    const keyButton = (label: string) => Array.from(
      container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-row button'),
    ).find((button) => button.textContent === label)!;

    key.mockClear();
    act(() => { keyButton('F5').click(); });
    expect(key.mock.calls).toEqual([
      ['F5', 'F5', true, false, { control: false, alt: false }],
      ['F5', 'F5', false, false, { control: false, alt: false }],
    ]);

    const comboToggle = getByRole('checkbox', { name: 'remote_desktop.combo_mode' }) as HTMLInputElement;
    act(() => { fireEvent.click(comboToggle); });
    expect(comboToggle.checked).toBe(true);

    key.mockClear();
    act(() => { keyButton('Control').click(); });
    expect(keyButton('Control').getAttribute('aria-pressed')).toBe('true');
    act(() => { keyButton('Shift').click(); });
    act(() => { keyButton('F5').click(); });
    expect(key.mock.calls).toEqual([
      ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
      ['ShiftLeft', 'Shift', true, false, { control: true, alt: false }],
      ['F5', 'F5', true, false, { control: true, alt: false }],
      ['F5', 'F5', false, false, { control: true, alt: false }],
      ['ShiftLeft', 'Shift', false, false, { control: true, alt: false }],
      ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
    ]);
    // One-shot: firing the chord released the latch instead of leaving it
    // held for whatever the operator taps next.
    expect(keyButton('Control').getAttribute('aria-pressed')).toBe('false');

    key.mockClear();
    act(() => { keyButton('Shift').click(); }); // latch Shift only, then navigate away
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
    expect(key).toHaveBeenCalledWith('ShiftLeft', 'Shift', false, false, { control: false, alt: false });
  });

  it('swipes between computer-keyboard pages and sends a page-two letter key', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
    });
    const track = container.querySelector('.remote-desktop-computer-keyboard-track') as HTMLElement;
    const pages = container.querySelector('.remote-desktop-computer-keyboard-pages') as HTMLElement;
    Object.defineProperty(pages, 'clientWidth', { value: 400, configurable: true });
    const keyButton = (label: string) => Array.from(
      container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-row button'),
    ).find((button) => button.textContent === label)!;

    // Page one is showing by default.
    expect(keyButton('F5')).toBeDefined();
    expect(track.style.transform).toContain('translateX(calc(0%');

    // A left-swipe well past the 20% commit threshold flips to page two.
    act(() => {
      pointer(pages, 'pointerdown', { pointerId: 9, clientX: 300, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 9, clientX: 200, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 9, clientX: 150, clientY: 200 });
      pointer(pages, 'pointerup', { pointerId: 9, clientX: 150, clientY: 200 });
    });
    expect(track.style.transform).toContain('translateX(calc(-33.33');

    key.mockClear();
    act(() => { keyButton('q').click(); });
    expect(key.mock.calls).toEqual([
      ['KeyQ', 'q', true, false, { control: false, alt: false }],
      ['KeyQ', 'q', false, false, { control: false, alt: false }],
    ]);

    // A tap on the first dot swipes back to page one.
    const dots = container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-dots button');
    expect(dots).toHaveLength(3);
    act(() => { dots[0].click(); });
    expect(track.style.transform).toContain('translateX(calc(0%');
  });

  it('draws each number key\'s shift-layer glyph in its corner and sends it on an upward swipe', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
    const pageTwo = container.querySelectorAll('.remote-desktop-computer-keyboard-page')[1] as HTMLElement;
    const digit = (n: string) => [...pageTwo.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === `remote_desktop.computer_key`
        && button.lastChild?.textContent === n)!;
    const corner = (button: HTMLButtonElement) => button.querySelector('.remote-desktop-computer-key-upper')?.textContent;

    // The standard-keyboard glyphs sit in the corner of the number keys...
    const uppers = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((n) => corner(digit(n)));
    expect(uppers).toEqual(['!', '@', '#', '$', '%', '^', '&', '*', '(', ')']);
    // ...and on the punctuation keys; letters have none.
    expect([...pageTwo.querySelectorAll('.remote-desktop-computer-key-upper')].map((el) => el.textContent))
      .toEqual(expect.arrayContaining(['_', '+', '{', '}', '|', ':', '"', '<', '>', '?']));
    const q = [...pageTwo.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'q')!;
    expect(corner(q)).toBeUndefined();

    const calls = () => key.mock.calls.map((call) => {
      const [code, value, down] = call as unknown as [string, string, boolean];
      return `${down ? 'down' : 'up'}:${code}:${value}`;
    });

    // A short tap is still the plain digit.
    const two = digit('2');
    key.mockClear();
    act(() => {
      pointer(two, 'pointerdown', { pointerId: 21, clientX: 100, clientY: 300 });
      pointer(two, 'pointerup', { pointerId: 21, clientX: 100, clientY: 298 });
      two.click();
    });
    expect(calls()).toEqual(['down:Digit2:2', 'up:Digit2:2']);

    // Dragging up sends Shift+2 (@) once -- the click the browser then fires is not a second tap.
    key.mockClear();
    act(() => {
      pointer(two, 'pointerdown', { pointerId: 22, clientX: 100, clientY: 300 });
      pointer(two, 'pointerup', { pointerId: 22, clientX: 101, clientY: 270 });
      two.click();
    });
    expect(calls()).toEqual(['down:ShiftLeft:Shift', 'down:Digit2:@', 'up:Digit2:@', 'up:ShiftLeft:Shift']);

    // A mostly-sideways drag is not an upward swipe.
    key.mockClear();
    act(() => {
      pointer(two, 'pointerdown', { pointerId: 23, clientX: 100, clientY: 300 });
      pointer(two, 'pointerup', { pointerId: 23, clientX: 160, clientY: 280 });
    });
    expect(calls()).toEqual([]);

    // The swipe says on screen what it is about to do, and clears after.
    act(() => {
      pointer(two, 'pointerdown', { pointerId: 24, clientX: 100, clientY: 300 });
      pointer(two, 'pointermove', { pointerId: 24, clientX: 100, clientY: 294 });
    });
    expect(two.classList.contains('is-swiping')).toBe(true);
    expect(two.classList.contains('is-swipe-armed')).toBe(false);
    act(() => pointer(two, 'pointermove', { pointerId: 24, clientX: 100, clientY: 280 }));
    expect(two.classList.contains('is-swipe-armed')).toBe(true);
    act(() => pointer(two, 'pointerup', { pointerId: 24, clientX: 100, clientY: 280 }));
    expect(two.classList.contains('is-swiping')).toBe(false);
    expect(two.classList.contains('is-swipe-armed')).toBe(false);

    // A swipe the browser takes away mid-gesture (it decided the drag was a
    // scroll) still sends the glyph it had already committed to.
    key.mockClear();
    act(() => {
      pointer(two, 'pointerdown', { pointerId: 25, clientX: 100, clientY: 300 });
      pointer(two, 'pointermove', { pointerId: 25, clientX: 100, clientY: 278 });
      two.dispatchEvent(Object.defineProperties(
        new MouseEvent('pointercancel', { bubbles: true, cancelable: true }),
        { pointerId: { value: 25 }, pointerType: { value: 'touch' } },
      ));
    });
    expect(calls()).toEqual(['down:ShiftLeft:Shift', 'down:Digit2:@', 'up:Digit2:@', 'up:ShiftLeft:Shift']);
    expect(two.classList.contains('is-swipe-armed')).toBe(false);
  });

  it('has a special-characters page whose keys send Shift plus the key, so every printable character is reachable', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
    const dots = container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-dots button');
    expect(dots).toHaveLength(3);
    act(() => { dots[2]!.click(); });
    const track = container.querySelector('.remote-desktop-computer-keyboard-track') as HTMLElement;
    expect(track.style.transform).toContain('translateX(calc(-66.66');

    const pageThree = container.querySelectorAll('.remote-desktop-computer-keyboard-page')[2] as HTMLElement;
    const glyphs = [...pageThree.querySelectorAll('button')].map((button) => button.textContent);
    for (const glyph of '!@#$%^&*()_+{}|:"<>?~`'.split('')) expect(glyphs).toContain(glyph);
    const keyButton = (glyph: string) => [...pageThree.querySelectorAll('button')]
      .find((button) => button.textContent === glyph) as HTMLButtonElement;

    key.mockClear();
    act(() => keyButton('@').click());
    expect(key.mock.calls.map((call) => {
      const [code, value, down] = call as unknown as [string, string, boolean];
      return `${down ? 'down' : 'up'}:${code}:${value}`;
    })).toEqual(['down:ShiftLeft:Shift', 'down:Digit2:@', 'up:Digit2:@', 'up:ShiftLeft:Shift']);

    // The backtick on this page is the bare key, not a shifted one.
    key.mockClear();
    act(() => keyButton('`').click());
    expect(key.mock.calls.map((call) => (call as unknown as [string, string, boolean]).slice(0, 3).join(':')))
      .toEqual(['Backquote:`:true', 'Backquote:`:false']);

    // ...and its shifted neighbour is the tilde on the same physical key.
    key.mockClear();
    act(() => keyButton('~').click());
    expect(key.mock.calls.map((call) => (call as unknown as [string, string, boolean]).slice(0, 3).join(':')))
      .toEqual(['ShiftLeft:Shift:true', 'Backquote:~:true', 'Backquote:~:false', 'ShiftLeft:Shift:false']);
  });

  it('does not flip pages on a drag that never crosses the commit threshold', async () => {
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
    });
    const track = container.querySelector('.remote-desktop-computer-keyboard-track') as HTMLElement;
    const pages = container.querySelector('.remote-desktop-computer-keyboard-pages') as HTMLElement;
    Object.defineProperty(pages, 'clientWidth', { value: 400, configurable: true });

    act(() => {
      pointer(pages, 'pointerdown', { pointerId: 10, clientX: 300, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 10, clientX: 280, clientY: 200 });
      pointer(pages, 'pointerup', { pointerId: 10, clientX: 280, clientY: 200 });
    });
    expect(track.style.transform).toContain('translateX(calc(0%');
  });

  it('opens the focused display resolution menu from the keyboard context-menu gesture', async () => {
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });
    displayTab.focus();
    act(() => {
      displayTab.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'F10',
        shiftKey: true,
      }));
    });
    expect(getByRole('menu')).not.toBeNull();
    expect(document.activeElement).toBe(displayTab);
  });

  it('opens the same per-display resolution menu on a mobile long press without selecting the tab', async () => {
    vi.useFakeTimers();
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });
    act(() => {
      pointer(displayTab, 'pointerdown', { pointerId: 44, clientX: 80, clientY: 60 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(getByRole('menu')).not.toBeNull();
    act(() => {
      pointer(displayTab, 'pointerup', { pointerId: 44, clientX: 80, clientY: 60 });
      (displayTab as HTMLButtonElement).click();
    });
    expect(setDisplayMode).not.toHaveBeenCalled();
  });

  it('does not leave a stale click suppression behind when a long press emits no click', async () => {
    vi.useFakeTimers();
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name' });
    act(() => {
      pointer(displayTab, 'pointerdown', { pointerId: 45, clientX: 100, clientY: 60 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_551); });
    act(() => { (displayTab as HTMLButtonElement).click(); });
    expect(selectDisplay).toHaveBeenCalledWith('display-second');
  });

  it('turns a touch tap into one atomic remote left click without DPI multiplication', async () => {
    const { stage } = await renderPanel();
    pointer(stage, 'pointerdown', { pointerId: 1, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 1, clientX: 200, clientY: 150 });
    expect(pointerClick).toHaveBeenCalledOnce();
    expect(pointerClick).toHaveBeenCalledWith('left', 0.5, 0.5);
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('keeps the legacy touch down/up click for an older worker', async () => {
    atomicButtonClickAdvertised = false;
    const { stage } = await renderPanel();
    pointer(stage, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 2, clientX: 200, clientY: 150 });
    expect(pointerClick).not.toHaveBeenCalled();
    expect(pointerButton.mock.calls).toEqual([
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
    ]);
  });

  it('defaults touch-mode display to fit-to-window instead of actual size', async () => {
    const { getByRole } = await renderPanel();
    expect(getByRole('button', { name: 'remote_desktop.fit' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(getByRole('button', { name: 'remote_desktop.actual_size' }).getAttribute('aria-pressed'))
      .toBe('false');
  });

  it('restores this machine\'s remembered display scale instead of the default', async () => {
    localStorage.setItem(
      'imcodes.web.remote-desktop.zoom.v1.server-1',
      JSON.stringify({ version: 1, viewScale: 'actual', scale: 2 }),
    );
    const { getByRole, getByLabelText } = await renderPanel();
    expect(getByRole('button', { name: 'remote_desktop.actual_size' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(getByLabelText('remote_desktop.zoom_reset').textContent).toBe('200%');
  });

  it('ignores another machine\'s remembered scale and uses this machine\'s own', async () => {
    localStorage.setItem(
      'imcodes.web.remote-desktop.zoom.v1.some-other-server',
      JSON.stringify({ version: 1, viewScale: 'actual', scale: 3 }),
    );
    const { getByRole } = await renderPanel();
    expect(getByRole('button', { name: 'remote_desktop.fit' }).getAttribute('aria-pressed'))
      .toBe('true');
  });

  it('keeps the phone keyboard up while the remote screen is operated', async () => {
    const { stage, getByRole, getByLabelText } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    const input = getByLabelText('remote_desktop.mobile_text_input') as HTMLTextAreaElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    // Touching, dragging and lifting on the picture must not take the focus
    // off the field -- that is what dismissed the OS keyboard.
    pointer(stage, 'pointerdown', { pointerId: 71, clientX: 120, clientY: 160 });
    expect(document.activeElement).toBe(input);
    pointer(stage, 'pointermove', { pointerId: 71, clientX: 150, clientY: 200 });
    pointer(stage, 'pointerup', { pointerId: 71, clientX: 150, clientY: 200 });
    expect(document.activeElement).toBe(input);

    // Closing it hands the stage back for physical keyboard input.
    act(() => { (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click(); });
    mousePointer(stage, 'pointerdown', { pointerId: 72, clientX: 120, clientY: 160 });
    expect(document.activeElement).toBe(stage);
  });

  it('keeps a hand-set zoom when the stage resizes, as the phone keyboard makes it', async () => {
    const { getByLabelText, getByRole, container } = await renderPanel();
    act(() => { (getByLabelText('remote_desktop.zoom_in') as HTMLButtonElement).click(); });
    expect(getByLabelText('remote_desktop.zoom_reset').textContent).toBe('150%');

    // The keyboard shortens the stage, which is a resize like any other.
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => { window.dispatchEvent(new Event('resize')); });
    act(() => { (getByRole('button', { name: 'remote_desktop.expand_toolbar' }) as HTMLButtonElement).click(); });
    expect(getByLabelText('remote_desktop.zoom_reset').textContent).toBe('150%');
    const video = container.querySelector('.remote-desktop-stage video') as HTMLVideoElement;
    expect(video.style.transform).toContain('scale(1.5)');
  });

  it('remembers a new zoom ratio for this machine once it settles, without saving on every intermediate change', async () => {
    vi.useFakeTimers();
    const { getByLabelText } = await renderPanel();
    act(() => { (getByLabelText('remote_desktop.zoom_in') as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    // Still within the debounce window -- nothing written yet.
    expect(localStorage.getItem('imcodes.web.remote-desktop.zoom.v1.server-1')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(JSON.parse(localStorage.getItem('imcodes.web.remote-desktop.zoom.v1.server-1')!))
      .toEqual({ version: 1, viewScale: 'fit', scale: 1.5 });
  });

  it('moves the ring and its bound cursor marker to wherever the screen is tapped, and taps the ring there to left-click', async () => {
    const { container, stage, getByLabelText } = await renderPanel();
    act(() => {
      // clientY stays on the vertical center so the video's 16:9-into-4:3
      // letterboxing doesn't complicate the expected normalized Y below --
      // that mapping is exercised by other tests already.
      pointer(stage, 'pointerdown', { pointerId: 3, clientX: 300, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 3, clientX: 300, clientY: 150 });
    });
    // The cursor marker sits exactly where a click lands; the ring is offset
    // below it so a dragging finger never covers that spot, but the two move
    // together off the same underlying position.
    const cursor = container.querySelector('.remote-desktop-virtual-pointer') as HTMLElement;
    expect(cursor.style.left).toBe('300px');
    expect(cursor.style.top).toBe('150px');
    // Touch mode is the default even on a desktop session driven by a real
    // mouse -- this marker must carry the modifier that keeps it hidden
    // outside a coarse (touch) pointer, unlike mouse mode's own always-shown
    // use of the same base class.
    expect(cursor.classList.contains('is-touch-ring-marker')).toBe(true);
    const ring = getByLabelText('remote_desktop.touch_ring');
    expect(ring.style.left).toBe('300px');
    expect(ring.style.top).toBe(`${150 + 72}px`);

    pointerClick.mockClear();
    act(() => {
      pointer(ring, 'pointerdown', { pointerId: 12, clientX: 300, clientY: 150 });
      pointer(ring, 'pointerup', { pointerId: 12, clientX: 300, clientY: 150 });
    });
    // Even though the ring itself is drawn lower, the click it fires lands at
    // the cursor marker's (true, unoffset) position.
    expect(pointerClick).toHaveBeenCalledWith('left', 0.75, 0.5);
  });

  it('drags the touch-mode ring to move the remote cursor relatively, without clicking', async () => {
    const { container, stage, getByLabelText } = await renderPanel();
    act(() => {
      // Seed a known ring position: a tap that lands exactly on the ring
      // (0,0 in this harness before any interaction) both places it there
      // and left-clicks once, which the drag assertions below account for.
      pointer(stage, 'pointerdown', { pointerId: 8, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 8, clientX: 200, clientY: 150 });
    });
    const ring = getByLabelText('remote_desktop.touch_ring');
    const cursor = container.querySelector('.remote-desktop-virtual-pointer') as HTMLElement;
    pointerMove.mockClear();
    pointerClick.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 9, clientX: 200, clientY: 150 }); });
    act(() => { pointer(ring, 'pointermove', { pointerId: 9, clientX: 250, clientY: 150 }); });
    expect(pointerMove).toHaveBeenCalledWith(0.625, 0.5);
    // The cursor marker and the ring are bound to the same underlying
    // position -- dragging the ring carries the marker along with it.
    expect(cursor.style.left).toBe('250px');
    expect(ring.style.left).toBe('250px');
    act(() => { pointer(ring, 'pointerup', { pointerId: 9, clientX: 250, clientY: 150 }); });
    // The drag itself moved the cursor; release must not additionally click.
    expect(pointerClick).not.toHaveBeenCalled();
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('holds the ring without moving and right-clicks on release', async () => {
    vi.useFakeTimers();
    const { stage, getByLabelText } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 8, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 8, clientX: 200, clientY: 150 });
    });
    const ring = getByLabelText('remote_desktop.touch_ring');
    pointerClick.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 11, clientX: 200, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    // Held: armed, and still free to become a drag, so nothing clicked yet.
    expect(ring.className).toContain('is-right');
    expect(pointerClick).not.toHaveBeenCalled();
    act(() => { pointer(ring, 'pointerup', { pointerId: 11, clientX: 200, clientY: 150 }); });
    expect(pointerClick).toHaveBeenCalledTimes(1);
    expect(pointerClick).toHaveBeenCalledWith('right', 0.5, 0.5);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ring.className).not.toContain('is-right');
  });

  it('suppresses every native long-press surface on the touch ring without losing its remote right-click', async () => {
    vi.useFakeTimers();
    const { stage, getByLabelText } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 81, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 81, clientX: 200, clientY: 150 });
    });
    const ring = getByLabelText('remote_desktop.touch_ring');

    // A native TouchEvent is separate from PointerEvent on iOS. Cancelling it
    // is what keeps the selection loupe from appearing over the custom ring.
    const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
    expect(ring.dispatchEvent(touchStart)).toBe(false);
    expect(touchStart.defaultPrevented).toBe(true);

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(ring.dispatchEvent(contextMenu)).toBe(false);
    expect(contextMenu.defaultPrevented).toBe(true);
    const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
    expect(ring.dispatchEvent(dragStart)).toBe(false);
    expect(dragStart.defaultPrevented).toBe(true);
    expect(ring.getAttribute('draggable')).toBe('false');

    pointerClick.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 82, clientX: 200, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    act(() => { pointer(ring, 'pointerup', { pointerId: 82, clientX: 200, clientY: 150 }); });
    expect(pointerClick).toHaveBeenCalledWith('right', 0.5, 0.5);
  });

  it('holds the ring, then drags with the left button down for a remote drag', async () => {
    vi.useFakeTimers();
    const { stage, getByLabelText } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 8, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 8, clientX: 200, clientY: 150 });
    });
    const ring = getByLabelText('remote_desktop.touch_ring');
    pointerClick.mockClear();
    pointerButton.mockClear();
    pointerMove.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 12, clientX: 200, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    act(() => { pointer(ring, 'pointermove', { pointerId: 12, clientX: 260, clientY: 150 }); });
    // Pressed where the cursor rested, before it moved: a drag from there.
    expect(pointerButton).toHaveBeenNthCalledWith(1, 'left', true, 0.5, 0.5);
    expect(pointerMove).toHaveBeenCalledWith(0.65, 0.5);
    act(() => { pointer(ring, 'pointerup', { pointerId: 12, clientX: 260, clientY: 150 }); });
    expect(pointerButton).toHaveBeenLastCalledWith('left', false, 0.65, 0.5);
    expect(pointerClick).not.toHaveBeenCalled();
    expect(ring.className).not.toContain('is-right');
  });

  it('never shows the browser\'s own menu on the remote screen, even when only viewing', async () => {
    const { stage } = await renderPanel();
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { stage.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels the ring long-press once a drag moves past the threshold', async () => {
    vi.useFakeTimers();
    const { stage, getByLabelText } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 8, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 8, clientX: 200, clientY: 150 });
    });
    const ring = getByLabelText('remote_desktop.touch_ring');
    pointerClick.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 13, clientX: 200, clientY: 150 }); });
    act(() => { pointer(ring, 'pointermove', { pointerId: 13, clientX: 230, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(pointerClick).not.toHaveBeenCalledWith('right', expect.anything(), expect.anything());
    expect(ring.className).not.toContain('is-right');
  });

  it('releases a captured mouse button even when pointer-up is outside video content', async () => {
    const { stage } = await renderPanel();
    let capturedPointerId: number | null = null;
    const releasePointerCapture = vi.fn((pointerId: number) => {
      if (capturedPointerId === pointerId) capturedPointerId = null;
    });
    Object.assign(stage, {
      setPointerCapture: (pointerId: number) => { capturedPointerId = pointerId; },
      hasPointerCapture: (pointerId: number) => capturedPointerId === pointerId,
      releasePointerCapture,
    });
    mousePointer(stage, 'pointerdown', {
      pointerId: 7, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointerup', {
      pointerId: 7, clientX: 500, clientY: 350,
    });
    mousePointer(stage, 'lostpointercapture', {
      pointerId: 7, clientX: 500, clientY: 350,
    });
    expect(pointerButton).toHaveBeenNthCalledWith(1, 'left', true, 0.5, 0.5);
    expect(pointerButton).toHaveBeenNthCalledWith(2, 'left', false, undefined, undefined);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerButtons).toHaveBeenCalledTimes(1);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('releases capture before interpreting a compatibility pointer-up button', async () => {
    const { stage } = await renderPanel();
    let capturedPointerId: number | null = null;
    const releasePointerCapture = vi.fn((pointerId: number) => {
      if (capturedPointerId === pointerId) capturedPointerId = null;
    });
    Object.assign(stage, {
      setPointerCapture: (pointerId: number) => { capturedPointerId = pointerId; },
      hasPointerCapture: (pointerId: number) => capturedPointerId === pointerId,
      releasePointerCapture,
    });

    mousePointer(stage, 'pointerdown', {
      pointerId: 17, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointerup', {
      pointerId: 17, clientX: 200, clientY: 150, button: -1,
    });

    expect(releasePointerCapture).toHaveBeenCalledWith(17);
    expect(capturedPointerId).toBeNull();
    // The remembered press supplies the real button, so remote input is also
    // released instead of leaving a separate stuck-button failure behind.
    expect(pointerButton).toHaveBeenNthCalledWith(2, 'left', false, 0.5, 0.5);
  });

  it('snaps a nearby desktop double-click to one remote pixel target', async () => {
    const { stage } = await renderPanel();
    vi.useFakeTimers();
    pointerButton.mockClear();
    pointerClick.mockClear();

    mousePointer(stage, 'pointerdown', {
      pointerId: 70, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointerup', {
      pointerId: 70, clientX: 200, clientY: 150,
    });
    act(() => { vi.advanceTimersByTime(120); });
    mousePointer(stage, 'pointerdown', {
      pointerId: 71, clientX: 206, clientY: 154,
    });
    mousePointer(stage, 'pointerup', {
      pointerId: 71, clientX: 206, clientY: 154,
    });

    expect(pointerButton.mock.calls).toEqual([
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
    ]);
    expect(pointerClick).toHaveBeenCalledOnce();
    expect(pointerClick).toHaveBeenCalledWith('left', 0.5, 0.5);
  });

  it('keeps the legacy down/up double-click sequence for an older worker', async () => {
    atomicButtonClickAdvertised = false;
    const { stage } = await renderPanel();
    vi.useFakeTimers();
    pointerButton.mockClear();
    pointerClick.mockClear();

    mousePointer(stage, 'pointerdown', { pointerId: 72, clientX: 200, clientY: 150 });
    mousePointer(stage, 'pointerup', { pointerId: 72, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(120); });
    mousePointer(stage, 'pointerdown', { pointerId: 73, clientX: 206, clientY: 154 });
    mousePointer(stage, 'pointerup', { pointerId: 73, clientX: 206, clientY: 154 });

    expect(pointerClick).not.toHaveBeenCalled();
    expect(pointerButton.mock.calls).toEqual([
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
    ]);
  });

  it('releases only pointer buttons on pointer cancellation so held modifiers survive', async () => {
    const { stage } = await renderPanel();
    mousePointer(stage, 'pointerdown', {
      pointerId: 8, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointercancel', {
      pointerId: 8, clientX: 200, clientY: 150,
    });
    expect(releasePointerButtons).toHaveBeenCalledTimes(1);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('maps Mac Command drag to a pure Windows middle-button drag', async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    try {
      const { stage } = await renderPanel();
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
      })));
      expect(key).toHaveBeenCalledWith('ControlLeft', 'Control', true, false, {
        control: true,
        alt: false,
      });

      mousePointer(stage, 'pointerdown', {
        pointerId: 19, clientX: 200, clientY: 150, metaKey: true,
      });
      nativeMousePointerMove(stage, { clientX: 300, clientY: 150 });
      mousePointer(stage, 'pointerup', {
        pointerId: 19, clientX: 300, clientY: 150, metaKey: false,
      });
      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
      })));

      expect(pointerButton).toHaveBeenNthCalledWith(1, 'middle', true, 0.5, 0.5);
      expect(pointerButton).toHaveBeenNthCalledWith(2, 'middle', false, expect.any(Number), 0.5);
      expect(pointerButton.mock.calls[1]?.[2]).toBeCloseTo(0.75, 4);
      expect(pointerMove).toHaveBeenCalledWith(expect.any(Number), 0.5);
      expect(pointerMove.mock.calls[0]?.[0]).toBeCloseTo(0.75, 4);
      expect(key.mock.calls).toEqual([
        ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
        ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
      ]);
      expect(pointerButton).not.toHaveBeenCalledWith('left', true, expect.anything(), expect.anything());
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('forwards Command-based shortcuts to a macOS target as Command, not Control', async () => {
    // Control is not bound to anything on macOS (and can mean something else
    // entirely, e.g. SIGINT in a terminal), so translating Command to
    // Control for a macOS target made every Command shortcut -- copy, paste,
    // undo, save, all of it -- a silent no-op there.
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    try {
      const { stage } = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
      })));
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyZ',
        key: 'z',
        metaKey: true,
      })));
      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'KeyZ',
        key: 'z',
        metaKey: true,
      })));
      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
      })));

      expect(key.mock.calls).toEqual([
        ['MetaLeft', 'Meta', true, false, { control: false, alt: false }],
        ['KeyZ', 'z', true, false, { control: false, alt: false }],
        ['KeyZ', 'z', false, false, { control: false, alt: false }],
        ['MetaLeft', 'Meta', false, false, { control: false, alt: false }],
      ]);
      expect(key).not.toHaveBeenCalledWith('ControlLeft', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  describe('shortcuts between Mac and PC keyboards', () => {
    async function withControllerPlatform(platform: string, run: () => Promise<void>): Promise<void> {
      const originalPlatform = navigator.platform;
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
      try {
        await run();
      } finally {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
      }
    }
    const press = (stage: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent => {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      act(() => { stage.dispatchEvent(event); });
      return event;
    };

    it('taps a Mac operator\'s Command+Left on a Linux target as one Home', async () => {
      await withControllerPlatform('MacIntel', async () => {
        const { stage } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
        press(stage, 'keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true });
        const left = press(stage, 'keydown', { code: 'ArrowLeft', key: 'ArrowLeft', metaKey: true });
        press(stage, 'keyup', { code: 'ArrowLeft', key: 'ArrowLeft', metaKey: true });
        press(stage, 'keyup', { code: 'MetaLeft', key: 'Meta' });

        expect(left.defaultPrevented).toBe(true);
        expect(tapChords).toHaveBeenCalledTimes(1);
        expect(tapChords).toHaveBeenCalledWith([[{ code: 'Home', key: 'Home' }]]);
        expect(key.mock.calls).toEqual([
          ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
          ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
        ]);
      });
    });

    it('sends a Windows operator\'s Control to a Mac target as Command, and Home as Command+Left', async () => {
      await withControllerPlatform('Win32', async () => {
        const { stage } = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
        press(stage, 'keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
        press(stage, 'keydown', { code: 'KeyS', key: 's', ctrlKey: true });
        press(stage, 'keyup', { code: 'KeyS', key: 's', ctrlKey: true });
        press(stage, 'keyup', { code: 'ControlLeft', key: 'Control' });
        expect(key.mock.calls).toEqual([
          ['MetaLeft', 'Meta', true, false, { control: false, alt: false }],
          ['KeyS', 's', true, false, { control: false, alt: false }],
          ['KeyS', 's', false, false, { control: false, alt: false }],
          ['MetaLeft', 'Meta', false, false, { control: false, alt: false }],
        ]);

        key.mockClear();
        press(stage, 'keydown', { code: 'Home', key: 'Home' });
        press(stage, 'keyup', { code: 'Home', key: 'Home' });
        expect(tapChords).toHaveBeenCalledWith([[{ code: 'MetaLeft', key: 'Meta' }, { code: 'ArrowLeft', key: 'ArrowLeft' }]]);
        expect(key).not.toHaveBeenCalled();
      });
    });

    it('takes the selection on a PC operator\'s Control+C to Linux and still delivers the interrupt', async () => {
      const readText = vi.fn(async () => 'from local clipboard');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText: vi.fn(async () => {}) },
      });
      await withControllerPlatform('Win32', async () => {
        const { stage } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
        await act(async () => {
          stage.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, code: 'KeyC', key: 'c', ctrlKey: true,
          }));
          await Promise.resolve();
        });
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
        expect(key).toHaveBeenCalledWith('KeyC', 'c', true, false, { control: true, alt: false });
        press(stage, 'keyup', { code: 'KeyC', key: 'c', ctrlKey: true });
        expect(key).toHaveBeenCalledWith('KeyC', 'c', false, false, { control: true, alt: false });
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);

        // A Linux terminal's own paste chord brings in the LOCAL clipboard.
        key.mockClear();
        await act(async () => {
          stage.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true,
          }));
          await Promise.resolve();
        });
        expect(readText).toHaveBeenCalledTimes(1);
        expect(text).toHaveBeenCalledWith('from local clipboard');
        expect(key).not.toHaveBeenCalled();
      });
    });

    it('cuts by copying the selection first, then tapping the target\'s own cut', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn(async () => ''), writeText: vi.fn(async () => {}) },
      });
      let answer!: (value: string) => void;
      requestRemoteClipboard.mockImplementationOnce(() => new Promise<string>((resolve) => { answer = resolve; }));
      await withControllerPlatform('Win32', async () => {
        const { stage } = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
        const cut = press(stage, 'keydown', { code: 'KeyX', key: 'x', ctrlKey: true });
        expect(cut.defaultPrevented).toBe(true);
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
        // Nothing is removed on the remote until the selection is in hand.
        expect(tapChords).not.toHaveBeenCalled();
        await act(async () => {
          answer('cut remotely');
          for (let i = 0; i < 5; i += 1) await Promise.resolve();
        });
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('cut remotely');
        expect(tapChords).toHaveBeenCalledWith([[{ code: 'MetaLeft', key: 'Meta' }, { code: 'KeyX', key: 'x' }]]);
        expect(key).not.toHaveBeenCalledWith('KeyX', expect.anything(), expect.anything(), expect.anything(), expect.anything());
      });
    });
  });

  it('suppresses Command, not Control, during a middle-drag on a macOS target', async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    try {
      const { stage } = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
      })));
      expect(key).toHaveBeenCalledWith('MetaLeft', 'Meta', true, false, {
        control: false,
        alt: false,
      });

      mousePointer(stage, 'pointerdown', {
        pointerId: 20, clientX: 200, clientY: 150, metaKey: true,
      });
      mousePointer(stage, 'pointerup', {
        pointerId: 20, clientX: 200, clientY: 150, metaKey: false,
      });
      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
      })));

      expect(pointerButton).toHaveBeenCalledWith('middle', true, expect.anything(), expect.anything());
      // The middle-drag start must release the SAME code it forwarded (Meta,
      // not Control) -- otherwise Command stays physically down on the
      // remote Mac for the rest of the drag and beyond.
      expect(key.mock.calls).toEqual([
        ['MetaLeft', 'Meta', true, false, { control: false, alt: false }],
        ['MetaLeft', 'Meta', false, false, { control: false, alt: false }],
      ]);
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('falls back to releaseAll when the synthetic Control release fails to send', async () => {
    // A transient data-channel hiccup can make the release send return false
    // without tearing down the session. If that dropped "up" were treated as
    // done, the remote host's real Control key would stay physically down for
    // the rest of the session -- exactly what was observed live on a Mac
    // host, surfacing as every left click behaving like a right click.
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    key.mockImplementation((code: string, _label: string, down: boolean) => !(code === 'ControlLeft' && down === false));
    try {
      const { stage } = await renderPanel();
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyA',
        key: 'a',
        metaKey: true,
      })));
      expect(key).toHaveBeenCalledWith('ControlLeft', 'Control', true, false, { control: true, alt: false });
      expect(releaseAll).not.toHaveBeenCalled();

      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'KeyA',
        key: 'a',
        metaKey: true,
      })));

      expect(key).toHaveBeenCalledWith('ControlLeft', 'Control', false, false, { control: false, alt: false });
      expect(releaseAll).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
      key.mockReset();
      key.mockImplementation(() => true);
    }
  });

  it('keeps sending desktop hover through the window capture path after a click', async () => {
    // A real desktop engine can stop the native video event before it bubbles
    // to the stage after pointer capture is released. The window capture path
    // must see the pointer move first, otherwise reconnecting briefly fixes
    // hover until the first click and then the cursor freezes.
    const { container, stage } = await renderPanel();
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    video?.addEventListener('pointermove', (event) => event.stopPropagation());
    pointerMove.mockClear();
    act(() => {
      mousePointer(stage, 'pointerdown', { pointerId: 21, clientX: 200, clientY: 150 });
      mousePointer(stage, 'pointerup', { pointerId: 21, clientX: 200, clientY: 150 });
      mousePointer(stage, 'lostpointercapture', { pointerId: 21, clientX: 200, clientY: 150 });
      nativeMousePointerMove(video!, { clientX: 200, clientY: 150 });
      nativeMousePointerMove(video!, { clientX: 300, clientY: 150 });
    });
    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('keeps sending hover when focus retargets mouse movement outside the stage', async () => {
    const { container } = await renderPanel();
    const toolbar = container.querySelector('.remote-desktop-toolbar');
    expect(toolbar).not.toBeNull();
    pointerMove.mockClear();

    act(() => {
      toolbar!.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      // Focused floating windows and native gesture layers may retarget the
      // desktop mouse event to document even though its coordinates are over
      // the video. Hit-testing by event.target freezes hover after that click.
      nativeMousePointerMove(document, { clientX: 200, clientY: 150 });
      nativeMousePointerMove(document, { clientX: 300, clientY: 150 });
    });

    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('keeps sending mouse-only hover when the browser reserves pointermove for dragging', async () => {
    const { stage } = await renderPanel();
    pointerMove.mockClear();

    act(() => {
      nativeMouseMove(stage, { clientX: 200, clientY: 150 });
      nativeMouseMove(stage, { clientX: 300, clientY: 150 });
    });

    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('uses the stage mousemove path when window hover listeners receive nothing', async () => {
    const nativeWindowAddEventListener = window.addEventListener.bind(window);
    const addEventListener = vi.spyOn(window, 'addEventListener').mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'mousemove' || type === 'pointermove') return;
      nativeWindowAddEventListener(type, listener, options);
    });
    let rendered: Awaited<ReturnType<typeof renderPanel>>;
    try {
      rendered = await renderPanel();
    } finally {
      addEventListener.mockRestore();
    }
    pointerMove.mockClear();

    act(() => {
      nativeMouseMove(rendered.stage, { clientX: 200, clientY: 150 });
      nativeMouseMove(rendered.stage, { clientX: 300, clientY: 150 });
    });

    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5], [0.75, 0.5]]);
  });

  it('deduplicates compatibility mousemove paired with pointermove', async () => {
    const { stage } = await renderPanel();
    pointerMove.mockClear();

    act(() => {
      nativeMousePointerMove(stage, { clientX: 200, clientY: 150 });
      nativeMouseMove(stage, { clientX: 200, clientY: 150 });
    });

    expect(pointerMove.mock.calls).toEqual([[0.5, 0.5]]);
  });

  it('sends the real remote pointer without snapping a mouse away from the edges', async () => {
    const { container, stage } = await renderPanel();
    pointerMove.mockClear();
    act(() => {
      nativeMousePointerMove(stage, { clientX: 4, clientY: 150 });
      nativeMousePointerMove(stage, { clientX: 396, clientY: 150 });
    });

    // A mouse lands where it is pointed: 1% in from the edge is a real pixel
    // column, not something to snap away, which is what made every click near
    // a border jump outward.
    expect(pointerMove.mock.calls).toEqual([[0.01, 0.5], [0.99, 0.5]]);
    // The finger's wide sticky zone is covered where it lives, in
    // remote-desktop-viewport: both thresholds are asserted against the same
    // position there.
    expect(container.querySelector('.remote-desktop-pointer-follow')).toBeNull();
    expect(getComputedStyle(stage).cursor).not.toBe('none');
  });

  it('acknowledges only a browser-presented decoded video frame', async () => {
    let presentedCallback: VideoFrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: VideoFrameRequestCallback) => {
      presentedCallback = callback;
      return 41;
    });
    const cancelFrame = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: { configurable: true, value: requestFrame },
      cancelVideoFrameCallback: { configurable: true, value: cancelFrame },
    });
    const rendered = await renderPanel();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => presentedCallback?.(0, {} as VideoFrameCallbackMetadata));
    expect(acknowledgePresentedFrame).toHaveBeenCalledWith(1920, 1080);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(41);
    getContext.mockRestore();
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  });

  it('releases all remote input when the panel loses browser focus', async () => {
    await renderPanel();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(releaseAll).toHaveBeenCalledTimes(1);
  });

  it('uses drag/pinch for the local viewport and never sends an accidental click', async () => {
    const { stage, video } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 150 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 280, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 360, clientY: 150 });
    });
    expect(video.style.transform).not.toContain('scale(1)');
    act(() => {
      pointer(stage, 'pointerup', { pointerId: 2, clientX: 360, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 1, clientX: 180, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 1, clientX: 180, clientY: 150 });
    });
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('sends two-finger drag as remote scroll instead of pinching the local view', async () => {
    const { stage, video } = await renderPanel();
    wheel.mockClear();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 150 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 280, clientY: 150 });
      // Both fingers move up together by the same amount -- the distance
      // between them stays ~160, only the center moves -- unlike the pinch
      // test above, where one finger moves and the other stays put.
      pointer(stage, 'pointermove', { pointerId: 1, clientX: 120, clientY: 120 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 280, clientY: 120 });
    });
    // Local view untouched -- this was read as a scroll, not a pinch.
    expect(video.style.transform).toContain('scale(1)');
    expect(wheel).toHaveBeenCalled();
    const [deltaX, deltaY] = wheel.mock.calls.at(-1)!;
    // Dragging up scrolls down (content follows the finger), the same
    // direction touch panning already uses elsewhere in this file.
    expect(deltaY).toBeGreaterThan(0);
    expect(deltaX).toBeCloseTo(0);

    act(() => {
      pointer(stage, 'pointerup', { pointerId: 1, clientX: 120, clientY: 120 });
      pointer(stage, 'pointerup', { pointerId: 2, clientX: 280, clientY: 120 });
    });
    expect(pointerButton).not.toHaveBeenCalled();
    expect(pointerClick).not.toHaveBeenCalled();
  });

  it('sends a horizontal two-finger drag as horizontal remote scroll', async () => {
    const { stage, video } = await renderPanel();
    wheel.mockClear();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 150, clientY: 100 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 150, clientY: 260 });
      // Both fingers move right together -- the vertical pair's distance
      // stays ~160, only the center moves horizontally.
      pointer(stage, 'pointermove', { pointerId: 1, clientX: 180, clientY: 100 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 180, clientY: 260 });
    });
    expect(video.style.transform).toContain('scale(1)');
    expect(wheel).toHaveBeenCalled();
    const [deltaX, deltaY] = wheel.mock.calls.at(-1)!;
    // Dragging right scrolls left (content follows the finger).
    expect(deltaX).toBeLessThan(0);
    expect(deltaY).toBeCloseTo(0);
  });

  it('maps a tap through the transformed video rect after mobile zoom', async () => {
    const { stage, video } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 150 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 280, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 440, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 2, clientX: 440, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 1, clientX: 120, clientY: 150 });
    });
    expect(video.style.transform).toContain('scale(2)');
    // At 2x, the 400x300 element has this transformed client rect. The 16:9
    // video content occupies y=-75..375; this tap is source point 75%,25%.
    video.getBoundingClientRect = () => ({
      x: -200, y: -150, left: -200, top: -150, right: 600, bottom: 450,
      width: 800, height: 600, toJSON: () => ({}),
    });
    pointer(stage, 'pointerdown', { pointerId: 3, clientX: 400, clientY: 37.5 });
    pointer(stage, 'pointerup', { pointerId: 3, clientX: 400, clientY: 37.5 });
    expect(pointerClick).toHaveBeenCalledWith('left', 0.75, 0.25);
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('turns a long press into right-click and snaps a nearby double tap to one Windows target', async () => {
    const { stage } = await renderPanel();
    pointerButton.mockClear();
    vi.useFakeTimers();

    pointer(stage, 'pointerdown', { pointerId: 40, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(550); });
    pointer(stage, 'pointerup', { pointerId: 40, clientX: 200, clientY: 150 });
    expect(pointerClick.mock.calls).toEqual([['right', 0.5, 0.5]]);

    pointerButton.mockClear();
    pointerClick.mockClear();
    pointer(stage, 'pointerdown', { pointerId: 41, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 41, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(180); });
    pointer(stage, 'pointerdown', { pointerId: 42, clientX: 218, clientY: 158 });
    pointer(stage, 'pointerup', { pointerId: 42, clientX: 218, clientY: 158 });
    expect(pointerClick.mock.calls).toEqual([
      ['left', 0.5, 0.5],
      ['left', 0.5, 0.5],
    ]);
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('does not show a redundant right-click button when the touch ring owns right-click', async () => {
    const { getByRole, queryByRole } = await renderPanel();
    expect(getByRole('button', { name: 'remote_desktop.touch_ring' })).toBeDefined();
    expect(queryByRole('button', { name: 'remote_desktop.touch_right_click' })).toBeNull();
  });

  it('provides a readable auto-zoomed virtual mouse with buttons, wheel, and edge pan', async () => {
    const { container, stage, video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    for (const [name, button] of [
      ['remote_desktop.mouse_left', 'left'],
      ['remote_desktop.mouse_right', 'right'],
    ] as const) {
      const target = getByRole('button', { name });
      pointer(target, 'pointerdown', { pointerId: 10, clientX: 200, clientY: 150 });
      pointer(target, 'pointerup', { pointerId: 10, clientX: 200, clientY: 150 });
      expect(pointerButton).toHaveBeenCalledWith(button, true, 0.5, 0.5);
      expect(pointerButton).toHaveBeenCalledWith(button, false, 0.5, 0.5);
    }

    const wheelControl = getByRole('button', { name: 'remote_desktop.mouse_wheel' });
    act(() => {
      pointer(wheelControl, 'pointerdown', { pointerId: 20, clientX: 200, clientY: 220 });
      pointer(wheelControl, 'pointermove', { pointerId: 20, clientX: 200, clientY: 250 });
      pointer(wheelControl, 'pointerup', { pointerId: 20, clientX: 200, clientY: 250 });
    });
    expect(wheel).toHaveBeenCalledWith(0, 240, 0.5, 0.5);

    const handle = getByRole('button', { name: 'remote_desktop.mouse_drag' });
    act(() => {
      pointer(handle, 'pointerdown', { pointerId: 30, clientX: 200, clientY: 250 });
      pointer(handle, 'pointermove', { pointerId: 30, clientX: 400, clientY: 250 });
      pointer(handle, 'pointerup', { pointerId: 30, clientX: 400, clientY: 250 });
    });
    expect(pointerMove).toHaveBeenCalled();
    expect(pointerMove).toHaveBeenCalledWith(1, 0.5);
    expect(video.style.transform).toMatch(/translate3d\(-/);
    // Mouse mode is an explicit choice, so its marker must stay unconditionally
    // visible -- it must not carry touch mode's coarse-pointer-only modifier.
    const mouseModeMarker = container.querySelector('.remote-desktop-virtual-pointer');
    expect(mouseModeMarker).not.toBeNull();
    expect(mouseModeMarker!.classList.contains('is-touch-ring-marker')).toBe(false);
    expect(stage.textContent).toContain('remote_desktop.mouse_hint');
  });

  it('recomputes readable mouse zoom when the selected display changes resolution in place', async () => {
    const { video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: true,
      route: 'direct',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 3840, height: 2160, dpiScale: 2.25, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 2,
      stream: null,
    }));

    expect(video.style.transform).toContain('scale(4)');
  });

  it('recomputes readable mouse zoom when the mobile viewport resizes', async () => {
    const { stage, video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    Object.defineProperties(stage, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(video.style.transform).toContain('scale(2.4)');
  });

  it('bounds transient reconnects and creates a fresh-authority client', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    expect(clientHooks).toHaveLength(1);
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    }));
    expect(container.textContent).toContain('remote_desktop.connection_retrying');
    // The closing client may publish another terminal snapshot after the retry
    // timer was armed. It must not replace the recovery UI with worker_failed.
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    }));
    expect(container.textContent).toContain('remote_desktop.connection_retrying');
    expect(container.textContent).not.toContain('remote_desktop.failed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS - 1,
      );
    });
    expect(clientHooks).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(clientHooks).toHaveLength(2);
  });

  it('renews the bounded retry budget after a stable recovered connection', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    const failed = {
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    };
    act(() => clientHooks[0]!.onSnapshot(failed));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS);
    });
    expect(clientHooks).toHaveLength(2);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS);
    });
    act(() => clientHooks[1]!.onSnapshot(failed));
    expect(container.textContent).toContain('remote_desktop.connection_retrying');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS);
    });
    expect(clientHooks).toHaveLength(3);
  });

  it('stops retrying after the bounded budget for one continuous outage', async () => {
    vi.useFakeTimers();
    const { container, getByRole } = await renderPanel();
    const failed = {
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    };

    for (let attempt = 0; attempt < REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS; attempt++) {
      act(() => clientHooks[attempt]!.onSnapshot(failed));
      expect(container.textContent).toContain('remote_desktop.connection_retrying');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS * (2 ** attempt),
        );
      });
      expect(clientHooks).toHaveLength(attempt + 2);
    }

    act(() => clientHooks[REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS]!
      .onSnapshot(failed));
    expect(container.textContent).toContain('remote_desktop.failed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS
          * (2 ** REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS),
      );
    });
    expect(clientHooks).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 1);

    act(() => {
      (getByRole('button', { name: 'remote_desktop.retry' }) as HTMLButtonElement).click();
    });
    expect(clientHooks).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 2);
    expect(clientStarts.at(-1)).toBe(1);
    expect(container.textContent).toContain('remote_desktop.connection_retrying');
  });

  it('treats a local-user Stop as terminal instead of reconnecting', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    expect(clientHooks).toHaveLength(1);
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_LOCAL_USER,
    }));
    expect(container.textContent).toContain('remote_desktop.failed');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(clientHooks).toHaveLength(1);
  });
});

describe('RemoteDesktopPanel in a window of its own', () => {
  const styles = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
    'utf8',
  );

  it('fills the window immediately instead of opening a panel to maximise', async () => {
    // Tearing a machine off into its own window used to land a draggable
    // 1200x760 panel inside an otherwise empty window: every tear-off began
    // with the same manual maximise, and the panel could only be dragged off
    // its own edges.
    const { container } = await renderPanel(undefined, undefined, { standalone: true });

    const panel = container.querySelector('.remote-desktop-panel');
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains('is-standalone')).toBe(true);
    // No floating window wrapper, and therefore nothing to drag or resize.
    expect(container.querySelector('.remote-desktop-floating-shell')).toBeNull();

    // The class has to carry real sizing, or it is a hook onto nothing.
    const rule = styles.match(/\.remote-desktop-panel\.is-standalone\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
  });

  it('offers no maximise control, because the window is already the panel', async () => {
    const { container } = await renderPanel(undefined, undefined, { standalone: true });
    expect(container.querySelector('.remote-desktop-maximize')).toBeNull();
    // Closing still has to be reachable -- it is what shuts the window.
    expect(container.querySelector('.remote-desktop-stop')).not.toBeNull();
  });

  it('keeps the floating panel and its maximise control when sharing a screen', async () => {
    // The docked panel is unchanged: it is one window among several, so it
    // still needs somewhere to maximise into.
    const { container } = await renderPanel();
    const panel = container.querySelector('.remote-desktop-panel');
    expect(panel!.classList.contains('is-standalone')).toBe(false);
    expect(container.querySelector('.remote-desktop-maximize')).not.toBeNull();
  });
});

function quickDataWithText(textValue: string): UseQuickDataResult {
  return {
    data: {
      history: [],
      sessionHistory: {},
      commands: [textValue],
      phrases: [],
    },
    loaded: true,
    recordHistory: vi.fn(),
    addCommand: vi.fn(),
    addPhrase: vi.fn(),
    removeCommand: vi.fn(),
    removePhrase: vi.fn(),
    removeHistory: vi.fn(),
    removeSessionHistory: vi.fn(),
    clearHistory: vi.fn(),
    clearSessionHistory: vi.fn(),
  };
}

describe('RemoteDesktopPanel quick input', () => {
  const exactText = `printf '%s\\n' "a&b; c"
next --flag='x:y'`;
  const styles = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
    'utf8',
  );

  const setFullscreenElement = (element: Element) => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: element,
    });
    act(() => document.dispatchEvent(new Event('fullscreenchange')));
  };

  const enableImmediateAnimationFrames = () => vi.spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      callback(0);
      return 1;
    });

  it('injects saved multiline command punctuation through the bound keyboard channel and restores focus', async () => {
    const animationFrame = enableImmediateAnimationFrames();
    const quickData = quickDataWithText(exactText);
    const ws = { targetsServer: () => true, send: vi.fn() };
    const rendered = await renderPanel(ws, undefined, { quickData });

    act(() => (rendered.getByRole('button', {
      name: 'remote_desktop.quick_input',
    }) as HTMLButtonElement).click());
    const dialog = rendered.getByRole('dialog', { name: 'quick_input.title' });
    expect(dialog.style.zIndex).toBe('10050');
    expect(rendered.queryByRole('button', { name: 'alias.tab' })).toBeNull();
    const command = document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLElement;
    expect(command.textContent).toContain('printf');
    act(() => command.click());

    expect(textByServer).toHaveBeenCalledWith('server-1', exactText);
    expect(quickData.recordHistory).toHaveBeenCalledWith(
      exactText,
      'remote-desktop:server-1',
    );
    expect(document.activeElement).toBe(rendered.stage);

    act(() => (rendered.getByRole('button', {
      name: 'remote_desktop.quick_input',
    }) as HTMLButtonElement).click());
    act(() => (rendered.getByRole('button', {
      name: DEFAULT_QUICK_PHRASES[0],
    }) as HTMLButtonElement).click());
    act(() => (rendered.getByRole('button', {
      name: 'remote_desktop.quick_input',
    }) as HTMLButtonElement).click());
    act(() => (rendered.getByRole('button', {
      name: SESSION_STOP_COMMAND,
    }) as HTMLButtonElement).click());

    expect(textByServer.mock.calls).toEqual([
      ['server-1', exactText],
      ['server-1', DEFAULT_QUICK_PHRASES[0]],
      ['server-1', SESSION_STOP_COMMAND],
    ]);
    expect(ws.send).not.toHaveBeenCalled();
    animationFrame.mockRestore();
  });

  it('keeps the picker inside a fullscreen panel and restores stage focus after injection', async () => {
    const animationFrame = enableImmediateAnimationFrames();
    const rendered = await renderPanel(undefined, undefined, {
      quickData: quickDataWithText(exactText),
    });
    const panel = rendered.container.querySelector('.remote-desktop-panel') as HTMLElement;
    setFullscreenElement(panel);

    const trigger = rendered.getByRole('button', { name: 'remote_desktop.quick_input' });
    fireEvent.click(trigger);
    const dialog = rendered.getByRole('dialog', { name: 'quick_input.title' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.contains(dialog)).toBe(true);
    expect(dialog.hidden).toBe(false);

    fireEvent.click(dialog.querySelector('.qp-pill-custom .qp-pill-text') as HTMLButtonElement);
    expect(textByServer).toHaveBeenCalledWith('server-1', exactText);
    expect(document.activeElement).toBe(rendered.stage);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    animationFrame.mockRestore();
  });

  it('keeps the picker inside the real fullscreen workspace root and remains interactable', async () => {
    const animationFrame = enableImmediateAnimationFrames();
    const machine = {
      serverId: 'workspace-host',
      refName: 'workspace-host',
      displayName: 'Workspace host',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    };
    const state = openRemoteDesktopWorkspaceHost(createRemoteDesktopWorkspaceState(), machine);
    const rendered = render(<RemoteDesktopWorkspace
      state={state}
      manager={new RemoteDesktopConnectionManager()}
      quickData={quickDataWithText(exactText)}
      onOpenHost={vi.fn()}
      onActivateTab={vi.fn()}
      onCloseHost={vi.fn()}
      onReorderHost={vi.fn()}
      onCloseWorkspace={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });
    const workspace = rendered.container.querySelector('.remote-desktop-workspace') as HTMLElement;
    const stage = rendered.container.querySelector('.remote-desktop-stage') as HTMLElement;
    setFullscreenElement(workspace);

    const trigger = rendered.getByRole('button', { name: 'remote_desktop.quick_input' });
    fireEvent.click(trigger);
    const dialog = rendered.getByRole('dialog', { name: 'quick_input.title' });
    expect(workspace.contains(dialog)).toBe(true);
    expect(dialog.hidden).toBe(false);

    fireEvent.click(dialog.querySelector('.qp-pill-custom .qp-pill-text') as HTMLButtonElement);
    expect(textByServer).toHaveBeenCalledWith('workspace-host', exactText);
    expect(document.activeElement).toBe(stage);
    animationFrame.mockRestore();
  });

  it('supports Tab and Enter activation, Escape focus return, and aria-expanded transitions', async () => {
    const animationFrame = enableImmediateAnimationFrames();
    const rendered = await renderPanel(undefined, undefined, {
      quickData: quickDataWithText(exactText),
    });
    const trigger = rendered.getByRole('button', { name: 'remote_desktop.quick_input' }) as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const entry = document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLButtonElement;
    for (let presses = 0; presses < 20 && document.activeElement !== entry; presses += 1) {
      fireEvent.keyDown(document, { key: 'Tab' });
    }
    expect(document.activeElement).toBe(entry);
    // jsdom does not perform a button's user-agent default action, so emulate
    // the click that an uncancelled Enter key produces in a browser.
    const runDefault = fireEvent.keyDown(entry, { key: 'Enter' });
    if (runDefault) fireEvent.click(entry);
    fireEvent.keyUp(entry, { key: 'Enter' });
    expect(textByServer).toHaveBeenCalledWith('server-1', exactText);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.qp')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    animationFrame.mockRestore();
  });

  it('keeps Quick Input usable in a mobile touch viewport beside the keyboard toolbar', async () => {
    const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const visualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const matchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 700,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    try {
      const rendered = await renderPanel(undefined, undefined, {
        quickData: quickDataWithText(exactText),
      });
      const mobileToolbar = rendered.container.querySelector('.remote-desktop-mobile-input-switch');
      expect(mobileToolbar).not.toBeNull();
      expect(rendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' })).toBeDefined();
      const trigger = rendered.getByRole('button', { name: 'remote_desktop.quick_input' });
      expect((trigger as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(trigger);
      const dialog = rendered.getByRole('dialog', { name: 'quick_input.title' });
      expect(dialog.hidden).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.qp\s*\{[^}]*position:\s*fixed/);
      expect(styles).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.remote-desktop-mobile-input-switch\s*\{[^}]*display:\s*flex/);
      fireEvent.click(dialog.querySelector('.qp-pill-custom .qp-pill-text') as HTMLButtonElement);
      expect(textByServer).toHaveBeenCalledWith('server-1', exactText);
    } finally {
      if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
      else delete (window as Window & { innerWidth?: number }).innerWidth;
      if (visualViewport) Object.defineProperty(window, 'visualViewport', visualViewport);
      else delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
      if (matchMedia) Object.defineProperty(window, 'matchMedia', matchMedia);
      else delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
    }
  });

  it('closes on reconnect and refuses a detached stale selection from the previous input epoch', async () => {
    const rendered = await renderPanel(undefined, undefined, {
      quickData: quickDataWithText(exactText),
    });
    act(() => (rendered.getByRole('button', {
      name: 'remote_desktop.quick_input',
    }) as HTMLButtonElement).click());
    const staleCommand = document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLElement;

    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 2,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
    }));
    expect(document.querySelector('.qp')).toBeNull();
    act(() => staleCommand.click());
    expect(textByServer).not.toHaveBeenCalled();
  });

  it('keeps add, edit, and delete mutations on the shared QuickInput persistence callbacks', async () => {
    const quickData = quickDataWithText('/saved --flag="a&b"');
    const rendered = await renderPanel(undefined, undefined, { quickData });
    act(() => (rendered.getByRole('button', {
      name: 'remote_desktop.quick_input',
    }) as HTMLButtonElement).click());

    fireEvent.click(rendered.getByRole('button', { name: 'quick_input.add_phrase' }));
    const addInput = document.querySelector('.qp-add-input') as HTMLInputElement;
    fireEvent.input(addInput, { target: { value: `say: 'yes' & wait` } });
    fireEvent.click(document.querySelector('.qp-add-confirm') as HTMLButtonElement);
    expect(quickData.addPhrase).toHaveBeenCalledWith(`say: 'yes' & wait`);

    fireEvent.click(document.querySelector('.qp-pill-custom .qp-pill-edit') as HTMLButtonElement);
    const editInput = document.querySelector('.qp-edit-input') as HTMLInputElement;
    fireEvent.input(editInput, { target: { value: '/saved --flag="x:y"; next' } });
    fireEvent.keyDown(editInput, { key: 'Enter' });
    expect(quickData.removeCommand).toHaveBeenCalledWith('/saved --flag="a&b"');
    expect(quickData.addCommand).toHaveBeenCalledWith('/saved --flag="x:y"; next');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(document.querySelector('.qp-pill-custom .qp-pill-del') as HTMLButtonElement);
    expect(confirm).toHaveBeenCalled();
    expect(quickData.removeCommand).toHaveBeenLastCalledWith('/saved --flag="a&b"');
    confirm.mockRestore();
  });

  it('closes and refuses stale selections after view-only, authority loss, or a workspace tab switch', async () => {
    const manager = new RemoteDesktopConnectionManager();
    const machine = {
      serverId: 'server-1',
      refName: 'controlled-1',
      displayName: 'Windows',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    };
    const quickData = quickDataWithText(exactText);
    const rendered = render(<RemoteDesktopPanel
      machine={machine}
      connectionManager={manager}
      embedded
      active
      inputActive
      quickData={quickData}
      onClose={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });

    const openAndCapture = () => {
      act(() => (rendered.getByRole('button', {
        name: 'remote_desktop.quick_input',
      }) as HTMLButtonElement).click());
      return document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLElement;
    };

    let stale = openAndCapture();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 2,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
    }));
    act(() => stale.click());

    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 3,
      inputEnabled: true,
      displays: [],
      layoutRevision: 1,
      stream: null,
    }));
    stale = openAndCapture();
    rendered.rerender(<RemoteDesktopPanel
      machine={machine}
      connectionManager={manager}
      embedded
      active={false}
      inputActive={false}
      quickData={quickData}
      onClose={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });
    act(() => stale.click());

    rendered.rerender(<RemoteDesktopPanel
      machine={machine}
      connectionManager={manager}
      embedded
      active
      inputActive
      quickData={quickData}
      onClose={vi.fn()}
    />);
    await act(async () => { await Promise.resolve(); });
    stale = openAndCapture();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 4,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    }));
    act(() => stale.click());

    expect(textByServer).not.toHaveBeenCalled();
    expect(document.querySelector('.qp')).toBeNull();
  });

  it('never sends an old host selection after the active workspace host changes', async () => {
    const quickData = quickDataWithText(exactText);
    const manager = new RemoteDesktopConnectionManager();
    const machine = (serverId: string) => ({
      serverId,
      refName: serverId,
      displayName: serverId,
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    });
    const panels = (activeServer: string) => <>
      {['host-a', 'host-b'].map((serverId) => <RemoteDesktopPanel
        key={serverId}
        machine={machine(serverId)}
        connectionManager={manager}
        embedded
        active={activeServer === serverId}
        inputActive={activeServer === serverId}
        quickData={quickData}
        onClose={vi.fn()}
      />)}
    </>;
    const rendered = render(panels('host-a'));
    await act(async () => { await Promise.resolve(); });

    const activePanel = rendered.container.querySelector('[aria-label="remote_desktop.title"]:not([hidden])') as HTMLElement;
    act(() => (activePanel.querySelector('.remote-desktop-quick-input button') as HTMLButtonElement).click());
    const hostASelection = document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLElement;

    rendered.rerender(panels('host-b'));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('.qp')).toBeNull();
    act(() => hostASelection.click());

    const hostBPanel = rendered.container.querySelector('[aria-label="remote_desktop.title"]:not([hidden])') as HTMLElement;
    act(() => (hostBPanel.querySelector('.remote-desktop-quick-input button') as HTMLButtonElement).click());
    act(() => (document.querySelector('.qp-pill-custom .qp-pill-text') as HTMLElement).click());

    expect(textByServer).toHaveBeenCalledTimes(1);
    expect(textByServer).toHaveBeenCalledWith('host-b', exactText);
  });
});
