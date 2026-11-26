import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { parseSyncedPreference, type SyncedPreferencePayload } from '@shared/synced-preference.js';
import { getUserPref, saveUserPref } from '../api.js';
import { safeLocalStorageSetItem } from '../local-storage-quota.js';

const LS_PREFIX = 'rcc_sync_';
function lsKey(key: string, scope?: string): string {
  return `${LS_PREFIX}${scope ? `${encodeURIComponent(scope)}:` : ''}${key}`;
}
function readLocal<T>(storageKey: string): SyncedPreferencePayload<T> | null {
  try { return parseSyncedPreference<T>(localStorage.getItem(storageKey)); } catch { return null; }
}
function localValue<T>(storageKey: string, fallback: T): T {
  const local = readLocal<T>(storageKey);
  return local === null ? fallback : local.v;
}
function writeLocal<T>(storageKey: string, payload: SyncedPreferencePayload<T>): void {
  // Preferences are durable intent: quota recovery evicts volatile snapshots first.
  safeLocalStorageSetItem(storageKey, JSON.stringify(payload));
}
function samePrefValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Whole-value LWW cache. Inventory/render projections must never be saved here.
 * Reconcile on mount/resume/reconnect; a failed read is not a missing preference.
 * Scope changes cancel pending requests/timers and fence old render callbacks.
 */
export function useSyncedPreference<T>(
  key: string,
  defaultValue: T,
  debounceMs = 300,
  localScope?: string,
): [T, (value: T | ((prev: T) => T)) => void, boolean] {
  const storageKey = lsKey(key, localScope);
  const owner = useRef({ storageKey, key });
  if (owner.current.storageKey !== storageKey || owner.current.key !== key) owner.current = { storageKey, key };
  const identity = owner.current;
  const [state, setState] = useState(() => ({ identity, value: localValue(storageKey, defaultValue) }));
  const [hydratedOwner, setHydratedOwner] = useState<typeof identity | null>(null);
  const latest = useRef<{ identity: typeof identity; payload: SyncedPreferencePayload<T> | null } | null>(null);
  if (latest.current?.identity !== identity) latest.current = { identity, payload: readLocal<T>(storageKey) };
  const readLatest = () => {
    const local = readLocal<T>(storageKey);
    const memory = latest.current?.payload ?? null;
    return local && (!memory || local.t >= memory.t) ? local : memory;
  };
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let cancelled = false;
    let running = false;
    let queued = false;
    const active = () => !cancelled && owner.current === identity;
    const apply = (payload: SyncedPreferencePayload<T>, writeToDisk: boolean) => {
      if (!active()) return;
      const prevPayload = latest.current?.identity === identity ? latest.current.payload : null;
      const diskLocal = readLocal<T>(storageKey);
      const matchesPrev = prevPayload !== null && samePrefValue(payload.v, prevPayload.v);
      const matchesDisk = diskLocal !== null && samePrefValue(payload.v, diskLocal.v);
      latest.current = { identity, payload };
      if (writeToDisk && !matchesDisk) {
        writeLocal(storageKey, payload);
      }
      if (matchesPrev) return;
      setState((prev) => (
        prev.identity === identity && samePrefValue(prev.value, payload.v)
          ? prev
          : { identity, value: payload.v }
      ));
    };
    setState((prev) => (prev.identity === identity ? prev : { identity, value: localValue(storageKey, defaultValue) }));

    const reconcile = async () => {
      if (!active()) return;
      if (running) { queued = true; return; }
      running = true;
      do {
        queued = false;
        try {
          const raw = await getUserPref(key, { strict: true, signal: abort.signal });
          if (!active()) return;
          const remote = parseSyncedPreference<T>(raw);
          const local = readLatest();
          if (raw != null && !remote) continue; // corrupt/legacy data is not a reset
          if (remote && (!local || remote.t >= local.t)) apply(remote, true);
          else if (local) await saveUserPref(key, JSON.stringify(local), { signal: abort.signal });
        } catch (error) {
          if (active()) console.warn(`[useSyncedPreference] failed to reconcile pref "${key}":`, error);
        } finally {
          if (active()) setHydratedOwner(identity);
        }
      } while (queued && active());
      running = false;
    };
    const wake = () => { void reconcile(); };
    const visible = () => { if (document.visibilityState === 'visible') wake(); };
    const storage = (event: StorageEvent) => {
      if (!active() || event.key !== storageKey) return;
      const incoming = parseSyncedPreference<T>(event.newValue);
      const local = readLatest();
      if (incoming && (!local || incoming.t >= local.t)) apply(incoming, false);
      else if (local && incoming && incoming.t < local.t) {
        // An older tab may have overwritten the shared storage row already.
        // Restore known intent too, so an offline reload cannot resurrect it.
        writeLocal(storageKey, local);
      }
    };
    wake();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('storage', storage);
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      abort.abort();
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('storage', storage);
      document.removeEventListener('visibilitychange', visible);
    };
  // Default objects/arrays are often inline; scope/key alone define ownership.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const setValue = useCallback((updater: T | ((prev: T) => T)): void => {
    if (owner.current !== identity) return;
    const previous = readLatest();
    const priorValue = previous ? previous.v : (state.identity === identity ? state.value : defaultValue);
    const next = typeof updater === 'function' ? (updater as (prev: T) => T)(priorValue) : updater;
    if (previous && samePrefValue(next, previous.v)) {
      latest.current = { identity, payload: previous };
      setState((prev) => (
        prev.identity === identity && samePrefValue(prev.value, next)
          ? prev
          : { identity, value: next }
      ));
      return;
    }
    const payload: SyncedPreferencePayload<T> = { v: next, t: Math.max(Date.now(), (previous?.t ?? 0) + 1) };
    latest.current = { identity, payload };
    writeLocal(storageKey, payload);
    setState({ identity, value: next });
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    const save = () => {
      debounceTimer.current = null;
      if (owner.current !== identity || controller.current?.signal.aborted) return;
      void saveUserPref(key, JSON.stringify(payload), { signal: controller.current?.signal }).catch((error) => {
        if (owner.current === identity) console.warn(`[useSyncedPreference] failed to save pref "${key}":`, error);
      });
    };
    if (debounceMs <= 0) save();
    else debounceTimer.current = setTimeout(save, debounceMs);
  }, [identity, storageKey, key, state, defaultValue, debounceMs]);

  return [state.identity === identity ? state.value : localValue(storageKey, defaultValue), setValue, hydratedOwner === identity];
}
