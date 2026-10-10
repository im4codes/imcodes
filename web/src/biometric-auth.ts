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
const AUTH_SCOPE_MIGRATION_OWNER = 'deck_auth_scope_migration_owner_v1';
const AUTH_SCOPE_MIGRATION_COMPLETE = 'deck_auth_scope_migration_complete_v1';

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

/**
 * Upgrade the legacy single-server slots exactly once.
 *
 * Only the server URL already persisted by the old app is trusted to own those
 * ambiguous credentials. If there is no selected server, discarding them is
 * safer than ever sending one Cloud Server's bearer token to another. The
 * owner marker makes a crash between the two scoped writes resumable.
 */
export async function initializeServerScopedAuth(serverUrl?: string | null): Promise<void> {
  if (await readStoredValue(AUTH_SCOPE_MIGRATION_COMPLETE)) return;

  const recordedOwner = normalizeCredentialServerUrl(
    await readStoredValue(AUTH_SCOPE_MIGRATION_OWNER),
  );
  const selectedOwner = recordedOwner ?? normalizeCredentialServerUrl(serverUrl);
  if (!selectedOwner) {
    await removeStoredValue(AUTH_KEY);
    await removeStoredValue(AUTH_KEY_ID);
    await writeStoredValue(AUTH_SCOPE_MIGRATION_COMPLETE, '1');
    await removeStoredValue(AUTH_SCOPE_MIGRATION_OWNER);
    return;
  }

  if (!recordedOwner) {
    await writeStoredValue(AUTH_SCOPE_MIGRATION_OWNER, selectedOwner);
  }
  const scopedAuthKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, selectedOwner)!;
  const scopedKeyId = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, selectedOwner)!;
  // Keep native Preferences reads serialized. Some bridge implementations
  // multiplex calls through one callback channel during cold startup.
  const legacyAuthKey = await readStoredValue(AUTH_KEY);
  const legacyKeyId = await readStoredValue(AUTH_KEY_ID);
  const existingAuthKey = await readStoredValue(scopedAuthKey);
  const existingKeyId = await readStoredValue(scopedKeyId);
  if (!existingAuthKey && legacyAuthKey) await writeStoredValue(scopedAuthKey, legacyAuthKey);
  if (!existingKeyId && legacyKeyId) await writeStoredValue(scopedKeyId, legacyKeyId);
  await removeStoredValue(AUTH_KEY);
  await removeStoredValue(AUTH_KEY_ID);
  await writeStoredValue(AUTH_SCOPE_MIGRATION_COMPLETE, '1');
  await removeStoredValue(AUTH_SCOPE_MIGRATION_OWNER);
}

/** Store API key — Preferences on native (encrypted by iOS), localStorage on web */
export async function storeAuthKey(apiKey: string, serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  await writeStoredValue(scopedKey ?? AUTH_KEY, apiKey);
}

/** Retrieve API key */
export async function getAuthKey(serverUrl?: string | null): Promise<string | null> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  return readStoredValue(scopedKey ?? AUTH_KEY);
}

/** Clear stored auth key */
export async function clearAuthKey(serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_V2_PREFIX, serverUrl);
  await removeStoredValue(scopedKey ?? AUTH_KEY);
}

export async function storeAuthKeyId(keyId: string, serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  await writeStoredValue(scopedKey ?? AUTH_KEY_ID, keyId);
}

export async function getAuthKeyId(serverUrl?: string | null): Promise<string | null> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  return readStoredValue(scopedKey ?? AUTH_KEY_ID);
}

export async function clearAuthKeyId(serverUrl?: string | null): Promise<void> {
  const scopedKey = scopedCredentialKey(AUTH_KEY_ID_V2_PREFIX, serverUrl);
  await removeStoredValue(scopedKey ?? AUTH_KEY_ID);
}
