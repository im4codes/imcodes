/**
 * Mac desktop native shell ("Designed for iPad" / Mac Catalyst) bottom input-bar
 * inset detector and CSS variable synchronization.
 *
 * Combines two live channels (taking their maximum, never double-counting):
 *   1. Native UIKit `UIResponder.keyboardWillChangeFrameNotification` window-bottom
 *      overlap (`window.__IMCODES_MAC_BOTTOM_INSET__` + `imcodes:mac-bottom-inset`).
 *   2. Web `window.visualViewport` bottom shrink (`innerHeight - (vv.height + vv.offsetTop)`),
 *      which protects older OTA-updated Mac shells even before rebuilding the native binary.
 *
 * Converts unzoomed window points/pixels into `:root` CSS-zoom coordinates via
 * `getActiveCssZoom()` (`60%–150%`) and writes `--imcodes-mac-bottom-inset` without
 * activating mobile `.kb-open` / `.input-focused` chrome-hiding classes.
 */
import { useEffect } from 'preact/hooks';
import {
  IOS_MAC_DESKTOP_CLASS,
  NATIVE_HOST_EVENT,
  isNativeMacDesktop,
} from './native-platform.js';
import { getActiveCssZoom, UI_SCALE_EVENT } from './ui-scale.js';
import { createSettledViewportUpdater } from './visual-viewport.js';

export const MAC_BOTTOM_INSET_EVENT = 'imcodes:mac-bottom-inset';
export const MAC_BOTTOM_INSET_CSS_VAR = '--imcodes-mac-bottom-inset';
export const MAC_BOTTOM_INSET_GLOBAL_PROP = '__IMCODES_MAC_BOTTOM_INSET__';

const MIN_EFFECTIVE_INSET_PX = 2;
const MAX_INSET_WINDOW_RATIO = 0.8;
const PINCH_ZOOM_TOLERANCE = 0.02;

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

type MacInsetWindow = Window & typeof globalThis & {
  __IMCODES_MAC_BOTTOM_INSET__?: unknown;
};

function sanitizeRawInsetPx(raw: unknown, innerHeight?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < MIN_EFFECTIVE_INSET_PX) {
    return 0;
  }
  if (typeof innerHeight === 'number' && Number.isFinite(innerHeight) && innerHeight > 0) {
    if (raw >= innerHeight * MAX_INSET_WINDOW_RATIO) {
      return 0;
    }
  }
  return Math.round(raw * 100) / 100;
}

/** Read the latest native-reported bottom overlap (in unzoomed window points/pixels). */
export function readNativeMacBottomInsetPx(
  win: MacInsetWindow | undefined = globalThis as MacInsetWindow,
): number {
  if (!win) return 0;
  return sanitizeRawInsetPx(win.__IMCODES_MAC_BOTTOM_INSET__, win.innerHeight);
}

/**
 * Compute bottom occlusion from `window.visualViewport` relative to `window.innerHeight`.
 * Ignores trackpad pinch-zoom (`vv.scale !== 1`), sub-2px rounding jitter, and bogus full-window values.
 */
export function computeVisualViewportBottomInsetPx(params: {
  innerHeight: number;
  visualViewportHeight?: number | null;
  visualViewportOffsetTop?: number | null;
  visualViewportScale?: number | null;
}): number {
  const {
    innerHeight,
    visualViewportHeight,
    visualViewportOffsetTop,
    visualViewportScale,
  } = params;
  if (!Number.isFinite(innerHeight) || innerHeight <= 0) return 0;
  if (
    typeof visualViewportHeight !== 'number'
    || !Number.isFinite(visualViewportHeight)
    || visualViewportHeight <= 0
  ) {
    return 0;
  }
  if (
    typeof visualViewportScale === 'number'
    && Number.isFinite(visualViewportScale)
    && Math.abs(visualViewportScale - 1) > PINCH_ZOOM_TOLERANCE
  ) {
    return 0;
  }
  const offsetTop = (
    typeof visualViewportOffsetTop === 'number' && Number.isFinite(visualViewportOffsetTop)
  )
    ? Math.max(0, visualViewportOffsetTop)
    : 0;
  const shrink = innerHeight - (visualViewportHeight + offsetTop);
  return sanitizeRawInsetPx(shrink, innerHeight);
}

/**
 * Merge native and `visualViewport` bottom insets (in unzoomed window pixels) and convert
 * into `:root` CSS-zoom coordinates (`rawPx / cssZoom`) with 0.001px ceiling precision so
 * zoomed layouts (`60%–150%`, including Mac default `125%`) never under-shift by rounding.
 */
export function resolveMacBottomInsetCssPx(params: {
  nativeInsetPx: number;
  visualViewportInsetPx: number;
  cssZoom: number;
}): number {
  const nativePx = Number.isFinite(params.nativeInsetPx) ? Math.max(0, params.nativeInsetPx) : 0;
  const vvPx = Number.isFinite(params.visualViewportInsetPx) ? Math.max(0, params.visualViewportInsetPx) : 0;
  const rawInsetPx = Math.max(nativePx, vvPx);
  if (rawInsetPx < MIN_EFFECTIVE_INSET_PX) return 0;
  const safeZoom = Number.isFinite(params.cssZoom) && params.cssZoom > 0 ? params.cssZoom : 1;
  return Math.ceil((rawInsetPx / safeZoom) * 1000) / 1000;
}

/** Write or clear `--imcodes-mac-bottom-inset` on `document.documentElement`. */
export function applyMacBottomInsetCssVar(
  root: HTMLElement | null | undefined,
  cssInsetPx: number,
): void {
  if (!root) return;
  if (!Number.isFinite(cssInsetPx) || cssInsetPx <= 0) {
    root.style.removeProperty(MAC_BOTTOM_INSET_CSS_VAR);
    return;
  }
  const formatted = `${Number(cssInsetPx.toFixed(3))}px`;
  if (root.style.getPropertyValue(MAC_BOTTOM_INSET_CSS_VAR) !== formatted) {
    root.style.setProperty(MAC_BOTTOM_INSET_CSS_VAR, formatted);
  }
}

/** Identify text-entry elements that can summon the macOS input assistant / IME bar. */
export function isMacEditableTarget(el: Element | null | undefined): boolean {
  if (!el || typeof el !== 'object') return false;
  const tag = el.tagName?.toUpperCase?.() ?? '';
  if (tag === 'TEXTAREA') {
    return !(el as HTMLTextAreaElement).disabled && !(el as HTMLTextAreaElement).readOnly;
  }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.disabled || input.readOnly) return false;
    const type = (input.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  const htmlEl = el as HTMLElement;
  if (htmlEl.isContentEditable) return true;
  const attr = htmlEl.getAttribute?.('contenteditable');
  return attr === '' || attr === 'true' || attr === 'plaintext-only';
}

export interface InstallMacInputInsetOptions {
  enabled?: boolean;
  win?: MacInsetWindow;
  doc?: Document;
}

/**
 * Install dual-channel Mac bottom-inset listeners and keep `--imcodes-mac-bottom-inset`
 * synchronized. No-op (and clears any stale CSS var) on non-Mac platforms.
 */
export function installMacInputInset(options: InstallMacInputInsetOptions = {}): () => void {
  const win = options.win ?? (globalThis as MacInsetWindow);
  const doc = options.doc ?? win?.document;
  const root = doc?.documentElement;
  const enabled = options.enabled ?? isNativeMacDesktop();

  if (!win || !doc || !root || !enabled) {
    applyMacBottomInsetCssVar(root, 0);
    return () => {};
  }

  root.classList.add(IOS_MAC_DESKTOP_CLASS);
  root.classList.remove('kb-open', 'input-focused', 'subcard-input-focused');

  let nativeInsetPx = readNativeMacBottomInsetPx(win);
  let hadEditableFocus = isMacEditableTarget(doc.activeElement);
  let lastWindowW = win.innerWidth;
  let lastWindowH = win.innerHeight;
  let blurResetTimer: ReturnType<typeof setTimeout> | undefined;

  const sync = () => {
    root.classList.remove('kb-open', 'input-focused', 'subcard-input-focused');
    const vv = win.visualViewport;
    const vvInsetPx = computeVisualViewportBottomInsetPx({
      innerHeight: win.innerHeight,
      visualViewportHeight: vv?.height,
      visualViewportOffsetTop: vv?.offsetTop,
      visualViewportScale: vv?.scale,
    });
    const cssZoom = getActiveCssZoom(doc);
    const cssInsetPx = resolveMacBottomInsetCssPx({
      nativeInsetPx,
      visualViewportInsetPx: vvInsetPx,
      cssZoom,
    });
    applyMacBottomInsetCssVar(root, cssInsetPx);

    if (
      cssInsetPx > 0
      && (win.scrollY !== 0 || root.scrollTop !== 0 || (doc.body && doc.body.scrollTop !== 0))
    ) {
      win.scrollTo?.(0, 0);
      root.scrollTop = 0;
      if (doc.body) doc.body.scrollTop = 0;
    }
  };

  const settledUpdater = createSettledViewportUpdater(sync, {
    requestFrame: (cb) => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(cb) : win.setTimeout(() => cb(Date.now()), 16)),
    cancelFrame: (id) => (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame(id) : win.clearTimeout(id)),
    setTimer: (cb, ms) => win.setTimeout(cb, ms),
    clearTimer: (id) => win.clearTimeout(id),
  });

  const onNativeInset = (event: Event) => {
    const detailInset = (event as CustomEvent<{ inset?: unknown }>).detail?.inset;
    if (detailInset !== undefined) {
      nativeInsetPx = sanitizeRawInsetPx(detailInset, win.innerHeight);
      win.__IMCODES_MAC_BOTTOM_INSET__ = nativeInsetPx;
    } else {
      nativeInsetPx = readNativeMacBottomInsetPx(win);
    }
    sync();
  };

  const onWindowResize = () => {
    const resized = win.innerWidth !== lastWindowW || win.innerHeight !== lastWindowH;
    if (resized) {
      lastWindowW = win.innerWidth;
      lastWindowH = win.innerHeight;
      if (!isMacEditableTarget(doc.activeElement) && nativeInsetPx > 0) {
        nativeInsetPx = 0;
        win.__IMCODES_MAC_BOTTOM_INSET__ = 0;
      }
    }
    settledUpdater.schedule();
  };

  const onFocusIn = (event: FocusEvent) => {
    if (isMacEditableTarget((event.target as Element | null) ?? doc.activeElement)) {
      if (blurResetTimer !== undefined) {
        clearTimeout(blurResetTimer);
        blurResetTimer = undefined;
      }
      hadEditableFocus = true;
    }
    settledUpdater.schedule();
  };

  const onFocusOut = () => {
    if (blurResetTimer !== undefined) {
      clearTimeout(blurResetTimer);
    }
    blurResetTimer = setTimeout(() => {
      blurResetTimer = undefined;
      const stillEditable = isMacEditableTarget(doc.activeElement);
      if (hadEditableFocus && !stillEditable) {
        hadEditableFocus = false;
        nativeInsetPx = 0;
        win.__IMCODES_MAC_BOTTOM_INSET__ = 0;
      }
      settledUpdater.schedule();
    }, 0);
  };

  const onVisibilityChange = () => {
    if (doc.visibilityState !== 'visible' || !isMacEditableTarget(doc.activeElement)) {
      if (!isMacEditableTarget(doc.activeElement)) {
        hadEditableFocus = false;
        nativeInsetPx = 0;
        win.__IMCODES_MAC_BOTTOM_INSET__ = 0;
      }
    }
    settledUpdater.schedule();
  };

  const onNativeHostChange = () => {
    nativeInsetPx = readNativeMacBottomInsetPx(win);
    sync();
  };

  sync();

  const vv = win.visualViewport;
  win.addEventListener(MAC_BOTTOM_INSET_EVENT, onNativeInset);
  win.addEventListener('resize', onWindowResize);
  win.addEventListener('pageshow', settledUpdater.schedule);
  win.addEventListener(UI_SCALE_EVENT, sync);
  win.addEventListener(NATIVE_HOST_EVENT, onNativeHostChange);
  vv?.addEventListener('resize', settledUpdater.schedule);
  vv?.addEventListener('scroll', settledUpdater.schedule);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    settledUpdater.cancel();
    if (blurResetTimer !== undefined) {
      clearTimeout(blurResetTimer);
      blurResetTimer = undefined;
    }
    win.removeEventListener(MAC_BOTTOM_INSET_EVENT, onNativeInset);
    win.removeEventListener('resize', onWindowResize);
    win.removeEventListener('pageshow', settledUpdater.schedule);
    win.removeEventListener(UI_SCALE_EVENT, sync);
    win.removeEventListener(NATIVE_HOST_EVENT, onNativeHostChange);
    vv?.removeEventListener('resize', settledUpdater.schedule);
    vv?.removeEventListener('scroll', settledUpdater.schedule);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('focusout', onFocusOut);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    applyMacBottomInsetCssVar(root, 0);
  };
}

/** Preact hook binding Mac bottom-inset synchronization when running on a Mac native host. */
export function useMacInputInset(isNativeMac: boolean): void {
  useEffect(() => {
    if (!isNativeMac) {
      applyMacBottomInsetCssVar(globalThis.document?.documentElement, 0);
      return;
    }
    return installMacInputInset({ enabled: true });
  }, [isNativeMac]);
}
