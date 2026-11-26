/**
 * Global gate that suppresses pointer-triggered hover previews immediately
 * after keyboard tab/server navigation until the user actually moves the
 * pointer to a new viewport coordinate.
 */

interface PointerPosition {
  x: number;
  y: number;
}

let lastPointerPos: PointerPosition | null = null;
let hoverSuppressed = false;
let suppressedAtPos: PointerPosition | null = null;
let listenersInstalled = false;
const subscribers = new Set<() => void>();

function handlePointerMove(event: Event): void {
  if ((event as PointerEvent).pointerType === 'touch') return;
  const { clientX, clientY } = event as MouseEvent;
  if (typeof clientX !== 'number' || typeof clientY !== 'number' || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return;
  }
  lastPointerPos = { x: clientX, y: clientY };
  if (!hoverSuppressed) return;
  if (suppressedAtPos === null || suppressedAtPos.x !== clientX || suppressedAtPos.y !== clientY) {
    hoverSuppressed = false;
    suppressedAtPos = null;
  }
}

function ensureListenersInstalled(): void {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
  window.addEventListener('mousemove', handlePointerMove, { capture: true, passive: true });
}

export function suppressHoverPreviewsUntilPointerMove(): void {
  ensureListenersInstalled();
  hoverSuppressed = true;
  suppressedAtPos = lastPointerPos ? { ...lastPointerPos } : null;
  for (const notify of [...subscribers]) {
    notify();
  }
}

export function isHoverPreviewSuppressed(): boolean {
  ensureListenersInstalled();
  return hoverSuppressed;
}

export function onHoverPreviewSuppressed(listener: () => void): () => void {
  ensureListenersInstalled();
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function resetHoverPreviewGateForTests(): void {
  if (typeof window !== 'undefined' && listenersInstalled) {
    window.removeEventListener('pointermove', handlePointerMove, true);
    window.removeEventListener('mousemove', handlePointerMove, true);
  }
  listenersInstalled = false;
  hoverSuppressed = false;
  suppressedAtPos = null;
  lastPointerPos = null;
  subscribers.clear();
}

ensureListenersInstalled();
