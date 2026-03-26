// Provider registry — manages transport provider lifecycle
// For now only OpenClaw, but designed for future providers

import type { TransportProvider, ProviderConfig } from './transport-provider.js';
import { wireProviderToRelay, broadcastProviderStatus } from '../daemon/transport-relay.js';
import logger from '../util/logger.js';

const providers = new Map<string, TransportProvider>();

/** ServerLink reference for sync pipeline — set by daemon startup. */
let _serverLink: { send(msg: object): void } | null = null;
export function setProviderRegistryServerLink(link: { send(msg: object): void }): void { _serverLink = link; }

export function getProvider(id: string): TransportProvider | undefined {
  return providers.get(id);
}

export function getAllProviders(): TransportProvider[] {
  return [...providers.values()];
}

export async function connectProvider(id: string, config: ProviderConfig): Promise<void> {
  // If already connected, disconnect first
  if (providers.has(id)) {
    await disconnectProvider(id);
  }

  const provider = await createProvider(id);
  await provider.connect(config);
  providers.set(id, provider);
  wireProviderToRelay(provider);

  // Materialize OC sessions before broadcasting status (sessions appear before catalog)
  if (id === 'openclaw' && !_serverLink) {
    logger.warn('connectProvider: _serverLink is null — oc-sync skipped (WS not connected yet?)');
  }
  if (id === 'openclaw' && _serverLink) {
    try {
      const { syncOcSessions } = await import('../daemon/oc-session-sync.js');
      await syncOcSessions(_serverLink as any);
    } catch (err) {
      logger.warn({ err }, 'OC session auto-sync failed — continuing without materialization');
    }
  }

  broadcastProviderStatus(id, true);
  logger.info({ provider: id }, 'Provider connected');

  // Persist config so autoReconnectProviders can restore on daemon restart
  if (id === 'openclaw' && config.url && config.token) {
    import('./openclaw-config.js')
      .then(({ saveConfig }) => saveConfig({ url: config.url!, token: config.token! }))
      .catch((e) => logger.warn({ err: e }, 'Failed to persist openclaw config'));
  }
}

export async function disconnectProvider(id: string): Promise<void> {
  const provider = providers.get(id);
  if (!provider) return;
  await provider.disconnect();
  providers.delete(id);
  broadcastProviderStatus(id, false);
  logger.info({ provider: id }, 'Provider disconnected');
}

export async function disconnectAll(): Promise<void> {
  for (const [id] of providers) {
    await disconnectProvider(id);
  }
}

async function createProvider(id: string): Promise<TransportProvider> {
  switch (id) {
    case 'openclaw': {
      const { OpenClawProvider } = await import('./providers/openclaw.js');
      return new OpenClawProvider();
    }
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}
