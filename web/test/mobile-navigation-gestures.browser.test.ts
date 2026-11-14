/**
 * @vitest-environment node
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('mobile-navigation-gestures real Chromium touch & unmount recovery', () => {
  it('supports consecutive 1-finger long-press multi-step drags across DOM unmount in Chromium CDP', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const gesturesPath = resolve(here, '../src/mobile-navigation-gestures.ts');

    const compiled = buildSync({
      stdin: {
        contents: `
          import { attachMobileNavigationGestures } from ${JSON.stringify(gesturesPath)};
          const actions = [];
          const root = document.getElementById('root');
          let paneIndex = 0;
          const mountPane = () => {
            root.innerHTML = '';
            const pane = document.createElement('div');
            pane.className = 'session-pane';
            pane.dataset.pane = String(paneIndex++);
            pane.style.cssText = 'position:fixed;inset:0;touch-action:none;';
            root.appendChild(pane);
            return pane;
          };
          mountPane();
          window.__gestureActions = actions;
          attachMobileNavigationGestures({
            isMobile: true,
            longPressMs: 60,
            onAction: (action, step) => {
              actions.push({ action, step });
              mountPane();
            },
          });
        `,
        resolveDir: resolve(here, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: compiled.outputFiles[0].text });

      const cdp = await context.newCDPSession(page);

      // Gesture 1: 1-finger long-press + drag left 108px -> tabPrev step 2, unmounts pane 0.
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 260, y: 300, id: 0 }],
      });
      await page.waitForTimeout(120);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 152, y: 300, id: 0 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 152, y: 300, id: 0 }],
      });

      // Gesture 2 on remounted pane 1: 1-finger long-press + drag up 160px -> serverPrev step 3 (844px tall viewport allows up to 5).
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 200, y: 500, id: 0 }],
      });
      await page.waitForTimeout(120);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 200, y: 340, id: 0 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 200, y: 340, id: 0 }],
      });

      const recorded = await page.evaluate(() => (window as unknown as { __gestureActions: Array<{ action: string; step: number }> }).__gestureActions);
      expect(recorded).toEqual([
        { action: 'tabPrev', step: 2 },
        { action: 'serverPrev', step: 3 },
      ]);
    } finally {
      await browser.close();
    }
  });

  it('locks out 2-finger CDP touch completely without triggering navigation while allowing subsequent 1-finger gesture', { timeout: 45000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const gesturesPath = resolve(here, '../src/mobile-navigation-gestures.ts');

    const compiled = buildSync({
      stdin: {
        contents: `
          import { attachMobileNavigationGestures } from ${JSON.stringify(gesturesPath)};
          window.__actions = [];
          document.body.innerHTML = '<div class="pane" style="position:fixed;inset:0;touch-action:none"></div>';
          attachMobileNavigationGestures({
            isMobile: true,
            longPressMs: 60,
            onAction: (action, step) => {
              window.__actions.push({ action, step });
            },
          });
        `,
        resolveDir: resolve(here, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      await page.setContent('<body></body>');
      await page.addScriptTag({ content: compiled.outputFiles[0].text });

      const cdp = await context.newCDPSession(page);
      const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<[number, number, number]>) =>
        cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: points.map(([id, x, y]) => ({ id, x, y })),
        });

      // 2-finger swipe MUST lock out and emit 0 actions
      await send('touchStart', [[0, 260, 300], [1, 265, 350]]);
      await send('touchMove', [[0, 140, 300], [1, 145, 350]]);
      await send('touchEnd', [[0, 140, 300]]);
      await send('touchEnd', [[1, 145, 350]]);

      // Fresh 1-finger long-press + drag right -> must work cleanly afterwards
      await send('touchStart', [[0, 120, 300]]);
      await page.waitForTimeout(120);
      await send('touchMove', [[0, 190, 300]]);
      await send('touchEnd', [[0, 190, 300]]);

      const actions = await page.evaluate(() => (window as unknown as { __actions: Array<{ action: string; step: number }> }).__actions);
      expect(actions).toEqual([{ action: 'tabNext', step: 1 }]);
    } finally {
      await browser.close();
    }
  });
});
