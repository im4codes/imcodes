/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_VIEWPORTS = [
  { name: 'narrow', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

describe('PcAppUpdateBanner real Chromium layout & overlay non-overlap', () => {
  it('places banner, tab bar, and composer without overlap across narrow and desktop viewports and keeps ClientDownloadsModal interactive', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(here, '../..');
    const bannerPath = resolve(webDir, 'src/components/PcAppUpdateBanner.tsx');
    const downloadsModalPath = resolve(webDir, 'src/components/ClientDownloadsModal.tsx');
    const i18nPath = resolve(webDir, 'src/i18n/index.ts');
    const css = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');

    const compiled = buildSync({
      absWorkingDir: webDir,
      stdin: {
        contents: `
          import { render } from 'preact';
          import { useState } from 'preact/hooks';
          import i18n from ${JSON.stringify(i18nPath)};
          import { PcAppUpdateBanner } from ${JSON.stringify(bannerPath)};
          import { ClientDownloadsModal } from ${JSON.stringify(downloadsModalPath)};

          function Harness() {
            const [open, setOpen] = useState(false);
            return (
              <div class="layout">
                <main class="main">
                  <PcAppUpdateBanner onOpenDownloads={() => setOpen(true)} />
                  <div class="tab-bar" data-testid="test-tab-bar">
                    <div class="tab-wrap"><button class="tab active">main</button></div>
                    <div class="tab-wrap"><button class="tab">worker-1</button></div>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                    <div class="controls-composer" data-testid="test-composer" style={{ padding: '12px', borderTop: '1px solid #334155' }}>
                      <textarea aria-label="Composer" style={{ width: '100%', height: '38px' }} />
                    </div>
                  </div>
                  <ClientDownloadsModal open={open} onClose={() => setOpen(false)} />
                </main>
              </div>
            );
          }

          window.__mountPcAppBannerHarness = async () => {
            await i18n.changeLanguage('en');
            window.__IMCODES_PC_APP__ = {
              isElectron: true,
              platform: 'win32',
              downloads: { revealFile: async () => true },
              updater: {
                getStatus: async () => ({
                  enabled: true,
                  currentVersion: '0.1.4',
                  state: 'error',
                  availableVersion: '0.1.5',
                  downloadedVersion: null,
                  progress: null,
                  error: 'Network timeout while downloading update package',
                }),
                checkForUpdates: async () => ({
                  enabled: true,
                  currentVersion: '0.1.4',
                  state: 'checking',
                  availableVersion: '0.1.5',
                  downloadedVersion: null,
                  progress: null,
                  error: null,
                }),
                quitAndInstall: async () => true,
                subscribe: () => () => {},
              },
            };
            render(<Harness />, document.getElementById('root'));
          };
        `,
        resolveDir: webDir,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      platform: 'browser',
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
      },
    });
    const bundleCode = compiled.outputFiles[0].text;

    const browser = await chromium.launch({ headless: true });
    try {
      for (const vp of TEST_VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.route('https://imcodes.test/**', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div></body></html>`,
          });
        });
        await page.goto('https://imcodes.test/', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: bundleCode });
        await page.evaluate(async () => {
          await (window as unknown as { __mountPcAppBannerHarness: () => Promise<void> }).__mountPcAppBannerHarness();
        });
        await page.waitForSelector('[data-testid="pc-app-update-banner"]');

        const geom = await page.evaluate(() => {
          const banner = document.querySelector('[data-testid="pc-app-update-banner"]')?.getBoundingClientRect();
          const tabBar = document.querySelector('[data-testid="test-tab-bar"]')?.getBoundingClientRect();
          const composer = document.querySelector('[data-testid="test-composer"]')?.getBoundingClientRect();
          return {
            banner: banner ? { top: banner.top, bottom: banner.bottom, left: banner.left, right: banner.right, width: banner.width, height: banner.height } : null,
            tabBar: tabBar ? { top: tabBar.top, bottom: tabBar.bottom, left: tabBar.left, right: tabBar.right, width: tabBar.width, height: tabBar.height } : null,
            composer: composer ? { top: composer.top, bottom: composer.bottom, left: composer.left, right: composer.right, width: composer.width, height: composer.height } : null,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            innerHeight: window.innerHeight,
          };
        });

        expect(geom.banner, `${vp.name} banner`).not.toBeNull();
        expect(geom.tabBar, `${vp.name} tabBar`).not.toBeNull();
        expect(geom.composer, `${vp.name} composer`).not.toBeNull();
        expect(geom.banner!.height).toBeGreaterThan(0);
        expect(geom.tabBar!.height).toBeGreaterThanOrEqual(42);
        expect(geom.composer!.height).toBeGreaterThan(0);
        expect(geom.scrollWidth).toBeLessThanOrEqual(geom.clientWidth);

        // Strictly stacked in normal flow with zero overlap
        expect(geom.banner!.bottom, `${vp.name}: banner must sit above tab-bar`).toBeLessThanOrEqual(geom.tabBar!.top + 0.5);
        expect(geom.tabBar!.bottom, `${vp.name}: tab-bar must sit above composer`).toBeLessThanOrEqual(geom.composer!.top + 0.5);
        expect(geom.composer!.bottom, `${vp.name}: composer must fit inside viewport`).toBeLessThanOrEqual(geom.innerHeight + 0.5);

        // Clicking Reinstall opens ClientDownloadsModal and closing it works cleanly
        await page.click('[data-testid="pc-app-update-reinstall"]');
        await page.waitForSelector('[data-testid="client-downloads-modal"]');
        const modalVisible = await page.isVisible('[data-testid="client-downloads-modal"]');
        expect(modalVisible, `${vp.name} modal visible`).toBe(true);
        await page.click('[data-testid="client-downloads-close"]');
        await page.waitForSelector('[data-testid="client-downloads-modal"]', { state: 'detached' });

        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
