/**
 * @vitest-environment node
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BASE_REF = 'e6414393dfc7b9e5d7c9d91cab2acd5208190d8a';

function tryReadGitFile(repoRoot: string, ref: string, relPath: string): string | null {
  try {
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function replaceEnvSab(css: string, sabPx: number): string {
  return css.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${sabPx}px`);
}

describe('SubSessionBar mobile footer status real Chromium layout & base/head height budget', () => {
  it('never exceeds base .subcard-bar height across 0px/34px safe-area insets and collapsed/expanded/empty states while keeping layout centered and interactive', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { build, buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(here, '../..');
    const repoRoot = resolve(webDir, '..');
    const componentPath = resolve(webDir, 'src/components/SubSessionBar.tsx');
    const i18nPath = resolve(webDir, 'src/i18n/index.ts');
    const headCss = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');

    const baseBarSrc = tryReadGitFile(repoRoot, BASE_REF, 'web/src/components/SubSessionBar.tsx');
    const baseCardSrc = tryReadGitFile(repoRoot, BASE_REF, 'web/src/components/SubSessionCard.tsx');
    const baseCss = tryReadGitFile(repoRoot, BASE_REF, 'web/src/styles.css');

    const harnessEntry = `
      import { render } from 'preact';
      import i18n from ${JSON.stringify(i18nPath)};
      import { SubSessionBar } from ${JSON.stringify(componentPath)};
      window.__BUILD_TIME__ = new Date(2026, 10, 14, 22, 10, 0).toISOString();
      window.__mountBar = async (props) => {
        await i18n.changeLanguage('en');
        const noop = () => {};
        render(
          <SubSessionBar
            onOpen={noop}
            onClose={noop}
            onRestart={noop}
            onNew={props.withOnNew === false ? undefined : noop}
            onViewDiscussions={noop}
            onViewRepo={noop}
            onViewCron={noop}
            ws={null}
            connected={props.daemonBadgeState === 'online'}
            onDiff={() => noop}
            onHistory={() => noop}
            {...props}
            openIds={new Set(props.openIds || [])}
          />,
          document.getElementById('root'),
        );
      };
    `;

    const buildCommon = {
      absWorkingDir: webDir,
      stdin: { contents: harnessEntry, resolveDir: webDir, loader: 'tsx' as const },
      define: {
        __BUILD_TIME__: JSON.stringify(new Date(2026, 10, 14, 22, 10, 0).toISOString()),
      },
      bundle: true,
      write: false,
      loader: { '.css': 'empty' as const },
      jsx: 'automatic' as const,
      jsxImportSource: 'preact',
      platform: 'browser' as const,
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
      },
    };

    const headBundle = buildSync(buildCommon).outputFiles[0].text;
    const baseBundle = (baseBarSrc && baseCardSrc && baseCss)
      ? (await build({
          ...buildCommon,
          plugins: [{
            name: 'base-snapshot',
            setup(pluginBuild) {
              pluginBuild.onLoad({ filter: /SubSessionBar\.tsx$/ }, () => ({
                contents: baseBarSrc,
                loader: 'tsx',
                resolveDir: resolve(webDir, 'src/components'),
              }));
              pluginBuild.onLoad({ filter: /SubSessionCard\.tsx$/ }, () => ({
                contents: baseCardSrc,
                loader: 'tsx',
                resolveDir: resolve(webDir, 'src/components'),
              }));
            },
          }],
        })).outputFiles[0].text
      : null;

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

      const matrix = [
        { name: 'collapsed', baseMaxBySab: { 0: 84, 34: 118 }, inline: false, hasRow: true, props: { subSessions, collapsed: true, desktopLayoutCapable: false, daemonBadgeState: 'online' } },
        { name: 'expanded_open_card', baseMaxBySab: { 0: 299, 34: 299 }, inline: false, hasRow: true, props: { subSessions, openIds: ['sub-1'], collapsed: false, desktopLayoutCapable: false, daemonBadgeState: 'online' } },
        { name: 'empty_collapsed', baseMaxBySab: { 0: 34, 34: 34 }, inline: true, hasRow: false, props: { subSessions: [], collapsed: true, desktopLayoutCapable: false, daemonBadgeState: 'offline' } },
        { name: 'empty_expanded_onNew', baseMaxBySab: { 0: 64, 34: 64 }, inline: false, hasRow: false, props: { subSessions: [], collapsed: false, desktopLayoutCapable: false, daemonBadgeState: 'connecting' } },
      ] as const;

      for (const sab of [0, 34] as const) {
        for (const item of matrix) {
          let baseHeight: number = item.baseMaxBySab[sab];
          if (baseBundle && baseCss) {
            await page.setContent(`<!doctype html><html style="--sab:${sab}px;"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${replaceEnvSab(baseCss, sab)}</style></head><body style="margin:0;background:#080d16;"><div id="root"></div></body></html>`);
            await page.addScriptTag({ content: baseBundle });
            await page.evaluate(async (p) => {
              const w = window as unknown as { __mountBar: (props: Record<string, unknown>) => Promise<void> };
              await w.__mountBar(p as Record<string, unknown>);
            }, item.props);
            baseHeight = await page.locator('.subcard-bar').evaluate((el) => el.getBoundingClientRect().height);
          }

          await page.setContent(`<!doctype html><html style="--sab:${sab}px;"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${replaceEnvSab(headCss, sab)}</style></head><body style="margin:0;background:#080d16;"><div id="root"></div></body></html>`);
          await page.addScriptTag({ content: headBundle });
          await page.evaluate(async (p) => {
            const w = window as unknown as { __mountBar: (props: Record<string, unknown>) => Promise<void> };
            await w.__mountBar(p as Record<string, unknown>);
          }, item.props);

          const geom = await page.evaluate((hasRow) => {
            const bar = document.querySelector('.subcard-bar') as HTMLElement;
            const toolbar = document.querySelector('.subcard-toolbar') as HTMLElement;
            const row = hasRow ? (document.querySelector('.subsession-row-with-close') as HTMLElement) : null;
            const footer = document.querySelector('[data-testid="mobile-subsession-footer-status"]') as HTMLElement;
            const badge = document.querySelector('[data-testid="mobile-subsession-footer-badge"]') as HTMLElement;
            const ver = document.querySelector('[data-testid="mobile-subsession-footer-version"]') as HTMLElement;
            const card = document.querySelector('.subcard') as HTMLElement | null;
            const inputArea = document.querySelector('.subcard-input-area') as HTMLElement | null;
            const br = bar.getBoundingClientRect();
            const rr = row?.getBoundingClientRect() ?? null;
            const fr = footer.getBoundingClientRect();
            const bg = badge.getBoundingClientRect();
            const vr = ver.getBoundingClientRect();
            const cr = card?.getBoundingClientRect() ?? null;
            const ir = inputArea?.getBoundingClientRect() ?? null;
            return {
              barHeight: br.height,
              rowBottom: rr?.bottom ?? null,
              footerTop: fr.top,
              badgeMidY: bg.top + bg.height / 2,
              verMidY: vr.top + vr.height / 2,
              badgeRight: bg.right,
              verLeft: vr.left,
              groupCenterX: (bg.left + vr.right) / 2,
              barCenterX: br.left + br.width / 2,
              overflowBar: bar.scrollWidth > bar.clientWidth,
              overflowToolbar: toolbar.scrollWidth > toolbar.clientWidth,
              overflowFooter: footer.scrollWidth > footer.clientWidth,
              bottomClearance: fr.bottom - Math.max(bg.bottom, vr.bottom),
              inputClipped: cr && ir ? ir.bottom > cr.bottom + 0.5 : false,
              verText: ver.textContent,
            };
          }, item.hasRow);

          expect(geom.verText).toBe('v11/14 22:10');
          expect(geom.overflowBar, `${item.name} sab=${sab} bar overflow`).toBe(false);
          expect(geom.overflowToolbar, `${item.name} sab=${sab} toolbar overflow`).toBe(false);
          expect(geom.overflowFooter, `${item.name} sab=${sab} footer overflow`).toBe(false);
          expect(geom.inputClipped, `${item.name} sab=${sab} input clipped`).toBe(false);
          expect(Math.abs(geom.badgeMidY - geom.verMidY)).toBeLessThanOrEqual(2);
          expect(geom.badgeRight).toBeLessThan(geom.verLeft);
          expect(geom.barHeight, `${item.name} sab=${sab} height`).toBeLessThanOrEqual(baseHeight + 0.01);

          if (item.hasRow && geom.rowBottom !== null) {
            expect(geom.footerTop).toBeGreaterThanOrEqual(geom.rowBottom - 0.5);
          }
          if (!item.inline) {
            expect(Math.abs(geom.groupCenterX - geom.barCenterX)).toBeLessThanOrEqual(2);
            if (sab === 34) {
              expect(geom.bottomClearance).toBeGreaterThanOrEqual(16);
            }
          }
        }
      }

      // .kb-open hides .subcard-bar and footer completely
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

      // Desktop leaves card height at 250px and does not render mobile footer status
      await page.evaluate(async (subs) => {
        document.documentElement.classList.remove('kb-open');
        const w = window as unknown as { __mountBar: (p: Record<string, unknown>) => Promise<void> };
        await w.__mountBar({
          subSessions: subs,
          openIds: ['sub-1'],
          collapsed: false,
          desktopLayoutCapable: true,
          daemonBadgeState: 'online',
        });
      }, subSessions);
      expect(await page.locator('[data-testid="mobile-subsession-footer-status"]').count()).toBe(0);
      const desktopCardH = await page.locator('.subcard').first().evaluate((el) => el.getBoundingClientRect().height);
      expect(desktopCardH).toBe(250);
    } finally {
      await browser.close();
    }
  });
});
