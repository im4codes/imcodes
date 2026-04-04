import { registerPlugin, type Plugin, type PluginListenerHandle } from '@capacitor/core';
import type { WatchApplicationContext, WatchDurableEvent } from '../watch-projection.js';

export interface WatchBridgePlugin extends Plugin {
  syncSnapshot(options: { context: WatchApplicationContext }): Promise<void>;
  pushDurableEvent(options: { event: WatchDurableEvent }): Promise<void>;
  addListener(
    eventName: 'watchCommand',
    listenerFunc: (command: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
}

const WatchBridge = registerPlugin<WatchBridgePlugin>('WatchBridge');

export default WatchBridge;
