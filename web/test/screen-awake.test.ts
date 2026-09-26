/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { plugin } = vi.hoisted(() => ({
  plugin: { keepAwake: vi.fn(), allowSleep: vi.fn() },
}));

vi.mock('@capacitor-community/keep-awake', () => ({ KeepAwake: plugin }));

import { holdScreenAwake } from '../src/screen-awake.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function stubWakeLock() {
  const sentinel = { release: vi.fn(async () => undefined) };
  const request = vi.fn(async () => sentinel);
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
  return { request, sentinel };
}

beforeEach(() => {
  plugin.keepAwake.mockReset().mockResolvedValue(undefined);
  plugin.allowSleep.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete (globalThis as any).Capacitor;
  delete (navigator as any).wakeLock;
});

describe('holdScreenAwake', () => {
  it('uses the native plugin in the app and lets the screen sleep on release', async () => {
    (globalThis as any).Capacitor = { isNativePlatform: () => true };
    const { request } = stubWakeLock();
    const release = holdScreenAwake();
    await flush();
    expect(plugin.keepAwake).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    release();
    expect(plugin.allowSleep).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Screen Wake Lock when an older app binary lacks the plugin', async () => {
    (globalThis as any).Capacitor = { isNativePlatform: () => true };
    plugin.keepAwake.mockRejectedValue(new Error('"KeepAwake" plugin is not implemented on ios'));
    const { request, sentinel } = stubWakeLock();
    const release = holdScreenAwake();
    await flush();
    expect(request).toHaveBeenCalledWith('screen');
    release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(plugin.allowSleep).not.toHaveBeenCalled();
  });

  it('uses the Screen Wake Lock in browsers and re-acquires it when the page is visible again', async () => {
    const { request } = stubWakeLock();
    const release = holdScreenAwake();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    release();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without any wake-lock support', () => {
    expect(() => holdScreenAwake()()).not.toThrow();
  });
});
