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
