/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

describe('push notification badge reset', () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockResolvedValue({ ok: true });
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
    };
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
