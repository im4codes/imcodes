import type { PluginListenerHandle } from '@capacitor/core';
import { isNative } from './native.js';
import type { WatchApplicationContext, WatchDurableEvent } from './watch-projection.js';

export type WatchCommand =
  | { action: 'switchServer'; serverId: string }
  | { action: 'openSession'; serverId: string; sessionName: string }
  | { action: 'refresh' };

// Import plugin eagerly — registerPlugin returns a lightweight proxy on all platforms.
// Do NOT wrap in async/await — Capacitor's Proxy traps .then() which breaks awaiting.
import WatchBridge from './plugins/watch-bridge.js';

export async function syncSnapshotToWatch(context: WatchApplicationContext): Promise<void> {
  try {
    await WatchBridge.syncSnapshot({ context });
  } catch {
    // Web/non-native: plugin not available — silent no-op
  }
}

export async function pushDurableEventToWatch(event: WatchDurableEvent): Promise<void> {
  try {
    await WatchBridge.pushDurableEvent({ event });
  } catch {
    // Web/non-native: silent no-op
  }
}

export async function onWatchCommand(handler: (command: WatchCommand) => void): Promise<() => void> {
  if (!isNative()) return () => {};

  const listener = await WatchBridge.addListener('watchCommand', (command) => {
    if (!command || typeof command !== 'object') return;
    handler(command as WatchCommand);
  });

  return () => {
    void (listener as PluginListenerHandle).remove().catch(() => {});
  };
}
