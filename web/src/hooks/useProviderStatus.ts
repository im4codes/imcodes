import { useState, useEffect, useCallback } from 'preact/hooks';
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

export function useProviderStatus(ws: WsClient | null) {
  const [providers, setProviders] = useState<Map<string, boolean>>(new Map());
  const [remoteSessions, setRemoteSessions] = useState<Map<string, RemoteSession[]>>(new Map());

  useEffect(() => {
    if (!ws) return;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'provider.status') {
        setProviders((prev) => {
          const next = new Map(prev);
          next.set(msg.providerId, msg.connected);
          return next;
        });
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

    return unsub;
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
