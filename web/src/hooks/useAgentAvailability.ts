import { useCallback, useEffect, useState } from 'preact/hooks';
import { AGENT_AVAILABILITY_MSG, type AgentAvailabilityMap } from '@shared/agent-availability.js';
import type { WsClient } from '../ws-client.js';

interface AvailabilityStoreEntry {
  agents: AgentAvailabilityMap | null;
  checkedAt: number;
  lastRequestedAt: number;
  detecting: boolean;
  subscribers: Set<() => void>;
}

const DEFAULT_STALE_MS = 60_000;
const wsAvailabilityStore = new WeakMap<object, AvailabilityStoreEntry>();

function getOrCreateStore(ws: WsClient): AvailabilityStoreEntry {
  let entry = wsAvailabilityStore.get(ws);
  if (!entry) {
    entry = {
      agents: null,
      checkedAt: 0,
      lastRequestedAt: 0,
      detecting: false,
      subscribers: new Set(),
    };
    wsAvailabilityStore.set(ws, entry);
  }
  return entry;
}

function notifyStore(entry: AvailabilityStoreEntry): void {
  for (const listener of entry.subscribers) {
    listener();
  }
}

export interface UseAgentAvailabilityOptions {
  enabled?: boolean;
  staleMs?: number;
}

export interface UseAgentAvailabilityResult {
  availability: AgentAvailabilityMap | null;
  detecting: boolean;
  refresh: (forceRefresh?: boolean) => void;
}

export function useAgentAvailability(
  ws: WsClient | null | undefined,
  options: UseAgentAvailabilityOptions = {},
): UseAgentAvailabilityResult {
  const enabled = options.enabled ?? true;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((v) => v + 1), []);

  const store = ws ? getOrCreateStore(ws) : null;

  useEffect(() => {
    if (!ws || !store) return;
    store.subscribers.add(bump);

    const unsub = typeof ws.onMessage === 'function'
      ? ws.onMessage((msg) => {
          if (msg.type === AGENT_AVAILABILITY_MSG.RESULT) {
            if (typeof msg.checkedAt === 'number' && msg.checkedAt < store.checkedAt) {
              return;
            }
            if (typeof msg.checkedAt === 'number') {
              store.checkedAt = msg.checkedAt;
            }
            store.agents = msg.agents ?? {};
            store.detecting = false;
            notifyStore(store);
          }
        })
      : undefined;

    if (enabled && typeof ws.detectAgents === 'function') {
      const now = Date.now();
      const isStale = store.agents === null
        ? (now - store.lastRequestedAt > staleMs)
        : (now - Math.max(store.checkedAt, store.lastRequestedAt) > staleMs);
      if (isStale) {
        store.lastRequestedAt = now;
        store.detecting = true;
        notifyStore(store);
        try {
          ws.detectAgents(false);
        } catch {
          store.detecting = false;
          notifyStore(store);
        }
      }
    }

    return () => {
      store.subscribers.delete(bump);
      unsub?.();
    };
  }, [ws, store, enabled, staleMs, bump]);

  const refresh = useCallback((forceRefresh = true) => {
    if (!ws || !store || typeof ws.detectAgents !== 'function') return;
    store.lastRequestedAt = Date.now();
    store.detecting = true;
    notifyStore(store);
    try {
      ws.detectAgents(forceRefresh);
    } catch {
      store.detecting = false;
      notifyStore(store);
    }
  }, [ws, store]);

  return {
    availability: store?.agents ?? null,
    detecting: store?.detecting ?? false,
    refresh,
  };
}
