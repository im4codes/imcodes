import { options } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  CHAT_FONT_SIZE_VAR,
  GLOBAL_FONT_DELTA_VAR,
  MIN_SCALED_FONT_PX,
  scaledCssFontLength,
  scaledCssFontPx,
  transformCssFontSizes,
} from './global-font-css.js';

export {
  CHAT_FONT_SIZE_VAR,
  GLOBAL_FONT_DELTA_VAR,
  MIN_SCALED_FONT_PX,
  scaledCssFontLength,
  scaledCssFontPx,
  transformCssFontSizes,
};

export const GLOBAL_FONT_DELTA_STORAGE_KEY = 'imcodes_globalFontDelta';
export const GLOBAL_FONT_DELTA_EVENT = 'imcodes:globalFontDeltaChanged';

export const DEFAULT_GLOBAL_FONT_DELTA = 0;
export const MIN_GLOBAL_FONT_DELTA = -6;
export const MAX_GLOBAL_FONT_DELTA = 12;

const FONT_SIZE_LITERAL_RE = /^\s*(\d+(?:\.\d+)?|\.\d+)(px|rem)\s*$/i;

export function clampGlobalFontDelta(delta: number): number {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return DEFAULT_GLOBAL_FONT_DELTA;
  }
  const rounded = Math.round(delta);
  if (Object.is(rounded, -0)) return 0;
  return Math.min(MAX_GLOBAL_FONT_DELTA, Math.max(MIN_GLOBAL_FONT_DELTA, rounded));
}

export function formatGlobalFontDelta(delta: number): string {
  const clamped = clampGlobalFontDelta(delta);
  if (clamped > 0) return `+${clamped}`;
  return String(clamped);
}

export function readGlobalFontDelta(): number {
  try {
    const raw = localStorage.getItem(GLOBAL_FONT_DELTA_STORAGE_KEY);
    if (raw === null) return DEFAULT_GLOBAL_FONT_DELTA;
    const trimmed = raw.trim();
    if (!trimmed) return DEFAULT_GLOBAL_FONT_DELTA;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? clampGlobalFontDelta(parsed) : DEFAULT_GLOBAL_FONT_DELTA;
  } catch {
    return DEFAULT_GLOBAL_FONT_DELTA;
  }
}

export function applyGlobalFontDelta(
  delta: number,
  target: HTMLElement | undefined = typeof document !== 'undefined' ? document.documentElement : undefined,
): void {
  if (!target) return;
  const clamped = clampGlobalFontDelta(delta);
  target.style.setProperty(GLOBAL_FONT_DELTA_VAR, `${clamped}px`);
}

export function writeGlobalFontDelta(delta: number): number {
  const clamped = clampGlobalFontDelta(delta);
  try {
    localStorage.setItem(GLOBAL_FONT_DELTA_STORAGE_KEY, String(clamped));
  } catch {
    // Storage unavailable (private mode / quota) — still apply to DOM and notify live listeners.
  }
  applyGlobalFontDelta(clamped);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(GLOBAL_FONT_DELTA_EVENT, { detail: { delta: clamped } }));
  }
  return clamped;
}

export function useGlobalFontDelta(): [number, (next: number | ((prev: number) => number)) => void] {
  const [delta, setDeltaState] = useState<number>(() => readGlobalFontDelta());
  const latestRef = useRef(delta);
  latestRef.current = delta;

  useEffect(() => {
    const syncFromEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ delta?: number }>).detail;
      const next = typeof detail?.delta === 'number'
        ? clampGlobalFontDelta(detail.delta)
        : readGlobalFontDelta();
      latestRef.current = next;
      setDeltaState(next);
    };
    const syncFromStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== GLOBAL_FONT_DELTA_STORAGE_KEY) return;
      const next = readGlobalFontDelta();
      latestRef.current = next;
      setDeltaState(next);
    };
    window.addEventListener(GLOBAL_FONT_DELTA_EVENT, syncFromEvent);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(GLOBAL_FONT_DELTA_EVENT, syncFromEvent);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  const update = useCallback((nextOrFn: number | ((prev: number) => number)) => {
    const candidate = typeof nextOrFn === 'function' ? nextOrFn(latestRef.current) : nextOrFn;
    const clamped = writeGlobalFontDelta(candidate);
    latestRef.current = clamped;
    setDeltaState(clamped);
  }, []);

  return [delta, update];
}

function scaleInlineFontSizeValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return scaledCssFontPx(value);
  }
  if (typeof value === 'string') {
    const match = FONT_SIZE_LITERAL_RE.exec(value);
    if (match) {
      const num = Number(match[1]);
      const unit = match[2].toLowerCase() as 'px' | 'rem';
      if (Number.isFinite(num)) return scaledCssFontLength(num, unit);
    }
  }
  return undefined;
}

let vnodeHookInstalled = false;

/**
 * Installs a Preact `options.vnode` hook that transparently scales static numeric
 * / `px` inline `style.fontSize` declarations (including shared/module-level style
 * objects, without mutating them) using `--imcodes-global-font-delta`.
 */
export function installGlobalFontVnodeHook(): void {
  if (vnodeHookInstalled) return;
  vnodeHookInstalled = true;

  const prevHook = options.vnode;
  options.vnode = (vnode) => {
    prevHook?.(vnode);

    if (typeof vnode.type !== 'string') return;
    if (vnode.type === 'text' || vnode.type === 'tspan') return;
    const props = vnode.props as Record<string, unknown> | undefined;
    if (!props) return;

    const style = props.style;
    if (!style) return;

    if (typeof style === 'string') {
      if (style.includes('font-size')) {
        props.style = transformCssFontSizes(style);
      }
      return;
    }

    if (typeof style === 'object') {
      const styleObj = style as Record<string, unknown>;
      const scaledCamel = scaleInlineFontSizeValue(styleObj.fontSize);
      const scaledKebab = scaleInlineFontSizeValue(styleObj['font-size']);
      if (scaledCamel !== undefined || scaledKebab !== undefined) {
        const cloned = { ...styleObj };
        if (scaledCamel !== undefined) cloned.fontSize = scaledCamel;
        if (scaledKebab !== undefined) cloned['font-size'] = scaledKebab;
        props.style = cloned;
      }
    }
  };
}

export function initGlobalFontScale(): void {
  applyGlobalFontDelta(readGlobalFontDelta());
  installGlobalFontVnodeHook();
}
