/**
 * Auth key storage for Capacitor apps.
 * Uses @capacitor/preferences on native (already in Package.swift).
 * Falls back to localStorage on web.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();

const AUTH_KEY = 'deck_auth_key';
const AUTH_KEY_ID = 'deck_api_key_id';
const AUTH_KEY_V2_PREFIX = 'deck_auth_key_v2:';
const AUTH_KEY_ID_V2_PREFIX = 'deck_api_key_id_v2:';

function normalizeCredentialServerUrl(serverUrl: string | null | undefined): string | null {
  const trimmed = String(serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function scopedCredentialKey(prefix: string, serverUrl: string | null | undefined): string | null {
  const normalized = normalizeCredentialServerUrl(serverUrl);
  return normalized ? `${prefix}${encodeURIComponent(normalized)}` : null;
}

async function readStoredValue(key: string): Promise<string | null> {
  if (!isNative()) return localStorage.getItem(key);
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key });
    return value ?? localStorage.getItem(key);
  } catch {
    return localStorage.getItem(key);
  }
}

async function writeStoredValue(key: string, value: string): Promise<void> {
  if (!isNative()) {
    localStorage.setItem(key, value);
    return;
  }
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key, value });
    localStorage.removeItem(key);
  } catch {
    localStorage.setItem(key, value);
  }
}

async function removeStoredValue(key: string): Promise<void> {
  localStorage.removeItem(key);
  if (!isNative()) return;
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key });
  } catch {
    // ignore
  }
}

async function migrateLegacyValue(legacyKey: string, scopedKey: string): Promise<string | null> {
  const existing = await readStoredValue(scopedKey);
  if (existing) return existing;
  const legacy = await readStoredValue(legacyKey);
  if (!legacy) return null;
  // The legacy slot always belonged to the one selected server from the old
  // schema. Write the isolated slot first, then remove the ambiguous alias.
  await writeStoredValue(scopedKey, legacy);
  await removeStoredValue(legacyKey);
  return legacy;
}

/** Store API key — Preferences on native (encrypted by iOS), localStorage on web */
export async function storeAuthKey(apiKey: string, serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  await writeStoredValue(scopedKey ?? AUTH_KEY, apiKey);
  if (scopedKey) await removeStoredValue(AUTH_KEY);
}

/** Retrieve API key */
export async function getAuthKey(serverUrl?: string | null): Promise<string | null> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  return scopedKey ? migrateLegacyValue(AUTH_KEY, scopedKey) : readStoredValue(AUTH_KEY);
}

/** Clear stored auth key */
export async function clearAuthKey(serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  if (scopedKey) await removeStoredValue(scopedKey);
  // Clear the legacy alias too: before migration it can only represent the
  // currently selected server, never another saved Cloud Server.
  await removeStoredValue(AUTH_KEY);
}

export async function storeAuthKeyId(keyId: string, serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  await writeStoredValue(scopedKey ?? AUTH_KEY_ID, keyId);
  if (scopedKey) await removeStoredValue(AUTH_KEY_ID);
}

export async function getAuthKeyId(serverUrl?: string | null): Promise<string | null> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  return scopedKey ? migrateLegacyValue(AUTH_KEY_ID, scopedKey) : readStoredValue(AUTH_KEY_ID);
}

export async function clearAuthKeyId(serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  if (scopedKey) await removeStoredValue(scopedKey);
  await removeStoredValue(AUTH_KEY_ID);
}
