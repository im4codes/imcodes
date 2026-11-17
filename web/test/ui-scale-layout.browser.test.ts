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
          <div id="font-prefs-mount" style="margin-left:auto;"></div>
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

    <div class="mobile-sidebar-overlay" data-testid="mobile-sidebar-overlay">
      <div class="mobile-sidebar-panel" data-testid="mobile-sidebar-panel">
        <div class="mobile-sidebar-header">
          <span style="font-size:15px;font-weight:700;color:#e2e8f0;">IM.codes</span>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;min-width:0;">
            <button class="mobile-sidebar-hdr-btn" type="button">🏠</button>
            <button class="mobile-sidebar-hdr-btn" type="button">⚙</button>
            <button class="mobile-sidebar-hdr-btn" type="button">🛡</button>
            <button class="mobile-sidebar-hdr-btn" type="button">CTX</button>
            <button class="mobile-sidebar-hdr-btn" type="button">≡</button>
            <button class="mobile-sidebar-hdr-btn" type="button">⊞</button>
            <button class="mobile-sidebar-close" type="button">✕</button>
          </div>
        </div>
        <div class="mobile-sidebar-body"><div>Session item</div></div>
      </div>
    </div>

    <div class="feature-announcement" data-testid="feature-announcement">
      <div class="feature-announcement-message">
        <span class="feature-announcement-icon">✨</span>
        <span>New global UI zoom adapts edge-to-edge on every screen size.</span>
      </div>
      <button class="feature-announcement-dismiss" type="button">Got it</button>
    </div>

    <div class="dialog-overlay" data-testid="dialog-overlay" style="display:none;">
      <div class="dialog" data-testid="dialog-card">
        <div style="padding:16px;color:#e2e8f0;">Dialog content inside zoomed viewport</div>
      </div>
    </div>

    <div id="settings-root"></div>
    <div id="onboarding-root"></div>
  </div>
</body>
</html>`;

describe('UI scale layout geometry in real Chromium', () => {
  it('fills edge-to-edge without black bars or overflow across 60%/90%/100%/125%/150% for root, .layout, SettingsPage, modals, and popovers on desktop (1280x800) and mobile (360x780)', { timeout: 45000 }, async () => {
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
    const mobileKbPath = resolve(here, '../src/mobile-keyboard.ts');
    const onboardingPath = resolve(here, '../src/components/UiScaleOnboardingCard.tsx');
    const settingsPath = resolve(here, '../src/pages/SettingsPage.tsx');
    const fontPrefsPath = resolve(here, '../src/components/FontPrefsDropdown.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { boundedVisualViewportHeight } from ${JSON.stringify(viewportPath)};
          import { getMobileKeyboardState } from ${JSON.stringify(mobileKbPath)};
          import { UiScaleOnboardingCard } from ${JSON.stringify(onboardingPath)};
          import { SettingsPage } from ${JSON.stringify(settingsPath)};
          import { DEFAULT_CHAT_FONT, FontPrefsDropdown, useFontPrefs } from ${JSON.stringify(fontPrefsPath)};

          // Stub fetch so SettingsPage API probes settle cleanly offline
          window.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

          window.__uiScale = uiScale;
          window.__syncViewportVars = (overrideVvHeight, inputFocused = false, hadKeyboardOpen = false) => {
            const vvHeight = overrideVvHeight ?? window.innerHeight;
            const z = uiScale.getActiveCssZoom();
            const vh = boundedVisualViewportHeight(vvHeight, window.innerHeight, document.documentElement.clientHeight, z);
            let kbState = { kbOpen: false, hideInputUi: false, hadKeyboardOpen: false };
            if (vh !== null) {
              document.documentElement.style.setProperty('--vvh', Math.round(vh / z) + 'px');
              const shrink = Math.max(0, window.innerHeight - vh);
              document.documentElement.style.setProperty('--kbh', Math.round(shrink / z) + 'px');
              kbState = getMobileKeyboardState(inputFocused, shrink, hadKeyboardOpen);
              document.documentElement.classList.toggle('kb-open', kbState.kbOpen);
            }
            return {
              clientHeight: document.documentElement.clientHeight,
              boundedVh: vh,
              vvh: document.documentElement.style.getPropertyValue('--vvh'),
              kbh: document.documentElement.style.getPropertyValue('--kbh'),
              shrink: vh === null ? null : Math.max(0, window.innerHeight - vh),
              kbOpen: kbState.kbOpen,
            };
          };
          window.__mountSettings = (open) => {
            const root = document.getElementById('settings-root');
            if (!open) {
              render(null, root);
              return;
            }
            render(
              <div
                data-testid="settings-page-overlay"
                style={{
                  position: 'fixed',
                  inset: 0,
                  width: 'var(--imcodes-ui-vw, 100%)',
                  height: 'var(--vvh, var(--imcodes-ui-dvh))',
                  maxHeight: 'var(--vvh, var(--imcodes-ui-dvh))',
                  zIndex: 9500,
                  background: '#0f172a',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <SettingsPage
                    displayName="Demo"
                    username="demo"
                    hasPassword={true}
                    onBack={() => {}}
                    onDisplayNameChanged={() => {}}
                    onUserAuthUpdated={() => {}}
                  />
                </div>
              </div>,
              root,
            );
          };
          function FontHarness() {
            const [prefs, updatePrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
            return <FontPrefsDropdown prefs={prefs} onChange={updatePrefs} />;
          }
          window.__mountFontPrefs = () => {
            render(<FontHarness />, document.getElementById('font-prefs-mount'));
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
        setup(b) {
          b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'mock-i18n' }));
          b.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({
            contents: `
              export function useTranslation() {
                return { t: (k, o) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)), i18n: { language: 'en', changeLanguage: async () => {} } };
              }
            `,
            loader: 'js',
          }));
        },
      }],
    });
    const bundleCode = compiled.outputFiles[0].text;

    const browser = await chromium.launch({ headless: true });
    try {
      const withCssInHead = (html: string) => html.replace('</head>', () => `<style>${css}</style></head>`);

      // 1. Desktop 1280x800 @ 60%, 90%, 100%, 125%, 130%, 150%
      const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await desktopPage.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: withCssInHead(LAYOUT_HTML) }));
      await desktopPage.goto('https://imcodes.test/');
      await desktopPage.addScriptTag({ content: bundleCode });
      await desktopPage.evaluate(() => {
        window.__mountSettings(true);
      });

      const desktopScaleRects: Array<{
        pct: number;
        htmlW: number;
        htmlH: number;
        layoutW: number;
        layoutH: number;
        settingsW: number;
        settingsH: number;
        readoutW: number;
        incBtnH: number;
        sidebarW: number;
      }> = [];

      for (const pct of [60, 90, 100, 125, 130, 150]) {
        const m = await desktopPage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          const vvStats = window.__syncViewportVars();
          const html = document.documentElement.getBoundingClientRect();
          const app = document.getElementById('app')!.getBoundingClientRect();
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const sidebar = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="controls-wrap"]')!.getBoundingClientRect();
          const settingsOverlay = document.querySelector('[data-testid="settings-page-overlay"]')!.getBoundingClientRect();
          const readout = document.querySelector('[data-testid="settings-ui-scale-readout"]')!.getBoundingClientRect();
          const incBtn = (document.querySelector('[aria-label="Increase UI scale"]') as HTMLElement).getBoundingClientRect();
          const computedZoom = getComputedStyle(document.documentElement).getPropertyValue('zoom');
          return {
            computedZoom,
            vvStats,
            html: { left: html.left, top: html.top, width: html.width, height: html.height },
            app: { width: app.width, height: app.height },
            layout: { left: layout.left, top: layout.top, right: layout.right, bottom: layout.bottom, width: layout.width, height: layout.height },
            settings: { left: settingsOverlay.left, top: settingsOverlay.top, right: settingsOverlay.right, bottom: settingsOverlay.bottom, width: settingsOverlay.width, height: settingsOverlay.height },
            controlsBottom: controls.bottom,
            readoutW: readout.width,
            incBtnH: incBtn.height,
            sidebarW: sidebar.width,
          };
        }, pct);

        expect(Number(m.computedZoom)).toBeCloseTo(pct / 100, 2);
        expect(m.vvStats.shrink).toBe(0);
        // Root html, #app, .layout, and SettingsPage fullscreen overlay all fill exact 1280x800
        for (const box of [m.html, m.app, m.layout, m.settings]) {
          expect(box.width, `desktop ${pct}% width`).toBeGreaterThanOrEqual(1278.5);
          expect(box.width, `desktop ${pct}% width`).toBeLessThanOrEqual(1281.5);
          expect(box.height, `desktop ${pct}% height`).toBeGreaterThanOrEqual(798.5);
          expect(box.height, `desktop ${pct}% height`).toBeLessThanOrEqual(801.5);
        }
        expect(m.settings.left).toBeCloseTo(0, 1);
        expect(m.settings.top).toBeCloseTo(0, 1);
        expect(m.controlsBottom).toBeGreaterThanOrEqual(796);
        expect(m.controlsBottom).toBeLessThanOrEqual(801.5);

        desktopScaleRects.push({
          pct,
          htmlW: m.html.width,
          htmlH: m.html.height,
          layoutW: m.layout.width,
          layoutH: m.layout.height,
          settingsW: m.settings.width,
          settingsH: m.settings.height,
          readoutW: m.readoutW,
          incBtnH: m.incBtnH,
          sidebarW: m.sidebarW,
        });
      }

      // Internal SettingsPage button height and sidebar width scale monotonically with zoom while container stays 1280x800
      const d60 = desktopScaleRects.find((r) => r.pct === 60)!;
      const d90 = desktopScaleRects.find((r) => r.pct === 90)!;
      const d100 = desktopScaleRects.find((r) => r.pct === 100)!;
      const d125 = desktopScaleRects.find((r) => r.pct === 125)!;
      const d150 = desktopScaleRects.find((r) => r.pct === 150)!;
      expect(d60.incBtnH).toBeLessThan(d90.incBtnH);
      expect(d90.incBtnH).toBeLessThan(d100.incBtnH);
      expect(d100.incBtnH).toBeLessThan(d125.incBtnH);
      expect(d125.incBtnH).toBeLessThan(d150.incBtnH);
      expect(d60.sidebarW).toBeLessThan(d100.sidebarW);
      expect(d150.sidebarW).toBeGreaterThan(d100.sidebarW);

      // Native Mac first-install onboarding card remains non-blocking at 125%
      const nativeMacOnboarding = await desktopPage.evaluate(() => {
        window.__mountSettings(false);
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

      // 2. Mobile 360x780 @ 60%, 75%, 90%, 100%, 125%, 130%, 150%
      const mobilePage = await browser.newPage({ viewport: { width: 360, height: 780 } });
      await mobilePage.route('https://imcodes.test/**', (route) => route.fulfill({
        contentType: 'text/html',
        body: withCssInHead(LAYOUT_HTML.replace('class="layout"', 'class="layout layout-mobile"')),
      }));
      await mobilePage.goto('https://imcodes.test/');
      await mobilePage.addScriptTag({ content: bundleCode });
      await mobilePage.evaluate(() => {
        window.__mountFontPrefs();
        window.__mountSettings(true);
        (document.querySelector('[data-testid="dialog-overlay"]') as HTMLElement).style.display = 'flex';
      });

      const mobileScaleRects: Array<{
        pct: number;
        settingsRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
        layoutRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
        incBtnH: number;
      }> = [];

      for (const pct of [60, 75, 90, 100, 125, 130, 150]) {
        const m = await mobilePage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          const vvStats = window.__syncViewportVars();
          const html = document.documentElement.getBoundingClientRect();
          const app = document.getElementById('app')!.getBoundingClientRect();
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const controls = document.querySelector('[data-testid="controls-wrap"]')!.getBoundingClientRect();
          const mobileBar = document.querySelector('[data-testid="mobile-bar"]')!.getBoundingClientRect();
          const settingsOverlay = document.querySelector('[data-testid="settings-page-overlay"]')!.getBoundingClientRect();
          const incBtn = (document.querySelector('[aria-label="Increase UI scale"]') as HTMLElement).getBoundingClientRect();
          const announcement = document.querySelector('[data-testid="feature-announcement"]')!.getBoundingClientRect();
          const dialogOverlay = document.querySelector('[data-testid="dialog-overlay"]')!.getBoundingClientRect();
          const dialogCard = document.querySelector('[data-testid="dialog-card"]')!.getBoundingClientRect();
          const sidebarPanel = document.querySelector('[data-testid="mobile-sidebar-panel"]') as HTMLElement;
          const sidebarVisibility = getComputedStyle(sidebarPanel).visibility;
          const leakedSidebarButtons = Array.from(sidebarPanel.querySelectorAll('button'))
            .map((btn) => btn.getBoundingClientRect())
            .filter((r) => r.right > 0.5 && sidebarVisibility !== 'hidden').length;
          const computedZoom = getComputedStyle(document.documentElement).getPropertyValue('zoom');
          return {
            computedZoom,
            vvStats,
            html: { width: html.width, height: html.height },
            app: { width: app.width, height: app.height },
            layout: { left: layout.left, top: layout.top, right: layout.right, bottom: layout.bottom, width: layout.width, height: layout.height },
            settings: { left: settingsOverlay.left, top: settingsOverlay.top, right: settingsOverlay.right, bottom: settingsOverlay.bottom, width: settingsOverlay.width, height: settingsOverlay.height },
            dialogOverlay: { width: dialogOverlay.width, height: dialogOverlay.height },
            dialogCard: { left: dialogCard.left, right: dialogCard.right },
            announcement: { left: announcement.left, right: announcement.right, width: announcement.width },
            sidebarVisibility,
            leakedSidebarButtons,
            controlsBottom: controls.bottom,
            mobileBarWidth: mobileBar.width,
            incBtnH: incBtn.height,
          };
        }, pct);

        expect(Number(m.computedZoom)).toBeCloseTo(pct / 100, 2);
        // Never falsely triggers kb-open or phantom shrink when keyboard is closed
        expect(m.vvStats.shrink).toBe(0);
        expect(m.vvStats.kbOpen).toBe(false);

        // Edge-to-edge 360x780 fill with zero black bars at 60%/75%/90% and zero overflow at 125%/130%/150%
        for (const box of [m.html, m.app, m.layout, m.settings, m.dialogOverlay]) {
          expect(box.width, `mobile ${pct}% width`).toBeGreaterThanOrEqual(358.5);
          expect(box.width, `mobile ${pct}% width`).toBeLessThanOrEqual(361.5);
          expect(box.height, `mobile ${pct}% height`).toBeGreaterThanOrEqual(778.5);
          expect(box.height, `mobile ${pct}% height`).toBeLessThanOrEqual(781.5);
        }
        expect(m.controlsBottom).toBeGreaterThanOrEqual(775);
        expect(m.controlsBottom).toBeLessThanOrEqual(782);
        expect(m.mobileBarWidth).toBeGreaterThanOrEqual(358.5);
        expect(m.mobileBarWidth).toBeLessThanOrEqual(361.5);

        // .feature-announcement and .dialog never clip outside 360px screen (even at 150%; at 60% 16px*0.6=9.6px)
        expect(m.announcement.left, `announcement left @ ${pct}%`).toBeGreaterThanOrEqual(6);
        expect(m.announcement.right, `announcement right @ ${pct}%`).toBeLessThanOrEqual(354);
        expect(m.dialogCard.left, `dialog left @ ${pct}%`).toBeGreaterThanOrEqual(8);
        expect(m.dialogCard.right, `dialog right @ ${pct}%`).toBeLessThanOrEqual(352);

        // Closed mobile sidebar drawer never leaks header buttons onto screen
        expect(m.sidebarVisibility).toBe('hidden');
        expect(m.leakedSidebarButtons).toBe(0);

        mobileScaleRects.push({
          pct,
          settingsRect: m.settings,
          layoutRect: m.layout,
          incBtnH: m.incBtnH,
        });
      }

      console.info('[ui-scale-layout SettingsPage geometry]', JSON.stringify({
        desktop1280x800: desktopScaleRects,
        mobile360x780: mobileScaleRects,
      }));

      const m60 = mobileScaleRects.find((r) => r.pct === 60)!;
      const m100 = mobileScaleRects.find((r) => r.pct === 100)!;
      const m150 = mobileScaleRects.find((r) => r.pct === 150)!;
      expect(m60.incBtnH).toBeLessThan(m100.incBtnH);
      expect(m100.incBtnH).toBeLessThan(m150.incBtnH);

      // FontPrefsDropdown (Aa popover) opened on 360dp @ 150% stays strictly inside [0, 360]
      await mobilePage.evaluate(() => {
        window.__mountSettings(false);
        (document.querySelector('[data-testid="dialog-overlay"]') as HTMLElement).style.display = 'none';
        window.__uiScale.writeUiScale(150);
        window.__syncViewportVars();
      });
      await mobilePage.click('button[aria-label="Aa"]');
      const aaRect = await mobilePage.evaluate(() => {
        const pop = document.querySelector('[data-testid="font-prefs-popover"]') as HTMLElement;
        const r = pop.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      });
      expect(aaRect.left).toBeGreaterThanOrEqual(4);
      expect(aaRect.right).toBeLessThanOrEqual(356);
      expect(aaRect.bottom).toBeLessThanOrEqual(776);

      // Soft keyboard open & close across 60%, 90%, 100%, 125%, 150% on 360x780
      await mobilePage.evaluate(() => window.__mountSettings(true));
      for (const pct of [60, 90, 100, 125, 150]) {
        const kbOpenMetrics = await mobilePage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          const openStats = window.__syncViewportVars(460, true, false);
          const layoutOpen = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const settingsOpen = document.querySelector('[data-testid="settings-page-overlay"]')!.getBoundingClientRect();
          const closedStats = window.__syncViewportVars(780, false, false);
          const layoutClosed = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const settingsClosed = document.querySelector('[data-testid="settings-page-overlay"]')!.getBoundingClientRect();
          return {
            openStats,
            layoutOpenH: layoutOpen.height,
            settingsOpenH: settingsOpen.height,
            closedStats,
            layoutClosedH: layoutClosed.height,
            settingsClosedH: settingsClosed.height,
          };
        }, pct);
        expect(kbOpenMetrics.openStats.kbOpen).toBe(true);
        expect(kbOpenMetrics.openStats.shrink).toBe(320);
        expect(kbOpenMetrics.layoutOpenH).toBeGreaterThanOrEqual(458);
        expect(kbOpenMetrics.layoutOpenH).toBeLessThanOrEqual(462);
        expect(kbOpenMetrics.settingsOpenH).toBeGreaterThanOrEqual(458);
        expect(kbOpenMetrics.settingsOpenH).toBeLessThanOrEqual(462);
        expect(kbOpenMetrics.closedStats.kbOpen).toBe(false);
        expect(kbOpenMetrics.closedStats.shrink).toBe(0);
        expect(kbOpenMetrics.layoutClosedH).toBeGreaterThanOrEqual(778.5);
        expect(kbOpenMetrics.settingsClosedH).toBeGreaterThanOrEqual(778.5);
      }

      // Orientation swap (360x780 -> 780x360 landscape -> 360x780) & legacy non-dvh fallback check
      await mobilePage.setViewportSize({ width: 780, height: 360 });
      for (const pct of [90, 150]) {
        const landscape = await mobilePage.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
          // Simulate older Android System WebView without 100dvh support (falls back to 100vh / zoom without --vvh)
          document.documentElement.style.removeProperty('--vvh');
          document.documentElement.style.setProperty('--imcodes-ui-dvh', 'calc(100vh / var(--imcodes-ui-zoom, 1))');
          const html = document.documentElement.getBoundingClientRect();
          const layout = document.querySelector('[data-testid="layout"]')!.getBoundingClientRect();
          const settings = document.querySelector('[data-testid="settings-page-overlay"]')!.getBoundingClientRect();
          return {
            htmlW: html.width,
            htmlH: html.height,
            layoutW: layout.width,
            layoutH: layout.height,
            settingsW: settings.width,
            settingsH: settings.height,
          };
        }, pct);
        expect(landscape.htmlW).toBeGreaterThanOrEqual(778.5);
        expect(landscape.htmlH).toBeGreaterThanOrEqual(358.5);
        expect(landscape.layoutW).toBeGreaterThanOrEqual(778.5);
        expect(landscape.layoutH).toBeGreaterThanOrEqual(358.5);
        expect(landscape.settingsW).toBeGreaterThanOrEqual(778.5);
        expect(landscape.settingsH).toBeGreaterThanOrEqual(358.5);
      }

      await mobilePage.close();
    } finally {
      await browser.close();
    }
  });
});
