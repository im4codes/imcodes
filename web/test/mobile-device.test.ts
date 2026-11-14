import { describe, expect, it, vi } from 'vitest';
import { isMobileDevice, isMobileLayout, subscribeDeviceLayoutChange } from '../src/mobile-device.js';
import { NATIVE_HOST_EVENT } from '../src/native-platform.js';

describe('shared mobile layout detection', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 390, false, 5],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', 412, false, 5],
    ['iPadOS desktop UA', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 1024, false, 5],
    ['desktop site on phone', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36', 390, false, 0],
    ['native Capacitor', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 1280, true, 0],
  ])('%s is mobile', (_label, userAgent, width, native, maxTouchPoints) => {
    expect(isMobileLayout({ userAgent, width, native, maxTouchPoints, pointerCoarse: width <= 720 })).toBe(true);
  });

  it('treats an iPadOS desktop UA as mobile but a real desktop as desktop', () => {
    expect(isMobileLayout({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
      width: 1280,
      maxTouchPoints: 5,
      pointerCoarse: false,
    })).toBe(true);
    expect(isMobileLayout({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
      width: 1280,
      maxTouchPoints: 0,
      pointerCoarse: false,
    })).toBe(false);
  });

  it('recognizes a touch device independently of viewport width', () => {
    expect(isMobileLayout({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 800, pointerCoarse: true, maxTouchPoints: 1 })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 1280, pointerCoarse: true, maxTouchPoints: 1 })).toBe(true);
  });

  it('keeps a narrow fine-pointer desktop in the desktop app shell', () => {
    const desktop = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 600, pointerCoarse: false, maxTouchPoints: 0 };
    expect(isMobileDevice(desktop)).toBe(false);
    expect(isMobileLayout(desktop)).toBe(true);
  });

  it('recognizes desktop-site phones through touch without using width', () => {
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 1024, pointerCoarse: true, maxTouchPoints: 5 })).toBe(true);
  });

  it('keeps Capacitor iOS running on macOS in the desktop shell while keeping real iOS/Android mobile', () => {
    // Mac Designed-for-iPad with Swift nativeHost signal (even if WebKit reports iPad UA and narrow width)
    const macAppNarrow = {
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      native: true,
      nativePlatform: 'ios',
      platform: 'iPad',
      maxTouchPoints: 0,
      width: 600,
      nativeHost: { isMacDesktop: true, pageZoomApplied: true },
    };
    expect(isMobileDevice(macAppNarrow)).toBe(false);
    expect(isMobileLayout(macAppNarrow)).toBe(true);
    expect(isMobileLayout({ ...macAppNarrow, width: 1280 })).toBe(false);

    // Mac Designed-for-iPad fallback without nativeHost global (older native binary / MacIntel)
    expect(isMobileDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      native: true,
      nativePlatform: 'ios',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      width: 1280,
    })).toBe(false);

    // Real iPhone & real iPad (including desktop UA & trackpad) stay mobile
    expect(isMobileDevice({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      native: true,
      nativePlatform: 'ios',
      platform: 'iPhone',
      maxTouchPoints: 5,
      width: 390,
      nativeHost: { isMacDesktop: false, pageZoomApplied: false },
    })).toBe(true);

    expect(isMobileDevice({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
      native: true,
      nativePlatform: 'ios',
      platform: 'MacIntel',
      maxTouchPoints: 5,
      hoverFinePointer: true,
      width: 1180,
    })).toBe(true);

    // Android native stays mobile
    expect(isMobileDevice({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
      native: true,
      nativePlatform: 'android',
      platform: 'Linux armv8l',
      maxTouchPoints: 5,
      width: 1080,
    })).toBe(true);
  });

  it('subscribes to native-host, pointer media queries, and optional resize with full cleanup', () => {
    const mqListeners = new Map<string, Set<() => void>>();
    const origMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: (_ev: string, fn: () => void) => {
          const set = mqListeners.get(query) ?? new Set<() => void>();
          set.add(fn);
          mqListeners.set(query, set);
        },
        removeEventListener: (_ev: string, fn: () => void) => {
          mqListeners.get(query)?.delete(fn);
        },
      }),
    });

    try {
      const fullListener = vi.fn();
      const unsubFull = subscribeDeviceLayoutChange(fullListener);
      window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      window.dispatchEvent(new Event('resize'));
      mqListeners.get('(hover: hover) and (pointer: fine)')?.forEach((fn) => fn());
      mqListeners.get('(pointer: coarse)')?.forEach((fn) => fn());
      mqListeners.get('(max-width: 720px)')?.forEach((fn) => fn());
      expect(fullListener).toHaveBeenCalledTimes(5);

      unsubFull();
      window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      window.dispatchEvent(new Event('resize'));
      expect(fullListener).toHaveBeenCalledTimes(5);

      const noResizeListener = vi.fn();
      const unsubNoResize = subscribeDeviceLayoutChange(noResizeListener, { includeResize: false });
      window.dispatchEvent(new Event('resize'));
      expect(noResizeListener).not.toHaveBeenCalled();
      window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      expect(noResizeListener).toHaveBeenCalledTimes(1);
      unsubNoResize();

      // Missing matchMedia still subscribes to native-host without throwing
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
      const fallbackListener = vi.fn();
      const unsubFallback = subscribeDeviceLayoutChange(fallbackListener);
      window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      expect(fallbackListener).toHaveBeenCalledTimes(1);
      unsubFallback();
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: origMatchMedia });
    }
  });
});
