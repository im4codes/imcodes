import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(),
  getApiKey: vi.fn<() => string | null>(() => null),
  apiFetch: vi.fn(),
  prefsGet: vi.fn(async () => ({ value: null as string | null })),
  prefsSet: vi.fn(async () => undefined),
  syncSnapshot: vi.fn(),
  pushDurableEvent: vi.fn(),
  addListener: vi.fn(),
}));

describe('watch bridge wrappers', () => {
  const storageMap = new Map<string, string>();

  beforeEach(() => {
    vi.resetModules();
    storageMap.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
      removeItem: (k: string) => { storageMap.delete(k); },
    });
    mocks.isNative.mockReset();
    mocks.getApiKey.mockReset();
    mocks.getApiKey.mockReturnValue(null);
    mocks.apiFetch.mockReset();
    mocks.prefsGet.mockReset();
    mocks.prefsGet.mockResolvedValue({ value: null });
    mocks.prefsSet.mockReset();
    mocks.prefsSet.mockResolvedValue(undefined);
    mocks.syncSnapshot.mockReset();
    mocks.pushDurableEvent.mockReset();
    mocks.addListener.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function importWatchBridge() {
    vi.doMock('../src/native.js', () => ({
      isNative: mocks.isNative,
    }));
    vi.doMock('../src/api.js', () => ({
      getApiKey: mocks.getApiKey,
      apiFetch: mocks.apiFetch,
    }));
    vi.doMock('@capacitor/preferences', () => ({
      Preferences: {
        get: mocks.prefsGet,
        set: mocks.prefsSet,
      },
    }));
    vi.doMock('../src/plugins/watch-bridge.js', () => ({
      default: {
        syncSnapshot: mocks.syncSnapshot,
        pushDurableEvent: mocks.pushDurableEvent,
        addListener: mocks.addListener,
      },
    }));
    return import('../src/watch-bridge.js');
  }

  it('calls plugin on all platforms (try/catch handles non-native gracefully)', async () => {
    mocks.isNative.mockReturnValue(false);
    const { syncSnapshotToWatch, pushDurableEventToWatch } = await importWatchBridge();

    await syncSnapshotToWatch({
      v: 1,
      snapshotStatus: 'fresh',
      generatedAt: 1,
      currentServerId: 'srv-1',
      servers: [],
      sessions: [],
      apiKey: null,
    });

    await pushDurableEventToWatch({ type: 'session.error', project: 'proj', message: 'boom' });

    // Plugin is called — on real web it would throw (caught silently), on native it goes through
    expect(mocks.syncSnapshot).toHaveBeenCalled();
    expect(mocks.pushDurableEvent).toHaveBeenCalled();
  });

  it('loads the native plugin lazily and forwards snapshot/event calls', async () => {
    mocks.isNative.mockReturnValue(true);
    const remove = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn();
    mocks.addListener.mockResolvedValue({ remove });
    const { syncSnapshotToWatch, pushDurableEventToWatch, onWatchCommand } = await importWatchBridge();

    await syncSnapshotToWatch({
      v: 1,
      snapshotStatus: 'fresh',
      generatedAt: 10,
      currentServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'Main', baseUrl: 'https://example.test' }],
      sessions: [],
      apiKey: 'watch-key',
    });

    await pushDurableEventToWatch({ type: 'session.notification', session: 'deck_sub_1', title: 'Hello', message: 'World' });

    const cleanup = await onWatchCommand(handler);
    expect(mocks.syncSnapshot).toHaveBeenCalledWith({
      context: {
        v: 1,
        snapshotStatus: 'fresh',
        generatedAt: 10,
        currentServerId: 'srv-1',
        servers: [{ id: 'srv-1', name: 'Main', baseUrl: 'https://example.test' }],
        sessions: [],
        apiKey: 'watch-key',
      },
    });
    expect(mocks.pushDurableEvent).toHaveBeenCalledWith({
      event: { type: 'session.notification', session: 'deck_sub_1', title: 'Hello', message: 'World' },
    });
    expect(mocks.addListener).toHaveBeenCalledWith('watchCommand', expect.any(Function));

    const listener = mocks.addListener.mock.calls[0]?.[1] as (command: { action: string }) => void;
    listener({ action: 'refresh' });
    expect(handler).toHaveBeenCalledWith({ action: 'refresh' });

    listener({ action: 'switchServer', serverId: 'srv-2' });
    expect(handler).toHaveBeenCalledWith({ action: 'switchServer', serverId: 'srv-2' });

    listener({ action: 'requestSnapshot' });
    expect(handler).toHaveBeenCalledWith({ action: 'requestSnapshot' });

    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns existing getApiKey() directly without minting a Watch key', async () => {
    mocks.isNative.mockReturnValue(true);
    mocks.getApiKey.mockReturnValue('direct-api-key');
    const { resolveWatchApiKey } = await importWatchBridge();

    const key = await resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    expect(key).toBe('direct-api-key');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('does not mint a Watch key in non-native browsers when getApiKey() is null', async () => {
    mocks.isNative.mockReturnValue(false);
    mocks.getApiKey.mockReturnValue(null);
    const { resolveWatchApiKey } = await importWatchBridge();

    const key = await resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    expect(key).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('mints and caches an Apple Watch API key once on native iOS when logged in via cookie/Passkey', async () => {
    mocks.isNative.mockReturnValue(true);
    mocks.getApiKey.mockReturnValue(null);
    let resolveFetch!: (val: { id: string; apiKey: string }) => void;
    mocks.apiFetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const { resolveWatchApiKey, watchApiKeyStorageKey, resetWatchApiKeyResolutionForTesting } = await importWatchBridge();
    resetWatchApiKeyResolutionForTesting();

    const p1 = resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    const p2 = resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/auth/user/me/keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'Apple Watch' }),
    });

    resolveFetch({ id: 'key-1', apiKey: 'deck_watch_minted_123' });
    const [k1, k2] = await Promise.all([p1, p2]);
    expect(k1).toBe('deck_watch_minted_123');
    expect(k2).toBe('deck_watch_minted_123');

    const storageKey = watchApiKeyStorageKey('https://app.im.codes', 'u1');
    expect(storageMap.get(storageKey)).toBe('deck_watch_minted_123');
    expect(mocks.prefsSet).toHaveBeenCalledWith({ key: storageKey, value: 'deck_watch_minted_123' });

    // Subsequent call reads cached key without hitting /api/auth/user/me/keys again
    const k3 = await resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    expect(k3).toBe('deck_watch_minted_123');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    // Preferences-only cache (after localStorage cleared) is also reused without minting
    storageMap.clear();
    mocks.prefsGet.mockResolvedValueOnce({ value: 'deck_watch_from_prefs' });
    const k4 = await resolveWatchApiKey({ userId: 'u1', baseUrl: 'https://app.im.codes' });
    expect(k4).toBe('deck_watch_from_prefs');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });
});
