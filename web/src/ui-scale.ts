/**
 * Global whole-page UI scale (%) state and CSS zoom application.
 * Unifies scaling across desktop browsers, Android, iOS, Mac Catalyst (default 100%),
 * and Designed-for-iPad Mac native shells (default 125%) without double-zooming.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  NATIVE_HOST_EVENT,
  isDesignedForIpadMac,
  readNativePlatformEnvironment,
  type NativePlatformEnvironment,
} from './native-platform';

export const UI_SCALE_STORAGE_KEY = 'imcodes_uiScale';
export const UI_SCALE_PROMPTED_STORAGE_KEY = 'imcodes_uiScalePrompted';
export const UI_SCALE_EVENT = 'imcodes:uiScaleChanged';
export const UI_SCALE_PROMPT_EVENT = 'imcodes:uiScalePromptChanged';
export const UI_SCALE_ZOOM_VAR = '--imcodes-ui-zoom';
export const DEFAULT_UI_SCALE = 100;
export const DESIGNED_FOR_IPAD_DEFAULT_UI_SCALE = 125;
export const MIN_UI_SCALE = 60;
export const MAX_UI_SCALE = 150;
export const UI_SCALE_STEP = 5;

/** Clamp an in-bounds or programmatic UI scale percentage to `[MIN_UI_SCALE, MAX_UI_SCALE]`. */
export function clampUiScale(value: number, fallback: number = DEFAULT_UI_SCALE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_UI_SCALE, Math.min(MAX_UI_SCALE, Math.round(value)));
}

/** Format a UI scale percentage as a user-facing label (e.g. `100%`). */
export function formatUiScale(scale: number): string {
  return `${clampUiScale(scale)}%`;
}

/**
 * Default UI scale for the current environment: `125%` on Designed-for-iPad Mac native shells
 * (old OTA shells and new native shells, excluding Mac Catalyst `native-1x`), `100%` everywhere else.
 */
export function getDefaultUiScale(
  env: NativePlatformEnvironment = readNativePlatformEnvironment(),
): number {
  return isDesignedForIpadMac(env) ? DESIGNED_FOR_IPAD_DEFAULT_UI_SCALE : DEFAULT_UI_SCALE;
}

/**
 * Read persisted UI scale from localStorage.
 * Missing, corrupt, non-numeric, or out-of-range values strictly fall back to `getDefaultUiScale(env)`.
 */
export function readUiScale(env?: NativePlatformEnvironment): number {
  const defaultScale = getDefaultUiScale(env);
  try {
    const raw = globalThis.localStorage?.getItem(UI_SCALE_STORAGE_KEY);
    if (raw == null || raw.trim() === '') return defaultScale;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed < MIN_UI_SCALE || parsed > MAX_UI_SCALE) {
      return defaultScale;
    }
    return clampUiScale(parsed, defaultScale);
  } catch {
    return defaultScale;
  }
}

/**
 * Resolve effective whole-page CSS zoom factor for a UI scale percentage (`60 -> 0.6`, `125 -> 1.25`).
 */
export function resolveEffectiveUiZoom(scale: number): number {
  return clampUiScale(scale) / 100;
}

/**
 * Read the active CSS zoom factor currently applied to `document.documentElement`.
 * Returns `1` when no CSS zoom is active.
 */
export function getActiveCssZoom(doc: Document | undefined = globalThis.document): number {
  const root = doc?.documentElement;
  if (!root) return 1;
  const varRaw = root.style.getPropertyValue(UI_SCALE_ZOOM_VAR).trim();
  if (varRaw) {
    const parsedVar = Number(varRaw);
    if (Number.isFinite(parsedVar) && parsedVar > 0) return parsedVar;
  }
  const zoomRaw = (root.style as unknown as { zoom?: string }).zoom?.trim()
    || root.style.getPropertyValue('zoom').trim();
  if (zoomRaw) {
    const parsedZoom = Number(zoomRaw);
    if (Number.isFinite(parsedZoom) && parsedZoom > 0) return parsedZoom;
  }
  return 1;
}

/** Apply the UI scale cleanly via CSS `zoom` and `--imcodes-ui-zoom` on `document.documentElement`. */
export function applyUiScale(scale: number): number {
  const zoomFactor = resolveEffectiveUiZoom(scale);
  const root = globalThis.document?.documentElement;
  if (root) {
    const zoomStyle = root.style as unknown as { zoom?: string };
    if (Math.abs(zoomFactor - 1) < 0.0005) {
      zoomStyle.zoom = '';
      root.style.removeProperty('zoom');
      root.style.removeProperty(UI_SCALE_ZOOM_VAR);
    } else {
      const formattedZoom = String(Number(zoomFactor.toFixed(4)));
      zoomStyle.zoom = formattedZoom;
      root.style.setProperty('zoom', formattedZoom);
      root.style.setProperty(UI_SCALE_ZOOM_VAR, formattedZoom);
    }
  }
  return zoomFactor;
}

/** Persist and apply UI scale, broadcasting a custom event to keep all UI controls in sync. */
export function writeUiScale(scale: number): number {
  const clamped = clampUiScale(scale, getDefaultUiScale());
  try {
    globalThis.localStorage?.setItem(UI_SCALE_STORAGE_KEY, String(clamped));
  } catch {
    // Ignore storage quota or SecurityError in restricted contexts.
  }
  applyUiScale(clamped);
  try {
    globalThis.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: { scale: clamped } }));
  } catch {
    // Ignore environments without CustomEvent dispatch support.
  }
  return clamped;
}

/** Persist UI scale onboarding completion so first-install card shows only once. */
export function markUiScalePrompted(): void {
  try {
    globalThis.localStorage?.setItem(UI_SCALE_PROMPTED_STORAGE_KEY, '1');
  } catch {
    // Ignore storage quota or SecurityError in restricted contexts.
  }
  try {
    globalThis.dispatchEvent(new CustomEvent(UI_SCALE_PROMPT_EVENT));
  } catch {
    // Ignore environments without CustomEvent dispatch support.
  }
}

/**
 * Show lightweight first-install UI scale onboarding card only in native Capacitor apps
 * (`Capacitor.isNativePlatform() === true`), when neither `imcodes_uiScalePrompted`
 * nor a prior `imcodes_uiScale` preference has been recorded. Hidden on regular web browsers.
 */
export function shouldShowUiScaleOnboardingPrompt(
  env: NativePlatformEnvironment = readNativePlatformEnvironment(),
): boolean {
  if (env.capacitor?.isNativePlatform?.() !== true) return false;
  try {
    const prompted = globalThis.localStorage?.getItem(UI_SCALE_PROMPTED_STORAGE_KEY);
    if (prompted != null && prompted !== '') return false;
    const savedScale = globalThis.localStorage?.getItem(UI_SCALE_STORAGE_KEY);
    if (savedScale != null && savedScale.trim() !== '') return false;
    return true;
  } catch {
    return false;
  }
}

/** Initialize UI scale on app startup from persisted storage or platform default. */
export function initUiScale(): number {
  const scale = readUiScale();
  applyUiScale(scale);
  return scale;
}

/** Reactive Preact hook returning `[uiScale, setUiScale, defaultUiScale]` synchronized across UI controls and tabs. */
export function useUiScale(): [number, (next: number | ((prev: number) => number)) => void, number] {
  const [defaultScale, setDefaultScale] = useState<number>(() => getDefaultUiScale());
  const [scale, setScaleState] = useState<number>(() => readUiScale());

  useEffect(() => {
    const syncAll = () => {
      setDefaultScale(getDefaultUiScale());
      const next = readUiScale();
      applyUiScale(next);
      setScaleState(next);
    };
    const onCustom = (e: Event) => {
      const detailScale = (e as CustomEvent<{ scale?: number }>).detail?.scale;
      if (typeof detailScale === 'number') {
        setScaleState(clampUiScale(detailScale, getDefaultUiScale()));
      } else {
        setScaleState(readUiScale());
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === UI_SCALE_STORAGE_KEY) {
        const next = readUiScale();
        applyUiScale(next);
        setScaleState(next);
      }
    };
    globalThis.addEventListener(UI_SCALE_EVENT, onCustom);
    globalThis.addEventListener('storage', onStorage);
    globalThis.addEventListener(NATIVE_HOST_EVENT, syncAll);
    return () => {
      globalThis.removeEventListener(UI_SCALE_EVENT, onCustom);
      globalThis.removeEventListener('storage', onStorage);
      globalThis.removeEventListener(NATIVE_HOST_EVENT, syncAll);
    };
  }, []);

  const setScale = useCallback((next: number | ((prev: number) => number)) => {
    const resolved = typeof next === 'function' ? next(readUiScale()) : next;
    const written = writeUiScale(resolved);
    setScaleState(written);
  }, []);

  return [scale, setScale, defaultScale];
}
