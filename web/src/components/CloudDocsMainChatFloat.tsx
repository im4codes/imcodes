import type { ComponentProps } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ChatView } from './ChatView.js';
import { StableSessionControls as SessionControls } from './StableSessionControls.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import type { WsClient } from '../ws-client.js';
import { dispatchSessionSend } from '../session-send-transport.js';
import type { SessionInfo } from '../types.js';
import { requestActiveTimelineRefreshAfterUserAction, useTimeline } from '../hooks/useTimeline.js';
import { getActiveThinkingTs, getTailSessionStateInfo, hasActiveToolCall } from '../thinking-utils.js';
import { hasActiveTimelineTurn, hasPendingUserSend } from '../timeline-running.js';
import { resolveTimelineBackedSessionState } from '../session-live-status.js';
import { resolveSessionInfoRuntimeType } from '../runtime-type.js';
import { formatLabel } from '../format-label.js';
import { isShareScopedState } from '../tab-sharing-ui.js';
import {
  formatCloudDocQuoteBadge,
  getCloudDocQuoteKey,
  sanitizeCloudDocQuoteName,
  sanitizeRemoteDesktopCitationName,
  type CloudDocQuoteTarget,
} from '../cloud-docs-reference.js';
import { acquireWindowPointerInteractionGuard } from './window-drag.js';
import { RESIZE_DIRS, type ResizeDir } from './window-resize.js';
import { getActiveCssZoom, getDomRectToLayoutScale, UI_SCALE_EVENT } from '../ui-scale.js';

export type CloudDocsMainChatSubSession = NonNullable<ComponentProps<typeof SessionControls>['subSessions']>[number];

export interface CloudDocsMainChatContext {
  session: SessionInfo;
  sessions: SessionInfo[];
  subSessions: CloudDocsMainChatSubSession[];
  ws: WsClient | null;
  connected: boolean;
  serverId: string;
  quickData: UseQuickDataResult;
  detectedModel?: string;
}

export const DEFAULT_MINI_CHAT_WIDTH = 380;
export const DEFAULT_MINI_CHAT_MIN_WIDTH = 280;
export const DEFAULT_MINI_CHAT_HEIGHT = 420;
export const DEFAULT_MINI_CHAT_MIN_HEIGHT = 220;

const CONTAINER_EDGE_MARGIN = 8;
const DOCKED_RIGHT_GAP = 14;
const DOCKED_BOTTOM_CLEARANCE = 76;
const DOCKED_FAB_OFFSET_BOTTOM = 62;

interface MiniChatPosition {
  right: number;
  bottom: number;
}

interface StoredMiniChatLayout {
  width: number | null;
  position: MiniChatPosition | null;
}

interface CloudDocsMainChatFloatProps {
  mainChat: CloudDocsMainChatContext;
  activePreviewQuote?: CloudDocQuoteTarget | null;
  onOpenDoc?: (docId: string) => void;
  onRemoteDesktopClick?: (targetId: string) => void;
  heightStorageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  overlayClassName?: string;
  visible?: boolean;
  hideFab?: boolean;
}

function getLayoutStorageKey(heightStorageKey: string | undefined): string | undefined {
  return heightStorageKey ? `${heightStorageKey}:layout` : undefined;
}

function getUnzoomedViewportSize(doc?: Document | null): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const zoom = getActiveCssZoom(doc ?? globalThis.document);
  return {
    width: window.innerWidth > 0 ? window.innerWidth / zoom : 0,
    height: window.innerHeight > 0 ? window.innerHeight / zoom : 0,
  };
}

function sanitizePositiveDimension(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { height?: unknown } | null;
        if (parsed && typeof parsed === 'object' && typeof parsed.height === 'number') {
          return Number.isFinite(parsed.height) && parsed.height > 0 ? parsed.height : null;
        }
      } catch {
        return null;
      }
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function readContainerRectSize(anchorEl: HTMLDivElement | null): { width: number; height: number } {
  const host = anchorEl?.parentElement ?? anchorEl;
  if (!host) return { width: 0, height: 0 };
  const layoutW = host.clientWidth > 0 ? host.clientWidth : host.offsetWidth;
  const layoutH = host.clientHeight > 0 ? host.clientHeight : host.offsetHeight;
  if (layoutW > 0 && layoutH > 0) {
    return { width: layoutW, height: layoutH };
  }
  const rect = host.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return {
      width: layoutW > 0 ? layoutW : 0,
      height: layoutH > 0 ? layoutH : 0,
    };
  }
  const rectScale = getDomRectToLayoutScale(host, anchorEl ? [anchorEl] : undefined);
  return {
    width: layoutW > 0 ? layoutW : rect.width / rectScale,
    height: layoutH > 0 ? layoutH : rect.height / rectScale,
  };
}

function readDockedCssInsets(
  miniEl: HTMLElement | null,
  doc?: Document | null,
): { right: number; bottom: number } {
  const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  if (miniEl && win && typeof win.getComputedStyle === 'function') {
    try {
      const cs = win.getComputedStyle(miniEl);
      const r = Number.parseFloat(cs.right);
      const b = Number.parseFloat(cs.bottom);
      if (Number.isFinite(r) && r >= 0 && Number.isFinite(b) && b >= 0) {
        return { right: Math.round(r), bottom: Math.round(b) };
      }
    } catch {
      /* ignore getComputedStyle errors */
    }
  }
  const isNarrow = Boolean(win?.matchMedia?.('(max-width: 600px)')?.matches);
  return isNarrow
    ? { right: 10, bottom: 58 }
    : { right: DOCKED_RIGHT_GAP, bottom: DOCKED_FAB_OFFSET_BOTTOM };
}

type BoundAxisFloor = {
  value: number;
  containerSize: number;
  inset: number;
};

type DockedAxisFloors = {
  width?: BoundAxisFloor;
  height?: BoundAxisFloor;
} | null;

type AxisConstraints = { width?: number; height?: number } | null;

function resolveAvailableMaxHeight(
  anchorEl: HTMLDivElement | null,
  minHeight: number,
  maxHeightProp?: number,
  docked = true,
  measuredContainerHeight?: number,
  dockedBottomOffset?: number,
  measuredStartFloor?: BoundAxisFloor,
): number | undefined {
  const containerHeight = measuredContainerHeight && measuredContainerHeight > 0
    ? measuredContainerHeight
    : readContainerRectSize(anchorEl).height;
  const viewportHeight = getUnzoomedViewportSize(anchorEl?.ownerDocument).height;
  const bottomInset = dockedBottomOffset ?? DOCKED_FAB_OFFSET_BOTTOM;
  let limit: number | undefined;
  if (containerHeight > 0) {
    const clearance = docked ? bottomInset + CONTAINER_EDGE_MARGIN : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(1, Math.floor(containerHeight - clearance));
    if (
      docked
      && measuredStartFloor
      && Math.round(measuredStartFloor.containerSize) === Math.round(containerHeight)
      && Math.round(measuredStartFloor.inset) === Math.round(bottomInset)
    ) {
      const physicalSpace = Math.max(1, Math.floor(containerHeight - bottomInset));
      limit = Math.max(limit, Math.min(physicalSpace, Math.round(measuredStartFloor.value)));
    }
  } else if (viewportHeight > 0) {
    const fallbackClearance = docked ? bottomInset + CONTAINER_EDGE_MARGIN : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(minHeight, Math.floor(viewportHeight - fallbackClearance));
  }
  if (maxHeightProp != null && Number.isFinite(maxHeightProp) && maxHeightProp > 0) {
    const cappedProp = Math.max(Math.min(minHeight, maxHeightProp), Math.floor(maxHeightProp));
    limit = limit != null ? Math.min(limit, cappedProp) : cappedProp;
  }
  return limit;
}

function resolveAvailableMaxWidth(
  anchorEl: HTMLDivElement | null,
  minWidth: number,
  maxWidthProp?: number,
  docked = true,
  measuredContainerWidth?: number,
  dockedRightOffset?: number,
  measuredStartFloor?: BoundAxisFloor,
): number | undefined {
  const containerWidth = measuredContainerWidth && measuredContainerWidth > 0
    ? measuredContainerWidth
    : readContainerRectSize(anchorEl).width;
  const viewportWidth = getUnzoomedViewportSize(anchorEl?.ownerDocument).width;
  const rightInset = dockedRightOffset ?? DOCKED_RIGHT_GAP;
  let limit: number | undefined;
  if (containerWidth > 0) {
    const clearance = docked ? rightInset + CONTAINER_EDGE_MARGIN : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(1, Math.floor(containerWidth - clearance));
    if (
      docked
      && measuredStartFloor
      && Math.round(measuredStartFloor.containerSize) === Math.round(containerWidth)
      && Math.round(measuredStartFloor.inset) === Math.round(rightInset)
    ) {
      const physicalSpace = Math.max(1, Math.floor(containerWidth - rightInset));
      limit = Math.max(limit, Math.min(physicalSpace, Math.round(measuredStartFloor.value)));
    }
  } else if (viewportWidth > 0) {
    const fallbackClearance = docked ? rightInset + CONTAINER_EDGE_MARGIN : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(minWidth, Math.floor(viewportWidth - fallbackClearance));
  }
  if (maxWidthProp != null && Number.isFinite(maxWidthProp) && maxWidthProp > 0) {
    const cappedProp = Math.max(Math.min(minWidth, maxWidthProp), Math.floor(maxWidthProp));
    limit = limit != null ? Math.min(limit, cappedProp) : cappedProp;
  }
  return limit;
}

function clampMiniChatDimension(
  value: number,
  minValue: number,
  availableMax?: number,
): number {
  const floor = availableMax != null ? Math.min(minValue, availableMax) : minValue;
  const upper = availableMax != null ? Math.max(floor, availableMax) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(upper, Math.max(floor, value)));
}

function resolveEffectiveMiniChatAxisSize(
  customSize: number | null,
  undockedCap: number | undefined,
  undockedMinFloor: number | undefined,
  minSize: number,
  containerMax: number | undefined,
): number | undefined {
  const candidate = customSize ?? undockedCap;
  if (candidate == null) return undefined;
  const effectiveMin = undockedMinFloor != null ? Math.min(minSize, undockedMinFloor) : minSize;
  const upper = undockedCap != null
    ? (containerMax != null ? Math.min(containerMax, undockedCap) : undockedCap)
    : containerMax;
  return clampMiniChatDimension(candidate, effectiveMin, upper);
}

function clearAxisConstraint<T>(
  prev: { width?: T; height?: T } | null,
  clearW: boolean,
  clearH: boolean,
): { width?: T; height?: T } | null {
  if (!prev) return null;
  const nextW = clearW ? undefined : prev.width;
  const nextH = clearH ? undefined : prev.height;
  return nextW == null && nextH == null ? null : { width: nextW, height: nextH };
}

function clampAxisPosition(pos: number, boxSize: number, boundsSize: number): number {
  if (boundsSize <= 0) return Math.max(0, Math.round(pos));
  const minPos = Math.min(CONTAINER_EDGE_MARGIN, Math.max(0, boundsSize - boxSize));
  const maxPos = Math.max(minPos, boundsSize - boxSize - CONTAINER_EDGE_MARGIN);
  return Math.round(Math.min(maxPos, Math.max(minPos, pos)));
}

function clampMiniChatPosition(
  pos: MiniChatPosition,
  boxWidth: number,
  boxHeight: number,
  containerWidth: number,
  containerHeight: number,
  doc?: Document | null,
): MiniChatPosition {
  const viewport = getUnzoomedViewportSize(doc);
  const boundsW = containerWidth > 0 ? containerWidth : viewport.width;
  const boundsH = containerHeight > 0 ? containerHeight : viewport.height;
  return {
    right: clampAxisPosition(pos.right, boxWidth, boundsW),
    bottom: clampAxisPosition(pos.bottom, boxHeight, boundsH),
  };
}

function readStoredMiniChatHeight(
  storageKey: string | undefined,
  minHeight: number,
  maxHeightProp?: number,
): number | null {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = sanitizePositiveDimension(raw);
    if (parsed === null) return null;
    const maxBound = maxHeightProp != null && Number.isFinite(maxHeightProp) && maxHeightProp > 0
      ? Math.max(minHeight, Math.floor(maxHeightProp))
      : undefined;
    return clampMiniChatDimension(parsed, minHeight, maxBound);
  } catch {
    return null;
  }
}

function writeStoredMiniChatHeight(storageKey: string | undefined, height: number): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, String(Math.round(height)));
  } catch {
    /* ignore storage quota / restricted storage failures */
  }
}

function readStoredMiniChatLayout(
  heightStorageKey: string | undefined,
  minWidth: number,
  maxWidthProp?: number,
): StoredMiniChatLayout {
  const key = getLayoutStorageKey(heightStorageKey);
  if (!key || typeof window === 'undefined') return { width: null, position: null };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { width: null, position: null };
    const parsed = JSON.parse(raw) as {
      width?: unknown;
      right?: unknown;
      bottom?: unknown;
      x?: unknown;
      y?: unknown;
    } | null;
    if (!parsed || typeof parsed !== 'object') return { width: null, position: null };

    let width: number | null = null;
    if (typeof parsed.width === 'number' && Number.isFinite(parsed.width) && parsed.width > 0) {
      const maxBound = maxWidthProp != null && Number.isFinite(maxWidthProp) && maxWidthProp > 0
        ? Math.max(minWidth, Math.floor(maxWidthProp))
        : undefined;
      width = clampMiniChatDimension(parsed.width, minWidth, maxBound);
    }

    // Only accept bottom-right anchored positions; drop legacy top-left {x, y}
    // so enabling/changing UI scale returns legacy configs cleanly to bottom-right.
    let position: MiniChatPosition | null = null;
    if (
      typeof parsed.right === 'number' && Number.isFinite(parsed.right) && parsed.right >= 0
      && typeof parsed.bottom === 'number' && Number.isFinite(parsed.bottom) && parsed.bottom >= 0
    ) {
      position = { right: Math.round(parsed.right), bottom: Math.round(parsed.bottom) };
    }

    return { width, position };
  } catch {
    return { width: null, position: null };
  }
}

function writeStoredMiniChatLayout(
  heightStorageKey: string | undefined,
  layout: StoredMiniChatLayout,
): void {
  const key = getLayoutStorageKey(heightStorageKey);
  if (!key || typeof window === 'undefined') return;
  const payload: Record<string, number> = {};
  if (layout.width != null && Number.isFinite(layout.width) && layout.width > 0) {
    payload.width = Math.round(layout.width);
  }
  if (layout.position && Number.isFinite(layout.position.right) && Number.isFinite(layout.position.bottom)) {
    payload.right = Math.round(Math.max(0, layout.position.right));
    payload.bottom = Math.round(Math.max(0, layout.position.bottom));
  }
  try {
    if (Object.keys(payload).length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(payload));
    }
  } catch {
    /* ignore storage quota / restricted storage failures */
  }
}

export function CloudDocsMainChatFloat({
  mainChat,
  activePreviewQuote = null,
  onOpenDoc,
  onRemoteDesktopClick,
  heightStorageKey,
  defaultWidth = DEFAULT_MINI_CHAT_WIDTH,
  minWidth = DEFAULT_MINI_CHAT_MIN_WIDTH,
  maxWidth,
  defaultHeight = DEFAULT_MINI_CHAT_HEIGHT,
  minHeight = DEFAULT_MINI_CHAT_MIN_HEIGHT,
  maxHeight,
  overlayClassName,
  visible = true,
  hideFab = false,
}: CloudDocsMainChatFloatProps) {
  const { t } = useTranslation();
  const safeMinWidth = useMemo(
    () => (Number.isFinite(minWidth) && minWidth > 0 ? minWidth : DEFAULT_MINI_CHAT_MIN_WIDTH),
    [minWidth],
  );
  const safeDefaultWidth = useMemo(
    () => (Number.isFinite(defaultWidth) && defaultWidth > 0 ? Math.max(safeMinWidth, defaultWidth) : DEFAULT_MINI_CHAT_WIDTH),
    [defaultWidth, safeMinWidth],
  );
  const safeMinHeight = useMemo(
    () => (Number.isFinite(minHeight) && minHeight > 0 ? minHeight : DEFAULT_MINI_CHAT_MIN_HEIGHT),
    [minHeight],
  );
  const safeDefaultHeight = useMemo(
    () => (Number.isFinite(defaultHeight) && defaultHeight > 0 ? Math.max(safeMinHeight, defaultHeight) : DEFAULT_MINI_CHAT_HEIGHT),
    [defaultHeight, safeMinHeight],
  );
  const resizable = Boolean(heightStorageKey);
  const [expanded, setExpanded] = useState(false);
  const [dismissedDocKey, setDismissedDocKey] = useState<string | null>(null);
  const [extraQuotes, setExtraQuotes] = useState<string[]>([]);
  const [customHeight, setCustomHeight] = useState<number | null>(() => (
    readStoredMiniChatHeight(heightStorageKey, safeMinHeight, maxHeight)
  ));
  const [customWidth, setCustomWidth] = useState<number | null>(() => (
    readStoredMiniChatLayout(heightStorageKey, safeMinWidth, maxWidth).width
  ));
  const [customPosition, setCustomPosition] = useState<MiniChatPosition | null>(() => (
    readStoredMiniChatLayout(heightStorageKey, safeMinWidth, maxWidth).position
  ));
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [uiScaleZoom, setUiScaleZoom] = useState<number>(() => getActiveCssZoom());
  const [dockedInsets, setDockedInsets] = useState<{ right: number; bottom: number } | null>(null);
  const [dockedFloor, setDockedFloor] = useState<DockedAxisFloors>(null);
  const [undockedSizeCap, setUndockedSizeCap] = useState<AxisConstraints>(null);
  const [undockedMinFloor, setUndockedMinFloor] = useState<AxisConstraints>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [activeResizeDir, setActiveResizeDir] = useState<ResizeDir | null>(null);
  const [isEntering, setIsEntering] = useState<boolean>(() => visible);
  const [entranceEpoch, setEntranceEpoch] = useState<number>(() => (visible ? 1 : 0));
  const prevVisibleRef = useRef<boolean>(visible);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const miniChatRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const resizeHandleRefs = useRef<Partial<Record<ResizeDir, HTMLDivElement | null>>>({});
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) {
      setIsEntering(false);
      return;
    }
    if (!wasVisible && visible) {
      setEntranceEpoch((epoch) => epoch + 1);
      setIsEntering(true);
    }
  }, [visible]);

  useEffect(() => {
    if (!isEntering || typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => {
      setIsEntering(false);
    }, 950);
    return () => window.clearTimeout(timer);
  }, [isEntering, entranceEpoch]);

  useEffect(() => {
    setCustomHeight(readStoredMiniChatHeight(heightStorageKey, safeMinHeight, maxHeight));
    const storedLayout = readStoredMiniChatLayout(heightStorageKey, safeMinWidth, maxWidth);
    setCustomWidth(storedLayout.width);
    setCustomPosition(storedLayout.position);
    setDockedInsets(null);
    setDockedFloor(null);
    setUndockedSizeCap(null);
    setUndockedMinFloor(null);
  }, [heightStorageKey, maxHeight, maxWidth, safeMinHeight, safeMinWidth]);

  useEffect(() => {
    if (!expanded) {
      setDockedFloor(null);
      return undefined;
    }
    if (customPosition !== null) {
      setDockedFloor(null);
    }
    const syncContainerSize = () => {
      const next = readContainerRectSize(anchorRef.current);
      setContainerSize((prev) => {
        if (prev.width === next.width && prev.height === next.height) return prev;
        const changedW = prev.width > 0 && next.width !== prev.width;
        const changedH = prev.height > 0 && next.height !== prev.height;
        if (changedW || changedH) {
          setDockedFloor((floor) => clearAxisConstraint(floor, changedW, changedH));
        }
        const grewW = prev.width > 0 && next.width > prev.width;
        const grewH = prev.height > 0 && next.height > prev.height;
        if (grewW || grewH) {
          setUndockedSizeCap((cap) => clearAxisConstraint(cap, grewW, grewH));
          setUndockedMinFloor((floor) => clearAxisConstraint(floor, grewW, grewH));
        }
        return next;
      });
      if (customPosition === null) {
        const nextInsets = readDockedCssInsets(miniChatRef.current, anchorRef.current?.ownerDocument);
        setDockedInsets((prev) => {
          if (prev && prev.right === nextInsets.right && prev.bottom === nextInsets.bottom) return prev;
          if (prev) {
            setDockedFloor((floor) => clearAxisConstraint(
              floor,
              prev.right !== nextInsets.right,
              prev.bottom !== nextInsets.bottom,
            ));
          }
          return nextInsets;
        });
      }
      const nextZoom = getActiveCssZoom(anchorRef.current?.ownerDocument);
      setUiScaleZoom((prevZoom) => {
        if (Math.abs(nextZoom - prevZoom) > 0.0005) {
          setDockedFloor(null);
        }
        if (nextZoom < prevZoom - 0.0005) {
          setUndockedSizeCap(null);
          setUndockedMinFloor(null);
        }
        return nextZoom;
      });
    };
    syncContainerSize();
    const host = anchorRef.current?.parentElement ?? anchorRef.current;
    let observer: ResizeObserver | null = null;
    if (host && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => syncContainerSize());
      observer.observe(host);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncContainerSize);
      window.addEventListener(UI_SCALE_EVENT, syncContainerSize);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', syncContainerSize);
        window.removeEventListener(UI_SCALE_EVENT, syncContainerSize);
      }
    };
  }, [customPosition, expanded]);

  useEffect(() => () => {
    cleanupDragRef.current?.();
  }, []);

  const dockedMode = customPosition === null;
  const containerMaxHeight = useMemo(
    () => resolveAvailableMaxHeight(
      anchorRef.current,
      safeMinHeight,
      maxHeight,
      dockedMode,
      containerSize.height,
      dockedMode ? dockedInsets?.bottom : undefined,
      dockedMode ? dockedFloor?.height : undefined,
    ),
    [containerSize.height, dockedFloor, dockedInsets?.bottom, dockedMode, maxHeight, safeMinHeight, uiScaleZoom],
  );
  const containerMaxWidth = useMemo(
    () => resolveAvailableMaxWidth(
      anchorRef.current,
      safeMinWidth,
      maxWidth,
      dockedMode,
      containerSize.width,
      dockedMode ? dockedInsets?.right : undefined,
      dockedMode ? dockedFloor?.width : undefined,
    ),
    [containerSize.width, dockedFloor, dockedInsets?.right, dockedMode, maxWidth, safeMinWidth, uiScaleZoom],
  );

  const effectiveMiniChatHeight = useMemo(
    () => (resizable
      ? resolveEffectiveMiniChatAxisSize(
        customHeight,
        undockedSizeCap?.height,
        undockedMinFloor?.height,
        safeMinHeight,
        containerMaxHeight,
      )
      : undefined),
    [containerMaxHeight, customHeight, resizable, safeMinHeight, undockedMinFloor?.height, undockedSizeCap?.height],
  );

  const effectiveMiniChatWidth = useMemo(
    () => (resizable
      ? resolveEffectiveMiniChatAxisSize(
        customWidth,
        undockedSizeCap?.width,
        undockedMinFloor?.width,
        safeMinWidth,
        containerMaxWidth,
      )
      : undefined),
    [containerMaxWidth, customWidth, resizable, safeMinWidth, undockedMinFloor?.width, undockedSizeCap?.width],
  );

  const effectiveMiniChatPosition = useMemo(() => {
    if (!customPosition) return null;
    const boxW = effectiveMiniChatWidth
      ?? (containerSize.width > 0
        ? Math.min(safeDefaultWidth, Math.max(1, containerSize.width - DOCKED_RIGHT_GAP * 2))
        : safeDefaultWidth);
    const boxH = effectiveMiniChatHeight
      ?? (containerSize.height > 0
        ? Math.min(safeDefaultHeight, Math.max(1, containerSize.height - DOCKED_BOTTOM_CLEARANCE))
        : safeDefaultHeight);
    return clampMiniChatPosition(
      customPosition,
      boxW,
      boxH,
      containerSize.width,
      containerSize.height,
      anchorRef.current?.ownerDocument,
    );
  }, [
    containerSize.height,
    containerSize.width,
    customPosition,
    effectiveMiniChatHeight,
    effectiveMiniChatWidth,
    safeDefaultHeight,
    safeDefaultWidth,
    uiScaleZoom,
  ]);

  const beginPointerInteraction = useCallback((
    event: PointerEvent,
    callbacks: {
      onMove: (dx: number, dy: number) => void;
      onCommit: () => void;
    },
  ) => {
    if (typeof event.button === 'number' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDragRef.current?.();

    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const captureEl = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const doc = captureEl?.ownerDocument ?? anchorRef.current?.ownerDocument ?? document;
    if (captureEl && pointerId != null && typeof captureEl.setPointerCapture === 'function') {
      try {
        captureEl.setPointerCapture(pointerId);
      } catch {
        /* jsdom / synthetic pointer events without an active pointer */
      }
    }
    const releaseGuard = acquireWindowPointerInteractionGuard(doc);
    let cleaned = false;

    const onMove = (moveEvent: PointerEvent) => {
      if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId) return;
      const cssZoom = getActiveCssZoom(doc);
      callbacks.onMove((moveEvent.clientX - startX) / cssZoom, (moveEvent.clientY - startY) / cssZoom);
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      if (captureEl && pointerId != null && typeof captureEl.releasePointerCapture === 'function') {
        try {
          if (!captureEl.hasPointerCapture || captureEl.hasPointerCapture(pointerId)) {
            captureEl.releasePointerCapture(pointerId);
          }
        } catch {
          /* ignore release errors on synthetic/detached targets */
        }
      }
      releaseGuard();
      cleanupDragRef.current = null;
      setIsDragging(false);
      setIsResizing(false);
      setActiveResizeDir(null);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (pointerId != null && upEvent.pointerId != null && upEvent.pointerId !== pointerId) return;
      cleanup();
      callbacks.onCommit();
    };

    const onCancel = (cancelEvent: PointerEvent) => {
      if (pointerId != null && cancelEvent.pointerId != null && cancelEvent.pointerId !== pointerId) return;
      cleanup();
    };

    const onBlur = () => {
      cleanup();
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
  }, []);

  const resolveCurrentBox = useCallback(() => {
    const anchorEl = anchorRef.current;
    const hostEl = anchorEl?.parentElement ?? null;
    const miniEl = miniChatRef.current;
    const anchorRect = anchorEl?.getBoundingClientRect?.();
    const containerRect = anchorRect && anchorRect.width > 0 ? anchorRect : hostEl?.getBoundingClientRect?.();
    const miniRect = miniEl?.getBoundingClientRect?.();
    const measured = readContainerRectSize(anchorEl);
    const cw = measured.width > 0 ? measured.width : (containerSize.width > 0 ? containerSize.width : 0);
    const ch = measured.height > 0 ? measured.height : (containerSize.height > 0 ? containerSize.height : 0);
    const calibrationFallbacks = [miniEl, hostEl].filter((el): el is HTMLElement => Boolean(el));
    const rectScale = getDomRectToLayoutScale(anchorEl, calibrationFallbacks);
    const startW = miniEl && miniEl.offsetWidth > 0
      ? Math.round(miniEl.offsetWidth)
      : (miniRect && miniRect.width > 0
        ? Math.round(miniRect.width / rectScale)
        : (effectiveMiniChatWidth ?? safeDefaultWidth));
    const startH = miniEl && miniEl.offsetHeight > 0
      ? Math.round(miniEl.offsetHeight)
      : (miniRect && miniRect.height > 0
        ? Math.round(miniRect.height / rectScale)
        : (effectiveMiniChatHeight ?? safeDefaultHeight));

    let startPos: MiniChatPosition;
    if (effectiveMiniChatPosition) {
      startPos = effectiveMiniChatPosition;
    } else if (containerRect && miniRect && containerRect.width > 0 && miniRect.width > 0) {
      startPos = {
        right: Math.max(0, Math.round((containerRect.right - miniRect.right) / rectScale)),
        bottom: Math.max(0, Math.round((containerRect.bottom - miniRect.bottom) / rectScale)),
      };
    } else {
      startPos = {
        right: DOCKED_RIGHT_GAP,
        bottom: DOCKED_FAB_OFFSET_BOTTOM,
      };
    }

    return { cw, ch, startW, startH, startPos };
  }, [
    containerSize.height,
    containerSize.width,
    effectiveMiniChatHeight,
    effectiveMiniChatPosition,
    effectiveMiniChatWidth,
    safeDefaultHeight,
    safeDefaultWidth,
  ]);

  const handleHeaderPointerDown = useCallback((event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], .mini-chat-resize-handle')) {
      return;
    }
    if (typeof event.button === 'number' && event.button !== 0) return;

    const { cw, ch, startW, startH, startPos } = resolveCurrentBox();
    const undockingFromDock = customPosition === null;
    let latestPos: MiniChatPosition | null = null;
    setIsDragging(true);

    beginPointerInteraction(event, {
      onMove: (dx, dy) => {
        if (dx === 0 && dy === 0 && latestPos === null) return;
        const latestContainer = readContainerRectSize(anchorRef.current);
        const liveW = latestContainer.width > 0 ? latestContainer.width : cw;
        const liveH = latestContainer.height > 0 ? latestContainer.height : ch;
        if (liveW > 0 || liveH > 0) {
          setContainerSize((prev) => (prev.width === liveW && prev.height === liveH ? prev : { width: liveW, height: liveH }));
        }
        if (undockingFromDock) {
          setUndockedSizeCap((prev) => prev ?? { width: startW, height: startH });
        }
        const clamped = clampMiniChatPosition(
          { right: startPos.right - dx, bottom: startPos.bottom - dy },
          startW,
          startH,
          liveW,
          liveH,
          anchorRef.current?.ownerDocument,
        );
        latestPos = clamped;
        setCustomPosition(clamped);
      },
      onCommit: () => {
        if (latestPos !== null && resizable) {
          writeStoredMiniChatLayout(heightStorageKey, {
            width: customWidth,
            position: latestPos,
          });
        }
      },
    });
  }, [beginPointerInteraction, customPosition, customWidth, heightStorageKey, resizable, resolveCurrentBox]);

  const handleResizePointerDown = useCallback((dir: ResizeDir, event: PointerEvent) => {
    if (!resizable) return;
    if (typeof event.button === 'number' && event.button !== 0) return;

    const { cw, ch, startW, startH, startPos } = resolveCurrentBox();
    const undockingFromDock = customPosition === null;
    const anchoredBottomRight = undockingFromDock && !dir.includes('e') && !dir.includes('s');
    const operatesHorizontal = dir.includes('w') || dir.includes('e');
    const operatesVertical = dir.includes('n') || dir.includes('s');
    let latestHeight: number | null = null;
    let latestWidth: number | null = null;
    let latestPosition: MiniChatPosition | null = null;
    let didMutateWidth = false;
    let didMutateHeight = false;

    setIsResizing(true);
    setActiveResizeDir(dir);

    beginPointerInteraction(event, {
      onMove: (dx, dy) => {
        const latestContainer = readContainerRectSize(anchorRef.current);
        const liveW = latestContainer.width > 0 ? latestContainer.width : cw;
        const liveH = latestContainer.height > 0 ? latestContainer.height : ch;
        if (liveW > 0 || liveH > 0) {
          setContainerSize((prev) => (prev.width === liveW && prev.height === liveH ? prev : { width: liveW, height: liveH }));
        }

        const maxW = resolveAvailableMaxWidth(anchorRef.current, safeMinWidth, maxWidth, anchoredBottomRight, liveW);
        const maxH = resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight, anchoredBottomRight, liveH);

        if (anchoredBottomRight) {
          setDockedInsets((prev) => (
            prev && prev.right === startPos.right && prev.bottom === startPos.bottom
              ? prev
              : { right: startPos.right, bottom: startPos.bottom }
          ));
          const startFloorW: BoundAxisFloor | undefined = liveW > 0
            ? { value: startW, containerSize: liveW, inset: startPos.right }
            : undefined;
          const startFloorH: BoundAxisFloor | undefined = liveH > 0
            ? { value: startH, containerSize: liveH, inset: startPos.bottom }
            : undefined;
          setDockedFloor((prev) => (
            prev
              && prev.width?.value === startFloorW?.value
              && prev.width?.containerSize === startFloorW?.containerSize
              && prev.width?.inset === startFloorW?.inset
              && prev.height?.value === startFloorH?.value
              && prev.height?.containerSize === startFloorH?.containerSize
              && prev.height?.inset === startFloorH?.inset
              ? prev
              : (startFloorW || startFloorH ? { width: startFloorW, height: startFloorH } : null)
          ));
          const dockedMaxW = resolveAvailableMaxWidth(
            anchorRef.current,
            safeMinWidth,
            maxWidth,
            true,
            liveW,
            startPos.right,
            startFloorW,
          );
          const dockedMaxH = resolveAvailableMaxHeight(
            anchorRef.current,
            safeMinHeight,
            maxHeight,
            true,
            liveH,
            startPos.bottom,
            startFloorH,
          );
          if (dir.includes('n')) {
            const dockedMinH = Math.min(safeMinHeight, dockedMaxH ?? safeMinHeight, startH);
            const nextH = clampMiniChatDimension(startH - dy, dockedMinH, dockedMaxH);
            if (didMutateHeight || nextH !== startH) {
              didMutateHeight = true;
              latestHeight = nextH;
              setUndockedMinFloor((prev) => {
                const floorH = nextH < Math.min(safeMinHeight, dockedMaxH ?? safeMinHeight) ? nextH : undefined;
                const w = prev?.width;
                return w == null && floorH == null ? null : { width: w, height: floorH };
              });
              setCustomHeight(nextH);
            }
          }
          if (dir.includes('w')) {
            const dockedMinW = Math.min(safeMinWidth, dockedMaxW ?? safeMinWidth, startW);
            const nextW = clampMiniChatDimension(startW - dx, dockedMinW, dockedMaxW);
            if (didMutateWidth || nextW !== startW) {
              didMutateWidth = true;
              latestWidth = nextW;
              setUndockedMinFloor((prev) => {
                const floorW = nextW < Math.min(safeMinWidth, dockedMaxW ?? safeMinWidth) ? nextW : undefined;
                const h = prev?.height;
                return floorW == null && h == null ? null : { width: floorW, height: h };
              });
              setCustomWidth(nextW);
            }
          }
          return;
        }

        const viewport = getUnzoomedViewportSize(anchorRef.current?.ownerDocument);
        const boundsW = liveW > 0 ? liveW : viewport.width;
        const boundsH = liveH > 0 ? liveH : viewport.height;
        const effMinW = maxW != null ? Math.min(safeMinWidth, maxW) : safeMinWidth;
        const effMinH = maxH != null ? Math.min(safeMinHeight, maxH) : safeMinHeight;
        const interactMinW = Math.min(effMinW, startW);
        const interactMinH = Math.min(effMinH, startH);

        let nextRight = startPos.right;
        let nextW = startW;
        if (dir.includes('w')) {
          const leftLimitW = boundsW > 0
            ? Math.max(interactMinW, boundsW - CONTAINER_EDGE_MARGIN - startPos.right)
            : Number.POSITIVE_INFINITY;
          const upperW = maxW != null ? Math.min(maxW, leftLimitW) : leftLimitW;
          nextW = clampMiniChatDimension(startW - dx, interactMinW, upperW);
        } else if (dir.includes('e')) {
          const minRight = boundsW > 0 ? Math.min(CONTAINER_EDGE_MARGIN, startPos.right) : Number.NEGATIVE_INFINITY;
          const maxRight = startPos.right + startW - interactMinW;
          let clampedRight = Math.max(minRight, Math.min(maxRight, startPos.right - dx));
          if (maxW != null && startPos.right + startW - clampedRight > maxW) {
            clampedRight = startPos.right + startW - maxW;
          }
          nextRight = Math.round(clampedRight);
          nextW = Math.round(startPos.right + startW - nextRight);
        }

        let nextBottom = startPos.bottom;
        let nextH = startH;
        if (dir.includes('n')) {
          const topLimitH = boundsH > 0
            ? Math.max(interactMinH, boundsH - CONTAINER_EDGE_MARGIN - startPos.bottom)
            : Number.POSITIVE_INFINITY;
          const upperH = maxH != null ? Math.min(maxH, topLimitH) : topLimitH;
          nextH = clampMiniChatDimension(startH - dy, interactMinH, upperH);
        } else if (dir.includes('s')) {
          const minBottom = boundsH > 0 ? Math.min(CONTAINER_EDGE_MARGIN, startPos.bottom) : Number.NEGATIVE_INFINITY;
          const maxBottom = startPos.bottom + startH - interactMinH;
          let clampedBottom = Math.max(minBottom, Math.min(maxBottom, startPos.bottom - dy));
          if (maxH != null && startPos.bottom + startH - clampedBottom > maxH) {
            clampedBottom = startPos.bottom + startH - maxH;
          }
          nextBottom = Math.round(clampedBottom);
          nextH = Math.round(startPos.bottom + startH - nextBottom);
        }

        const changedW = operatesHorizontal && (didMutateWidth || nextW !== startW);
        const changedH = operatesVertical && (didMutateHeight || nextH !== startH);

        setUndockedSizeCap((prev) => {
          const nextCapW = changedW
            ? undefined
            : (prev?.width ?? (undockingFromDock || startW < effMinW ? startW : undefined));
          const nextCapH = changedH
            ? undefined
            : (prev?.height ?? (undockingFromDock || startH < effMinH ? startH : undefined));
          return nextCapW == null && nextCapH == null ? null : { width: nextCapW, height: nextCapH };
        });

        setUndockedMinFloor((prev) => {
          const nextFloorW = changedW ? (nextW < effMinW ? nextW : undefined) : prev?.width;
          const nextFloorH = changedH ? (nextH < effMinH ? nextH : undefined) : prev?.height;
          return nextFloorW == null && nextFloorH == null ? null : { width: nextFloorW, height: nextFloorH };
        });

        if (changedW) {
          didMutateWidth = true;
          latestWidth = nextW;
          setCustomWidth(nextW);
        }
        if (changedH) {
          didMutateHeight = true;
          latestHeight = nextH;
          setCustomHeight(nextH);
        }
        const nextPos = { right: nextRight, bottom: nextBottom };
        latestPosition = nextPos;
        setCustomPosition(nextPos);
      },
      onCommit: () => {
        if (latestHeight !== null) {
          writeStoredMiniChatHeight(heightStorageKey, latestHeight);
        }
        const positionChanged = latestPosition !== null
          && (!undockingFromDock || latestPosition.right !== startPos.right || latestPosition.bottom !== startPos.bottom);
        if (latestWidth !== null || positionChanged) {
          writeStoredMiniChatLayout(heightStorageKey, {
            width: latestWidth ?? customWidth,
            position: latestPosition ?? effectiveMiniChatPosition ?? null,
          });
        }
      },
    });
  }, [
    beginPointerInteraction,
    customPosition,
    customWidth,
    effectiveMiniChatPosition,
    heightStorageKey,
    maxHeight,
    maxWidth,
    resizable,
    resolveCurrentBox,
    safeMinHeight,
    safeMinWidth,
  ]);

  // Attach lowercase 'pointerdown' directly so both real browsers and jsdom
  // (where HTMLElement lacks `onpointerdown` in Preact's prop-name check) fire it.
  useEffect(() => {
    if (!expanded) return undefined;
    const headerEl = headerRef.current;
    const headerListener = (event: PointerEvent) => handleHeaderPointerDown(event);
    headerEl?.addEventListener('pointerdown', headerListener);

    const handleCleanups: Array<() => void> = [];
    if (resizable) {
      for (const dir of RESIZE_DIRS) {
        const el = resizeHandleRefs.current[dir];
        if (!el) continue;
        const listener = (event: PointerEvent) => handleResizePointerDown(dir, event);
        el.addEventListener('pointerdown', listener);
        handleCleanups.push(() => el.removeEventListener('pointerdown', listener));
      }
    }

    return () => {
      headerEl?.removeEventListener('pointerdown', headerListener);
      for (const fn of handleCleanups) fn();
    };
  }, [expanded, handleHeaderPointerDown, handleResizePointerDown, resizable]);

  const session = mainChat.session;
  const sessionName = session.name;
  const hasChatTimeline = session.agentType !== 'shell' && session.agentType !== 'script';

  const {
    events: timelineEvents,
    loading: timelineLoading,
    refreshing: timelineRefreshing,
    historyStatus,
    loadingOlder,
    hasOlderHistory,
    loadOlderEvents,
    historyGap,
    loadMessageContext,
    addOptimisticUserMessage,
    removeOptimisticMessage,
    markOptimisticFailed,
    retryOptimisticMessage,
    forceRefresh: timelineForceRefresh,
  } = useTimeline(sessionName, mainChat.ws, mainChat.serverId, {
    incognito: session.incognito,
    // SessionPane owns keyboard/recovery timers for activeSession. Keep this card
    // secondary so it stays synced live without competing on recovery work.
    isActiveSession: false,
    isVisible: expanded,
    subscriptionMode: expanded ? 'full' : 'summary',
    bootstrapWhenVisible: true,
    disableHistory: !hasChatTimeline,
    authoritativeSessionState: session.state,
  });

  const activeThinkingTs = useMemo(() => getActiveThinkingTs(timelineEvents), [timelineEvents]);
  const activeToolCall = useMemo(() => hasActiveToolCall(timelineEvents), [timelineEvents]);
  const pendingUserSend = useMemo(() => hasPendingUserSend(timelineEvents), [timelineEvents]);
  const timelineSessionStateInfo = useMemo(() => getTailSessionStateInfo(timelineEvents), [timelineEvents]);
  const timelineLastEventTs = timelineEvents.length > 0
    ? (timelineEvents[timelineEvents.length - 1]?.ts ?? null)
    : null;
  const activeTimelineTurn = useMemo(() => (
    session.authoritativeIdleAt != null
      && timelineLastEventTs != null
      && timelineLastEventTs <= session.authoritativeIdleAt
      ? false
      : hasActiveTimelineTurn(timelineEvents)
  ), [session.authoritativeIdleAt, timelineEvents, timelineLastEventTs]);

  const liveSessionState = useMemo(
    () => resolveTimelineBackedSessionState({
      timelineState: timelineSessionStateInfo.state,
      sessionState: session.state,
      activeThinking: !!activeThinkingTs,
      activeToolCall,
      activeTransportTurn: activeTimelineTurn,
      authoritativeIdleAt: session.authoritativeIdleAt,
      timelineStateTs: timelineSessionStateInfo.ts,
      timelineLastEventTs,
    }),
    [
      activeThinkingTs,
      activeTimelineTurn,
      activeToolCall,
      session.authoritativeIdleAt,
      session.state,
      timelineLastEventTs,
      timelineSessionStateInfo.state,
      timelineSessionStateInfo.ts,
    ],
  );

  const effectiveRuntimeType = resolveSessionInfoRuntimeType(session);
  const isTransportSession = effectiveRuntimeType === 'transport';
  const controlsSession = useMemo<SessionInfo>(() => {
    if (!isTransportSession || !liveSessionState || liveSessionState === session.state) return session;
    return { ...session, state: liveSessionState as SessionInfo['state'] };
  }, [isTransportSession, liveSessionState, session]);

  const isBusy = liveSessionState === 'running'
    || !!activeThinkingTs
    || activeToolCall
    || activeTimelineTurn
    || pendingUserSend;

  const sessionDisplayName = session.label
    ? formatLabel(session.label)
    : (session.project || session.name);

  const activeDocKey = activePreviewQuote ? getCloudDocQuoteKey(activePreviewQuote) : null;
  const autoQuoteBadge = activePreviewQuote ? formatCloudDocQuoteBadge(activePreviewQuote) : null;

  useEffect(() => {
    setDismissedDocKey(null);
  }, [activeDocKey]);

  useEffect(() => {
    setExtraQuotes([]);
  }, [sessionName]);

  const isAutoQuoteAttached = !!autoQuoteBadge && !!activeDocKey && dismissedDocKey !== activeDocKey;
  const quotes = useMemo(
    () => (isAutoQuoteAttached && autoQuoteBadge ? [autoQuoteBadge, ...extraQuotes] : extraQuotes),
    [autoQuoteBadge, extraQuotes, isAutoQuoteAttached],
  );

  const handleRemoveQuote = useCallback((index: number) => {
    if (isAutoQuoteAttached) {
      if (index === 0) {
        setDismissedDocKey(activeDocKey);
        return;
      }
      setExtraQuotes((prev) => prev.filter((_, idx) => idx !== index - 1));
      return;
    }
    setExtraQuotes((prev) => prev.filter((_, idx) => idx !== index));
  }, [activeDocKey, isAutoQuoteAttached]);

  const chatScrollFnRef = useRef<(() => void) | null>(null);
  const setChatScrollFn = useCallback((fn: () => void) => {
    chatScrollFnRef.current = fn;
  }, []);

  useEffect(() => {
    if (!expanded) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(() => chatScrollFnRef.current?.());
      return () => cancelAnimationFrame(id);
    }
    chatScrollFnRef.current?.();
    return undefined;
  }, [expanded]);

  const timelineEventsRef = useRef(timelineEvents);
  timelineEventsRef.current = timelineEvents;

  const handleResendFailed = useCallback((commandId: string, text: string) => {
    if (!mainChat.ws && !mainChat.serverId) return;
    const failedEvent = timelineEventsRef.current.find(
      (e) => e.type === 'user.message'
        && e.payload.failed === true
        && e.payload.commandId === commandId,
    );
    const resendExtra = failedEvent && typeof failedEvent.payload._resendExtra === 'object'
      ? (failedEvent.payload._resendExtra as Record<string, unknown>)
      : undefined;
    const attachmentsFromFailure = failedEvent && Array.isArray(failedEvent.payload.attachments)
      ? (failedEvent.payload.attachments as Array<Record<string, unknown>>)
      : undefined;
    const newCommandId = globalThis.crypto?.randomUUID?.()
      ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      dispatchSessionSend(mainChat.ws, mainChat.serverId, {
        sessionName,
        text,
        ...(resendExtra ?? {}),
        commandId: newCommandId,
      }, (err) => {
        markOptimisticFailed(newCommandId, err instanceof Error ? err.message : String(err || 'Send failed'));
      });
      requestActiveTimelineRefreshAfterUserAction();
    } catch {
      return;
    }
    retryOptimisticMessage(commandId, newCommandId, text, {
      ...(attachmentsFromFailure ? { attachments: attachmentsFromFailure } : {}),
      ...(resendExtra ? { resendExtra } : {}),
    });
  }, [mainChat.serverId, mainChat.ws, markOptimisticFailed, retryOptimisticMessage, sessionName]);

  const overlayClassSuffix = overlayClassName ? ` ${overlayClassName}` : '';
  const miniChatStyle = useMemo(() => {
    const style: Record<string, string | number> = {};
    if (effectiveMiniChatWidth != null) {
      style.width = `${effectiveMiniChatWidth}px`;
      if (containerMaxWidth != null) style.maxWidth = `${containerMaxWidth}px`;
    }
    if (effectiveMiniChatHeight != null) {
      style.height = `${effectiveMiniChatHeight}px`;
      if (containerMaxHeight != null) style.maxHeight = `${containerMaxHeight}px`;
    }
    if (effectiveMiniChatPosition != null) {
      style.right = `${effectiveMiniChatPosition.right}px`;
      style.bottom = `${effectiveMiniChatPosition.bottom}px`;
    }
    return Object.keys(style).length > 0 ? style : undefined;
  }, [
    containerMaxHeight,
    containerMaxWidth,
    effectiveMiniChatHeight,
    effectiveMiniChatPosition,
    effectiveMiniChatWidth,
  ]);

  return (
    <div
      ref={anchorRef}
      class="cloud-docs-main-chat-anchor"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {(isDragging || isResizing) && (
        <div
          class={`cloud-docs-mini-chat-interaction-shield${overlayClassSuffix}`}
          aria-hidden="true"
          data-testid="cloud-docs-mini-chat-interaction-shield"
        />
      )}
      {expanded && (
        <div
          ref={miniChatRef}
          class={`cloud-docs-mini-chat${effectiveMiniChatPosition ? ' is-positioned' : ''}${isDragging ? ' is-dragging' : ''}${isResizing ? ' is-resizing' : ''}${overlayClassSuffix}`}
          style={miniChatStyle}
          role="dialog"
          aria-modal="false"
          aria-label={t('cloud_docs.ai_chat.title', { session: sessionDisplayName })}
          data-testid="cloud-docs-mini-chat"
          onContextMenu={(e) => e.stopPropagation()}
        >
          {resizable && RESIZE_DIRS.map((dir) => (
            <div
              key={dir}
              ref={(el) => { resizeHandleRefs.current[dir] = el; }}
              class={`mini-chat-resize-handle mini-chat-resize-${dir}${activeResizeDir === dir ? ' is-active' : ''}`}
              role={dir === 'n' ? 'separator' : undefined}
              aria-orientation={dir === 'n' ? 'horizontal' : undefined}
              aria-label={dir === 'n' ? t('cloud_docs.ai_chat.resize_height', 'Resize AI chat height') : undefined}
              aria-valuemin={dir === 'n' ? safeMinHeight : undefined}
              aria-valuemax={dir === 'n' ? containerMaxHeight : undefined}
              aria-valuenow={dir === 'n' ? (effectiveMiniChatHeight ?? safeDefaultHeight) : undefined}
              aria-hidden={dir === 'n' ? undefined : true}
              data-testid={dir === 'n' ? 'mini-chat-resize-handle' : `mini-chat-resize-handle-${dir}`}
            />
          ))}
          <div
            ref={headerRef}
            class="cloud-docs-mini-chat-header"
            data-testid="cloud-docs-mini-chat-header"
          >
            <div class="cloud-docs-mini-chat-title-group">
              <img
                class="cloud-docs-mini-chat-avatar"
                src="/imcodes-robot-avatar.png"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <div class="cloud-docs-mini-chat-title-meta">
                <span class="cloud-docs-mini-chat-title" title={sessionDisplayName}>
                  {sessionDisplayName}
                </span>
                <span class={`cloud-docs-mini-chat-status${isBusy ? ' busy' : ''}`}>
                  <span class="cloud-docs-mini-chat-status-dot" aria-hidden="true" />
                  <span>
                    {isBusy
                      ? t('cloud_docs.ai_chat.thinking', 'Thinking...')
                      : t('cloud_docs.ai_chat.synced', 'Synced')}
                  </span>
                </span>
              </div>
            </div>
            <button
              type="button"
              class="cloud-docs-mini-chat-close"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setExpanded(false)}
              aria-label={t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')}
              title={t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')}
              data-testid="cloud-docs-mini-chat-close"
            >
              ×
            </button>
          </div>

          <div class="cloud-docs-mini-chat-messages">
            <ChatView
              visible={expanded}
              events={timelineEvents}
              loading={timelineLoading}
              refreshing={timelineRefreshing}
              historyStatus={historyStatus}
              loadingOlder={loadingOlder}
              hasOlderHistory={hasOlderHistory}
              onLoadOlder={loadOlderEvents}
              historyGap={historyGap}
              onLoadMessageContext={loadMessageContext}
              onForceSync={timelineForceRefresh}
              sessionId={sessionName}
              sessions={mainChat.sessions}
              sessionState={liveSessionState ?? undefined}
              onScrollBottomFn={setChatScrollFn}
              workdir={session.projectDir}
              ws={mainChat.connected ? mainChat.ws : null}
              serverId={mainChat.serverId}
              scopeFilesToSession={!!session.sharedState && session.sharedState.targetKind !== 'server'}
              readOnlyFiles={!!session.sharedState && session.sharedState.effectiveRole !== 'participant'}
              canManageFileShares={!isShareScopedState(session.sharedState)}
              onQuote={(text) => setExtraQuotes((prev) => [...prev, text])}
              onCloudDocClick={onOpenDoc}
              onRemoteDesktopClick={onRemoteDesktopClick}
              agentType={session.agentType}
              onResendFailed={handleResendFailed}
              hideFilePanel
              hideTaskPairPanel
            />
          </div>

          {activePreviewQuote && activeDocKey && dismissedDocKey === activeDocKey && (() => {
            const isRemoteDesktop = activePreviewQuote.kind === 'remote_desktop';
            const safeName = isRemoteDesktop
              ? sanitizeRemoteDesktopCitationName(activePreviewQuote.name)
              : sanitizeCloudDocQuoteName(activePreviewQuote.name);
            return (
              <div class="cloud-docs-mini-chat-doc-strip">
                <button
                  type="button"
                  class="cloud-docs-mini-chat-reattach-btn"
                  onClick={() => setDismissedDocKey(null)}
                  data-testid="cloud-docs-mini-chat-reattach"
                  title={isRemoteDesktop
                    ? t('cloud_docs.ai_chat.reattach_remote_desktop_hint', { name: safeName })
                    : t('cloud_docs.ai_chat.reattach_doc_hint', { name: safeName })}
                >
                  + {isRemoteDesktop
                    ? t('cloud_docs.ai_chat.reattach_remote_desktop', { name: safeName })
                    : t('cloud_docs.ai_chat.reattach_doc', { name: safeName })}
                </button>
              </div>
            );
          })()}

          <div class="cloud-docs-mini-chat-controls">
            <SessionControls
              ws={mainChat.ws}
              connected={mainChat.connected}
              activeSession={controlsSession}
              sessionDisplayName={sessionDisplayName}
              quickData={mainChat.quickData}
              detectedModel={mainChat.detectedModel}
              compact
              hideWorkflowControls
              activeThinking={!!activeThinkingTs}
              activeTransportTurn={activeTimelineTurn}
              transportTimelineEvents={timelineEvents}
              sessions={mainChat.sessions}
              subSessions={mainChat.subSessions}
              serverId={mainChat.serverId}
              canManageFileShares={!isShareScopedState(session.sharedState)}
              quotes={quotes}
              onRemoveQuote={handleRemoveQuote}
              onSend={(_name, text, meta) => {
                const extras = meta?.extra as Record<string, unknown> | undefined;
                const isP2pSend = !!extras && (
                  (Array.isArray(extras.p2pAtTargets) && extras.p2pAtTargets.length > 0)
                  || (typeof extras.p2pMode === 'string' && extras.p2pMode.length > 0)
                  || (extras.p2pSessionConfig != null && typeof extras.p2pSessionConfig === 'object')
                );
                if (isP2pSend || !hasChatTimeline) return;
                addOptimisticUserMessage(text, meta?.commandId, {
                  ...(meta?.attachments ? { attachments: meta.attachments } : {}),
                  ...(meta?.extra ? { resendExtra: meta.extra } : {}),
                  ...(meta?.queueAppend ? { queueAppend: true } : {}),
                });
                if (meta?.commandId && meta.localFailure) {
                  markOptimisticFailed(meta.commandId, meta.localFailure);
                }
                chatScrollFnRef.current?.();
              }}
              onRemoveOptimisticMessage={removeOptimisticMessage}
              onSendFailed={markOptimisticFailed}
            />
          </div>
        </div>
      )}

      {!hideFab && (
        <button
          type="button"
          class={`cloud-docs-fab${expanded ? ' active' : ''}${isBusy ? ' busy' : ''}${isEntering ? ' is-entering' : ''}${overlayClassSuffix}`}
          onClick={() => setExpanded((prev) => !prev)}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.animationName && event.animationName !== 'cloudDocsFabEntrance') return;
            setIsEntering(false);
          }}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
            : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
          title={expanded
            ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
            : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
          data-testid="cloud-docs-main-chat-fab"
        >
          <span class="cloud-docs-fab-aura" aria-hidden="true" />
          <span class="cloud-docs-fab-ring" aria-hidden="true" />
          <img
            class="cloud-docs-fab-avatar"
            src="/imcodes-robot-avatar.png"
            alt="IM.codes AI"
            draggable={false}
          />
          {isBusy && (
            <span
              class="cloud-docs-fab-busy-dot"
              aria-hidden="true"
              data-testid="cloud-docs-fab-busy-dot"
            />
          )}
        </button>
      )}
    </div>
  );
}
