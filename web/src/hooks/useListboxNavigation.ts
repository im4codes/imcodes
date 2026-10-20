import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, type Dispatch, type StateUpdater } from 'preact/hooks';
import { isImeComposingKeyEvent } from '../ime-keyboard.js';

const LISTBOX_NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

const DEFAULT_PAGE_SIZE = 5;

function selectablePosition(indices: readonly number[], activeIndex: number): number {
  const exact = indices.indexOf(activeIndex);
  if (exact >= 0) return exact;
  const next = indices.findIndex((index) => index >= activeIndex);
  return next >= 0 ? next : 0;
}

export function normalizeListboxIndex(
  activeIndex: number,
  selectableIndices: readonly number[],
): number {
  if (selectableIndices.length === 0) return 0;
  if (selectableIndices.includes(activeIndex)) return activeIndex;
  return selectableIndices[selectablePosition(selectableIndices, activeIndex)] ?? selectableIndices[0];
}

export function moveListboxIndex(
  activeIndex: number,
  key: string,
  selectableIndices: readonly number[],
  pageSize = DEFAULT_PAGE_SIZE,
): number {
  if (selectableIndices.length === 0) return 0;
  if (key === 'Home') return selectableIndices[0];
  if (key === 'End') return selectableIndices[selectableIndices.length - 1];

  const currentPosition = selectablePosition(selectableIndices, activeIndex);
  const delta = key === 'ArrowUp'
    ? -1
    : key === 'ArrowDown'
      ? 1
      : key === 'PageUp'
        ? -Math.max(1, pageSize)
        : key === 'PageDown'
          ? Math.max(1, pageSize)
          : 0;
  const nextPosition = (currentPosition + delta + selectableIndices.length * (Math.abs(delta) + 1))
    % selectableIndices.length;
  return selectableIndices[nextPosition];
}

interface UseListboxNavigationOptions {
  activeIndex: number;
  containerRef: RefObject<HTMLElement>;
  itemCount: number;
  open: boolean;
  pageSize?: number;
  selectableIndices?: readonly number[];
  setActiveIndex: Dispatch<StateUpdater<number>>;
}

/**
 * One keyboard and visibility contract for composer suggestion lists.
 * Headings and disabled rows stay outside `selectableIndices`; navigation wraps
 * only through real options and never scrolls an outer composer/chat viewport.
 */
export function useListboxNavigation({
  activeIndex,
  containerRef,
  itemCount,
  open,
  pageSize = DEFAULT_PAGE_SIZE,
  selectableIndices,
  setActiveIndex,
}: UseListboxNavigationOptions) {
  const allIndices = useMemo(
    () => Array.from({ length: itemCount }, (_, index) => index),
    [itemCount],
  );
  const availableIndices = selectableIndices ?? allIndices;
  const effectiveActiveIndex = normalizeListboxIndex(activeIndex, availableIndices);

  // Filtering or live list updates can remove the highlighted row. Correct the
  // state in the same commit phase so Enter/Tab never observes an old index.
  useLayoutEffect(() => {
    if (!open) return;
    setActiveIndex((current) => normalizeListboxIndex(current, availableIndices));
  }, [availableIndices, open, setActiveIndex]);

  useEffect(() => {
    if (!open || availableIndices.length === 0) return;
    const highlighted = containerRef.current?.querySelector<HTMLElement>('[data-hl="true"]');
    if (typeof highlighted?.scrollIntoView === 'function') {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
  }, [availableIndices, containerRef, effectiveActiveIndex, open]);

  const handleNavigationKey = useCallback((event: KeyboardEvent): boolean => {
    if (!open || isImeComposingKeyEvent(event) || !LISTBOX_NAVIGATION_KEYS.has(event.key)) return false;
    event.preventDefault();
    if (availableIndices.length > 0) {
      setActiveIndex((current) => moveListboxIndex(current, event.key, availableIndices, pageSize));
    }
    return true;
  }, [availableIndices, open, pageSize, setActiveIndex]);

  return {
    activeIndex: effectiveActiveIndex,
    handleNavigationKey,
  };
}
