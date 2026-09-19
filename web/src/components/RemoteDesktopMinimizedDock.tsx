import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * The chip a minimized remote-desktop window collapses into. It sits right
 * under the "AI Desk" shortcut (the thing that opens these windows) instead of
 * floating in the screen corner, is deliberately small, and the window visibly
 * shrinks into it on minimize.
 */

/** Where the chip is anchored: the AI Desk shortcut group in the toolbar. */
const DOCK_ANCHOR_SELECTOR = '.controlled-nodes-shortcut-group';
const DOCK_GAP_PX = 5;
/** Vertical pitch between chips when more than one window is minimized. */
const DOCK_SLOT_PITCH_PX = 28;
const MINIMIZE_ANIMATION_MS = 280;
const DOCK_SELECTOR = '.remote-desktop-minimized-dock';
/** Fired when a chip goes away so the ones below it close the gap. */
const DOCK_LAYOUT_EVENT = 'imcodes:remote-desktop-dock-layout';

export interface RemoteDesktopMinimizeOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type RemoteDesktopMinimizeOriginRef = RefObject<RemoteDesktopMinimizeOrigin | null>;

/** Remember where the window is right now, before minimizing hides it. */
export function rememberMinimizeOrigin(
  originRef: RemoteDesktopMinimizeOriginRef,
  from: Element | null,
): void {
  const rect = from?.closest('.floating-panel')?.getBoundingClientRect();
  originRef.current = rect && rect.width > 0 && rect.height > 0
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : null;
}

interface DockPosition { left: number; top: number }

function measureAnchor(dock: Element | null): DockPosition | null {
  // Chips stack downward in DOM order; the first one sits right under the anchor.
  const slot = Math.max(0, dock ? Array.from(document.querySelectorAll(DOCK_SELECTOR)).indexOf(dock) : 0);
  const anchor = document.querySelector(DOCK_ANCHOR_SELECTOR);
  const rect = anchor?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.bottom + DOCK_GAP_PX + slot * DOCK_SLOT_PITCH_PX };
}

export function RemoteDesktopMinimizedDock({
  label,
  ariaLabel,
  originRef,
  onRestore,
}: {
  label: string;
  ariaLabel?: string;
  originRef: RemoteDesktopMinimizeOriginRef;
  onRestore(): void;
}) {
  const dockRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<DockPosition | null>(null);
  const [ghost, setGhost] = useState<RemoteDesktopMinimizeOrigin | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // Track the AI Desk shortcut across layout changes; without one on screen
  // the stylesheet's corner placement stays in effect.
  useLayoutEffect(() => {
    const update = () => setPosition(measureAnchor(dockRef.current));
    update();
    window.addEventListener('resize', update);
    window.addEventListener(DOCK_LAYOUT_EVENT, update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener(DOCK_LAYOUT_EVENT, update);
      window.dispatchEvent(new Event(DOCK_LAYOUT_EVENT));
    };
  }, []);

  // Shrink the window into the chip: a ghost of the window's frame flies from
  // where the window was to where the chip is, then disappears.
  useLayoutEffect(() => {
    const origin = originRef.current;
    originRef.current = null;
    if (!origin) return;
    setGhost(origin);
  }, [originRef]);

  useLayoutEffect(() => {
    const el = ghostRef.current;
    const dock = dockRef.current?.getBoundingClientRect();
    if (!ghost || !el || !dock || typeof el.animate !== 'function') {
      if (ghost) setGhost(null);
      return;
    }
    const animation = el.animate([
      { left: `${ghost.left}px`, top: `${ghost.top}px`, width: `${ghost.width}px`, height: `${ghost.height}px`, opacity: 0.9 },
      { left: `${dock.left}px`, top: `${dock.top}px`, width: `${dock.width}px`, height: `${dock.height}px`, opacity: 0.15 },
    ], { duration: MINIMIZE_ANIMATION_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    const done = () => setGhost(null);
    animation.onfinish = done;
    animation.oncancel = done;
    return () => { animation.onfinish = null; animation.oncancel = null; animation.cancel(); };
  }, [ghost]);

  return (
    <>
      <button
        ref={dockRef}
        type="button"
        class="remote-desktop-minimized-dock"
        style={position ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto' } : undefined}
        onClick={onRestore}
        aria-label={ariaLabel}
      >{label}</button>
      {ghost && (
        <div
          ref={ghostRef}
          class="remote-desktop-minimize-ghost"
          aria-hidden="true"
          style={{ left: `${ghost.left}px`, top: `${ghost.top}px`, width: `${ghost.width}px`, height: `${ghost.height}px` }}
        />
      )}
    </>
  );
}
