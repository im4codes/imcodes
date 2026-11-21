import type { PluginListenerHandle } from '@capacitor/core';
import { isNative } from './native.js';
import { apiFetch, getApiKey } from './api.js';
import type { WatchApplicationContext, WatchDurableEvent } from './watch-projection.js';

export type WatchCommand =
  | { action: 'switchServer'; serverId: string }
  | { action: 'openSession'; serverId: string; sessionName: string }
  | { action: 'refresh' }
  | { action: 'requestSnapshot' };

const WATCH_API_KEY_PREFIX = 'imcodes_watch_api_key:';
const inFlightWatchApiKeys = new Map<string, Promise<string | null>>();

export function watchApiKeyStorageKey(baseUrl: string, userId: string): string {
  return `${WATCH_API_KEY_PREFIX}${baseUrl}:${userId}`;
}

export function resetWatchApiKeyResolutionForTesting(): void {
  inFlightWatchApiKeys.clear();
}

function readLocalWatchApiKey(storageKey: string): string | null {
  try {
    const local = localStorage.getItem(storageKey);
    return local && local.trim() ? local.trim() : null;
  } catch {
    return null;
  }
}

async function readNativeWatchApiKey(storageKey: string): Promise<string | null> {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: storageKey });
    if (value && value.trim()) return value.trim();
  } catch {
    // Ignore Preferences errors and fall back to localStorage
  }
  return readLocalWatchApiKey(storageKey);
}

async function writeStoredWatchApiKey(storageKey: string, apiKey: string): Promise<void> {
  try {
    localStorage.setItem(storageKey, apiKey);
  } catch {
    // Ignore storage errors
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: storageKey, value: apiKey });
  } catch {
    // Ignore Preferences errors
  }
}

export async function resolveWatchApiKey(
  auth: { userId?: string | null; baseUrl?: string | null } | null | undefined,
): Promise<string | null> {
  const directKey = getApiKey();
  if (directKey && directKey.trim()) return directKey;
  if (!isNative()) return null;

  const userId = auth?.userId?.trim();
  const baseUrl = auth?.baseUrl?.trim();
  if (!userId || !baseUrl) return null;

  const storageKey = watchApiKeyStorageKey(baseUrl, userId);
  const localCached = readLocalWatchApiKey(storageKey);
  if (localCached) return localCached;

  const existing = inFlightWatchApiKeys.get(storageKey);
  if (existing) return existing;

  const resolvePromise = (async (): Promise<string | null> => {
    try {
      const nativeCached = await readNativeWatchApiKey(storageKey);
      if (nativeCached) {
        try { localStorage.setItem(storageKey, nativeCached); } catch { /* ignore */ }
        return nativeCached;
      }

      const res = await apiFetch<{ id?: string; apiKey?: string }>('/api/auth/user/me/keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'Apple Watch' }),
      });
      const minted = typeof res?.apiKey === 'string' ? res.apiKey.trim() : '';
      if (!minted) return null;
      await writeStoredWatchApiKey(storageKey, minted);
      return minted;
    } catch (err) {
      console.warn('[watch-bridge] failed to resolve Watch API key:', err);
      return null;
    } finally {
      inFlightWatchApiKeys.delete(storageKey);
    }
  })();

  inFlightWatchApiKeys.set(storageKey, resolvePromise);
  return resolvePromise;
}

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
