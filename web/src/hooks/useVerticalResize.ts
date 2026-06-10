/**
 * useVerticalResize — bottom-edge vertical resize behavior shared by the sidebar
 * pinned panels and the session-tree popup.
 *
 * Tracks a live local height while the user drags a bottom resize handle (mouse
 * or touch) and reports the final height via `onResize` so the parent can
 * persist it. Extracted so the session tree and pinned panels share one
 * implementation instead of duplicating the drag logic.
 */

import { useRef, useCallback, useEffect, useState } from 'preact/hooks';

export interface UseVerticalResizeOptions {
  /** Current/desired height in px (controlled from the parent). */
  height: number;
  /** Minimum height in px. Default 100. */
  minHeight?: number;
  /** Called with the final height when a drag completes (for persistence). */
  onResize?: (height: number) => void;
}

export interface VerticalResizeHandlers {
  /** Live height — updates continuously during a drag. */
  height: number;
  /** Attach to the resize handle's `onMouseDown`. */
  onMouseDown: (e: MouseEvent) => void;
  /** Attach to the resize handle's `onTouchStart`. */
  onTouchStart: (e: TouchEvent) => void;
}

export function useVerticalResize({
  height,
  minHeight = 100,
  onResize,
}: UseVerticalResizeOptions): VerticalResizeHandlers {
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const [localHeight, setLocalHeight] = useState(height);

  useEffect(() => { setLocalHeight(height); }, [height]);

  const startDrag = useCallback((clientY: number) => {
    isDraggingRef.current = true;
    startYRef.current = clientY;
    startHeightRef.current = localHeight;
  }, [localHeight]);

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startDrag(e.clientY);

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.clientY - startYRef.current;
      setLocalHeight(Math.max(minHeight, startHeightRef.current + delta));
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const finalH = Math.max(minHeight, startHeightRef.current + (ev.clientY - startYRef.current));
      setLocalHeight(finalH);
      onResize?.(finalH);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [startDrag, onResize, minHeight]);

  const onTouchStart = useCallback((e: TouchEvent) => {
    e.stopPropagation();
    startDrag(e.touches[0].clientY);

    const onTouchMove = (ev: TouchEvent) => {
      if (!isDraggingRef.current) return;
      const delta = ev.touches[0].clientY - startYRef.current;
      setLocalHeight(Math.max(minHeight, startHeightRef.current + delta));
    };

    const onTouchEnd = (ev: TouchEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      const finalH = Math.max(minHeight, startHeightRef.current + (ev.changedTouches[0].clientY - startYRef.current));
      setLocalHeight(finalH);
      onResize?.(finalH);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };

    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
  }, [startDrag, onResize, minHeight]);

  return { height: localHeight, onMouseDown, onTouchStart };
}
