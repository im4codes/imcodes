import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

// Browser-local presentation preference, deliberately independent of server/session.
import { TASK_PAIR_STATUS_PANEL_WIDTH_STORAGE_KEY as TASK_PAIR_PANEL_WIDTH_KEY, TASK_PAIR_STATUS_PANEL_SECONDARY_WIDTH_STORAGE_KEY } from '@shared/task-pair.js';
export { TASK_PAIR_PANEL_WIDTH_KEY };
const WIDTH_VAR = '--task-pair-panel-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;

export function taskPairPanelWidthBounds(available: number, secondary = false) {
  const max = Math.max(1, Math.min(MAX_WIDTH, Math.floor(available * (secondary ? 0.4 : 0.65))));
  return { min: Math.min(MIN_WIDTH, max), max };
}

export function readTaskPairPanelWidth(key = TASK_PAIR_PANEL_WIDTH_KEY): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.min(MAX_WIDTH, value) : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

/** One local width drives both the panel and its chat/pinned-message reservation. */
export function useTaskPairPanelWidth(panelRef: RefObject<HTMLElement>, enabled: boolean, secondary = false) {
  const storageKey = secondary ? TASK_PAIR_STATUS_PANEL_SECONDARY_WIDTH_STORAGE_KEY : TASK_PAIR_PANEL_WIDTH_KEY;
  const changedEvent = `${storageKey}:changed`;
  const [preference, setPreference] = useState(() => ({ key: storageKey, width: readTaskPairPanelWidth(storageKey) }));
  // Scope can change without a remount. Never temporarily reuse the other
  // scope's width or let a pointer gesture commit into its storage key.
  const preferred = preference.key === storageKey ? preference.width : readTaskPairPanelWidth(storageKey);
  const setPreferred = (next: number) => setPreference({ key: storageKey, width: next });
  const [available, setAvailable] = useState(() => window.innerWidth);
  const stopDrag = useRef<(() => void) | null>(null);
  const bounds = taskPairPanelWidthBounds(available, secondary);
  const clamp = (value: number) => Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
  const width = clamp(preferred);
  const persist = (next: number) => {
    setPreferred(next);
    try { window.localStorage.setItem(storageKey, String(next)); } catch { /* current panel remains usable */ }
    window.dispatchEvent(new CustomEvent<number>(changedEvent, { detail: next }));
  };
  useLayoutEffect(() => {
    setPreferred(readTaskPairPanelWidth(storageKey));
    const sync = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== storageKey && event.key !== null) return;
        setPreferred(readTaskPairPanelWidth(storageKey));
      } else {
        setPreferred((event as CustomEvent<number>).detail);
      }
    };
    window.addEventListener('storage', sync);
    window.addEventListener(changedEvent, sync);
    return () => { stopDrag.current?.(); window.removeEventListener('storage', sync); window.removeEventListener(changedEvent, sync); };
  }, [storageKey, changedEvent]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const panel = panelRef.current;
    if (!panel) return;
    const host = panel.closest<HTMLElement>('.chat-view-wrap') ?? panel.parentElement;
    const measure = () => setAvailable(host?.getBoundingClientRect().width || window.innerWidth);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (host) observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); stopDrag.current?.(); };
  }, [enabled, panelRef]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const panel = panelRef.current;
    const host = panel?.closest<HTMLElement>('.chat-view-wrap') ?? panel;
    if (!host) return;
    const previous = host.style.getPropertyValue(WIDTH_VAR);
    host.style.setProperty(WIDTH_VAR, `${width}px`);
    return () => { if (previous) host.style.setProperty(WIDTH_VAR, previous); else host.style.removeProperty(WIDTH_VAR); };
  }, [enabled, width, panelRef]);

  const onPointerDown = (event: PointerEvent) => {
    if (!enabled || event.button !== 0 || stopDrag.current) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let next = width;
    let moved = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      moved ||= e.clientX !== startX;
      next = clamp(width + startX - e.clientX);
      setPreferred(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      target.removeEventListener('lostpointercapture', cancel);
      stopDrag.current = null;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      move(e); stop();
      if (moved) persist(next); else setPreferred(preferred);
    };
    const cancel = (e?: Event) => {
      if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
      stop(); setPreferred(preferred);
    };
    stopDrag.current = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    target.addEventListener('lostpointercapture', cancel);
    target.setPointerCapture?.(pointerId);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled) return;
    const next = event.key === 'ArrowLeft' ? width + 24 : event.key === 'ArrowRight' ? width - 24 : event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation(); persist(clamp(next));
  };
  return { width, min: bounds.min, max: bounds.max, onPointerDown, onKeyDown };
}
