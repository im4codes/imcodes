/**
 * SidebarPinnedPanel — generic pinned panel container for the sidebar.
 *
 * Uses PinnedPanelRegistry to render content based on panel.type.
 * New panel types only need to register in pinnedPanelTypes.tsx.
 *
 * Includes a resize handle at the bottom and an unpin (×) button in the header.
 * The bottom drag-to-resize behavior is shared with the session tree via the
 * `useVerticalResize` hook.
 */

import { useTranslation } from 'react-i18next';
import type { PinnedPanel } from '../app.js';
import { getPanelTitle, renderPanelContent } from './PinnedPanelRegistry.js';
import type { PanelRenderContext } from './PinnedPanelRegistry.js';
import { useVerticalResize } from '../hooks/useVerticalResize.js';

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
  const { height: localHeight, onMouseDown, onTouchStart } = useVerticalResize({ height, onResize });

  const title = getPanelTitle(panel, ctx);
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
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        aria-hidden="true"
      />
    </div>
  );
}
