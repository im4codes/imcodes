import { describe, expect, it } from 'vitest';
import { isMobileLayout } from '../src/mobile-device.js';

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

  it('recognizes a coarse touch device up to the medium breakpoint', () => {
    expect(isMobileLayout({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 800, pointerCoarse: true, maxTouchPoints: 1 })).toBe(true);
    expect(isMobileLayout({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', width: 1280, pointerCoarse: true, maxTouchPoints: 1 })).toBe(false);
  });
});
