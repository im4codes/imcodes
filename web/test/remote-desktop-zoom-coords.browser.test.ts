/**
 * @vitest-environment node
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME_MAC_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('RemoteDesktop zoom coordinates in real Chromium', () => {
  it('aligns mouse clicks, stage bounds, overlay hit-testing, and virtual-mouse round-trips across 60%–150% UI scale', { timeout: 60_000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    const executablePath = existsSync(chromium.executablePath())
      ? undefined
      : process.platform === 'darwin' && existsSync(CHROME_MAC_PATH)
        ? CHROME_MAC_PATH
        : null;
    if (executablePath === null) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const compiled = await build({
      stdin: {
        contents: `
          import { applyUiScale } from './src/ui-scale.js';
          import { mapRemoteDesktopVideoPoint } from '../shared/remote-desktop.js';
          import {
            resolveCssZoomMetrics,
            clientPointToRectSpace,
            clientPointToStageLocalCss,
            stageLocalCssToClientPoint,
          } from './src/remote-desktop-coords.js';
          import { isPointOverRemoteDesktopOverlay } from './src/remote-desktop-pointer-overlay.js';

          window.__rdProbe = {
            applyUiScale,
            measureAndBind(videoWidth, videoHeight, panelScale, panX, panY) {
              const stage = document.getElementById('stage');
              const video = document.getElementById('video');
              video.style.transform = \`translate3d(\${panX}px, \${panY}px, 0) scale(\${panelScale})\`;
              video.style.transformOrigin = 'center center';
              void stage.offsetHeight;
              window.__clicks = [];
              if (!window.__listenerBound) {
                window.__listenerBound = true;
                window.addEventListener('pointerdown', (e) => {
                  const stageRect = stage.getBoundingClientRect();
                  const videoRect = video.getBoundingClientRect();
                  const metrics = resolveCssZoomMetrics(document, window, stage);
                  const stagePt = clientPointToRectSpace(e.clientX, e.clientY, metrics);
                  const insideStage = stagePt.x >= stageRect.left && stagePt.x <= stageRect.right
                    && stagePt.y >= stageRect.top && stagePt.y <= stageRect.bottom;
                  const occluded = isPointOverRemoteDesktopOverlay(e.clientX, e.clientY);
                  const norm = mapRemoteDesktopVideoPoint({
                    clientX: stagePt.x,
                    clientY: stagePt.y,
                    viewportLeft: videoRect.left,
                    viewportTop: videoRect.top,
                    viewportWidth: videoRect.width,
                    viewportHeight: videoRect.height,
                    videoWidth: window.__vw,
                    videoHeight: window.__vh,
                  });
                  const local = clientPointToStageLocalCss(e.clientX, e.clientY, stageRect, metrics);
                  const roundTrip = stageLocalCssToClientPoint(local.x, local.y, stageRect, metrics);
                  const vmouse = document.getElementById('vmouse');
                  vmouse.style.left = \`\${local.x}px\`;
                  vmouse.style.top = \`\${local.y}px\`;
                  void vmouse.offsetHeight;
                  const vmRect = vmouse.getBoundingClientRect();
                  window.__clicks.push({
                    clientX: e.clientX,
                    clientY: e.clientY,
                    insideStage,
                    occluded,
                    norm,
                    local,
                    roundTrip,
                    vmCenterX: vmRect.left + vmRect.width / 2,
                    vmCenterY: vmRect.top + vmRect.height / 2,
                  });
                }, true);
              }
              window.__vw = videoWidth;
              window.__vh = videoHeight;
              return {
                stageRect: stage.getBoundingClientRect().toJSON(),
                videoRect: video.getBoundingClientRect().toJSON(),
                overlayRect: document.getElementById('overlay').getBoundingClientRect().toJSON(),
              };
            },
          };
        `,
        resolveDir: resolve(here, '..'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
    });

    const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.setContent(`
        <!doctype html>
        <html>
        <head>
          <style>
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
            #stage { position: relative; margin: 60px 0 0 80px; width: 400px; height: 300px; overflow: hidden; background: #111; }
            #video { width: 400px; height: 300px; background: #334; }
            #overlay { position: absolute; right: 8px; top: 8px; width: 60px; height: 40px; background: #933; }
            #vmouse { position: absolute; width: 10px; height: 10px; transform: translate(-50%, -50%); pointer-events: none; }
          </style>
        </head>
        <body>
          <div id="stage">
            <div id="video"></div>
            <div id="overlay" class="remote-desktop-file-window"></div>
            <div id="vmouse"></div>
          </div>
        </body>
        </html>
      `);
      await page.addScriptTag({ content: compiled.outputFiles[0].text });

      for (const pct of [60, 80, 100, 125, 150]) {
        await page.evaluate((scale) => (window as unknown as { __rdProbe: { applyUiScale(s: number): void } }).__rdProbe.applyUiScale(scale), pct);
        for (const [panelScale, panX, panY] of [[1, 0, 0], [2, 30, -20]] as const) {
          const rects = await page.evaluate(
            ([ps, px, py]) => (window as unknown as { __rdProbe: { measureAndBind(w: number, h: number, s: number, x: number, y: number): { stageRect: DOMRect; videoRect: DOMRect; overlayRect: DOMRect } } }).__rdProbe.measureAndBind(1920, 1080, ps, px, py),
            [panelScale, panX, panY],
          );
          const vr = rects.videoRect;
          const fitScale = Math.min(vr.width / 1920, vr.height / 1080);
          const cw = 1920 * fitScale;
          const ch = 1080 * fitScale;
          const cleft = vr.left + (vr.width - cw) / 2;
          const ctop = vr.top + (vr.height - ch) / 2;

          const targetX = cleft + cw * 0.5;
          const targetY = ctop + ch * 0.5;
          await page.mouse.click(targetX, targetY);

          const tx2 = cleft + cw * 0.25;
          const ty2 = ctop + ch * 0.25;
          const sr = rects.stageRect;
          const inStage2 = tx2 >= sr.left && tx2 <= sr.right && ty2 >= sr.top && ty2 <= sr.bottom;
          if (inStage2) {
            await page.mouse.click(tx2, ty2);
          }

          const ov = rects.overlayRect;
          await page.mouse.click(ov.left + ov.width / 2, ov.top + ov.height / 2);

          const clicks = await page.evaluate(() => (window as unknown as { __clicks: Array<{ insideStage: boolean; occluded: boolean; norm: { x: number; y: number } | null; roundTrip: { x: number; y: number }; vmCenterX: number; vmCenterY: number }> }).__clicks);
          const c0 = clicks[0]!;
          expect(c0.insideStage, `${pct}% scale=${panelScale} center insideStage`).toBe(true);
          expect(c0.occluded, `${pct}% scale=${panelScale} center occluded`).toBe(false);
          expect(c0.norm!.x).toBeCloseTo(0.5, 2);
          expect(c0.norm!.y).toBeCloseTo(0.5, 2);
          expect(c0.roundTrip.x).toBeCloseTo(targetX, 1);
          expect(c0.roundTrip.y).toBeCloseTo(targetY, 1);
          expect(c0.vmCenterX).toBeCloseTo(targetX, 1);
          expect(c0.vmCenterY).toBeCloseTo(targetY, 1);

          let overlayIdx = 1;
          if (inStage2) {
            const c1 = clicks[1]!;
            expect(c1.insideStage).toBe(true);
            expect(c1.norm!.x).toBeCloseTo(0.25, 2);
            expect(c1.norm!.y).toBeCloseTo(0.25, 2);
            expect(c1.vmCenterX).toBeCloseTo(tx2, 1);
            expect(c1.vmCenterY).toBeCloseTo(ty2, 1);
            overlayIdx = 2;
          }
          expect(clicks[overlayIdx]!.occluded, `${pct}% overlay hit-test`).toBe(true);
        }
      }
    } finally {
      await browser.close();
    }
  });
});
