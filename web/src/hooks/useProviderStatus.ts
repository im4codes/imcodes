import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

export interface ProviderStatus {
  id: string;
  connected: boolean;
}

export interface RemoteSession {
  key: string;
  displayName?: string;
  agentId?: string;
  updatedAt?: number;
  percentUsed?: number;
}

/** Grace period (ms) before propagating a disconnect to the UI.
 *  OC gateway restarts in ~2-3s; this hides transient blips. */
const DISCONNECT_GRACE_MS = 5_000;

export function useProviderStatus(ws: WsClient | null) {
  const [providers, setProviders] = useState<Map<string, boolean>>(new Map());
  const [remoteSessions, setRemoteSessions] = useState<Map<string, RemoteSession[]>>(new Map());
  const graceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'provider.status') {
        const { providerId, connected } = msg;
        if (connected) {
          // Reconnected — cancel any pending disconnect grace timer
          const pending = graceTimers.current.get(providerId);
          if (pending) { clearTimeout(pending); graceTimers.current.delete(providerId); }
          setProviders((prev) => { const next = new Map(prev); next.set(providerId, true); return next; });
        } else {
          // Disconnected — delay UI update to absorb transient reconnects
          if (!graceTimers.current.has(providerId)) {
            graceTimers.current.set(providerId, setTimeout(() => {
              graceTimers.current.delete(providerId);
              setProviders((prev) => { const next = new Map(prev); next.set(providerId, false); return next; });
            }, DISCONNECT_GRACE_MS));
          }
        }
      }
      if (msg.type === 'provider.sessions_response') {
        setRemoteSessions((prev) => {
          const next = new Map(prev);
          next.set(msg.providerId, msg.sessions ?? []);
          return next;
        });
      }
      // On daemon reconnect, provider status cache in bridge is refreshed.
      // Request session list which also triggers a fresh status push.
      if (msg.type === 'daemon.reconnected') {
        try { ws.send({ type: 'provider.list_sessions', providerId: 'openclaw' }); } catch { /* */ }
      }
    });

    return () => {
      unsub();
      // Clear all grace timers on cleanup
      for (const t of graceTimers.current.values()) clearTimeout(t);
      graceTimers.current.clear();
    };
  }, [ws]);

  const refreshSessions = useCallback((providerId: string) => {
    if (!ws) return;
    try {
      ws.send({ type: 'provider.list_sessions', providerId });
    } catch { /* not connected */ }
  }, [ws]);

  return {
    providers,
    remoteSessions,
    isProviderConnected: (id: string) => providers.get(id) === true,
    getRemoteSessions: (id: string) => remoteSessions.get(id) ?? [],
    refreshSessions,
  };
}
