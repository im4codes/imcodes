import { useState, useEffect } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';

export interface ProviderStatus {
  id: string;
  connected: boolean;
}

export function useProviderStatus(ws: WsClient | null) {
  const [providers, setProviders] = useState<Map<string, boolean>>(new Map());

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
    });

    return unsub;
  }, [ws]);

  return {
    providers,
    isProviderConnected: (id: string) => providers.get(id) === true,
  };
}
