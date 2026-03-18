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
  if (!isNative()) return window.location.origin;
  const { Preferences } = await import('@capacitor/preferences');
  const { value } = await Preferences.get({ key: PREFS_SERVER_URL_KEY });
  return value; // null = not configured yet → show ServerSetupPage
}

/** Returns the saved list of server URLs. Never includes duplicates. */
export async function getServerList(): Promise<string[]> {
  if (!isNative()) return [];
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: PREFS_SERVER_LIST_KEY });
    if (!value) return [];
    return JSON.parse(value) as string[];
  } catch {
    return [];
  }
}

/** Add a URL to the saved server list (no-op if already present). */
export async function addServerToList(url: string): Promise<void> {
  if (!isNative()) return;
  const list = await getServerList();
  if (list.includes(url)) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_LIST_KEY, value: JSON.stringify([...list, url]) });
}

/** Remove a URL from the saved server list. */
export async function removeServerFromList(url: string): Promise<void> {
  if (!isNative()) return;
  const list = await getServerList();
  const updated = list.filter((u) => u !== url);
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_LIST_KEY, value: JSON.stringify(updated) });
}

/** Only stores on native; on web, server URL is always window.location.origin. */
export async function setServerUrl(url: string): Promise<void> {
  if (!isNative()) return;
  const normalized = url.replace(/\/$/, '');
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: PREFS_SERVER_URL_KEY, value: normalized });
}

export async function clearServerUrl(): Promise<void> {
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
