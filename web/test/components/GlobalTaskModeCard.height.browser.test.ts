/**
 * @vitest-environment node
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BASE_REF = '47860ab08cd66969a1fffa81cb6e5026f1cbf039';

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

describe('GlobalTaskModeView card real Chromium zero-extra-height parity', () => {
  it('matches base card, meta, and progress heights across mobile (393px/335px) and desktop long-tag (800px/460px) collapsed and expanded states', { timeout: 90000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(here, '../..');
    const repoRoot = resolve(webDir, '..');
    const viewPath = resolve(webDir, 'src/components/GlobalTaskModeView.tsx');
    const i18nPath = resolve(webDir, 'src/i18n/index.ts');
    const storePath = resolve(webDir, 'src/global-task-mode-store.ts');
    const headBaseCss = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');
    const headBriefCss = readFileSync(resolve(webDir, 'src/components/global-task-mode-brief.css'), 'utf8');

    const baseViewSrc = tryReadGitFile(repoRoot, BASE_REF, 'web/src/components/GlobalTaskModeView.tsx');
    const baseCss = tryReadGitFile(repoRoot, BASE_REF, 'web/src/styles.css');
    if (!baseViewSrc || !baseCss) {
      return;
    }

    const harnessEntry = `
      import { render } from 'preact';
      import i18n from ${JSON.stringify(i18nPath)};
      import { globalTaskModeStore, clearGlobalTaskModeSessionState } from ${JSON.stringify(storePath)};
      import { GlobalTaskModeView } from ${JSON.stringify(viewPath)};
      class NoopWebSocket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 1; send() {} close() {} addEventListener() {} removeEventListener() {}
      }
      window.WebSocket = NoopWebSocket;
      window.__mountCards = async (tasks, cardWidthPx) => {
        await i18n.changeLanguage('en');
        clearGlobalTaskModeSessionState();
        globalTaskModeStore.setState({
          loading: false,
          connected: true,
          connecting: false,
          servers: [{ id: 'srv-1', name: tasks[0].serverName, online: true }],
          brains: [],
          tasks,
        });
        const root = document.getElementById('root');
        root.style.width = cardWidthPx ? (cardWidthPx + 'px') : '100%';
        render(null, root);
        render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />, root);
        await new Promise((r) => setTimeout(r, 40));
      };
    `;

    const buildHarness = async (overrideBaseSrc: string | null) => {
      const result = await build({
        absWorkingDir: webDir,
        stdin: {
          contents: harnessEntry,
          resolveDir: webDir,
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        outfile: 'harness.js',
        jsx: 'automatic',
        jsxImportSource: 'preact',
        platform: 'browser',
        alias: {
          react: 'preact/compat',
          'react-dom': 'preact/compat',
          '@shared': resolve(repoRoot, 'shared'),
        },
        plugins: [
          {
            name: 'mock-and-swap',
            setup(pluginBuild) {
              pluginBuild.onLoad({ filter: /\.css$/ }, () => ({
                contents: '',
                loader: 'css',
              }));
              if (overrideBaseSrc) {
                pluginBuild.onLoad({ filter: /GlobalTaskModeView\.tsx$/ }, () => ({
                  contents: overrideBaseSrc,
                  loader: 'tsx',
                  resolveDir: resolve(webDir, 'src/components'),
                }));
              }
            },
          },
        ],
      });
      return result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    };

    const headBundle = await buildHarness(null);
    const baseBundle = await buildHarness(baseViewSrc);

    const sampleTasks = {
      mobile: [
        {
          serverId: 'srv-1',
          serverName: 'M3',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_cd_brain',
          brainLabel: 'Main',
          taskId: 'tsk_height_mobile',
          title: 'Compact brief & checklist card',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 5, implemented: 2, audited: 1 },
          executorLabel: 'Exec1',
          auditorLabel: 'Aud1',
          executorModel: 'gemini-4-neon',
          auditorModel: 'gpt-6.2-astra',
          createdAt: 1795600000000,
          updatedAt: 1795600010000,
          isTerminal: false,
          needsAttention: false,
        },
      ],
      desktopLong: [
        {
          serverId: 'srv-1',
          serverName: 'Prod-East-1',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_cd_brain',
          brainLabel: 'Core Architect',
          taskId: 'tsk_height_desktop',
          title: 'Compact brief & checklist card with long tags',
          status: 'working',
          flags: [],
          round: 2,
          checklist: { total: 5, implemented: 3, audited: 2 },
          executorLabel: 'Exec1',
          auditorLabel: 'Aud1',
          executorModel: 'gemini-4-neon',
          auditorModel: 'gpt-6.2-sol',
          createdAt: 1795600000000,
          updatedAt: 1795600010000,
          isTerminal: false,
          needsAttention: false,
        },
      ],
      desktopWrapped: [
        {
          serverId: 'srv-1',
          serverName: 'Production East Cluster Alpha',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_cd_brain',
          brainLabel: 'Architecture Lead Team Coordinator',
          taskId: 'tsk_height_desktop_wrap',
          title: 'Compact brief & checklist card with wrapping tags',
          status: 'working',
          flags: [],
          round: 2,
          checklist: { total: 5, implemented: 3, audited: 2 },
          executorLabel: 'Exec1',
          auditorLabel: 'Aud1',
          executorModel: 'claude-opus-4-6-extended',
          auditorModel: 'gpt-6.2-sol-reasoning',
          createdAt: 1795600000000,
          updatedAt: 1795600010000,
          isTerminal: false,
          needsAttention: false,
        },
      ],
    };

    const scenarios = [
      { name: 'mobile-393-335', viewport: { width: 393, height: 844 }, cardWidthPx: 335, tasks: sampleTasks.mobile },
      { name: 'desktop-800-460-long-1line', viewport: { width: 800, height: 900 }, cardWidthPx: 460, tasks: sampleTasks.desktopLong },
      { name: 'desktop-800-460-long-wrapped', viewport: { width: 800, height: 900 }, cardWidthPx: 460, tasks: sampleTasks.desktopWrapped },
      {
        name: 'desktop-1033-2col-492',
        viewport: { width: 1033, height: 900 },
        cardWidthPx: 0,
        tasks: [
          sampleTasks.desktopLong[0]!,
          { ...sampleTasks.desktopLong[0]!, taskId: 'tsk_height_desktop_1033_2' },
        ],
      },
      {
        name: 'desktop-1094-2col-523',
        viewport: { width: 1094, height: 900 },
        cardWidthPx: 0,
        tasks: [
          sampleTasks.desktopLong[0]!,
          { ...sampleTasks.desktopLong[0]!, taskId: 'tsk_height_desktop_2' },
        ],
      },
    ] as const;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.route('https://imcodes.test/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#080d16;"><div id="root"></div></body></html>',
        });
      });

      const measure = async (
        bundle: string,
        css: string,
        viewport: { width: number; height: number },
        cardWidthPx: number,
        tasks: ReadonlyArray<(typeof sampleTasks.mobile)[number]>,
        expand: boolean,
      ) => {
        await page.setViewportSize(viewport);
        await page.goto('https://imcodes.test/', { waitUntil: 'domcontentloaded' });
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(async ({ tasks: tList, width }) => {
          const w = window as unknown as { __mountCards: (t: unknown, w: number) => Promise<void> };
          await w.__mountCards(tList, width);
        }, { tasks, width: cardWidthPx });

        const taskId = tasks[0]!.taskId;
        if (expand) {
          await page.click(`[data-testid="task-mode-card-${taskId}"]`);
        }

        return await page.evaluate((id) => {
          const card = document.querySelector(`[data-testid="task-mode-card-${id}"]`) as HTMLElement;
          const meta = card.querySelector('.global-task-card-meta') as HTMLElement;
          const progress = card.querySelector(`[data-testid="task-mode-progress-${id}"]`) as HTMLElement;
          const replyBtn = card.querySelector(`[data-testid="task-mode-reply-${id}"]`) as HTMLElement | null;
          const briefBtn = card.querySelector(`[data-testid="task-mode-brief-btn-${id}"]`) as HTMLElement | null;
          const progressBtn = card.querySelector(`[data-testid="task-mode-progress-btn-${id}"]`) as HTMLElement | null;
          const detailActions = card.querySelector('.global-task-detail-actions') as HTMLElement | null;
          const detailBrief = card.querySelector(`[data-testid="task-mode-detail-brief-${id}"]`) as HTMLElement | null;
          const detailJump = card.querySelector(`[data-testid="task-mode-jump-${id}"]`) as HTMLElement | null;
          return {
            cardWidth: card.getBoundingClientRect().width,
            cardHeight: card.getBoundingClientRect().height,
            metaHeight: meta.getBoundingClientRect().height,
            progressHeight: progress.getBoundingClientRect().height,
            replyRect: replyBtn ? replyBtn.getBoundingClientRect().toJSON() : null,
            briefRect: briefBtn ? briefBtn.getBoundingClientRect().toJSON() : null,
            progressBtnRect: progressBtn ? progressBtn.getBoundingClientRect().toJSON() : null,
            detailActionsHeight: detailActions ? detailActions.getBoundingClientRect().height : null,
            detailBriefTop: detailBrief ? detailBrief.getBoundingClientRect().top : null,
            detailJumpTop: detailJump ? detailJump.getBoundingClientRect().top : null,
          };
        }, taskId);
      };

      // Inject brief CSS BEFORE styles.css to match Vite production chunk ordering,
      // and also test the built dist/assets/index-*.css bundle directly when present.
      const distAssetsDir = resolve(webDir, 'dist/assets');
      const builtCssName = existsSync(distAssetsDir)
        ? readdirSync(distAssetsDir).find((name) => /^index-.*\.css$/.test(name))
        : undefined;
      const headCssVariants = [
        `${headBriefCss}\n${headBaseCss}`,
        ...(builtCssName ? [readFileSync(resolve(distAssetsDir, builtCssName), 'utf8')] : []),
      ];

      for (const s of scenarios) {
        for (const expand of [false, true]) {
          const baseM = await measure(baseBundle, baseCss, s.viewport, s.cardWidthPx, s.tasks, expand);
          if (s.name === 'desktop-1094-2col-523') {
            expect(baseM.cardWidth).toBeGreaterThanOrEqual(520);
          }
          for (const headCss of headCssVariants) {
            const headM = await measure(headBundle, headCss, s.viewport, s.cardWidthPx, s.tasks, expand);
            expect(headM.progressHeight, `${s.name} expand=${expand} progressHeight`).toBe(baseM.progressHeight);
            expect(headM.metaHeight, `${s.name} expand=${expand} metaHeight`).toBe(baseM.metaHeight);
            expect(headM.cardHeight, `${s.name} expand=${expand} cardHeight`).toBe(baseM.cardHeight);
            expect(headM.briefRect).not.toBeNull();
            expect(headM.replyRect).not.toBeNull();
            expect(Math.abs(headM.briefRect!.top - headM.replyRect!.top), `${s.name} expand=${expand} brief/reply top parity`).toBeLessThanOrEqual(1);
            expect(headM.briefRect!.right).toBeLessThanOrEqual(headM.replyRect!.left + 0.5);
            if (expand) {
              expect(headM.detailBriefTop).not.toBeNull();
              expect(headM.detailJumpTop).not.toBeNull();
              expect(Math.abs(headM.detailBriefTop! - headM.detailJumpTop!)).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  });
});
