/**
 * FloatingPanel — reusable draggable/resizable floating window.
 * Used for RepoPage, DiscussionsPage, and other full-page overlays
 * that should behave like floating windows on desktop.
 */
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';
import { DesktopWindowMaximizeButton } from './DesktopWindowMaximizeButton.js';
import {
  clampGeometryToWorkspace,
  geometryFromWorkspace,
  normalizeWindowGeometry,
  reserveWorkspaceBottom,
  shouldPersistGeometry,
  viewportWorkspaceBelowSessionTabs,
  type WorkspaceBounds,
  type WindowGeometry,
} from '../desktop-window-maximize.js';

interface Props {
  id: string;
  title: string;
  children: ComponentChildren;
  onClose: () => void;
  zIndex?: number;
  onFocus?: () => void;
  onPin?: () => void;
  pinTooltip?: string;
  defaultW?: number;
  defaultH?: number;
  enableMaximize?: boolean;
  isMaximized?: boolean;
  onToggleMaximized?: () => void;
  getMaximizeBounds?: () => WorkspaceBounds | null;
  desktopLayoutCapable?: boolean;
  className?: string;
}

const MIN_W = 360;
const MIN_H = 280;
const DRAG_MARGIN = 32;

function currentViewportBounds(): WorkspaceBounds {
  return reserveWorkspaceBottom(viewportWorkspaceBelowSessionTabs({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    minW: MIN_W,
    minH: MIN_H,
  }));
}

function clampGeomToViewport(geom: WindowGeometry): WindowGeometry {
  const bounds = currentViewportBounds();
  const clamped = clampGeometryToWorkspace(geom, bounds, {
    minW: MIN_W,
    minH: MIN_H,
    visibleMargin: DRAG_MARGIN,
  });
  return {
    ...clamped,
    y: Math.min(clamped.y, Math.max(bounds.y, bounds.y + bounds.h - clamped.h)),
  };
}

function loadGeom(id: string, dw: number, dh: number): WindowGeometry {
  const fallback = {
    x: Math.max(0, (window.innerWidth - dw) / 2),
    y: Math.max(0, (window.innerHeight - dh) / 2 - 40),
    w: dw,
    h: dh,
  };
  try {
    const raw = localStorage.getItem(`rcc_float_${id}`);
    if (raw) return clampGeomToViewport(normalizeWindowGeometry(JSON.parse(raw), fallback));
  } catch { /* ignore */ }
  return clampGeomToViewport(fallback);
}

function saveGeom(id: string, geom: WindowGeometry) {
  try { localStorage.setItem(`rcc_float_${id}`, JSON.stringify(geom)); } catch { /* ignore */ }
}

function fallbackMaximizedGeometry(): WindowGeometry {
  return geometryFromWorkspace(currentViewportBounds());
}

export function FloatingPanel({
  id,
  title,
  children,
  onClose,
  zIndex = 2000,
  onFocus,
  onPin,
  pinTooltip,
  defaultW = 700,
  defaultH = 520,
  enableMaximize = false,
  isMaximized = false,
  onToggleMaximized,
  getMaximizeBounds,
  desktopLayoutCapable = true,
  className,
}: Props) {
  const { t } = useTranslation();
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const canUseDesktopMaximize = enableMaximize && desktopLayoutCapable;
  const isDesktopMaximized = canUseDesktopMaximize && isMaximized;
  const [geom, setGeom] = useState(() => loadGeom(id, defaultW, defaultH));
  const [, forceWorkspaceRender] = useState(0);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  useEffect(() => {
    if (shouldPersistGeometry(isDesktopMaximized)) saveGeom(id, geom);
  }, [id, geom, isDesktopMaximized]);
  useEffect(() => {
    const onResize = () => {
      if (isDesktopMaximized) {
        forceWorkspaceRender((n) => n + 1);
        return;
      }
      setGeom((g) => clampGeomToViewport(g));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isDesktopMaximized]);

  // ── Drag ─────────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const clampPos = useCallback((x: number, y: number, w: number) => {
    const topBound = currentViewportBounds().y;
    return {
      x: Math.min(Math.max(x, DRAG_MARGIN - w), window.innerWidth - DRAG_MARGIN),
      y: Math.min(Math.max(y, topBound), Math.max(topBound, window.innerHeight - DRAG_MARGIN)),
    };
  }, []);

  const startDrag = useCallback((e: MouseEvent) => {
    if (isDesktopMaximized) {
      onFocus?.();
      return;
    }
    if ((e.target as HTMLElement).closest('button, input, textarea, [contenteditable], a')) return;
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: geomRef.current.x, oy: geomRef.current.y };
    onFocus?.();
    const onMove = (me: MouseEvent) => {
      if (!dragStart.current) return;
      const dx = me.clientX - dragStart.current.mx;
      const dy = me.clientY - dragStart.current.my;
      setGeom((g) => {
        const { x, y } = clampPos(dragStart.current!.ox + dx, dragStart.current!.oy + dy, g.w);
        return { ...g, x, y };
      });
    };
    const onUp = () => {
      dragStart.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, [isDesktopMaximized, onFocus, clampPos]);

  // ── Resize ───────────────────────────────────────────────────────────────
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

  const onResizeMouseDown = useCallback((dir: ResizeDir) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDesktopMaximized) return;
    onFocus?.();
    const startG = { ...geomRef.current };
    const sx = e.clientX, sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - sx;
      const dy = me.clientY - sy;
      setGeom(() => {
        let { x, y, w, h } = { ...startG };
        const startRight = startG.x + startG.w;
        const startBottom = startG.y + startG.h;
        if (dir.includes('e')) w = Math.max(MIN_W, startG.w + dx);
        if (dir.includes('s')) h = Math.max(MIN_H, startG.h + dy);
        if (dir.includes('w')) {
          const desiredX = startG.x + dx;
          x = Math.min(desiredX, startRight - MIN_W);
          w = startRight - x;
        }
        if (dir.includes('n')) {
          const bounds = currentViewportBounds();
          const desiredY = startG.y + dy;
          y = Math.max(bounds.y, Math.min(desiredY, startBottom - MIN_H));
          h = startBottom - y;
        }
        return clampGeomToViewport({ x, y, w, h });
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [isDesktopMaximized, onFocus]);

  const onMaximizeClick = useCallback(() => {
    onFocus?.();
    onToggleMaximized?.();
  }, [onFocus, onToggleMaximized]);

  // Mobile: fullscreen with title bar
  if (isMobile) {
    return (
      <div className={['floating-panel', className].filter(Boolean).join(' ')} style={{ position: 'fixed', inset: 0, zIndex, background: '#0f172a', display: 'flex', flexDirection: 'column' }}>
        <div className="floating-panel-safe-area" style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0, background: '#0f172a' }} />
        <div className="floating-panel-titlebar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#1e293b', borderBottom: '1px solid #334155', flexShrink: 0 }}>
          <span
            title={title}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 13,
              color: '#94a3b8',
              fontWeight: 600,
            }}
          >
            {title}
          </span>
          <button
            onClick={onClose}
            title={t('window.close')}
            aria-label={t('window.close')}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 18, padding: '4px 8px', flexShrink: 0 }}
          >✕</button>
        </div>
        <div className="floating-panel-content" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    );
  }

  // Desktop: floating window
  const rh = 5; // resize handle size
  const displayGeom = isDesktopMaximized
    ? geometryFromWorkspace(getMaximizeBounds?.() ?? fallbackMaximizedGeometry())
    : geom;
  return (
    <div
      className={['floating-panel', className].filter(Boolean).join(' ')}
      data-testid={`floating-panel-${id}`}
      style={{
        position: 'fixed', left: displayGeom.x, top: displayGeom.y, width: displayGeom.w, height: displayGeom.h,
        zIndex, display: 'flex', flexDirection: 'column',
        background: '#0f172a', border: isDesktopMaximized ? '2px solid #3b82f6' : '1px solid #334155', borderRadius: 8,
        boxShadow: isDesktopMaximized ? '0 0 0 1px rgba(96,165,250,0.45), 0 12px 40px #00000060' : '0 12px 40px #00000060',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
      onMouseDown={() => onFocus?.()}
    >
      {/* Title bar — draggable */}
      <div
        className="floating-panel-titlebar"
        onMouseDown={startDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', background: '#1e293b', cursor: isDesktopMaximized ? 'default' : 'grab',
          borderBottom: '1px solid #334155', flexShrink: 0, userSelect: 'none',
        }}
      >
        <span
          title={title}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            color: '#94a3b8',
            fontWeight: 600,
          }}
        >
          {title}
        </span>
        {onPin && (
          <button
            onClick={onPin}
            class="subsession-minimize-btn"
            title={pinTooltip ?? t('sidebar.pin_to_sidebar')}
          >📌</button>
        )}
        {canUseDesktopMaximize && onToggleMaximized && (
          <DesktopWindowMaximizeButton
            data-testid="floating-maximize-toggle"
            onClick={onMaximizeClick}
            maximized={isDesktopMaximized}
          />
        )}
        <button
          onClick={onClose}
          class="subsession-minimize-btn"
          title={t('window.minimize')}
          aria-label={t('window.minimize')}
        >▾</button>
        <button
          onClick={onClose}
          class="subsession-close-btn"
          title={t('window.close')}
          aria-label={t('window.close')}
        >×</button>
      </div>

      {/* Content */}
      <div className="floating-panel-content" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Resize handles */}
      {!isDesktopMaximized && (
        <>
          <div data-testid="floating-resize-se" onMouseDown={onResizeMouseDown('se')} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'se-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-e" onMouseDown={onResizeMouseDown('e')} style={{ position: 'absolute', right: 0, top: rh, bottom: rh, width: rh, cursor: 'e-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-s" onMouseDown={onResizeMouseDown('s')} style={{ position: 'absolute', bottom: 0, left: rh, right: rh, height: rh, cursor: 's-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-w" onMouseDown={onResizeMouseDown('w')} style={{ position: 'absolute', left: 0, top: rh, bottom: rh, width: rh, cursor: 'w-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-n" onMouseDown={onResizeMouseDown('n')} style={{ position: 'absolute', top: 0, left: rh, right: rh, height: rh, cursor: 'n-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-nw" onMouseDown={onResizeMouseDown('nw')} style={{ position: 'absolute', left: 0, top: 0, width: 16, height: 16, cursor: 'nw-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-ne" onMouseDown={onResizeMouseDown('ne')} style={{ position: 'absolute', right: 0, top: 0, width: 16, height: 16, cursor: 'ne-resize', zIndex: 3 }} />
          <div data-testid="floating-resize-sw" onMouseDown={onResizeMouseDown('sw')} style={{ position: 'absolute', left: 0, bottom: 0, width: 16, height: 16, cursor: 'sw-resize', zIndex: 3 }} />
          <div
            data-testid="floating-bottom-drag"
            onMouseDown={startDrag}
            style={{ position: 'absolute', left: 24, right: 24, bottom: rh, height: 14, cursor: 'grab', zIndex: 2 }}
          />
        </>
      )}
    </div>
  );
}
