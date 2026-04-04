/**
 * useVirtualList — lightweight virtual list hook for dynamic-height items.
 *
 * Only renders items within the visible viewport + overscan. Uses a shared
 * ResizeObserver (one per hook instance) with rAF-batched height updates.
 * Height cache is keyed by stable item keys and pruned on each items change.
 *
 * This hook owns ONLY generic list-window math. Chat-specific policy (selection
 * freeze, streaming tail, auto-scroll, load-older anchor) lives in the consumer.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { RefObject } from 'preact';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseVirtualListOptions<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  estimatedHeight?: number;       // default 100
  overscan?: number;              // extra items above/below viewport, default 5
  scrollRef: RefObject<HTMLElement>;
  enabled?: boolean;              // false = passthrough (all items visible, no spacers)
}

export interface VirtualItem<T> {
  item: T;
  index: number;
  key: string;
}

export interface UseVirtualListResult<T> {
  visibleItems: VirtualItem<T>[];
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  /** Callback ref factory — call measureRef(key) on item wrapper */
  measureRef: (key: string) => (el: HTMLElement | null) => void;
  /** Scroll to the very end of the list */
  scrollToEnd: () => void;
  /** Scroll to a specific item by key */
  scrollToItem: (key: string, align?: 'start' | 'center' | 'end') => void;
  /** Whether virtualization is active */
  isVirtualized: boolean;
}

// ── Helpers (exported for testing) ───────────────────────────────────────────

/** Compute cumulative heights and total height from items + cache + estimate. */
export function computeCumulativeHeights<T>(
  items: T[],
  getKey: (item: T, index: number) => string,
  estimatedHeight: number,
  heightCache: Map<string, number>,
): { cumulative: number[]; total: number } {
  const n = items.length;
  const cumulative = new Array<number>(n + 1);
  cumulative[0] = 0;
  for (let i = 0; i < n; i++) {
    const key = getKey(items[i], i);
    const h = heightCache.get(key) ?? estimatedHeight;
    cumulative[i + 1] = cumulative[i] + h;
  }
  return { cumulative, total: cumulative[n] };
}

/** Find the visible range [start, end) given scroll position. */
export function computeRange(
  scrollTop: number,
  viewportHeight: number,
  cumulative: number[],
  itemCount: number,
  overscan: number,
): { start: number; end: number } {
  if (itemCount === 0) return { start: 0, end: 0 };

  // Binary search for first item whose bottom edge > scrollTop
  let lo = 0, hi = itemCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const rawStart = lo;

  // Binary search for first item whose top edge >= scrollTop + viewportHeight
  lo = rawStart;
  hi = itemCount;
  const bottomEdge = scrollTop + viewportHeight;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid] < bottomEdge) lo = mid + 1;
    else hi = mid;
  }
  const rawEnd = lo;

  // Apply overscan
  const start = Math.max(0, rawStart - overscan);
  const end = Math.min(itemCount, rawEnd + overscan);
  return { start, end };
}

/** Remove stale keys from cache that are not in current items. */
export function pruneCache<T>(
  cache: Map<string, number>,
  items: T[],
  getKey: (item: T, index: number) => string,
): void {
  if (cache.size === 0) return;
  const currentKeys = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    currentKeys.add(getKey(items[i], i));
  }
  for (const key of cache.keys()) {
    if (!currentKeys.has(key)) cache.delete(key);
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useVirtualList<T>(options: UseVirtualListOptions<T>): UseVirtualListResult<T> {
  const {
    items,
    getKey,
    estimatedHeight = 100,
    overscan = 5,
    scrollRef,
    enabled = true,
  } = options;

  const isVirtualized = enabled && items.length > 0;

  // Height cache (mutable map, updated by ResizeObserver)
  const heightCacheRef = useRef(new Map<string, number>());
  // Trigger re-render when heights change
  const [heightVersion, setHeightVersion] = useState(0);

  // Scroll state
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // ResizeObserver: single shared instance
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementMapRef = useRef(new Map<string, HTMLElement>());
  const pendingHeightsRef = useRef(new Map<string, number>());
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!isVirtualized) return;

    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey;
        if (!key) continue;
        const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        const cached = heightCacheRef.current.get(key);
        if (cached !== h) {
          pendingHeightsRef.current.set(key, h);
          changed = true;
        }
      }
      if (changed && !rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = 0;
          const pending = pendingHeightsRef.current;
          if (pending.size === 0) return;
          for (const [k, v] of pending) {
            heightCacheRef.current.set(k, v);
          }
          pending.clear();
          setHeightVersion((v) => v + 1);
        });
      }
    });
    observerRef.current = observer;

    return () => {
      observer.disconnect();
      observerRef.current = null;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [isVirtualized]);

  // measureRef callback factory
  const measureRef = useCallback((key: string) => {
    return (el: HTMLElement | null) => {
      const observer = observerRef.current;
      if (!observer) return;
      const oldEl = elementMapRef.current.get(key);
      if (oldEl && oldEl !== el) {
        observer.unobserve(oldEl);
        elementMapRef.current.delete(key);
      }
      if (el) {
        elementMapRef.current.set(key, el);
        observer.observe(el);
      }
    };
  }, []);

  // Cache pruning on items change
  useEffect(() => {
    pruneCache(heightCacheRef.current, items, getKey);
  }, [items, getKey]);

  // Scroll handler
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isVirtualized) return;

    const onScroll = () => {
      setScrollTop(el.scrollTop);
    };
    // Init
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);

    el.addEventListener('scroll', onScroll, { passive: true });

    // Viewport resize
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        setViewportHeight(el.clientHeight);
      });
      ro.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [scrollRef, isVirtualized]);

  // Compute layout
  const heightCache = heightCacheRef.current;

  const { cumulative, total: totalHeight } = useMemo(
    () => computeCumulativeHeights(items, getKey, estimatedHeight, heightCache),
    // heightVersion forces recomputation when ResizeObserver updates the cache
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, getKey, estimatedHeight, heightVersion],
  );

  const { start, end } = useMemo(
    () => isVirtualized
      ? computeRange(scrollTop, viewportHeight, cumulative, items.length, overscan)
      : { start: 0, end: items.length },
    [isVirtualized, scrollTop, viewportHeight, cumulative, items.length, overscan],
  );

  const topSpacerHeight = isVirtualized ? cumulative[start] : 0;
  const bottomSpacerHeight = isVirtualized ? Math.max(0, totalHeight - cumulative[end]) : 0;

  const visibleItems = useMemo(() => {
    const result: VirtualItem<T>[] = [];
    for (let i = start; i < end; i++) {
      result.push({ item: items[i], index: i, key: getKey(items[i], i) });
    }
    return result;
  }, [items, getKey, start, end]);

  // Imperative: scroll to end
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  // Imperative: scroll to item
  const scrollToItem = useCallback((key: string, align: 'start' | 'center' | 'end' = 'start') => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = items.findIndex((item, i) => getKey(item, i) === key);
    if (idx === -1) return;
    const itemTop = cumulative[idx];
    const itemHeight = heightCache.get(key) ?? estimatedHeight;
    const vh = el.clientHeight;
    let target = itemTop;
    if (align === 'center') target -= (vh - itemHeight) / 2;
    else if (align === 'end') target -= (vh - itemHeight);
    el.scrollTop = Math.max(0, target);
  }, [scrollRef, items, getKey, cumulative, heightCache, estimatedHeight]);

  return {
    visibleItems,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    measureRef,
    scrollToEnd,
    scrollToItem,
    isVirtualized,
  };
}
