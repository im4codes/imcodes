/**
 * SidebarPinnedPanel — generic pinned panel container for the sidebar.
 *
 * Uses PinnedPanelRegistry to render content based on panel.type.
 * New panel types only need to register in pinnedPanelTypes.tsx.
 *
 * Includes a resize handle at the bottom and an unpin (×) button in the header.
 */

import { useRef, useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { PinnedPanel } from '../app.js';
import { getPanelTitle, renderPanelContent } from './PinnedPanelRegistry.js';
import type { PanelRenderContext } from './PinnedPanelRegistry.js';

const MIN_HEIGHT = 100;

interface SidebarPinnedPanelProps {
  panel: PinnedPanel;
  height: number;
  onUnpin: () => void;
  onResize: (height: number) => void;
  ctx: PanelRenderContext;
}

export function SidebarPinnedPanel({
  panel,
  height,
  onUnpin,
  onResize,
  ctx,
}: SidebarPinnedPanelProps) {
  const { t } = useTranslation();

  // ── Resize handle (bottom drag) ──────────────────────────────────────────
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const [localHeight, setLocalHeight] = useState(height);

  useEffect(() => { setLocalHeight(height); }, [height]);

  const handleResizeMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = localHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientY - startYRef.current;
      const newH = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      setLocalHeight(newH);
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const delta = ev.clientY - startYRef.current;
      const finalH = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      setLocalHeight(finalH);
      onResize(finalH);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [localHeight, onResize]);

  const title = getPanelTitle(panel);
  const content = renderPanelContent(panel, ctx);

  return (
    <div class="sidebar-pinned-panel" style={{ height: localHeight, flexShrink: 0 }}>
      {/* Header */}
      <div class="sidebar-pinned-header">
        <span class="sidebar-pinned-title">{title}</span>
        <button
          class="sidebar-pinned-unpin"
          onClick={onUnpin}
          title={t('sidebar.unpin')}
          aria-label={t('sidebar.unpin')}
        >
          ×
        </button>
      </div>

      {/* Content area */}
      <div class="sidebar-pinned-content">
        {content ?? <div class="sidebar-pinned-unavailable">{t('sidebar.session_unavailable')}</div>}
      </div>

      {/* Bottom resize handle */}
      <div
        class="sidebar-pinned-resize-handle"
        onMouseDown={handleResizeMouseDown}
        aria-hidden="true"
      />
    </div>
  );
}
