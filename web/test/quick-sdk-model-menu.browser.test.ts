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

describe('QuickSdkModelMenu real-browser layout, safe-area & scroll isolation', () => {
  it('fits cleanly on 1440x900, 390x844, 320x568, notched horizontal safe areas, keyboard VisualViewport, and scrolls columns independently', { timeout: 30000 }, async () => {
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

    const compiled = await build({
      stdin: {
        contents: `
          import { render } from 'preact';
          import { useState, useRef, useEffect } from 'preact/hooks';
          import i18n from 'i18next';
          import { I18nextProvider, initReactI18next } from 'react-i18next';
          import enLocale from './src/i18n/locales/en.json';
          import zhCNLocale from './src/i18n/locales/zh-CN.json';
          import { QuickSdkModelMenu } from './src/components/QuickSdkModelMenu.js';
          import {
            computeModelDropdownStyle,
            readSafeAreaBottomPx,
            readSafeAreaLeftPx,
            readSafeAreaRightPx,
            readSafeAreaTopPx,
          } from './src/util/model-dropdown-style.js';

          i18n.use(initReactI18next).init({
            resources: { en: { translation: enLocale }, 'zh-CN': { translation: zhCNLocale } },
            lng: 'zh-CN',
            fallbackLng: 'en',
            interpolation: { escapeValue: false },
          });

          function Harness({ triggerAlign = 'left', overrideVv = null }) {
            const [open, setOpen] = useState(true);
            const [tick, setTick] = useState(0);
            const btnRef = useRef(null);

            useEffect(() => {
              setTick((x) => x + 1);
              const refresh = () => setTick((x) => x + 1);
              window.addEventListener('resize', refresh);
              return () => window.removeEventListener('resize', refresh);
            }, []);

            const rect = btnRef.current?.getBoundingClientRect() ?? {
              top: window.innerHeight - 82,
              bottom: window.innerHeight - 52,
              left: triggerAlign === 'right' ? window.innerWidth - 96 : 16,
              right: triggerAlign === 'right' ? window.innerWidth - 16 : 96,
              width: 80,
            };
            const vv = overrideVv ?? {
              width: window.visualViewport?.width,
              height: window.visualViewport?.height,
              offsetTop: window.visualViewport?.offsetTop,
              offsetLeft: window.visualViewport?.offsetLeft,
            };
            const effWidth = vv.width ? Math.min(window.innerWidth, vv.width) : window.innerWidth;
            const isNarrow = effWidth <= 640;
            const style = open ? computeModelDropdownStyle(rect, {
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              visualViewportWidth: vv.width,
              visualViewportHeight: vv.height,
              visualViewportOffsetTop: vv.offsetTop,
              visualViewportOffsetLeft: vv.offsetLeft,
              safeAreaTop: readSafeAreaTopPx(),
              safeAreaBottom: readSafeAreaBottomPx(),
              safeAreaLeft: readSafeAreaLeftPx(),
              safeAreaRight: readSafeAreaRightPx(),
            }, {
              minWidth: isNarrow ? 280 : 340,
              preferredWidth: isNarrow ? 374 : 416,
              ...(isNarrow ? { viewportHeightCapRatio: 0.46, maxHeightPx: 340 } : {}),
            }) : undefined;

            return (
              <I18nextProvider i18n={i18n}>
                <div class="layout" style={{ height: '100vh', minHeight: '100vh' }}>
                  <main class="main" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#080d16' }}>
                    <div style={{ flex: 1 }} />
                    <div class="controls-wrapper" style={{ borderTop: '1px solid rgba(148,163,184,0.18)', background: '#0d1422', padding: '8px 12px 12px' }}>
                      <div class="shortcuts-row" style={{ display: 'flex', justifyContent: triggerAlign === 'right' ? 'flex-end' : 'flex-start', gap: '6px' }}>
                        <div class="shortcuts-model">
                          <button
                            ref={btnRef}
                            type="button"
                            class="shortcut-btn"
                            data-testid="session-model-trigger"
                            style={{ color: '#a78bfa', fontSize: '11px', padding: '5px 10px' }}
                            onClick={() => setOpen((v) => !v)}
                          >
                            Sonnet
                          </button>
                          {open && (
                            <div class="menu-dropdown menu-dropdown-models" style={style}>
                              <QuickSdkModelMenu
                                ws={null}
                                activeSession={{
                                  name: 'deck_app_brain',
                                  project: 'app',
                                  role: 'brain',
                                  state: 'idle',
                                  projectDir: '/work/app',
                                  agentType: 'claude-code',
                                  modelDisplay: 'sonnet',
                                }}
                                serverId="srv1"
                                modelOpen={open}
                                splitAllowed={true}
                                currentSdk="claude-code"
                                currentModel="sonnet"
                                sameSdkItems={[
                                  { id: 'opus', label: 'Opus' },
                                  { id: 'sonnet', label: 'Sonnet' },
                                  { id: 'haiku', label: 'Haiku' },
                                ]}
                                onSelectSameSdkModel={() => {}}
                                onClose={() => setOpen(false)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </main>
                </div>
              </I18nextProvider>
            );
          }

          window.__mountHarness = (opts) => {
            render(<Harness triggerAlign={opts.align} overrideVv={opts.overrideVv ?? null} />, document.getElementById('app'));
          };
        `,
        resolveDir: webRoot,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      alias: {
        '@shared': resolve(webRoot, '../shared'),
        'react': require.resolve('preact/compat'),
        'react-dom': require.resolve('preact/compat'),
      },
    });
    const bundleJs = compiled.outputFiles[0].text;

    const browser = await chromium.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const scenarios = [
        { name: 'desktop-1440', vw: 1440, vh: 900, align: 'left', sat: 0, sab: 0, sal: 0, sar: 0, expectRowH: 36, vv: null },
        { name: 'mobile-390', vw: 390, vh: 844, align: 'right', sat: 47, sab: 34, sal: 0, sar: 0, expectRowH: 40, vv: null },
        { name: 'mobile-320', vw: 320, vh: 568, align: 'right', sat: 0, sab: 0, sal: 0, sar: 0, expectRowH: 38, vv: null },
        { name: 'notched-390', vw: 390, vh: 844, align: 'right', sat: 47, sab: 34, sal: 22, sar: 22, expectRowH: 40, vv: null },
        {
          name: 'keyboard-zoomed-390',
          vw: 390,
          vh: 844,
          align: 'right',
          sat: 47,
          sab: 34,
          sal: 22,
          sar: 22,
          expectRowH: 40,
          vv: { width: 350, height: 380, offsetLeft: 20, offsetTop: 24 },
        },
      ] as const;

      for (const sc of scenarios) {
        const ctx = await browser.newContext({ viewport: { width: sc.vw, height: sc.vh } });
        const page = await ctx.newPage();
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n:root{--sat:${sc.sat}px;--sab:${sc.sab}px;--sal:${sc.sal}px;--sar:${sc.sar}px;}</style></head><body><div id="app"></div></body></html>`);
        await page.addScriptTag({ content: bundleJs });
        await page.evaluate((opts) => (window as any).__mountHarness(opts), { align: sc.align, overrideVv: sc.vv });
        await page.waitForSelector('[data-testid="quick-sdk-model-split"]');
        await page.click('[data-sdk-id="codex-sdk"]');

        const geom = await page.evaluate(() => {
          const menu = document.querySelector('.menu-dropdown-models')!.getBoundingClientRect().toJSON();
          const split = document.querySelector('.quick-sdk-model-split')!.getBoundingClientRect().toJSON();
          const sdks = document.querySelector('.quick-sdk-model-sdks')!.getBoundingClientRect().toJSON();
          const models = document.querySelector('.quick-sdk-model-models')!.getBoundingClientRect().toJSON();
          const sdkRow = document.querySelector('.quick-sdk-item')!.getBoundingClientRect().toJSON();
          const modelRow = document.querySelector('.quick-sdk-model-item')!.getBoundingClientRect().toJSON();
          return {
            docScrollWidth: document.documentElement.scrollWidth,
            menu,
            split,
            sdks,
            models,
            sdkRow,
            modelRow,
          };
        });

        const vvLeft = sc.vv ? sc.vv.offsetLeft : 0;
        const vvRight = sc.vv ? Math.min(sc.vw, sc.vv.offsetLeft + sc.vv.width) : sc.vw;
        const vvTop = sc.vv ? sc.vv.offsetTop : 0;
        const vvBottom = sc.vv ? Math.min(sc.vh, sc.vv.offsetTop + sc.vv.height) : sc.vh;

        const minLeft = Math.max(vvLeft, sc.sal) + 8;
        const maxRight = Math.min(vvRight, sc.vw - sc.sar) - 8;
        const minTop = Math.max(vvTop, sc.sat) + 16;
        const maxBottom = Math.min(vvBottom, sc.vh - sc.sab) - 8;

        expect(geom.docScrollWidth, sc.name).toBe(sc.vw);
        expect(geom.menu.left, sc.name).toBeGreaterThanOrEqual(minLeft);
        expect(geom.menu.right, sc.name).toBeLessThanOrEqual(maxRight);
        expect(geom.menu.top, sc.name).toBeGreaterThanOrEqual(minTop);
        expect(geom.menu.bottom, sc.name).toBeLessThanOrEqual(maxBottom);
        expect(geom.split.right, sc.name).toBeLessThanOrEqual(geom.menu.right);
        expect(geom.models.left, sc.name).toBeGreaterThanOrEqual(geom.sdks.right - 0.5);
        expect(geom.sdkRow.height, sc.name).toBeGreaterThanOrEqual(sc.expectRowH);
        expect(geom.modelRow.height, sc.name).toBeGreaterThanOrEqual(sc.expectRowH);

        if (sc.name === 'mobile-390') {
          expect(geom.menu.height).toBeLessThanOrEqual(340);
          // Independent column scroll: wheel-scroll SDK rail, verify model rail & page do not move.
          const sdksCenter = { x: geom.sdks.left + geom.sdks.width / 2, y: geom.sdks.top + geom.sdks.height / 2 };
          await page.mouse.move(sdksCenter.x, sdksCenter.y);
          await page.mouse.wheel(0, 120);
          await page.waitForTimeout(50);
          const scrollCheck = await page.evaluate(() => {
            const scrolls = Array.from(document.querySelectorAll('.quick-sdk-col-scroll')) as HTMLElement[];
            return {
              sdkScrollTop: scrolls[0]?.scrollTop ?? 0,
              modelScrollTop: scrolls[1]?.scrollTop ?? 0,
              winScrollY: window.scrollY,
            };
          });
          expect(scrollCheck.sdkScrollTop).toBeGreaterThan(0);
          expect(scrollCheck.modelScrollTop).toBe(0);
          expect(scrollCheck.winScrollY).toBe(0);
        }

        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  });
});
