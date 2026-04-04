import type { PluginListenerHandle } from '@capacitor/core';
import { isNative } from './native.js';
import type { WatchApplicationContext, WatchDurableEvent } from './watch-projection.js';

export type WatchCommand =
  | { action: 'switchServer'; serverId: string }
  | { action: 'refresh' };

type WatchBridgeModule = typeof import('./plugins/watch-bridge.js');

let watchBridgeModulePromise: Promise<WatchBridgeModule> | null = null;

async function loadWatchBridgePlugin(): Promise<WatchBridgeModule['default'] | null> {
  if (!isNative()) return null;
  if (!watchBridgeModulePromise) {
    watchBridgeModulePromise = import('./plugins/watch-bridge.js');
  }
  const module = await watchBridgeModulePromise;
  return module.default;
}

export async function syncSnapshotToWatch(context: WatchApplicationContext): Promise<void> {
  const plugin = await loadWatchBridgePlugin();
  if (!plugin) return;
  await plugin.syncSnapshot({ context });
}

export async function pushDurableEventToWatch(event: WatchDurableEvent): Promise<void> {
  const plugin = await loadWatchBridgePlugin();
  if (!plugin) return;
  await plugin.pushDurableEvent({ event });
}

export async function onWatchCommand(handler: (command: WatchCommand) => void): Promise<() => void> {
  const plugin = await loadWatchBridgePlugin();
  if (!plugin) return () => {};

  const listener = await plugin.addListener('watchCommand', (command) => {
    if (!command || typeof command !== 'object') return;
    handler(command as WatchCommand);
  });

  return () => {
    void (listener as PluginListenerHandle).remove().catch(() => {});
  };
}
