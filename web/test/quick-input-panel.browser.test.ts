/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

describe('QuickInputPanel real-browser viewport containment and narrow-screen layout', () => {
  it('keeps Files tab .fb-lightbox viewport-anchored (0,0..360,780) and avoids horizontal overflow on 360x780 and 1280x800', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = existsSync(chromium.executablePath())
      ? chromium.executablePath()
      : (existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : '');
    if (!executablePath) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const css = readFileSync(resolve(webRoot, 'src/styles.css'), 'utf8');

    const stubFileBrowserPlugin = {
      name: 'stub-file-browser-lazy',
      setup(pluginBuild: { onLoad: (opts: { filter: RegExp }, cb: () => { contents: string; loader: 'tsx' }) => void }) {
        pluginBuild.onLoad({ filter: /file-browser-lazy\.tsx$/ }, () => ({
          loader: 'tsx',
          contents: `
            import { h } from 'preact';
            export function FileBrowser() {
              return h('div', { class: 'fb-panel fb-layout-panel' }, [
                h('div', { class: 'fb-lightbox', 'data-testid': 'files-tab-lightbox' }, 'preview'),
              ]);
            }
          `,
        }));
      },
    };

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import { useRef } from 'preact/hooks';
          import i18n from 'i18next';
          import { I18nextProvider, initReactI18next } from 'react-i18next';
          import enLocale from './src/i18n/locales/en.json';
          import zhCNLocale from './src/i18n/locales/zh-CN.json';
          import { QuickInputPanel } from './src/components/QuickInputPanel.js';

          i18n.use(initReactI18next).init({
            resources: { en: { translation: enLocale }, 'zh-CN': { translation: zhCNLocale } },
            lng: 'zh-CN',
            fallbackLng: 'en',
            interpolation: { escapeValue: false },
          });

          const data = {
            history: [],
            sessionHistory: {},
            commands: ['./scripts/restart-daemon.sh restart', '/compact --very-long-command-argument-to-check-ellipsis-truncation'],
            phrases: ['汇报整体任务进度和时间估算', '这是一个非常非常长的快捷短语，用来验证单行省略号截断不会撑破移动端网格布局'],
          };

          const fakeWs = {
            connected: true,
            send: () => {},
            onMessage: () => () => {},
          };

          function Harness() {
            const anchorRef = useRef<HTMLButtonElement>(null);
            return (
              <div>
                <button
                  ref={anchorRef}
                  type="button"
                  style={{ position: 'fixed', left: '16px', bottom: '16px', width: '40px', height: '32px' }}
                >
                  trigger
                </button>
                <QuickInputPanel
                  open
                  onClose={() => {}}
                  onSelect={() => {}}
                  onSend={() => {}}
                  agentType="claude-code"
                  sessionName="session-browser"
                  ws={fakeWs as never}
                  anchorRef={anchorRef}
                  data={data}
                  loaded
                  onAddCommand={() => {}}
                  onAddPhrase={() => {}}
                  onRemoveCommand={() => {}}
                  onRemovePhrase={() => {}}
                  onRemoveHistory={() => {}}
                  onRemoveSessionHistory={() => {}}
                  onClearHistory={() => {}}
                  onClearSessionHistory={() => {}}
                />
              </div>
            );
          }

          render(
            <I18nextProvider i18n={i18n}>
              <Harness />
            </I18nextProvider>,
            document.getElementById('root')!,
          );
        `,
        resolveDir: webRoot,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      define: {
        localStorage: '__qpTestLocalStorage',
        'window.localStorage': '__qpTestLocalStorage',
        'globalThis.localStorage': '__qpTestLocalStorage',
      },
      plugins: [stubFileBrowserPlugin],
      alias: {
        '@shared': resolve(webRoot, '../shared'),
        react: require.resolve('preact/compat'),
        'react-dom': require.resolve('preact/compat'),
      },
    });

    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.setContent(`
        <!doctype html>
        <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
          <body>
            <div id="root"></div>
            <script>
              (() => {
                const store = new Map();
                window.__qpTestLocalStorage = {
                  getItem: (k) => store.has(k) ? store.get(k) : null,
                  setItem: (k, v) => { store.set(k, String(v)); },
                  removeItem: (k) => { store.delete(k); },
                  clear: () => { store.clear(); },
                  key: (i) => Array.from(store.keys())[i] ?? null,
                  get length() { return store.size; },
                };
              })();
            </script>
          </body>
        </html>
      `);
      await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
      expect(errors).toEqual([]);
      await page.waitForSelector('.qp', { timeout: 5000 });

      // 1. Check narrow 360x780 Quick tab 1-column grid & zero horizontal overflow
      const quickStats = await page.evaluate(() => {
        const panel = document.querySelector('.qp') as HTMLElement;
        const grid = document.querySelector('[data-qp-section="phrase"] .qp-custom-grid') as HTMLElement;
        const gridCols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
        const qpStyle = getComputedStyle(panel);
        const beforeStyle = getComputedStyle(panel, '::before');
        return {
          qpBackdropFilter: qpStyle.backdropFilter,
          beforeBackdropFilter: beforeStyle.backdropFilter,
          gridCols,
          panelOverflowX: panel.scrollWidth - panel.clientWidth,
        };
      });

      expect(quickStats.qpBackdropFilter).toBe('none');
      expect(quickStats.beforeBackdropFilter).toContain('blur(');
      expect(quickStats.gridCols).toBe(1);
      expect(quickStats.panelOverflowX).toBeLessThanOrEqual(0);

      // 2. Check desktop 1280x800 2-column grid and zero horizontal overflow
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForSelector('[data-qp-section="phrase"] .qp-custom-grid', { timeout: 3000 });
      const desktopStats = await page.evaluate(() => {
        const panel = document.querySelector('.qp') as HTMLElement;
        const grid = document.querySelector('[data-qp-section="phrase"] .qp-custom-grid') as HTMLElement;
        return {
          cols: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
          panelOverflowX: panel.scrollWidth - panel.clientWidth,
        };
      });
      expect(desktopStats.cols).toBe(2);
      expect(desktopStats.panelOverflowX).toBeLessThanOrEqual(0);

      // 3. Switch back to 360x780, open Files tab and verify .fb-lightbox remains viewport-anchored (0,0..360,780)
      await page.setViewportSize({ width: 360, height: 780 });
      await page.click('.qp-tab:nth-child(2)', { timeout: 3000 });
      await page.waitForSelector('[data-testid="files-tab-lightbox"]', { timeout: 3000 });

      const filesStats = await page.evaluate(() => {
        const lightbox = document.querySelector('[data-testid="files-tab-lightbox"]') as HTMLElement;
        const lbRect = lightbox.getBoundingClientRect();
        const topHit = document.elementFromPoint(180, 20);
        const bottomHit = document.elementFromPoint(180, 760);
        return {
          lbRect: { top: lbRect.top, left: lbRect.left, width: lbRect.width, height: lbRect.height },
          topHitIsLightbox: topHit === lightbox,
          bottomHitIsLightbox: bottomHit === lightbox,
        };
      });

      expect(filesStats.lbRect).toEqual({ top: 0, left: 0, width: 360, height: 780 });
      expect(filesStats.topHitIsLightbox).toBe(true);
      expect(filesStats.bottomHitIsLightbox).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
