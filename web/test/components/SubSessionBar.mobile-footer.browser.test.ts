/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('SubSessionBar mobile footer status real Chromium layout & height budget', () => {
  it('renders badge + build version side-by-side centered below sub-session buttons without increasing height across 0px and 34px safe-area insets', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const componentPath = resolve(here, '../../src/components/SubSessionBar.tsx');
    const i18nPath = resolve(here, '../../src/i18n/index.ts');
    const css = readFileSync(resolve(here, '../../src/styles.css'), 'utf8');

    const compiled = buildSync({
      stdin: {
        contents: `
          import { render } from 'preact';
          import i18n from ${JSON.stringify(i18nPath)};
          import { SubSessionBar } from ${JSON.stringify(componentPath)};
          window.__BUILD_TIME__ = new Date(2026, 10, 14, 22, 10, 0).toISOString();
          window.__mountBar = async (props) => {
            await i18n.changeLanguage('en');
            const noop = () => {};
            render(
              <SubSessionBar
                openIds={new Set()}
                onOpen={noop}
                onClose={noop}
                onRestart={noop}
                ws={null}
                connected={props.daemonBadgeState === 'online'}
                onDiff={() => noop}
                onHistory={() => noop}
                {...props}
              />,
              document.getElementById('root'),
            );
          };
        `,
        resolveDir: resolve(here, '../..'),
        loader: 'tsx',
      },
      define: {
        __BUILD_TIME__: JSON.stringify(new Date(2026, 10, 14, 22, 10, 0).toISOString()),
      },
      bundle: true,
      write: false,
      loader: { '.css': 'empty' },
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
        viewport: { width: 390, height: 844 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      });

      const subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_1',
          type: 'claude-code-sdk',
          label: 'worker-1',
          state: 'idle',
          cwd: '/tmp/repo',
          activeModel: 'opus',
        },
        {
          id: 'sub-2',
          sessionName: 'deck_sub_2',
          type: 'codex-sdk',
          label: 'worker-2',
          state: 'running',
          cwd: '/tmp/repo',
        },
      ];

      for (const sab of [0, 34] as const) {
        await page.setContent(`<!doctype html><html style="--sab:${sab}px;"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#080d16;"><div id="root"></div></body></html>`);
        await page.addScriptTag({ content: bundleCode });

        // 1. Collapsed with sub-sessions -> horizontal centered side-by-side below row, height <= baseline
        await page.evaluate(async (subs) => {
          const w = window as unknown as { __mountBar: (p: Record<string, unknown>) => Promise<void> };
          await w.__mountBar({
            subSessions: subs,
            collapsed: true,
            desktopLayoutCapable: false,
            daemonBadgeState: 'online',
          });
        }, subSessions);

        const collapsedGeom = await page.evaluate(() => {
          const bar = document.querySelector('.subcard-bar') as HTMLElement;
          const row = document.querySelector('.subsession-row-with-close') as HTMLElement;
          const footer = document.querySelector('[data-testid="mobile-subsession-footer-status"]') as HTMLElement;
          const badge = document.querySelector('[data-testid="mobile-subsession-footer-badge"]') as HTMLElement;
          const ver = document.querySelector('[data-testid="mobile-subsession-footer-version"]') as HTMLElement;
          const br = bar.getBoundingClientRect();
          const rr = row.getBoundingClientRect();
          const fr = footer.getBoundingClientRect();
          const bg = badge.getBoundingClientRect();
          const vr = ver.getBoundingClientRect();
          return {
            barHeight: br.height,
            rowBottom: rr.bottom,
            footerTop: fr.top,
            footerBottom: fr.bottom,
            badgeText: badge.textContent,
            verText: ver.textContent,
            badgeMidY: bg.top + bg.height / 2,
            verMidY: vr.top + vr.height / 2,
            badgeRight: bg.right,
            verLeft: vr.left,
            groupCenterX: (bg.left + vr.right) / 2,
            barCenterX: br.left + br.width / 2,
            overflows: footer.scrollWidth > footer.clientWidth,
            bottomClearance: fr.bottom - Math.max(bg.bottom, vr.bottom),
          };
        });

        expect(collapsedGeom.badgeText).toBe('● Online');
        expect(collapsedGeom.verText).toBe('v11/14 22:10');
        expect(collapsedGeom.footerTop).toBeGreaterThanOrEqual(collapsedGeom.rowBottom - 0.5);
        expect(Math.abs(collapsedGeom.badgeMidY - collapsedGeom.verMidY)).toBeLessThanOrEqual(2);
        expect(collapsedGeom.badgeRight).toBeLessThan(collapsedGeom.verLeft);
        expect(Math.abs(collapsedGeom.groupCenterX - collapsedGeom.barCenterX)).toBeLessThanOrEqual(2);
        expect(collapsedGeom.overflows).toBe(false);

        if (sab === 0) {
          expect(collapsedGeom.barHeight).toBeLessThanOrEqual(84);
        } else {
          expect(collapsedGeom.barHeight).toBeLessThanOrEqual(118);
          // Status pill + version remain cleanly above the bottom safe-area Home Indicator edge
          expect(collapsedGeom.bottomClearance).toBeGreaterThanOrEqual(16);
        }

        // 2. Empty subSessions & expanded state remain centered without horizontal overflow
        await page.evaluate(async (subs) => {
          const w = window as unknown as { __mountBar: (p: Record<string, unknown>) => Promise<void> };
          await w.__mountBar({
            subSessions: [],
            collapsed: false,
            desktopLayoutCapable: false,
            daemonBadgeState: 'offline',
          });
          const f = document.querySelector('[data-testid="mobile-subsession-footer-status"]') as HTMLElement;
          if (!f || f.scrollWidth > f.clientWidth) throw new Error('empty-overflow');
          await w.__mountBar({
            subSessions: subs,
            collapsed: false,
            desktopLayoutCapable: false,
            daemonBadgeState: 'connecting',
          });
        }, subSessions);

        const expandedGeom = await page.evaluate(() => {
          const bar = document.querySelector('.subcard-bar') as HTMLElement;
          const row = document.querySelector('.subsession-row-with-close') as HTMLElement;
          const footer = document.querySelector('[data-testid="mobile-subsession-footer-status"]') as HTMLElement;
          const badge = document.querySelector('[data-testid="mobile-subsession-footer-badge"]') as HTMLElement;
          const ver = document.querySelector('[data-testid="mobile-subsession-footer-version"]') as HTMLElement;
          return {
            rowBottom: row.getBoundingClientRect().bottom,
            footerTop: footer.getBoundingClientRect().top,
            badgeText: badge.textContent,
            overflows: footer.scrollWidth > footer.clientWidth,
            barCenterX: bar.getBoundingClientRect().width / 2,
            groupCenterX: (badge.getBoundingClientRect().left + ver.getBoundingClientRect().right) / 2,
          };
        });
        expect(expandedGeom.badgeText).toContain('Connecting');
        expect(expandedGeom.footerTop).toBeGreaterThanOrEqual(expandedGeom.rowBottom - 0.5);
        expect(expandedGeom.overflows).toBe(false);
        expect(Math.abs(expandedGeom.groupCenterX - expandedGeom.barCenterX)).toBeLessThanOrEqual(2);
      }

      // 3. .kb-open hides .subcard-bar and the footer inside it
      await page.evaluate(() => {
        document.documentElement.classList.add('kb-open');
      });
      const kbHidden = await page.evaluate(() => {
        const footer = document.querySelector('[data-testid="mobile-subsession-footer-status"]') as HTMLElement;
        return {
          barDisplay: getComputedStyle(document.querySelector('.subcard-bar')!).display,
          footerHeight: footer.getBoundingClientRect().height,
        };
      });
      expect(kbHidden.barDisplay).toBe('none');
      expect(kbHidden.footerHeight).toBe(0);

      // 4. Desktop does not render mobile footer status
      await page.evaluate(async (subs) => {
        document.documentElement.classList.remove('kb-open');
        const w = window as unknown as { __mountBar: (p: Record<string, unknown>) => Promise<void> };
        await w.__mountBar({
          subSessions: subs,
          collapsed: false,
          desktopLayoutCapable: true,
          daemonBadgeState: 'online',
        });
      }, subSessions);
      expect(await page.locator('[data-testid="mobile-subsession-footer-status"]').count()).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
