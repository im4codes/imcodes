/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IOS_MAC_DESKTOP_CLASS,
  IOS_MAC_TEXT_SCALE_CLASS,
  IOS_MAC_TERMINAL_FONT_SIZE,
  NATIVE_HOST_EVENT,
  applyNativePlatformClasses,
  isNativeMacDesktop,
  shouldUseIosMacTextScale,
  type NativePlatformEnvironment,
} from '../src/native-platform';

const nativeIos = {
  isNativePlatform: () => true,
  getPlatform: () => 'ios',
};

function env(overrides: Partial<NativePlatformEnvironment> = {}): NativePlatformEnvironment {
  return {
    capacitor: nativeIos,
    navigator: {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      maxTouchPoints: 0,
    },
    innerWidth: 1200,
    ...overrides,
  };
}

describe('native platform text scaling', () => {
  it('enables larger text for the packaged iOS app running on Mac', () => {
    expect(shouldUseIosMacTextScale(env())).toBe(true);
    expect(IOS_MAC_TERMINAL_FONT_SIZE).toBeGreaterThan(13);
  });

  it('does not enable the Mac text scale for touch iPadOS', () => {
    expect(shouldUseIosMacTextScale(env({
      navigator: {
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        maxTouchPoints: 5,
      },
    }))).toBe(false);
  });

  it('does not enable the native-only text scale in web mode', () => {
    expect(shouldUseIosMacTextScale(env({
      capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
      },
    }))).toBe(false);
  });

  it('applies and removes the html marker class from the same contract', () => {
    const root = document.createElement('html');
    applyNativePlatformClasses(root, env());
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(true);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(true);
    expect(root.dataset.nativePlatform).toBe('ios');

    applyNativePlatformClasses(root, env({
      capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
      },
    }));
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(false);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
    expect(root.dataset.nativePlatform).toBeUndefined();
  });

  it('uses authoritative native host info when available and avoids double-scaling under WKWebView pageZoom', () => {
    const macWithZoom = env({
      navigator: {
        platform: 'iPad',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        maxTouchPoints: 0,
      },
      innerWidth: 540,
      nativeHost: { isMacDesktop: true, pageZoomApplied: true },
    });
    expect(isNativeMacDesktop(macWithZoom)).toBe(true);
    expect(shouldUseIosMacTextScale(macWithZoom)).toBe(false);

    const root = document.createElement('html');
    applyNativePlatformClasses(root, macWithZoom);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
    expect(root.dataset.nativePlatform).toBe('ios');
    expect(NATIVE_HOST_EVENT).toBe('imcodes:native-host');
  });

  it('rejects real iPhone/iPad/Android from Mac desktop detection while supporting fine-pointer fallback', () => {
    expect(isNativeMacDesktop(env({
      navigator: {
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        maxTouchPoints: 0,
      },
    }))).toBe(false);

    expect(isNativeMacDesktop(env({
      navigator: {
        platform: 'iPad',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        maxTouchPoints: 5,
      },
      matchMedia: () => ({ matches: true }),
    }))).toBe(false);

    expect(isNativeMacDesktop(env({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    }))).toBe(false);

    expect(isNativeMacDesktop(env({
      navigator: {
        platform: 'iPad',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        maxTouchPoints: 0,
      },
      matchMedia: (q) => ({ matches: q === '(hover: hover) and (pointer: fine)' }),
      innerWidth: 600,
    }))).toBe(true);
  });

  it('keeps iOS AppDelegate Mac pageZoom + host signal above Foundation-only OTA helper slice', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const appDelegate = readFileSync(resolve(dir, '../ios/App/App/AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('ProcessInfo.processInfo.isiOSAppOnMac');
    expect(appDelegate).toContain('targetEnvironment(macCatalyst)');
    expect(appDelegate).toContain('webView.pageZoom = Self.macDesignedForIpadPageZoom');
    expect(appDelegate).toContain('window.__IMCODES_NATIVE_HOST__');
    expect(appDelegate).toContain("CustomEvent('imcodes:native-host')");
    expect(appDelegate).toContain('"native-1x"');
    expect(appDelegate).toContain('"native-page-zoom"');
    expect(appDelegate).toContain('"none"');

    const otaStart = appDelegate.indexOf('private static let nativeBundledBuildIdKey');
    expect(otaStart).toBeGreaterThan(0);
    const otaSlice = appDelegate.slice(otaStart);
    expect(otaSlice).not.toContain('UIKit');
    expect(otaSlice).not.toContain('WKWebView');
    expect(otaSlice).not.toContain('UIDevice');
  });

  it('distinguishes native-1x Catalyst .mac, native-page-zoom iOS-on-Mac, and legacy shell fallback', () => {
    const catalystMac = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'native-1x' },
    });
    expect(isNativeMacDesktop(catalystMac)).toBe(true);
    expect(shouldUseIosMacTextScale(catalystMac)).toBe(false);

    // Even when a host omits scaleMode and sends { isMacDesktop: true, pageZoomApplied: false },
    // the authoritative Mac host does not want legacy CSS double-scaling.
    const catalystMacImplicit = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false },
    });
    expect(isNativeMacDesktop(catalystMacImplicit)).toBe(true);
    expect(shouldUseIosMacTextScale(catalystMacImplicit)).toBe(false);
    const root = document.createElement('html');
    applyNativePlatformClasses(root, catalystMacImplicit);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);

    const designedForIpadZoom = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: true, scaleMode: 'native-page-zoom' },
    });
    expect(isNativeMacDesktop(designedForIpadZoom)).toBe(true);
    expect(shouldUseIosMacTextScale(designedForIpadZoom)).toBe(false);

    const explicitLegacy = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'legacy-css' },
    });
    expect(shouldUseIosMacTextScale(explicitLegacy)).toBe(true);
    applyNativePlatformClasses(root, explicitLegacy);
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(true);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(true);

    // Real iPadOS / iOS must never receive native-mac-desktop or native-ios-mac.
    const realIpad = env({
      navigator: {
        platform: 'iPad',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        maxTouchPoints: 5,
      },
      matchMedia: () => ({ matches: true }),
    });
    applyNativePlatformClasses(root, realIpad);
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(false);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
  });

  it('sets #080d16 host, rootVC, webView, scrollView, and underPageBackgroundColor under isiOSAppOnMac', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const appDelegate = readFileSync(resolve(dir, '../ios/App/App/AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('macHostBackgroundColor');
    expect(appDelegate).toContain('8.0 / 255.0');
    expect(appDelegate).toContain('13.0 / 255.0');
    expect(appDelegate).toContain('22.0 / 255.0');
    expect(appDelegate).toContain('configureMacHostAppearance');
    expect(appDelegate).toContain('window?.backgroundColor = bg');
    expect(appDelegate).toContain('rootVC.view.backgroundColor = bg');
    expect(appDelegate).toContain('targetWebView.backgroundColor = bg');
    expect(appDelegate).toContain('targetWebView.scrollView.backgroundColor = bg');
    expect(appDelegate).toContain('targetWebView.underPageBackgroundColor = bg');
    expect(appDelegate).toContain('applicationWillEnterForeground');
  });
});
