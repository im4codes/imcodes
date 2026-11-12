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
});
