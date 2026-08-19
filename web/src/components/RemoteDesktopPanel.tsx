import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_DPI_SCALE_PERCENTS,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  mapRemoteDesktopVideoPoint,
} from '@shared/remote-desktop.js';
import { DIRECT_FILE_TRANSFER_STATE } from '@shared/direct-file-transfer.js';
import {
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_PATH,
} from '@shared/transport/file-transfer.js';
import { downloadAttachment } from '../api.js';
import { createMachineFileHandle, type MachineListItem } from '../api/machines.js';
import { MachineDirectoryWsAdapter } from '../machine-directory-ws-adapter.js';
import {
  isFileUploadCanceled,
  uploadFileWithDirectFallback,
  type FileUploadTransportMode,
} from '../direct-file-transfer.js';
import { RemoteDesktopClient, type RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import {
  REMOTE_DESKTOP_MOBILE_SHORTCUTS,
  isAppleControllerPlatform,
  detectRemoteDesktopClipboardShortcut,
  mapRemoteDesktopKeyboardEvent,
  readControllerPlatform,
  REMOTE_DESKTOP_CLIPBOARD_SHORTCUT,
  remoteDesktopShortcutLabel,
  sendRemoteDesktopChord,
} from '../remote-desktop-keyboard.js';
import { copyToClipboard } from '../util/clipboard.js';
import type { WsClient } from '../ws-client.js';
import { openRemoteDesktopWindow } from '../remote-desktop-window.js';
import { FloatingPanel } from './FloatingPanel.js';
import { DesktopWindowMaximizeButton } from './DesktopWindowMaximizeButton.js';
import { FileBrowser } from './FileBrowser.js';
import {
  INITIAL_REMOTE_DESKTOP_VIEWPORT,
  clampRemoteDesktopViewport,
  panRemoteDesktopViewportAtEdge,
  remoteDesktopMouseModeViewport,
  stickRemoteDesktopPointerToEdges,
  viewportFromRemoteDesktopPinch,
  type RemoteDesktopViewport,
} from '../remote-desktop-viewport.js';

type ViewScale = 'fit' | 'actual';
type MobileInputMode = 'touch' | 'mouse';
type ClipboardStatus = 'idle' | 'copying' | 'copied' | 'pasting' | 'pasted' | 'empty' | 'failed';

interface TouchPoint {
  x: number;
  y: number;
}

type TouchSingleGesture = {
  kind: 'single';
  pointerId: number;
  start: TouchPoint;
  startedAt: number;
  moved: boolean;
  longPressFired: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  viewport: RemoteDesktopViewport;
};

type TouchGesture = TouchSingleGesture | {
  kind: 'pinch';
  initialCenter: TouchPoint;
  initialDistance: number;
  viewport: RemoteDesktopViewport;
};

type VirtualMouseDrag = {
  kind: 'move';
  pointerId: number;
  start: TouchPoint;
  origin: TouchPoint;
} | {
  kind: 'wheel';
  pointerId: number;
  lastY: number;
};

type VirtualMouseButton = 'left' | 'middle' | 'right';

interface DisplayModeMenuState {
  displayId: string;
  x: number;
  y: number;
}

interface DisplayTabLongPress {
  displayId: string;
  pointerId: number;
  start: TouchPoint;
  timer: ReturnType<typeof setTimeout>;
}

const INITIAL_SNAPSHOT: RemoteDesktopSnapshot = {
  state: REMOTE_DESKTOP_STATE.AUTHORIZING,
  mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
  inputEpoch: 0,
  inputEnabled: false,
  displays: [],
  layoutRevision: 1,
  stream: null,
  durationMs: 0,
  reconnectCount: 0,
  capabilityVersion: REMOTE_DESKTOP_CAPABILITY,
};

const MAX_REMOTE_DESKTOP_RECONNECTS = REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS;
/**
 * The resolutions to offer for a display: the ones its driver reported, or the
 * common sizes when the node is too old to report any. A node that reports them
 * decides on its own — offering a size its driver lacks is a control that can
 * only ever do nothing.
 */
function displayModeOptions(
  display: RemoteDesktopSnapshot['displays'][number],
): Array<{ width: number; height: number; label?: string }> {
  if (!display.modes?.length) return [...REMOTE_DESKTOP_COMMON_DISPLAY_MODES];
  const labels = new Map<string, string>(REMOTE_DESKTOP_COMMON_DISPLAY_MODES.map((mode) => (
    [`${mode.width}x${mode.height}`, mode.label] as [string, string]
  )));
  return display.modes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    ...(labels.has(`${mode.width}x${mode.height}`)
      ? { label: labels.get(`${mode.width}x${mode.height}`) }
      : {}),
  }));
}

/** How long a refused-command notice stays up before it fades on its own. */
const CONTROL_NOTICE_MS = 6_000;
const TOUCH_LONG_PRESS_MS = 550;
const TOUCH_DOUBLE_TAP_MS = 400;
const TOUCH_DOUBLE_TAP_DISTANCE_PX = 32;
const RECONNECTABLE_REMOTE_DESKTOP_FAILURES = new Set<string>([
  REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
  REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED,
  REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED,
  REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
  REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
]);

const REMOTE_DESKTOP_CONNECTION_STEPS = [
  'authorize',
  'worker',
  'negotiate',
  'media',
] as const;

function activeRemoteDesktopConnectionStep(
  snapshot: RemoteDesktopSnapshot,
  mediaPresented: boolean,
): number {
  if (snapshot.stream && mediaPresented) return REMOTE_DESKTOP_CONNECTION_STEPS.length;
  switch (snapshot.state) {
    case REMOTE_DESKTOP_STATE.PREPARING:
      return 1;
    case REMOTE_DESKTOP_STATE.CONNECTING:
      return 2;
    case REMOTE_DESKTOP_STATE.DIRECT:
    case REMOTE_DESKTOP_STATE.RELAYED:
    case REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY:
      return 3;
    case REMOTE_DESKTOP_STATE.RECONNECTING:
    case REMOTE_DESKTOP_STATE.STOPPING:
    case REMOTE_DESKTOP_STATE.STOPPED:
    case REMOTE_DESKTOP_STATE.FAILED:
      return -1;
    case REMOTE_DESKTOP_STATE.AUTHORIZING:
    default:
      return 0;
  }
}

export function canOpenRemoteDesktop(machine: MachineListItem): boolean {
  const role = machine.accessRole ?? 'owner';
  return machine.os === 'win'
    && machine.online
    && machine.execEnabled
    && (role === 'owner' || role === 'participant')
    && Boolean(machine.capabilities?.includes(REMOTE_DESKTOP_CAPABILITY));
}

export interface RemoteDesktopPanelProps {
  machine: MachineListItem;
  ws?: WsClient | null;
  minimized?: boolean;
  standalone?: boolean;
  allowStandaloneWindow?: boolean;
  onMinimize?(): void;
  onRestore?(): void;
  onClose(): void;
  /**
   * Managed desktop-stack z-index. Without it the panel sat at a hardcoded
   * 10020, above every stack-managed window, so no other window could ever be
   * raised over it however the user clicked.
   */
  zIndex?: number;
  /** Raise this window. Wired to a mousedown anywhere inside the panel. */
  onFocus?(): void;
}

interface RemoteDesktopTransferRow {
  id: string;
  name: string;
  progress: number;
  transport: FileUploadTransportMode;
  status: 'transferring' | 'done' | 'canceled' | 'error';
}

export function RemoteDesktopPanel({
  machine,
  ws = null,
  minimized = false,
  standalone = false,
  allowStandaloneWindow = false,
  onMinimize,
  onRestore,
  onClose,
  zIndex,
  onFocus,
}: RemoteDesktopPanelProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RemoteDesktopSnapshot>(INITIAL_SNAPSHOT);
  const [viewScale, setViewScale] = useState<ViewScale>('fit');
  const [mobileInputMode, setMobileInputMode] = useState<MobileInputMode>('touch');
  const [viewport, setViewport] = useState<RemoteDesktopViewport>(INITIAL_REMOTE_DESKTOP_VIEWPORT);
  const [virtualMouse, setVirtualMouse] = useState<TouchPoint>({ x: 0, y: 0 });
  const [viewportGeometryRevision, setViewportGeometryRevision] = useState(0);
  const [clientGeneration, setClientGeneration] = useState(0);
  const [transfers, setTransfers] = useState<RemoteDesktopTransferRow[]>([]);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [fetchPath, setFetchPath] = useState('');
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState('');
  const [fileDropActive, setFileDropActive] = useState(false);
  const [mobileTextOpen, setMobileTextOpen] = useState(false);
  const [displayModeMenu, setDisplayModeMenu] = useState<DisplayModeMenuState | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<ClipboardStatus>('idle');
  const [mediaPresented, setMediaPresented] = useState(false);
  const [desktopMaximized, setDesktopMaximized] = useState(false);
  const [controlNotice, setControlNotice] = useState<{ id: number; text: string } | null>(null);
  const clientRef = useRef<RemoteDesktopClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileTextInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mobileTextComposingRef = useRef(false);
  const machineDirectoryAdapterRef = useRef<MachineDirectoryWsAdapter | null>(null);
  const displayModeMenuRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<RemoteDesktopViewport>(INITIAL_REMOTE_DESKTOP_VIEWPORT);
  const virtualMouseRef = useRef<TouchPoint>({ x: 0, y: 0 });
  const virtualMouseDragRef = useRef<VirtualMouseDrag | null>(null);
  const virtualMouseEdgePointRef = useRef<TouchPoint | null>(null);
  const virtualMouseEdgeFrameRef = useRef<number | null>(null);
  const heldVirtualButtonsRef = useRef(new Map<number, VirtualMouseButton>());
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const lastTouchTapRef = useRef<{
    at: number;
    point: TouchPoint;
    normalized: TouchPoint;
  } | null>(null);
  const lastTouchRemotePointRef = useRef<TouchPoint>({ x: 0.5, y: 0.5 });
  const reconnectCountRef = useRef(0);
  const forceWorkerRecycleRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferControllersRef = useRef(new Map<string, AbortController>());
  const unmountedRef = useRef(false);
  const displayTabLongPressRef = useRef<DisplayTabLongPress | null>(null);
  const suppressDisplayTabClickRef = useRef(false);
  const suppressDisplayTabClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousInputEnabledRef = useRef(false);
  const mediaPresentedRef = useRef(false);
  const forwardedCommandCodesRef = useRef(new Set<string>());
  const suppressedCommandCodesRef = useRef(new Set<string>());
  const syntheticCommandControlRef = useRef(false);
  const commandMiddleDragPointerRef = useRef<number | null>(null);
  const forwardedPasteShortcutAtRef = useRef(0);
  const supportsDirectoryTransfer = Boolean(machine.capabilities?.includes(FILE_TRANSFER_DIRECTORY_CAPABILITY));

  if (!machineDirectoryAdapterRef.current) {
    machineDirectoryAdapterRef.current = new MachineDirectoryWsAdapter(machine.serverId);
  }

  useEffect(() => () => {
    machineDirectoryAdapterRef.current?.destroy();
    machineDirectoryAdapterRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    const publishSnapshot = (next: RemoteDesktopSnapshot) => {
      if (disposed || unmountedRef.current) return;
      const connected = next.state === REMOTE_DESKTOP_STATE.DIRECT
        || next.state === REMOTE_DESKTOP_STATE.RELAYED;
      if (!connected && reconnectStabilityTimerRef.current) {
        clearTimeout(reconnectStabilityTimerRef.current);
        reconnectStabilityTimerRef.current = null;
      }
      if (connected && reconnectCountRef.current > 0
        && !reconnectStabilityTimerRef.current) {
        reconnectStabilityTimerRef.current = setTimeout(() => {
          reconnectStabilityTimerRef.current = null;
          if (disposed || unmountedRef.current) return;
          reconnectCountRef.current = 0;
          setSnapshot((current) => ({ ...current, reconnectCount: 0 }));
        }, REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS);
      }
      const reason = next.terminalReason ?? next.error;
      const reconnectableFailure = next.state === REMOTE_DESKTOP_STATE.FAILED
        && Boolean(reason && RECONNECTABLE_REMOTE_DESKTOP_FAILURES.has(reason));
      // stop()/terminal cleanup can publish more than one FAILED snapshot for
      // the same client. Once a retry is scheduled, keep the recovery UI in
      // place instead of briefly exposing worker_failed (and a dead Retry
      // button) while the old authority finishes closing.
      if (reconnectableFailure && reconnectTimerRef.current) return;
      if (reconnectableFailure
        && reconnectCountRef.current < MAX_REMOTE_DESKTOP_RECONNECTS) {
        reconnectCountRef.current++;
        const reconnectCount = reconnectCountRef.current;
        setSnapshot({
          ...next,
          state: REMOTE_DESKTOP_STATE.RECONNECTING,
          inputEnabled: false,
          reconnectCount,
        });
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (!unmountedRef.current) setClientGeneration((current) => current + 1);
        }, REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS
          * (2 ** (reconnectCount - 1)));
        return;
      }
      setSnapshot({ ...next, reconnectCount: reconnectCountRef.current });
    };
    const client = new RemoteDesktopClient(machine.serverId, { onSnapshot: publishSnapshot });
    clientRef.current = client;
    const reconnectAttempt = forceWorkerRecycleRef.current
      ? Math.max(1, reconnectCountRef.current)
      : reconnectCountRef.current;
    forceWorkerRecycleRef.current = false;
    void client.start(reconnectAttempt).catch(() => publishSnapshot({
      ...client.current(),
      state: REMOTE_DESKTOP_STATE.FAILED,
      inputEnabled: false,
      error: REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
    }));
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (reconnectStabilityTimerRef.current) {
        clearTimeout(reconnectStabilityTimerRef.current);
      }
      reconnectStabilityTimerRef.current = null;
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [machine.serverId, clientGeneration]);

  useEffect(() => () => {
    unmountedRef.current = true;
    for (const controller of transferControllersRef.current.values()) controller.abort();
    transferControllersRef.current.clear();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (reconnectStabilityTimerRef.current) clearTimeout(reconnectStabilityTimerRef.current);
    reconnectStabilityTimerRef.current = null;
    if (virtualMouseEdgeFrameRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(virtualMouseEdgeFrameRef.current);
      } else {
        window.clearTimeout(virtualMouseEdgeFrameRef.current);
      }
      virtualMouseEdgeFrameRef.current = null;
    }
    heldVirtualButtonsRef.current.clear();
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    if (displayTabLongPressRef.current) clearTimeout(displayTabLongPressRef.current.timer);
    displayTabLongPressRef.current = null;
    if (suppressDisplayTabClickTimerRef.current) {
      clearTimeout(suppressDisplayTabClickTimerRef.current);
      suppressDisplayTabClickTimerRef.current = null;
    }
  }, []);

  // A refused layout command is the only outcome the picture cannot show: the
  // desktop keeps streaming unchanged. Surface the node's reason and let it
  // fade, so a second attempt with the same reason still announces itself.
  useEffect(() => {
    const rejection = snapshot.controlRejection;
    if (!rejection) return;
    setControlNotice({
      id: rejection.id,
      text: t(`remote_desktop.control_rejected.${rejection.reason}`),
    });
    const timer = setTimeout(() => {
      setControlNotice((current) => (current?.id === rejection.id ? null : current));
    }, CONTROL_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [snapshot.controlRejection?.id, t]);

  useEffect(() => {
    if (!displayModeMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!displayModeMenuRef.current?.contains(event.target as Node)) {
        setDisplayModeMenu(null);
      }
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDisplayModeMenu(null);
    };
    const closeOnResize = () => setDisplayModeMenu(null);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [displayModeMenu]);

  useEffect(() => {
    mediaPresentedRef.current = false;
    setMediaPresented(false);
    if (videoRef.current && videoRef.current.srcObject !== snapshot.stream) {
      videoRef.current.srcObject = snapshot.stream;
    }
  }, [snapshot.stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let disposed = false;
    let callbackId: number | null = null;
    const onPresentedFrame = () => {
      if (disposed) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (!mediaPresentedRef.current) {
          mediaPresentedRef.current = true;
          setMediaPresented(true);
        }
        clientRef.current?.acknowledgePresentedFrame(video.videoWidth, video.videoHeight);
      }
      callbackId = video.requestVideoFrameCallback(onPresentedFrame);
    };
    callbackId = video.requestVideoFrameCallback(onPresentedFrame);
    return () => {
      disposed = true;
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setViewportGeometryRevision((current) => current + 1);
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(refresh)
      : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    if (videoRef.current) observer?.observe(videoRef.current);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, []);

  useEffect(() => {
    const release = () => clientRef.current?.releaseAll();
    const visibility = () => { if (document.visibilityState !== 'visible') release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    const wasEnabled = previousInputEnabledRef.current;
    previousInputEnabledRef.current = snapshot.inputEnabled;
    if (snapshot.inputEnabled || !wasEnabled) return;
    clientRef.current?.releaseAll();
    forwardedCommandCodesRef.current.clear();
    suppressedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    commandMiddleDragPointerRef.current = null;
    heldVirtualButtonsRef.current.clear();
    touchPointsRef.current.clear();
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    virtualMouseDragRef.current = null;
    stopVirtualMouseEdgePan();
  }, [snapshot.inputEnabled]);

  useEffect(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    const display = snapshot.displays.find((candidate) => (
      candidate.id === snapshot.selectedDisplayId
    ));
    const geometry = stage && video ? {
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      contentWidth: video.offsetWidth,
      contentHeight: video.offsetHeight,
    } : null;
    const nextViewport = mobileInputMode === 'mouse' && geometry && display
      ? remoteDesktopMouseModeViewport(display, geometry)
      : INITIAL_REMOTE_DESKTOP_VIEWPORT;
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    if (stage) {
      const nextMouse = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
      virtualMouseRef.current = nextMouse;
      setVirtualMouse(nextMouse);
    }
    touchPointsRef.current.clear();
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    virtualMouseDragRef.current = null;
    virtualMouseEdgePointRef.current = null;
  }, [
    snapshot.selectedDisplayId,
    snapshot.layoutRevision,
    viewScale,
    mobileInputMode,
    viewportGeometryRevision,
  ]);

  const normalizedClientPoint = useCallback((clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const rect = video.getBoundingClientRect();
    return mapRemoteDesktopVideoPoint({
      clientX,
      clientY,
      viewportLeft: rect.left,
      viewportTop: rect.top,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
  }, []);

  const normalizedPoint = useCallback((event: PointerEvent | WheelEvent) => (
    normalizedClientPoint(event.clientX, event.clientY)
  ), [normalizedClientPoint]);

  const normalizedDesktopPointerPoint = useCallback((event: PointerEvent) => {
    const point = normalizedClientPoint(event.clientX, event.clientY);
    return point ? stickRemoteDesktopPointerToEdges(point) : null;
  }, [normalizedClientPoint]);

  const setMode = (mode: typeof REMOTE_DESKTOP_ACCESS_MODE[keyof typeof REMOTE_DESKTOP_ACCESS_MODE]) => {
    clientRef.current?.setMode(mode);
  };

  const retryConnection = () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (reconnectStabilityTimerRef.current) clearTimeout(reconnectStabilityTimerRef.current);
    reconnectStabilityTimerRef.current = null;
    reconnectCountRef.current = 0;
    forceWorkerRecycleRef.current = true;
    setSnapshot((current) => ({
      ...current,
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      inputEnabled: false,
      stream: null,
      reconnectCount: 0,
      error: undefined,
      terminalReason: undefined,
    }));
    setClientGeneration((current) => current + 1);
  };

  const openDisplayModeMenu = (
    displayId: string,
    target: HTMLElement,
    clientX?: number,
    clientY?: number,
  ) => {
    const rect = target.getBoundingClientRect();
    const requestedX = clientX && clientX > 0 ? clientX : rect.left;
    const requestedY = clientY && clientY > 0 ? clientY : rect.bottom;
    setDisplayModeMenu({
      displayId,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 460)),
    });
  };

  const clearDisplayTabLongPress = (pointerId?: number) => {
    const pending = displayTabLongPressRef.current;
    if (!pending || (pointerId !== undefined && pending.pointerId !== pointerId)) return;
    clearTimeout(pending.timer);
    displayTabLongPressRef.current = null;
  };

  const beginDisplayTabLongPress = (event: PointerEvent, displayId: string) => {
    if (event.pointerType !== 'touch') return;
    clearDisplayTabLongPress();
    const target = event.currentTarget as HTMLElement;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const timer = setTimeout(() => {
      const pending = displayTabLongPressRef.current;
      if (!pending || pending.pointerId !== pointerId || pending.displayId !== displayId) return;
      displayTabLongPressRef.current = null;
      suppressDisplayTabClickRef.current = true;
      if (suppressDisplayTabClickTimerRef.current) {
        clearTimeout(suppressDisplayTabClickTimerRef.current);
      }
      suppressDisplayTabClickTimerRef.current = setTimeout(() => {
        suppressDisplayTabClickRef.current = false;
        suppressDisplayTabClickTimerRef.current = null;
      }, 1_000);
      openDisplayModeMenu(displayId, target, start.x, start.y);
    }, 550);
    displayTabLongPressRef.current = { displayId, pointerId, start, timer };
  };

  const moveDisplayTabLongPress = (event: PointerEvent) => {
    const pending = displayTabLongPressRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pending.start.x, event.clientY - pending.start.y) > 10) {
      clearDisplayTabLongPress(event.pointerId);
    }
  };

  const viewportGeometry = () => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return null;
    return {
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      contentWidth: video.offsetWidth,
      contentHeight: video.offsetHeight,
    };
  };

  const commitViewport = (next: RemoteDesktopViewport) => {
    viewportRef.current = next;
    setViewport(next);
  };

  const commitVirtualMouse = (next: TouchPoint) => {
    virtualMouseRef.current = next;
    setVirtualMouse(next);
  };

  const virtualMouseClientPoint = (point = virtualMouseRef.current): TouchPoint | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  };

  const sendVirtualMouseMove = (point = virtualMouseRef.current) => {
    const clientPoint = virtualMouseClientPoint(point);
    if (!clientPoint) return;
    const normalized = normalizedClientPoint(clientPoint.x, clientPoint.y);
    if (normalized) clientRef.current?.pointerMove(normalized.x, normalized.y);
  };

  const scheduleAnimationFrame = (callback: FrameRequestCallback): number => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
  };

  const cancelScheduledAnimationFrame = (handle: number) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
  };

  const stopVirtualMouseEdgePan = () => {
    if (virtualMouseEdgeFrameRef.current !== null) {
      cancelScheduledAnimationFrame(virtualMouseEdgeFrameRef.current);
      virtualMouseEdgeFrameRef.current = null;
    }
    virtualMouseEdgePointRef.current = null;
  };

  const startVirtualMouseEdgePan = () => {
    if (virtualMouseEdgeFrameRef.current !== null) return;
    let previous = performance.now();
    const tick: FrameRequestCallback = (now) => {
      virtualMouseEdgeFrameRef.current = null;
      const drag = virtualMouseDragRef.current;
      const point = virtualMouseEdgePointRef.current;
      const geometry = viewportGeometry();
      if (!drag || drag.kind !== 'move' || !point || !geometry) return;
      const result = panRemoteDesktopViewportAtEdge(
        viewportRef.current,
        point,
        now - previous,
        geometry,
      );
      previous = now;
      if (result.active) {
        commitViewport(result.viewport);
      }
      // Send once more after the viewport reaches its clamp. The previous
      // frame's transform is then visible in the DOM, so source coordinates
      // can reach the exact 0/1 edges instead of stopping a few pixels short.
      sendVirtualMouseMove(point);
      if (result.active) {
        virtualMouseEdgeFrameRef.current = scheduleAnimationFrame(tick);
      }
    };
    virtualMouseEdgeFrameRef.current = scheduleAnimationFrame(tick);
  };

  const localTouchPoint = (event: PointerEvent): TouchPoint | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const beginVirtualMouseMove = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !snapshot.inputEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    virtualMouseDragRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      start: point,
      origin: virtualMouseRef.current,
    };
  };

  const beginVirtualMouseWheel = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !snapshot.inputEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    virtualMouseDragRef.current = {
      kind: 'wheel',
      pointerId: event.pointerId,
      lastY: point.y,
    };
  };

  const onVirtualMouseMove = (event: PointerEvent) => {
    const drag = virtualMouseDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = localTouchPoint(event);
    const stage = stageRef.current;
    if (!point || !stage) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.kind === 'wheel') {
      const delta = point.y - drag.lastY;
      drag.lastY = point.y;
      if (Math.abs(delta) >= 0.5) {
        const clientPoint = virtualMouseClientPoint();
        const normalized = clientPoint
          ? normalizedClientPoint(clientPoint.x, clientPoint.y)
          : null;
        if (normalized) clientRef.current?.wheel(0, delta * 8, normalized.x, normalized.y);
      }
      return;
    }
    const next = {
      x: Math.max(0, Math.min(stage.clientWidth,
        drag.origin.x + point.x - drag.start.x)),
      y: Math.max(0, Math.min(stage.clientHeight,
        drag.origin.y + point.y - drag.start.y)),
    };
    commitVirtualMouse(next);
    virtualMouseEdgePointRef.current = next;
    sendVirtualMouseMove(next);
    const geometry = viewportGeometry();
    if (geometry) {
      const edge = panRemoteDesktopViewportAtEdge(
        viewportRef.current,
        next,
        16,
        geometry,
      );
      if (edge.active) commitViewport(edge.viewport);
    }
    startVirtualMouseEdgePan();
  };

  const endVirtualMouseDrag = (event: PointerEvent) => {
    const drag = virtualMouseDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    virtualMouseDragRef.current = null;
    stopVirtualMouseEdgePan();
  };

  const onVirtualMouseButton = (
    event: PointerEvent,
    button: VirtualMouseButton,
    down: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (down) {
      if (heldVirtualButtonsRef.current.has(event.pointerId)) return;
      const clientPoint = virtualMouseClientPoint();
      const normalized = clientPoint
        ? normalizedClientPoint(clientPoint.x, clientPoint.y)
        : null;
      if (normalized && clientRef.current?.pointerButton(
        button,
        true,
        normalized.x,
        normalized.y,
      )) {
        heldVirtualButtonsRef.current.set(event.pointerId, button);
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }
      return;
    }
    const held = heldVirtualButtonsRef.current.get(event.pointerId);
    if (!held) return;
    heldVirtualButtonsRef.current.delete(event.pointerId);
    const clientPoint = virtualMouseClientPoint();
    const normalized = clientPoint
      ? normalizedClientPoint(clientPoint.x, clientPoint.y)
      : null;
    clientRef.current?.pointerButton(
      held,
      false,
      normalized?.x,
      normalized?.y,
    );
  };

  const cancelVirtualMousePointer = (event: PointerEvent) => {
    endVirtualMouseDrag(event);
    onVirtualMouseButton(event, 'left', false);
  };

  const beginPinch = () => {
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    const points = [...touchPointsRef.current.values()];
    if (points.length < 2) return;
    const [first, second] = points;
    touchGestureRef.current = {
      kind: 'pinch',
      initialCenter: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      initialDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      viewport: viewportRef.current,
    };
  };

  const onTouchDown = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    touchPointsRef.current.set(event.pointerId, point);
    if (touchPointsRef.current.size === 1) {
      const gesture: TouchSingleGesture = {
        kind: 'single',
        pointerId: event.pointerId,
        start: point,
        startedAt: performance.now(),
        moved: false,
        longPressFired: false,
        longPressTimer: null,
        viewport: viewportRef.current,
      };
      gesture.longPressTimer = setTimeout(() => {
        const current = touchGestureRef.current;
        const stage = stageRef.current;
        if (current !== gesture || current.moved || !stage || !snapshot.inputEnabled) return;
        const rect = stage.getBoundingClientRect();
        const normalized = normalizedClientPoint(
          rect.left + current.start.x,
          rect.top + current.start.y,
        );
        if (!normalized) return;
        current.longPressFired = true;
        lastTouchTapRef.current = null;
        lastTouchRemotePointRef.current = normalized;
        clientRef.current?.pointerButton('right', true, normalized.x, normalized.y);
        clientRef.current?.pointerButton('right', false, normalized.x, normalized.y);
      }, TOUCH_LONG_PRESS_MS);
      touchGestureRef.current = gesture;
    } else {
      beginPinch();
    }
  };

  const onTouchMove = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !touchPointsRef.current.has(event.pointerId)) return;
    event.preventDefault();
    touchPointsRef.current.set(event.pointerId, point);
    const geometry = viewportGeometry();
    const gesture = touchGestureRef.current;
    if (!geometry || !gesture) return;
    const points = [...touchPointsRef.current.values()];
    if (points.length >= 2 && gesture.kind === 'pinch') {
      const [first, second] = points;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      commitViewport(viewportFromRemoteDesktopPinch(
        gesture.viewport,
        gesture.initialCenter,
        center,
        gesture.viewport.scale * distance / gesture.initialDistance,
        geometry,
      ));
    } else if (points.length === 1 && gesture.kind === 'single'
      && gesture.pointerId === event.pointerId) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (Math.hypot(dx, dy) > 6 && !gesture.moved) {
        gesture.moved = true;
        if (gesture.longPressTimer) clearTimeout(gesture.longPressTimer);
      }
      if (gesture.moved) {
        commitViewport(clampRemoteDesktopViewport({
          ...gesture.viewport,
          x: gesture.viewport.x + dx,
          y: gesture.viewport.y + dy,
        }, geometry));
      }
    }
  };

  const onTouchEnd = (event: PointerEvent, canceled = false) => {
    const point = localTouchPoint(event);
    const gesture = touchGestureRef.current;
    if (gesture?.kind === 'single' && gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
    }
    const shouldClick = !canceled && point && gesture?.kind === 'single'
      && gesture.pointerId === event.pointerId
      && !gesture.moved
      && !gesture.longPressFired
      && performance.now() - gesture.startedAt <= 600;
    touchPointsRef.current.delete(event.pointerId);
    if (shouldClick) {
      const normalized = normalizedPoint(event);
      if (normalized) {
        const now = performance.now();
        const previous = lastTouchTapRef.current;
        const doubleTap = previous
          && now - previous.at <= TOUCH_DOUBLE_TAP_MS
          && Math.hypot(point.x - previous.point.x, point.y - previous.point.y)
            <= TOUCH_DOUBLE_TAP_DISTANCE_PX;
        const target = doubleTap ? previous.normalized : normalized;
        lastTouchRemotePointRef.current = target;
        clientRef.current?.pointerButton('left', true, target.x, target.y);
        clientRef.current?.pointerButton('left', false, target.x, target.y);
        lastTouchTapRef.current = doubleTap ? null : {
          at: now,
          point,
          normalized,
        };
      }
    }
    const remaining = [...touchPointsRef.current.entries()];
    if (remaining.length === 1) {
      const [pointerId, remainingPoint] = remaining[0];
      touchGestureRef.current = {
        kind: 'single',
        pointerId,
        start: remainingPoint,
        startedAt: performance.now(),
        moved: true,
        longPressFired: false,
        longPressTimer: null,
        viewport: viewportRef.current,
      };
    } else if (remaining.length >= 2) {
      beginPinch();
    } else {
      touchGestureRef.current = null;
    }
  };

  const onTouchRightButton = (event: PointerEvent, down: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const point = lastTouchRemotePointRef.current;
    if (down) {
      if (!snapshot.inputEnabled || heldVirtualButtonsRef.current.has(event.pointerId)) return;
      if (clientRef.current?.pointerButton('right', true, point.x, point.y)) {
        heldVirtualButtonsRef.current.set(event.pointerId, 'right');
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }
      return;
    }
    if (heldVirtualButtonsRef.current.get(event.pointerId) !== 'right') return;
    heldVirtualButtonsRef.current.delete(event.pointerId);
    clientRef.current?.pointerButton('right', false, point.x, point.y);
  };

  const changeZoom = (delta: number) => {
    const geometry = viewportGeometry();
    if (!geometry) return;
    const current = viewportRef.current;
    commitViewport(clampRemoteDesktopViewport({
      ...current,
      scale: current.scale + delta,
    }, geometry));
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      onTouchMove(event);
      return;
    }
    const point = normalizedDesktopPointerPoint(event);
    if (!point) return;
    clientRef.current?.pointerMove(point.x, point.y);
  };

  const suppressCommandControlForMiddleDrag = () => {
    const client = clientRef.current;
    if (!client) return;
    const controlCodes = new Set(forwardedCommandCodesRef.current);
    if (syntheticCommandControlRef.current) controlCodes.add('ControlLeft');
    let released = true;
    for (const code of controlCodes) {
      suppressedCommandCodesRef.current.add(code);
      if (!client.key(code, 'Control', false, false, { control: false, alt: false })) {
        released = false;
      }
    }
    forwardedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    if (!released) client.releaseAll();
  };

  const onPointerButton = (event: PointerEvent, down: boolean) => {
    if (down && snapshot.inputEnabled) {
      stageRef.current?.focus({ preventScroll: true });
    }
    if (event.pointerType === 'touch') {
      if (down) onTouchDown(event);
      else onTouchEnd(event);
      return;
    }
    const startsCommandMiddleDrag = down
      && event.button === 0
      && event.metaKey
      && isAppleControllerPlatform(readControllerPlatform());
    const continuingCommandMiddleDrag = !down
      && commandMiddleDragPointerRef.current === event.pointerId;
    const button = startsCommandMiddleDrag || continuingCommandMiddleDrag ? 'middle'
      : event.button === 0 ? 'left'
      : event.button === 1 ? 'middle'
        : event.button === 2 ? 'right'
          : event.button === 3 ? 'back'
            : event.button === 4 ? 'forward'
              : null;
    if (!button) return;
    const point = normalizedDesktopPointerPoint(event);
    if (down && !point) return;
    event.preventDefault();
    if (down) {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      if (startsCommandMiddleDrag) {
        suppressCommandControlForMiddleDrag();
        commandMiddleDragPointerRef.current = event.pointerId;
      }
    }
    const sent = clientRef.current?.pointerButton(button, down, point?.x, point?.y) ?? false;
    if (startsCommandMiddleDrag && !sent) commandMiddleDragPointerRef.current = null;
    if (continuingCommandMiddleDrag) commandMiddleDragPointerRef.current = null;
  };

  const onWheel = (event: WheelEvent) => {
    const point = normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    clientRef.current?.wheel(event.deltaX, event.deltaY, point.x, point.y);
  };

  const onKey = (event: KeyboardEvent, down: boolean) => {
    if (!snapshot.inputEnabled) return;
    const client = clientRef.current;
    const mapped = mapRemoteDesktopKeyboardEvent(event);
    if (!client || !mapped) return;
    // Copy and paste are answered by the clipboard bridge rather than forwarded
    // blind: the two machines have separate clipboards, so the keystroke alone
    // copies where the operator cannot reach and pastes what they never copied.
    // Copy still reaches the remote — the bridge sends it there to make the
    // selection — so an interrupt in a remote console keeps working.
    const clipboardShortcut = detectRemoteDesktopClipboardShortcut(event);
    if (clipboardShortcut === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE
      && !navigator.clipboard?.readText) {
      // No clipboard read here (Firefox, non-secure contexts): leave the key
      // alone so the browser raises its own paste event, which carries the text
      // without needing permission. Not forwarding it keeps the remote from
      // pasting its own clipboard on top.
      return;
    }
    if (clipboardShortcut) {
      event.preventDefault();
      if (!down) return;
      if (clipboardShortcut === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY) {
        void copyRemoteSelection();
      } else {
        void pasteLocalClipboard();
      }
      return;
    }
    const commandEvent = event.code === 'MetaLeft' || event.code === 'MetaRight';
    if (mapped.commandAsControl && commandEvent
      && suppressedCommandCodesRef.current.has(mapped.code)
      && !syntheticCommandControlRef.current) {
      if (!down) suppressedCommandCodesRef.current.delete(mapped.code);
      event.preventDefault();
      return;
    }
    if (mapped.commandAsControl && commandEvent) {
      if (down) forwardedCommandCodesRef.current.add(mapped.code);
      else forwardedCommandCodesRef.current.delete(mapped.code);
      if (!down && syntheticCommandControlRef.current) {
        client.key('ControlLeft', 'Control', false, false, { control: false, alt: event.altKey });
        syntheticCommandControlRef.current = false;
      }
    } else if (mapped.commandAsControl && event.metaKey
      && forwardedCommandCodesRef.current.size === 0
      && !syntheticCommandControlRef.current) {
      suppressedCommandCodesRef.current.clear();
      syntheticCommandControlRef.current = client.key(
        'ControlLeft',
        'Control',
        true,
        false,
        { control: true, alt: event.altKey },
      );
    } else if (mapped.commandAsControl && !event.metaKey && syntheticCommandControlRef.current) {
      client.key('ControlLeft', 'Control', false, false, { control: false, alt: event.altKey });
      syntheticCommandControlRef.current = false;
    }
    const sent = client.key(mapped.code, mapped.key, down, event.repeat, mapped.modifiers);
    if (sent) {
      if (down && mapped.code === 'KeyV' && mapped.modifiers.control) {
        forwardedPasteShortcutAtRef.current = Date.now();
      }
      event.preventDefault();
    }
    if (mapped.commandAsControl && !commandEvent && !down && event.metaKey
      && forwardedCommandCodesRef.current.size === 0 && syntheticCommandControlRef.current) {
      client.key('ControlLeft', 'Control', false, false, { control: false, alt: event.altKey });
      syntheticCommandControlRef.current = false;
    }
  };

  const releaseCapturedInput = () => {
    forwardedCommandCodesRef.current.clear();
    suppressedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    commandMiddleDragPointerRef.current = null;
    forwardedPasteShortcutAtRef.current = 0;
    clientRef.current?.releaseAll();
  };

  const sendPastedText = (text: string): boolean => {
    if (!snapshot.inputEnabled || !text) return false;
    const sent = clientRef.current?.text(text) ?? false;
    if (sent) stageRef.current?.focus({ preventScroll: true });
    return sent;
  };

  const pasteLocalClipboard = async () => {
    if (!snapshot.inputEnabled) return;
    setClipboardStatus('pasting');
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) {
        setClipboardStatus('empty');
        return;
      }
      setClipboardStatus(sendPastedText(text) ? 'pasted' : 'failed');
    } catch {
      setClipboardStatus('failed');
    }
  };

  const copyRemoteSelection = async () => {
    if (!snapshot.inputEnabled) return;
    setClipboardStatus('copying');
    const text = await clientRef.current?.requestRemoteClipboard();
    if (!text) {
      setClipboardStatus('empty');
      return;
    }
    copyToClipboard(text, () => setClipboardStatus('copied'));
  };

  const stopAndClose = () => {
    clientRef.current?.stop();
    onClose();
  };

  const minimizePanel = () => {
    releaseCapturedInput();
    setDesktopMaximized(false);
    onMinimize?.();
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await panelRef.current?.requestFullscreen();
  };

  const updateTransfer = (id: string, patch: Partial<RemoteDesktopTransferRow>) => {
    setTransfers((current) => current.map((row) => (
      row.id === id ? { ...row, ...patch } : row
    )));
  };

  const sendFile = async (file: File) => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    transferControllersRef.current.set(id, controller);
    setTransfers((current) => [...current, {
      id,
      name: file.name || 'file',
      progress: 0,
      transport: DIRECT_FILE_TRANSFER_STATE.CONNECTING,
      status: 'transferring',
    }]);
    setTransferError(null);
    try {
      await uploadFileWithDirectFallback({
        ws: ws?.targetsServer(machine.serverId) ? ws : null,
        serverId: machine.serverId,
        file,
        ...(supportsDirectoryTransfer && destinationDirectory ? { destinationDirectory } : {}),
        signal: controller.signal,
        onProgress: (progress) => updateTransfer(id, { progress }),
        onMode: (transport) => updateTransfer(id, { transport }),
      });
      updateTransfer(id, { progress: 100, status: 'done' });
    } catch (error) {
      if (isFileUploadCanceled(error)) {
        updateTransfer(id, { status: 'canceled' });
        return;
      }
      updateTransfer(id, { status: 'error' });
      setTransferError(t('remote_desktop.file_transfer_failed'));
    } finally {
      transferControllersRef.current.delete(id);
    }
  };

  const sendFiles = async (files: readonly File[]) => {
    for (const file of files) {
      await sendFile(file);
    }
  };

  const openMobileKeyboard = () => {
    if (!snapshot.inputEnabled) return;
    setMobileTextOpen(true);
    requestAnimationFrame(() => mobileTextInputRef.current?.focus({ preventScroll: true }));
  };

  const submitMobileText = (value: string) => {
    if (!value || !snapshot.inputEnabled) return;
    if (sendPastedText(value) && mobileTextInputRef.current) {
      mobileTextInputRef.current.value = '';
    }
  };

  const sendMobileShortcut = (keys: readonly { code: string; key: string }[]) => {
    const client = clientRef.current;
    if (!client || !snapshot.inputEnabled) return;
    sendRemoteDesktopChord(
      keys,
      (code, key, down, repeat, modifiers) => client.key(code, key, down, repeat, modifiers),
      () => client.releaseAll(),
    );
    mobileTextInputRef.current?.focus({ preventScroll: true });
  };

  const fetchFile = async () => {
    const path = fetchPath.trim();
    if (!path) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    transferControllersRef.current.set(id, controller);
    setTransfers((current) => [...current, {
      id,
      name: path,
      progress: 0,
      transport: DIRECT_FILE_TRANSFER_STATE.RELAY,
      status: 'transferring',
    }]);
    setTransferError(null);
    try {
      const attachment = await createMachineFileHandle(machine.serverId, path, controller.signal);
      updateTransfer(id, { progress: 70 });
      await downloadAttachment(machine.serverId, attachment.id, undefined, controller.signal);
      updateTransfer(id, { progress: 100, status: 'done' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        updateTransfer(id, { status: 'canceled' });
        return;
      }
      updateTransfer(id, { status: 'error' });
      setTransferError(t('remote_desktop.file_transfer_failed'));
    } finally {
      transferControllersRef.current.delete(id);
    }
  };

  const cancelTransfer = (id: string) => {
    transferControllersRef.current.get(id)?.abort();
  };

  const connected = snapshot.state === REMOTE_DESKTOP_STATE.DIRECT
    || snapshot.state === REMOTE_DESKTOP_STATE.RELAYED;
  const selectedDisplay = snapshot.displays.find((display) => display.id === snapshot.selectedDisplayId);
  const currentStreamPresented = Boolean(snapshot.stream
    && mediaPresented
    && videoRef.current?.srcObject === snapshot.stream);
  const activeConnectionStep = activeRemoteDesktopConnectionStep(snapshot, currentStreamPresented);

  return (
    <>
      <div class="remote-desktop-window-host" hidden={minimized}>
        <FloatingPanel
      id={`remote-desktop-${machine.serverId}`}
      title={t('remote_desktop.title', { machine: machine.displayName })}
      onClose={stopAndClose}
      zIndex={zIndex ?? 10020}
      onFocus={onFocus}
      defaultW={1200}
      defaultH={760}
      minW={640}
      minH={420}
      enableMaximize
      isMaximized={desktopMaximized}
      onToggleMaximized={() => setDesktopMaximized((current) => !current)}
      className="remote-desktop-floating-shell"
      hideTitleBar
      dragHandleSelector=".remote-desktop-header"
    >
      <div
        ref={panelRef}
        class="remote-desktop-panel"
        role="dialog"
        aria-modal="false"
        aria-label={t('remote_desktop.title', { machine: machine.displayName })}
      >
        <header class="remote-desktop-header">
          <div>
            <strong>{machine.displayName}</strong>
            <span>{t(`remote_desktop.state.${snapshot.state}`)}</span>
          </div>
          <div class="remote-desktop-presence" aria-live="polite">
            <span>{t('remote_desktop.viewers', { count: snapshot.viewerCount ?? 1 })}</span>
            <span>{t('remote_desktop.controllers', { count: snapshot.controllerCount ?? (snapshot.mode === 'control' ? 1 : 0) })}</span>
          </div>
          <div class="remote-desktop-window-actions">
            {!standalone && allowStandaloneWindow && (
              <button
                type="button"
                class="subsession-minimize-btn remote-desktop-open-window"
                aria-label={t('remote_desktop.open_new_window')}
                title={t('remote_desktop.open_new_window')}
                onClick={() => {
                  if (openRemoteDesktopWindow(machine.serverId)) stopAndClose();
                }}
              >↗</button>
            )}
            <DesktopWindowMaximizeButton
              maximized={desktopMaximized}
              class="subsession-minimize-btn remote-desktop-maximize"
              onClick={() => setDesktopMaximized((current) => !current)}
            />
            {onMinimize && (
              <button
                type="button"
                class="subsession-minimize-btn remote-desktop-minimize"
                aria-label={t('window.minimize')}
                title={t('window.minimize')}
                onClick={minimizePanel}
              >▾</button>
            )}
            <button
              type="button"
              class="subsession-close-btn remote-desktop-stop"
              aria-label={t('remote_desktop.stop')}
              title={t('remote_desktop.stop')}
              onClick={stopAndClose}
            >×</button>
          </div>
        </header>

        <div class="remote-desktop-toolbar">
          <div class="remote-desktop-display-tabs" role="tablist" aria-label={t('remote_desktop.displays')}>
            {snapshot.displays.map((display) => (
              <button
                key={display.id}
                type="button"
                role="tab"
                aria-selected={display.id === snapshot.selectedDisplayId}
                aria-haspopup="menu"
                title={t('remote_desktop.resolution_hint')}
                disabled={!display.available}
                onClick={() => {
                  if (suppressDisplayTabClickRef.current) {
                    suppressDisplayTabClickRef.current = false;
                    if (suppressDisplayTabClickTimerRef.current) {
                      clearTimeout(suppressDisplayTabClickTimerRef.current);
                      suppressDisplayTabClickTimerRef.current = null;
                    }
                    return;
                  }
                  clientRef.current?.selectDisplay(display.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  openDisplayModeMenu(display.id, event.currentTarget);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openDisplayModeMenu(display.id, event.currentTarget, event.clientX, event.clientY);
                }}
                onPointerDown={(event) => beginDisplayTabLongPress(event, display.id)}
                onPointerMove={moveDisplayTabLongPress}
                onPointerUp={(event) => clearDisplayTabLongPress(event.pointerId)}
                onPointerCancel={(event) => clearDisplayTabLongPress(event.pointerId)}
              >
                {display.label}
              </button>
            ))}
          </div>
          <div class="remote-desktop-mode-switch" role="group" aria-label={t('remote_desktop.mode_label')}>
            <button
              type="button"
              aria-pressed={snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW}
              onClick={() => setMode(REMOTE_DESKTOP_ACCESS_MODE.VIEW)}
            >{t('remote_desktop.view_mode')}</button>
            <button
              type="button"
              aria-pressed={snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
              disabled={!connected}
              onClick={() => setMode(REMOTE_DESKTOP_ACCESS_MODE.CONTROL)}
            >{t('remote_desktop.control_mode')}</button>
          </div>
          <div class="remote-desktop-view-switch" role="group" aria-label={t('remote_desktop.scale_label')}>
            <button type="button" aria-pressed={viewScale === 'fit'} onClick={() => setViewScale('fit')}>{t('remote_desktop.fit')}</button>
            <button type="button" aria-pressed={viewScale === 'actual'} onClick={() => setViewScale('actual')}>{t('remote_desktop.actual_size')}</button>
            <button type="button" onClick={() => { void toggleFullscreen(); }}>{t('remote_desktop.fullscreen')}</button>
          </div>
          <div class="remote-desktop-clipboard-switch" role="group" aria-label={t('remote_desktop.clipboard_label')}>
            <button
              type="button"
              disabled={!snapshot.inputEnabled || clipboardStatus === 'copying'}
              onClick={() => { void copyRemoteSelection(); }}
            >{t('remote_desktop.copy_remote_selection')}</button>
            <button
              type="button"
              disabled={!snapshot.inputEnabled || clipboardStatus === 'pasting'}
              onClick={() => { void pasteLocalClipboard(); }}
            >{t('remote_desktop.paste_local_clipboard')}</button>
            <span class="remote-desktop-clipboard-status" aria-live="polite">
              {clipboardStatus === 'idle' ? '' : t(`remote_desktop.clipboard_${clipboardStatus}`)}
            </span>
          </div>
          <div class="remote-desktop-zoom-switch" role="group" aria-label={t('remote_desktop.zoom_label')}>
            <button type="button" aria-label={t('remote_desktop.zoom_out')} disabled={viewport.scale <= 1} onClick={() => changeZoom(-0.5)}>−</button>
            <button type="button" aria-label={t('remote_desktop.zoom_reset')} disabled={viewport.scale === 1 && viewport.x === 0 && viewport.y === 0} onClick={() => commitViewport(INITIAL_REMOTE_DESKTOP_VIEWPORT)}>{Math.round(viewport.scale * 100)}%</button>
            <button type="button" aria-label={t('remote_desktop.zoom_in')} disabled={viewport.scale >= 4} onClick={() => changeZoom(0.5)}>+</button>
          </div>
          <div class="remote-desktop-mobile-input-switch" role="group" aria-label={t('remote_desktop.mobile_input_mode')}>
            <button
              type="button"
              aria-pressed={mobileInputMode === 'touch'}
              onClick={() => setMobileInputMode('touch')}
            >{t('remote_desktop.touch_mode')}</button>
            <button
              type="button"
              aria-pressed={mobileInputMode === 'mouse'}
              onClick={() => setMobileInputMode('mouse')}
            >{t('remote_desktop.mouse_mode')}</button>
            <button
              type="button"
              class="remote-desktop-keyboard-trigger"
              aria-label={t('remote_desktop.mobile_keyboard')}
              aria-expanded={mobileTextOpen}
              aria-pressed={mobileTextOpen}
              disabled={!snapshot.inputEnabled}
              onClick={openMobileKeyboard}
            ><span aria-hidden="true">⌨</span></button>
          </div>
          {snapshot.signInScreen && (
            <button
              type="button"
              class="remote-desktop-unlock-trigger"
              disabled={!snapshot.inputEnabled || !snapshot.unlockAvailable}
              title={snapshot.unlockAvailable
                ? t('remote_desktop.unlock_hint')
                : t('remote_desktop.unlock_unconfigured')}
              onClick={() => { clientRef.current?.requestUnlock(); }}
            >{t('remote_desktop.unlock')}</button>
          )}
          <button
            type="button"
            class="remote-desktop-files-trigger"
            aria-expanded={filePanelOpen}
            aria-pressed={filePanelOpen}
            onClick={() => setFilePanelOpen((open) => !open)}
          >{t('remote_desktop.files')}</button>
        </div>

        {controlNotice && (
          <div class="remote-desktop-control-notice" role="alert">{controlNotice.text}</div>
        )}

        {displayModeMenu && (() => {
          const display = snapshot.displays.find((candidate) => candidate.id === displayModeMenu.displayId);
          if (!display?.available) return null;
          return (
            <div
              ref={displayModeMenuRef}
              class="remote-desktop-resolution-menu"
              role="menu"
              aria-label={t('remote_desktop.resolution_menu', { display: display.label })}
              style={{ left: `${displayModeMenu.x}px`, top: `${displayModeMenu.y}px` }}
            >
              <strong>{t('remote_desktop.resolution_menu', { display: display.label })}</strong>
              {displayModeOptions(display).map((mode) => (
                <button
                  key={`${mode.width}x${mode.height}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={display.width === mode.width && display.height === mode.height}
                  // Clickable whenever this viewer holds control: when input is
                  // not ready the click still gets an explanation, which beats a
                  // grey button that never says why.
                  disabled={snapshot.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
                  onClick={() => {
                    clientRef.current?.setDisplayMode(display.id, mode.width, mode.height);
                    setDisplayModeMenu(null);
                  }}
                >
                  <span>{mode.label ?? `${mode.width}×${mode.height}`}</span>
                  <small>{mode.label ? `${mode.width}×${mode.height}` : ''}</small>
                </button>
              ))}
              {display.modes === undefined && (
                <small class="remote-desktop-resolution-note">
                  {t('remote_desktop.resolution_unreported')}
                </small>
              )}
              <strong>{t('remote_desktop.dpi_menu')}</strong>
              <div class="remote-desktop-dpi-options" role="group" aria-label={t('remote_desktop.dpi_menu')}>
                {REMOTE_DESKTOP_DPI_SCALE_PERCENTS.map((dpiScalePercent) => (
                  <button
                    key={dpiScalePercent}
                    type="button"
                    role="menuitemradio"
                    aria-label={`${dpiScalePercent}% DPI`}
                    aria-checked={Math.round(display.dpiScale * 100) === dpiScalePercent}
                    disabled={snapshot.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
                    onClick={() => {
                      clientRef.current?.setDisplayScale(display.id, dpiScalePercent);
                      setDisplayModeMenu(null);
                    }}
                  >{dpiScalePercent}%</button>
                ))}
              </div>
            </div>
          );
        })()}

        <div
          ref={stageRef}
          class={`remote-desktop-stage is-${viewScale} ${snapshot.inputEnabled ? 'is-controlling' : 'is-viewing'}`}
          tabIndex={snapshot.inputEnabled ? 0 : -1}
          onPointerMove={onPointerMove}
          onPointerEnter={onPointerMove}
          onPointerDown={(event) => onPointerButton(event, true)}
          onPointerUp={(event) => onPointerButton(event, false)}
          onPointerCancel={(event) => {
            if (event.pointerType === 'touch') onTouchEnd(event, true);
            if (commandMiddleDragPointerRef.current === event.pointerId) {
              commandMiddleDragPointerRef.current = null;
            }
            clientRef.current?.releasePointerButtons();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
              onTouchEnd(event, true);
            }
            if (commandMiddleDragPointerRef.current === event.pointerId) {
              commandMiddleDragPointerRef.current = null;
            }
            clientRef.current?.releasePointerButtons();
          }}
          onWheel={onWheel}
          onKeyDown={(event) => onKey(event, true)}
          onKeyUp={(event) => onKey(event, false)}
          onBlur={releaseCapturedInput}
          onContextMenu={(event) => { if (snapshot.inputEnabled) event.preventDefault(); }}
          onCompositionEnd={(event) => {
            if (snapshot.inputEnabled) clientRef.current?.text((event as CompositionEvent).data);
          }}
          onPaste={(event) => {
            if (!snapshot.inputEnabled) return;
            if (Date.now() - forwardedPasteShortcutAtRef.current < 750) {
              forwardedPasteShortcutAtRef.current = 0;
              event.preventDefault();
              return;
            }
            const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
            if (sendPastedText(text)) {
              event.preventDefault();
              setClipboardStatus('pasted');
            }
          }}
        >
          <video
            ref={videoRef}
            autoplay
            playsInline
            muted
            draggable={false}
            onLoadedData={() => {
              if (!mediaPresentedRef.current) {
                mediaPresentedRef.current = true;
                setMediaPresented(true);
              }
            }}
            style={{
              ...(viewScale === 'actual' && selectedDisplay
                ? { width: `${selectedDisplay.width}px`, height: `${selectedDisplay.height}px` }
                : {}),
              transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
              transformOrigin: 'center center',
            }}
            aria-label={t('remote_desktop.video_label', { machine: machine.displayName })}
          />
          {mobileTextOpen && (
            <div class="remote-desktop-mobile-keyboard" role="group" aria-label={t('remote_desktop.mobile_keyboard')}>
              <div class="remote-desktop-mobile-keyboard-head">
                <span aria-hidden="true">⌨</span>
                <button
                  type="button"
                  aria-label={t('remote_desktop.close_mobile_keyboard')}
                  onClick={() => setMobileTextOpen(false)}
                >×</button>
              </div>
              <textarea
                ref={mobileTextInputRef}
                rows={1}
                inputMode="text"
                enterkeyhint="done"
                autocapitalize="none"
                autocomplete="off"
                spellcheck={false}
                aria-label={t('remote_desktop.mobile_text_input')}
                placeholder={t('remote_desktop.mobile_text_input')}
                onCompositionStart={() => { mobileTextComposingRef.current = true; }}
                onCompositionEnd={() => {
                  mobileTextComposingRef.current = false;
                  queueMicrotask(() => {
                    const input = mobileTextInputRef.current;
                    if (input?.value) submitMobileText(input.value);
                  });
                }}
                onInput={(event) => {
                  if (!mobileTextComposingRef.current) {
                    submitMobileText((event.currentTarget as HTMLTextAreaElement).value);
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
                onKeyUp={(event) => event.stopPropagation()}
              />
              <div class="remote-desktop-mobile-shortcuts" aria-label={t('remote_desktop.mobile_shortcuts')}>
                {REMOTE_DESKTOP_MOBILE_SHORTCUTS.map((shortcut) => (
                  <button
                    key={shortcut.id}
                    type="button"
                    aria-label={t(`remote_desktop.shortcut_${shortcut.id}`)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => sendMobileShortcut(shortcut.keys)}
                  >{remoteDesktopShortcutLabel(shortcut.id)}</button>
                ))}
                <button
                  type="button"
                  aria-label={t('remote_desktop.copy_remote_selection')}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => { void copyRemoteSelection(); }}
                >{t('remote_desktop.copy_remote_selection')}</button>
                <button
                  type="button"
                  aria-label={t('remote_desktop.paste_local_clipboard')}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => { void pasteLocalClipboard(); }}
                >{t('remote_desktop.paste_local_clipboard')}</button>
              </div>
            </div>
          )}
          {mobileInputMode === 'mouse' && (
            <>
              <div
                class="remote-desktop-virtual-pointer"
                aria-hidden="true"
                style={{ left: `${virtualMouse.x}px`, top: `${virtualMouse.y}px` }}
              />
              <div
                class="remote-desktop-virtual-mouse"
                role="group"
                aria-label={t('remote_desktop.mouse_controls')}
                onPointerMove={onVirtualMouseMove}
                onPointerUp={endVirtualMouseDrag}
                onPointerCancel={cancelVirtualMousePointer}
                onLostPointerCapture={cancelVirtualMousePointer}
              >
                <div class="remote-desktop-virtual-mouse-buttons">
                  {(['left', 'right'] as const).map((button) => (
                    <button
                      key={button}
                      type="button"
                      aria-label={t(`remote_desktop.mouse_${button}`)}
                      disabled={!snapshot.inputEnabled}
                      onPointerDown={(event) => onVirtualMouseButton(event, button, true)}
                      onPointerUp={(event) => onVirtualMouseButton(event, button, false)}
                      onPointerCancel={(event) => onVirtualMouseButton(event, button, false)}
                      onLostPointerCapture={(event) => onVirtualMouseButton(event, button, false)}
                    >{t(`remote_desktop.mouse_${button}_short`)}</button>
                  ))}
                  <button
                    type="button"
                    class="remote-desktop-virtual-wheel"
                    aria-label={t('remote_desktop.mouse_wheel')}
                    disabled={!snapshot.inputEnabled}
                    onPointerDown={beginVirtualMouseWheel}
                  ><span aria-hidden="true" /></button>
                </div>
                <button
                  type="button"
                  class="remote-desktop-virtual-mouse-handle"
                  aria-label={t('remote_desktop.mouse_drag')}
                  disabled={!snapshot.inputEnabled}
                  onPointerDown={beginVirtualMouseMove}
                ><span aria-hidden="true">✥</span></button>
              </div>
            </>
          )}
          {mobileInputMode === 'touch' && snapshot.inputEnabled && (
            <button
              type="button"
              class="remote-desktop-touch-right-button"
              aria-label={t('remote_desktop.touch_right_click')}
              onPointerDown={(event) => onTouchRightButton(event, true)}
              onPointerUp={(event) => onTouchRightButton(event, false)}
              onPointerCancel={(event) => onTouchRightButton(event, false)}
              onLostPointerCapture={(event) => onTouchRightButton(event, false)}
            >{t('remote_desktop.mouse_right_short')}</button>
          )}
          {!currentStreamPresented && (
            <div class="remote-desktop-stage-placeholder" role="status">
              {snapshot.state === REMOTE_DESKTOP_STATE.FAILED ? (
                <>
                  <span>{t('remote_desktop.failed', { reason: snapshot.error ?? snapshot.terminalReason ?? '' })}</span>
                  <button type="button" onClick={retryConnection}>
                    {t('remote_desktop.retry')}
                  </button>
                </>
              ) : (
                <div class="remote-desktop-connection-progress">
                  <strong>
                    {snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING
                      ? t('remote_desktop.connection_retrying', { count: snapshot.reconnectCount ?? 1 })
                      : t(`remote_desktop.state.${snapshot.state}`)}
                  </strong>
                  {snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING
                    && (snapshot.terminalReason ?? snapshot.error) && (
                    // A reconnect with no reason is the same silent failure as
                    // a click that does nothing: the viewer cannot tell a lost
                    // network from a node that refused, and neither can anyone
                    // they report it to.
                    <small class="remote-desktop-retry-reason">
                      {t('remote_desktop.connection_retrying_reason', {
                        reason: snapshot.terminalReason ?? snapshot.error,
                      })}
                    </small>
                  )}
                  <ol aria-label={t('remote_desktop.connection_progress')}>
                    {REMOTE_DESKTOP_CONNECTION_STEPS.map((step, index) => {
                      const complete = index < activeConnectionStep;
                      const current = index === activeConnectionStep;
                      return (
                        <li
                          key={step}
                          class={complete ? 'is-complete' : current ? 'is-current' : 'is-pending'}
                          aria-current={current ? 'step' : undefined}
                        >
                          <span aria-hidden="true">{complete ? '✓' : index + 1}</span>
                          <span>{t(`remote_desktop.connection_steps.${step}`)}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          )}
          <div class="remote-desktop-touch-hint">
            {t(mobileInputMode === 'mouse'
              ? 'remote_desktop.mouse_hint'
              : 'remote_desktop.touch_hint')}
          </div>
        </div>

        {filePanelOpen && (
          <aside class="remote-desktop-file-drawer" aria-label={t('remote_desktop.files')}>
            <div class="remote-desktop-file-drawer-head">
              <div>
                <strong>{t('remote_desktop.files')}</strong>
                <span>{t('remote_desktop.file_transfer_hint')}</span>
              </div>
              <button
                type="button"
                aria-label={t('remote_desktop.close_files')}
                onClick={() => {
                  setDirectoryPickerOpen(false);
                  setFilePanelOpen(false);
                }}
              >×</button>
            </div>

            {supportsDirectoryTransfer ? (
              <div class="remote-desktop-file-destination">
                <span>{t('remote_desktop.destination_folder')}</span>
                <code title={destinationDirectory || undefined}>
                  {destinationDirectory || t('remote_desktop.choose_destination_folder')}
                </code>
                <button type="button" onClick={() => setDirectoryPickerOpen(true)}>
                  {t('remote_desktop.choose_folder')}
                </button>
              </div>
            ) : (
              <div class="remote-desktop-file-compatibility">
                {t('remote_desktop.file_destination_upgrade_hint')}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={(event) => {
                const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
                if (files.length > 0) void sendFiles(files);
                (event.currentTarget as HTMLInputElement).value = '';
              }}
            />
            <button
              type="button"
              class={`remote-desktop-file-drop${fileDropActive ? ' is-active' : ''}`}
              disabled={supportsDirectoryTransfer && !destinationDirectory}
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                if (!supportsDirectoryTransfer || destinationDirectory) setFileDropActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (!supportsDirectoryTransfer || destinationDirectory) {
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                  setFileDropActive(true);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDropActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setFileDropActive(false);
                if (supportsDirectoryTransfer && !destinationDirectory) return;
                const files = Array.from(event.dataTransfer?.files ?? []);
                if (files.length > 0) void sendFiles(files);
              }}
            >
              <span aria-hidden="true">⇧</span>
              <strong>{supportsDirectoryTransfer && !destinationDirectory
                ? t('remote_desktop.choose_destination_first')
                : t('remote_desktop.drop_files_here')}</strong>
              <small>{t('remote_desktop.drop_files_hint')}</small>
            </button>

            <div class="remote-desktop-fetch-row">
              <input
                value={fetchPath}
                onInput={(event) => setFetchPath((event.currentTarget as HTMLInputElement).value)}
                placeholder={t('remote_desktop.fetch_path')}
                aria-label={t('remote_desktop.fetch_path')}
              />
              <button type="button" disabled={!fetchPath.trim()} onClick={() => { void fetchFile(); }}>
                {t('remote_desktop.fetch_file')}
              </button>
            </div>

            <div class="remote-desktop-transfer-list" aria-live="polite">
              {transfers.map((transfer) => (
                <div class="remote-desktop-transfer-row" key={transfer.id}>
                  <span class="remote-desktop-transfer-name">{transfer.name}</span>
                  <span>{t(`upload.transport.${transfer.transport}`)}</span>
                  <progress
                    value={transfer.progress}
                    max={100}
                    aria-label={t('remote_desktop.transfer_progress', { progress: transfer.progress })}
                  />
                  <span>{t(`remote_desktop.transfer_status_${transfer.status}`)}</span>
                  {transfer.status === 'transferring' && (
                    <button
                      type="button"
                      aria-label={t('remote_desktop.cancel_transfer', { name: transfer.name })}
                      onClick={() => cancelTransfer(transfer.id)}
                    >{t('upload.cancel')}</button>
                  )}
                </div>
              ))}
            </div>
            {transferError && <span role="alert">{transferError}</span>}

            {directoryPickerOpen && machineDirectoryAdapterRef.current && (
              <div class="remote-desktop-directory-picker">
                <FileBrowser
                  key={`${machine.serverId}:${destinationDirectory}`}
                  ws={machineDirectoryAdapterRef.current.asWsClient()}
                  mode="dir-only"
                  layout="panel"
                  initialPath={destinationDirectory || FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES}
                  serverId={`${machine.serverId}:remote-directory`}
                  readOnly
                  onConfirm={(paths) => {
                    const selected = paths[0];
                    if (!selected
                      || selected === FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES
                      || selected === FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES_ROOT) return;
                    setDestinationDirectory(selected);
                    setDirectoryPickerOpen(false);
                  }}
                  onClose={() => setDirectoryPickerOpen(false)}
                />
              </div>
            )}
          </aside>
        )}

        <footer class="remote-desktop-footer">
          <div class="remote-desktop-diagnostics" aria-label={t('remote_desktop.diagnostics')}>
            <span>{t('remote_desktop.route', { route: snapshot.route ?? '—' })}</span>
            {selectedDisplay && <span>{selectedDisplay.width}×{selectedDisplay.height} · {Math.round(selectedDisplay.dpiScale * 100)}% DPI</span>}
            {snapshot.quality && (
              <>
                <span>{snapshot.quality.width}×{snapshot.quality.height} · {snapshot.quality.fps.toFixed(0)} FPS</span>
                <span>{(snapshot.quality.bitrateBps / 1_000_000).toFixed(1)} Mbps · {snapshot.quality.rttMs.toFixed(0)} ms</span>
                <span>{t('remote_desktop.encoder', { encoder: snapshot.quality.encoderClass })}</span>
                <span>{t('remote_desktop.quality', { preset: snapshot.quality.preset })}</span>
                <span>{t('remote_desktop.dropped_frames', { count: snapshot.quality.droppedFrames })}</span>
              </>
            )}
            <span>{t('remote_desktop.duration', { seconds: Math.floor((snapshot.durationMs ?? 0) / 1000) })}</span>
            <span>{t('remote_desktop.reconnects', { count: snapshot.reconnectCount ?? 0 })}</span>
            <span>{t('remote_desktop.capability', { version: snapshot.capabilityVersion ?? REMOTE_DESKTOP_CAPABILITY })}</span>
          </div>
        </footer>
      </div>
        </FloatingPanel>
      </div>
      {minimized && (
        <button
          type="button"
          class="remote-desktop-minimized-dock"
          aria-label={t('remote_desktop.title', { machine: machine.displayName })}
          onClick={onRestore}
        >
          <span class={`remote-desktop-minimized-status${connected ? ' is-online' : ''}`} aria-hidden="true" />
          <span class="remote-desktop-minimized-copy">
            <strong>{machine.displayName}</strong>
            <small>{t(`remote_desktop.state.${snapshot.state}`)}</small>
          </span>
          <span class="remote-desktop-minimized-restore" aria-hidden="true">↗</span>
        </button>
      )}
    </>
  );
}
