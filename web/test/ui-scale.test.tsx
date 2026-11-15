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
  formatUiScale,
  getActiveCssZoom,
  getDefaultUiScale,
  markUiScalePrompted,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  readUiScale,
  resolveEffectiveUiZoom,
  shouldShowUiScaleOnboardingPrompt,
  UI_SCALE_PROMPTED_STORAGE_KEY,
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

function setGlobalRuntime(overrides: {
  isNative?: boolean;
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
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
  if (overrides.userAgent !== undefined) {
    Object.defineProperty(navigator, 'userAgent', { value: overrides.userAgent, configurable: true });
  }
  if (overrides.maxTouchPoints !== undefined) {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: overrides.maxTouchPoints, configurable: true });
  }
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
    expect(getDefaultUiScale(androidPhone)).toBe(100);
    expect(getDefaultUiScale(desktopBrowser)).toBe(100);
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
    expect(getActiveCssZoom()).toBe(1);

    writeUiScale(75);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('0.75');
    expect(getActiveCssZoom()).toBe(0.75);
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('75');
    expect(readGlobalFontDelta()).toBe(DEFAULT_GLOBAL_FONT_DELTA);
    expect(localStorage.getItem(GLOBAL_FONT_DELTA_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue(GLOBAL_FONT_DELTA_VAR)).toBe('');

    writeUiScale(125);
    expect(document.documentElement.style.getPropertyValue(UI_SCALE_ZOOM_VAR)).toBe('1.25');
    expect(getActiveCssZoom()).toBe(1.25);

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
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const rootRule = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
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
});
