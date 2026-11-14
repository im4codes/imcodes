/**
 * @vitest-environment node
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('mobile-navigation-gestures real Chromium multi-touch & unmount recovery', () => {
  it('triggers 1st, 2nd, and 3rd two-finger swipes cleanly across DOM unmount on remainingCount === 1', { timeout: 45000 }, async () => {
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
            onAction: (action) => {
              actions.push(action);
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

      // Gesture 1 (CDP real TouchEvents): both down simultaneously, swipe left, lift finger 0 first
      // (unmounts pane 0 before finger 1 lifts), then lift finger 1.
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: 260, y: 300, id: 0 },
          { x: 265, y: 350, id: 1 },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: 180, y: 300, id: 0 },
          { x: 185, y: 350, id: 1 },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 185, y: 350, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });

      // Gesture 2: trigger with remaining finger on old pane, and simulate dropped final touchend by
      // starting Gesture 3 simultaneously with new real Chromium TouchEvent (touches=2, changedTouches=2)
      // while finger 1 never fired touchEnd after pane 1 unmounted.
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: 120, y: 300, id: 0 },
          { x: 125, y: 350, id: 1 },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: 205, y: 300, id: 0 },
          { x: 210, y: 350, id: 1 },
        ],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 210, y: 350, id: 1 }],
      });

      // Dispatch a simultaneous 2-finger TouchEvent on the newly mounted pane with the same touch IDs
      // (0, 1) without sending the final touchEnd from Gesture 2.
      await page.evaluate(() => {
        const pane = document.querySelector('.session-pane')!;
        const tStart1 = new Touch({ identifier: 0, target: pane, clientX: 180, clientY: 400 });
        const tStart2 = new Touch({ identifier: 1, target: pane, clientX: 230, clientY: 405 });
        pane.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [tStart1, tStart2],
          targetTouches: [tStart1, tStart2],
          changedTouches: [tStart1, tStart2],
        }));

        const tMove1 = new Touch({ identifier: 0, target: pane, clientX: 180, clientY: 315 });
        const tMove2 = new Touch({ identifier: 1, target: pane, clientX: 230, clientY: 320 });
        pane.dispatchEvent(new TouchEvent('touchmove', {
          bubbles: true,
          cancelable: true,
          touches: [tMove1, tMove2],
          targetTouches: [tMove1, tMove2],
          changedTouches: [tMove1, tMove2],
        }));

        pane.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [tMove1, tMove2],
        }));
      });

      const recorded = await page.evaluate(() => (window as unknown as { __gestureActions: string[] }).__gestureActions);
      expect(recorded).toEqual(['tabPrev', 'tabNext', 'serverPrev']);
    } finally {
      await browser.close();
    }
  });
});
