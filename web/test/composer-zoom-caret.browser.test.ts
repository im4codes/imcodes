/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function resolveChromiumExecutable(chromium: typeof import('playwright').chromium): string | null {
  try {
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) return exe;
  } catch {
    /* ignore */
  }
  return null;
}

describe('composer caret positioning under UI zoom (real Chromium)', () => {
  it('places caret accurately across 75%-150% UI scale on desktop & mobile viewports and preserves drag/double-click selection', async () => {
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = resolveChromiumExecutable(chromium);
    if (!executablePath) return;

    const { build } = require('esbuild') as typeof import('esbuild');
    const hereDir = import.meta.dirname;
    const css = readFileSync(resolve(hereDir, '../src/styles.css'), 'utf8');
    const uiScalePath = resolve(hereDir, '../src/ui-scale.ts');
    const zoomCaretPath = resolve(hereDir, '../src/zoom-caret.ts');

    const bundleResult = await build({
      stdin: {
        contents: `
          import * as uiScale from ${JSON.stringify(uiScalePath)};
          import * as zoomCaret from ${JSON.stringify(zoomCaretPath)};
          window.__uiScale = uiScale;
          window.__zoomCaret = zoomCaret;
        `,
        resolveDir: resolve(hereDir, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      nodePaths: [resolve(hereDir, '../node_modules')],
    });
    const bundleCode = bundleResult.outputFiles[0].text;

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
      .stage { padding: 24px 16px; box-sizing: border-box; width: var(--imcodes-ui-vw, 100%); display: flex; flex-direction: column; gap: 16px; }
      .controls-composer { display: flex; width: min(320px, 100%); }
      .controls-input { min-height: 54px; max-height: 76px; }
    </style></head><body>
      <div class="stage">
        <div class="controls-composer">
          <div class="controls-input" contenteditable="true" spellcheck="false">alpha beta gamma\nsecond line 测试中文定位 end\nthird line extra overflow check\nfourth line bottom</div>
        </div>
        <textarea id="ta-box" rows="2" style="width:min(320px,100%);font:13px/1.4 monospace;">alpha beta gamma\nsecond line</textarea>
      </div>
    </body></html>`;

    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        const page = await browser.newPage({ viewport });
        await page.route('https://imcodes.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto('https://imcodes.test/');
        await page.addScriptTag({ content: bundleCode });

        // Wire exact SessionControls tap/click logic onto .controls-input
        await page.evaluate(() => {
          const el = document.querySelector('.controls-input') as HTMLElement;
          let tapState: { x: number; y: number; moved: boolean } | null = null;
          el.addEventListener('pointerdown', (e) => {
            if (e.isPrimary !== false && e.button === 0) {
              tapState = { x: e.clientX, y: e.clientY, moved: false };
            }
          });
          el.addEventListener('pointermove', (e) => {
            if (tapState && !tapState.moved && Math.hypot(e.clientX - tapState.x, e.clientY - tapState.y) > 6) {
              tapState.moved = true;
            }
          });
          el.addEventListener('click', (e) => {
            const tap = tapState;
            tapState = null;
            if (!tap?.moved && !e.shiftKey && e.detail <= 1) {
              window.__zoomCaret.placeContentEditableCaretAtPoint(el, e.clientX, e.clientY);
            }
          });
        });

        for (const pct of [60, 75, 85, 100, 125, 150]) {
          await page.evaluate((scalePct) => {
            window.__uiScale.writeUiScale(scalePct);
          }, pct);
          await page.waitForTimeout(80);

          // Sample start, mid line 1, end line 1, line 2 ASCII + CJK
          const points = await page.evaluate(() => {
            const el = document.querySelector('.controls-input') as HTMLElement;
            const tn = el.firstChild as Text;
            el.scrollTop = 0;
            const offsets = [0, 5, 11, 16, 20, 29, 34];
            return offsets.map((off) => {
              const r = document.createRange();
              r.setStart(tn, off);
              r.setEnd(tn, off + 1);
              const rect = r.getClientRects()[0];
              return { off, x: rect.left + Math.min(2, rect.width * 0.2), y: rect.top + rect.height / 2 };
            });
          });

          for (const pt of points) {
            await page.mouse.click(pt.x, pt.y);
            const result = await page.evaluate(() => {
              const sel = window.getSelection();
              return { isCollapsed: sel?.isCollapsed, offset: sel?.anchorOffset ?? -1 };
            });
            expect(result.isCollapsed).toBe(true);
            expect(Math.abs(result.offset - pt.off), `vp=${viewport.width} pct=${pct} pt=${pt.off}`).toBeLessThanOrEqual(1);
          }

          // Click to the right of line 1 end: must land at end of line 1 (offset 16, right before first \n)
          const rightOfLine1 = await page.evaluate((scalePct) => {
            const el = document.querySelector('.controls-input') as HTMLElement;
            const tn = el.firstChild as Text;
            const r = document.createRange();
            r.setStart(tn, 0);
            r.setEnd(tn, 1);
            const charRect = r.getClientRects()[0];
            const elRect = el.getBoundingClientRect();
            return { x: Math.min(elRect.right, window.innerWidth) - 4 * (scalePct / 100), y: charRect.top + charRect.height / 2 };
          }, pct);
          await page.mouse.click(rightOfLine1.x, rightOfLine1.y);
          const line1EndOffset = await page.evaluate(() => window.getSelection()?.anchorOffset ?? -1);
          expect(line1EndOffset, `vp=${viewport.width} pct=${pct} right-of-line1`).toBe(16);

          // Scroll composer to bottom and click line 4 ('fourth')
          const scrolledTarget = await page.evaluate(() => {
            const el = document.querySelector('.controls-input') as HTMLElement;
            el.scrollTop = el.scrollHeight;
            const tn = el.firstChild as Text;
            const targetOff = tn.data.indexOf('fourth') + 2;
            const r = document.createRange();
            r.setStart(tn, targetOff);
            r.setEnd(tn, targetOff + 1);
            const rect = r.getClientRects()[0];
            return { targetOff, x: rect.left + 1, y: rect.top + rect.height / 2 };
          });
          await page.mouse.click(scrolledTarget.x, scrolledTarget.y);
          const scrolledGot = await page.evaluate(() => window.getSelection()?.anchorOffset ?? -1);
          expect(Math.abs(scrolledGot - scrolledTarget.targetOff), `scrolled pct=${pct}`).toBeLessThanOrEqual(1);

          // Drag selection must NOT be collapsed by click handler
          await page.evaluate(() => { (document.querySelector('.controls-input') as HTMLElement).scrollTop = 0; });
          const dragSpan = await page.evaluate(() => {
            const el = document.querySelector('.controls-input') as HTMLElement;
            const tn = el.firstChild as Text;
            const r1 = document.createRange();
            r1.setStart(tn, 0);
            r1.setEnd(tn, 1);
            const r2 = document.createRange();
            r2.setStart(tn, 10);
            r2.setEnd(tn, 11);
            const rc1 = r1.getClientRects()[0];
            const rc2 = r2.getClientRects()[0];
            return {
              x1: rc1.left + 1,
              y1: rc1.top + rc1.height / 2,
              x2: rc2.left + rc2.width,
              y2: rc2.top + rc2.height / 2,
            };
          });
          await page.mouse.move(dragSpan.x1, dragSpan.y1);
          await page.mouse.down();
          await page.mouse.move(dragSpan.x2, dragSpan.y2, { steps: 6 });
          await page.mouse.up();
          const dragged = await page.evaluate(() => {
            const sel = window.getSelection();
            return { isCollapsed: sel?.isCollapsed, text: sel?.toString() ?? '' };
          });
          expect(dragged.isCollapsed, `drag preserved pct=${pct}`).toBe(false);
          expect(dragged.text.length).toBeGreaterThanOrEqual(5);

          // Double-click word selection must remain intact
          const dblPt = await page.evaluate(() => {
            const el = document.querySelector('.controls-input') as HTMLElement;
            const tn = el.firstChild as Text;
            const r = document.createRange();
            r.setStart(tn, 7);
            r.setEnd(tn, 8);
            const rc = r.getClientRects()[0];
            return { x: rc.left + 1, y: rc.top + rc.height / 2 };
          });
          await page.mouse.dblclick(dblPt.x, dblPt.y);
          const dblSel = await page.evaluate(() => ({
            isCollapsed: window.getSelection()?.isCollapsed,
            text: window.getSelection()?.toString() ?? '',
          }));
          expect(dblSel.isCollapsed).toBe(false);
          expect(dblSel.text).toContain('beta');

          // <textarea> click remains accurate
          const taBox = await page.evaluate((scalePct) => {
            const ta = document.getElementById('ta-box') as HTMLTextAreaElement;
            const rc = ta.getBoundingClientRect();
            return { x: rc.left + 40 * (scalePct / 100), y: rc.top + 12 * (scalePct / 100) };
          }, pct);
          await page.mouse.click(taBox.x, taBox.y);
          const taPos = await page.evaluate(() => (document.getElementById('ta-box') as HTMLTextAreaElement).selectionStart);
          expect(taPos).toBeGreaterThan(0);
          expect(taPos).toBeLessThan(12);
        }

        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
