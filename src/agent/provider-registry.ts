// Provider registry — manages transport provider lifecycle
// For now only OpenClaw, but designed for future providers

import type { TransportProvider, ProviderConfig } from './transport-provider.js';
import logger from '../util/logger.js';

const providers = new Map<string, TransportProvider>();

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
  logger.info({ provider: id }, 'Provider connected');
}

export async function disconnectProvider(id: string): Promise<void> {
  const provider = providers.get(id);
  if (!provider) return;
  await provider.disconnect();
  providers.delete(id);
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
