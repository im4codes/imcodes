/**
 * @vitest-environment node
 *
 * Real Chromium geometry tests for `.chat-pinned-last-sent`:
 * verifies tall (>viewport) message bubbles crossing the top -4px/+8px
 * thresholds in small scroll steps (including 1px boundary crossings where native
 * IntersectionObserver `[0, 1]` alone delivers no further events).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('ChatView — pinned last-sent banner real Chromium boundary geometry', () => {
  it('shows and hides .chat-pinned-last-sent reliably for tall rows across 1px top-boundary steps in real Chromium', { timeout: 45000 }, async () => {
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
                sessionId="deck_test_brain"
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
      const page = await browser.newPage({
        viewport: { width: 390, height: 600 },
        colorScheme: 'dark',
      });
      await page.route('https://imcodes.test/**', async (route) => {
        const url = route.request().url();
        if (url === 'https://imcodes.test/test.html') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><style>${css}
              #root { width: 360px; }
              .chat-main { display: flex; flex-direction: column; overflow: visible !important; height: auto !important; }
              .chat-view { flex: none !important; height: 100px !important; max-height: 100px !important; overflow-y: auto !important; padding: 0 !important; }
              [data-event-id="u-tall"] { height: 160px !important; min-height: 160px !important; margin: 0 !important; box-sizing: border-box !important; }
              .chat-assistant, .chat-event { min-height: 80px; }
            </style></head><body><div id="root"></div></body></html>`,
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto('https://imcodes.test/test.html');
      await page.addScriptTag({ content: bundleCode });

      const events = [
        {
          eventId: 'u-tall',
          type: 'user.message',
          sessionId: 'deck_test_brain',
          ts: 1000,
          epoch: 1,
          seq: 1,
          source: 'daemon',
          confidence: 'high',
          payload: { text: 'Tall prompt message above assistant replies' },
        },
        ...Array.from({ length: 8 }, (_, idx) => ({
          eventId: `a-${idx + 1}`,
          type: 'assistant.text',
          sessionId: 'deck_test_brain',
          ts: 2000 + idx * 100,
          epoch: 1,
          seq: 2 + idx,
          source: 'daemon',
          confidence: 'high',
          payload: { text: `Assistant reply chunk ${idx + 1}`, streaming: false },
        })),
      ];

      await page.evaluate(async (ev) => {
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const scrollEl = document.querySelector('.chat-view') as HTMLElement;
        // User scrolls away from bottom first (just like normal reading in browser)
        // so follow mode does not re-pin scrollTop while stepping across boundaries.
        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      }, events);

      const stepToTargetBottomOffset = async (desiredDeltaFromRootTop: number) => {
        return page.evaluate(async (desired) => {
          const scrollEl = document.querySelector('.chat-view') as HTMLElement;
          const target = document.querySelector('[data-event-id="u-tall"]') as HTMLElement;
          const currentDelta = target.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top;
          scrollEl.scrollTop += currentDelta - desired;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          return {
            delta: target.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top,
            hasBanner: Boolean(document.querySelector('.chat-pinned-last-sent')),
          };
        }, desiredDeltaFromRootTop);
      };

      // Step downward across top edge: +10 -> -1 (deadband: stay hidden) -> -18 (must appear!)
      const s10 = await stepToTargetBottomOffset(10);
      expect(s10.delta).toBeCloseTo(10, 0);
      expect(s10.hasBanner).toBe(false);

      const sNeg1 = await stepToTargetBottomOffset(-1);
      expect(sNeg1.delta).toBeCloseTo(-1, 0);
      expect(sNeg1.hasBanner).toBe(false);

      const sNeg18 = await stepToTargetBottomOffset(-18);
      expect(sNeg18.delta).toBeCloseTo(-18, 0);
      expect(sNeg18.hasBanner).toBe(true);

      // Step further above (-30), then reverse upward: +1 (deadband: stay shown) -> +50 (must hide even though row=160px > root=100px!)
      const sNeg30 = await stepToTargetBottomOffset(-30);
      expect(sNeg30.delta).toBeCloseTo(-30, 0);
      expect(sNeg30.hasBanner).toBe(true);

      const sPos1 = await stepToTargetBottomOffset(1);
      expect(sPos1.delta).toBeCloseTo(1, 0);
      expect(sPos1.hasBanner).toBe(true);

      const sPos50 = await stepToTargetBottomOffset(50);
      expect(sPos50.delta).toBeCloseTo(50, 0);
      expect(sPos50.hasBanner).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it('re-binds .chat-pinned-last-sent after the target bubble unmounts and remounts across virtualized scrolling', { timeout: 45000 }, async () => {
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
                sessionId="deck_test_virtual_pin"
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
      const page = await browser.newPage({
        viewport: { width: 390, height: 600 },
        colorScheme: 'dark',
      });
      await page.route('https://imcodes.test/**', async (route) => {
        const url = route.request().url();
        if (url === 'https://imcodes.test/test.html') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><style>${css}
              #root { width: 360px; }
              .chat-main { display: flex; flex-direction: column; overflow: visible !important; height: auto !important; }
              .chat-view { flex: none !important; height: 200px !important; max-height: 200px !important; overflow-y: auto !important; padding: 0 !important; }
              .chat-user, .chat-assistant, .chat-event { min-height: 90px; box-sizing: border-box !important; }
              [data-event-id="u-last"] { height: 120px !important; min-height: 120px !important; }
              [data-event-id="a-tail-block"] { min-height: 120px; }
              .tail-grown [data-event-id="a-tail-block"] { min-height: 420px; }
            </style></head><body><div id="root"></div></body></html>`,
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto('https://imcodes.test/test.html');
      await page.addScriptTag({ content: bundleCode });

      const baseEvents = Array.from({ length: 74 }, (_, idx) => {
        if (idx === 72) {
          return {
            eventId: 'u-last',
            type: 'user.message',
            sessionId: 'deck_test_virtual_pin',
            ts: 1000 + idx * 100,
            epoch: 1,
            seq: idx + 1,
            source: 'daemon',
            confidence: 'high',
            payload: { text: 'Last sent prompt near tail of virtualized session' },
          };
        }
        if (idx === 73) {
          return {
            eventId: 'a-tail-block',
            type: 'assistant.text',
            sessionId: 'deck_test_virtual_pin',
            ts: 1000 + idx * 100,
            epoch: 1,
            seq: idx + 1,
            source: 'daemon',
            confidence: 'high',
            payload: { text: 'Initial short assistant reply after u-last', streaming: false },
          };
        }
        return {
          eventId: `m-${idx + 1}`,
          type: idx % 2 === 0 ? 'user.message' : 'assistant.text',
          sessionId: 'deck_test_virtual_pin',
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
      await page.evaluate(() => {
        (window as unknown as { __initialTargetNode: Element | null }).__initialTargetNode = document.querySelector('[data-event-id="u-last"]');
      });

      // Scroll up to early history so u-last disconnects from the virtualized DOM, then scroll back down to bottom.
      await page.evaluate(() => {
        const scrollEl = document.querySelector('.chat-view') as HTMLElement;
        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        scrollEl.scrollTop = 0;
      });
      await page.waitForFunction(() => {
        const initial = (window as unknown as { __initialTargetNode: Element | null }).__initialTargetNode;
        return Boolean(initial && !initial.isConnected && !document.querySelector('[data-event-id="u-last"]'));
      }, { timeout: 5000 });

      await page.evaluate(() => {
        const scrollEl = document.querySelector('.chat-view') as HTMLElement;
        scrollEl.scrollTop = scrollEl.scrollHeight;
      });
      await page.waitForFunction(() => {
        const initial = (window as unknown as { __initialTargetNode: Element | null }).__initialTargetNode;
        const current = document.querySelector('[data-event-id="u-last"]');
        return Boolean(current && current.isConnected && current !== initial);
      }, { timeout: 5000 });

      // Grow tail below u-last and push its bottom to -25px above root top -> banner MUST appear on the remounted node.
      const grownEvents = [
        ...baseEvents.slice(0, 73),
        {
          eventId: 'a-tail-block',
          type: 'assistant.text',
          sessionId: 'deck_test_virtual_pin',
          ts: 1000 + 73 * 100,
          epoch: 1,
          seq: 74,
          source: 'daemon',
          confidence: 'high',
          payload: { text: 'Initial short assistant reply after u-last\n\nGrown tail output pushing prompt above top edge', streaming: false },
        },
      ];

      await page.evaluate(async (ev) => {
        document.body.classList.add('tail-grown');
        await (window as unknown as { __mountChat: (e: unknown[]) => Promise<void> }).__mountChat(ev);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, grownEvents);

      const stepTo = async (desired: number) => page.evaluate(async (targetOffset) => {
        const scrollEl = document.querySelector('.chat-view') as HTMLElement;
        const target = document.querySelector('[data-event-id="u-last"]') as HTMLElement;
        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }));
        const current = target.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top;
        scrollEl.scrollTop += current - targetOffset;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          delta: target.getBoundingClientRect().bottom - scrollEl.getBoundingClientRect().top,
          hasBanner: Boolean(document.querySelector('.chat-pinned-last-sent')),
        };
      }, desired);

      const above25 = await stepTo(-25);
      expect(above25.delta).toBeLessThanOrEqual(-18);
      expect(above25.hasBanner).toBe(true);

      const inside50 = await stepTo(50);
      expect(inside50.delta).toBeGreaterThanOrEqual(20);
      expect(inside50.hasBanner).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
