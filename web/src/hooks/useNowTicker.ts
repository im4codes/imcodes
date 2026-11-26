import { useEffect, useRef, useState } from 'preact/hooks';

type Listener = (value: number) => void;

type TickerStore = {
  now: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<Listener>;
};

const stores = new Map<number, TickerStore>();
let visibilityListenerAttached = false;

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function hasAnyListeners(): boolean {
  for (const store of stores.values()) {
    if (store.listeners.size > 0) return true;
  }
  return false;
}

function getStore(intervalMs: number): TickerStore {
  let store = stores.get(intervalMs);
  if (!store) {
    store = {
      now: Date.now(),
      timer: null,
      listeners: new Set(),
    };
    stores.set(intervalMs, store);
  }
  return store;
}

function startStore(intervalMs: number, store: TickerStore) {
  if (store.timer || store.listeners.size === 0 || isDocumentHidden()) return;
  store.now = Date.now();
  store.timer = setInterval(() => {
    store.now = Date.now();
    store.listeners.forEach((listener) => listener(store.now));
  }, intervalMs);
}

function stopStore(store: TickerStore) {
  if (!store.timer || store.listeners.size > 0) return;
  clearInterval(store.timer);
  store.timer = null;
}

function pauseAllStores() {
  for (const store of stores.values()) {
    if (store.timer) {
      clearInterval(store.timer);
      store.timer = null;
    }
  }
}

function handleVisibilityChange() {
  if (isDocumentHidden()) {
    pauseAllStores();
    return;
  }
  const now = Date.now();
  for (const [intervalMs, store] of stores.entries()) {
    if (store.listeners.size === 0) continue;
    store.now = now;
    store.listeners.forEach((listener) => listener(now));
    startStore(intervalMs, store);
  }
}

function syncVisibilityListener() {
  if (typeof document === 'undefined') return;
  const needed = hasAnyListeners();
  if (needed && !visibilityListenerAttached) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = true;
  } else if (!needed && visibilityListenerAttached) {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = false;
  }
}

export function useNowTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const wasActiveRef = useRef(active);
  const currentNow = active && !wasActiveRef.current ? Date.now() : now;
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const store = getStore(intervalMs);
    const listener: Listener = (value) => setNow(value);
    store.listeners.add(listener);
    syncVisibilityListener();
    // Start BEFORE seeding: a store whose last listener left keeps its final
    // `now` forever, so seeding from it first would render one frame of an
    // arbitrarily stale time — visible as a nonsense elapsed value on anything
    // that counts up from a timestamp. `startStore` refreshes `now` when it was
    // stopped; when hidden, seed a fresh timestamp without running an interval.
    if (isDocumentHidden()) {
      const fresh = Date.now();
      store.now = fresh;
      setNow(fresh);
    } else {
      startStore(intervalMs, store);
      setNow(Date.now());
    }

    return () => {
      store.listeners.delete(listener);
      stopStore(store);
      syncVisibilityListener();
    };
  }, [active, intervalMs]);

  return currentNow;
}
