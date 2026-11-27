/**
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function resolveChromiumExecutable(chromiumPkg: typeof import('playwright').chromium): string | null {
  const bundled = chromiumPkg.executablePath();
  if (existsSync(bundled)) return bundled;
  if (process.platform === 'darwin') {
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (existsSync(systemChrome)) return systemChrome;
  }
  return null;
}

describe('UI scale layout geometry in real Chromium', () => {
  it('fills edge-to-edge without black bars or overflow across 60%/90%/100%/125%/150% for root, .layout, SettingsPage, modals, and popovers on desktop (1280x800) and mobile (360x780)', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) {
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
              export const initReactI18next = { type: '3rdParty', init: () => {} };
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

    const browser = await chromium.launch({ executablePath, headless: true });
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

      // Internal SettingsPage button height scales monotonically with zoom while container stays 1280x800.
      // Sidebar preserves visual width at shrink scales (60%/90% ~ 100%) while enlarging (>100%) scales up as before.
      const d60 = desktopScaleRects.find((r) => r.pct === 60)!;
      const d90 = desktopScaleRects.find((r) => r.pct === 90)!;
      const d100 = desktopScaleRects.find((r) => r.pct === 100)!;
      const d125 = desktopScaleRects.find((r) => r.pct === 125)!;
      const d150 = desktopScaleRects.find((r) => r.pct === 150)!;
      expect(d60.incBtnH).toBeLessThan(d90.incBtnH);
      expect(d90.incBtnH).toBeLessThan(d100.incBtnH);
      expect(d100.incBtnH).toBeLessThan(d125.incBtnH);
      expect(d125.incBtnH).toBeLessThan(d150.incBtnH);
      expect(Math.abs(d60.sidebarW - d100.sidebarW)).toBeLessThanOrEqual(2);
      expect(Math.abs(d90.sidebarW - d100.sidebarW)).toBeLessThanOrEqual(2);
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

  it('preserves sidebar visual screen proportion across 60%-95% on desktop <Sidebar>, mobile drawer, and expanded tablet while inner controls scale and drag resize tracks 1:1', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) {
      return;
    }
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(here, '../src/ui-scale.ts');
    const sidebarPath = resolve(here, '../src/components/Sidebar.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { Sidebar } from ${JSON.stringify(sidebarPath)};

          window.__uiScale = uiScale;
          window.__unmountRoot = () => {
            render(null, document.getElementById('root'));
          };
          window.__mountDesktopSidebar = (collapsed = false) => {
            render(
              <div class="layout" data-testid="sidebar-layout">
                <div class="server-icon-bar" style={{ width: '48px', flexShrink: 0 }}>Icons</div>
                <Sidebar collapsed={collapsed} serverId="srv-1">
                  <div class="sidebar-item" style={{ padding: '8px 12px', fontSize: '13px' }}>
                    <button type="button" data-testid="sidebar-inner-btn" style={{ padding: '6px 10px', fontSize: '13px' }}>Item</button>
                  </div>
                </Sidebar>
                <main class="main" data-testid="sidebar-main" style={{ flex: 1, minWidth: 0 }}>Main</main>
              </div>,
              document.getElementById('root'),
            );
          };
          window.__mountMobileSidebarDrawer = (expanded = false) => {
            render(
              <div class={\`layout layout-mobile\${expanded ? ' layout-mobile-expanded' : ''}\`} data-testid="mobile-drawer-layout">
                <div class="mobile-sidebar-overlay open" data-testid="mobile-drawer-overlay">
                  <div class="mobile-sidebar-panel" data-testid="mobile-drawer-panel">
                    <div class="mobile-sidebar-header">
                      <span>IM.codes</span>
                      <button type="button" class="mobile-sidebar-close" data-testid="drawer-close-btn">✕</button>
                    </div>
                    <div class="mobile-sidebar-body"><div>Session</div></div>
                  </div>
                </div>
                <main class="main" data-testid="mobile-drawer-main">Main</main>
              </div>,
              document.getElementById('root'),
            );
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
      define: {
        __BUILD_TIME__: JSON.stringify('2026-05-11T02:34:00.000Z'),
      },
      plugins: [{
        name: 'mock-i18n',
        setup(b) {
          b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'mock-i18n' }));
          b.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({
            contents: `
              export const initReactI18next = { type: '3rdParty', init: () => {} };
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

    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div></body></html>`;

      // 1. Desktop <Sidebar> across 60%, 75%, 90%, 95%, 100%, 125% at 1280x800
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://imcodes.test/');
      await page.addScriptTag({ content: bundleCode });
      await page.evaluate(() => { window.__mountDesktopSidebar(false); });
      await page.waitForTimeout(50);

      const desktopMeasurements: Record<number, { panelW: number; btnH: number; htmlW: number; handleRight: number; handleY: number }> = {};
      for (const pct of [60, 75, 90, 95, 100, 125]) {
        await page.evaluate((s) => { window.__uiScale.writeUiScale(s); }, pct);
        // Wait >200ms CSS width transition so transition completes cleanly
        await page.waitForTimeout(260);
        desktopMeasurements[pct] = await page.evaluate(() => {
          const panel = document.querySelector('.sidebar-panel')!.getBoundingClientRect();
          const btn = document.querySelector('[data-testid="sidebar-inner-btn"]')!.getBoundingClientRect();
          const htmlRect = document.documentElement.getBoundingClientRect();
          const handle = document.querySelector('.sidebar-resize-handle')!.getBoundingClientRect();
          return {
            panelW: panel.width,
            btnH: btn.height,
            htmlW: htmlRect.width,
            handleRight: handle.right,
            handleY: handle.top + handle.height / 2,
          };
        });
        expect(desktopMeasurements[pct].htmlW).toBeLessThanOrEqual(1281.5);
      }

      // 60%–95% keep visual screen width (~380px), while inner button scales down with zoom; 125% still scales up
      for (const pct of [60, 75, 90, 95]) {
        expect(Math.abs(desktopMeasurements[pct].panelW - desktopMeasurements[100].panelW)).toBeLessThanOrEqual(2);
        expect(desktopMeasurements[pct].btnH).toBeLessThan(desktopMeasurements[100].btnH);
      }
      expect(desktopMeasurements[125].panelW).toBeGreaterThan(desktopMeasurements[100].panelW);

      // Real pointer drag at 60% tracks the cursor 1:1 MID-DRAG (no 0.2s transition lag while mouse button is still down)
      await page.evaluate(() => { window.__uiScale.writeUiScale(60); });
      await page.waitForTimeout(260);
      const beforeDrag = await page.evaluate(() => {
        const panel = document.querySelector('.sidebar-panel')!.getBoundingClientRect();
        const handle = document.querySelector('.sidebar-resize-handle')!.getBoundingClientRect();
        return { panelW: panel.width, panelRight: panel.right, x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
      });
      await page.mouse.move(beforeDrag.x, beforeDrag.y);
      await page.mouse.down();
      await page.mouse.move(beforeDrag.x + 80, beforeDrag.y, { steps: 5 });
      const midDrag = await page.evaluate(() => new Promise<{ panelW: number; panelRight: number; resizing: boolean }>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const panel = document.querySelector('.sidebar-panel') as HTMLElement;
          const rect = panel.getBoundingClientRect();
          resolve({
            panelW: rect.width,
            panelRight: rect.right,
            resizing: panel.classList.contains('sidebar-panel-resizing'),
          });
        }));
      }));
      expect(midDrag.resizing).toBe(true);
      expect(Math.abs(midDrag.panelW - (beforeDrag.panelW + 80))).toBeLessThanOrEqual(2);
      expect(Math.abs(midDrag.panelRight - (beforeDrag.panelRight + 80))).toBeLessThanOrEqual(2);
      await page.mouse.up();
      await page.waitForTimeout(40);
      const afterDrag = await page.evaluate(() => {
        const panel = document.querySelector('.sidebar-panel') as HTMLElement;
        return {
          panelW: panel.getBoundingClientRect().width,
          resizing: panel.classList.contains('sidebar-panel-resizing'),
          stored: localStorage.getItem('sidebar_width'),
        };
      });
      expect(afterDrag.resizing).toBe(false);
      expect(Math.abs(afterDrag.panelW - (beforeDrag.panelW + 80))).toBeLessThanOrEqual(2);
      expect(afterDrag.stored).toBe('460');

      // Enlarged scale (125%) preserves both original transition (0.2s mid-drag) and direct clientX delta (380 + 80 -> 460 / ~575px)
      await page.evaluate(() => {
        window.__unmountRoot();
        localStorage.removeItem('sidebar_width');
        window.__uiScale.writeUiScale(125);
        window.__mountDesktopSidebar(false);
      });
      await page.waitForTimeout(260);
      const beforeDrag125 = await page.evaluate(() => {
        const handle = document.querySelector('.sidebar-resize-handle')!.getBoundingClientRect();
        return { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
      });
      await page.mouse.move(beforeDrag125.x, beforeDrag125.y);
      await page.mouse.down();
      await page.mouse.move(beforeDrag125.x + 80, beforeDrag125.y, { steps: 5 });
      const midDrag125 = await page.evaluate(() => {
        const panel = document.querySelector('.sidebar-panel') as HTMLElement;
        return {
          resizingClass: panel.classList.contains('sidebar-panel-resizing'),
          transitionDuration: getComputedStyle(panel).transitionDuration,
        };
      });
      expect(midDrag125.resizingClass).toBe(false);
      expect(midDrag125.transitionDuration).toBe('0.2s');
      await page.mouse.up();
      expect(await page.evaluate(() => localStorage.getItem('sidebar_width'))).toBe('460');
      await page.waitForTimeout(260);
      const settledWidth125 = await page.evaluate(() => document.querySelector('.sidebar-panel')!.getBoundingClientRect().width);
      expect(Math.abs(settledWidth125 - 460 * 1.25)).toBeLessThanOrEqual(2);
      await page.evaluate(() => {
        window.__unmountRoot();
        localStorage.removeItem('sidebar_width');
        window.__uiScale.writeUiScale(60);
        window.__mountDesktopSidebar(false);
      });
      await page.waitForTimeout(260);

      // Collapsed stays 0px at 60%
      await page.evaluate(() => { window.__mountDesktopSidebar(true); });
      await page.waitForTimeout(260);
      const collapsedW = await page.evaluate(() => document.querySelector('.sidebar-panel')!.getBoundingClientRect().width);
      expect(collapsedW).toBe(0);

      // Narrow desktop (900x700) with max width 560px at 60% stays inside 900px without horizontal overflow
      await page.setViewportSize({ width: 900, height: 700 });
      await page.evaluate(() => {
        window.__unmountRoot();
        localStorage.setItem('sidebar_width', '560');
        window.__mountDesktopSidebar(false);
      });
      await page.waitForTimeout(260);
      const narrowMetrics = await page.evaluate(() => ({
        panelW: document.querySelector('.sidebar-panel')!.getBoundingClientRect().width,
        htmlW: document.documentElement.getBoundingClientRect().width,
        scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(Math.abs(narrowMetrics.panelW - 560)).toBeLessThanOrEqual(2);
      expect(narrowMetrics.htmlW).toBeLessThanOrEqual(901.5);
      expect(narrowMetrics.scrollOverflow).toBeLessThanOrEqual(1);

      // 2. Mobile drawer (360x780) & expanded foldable/tablet drawer (1024x768)
      await page.setViewportSize({ width: 360, height: 780 });
      await page.evaluate(() => { window.__mountMobileSidebarDrawer(false); });
      await page.waitForTimeout(280);
      const mobileDrawerWidths: Record<number, number> = {};
      for (const pct of [60, 75, 90, 100]) {
        await page.evaluate((s) => { window.__uiScale.writeUiScale(s); }, pct);
        await page.waitForTimeout(50);
        mobileDrawerWidths[pct] = await page.evaluate(() => document.querySelector('[data-testid="mobile-drawer-panel"]')!.getBoundingClientRect().width);
        expect(mobileDrawerWidths[pct]).toBeLessThanOrEqual(360 * 0.88 + 2);
      }
      for (const pct of [60, 75, 90]) {
        expect(Math.abs(mobileDrawerWidths[pct] - mobileDrawerWidths[100])).toBeLessThanOrEqual(2);
      }

      await page.setViewportSize({ width: 1024, height: 768 });
      await page.evaluate(() => { window.__mountMobileSidebarDrawer(true); });
      await page.waitForTimeout(280);
      const expandedMetrics: Record<number, { panelW: number; mainLeft: number }> = {};
      for (const pct of [60, 75, 90, 100]) {
        await page.evaluate((s) => { window.__uiScale.writeUiScale(s); }, pct);
        await page.waitForTimeout(50);
        expandedMetrics[pct] = await page.evaluate(() => ({
          panelW: document.querySelector('[data-testid="mobile-drawer-panel"]')!.getBoundingClientRect().width,
          mainLeft: document.querySelector('[data-testid="mobile-drawer-main"]')!.getBoundingClientRect().left,
        }));
      }
      for (const pct of [60, 75, 90]) {
        expect(Math.abs(expandedMetrics[pct].panelW - expandedMetrics[100].panelW)).toBeLessThanOrEqual(2);
        expect(Math.abs(expandedMetrics[pct].mainLeft - expandedMetrics[pct].panelW)).toBeLessThanOrEqual(2);
      }

      await page.close();
    } finally {
      await browser.close();
    }
  });

  async function buildOnlyOfficeFixtureAssets() {
    const require = createRequire(import.meta.url);
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(here, '../src/ui-scale.ts');
    const viewportPath = resolve(here, '../src/visual-viewport.ts');
    const onlyOfficeZoomPath = resolve(here, '../src/onlyoffice-zoom.ts');

    const compiled = await build({
      stdin: {
        contents: `
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { boundedVisualViewportHeight } from ${JSON.stringify(viewportPath)};
          import { observeOnlyOfficeEditorHostGeometry } from ${JSON.stringify(onlyOfficeZoomPath)};

          window.__uiScale = uiScale;
          window.__syncViewportVars = (withVvh = true) => {
            if (!withVvh) {
              document.documentElement.style.removeProperty('--vvh');
              return;
            }
            const z = uiScale.getActiveCssZoom();
            const vh = boundedVisualViewportHeight(window.innerHeight, window.innerHeight, document.documentElement.clientHeight, z);
            if (vh !== null) {
              document.documentElement.style.setProperty('--vvh', Math.round(vh / z) + 'px');
            }
          };

          const embeddedStyle = (fullscreen) => fullscreen
            ? 'display:flex;flex-direction:column;width:100%;height:var(--vvh,100%);max-height:var(--vvh,100%);min-height:var(--vvh,100%);overflow:hidden;box-sizing:border-box;position:fixed;inset:0;z-index:9999;background:#0f172a;'
            : 'display:flex;flex-direction:column;flex:1 1 0;width:100%;height:100%;max-height:100%;min-height:0;overflow:hidden;position:relative;background:#0f172a;';

          const editorInnerHtml = (fullscreen) => \`
            <div class="office-preview-embedded\${fullscreen ? ' is-fullscreen' : ''}" data-testid="oo-embedded" style="\${embeddedStyle(fullscreen)}">
              <div class="office-preview-toolbar" style="height:32px;flex-shrink:0;">Toolbar</div>
              <div class="office-preview-editor-wrap" data-testid="oo-wrap" style="flex:1 1 0;width:100%;min-width:0;min-height:0;position:relative;overflow:hidden;">
                <div class="office-preview-editor-host" data-testid="oo-host">
                  <iframe
                    data-testid="oo-iframe"
                    srcdoc="<!doctype html><html style='margin:0;width:100%;height:100%'><body style='margin:0;width:100%;height:100%;background:#1e293b'><div id='oo-canvas' style='width:100%;height:100%;background:#22c55e'></div></body></html>"
                  ></iframe>
                </div>
              </div>
            </div>
          \`;

          let cleanupObserver = null;
          window.__mountOnlyOfficeShell = (entry = 'cloud-docs', fullscreen = false) => {
            if (cleanupObserver) {
              cleanupObserver();
              cleanupObserver = null;
            }
            const root = document.getElementById('oo-shell-root');
            if (entry === 'file-browser') {
              root.innerHTML = \`
                <div class="mobile-fb-overlay">
                  <div class="fb-panel" style="flex:1;min-height:0;display:flex;flex-direction:column;">
                    <div class="fb-body-split" style="flex:1;min-height:0;display:flex;">
                      <div class="fb-preview" data-testid="oo-shell">
                        <div class="fb-preview-header" style="height:36px;flex-shrink:0;">File</div>
                        \${editorInnerHtml(fullscreen)}
                      </div>
                    </div>
                  </div>
                </div>
              \`;
            } else {
              root.innerHTML = \`
                <div class="floating-panel is-mobile" data-testid="oo-shell" style="position:fixed;inset:0;width:var(--imcodes-ui-vw,100%);height:var(--vvh,var(--imcodes-ui-dvh));max-height:var(--vvh,var(--imcodes-ui-dvh));display:flex;flex-direction:column;background:#0f172a;">
                  <div class="floating-panel-content" style="flex:1;min-height:0;display:flex;flex-direction:column;">
                    <div class="cloud-docs-panel" style="flex:1;min-height:0;display:flex;flex-direction:column;">
                      <div class="cloud-docs-preview-header" style="height:40px;flex-shrink:0;">Preview Header</div>
                      <div class="cloud-docs-preview-stage" style="flex:1 1 0;min-height:0;display:flex;flex-direction:column;">
                        \${editorInnerHtml(fullscreen)}
                      </div>
                    </div>
                  </div>
                </div>
              \`;
            }
            const wrap = root.querySelector('[data-testid="oo-wrap"]');
            const host = root.querySelector('[data-testid="oo-host"]');
            cleanupObserver = observeOnlyOfficeEditorHostGeometry(wrap, host);
          };

          window.__setOnlyOfficeFullscreen = (fullscreen) => {
            const embedded = document.querySelector('[data-testid="oo-embedded"]');
            if (!embedded) return;
            embedded.classList.toggle('is-fullscreen', fullscreen);
            embedded.setAttribute('style', embeddedStyle(fullscreen));
          };

          window.__measureOnlyOfficeGeometry = () => {
            const shell = document.querySelector('[data-testid="oo-shell"]').getBoundingClientRect();
            const embedded = document.querySelector('[data-testid="oo-embedded"]').getBoundingClientRect();
            const wrap = document.querySelector('[data-testid="oo-wrap"]').getBoundingClientRect();
            const host = document.querySelector('[data-testid="oo-host"]').getBoundingClientRect();
            const iframe = document.querySelector('[data-testid="oo-iframe"]');
            const ir = iframe.getBoundingClientRect();
            const canvas = iframe.contentDocument?.getElementById('oo-canvas')?.getBoundingClientRect() ?? null;
            return {
              vw: window.innerWidth,
              vh: window.innerHeight,
              shell: { left: shell.left, top: shell.top, width: shell.width, height: shell.height },
              embedded: { left: embedded.left, top: embedded.top, width: embedded.width, height: embedded.height },
              wrap: { left: wrap.left, top: wrap.top, width: wrap.width, height: wrap.height },
              host: { left: host.left, top: host.top, width: host.width, height: host.height },
              iframe: { left: ir.left, top: ir.top, width: ir.width, height: ir.height },
              innerWin: { width: iframe.contentWindow?.innerWidth ?? 0, height: iframe.contentWindow?.innerHeight ?? 0 },
              canvas: canvas ? { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height } : null,
            };
          };
        `,
        resolveDir: here,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
    });

    const bundleJs = compiled.outputFiles[0]!.text;
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="oo-shell-root"></div></body>
</html>`;
    return { css, bundleJs, html };
  }

  function assertOnlyOfficeGeometry(
    g: {
      vw: number;
      vh: number;
      shell: { left: number; top: number; width: number; height: number };
      embedded: { left: number; top: number; width: number; height: number };
      wrap: { left: number; top: number; width: number; height: number };
      iframe: { left: number; top: number; width: number; height: number };
      innerWin: { width: number; height: number };
      canvas: { left: number; top: number; width: number; height: number } | null;
    },
    fullscreen: boolean,
    label: string,
  ): void {
    expect(g.canvas, `${label} inner canvas`).toBeTruthy();
    expect(Math.abs(g.shell.left), `${label} shell left`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.shell.top), `${label} shell top`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.shell.width - g.vw), `${label} shell width`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.shell.height - g.vh), `${label} shell height`).toBeLessThanOrEqual(2);
    if (fullscreen) {
      expect(Math.abs(g.embedded.left), `${label} fs left`).toBeLessThanOrEqual(2);
      expect(Math.abs(g.embedded.top), `${label} fs top`).toBeLessThanOrEqual(2);
      expect(Math.abs(g.embedded.width - g.vw), `${label} fs width`).toBeLessThanOrEqual(2);
      expect(Math.abs(g.embedded.height - g.vh), `${label} fs height`).toBeLessThanOrEqual(2);
    } else {
      expect(Math.abs(g.embedded.width - g.vw), `${label} embedded width`).toBeLessThanOrEqual(2);
      expect(g.embedded.top + g.embedded.height, `${label} embedded bottom`).toBeLessThanOrEqual(g.vh + 2);
    }
    expect(Math.abs(g.iframe.left - g.wrap.left), `${label} iframe left`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.iframe.top - g.wrap.top), `${label} iframe top`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.iframe.width - g.wrap.width), `${label} iframe width`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.iframe.height - g.wrap.height), `${label} iframe height`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.innerWin.width - g.wrap.width), `${label} innerWin width`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.innerWin.height - g.wrap.height), `${label} innerWin height`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.canvas!.width - g.wrap.width), `${label} canvas width`).toBeLessThanOrEqual(2);
    expect(Math.abs(g.canvas!.height - g.wrap.height), `${label} canvas height`).toBeLessThanOrEqual(2);
  }

  it('fills ONLYOFFICE shell, fullscreen, and iframe 100% edge-to-edge in Chromium across 60%-150% UI scale with/without --vvh, standalone UI_SCALE_EVENT, and resize', { timeout: 60000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { css, bundleJs, html } = await buildOnlyOfficeFixtureAssets();
    const browser = await chromium.launch({ headless: true });
    try {
      const scales = [60, 75, 85, 100, 125, 150];
      const matrix: Array<{ entry: 'cloud-docs' | 'file-browser'; width: number; height: number }> = [
        { entry: 'cloud-docs', width: 1280, height: 800 },
        { entry: 'cloud-docs', width: 390, height: 844 },
        { entry: 'file-browser', width: 390, height: 844 },
      ];

      for (const target of matrix) {
        const page = await browser.newPage({ viewport: { width: target.width, height: target.height } });
        await page.setContent(html);
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundleJs });

        await page.evaluate((entry) => {
          (window as unknown as { __mountOnlyOfficeShell: (e: string, fs: boolean) => void }).__mountOnlyOfficeShell(entry, false);
        }, target.entry);
        await page.waitForSelector('[data-testid="oo-iframe"]');

        for (const withVvh of [true, false]) {
          for (const pct of scales) {
            for (const fullscreen of [false, true, false]) {
              await page.evaluate(({ scalePct, fs, vvh }) => {
                const w = window as unknown as {
                  __uiScale: { writeUiScale: (s: number) => void };
                  __syncViewportVars: (withVvh: boolean) => void;
                  __setOnlyOfficeFullscreen: (f: boolean) => void;
                };
                w.__uiScale.writeUiScale(scalePct);
                w.__syncViewportVars(vvh);
                w.__setOnlyOfficeFullscreen(fs);
              }, { scalePct: pct, fs: fullscreen, vvh: withVvh });
              await page.waitForTimeout(40);

              const g = await page.evaluate(() => (
                window as unknown as { __measureOnlyOfficeGeometry: () => ReturnType<never> }
              ).__measureOnlyOfficeGeometry());
              assertOnlyOfficeGeometry(g, fullscreen, `chromium ${target.entry} ${target.width}x${target.height} vvh=${withVvh} ${pct}% fs=${fullscreen}`);
            }
          }
        }

        // Standalone UI_SCALE_EVENT only (75% -> 125% -> 60% -> 100%, no viewport resize or fullscreen toggle)
        await page.evaluate(() => {
          const w = window as unknown as {
            __syncViewportVars: (withVvh: boolean) => void;
            __setOnlyOfficeFullscreen: (f: boolean) => void;
          };
          w.__syncViewportVars(false);
          w.__setOnlyOfficeFullscreen(false);
        });
        for (const pct of [75, 125, 60, 100]) {
          await page.evaluate((scalePct) => {
            (window as unknown as { __uiScale: { writeUiScale: (s: number) => void } }).__uiScale.writeUiScale(scalePct);
          }, pct);
          await page.waitForTimeout(40);
          const g = await page.evaluate(() => (
            window as unknown as { __measureOnlyOfficeGeometry: () => ReturnType<never> }
          ).__measureOnlyOfficeGeometry());
          assertOnlyOfficeGeometry(g, false, `chromium standalone UI_SCALE_EVENT ${target.entry} ${pct}%`);
        }

        // Standalone viewport resize on mobile (390x844 -> 844x390 -> 390x844 at 75% without re-calling sync)
        if (target.width === 390 && target.entry === 'cloud-docs') {
          await page.evaluate(() => {
            (window as unknown as { __uiScale: { writeUiScale: (s: number) => void }; __syncViewportVars: (v: boolean) => void }).__uiScale.writeUiScale(75);
            (window as unknown as { __syncViewportVars: (v: boolean) => void }).__syncViewportVars(false);
          });
          await page.setViewportSize({ width: 844, height: 390 });
          await page.waitForTimeout(50);
          const gLand = await page.evaluate(() => (
            window as unknown as { __measureOnlyOfficeGeometry: () => ReturnType<never> }
          ).__measureOnlyOfficeGeometry());
          assertOnlyOfficeGeometry(gLand, false, 'chromium standalone resize 844x390 @75%');
        }

        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('fills ONLYOFFICE shell, fullscreen, and iframe 100% edge-to-edge in real WebKitGTK across 60%-150% UI scale with/without --vvh, standalone UI_SCALE_EVENT, and resize', { timeout: 60000 }, async () => {
    let hasWebKitGtk = existsSync('/usr/bin/python3');
    if (hasWebKitGtk) {
      try {
        execFileSync('which', ['xvfb-run'], { stdio: 'ignore' });
        execFileSync('/usr/bin/python3', ['-c', "import gi; gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')"], { stdio: 'ignore' });
      } catch {
        hasWebKitGtk = false;
      }
    }
    if (!hasWebKitGtk) {
      return;
    }

    const { css, bundleJs, html } = await buildOnlyOfficeFixtureAssets();
    const fullHtml = html
      .replace('</head>', `<style>${css}</style></head>`)
      .replace('</body>', `<script>${bundleJs}</script></body>`);
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-oo-webkit-'));
    try {
      const htmlPath = join(dir, 'fixture.html');
      const pyPath = join(dir, 'verify.py');
      writeFileSync(htmlPath, fullHtml, 'utf8');
      writeFileSync(pyPath, `import json, pathlib, sys
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2

source = pathlib.Path(sys.argv[1]).resolve().as_uri()
step_js = """
const waitSettled = async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const deadline = performance.now() + 300;
  while (performance.now() < deadline) {
    const g = window.__measureOnlyOfficeGeometry();
    if (
      Math.abs(g.iframe.width - g.wrap.width) <= 2
      && Math.abs(g.iframe.height - g.wrap.height) <= 2
    ) {
      return g;
    }
    await new Promise(r => setTimeout(r, 16));
  }
  return window.__measureOnlyOfficeGeometry();
};
const results = [];
const currentW = window.innerWidth;
const currentH = window.innerHeight;
const targetEntries = currentW === 390 ? ['cloud-docs', 'file-browser'] : ['cloud-docs'];
for (const entry of targetEntries) {
  window.__mountOnlyOfficeShell(entry, false);
  const iframe = document.querySelector('[data-testid=oo-iframe]');
  await new Promise(resolve => {
    if (iframe.contentDocument?.getElementById('oo-canvas')) resolve();
    else iframe.addEventListener('load', resolve, { once: true });
  });
  for (const withVvh of [true, false]) {
    for (const pct of [60, 75, 85, 100, 125, 150]) {
      for (const full of [false, true, false]) {
        window.__uiScale.writeUiScale(pct);
        window.__syncViewportVars(withVvh);
        window.__setOnlyOfficeFullscreen(full);
        const metrics = await waitSettled();
        results.push({ label: entry + ' ' + currentW + 'x' + currentH + ' vvh=' + withVvh + ' ' + pct + '% fs=' + full, full, metrics });
      }
    }
  }
  window.__syncViewportVars(false);
  window.__setOnlyOfficeFullscreen(false);
  for (const pct of [75, 125, 60, 100]) {
    window.__uiScale.writeUiScale(pct);
    const metrics = await waitSettled();
    results.push({ label: 'standalone UI_SCALE_EVENT ' + entry + ' ' + currentW + 'x' + currentH + ' ' + pct + '%', full: false, metrics });
  }
}
return JSON.stringify(results);
"""

all_rows = []
windows = []

def run_window(width, height, phase):
    win = Gtk.Window()
    win.set_default_size(width, height)
    view = WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral())
    win.add(view)
    windows.append(win)

    def on_done(w, res, *args):
        val = w.call_async_javascript_function_finish(res)
        parsed = json.loads(val.to_string())
        if isinstance(parsed, list):
            all_rows.extend(parsed)
        else:
            all_rows.append(parsed)
        if phase == 0:
            GLib.idle_add(run_window, 1280, 800, 1)
        elif phase == 1:
            def do_resize(*_a):
                win.resize(844, 390)
                GLib.timeout_add(80, after_resize)
                return GLib.SOURCE_REMOVE
            def after_resize(*_a):
                w.call_async_javascript_function("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return JSON.stringify({ label: 'webkit standalone gtk resize ' + window.innerWidth + 'x' + window.innerHeight + ' @75%', full: false, metrics: window.__measureOnlyOfficeGeometry() });", -1, None, None, None, None, on_resize_done, None)
                return GLib.SOURCE_REMOVE
            w.call_async_javascript_function("window.__mountOnlyOfficeShell('cloud-docs', false); window.__uiScale.writeUiScale(75); window.__syncViewportVars(false); return 'ok';", -1, None, None, None, None, do_resize, None)
        else:
            print(json.dumps(all_rows))
            Gtk.main_quit()

    def on_resize_done(w, res, *args):
        val = w.call_async_javascript_function_finish(res)
        all_rows.append(json.loads(val.to_string()))
        print(json.dumps(all_rows))
        Gtk.main_quit()

    def on_load(w, event):
        if event == WebKit2.LoadEvent.FINISHED:
            w.call_async_javascript_function(step_js, -1, None, None, None, None, on_done, None)

    view.connect('load-changed', on_load)
    win.show_all()
    view.load_uri(source)
    return GLib.SOURCE_REMOVE

GLib.timeout_add_seconds(50, lambda: (sys.stderr.write('WebKitGTK timeout\\n'), sys.exit(2), False)[-1])
run_window(390, 844, 0)
Gtk.main()
`, 'utf8');

      const stdout = await new Promise<string>((resolveOut, rejectOut) => {
        execFile('xvfb-run', ['-a', '/usr/bin/python3', pyPath, htmlPath], { maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
          if (err) {
            rejectOut(new Error(`WebKitGTK failed: ${err.message}\n${stderr}\n${out}`));
            return;
          }
          resolveOut(out);
        });
      });

      const rows = JSON.parse(stdout.trim().split('\n').pop()!) as Array<{
        label: string;
        full: boolean;
        metrics: Parameters<typeof assertOnlyOfficeGeometry>[0];
      }>;
      expect(rows.length).toBeGreaterThan(30);
      for (const row of rows) {
        assertOnlyOfficeGeometry(row.metrics, row.full, `webkit ${row.label}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scrolls ChatView smoothly at 75% and 85% mobile UI zoom without idle upward jumps', async () => {
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const hereDir = import.meta.dirname;
    const css = readFileSync(resolve(hereDir, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(hereDir, '../src/ui-scale.ts');
    const chatViewPath = resolve(hereDir, '../src/components/ChatView.tsx');

    const bundleResult = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { ChatView } from ${JSON.stringify(chatViewPath)};

          window.__uiScale = uiScale;
          const makeEvents = (count) => Array.from({ length: count }, (_, i) => ({
            eventId: 'evt-' + i,
            type: i % 2 ? 'user.message' : 'assistant.text',
            ts: 1000 + i,
            epoch: 1,
            seq: i,
            sessionId: 'pw-zoom-chat',
            source: 'daemon',
            confidence: 'high',
            payload: {
              text: 'Message #' + i + '\\nLine 2 with padding text for multi-line height calibration.\\nLine 3 more text.',
              streaming: false,
            },
          }));
          window.__mountChat = () => {
            render(
              <ChatView
                events={makeEvents(42)}
                loading={false}
                hasOlderHistory={false}
                sessionId="pw-zoom-chat"
                visible={true}
                hideFilePanel={true}
                hideTaskPairPanel={true}
              />,
              document.getElementById('chat-root'),
            );
          };
        `,
        resolveDir: resolve(hereDir, '..'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      nodePaths: [resolve(hereDir, '../node_modules')],
      plugins: [
        {
          name: 'mock-i18n',
          setup(b) {
            b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'mock-i18n', namespace: 'mock-i18n' }));
            b.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({
              contents: 'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en" } }); export const Trans = ({ children }) => children;',
            }));
          },
        },
      ],
    });
    const bundleCode = bundleResult.outputFiles[0].text;
    const chatHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>
      html, body, #chat-root { margin: 0; padding: 0; width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      #chat-root > .chat-view-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    </style></head><body><div id="chat-root"></div></body></html>`;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: chatHtml }));
      await page.goto('https://imcodes.test/');
      await page.addScriptTag({ content: bundleCode });
      await page.evaluate(() => {
        window.__uiScale.writeUiScale(75);
        window.__mountChat();
      });
      await page.waitForTimeout(250);

      for (const pct of [75, 85]) {
        const expectedZoom = pct / 100;
        await page.evaluate((scalePct) => {
          window.__uiScale.writeUiScale(scalePct);
        }, pct);
        await page.waitForTimeout(220);
        const initInfo = await page.evaluate(() => {
          const chatEl = document.querySelector('.chat-view') as HTMLElement;
          chatEl.scrollTop = chatEl.scrollHeight;
          return {
            scale: window.__uiScale.getDomRectToLayoutScale(chatEl),
            scrollHeight: chatEl.scrollHeight,
            clientHeight: chatEl.clientHeight,
            scrollTop: chatEl.scrollTop,
          };
        });
        await page.waitForTimeout(200);

        expect(initInfo.scale).toBeCloseTo(expectedZoom, 2);
        expect(initInfo.scrollHeight).toBeGreaterThan(initInfo.clientHeight + 500);

        // Smooth wheel scroll upward from bottom in bounded steps; verify monotonic downward scrollTop delta & zero idle jump
        await page.mouse.move(180, 350);
        const tops: number[] = [await page.evaluate(() => (document.querySelector('.chat-view') as HTMLElement).scrollTop)];
        for (let step = 0; step < 8; step++) {
          await page.mouse.wheel(0, -180);
          await page.waitForTimeout(60);
          const currentTop = await page.evaluate(() => (document.querySelector('.chat-view') as HTMLElement).scrollTop);
          tops.push(currentTop);
        }
        // Must have scrolled meaningfully upward overall without bouncing back upward wildly
        expect(tops[tops.length - 1]).toBeLessThan(tops[0] - 200);
        for (let i = 1; i < tops.length; i++) {
          expect(tops[i] - tops[i - 1]).toBeLessThanOrEqual(2);
        }

        // Wait > 200ms idle settle (reconcileIdle / ResizeObserver settle) and verify no sudden jump (both scrollTop and anchored row)
        const beforeIdle = await page.evaluate(() => {
          const chatEl = document.querySelector('.chat-view') as HTMLElement;
          const chatTop = chatEl.getBoundingClientRect().top;
          const rows = [...chatEl.querySelectorAll<HTMLElement>('[data-event-id]')];
          const anchor = rows.find((r) => r.getBoundingClientRect().bottom > chatTop + 4);
          return {
            scrollTop: chatEl.scrollTop,
            anchorId: anchor?.getAttribute('data-event-id') ?? null,
            anchorTop: anchor ? anchor.getBoundingClientRect().top - chatTop : null,
          };
        });
        await page.waitForTimeout(320);
        const afterIdle = await page.evaluate((anchorId) => {
          const chatEl = document.querySelector('.chat-view') as HTMLElement;
          const chatTop = chatEl.getBoundingClientRect().top;
          const anchor = anchorId ? chatEl.querySelector<HTMLElement>(`[data-event-id="${anchorId}"]`) : null;
          return {
            scrollTop: chatEl.scrollTop,
            anchorTop: anchor ? anchor.getBoundingClientRect().top - chatTop : null,
          };
        }, beforeIdle.anchorId);
        expect(Math.abs(afterIdle.scrollTop - beforeIdle.scrollTop)).toBeLessThanOrEqual(4);
        if (beforeIdle.anchorTop !== null && afterIdle.anchorTop !== null) {
          expect(Math.abs(afterIdle.anchorTop - beforeIdle.anchorTop)).toBeLessThanOrEqual(2);
        }
      }

      // Live scale switch back to 100% aligns scale=1, keeps the visible anchor steady, and settles cleanly with no idle drift
      const beforeReset = await page.evaluate(() => {
        const chatEl = document.querySelector('.chat-view') as HTMLElement;
        const rectScale = window.__uiScale.getDomRectToLayoutScale(chatEl);
        const top = chatEl.getBoundingClientRect().top;
        const rows = [...chatEl.querySelectorAll<HTMLElement>('[data-event-id]')];
        const anchor = rows.find((r) => r.getBoundingClientRect().bottom > top + 4);
        return {
          anchorId: anchor?.getAttribute('data-event-id') ?? null,
          relTop: anchor ? (anchor.getBoundingClientRect().top - top) / rectScale : null,
        };
      });
      await page.evaluate(() => {
        window.__uiScale.writeUiScale(100);
      });
      await page.waitForTimeout(220);
      const resetSettled = await page.evaluate((anchorId) => {
        const chatEl = document.querySelector('.chat-view') as HTMLElement;
        const top = chatEl.getBoundingClientRect().top;
        const anchor = anchorId ? chatEl.querySelector<HTMLElement>(`[data-event-id="${anchorId}"]`) : null;
        return {
          scale: window.__uiScale.getDomRectToLayoutScale(chatEl),
          scrollTop: chatEl.scrollTop,
          relTop: anchor ? anchor.getBoundingClientRect().top - top : null,
        };
      }, beforeReset.anchorId);
      await page.waitForTimeout(260);
      const afterResetIdle = await page.evaluate(() => (document.querySelector('.chat-view') as HTMLElement).scrollTop);
      expect(resetSettled.scale).toBe(1);
      if (beforeReset.relTop !== null && resetSettled.relTop !== null) {
        expect(Math.abs(resetSettled.relTop - beforeReset.relTop)).toBeLessThanOrEqual(4);
      }
      expect(Math.abs(afterResetIdle - resetSettled.scrollTop)).toBeLessThanOrEqual(4);
      expect(errors).toEqual([]);

      await page.close();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('preserves first visible anchor message and follow-bottom across live 75% -> 85% -> 100% UI_SCALE_EVENT on long multi-line messages', async () => {
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const hereDir = import.meta.dirname;
    const css = readFileSync(resolve(hereDir, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(hereDir, '../src/ui-scale.ts');
    const chatViewPath = resolve(hereDir, '../src/components/ChatView.tsx');

    const bundleResult = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import { ChatView } from ${JSON.stringify(chatViewPath)};

          window.__uiScale = uiScale;
          const makeLongEvents = (count) => Array.from({ length: count }, (_, i) => ({
            eventId: 'evt-' + i,
            type: i % 2 ? 'user.message' : 'assistant.text',
            ts: 1000 + i,
            epoch: 1,
            seq: i,
            sessionId: 'pw-live-scale-anchor',
            source: 'daemon',
            confidence: 'high',
            payload: {
              text: Array.from({ length: 14 }, (_, j) => 'Example ' + i + ' / ' + j).join('\\n'),
              streaming: false,
            },
          }));
          window.__mountLongChat = () => {
            render(
              <ChatView
                events={makeLongEvents(42)}
                loading={false}
                hasOlderHistory={false}
                sessionId="pw-live-scale-anchor"
                visible={true}
                hideFilePanel={true}
                hideTaskPairPanel={true}
              />,
              document.getElementById('chat-root'),
            );
          };
        `,
        resolveDir: resolve(hereDir, '..'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      nodePaths: [resolve(hereDir, '../node_modules')],
      plugins: [
        {
          name: 'mock-i18n',
          setup(b) {
            b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'mock-i18n', namespace: 'mock-i18n' }));
            b.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({
              contents: 'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en" } }); export const Trans = ({ children }) => children;',
            }));
          },
        },
      ],
    });
    const bundleCode = bundleResult.outputFiles[0].text;
    const chatHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>
      html, body, #chat-root { margin: 0; padding: 0; width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      #chat-root > .chat-view-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    </style></head><body><div id="chat-root"></div></body></html>`;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: chatHtml }));
      await page.goto('https://imcodes.test/');
      await page.addScriptTag({ content: bundleCode });
      await page.evaluate(() => {
        window.__uiScale.writeUiScale(75);
        window.__mountLongChat();
      });
      await page.waitForTimeout(320);

      // 1. Follow-bottom state is preserved across live 75% -> 85% -> 75% transitions
      await page.evaluate(() => window.__uiScale.writeUiScale(85));
      await page.waitForTimeout(350);
      const followAfter85 = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        return { dist: el.scrollHeight - el.scrollTop - el.clientHeight, hasBtn: Boolean(document.querySelector('.chat-scroll-btn')) };
      });
      expect(followAfter85.dist).toBeLessThanOrEqual(24);
      expect(followAfter85.hasBtn).toBe(false);

      // Reset back to 75%, scroll up into mid-history, settle, then verify 75% -> 85% -> 100% preserves first visible row & relative layout offset
      await page.evaluate(() => window.__uiScale.writeUiScale(75));
      await page.waitForTimeout(300);
      await page.mouse.move(180, 350);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(55);
      }
      await page.waitForTimeout(350);

      const snapshotVisible = () => page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        const rectScale = window.__uiScale.getDomRectToLayoutScale(el);
        const bounds = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll<HTMLElement>('[data-event-id]')];
        const anchor = rows.find((n) => n.getBoundingClientRect().bottom > bounds.top + 4);
        const oldId = (window as unknown as { __auditAnchorId?: string }).__auditAnchorId;
        const oldEl = oldId ? rows.find((n) => n.getAttribute('data-event-id') === oldId) : null;
        return {
          anchorId: anchor?.getAttribute('data-event-id') ?? null,
          layoutRelOffset: anchor ? (anchor.getBoundingClientRect().top - bounds.top) / rectScale : -9999,
          previousVisible: Boolean(oldEl && oldEl.getBoundingClientRect().bottom > bounds.top && oldEl.getBoundingClientRect().top < bounds.bottom),
          scrollTop: el.scrollTop,
        };
      });

      const before = await snapshotVisible();
      expect(before.anchorId).toBeTruthy();
      expect(before.anchorId).not.toBe('evt-41');

      await page.evaluate((id) => {
        (window as unknown as { __auditAnchorId?: string }).__auditAnchorId = id ?? undefined;
        window.__uiScale.writeUiScale(85);
      }, before.anchorId);
      await page.waitForTimeout(420);
      const after85 = await snapshotVisible();
      expect(after85.anchorId).toBe(before.anchorId);
      expect(after85.previousVisible).toBe(true);
      expect(Math.abs(after85.layoutRelOffset - before.layoutRelOffset)).toBeLessThanOrEqual(4);

      await page.evaluate(() => window.__uiScale.writeUiScale(100));
      await page.waitForTimeout(420);
      const after100 = await snapshotVisible();
      expect(after100.anchorId).toBe(before.anchorId);
      expect(after100.previousVisible).toBe(true);
      expect(Math.abs(after100.layoutRelOffset - before.layoutRelOffset)).toBeLessThanOrEqual(4);
      expect(errors).toEqual([]);

      await page.close();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps SessionTabs top-left corner badges zero-growth and unclipped at left scroll edge, narrow viewports, and two-digit labels in real Chromium', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) {
      return;
    }
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    const sessionTabsPath = resolve(here, '../src/components/SessionTabs.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import { SessionTabs } from ${JSON.stringify(sessionTabsPath)};

          window.__mountTabs = (activeName) => {
            const mount = document.getElementById('tabs-mount');
            const sessions = Array.from({ length: 18 }, (_, i) => ({
              name: \`sess_\${i + 1}\`,
              project: \`proj-\${i + 1}\`,
              label: i === 9 ? 'tenth-tab' : \`tab-\${i + 1}\`,
              role: i === 0 ? 'brain' : \`w\${i}\`,
              agentType: i === 0 ? 'claude-code-sdk' : 'codex-sdk',
              state: 'idle',
            }));
            render(
              <SessionTabs
                sessions={sessions}
                activeSession={activeName}
                connected={true}
                latencyMs={18}
                onSelect={() => {}}
                onNewSession={() => {}}
                onStopProject={() => {}}
                onRestartProject={() => {}}
                sessionsLoaded={true}
                pinned={new Set(['sess_1'])}
                setPinnedArr={() => {}}
              />,
              mount,
            );
          };
        `,
        resolveDir: resolve(here, '..'),
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      write: false,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      plugins: [
        {
          name: 'tabs-browser-stubs',
          setup(buildCtx) {
            buildCtx.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'tabs-stub' }));
            buildCtx.onResolve({ filter: /^\.\.\/api\.js$/ }, () => ({ path: 'api-stub', namespace: 'tabs-stub' }));
            buildCtx.onLoad({ filter: /.*/, namespace: 'tabs-stub' }, (args) => ({
              contents: args.path === 'react-i18next'
                ? 'export const useTranslation = () => ({ t: (_k, d) => (typeof d === "string" ? d : _k) });'
                : 'export const getUserPref = async () => null; export const saveUserPref = async () => {}; export const apiFetch = async () => ({}); export class ApiError extends Error {}; export const getApiBaseUrl = () => ""; export const getExpectedUserId = () => "";',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const bundleCode = compiled.outputFiles[0]!.text;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#080d16;"><div class="layout" style="width:100vw;height:100vh;"><main class="main" style="width:100%;min-width:0;display:flex;flex-direction:column;"><div id="tabs-mount" style="width:100%;min-width:0;"></div></main></div></body></html>`;

    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const viewports = [
        { width: 1280, height: 800, mobile: false },
        { width: 460, height: 700, mobile: false },
        { width: 360, height: 780, mobile: true },
      ];
      for (const vp of viewports) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto('https://imcodes.test/');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundleCode });
        await page.evaluate((isMob) => {
          document.documentElement.classList.toggle('is-mobile', isMob);
          (window as unknown as { __mountTabs: (name: string) => void }).__mountTabs('sess_10');
        }, vp.mobile);
        await page.waitForSelector('.tab-bar .tab .session-tab-seq');

        // 1. Compare real rendered non-zero dimensions with corner badges visible vs hidden
        const dims = await page.evaluate(() => {
          const bar = document.querySelector('.tab-bar') as HTMLElement;
          const tabs = [...bar.querySelectorAll<HTMLElement>('.tab')];
          const measure = () => ({
            barHeight: bar.getBoundingClientRect().height,
            tabs: tabs.map((t) => ({
              width: t.getBoundingClientRect().width,
              height: t.getBoundingClientRect().height,
            })),
          });
          const withBadges = measure();
          const hideStyle = document.createElement('style');
          hideStyle.textContent = '.session-tab-seq { display: none !important; }';
          document.head.appendChild(hideStyle);
          void bar.offsetHeight;
          const withoutBadges = measure();
          hideStyle.remove();
          return { withBadges, withoutBadges };
        });

        expect(dims.withBadges.barHeight).toBeGreaterThanOrEqual(42);
        expect(Math.abs(dims.withBadges.barHeight - dims.withoutBadges.barHeight)).toBeLessThan(0.01);
        expect(dims.withBadges.tabs).toHaveLength(18);
        for (let i = 0; i < dims.withBadges.tabs.length; i++) {
          expect(dims.withBadges.tabs[i]!.width).toBeGreaterThan(40);
          expect(dims.withBadges.tabs[i]!.height).toBeGreaterThanOrEqual(34);
          expect(Math.abs(dims.withBadges.tabs[i]!.width - dims.withoutBadges.tabs[i]!.width)).toBeLessThan(0.01);
          expect(Math.abs(dims.withBadges.tabs[i]!.height - dims.withoutBadges.tabs[i]!.height)).toBeLessThan(0.01);
        }

        // 2. Scroll Tab #10 flush to left edge of .tab-bar; verify Tab #10 and two-digit badge '10' are unclipped
        const edgeCheck = await page.evaluate(() => {
          const bar = document.querySelector('.tab-bar') as HTMLElement;
          const tab1 = document.querySelector('[data-testid="session-tab-seq-sess_1"]')?.closest('.tab') as HTMLElement;
          const badge1 = document.querySelector('[data-testid="session-tab-seq-sess_1"]') as HTMLElement;
          bar.scrollLeft = 0;
          const bBar0 = bar.getBoundingClientRect();
          const b1 = badge1.getBoundingClientRect();
          const t1 = tab1.getBoundingClientRect();

          const badge10 = document.querySelector('[data-testid="session-tab-seq-sess_10"]') as HTMLElement;
          const tab10 = badge10.closest('.tab') as HTMLElement;
          const tab10Wrap = tab10.closest('.tab-wrap') as HTMLElement;
          bar.scrollLeft = tab10Wrap.offsetLeft;
          const bBar10 = bar.getBoundingClientRect();
          const b10 = badge10.getBoundingClientRect();
          const t10 = tab10.getBoundingClientRect();

          return {
            tab1Text: badge1.textContent,
            badge1LeftOk: b1.left >= bBar0.left - 0.5 && b1.left >= t1.left - 0.5,
            badge1TopOk: b1.top >= bBar0.top - 0.5,
            badge1SizeOk: b1.width > 0 && b1.height > 0,
            tab10Text: badge10.textContent,
            debugRects: { bar: bBar10, tab10: t10, badge10: b10, scrollLeft: bar.scrollLeft, wrapOffsetLeft: tab10Wrap.offsetLeft },
            tab10VisibleOk: t10.left >= bBar10.left - 0.5 && t10.right <= bBar10.right + 0.5,
            badge10LeftOk: b10.left >= bBar10.left - 0.5 && b10.left >= t10.left - 0.5,
            badge10TopOk: b10.top >= bBar10.top - 0.5,
            badge10RightOk: b10.right <= bBar10.right + 0.5,
            badge10BottomOk: b10.bottom <= bBar10.bottom + 0.5,
            badge10SizeOk: b10.width > 0 && b10.height > 0,
          };
        });

        expect(edgeCheck.tab1Text).toBe('1');
        expect(edgeCheck.badge1LeftOk).toBe(true);
        expect(edgeCheck.badge1TopOk).toBe(true);
        expect(edgeCheck.badge1SizeOk).toBe(true);
        expect(edgeCheck.tab10Text).toBe('10');
        expect(edgeCheck.tab10VisibleOk, JSON.stringify(edgeCheck.debugRects)).toBe(true);
        expect(edgeCheck.badge10LeftOk).toBe(true);
        expect(edgeCheck.badge10TopOk).toBe(true);
        expect(edgeCheck.badge10RightOk).toBe(true);
        expect(edgeCheck.badge10BottomOk).toBe(true);
        expect(edgeCheck.badge10SizeOk).toBe(true);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 45_000);

  it('keeps mobile top bar, server latency, chevron, and all tool buttons inside 320px and 375px viewports on web and android in real Chromium', { timeout: 45_000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) {
      return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${css}</style>
</head>
<body style="margin:0;background:#080d16;">
  <div class="layout layout-mobile" style="width:100vw;height:100vh;">
    <main class="main" style="width:100%;min-width:0;display:flex;flex-direction:column;">
      <div class="mobile-server-bar" data-testid="mobile-server-bar">
        <button class="mobile-sidebar-toggle" type="button">☰</button>
        <div class="mobile-server-switcher-wrap">
          <button class="mobile-server-btn" type="button" title="Very Long Production Node Identifier Alpha">
            <span class="mobile-server-btn-icon" aria-hidden="true">☁</span>
            <span class="mobile-server-btn-name">Very Long Production Node Identifier Alpha</span>
            <span class="share-state-indicator" aria-label="Shared">👥</span>
            <span class="mobile-server-latency"><span class="badge-dot badge-dot-online">●</span>32ms</span>
            <span class="mobile-server-btn-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        <div class="mobile-server-actions">
          <div class="mobile-remote-desktop-group">
            <button class="view-toggle daemon-remote-desktop-btn" type="button">🖥</button>
            <button class="controlled-nodes-quick-trigger" type="button">▾</button>
          </div>
          <button class="view-toggle" type="button">📁</button>
          <button class="view-toggle" type="button">🌐</button>
          <button class="view-toggle global-task-mode-entry-btn mobile-task-mode-btn" type="button">⚡</button>
          <button class="view-toggle mobile-cloud-docs-marquee-btn" type="button">📄</button>
          <button class="view-toggle" type="button">💬</button>
        </div>
      </div>
    </main>
  </div>
</body>
</html>`;

    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const testCases = [
        { width: 320, height: 568, platform: 'web' },
        { width: 320, height: 568, platform: 'android' },
        { width: 375, height: 667, platform: 'web' },
        { width: 375, height: 667, platform: 'android' },
      ];

      for (const tc of testCases) {
        const page = await browser.newPage({ viewport: { width: tc.width, height: tc.height } });
        await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto('https://imcodes.test/');
        if (tc.platform === 'android') {
          await page.evaluate(() => {
            document.documentElement.setAttribute('data-native-platform', 'android');
          });
        }

        const metrics = await page.evaluate((vpWidth) => {
          const bar = document.querySelector('.mobile-server-bar') as HTMLElement;
          const toggle = document.querySelector('.mobile-sidebar-toggle') as HTMLElement;
          const btn = document.querySelector('.mobile-server-btn') as HTMLElement;
          const name = document.querySelector('.mobile-server-btn-name') as HTMLElement;
          const latency = document.querySelector('.mobile-server-latency') as HTMLElement;
          const chevron = document.querySelector('.mobile-server-btn-chevron') as HTMLElement;
          const actions = document.querySelector('.mobile-server-actions') as HTMLElement;
          const actionButtons = Array.from(actions.querySelectorAll('button'));
          const lastActionBtn = actionButtons[actionButtons.length - 1];

          const bBar = bar.getBoundingClientRect();
          const bToggle = toggle.getBoundingClientRect();
          const bBtn = btn.getBoundingClientRect();
          const bName = name.getBoundingClientRect();
          const bLatency = latency.getBoundingClientRect();
          const bChevron = chevron.getBoundingClientRect();
          const bActions = actions.getBoundingClientRect();
          const bLastBtn = lastActionBtn.getBoundingClientRect();

          return {
            barWidth: bBar.width,
            toggleRight: bToggle.right,
            btnLeft: bBtn.left,
            btnRight: bBtn.right,
            btnWidth: bBtn.width,
            nameLeft: bName.left,
            nameRight: bName.right,
            nameWidth: bName.width,
            nameTruncated: name.scrollWidth > name.clientWidth,
            latencyLeft: bLatency.left,
            latencyRight: bLatency.right,
            chevronLeft: bChevron.left,
            chevronRight: bChevron.right,
            actionsLeft: bActions.left,
            actionsRight: bActions.right,
            actionsWidth: bActions.width,
            lastBtnRight: bLastBtn.right,
            vpWidth,
          };
        }, tc.width);

        // 1. Mobile top bar fits viewport
        expect(metrics.barWidth, `${tc.platform} ${tc.width} bar width`).toBeLessThanOrEqual(tc.width + 0.5);

        // 2. Server dropdown button does not overlap toggle or actions
        expect(metrics.btnLeft, `${tc.platform} ${tc.width} btn left`).toBeGreaterThanOrEqual(metrics.toggleRight - 0.5);
        expect(metrics.btnRight, `${tc.platform} ${tc.width} btn right`).toBeLessThanOrEqual(metrics.actionsLeft + 0.5);

        // 3. Name has usable width (>= 20px) and long server name is truncated
        expect(metrics.nameWidth, `${tc.platform} ${tc.width} name width`).toBeGreaterThanOrEqual(20);
        expect(metrics.nameTruncated, `${tc.platform} ${tc.width} name truncated`).toBe(true);

        // 4. Latency and chevron stay inside server button
        expect(metrics.latencyLeft, `${tc.platform} ${tc.width} latency left`).toBeGreaterThanOrEqual(metrics.nameRight - 0.5);
        expect(metrics.chevronLeft, `${tc.platform} ${tc.width} chevron left`).toBeGreaterThanOrEqual(metrics.latencyRight - 0.5);
        expect(metrics.chevronRight, `${tc.platform} ${tc.width} chevron inside btn`).toBeLessThanOrEqual(metrics.btnRight + 0.5);

        // 5. All action buttons stay within the viewport (last action button right <= viewport width)
        expect(metrics.lastBtnRight, `${tc.platform} ${tc.width} last btn in viewport`).toBeLessThanOrEqual(tc.width + 0.5);

        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 45_000);
});
