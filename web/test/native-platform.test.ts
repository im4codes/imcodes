/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  IOS_MAC_TEXT_SCALE_CLASS,
  IOS_MAC_TERMINAL_FONT_SIZE,
  applyNativePlatformClasses,
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
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(true);
    expect(root.dataset.nativePlatform).toBe('ios');

    applyNativePlatformClasses(root, env({
      capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
      },
    }));
    expect(root.classList.contains(IOS_MAC_TEXT_SCALE_CLASS)).toBe(false);
    expect(root.dataset.nativePlatform).toBeUndefined();
  });
});
