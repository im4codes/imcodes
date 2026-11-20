import type { ComponentProps } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ChatView } from './ChatView.js';
import { StableSessionControls as SessionControls } from './StableSessionControls.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import type { WsClient } from '../ws-client.js';
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
  type CloudDocQuoteTarget,
} from '../cloud-docs-reference.js';
import { acquireWindowPointerInteractionGuard } from './window-drag.js';
import { RESIZE_DIRS, type ResizeDir } from './window-resize.js';

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
  x: number;
  y: number;
}

interface StoredMiniChatLayout {
  width: number | null;
  position: MiniChatPosition | null;
}

interface CloudDocsMainChatFloatProps {
  mainChat: CloudDocsMainChatContext;
  activePreviewQuote?: CloudDocQuoteTarget | null;
  onOpenDoc?: (docId: string) => void;
  heightStorageKey?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  overlayClassName?: string;
  visible?: boolean;
}

function getLayoutStorageKey(heightStorageKey: string | undefined): string | undefined {
  return heightStorageKey ? `${heightStorageKey}:layout` : undefined;
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
  const rect = host.getBoundingClientRect?.();
  const width = host.clientWidth > 0 ? host.clientWidth : (rect?.width && rect.width > 0 ? rect.width : 0);
  const height = host.clientHeight > 0 ? host.clientHeight : (rect?.height && rect.height > 0 ? rect.height : 0);
  return { width, height };
}

function resolveAvailableMaxHeight(
  anchorEl: HTMLDivElement | null,
  minHeight: number,
  maxHeightProp?: number,
  docked = true,
  measuredContainerHeight?: number,
): number | undefined {
  const containerHeight = measuredContainerHeight && measuredContainerHeight > 0
    ? measuredContainerHeight
    : readContainerRectSize(anchorEl).height;
  let limit: number | undefined;
  if (containerHeight > 0) {
    const clearance = docked ? DOCKED_BOTTOM_CLEARANCE : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(140, Math.floor(containerHeight - clearance));
  } else if (typeof window !== 'undefined' && window.innerHeight > 0) {
    const fallbackClearance = docked ? 120 : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(minHeight, Math.floor(window.innerHeight - fallbackClearance));
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
): number | undefined {
  const containerWidth = measuredContainerWidth && measuredContainerWidth > 0
    ? measuredContainerWidth
    : readContainerRectSize(anchorEl).width;
  let limit: number | undefined;
  if (containerWidth > 0) {
    const clearance = docked ? DOCKED_RIGHT_GAP * 2 : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(180, Math.floor(containerWidth - clearance));
  } else if (typeof window !== 'undefined' && window.innerWidth > 0) {
    const fallbackClearance = docked ? DOCKED_RIGHT_GAP * 2 : CONTAINER_EDGE_MARGIN * 2;
    limit = Math.max(minWidth, Math.floor(window.innerWidth - fallbackClearance));
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
): MiniChatPosition {
  const boundsW = containerWidth > 0
    ? containerWidth
    : (typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 0);
  const boundsH = containerHeight > 0
    ? containerHeight
    : (typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 0);
  return {
    x: clampAxisPosition(pos.x, boxWidth, boundsW),
    y: clampAxisPosition(pos.y, boxHeight, boundsH),
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
    const parsed = JSON.parse(raw) as { width?: unknown; x?: unknown; y?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return { width: null, position: null };

    let width: number | null = null;
    if (typeof parsed.width === 'number' && Number.isFinite(parsed.width) && parsed.width > 0) {
      const maxBound = maxWidthProp != null && Number.isFinite(maxWidthProp) && maxWidthProp > 0
        ? Math.max(minWidth, Math.floor(maxWidthProp))
        : undefined;
      width = clampMiniChatDimension(parsed.width, minWidth, maxBound);
    }

    let position: MiniChatPosition | null = null;
    if (
      typeof parsed.x === 'number' && Number.isFinite(parsed.x) && parsed.x >= 0
      && typeof parsed.y === 'number' && Number.isFinite(parsed.y) && parsed.y >= 0
    ) {
      position = { x: Math.round(parsed.x), y: Math.round(parsed.y) };
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
  if (layout.position && Number.isFinite(layout.position.x) && Number.isFinite(layout.position.y)) {
    payload.x = Math.round(Math.max(0, layout.position.x));
    payload.y = Math.round(Math.max(0, layout.position.y));
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
  heightStorageKey,
  defaultWidth = DEFAULT_MINI_CHAT_WIDTH,
  minWidth = DEFAULT_MINI_CHAT_MIN_WIDTH,
  maxWidth,
  defaultHeight = DEFAULT_MINI_CHAT_HEIGHT,
  minHeight = DEFAULT_MINI_CHAT_MIN_HEIGHT,
  maxHeight,
  overlayClassName,
  visible = true,
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
  }, [heightStorageKey, maxHeight, maxWidth, safeMinHeight, safeMinWidth]);

  useEffect(() => {
    if (!expanded) return undefined;
    const syncContainerSize = () => {
      const next = readContainerRectSize(anchorRef.current);
      setContainerSize((prev) => (
        prev.width === next.width && prev.height === next.height ? prev : next
      ));
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
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', syncContainerSize);
      }
    };
  }, [expanded]);

  useEffect(() => () => {
    cleanupDragRef.current?.();
  }, []);

  const dockedMode = customPosition === null;
  const containerMaxHeight = useMemo(
    () => resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight, dockedMode, containerSize.height),
    [containerSize.height, dockedMode, maxHeight, safeMinHeight],
  );
  const containerMaxWidth = useMemo(
    () => resolveAvailableMaxWidth(anchorRef.current, safeMinWidth, maxWidth, dockedMode, containerSize.width),
    [containerSize.width, dockedMode, maxWidth, safeMinWidth],
  );

  const effectiveMiniChatHeight = useMemo(() => {
    if (!resizable || customHeight === null) return undefined;
    return clampMiniChatDimension(customHeight, safeMinHeight, containerMaxHeight);
  }, [containerMaxHeight, customHeight, resizable, safeMinHeight]);

  const effectiveMiniChatWidth = useMemo(() => {
    if (!resizable || customWidth === null) return undefined;
    return clampMiniChatDimension(customWidth, safeMinWidth, containerMaxWidth);
  }, [containerMaxWidth, customWidth, resizable, safeMinWidth]);

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
    return clampMiniChatPosition(customPosition, boxW, boxH, containerSize.width, containerSize.height);
  }, [
    containerSize.height,
    containerSize.width,
    customPosition,
    effectiveMiniChatHeight,
    effectiveMiniChatWidth,
    safeDefaultHeight,
    safeDefaultWidth,
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
    if (captureEl && pointerId != null && typeof captureEl.setPointerCapture === 'function') {
      try {
        captureEl.setPointerCapture(pointerId);
      } catch {
        /* jsdom / synthetic pointer events without an active pointer */
      }
    }
    const releaseGuard = acquireWindowPointerInteractionGuard(document);
    let cleaned = false;

    const onMove = (moveEvent: PointerEvent) => {
      if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId) return;
      callbacks.onMove(moveEvent.clientX - startX, moveEvent.clientY - startY);
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
    const containerRect = anchorRef.current?.getBoundingClientRect?.();
    const miniRect = miniChatRef.current?.getBoundingClientRect?.();
    const measured = readContainerRectSize(anchorRef.current);
    const cw = measured.width > 0 ? measured.width : (containerSize.width > 0 ? containerSize.width : 0);
    const ch = measured.height > 0 ? measured.height : (containerSize.height > 0 ? containerSize.height : 0);
    const startW = miniRect && miniRect.width > 0
      ? Math.round(miniRect.width)
      : (effectiveMiniChatWidth ?? safeDefaultWidth);
    const startH = miniRect && miniRect.height > 0
      ? Math.round(miniRect.height)
      : (effectiveMiniChatHeight ?? safeDefaultHeight);

    let startPos: MiniChatPosition;
    if (effectiveMiniChatPosition) {
      startPos = effectiveMiniChatPosition;
    } else if (containerRect && miniRect && containerRect.width > 0 && miniRect.width > 0) {
      startPos = {
        x: Math.round(miniRect.left - containerRect.left),
        y: Math.round(miniRect.top - containerRect.top),
      };
    } else {
      const fallbackBoundsW = cw > 0 ? cw : (typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 800);
      const fallbackBoundsH = ch > 0 ? ch : (typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 600);
      startPos = {
        x: Math.max(CONTAINER_EDGE_MARGIN, fallbackBoundsW - DOCKED_RIGHT_GAP - startW),
        y: Math.max(CONTAINER_EDGE_MARGIN, fallbackBoundsH - DOCKED_FAB_OFFSET_BOTTOM - startH),
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
    let latestPos: MiniChatPosition | null = null;
    setIsDragging(true);

    beginPointerInteraction(event, {
      onMove: (dx, dy) => {
        if (dx === 0 && dy === 0 && latestPos === null) return;
        const latestContainer = readContainerRectSize(anchorRef.current);
        const liveW = latestContainer.width > 0 ? latestContainer.width : cw;
        const liveH = latestContainer.height > 0 ? latestContainer.height : ch;
        const clamped = clampMiniChatPosition(
          { x: startPos.x + dx, y: startPos.y + dy },
          startW,
          startH,
          liveW,
          liveH,
        );
        latestPos = clamped;
        setCustomPosition(clamped);
      },
      onCommit: () => {
        if (latestPos !== null && resizable) {
          writeStoredMiniChatLayout(heightStorageKey, {
            width: effectiveMiniChatWidth ?? null,
            position: latestPos,
          });
        }
      },
    });
  }, [beginPointerInteraction, effectiveMiniChatWidth, heightStorageKey, resizable, resolveCurrentBox]);

  const handleResizePointerDown = useCallback((dir: ResizeDir, event: PointerEvent) => {
    if (!resizable) return;
    if (typeof event.button === 'number' && event.button !== 0) return;

    const { cw, ch, startW, startH, startPos } = resolveCurrentBox();
    const anchoredBottomRight = customPosition === null && !dir.includes('e') && !dir.includes('s');
    let latestHeight: number | null = null;
    let latestWidth: number | null = null;
    let latestPosition: MiniChatPosition | null = null;

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
          if (dir.includes('n')) {
            const nextH = clampMiniChatDimension(startH - dy, safeMinHeight, maxH);
            latestHeight = nextH;
            setCustomHeight(nextH);
          }
          if (dir.includes('w')) {
            const nextW = clampMiniChatDimension(startW - dx, safeMinWidth, maxW);
            latestWidth = nextW;
            setCustomWidth(nextW);
          }
          return;
        }

        const boundsW = liveW > 0 ? liveW : (typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 0);
        const boundsH = liveH > 0 ? liveH : (typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 0);
        const effMinW = maxW != null ? Math.min(safeMinWidth, maxW) : safeMinWidth;
        const effMinH = maxH != null ? Math.min(safeMinHeight, maxH) : safeMinHeight;

        let nextX = startPos.x;
        let nextW = startW;
        if (dir.includes('w')) {
          const startRight = startPos.x + startW;
          const minLeft = boundsW > 0 ? CONTAINER_EDGE_MARGIN : Number.NEGATIVE_INFINITY;
          const maxLeft = startRight - effMinW;
          let clampedLeft = Math.max(minLeft, Math.min(maxLeft, startPos.x + dx));
          if (maxW != null && startRight - clampedLeft > maxW) {
            clampedLeft = startRight - maxW;
          }
          nextX = Math.round(clampedLeft);
          nextW = Math.round(startRight - nextX);
        } else if (dir.includes('e')) {
          const rightLimitW = boundsW > 0 ? Math.max(effMinW, boundsW - CONTAINER_EDGE_MARGIN - startPos.x) : Number.POSITIVE_INFINITY;
          const upperW = maxW != null ? Math.min(maxW, rightLimitW) : rightLimitW;
          nextW = clampMiniChatDimension(startW + dx, effMinW, upperW);
        }

        let nextY = startPos.y;
        let nextH = startH;
        if (dir.includes('n')) {
          const startBottom = startPos.y + startH;
          const minTop = boundsH > 0 ? CONTAINER_EDGE_MARGIN : Number.NEGATIVE_INFINITY;
          const maxTop = startBottom - effMinH;
          let clampedTop = Math.max(minTop, Math.min(maxTop, startPos.y + dy));
          if (maxH != null && startBottom - clampedTop > maxH) {
            clampedTop = startBottom - maxH;
          }
          nextY = Math.round(clampedTop);
          nextH = Math.round(startBottom - nextY);
        } else if (dir.includes('s')) {
          const bottomLimitH = boundsH > 0 ? Math.max(effMinH, boundsH - CONTAINER_EDGE_MARGIN - startPos.y) : Number.POSITIVE_INFINITY;
          const upperH = maxH != null ? Math.min(maxH, bottomLimitH) : bottomLimitH;
          nextH = clampMiniChatDimension(startH + dy, effMinH, upperH);
        }

        if (dir.includes('w') || dir.includes('e')) {
          latestWidth = nextW;
          setCustomWidth(nextW);
        }
        if (dir.includes('n') || dir.includes('s')) {
          latestHeight = nextH;
          setCustomHeight(nextH);
        }
        const nextPos = { x: nextX, y: nextY };
        latestPosition = nextPos;
        setCustomPosition(nextPos);
      },
      onCommit: () => {
        if (latestHeight !== null) {
          writeStoredMiniChatHeight(heightStorageKey, latestHeight);
        }
        if (latestWidth !== null || latestPosition !== null) {
          writeStoredMiniChatLayout(heightStorageKey, {
            width: latestWidth ?? effectiveMiniChatWidth ?? null,
            position: latestPosition ?? effectiveMiniChatPosition ?? null,
          });
        }
      },
    });
  }, [
    beginPointerInteraction,
    customPosition,
    effectiveMiniChatPosition,
    effectiveMiniChatWidth,
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
    if (!mainChat.ws || !mainChat.connected) return;
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
      mainChat.ws.sendSessionCommand('send', {
        sessionName,
        text,
        ...(resendExtra ?? {}),
        commandId: newCommandId,
      });
      requestActiveTimelineRefreshAfterUserAction();
    } catch {
      return;
    }
    retryOptimisticMessage(commandId, newCommandId, text, {
      ...(attachmentsFromFailure ? { attachments: attachmentsFromFailure } : {}),
      ...(resendExtra ? { resendExtra } : {}),
    });
  }, [mainChat.connected, mainChat.ws, retryOptimisticMessage, sessionName]);

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
      style.left = `${effectiveMiniChatPosition.x}px`;
      style.top = `${effectiveMiniChatPosition.y}px`;
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
              agentType={session.agentType}
              onResendFailed={handleResendFailed}
              hideFilePanel
              hideTaskPairPanel
            />
          </div>

          {activePreviewQuote && activeDocKey && dismissedDocKey === activeDocKey && (
            <div class="cloud-docs-mini-chat-doc-strip">
              <button
                type="button"
                class="cloud-docs-mini-chat-reattach-btn"
                onClick={() => setDismissedDocKey(null)}
                data-testid="cloud-docs-mini-chat-reattach"
                title={t('cloud_docs.ai_chat.reattach_doc_hint', {
                  name: sanitizeCloudDocQuoteName(activePreviewQuote.name),
                })}
              >
                + {t('cloud_docs.ai_chat.reattach_doc', {
                  name: sanitizeCloudDocQuoteName(activePreviewQuote.name),
                })}
              </button>
            </div>
          )}

          <div class="cloud-docs-mini-chat-controls">
            <SessionControls
              ws={mainChat.ws}
              connected={mainChat.connected}
              activeSession={controlsSession}
              sessionDisplayName={sessionDisplayName}
              quickData={mainChat.quickData}
              detectedModel={mainChat.detectedModel}
              compact
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
            />
          </div>
        </div>
      )}

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
    </div>
  );
}
