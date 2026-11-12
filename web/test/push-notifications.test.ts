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
