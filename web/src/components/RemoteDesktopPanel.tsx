import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  mapRemoteDesktopVideoPoint,
} from '@shared/remote-desktop.js';
import { DIRECT_FILE_TRANSFER_STATE } from '@shared/direct-file-transfer.js';
import { downloadAttachment } from '../api.js';
import { createMachineFileHandle, type MachineListItem } from '../api/machines.js';
import {
  isFileUploadCanceled,
  uploadFileWithDirectFallback,
  type FileUploadTransportMode,
} from '../direct-file-transfer.js';
import { RemoteDesktopClient, type RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import type { WsClient } from '../ws-client.js';
import {
  INITIAL_REMOTE_DESKTOP_VIEWPORT,
  clampRemoteDesktopViewport,
  panRemoteDesktopViewportAtEdge,
  remoteDesktopMouseModeViewport,
  viewportFromRemoteDesktopPinch,
  type RemoteDesktopViewport,
} from '../remote-desktop-viewport.js';

type ViewScale = 'fit' | 'actual';
type MobileInputMode = 'touch' | 'mouse';

interface TouchPoint {
  x: number;
  y: number;
}

type TouchGesture = {
  kind: 'single';
  pointerId: number;
  start: TouchPoint;
  startedAt: number;
  moved: boolean;
  viewport: RemoteDesktopViewport;
} | {
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
const RECONNECTABLE_REMOTE_DESKTOP_FAILURES = new Set<string>([
  REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
  REMOTE_DESKTOP_ERROR.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.BROWSER_DISCONNECTED,
  REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED,
  REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT,
  REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
  REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
]);

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
  onClose(): void;
}

interface RemoteDesktopTransferRow {
  id: string;
  name: string;
  progress: number;
  transport: FileUploadTransportMode;
  status: 'transferring' | 'done' | 'canceled' | 'error';
}

export function RemoteDesktopPanel({ machine, ws = null, onClose }: RemoteDesktopPanelProps) {
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
  const [displayModeMenu, setDisplayModeMenu] = useState<DisplayModeMenuState | null>(null);
  const clientRef = useRef<RemoteDesktopClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const displayModeMenuRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<RemoteDesktopViewport>(INITIAL_REMOTE_DESKTOP_VIEWPORT);
  const virtualMouseRef = useRef<TouchPoint>({ x: 0, y: 0 });
  const virtualMouseDragRef = useRef<VirtualMouseDrag | null>(null);
  const virtualMouseEdgePointRef = useRef<TouchPoint | null>(null);
  const virtualMouseEdgeFrameRef = useRef<number | null>(null);
  const heldVirtualButtonsRef = useRef(new Map<number, VirtualMouseButton>());
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectStabilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferControllersRef = useRef(new Map<string, AbortController>());
  const unmountedRef = useRef(false);
  const displayTabLongPressRef = useRef<DisplayTabLongPress | null>(null);
  const suppressDisplayTabClickRef = useRef(false);
  const suppressDisplayTabClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousInputEnabledRef = useRef(false);

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
      if (next.state === REMOTE_DESKTOP_STATE.FAILED
        && reason && RECONNECTABLE_REMOTE_DESKTOP_FAILURES.has(reason)
        && reconnectCountRef.current < MAX_REMOTE_DESKTOP_RECONNECTS
        && !reconnectTimerRef.current) {
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
    void client.start(reconnectCountRef.current).catch(() => publishSnapshot({
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
    if (displayTabLongPressRef.current) clearTimeout(displayTabLongPressRef.current.timer);
    displayTabLongPressRef.current = null;
    if (suppressDisplayTabClickTimerRef.current) {
      clearTimeout(suppressDisplayTabClickTimerRef.current);
      suppressDisplayTabClickTimerRef.current = null;
    }
  }, []);

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
    heldVirtualButtonsRef.current.clear();
    touchPointsRef.current.clear();
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

  const setMode = (mode: typeof REMOTE_DESKTOP_ACCESS_MODE[keyof typeof REMOTE_DESKTOP_ACCESS_MODE]) => {
    clientRef.current?.setMode(mode);
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
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 244)),
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
        sendVirtualMouseMove(point);
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
      x: Math.max(12, Math.min(stage.clientWidth - 12,
        drag.origin.x + point.x - drag.start.x)),
      y: Math.max(12, Math.min(stage.clientHeight - 12,
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
      touchGestureRef.current = {
        kind: 'single',
        pointerId: event.pointerId,
        start: point,
        startedAt: performance.now(),
        moved: false,
        viewport: viewportRef.current,
      };
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
      if (Math.hypot(dx, dy) > 6) gesture.moved = true;
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
    const shouldClick = !canceled && point && gesture?.kind === 'single'
      && gesture.pointerId === event.pointerId
      && !gesture.moved
      && performance.now() - gesture.startedAt <= 600;
    touchPointsRef.current.delete(event.pointerId);
    if (shouldClick) {
      const normalized = normalizedPoint(event);
      if (normalized) {
        clientRef.current?.pointerButton('left', true, normalized.x, normalized.y);
        clientRef.current?.pointerButton('left', false, normalized.x, normalized.y);
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
        viewport: viewportRef.current,
      };
    } else if (remaining.length >= 2) {
      beginPinch();
    } else {
      touchGestureRef.current = null;
    }
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
    const point = normalizedPoint(event);
    if (point) clientRef.current?.pointerMove(point.x, point.y);
  };

  const onPointerButton = (event: PointerEvent, down: boolean) => {
    if (event.pointerType === 'touch') {
      if (down) onTouchDown(event);
      else onTouchEnd(event);
      return;
    }
    const button = event.button === 0 ? 'left'
      : event.button === 1 ? 'middle'
        : event.button === 2 ? 'right'
          : event.button === 3 ? 'back'
            : event.button === 4 ? 'forward'
              : null;
    if (!button) return;
    const point = normalizedPoint(event);
    if (down && !point) return;
    event.preventDefault();
    if (down) (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    clientRef.current?.pointerButton(button, down, point?.x, point?.y);
  };

  const onWheel = (event: WheelEvent) => {
    const point = normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    clientRef.current?.wheel(event.deltaX, event.deltaY, point.x, point.y);
  };

  const onKey = (event: KeyboardEvent, down: boolean) => {
    if (event.key === 'Escape' && down) {
      event.preventDefault();
      setMode(REMOTE_DESKTOP_ACCESS_MODE.VIEW);
      return;
    }
    if (!snapshot.inputEnabled) return;
    const sent = clientRef.current?.key(event.code, event.key, down, event.repeat, {
      control: event.ctrlKey,
      alt: event.altKey,
    });
    if (sent) event.preventDefault();
  };

  const stopAndClose = () => {
    clientRef.current?.stop();
    onClose();
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

  return (
    <div class="remote-desktop-backdrop" role="presentation" onClick={stopAndClose}>
      <div
        ref={panelRef}
        class="remote-desktop-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('remote_desktop.title', { machine: machine.displayName })}
        onClick={(event) => event.stopPropagation()}
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
          <button type="button" class="remote-desktop-stop" onClick={stopAndClose}>
            {t('remote_desktop.stop')}
          </button>
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
          </div>
        </div>

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
              {REMOTE_DESKTOP_COMMON_DISPLAY_MODES.map((mode) => (
                <button
                  key={`${mode.width}x${mode.height}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={display.width === mode.width && display.height === mode.height}
                  disabled={!snapshot.inputEnabled}
                  onClick={() => {
                    clientRef.current?.setDisplayMode(display.id, mode.width, mode.height);
                    setDisplayModeMenu(null);
                  }}
                >
                  <span>{mode.label}</span>
                  <small>{mode.width}×{mode.height}</small>
                </button>
              ))}
            </div>
          );
        })()}

        <div
          ref={stageRef}
          class={`remote-desktop-stage is-${viewScale} ${snapshot.inputEnabled ? 'is-controlling' : 'is-viewing'}`}
          tabIndex={snapshot.inputEnabled ? 0 : -1}
          onPointerMove={onPointerMove}
          onPointerDown={(event) => onPointerButton(event, true)}
          onPointerUp={(event) => onPointerButton(event, false)}
          onPointerCancel={(event) => {
            if (event.pointerType === 'touch') onTouchEnd(event, true);
            clientRef.current?.releasePointerButtons();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
              onTouchEnd(event, true);
            }
            clientRef.current?.releasePointerButtons();
          }}
          onWheel={onWheel}
          onKeyDown={(event) => onKey(event, true)}
          onKeyUp={(event) => onKey(event, false)}
          onBlur={() => clientRef.current?.releaseAll()}
          onContextMenu={(event) => { if (snapshot.inputEnabled) event.preventDefault(); }}
          onCompositionEnd={(event) => {
            if (snapshot.inputEnabled) clientRef.current?.text((event as CompositionEvent).data);
          }}
        >
          <video
            ref={videoRef}
            autoplay
            playsInline
            muted
            draggable={false}
            style={{
              ...(viewScale === 'actual' && selectedDisplay
                ? { width: `${selectedDisplay.width}px`, height: `${selectedDisplay.height}px` }
                : {}),
              transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
              transformOrigin: 'center center',
            }}
            aria-label={t('remote_desktop.video_label', { machine: machine.displayName })}
          />
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
                  {(['left', 'middle', 'right'] as const).map((button) => (
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
                </div>
                <button
                  type="button"
                  class="remote-desktop-virtual-wheel"
                  aria-label={t('remote_desktop.mouse_wheel')}
                  disabled={!snapshot.inputEnabled}
                  onPointerDown={beginVirtualMouseWheel}
                >↕</button>
                <button
                  type="button"
                  class="remote-desktop-virtual-mouse-handle"
                  aria-label={t('remote_desktop.mouse_drag')}
                  disabled={!snapshot.inputEnabled}
                  onPointerDown={beginVirtualMouseMove}
                >⌖</button>
              </div>
            </>
          )}
          {!snapshot.stream && (
            <div class="remote-desktop-stage-placeholder" role="status">
              {snapshot.state === REMOTE_DESKTOP_STATE.FAILED
                ? t('remote_desktop.failed', { reason: snapshot.error ?? snapshot.terminalReason ?? '' })
                : t('remote_desktop.connecting')}
            </div>
          )}
          {snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL && snapshot.inputEnabled && (
            <div class="remote-desktop-capture-hint">{t('remote_desktop.escape_hint')}</div>
          )}
          <div class="remote-desktop-touch-hint">
            {t(mobileInputMode === 'mouse'
              ? 'remote_desktop.mouse_hint'
              : 'remote_desktop.touch_hint')}
          </div>
        </div>

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
          <div class="remote-desktop-files">
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(event) => {
                const file = (event.currentTarget as HTMLInputElement).files?.[0];
                if (file) void sendFile(file);
                (event.currentTarget as HTMLInputElement).value = '';
              }}
            />
            <button type="button" onClick={() => fileInputRef.current?.click()}>{t('remote_desktop.send_file')}</button>
            <input
              value={fetchPath}
              onInput={(event) => setFetchPath((event.currentTarget as HTMLInputElement).value)}
              placeholder={t('remote_desktop.fetch_path')}
              aria-label={t('remote_desktop.fetch_path')}
            />
            <button type="button" disabled={!fetchPath.trim()} onClick={() => { void fetchFile(); }}>{t('remote_desktop.fetch_file')}</button>
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
          </div>
        </footer>
      </div>
    </div>
  );
}
