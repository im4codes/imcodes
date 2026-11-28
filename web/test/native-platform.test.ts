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
  getPcAppBridge,
  isDesignedForIpadMac,
  isMobilePhone,
  isNativeMacDesktop,
  isPcAppDesktop,
  isPcAppInlineVoiceSupported,
  isPcAppShellOutdated,
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

describe('native platform detection and uniform UI scaling', () => {
  it('identifies Designed-for-iPad Mac without enabling unbalanced chat-only text inflation', () => {
    expect(isDesignedForIpadMac(env())).toBe(true);
    expect(shouldUseIosMacTextScale(env())).toBe(false);
    expect(IOS_MAC_TERMINAL_FONT_SIZE).toBeGreaterThan(13);
  });

  it('does not treat touch iPadOS as Mac desktop or Designed-for-iPad Mac', () => {
    const ipad = env({
      navigator: {
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
        maxTouchPoints: 5,
      },
    });
    expect(isDesignedForIpadMac(ipad)).toBe(false);
    expect(shouldUseIosMacTextScale(ipad)).toBe(false);
  });

  it('does not mark web mode as native Mac desktop', () => {
    const webEnv = env({
      capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
      },
    });
    expect(isDesignedForIpadMac(webEnv)).toBe(false);
    expect(shouldUseIosMacTextScale(webEnv)).toBe(false);
  });

  it('applies and removes native-mac-desktop while leaving legacy native-ios-mac off', () => {
    const root = document.createElement('html');
    applyNativePlatformClasses(root, env());
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(true);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
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

  it('respects authoritative native host info and avoids double-scaling intermediate pageZoom binaries', () => {
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
    expect(isDesignedForIpadMac(macWithZoom)).toBe(false);
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

    // Apple Silicon Mac running an iPhone-compat iOS build exposes zero touch points and a fine pointer.
    expect(isNativeMacDesktop(env({
      navigator: {
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        maxTouchPoints: 0,
      },
      matchMedia: (q) => ({ matches: q === '(hover: hover) and (pointer: fine)' }),
      innerWidth: 420,
    }))).toBe(true);

    // Real iPhone/touch phone with maxTouchPoints > 1 must still be rejected even if matchMedia lies.
    expect(isNativeMacDesktop(env({
      navigator: {
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        maxTouchPoints: 5,
      },
      matchMedia: (q) => ({ matches: q === '(hover: hover) and (pointer: fine)' }),
      innerWidth: 390,
    }))).toBe(false);
  });

  it('keeps iOS AppDelegate free of WKWebView.pageZoom reads/writes while keeping host signal above Foundation-only OTA helper slice', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const appDelegate = readFileSync(resolve(dir, '../ios/App/App/AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('ProcessInfo.processInfo.isiOSAppOnMac');
    expect(appDelegate).toContain('targetEnvironment(macCatalyst)');
    expect(appDelegate).not.toMatch(/\.pageZoom\b/);
    expect(appDelegate).not.toContain('macDesignedForIpadPageZoom');
    expect(appDelegate).toContain('let pageZoomApplied = false');
    expect(appDelegate).toContain('window.__IMCODES_NATIVE_HOST__');
    expect(appDelegate).toContain("CustomEvent('imcodes:native-host')");
    expect(appDelegate).toContain('pressesBegan');
    expect(appDelegate).toContain('pressesEnded');
    expect(appDelegate).toContain('imcodes:native-modifier-press');
    expect(appDelegate).toContain('"native-1x"');
    expect(appDelegate).toContain('"designed-for-ipad"');
    expect(appDelegate).toContain('"none"');

    const otaStart = appDelegate.indexOf('private static let nativeBundledBuildIdKey');
    expect(otaStart).toBeGreaterThan(0);
    const otaSlice = appDelegate.slice(otaStart);
    expect(otaSlice).not.toContain('UIKit');
    expect(otaSlice).not.toContain('WKWebView');
    expect(otaSlice).not.toContain('UIDevice');
  });

  it('distinguishes native-1x Catalyst .mac, designed-for-ipad Mac shells, and legacy shells', () => {
    const catalystMac = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'native-1x' },
    });
    expect(isNativeMacDesktop(catalystMac)).toBe(true);
    expect(isDesignedForIpadMac(catalystMac)).toBe(false);
    expect(shouldUseIosMacTextScale(catalystMac)).toBe(false);

    // Explicit { isMacDesktop: true, pageZoomApplied: false } without designed-for-ipad mode is treated as 1x.
    const catalystMacImplicit = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false },
    });
    expect(isNativeMacDesktop(catalystMacImplicit)).toBe(true);
    expect(isDesignedForIpadMac(catalystMacImplicit)).toBe(false);
    expect(shouldUseIosMacTextScale(catalystMacImplicit)).toBe(false);
    const root = document.createElement('html');
    applyNativePlatformClasses(root, catalystMacImplicit);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);

    const intermediateZoomShell = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: true, scaleMode: 'native-page-zoom' },
    });
    expect(isNativeMacDesktop(intermediateZoomShell)).toBe(true);
    expect(isDesignedForIpadMac(intermediateZoomShell)).toBe(false);
    expect(shouldUseIosMacTextScale(intermediateZoomShell)).toBe(false);

    const newDesignedForIpadShell = env({
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' },
    });
    expect(isDesignedForIpadMac(newDesignedForIpadShell)).toBe(true);
    expect(shouldUseIosMacTextScale(newDesignedForIpadShell)).toBe(false);
    applyNativePlatformClasses(root, newDesignedForIpadShell);
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(true);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);

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

  it('scopes compact Android mobile sizing rules without CSS zoom and leaves iOS/Mac styles intact', () => {
    const root = document.createElement('html');
    applyNativePlatformClasses(root, {
      capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
      },
      navigator: {
        platform: 'Linux armv8l',
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
        maxTouchPoints: 5,
      },
    });
    expect(root.dataset.nativePlatform).toBe('android');
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(false);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);

    const dir = dirname(fileURLToPath(import.meta.url));
    const styles = readFileSync(resolve(dir, '../src/styles.css'), 'utf8');
    const androidBlockStart = styles.indexOf('html[data-native-platform="android"]');
    expect(androidBlockStart).toBeGreaterThan(-1);
    const androidSection = styles.slice(Math.max(0, androidBlockStart - 120));
    expect(androidSection).toContain('@media (max-width: 420px)');
    expect(androidSection).toContain('--subsession-compact-card-width: 46px;');
    expect(androidSection).toContain('html[data-native-platform="android"] .mobile-server-bar');
    expect(androidSection).toContain('html[data-native-platform="android"] .subcard-bar-mobile .subsession-bar');
    expect(androidSection).toContain('html[data-native-platform="android"] .controls-input');
    expect(androidSection).toContain('html[data-native-platform="android"] .chat-bubble-content');
    expect(androidSection).not.toMatch(/\bzoom\s*:/);
    expect(styles).toContain('html.native-ios-mac {\n  -webkit-text-size-adjust: 115%;\n  text-size-adjust: 115%;\n}');
  });

  it('detects Electron PC App desktop via __IMCODES_PC_APP__ bridge without triggering Capacitor iOS/Mac classes or zoom', () => {
    const pcEnv: NativePlatformEnvironment = {
      capacitor: undefined,
      navigator: {
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/156.0.0.0 Electron/45.3.3 Safari/537.36',
        maxTouchPoints: 0,
      },
      pcApp: {
        platform: 'darwin',
        isElectron: true,
        voice: {
          isNativeSpeechSupported: () => true,
        },
      },
    };
    expect(isPcAppDesktop(pcEnv)).toBe(true);
    expect(isPcAppInlineVoiceSupported(pcEnv)).toBe(true);
    expect(getPcAppBridge(pcEnv)?.platform).toBe('darwin');

    const winPcEnv: NativePlatformEnvironment = {
      capacitor: undefined,
      navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.3.3' },
      pcApp: {
        platform: 'win32',
        isElectron: true,
        voice: { isNativeSpeechSupported: () => false },
      },
    };
    expect(isPcAppDesktop(winPcEnv)).toBe(true);
    expect(isPcAppInlineVoiceSupported(winPcEnv)).toBe(false);
    expect(isNativeMacDesktop(pcEnv)).toBe(false);
    expect(isDesignedForIpadMac(pcEnv)).toBe(false);
    expect(shouldUseIosMacTextScale(pcEnv)).toBe(false);

    const root = document.createElement('html');
    applyNativePlatformClasses(root, pcEnv);
    expect(root.classList.contains(IOS_MAC_DESKTOP_CLASS)).toBe(false);
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
    expect(root.dataset.nativePlatform).toBeUndefined();

    // Normal web browser without __IMCODES_PC_APP__ returns false
    expect(isPcAppDesktop({ navigator: { platform: 'MacIntel', userAgent: 'Safari' } })).toBe(false);
    expect(getPcAppBridge({ navigator: { platform: 'MacIntel' } })).toBeNull();
  });

  it('detects outdated PC App shells lacking revealFile or updater.quitAndInstall without matching browsers or Capacitor mobile', () => {
    expect(isPcAppShellOutdated({
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' },
    })).toBe(false);

    expect(isPcAppShellOutdated({
      capacitor: nativeIos,
      navigator: { platform: 'iPhone', userAgent: 'Mozilla/5.0 Electron/1.0' },
    })).toBe(false);

    expect(isPcAppShellOutdated({
      navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 Electron/45.3.3' },
    })).toBe(true);

    expect(isPcAppShellOutdated({
      pcApp: {
        isElectron: true,
        platform: 'win32',
        downloads: {},
      },
    })).toBe(true);

    expect(isPcAppShellOutdated({
      pcApp: {
        isElectron: true,
        platform: 'win32',
        downloads: { revealFile: async () => true },
      },
    })).toBe(true);

    expect(isPcAppShellOutdated({
      pcApp: {
        isElectron: true,
        platform: 'win32',
        downloads: { revealFile: async () => true },
        updater: { quitAndInstall: async () => true },
      },
    })).toBe(false);
  });

  it('accurately identifies mobile phones while strictly excluding desktop browsers, PC App, Mac Catalyst, Designed-for-iPad Mac, iPads, and tablets', () => {
    // Mobile phones (iPhone, iPod, Android phone)
    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 390,
    })).toBe(true);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 },
      innerWidth: 390,
    })).toBe(true);

    expect(isMobilePhone({
      navigator: { platform: 'iPod', userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 320,
    })).toBe(true);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
      innerWidth: 360,
    })).toBe(true);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 },
      innerWidth: 393,
    })).toBe(true);

    // Desktop browsers (including narrow width)
    expect(isMobilePhone({
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' },
      innerWidth: 1440,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' },
      innerWidth: 360,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0' },
      innerWidth: 1920,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
      innerWidth: 1200,
    })).toBe(false);

    // Electron PC App (even at narrow width)
    expect(isMobilePhone({
      pcApp: { isElectron: true, platform: 'darwin' },
      innerWidth: 1200,
    })).toBe(false);

    expect(isMobilePhone({
      pcApp: { isElectron: true, platform: 'darwin' },
      innerWidth: 360,
    })).toBe(false);

    expect(isMobilePhone({
      pcApp: { isElectron: true, platform: 'win32' },
      innerWidth: 360,
    })).toBe(false);

    // Designed-for-iPad Mac and Mac Catalyst
    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 0 },
      nativeHost: { isMacDesktop: true, scaleMode: 'designed-for-ipad' },
    })).toBe(false);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 0 },
      nativeHost: { isMacDesktop: true, scaleMode: 'native-1x' },
    })).toBe(false);

    // iPad / iPadOS (Safari, desktop-mode, Capacitor)
    expect(isMobilePhone({
      navigator: { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 1024,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1', maxTouchPoints: 5 },
      innerWidth: 1024,
    })).toBe(false);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 834,
    })).toBe(false);

    // Capacitor desktop mode iPad in 500px narrow window must remain false (tablet, not phone)
    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      nativeHost: { isMacDesktop: false },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 5 },
      innerWidth: 500,
    })).toBe(false);

    // Android tablet
    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
      innerWidth: 900,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', maxTouchPoints: 5 },
      innerWidth: 1200,
    })).toBe(false);

    expect(isMobilePhone({
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36', maxTouchPoints: 5 },
    })).toBe(false);

    // Android UA carrying both Tablet and Mobile tokens on 900px tablet must remain false
    expect(isMobilePhone({
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 Mobile Safari/537.36', maxTouchPoints: 5 },
      innerWidth: 900,
    })).toBe(false);

    // Synthetic Capacitor fallback without explicit UA tokens
    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      innerWidth: 375,
    })).toBe(true);

    expect(isMobilePhone({
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      innerWidth: 1024,
    })).toBe(false);
  });
});
