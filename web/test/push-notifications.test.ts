/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiFetchMock,
  pushAddListenerMock,
  pushCheckPermissionsMock,
  pushRegisterMock,
  pushRequestPermissionsMock,
  pushListeners,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  pushAddListenerMock: vi.fn(),
  pushCheckPermissionsMock: vi.fn(),
  pushRegisterMock: vi.fn(),
  pushRequestPermissionsMock: vi.fn(),
  pushListeners: {} as Record<string, (payload: unknown) => unknown>,
}));

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: (...args: unknown[]) => pushAddListenerMock(...args),
    checkPermissions: (...args: unknown[]) => pushCheckPermissionsMock(...args),
    register: (...args: unknown[]) => pushRegisterMock(...args),
    requestPermissions: (...args: unknown[]) => pushRequestPermissionsMock(...args),
  },
}));

describe('push notification badge reset', () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetchMock.mockReset().mockResolvedValue({ ok: true });
    pushAddListenerMock.mockReset().mockImplementation((eventName: string, handler: (payload: unknown) => unknown) => {
      pushListeners[eventName] = handler;
    });
    pushCheckPermissionsMock.mockReset().mockResolvedValue({ receive: 'granted' });
    pushRegisterMock.mockReset().mockResolvedValue(undefined);
    pushRequestPermissionsMock.mockReset().mockResolvedValue({ receive: 'granted' });
    for (const eventName of Object.keys(pushListeners)) delete pushListeners[eventName];
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
  });

  it('forwards a native notification tap with the exact server and session target', async () => {
    const navigate = vi.fn();
    window.addEventListener('deck:navigate', navigate, { once: true });
    const { initPushNotifications } = await import('../src/push-notifications.js');

    await initPushNotifications('api-key', 'https://app.im.codes');
    expect(pushListeners.pushNotificationActionPerformed).toBeTypeOf('function');

    pushListeners.pushNotificationActionPerformed?.({
      notification: {
        data: { serverId: 'srv-2', session: 'deck_sub_alpha_helper' },
      },
    });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect((navigate.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      serverId: 'srv-2',
      session: 'deck_sub_alpha_helper',
    });
  });

  it('resets server badge through apiFetch', async () => {
    const { resetPushBadge } = await import('../src/push-notifications.js');

    await resetPushBadge(true);

    expect(apiFetchMock).toHaveBeenCalledWith('/api/push/badge-reset', { method: 'POST' });
  });

  it('routes native callback through the same server reset path', async () => {
    await import('../src/push-notifications.js');

    await (window as Window & { __imcodesResetBadge?: () => Promise<void> }).__imcodesResetBadge?.();

    expect(apiFetchMock).toHaveBeenCalledWith('/api/push/badge-reset', { method: 'POST' });
  });
});

describe('push notification preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
  });

  it('falls back to default push notification types when localStorage is empty', async () => {
    const { getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');
    const { DEFAULT_PUSH_NOTIFICATION_TYPES } = await import('@shared/push-notifications.js');

    const prefs = getLocalPushNotificationPreferences();
    expect(prefs).toEqual(DEFAULT_PUSH_NOTIFICATION_TYPES);
  });

  it('reads and sanitizes saved push notification types from localStorage', async () => {
    const { getLocalPushNotificationPreferences, PUSH_NOTIFICATION_PREFERENCES_KEY } = await import('../src/push-notifications.js');
    localStorage.setItem(
      PUSH_NOTIFICATION_PREFERENCES_KEY,
      JSON.stringify(['task_complete', 'invalid_type', 'remote_desktop']),
    );

    const prefs = getLocalPushNotificationPreferences();
    expect(prefs).toEqual(['task_complete', 'remote_desktop']);
  });

  it('saves preferences to localStorage', async () => {
    const { setLocalPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    setLocalPushNotificationPreferences(['task_pair_done', 'remote_desktop']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_done', 'remote_desktop']);
  });

  it('fetches remote preferences and caches them locally', async () => {
    const { fetchPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete', 'task_pair_paused', 'remote_desktop'],
    });

    const types = await fetchPushNotificationPreferences();
    expect(types).toEqual(['task_complete', 'task_pair_paused', 'remote_desktop']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_complete', 'task_pair_paused', 'remote_desktop']);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/push/preferences');
  });

  it('syncs push notification preferences to the server and local storage', async () => {
    const { syncPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');
    apiFetchMock.mockResolvedValueOnce({ ok: true });

    await syncPushNotificationPreferences(['task_complete', 'waiting_input']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_complete', 'waiting_input']);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/push/preferences', {
      method: 'POST',
      body: JSON.stringify({ types: ['task_complete', 'waiting_input'] }),
    });
  });

  it('preserves explicitly empty array [] in localStorage and does not fall back to defaults', async () => {
    const { setLocalPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    setLocalPushNotificationPreferences([]);
    expect(getLocalPushNotificationPreferences()).toEqual([]);
  });

  it('guards against late initial fetch overwriting newer local edits', async () => {
    const { fetchPushNotificationPreferences, recordLocalPushNotificationEdit, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    let resolveFetch: (val: any) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    apiFetchMock.mockReturnValueOnce(fetchPromise);

    // Initial fetch starts
    const pendingFetch = fetchPushNotificationPreferences();

    // User edits checkbox in UI before fetch completes
    recordLocalPushNotificationEdit(['remote_desktop']);

    // Fetch finally completes with stale defaults
    resolveFetch!({
      ok: true,
      types: ['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop'],
    });

    const result = await pendingFetch;
    // Returns null to indicate discarded stale fetch
    expect(result).toBeNull();
    // Local storage still retains user's edit
    expect(getLocalPushNotificationPreferences()).toEqual(['remote_desktop']);
  });

  it('preserves dirty selection when preference sync fails, blocking subsequent remote read override', async () => {
    const { syncPushNotificationPreferences, fetchPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    apiFetchMock.mockRejectedValueOnce(new Error('injected POST failure'));
    await syncPushNotificationPreferences(['task_pair_audit']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_audit']);

    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop'],
    });
    const result = await fetchPushNotificationPreferences();
    expect(result).toBeNull();
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_audit']);
  });

  it('prevents a settings read started before save ACK from restoring stale server defaults', async () => {
    const { syncPushNotificationPreferences, fetchPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    let ack: (val: any) => void;
    apiFetchMock.mockImplementation((path: string, options: any) => {
      if (options?.method === 'POST') {
        return new Promise((resolve) => {
          ack = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        types: ['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop'],
      });
    });

    const save = syncPushNotificationPreferences(['task_pair_audit']);
    await Promise.resolve();
    await Promise.resolve();

    await fetchPushNotificationPreferences();
    const seen = getLocalPushNotificationPreferences();
    ack!({ ok: true });
    await save;

    expect(seen).toEqual(['task_pair_audit']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_audit']);
  });

  it('rejects a GET issued while dirty even when its response arrives after POST ACK (edit -> GET -> ACK -> response)', async () => {
    const {
      syncPushNotificationPreferences,
      fetchPushNotificationPreferences,
      getLocalPushNotificationPreferences,
      hasUnsyncedPushNotificationEdits,
    } = await import('../src/push-notifications.js');

    let ack: ((val: any) => void) | undefined;
    let readResolve: ((val: any) => void) | undefined;

    apiFetchMock.mockImplementation((path: string, options: any) => {
      if (options?.method === 'POST') {
        return new Promise((resolve) => {
          ack = resolve;
        });
      }
      return new Promise((resolve) => {
        readResolve = resolve;
      });
    });

    const save = syncPushNotificationPreferences(['task_pair_audit']);
    await Promise.resolve();
    await Promise.resolve();
    expect(hasUnsyncedPushNotificationEdits()).toBe(true);

    // Issue GET while dirty
    const pendingRead = fetchPushNotificationPreferences();

    // POST succeeds and ACK arrives before GET response
    ack!({ ok: true });
    await save;
    expect(hasUnsyncedPushNotificationEdits()).toBe(false);

    // Old GET response arrives with stale defaults
    readResolve!({
      ok: true,
      types: ['task_complete', 'waiting_input', 'session_error', 'task_pair_done', 'task_pair_paused', 'remote_desktop'],
    });
    const result = await pendingRead;

    // Must be discarded and must not overwrite user's selection
    expect(result).toBeNull();
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_audit']);
  });

  it('allows normal remote hydration once in-flight edits are successfully ACKed', async () => {
    const { syncPushNotificationPreferences, fetchPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    apiFetchMock.mockResolvedValueOnce({ ok: true });
    await syncPushNotificationPreferences(['task_pair_done']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_done']);

    // Once successfully ACKed, a new remote fetch hydrates cleanly
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_pair_done', 'remote_desktop'],
    });
    const hydrated = await fetchPushNotificationPreferences();
    expect(hydrated).toEqual(['task_pair_done', 'remote_desktop']);
    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_done', 'remote_desktop']);
  });

  it('coalesces rapid consecutive sync calls and commits the final generation', async () => {
    const { syncPushNotificationPreferences, getLocalPushNotificationPreferences } = await import('../src/push-notifications.js');

    const postBodies: any[] = [];
    apiFetchMock.mockImplementation((path: string, options: any) => {
      if (options?.method === 'POST') {
        postBodies.push(JSON.parse(options.body));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, types: [] });
    });

    await Promise.all([
      syncPushNotificationPreferences(['task_complete']),
      syncPushNotificationPreferences(['task_complete', 'waiting_input']),
      syncPushNotificationPreferences(['task_pair_audit']),
    ]);

    expect(getLocalPushNotificationPreferences()).toEqual(['task_pair_audit']);
    expect(postBodies[postBodies.length - 1]).toEqual({ types: ['task_pair_audit'] });
  });
});

describe('push enabled servers preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
  });

  it('defaults enabled servers to null (untouched auto-default) when localStorage is empty', async () => {
    const { getLocalPushEnabledServers } = await import('../src/push-notifications.js');
    expect(getLocalPushEnabledServers()).toBeNull();
  });

  it('fetches both types and enabledServerIds (including null reset) in fetchPushNotificationSettings cleanly', async () => {
    const {
      fetchPushNotificationSettings,
      setLocalPushEnabledServers,
      getLocalPushEnabledServers,
      getLocalPushNotificationPreferences,
    } = await import('../src/push-notifications.js');

    // Stale local cache gets cleared when server returns null (untouched auto-default)
    setLocalPushEnabledServers(['stale-srv']);
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete', 'remote_desktop'],
      enabledServerIds: null,
    });

    const snapshotNull = await fetchPushNotificationSettings();
    expect(snapshotNull).toEqual({
      types: ['task_complete', 'remote_desktop'],
      enabledServerIds: null,
    });
    expect(getLocalPushEnabledServers()).toBeNull();

    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete', 'remote_desktop'],
      enabledServerIds: ['srv-1', 'srv-2'],
    });

    const snapshot = await fetchPushNotificationSettings();
    expect(snapshot).toEqual({
      types: ['task_complete', 'remote_desktop'],
      enabledServerIds: ['srv-1', 'srv-2'],
    });
    expect(getLocalPushNotificationPreferences()).toEqual(['task_complete', 'remote_desktop']);
    expect(getLocalPushEnabledServers()).toEqual(['srv-1', 'srv-2']);
  });

  it('syncs enabledServerIds via POST /api/push/preferences without sending types', async () => {
    const { syncPushEnabledServers, getLocalPushEnabledServers } = await import('../src/push-notifications.js');
    apiFetchMock.mockResolvedValueOnce({ ok: true, enabledServerIds: ['srv-1'] });

    await syncPushEnabledServers([' srv-1 ', '', 'srv-1']);
    expect(getLocalPushEnabledServers()).toEqual(['srv-1']);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/push/preferences', {
      method: 'POST',
      body: JSON.stringify({ enabledServerIds: ['srv-1'] }),
    });
  });

  it('guards enabledServerIds against stale remote read while local edit is dirty', async () => {
    const {
      fetchPushNotificationSettings,
      recordLocalPushEnabledServersEdit,
      getLocalPushEnabledServers,
    } = await import('../src/push-notifications.js');

    let resolveFetch: (val: any) => void;
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

    const pending = fetchPushNotificationSettings();
    recordLocalPushEnabledServersEdit(['srv-2']);

    resolveFetch!({
      ok: true,
      types: ['task_complete'],
      enabledServerIds: ['srv-1'],
    });

    const snapshot = await pending;
    expect(snapshot).toEqual({
      types: ['task_complete'],
      enabledServerIds: undefined,
    });
    expect(getLocalPushEnabledServers()).toEqual(['srv-2']);
  });

  it('commits optimistically, notifies subscribers, and rolls back on API failure without clobbering newer edits', async () => {
    const {
      commitPushEnabledServers,
      subscribePushEnabledServers,
      getLocalPushEnabledServers,
      hasUnsyncedPushEnabledServerEdits,
      resetPushNotificationPreferencesStateForTesting,
    } = await import('../src/push-notifications.js');

    resetPushNotificationPreferencesStateForTesting();
    const seen: Array<string[] | null> = [];
    const unsubscribe = subscribePushEnabledServers((next) => seen.push(next));

    // Failure case: previous null -> attempt [] -> POST fails -> rolls back to null
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    const okFail = await commitPushEnabledServers([], null);
    expect(okFail).toBe(false);
    expect(getLocalPushEnabledServers()).toBeNull();
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);
    expect(seen).toEqual([[], null]);

    // Concurrent case: slow POST 1 fails after POST 2 starts -> rollback of #1 must not overwrite #2
    seen.length = 0;
    let rejectFirst: (err: Error) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ ok: true });

    const first = commitPushEnabledServers(['srv-1'], null);
    await Promise.resolve();
    const second = commitPushEnabledServers(['srv-1', 'srv-2'], ['srv-1']);
    rejectFirst!(new Error('stale failure'));
    const [ok1, ok2] = await Promise.all([first, second]);

    expect(ok1).toBe(false);
    expect(ok2).toBe(true);
    expect(getLocalPushEnabledServers()).toEqual(['srv-1', 'srv-2']);
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);
    expect(seen).toEqual([['srv-1'], ['srv-1', 'srv-2']]);
    unsubscribe();
  });

  it('rolls back concurrent double failures to the last confirmed snapshot instead of unconfirmed optimistic intermediate state', async () => {
    const {
      fetchPushNotificationSettings,
      commitPushEnabledServers,
      subscribePushEnabledServers,
      getLocalPushEnabledServers,
      hasUnsyncedPushEnabledServerEdits,
      resetPushNotificationPreferencesStateForTesting,
    } = await import('../src/push-notifications.js');

    resetPushNotificationPreferencesStateForTesting();
    let remoteServers: string[] | null = [];
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete'],
      enabledServerIds: [...remoteServers],
    });
    await fetchPushNotificationSettings();

    const seen: Array<string[] | null> = [];
    const unsubscribe = subscribePushEnabledServers((next) => seen.push(next));

    let rejectFirst!: (err: Error) => void;
    let rejectSecond!: (err: Error) => void;
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/push/preferences' && init?.method === 'POST') {
        if (!rejectFirst) {
          return new Promise((_, reject) => { rejectFirst = reject; });
        }
        return new Promise((_, reject) => { rejectSecond = reject; });
      }
      return Promise.resolve({ ok: true, types: ['task_complete'], enabledServerIds: [...(remoteServers ?? [])] });
    });

    const first = commitPushEnabledServers(['srv-1'], []);
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    const second = commitPushEnabledServers(['srv-1', 'srv-2'], ['srv-1']);

    rejectFirst(new Error('network A down'));
    await vi.waitFor(() => expect(rejectSecond).toBeTypeOf('function'));
    rejectSecond(new Error('network B down'));

    const [ok1, ok2] = await Promise.all([first, second]);
    expect([ok1, ok2]).toEqual([false, false]);
    expect(remoteServers).toEqual([]);
    expect(getLocalPushEnabledServers()).toEqual([]);
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);
    expect(seen).toEqual([['srv-1'], ['srv-1', 'srv-2'], []]);

    // Clean subsequent GET still hydrates normally (dirty flag was not stuck)
    remoteServers = ['srv-remote'];
    const refreshed = await fetchPushNotificationSettings();
    expect(refreshed?.enabledServerIds).toEqual(['srv-remote']);
    expect(getLocalPushEnabledServers()).toEqual(['srv-remote']);
    unsubscribe();
  });

  it('rolls back first-succeeds-then-second-fails to the first ACKed server snapshot', async () => {
    const {
      fetchPushNotificationSettings,
      commitPushEnabledServers,
      getLocalPushEnabledServers,
      hasUnsyncedPushEnabledServerEdits,
      resetPushNotificationPreferencesStateForTesting,
    } = await import('../src/push-notifications.js');

    resetPushNotificationPreferencesStateForTesting();
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete'],
      enabledServerIds: [],
    });
    await fetchPushNotificationSettings();

    let resolveFirst!: (val: unknown) => void;
    let rejectSecond!: (err: Error) => void;
    let postIndex = 0;
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/push/preferences' && init?.method === 'POST') {
        postIndex++;
        if (postIndex === 1) {
          return new Promise((resolve) => { resolveFirst = resolve; });
        }
        return new Promise((_, reject) => { rejectSecond = reject; });
      }
      return Promise.resolve({ ok: true });
    });

    const first = commitPushEnabledServers(['srv-1'], []);
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    // Overlapping second call passes stale pre-A `[]` as previous; ACK from A must still win!
    const second = commitPushEnabledServers(['srv-1', 'srv-2'], []);

    resolveFirst({ ok: true, enabledServerIds: ['srv-1'] });
    await vi.waitFor(() => expect(rejectSecond).toBeTypeOf('function'));
    rejectSecond(new Error('second POST failed'));

    const [ok1, ok2] = await Promise.all([first, second]);
    expect([ok1, ok2]).toEqual([true, false]);
    expect(getLocalPushEnabledServers()).toEqual(['srv-1']);
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);
  });

  it('handles same-tick coalesced commit success and failure with accurate ACK, local state, and dirty bit', async () => {
    const {
      fetchPushNotificationSettings,
      commitPushEnabledServers,
      getLocalPushEnabledServers,
      hasUnsyncedPushEnabledServerEdits,
      resetPushNotificationPreferencesStateForTesting,
    } = await import('../src/push-notifications.js');

    resetPushNotificationPreferencesStateForTesting();
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      types: ['task_complete'],
      enabledServerIds: [],
    });
    await fetchPushNotificationSettings();

    // Same-tick coalesced failure: single POST fails -> rolls back to confirmed [], not intermediate ['srv-1']
    let postCount = 0;
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/push/preferences' && init?.method === 'POST') {
        postCount++;
        return Promise.reject(new Error('coalesced POST failed'));
      }
      return Promise.resolve({ ok: true });
    });

    const failResults = await Promise.all([
      commitPushEnabledServers(['srv-1'], []),
      commitPushEnabledServers(['srv-1', 'srv-2'], ['srv-1']),
    ]);
    expect(postCount).toBe(1);
    expect(failResults).toEqual([false, false]);
    expect(getLocalPushEnabledServers()).toEqual([]);
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);

    // Same-tick coalesced success: single POST commits ['srv-1', 'srv-2'], clean dirty bit
    postCount = 0;
    const bodies: unknown[] = [];
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/api/push/preferences' && init?.method === 'POST') {
        postCount++;
        bodies.push(JSON.parse(String(init.body ?? '{}')));
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true });
    });

    const okResults = await Promise.all([
      commitPushEnabledServers(['srv-1'], []),
      commitPushEnabledServers(['srv-1', 'srv-2'], ['srv-1']),
    ]);
    expect(postCount).toBe(1);
    expect(bodies).toEqual([{ enabledServerIds: ['srv-1', 'srv-2'] }]);
    expect(okResults).toEqual([true, true]);
    expect(getLocalPushEnabledServers()).toEqual(['srv-1', 'srv-2']);
    expect(hasUnsyncedPushEnabledServerEdits()).toBe(false);
  });
});
