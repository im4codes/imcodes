/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
] as const;

const TEST_LOCALES = ['en', 'es', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;

describe('MobileSwipeHud real Chromium geometry & responsive wrapping', () => {
  it('renders all 4 directional labels without ellipsis, clipping, overlap, or card overflow across 320/375/390px and all 7 locales', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const componentPath = resolve(here, '../../src/components/MobileSwipeHud.tsx');
    const i18nPath = resolve(here, '../../src/i18n/index.ts');
    const css = readFileSync(resolve(here, '../../src/styles.css'), 'utf8');

    const compiled = buildSync({
      stdin: {
        contents: `
          import { render } from 'preact';
          import i18n from ${JSON.stringify(i18nPath)};
          import { MobileSwipeHud } from ${JSON.stringify(componentPath)};
          window.__mountSwipeHud = async (locale, progress) => {
            await i18n.changeLanguage(locale);
            render(<MobileSwipeHud progress={progress} />, document.getElementById('root'));
          };
        `,
        resolveDir: resolve(here, '../..'),
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
      const page = await browser.newPage({
        viewport: { width: 320, height: 568 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });
      await page.setContent(`<style>${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: bundleCode });

      const cases = [
        {
          name: 'unarmed-left',
          progress: {
            dx: -28,
            dy: 0,
            direction: 'left',
            action: 'tabPrev',
            distance: 28,
            threshold: 56,
            progress: 0.5,
            armed: false,
          },
        },
        {
          name: 'armed-right',
          progress: {
            dx: 68,
            dy: 0,
            direction: 'right',
            action: 'tabNext',
            distance: 68,
            threshold: 56,
            progress: 1,
            armed: true,
          },
        },
        {
          name: 'armed-up',
          progress: {
            dx: 0,
            dy: -64,
            direction: 'up',
            action: 'serverPrev',
            distance: 64,
            threshold: 56,
            progress: 1,
            armed: true,
          },
        },
      ] as const;

      for (const vp of TEST_VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const locale of TEST_LOCALES) {
          for (const testCase of cases) {
            await page.evaluate(
              ({ lang, progress }) =>
                (window as unknown as {
                  __mountSwipeHud: (l: string, p: unknown) => Promise<void>;
                }).__mountSwipeHud(lang, progress),
              { lang: locale, progress: testCase.progress },
            );

            const metrics = await page.evaluate(() => {
              const hud = document.querySelector('[data-testid="mobile-swipe-hud"]') as HTMLElement;
              const card = document.querySelector('.mobile-swipe-hud-card') as HTMLElement;
              const center = document.querySelector('.mobile-swipe-hud-center') as HTMLElement;
              const cardRect = card.getBoundingClientRect();
              const centerRect = center.getBoundingClientRect();

              const dirs = (['up', 'down', 'left', 'right'] as const).map((dir) => {
                const pill = document.querySelector(`[data-testid="mobile-swipe-hud-dir-${dir}"]`) as HTMLElement;
                const label = pill.querySelector('.mobile-swipe-hud-dir-label') as HTMLElement;
                const pillRect = pill.getBoundingClientRect();
                const labelRect = label.getBoundingClientRect();
                const labelStyle = getComputedStyle(label);
                return {
                  dir,
                  text: label.textContent?.trim() ?? '',
                  pillRect: {
                    left: pillRect.left,
                    right: pillRect.right,
                    top: pillRect.top,
                    bottom: pillRect.bottom,
                    width: pillRect.width,
                    height: pillRect.height,
                  },
                  labelRect: {
                    width: labelRect.width,
                    height: labelRect.height,
                  },
                  scrollWidth: label.scrollWidth,
                  clientWidth: label.clientWidth,
                  scrollHeight: label.scrollHeight,
                  clientHeight: label.clientHeight,
                  whiteSpace: labelStyle.whiteSpace,
                  textOverflow: labelStyle.textOverflow,
                  overflowX: labelStyle.overflowX,
                  fontSize: parseFloat(labelStyle.fontSize),
                };
              });

              return {
                pointerEvents: getComputedStyle(hud).pointerEvents,
                cardScrollWidth: card.scrollWidth,
                cardClientWidth: card.clientWidth,
                cardRect: {
                  left: cardRect.left,
                  right: cardRect.right,
                  top: cardRect.top,
                  bottom: cardRect.bottom,
                  width: cardRect.width,
                },
                centerRect: {
                  left: centerRect.left,
                  right: centerRect.right,
                  top: centerRect.top,
                  bottom: centerRect.bottom,
                },
                dirs,
              };
            });

            const tag = `${vp.width}px/${locale}/${testCase.name}`;
            expect(metrics.pointerEvents, tag).toBe('none');
            expect(metrics.cardScrollWidth, `${tag}: card horizontal overflow`).toBeLessThanOrEqual(
              metrics.cardClientWidth + 1,
            );
            expect(metrics.cardRect.left, `${tag}: card left inside viewport`).toBeGreaterThanOrEqual(0);
            expect(metrics.cardRect.right, `${tag}: card right inside viewport`).toBeLessThanOrEqual(vp.width + 0.5);

            // Assert every directional label fits cleanly without ellipsis or clipping
            for (const d of metrics.dirs) {
              expect(d.text.length, `${tag}/${d.dir}: non-empty label`).toBeGreaterThan(0);
              expect(d.fontSize, `${tag}/${d.dir}: readable font size`).toBeGreaterThanOrEqual(10.5);
              expect(d.scrollWidth, `${tag}/${d.dir}: horizontal text clipping`).toBeLessThanOrEqual(
                d.clientWidth + 1,
              );
              expect(d.scrollHeight, `${tag}/${d.dir}: vertical text clipping`).toBeLessThanOrEqual(
                d.clientHeight + 1,
              );
              expect(d.whiteSpace, `${tag}/${d.dir}: allows multi-line wrapping`).not.toBe('nowrap');
              expect(d.textOverflow, `${tag}/${d.dir}: must not use ellipsis`).not.toBe('ellipsis');
              expect(d.pillRect.left, `${tag}/${d.dir}: pill inside card left`).toBeGreaterThanOrEqual(
                metrics.cardRect.left - 0.5,
              );
              expect(d.pillRect.right, `${tag}/${d.dir}: pill inside card right`).toBeLessThanOrEqual(
                metrics.cardRect.right + 0.5,
              );
            }

            // Assert no overlap among the 4 pills and the center ring
            const boxes = [
              { id: 'center', ...metrics.centerRect },
              ...metrics.dirs.map((d) => ({ id: d.dir, ...d.pillRect })),
            ];
            for (let i = 0; i < boxes.length; i += 1) {
              for (let j = i + 1; j < boxes.length; j += 1) {
                const a = boxes[i]!;
                const b = boxes[j]!;
                const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                const overlaps = overlapX > 0.5 && overlapY > 0.5;
                expect(overlaps, `${tag}: ${a.id} overlaps ${b.id}`).toBe(false);
              }
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  });
});
