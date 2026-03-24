/**
 * FloatingPanel — reusable draggable/resizable floating window.
 * Used for RepoPage, DiscussionsPage, and other full-page overlays
 * that should behave like floating windows on desktop.
 */
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface WindowGeometry { x: number; y: number; w: number; h: number }

interface Props {
  id: string;
  title: string;
  children: ComponentChildren;
  onClose: () => void;
  zIndex?: number;
  onFocus?: () => void;
  defaultW?: number;
  defaultH?: number;
}

const MIN_W = 360;
const MIN_H = 280;
const DRAG_MARGIN = 32;

function loadGeom(id: string, dw: number, dh: number): WindowGeometry {
  try {
    const raw = localStorage.getItem(`rcc_float_${id}`);
    if (raw) return JSON.parse(raw) as WindowGeometry;
  } catch { /* ignore */ }
  return {
    x: Math.max(0, (window.innerWidth - dw) / 2),
    y: Math.max(0, (window.innerHeight - dh) / 2 - 40),
    w: dw, h: dh,
  };
}

function saveGeom(id: string, geom: WindowGeometry) {
  try { localStorage.setItem(`rcc_float_${id}`, JSON.stringify(geom)); } catch { /* ignore */ }
}

export function FloatingPanel({ id, title, children, onClose, zIndex = 2000, onFocus, defaultW = 700, defaultH = 520 }: Props) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const [geom, setGeom] = useState(() => loadGeom(id, defaultW, defaultH));
  const geomRef = useRef(geom);
  geomRef.current = geom;

  useEffect(() => { saveGeom(id, geom); }, [id, geom]);

  // ── Drag ─────────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const clampPos = useCallback((x: number, y: number, w: number) => ({
    x: Math.min(Math.max(x, DRAG_MARGIN - w), window.innerWidth - DRAG_MARGIN),
    y: Math.min(Math.max(y, 0), window.innerHeight - DRAG_MARGIN),
  }), []);

  const startDrag = useCallback((e: MouseEvent) => {
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
  }, [onFocus, clampPos]);

  // ── Resize ───────────────────────────────────────────────────────────────
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

  const onResizeMouseDown = useCallback((dir: ResizeDir) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onFocus?.();
    const startG = { ...geomRef.current };
    const sx = e.clientX, sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - sx;
      const dy = me.clientY - sy;
      setGeom(() => {
        let { x, y, w, h } = { ...startG };
        if (dir.includes('e')) w = Math.max(MIN_W, startG.w + dx);
        if (dir.includes('s')) h = Math.max(MIN_H, startG.h + dy);
        if (dir.includes('w')) { w = Math.max(MIN_W, startG.w - dx); x = startG.x + (startG.w - w); }
        if (dir.includes('n')) { h = Math.max(MIN_H, startG.h - dy); y = startG.y + (startG.h - h); }
        return { x, y, w, h };
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onFocus]);

  // Mobile: fullscreen
  if (isMobile) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex, background: '#0f172a', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        {children}
      </div>
    );
  }

  // Desktop: floating window
  const rh = 5; // resize handle size
  return (
    <div
      style={{
        position: 'fixed', left: geom.x, top: geom.y, width: geom.w, height: geom.h,
        zIndex, display: 'flex', flexDirection: 'column',
        background: '#0f172a', border: '1px solid #334155', borderRadius: 8,
        boxShadow: '0 12px 40px #00000060', overflow: 'hidden',
      }}
      onMouseDown={() => onFocus?.()}
    >
      {/* Title bar — draggable */}
      <div
        onMouseDown={startDrag}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', background: '#1e293b', cursor: 'grab',
          borderBottom: '1px solid #334155', flexShrink: 0, userSelect: 'none',
        }}
      >
        <span style={{ flex: 1, fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>{title}</span>
        <button
          onClick={onClose}
          class="subsession-minimize-btn"
          title="Minimize"
        >▾</button>
        <button
          onClick={onClose}
          class="subsession-close-btn"
          title="Close"
        >×</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Resize handles */}
      <div onMouseDown={onResizeMouseDown('se')} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'se-resize' }} />
      <div onMouseDown={onResizeMouseDown('e')} style={{ position: 'absolute', right: 0, top: rh, bottom: rh, width: rh, cursor: 'e-resize' }} />
      <div onMouseDown={onResizeMouseDown('s')} style={{ position: 'absolute', bottom: 0, left: rh, right: rh, height: rh, cursor: 's-resize' }} />
      <div onMouseDown={onResizeMouseDown('w')} style={{ position: 'absolute', left: 0, top: rh, bottom: rh, width: rh, cursor: 'w-resize' }} />
      <div onMouseDown={onResizeMouseDown('n')} style={{ position: 'absolute', top: 0, left: rh, right: rh, height: rh, cursor: 'n-resize' }} />
      <div onMouseDown={onResizeMouseDown('nw')} style={{ position: 'absolute', left: 0, top: 0, width: 16, height: 16, cursor: 'nw-resize' }} />
      <div onMouseDown={onResizeMouseDown('ne')} style={{ position: 'absolute', right: 0, top: 0, width: 16, height: 16, cursor: 'ne-resize' }} />
      <div onMouseDown={onResizeMouseDown('sw')} style={{ position: 'absolute', left: 0, bottom: 0, width: 16, height: 16, cursor: 'sw-resize' }} />
    </div>
  );
}
