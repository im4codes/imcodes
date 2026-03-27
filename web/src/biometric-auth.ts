/**
 * Auth key storage for Capacitor apps.
 * Uses @capacitor/preferences on native (already in Package.swift).
 * Falls back to localStorage on web.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();

const AUTH_KEY = 'deck_auth_key';

/** Store API key — Preferences on native (encrypted by iOS), localStorage on web */
export async function storeAuthKey(apiKey: string): Promise<void> {
  if (!isNative()) {
    localStorage.setItem(AUTH_KEY, apiKey);
    return;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: AUTH_KEY, value: apiKey });
  } catch {
    localStorage.setItem(AUTH_KEY, apiKey);
  }
}

/** Retrieve API key */
export async function getAuthKey(): Promise<string | null> {
  if (!isNative()) {
    return localStorage.getItem(AUTH_KEY);
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: AUTH_KEY });
    return value;
  } catch {
    return localStorage.getItem(AUTH_KEY);
  }
}

/** Clear stored auth key */
export async function clearAuthKey(): Promise<void> {
  localStorage.removeItem(AUTH_KEY);
  if (!isNative()) return;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key: AUTH_KEY });
  } catch {
    // ignore
  }
}
