/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const termMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    scrollToBottom: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  }>,
  fitCalls: 0,
}));

const i18nMock = vi.hoisted(() => ({
  translations: {} as Record<string, string>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => i18nMock.translations[key] ?? options?.defaultValue ?? key,
  }),
}));

vi.mock('xterm', () => {
  class MockTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
    loadAddon = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    write = vi.fn((_data: unknown, cb?: () => void) => cb?.());
    scrollToBottom = vi.fn();
    clear = vi.fn();
    focus = vi.fn();
    refresh = vi.fn();

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      termMockState.instances.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn(() => {
      termMockState.fitCalls += 1;
    });
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

import {
  applyUiScale,
  clampUiScale,
  DEFAULT_UI_SCALE,
  DESIGNED_FOR_IPAD_DEFAULT_UI_SCALE,
  MOBILE_PHONE_DEFAULT_UI_SCALE,
  formatUiScale,
  getActiveCssZoom,
  getDefaultUiScale,
  getDomRectToLayoutScale,
  initUiScale,
  markUiScalePrompted,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  readUiScale,
  resolveEffectiveUiZoom,
  resolveShrinkZoom,
  shouldShowUiScaleOnboardingPrompt,
  UI_SCALE_PROMPTED_STORAGE_KEY,
  UI_SCALE_SHRINK_ZOOM_VAR,
  UI_SCALE_STORAGE_KEY,
  UI_SCALE_ZOOM_VAR,
  writeUiScale,
} from '../src/ui-scale.js';
import {
  DEFAULT_GLOBAL_FONT_DELTA,
  GLOBAL_FONT_DELTA_STORAGE_KEY,
  GLOBAL_FONT_DELTA_VAR,
  readGlobalFontDelta,
} from '../src/global-font.js';
import { boundedVisualViewportHeight } from '../src/visual-viewport.js';
import { DEFAULT_CHAT_FONT, FontPrefsDropdown, useFontPrefs } from '../src/components/FontPrefsDropdown.js';
import { UiScaleOnboardingCard } from '../src/components/UiScaleOnboardingCard.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { TerminalView } from '../src/components/TerminalView.js';
import { NATIVE_HOST_EVENT, type NativePlatformEnvironment } from '../src/native-platform.js';

const originalNavigatorUserAgent = navigator.userAgent;
const originalNavigatorPlatform = navigator.platform;
const originalMaxTouchPoints = navigator.maxTouchPoints;
const originalInnerWidth = window.innerWidth;

function setGlobalRuntime(overrides: {
  isNative?: boolean;
  platform?: string;
  navigatorPlatform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  innerWidth?: number;
  nativeHost?: Record<string, unknown>;
} = {}): void {
  const g = globalThis as Record<string, unknown>;
  if (overrides.isNative) {
    g.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => overrides.platform ?? 'ios',
    };
  } else {
    delete g.Capacitor;
  }
  g.__IMCODES_NATIVE_HOST__ = overrides.nativeHost;
  Object.defineProperty(navigator, 'platform', {
    value: overrides.navigatorPlatform ?? originalNavigatorPlatform,
    configurable: true,
  });
  Object.defineProperty(navigator, 'userAgent', {
    value: overrides.userAgent ?? originalNavigatorUserAgent,
    configurable: true,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: overrides.maxTouchPoints ?? originalMaxTouchPoints,
    configurable: true,
  });
  Object.defineProperty(window, 'innerWidth', {
    value: overrides.innerWidth ?? originalInnerWidth,
    configurable: true,
  });
}

describe('whole-page UI scale (%) setting & onboarding', () => {
  beforeEach(() => {
    localStorage.clear();
    i18nMock.translations = {};
    termMockState.instances = [];
    termMockState.fitCalls = 0;
    document.documentElement.style.cssText = '';
    setGlobalRuntime();
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.style.cssText = '';
    setGlobalRuntime();
  });

  it('defaults to 125% on Designed-for-iPad Mac (old OTA and new native shells) and 100% elsewhere', () => {
    const legacyOtaMac: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 0 },
      innerWidth: 1200,
    };
    const newNativeDesignedForIpad: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 0 },
      innerWidth: 1024,
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' },
    };
    const catalystMac: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', maxTouchPoints: 0 },
      innerWidth: 1200,
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'native-1x' },
    };
    const intermediateNativePageZoom: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'MacIntel', maxTouchPoints: 0 },
      nativeHost: { isMacDesktop: true, pageZoomApplied: true, scaleMode: 'native-page-zoom' },
    };
    const androidPhone: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
      innerWidth: 360,
    };
    const desktopBrowser: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130.0', maxTouchPoints: 0 },
      innerWidth: 1280,
    };

    expect(getDefaultUiScale(legacyOtaMac)).toBe(DESIGNED_FOR_IPAD_DEFAULT_UI_SCALE);
    expect(readUiScale(legacyOtaMac)).toBe(125);
    expect(getDefaultUiScale(newNativeDesignedForIpad)).toBe(125);
    expect(readUiScale(newNativeDesignedForIpad)).toBe(125);

    expect(getDefaultUiScale(catalystMac)).toBe(DEFAULT_UI_SCALE);
    expect(getDefaultUiScale(intermediateNativePageZoom)).toBe(100);
    expect(getDefaultUiScale(androidPhone)).toBe(MOBILE_PHONE_DEFAULT_UI_SCALE);
    expect(readUiScale(androidPhone)).toBe(95);
    expect(getDefaultUiScale(desktopBrowser)).toBe(100);
  });

  it('defaults to 95% on mobile phones when unset, auto-applies on init without fake localStorage, and strictly honors manual user preferences', () => {
    const iphoneCapacitor: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      navigator: { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 390,
    };
    const iphoneSafari: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 },
      innerWidth: 390,
    };
    const androidCapacitor: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
      innerWidth: 360,
    };
    const androidChrome: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 },
      innerWidth: 393,
    };

    // 1. Defaults to 95% on all phones when imcodes_uiScale is unset
    expect(getDefaultUiScale(iphoneCapacitor)).toBe(95);
    expect(readUiScale(iphoneCapacitor)).toBe(95);
    expect(getDefaultUiScale(iphoneSafari)).toBe(95);
    expect(readUiScale(iphoneSafari)).toBe(95);
    expect(getDefaultUiScale(androidCapacitor)).toBe(95);
    expect(readUiScale(androidCapacitor)).toBe(95);
    expect(getDefaultUiScale(androidChrome)).toBe(95);
    expect(readUiScale(androidChrome)).toBe(95);

    // 2. initUiScale on fresh phone install auto-applies 95% without setting localStorage
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      navigatorPlatform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      maxTouchPoints: 5,
      innerWidth: 390,
    });
    localStorage.clear();
    const appliedScale = initUiScale();
    expect(appliedScale).toBe(95);
    expect(getActiveCssZoom()).toBe(0.95);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.95');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('0.95');
    // Does NOT write fake localStorage preference, preserving onboarding prompt detection
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull();
    expect(shouldShowUiScaleOnboardingPrompt()).toBe(true);

    // 3. User manual settings (e.g. 100, 85, 110) on phone are strictly honored
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '100');
    expect(readUiScale(iphoneCapacitor)).toBe(100);
    expect(initUiScale()).toBe(100);
    expect(getActiveCssZoom()).toBe(1);

    localStorage.setItem(UI_SCALE_STORAGE_KEY, '85');
    expect(readUiScale(iphoneCapacitor)).toBe(85);
    expect(initUiScale()).toBe(85);
    expect(getActiveCssZoom()).toBe(0.85);

    localStorage.setItem(UI_SCALE_STORAGE_KEY, '110');
    expect(readUiScale(androidCapacitor)).toBe(110);
    expect(initUiScale()).toBe(110);
    expect(getActiveCssZoom()).toBe(1.1);

    // 4. Reset on phone restores default 95%
    localStorage.removeItem(UI_SCALE_STORAGE_KEY);
    expect(readUiScale(iphoneCapacitor)).toBe(95);

    // 5. Non-phones remain strictly unchanged
    const desktopBrowserNarrow: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130.0', maxTouchPoints: 0 },
      innerWidth: 360,
    };
    const pcAppNarrow: NativePlatformEnvironment = {
      pcApp: { isElectron: true, platform: 'darwin' },
      navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Electron/30.0', maxTouchPoints: 0 },
      innerWidth: 360,
    };
    const ipad: NativePlatformEnvironment = {
      navigator: { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
      innerWidth: 1024,
    };
    const androidTablet: NativePlatformEnvironment = {
      capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
      navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 },
      innerWidth: 900,
    };
    expect(getDefaultUiScale(desktopBrowserNarrow)).toBe(100);
    expect(getDefaultUiScale(pcAppNarrow)).toBe(100);
    expect(getDefaultUiScale(ipad)).toBe(100);
    expect(getDefaultUiScale(androidTablet)).toBe(100);
  });

  it('strictly falls back to platform default on corrupt, out-of-range, or blocked localStorage', () => {
    expect(clampUiScale(50)).toBe(MIN_UI_SCALE);
    expect(clampUiScale(180)).toBe(MAX_UI_SCALE);
    expect(formatUiScale(75)).toBe('75%');
    expect(resolveEffectiveUiZoom(125)).toBe(1.25);

    for (const invalid of ['', 'NaN', 'abc', '0', '59', '151', '999', '-10']) {
      localStorage.setItem(UI_SCALE_STORAGE_KEY, invalid);
      expect(readUiScale()).toBe(DEFAULT_UI_SCALE);
    }

    localStorage.setItem(UI_SCALE_STORAGE_KEY, '75');
    expect(readUiScale()).toBe(75);
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '150');
    expect(readUiScale()).toBe(150);

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
    expect(readUiScale()).toBe(DEFAULT_UI_SCALE);
  });

  it('applies CSS zoom and --imcodes-ui-zoom without double-zooming or mutating globalFontDelta', () => {
    applyUiScale(100);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('');
    expect(getActiveCssZoom()).toBe(1);
    expect(resolveShrinkZoom(100)).toBe(1);

    writeUiScale(60);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('0.6');
    expect(resolveShrinkZoom(60)).toBe(0.6);

    writeUiScale(75);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.75');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('0.75');
    expect(resolveShrinkZoom(75)).toBe(0.75);
    expect(getActiveCssZoom()).toBe(0.75);
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('75');
    expect(readGlobalFontDelta()).toBe(DEFAULT_GLOBAL_FONT_DELTA);
    expect(localStorage.getItem(GLOBAL_FONT_DELTA_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('');

    writeUiScale(95);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('0.95');
    expect(resolveShrinkZoom(95)).toBe(0.95);

    writeUiScale(125);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('1.25');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('');
    expect(resolveShrinkZoom(125)).toBe(1);
    expect(getActiveCssZoom()).toBe(1.25);

    writeUiScale(150);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('');
    expect(resolveShrinkZoom(150)).toBe(1);

    // Physical viewport height normalizes zoomed documentElement.clientHeight across 60%..150% while --vvh divides by zoom
    for (const pct of [60, 90, 100, 125, 130, 150]) {
      writeUiScale(pct);
      const z = getActiveCssZoom();
      Object.defineProperty(document.documentElement, 'clientHeight', { value: Math.round(780 / z), configurable: true });
      expect(boundedVisualViewportHeight(780, 780, document.documentElement.clientHeight, z)).toBe(780);
      expect(boundedVisualViewportHeight(460, 780, document.documentElement.clientHeight, z)).toBe(460);
    }
    writeUiScale(130);
    expect(Math.round(780 / getActiveCssZoom())).toBe(600);
  });

  it('provides non-dvh fallback in :root and clamps FontPrefsDropdown within zoomed narrow viewports', () => {
    const cssPath = existsSync(resolve(process.cwd(), 'src/styles.css'))
      ? resolve(process.cwd(), 'src/styles.css')
      : resolve(process.cwd(), 'web/src/styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const rootRule = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rootRule).toContain('--imcodes-ui-zoom-shrink: 1;');
    expect(rootRule).toContain('--imcodes-ui-vw: calc(100vw / var(--imcodes-ui-zoom, 1));');
    expect(rootRule).toContain('--imcodes-ui-vh: calc(100vh / var(--imcodes-ui-zoom, 1));');
    expect(rootRule).toContain('--imcodes-ui-dvh: calc(100vh / var(--imcodes-ui-zoom, 1));');
    expect(css).toMatch(/@supports\s*\(height:\s*100dvh\)\s*\{\s*:root\s*\{\s*--imcodes-ui-dvh:\s*calc\(100dvh\s*\/\s*var\(--imcodes-ui-zoom,\s*1\)\);/);

    writeUiScale(150);
    Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
    vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 780, width: 360, height: 780, toJSON: () => ({}),
    });
    function NarrowFontHarness() {
      const [prefs, updatePrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
      return <FontPrefsDropdown prefs={prefs} onChange={updatePrefs} />;
    }
    render(<NarrowFontHarness />);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === document.documentElement) {
        return { x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 780, width: 360, height: 780, toJSON: () => ({}) };
      }
      if (this.getAttribute('data-testid') === 'font-prefs-popover') {
        // Simulate trigger at x=300 on 360px screen with 336px rendered popover width -> overflows right by 276px
        return { x: 300, y: 40, left: 300, top: 40, right: 636, bottom: 320, width: 336, height: 280, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    const pop = screen.getByTestId('font-prefs-popover');
    expect(Number.parseFloat(pop.style.left)).toBeLessThan(0);
    expect(pop.style.maxHeight).toBe('calc(var(--vvh, var(--imcodes-ui-dvh)) - 56px)');
  });

  it('syncs UI Scale (%) across FontPrefsDropdown, SettingsPage, storage events, and Reset without breaking globalFontDelta', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

    function Harness() {
      const [prefs, updatePrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
      return (
        <>
          <FontPrefsDropdown prefs={prefs} onChange={updatePrefs} />
          <SettingsPage
            displayName="K"
            username="k"
            hasPassword={true}
            onBack={() => {}}
            onDisplayNameChanged={() => {}}
            onUserAuthUpdated={() => {}}
          />
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('100%');

    const decButtons = screen.getAllByRole('button', { name: 'Decrease UI scale' });
    const incButtons = screen.getAllByRole('button', { name: 'Increase UI scale' });

    // Decrease from Aa popover down to 90%
    fireEvent.click(decButtons[0]);
    fireEvent.click(decButtons[0]);
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('90%');
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('90%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.9');

    // Increase from SettingsPage up to 105%
    fireEvent.click(incButtons[1]);
    fireEvent.click(incButtons[1]);
    fireEvent.click(incButtons[1]);
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('105%');
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('105%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('1.05');

    // Storage sync across tabs updates readouts and CSS zoom
    act(() => {
      localStorage.setItem(UI_SCALE_STORAGE_KEY, '75');
      window.dispatchEvent(new StorageEvent('storage', { key: UI_SCALE_STORAGE_KEY, newValue: '75' }));
    });
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('75%');
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('75%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.75');

    // Reset button restores platform default (100% on web)
    fireEvent.click(screen.getByTestId('ui-scale-reset'));
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('100%');
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('100%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('');

    // On a mobile phone, Reset restores 95%
    cleanup();
    localStorage.clear();
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      navigatorPlatform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      maxTouchPoints: 5,
      innerWidth: 390,
    });
    render(<Harness />);
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('95%');
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('95%');
    const phoneIncButtons = screen.getAllByRole('button', { name: 'Increase UI scale' });
    fireEvent.click(phoneIncButtons[0]);
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('100%');
    fireEvent.click(screen.getByTestId('ui-scale-reset'));
    expect(screen.getByTestId('ui-scale-readout').textContent).toBe('95%');
    expect(screen.getByTestId('settings-ui-scale-readout').textContent).toBe('95%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_SHRINK_ZOOM_VAR)).toBe('0.95');
  });

  it('shows first-install floating UI scale card only on native apps and persists imcodes_uiScalePrompted on Done/Close/Aa change', () => {
    // Hidden on regular web browsers
    expect(shouldShowUiScaleOnboardingPrompt()).toBe(false);
    const webRender = render(<UiScaleOnboardingCard />);
    expect(screen.queryByTestId('ui-scale-onboarding-card')).toBeNull();
    webRender.unmount();

    // Native Designed-for-iPad Mac first install -> shows card defaulting to 125%
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      maxTouchPoints: 0,
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' },
    });
    expect(shouldShowUiScaleOnboardingPrompt()).toBe(true);

    function NativeHarness() {
      const [prefs, updatePrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
      return (
        <>
          <FontPrefsDropdown prefs={prefs} onChange={updatePrefs} />
          <UiScaleOnboardingCard />
        </>
      );
    }

    render(<NativeHarness />);
    expect(screen.getByTestId('ui-scale-onboarding-card')).toBeTruthy();
    expect(screen.getByTestId('ui-scale-onboarding-readout').textContent).toBe('125%');

    // Tapping quick preset updates scale live WITHOUT closing card mid-preview
    fireEvent.click(screen.getByTestId('ui-scale-onboarding-preset-75'));
    expect(screen.getByTestId('ui-scale-onboarding-readout').textContent).toBe('75%');
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.75');
    expect(screen.getByTestId('ui-scale-onboarding-card')).toBeTruthy();

    // Clicking Done sets imcodes_uiScalePrompted='1' and hides card permanently
    fireEvent.click(screen.getByTestId('ui-scale-onboarding-done'));
    expect(localStorage.getItem(UI_SCALE_PROMPTED_STORAGE_KEY)).toBe('1');
    expect(screen.queryByTestId('ui-scale-onboarding-card')).toBeNull();
    expect(shouldShowUiScaleOnboardingPrompt()).toBe(false);

    // Changing scale from Aa also dismisses an open onboarding card and marks prompted
    cleanup();
    localStorage.clear();
    render(<NativeHarness />);
    expect(screen.getByTestId('ui-scale-onboarding-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aa' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Decrease UI scale' })[0]);
    expect(localStorage.getItem(UI_SCALE_PROMPTED_STORAGE_KEY)).toBe('1');
    expect(screen.queryByTestId('ui-scale-onboarding-card')).toBeNull();

    // Native iPhone first install -> shows card defaulting to 95%
    cleanup();
    localStorage.clear();
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      navigatorPlatform: 'iPhone',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      maxTouchPoints: 5,
      innerWidth: 390,
    });
    expect(shouldShowUiScaleOnboardingPrompt()).toBe(true);
    render(<NativeHarness />);
    expect(screen.getByTestId('ui-scale-onboarding-card')).toBeTruthy();
    expect(screen.getByTestId('ui-scale-onboarding-readout').textContent).toBe('95%');
  });

  it('re-fits TerminalView when UI scale changes without Mac-only font inflation', () => {
    const ws = {
      connected: true,
      send: vi.fn(),
      sendTerminalInput: vi.fn(),
      sendTerminalResize: vi.fn(),
      onMessage: vi.fn(() => () => {}),
      onTerminalRaw: vi.fn(() => () => {}),
      onTerminalDiff: vi.fn(() => () => {}),
      onTerminalHistory: vi.fn(() => () => {}),
    };
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' },
    });

    render(
      <TerminalView
        sessionName="deck_test"
        ws={ws as never}
        active={true}
      />,
    );

    const beforeFitCount = termMockState.fitCalls;
    expect(termMockState.instances[0].options.fontSize).toBe(13);

    act(() => {
      writeUiScale(135);
    });
    expect(termMockState.fitCalls).toBeGreaterThan(beforeFitCount);
    expect(termMockState.instances[0].options.fontSize).toBe(13);
  });

  it('all 7 locale files translate the new UI scale and onboarding keys', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'];
    const fontKeys = [
      'uiScaleLabel',
      'uiScaleDecrease',
      'uiScaleIncrease',
      'uiScaleReset',
      'uiScalePromptTitle',
      'uiScalePromptHint',
      'uiScalePromptDone',
      'uiScalePromptClose',
    ];
    for (const locale of locales) {
      const localeCandidates = [
        fileURLToPath(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url)),
        resolve(process.cwd(), `src/i18n/locales/${locale}.json`),
        resolve(process.cwd(), `web/src/i18n/locales/${locale}.json`),
      ];
      const localePath = localeCandidates.find((candidate) => existsSync(candidate));
      if (!localePath) throw new Error(`Missing locale file: ${locale}`);
      const json = JSON.parse(readFileSync(localePath, 'utf8')) as {
        chat: { font: Record<string, string> };
        settings: Record<string, string>;
      };
      for (const key of fontKeys) {
        expect(typeof json.chat.font[key], `${locale}.chat.font.${key}`).toBe('string');
        expect(json.chat.font[key].length).toBeGreaterThan(0);
      }
      expect(typeof json.settings.ui_scale_desc, `${locale}.settings.ui_scale_desc`).toBe('string');
      expect(json.settings.ui_scale_desc.length).toBeGreaterThan(0);
    }

    // Also test late NATIVE_HOST_EVENT flips from 100% to 125% if nothing saved
    markUiScalePrompted();
    expect(localStorage.getItem(UI_SCALE_PROMPTED_STORAGE_KEY)).toBe('1');
    localStorage.removeItem(UI_SCALE_STORAGE_KEY);
    setGlobalRuntime({
      isNative: true,
      platform: 'ios',
      nativeHost: { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' },
    });
    window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
    expect(readUiScale()).toBe(125);
  });

  it('self-calibrates DOMRect-to-layout scale across 100%, WebKit unzoomed rects, Chromium zoomed rects, and hidden/jsdom fallbacks', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let offsetH = 400;
    let offsetW = 360;
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => offsetH });
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => offsetW });

    // 100% zoom fast path: returns 1 without invoking getBoundingClientRect or offset reads
    let offsetReads = 0;
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => { offsetReads += 1; return offsetH; } });
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => { offsetReads += 1; return offsetW; } });
    applyUiScale(100);
    const rectSpy = vi.spyOn(el, 'getBoundingClientRect');
    expect(getDomRectToLayoutScale(el)).toBe(1);
    expect(rectSpy).not.toHaveBeenCalled();
    expect(offsetReads).toBe(0);

    // Non-100% extremes AND near-100% ratios (98%, 99%, 101%, 102%)
    for (const pct of [60, 75, 85, 98, 99, 101, 102, 125, 150]) {
      const z = pct / 100;
      applyUiScale(pct);

      // WebKit: getBoundingClientRect() returns unzoomed CSS layout pixels (rect.height === offsetHeight)
      rectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: offsetW, bottom: offsetH, width: offsetW, height: offsetH, toJSON: () => ({}) } as DOMRect);
      expect(getDomRectToLayoutScale(el)).toBe(1);

      // Chromium: getBoundingClientRect() returns zoomed visual pixels (rect.height === offsetHeight * z)
      rectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: offsetW * z, bottom: offsetH * z, width: offsetW * z, height: offsetH * z, toJSON: () => ({}) } as DOMRect);
      expect(getDomRectToLayoutScale(el)).toBe(z);

      // offsetHeight === 0, offsetWidth > 0 falls back cleanly to rect.width / offsetWidth
      offsetH = 0;
      rectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: offsetW, bottom: 0, width: offsetW, height: 0, toJSON: () => ({}) } as DOMRect);
      expect(getDomRectToLayoutScale(el)).toBe(1);
      offsetH = 400;
    }

    // Hidden/collapsed pane (offsetHeight === 0 && offsetWidth === 0): never NaN/Infinity/0
    applyUiScale(75);
    offsetH = 0;
    offsetW = 0;
    rectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect);
    const origInnerW = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    const docRectSpy = vi.spyOn(document.documentElement, 'getBoundingClientRect');

    // WebKit root fallback: documentElement rect stays unzoomed (~480 vs innerWidth 360) -> 1
    docRectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 0, width: 480, height: 0, toJSON: () => ({}) } as DOMRect);
    expect(getDomRectToLayoutScale(el)).toBe(1);

    // Chromium/jsdom fallback: documentElement rect matches innerWidth (or width === 0) -> zoom (0.75)
    docRectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 360, bottom: 0, width: 360, height: 0, toJSON: () => ({}) } as DOMRect);
    expect(getDomRectToLayoutScale(el)).toBe(0.75);
    docRectSpy.mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect);
    expect(getDomRectToLayoutScale(el)).toBe(0.75);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: origInnerW });
    el.remove();
  });
});
