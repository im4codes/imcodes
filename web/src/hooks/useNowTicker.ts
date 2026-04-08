import { useEffect, useState } from 'preact/hooks';

type Listener = (value: number) => void;

type TickerStore = {
  now: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<Listener>;
};

const stores = new Map<number, TickerStore>();

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
  if (store.timer || store.listeners.size === 0) return;
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

export function useNowTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }

    const store = getStore(intervalMs);
    const listener: Listener = (value) => setNow(value);
    store.listeners.add(listener);
    setNow(store.now);
    startStore(intervalMs, store);

    return () => {
      store.listeners.delete(listener);
      stopStore(store);
    };
  }, [active, intervalMs]);

  return now;
}
