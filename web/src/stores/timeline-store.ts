import { useSyncExternalStore } from 'preact/compat';
import type { TimelineEvent } from '../../../src/shared/timeline/types.js';
import { mergeTimelineEvents } from '../../../src/shared/timeline/merge.js';

export interface TimelineStoreSnapshot {
  events: TimelineEvent[];
  epoch: number;
  seq: number;
}

export interface TimelineStore {
  getSnapshot: () => TimelineStoreSnapshot;
  subscribe: (listener: () => void) => () => void;
  ingest: (event: TimelineEvent, maxEvents?: number) => boolean;
  merge: (events: readonly TimelineEvent[], maxEvents?: number) => boolean;
  replace: (events: TimelineEvent[], epoch?: number, seq?: number, maxEvents?: number) => void;
  remove: (eventId: string) => void;
  reset: () => void;
}

const stores = new Map<string, TimelineStore>();

function createStore(): TimelineStore {
  let snapshot: TimelineStoreSnapshot = { events: [], epoch: 0, seq: 0 };
  const listeners = new Set<() => void>();
  const publish = (next: TimelineStoreSnapshot): void => {
    if (next.events === snapshot.events && next.epoch === snapshot.epoch && next.seq === snapshot.seq) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const merge = (incoming: readonly TimelineEvent[], maxEvents = 300): boolean => {
    if (incoming.length === 0) return false;
    const bounded = [...mergeTimelineEvents(snapshot.events, incoming as TimelineEvent[], maxEvents)] as TimelineEvent[];
    const epoch = incoming.reduce((max, event) => Math.max(max, event.epoch), snapshot.epoch);
    const seq = incoming.reduce((max, event) => Math.max(max, event.seq), snapshot.seq);
    if (bounded === snapshot.events && epoch === snapshot.epoch && seq === snapshot.seq) return false;
    publish({ events: bounded, epoch, seq });
    return true;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    ingest: (event, maxEvents = 300) => merge([event], maxEvents),
    merge,
    replace: (events, epoch = 0, seq = 0, maxEvents = 300) => {
      const bounded = events.length > maxEvents ? events.slice(-maxEvents) : events;
      const nextEpoch = events.reduce((max, event) => Math.max(max, event.epoch), epoch);
      const nextSeq = events.reduce((max, event) => Math.max(max, event.seq), seq);
      publish({ events: bounded, epoch: nextEpoch, seq: nextSeq });
    },
    remove: (eventId) => {
      const next = snapshot.events.filter((event) => event.eventId !== eventId);
      if (next.length !== snapshot.events.length) publish({ ...snapshot, events: next });
    },
    reset: () => publish({ events: [], epoch: 0, seq: 0 }),
  };
}

export function getTimelineStore(cacheKey: string): TimelineStore {
  let store = stores.get(cacheKey);
  if (!store) {
    store = createStore();
    stores.set(cacheKey, store);
  }
  return store;
}

export function peekTimelineStore(cacheKey: string | null | undefined): TimelineStoreSnapshot | null {
  return cacheKey ? getTimelineStore(cacheKey).getSnapshot() : null;
}

export function useTimelineStore(cacheKey: string | null | undefined): TimelineStoreSnapshot {
  const store = cacheKey ? getTimelineStore(cacheKey) : null;
  const empty = EMPTY_SNAPSHOT;
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : () => empty,
  );
}

const EMPTY_SNAPSHOT: TimelineStoreSnapshot = { events: [], epoch: 0, seq: 0 };
const noopSubscribe = () => () => {};

export function __resetTimelineStoresForTests(): void {
  stores.clear();
}

