/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceState = vi.hoisted(() => ({
  store: new Map<string, string>(),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: preferenceState.store.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferenceState.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferenceState.store.delete(key);
    }),
  },
}));

describe('server-scoped native credentials', () => {
  beforeEach(() => {
    preferenceState.store.clear();
    localStorage.clear();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps API keys and key IDs isolated by normalized Cloud Server URL', async () => {
    const {
      clearAuthKey,
      clearAuthKeyId,
      getAuthKey,
      getAuthKeyId,
      storeAuthKey,
      storeAuthKeyId,
    } = await import('../src/biometric-auth.js');

    await storeAuthKey('key-a', 'https://cloud-a.example/');
    await storeAuthKeyId('key-id-a', 'https://cloud-a.example/');
    await storeAuthKey('key-b', 'https://cloud-b.example');
    await storeAuthKeyId('key-id-b', 'https://cloud-b.example');

    await expect(getAuthKey('https://cloud-a.example')).resolves.toBe('key-a');
    await expect(getAuthKeyId('https://cloud-a.example')).resolves.toBe('key-id-a');
    await expect(getAuthKey('https://cloud-b.example/')).resolves.toBe('key-b');
    await expect(getAuthKeyId('https://cloud-b.example/')).resolves.toBe('key-id-b');

    await clearAuthKey('https://cloud-a.example');
    await clearAuthKeyId('https://cloud-a.example');
    await expect(getAuthKey('https://cloud-a.example')).resolves.toBeNull();
    await expect(getAuthKeyId('https://cloud-a.example')).resolves.toBeNull();
    await expect(getAuthKey('https://cloud-b.example')).resolves.toBe('key-b');
    await expect(getAuthKeyId('https://cloud-b.example')).resolves.toBe('key-id-b');
  });

  it('atomically migrates both legacy credentials before another server can modify them', async () => {
    preferenceState.store.set('deck_auth_key', 'legacy-api-key');
    preferenceState.store.set('deck_api_key_id', 'legacy-key-id');
    const {
      clearAuthKey,
      clearAuthKeyId,
      getAuthKey,
      getAuthKeyId,
      initializeServerScopedAuth,
      storeAuthKey,
      storeAuthKeyId,
    } = await import('../src/biometric-auth.js');

    await initializeServerScopedAuth('https://legacy-cloud.example/');
    await expect(getAuthKey('https://legacy-cloud.example/')).resolves.toBe('legacy-api-key');
    await expect(getAuthKeyId('https://legacy-cloud.example/')).resolves.toBe('legacy-key-id');
    expect(preferenceState.store.has('deck_auth_key')).toBe(false);
    expect(preferenceState.store.has('deck_api_key_id')).toBe(false);

    await storeAuthKey('different-key', 'https://different-cloud.example');
    await storeAuthKeyId('different-key-id', 'https://different-cloud.example');
    await clearAuthKey('https://different-cloud.example');
    await clearAuthKeyId('https://different-cloud.example');
    await expect(getAuthKey('https://legacy-cloud.example')).resolves.toBe('legacy-api-key');
    await expect(getAuthKeyId('https://legacy-cloud.example')).resolves.toBe('legacy-key-id');
  });

  it('discards ambiguous legacy credentials when no previously selected server exists', async () => {
    preferenceState.store.set('deck_auth_key', 'must-not-send-to-arbitrary-server');
    preferenceState.store.set('deck_api_key_id', 'ambiguous-key-id');
    const { getAuthKey, getAuthKeyId, initializeServerScopedAuth } = await import('../src/biometric-auth.js');

    await initializeServerScopedAuth(null);

    await expect(getAuthKey('https://newly-selected.example')).resolves.toBeNull();
    await expect(getAuthKeyId('https://newly-selected.example')).resolves.toBeNull();
    expect(preferenceState.store.has('deck_auth_key')).toBe(false);
    expect(preferenceState.store.has('deck_api_key_id')).toBe(false);
    expect(preferenceState.store.get('deck_auth_scope_migration_complete_v1')).toBe('1');
  });
});
