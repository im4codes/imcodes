import { useState, useEffect, useRef } from 'preact/hooks';
import { getUserPref, saveUserPref } from '../api.js';

/** Payload format stored in both localStorage and server. */
interface SyncPayload<T> {
  v: T;
  t: number;
}

const LS_PREFIX = 'rcc_sync_';

function lsKey(key: string): string {
  return `${LS_PREFIX}${key}`;
}

function readFromLocalStorage<T>(key: string): SyncPayload<T> | null {
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (!raw) return null;
    return JSON.parse(raw) as SyncPayload<T>;
  } catch {
    return null;
  }
}

function writeToLocalStorage<T>(key: string, payload: SyncPayload<T>): void {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(payload));
  } catch { /* storage full or restricted */ }
}

/**
 * Generic write-through cache hook for server-synced preferences.
 *
 * - On mount: reads localStorage immediately (instant render), then fetches
 *   server async. Newer timestamp wins; if local is newer, pushes to server.
 * - On setValue: updates state + localStorage immediately, then debounces a
 *   server PUT.
 * - On unmount: cancels any pending debounced save.
 *
 * Both localStorage and server store the same `{ v: T, t: number }` payload.
 */
export function useSyncedPreference<T>(
  key: string,
  defaultValue: T,
  debounceMs = 300,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValueState] = useState<T>(() => {
    const local = readFromLocalStorage<T>(key);
    return local !== null ? local.v : defaultValue;
  });

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On mount: fetch server and reconcile timestamps.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const serverRaw = await getUserPref(key);
      if (cancelled) return;

      if (serverRaw == null) {
        // No server value — push local value (if any) to server.
        const local = readFromLocalStorage<T>(key);
        if (local !== null) {
          try {
            await saveUserPref(key, JSON.stringify(local));
          } catch (err) {
            console.warn(`[useSyncedPreference] failed to push local pref "${key}" to server:`, err);
          }
        }
        return;
      }

      // Server value exists — parse it.
      let serverPayload: SyncPayload<T> | null = null;
      try {
        const raw = typeof serverRaw === 'string' ? serverRaw : JSON.stringify(serverRaw);
        serverPayload = JSON.parse(raw) as SyncPayload<T>;
      } catch {
        console.warn(`[useSyncedPreference] could not parse server pref "${key}"`);
        return;
      }

      if (!serverPayload || typeof serverPayload.t !== 'number') return;

      const local = readFromLocalStorage<T>(key);

      if (local === null || serverPayload.t >= local.t) {
        // Server is newer (or no local) — update state and localStorage.
        if (cancelled) return;
        setValueState(serverPayload.v);
        writeToLocalStorage(key, serverPayload);
      } else {
        // Local is newer — push to server.
        try {
          await saveUserPref(key, JSON.stringify(local));
        } catch (err) {
          console.warn(`[useSyncedPreference] failed to push newer local pref "${key}" to server:`, err);
        }
      }
    })().catch((err) => {
      if (!cancelled) {
        console.warn(`[useSyncedPreference] failed to fetch server pref "${key}":`, err);
      }
    });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cleanup debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  const setValue = (updater: T | ((prev: T) => T)): void => {
    setValueState((prev) => {
      const newValue = typeof updater === 'function'
        ? (updater as (prev: T) => T)(prev)
        : updater;

      const payload: SyncPayload<T> = { v: newValue, t: Date.now() };

      // Write to localStorage synchronously (survives page close).
      writeToLocalStorage(key, payload);

      // Debounced server PUT.
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void saveUserPref(key, JSON.stringify(payload)).catch((err) => {
          console.warn(`[useSyncedPreference] failed to save pref "${key}" to server:`, err);
        });
      }, debounceMs);

      return newValue;
    });
  };

  return [value, setValue];
}
