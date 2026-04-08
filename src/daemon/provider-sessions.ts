import { getProvider } from '../agent/provider-registry.js';

export async function listProviderSessions(providerId: string): Promise<Array<{ key: string; displayName?: string; agentId?: string; updatedAt?: number; percentUsed?: number }>> {
  const provider = getProvider(providerId);
  if (!provider) return [];
  if (!provider.capabilities.sessionRestore || !provider.listSessions) return [];
  return provider.listSessions();
}
