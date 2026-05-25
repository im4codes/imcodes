/**
 * Native platform detection and persistent config.
 * Web mode: always returns window.location.origin, set/clear are no-ops.
 * Native mode: reads/writes @capacitor/preferences, defaults to app.im.codes.
 */

export const DEFAULT_SERVER_URL = 'https://app.im.codes';
const PREFS_SERVER_URL_KEY = 'deck_server_url';
const PREFS_SERVER_LIST_KEY = 'deck_server_list';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const isNative = (): boolean =>
  typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' &&
  (globalThis as any).Capacitor.isNativePlatform();

/** Returns null on native when no URL has been saved yet (first launch). */
export async function getServerUrl(): Promise<string | null> {
  if (!isNative()) return getCurrentOrigin();
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: PREFS_SERVER_URL_KEY });
    return normalizeServerUrl(value ?? readLocalStorageValue(PREFS_SERVER_URL_KEY));
  } catch {
    return normalizeServerUrl(readLocalStorageValue(PREFS_SERVER_URL_KEY));
  }
}

/** Returns the saved list of server URLs. Always includes DEFAULT_SERVER_URL first. */
export async function getServerList(): Promise<string[]> {
  const localList = readLocalStorageValue(PREFS_SERVER_LIST_KEY);
  const localCurrent = readLocalStorageValue(PREFS_SERVER_URL_KEY);
  if (!isNative()) {
    return mergeServerUrlList([DEFAULT_SERVER_URL, getCurrentOrigin(), ...parseServerListValue(localList), localCurrent]);
  }

  let persistedList: string | null = null;
  let persistedCurrent: string | null = null;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    persistedList = (await Preferences.get({ key: PREFS_SERVER_LIST_KEY })).value;
    persistedCurrent = (await Preferences.get({ key: PREFS_SERVER_URL_KEY })).value;
  } catch {
    // Keep going with the localStorage mirror below. The server picker should
    // never become empty just because the native Preferences bridge is late.
  }

  const merged = mergeServerUrlList([
    DEFAULT_SERVER_URL,
    persistedCurrent,
    ...parseServerListValue(persistedList),
    localCurrent,
    ...parseServerListValue(localList),
  ]);
  persistServerListMirror(merged);
  return merged;
}

/** Add a URL to the saved server list (no-op if already present). */
export async function addServerToList(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return;
  const list = mergeServerUrlList([...(await getServerList()), normalized]);
  persistServerListMirror(list);
  if (!isNative()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_LIST_KEY, value: JSON.stringify(list) });
}

/** Remove a URL from the saved server list. Cannot remove the default server. */
export async function removeServerFromList(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (!normalized || normalized === DEFAULT_SERVER_URL) return;
  const updated = (await getServerList()).filter((u) => u !== normalized);
  persistServerListMirror(updated);
  if (!isNative()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_LIST_KEY, value: JSON.stringify(updated) });
}

/** Stores the selected native server URL and mirrors it locally for recovery. */
export async function setServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return;
  writeLocalStorageValue(PREFS_SERVER_URL_KEY, normalized);
  await addServerToList(normalized);
  if (!isNative()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_URL_KEY, value: normalized });
}

export async function clearServerUrl(): Promise<void> {
  removeLocalStorageValue(PREFS_SERVER_URL_KEY);
  if (!isNative()) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.remove({ key: PREFS_SERVER_URL_KEY });
}

/** Client-side URL validation: must be HTTPS (except localhost for dev). */
export function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getCurrentOrigin(): string {
  try {
    return globalThis.location?.origin ?? '';
  } catch {
    return '';
  }
}

function normalizeServerUrl(url: string | null | undefined): string | null {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, '');
  return isValidServerUrl(normalized) ? normalized : null;
}

function parseServerListValue(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => typeof item === 'string' ? [item] : []);
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { servers?: unknown; urls?: unknown };
      const list = Array.isArray(record.servers) ? record.servers : record.urls;
      if (Array.isArray(list)) {
        return list.flatMap((item) => typeof item === 'string' ? [item] : []);
      }
    }
  } catch {
    return value.split(/[\n,]/g);
  }
  return [];
}

function mergeServerUrlList(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeServerUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readLocalStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* ignore restricted storage */ }
}

function removeLocalStorageValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch { /* ignore restricted storage */ }
}

function persistServerListMirror(list: string[]): void {
  writeLocalStorageValue(PREFS_SERVER_LIST_KEY, JSON.stringify(mergeServerUrlList([DEFAULT_SERVER_URL, ...list])));
}
