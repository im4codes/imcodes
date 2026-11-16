import type { WindowGeometry } from '../desktop-window-maximize.js';

export const WINDOW_DRAGGING_CLASS = 'imcodes-window-dragging';

const guardCounts = new WeakMap<Document, number>();

function isSelectionEditable(doc: Document, sel: Selection | null): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    return true;
  }
  const anchor = sel?.anchorNode ?? null;
  const anchorEl = anchor
    ? (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement)
    : null;
  return Boolean(anchorEl?.closest('[contenteditable="true"], [contenteditable=""], input, textarea'));
}

function clearNonEditableSelection(doc: Document): void {
  const sel = doc.defaultView?.getSelection?.() ?? doc.getSelection?.() ?? null;
  if (!sel || sel.rangeCount === 0) return;
  if (isSelectionEditable(doc, sel)) return;
  try {
    sel.removeAllRanges();
  } catch {
    // ignore WebKit selection edge errors
  }
}

/**
 * Lock document-level text selection for the duration of a floating-window
 * pointer drag or resize. Under WKWebView / isiOSAppOnMac, moving a fixed
 * window across scrollable chat views can otherwise initiate native UIKit
 * text selection across underlying containers and paint a full-height overlay
 * above all floating windows.
 */
export function acquireWindowPointerInteractionGuard(doc: Document = document): () => void {
  const prev = guardCounts.get(doc) ?? 0;
  guardCounts.set(doc, prev + 1);
  if (prev === 0) {
    doc.documentElement.classList.add(WINDOW_DRAGGING_CLASS);
    clearNonEditableSelection(doc);
  }

  const onSelectStart = (ev: Event) => {
    ev.preventDefault();
  };
  const onSelectionChange = () => {
    clearNonEditableSelection(doc);
  };

  doc.addEventListener('selectstart', onSelectStart, true);
  doc.addEventListener('selectionchange', onSelectionChange);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    doc.removeEventListener('selectstart', onSelectStart, true);
    doc.removeEventListener('selectionchange', onSelectionChange);
    const next = Math.max(0, (guardCounts.get(doc) ?? 1) - 1);
    if (next === 0) {
      guardCounts.delete(doc);
      doc.documentElement.classList.remove(WINDOW_DRAGGING_CLASS);
    } else {
      guardCounts.set(doc, next);
    }
  };
}

export interface FloatingWindowDragOptions {
  element: HTMLElement | null;
  startX: number;
  startY: number;
  origin: WindowGeometry;
  clampPos: (x: number, y: number, w: number, h: number) => { x: number; y: number };
  onCommit: (x: number, y: number) => void;
  doc?: Document;
}

/**
 * Drive a desktop floating-window drag using a rAF-coalesced GPU transform
 * (`translate3d`) while the pointer is moving, committing final `left`/`top`
 * geometry synchronously on release and cleaning up all listeners/guards.
 */
export function startFloatingWindowDrag(options: FloatingWindowDragOptions): () => void {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const releaseGuard = acquireWindowPointerInteractionGuard(doc);
  const el = options.element;
  let lastClientX = options.startX;
  let lastClientY = options.startY;
  let hasMoved = false;
  let rafId: number | null = null;
  let finished = false;

  if (el) {
    el.style.willChange = 'transform';
  }

  const computeAt = (clientX: number, clientY: number) => {
    const dx = clientX - options.startX;
    const dy = clientY - options.startY;
    return options.clampPos(
      options.origin.x + dx,
      options.origin.y + dy,
      options.origin.w,
      options.origin.h,
    );
  };

  const applyTransform = () => {
    rafId = null;
    if (finished || !el) return;
    const clamped = computeAt(lastClientX, lastClientY);
    const tx = clamped.x - options.origin.x;
    const ty = clamped.y - options.origin.y;
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  };

  const onMove = (me: MouseEvent) => {
    if (finished) return;
    lastClientX = me.clientX;
    lastClientY = me.clientY;
    hasMoved = true;
    if (!el) return;
    if (typeof win.requestAnimationFrame === 'function') {
      if (rafId === null) {
        rafId = win.requestAnimationFrame(applyTransform);
      }
    } else {
      applyTransform();
    }
  };

  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
      rafId = null;
    }
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('mouseup', onUp);
    win.removeEventListener('blur', onBlur);
    if (el) {
      el.style.transform = '';
      el.style.willChange = '';
    }
    if (commit && hasMoved) {
      const finalPos = computeAt(lastClientX, lastClientY);
      options.onCommit(finalPos.x, finalPos.y);
    }
    releaseGuard();
  };

  const onUp = () => {
    finish(true);
  };

  const onBlur = () => {
    finish(true);
  };

  doc.addEventListener('mousemove', onMove);
  doc.addEventListener('mouseup', onUp);
  win.addEventListener('blur', onBlur);

  return () => finish(false);
}

export interface FloatingWindowResizeOptions {
  startX: number;
  startY: number;
  computeGeometry: (dx: number, dy: number) => WindowGeometry;
  onUpdate: (geom: WindowGeometry) => void;
  onEnd?: () => void;
  doc?: Document;
}

/**
 * Drive a desktop floating-window resize with rAF-coalesced intermediate updates,
 * selection lock, and synchronous final geometry commit on mouseup/blur.
 */
export function startFloatingWindowResize(options: FloatingWindowResizeOptions): () => void {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const releaseGuard = acquireWindowPointerInteractionGuard(doc);
  let lastDx = 0;
  let lastDy = 0;
  let hasMoved = false;
  let rafId: number | null = null;
  let finished = false;

  const applyFrame = () => {
    rafId = null;
    if (finished) return;
    options.onUpdate(options.computeGeometry(lastDx, lastDy));
  };

  const onMove = (me: MouseEvent) => {
    if (finished) return;
    lastDx = me.clientX - options.startX;
    lastDy = me.clientY - options.startY;
    hasMoved = true;
    if (typeof win.requestAnimationFrame === 'function') {
      if (rafId === null) {
        rafId = win.requestAnimationFrame(applyFrame);
      }
    } else {
      applyFrame();
    }
  };

  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
      rafId = null;
    }
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('mouseup', onUp);
    win.removeEventListener('blur', onBlur);
    if (commit && hasMoved) {
      options.onUpdate(options.computeGeometry(lastDx, lastDy));
    }
    options.onEnd?.();
    releaseGuard();
  };

  const onUp = () => {
    finish(true);
  };

  const onBlur = () => {
    finish(true);
  };

  doc.addEventListener('mousemove', onMove);
  doc.addEventListener('mouseup', onUp);
  win.addEventListener('blur', onBlur);

  return () => finish(false);
}
