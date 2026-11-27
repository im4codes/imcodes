/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_CONTROL_REJECTION,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_STOP_ORIGIN,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '@shared/remote-desktop.js';
import {
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY,
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
import { applyUiScale } from '../src/ui-scale.js';

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

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return {
    useTranslation: () => ({ t }),
  };
});

const pointerButton = vi.fn(() => true);
const pointerClick = vi.fn(() => true);
const pointerMove = vi.fn();
const wheel = vi.fn(() => true);
const releaseAll = vi.fn();
const reconcileModifiers = vi.fn();
const noteMetaChordKey = vi.fn();
const releasePointerButtons = vi.fn();
const acknowledgePresentedFrame = vi.fn(() => true);
const setDisplayMode = vi.fn(() => true);
const setDisplayScale = vi.fn(() => true);
const setMode = vi.fn(() => true);
const key = vi.fn(() => true);
const tapChords = vi.fn(() => true);
const text = vi.fn(() => true);
const pasteText = vi.fn(() => true);
const textByServer = vi.fn<(serverId: string, value: string) => boolean>(() => true);
const requestRemoteClipboard = vi.fn(async () => 'selected remotely');
const selectDisplay = vi.fn(() => true);
const setQualityPreference = vi.fn(() => true);
const setClipboardSync = vi.fn(() => true);
const setAudioEnabled = vi.fn(() => true);
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
  getUserPref: vi.fn(async () => null),
  saveUserPref: vi.fn(async () => undefined),
}));
const directoryAdapters = vi.hoisted(() => [] as Array<{
  serverId: string;
  options?: { supportsQuery?: boolean };
  destroy: ReturnType<typeof vi.fn>;
}>);
const fileBrowserProps = vi.hoisted(() => [] as Array<{ listView?: boolean; directoryQuery?: boolean }>);
const clientHooks: Array<{ onSnapshot(value: unknown): void }> = [];
const clientStarts: number[] = [];
let atomicButtonClickAdvertised = true;

const nativeOpenMocks = vi.hoisted(() => ({
  browserOpen: vi.fn(async () => undefined),
  isNative: vi.fn(() => false),
  apiBaseUrl: 'https://im.example.test',
}));

const voiceMocks = vi.hoisted(() => ({
  available: false,
  onResult: null as ((text: string, isFinal: boolean) => void) | null,
  onListeningChange: null as ((listening: boolean) => void) | null,
  onError: null as ((error: string) => void) | null,
  primeVoiceGesture: vi.fn(() => true),
  triggerHapticFeedback: vi.fn(async () => undefined),
  startListening: vi.fn(async (
    onResult: (text: string, isFinal: boolean) => void,
    onListeningChange?: (listening: boolean) => void,
    onError?: (error: string) => void,
  ) => {
    voiceMocks.onResult = onResult;
    voiceMocks.onListeningChange = onListeningChange ?? null;
    voiceMocks.onError = onError ?? null;
    onListeningChange?.(true);
    return true;
  }),
  stopListening: vi.fn(async (_opts?: { abort?: boolean }) => undefined),
}));

vi.mock('../src/components/VoiceInput.js', () => ({
  isAvailable: () => voiceMocks.available,
  primeVoiceGesture: (...args: unknown[]) => (voiceMocks.primeVoiceGesture as (...a: unknown[]) => boolean)(...args),
  triggerHapticFeedback: (...args: unknown[]) => (voiceMocks.triggerHapticFeedback as (...a: unknown[]) => Promise<void>)(...args),
  startListening: (
    onResult: (text: string, isFinal: boolean) => void,
    onListeningChange?: (listening: boolean) => void,
    onError?: (error: string) => void,
  ) => voiceMocks.startListening(onResult, onListeningChange, onError),
  stopListening: (opts?: { abort?: boolean }) => voiceMocks.stopListening(opts),
  onAudioLevel: vi.fn(),
  pickLocale: vi.fn(() => 'en-US'),
}));

vi.mock('../src/native.js', () => ({
  isNative: () => nativeOpenMocks.isNative(),
}));

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: (...args: unknown[]) => nativeOpenMocks.browserOpen(...args),
  },
}));

vi.mock('../src/remote-desktop-client.js', () => ({
  REMOTE_DESKTOP_CLIENT_ERROR: { WEBRTC_UNAVAILABLE: 'webrtc_unavailable' },
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
    reconcileModifiers = reconcileModifiers;
    noteMetaChordKey = noteMetaChordKey;
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
    pasteText = (value: string) => {
      pasteText(value);
      return textByServer(this.serverId, value);
    };
    setMode = setMode;
    selectDisplay = selectDisplay;
    setDisplayMode = setDisplayMode;
    setDisplayScale = setDisplayScale;
    requestUnlock = vi.fn(() => true);
    setQualityPreference = setQualityPreference;
    setClipboardSync = setClipboardSync;
    setAudioEnabled = setAudioEnabled;
    requestRemoteClipboard = requestRemoteClipboard;
  },
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: fileApiMocks.downloadAttachment,
  getApiBaseUrl: () => nativeOpenMocks.apiBaseUrl,
  getUserPref: fileApiMocks.getUserPref,
  saveUserPref: fileApiMocks.saveUserPref,
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
    constructor(readonly serverId: string, readonly options?: { supportsQuery?: boolean }) {
      directoryAdapters.push(this);
    }
    asWsClient() { return {}; }
  },
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: (props: {
    listView?: boolean;
    directoryQuery?: boolean;
    onCurrentPathChange?(path: string): void;
    onSelectedPathChange?(path: string | null, isDirectory: boolean): void;
  }) => {
    fileBrowserProps.push({ listView: props.listView, directoryQuery: props.directoryQuery });
    return (
    <div data-testid="remote-file-browser">
      <button
        type="button"
        onClick={() => {
          props.onCurrentPathChange?.('C:\\Users\\admin\\Desktop');
          props.onSelectedPathChange?.('C:\\Users\\admin\\Desktop\\report.txt', false);
        }}
      >select-remote-file</button>
    </div>
    );
  },
}));

import {
  RemoteDesktopPanel,
  recommendRemoteDesktopDpiPercent,
  resolveRemoteDesktopBrowserOpenUrl,
} from '../src/components/RemoteDesktopPanel.js';
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
  fileBrowserProps.length = 0;
  atomicButtonClickAdvertised = true;
  voiceMocks.available = false;
  voiceMocks.onResult = null;
  voiceMocks.onListeningChange = null;
  voiceMocks.onError = null;
  voiceMocks.primeVoiceGesture.mockClear();
  voiceMocks.triggerHapticFeedback.mockClear();
  voiceMocks.startListening.mockClear();
  voiceMocks.stopListening.mockClear();
  localStorage.removeItem('rcc_float_remote-desktop-server-1');
  localStorage.removeItem('imcodes.web.remote-desktop.zoom.v1.server-1');
  localStorage.removeItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY);
  localStorage.removeItem('imcodes.web.remote-desktop.audio_volume.v1');
  localStorage.removeItem('rcc_sync_remote_desktop_touch_hint_dismissed');
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const keyName = localStorage.key(i);
    if (keyName?.startsWith('imcodes.web.remote-desktop.audio_enabled.v1.')) {
      localStorage.removeItem(keyName);
    }
  }
  delete (document as Document & { fullscreenElement?: Element | null }).fullscreenElement;
});

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: { pointerId: number; clientX: number; clientY: number },
): void {
  const eventName = type === 'pointerdown' && !('onpointerdown' in target)
    ? 'PointerDown'
    : type === 'pointermove' && !('onpointermove' in target)
      ? 'PointerMove'
      : type === 'pointerup' && !('onpointerup' in target)
        ? 'PointerUp'
        : type === 'pointercancel' && !('onpointercancel' in target)
          ? 'PointerCancel'
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
    menuBarHidden?: boolean;
    onShowMenuBar?: () => void;
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
    menuBarHidden={panelProps.menuBarHidden}
    onShowMenuBar={panelProps.onShowMenuBar}
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

  it('keeps the last frame when the same peer replaces its media stream during a quality switch', async () => {
    let presentedCallback: VideoFrameRequestCallback | undefined;
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: {
        configurable: true,
        value: (callback: VideoFrameRequestCallback) => { presentedCallback = callback; return 82; },
      },
      cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(), clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    try {
      const firstTrack = Object.assign(new EventTarget(), { muted: false, readyState: 'live' });
      const secondTrack = Object.assign(new EventTarget(), { muted: false, readyState: 'live' });
      const first = { getVideoTracks: () => [firstTrack] } as unknown as MediaStream;
      const second = { getVideoTracks: () => [secondTrack] } as unknown as MediaStream;
      const rendered = await renderPanel();
      const snapshot = {
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 0,
        inputEnabled: false,
        route: 'direct',
        displays: [],
        layoutRevision: 1,
        streamGeneration: 7,
      };
      act(() => clientHooks[0]!.onSnapshot({ ...snapshot, stream: first }));
      act(() => presentedCallback?.(100, {} as VideoFrameCallbackMetadata));
      firstTrack.muted = true;
      act(() => firstTrack.dispatchEvent(new Event('mute')));
      expect(rendered.container.querySelector('.remote-desktop-last-frame')?.classList
        .contains('is-visible')).toBe(true);

      act(() => clientHooks[0]!.onSnapshot({ ...snapshot, stream: second }));
      expect(rendered.container.querySelector('.remote-desktop-last-frame')?.classList
        .contains('is-visible')).toBe(true);
      expect(rendered.container.querySelector('.remote-desktop-stage-placeholder')).toBeNull();
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

    act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 1,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      error: REMOTE_DESKTOP_ERROR.ACCESS_DENIED,
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
    expect(trigger(first).getAttribute('aria-label')).toContain('quality_short_balanced');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 1440, maxFps: 30, maxBitrateBps: 10_000_000, priority: 'balanced' },
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
      { maxHeight: 0, maxFps: 30, maxBitrateBps: 15_000_000, priority: 'resolution' },
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
      { maxHeight: 0, maxFps: 30, maxBitrateBps: 15_000_000, priority: 'resolution' },
      { latencyGuard: true },
    );

    // Another server keeps its own setting -- here the default -- even in
    // the same panel.
    reopened.rerender(<RemoteDesktopPanel machine={machine('server-2')} onClose={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(trigger(reopened).getAttribute('aria-label')).toContain('quality_short_balanced');
    expect(setQualityPreference).toHaveBeenLastCalledWith(
      { maxHeight: 1440, maxFps: 30, maxBitrateBps: 10_000_000, priority: 'balanced' },
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

  it('lists the remote folder as a table, and asks the node to filter/order it only when the node can', async () => {
    const withQuery = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY, FILE_TRANSFER_DIRECTORY_CAPABILITY, FILE_TRANSFER_DIRECTORY_QUERY_CAPABILITY]);
    act(() => { (withQuery.getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    expect(fileBrowserProps.at(-1)).toEqual({ listView: true, directoryQuery: true });
    expect(directoryAdapters.at(-1)?.options).toEqual({ supportsQuery: true });
    cleanup();
    directoryAdapters.length = 0;
    fileBrowserProps.length = 0;

    const older = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY, FILE_TRANSFER_DIRECTORY_CAPABILITY]);
    act(() => { (older.getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    expect(fileBrowserProps.at(-1)).toEqual({ listView: true, directoryQuery: false });
    expect(directoryAdapters.at(-1)?.options).toEqual({ supportsQuery: false });
  });

  it('uses the embedded remote file selection for an explicit fetch action', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'handle-1' });
    fileApiMocks.downloadAttachment.mockResolvedValue(undefined);
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue({
      handle: { createWritable: vi.fn() },
    });
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
    expect(directTransferMocks.selectPreviewDownloadDestination).not.toHaveBeenCalled();
    expect(directTransferMocks.downloadPreviewWithDirectFallback).not.toHaveBeenCalled();
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledWith(
      'server-1',
      'handle-1',
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('skips save destination picking and runs a single browser download when ws targets a different server', async () => {
    fileApiMocks.createMachineFileHandle.mockResolvedValue({ id: 'handle-other-ws' });
    fileApiMocks.downloadAttachment.mockResolvedValue(undefined);
    directTransferMocks.selectPreviewDownloadDestination.mockResolvedValue({
      handle: { createWritable: vi.fn() },
    });
    const ws = { targetsServer: vi.fn(() => false) };
    const { getByRole } = await renderPanel(ws, [
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
    expect(ws.targetsServer).toHaveBeenCalledWith('server-1');
    expect(directTransferMocks.selectPreviewDownloadDestination).not.toHaveBeenCalled();
    expect(directTransferMocks.downloadPreviewWithDirectFallback).not.toHaveBeenCalled();
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(fileApiMocks.downloadAttachment).toHaveBeenCalledWith(
      'server-1',
      'handle-other-ws',
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
      traffic: { bytesSent: 1024, bytesReceived: 2048 },
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
    const traffic = stats?.querySelector('[data-remote-desktop-traffic]');
    expect(traffic?.getAttribute('data-bytes-sent')).toBe('1024');
    expect(traffic?.getAttribute('data-bytes-received')).toBe('2048');
    expect(traffic?.textContent).toContain('remote_desktop.traffic_usage');
    expect(stats?.textContent).toContain('1920×1080');
    expect(stats?.textContent).toContain('29 FPS');
    expect(stats?.textContent).toContain('4.2 Mbps · 24 ms');
    // The latency figure says what it is: a full round trip, not one-way.
    const rtt = container.querySelector('.remote-desktop-stats [data-rtt-ms]');
    expect(rtt?.getAttribute('title')).toBe('remote_desktop.rtt_definition');
    expect(rtt?.getAttribute('data-rtt-ms')).toBe('24');
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

  it('places Windows DPI scale side-by-side with resolution options and updates DPI automatically when Auto DPI is enabled', async () => {
    expect(recommendRemoteDesktopDpiPercent(5120, 2880)).toBe(250);
    expect(recommendRemoteDesktopDpiPercent(3840, 2160)).toBe(200);
    expect(recommendRemoteDesktopDpiPercent(2560, 1600)).toBe(150);
    expect(recommendRemoteDesktopDpiPercent(2560, 1440)).toBe(150);
    expect(recommendRemoteDesktopDpiPercent(1920, 1440)).toBe(125);
    expect(recommendRemoteDesktopDpiPercent(1920, 1080)).toBe(100);
    expect(recommendRemoteDesktopDpiPercent(1280, 720)).toBe(100);

    const { getByRole, getAllByRole, getByTestId } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });
    const openMenu = () => {
      act(() => {
        displayTab.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 50,
        }));
      });
    };

    openMenu();
    const menu = getByRole('menu');
    const columns = menu.querySelector('.remote-desktop-display-menu-columns');
    const resCol = menu.querySelector('.remote-desktop-resolution-col');
    const dpiCol = menu.querySelector('.remote-desktop-dpi-col');
    expect(columns).not.toBeNull();
    expect(resCol).not.toBeNull();
    expect(dpiCol).not.toBeNull();
    expect(resCol?.contains(getAllByRole('menuitemradio').find((m) => m.textContent?.includes('×'))!)).toBe(true);
    expect(dpiCol?.contains(getByTestId('remote-desktop-dpi-auto'))).toBe(true);
    expect(dpiCol?.contains(getByRole('menuitemradio', { name: '150% DPI' }))).toBe(true);

    // Enable Auto DPI -> immediately applies recommended DPI for current 1920x1080 display (100%)
    act(() => { (getByTestId('remote-desktop-dpi-auto') as HTMLButtonElement).click(); });
    expect(setDisplayScale).toHaveBeenCalledWith('display-primary', 100);

    // Switch resolution to 4K while Auto DPI is active -> sends both setDisplayMode and setDisplayScale(200)
    setDisplayScale.mockClear();
    setDisplayMode.mockClear();
    openMenu();
    expect(getByTestId('remote-desktop-dpi-auto').getAttribute('aria-checked')).toBe('true');
    const mode4k = getAllByRole('menuitemradio').find((mode) => mode.textContent?.includes('3840×2160'))!;
    act(() => { (mode4k as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-primary', 3840, 2160);
    expect(setDisplayScale).toHaveBeenCalledWith('display-primary', 200);

    // Selecting a manual DPI turns off Auto DPI for subsequent resolution switches
    setDisplayScale.mockClear();
    setDisplayMode.mockClear();
    openMenu();
    act(() => { (getByRole('menuitemradio', { name: '125% DPI' }) as HTMLButtonElement).click(); });
    expect(setDisplayScale).toHaveBeenCalledWith('display-primary', 125);

    setDisplayScale.mockClear();
    openMenu();
    expect(getByTestId('remote-desktop-dpi-auto').getAttribute('aria-checked')).toBe('false');
    const mode1080p = getAllByRole('menuitemradio').find((mode) => mode.textContent?.includes('1920×1080'))!;
    act(() => { (mode1080p as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-primary', 1920, 1080);
    expect(setDisplayScale).not.toHaveBeenCalled();
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
    expect(pasteText).toHaveBeenCalledWith('pasted from event');

    await act(async () => {
      (getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(pasteText).toHaveBeenCalledWith('local clipboard');

    await act(async () => {
      (getByRole('button', { name: 'common.copy' }) as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected remotely');
  });

  it('does not overwrite the local clipboard and shows empty status when copy button gets empty selection', async () => {
    const write = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn(async () => ''), write, writeText },
    });
    const OrigItem = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    class LocalStubClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal('ClipboardItem', LocalStubClipboardItem);
    write.mockImplementationOnce(async (items: LocalStubClipboardItem[]) => {
      await items[0]!.items['text/plain'];
    });
    try {
      requestRemoteClipboard.mockResolvedValueOnce('');
      const { getByRole, findByText } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
      await act(async () => {
        (getByRole('button', { name: 'common.copy' }) as HTMLButtonElement).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(await findByText('remote_desktop.clipboard_empty')).toBeTruthy();
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      if (OrigItem === undefined) {
        Reflect.deleteProperty(globalThis as object, 'ClipboardItem');
      } else {
        vi.stubGlobal('ClipboardItem', OrigItem);
      }
    }
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
      expect(pasteText).toHaveBeenCalledWith('pasted via native event');
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
    expect(pasteText).toHaveBeenCalledWith('from readText');
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
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });

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
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
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
    // in the panel layout instead of covering the video. Defaults to the computer keyboard tab.
    expect(stage!.contains(keyboard)).toBe(false);
    expect(getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.remote-desktop-computer-keyboard')).not.toBeNull();
    expect(container.querySelector('[aria-label="remote_desktop.mobile_text_input"]')).toBeNull();

    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
    const imeInput = getByRole('textbox', { name: 'remote_desktop.mobile_text_input' }) as HTMLTextAreaElement;
    expect(imeInput).toBeDefined();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(imeInput);
    });

    // Closing and reopening resets back to the computer keyboard default tab and page.
    act(() => {
      (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
    });
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.remote-desktop-computer-keyboard')).not.toBeNull();
    expect(container.querySelector('[aria-label="remote_desktop.mobile_text_input"]')).toBeNull();
  });

  it('notifies onMobileKeyboardOpenChange when opening keys or ime keyboard tabs and resets on close or unmount', async () => {
    const onMobileKeyboardOpenChange = vi.fn();
    const manager = new RemoteDesktopConnectionManager();
    const rendered = render(
      <RemoteDesktopPanel
        machine={{
          serverId: 'srv-kb-cb',
          refName: 'srv-kb-cb',
          displayName: 'KB Host',
          os: 'win',
          online: true,
          execEnabled: true,
          accessRole: 'owner',
          capabilities: [REMOTE_DESKTOP_CAPABILITY],
        }}
        connectionManager={manager}
        onClose={vi.fn()}
        onMobileKeyboardOpenChange={onMobileKeyboardOpenChange}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    onMobileKeyboardOpenChange.mockClear();

    act(() => { (rendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(onMobileKeyboardOpenChange).toHaveBeenLastCalledWith(true);

    // Switching from virtual PC keys tab to ime tab keeps keyboard open state true
    onMobileKeyboardOpenChange.mockClear();
    act(() => {
      (rendered.getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
    expect(onMobileKeyboardOpenChange).not.toHaveBeenCalledWith(false);

    // Closing keyboard notifies false
    act(() => { (rendered.getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(onMobileKeyboardOpenChange).toHaveBeenLastCalledWith(false);

    // Re-opening keyboard and unmounting resets parent state back to false
    act(() => { (rendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(onMobileKeyboardOpenChange).toHaveBeenLastCalledWith(true);
    rendered.unmount();
    expect(onMobileKeyboardOpenChange).toHaveBeenLastCalledWith(false);
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
    expect((container.querySelector('.remote-desktop-touch-hint') as HTMLElement).hidden).toBe(true);
    expect(container.querySelector('.remote-desktop-stats')).not.toBeNull();

    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect((container.querySelector('.remote-desktop-touch-hint') as HTMLElement).hidden).toBe(false);

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

    // Switching to the IME tab keeps the same space-saving contract active.
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
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
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
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

    expect(container.querySelector('.remote-desktop-combo-toggle')).toBeNull();

    key.mockClear();
    act(() => { keyButton('Control').click(); });
    expect(keyButton('Control').getAttribute('aria-pressed')).toBe('true');
    expect(keyButton('Control').getAttribute('data-modifier-state')).toBe('oneshot');
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

    // The letters are showing by default -- what most typing needs.
    expect(keyButton('q')).toBeDefined();
    expect(track.style.transform).toContain('translateX(calc(-33.33');

    // A right-swipe well past the 20% commit threshold flips to page one.
    act(() => {
      pointer(pages, 'pointerdown', { pointerId: 8, clientX: 150, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 8, clientX: 250, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 8, clientX: 300, clientY: 200 });
      pointer(pages, 'pointerup', { pointerId: 8, clientX: 300, clientY: 200 });
    });
    expect(keyButton('F5')).toBeDefined();
    expect(track.style.transform).toContain('translateX(calc(0%');

    // ...and a left-swipe back to the letters.
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
      pointer(two, 'pointercancel', { pointerId: 25, clientX: 100, clientY: 278 });
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

    // Starts on the letters page and stays there.
    act(() => {
      pointer(pages, 'pointerdown', { pointerId: 10, clientX: 300, clientY: 200 });
      pointer(pages, 'pointermove', { pointerId: 10, clientX: 280, clientY: 200 });
      pointer(pages, 'pointerup', { pointerId: 10, clientX: 280, clientY: 200 });
    });
    expect(track.style.transform).toContain('translateX(calc(-33.33');
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
    voiceMocks.triggerHapticFeedback.mockClear();
    act(() => {
      pointer(displayTab, 'pointerdown', { pointerId: 44, clientX: 80, clientY: 60 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(getByRole('menu')).not.toBeNull();
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledWith(20, 'medium');
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledTimes(1);
    act(() => {
      pointer(displayTab, 'pointerup', { pointerId: 44, clientX: 80, clientY: 60 });
      (displayTab as HTMLButtonElement).click();
    });
    expect(setDisplayMode).not.toHaveBeenCalled();
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledTimes(1);
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
    expect(reconcileModifiers).toHaveBeenCalledWith({
      control: false,
      alt: false,
      shift: false,
      meta: false,
    }, undefined);
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('applies oneshot and locked mobile Control modifiers across synthetic taps', async () => {
    const { stage, container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
    act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
    const control = [...container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-row button')]
      .find((button) => button.textContent === 'Control')!;

    // 1st tap = oneshot: reconciles control=true on the tap and releases after the click succeeds
    act(() => { control.click(); });
    reconcileModifiers.mockClear();
    releaseAll.mockClear();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 101, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 101, clientX: 200, clientY: 150 });
    });
    expect(reconcileModifiers).toHaveBeenCalledWith({
      control: true,
      alt: false,
      shift: false,
      meta: false,
    }, undefined);
    expect(releaseAll).not.toHaveBeenCalled();
    expect(control.getAttribute('aria-pressed')).toBe('false');

    // 2 taps = locked: keeps Control latched across multiple synthetic clicks
    act(() => { control.click(); });
    act(() => { control.click(); });
    expect(control.getAttribute('data-modifier-state')).toBe('locked');
    reconcileModifiers.mockClear();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 102, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 102, clientX: 200, clientY: 150 });
    });
    expect(reconcileModifiers).toHaveBeenCalledWith({
      control: true,
      alt: false,
      shift: false,
      meta: false,
    }, undefined);
    expect(control.getAttribute('aria-pressed')).toBe('true');
    expect(control.getAttribute('data-modifier-state')).toBe('locked');
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
    act(() => {
      (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
    });
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

    // A tap is not a focus change either: WebKit blurs the focused field for
    // one, which is what closed the keyboard while dragging never did.
    const touchEnd = (target: Element) => {
      const event = new Event('ontouchend' in target ? 'touchend' : 'TouchEnd', {
        bubbles: true,
        cancelable: true,
      });
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    expect(touchEnd(stage).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    // Closing it hands the stage back for physical keyboard input.
    act(() => { (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click(); });
    expect(touchEnd(stage).defaultPrevented).toBe(false);
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

  it('keeps the touch ring position across geometry-only resizes and clamps it to the stage', async () => {
    const { stage, getByLabelText } = await renderPanel();
    const ring = getByLabelText('remote_desktop.touch_ring');

    // The first resize after the test harness supplies usable stage geometry
    // completes the same initial-centre pass that ResizeObserver performs in
    // a browser.
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('200px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${150 + 72}px`);

    // Move the ring away from centre, then resize without changing display,
    // layout, scale or input mode. The position must survive unchanged.
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 301, clientX: 320, clientY: 120 });
      pointer(stage, 'pointerup', { pointerId: 301, clientX: 320, clientY: 120 });
    });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('320px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${120 + 72}px`);

    // Minimizing a floating panel can briefly report a zero-sized stage. That
    // transient geometry must not overwrite the last usable ring coordinate;
    // restoring the panel should paint it back at the same place.
    Object.defineProperties(stage, {
      clientWidth: { value: 0, configurable: true },
      clientHeight: { value: 0, configurable: true },
    });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('320px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${120 + 72}px`);

    Object.defineProperties(stage, {
      clientWidth: { value: 400, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('320px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${120 + 72}px`);

    Object.defineProperties(stage, {
      clientWidth: { value: 240, configurable: true },
      clientHeight: { value: 180, configurable: true },
    });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('240px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${120 + 72}px`);

    // A still smaller stage clamps both coordinates, and growing it again
    // does not recenter the user's ring.
    Object.defineProperties(stage, {
      clientWidth: { value: 100, configurable: true },
      clientHeight: { value: 80, configurable: true },
    });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('100px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${80 + 72}px`);

    Object.defineProperties(stage, {
      clientWidth: { value: 600, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('100px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${80 + 72}px`);
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
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('300px');
    expect(ring.style.getPropertyValue('--touch-ring-y')).toBe(`${150 + 72}px`);

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
    expect(ring.style.getPropertyValue('--touch-ring-x')).toBe('250px');
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
    voiceMocks.triggerHapticFeedback.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 11, clientX: 200, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    // Held: armed, and still free to become a drag, so nothing clicked yet.
    expect(ring.className).toContain('is-right');
    expect(pointerClick).not.toHaveBeenCalled();
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledWith(20, 'medium');
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledTimes(1);
    act(() => { pointer(ring, 'pointerup', { pointerId: 11, clientX: 200, clientY: 150 }); });
    expect(pointerClick).toHaveBeenCalledTimes(1);
    expect(pointerClick).toHaveBeenCalledWith('right', 0.5, 0.5);
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledTimes(1);
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
    voiceMocks.triggerHapticFeedback.mockClear();
    act(() => { pointer(ring, 'pointerdown', { pointerId: 13, clientX: 200, clientY: 150 }); });
    act(() => { pointer(ring, 'pointermove', { pointerId: 13, clientX: 230, clientY: 150 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(pointerClick).not.toHaveBeenCalledWith('right', expect.anything(), expect.anything());
    expect(ring.className).not.toContain('is-right');
    expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();
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
        expect(pasteText).toHaveBeenCalledWith('from local clipboard');
        expect(key).not.toHaveBeenCalled();
        const duplicatePasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(duplicatePasteEvent, 'clipboardData', {
          value: { getData: vi.fn(() => 'from local clipboard') },
        });
        act(() => stage.dispatchEvent(duplicatePasteEvent));
        expect(duplicatePasteEvent.defaultPrevented).toBe(true);
        expect(pasteText).toHaveBeenCalledTimes(1);
      });
    });

    it('takes a PC operator\'s Linux selection on Control+Shift+C and forwards the terminal chord', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn(async () => ''), writeText: vi.fn(async () => {}) },
      });
      await withControllerPlatform('Win32', async () => {
        const { stage } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
        await act(async () => {
          stage.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, code: 'KeyC', key: 'c',
            ctrlKey: true, shiftKey: true,
          }));
          await Promise.resolve();
        });
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
        expect(key).toHaveBeenCalledWith(
          'KeyC', 'c', true, false, { control: true, alt: false },
        );
        const keyup = press(stage, 'keyup', {
          code: 'KeyC', key: 'c', ctrlKey: true, shiftKey: true,
        });
        expect(keyup.defaultPrevented).toBe(true);
        expect(key).toHaveBeenCalledWith(
          'KeyC', 'c', false, false, { control: true, alt: false },
        );
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
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

  it('does not treat touch pointerleave after a tap as focus loss', async () => {
    const { stage } = await renderPanel();
    releaseAll.mockClear();
    pointer(stage, 'pointerdown', { pointerId: 91, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 91, clientX: 200, clientY: 150 });
    const event = new MouseEvent('pointerleave', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: 91 },
      pointerType: { value: 'touch' },
    });
    stage.dispatchEvent(event);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('reconciles a modifier swallowed by the browser on the next key event', async () => {
    const { stage } = await renderPanel();
    act(() => {
      stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'ControlLeft',
        key: 'Control',
        ctrlKey: true,
      }));
      stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyA',
        key: 'a',
        ctrlKey: false,
      }));
    });
    expect(reconcileModifiers).toHaveBeenLastCalledWith({
      control: false,
      alt: false,
      shift: false,
      meta: false,
    }, 'KeyA');
  });

  it('releases a letter whose keyup was swallowed during Cmd+E when Meta is released', async () => {
    const { stage } = await renderPanel();
    key.mockClear();
    act(() => {
      stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, code: 'MetaLeft', key: 'Meta', metaKey: true,
      }));
      stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, cancelable: true, code: 'KeyE', key: 'e', metaKey: true,
      }));
      const metaUp = new KeyboardEvent('keyup', {
        bubbles: true, cancelable: true, code: 'MetaLeft', key: 'Meta', metaKey: false,
      });
      Object.defineProperty(metaUp, 'getModifierState', {
        value: (name: string) => name === 'Meta' ? false : false,
      });
      stage.dispatchEvent(metaUp);
    });
    expect(noteMetaChordKey).toHaveBeenCalledWith('KeyE', 'e', true);
    expect(reconcileModifiers).toHaveBeenCalled();
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
      const leave = new MouseEvent('pointerleave', { bubbles: true, cancelable: true });
      Object.defineProperties(leave, { pointerId: { value: 2 }, pointerType: { value: 'touch' } });
      stage.dispatchEvent(leave);
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
    voiceMocks.triggerHapticFeedback.mockClear();
    vi.useFakeTimers();

    pointer(stage, 'pointerdown', { pointerId: 40, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(550); });
    pointer(stage, 'pointerup', { pointerId: 40, clientX: 200, clientY: 150 });
    expect(pointerClick.mock.calls).toEqual([['right', 0.5, 0.5]]);
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledWith(20, 'medium');
    expect(voiceMocks.triggerHapticFeedback).toHaveBeenCalledTimes(1);

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

  describe('mobile haptic feedback', () => {
    it('does not trigger haptic feedback on short tap or when gesture moves before 550ms on stage', async () => {
      vi.useFakeTimers();
      const { stage } = await renderPanel();
      voiceMocks.triggerHapticFeedback.mockClear();

      // 1. Short tap (under 550ms)
      pointer(stage, 'pointerdown', { pointerId: 101, clientX: 200, clientY: 150 });
      act(() => { vi.advanceTimersByTime(200); });
      pointer(stage, 'pointerup', { pointerId: 101, clientX: 200, clientY: 150 });
      act(() => { vi.advanceTimersByTime(400); });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();

      // 2. Touch move exceeding threshold cancels long press
      voiceMocks.triggerHapticFeedback.mockClear();
      pointer(stage, 'pointerdown', { pointerId: 102, clientX: 200, clientY: 150 });
      act(() => { vi.advanceTimersByTime(100); });
      pointer(stage, 'pointermove', { pointerId: 102, clientX: 220, clientY: 150 });
      act(() => { vi.advanceTimersByTime(550); });
      pointer(stage, 'pointerup', { pointerId: 102, clientX: 220, clientY: 150 });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();

      // 3. Second finger arriving cancels single-finger long-press
      voiceMocks.triggerHapticFeedback.mockClear();
      pointer(stage, 'pointerdown', { pointerId: 103, clientX: 200, clientY: 150 });
      act(() => { vi.advanceTimersByTime(100); });
      pointer(stage, 'pointerdown', { pointerId: 104, clientX: 240, clientY: 180 });
      act(() => { vi.advanceTimersByTime(550); });
      pointer(stage, 'pointerup', { pointerId: 103, clientX: 200, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 104, clientX: 240, clientY: 180 });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();

      // 4. View-only mode (!snapshot.inputEnabled) does not trigger haptics
      voiceMocks.triggerHapticFeedback.mockClear();
      act(() => clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.CONNECTED,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 1,
        inputEnabled: false,
        displays: [{ id: 'display-1', name: 'Main', width: 800, height: 600, primary: true }],
        layoutRevision: 1,
        stream: null,
      }));
      pointer(stage, 'pointerdown', { pointerId: 105, clientX: 200, clientY: 150 });
      act(() => { vi.advanceTimersByTime(550); });
      pointer(stage, 'pointerup', { pointerId: 105, clientX: 200, clientY: 150 });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();
    });

    it('does not trigger haptic feedback on display tab when moved or released before 550ms', async () => {
      vi.useFakeTimers();
      const { getByRole } = await renderPanel();
      const displayTab = getByRole('tab', { name: 'remote_desktop.display_name_main' });

      // 1. Released before 550ms
      voiceMocks.triggerHapticFeedback.mockClear();
      act(() => {
        pointer(displayTab, 'pointerdown', { pointerId: 110, clientX: 80, clientY: 60 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      act(() => {
        pointer(displayTab, 'pointerup', { pointerId: 110, clientX: 80, clientY: 60 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();

      // 2. Moved > 10px before 550ms
      voiceMocks.triggerHapticFeedback.mockClear();
      act(() => {
        pointer(displayTab, 'pointerdown', { pointerId: 111, clientX: 80, clientY: 60 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      act(() => {
        pointer(displayTab, 'pointermove', { pointerId: 111, clientX: 100, clientY: 60 });
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(550); });
      act(() => {
        pointer(displayTab, 'pointerup', { pointerId: 111, clientX: 100, clientY: 60 });
      });
      expect(voiceMocks.triggerHapticFeedback).not.toHaveBeenCalled();
    });
  });

  it('does not show a redundant right-click button when the touch ring owns right-click', async () => {
    const { getByRole, queryByRole } = await renderPanel();
    expect(getByRole('button', { name: 'remote_desktop.touch_ring' })).toBeDefined();
    expect(queryByRole('button', { name: 'remote_desktop.touch_right_click' })).toBeNull();
  });

  it('keeps the touch hint and Got it button hidden in touch mode across legacy prefs, resizes, and keyboard toggles while preserving mouse hint', async () => {
    const first = await renderPanel();
    const firstHint = first.container.querySelector('.remote-desktop-touch-hint') as HTMLElement;
    expect(firstHint.hidden).toBe(true);
    expect(firstHint.textContent).toBe('');
    expect(first.queryByRole('button', { name: 'remote_desktop.touch_hint_dismiss' })).toBeNull();
    first.unmount();

    for (const storedValue of ['{"v":false,"t":1}', '{"v":true,"t":1}']) {
      localStorage.setItem('rcc_sync_remote_desktop_touch_hint_dismissed', storedValue);
      fileApiMocks.getUserPref.mockResolvedValueOnce(storedValue as never);
      const reopened = await renderPanel();
      const hint = reopened.container.querySelector('.remote-desktop-touch-hint') as HTMLElement;
      expect(hint.hidden).toBe(true);
      expect(hint.textContent).toBe('');
      expect(reopened.queryByRole('button', { name: 'remote_desktop.touch_hint_dismiss' })).toBeNull();

      act(() => {
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('remote-desktop-touch-hint-dismissed'));
        (reopened.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
      });
      expect(hint.hidden).toBe(true);
      act(() => {
        (reopened.getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
      });
      expect(hint.hidden).toBe(true);
      expect(reopened.queryByRole('button', { name: 'remote_desktop.touch_hint_dismiss' })).toBeNull();

      act(() => {
        fireEvent.click(reopened.getByRole('button', { name: 'remote_desktop.mouse_mode' }));
      });
      expect(hint.hidden).toBe(false);
      expect(reopened.queryByRole('button', { name: 'remote_desktop.touch_hint_dismiss' })).toBeNull();
      expect(hint.textContent).toContain('remote_desktop.mouse_hint');

      act(() => {
        fireEvent.click(reopened.getByRole('button', { name: 'remote_desktop.touch_mode' }));
      });
      expect(hint.hidden).toBe(true);
      expect(hint.textContent).toBe('');
      reopened.unmount();
    }
    expect(fileApiMocks.saveUserPref).not.toHaveBeenCalled();
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

  it('keeps the mouse viewport and pointer position across height-only status-bar reflow', async () => {
    const { stage, video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');
    pointerMove.mockClear();
    Object.defineProperties(stage, {
      clientWidth: { value: 400, configurable: true },
      clientHeight: { value: 220, configurable: true },
    });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(video.style.transform).toContain('scale(3.2)');
    expect(pointerMove).not.toHaveBeenCalled();
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

  it('shows WebRTC-unavailable guidance and Open in Browser instead of protocol_error/Retry', async () => {
    nativeOpenMocks.isNative.mockReturnValue(false);
    nativeOpenMocks.apiBaseUrl = 'https://im.example.test';
    nativeOpenMocks.browserOpen.mockClear();
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    const { container, getByRole, queryByRole } = await renderPanel();

    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      error: 'webrtc_unavailable',
      retryable: false,
    }));

    expect(container.textContent).toContain('remote_desktop.webrtc_unavailable');
    expect(container.textContent).not.toContain('remote_desktop.failed');
    expect(container.textContent).not.toContain('protocol_error');
    expect(queryByRole('button', { name: 'remote_desktop.retry' })).toBeNull();

    const openBtn = getByRole('button', { name: 'remote_desktop.open_in_browser' }) as HTMLButtonElement;
    expect(openBtn.disabled).toBe(false);
    await act(async () => { openBtn.click(); });
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^https?:\/\/[^/]+\/remote-desktop\/app\/\?machine=server-1$/),
      '_blank',
      'noopener,noreferrer',
    );

    // Native (e.g. iOS App on Mac via Capacitor) uses Browser.open with deep link directly to the target machine
    nativeOpenMocks.isNative.mockReturnValue(true);
    nativeOpenMocks.apiBaseUrl = 'https://im.zhinet.work';
    act(() => { openBtn.click(); });
    await vi.waitFor(() => {
      expect(nativeOpenMocks.browserOpen).toHaveBeenCalledWith({
        url: 'https://im.zhinet.work/remote-desktop/app/?machine=server-1',
      });
    });

    // Direct URL resolver boundary checks: subpaths/ports, invalid/missing machineId fallback, non-http(s) rejection
    expect(resolveRemoteDesktopBrowserOpenUrl('srv_abc-123')).toBe(
      'https://im.zhinet.work/remote-desktop/app/?machine=srv_abc-123',
    );
    nativeOpenMocks.apiBaseUrl = 'http://127.0.0.1:8787/nested/path/';
    expect(resolveRemoteDesktopBrowserOpenUrl('server-1')).toBe(
      'http://127.0.0.1:8787/remote-desktop/app/?machine=server-1',
    );
    expect(resolveRemoteDesktopBrowserOpenUrl(undefined)).toBe('http://127.0.0.1:8787/remote-desktop/app/');
    expect(resolveRemoteDesktopBrowserOpenUrl('')).toBe('http://127.0.0.1:8787/remote-desktop/app/');
    expect(resolveRemoteDesktopBrowserOpenUrl('bad id/?evil=1')).toBe('http://127.0.0.1:8787/remote-desktop/app/');
    nativeOpenMocks.apiBaseUrl = 'capacitor://localhost';
    expect(resolveRemoteDesktopBrowserOpenUrl('server-1')).toBeNull();
    nativeOpenMocks.apiBaseUrl = '';
    expect(resolveRemoteDesktopBrowserOpenUrl('server-1')).toBeNull();

    // Unsafe/non-http(s) URL must never pass to Browser.open
    cleanup();
    nativeOpenMocks.apiBaseUrl = 'javascript:alert(1)';
    nativeOpenMocks.browserOpen.mockClear();
    const unsafeResult = await renderPanel();
    act(() => clientHooks.at(-1)!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      error: 'webrtc_unavailable',
      retryable: false,
    }));
    const disabledOpenBtn = unsafeResult.getByRole('button', { name: 'remote_desktop.open_in_browser' }) as HTMLButtonElement;
    expect(disabledOpenBtn.disabled).toBe(true);
    await act(async () => { disabledOpenBtn.click(); });
    expect(nativeOpenMocks.browserOpen).not.toHaveBeenCalled();
    nativeOpenMocks.isNative.mockReturnValue(false);
    nativeOpenMocks.apiBaseUrl = 'https://im.example.test';
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

describe('remote desktop mobile keyboard voice hold-to-talk', () => {
  const makeMachine = () => ({
    serverId: 'server-1',
    refName: 'server-1',
    displayName: 'Server 1',
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner' as const,
    capabilities: [REMOTE_DESKTOP_CAPABILITY],
  });

  async function renderWithKeyboardOpen() {
    const manager = new RemoteDesktopConnectionManager();
    const rendered = render(
      <RemoteDesktopPanel
        machine={makeMachine()}
        connectionManager={manager}
        embedded
        active
        inputActive
        onClose={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    return rendered;
  }

  it('renders the voice button only inside opened mobile keyboard tabs when VoiceInput is available and inputEnabled is true', async () => {
    voiceMocks.available = true;
    const { container, getByRole, queryByRole } = await renderWithKeyboardOpen();

    // Closed keyboard: voice trigger must NOT render.
    expect(container.querySelector('.remote-desktop-voice-trigger')).toBeNull();
    expect(queryByRole('button', { name: 'voice.voice_input' })).toBeNull();

    // Open mobile keyboard drawer: mic sits strictly between 'ime' and 'keys' tabs.
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
    });
    const tablist = container.querySelector('.remote-desktop-mobile-keyboard-head .remote-desktop-mobile-keyboard-tabs')!;
    const children = Array.from(tablist.children);
    expect(children).toHaveLength(3);
    expect(children[0]?.getAttribute('role')).toBe('tab');
    expect(children[0]?.textContent).toBe('remote_desktop.mobile_keyboard_tab_ime');
    expect(children[1]?.classList.contains('remote-desktop-voice-trigger')).toBe(true);
    expect(children[2]?.getAttribute('role')).toBe('tab');
    expect(children[2]?.textContent).toBe('remote_desktop.mobile_keyboard_tab_keys');

    // Unavailable VoiceInput hides the button.
    voiceMocks.available = false;
    act(() => {
      clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 2,
        inputEnabled: true,
        displays: [],
        layoutRevision: 1,
        stream: null,
      });
    });
    expect(container.querySelector('.remote-desktop-voice-trigger')).toBeNull();

    // Re-enable VoiceInput, disable inputEnabled -> button hidden.
    voiceMocks.available = true;
    act(() => {
      clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 3,
        inputEnabled: false,
        displays: [],
        layoutRevision: 1,
        stream: null,
      });
    });
    expect(container.querySelector('.remote-desktop-voice-trigger')).toBeNull();
  });

  it('opens VoiceOverlay on mic click, sends text via submitMobileTextAndEnter, and closes overlay', async () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrameId++;
      pendingFrames.set(id, cb);
      return id;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      pendingFrames.delete(id);
    });
    try {
      voiceMocks.available = true;
      const { container, getByRole } = await renderWithKeyboardOpen();
      act(() => {
        (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
      });

      expect(document.body.querySelector('.voice-overlay')).toBeNull();

      const trigger = getByRole('button', { name: 'voice.voice_input' });
      await act(async () => {
        fireEvent.click(trigger);
        await Promise.resolve();
      });

      expect(voiceMocks.primeVoiceGesture).toHaveBeenCalledWith({ deferAudioPause: false, projectKey: null });
      expect(document.body.querySelector('.voice-overlay')).not.toBeNull();
      expect(voiceMocks.startListening).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.remote-desktop-voice-pill')).toBeNull();

      // Deliver recognized transcript into VoiceOverlay and click Send.
      await act(async () => {
        voiceMocks.onResult?.('hello from voice overlay', true);
        await Promise.resolve();
      });

      const sendButton = document.body.querySelector('.voice-overlay-send') as HTMLButtonElement;
      expect(sendButton).not.toBeNull();
      expect(sendButton.disabled).toBe(false);

      pendingFrames.clear();
      await act(async () => {
        fireEvent.click(sendButton);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Unmounts overlay cleanly before sending on the next animation frame.
      expect(document.body.querySelector('.voice-overlay')).toBeNull();
      expect(text).not.toHaveBeenCalled();

      await act(async () => {
        for (const [id, cb] of [...pendingFrames.entries()]) {
          pendingFrames.delete(id);
          cb(0);
        }
      });

      expect(text).toHaveBeenCalledWith('hello from voice overlay');
    } finally {
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });

  it('closes VoiceOverlay when closing mobile keyboard, dropping inputEnabled, or unmounting', async () => {
    voiceMocks.available = true;
    const { getByRole, unmount } = await renderWithKeyboardOpen();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
    });

    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();

    act(() => {
      (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('.voice-overlay')).toBeNull();

    // Reopen keyboard + VoiceOverlay, then drop inputEnabled -> overlay closes cleanly.
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();

    act(() => {
      clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 4,
        inputEnabled: false,
        displays: [],
        layoutRevision: 1,
        stream: null,
      });
    });
    expect(document.body.querySelector('.voice-overlay')).toBeNull();

    // Re-enable inputEnabled, open VoiceOverlay, then unmount panel -> overlay unmounts cleanly.
    act(() => {
      clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 5,
        inputEnabled: true,
        displays: [],
        layoutRevision: 1,
        stream: null,
      });
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();

    unmount();
    expect(document.body.querySelector('.voice-overlay')).toBeNull();
  });

  it('resumes paused remote video stream when VoiceOverlay closes without touching active or detached streams', async () => {
    voiceMocks.available = true;
    const { container, getByRole, unmount } = await renderWithKeyboardOpen();
    const video = container.querySelector('video') as HTMLVideoElement;
    const playSpy = vi.fn(async () => {});
    Object.defineProperty(video, 'play', { configurable: true, value: playSpy });

    const stream = {} as MediaStream;
    act(() => {
      clientHooks[0]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 2,
        inputEnabled: true,
        displays: [],
        layoutRevision: 1,
        stream,
      });
    });

    act(() => {
      (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
    });

    // 1. Initial stream attach calls play(); VoiceOverlay open/close while playing does NOT call play() again.
    expect(playSpy).toHaveBeenCalledTimes(1);
    playSpy.mockClear();
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    await act(async () => {
      (document.body.querySelector('.voice-overlay-close') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(playSpy).not.toHaveBeenCalled();

    // 2. Video paused with active srcObject -> closing VoiceOverlay resumes play().
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    await act(async () => {
      (document.body.querySelector('.voice-overlay-close') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(playSpy).toHaveBeenCalledTimes(1);

    // 3. No srcObject -> closing VoiceOverlay does NOT call play().
    playSpy.mockClear();
    video.srcObject = null;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    await act(async () => {
      (document.body.querySelector('.voice-overlay-close') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(playSpy).not.toHaveBeenCalled();

    // 4. Unmounting while VoiceOverlay is open does NOT call play().
    video.srcObject = stream;
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'voice.voice_input' }));
      await Promise.resolve();
    });
    unmount();
    expect(playSpy).not.toHaveBeenCalled();
  });

  describe('browser_shortcut_hint suppression in PC App', () => {
    async function runSwallowedCommandChords({
      pcAppBridge,
      userAgent,
    }: {
      pcAppBridge?: { isElectron?: boolean };
      userAgent: string;
    }) {
      const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
      const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
      const originalRequestFullscreen = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen');
      const originalFullscreenEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');
      const pcAppWin = window as Window & { __IMCODES_PC_APP__?: unknown };
      const hadPcApp = Object.prototype.hasOwnProperty.call(pcAppWin, '__IMCODES_PC_APP__');
      const originalPcApp = pcAppWin.__IMCODES_PC_APP__;

      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: vi.fn(async () => {}),
      });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
      if (pcAppBridge !== undefined) {
        pcAppWin.__IMCODES_PC_APP__ = pcAppBridge;
      } else {
        delete pcAppWin.__IMCODES_PC_APP__;
      }

      try {
        const rendered = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
        for (let i = 0; i < 2; i += 1) {
          act(() => {
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              code: 'MetaLeft',
              key: 'Meta',
              metaKey: true,
            }));
          });
          act(() => {
            rendered.stage.dispatchEvent(new KeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              code: 'MetaLeft',
              key: 'Meta',
            }));
          });
        }
        return rendered.container.querySelector('.remote-desktop-control-notice')?.textContent ?? null;
      } finally {
        if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform);
        else delete (navigator as { platform?: string }).platform;
        if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
        else delete (navigator as { userAgent?: string }).userAgent;
        if (originalRequestFullscreen) Object.defineProperty(Element.prototype, 'requestFullscreen', originalRequestFullscreen);
        else delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
        if (originalFullscreenEnabled) Object.defineProperty(document, 'fullscreenEnabled', originalFullscreenEnabled);
        else delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
        if (hadPcApp) pcAppWin.__IMCODES_PC_APP__ = originalPcApp;
        else delete pcAppWin.__IMCODES_PC_APP__;
      }
    }

    it('suppresses browser_shortcut_hint when running inside PC App bridge', async () => {
      const notice = await runSwallowedCommandChords({
        pcAppBridge: { isElectron: true },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      });
      expect(notice).toBeNull();
    });

    it('suppresses browser_shortcut_hint in Electron popout User-Agent without __IMCODES_PC_APP__', async () => {
      const notice = await runSwallowedCommandChords({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/33.0.0 Chrome/130.0.0.0 Safari/537.36',
      });
      expect(notice).toBeNull();
    });

    it('still shows browser_shortcut_hint in regular web browsers outside fullscreen', async () => {
      const notice = await runSwallowedCommandChords({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      });
      expect(notice).toBe('remote_desktop.browser_shortcut_hint');
    });
  });

  describe('global tri-state modifier bar', () => {
    it('renders CTRL ALT SHIFT CMD/WIN without combo_mode toggle across all keyboard pages and handles oneshot/locked canvas clicks', async () => {
      const macRendered = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
      act(() => { (macRendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
      act(() => { (macRendered.getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });

      const macBar = macRendered.container.querySelector('.remote-desktop-combo-bar') as HTMLElement;
      expect(macBar).toBeTruthy();
      expect(macBar.querySelector('.remote-desktop-combo-toggle')).toBeNull();
      expect(macBar.querySelector('.remote-desktop-combo-spacer')).toBeTruthy();
      const macButtons = Array.from(macBar.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'));
      expect(macButtons.map((b) => b.textContent)).toEqual(['CTRL', 'ALT', 'SHIFT', 'CMD']);

      // Stays visible across Page 0, Page 1 (default), and Page 2 dots
      const dots = Array.from(macRendered.container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-dots button'));
      expect(dots).toHaveLength(3);
      for (const dot of dots) {
        act(() => { dot.click(); });
        expect(macBar.querySelectorAll('.remote-desktop-combo-modifiers button')).toHaveLength(4);
      }

      const macCmd = Array.from(macBar.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'))
        .find((b) => b.textContent === 'CMD')!;

      // 1st tap CMD = oneshot: reconciles meta=true and auto-releases after synthetic click
      act(() => { macCmd.click(); });
      expect(macCmd.getAttribute('data-modifier-state')).toBe('oneshot');
      reconcileModifiers.mockClear();
      act(() => {
        pointer(macRendered.stage, 'pointerdown', { pointerId: 102, clientX: 200, clientY: 150 });
        pointer(macRendered.stage, 'pointerup', { pointerId: 102, clientX: 200, clientY: 150 });
      });
      expect(reconcileModifiers).toHaveBeenCalledWith({
        control: false,
        alt: false,
        shift: false,
        meta: true,
      }, undefined);
      expect(macCmd.getAttribute('aria-pressed')).toBe('false');
      expect(macCmd.classList.contains('is-held')).toBe(false);

      // 2nd tap CMD = locked: stays locked across multiple synthetic clicks until 3rd tap releases
      act(() => { macCmd.click(); });
      act(() => { macCmd.click(); });
      expect(macCmd.getAttribute('data-modifier-state')).toBe('locked');
      expect(macCmd.classList.contains('is-held')).toBe(true);
      expect(macCmd.classList.contains('is-locked')).toBe(true);
      for (const pointerId of [103, 104]) {
        reconcileModifiers.mockClear();
        act(() => {
          pointer(macRendered.stage, 'pointerdown', { pointerId, clientX: 200, clientY: 150 });
          pointer(macRendered.stage, 'pointerup', { pointerId, clientX: 200, clientY: 150 });
        });
        expect(reconcileModifiers).toHaveBeenCalledWith({
          control: false,
          alt: false,
          shift: false,
          meta: true,
        }, undefined);
        expect(macCmd.getAttribute('data-modifier-state')).toBe('locked');
      }
      macRendered.unmount();

      for (const caps of [
        [...LINUX_TARGET_CAPABILITIES],
        [REMOTE_DESKTOP_SESSION_CAPABILITY, REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS, REMOTE_DESKTOP_ENCODER_CAPABILITY.H264, REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY],
        undefined,
      ]) {
        const rendered = await renderPanel(undefined, caps ? [...caps] : undefined);
        act(() => { (rendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
        act(() => { (rendered.getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
        const buttons = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'));
        expect(buttons.map((b) => b.textContent)).toEqual(['CTRL', 'ALT', 'SHIFT', 'WIN']);
        rendered.unmount();
      }
    });

    it('cycles shared global and Page 0 modifiers through oneshot -> locked -> off, handles mixed/shifted chords, and cleans up on tab switch, close, and inputEnabled=false', async () => {
      const { container, getByRole, unmount } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
      const cssSource = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
        'utf8',
      );
      expect(cssSource).toMatch(/\.remote-desktop-combo-bar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
      expect(cssSource).toMatch(/\.remote-desktop-combo-spacer\s*\{[^}]*flex:\s*1 1 0;/);
      expect(cssSource).toMatch(
        /\.remote-desktop-combo-modifiers\s*\{[^}]*justify-content:\s*flex-end;[^}]*flex:\s*1 1 calc\(var\(--rd-kb-close-w[^)]*\)\s*\+\s*var\(--rd-kb-head-gap[^)]*\)\);/,
      );
      expect(cssSource).toMatch(/--rd-kb-close-w:\s*30px;/);
      expect(cssSource).toMatch(/--rd-kb-head-gap:\s*8px;/);
      expect(cssSource).toMatch(/--rd-kb-tab-gap:\s*6px;/);
      expect(cssSource).toMatch(/--rd-kb-center-w:\s*40px;/);
      expect(cssSource).toContain('.remote-desktop-combo-modifiers button.is-locked');
      expect(cssSource).toContain('.remote-desktop-computer-keyboard-row button.is-locked');
      expect(cssSource).not.toContain('.remote-desktop-combo-toggle');

      act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
      act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
      expect(container.querySelector('.remote-desktop-combo-toggle')).toBeNull();

      const globalBtn = (label: string) => Array.from(
        container.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'),
      ).find((b) => b.textContent === label)!;
      const pageKeyBtn = (label: string) => Array.from(
        container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-row button'),
      ).find((b) => b.textContent === label)!;

      // 1. 3-state cycle shared between global WIN and Page 0 Win
      key.mockClear();
      act(() => { globalBtn('WIN').click(); });
      expect(key.mock.calls).toEqual([
        ['MetaLeft', 'Meta', true, false, { control: false, alt: false }],
      ]);
      expect(globalBtn('WIN').getAttribute('aria-pressed')).toBe('true');
      expect(globalBtn('WIN').getAttribute('data-modifier-state')).toBe('oneshot');
      expect(globalBtn('WIN').classList.contains('is-held')).toBe(true);
      expect(globalBtn('WIN').classList.contains('is-locked')).toBe(false);
      expect(pageKeyBtn('Win').getAttribute('data-modifier-state')).toBe('oneshot');

      key.mockClear();
      act(() => { globalBtn('WIN').click(); });
      expect(key).not.toHaveBeenCalled();
      expect(globalBtn('WIN').getAttribute('aria-pressed')).toBe('true');
      expect(globalBtn('WIN').getAttribute('data-modifier-state')).toBe('locked');
      expect(globalBtn('WIN').classList.contains('is-held')).toBe(true);
      expect(globalBtn('WIN').classList.contains('is-locked')).toBe(true);
      expect(pageKeyBtn('Win').classList.contains('is-locked')).toBe(true);

      key.mockClear();
      act(() => { pageKeyBtn('Win').click(); });
      expect(key.mock.calls).toEqual([
        ['MetaLeft', 'Meta', false, false, { control: false, alt: false }],
      ]);
      expect(globalBtn('WIN').getAttribute('aria-pressed')).toBe('false');
      expect(globalBtn('WIN').getAttribute('data-modifier-state')).toBeNull();
      expect(globalBtn('WIN').classList.contains('is-held')).toBe(false);
      expect(globalBtn('WIN').classList.contains('is-locked')).toBe(false);
      expect(pageKeyBtn('Win').getAttribute('aria-pressed')).toBe('false');

      // 2. One-shot consumption: 1st tap CTRL + tap c -> Ctrl+c then auto-release; next v -> plain v
      key.mockClear();
      act(() => { globalBtn('CTRL').click(); });
      act(() => { pageKeyBtn('c').click(); });
      expect(key.mock.calls).toEqual([
        ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
        ['KeyC', 'c', true, false, { control: true, alt: false }],
        ['KeyC', 'c', false, false, { control: true, alt: false }],
        ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
      ]);
      expect(globalBtn('CTRL').getAttribute('aria-pressed')).toBe('false');
      key.mockClear();
      act(() => { pageKeyBtn('v').click(); });
      expect(key.mock.calls).toEqual([
        ['KeyV', 'v', true, false, { control: false, alt: false }],
        ['KeyV', 'v', false, false, { control: false, alt: false }],
      ]);

      // 3. Locked persistence: 2nd tap CTRL + tap c + tap v -> both send with control=true, CTRL stays locked until 3rd tap
      key.mockClear();
      act(() => { globalBtn('CTRL').click(); });
      act(() => { globalBtn('CTRL').click(); });
      act(() => { pageKeyBtn('c').click(); });
      act(() => { pageKeyBtn('v').click(); });
      expect(globalBtn('CTRL').getAttribute('data-modifier-state')).toBe('locked');
      expect(key.mock.calls).toEqual([
        ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
        ['KeyC', 'c', true, false, { control: true, alt: false }],
        ['KeyC', 'c', false, false, { control: true, alt: false }],
        ['KeyV', 'v', true, false, { control: true, alt: false }],
        ['KeyV', 'v', false, false, { control: true, alt: false }],
      ]);

      // 4. Mixed locked + oneshot: CTRL locked + SHIFT oneshot + tap z -> releases ONLY SHIFT, keeps CTRL locked
      key.mockClear();
      act(() => { globalBtn('SHIFT').click(); });
      act(() => { pageKeyBtn('z').click(); });
      expect(key.mock.calls).toEqual([
        ['ShiftLeft', 'Shift', true, false, { control: true, alt: false }],
        ['KeyZ', 'z', true, false, { control: true, alt: false }],
        ['KeyZ', 'z', false, false, { control: true, alt: false }],
        ['ShiftLeft', 'Shift', false, false, { control: true, alt: false }],
      ]);
      expect(globalBtn('SHIFT').getAttribute('aria-pressed')).toBe('false');
      expect(globalBtn('CTRL').getAttribute('data-modifier-state')).toBe('locked');
      act(() => { globalBtn('CTRL').click(); }); // 3rd tap releases CTRL
      expect(globalBtn('CTRL').getAttribute('aria-pressed')).toBe('false');

      // 5. Shifted key while SHIFT is locked: must NOT emit duplicate ShiftLeft keyDown or premature ShiftLeft keyUp
      key.mockClear();
      act(() => { globalBtn('SHIFT').click(); });
      act(() => { globalBtn('SHIFT').click(); });
      act(() => { pageKeyBtn('⇧').click(); });
      act(() => { pageKeyBtn('Q').click(); });
      expect(key.mock.calls).toEqual([
        ['ShiftLeft', 'Shift', true, false, { control: false, alt: false }],
        ['KeyQ', 'Q', true, false, { control: false, alt: false, shift: true }],
        ['KeyQ', 'Q', false, false, { control: false, alt: false, shift: true }],
      ]);
      expect(globalBtn('SHIFT').getAttribute('data-modifier-state')).toBe('locked');

      // 6. Safety cleanup: switching to IME releases locked modifiers
      key.mockClear();
      act(() => {
        (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_ime' }) as HTMLButtonElement).click();
      });
      expect(key).toHaveBeenCalledWith('ShiftLeft', 'Shift', false, false, { control: false, alt: false });
      expect(globalBtn('SHIFT')).toBeUndefined();

      // Switch back to keys, lock ALT, close mobile keyboard -> releases ALT
      act(() => {
        (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click();
      });
      act(() => { globalBtn('ALT').click(); });
      act(() => { globalBtn('ALT').click(); });
      expect(globalBtn('ALT').getAttribute('data-modifier-state')).toBe('locked');
      key.mockClear();
      act(() => {
        (getByRole('button', { name: 'remote_desktop.close_mobile_keyboard' }) as HTMLButtonElement).click();
      });
      expect(key).toHaveBeenCalledWith('AltLeft', 'Alt', false, false, { control: false, alt: false });

      // Reopen keyboard, mix locked CTRL + oneshot ALT, then inputEnabled flips false -> releases both and disables buttons
      act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
      act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });
      act(() => { globalBtn('CTRL').click(); });
      act(() => { globalBtn('CTRL').click(); });
      act(() => { globalBtn('ALT').click(); });
      key.mockClear();
      act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
        inputEpoch: 2,
        inputEnabled: false,
        route: 'direct',
        displays: [],
        layoutRevision: 1,
        stream: null,
        durationMs: 0,
        reconnectCount: 0,
      }));
      expect(key.mock.calls).toEqual([
        ['AltLeft', 'Alt', false, false, { control: true, alt: false }],
        ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
      ]);
      const disabledButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'),
      );
      expect(disabledButtons).toHaveLength(4);
      expect(disabledButtons.every((b) => b.disabled)).toBe(true);
      expect(disabledButtons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
      key.mockClear();
      act(() => { disabledButtons[0]?.click(); });
      expect(key).not.toHaveBeenCalled();
      unmount();
    });

    it('reuses MobileDpad inside centered combo bar spacer layout, supports oneshot release and locked persistence across repeats, and respects inputEnabled', async () => {
      const { container, getByRole, unmount } = await renderPanel(undefined, [...LINUX_TARGET_CAPABILITIES]);
      act(() => { (getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click(); });
      act(() => { (getByRole('tab', { name: 'remote_desktop.mobile_keyboard_tab_keys' }) as HTMLButtonElement).click(); });

      const comboBar = container.querySelector('.remote-desktop-combo-bar')!;
      const children = Array.from(comboBar.children);
      expect(children.map((el) => el.classList.contains('remote-desktop-combo-spacer')
        ? 'spacer'
        : el.classList.contains('remote-desktop-combo-dpad')
          ? 'dpad'
          : el.classList.contains('remote-desktop-combo-modifiers')
            ? 'modifiers'
            : 'other')).toEqual(['spacer', 'dpad', 'modifiers']);

      const dpad = comboBar.querySelector<HTMLElement>('.remote-desktop-combo-dpad')!;
      expect(dpad.classList.contains('shortcut-dpad')).toBe(true);
      expect(dpad.querySelectorAll('.dpad-arrow')).toHaveLength(4);

      // Drag inside deadzone (< 8px) does not fire any arrow key
      key.mockClear();
      act(() => {
        pointer(dpad, 'pointerdown', { pointerId: 10, clientX: 100, clientY: 100 });
        pointer(dpad, 'pointermove', { pointerId: 10, clientX: 103, clientY: 104 });
        pointer(dpad, 'pointerup', { pointerId: 10, clientX: 103, clientY: 104 });
      });
      expect(key).not.toHaveBeenCalled();

      // Dragging up/down/left/right dispatches ArrowUp/ArrowDown/ArrowLeft/ArrowRight
      const cases: Array<[number, number, string]> = [
        [0, -25, 'ArrowUp'],
        [0, 25, 'ArrowDown'],
        [-25, 0, 'ArrowLeft'],
        [25, 0, 'ArrowRight'],
      ];
      for (const [dx, dy, expectedCode] of cases) {
        key.mockClear();
        act(() => {
          pointer(dpad, 'pointerdown', { pointerId: 11, clientX: 100, clientY: 100 });
          pointer(dpad, 'pointermove', { pointerId: 11, clientX: 100 + dx, clientY: 100 + dy });
          pointer(dpad, 'pointerup', { pointerId: 11, clientX: 100 + dx, clientY: 100 + dy });
        });
        expect(key.mock.calls).toEqual([
          [expectedCode, expectedCode, true, false, { control: false, alt: false }],
          [expectedCode, expectedCode, false, false, { control: false, alt: false }],
        ]);
      }

      // Stays visible across all 3 computer keyboard pages
      const pageDots = Array.from(container.querySelectorAll<HTMLButtonElement>('.remote-desktop-computer-keyboard-dots button'));
      expect(pageDots).toHaveLength(3);
      for (const dot of pageDots) {
        act(() => { dot.click(); });
        expect(container.querySelector('.remote-desktop-combo-bar .remote-desktop-combo-dpad')).toBeTruthy();
      }

      const modBtn = (label: string) => Array.from(
        container.querySelectorAll<HTMLButtonElement>('.remote-desktop-combo-modifiers button'),
      ).find((b) => b.textContent === label)!;

      vi.useFakeTimers();
      try {
        // Oneshot CTRL + drag left -> sends Ctrl+ArrowLeft and releases CTRL; auto-repeat sends plain ArrowLeft
        act(() => { modBtn('CTRL').click(); });
        expect(modBtn('CTRL').getAttribute('data-modifier-state')).toBe('oneshot');

        key.mockClear();
        act(() => {
          pointer(dpad, 'pointerdown', { pointerId: 12, clientX: 100, clientY: 100 });
          pointer(dpad, 'pointermove', { pointerId: 12, clientX: 70, clientY: 100 });
        });
        expect(key.mock.calls).toEqual([
          ['ArrowLeft', 'ArrowLeft', true, false, { control: true, alt: false }],
          ['ArrowLeft', 'ArrowLeft', false, false, { control: true, alt: false }],
          ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
        ]);
        expect(modBtn('CTRL').classList.contains('is-held')).toBe(false);

        key.mockClear();
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(key.mock.calls).toEqual([
          ['ArrowLeft', 'ArrowLeft', true, false, { control: false, alt: false }],
          ['ArrowLeft', 'ArrowLeft', false, false, { control: false, alt: false }],
        ]);
        act(() => {
          pointer(dpad, 'pointerup', { pointerId: 12, clientX: 70, clientY: 100 });
        });

        // Locked SHIFT + drag right + auto-repeat -> keeps SHIFT locked on BOTH initial arrow and repeat
        act(() => { modBtn('SHIFT').click(); });
        act(() => { modBtn('SHIFT').click(); });
        expect(modBtn('SHIFT').getAttribute('data-modifier-state')).toBe('locked');

        key.mockClear();
        act(() => {
          pointer(dpad, 'pointerdown', { pointerId: 13, clientX: 100, clientY: 100 });
          pointer(dpad, 'pointermove', { pointerId: 13, clientX: 130, clientY: 100 });
        });
        expect(key.mock.calls).toEqual([
          ['ArrowRight', 'ArrowRight', true, false, { control: false, alt: false }],
          ['ArrowRight', 'ArrowRight', false, false, { control: false, alt: false }],
        ]);
        expect(modBtn('SHIFT').getAttribute('data-modifier-state')).toBe('locked');

        key.mockClear();
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(key.mock.calls).toEqual([
          ['ArrowRight', 'ArrowRight', true, false, { control: false, alt: false }],
          ['ArrowRight', 'ArrowRight', false, false, { control: false, alt: false }],
        ]);
        expect(modBtn('SHIFT').getAttribute('data-modifier-state')).toBe('locked');

        // inputEnabled flipping false mid-hold stops auto-repeat, disables D-pad, and releases locked SHIFT
        key.mockClear();
        act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
          inputEpoch: 3,
          inputEnabled: false,
          route: 'direct',
          displays: [],
          layoutRevision: 1,
          stream: null,
          durationMs: 0,
          reconnectCount: 0,
        }));
        expect(key).toHaveBeenCalledWith('ShiftLeft', 'Shift', false, false, { control: false, alt: false });
        expect(modBtn('SHIFT').classList.contains('is-locked')).toBe(false);
        expect(dpad.getAttribute('data-disabled')).toBe('true');
        key.mockClear();
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(key).not.toHaveBeenCalled();

        act(() => {
          pointer(dpad, 'pointerup', { pointerId: 13, clientX: 130, clientY: 100 });
          pointer(dpad, 'pointerdown', { pointerId: 14, clientX: 100, clientY: 100 });
          pointer(dpad, 'pointermove', { pointerId: 14, clientX: 130, clientY: 100 });
          pointer(dpad, 'pointerup', { pointerId: 14, clientX: 130, clientY: 100 });
        });
        expect(key).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }

      unmount();
    });

    it('strictly aligns .remote-desktop-combo-dpad with .remote-desktop-voice-trigger horizontally across viewports and UI scales in real Chromium without modifier button intrusion', { timeout: 45000 }, async () => {
      const cssSource = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
        'utf8',
      );
      // CSS contract guards:
      expect(cssSource).toMatch(/--rd-kb-close-w:\s*30px;/);
      expect(cssSource).toMatch(/--rd-kb-head-gap:\s*8px;/);
      expect(cssSource).toMatch(/--rd-kb-tab-gap:\s*6px;/);
      expect(cssSource).toMatch(/--rd-kb-center-w:\s*40px;/);
      expect(cssSource).toMatch(/\.remote-desktop-mobile-keyboard-tabs button\s*\{[^}]*flex:\s*1 1 0;/);
      expect(cssSource).toMatch(/\.remote-desktop-voice-trigger\s*\{[^}]*flex:\s*0 0 var\(--rd-kb-center-w/);
      expect(cssSource).toMatch(/\.remote-desktop-combo-bar \.remote-desktop-combo-dpad\s*\{[^}]*flex:\s*0 0 var\(--rd-kb-center-w/);
      expect(cssSource).toMatch(/container-type:\s*inline-size;/);
      expect(cssSource).toMatch(/@container\s*\(max-width:\s*180px\)/);
      expect(cssSource).toMatch(/@container\s*\(max-width:\s*145px\)/);
      expect(cssSource).toMatch(/@container\s*\(max-width:\s*115px\)/);

      // Real Chromium Playwright geometry verification:
      const { existsSync } = await import('node:fs');
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const { chromium } = req('playwright') as typeof import('playwright');
      const chromeApp = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const execPath = existsSync(chromium.executablePath())
        ? chromium.executablePath()
        : existsSync(chromeApp)
          ? chromeApp
          : null;
      if (!execPath) {
        return;
      }

      const browser = await chromium.launch({ executablePath: execPath, headless: true });
      try {
        const page = await browser.newPage();

        const runSuite = async (html: string) => {
          await page.setContent(html);
          for (const width of [360, 390, 430, 768]) {
            for (const zoom of [1.0, 1.25, 1.5]) {
              await page.setViewportSize({ width, height: 800 });
              await page.evaluate((z) => {
                document.documentElement.style.zoom = String(z);
              }, zoom);
              const res = await page.evaluate(() => {
                const voice = document.querySelector('.remote-desktop-voice-trigger')?.getBoundingClientRect();
                const dpad = document.querySelector('.remote-desktop-combo-dpad')?.getBoundingClientRect();
                const mod = document.querySelector('.remote-desktop-combo-modifiers')!.getBoundingClientRect();
                const buttons = Array.from(document.querySelectorAll('.remote-desktop-combo-modifiers button')).map((b) => b.getBoundingClientRect());

                let overlap = false;
                for (let i = 0; i < buttons.length - 1; i++) {
                  if (buttons[i].right > buttons[i + 1].left + 0.5) {
                    overlap = true;
                  }
                }
                const firstBtn = buttons[0];
                const lastBtn = buttons[buttons.length - 1];
                const insideContainer = firstBtn.left >= mod.left - 0.5 && lastBtn.right <= mod.right + 0.5;
                const clearOfDpad = dpad ? firstBtn.left >= dpad.right - 0.5 : true;
                const alignRight = Math.abs(lastBtn.right - mod.right) <= 0.5;
                const voiceDpadLeftAligned = (voice && dpad) ? Math.abs(voice.left - dpad.left) <= 0.5 : true;
                const voiceDpadRightAligned = (voice && dpad) ? Math.abs(voice.right - dpad.right) <= 0.5 : true;
                const voiceDpadWidthAligned = (voice && dpad) ? Math.abs(voice.width - dpad.width) <= 0.5 : true;

                return {
                  overlap,
                  insideContainer,
                  clearOfDpad,
                  alignRight,
                  voiceDpadLeftAligned,
                  voiceDpadRightAligned,
                  voiceDpadWidthAligned,
                  modTop: mod.top,
                  dpadTop: dpad?.top,
                };
              });

              expect(res.overlap).toBe(false);
              expect(res.insideContainer).toBe(true);
              expect(res.clearOfDpad).toBe(true);
              expect(res.alignRight).toBe(true);
              expect(res.voiceDpadLeftAligned).toBe(true);
              expect(res.voiceDpadRightAligned).toBe(true);
              expect(res.voiceDpadWidthAligned).toBe(true);
              if (res.dpadTop !== undefined) {
                expect(res.modTop).toBeLessThanOrEqual(res.dpadTop + 5);
              }
            }
          }
        };

        // 1. Standard Win modifiers (CTRL ALT SHIFT WIN)
        await runSuite(`<!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            ${cssSource}
          </style>
        </head>
        <body>
          <div class="remote-desktop-mobile-keyboard">
            <div class="remote-desktop-mobile-keyboard-head">
              <div class="remote-desktop-mobile-keyboard-tabs" role="tablist">
                <button type="button" role="tab" class="is-active">输入法</button>
                <button type="button" class="remote-desktop-voice-trigger">🎤</button>
                <button type="button" role="tab">电脑键盘</button>
              </div>
              <button type="button">×</button>
            </div>
            <div class="remote-desktop-computer-keyboard">
              <div class="remote-desktop-combo-bar">
                <div class="remote-desktop-combo-spacer"></div>
                <div class="remote-desktop-combo-dpad shortcut-dpad">
                  <span class="dpad-arrow dpad-arrow-up">▲</span>
                  <span class="dpad-arrow dpad-arrow-down">▼</span>
                  <span class="dpad-arrow dpad-arrow-left">◀</span>
                  <span class="dpad-arrow dpad-arrow-right">▶</span>
                </div>
                <div class="remote-desktop-combo-modifiers">
                  <button type="button">CTRL</button>
                  <button type="button">ALT</button>
                  <button type="button">SHIFT</button>
                  <button type="button">WIN</button>
                </div>
              </div>
            </div>
          </div>
        </body>
        </html>`);

        // 2. macOS modifier symbols (⌃ ⌥ ⇧ ⌘)
        await runSuite(`<!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            ${cssSource}
          </style>
        </head>
        <body>
          <div class="remote-desktop-mobile-keyboard">
            <div class="remote-desktop-mobile-keyboard-head">
              <div class="remote-desktop-mobile-keyboard-tabs" role="tablist">
                <button type="button" role="tab" class="is-active">IME</button>
                <button type="button" class="remote-desktop-voice-trigger">🎤</button>
                <button type="button" role="tab">Keys</button>
              </div>
              <button type="button">×</button>
            </div>
            <div class="remote-desktop-computer-keyboard">
              <div class="remote-desktop-combo-bar">
                <div class="remote-desktop-combo-spacer"></div>
                <div class="remote-desktop-combo-dpad shortcut-dpad"></div>
                <div class="remote-desktop-combo-modifiers">
                  <button type="button">⌃</button>
                  <button type="button">⌥</button>
                  <button type="button">⇧</button>
                  <button type="button">⌘</button>
                </div>
              </div>
            </div>
          </div>
        </body>
        </html>`);

        // 3. No voice button (voiceAvailable === false)
        await runSuite(`<!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            ${cssSource}
          </style>
        </head>
        <body>
          <div class="remote-desktop-mobile-keyboard">
            <div class="remote-desktop-mobile-keyboard-head">
              <div class="remote-desktop-mobile-keyboard-tabs" role="tablist">
                <button type="button" role="tab">输入法</button>
                <button type="button" role="tab" class="is-active">电脑键盘</button>
              </div>
              <button type="button">×</button>
            </div>
            <div class="remote-desktop-computer-keyboard">
              <div class="remote-desktop-combo-bar">
                <div class="remote-desktop-combo-spacer"></div>
                <div class="remote-desktop-combo-dpad shortcut-dpad"></div>
                <div class="remote-desktop-combo-modifiers">
                  <button type="button">CTRL</button>
                  <button type="button">ALT</button>
                  <button type="button">SHIFT</button>
                  <button type="button">WIN</button>
                </div>
              </div>
            </div>
          </div>
        </body>
        </html>`);

        // 4. Asymmetric long tab labels across locales
        await runSuite(`<!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            ${cssSource}
          </style>
        </head>
        <body>
          <div class="remote-desktop-mobile-keyboard">
            <div class="remote-desktop-mobile-keyboard-head">
              <div class="remote-desktop-mobile-keyboard-tabs" role="tablist">
                <button type="button" role="tab">Long System Input Method Name</button>
                <button type="button" class="remote-desktop-voice-trigger">🎤</button>
                <button type="button" role="tab" class="is-active">Keys</button>
              </div>
              <button type="button">×</button>
            </div>
            <div class="remote-desktop-computer-keyboard">
              <div class="remote-desktop-combo-bar">
                <div class="remote-desktop-combo-spacer"></div>
                <div class="remote-desktop-combo-dpad shortcut-dpad"></div>
                <div class="remote-desktop-combo-modifiers">
                  <button type="button">CTRL</button>
                  <button type="button">ALT</button>
                  <button type="button">SHIFT</button>
                  <button type="button">WIN</button>
                </div>
              </div>
            </div>
          </div>
        </body>
        </html>`);
      } finally {
        await browser.close();
      }
    });
  });

  describe('controlRejection alert banner', () => {
    it('suppresses the notice for quality_unavailable while displaying and auto-dismissing other rejections', async () => {
      const rendered = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES]);
      const baseSnapshot = {
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: true,
        route: 'direct',
        displays: [],
        layoutRevision: 1,
        stream: null,
        durationMs: 0,
        reconnectCount: 0,
      };

      act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
        ...baseSnapshot,
        controlRejection: { id: 1, reason: REMOTE_DESKTOP_CONTROL_REJECTION.QUALITY_UNAVAILABLE },
      }));
      expect(rendered.container.querySelector('.remote-desktop-control-notice')).toBeNull();

      vi.useFakeTimers();
      try {
        act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
          ...baseSnapshot,
          controlRejection: { id: 2, reason: REMOTE_DESKTOP_CONTROL_REJECTION.MODE_CHANGE_FAILED },
        }));
        const notice = rendered.container.querySelector('.remote-desktop-control-notice');
        expect(notice?.textContent).toBe('remote_desktop.control_rejected.mode_change_failed');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(rendered.container.querySelector('.remote-desktop-control-notice')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
      rendered.unmount();
    });
  });

  describe('menu bar hide and show toggle', () => {
    it('hides toolbar and shows non-leaking floating restore pill in standalone non-embedded panel', async () => {
      const rendered = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES], { standalone: true });
      act(() => clientHooks[clientHooks.length - 1]!.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: true,
        route: 'direct',
        displays: [],
        layoutRevision: 1,
        stream: null,
        durationMs: 0,
        reconnectCount: 0,
      }));

      const panel = rendered.container.querySelector('.remote-desktop-panel') as HTMLElement;
      const toolbarShell = rendered.container.querySelector('.remote-desktop-toolbar-shell') as HTMLElement;
      const hideBtn = rendered.container.querySelector('.remote-desktop-menubar-toggle') as HTMLButtonElement;
      expect(hideBtn).toBeTruthy();
      expect(hideBtn.getAttribute('aria-label')).toBe('remote_desktop.hide_menubar');
      expect(toolbarShell.hidden).toBe(false);
      expect(rendered.container.querySelector('.remote-desktop-menubar-restore')).toBeNull();

      // Open quality popover before hiding; hiding the menu bar must close it cleanly.
      fireEvent.click(rendered.container.querySelector('.remote-desktop-quality-trigger')!);
      expect(document.body.querySelector('.remote-desktop-quality-popover')).toBeTruthy();

      fireEvent.click(hideBtn);

      expect(panel.classList.contains('is-menubar-hidden')).toBe(true);
      expect(toolbarShell.hidden).toBe(true);
      expect(document.body.querySelector('.remote-desktop-quality-popover')).toBeNull();

      const restoreBtn = rendered.container.querySelector('.remote-desktop-menubar-restore') as HTMLButtonElement;
      expect(restoreBtn).toBeTruthy();
      expect(restoreBtn.getAttribute('aria-label')).toBe('remote_desktop.show_menubar');
      expect(restoreBtn.classList.contains('remote-desktop-file-window')).toBe(true);
      expect(restoreBtn.closest('.remote-desktop-stage')).toBeNull();

      pointerMove.mockClear();
      pointerButton.mockClear();
      pointerClick.mockClear();

      // Hovering/clicking the floating restore pill must never forward pointer input to remote machine
      mousePointer(restoreBtn, 'pointerdown', { pointerId: 1, clientX: 200, clientY: 10 });
      nativeMouseMove(restoreBtn, { clientX: 200, clientY: 10 });
      mousePointer(restoreBtn, 'pointerup', { pointerId: 1, clientX: 200, clientY: 10 });
      fireEvent.click(restoreBtn);

      expect(pointerMove).not.toHaveBeenCalled();
      expect(pointerButton).not.toHaveBeenCalled();
      expect(pointerClick).not.toHaveBeenCalled();
      expect(panel.classList.contains('is-menubar-hidden')).toBe(false);
      expect(toolbarShell.hidden).toBe(false);
      expect(rendered.container.querySelector('.remote-desktop-menubar-restore')).toBeNull();

      rendered.unmount();
    });

    it('hides embedded toolbar when controlled menuBarHidden is true without rendering a duplicate restore pill', async () => {
      const rendered = await renderPanel(undefined, [...MAC_TARGET_CAPABILITIES], {
        embedded: true,
        menuBarHidden: true,
        onShowMenuBar: vi.fn(),
      });

      const panel = rendered.container.querySelector('.remote-desktop-panel') as HTMLElement;
      const toolbarShell = rendered.container.querySelector('.remote-desktop-toolbar-shell') as HTMLElement;
      expect(panel.classList.contains('is-menubar-hidden')).toBe(true);
      expect(toolbarShell.hidden).toBe(true);
      expect(rendered.container.querySelector('.remote-desktop-menubar-toggle')).toBeNull();
      expect(rendered.container.querySelector('.remote-desktop-menubar-restore')).toBeNull();

      rendered.unmount();
    });
  });

  describe('CSS uiScale coordinate alignment across Chrome and WebKit zoom regimes', () => {
    it.each([
      { regime: 'chrome' as const, pct: 80 },
      { regime: 'chrome' as const, pct: 125 },
      { regime: 'webkit' as const, pct: 125 },
      { regime: 'webkit' as const, pct: 150 },
    ])('aligns desktop mouse, wheel, touch tap, long-press, virtual mouse, and popovers at $regime $pct%', async ({ regime, pct }) => {
      const z = applyUiScale(pct);
      const origRootRect = document.documentElement.getBoundingClientRect;
      const origInnerW = window.innerWidth;
      const origInnerH = window.innerHeight;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      const rootW = regime === 'chrome' ? 1280 : 1280 / z;
      const rootH = regime === 'chrome' ? 800 : 800 / z;
      document.documentElement.getBoundingClientRect = () => ({
        x: 0, y: 0, left: 0, top: 0, right: rootW, bottom: rootH, width: rootW, height: rootH, toJSON: () => ({}),
      });

      const rectScale = regime === 'chrome' ? z : 1;
      const rendered = await renderPanel();
      try {
        const makeBoxRect = (l: number, t: number, w: number, h: number): DOMRect => ({
          x: l * rectScale,
          y: t * rectScale,
          left: l * rectScale,
          top: t * rectScale,
          right: (l + w) * rectScale,
          bottom: (t + h) * rectScale,
          width: w * rectScale,
          height: h * rectScale,
          toJSON: () => ({}),
        } as DOMRect);

        // Stage sits at pre-zoom CSS (100, 80), size 400x300; 16:9 (1920x1080) video fits to 400x225 at CSS top = 80 + 37.5 = 117.5.
        rendered.stage.getBoundingClientRect = () => makeBoxRect(100, 80, 400, 300);
        rendered.video.getBoundingClientRect = () => makeBoxRect(100, 80, 400, 300);

        // 1. Desktop mouse move, click, and wheel at CSS (400, 230) -> normalized (0.75, 0.5).
        // Viewport client coords are multiplied by z in BOTH Chrome and WebKit!
        const rightHalfClientX = 400 * z;
        const centerClientY = 230 * z;
        pointerMove.mockClear();
        pointerButton.mockClear();
        wheel.mockClear();
        act(() => {
          mousePointer(rendered.stage, 'pointermove', { pointerId: 1, clientX: rightHalfClientX, clientY: centerClientY });
          mousePointer(rendered.stage, 'pointerdown', { pointerId: 1, clientX: rightHalfClientX, clientY: centerClientY, button: 0 });
          mousePointer(rendered.stage, 'pointerup', { pointerId: 1, clientX: rightHalfClientX, clientY: centerClientY, button: 0 });
          rendered.stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rightHalfClientX, clientY: centerClientY, deltaY: 120 }));
        });
        expect(pointerMove).toHaveBeenCalled();
        const moveCall = pointerMove.mock.calls[pointerMove.mock.calls.length - 1]!;
        expect(moveCall[0]).toBeCloseTo(0.75, 2);
        expect(moveCall[1]).toBeCloseTo(0.5, 2);
        expect(pointerButton).toHaveBeenCalledWith('left', true, expect.closeTo(0.75, 2), expect.closeTo(0.5, 2));
        expect(wheel).toHaveBeenCalledWith(0, 120, expect.closeTo(0.75, 2), expect.closeTo(0.5, 2));

        // 2. Touch tap at CSS (200, 230) -> stage local CSS (100, 150) & normalized (0.25, 0.5).
        pointerClick.mockClear();
        pointerButton.mockClear();
        const touchClientX = 200 * z;
        const touchClientY = 230 * z;
        act(() => {
          pointer(rendered.stage, 'pointerdown', { pointerId: 2, clientX: touchClientX, clientY: touchClientY });
          pointer(rendered.stage, 'pointerup', { pointerId: 2, clientX: touchClientX, clientY: touchClientY });
        });
        const touchCalls = pointerClick.mock.calls.length > 0
          ? pointerClick.mock.calls.map((c) => ({ button: c[0], x: c[1], y: c[2] }))
          : pointerButton.mock.calls.map((c) => ({ button: c[0], x: c[2], y: c[3] }));
        expect(touchCalls.length).toBeGreaterThan(0);
        expect(touchCalls[0]!.x).toBeCloseTo(0.25, 2);
        expect(touchCalls[0]!.y).toBeCloseTo(0.5, 2);

        const virtualPtr = rendered.container.querySelector('.remote-desktop-virtual-pointer') as HTMLElement | null;
        if (virtualPtr) {
          expect(parseFloat(virtualPtr.style.left)).toBeCloseTo(100, 1);
          expect(parseFloat(virtualPtr.style.top)).toBeCloseTo(150, 1);
        }

        // 3. Long-press right-click at CSS (200, 230)
        vi.useFakeTimers();
        try {
          pointerClick.mockClear();
          pointerButton.mockClear();
          act(() => {
            pointer(rendered.stage, 'pointerdown', { pointerId: 3, clientX: touchClientX, clientY: touchClientY });
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
          });
          const lpCalls = pointerClick.mock.calls.length > 0
            ? pointerClick.mock.calls.map((c) => ({ button: c[0], x: c[1], y: c[2] }))
            : pointerButton.mock.calls.map((c) => ({ button: c[0], x: c[2], y: c[3] }));
          expect(lpCalls.some((c) => c.button === 'right')).toBe(true);
          const rightCall = lpCalls.find((c) => c.button === 'right')!;
          expect(rightCall.x).toBeCloseTo(0.25, 2);
          expect(rightCall.y).toBeCloseTo(0.5, 2);
          act(() => {
            pointer(rendered.stage, 'pointerup', { pointerId: 3, clientX: touchClientX, clientY: touchClientY });
          });
        } finally {
          vi.useRealTimers();
        }

        // 4. Quality popover stays inside logical CSS viewport [1280/z, 800/z]
        const qualityBtn = rendered.container.querySelector('.remote-desktop-quality-trigger') as HTMLElement | null;
        if (qualityBtn) {
          qualityBtn.getBoundingClientRect = () => makeBoxRect(1200 / z - 30, 40, 40, 24);
          await act(async () => {
            fireEvent.click(qualityBtn);
          });
          const popover = document.body.querySelector('.remote-desktop-quality-popover') as HTMLElement | null;
          if (popover) {
            expect(parseFloat(popover.style.left)).toBeLessThanOrEqual(1280 / z - 260);
            expect(parseFloat(popover.style.top)).toBeCloseTo(70, 1);
          }
        }
      } finally {
        rendered.unmount();
        document.documentElement.getBoundingClientRect = origRootRect;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: origInnerW });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInnerH });
        applyUiScale(100);
      }
    });

    it('supports bidirectional clipboard sync toggle (ON: passive remote->local & active-only local->remote; OFF: passthrough keys)', async () => {
      const STORAGE_KEY = 'imcodes.web.remote-desktop.clipboard_sync.v1';
      localStorage.removeItem(STORAGE_KEY);
      setClipboardSync.mockClear();
      key.mockClear();
      pasteText.mockClear();
      requestRemoteClipboard.mockClear();

      const readText = vi.fn(async () => 'local active paste');
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText },
      });

      const rendered = await renderPanel({ capabilities: [...LINUX_TARGET_CAPABILITIES] });
      try {
        const syncBtn = rendered.getByRole('button', { name: 'remote_desktop.clipboard_sync' }) as HTMLButtonElement;
        expect(syncBtn.getAttribute('aria-pressed')).toBe('true');
        expect(setClipboardSync).toHaveBeenCalledWith(true);

        // Switching ON still never polls or reads local clipboard automatically.
        act(() => {
          window.dispatchEvent(new Event('focus'));
          mousePointer(rendered.stage, 'pointerdown', { pointerId: 101, clientX: 100, clientY: 100 });
          mousePointer(rendered.stage, 'pointerup', { pointerId: 101, clientX: 100, clientY: 100 });
        });
        expect(readText).not.toHaveBeenCalled();

        // Emit passive remote clipboard update while ON -> writes local clipboard automatically.
        const currentHooks = clientHooks.at(-1)!;
        const baseSnapshot = {
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          atomicButtonClick: true,
          route: 'direct',
          displays: [{
            id: 'display-primary',
            label: 'Display 1',
            primary: true,
            available: true,
            width: 1920,
            height: 1080,
            dpiScale: 1,
            rotation: 0,
          }],
          selectedDisplayId: 'display-primary',
          layoutRevision: 1,
          stream: null,
        };
        await act(async () => {
          currentHooks.onSnapshot({
            ...baseSnapshot,
            remoteClipboardUpdate: { id: 1, text: 'from remote app button' },
          });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith('from remote app button');
        expect(readText).not.toHaveBeenCalled();

        // If navigator.clipboard.writeText rejects (unfocused / lacking gesture), defer & retry on next pointerdown.
        writeText.mockRejectedValueOnce(new Error('Document is not focused.'));
        await act(async () => {
          currentHooks.onSnapshot({
            ...baseSnapshot,
            remoteClipboardUpdate: { id: 2, text: 'deferred remote copy' },
          });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(2);
        await act(async () => {
          mousePointer(rendered.stage, 'pointerdown', { pointerId: 102, clientX: 120, clientY: 120 });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith('deferred remote copy');

        // Active paste records echo guard: matching passive update within 3s is suppressed.
        await act(async () => {
          (rendered.getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement).click();
          await Promise.resolve();
        });
        expect(readText).toHaveBeenCalledTimes(1);
        expect(pasteText).toHaveBeenCalledWith('local active paste');
        const writesBeforeEcho = writeText.mock.calls.length;
        await act(async () => {
          currentHooks.onSnapshot({
            ...baseSnapshot,
            remoteClipboardUpdate: { id: 3, text: 'local active paste' },
          });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(writesBeforeEcho);

        // View mode / input disabled ignores incoming remote updates.
        await act(async () => {
          currentHooks.onSnapshot({
            ...baseSnapshot,
            mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
            inputEnabled: false,
            remoteClipboardUpdate: { id: 4, text: 'ignored in view mode' },
          });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(writesBeforeEcho);

        // Restore control mode, toggle switch OFF -> persists & notifies client.
        await act(async () => {
          currentHooks.onSnapshot({ ...baseSnapshot });
        });
        act(() => {
          syncBtn.click();
        });
        expect(syncBtn.getAttribute('aria-pressed')).toBe('false');
        expect(localStorage.getItem(STORAGE_KEY)).toBe('0');
        expect(setClipboardSync).toHaveBeenLastCalledWith(false);

        // While OFF, passive remote updates are dropped, DOM paste is ignored, and shortcuts pass straight through.
        await act(async () => {
          currentHooks.onSnapshot({
            ...baseSnapshot,
            remoteClipboardUpdate: { id: 5, text: 'ignored while off' },
          });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(writesBeforeEcho);

        key.mockClear();
        const ctrlV = new KeyboardEvent('keydown', {
          key: 'v',
          code: 'KeyV',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        act(() => { rendered.stage.dispatchEvent(ctrlV); });
        expect(key).toHaveBeenCalledWith('KeyV', 'v', true, false, { control: true, alt: false });
        expect(readText).toHaveBeenCalledTimes(1);

        const pasteEvt = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvt, 'clipboardData', {
          value: { getData: vi.fn(() => 'should not bridge when off') },
        });
        act(() => { rendered.stage.dispatchEvent(pasteEvt); });
        expect(pasteText).toHaveBeenCalledTimes(1);

        // Manual Copy & Paste toolbar buttons continue working while sync is OFF.
        await act(async () => {
          (rendered.getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement).click();
          await Promise.resolve();
        });
        expect(readText).toHaveBeenCalledTimes(2);
        expect(pasteText).toHaveBeenCalledTimes(2);

        await act(async () => {
          (rendered.getByRole('button', { name: 'common.copy' }) as HTMLButtonElement).click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('selected remotely');

        // Re-mounting reads persisted OFF state from localStorage.
        rendered.unmount();
        const second = await renderPanel({ capabilities: [...LINUX_TARGET_CAPABILITIES] });
        try {
          const secondBtn = second.getByRole('button', { name: 'remote_desktop.clipboard_sync' }) as HTMLButtonElement;
          expect(secondBtn.getAttribute('aria-pressed')).toBe('false');
        } finally {
          second.unmount();
        }
      } finally {
        localStorage.removeItem(STORAGE_KEY);
      }
    });

    it('isolates generation-fenced pending writes (late A reject after B or OFF) and excludes Paste button pointerdown', async () => {
      const STORAGE_KEY = 'imcodes.web.remote-desktop.clipboard_sync.v1';
      localStorage.removeItem(STORAGE_KEY);
      pasteText.mockClear();

      type Deferred = { resolve: () => void; reject: (err: Error) => void };
      const deferredWrites: Array<{ text: string; d: Deferred }> = [];
      const writeText = vi.fn((value: string) => new Promise<void>((resolve, reject) => {
        deferredWrites.push({ text: value, d: { resolve, reject } });
      }));
      const readText = vi.fn(async () => 'user local B');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText },
      });

      const rendered = await renderPanel({ capabilities: [...LINUX_TARGET_CAPABILITIES] });
      try {
        const currentHooks = clientHooks.at(-1)!;
        const baseSnapshot = {
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          atomicButtonClick: true,
          route: 'direct',
          displays: [{
            id: 'display-primary', label: 'Display 1', primary: true, available: true,
            width: 1920, height: 1080, dpiScale: 1, rotation: 0,
          }],
          selectedDisplayId: 'display-primary',
          layoutRevision: 1,
          stream: null,
        };

        // 1. A starts, then B arrives and resolves; late A rejection must NOT enqueue stale pending A.
        await act(async () => {
          currentHooks.onSnapshot({ ...baseSnapshot, remoteClipboardUpdate: { id: 1, text: 'remote A' } });
          await Promise.resolve();
        });
        await act(async () => {
          currentHooks.onSnapshot({ ...baseSnapshot, remoteClipboardUpdate: { id: 2, text: 'remote B' } });
          await Promise.resolve();
        });
        expect(deferredWrites.map((w) => w.text)).toEqual(['remote A', 'remote B']);
        await act(async () => {
          deferredWrites[1]!.d.resolve();
          await Promise.resolve();
        });
        await act(async () => {
          deferredWrites[0]!.d.reject(new Error('late A focus rejection'));
          await Promise.resolve();
        });
        const callsBeforeInteraction = writeText.mock.calls.length;
        await act(async () => {
          mousePointer(rendered.stage, 'pointerdown', { pointerId: 201, clientX: 80, clientY: 80 });
          window.dispatchEvent(new Event('focus'));
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(callsBeforeInteraction);

        // 2. C starts and sync is toggled OFF; late C rejection must NOT arm a pending write.
        await act(async () => {
          currentHooks.onSnapshot({ ...baseSnapshot, remoteClipboardUpdate: { id: 3, text: 'remote C' } });
          await Promise.resolve();
        });
        const syncBtn = rendered.getByRole('button', { name: 'remote_desktop.clipboard_sync' }) as HTMLButtonElement;
        act(() => { syncBtn.click(); });
        await act(async () => {
          deferredWrites[2]!.d.reject(new Error('late C after OFF'));
          await Promise.resolve();
        });
        act(() => { syncBtn.click(); });
        const callsAfterReEnable = writeText.mock.calls.length;
        await act(async () => {
          mousePointer(rendered.stage, 'pointerdown', { pointerId: 202, clientX: 80, clientY: 80 });
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(callsAfterReEnable);

        // 3. Pending remote write D exists -> pointerdown directly on Paste button MUST NOT flush D before click reads local B.
        await act(async () => {
          currentHooks.onSnapshot({ ...baseSnapshot, remoteClipboardUpdate: { id: 4, text: 'pending remote D' } });
          await Promise.resolve();
        });
        await act(async () => {
          deferredWrites[3]!.d.reject(new Error('unfocused D'));
          await Promise.resolve();
        });
        const callsBeforePasteBtn = writeText.mock.calls.length;
        const pasteBtn = rendered.getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement;
        await act(async () => {
          mousePointer(pasteBtn, 'pointerdown', { pointerId: 203, clientX: 10, clientY: 10 });
          pasteBtn.click();
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledTimes(callsBeforePasteBtn);
        expect(pasteText).toHaveBeenCalledWith('user local B');
      } finally {
        rendered.unmount();
        localStorage.removeItem(STORAGE_KEY);
      }
    });

    it('handles all active-paste chords (Ctrl+Shift+V on Win->Win, Ctrl+V & Shift+Insert on Apple) when ON and passes them through when OFF', async () => {
      const STORAGE_KEY = 'imcodes.web.remote-desktop.clipboard_sync.v1';
      localStorage.removeItem(STORAGE_KEY);
      const origPlatform = navigator.platform;
      const readText = vi.fn(async () => 'active chord paste');
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText },
      });

      try {
        // Case A: Windows/Linux controller targeting Windows with Ctrl+Shift+V.
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
        const winRendered = await renderPanel({
          capabilities: [
            REMOTE_DESKTOP_SESSION_CAPABILITY,
            REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS,
            REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
            REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
          ],
        });
        try {
          pasteText.mockClear();
          key.mockClear();
          await act(async () => {
            winRendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(readText).toHaveBeenCalledTimes(1);
          expect(pasteText).toHaveBeenCalledWith('active chord paste');
          expect(key).not.toHaveBeenCalled();

          // Toggle OFF -> Ctrl+Shift+V passes straight through to key() without reading local clipboard.
          const winSyncBtn = winRendered.getByRole('button', { name: 'remote_desktop.clipboard_sync' }) as HTMLButtonElement;
          act(() => { winSyncBtn.click(); });
          await act(async () => {
            winRendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(readText).toHaveBeenCalledTimes(1);
          expect(pasteText).toHaveBeenCalledTimes(1);
          expect(key).toHaveBeenCalledWith('KeyV', 'V', true, false, { control: true, alt: false });
        } finally {
          winRendered.unmount();
          localStorage.removeItem(STORAGE_KEY);
        }

        // Case B: Apple controller targeting macOS with Ctrl+V and Shift+Insert (ON -> active paste; OFF -> key passthrough).
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        const macRendered = await renderPanel({ capabilities: [...MAC_TARGET_CAPABILITIES] });
        try {
          pasteText.mockClear();
          key.mockClear();
          readText.mockClear();
          await act(async () => {
            macRendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
            macRendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Insert', code: 'Insert', shiftKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(readText).toHaveBeenCalledTimes(2);
          expect(pasteText).toHaveBeenCalledTimes(2);
          expect(key).not.toHaveBeenCalled();

          const macSyncBtn = macRendered.getByRole('button', { name: 'remote_desktop.clipboard_sync' }) as HTMLButtonElement;
          act(() => { macSyncBtn.click(); });
          await act(async () => {
            macRendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(readText).toHaveBeenCalledTimes(2);
          expect(key).toHaveBeenCalledWith('KeyV', 'v', true, false, { control: true, alt: false });
        } finally {
          macRendered.unmount();
        }
      } finally {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: origPlatform });
        localStorage.removeItem(STORAGE_KEY);
      }
    });

    it('preserves shared local clipboard B when modifier keydown precedes V/Insert while a pending remote write A awaits flush', async () => {
      const STORAGE_KEY = 'imcodes.web.remote-desktop.clipboard_sync.v1';
      localStorage.removeItem(STORAGE_KEY);
      const origPlatform = navigator.platform;
      let sharedClipboard = 'user local B';
      let rejectNextWrite = false;
      const writeText = vi.fn(async (value: string) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error('unfocused');
        }
        sharedClipboard = value;
      });
      const readText = vi.fn(async () => sharedClipboard);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText },
      });

      try {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
        const rendered = await renderPanel({ capabilities: [...LINUX_TARGET_CAPABILITIES] });
        try {
          const currentHooks = clientHooks.at(-1)!;
          const baseSnapshot = {
            state: REMOTE_DESKTOP_STATE.DIRECT,
            mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
            inputEpoch: 1,
            inputEnabled: true,
            atomicButtonClick: true,
            route: 'direct',
            displays: [{
              id: 'display-primary', label: 'Display 1', primary: true, available: true,
              width: 1920, height: 1080, dpiScale: 1, rotation: 0,
            }],
            selectedDisplayId: 'display-primary',
            layoutRevision: 1,
            stream: null,
          };

          const armPendingRemoteA = async (id: number) => {
            rejectNextWrite = true;
            sharedClipboard = 'user local B';
            await act(async () => {
              currentHooks.onSnapshot({
                ...baseSnapshot,
                remoteClipboardUpdate: { id, text: 'remote pending A', inputEpoch: 1 },
              });
              await Promise.resolve();
            });
          };

          // 1. Realistic Ctrl+V sequence: ControlLeft -> KeyV
          pasteText.mockClear();
          await armPendingRemoteA(1);
          await act(async () => {
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(sharedClipboard).toBe('user local B');
          expect(pasteText).toHaveBeenCalledWith('user local B');

          // 2. Realistic Ctrl+Shift+V sequence: ControlLeft -> ShiftLeft -> KeyV
          pasteText.mockClear();
          await armPendingRemoteA(2);
          await act(async () => {
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Control', code: 'ControlLeft', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
            }));
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(sharedClipboard).toBe('user local B');
          expect(pasteText).toHaveBeenCalledWith('user local B');

          // 3. Realistic Shift+Insert sequence: ShiftLeft -> Insert
          pasteText.mockClear();
          await armPendingRemoteA(3);
          await act(async () => {
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true, cancelable: true,
            }));
            rendered.stage.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Insert', code: 'Insert', shiftKey: true, bubbles: true, cancelable: true,
            }));
            await Promise.resolve();
          });
          expect(sharedClipboard).toBe('user local B');
          expect(pasteText).toHaveBeenCalledWith('user local B');
        } finally {
          rendered.unmount();
        }
      } finally {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: origPlatform });
        localStorage.removeItem(STORAGE_KEY);
      }
    });
  });

  describe('system audio playback controls and voice ducking', () => {
    it('keeps audio off by default, keeps video muted, plays dedicated audio on toggle, catches autoplay errors, persists volume, and ducks during VoiceOverlay', async () => {
      voiceMocks.available = true;
      const manager = new RemoteDesktopConnectionManager();
      const rendered = render(
        <RemoteDesktopPanel
          machine={{
            serverId: 'server-1',
            refName: 'server-1',
            displayName: 'Server 1',
            os: 'mac',
            online: true,
            execEnabled: true,
            accessRole: 'owner',
            capabilities: [REMOTE_DESKTOP_CAPABILITY],
          }}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      const videoEl = rendered.container.querySelector('video') as HTMLVideoElement;
      const audioEl = rendered.container.querySelector('audio') as HTMLAudioElement;
      expect(videoEl).not.toBeNull();
      expect(audioEl).not.toBeNull();
      expect(videoEl.muted).toBe(true);
      expect(audioEl.muted).toBe(true);

      const audioPlaySpy = vi.fn(async () => undefined);
      Object.defineProperty(audioEl, 'play', { configurable: true, value: audioPlaySpy });

      const fakeVideoStream = {} as MediaStream;
      const fakeAudioStream = {} as MediaStream;
      act(() => {
        clientHooks[0]!.onSnapshot({
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          displays: [],
          layoutRevision: 1,
          stream: fakeVideoStream,
          audioStream: fakeAudioStream,
          atomicButtonClick: true,
        });
      });

      const audioToggle = rendered.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
      const volumeSlider = rendered.container.querySelector('.remote-desktop-audio-volume') as HTMLInputElement;
      expect(audioToggle).not.toBeNull();
      expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
      expect(audioEl.volume).toBeCloseTo(1, 5);
      expect(volumeSlider.value).toBe('1');
      expect(audioPlaySpy).not.toHaveBeenCalled();

      // Enable audio: sends setAudioEnabled(true), unmutes <audio>, keeps <video muted>, calls audio.play().
      await act(async () => {
        fireEvent.click(audioToggle);
        await Promise.resolve();
      });
      expect(setAudioEnabled).toHaveBeenCalledWith(true);
      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(audioEl.muted).toBe(false);
      expect(videoEl.muted).toBe(true);
      expect(audioPlaySpy).toHaveBeenCalled();

      // Volume slider adjusts <audio>.volume and persists to localStorage.
      act(() => {
        fireEvent.input(volumeSlider, { target: { value: '0.35' } });
      });
      expect(audioEl.volume).toBeCloseTo(0.35, 5);
      expect(localStorage.getItem('imcodes.web.remote-desktop.audio_volume.v1')).toBe('0.35');

      // Opening VoiceOverlay ducks <audio> (muted = true) and closing restores unmuted playback.
      act(() => {
        (rendered.getByRole('button', { name: 'remote_desktop.mobile_keyboard' }) as HTMLButtonElement).click();
      });
      const voiceTrigger = rendered.getByRole('button', { name: 'voice.voice_input' });
      await act(async () => {
        fireEvent.click(voiceTrigger);
        await Promise.resolve();
      });
      expect(document.body.querySelector('.voice-overlay')).not.toBeNull();
      expect(audioEl.muted).toBe(true);

      audioPlaySpy.mockClear();
      const closeVoiceBtn = document.body.querySelector('.voice-overlay-close') as HTMLButtonElement;
      expect(closeVoiceBtn).not.toBeNull();
      await act(async () => {
        fireEvent.click(closeVoiceBtn);
        await Promise.resolve();
      });
      expect(audioEl.muted).toBe(false);
      expect(audioPlaySpy).toHaveBeenCalled();
      expect(videoEl.muted).toBe(true);

      // Rejected audio.play() (browser autoplay block) shows direct 1-gesture retry without disabling audio.
      const rejectedPlay = vi.fn(() => Promise.reject(new DOMException('NotAllowedError', 'NotAllowedError')));
      Object.defineProperty(audioEl, 'play', { configurable: true, value: rejectedPlay });
      await act(async () => {
        fireEvent.click(audioToggle); // turn off
        await Promise.resolve();
      });
      expect(setAudioEnabled).toHaveBeenLastCalledWith(false);
      expect(audioEl.muted).toBe(true);

      await act(async () => {
        fireEvent.click(audioToggle); // turn on with blocked autoplay
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(rejectedPlay).toHaveBeenCalled();
      expect(audioToggle.classList.contains('is-blocked')).toBe(true);
      const retryBtn = rendered.container.querySelector('.remote-desktop-audio-retry') as HTMLButtonElement;
      expect(retryBtn).not.toBeNull();

      const allowedPlay = vi.fn(async () => undefined);
      Object.defineProperty(audioEl, 'play', { configurable: true, value: allowedPlay });
      await act(async () => {
        fireEvent.click(retryBtn);
        await Promise.resolve();
      });
      expect(allowedPlay).toHaveBeenCalled();
      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(audioToggle.classList.contains('is-blocked')).toBe(false);
      expect(rendered.container.querySelector('.remote-desktop-audio-retry')).toBeNull();

      rendered.unmount();
    });

    it('calls audio.play() synchronously inside click gesture even before audioStream arrives and restores worker audio across inputActive focus switches', async () => {
      const manager = new RemoteDesktopConnectionManager();
      const machine = {
        serverId: 'server-1',
        refName: 'server-1',
        displayName: 'Server 1',
        os: 'mac',
        online: true,
        execEnabled: true,
        accessRole: 'owner' as const,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      };
      const rendered = render(
        <RemoteDesktopPanel
          machine={machine}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      const videoEl = rendered.container.querySelector('video') as HTMLVideoElement;
      const audioEl = rendered.container.querySelector('audio') as HTMLAudioElement;
      const playCalls: Array<{ srcObjectPresent: boolean; muted: boolean }> = [];
      Object.defineProperty(audioEl, 'play', {
        configurable: true,
        value: vi.fn(async () => {
          playCalls.push({ srcObjectPresent: Boolean(audioEl.srcObject), muted: audioEl.muted });
        }),
      });

      // Deliver video stream ONLY (no audioStream yet).
      act(() => {
        clientHooks[0]!.onSnapshot({
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          displays: [],
          layoutRevision: 1,
          stream: {} as MediaStream,
        });
      });

      const audioToggle = rendered.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
      setAudioEnabled.mockClear();

      // Click Sound ON BEFORE audio track arrives: synchronous play() MUST fire inside gesture.
      await act(async () => {
        fireEvent.click(audioToggle);
        await Promise.resolve();
      });
      expect(playCalls.length).toBeGreaterThanOrEqual(1);
      expect(playCalls[0]).toEqual({ srcObjectPresent: false, muted: false });
      expect(setAudioEnabled).toHaveBeenLastCalledWith(true);

      // Audio track arrives afterwards -> attaches srcObject and plays automatically while video stays muted.
      const fakeAudioStream = {} as MediaStream;
      act(() => {
        clientHooks[0]!.onSnapshot({
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          displays: [],
          layoutRevision: 1,
          stream: {} as MediaStream,
          audioStream: fakeAudioStream,
        });
      });
      expect(audioEl.srcObject).toBe(fakeAudioStream);
      expect(playCalls.some((c) => c.srcObjectPresent && !c.muted)).toBe(true);
      expect(videoEl.muted).toBe(true);

      // Toggle inputActive (tab switch / minimize) and return: UI switch stays ON and worker gets ON again.
      rendered.rerender(
        <RemoteDesktopPanel
          machine={machine}
          connectionManager={manager}
          embedded
          active={false}
          inputActive={false}
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      setAudioEnabled.mockClear();
      rendered.rerender(
        <RemoteDesktopPanel
          machine={machine}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(setAudioEnabled).toHaveBeenCalledWith(true);

      rendered.unmount();
    });

    it('persists per-host audio preference across unmount/reopen (on -> reopen -> off -> reopen), isolates hosts, preserves route refresh, and fails soft when storage throws', async () => {
      const manager = new RemoteDesktopConnectionManager();
      const hostAlphaRoute1 = {
        serverId: 'srv-route-1',
        remoteDesktopHostId: 'host-alpha',
        refName: 'host-alpha',
        displayName: 'Host Alpha',
        os: 'mac',
        online: true,
        execEnabled: true,
        accessRole: 'owner' as const,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      };
      const hostAlphaRoute2 = { ...hostAlphaRoute1, serverId: 'srv-route-2' };
      const hostBetaFallback = {
        serverId: 'server-beta',
        refName: 'server-beta',
        displayName: 'Host Beta',
        os: 'linux',
        online: true,
        execEnabled: true,
        accessRole: 'owner' as const,
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      };

      // 1. Unset host starts muted and sends NO extra SET_AUDIO on mount.
      setAudioEnabled.mockClear();
      const first = render(
        <RemoteDesktopPanel
          machine={hostAlphaRoute1}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      let audioToggle = first.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
      expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
      expect(setAudioEnabled).not.toHaveBeenCalled();

      // Enable audio on host-alpha -> persists by canonical hostKey and notifies connection.
      await act(async () => {
        fireEvent.click(audioToggle);
        await Promise.resolve();
      });
      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(setAudioEnabled).toHaveBeenLastCalledWith(true);
      expect(localStorage.getItem('imcodes.web.remote-desktop.audio_enabled.v1.host-alpha')).toBe('1');

      // Switch route (serverId changes, same canonical hostKey) -> keeps audio ON without resetting.
      setAudioEnabled.mockClear();
      first.rerender(
        <RemoteDesktopPanel
          machine={hostAlphaRoute2}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });
      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(setAudioEnabled).toHaveBeenCalledWith(true);

      // Switch to unset host-beta -> must NOT briefly write host-alpha's true to host-beta
      // (unsubscribe on host-alpha sends false for host-alpha when its last viewer leaves, never true for host-beta).
      setAudioEnabled.mockClear();
      first.rerender(
        <RemoteDesktopPanel
          machine={hostBetaFallback}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });
      expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
      expect(setAudioEnabled).not.toHaveBeenCalledWith(true);
      first.unmount();

      // Fresh mount of unset host-beta sends zero SET_AUDIO calls.
      setAudioEnabled.mockClear();
      const freshBeta = render(
        <RemoteDesktopPanel
          machine={hostBetaFallback}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });
      expect((freshBeta.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
      expect(setAudioEnabled).not.toHaveBeenCalled();
      freshBeta.unmount();

      // 2. Reopen host-alpha (even on route 2) -> restores ON, unmutes/plays when stream present, and supports autoplay retry.
      setAudioEnabled.mockClear();
      const reopenedOn = render(
        <RemoteDesktopPanel
          machine={hostAlphaRoute2}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      audioToggle = reopenedOn.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
      const audioEl = reopenedOn.container.querySelector('audio') as HTMLAudioElement;
      const blockedPlay = vi.fn(() => Promise.reject(new DOMException('NotAllowedError', 'NotAllowedError')));
      Object.defineProperty(audioEl, 'play', { configurable: true, value: blockedPlay });

      expect(audioToggle.getAttribute('aria-pressed')).toBe('true');
      expect(setAudioEnabled).toHaveBeenCalledWith(true);

      await act(async () => {
        clientHooks[1]!.onSnapshot({
          state: REMOTE_DESKTOP_STATE.DIRECT,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          inputEnabled: true,
          displays: [],
          layoutRevision: 1,
          stream: {} as MediaStream,
          audioStream: {} as MediaStream,
        });
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(audioEl.muted).toBe(false);
      expect(blockedPlay).toHaveBeenCalled();
      const retryBtn = reopenedOn.container.querySelector('.remote-desktop-audio-retry') as HTMLButtonElement;
      expect(retryBtn).not.toBeNull();
      const allowedPlay = vi.fn(async () => undefined);
      Object.defineProperty(audioEl, 'play', { configurable: true, value: allowedPlay });
      await act(async () => {
        fireEvent.click(retryBtn);
        await Promise.resolve();
      });
      expect(allowedPlay).toHaveBeenCalled();
      expect(reopenedOn.container.querySelector('.remote-desktop-audio-retry')).toBeNull();

      // Explicitly turn audio OFF -> persists '0' and sends false.
      await act(async () => {
        fireEvent.click(audioToggle);
        await Promise.resolve();
      });
      expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
      expect(setAudioEnabled).toHaveBeenLastCalledWith(false);
      expect(localStorage.getItem('imcodes.web.remote-desktop.audio_enabled.v1.host-alpha')).toBe('0');
      reopenedOn.unmount();

      // 3. Reopen host-alpha -> restores explicit OFF and syncs false; host-beta remains isolated.
      setAudioEnabled.mockClear();
      const reopenedOff = render(
        <RemoteDesktopPanel
          machine={hostAlphaRoute1}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });

      audioToggle = reopenedOff.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
      expect(audioToggle.getAttribute('aria-pressed')).toBe('false');
      expect(setAudioEnabled).toHaveBeenCalledWith(false);
      reopenedOff.unmount();

      // 4. Unset presentation mounting alongside an active audio-ON presentation on the SAME host must not mute the aggregate.
      const sharedHost = { ...hostBetaFallback, serverId: 'server-shared' };
      const p1 = render(
        <RemoteDesktopPanel
          machine={sharedHost}
          connectionManager={manager}
          embedded
          active
          inputActive
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });
      await act(async () => {
        fireEvent.click(p1.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement);
        await Promise.resolve();
      });
      expect(setAudioEnabled).toHaveBeenLastCalledWith(true);

      // Simulate an unset second presentation (no saved preference) opening for the same host.
      localStorage.removeItem('imcodes.web.remote-desktop.audio_enabled.v1.server-shared');
      setAudioEnabled.mockClear();
      const p2 = render(
        <RemoteDesktopPanel
          machine={sharedHost}
          connectionManager={manager}
          embedded
          active={false}
          inputActive={false}
          onClose={vi.fn()}
        />,
      );
      await act(async () => { await Promise.resolve(); });
      expect(setAudioEnabled).not.toHaveBeenCalled();
      p2.unmount();
      expect(setAudioEnabled).not.toHaveBeenCalled();
      p1.unmount();
      expect(setAudioEnabled).toHaveBeenCalledWith(false);

      // 5. Storage failures fail soft while preserving in-session toggling and route refresh.
      const failingAudioKey = 'imcodes.web.remote-desktop.audio_enabled.v1.host-fail-storage';
      const origGetItem = Storage.prototype.getItem;
      const origSetItem = Storage.prototype.setItem;
      let getThrowCalls = 0;
      let setThrowCalls = 0;
      const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (key === failingAudioKey) {
          getThrowCalls += 1;
          throw new DOMException('SecurityError', 'SecurityError');
        }
        return origGetItem.call(this, key);
      });
      const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === failingAudioKey) {
          setThrowCalls += 1;
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return origSetItem.call(this, key, value);
      });
      try {
        setAudioEnabled.mockClear();
        const failingStorageHost = {
          serverId: 'srv-fail-1',
          remoteDesktopHostId: 'host-fail-storage',
          refName: 'host-fail-storage',
          displayName: 'Fail Storage',
          os: 'mac',
          online: true,
          execEnabled: true,
          accessRole: 'owner' as const,
          capabilities: [REMOTE_DESKTOP_CAPABILITY],
        };
        const panelFail = render(
          <RemoteDesktopPanel
            machine={failingStorageHost}
            connectionManager={manager}
            embedded
            active
            inputActive
            onClose={vi.fn()}
          />,
        );
        await act(async () => { await Promise.resolve(); });
        expect(getSpy).toHaveBeenCalledWith(failingAudioKey);
        expect(getThrowCalls).toBeGreaterThanOrEqual(1);
        const toggleFail = panelFail.container.querySelector('.remote-desktop-audio-toggle') as HTMLButtonElement;
        expect(toggleFail.getAttribute('aria-pressed')).toBe('false');
        expect(setAudioEnabled).not.toHaveBeenCalled();
        await act(async () => {
          fireEvent.click(toggleFail);
          await Promise.resolve();
        });
        expect(setSpy).toHaveBeenCalledWith(failingAudioKey, '1');
        expect(setThrowCalls).toBeGreaterThanOrEqual(1);
        expect(toggleFail.getAttribute('aria-pressed')).toBe('true');
        expect(setAudioEnabled).toHaveBeenLastCalledWith(true);

        // Route refresh on same logical host keeps in-session audio state even when storage throws.
        setAudioEnabled.mockClear();
        panelFail.rerender(
          <RemoteDesktopPanel
            machine={{ ...failingStorageHost, serverId: 'srv-fail-2' }}
            connectionManager={manager}
            embedded
            active
            inputActive
            onClose={vi.fn()}
          />,
        );
        await act(async () => { await Promise.resolve(); });
        expect(toggleFail.getAttribute('aria-pressed')).toBe('true');
        expect(setAudioEnabled).toHaveBeenCalledWith(true);
        panelFail.unmount();
      } finally {
        getSpy.mockRestore();
        setSpy.mockRestore();
      }
    });
  });
});
