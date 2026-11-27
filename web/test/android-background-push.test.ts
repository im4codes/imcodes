/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushPluginSpy } = vi.hoisted(() => ({
  pushPluginSpy: vi.fn(),
}));

vi.mock('@capacitor/push-notifications', () => {
  pushPluginSpy();
  return {
    PushNotifications: {
      addListener: vi.fn(),
      checkPermissions: vi.fn(),
      register: vi.fn(),
      requestPermissions: vi.fn(),
    },
  };
});

describe('Android withoutFcm native BackgroundPush integration', () => {
  let listeners: Record<string, (payload: Record<string, unknown>) => void>;
  let currentStatus: {
    supported: boolean;
    hasFcm: boolean;
    enabled: boolean;
    running: boolean;
    connectionState: 'disabled' | 'stopped' | 'connecting' | 'connected' | 'waiting_network' | 'auth_error';
    notificationsGranted: boolean;
    batteryOptimizationIgnored: boolean;
  };
  let pluginMock: {
    getStatus: ReturnType<typeof vi.fn>;
    requestNotificationPermission: ReturnType<typeof vi.fn>;
    requestIgnoreBatteryOptimizations: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    consumePendingNotification: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    pushPluginSpy.mockReset();
    listeners = {};
    currentStatus = {
      supported: true,
      hasFcm: false,
      enabled: false,
      running: false,
      connectionState: 'stopped',
      notificationsGranted: false,
      batteryOptimizationIgnored: false,
    };
    pluginMock = {
      getStatus: vi.fn(async () => ({ ...currentStatus })),
      requestNotificationPermission: vi.fn(async () => {
        currentStatus.notificationsGranted = true;
        return { supported: true, granted: true };
      }),
      requestIgnoreBatteryOptimizations: vi.fn(async () => {
        currentStatus.batteryOptimizationIgnored = true;
        return { supported: true, granted: true };
      }),
      start: vi.fn(async () => {
        currentStatus.enabled = true;
        currentStatus.running = true;
        currentStatus.connectionState = 'connected';
        return { supported: true, started: true };
      }),
      stop: vi.fn(async () => {
        currentStatus.enabled = false;
        currentStatus.running = false;
        currentStatus.connectionState = 'stopped';
        return { supported: true, stopped: true };
      }),
      consumePendingNotification: vi.fn(async () => ({ notification: null })),
      addListener: vi.fn(async (eventName: string, handler: (payload: Record<string, unknown>) => void) => {
        listeners[eventName] = handler;
        return { remove: async () => {} };
      }),
    };

    (globalThis as Record<string, unknown>).__PUSH_FCM__ = false;
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        BackgroundPush: pluginMock,
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__PUSH_FCM__;
    delete (globalThis as Record<string, unknown>).Capacitor;
  });

  it('requests notification permission and starts BackgroundPush on withoutFcm without touching @capacitor/push-notifications', async () => {
    const {
      initPushNotifications,
      isPushSupported,
      stopAndroidBackgroundPushOnLogout,
      disableAndroidBackgroundPush,
      enableAndroidBackgroundPush,
      requestAndroidBatteryOptimizationExemption,
      resetAndroidBackgroundPushStateForTesting,
    } = await import('../src/push-notifications.js');
    resetAndroidBackgroundPushStateForTesting();

    await initPushNotifications('api-key-android', 'https://selfhosted.example.com');

    expect(pushPluginSpy).not.toHaveBeenCalled();
    expect(pluginMock.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(pluginMock.start).toHaveBeenCalledWith({
      serverUrl: 'https://selfhosted.example.com',
      apiKey: 'api-key-android',
    });
    expect(isPushSupported()).toBe(true);

    const batteryStatus = await requestAndroidBatteryOptimizationExemption();
    expect(pluginMock.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    expect(batteryStatus?.batteryOptimizationIgnored).toBe(true);

    const disabledStatus = await disableAndroidBackgroundPush();
    expect(pluginMock.stop).toHaveBeenCalledTimes(1);
    expect(disabledStatus?.enabled).toBe(false);

    const reEnabledStatus = await enableAndroidBackgroundPush({
      apiKey: 'api-key-android',
      serverUrl: 'https://selfhosted.example.com',
    });
    expect(reEnabledStatus?.enabled).toBe(true);
    expect(reEnabledStatus?.running).toBe(true);

    await stopAndroidBackgroundPushOnLogout();
    expect(pluginMock.stop).toHaveBeenCalledTimes(2);
    expect(isPushSupported()).toBe(false);
  });

  it('handles both cold-launch pending notifications and warm notification tap events', async () => {
    pluginMock.consumePendingNotification.mockResolvedValueOnce({
      notification: { serverId: 'srv-cold', session: 'deck_cold_brain' },
    });

    const events: Array<Record<string, unknown>> = [];
    const onNav = (ev: Event) => {
      events.push((ev as CustomEvent).detail as Record<string, unknown>);
    };
    window.addEventListener('deck:navigate', onNav);

    try {
      const { initPushNotifications, resetAndroidBackgroundPushStateForTesting } = await import('../src/push-notifications.js');
      resetAndroidBackgroundPushStateForTesting();

      await initPushNotifications('api-key-android', 'https://app.im.codes');

      expect(events).toContainEqual({ serverId: 'srv-cold', session: 'deck_cold_brain' });

      listeners.backgroundPushActionPerformed?.({
        serverId: 'srv-warm',
        session: 'deck_warm_sub',
      });
      expect(events).toContainEqual({ serverId: 'srv-warm', session: 'deck_warm_sub' });
    } finally {
      window.removeEventListener('deck:navigate', onNav);
    }
  });

  it('stays completely disabled on withFcm builds', async () => {
    (globalThis as Record<string, unknown>).__PUSH_FCM__ = true;
    const {
      isAndroidBackgroundPushSupportedBuild,
      getAndroidBackgroundPushStatus,
      enableAndroidBackgroundPush,
      resetAndroidBackgroundPushStateForTesting,
    } = await import('../src/push-notifications.js');
    resetAndroidBackgroundPushStateForTesting();

    expect(isAndroidBackgroundPushSupportedBuild()).toBe(false);
    expect(await getAndroidBackgroundPushStatus()).toBeNull();
    expect(await enableAndroidBackgroundPush()).toBeNull();
    expect(pluginMock.start).not.toHaveBeenCalled();
  });

  it('P0-3: fences stale deferred permissions, avoids mixing partial credential pairs, and refuses start after logout/server-switch', async () => {
    let resolvePerm!: (val: { supported: boolean; granted: boolean }) => void;
    pluginMock.requestNotificationPermission.mockImplementationOnce(
      () => new Promise<{ supported: boolean; granted: boolean }>((r) => {
        resolvePerm = r;
      }),
    );

    const {
      initPushNotifications,
      stopAndroidBackgroundPushOnLogout,
      enableAndroidBackgroundPush,
      resetAndroidBackgroundPushStateForTesting,
    } = await import('../src/push-notifications.js');
    resetAndroidBackgroundPushStateForTesting();

    // Start init while permission prompt stays open
    const initPromise = initPushNotifications('old-key-a', 'https://server-a.example.com');
    await vi.waitFor(() => expect(pluginMock.requestNotificationPermission).toHaveBeenCalledTimes(1));

    // User logs out or switches server before permission prompt finishes
    await stopAndroidBackgroundPushOnLogout();
    expect(pluginMock.stop).toHaveBeenCalledTimes(1);

    // Deferred permission finally resolves -> MUST NOT call start with old credentials
    currentStatus.notificationsGranted = true;
    resolvePerm({ supported: true, granted: true });
    await initPromise;
    expect(pluginMock.start).not.toHaveBeenCalled();

    // User toggles switch on Server B picker before logging in (no credentials): MUST NOT start old credentials
    await enableAndroidBackgroundPush();
    expect(pluginMock.start).not.toHaveBeenCalled();

    // Partial credential update (Server B URL without Server B key) MUST NOT combine with stale key A
    await initPushNotifications('key-a', 'https://server-a.example.com');
    pluginMock.start.mockClear();
    await enableAndroidBackgroundPush({ serverUrl: 'https://server-b.example.com' });
    expect(pluginMock.start).not.toHaveBeenCalled();
  });

  it('P0-4: rejects non-loopback HTTP URLs and embedded userinfo at JS boundary', async () => {
    const { normalizeAndroidBgServerUrl, initPushNotifications, resetAndroidBackgroundPushStateForTesting } = await import('../src/push-notifications.js');
    resetAndroidBackgroundPushStateForTesting();

    expect(normalizeAndroidBgServerUrl('https://app.im.codes/')).toBe('https://app.im.codes');
    expect(normalizeAndroidBgServerUrl('http://remote.example.com')).toBeNull();
    expect(normalizeAndroidBgServerUrl('https://user:secret@app.im.codes')).toBeNull();

    await initPushNotifications('api-key', 'http://remote.example.com');
    expect(pluginMock.start).not.toHaveBeenCalled();
  });

  it('P0-2: sends client.presence foreground=false/true over open WebSocket on notifyBackgrounded/notifyForegrounded', async () => {
    const sentPayloads: string[] = [];
    const mockWsInstance = {
      readyState: 1,
      send: vi.fn((data: string) => sentPayloads.push(data)),
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1;
      constructor() {
        return mockWsInstance as never;
      }
    });

    try {
      const { WsClient } = await import('../src/ws-client.js');
      const client = new WsClient('https://app.im.codes', 'srv-1');
      (client as any).ws = mockWsInstance;
      (client as any)._connected = true;

      client.notifyBackgrounded();
      client.notifyForegrounded();

      expect(sentPayloads.map((p) => JSON.parse(p))).toEqual([
        { type: 'client.presence', foreground: false },
        { type: 'client.presence', foreground: true },
      ]);
      expect(mockWsInstance.close).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
