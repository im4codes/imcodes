/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAC_SHELL_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
  <div id="app">
    <div class="layout" data-testid="layout">
      <aside class="sidebar" data-testid="sidebar">
        <div class="sidebar-header">IM.codes</div>
        <div class="server-list"><div class="server-item active">Mac Host</div></div>
        <div class="sidebar-stats" data-testid="status-bar">
          <div class="sidebar-stats-row"><span>English | Voice · v2026.11</span></div>
        </div>
      </aside>
      <main class="main" data-testid="main">
        <div class="tab-bar"><div class="tab active">main</div></div>
        <div style="flex:1;min-height:0;overflow:auto;">messages</div>
        <div class="controls-wrapper" data-testid="controls-wrapper">
          <div class="shortcuts-row" data-testid="shortcuts-row">
            <div class="shortcuts"><button type="button" class="shortcut-btn">Stop</button></div>
          </div>
          <div class="controls" style="padding:8px;">
            <textarea class="controls-input" data-testid="composer-input" rows="1" style="width:100%;">hello</textarea>
          </div>
        </div>
        <div class="subcard-bar" data-testid="subsession-bar-wrap">
          <div class="subsession-bar" data-testid="subsession-bar">
            <div class="subsession-card">Ag9</div>
          </div>
        </div>
      </main>
    </div>
    <div class="toast-container" data-testid="toast-container">
      <div class="toast">Saved</div>
    </div>
  </div>
</body>
</html>`;

describe('Mac bottom input-bar inset geometry in real Chromium', () => {
  it('lifts .layout, status bar, composer, sub-session bar, and fixed bottom overlays cleanly above a 44px bottom bar at 100%, 125% (Mac default), 60%, and 150% via both native and visualViewport channels', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(here, '../src/ui-scale.ts');
    const macInsetPath = resolve(here, '../src/mac-input-inset.ts');
    const nativePlatformPath = resolve(here, '../src/native-platform.ts');

    const compiled = await build({
      stdin: {
        contents: `
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import * as macInset from ${JSON.stringify(macInsetPath)};
          import * as nativePlatform from ${JSON.stringify(nativePlatformPath)};

          window.__uiScale = uiScale;
          window.__macInset = macInset;
          window.__nativePlatform = nativePlatform;
        `,
        resolveDir: resolve(here, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
    });
    const bundleCode = compiled.outputFiles[0].text;

    const browser = await chromium.launch({ headless: true });
    try {
      const windowHeight = 800;
      const barHeight = 44;
      const page = await browser.newPage({ viewport: { width: 1280, height: windowHeight } });
      await page.route('https://imcodes.mac.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: MAC_SHELL_HTML }),
      );
      await page.goto('https://imcodes.mac.test/');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundleCode });

      // Configure simulated Designed-for-iPad Mac host and install Mac input inset controller
      await page.evaluate(() => {
        const w = window as unknown as Record<string, any>;
        w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
        w.__IMCODES_NATIVE_HOST__ = {
          isMacDesktop: true,
          pageZoomApplied: false,
          scaleMode: 'designed-for-ipad',
        };
        w.__nativePlatform.applyNativePlatformClasses();
        w.__disposeMacInset = w.__macInset.installMacInputInset();
      });

      // 1. Verify native channel across 100%, 125% (Mac default), 60%, and 150%
      for (const scalePct of [100, 125, 60, 150]) {
        const activeMetrics = await page.evaluate(({ pct, inset }) => {
          const w = window as unknown as Record<string, any>;
          w.__uiScale.writeUiScale(pct);
          const input = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
          input.focus();
          window.dispatchEvent(new CustomEvent('imcodes:mac-bottom-inset', { detail: { inset } }));

          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const statusBar = document.querySelector('[data-testid="status-bar"]')!.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="controls-wrapper"]')!.getBoundingClientRect();
          const inputRect = input.getBoundingClientRect();
          const shortcuts = document.querySelector('[data-testid="shortcuts-row"]')!;
          const subBar = document.querySelector('[data-testid="subsession-bar"]')!;
          const toast = document.querySelector('[data-testid="toast-container"]')!.getBoundingClientRect();

          return {
            layoutBottom: layout.bottom,
            layoutTop: layout.top,
            statusBarBottom: statusBar.bottom,
            controlsBottom: controls.bottom,
            inputBottom: inputRect.bottom,
            subBarBottom: subBar.getBoundingClientRect().bottom,
            shortcutsDisplay: getComputedStyle(shortcuts).display,
            subBarDisplay: getComputedStyle(subBar).display,
            toastBottom: toast.bottom,
            hasKbOpen: document.documentElement.classList.contains('kb-open'),
            hasInputFocused: document.documentElement.classList.contains('input-focused'),
            cssVar: document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset'),
          };
        }, { pct: scalePct, inset: barHeight });

        const expectedMaxBottom = windowHeight - barHeight; // 756
        expect(activeMetrics.cssVar).not.toBe('');
        // Exact shift: never covered by the 44px bar (<= 756.05) and never over-shifted (>= 755)
        expect(activeMetrics.layoutTop).toBe(0);
        expect(activeMetrics.layoutBottom).toBeLessThanOrEqual(expectedMaxBottom + 0.05);
        expect(activeMetrics.layoutBottom).toBeGreaterThanOrEqual(expectedMaxBottom - 1);
        expect(activeMetrics.statusBarBottom).toBeLessThanOrEqual(expectedMaxBottom + 0.05);
        expect(activeMetrics.controlsBottom).toBeLessThanOrEqual(expectedMaxBottom + 0.05);
        expect(activeMetrics.inputBottom).toBeLessThanOrEqual(expectedMaxBottom + 0.05);
        expect(activeMetrics.subBarBottom).toBeLessThanOrEqual(expectedMaxBottom + 0.05);
        // Desktop controls & sub-session bar stay visible (never hidden by mobile .kb-open/.input-focused)
        expect(activeMetrics.shortcutsDisplay).not.toBe('none');
        expect(activeMetrics.subBarDisplay).not.toBe('none');
        expect(activeMetrics.hasKbOpen).toBe(false);
        expect(activeMetrics.hasInputFocused).toBe(false);
        // Fixed bottom toast container also lifts above the bar
        expect(activeMetrics.toastBottom).toBeLessThanOrEqual(expectedMaxBottom);

        // Dismiss bar -> immediately restores full windowHeight (800)
        const restoredMetrics = await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent('imcodes:mac-bottom-inset', { detail: { inset: 0 } }));
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          return {
            layoutBottom: layout.bottom,
            cssVar: document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset'),
          };
        });
        expect(restoredMetrics.cssVar).toBe('');
        expect(restoredMetrics.layoutBottom).toBeGreaterThanOrEqual(windowHeight - 0.5);
        expect(restoredMetrics.layoutBottom).toBeLessThanOrEqual(windowHeight + 0.5);
      }

      // 2. Verify legacy OTA Mac shell fallback (visualViewport shrink without native event) @ 125%
      const otaFallbackMetrics = await page.evaluate(({ inset }) => {
        const w = window as unknown as Record<string, any>;
        w.__uiScale.writeUiScale(125);
        w.__disposeMacInset?.();

        const listeners = new Set<EventListener>();
        let mockVvHeight = window.innerHeight - inset;
        const mockVv = {
          get height() { return mockVvHeight; },
          offsetTop: 0,
          scale: 1,
          addEventListener: (_type: string, fn: EventListener) => listeners.add(fn),
          removeEventListener: (_type: string, fn: EventListener) => listeners.delete(fn),
        };
        Object.defineProperty(window, 'visualViewport', { value: mockVv, configurable: true });
        w.__IMCODES_MAC_BOTTOM_INSET__ = 0;

        const dispose = w.__macInset.installMacInputInset();
        const openBottom = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect().bottom;
        const openVar = document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset');

        mockVvHeight = window.innerHeight;
        listeners.forEach((fn) => fn(new Event('resize')));
        const closedBottom = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect().bottom;
        const closedVar = document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset');
        dispose();

        return { openBottom, openVar, closedBottom, closedVar };
      }, { inset: barHeight });

      expect(otaFallbackMetrics.openVar).toBe('35.2px');
      expect(otaFallbackMetrics.openBottom).toBeLessThanOrEqual(windowHeight - barHeight + 0.05);
      expect(otaFallbackMetrics.openBottom).toBeGreaterThanOrEqual(windowHeight - barHeight - 1);
      expect(otaFallbackMetrics.closedVar).toBe('');
      expect(otaFallbackMetrics.closedBottom).toBeGreaterThanOrEqual(windowHeight - 0.5);
      expect(otaFallbackMetrics.closedBottom).toBeLessThanOrEqual(windowHeight + 0.5);

      // 3. Verify non-Mac desktop web & Android/iPhone native shells are completely unaffected
      const nonMacMetrics = await page.evaluate(() => {
        const w = window as unknown as Record<string, any>;
        delete w.Capacitor;
        delete w.__IMCODES_NATIVE_HOST__;
        w.__uiScale.writeUiScale(100);
        w.__nativePlatform.applyNativePlatformClasses();
        const disposeWeb = w.__macInset.installMacInputInset();
        window.dispatchEvent(new CustomEvent('imcodes:mac-bottom-inset', { detail: { inset: 44 } }));
        const webBottom = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect().bottom;
        const webVar = document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset');
        const hasMacClassOnWeb = document.documentElement.classList.contains('native-mac-desktop');
        disposeWeb();

        w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        w.__nativePlatform.applyNativePlatformClasses();
        const disposeAndroid = w.__macInset.installMacInputInset();
        window.dispatchEvent(new CustomEvent('imcodes:mac-bottom-inset', { detail: { inset: 44 } }));
        const androidBottom = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect().bottom;
        const androidVar = document.documentElement.style.getPropertyValue('--imcodes-mac-bottom-inset');
        const hasMacClassOnAndroid = document.documentElement.classList.contains('native-mac-desktop');
        disposeAndroid();

        return {
          webBottom,
          webVar,
          hasMacClassOnWeb,
          androidBottom,
          androidVar,
          hasMacClassOnAndroid,
        };
      });

      expect(nonMacMetrics.webVar).toBe('');
      expect(nonMacMetrics.hasMacClassOnWeb).toBe(false);
      expect(nonMacMetrics.webBottom).toBeGreaterThanOrEqual(windowHeight - 0.5);
      expect(nonMacMetrics.androidVar).toBe('');
      expect(nonMacMetrics.hasMacClassOnAndroid).toBe(false);
      expect(nonMacMetrics.androidBottom).toBeGreaterThanOrEqual(windowHeight - 0.5);

      await page.close();
    } finally {
      await browser.close();
    }
  });
});
