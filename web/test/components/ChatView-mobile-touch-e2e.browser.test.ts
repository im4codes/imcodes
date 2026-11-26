/**
 * @vitest-environment node
 *
 * End-to-end mobile touch (390x844, hasTouch: true) Playwright Chromium test
 * verifying the complete scroll/pin lifecycle on real `ChatView`:
 *   1. Smooth bottom follow during live streaming chunks.
 *   2. Zero scrollTop snap-back on same-touch upward reversal + slow upward drag
 *      inside `reengageThreshold`, even while streaming chunks and multi-frame checks run.
 *   3. Zero `.chat-pinned-last-sent` flicker across -4px/+8px boundaries and clean
 *      target re-binding after virtualized unmount/remount.
 *   4. Clean re-engagement when scrolling back down to the bottom.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('ChatView — mobile touch (390x844) real Chromium end-to-end verification', () => {
  it('stays smooth across streaming, same-touch reversal, slow upward drag, banner transitions, virtualizer remount, and bottom re-engage', { timeout: 60000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(here, '../..');
    const chatViewPath = resolve(webDir, 'src/components/ChatView.tsx');
    const i18nPath = resolve(webDir, 'src/i18n/index.ts');
    const css = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');

    const compiled = buildSync({
      absWorkingDir: webDir,
      stdin: {
        contents: `
          import { render } from 'preact';
          import i18n from ${JSON.stringify(i18nPath)};
          import { ChatView } from ${JSON.stringify(chatViewPath)};
          window.__mountChat = async (events) => {
            await i18n.changeLanguage('en');
            render(
              <ChatView
                events={events}
                loading={false}
                hasOlderHistory={false}
                sessionId="deck_mobile_e2e_brain"
                visible={true}
              />,
              document.getElementById('root'),
            );
          };
        `,
        resolveDir: webDir,
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
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme: 'dark',
      });
      const page = await context.newPage();
      await page.route('https://imcodes.test/**', async (route) => {
        const url = route.request().url();
        if (url === 'https://imcodes.test/mobile.html') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>${css}
              html, body, #root { margin: 0; padding: 0; width: 390px; height: 844px !important; max-height: 844px !important; overflow: hidden !important; }
              .chat-main { height: 844px !important; max-height: 844px !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; }
              .chat-view { flex: 1 1 0% !important; height: 0 !important; min-height: 0 !important; overflow-y: auto !important; }
              .chat-user, .chat-assistant, .chat-event { min-height: 88px; box-sizing: border-box !important; }
              [data-event-id="u-last"] { height: 150px !important; min-height: 150px !important; }
              [data-event-id="a-stream"] { min-height: 120px; }
              .tail-grown [data-event-id="a-stream"] { min-height: 980px; }
            </style></head><body><div id="root"></div></body></html>`,
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto('https://imcodes.test/mobile.html');
      await page.addScriptTag({ content: bundleCode });

      const baseEvents = Array.from({ length: 60 }, (_, idx) => {
        if (idx === 58) {
          return {
            eventId: 'u-last',
            type: 'user.message',
            sessionId: 'deck_mobile_e2e_brain',
            ts: 1000 + idx * 100,
            epoch: 1,
            seq: idx + 1,
            source: 'daemon',
            confidence: 'high',
            payload: { text: 'Mobile scroll verification last prompt' },
          };
        }
        if (idx === 59) {
          return {
            eventId: 'a-stream',
            type: 'assistant.text',
            sessionId: 'deck_mobile_e2e_brain',
            ts: 1000 + idx * 100,
            epoch: 1,
            seq: idx + 1,
            source: 'daemon',
            confidence: 'high',
            payload: { text: 'Streaming chunk 0', streaming: true },
          };
        }
        return {
          eventId: `m-${idx + 1}`,
          type: idx % 2 === 0 ? 'user.message' : 'assistant.text',
          sessionId: 'deck_mobile_e2e_brain',
          ts: 1000 + idx * 100,
          epoch: 1,
          seq: idx + 1,
          source: 'daemon',
          confidence: 'high',
          payload: { text: `History message ${idx + 1}`, ...(idx % 2 === 1 ? { streaming: false } : {}) },
        };
      });

      await page.evaluate(async (ev) => {
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
      }, baseEvents);
      await page.waitForFunction(() => Boolean(document.querySelector('[data-virtual-key] [data-event-id="u-last"]')), { timeout: 5000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      // 1) Live streaming stays smoothly pinned at bottom.
      for (let chunk = 1; chunk <= 3; chunk++) {
        const streamed = [
          ...baseEvents.slice(0, 59),
          {
            ...baseEvents[59],
            payload: { text: `Streaming chunk ${chunk}\n\n${'Line of response.\n'.repeat(chunk * 2)}`, streaming: chunk < 3 },
          },
        ];
        await page.evaluate(async (ev) => {
          await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }, streamed);
        const streamPos = await page.evaluate(() => {
          const el = document.querySelector('.chat-view') as HTMLElement;
          return {
            distance: el.scrollHeight - el.clientHeight - el.scrollTop,
            hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
          };
        });
        expect(streamPos.distance).toBeLessThanOrEqual(2);
        expect(streamPos.hasScrollBtn).toBe(false);
      }

      // 2) Real Chromium CDP Input.dispatchTouchEvent: pull-to-bottom + same-touch upward reversal
      //    + slow upward drag inside reengageThreshold while a live streaming chunk also arrives.
      //    Record per-frame + scroll-event samples with ZERO direct JS scrollTop writes and assert
      //    monotonic upward progress with zero snap-back toward the bottom.
      const cdp = await context.newCDPSession(page);
      const startScrollTop = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        const sampler = {
          samples: [] as Array<{ scrollTop: number; hasScrollBtn: boolean }>,
          active: true,
          phase: 'reversal' as 'reversal' | 'postDrag',
          reversalSamples: [] as Array<{ scrollTop: number; hasScrollBtn: boolean }>,
        };
        const record = () => {
          const item = {
            scrollTop: el.scrollTop,
            hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
          };
          sampler.samples.push(item);
          if (sampler.phase === 'reversal') sampler.reversalSamples.push(item);
        };
        const onScroll = () => record();
        const tick = () => {
          record();
          if (sampler.active) requestAnimationFrame(tick);
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        const win = window as unknown as {
          __touchSampler: typeof sampler;
          __stopTouchSampler: () => void;
        };
        win.__touchSampler = sampler;
        win.__stopTouchSampler = () => {
          sampler.active = false;
          el.removeEventListener('scroll', onScroll);
        };
        requestAnimationFrame(tick);
        return el.scrollTop;
      });

      const sendTouch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) => {
        await cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: 195, y, id: 0 }],
        });
      };

      // Finger starts at y=580, drags upward on screen (pulling to bottom) to y=420,
      // then reverses downward on screen (scrolling UP into history) WITHOUT lifting finger.
      await sendTouch('touchStart', 580);
      await page.waitForTimeout(16);
      await sendTouch('touchMove', 500);
      await page.waitForTimeout(16);
      await sendTouch('touchMove', 420);
      await page.waitForTimeout(16);
      // Same-touch reversal downward on screen (y increases 420 -> 580 -> 660) -> drags viewport UP
      for (const y of [440, 470, 505, 540, 580, 620, 660]) {
        await sendTouch('touchMove', y);
        await page.waitForTimeout(16);
      }
      await sendTouch('touchEnd', 660);
      await page.waitForTimeout(100);

      // Slow second upward CDP drag (40px step) while inside/near reengageThreshold
      await sendTouch('touchStart', 480);
      await page.waitForTimeout(16);
      for (const y of [496, 512, 530]) {
        await sendTouch('touchMove', y);
        await page.waitForTimeout(16);
      }
      await sendTouch('touchEnd', 530);
      // Let compositor momentum finish completely before taking pre-stream baseline
      await page.evaluate(() => new Promise<void>((resolve) => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        let last = el.scrollTop;
        let sameCount = 0;
        const check = () => {
          const cur = el.scrollTop;
          if (Math.abs(cur - last) <= 0.5) {
            sameCount += 1;
            if (sameCount >= 4) { resolve(); return; }
          } else {
            sameCount = 0;
            last = cur;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }));

      const touchReversalResult = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        const win = window as unknown as {
          __touchSampler: {
            samples: Array<{ scrollTop: number; hasScrollBtn: boolean }>;
            reversalSamples: Array<{ scrollTop: number; hasScrollBtn: boolean }>;
          };
          __stopTouchSampler: () => void;
        };
        win.__stopTouchSampler();
        return {
          finalUpTop: el.scrollTop,
          distance: el.scrollHeight - el.clientHeight - el.scrollTop,
          hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          samples: win.__touchSampler.samples,
        };
      });

      expect(touchReversalResult.scrollHeight).toBeGreaterThan(touchReversalResult.clientHeight + 1000);
      // Real CDP compositor drag genuinely scrolled up inside/near reengageThreshold without JS setting scrollTop
      expect(touchReversalResult.finalUpTop).toBeLessThan(startScrollTop - 15);
      expect(touchReversalResult.hasScrollBtn).toBe(true);
      // Every sample once upward scroll started must remain strictly below startScrollTop and never snap back toward bottom (> +1px reversal)
      const movedUpSamples = touchReversalResult.samples.filter((s) => s.scrollTop < startScrollTop - 1);
      expect(movedUpSamples.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < movedUpSamples.length; i++) {
        expect(movedUpSamples[i].scrollTop).toBeLessThanOrEqual(movedUpSamples[i - 1].scrollTop + 1);
      }
      expect(Math.max(...movedUpSamples.map((s) => s.scrollTop))).toBeLessThan(startScrollTop);

      // Stream another chunk while user sits scrolled up -> must NOT snap back down!
      const preStreamTop = touchReversalResult.finalUpTop;
      await page.evaluate(async (ev) => {
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, [
        ...baseEvents.slice(0, 59),
        {
          ...baseEvents[59],
          payload: { text: `Streaming chunk 3\n\n${'Line of response.\n'.repeat(6)}\nExtra streaming delta while user reads`, streaming: true },
        },
      ]);
      const postStreamWhileReading = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        return {
          scrollTop: el.scrollTop,
          hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
        };
      });
      expect(postStreamWhileReading.scrollTop).toBe(preStreamTop);
      expect(postStreamWhileReading.hasScrollBtn).toBe(true);

      // 3) .chat-pinned-last-sent stability across boundary + virtualized unmount/remount
      await page.evaluate(async (ev) => {
        document.body.classList.add('tail-grown');
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        (window as unknown as { __initialTarget: Element | null }).__initialTarget = document.querySelector('[data-event-id="u-last"]');
      }, [
        ...baseEvents.slice(0, 59),
        {
          ...baseEvents[59],
          payload: { text: 'Tall tail content', streaming: false },
        },
      ]);

      // Scroll to top -> u-last unmounts, then scroll back -> remounts, then verify -22px show and +50px hide with 0 flicker
      await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        el.scrollTop = 0;
      });
      await page.waitForFunction(() => {
        const initial = (window as unknown as { __initialTarget: Element | null }).__initialTarget;
        return Boolean(initial && !initial.isConnected && !document.querySelector('[data-event-id="u-last"]'));
      }, { timeout: 5000 });
      await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForFunction(() => Boolean(document.querySelector('[data-event-id="u-last"]')), { timeout: 5000 });

      const stepBanner = async (desiredOffset: number) => page.evaluate(async (targetY) => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        const target = document.querySelector('[data-event-id="u-last"]') as HTMLElement;
        const delta = target.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
        el.scrollTop += delta - targetY;
        const states: boolean[] = [];
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          states.push(Boolean(document.querySelector('.chat-pinned-last-sent')));
        }
        return states;
      }, desiredOffset);

      const statesAbove = await stepBanner(-22);
      expect(statesAbove[statesAbove.length - 1]).toBe(true);
      // Zero transient off/on flicker once visible
      expect(statesAbove.slice(1).every((s) => s === true)).toBe(true);

      const statesInside = await stepBanner(50);
      expect(statesInside[statesInside.length - 1]).toBe(false);
      expect(statesInside.slice(1).every((s) => s === false)).toBe(true);

      // 4) Real CDP touch drag back down to bottom cleanly re-engages auto-follow
      await sendTouch('touchStart', 650);
      await page.waitForTimeout(16);
      for (const y of [570, 480, 390, 300, 210]) {
        await sendTouch('touchMove', y);
        await page.waitForTimeout(16);
      }
      await sendTouch('touchEnd', 210);
      await page.waitForTimeout(150);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      const beforeReengage = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          distance: el.scrollHeight - el.clientHeight - el.scrollTop,
          hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
        };
      });
      expect(beforeReengage.distance).toBeLessThanOrEqual(2);
      expect(beforeReengage.hasScrollBtn).toBe(false);
      await page.evaluate(async (ev) => {
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, [
        ...baseEvents.slice(0, 59),
        {
          ...baseEvents[59],
          payload: { text: 'Tall tail content\n\nFinal follow verification line\n\nMore output', streaming: false },
        },
      ]);
      const reengagedBottom = await page.evaluate(() => {
        const el = document.querySelector('.chat-view') as HTMLElement;
        return {
          distance: el.scrollHeight - el.clientHeight - el.scrollTop,
          hasScrollBtn: Boolean(document.querySelector('.chat-scroll-btn')),
        };
      });
      expect(reengagedBottom.distance).toBeLessThanOrEqual(2);
      expect(reengagedBottom.hasScrollBtn).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
