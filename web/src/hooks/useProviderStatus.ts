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

    const unsub = ws.onMessage((raw) => {
      const msg = raw as unknown as Record<string, unknown>;
      if (msg['type'] === 'provider.status') {
        const providerId = msg['providerId'] as string;
        const connected = msg['connected'] as boolean;
        setProviders((prev) => {
          const next = new Map(prev);
          next.set(providerId, connected);
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
