import type { TransportProvider } from './transport-provider.js';

const retiringProviders = new WeakSet<TransportProvider>();

/** Synchronously mark a provider instance retiring before `disconnect()` awaits. */
export function markProviderRetiring(provider: TransportProvider): void {
  retiringProviders.add(provider);
}

/** Clear retiring state if the same instance is registered again on reconnect. */
export function clearProviderRetiring(provider: TransportProvider): void {
  retiringProviders.delete(provider);
}

/** O(1) check for whether `provider` has started retiring via disconnect/replace. */
export function isProviderRetiring(provider: TransportProvider): boolean {
  return retiringProviders.has(provider);
}
