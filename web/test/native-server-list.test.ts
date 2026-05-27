/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failGet: false,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => {
      if (preferenceState.failGet) throw new Error('preferences unavailable');
      return { value: preferenceState.store.get(key) ?? null };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferenceState.store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferenceState.store.delete(key);
    }),
  },
}));

describe('native server URL list', () => {
  beforeEach(() => {
    preferenceState.store.clear();
    preferenceState.failGet = false;
    localStorage.clear();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  });

  it('merges the built-in relay, current server, saved list, and local mirror', async () => {
    const { DEFAULT_SERVER_URL, getServerList } = await import('../src/native.js');
    preferenceState.store.set('deck_server_url', 'https://current.example/');
    preferenceState.store.set('deck_server_list', JSON.stringify([
      DEFAULT_SERVER_URL,
      'https://relay-one.example/',
      'not a url',
    ]));
    localStorage.setItem('deck_server_list', JSON.stringify([
      'https://relay-two.example',
      'https://relay-one.example',
    ]));

    await expect(getServerList()).resolves.toEqual([
      DEFAULT_SERVER_URL,
      'https://current.example',
      'https://relay-one.example',
      'https://relay-two.example',
    ]);
  });

  it('falls back to the local mirror instead of returning an empty picker', async () => {
    const { DEFAULT_SERVER_URL, getServerList } = await import('../src/native.js');
    preferenceState.failGet = true;
    localStorage.setItem('deck_server_url', 'https://active.example');
    localStorage.setItem('deck_server_list', JSON.stringify([
      'https://relay-a.example',
      'https://relay-b.example',
    ]));

    await expect(getServerList()).resolves.toEqual([
      DEFAULT_SERVER_URL,
      'https://active.example',
      'https://relay-a.example',
      'https://relay-b.example',
    ]);
  });

  it('persists selected servers into the picker list and keeps them after clearing the active URL', async () => {
    const { DEFAULT_SERVER_URL, clearServerUrl, getServerList, getServerUrl, setServerUrl } = await import('../src/native.js');

    await setServerUrl('https://new-relay.example/');
    expect(preferenceState.store.get('deck_server_url')).toBe('https://new-relay.example');
    expect(JSON.parse(preferenceState.store.get('deck_server_list') ?? '[]')).toEqual([
      DEFAULT_SERVER_URL,
      'https://new-relay.example',
    ]);
    await expect(getServerUrl()).resolves.toBe('https://new-relay.example');

    await clearServerUrl();
    await expect(getServerUrl()).resolves.toBeNull();
    await expect(getServerList()).resolves.toEqual([
      DEFAULT_SERVER_URL,
      'https://new-relay.example',
    ]);
  });
});
