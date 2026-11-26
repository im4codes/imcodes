import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';
import type { PinnedPanel } from '../app.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';
import { VoiceLanguageSwitcher } from './VoiceLanguageSwitcher.js';
import { resizeHandleHoverEvents } from './window-resize.js';
import { resolveShrinkZoom, useUiScale } from '../ui-scale.js';

const LS_COLLAPSED = 'sidebar_collapsed';
const LS_WIDTH = 'sidebar_width';
const LEGACY_LS_WIDTH_PREFIX = 'sidebar_width_';
export const MIN_WIDTH = 180;
export const MAX_WIDTH = 560;
export const DEFAULT_WIDTH = 380;

function parseStoredWidth(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return n >= MIN_WIDTH && n <= MAX_WIDTH ? n : null;
}

function readGlobalOrLegacyWidth(serverId: string | null): number | null {
  try {
    const globalStored = parseStoredWidth(localStorage.getItem(LS_WIDTH));
    if (globalStored !== null) return globalStored;
    if (serverId) {
      return parseStoredWidth(localStorage.getItem(LEGACY_LS_WIDTH_PREFIX + serverId));
    }
  } catch { /* ignore */ }
  return null;
}

interface Props {
  collapsed: boolean;
  serverId: string | null;
  /** Currently pinned panels — used to show drop zone only for droppable types. */
  pinnedPanels?: PinnedPanel[];
  /** Called when a panel is dropped onto the sidebar drop zone. */
  onDropPanel?: (type: string, id: string) => void;
  children?: ComponentChildren;
}

export function Sidebar({ collapsed, serverId, pinnedPanels: _pinnedPanels, onDropPanel, children }: Props) {
  const { t } = useTranslation();
  const [uiScale] = useUiScale();
  const shrinkZoom = resolveShrinkZoom(uiScale);

  // ── Drag-over drop zone state ────────────────────────────────────────────
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0); // track nested enters/leaves

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('application/x-pinpanel')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('application/x-pinpanel')) return;
    dragCounterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((_e: DragEvent) => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (!e.dataTransfer) return;
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData('application/x-pinpanel');
      if (raw) {
        const parsed = JSON.parse(raw) as { type: string; id: string };
        onDropPanel?.(parsed.type, parsed.id);
      }
    } catch { /* ignore bad data */ }
  }, [onDropPanel]);

  // Persist sidebar width globally across servers, falling back once to legacy per-server width if unset
  const [width, setWidth] = useState<number>(() => readGlobalOrLegacyWidth(serverId) ?? DEFAULT_WIDTH);
  const hasExplicitWidthRef = useRef<boolean>(readGlobalOrLegacyWidth(serverId) !== null);

  // If mounted with serverId=null before initial server resolved and no global width exists yet, pick up legacy fallback once
  useEffect(() => {
    if (hasExplicitWidthRef.current || !serverId) return;
    try {
      if (parseStoredWidth(localStorage.getItem(LS_WIDTH)) !== null) {
        hasExplicitWidthRef.current = true;
        return;
      }
      const legacy = parseStoredWidth(localStorage.getItem(LEGACY_LS_WIDTH_PREFIX + serverId));
      if (legacy !== null) {
        hasExplicitWidthRef.current = true;
        setWidth(legacy);
      }
    } catch { /* ignore */ }
  }, [serverId]);

  const [isResizing, setIsResizing] = useState(false);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  const clampDraggedWidth = useCallback((clientX: number) => {
    // At shrink scales (< 100%), width is stored in visual px and scaled up by 1/shrinkZoom on render,
    // so raw clientX delta tracks 1:1 with the cursor. At >= 100%, preserve the original direct clientX delta.
    const delta = Math.round(clientX - startXRef.current);
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
  }, []);

  const handleResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragCleanupRef.current?.();
    isDraggingRef.current = true;
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      setWidth(clampDraggedWidth(ev.clientX));
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const finalWidth = clampDraggedWidth(ev.clientX);
      cleanup();
      hasExplicitWidthRef.current = true;
      setWidth(finalWidth);
      try { localStorage.setItem(LS_WIDTH, String(finalWidth)); } catch { /* ignore */ }
    };

    dragCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [clampDraggedWidth, width]);

  // Touch support for tablet/iPad resize
  const handleResizeTouchStart = useCallback((e: TouchEvent) => {
    e.stopPropagation();
    dragCleanupRef.current?.();
    isDraggingRef.current = true;
    setIsResizing(true);
    startXRef.current = e.touches[0].clientX;
    startWidthRef.current = width;

    const onTouchMove = (ev: TouchEvent) => {
      if (!isDraggingRef.current) return;
      setWidth(clampDraggedWidth(ev.touches[0].clientX));
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      setIsResizing(false);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', finishTouch);
      document.removeEventListener('touchcancel', finishTouch);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    const finishTouch = (ev: TouchEvent) => {
      if (!isDraggingRef.current) return;
      const touch = ev.changedTouches[0];
      cleanup();
      if (touch) {
        const finalWidth = clampDraggedWidth(touch.clientX);
        hasExplicitWidthRef.current = true;
        setWidth(finalWidth);
        try { localStorage.setItem(LS_WIDTH, String(finalWidth)); } catch { /* ignore */ }
      }
    };

    dragCleanupRef.current = cleanup;
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', finishTouch);
    document.addEventListener('touchcancel', finishTouch);
  }, [clampDraggedWidth, width]);

  const renderedWidth = collapsed ? 0 : (shrinkZoom < 1 ? Math.round(width / shrinkZoom) : width);
  const disableDragTransition = isResizing && shrinkZoom < 1;

  return (
    <div
      class={`sidebar-panel${collapsed ? ' sidebar-panel-collapsed' : ''}${disableDragTransition ? ' sidebar-panel-resizing' : ''}${isDragOver ? ' sidebar-panel-drop-active' : ''}`}
      style={{ width: renderedWidth }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Content area — hidden when collapsed but kept mounted per D6/D5 spec */}
      <div
        class="sidebar-content"
        style={{ display: collapsed ? 'none' : undefined }}
      >
        {children}
      </div>

      {/* Drop zone indicator — visible while dragging over */}
      {isDragOver && !collapsed && (
        <div class="sidebar-drop-zone" aria-hidden="true">
          {t('sidebar.drop_to_pin')}
        </div>
      )}

      {/* Footer: one row — language, build time, copyright */}
      {!collapsed && (
        <div class="sidebar-footer">
          <LanguageSwitcher />
          <VoiceLanguageSwitcher />
          <span class="sidebar-build-time">
            {(() => { try { const d = new Date(__BUILD_TIME__); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
          </span>
          <span class="sidebar-copyright">© 2026 IM.codes</span>
        </div>
      )}

      {/* Resize grip — visible pill on the right border edge */}
      {!collapsed && (
        <div
          class="sidebar-resize-grip resize-hover-surface"
          {...resizeHandleHoverEvents}
          onMouseDown={handleResizeMouseDown}
          onTouchStart={handleResizeTouchStart}
          title={t('sidebar.drag_to_resize', 'Drag to resize')}
        >
          ◂▸
        </div>
      )}

      {/* Right-edge resize handle — invisible drag strip */}
      {!collapsed && (
        <div
          class="sidebar-resize-handle resize-hover-surface"
          {...resizeHandleHoverEvents}
          onMouseDown={handleResizeMouseDown}
          onTouchStart={handleResizeTouchStart}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** Load persisted collapsed state from localStorage */
export function loadSidebarCollapsed(): boolean {
  try {
    const value = localStorage.getItem(LS_COLLAPSED);
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/** Persist collapsed state to localStorage */
export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0');
  } catch { /* ignore */ }
}
