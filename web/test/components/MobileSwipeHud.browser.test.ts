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
  it('renders all 4 directional labels and truncated targets without clipping, overlap, or card overflow across 320/375/390px and all 7 locales', { timeout: 45000 }, async () => {
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
          window.__mountSwipeHud = async (locale, progress, targets) => {
            await i18n.changeLanguage(locale);
            render(<MobileSwipeHud progress={progress} targets={targets} />, document.getElementById('root'));
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
          name: 'unarmed-left-with-targets',
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
          targets: {
            up: 'mini-2',
            down: 'mac-studio-prod',
            left: 'cd',
            right: 'clawd',
          },
        },
        {
          name: 'armed-right-long-mixed-cjk-ascii',
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
          targets: {
            up: '生产环境主机-ap-northeast-1-ultra-long-server-name-01',
            down: '测试环境节点-us-west-2-very-long-hostname-99',
            left: '超长中文混合会话名称-codedeck-frontend-mobile-swipe-hud',
            right: 'AnotherExtremelyLongSessionProjectNameWithMixed文字123456',
          },
        },
        {
          name: 'armed-up-with-unavailable-session-axis',
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
          targets: {
            up: [
              { step: 1, id: 's1', label: 'mini-2' },
              { step: 2, id: 's2', label: 'mini-3' },
              { step: 3, id: 's3', label: 'mini-4' },
            ],
            down: [
              { step: 1, id: 's4', label: 'prod-box-02' },
              { step: 2, id: 's5', label: 'prod-box-03' },
              { step: 3, id: 's6', label: 'prod-box-04' },
            ],
            left: null,
            right: null,
          },
        },
        {
          name: 'armed-tall-multi-level-5',
          progress: {
            dx: 0,
            dy: 245,
            direction: 'down',
            action: 'serverNext',
            distance: 245,
            threshold: 56,
            progress: 1,
            armed: true,
            step: 5,
            maxSteps: 5,
            horizontalMaxSteps: 3,
            verticalMaxSteps: 5,
          },
          targets: {
            up: [
              { step: 1, id: 'u1', label: 'srv-up-1' },
              { step: 2, id: 'u2', label: 'srv-up-2' },
              { step: 3, id: 'u3', label: 'srv-up-3' },
              { step: 4, id: 'u4', label: 'srv-up-4' },
              { step: 5, id: 'u5', label: 'srv-up-5' },
            ],
            down: [
              { step: 1, id: 'd1', label: 'srv-down-1' },
              { step: 2, id: 'd2', label: 'srv-down-2' },
              { step: 3, id: 'd3', label: 'srv-down-3' },
              { step: 4, id: 'd4', label: 'srv-down-4' },
              { step: 5, id: 'd5', label: 'srv-down-5' },
            ],
            left: [
              { step: 1, id: 'l1', label: 'tab-prev-1' },
              { step: 2, id: 'l2', label: 'tab-prev-2' },
              { step: 3, id: 'l3', label: 'tab-prev-3' },
            ],
            right: [
              { step: 1, id: 'r1', label: 'tab-next-1' },
              { step: 2, id: 'r2', label: 'tab-next-2' },
              { step: 3, id: 'r3', label: 'tab-next-3' },
            ],
          },
        },
      ] as const;

      for (const vp of TEST_VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const locale of TEST_LOCALES) {
          for (const testCase of cases) {
            if (testCase.name === 'armed-tall-multi-level-5' && vp.height < 800) {
              continue;
            }
            await page.evaluate(
              ({ lang, progress, targets }) =>
                (window as unknown as {
                  __mountSwipeHud: (l: string, p: unknown, t: unknown) => Promise<void>;
                }).__mountSwipeHud(lang, progress, targets),
              { lang: locale, progress: testCase.progress, targets: testCase.targets },
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
                const target = pill.querySelector('.mobile-swipe-hud-dir-target') as HTMLElement | null;
                const pillRect = pill.getBoundingClientRect();
                const labelRect = label.getBoundingClientRect();
                const labelStyle = getComputedStyle(label);
                const targetStyle = target ? getComputedStyle(target) : null;
                return {
                  dir,
                  text: label.textContent?.trim() ?? '',
                  targetText: target?.textContent?.trim() ?? '',
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
                  targetWhiteSpace: targetStyle?.whiteSpace ?? null,
                  targetTextOverflow: targetStyle?.textOverflow ?? null,
                  targetOverflowX: targetStyle?.overflowX ?? null,
                  targetHeight: target ? target.getBoundingClientRect().height : 0,
                  targetLineHeight: targetStyle ? parseFloat(targetStyle.lineHeight) : 0,
                };
              });

              return {
                pointerEvents: getComputedStyle(hud).pointerEvents,
                cardScrollWidth: card.scrollWidth,
                cardClientWidth: card.clientWidth,
                cardScrollHeight: card.scrollHeight,
                cardClientHeight: card.clientHeight,
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
            expect(metrics.cardScrollHeight, `${tag}: card vertical overflow`).toBeLessThanOrEqual(
              metrics.cardClientHeight + 1,
            );
            expect(metrics.cardRect.left, `${tag}: card left inside viewport`).toBeGreaterThanOrEqual(0);
            expect(metrics.cardRect.right, `${tag}: card right inside viewport`).toBeLessThanOrEqual(vp.width + 0.5);
            expect(metrics.cardRect.top, `${tag}: card top inside viewport`).toBeGreaterThanOrEqual(0);
            expect(metrics.cardRect.bottom, `${tag}: card bottom inside viewport`).toBeLessThanOrEqual(vp.height + 0.5);

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
              // Target name stays single-line with ellipsis truncation and never expands pill past card
              expect(d.targetText.length, `${tag}/${d.dir}: non-empty target text`).toBeGreaterThan(0);
              expect(d.targetWhiteSpace, `${tag}/${d.dir}: target uses single-line nowrap`).toBe('nowrap');
              expect(d.targetTextOverflow, `${tag}/${d.dir}: target uses ellipsis`).toBe('ellipsis');
              expect(d.targetOverflowX, `${tag}/${d.dir}: target clips overflow`).toBe('hidden');
              expect(d.targetHeight, `${tag}/${d.dir}: target stays single-line`).toBeLessThanOrEqual(
                d.targetLineHeight + 4,
              );
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

  it('maintains theme surface polarity, readable WCAG contrast, and native backdrop overrides across dark/light, server/session, armed/unarmed, and native classes', { timeout: 30000 }, async () => {
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
          window.__mountSwipeHud = async (locale, progress, targets) => {
            await i18n.changeLanguage(locale);
            render(<MobileSwipeHud progress={progress} targets={targets} />, document.getElementById('root'));
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

    const parseRgba = (raw: string): [number, number, number, number] => {
      const m = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (!m) throw new Error(`Unexpected CSS color format: ${raw}`);
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    };
    const relLuminance = ([r, g, b]: [number, number, number]) => {
      const lin = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
    };
    const compositeOver = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] => {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
      ];
    };
    const contrast = (a: [number, number, number], b: [number, number, number]) => {
      const la = relLuminance(a);
      const lb = relLuminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const states = [
      { name: 'neutral', progress: { dx: 6, dy: 0, direction: null, action: null, distance: 6, threshold: 56, progress: 0.1, armed: false } },
      { name: 'server-unarmed', progress: { dx: 0, dy: -32, direction: 'up', action: 'serverPrev', distance: 32, threshold: 56, progress: 0.57, armed: false } },
      { name: 'server-armed', progress: { dx: 0, dy: 64, direction: 'down', action: 'serverNext', distance: 64, threshold: 56, progress: 1, armed: true } },
      { name: 'session-unarmed', progress: { dx: -32, dy: 0, direction: 'left', action: 'tabPrev', distance: 32, threshold: 56, progress: 0.57, armed: false } },
      { name: 'session-armed', progress: { dx: 64, dy: 0, direction: 'right', action: 'tabNext', distance: 64, threshold: 56, progress: 1, armed: true } },
    ] as const;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      await page.setContent(`<style>${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: bundleCode });

      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        const backdropRgb: [number, number, number] = scheme === 'light' ? [241, 245, 249] : [10, 15, 28];

        for (const htmlClass of ['', 'native-ios-mac', 'native-mac-desktop'] as const) {
          await page.evaluate((cls) => {
            document.documentElement.className = cls;
          }, htmlClass);

          for (const st of states) {
            await page.evaluate(
              ({ progress }) =>
                (window as unknown as {
                  __mountSwipeHud: (l: string, p: unknown, t: unknown) => Promise<void>;
                }).__mountSwipeHud('en', progress, {
                  up: 'mini-2',
                  down: 'prod-01',
                  left: 'cd',
                  right: 'clawd',
                }),
              { progress: st.progress },
            );

            const styles = await page.evaluate(() => {
              const card = document.querySelector('.mobile-swipe-hud-card') as HTMLElement;
              const header = document.querySelector('.mobile-swipe-hud-header') as HTMLElement;
              const pct = document.querySelector('.mobile-swipe-hud-pct') as HTMLElement;
              const hint = document.querySelector('.mobile-swipe-hud-hint') as HTMLElement;
              const activeDir = (document.querySelector('.mobile-swipe-hud-dir.is-active') ?? document.querySelector('.mobile-swipe-hud-dir')) as HTMLElement;
              const activeTarget = activeDir.querySelector('.mobile-swipe-hud-dir-target') as HTMLElement;
              const cardStyle = getComputedStyle(card);
              const pctStyle = getComputedStyle(pct);
              const activeDirStyle = getComputedStyle(activeDir);
              return {
                cardBg: cardStyle.backgroundColor,
                cardBackdrop: cardStyle.backdropFilter,
                headerColor: getComputedStyle(header).color,
                pctColor: pctStyle.color,
                pctBg: pctStyle.backgroundColor,
                hintColor: getComputedStyle(hint).color,
                dirBg: activeDirStyle.backgroundColor,
                targetColor: getComputedStyle(activeTarget).color,
              };
            });

            const tag = `${scheme}/${htmlClass || 'browser'}/${st.name}`;
            const cardRgb = compositeOver(parseRgba(styles.cardBg), backdropRgb);
            const cardLum = relLuminance(cardRgb);
            if (scheme === 'light') {
              expect(cardLum, `${tag}: card surface must stay light`).toBeGreaterThan(0.7);
            } else {
              expect(cardLum, `${tag}: card surface must stay dark`).toBeLessThan(0.2);
            }

            if (htmlClass) {
              expect(styles.cardBackdrop, `${tag}: native class disables backdrop-filter`).toBe('none');
            }

            const headerRgb = compositeOver(parseRgba(styles.headerColor), cardRgb);
            const hintRgb = compositeOver(parseRgba(styles.hintColor), cardRgb);
            const pctBgRgb = compositeOver(parseRgba(styles.pctBg), cardRgb);
            const pctFgRgb = compositeOver(parseRgba(styles.pctColor), pctBgRgb);
            const dirBgRgb = compositeOver(parseRgba(styles.dirBg), cardRgb);
            const targetFgRgb = compositeOver(parseRgba(styles.targetColor), dirBgRgb);

            expect(contrast(headerRgb, cardRgb), `${tag}: header contrast`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(hintRgb, cardRgb), `${tag}: hint contrast`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(pctFgRgb, pctBgRgb), `${tag}: pct badge contrast`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(targetFgRgb, dirBgRgb), `${tag}: target contrast`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    } finally {
      await browser.close();
    }
  });
});
