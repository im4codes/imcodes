import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';
import type { PinnedPanel } from '../app.js';

const LS_COLLAPSED = 'sidebar_collapsed';
const LS_WIDTH = 'sidebar_width_';
const MIN_WIDTH = 180;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 240;

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

  // Persist and restore sidebar width per server
  const [width, setWidth] = useState<number>(() => {
    if (!serverId) return DEFAULT_WIDTH;
    try {
      const stored = localStorage.getItem(LS_WIDTH + serverId);
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
      }
    } catch { /* ignore */ }
    return DEFAULT_WIDTH;
  });

  // Update width when serverId changes
  useEffect(() => {
    if (!serverId) return;
    try {
      const stored = localStorage.getItem(LS_WIDTH + serverId);
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= MIN_WIDTH && n <= MAX_WIDTH) {
          setWidth(n);
          return;
        }
      }
    } catch { /* ignore */ }
    setWidth(DEFAULT_WIDTH);
  }, [serverId]);

  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientX - startXRef.current;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(newWidth);
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const delta = ev.clientX - startXRef.current;
      const finalWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(finalWidth);
      if (serverId) {
        try { localStorage.setItem(LS_WIDTH + serverId, String(finalWidth)); } catch { /* ignore */ }
      }
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, serverId]);

  return (
    <div
      class={`sidebar-panel${collapsed ? ' sidebar-panel-collapsed' : ''}${isDragOver ? ' sidebar-panel-drop-active' : ''}`}
      style={{ width: collapsed ? 0 : width }}
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

      {/* Right-edge resize handle — only active when not collapsed */}
      {!collapsed && (
        <div
          class="sidebar-resize-handle"
          onMouseDown={handleResizeMouseDown}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** Load persisted collapsed state from localStorage */
export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(LS_COLLAPSED) === 'true';
  } catch {
    return false;
  }
}

/** Persist collapsed state to localStorage */
export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(LS_COLLAPSED, String(collapsed));
  } catch { /* ignore */ }
}
