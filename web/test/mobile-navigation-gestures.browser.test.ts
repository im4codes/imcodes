/**
 * @vitest-environment node
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('mobile-navigation-gestures real Chromium multi-touch & unmount recovery', () => {
  it('recovers across 2nd and 3rd swipes when pane unmounts at remainingCount === 1 (CDP rounds 1-2, synthetic TouchEvent round 3)', { timeout: 45000 }, async () => {
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

      // Gesture 1 (native CDP TouchEvents): both down simultaneously, swipe left, lift id 0 first
      // (unmounts pane 0 while id 1 stays down on detached pane 0), then lift id 1.
      // Note: CDP `Input.dispatchTouchEvent` `touchEnd` takes ONLY the released touch point(s).
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
        touchPoints: [{ x: 180, y: 300, id: 0 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: 185, y: 350, id: 1 }],
      });

      // Gesture 2 (native CDP TouchEvents): swipe right, lift id 0 first -> triggers tabNext and unmounts pane 1.
      // Do NOT send final touchEnd for id 1 in CDP, leaving window tracker in post-trigger state with detached target.
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
        touchPoints: [{ x: 205, y: 300, id: 0 }],
      });

      // Gesture 3 (synthetic DOM TouchEvent in Chromium): simulates OS dropping final touchend after unmount
      // followed by simultaneous 2-finger landing with reused IDs (0, 1) on the newly mounted pane.
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

  it('preserves single-trigger latch in pure CDP TouchEvents when surviving finger stays down across DOM unmount (including move before adding finger 2)', { timeout: 45000 }, async () => {
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
          window.__events = [];
          const mount = () => {
            document.body.innerHTML = '<div class="pane" style="position:fixed;inset:0;touch-action:none"></div>';
          };
          mount();
          for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
            window.addEventListener(type, (e) => {
              window.__events.push({
                type,
                touches: [...e.touches].map((t) => ({ id: t.identifier, connected: t.target.isConnected })),
                changed: [...e.changedTouches].map((t) => t.identifier),
              });
            }, true);
          }
          attachMobileNavigationGestures({
            isMobile: true,
            onAction: (action) => {
              window.__actions.push(action);
              mount();
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

      // Swipe left with [0, 1], lift id 0 -> triggers tabPrev & unmounts old pane while id 1 stays down.
      await send('touchStart', [[0, 260, 300], [1, 265, 350]]);
      await send('touchMove', [[0, 180, 300], [1, 185, 350]]);
      await send('touchEnd', [[0, 180, 300]]);

      // Held id 1 moves on detached target, then user adds id 2 on newly mounted pane and swipes left.
      await send('touchMove', [[1, 185, 360]]);
      await send('touchStart', [[1, 185, 360], [2, 260, 400]]);
      await send('touchMove', [[1, 105, 360], [2, 180, 400]]);
      await send('touchEnd', [[2, 180, 400]]);

      // Same continuous touch session must not navigate twice.
      let result = await page.evaluate(() => ({
        actions: (window as unknown as { __actions: string[] }).__actions,
        events: (window as unknown as { __events: Array<{ type: string; touches: Array<{ id: number; connected: boolean }>; changed: number[] }> }).__events,
      }));
      expect(result.actions).toEqual(['tabPrev']);
      expect(result.events.some((ev) => ev.type === 'touchstart' && ev.changed.length === 1 && ev.changed[0] === 2 && ev.touches.some((t) => t.id === 1 && !t.connected))).toBe(true);

      // Finally lift held id 1, then run a fresh CDP 2-finger swipe right -> must trigger tabNext cleanly.
      await send('touchEnd', [[1, 105, 360]]);
      await send('touchStart', [[0, 120, 300], [1, 125, 350]]);
      await send('touchMove', [[0, 200, 300], [1, 205, 350]]);
      await send('touchEnd', [[0, 200, 300]]);
      await send('touchEnd', [[1, 205, 350]]);

      result = await page.evaluate(() => ({
        actions: (window as unknown as { __actions: string[] }).__actions,
        events: (window as unknown as { __events: Array<{ type: string; touches: Array<{ id: number; connected: boolean }>; changed: number[] }> }).__events,
      }));
      expect(result.actions).toEqual(['tabPrev', 'tabNext']);
    } finally {
      await browser.close();
    }
  });
});
