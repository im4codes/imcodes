/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LAYOUT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
  <div id="app">
    <div class="layout" data-testid="layout">
      <aside class="sidebar" data-testid="sidebar">
        <div class="sidebar-header">IM.codes</div>
        <div class="server-item">Server A</div>
      </aside>
      <main class="main" data-testid="main">
        <div class="mobile-server-bar" data-testid="mobile-bar">
          <button class="view-toggle" type="button">Chat</button>
          <button type="button" aria-label="Aa">Aa</button>
        </div>
        <div class="tab-bar">
          <div class="tab active">main</div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;">messages</div>
        <div class="controls-wrap" data-testid="controls-wrap" style="padding:8px;background:#0f172a;border-top:1px solid #334155;">
          <textarea class="controls-input" rows="1" style="width:100%;">draft</textarea>
        </div>
      </main>
    </div>
    <div id="onboarding-root"></div>
  </div>
</body>
</html>`;

describe('UI scale layout geometry in real Chromium', () => {
  it('fills edge-to-edge without clipping or dead gaps on desktop (125%/130%) and mobile (360x780 @ 75%/130%), plus native onboarding card', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(here, '../src/ui-scale.ts');
    const viewportPath = resolve(here, '../src/visual-viewport.ts');
    const onboardingPath = resolve(here, '../src/components/UiScaleOnboardingCard.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { boundedVisualViewportHeight } from ${JSON.stringify(viewportPath)};
          import { UiScaleOnboardingCard } from ${JSON.stringify(onboardingPath)};

          window.__uiScale = uiScale;
          window.__syncViewportVars = (overrideVvHeight) => {
            const vvHeight = overrideVvHeight ?? window.innerHeight;
            const vh = boundedVisualViewportHeight(vvHeight, window.innerHeight, document.documentElement.clientHeight);
            if (vh !== null) {
              const z = uiScale.getActiveCssZoom();
              document.documentElement.style.setProperty('--vvh', Math.round(vh / z) + 'px');
              const shrink = Math.max(0, window.innerHeight - vh);
              document.documentElement.style.setProperty('--kbh', Math.round(shrink / z) + 'px');
            }
            return {
              clientHeight: document.documentElement.clientHeight,
              boundedVh: vh,
              vvh: document.documentElement.style.getPropertyValue('--vvh'),
              kbh: document.documentElement.style.getPropertyValue('--kbh'),
              shrink: vh === null ? null : Math.max(0, window.innerHeight - vh),
            };
          };
          window.__mountOnboarding = () => {
            render(<UiScaleOnboardingCard />, document.getElementById('onboarding-root'));
          };
        `,
        resolveDir: resolve(here, '..'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      platform: 'browser',
      plugins: [{
        name: 'mock-i18n',
        setup(build) {
          build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'mock-i18n' }));
          build.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({
            contents: 'export function useTranslation() { return { t: (k, o) => o?.defaultValue ?? k }; }',
            loader: 'js',
          }));
        },
      }],
    });
    const bundleCode = compiled.outputFiles[0].text;

    const browser = await chromium.launch({ headless: true });
    try {
      // 1. Desktop 1280x800 @ 100%, 125% (Mac default), 130%
      const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await desktopPage.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: LAYOUT_HTML }));
      await desktopPage.goto('https://imcodes.test/');
      await desktopPage.addStyleTag({ content: css });
      await desktopPage.addScriptTag({ content: bundleCode });

      const desktopBaseline = await desktopPage.evaluate(() => {
        window.__uiScale.writeUiScale(100);
        window.__syncViewportVars();
        const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
        const sidebar = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
        const tab = document.querySelector('.tab')!.getBoundingClientRect();
        return {
          sidebarW: sidebar.width,
          tabH: tab.height,
          layoutW: layout.width,
          layoutH: layout.height,
        };
      });
      expect(desktopBaseline.layoutW).toBeGreaterThanOrEqual(1279);
      expect(desktopBaseline.layoutH).toBeGreaterThanOrEqual(799);

      for (const pct of [125, 130]) {
        const scaled = await desktopPage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          window.__syncViewportVars();
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const sidebar = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="controls-wrap"]')!.getBoundingClientRect();
          const tab = document.querySelector('.tab')!.getBoundingClientRect();
          const computedZoom = getComputedStyle(document.documentElement).getPropertyValue('zoom');
          return {
            computedZoom,
            sidebarW: sidebar.width,
            tabH: tab.height,
            layoutLeft: layout.left,
            layoutTop: layout.top,
            layoutRight: layout.right,
            layoutBottom: layout.bottom,
            controlsBottom: controls.bottom,
          };
        }, pct);

        const factor = pct / 100;
        expect(Number(scaled.computedZoom)).toBeCloseTo(factor, 2);
        // Sidebars & tabs scale uniformly (rendered rect scales with zoom!)
        expect(scaled.sidebarW).toBeGreaterThan(desktopBaseline.sidebarW * (factor - 0.05));
        expect(scaled.tabH).toBeGreaterThan(desktopBaseline.tabH * (factor - 0.05));
        // Edge-to-edge without overflow clipping or dead bottom/right gaps
        expect(scaled.layoutLeft).toBeGreaterThanOrEqual(0);
        expect(scaled.layoutTop).toBeGreaterThanOrEqual(0);
        expect(scaled.layoutRight).toBeGreaterThanOrEqual(1278);
        expect(scaled.layoutRight).toBeLessThanOrEqual(1281);
        expect(scaled.layoutBottom).toBeGreaterThanOrEqual(798);
        expect(scaled.layoutBottom).toBeLessThanOrEqual(801);
        expect(scaled.controlsBottom).toBeLessThanOrEqual(801);
        expect(scaled.controlsBottom).toBeGreaterThanOrEqual(795);
      }

      // Simulated Designed-for-iPad Mac native app defaults to 125% and mounts non-blocking onboarding card
      const nativeMacOnboarding = await desktopPage.evaluate(() => {
        localStorage.clear();
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
        window.__IMCODES_NATIVE_HOST__ = { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'designed-for-ipad' };
        const initialized = window.__uiScale.initUiScale();
        window.__mountOnboarding();
        const card = document.querySelector('[data-testid="ui-scale-onboarding-card"]') as HTMLElement | null;
        const readout = document.querySelector('[data-testid="ui-scale-onboarding-readout"]')?.textContent;
        const textarea = document.querySelector('.controls-input') as HTMLTextAreaElement;
        const tRect = textarea.getBoundingClientRect();
        const cRect = card!.getBoundingClientRect();
        const overlapControls = !(cRect.right < tRect.left || cRect.left > tRect.right || cRect.bottom < tRect.top || cRect.top > tRect.bottom);
        return { initialized, cardPresent: Boolean(card), readout, overlapControls };
      });
      expect(nativeMacOnboarding.initialized).toBe(125);
      expect(nativeMacOnboarding.cardPresent).toBe(true);
      expect(nativeMacOnboarding.readout).toBe('125%');
      expect(nativeMacOnboarding.overlapControls).toBe(false);
      await desktopPage.close();

      // 2. Mobile 360x780 @ 75% (Android/phone shrink) & 130% (mobile enlarge)
      const mobilePage = await browser.newPage({ viewport: { width: 360, height: 780 } });
      await mobilePage.route('https://imcodes.test/**', (route) => route.fulfill({
        contentType: 'text/html',
        body: LAYOUT_HTML.replace('class="layout"', 'class="layout layout-mobile"'),
      }));
      await mobilePage.goto('https://imcodes.test/');
      await mobilePage.addStyleTag({ content: css });
      await mobilePage.addScriptTag({ content: bundleCode });

      for (const pct of [75, 130]) {
        const mobileState = await mobilePage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          const vvStats = window.__syncViewportVars();
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="controls-wrap"]')!.getBoundingClientRect();
          const mobileBar = document.querySelector('[data-testid="mobile-bar"]')!.getBoundingClientRect();
          const computedZoom = getComputedStyle(document.documentElement).getPropertyValue('zoom');
          return {
            computedZoom,
            vvStats,
            layoutLeft: layout.left,
            layoutTop: layout.top,
            layoutRight: layout.right,
            layoutBottom: layout.bottom,
            controlsBottom: controls.bottom,
            controlsTop: controls.top,
            mobileBarWidth: mobileBar.width,
          };
        }, pct);

        expect(Number(mobileState.computedZoom)).toBeCloseTo(pct / 100, 2);
        // visualViewport shrink stays 0 (never falsely thinks zoomed viewport = open keyboard)
        expect(mobileState.vvStats.shrink).toBe(0);
        // Full 360x780 edge-to-edge fill with zero dead right/bottom gaps and zero offscreen clipping
        expect(mobileState.layoutLeft).toBeGreaterThanOrEqual(0);
        expect(mobileState.layoutTop).toBeGreaterThanOrEqual(0);
        expect(mobileState.layoutRight).toBeGreaterThanOrEqual(358);
        expect(mobileState.layoutRight).toBeLessThanOrEqual(361);
        expect(mobileState.layoutBottom).toBeGreaterThanOrEqual(778);
        expect(mobileState.layoutBottom).toBeLessThanOrEqual(782);
        expect(mobileState.controlsBottom).toBeLessThanOrEqual(782);
        expect(mobileState.controlsBottom).toBeGreaterThanOrEqual(775);
        expect(mobileState.mobileBarWidth).toBeGreaterThanOrEqual(358);
      }
      await mobilePage.close();
    } finally {
      await browser.close();
    }
  });
});
