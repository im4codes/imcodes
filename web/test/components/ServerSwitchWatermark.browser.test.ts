/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('ServerSwitchWatermark browser animation & cascade', () => {
  it('fades computed opacity and transform cleanly on exit, supports mid-exit retrigger, and honors prefers-reduced-motion in chromium', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }
    const { buildSync } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const componentPath = resolve(here, '../../src/components/ServerSwitchWatermark.tsx');
    const css = readFileSync(resolve(here, '../../src/styles.css'), 'utf8');

    const compiled = buildSync({
      stdin: {
        contents: `
          import { render } from 'preact';
          import { ServerSwitchWatermark } from ${JSON.stringify(componentPath)};
          window.__mountHud = (props) => {
            render(<ServerSwitchWatermark {...props} />, document.getElementById('root'));
          };
        `,
        resolveDir: resolve(here, '../..'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      jsx: 'automatic',
      jsxImportSource: 'preact',
      platform: 'browser',
    });
    const bundleCode = compiled.outputFiles[0].text;

    const browser = await chromium.launch({ headless: true });
    try {
      // 1. Normal motion: verify computed opacity & transform transition downward during exit (not locked at 1 by entry fill-mode)
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, colorScheme: 'dark', reducedMotion: 'no-preference' });
      await page.setContent(`<style>${css}</style><button id="focus-guard">Focus</button><div id="root"></div>`);
      await page.addScriptTag({ content: bundleCode });
      await page.locator('#focus-guard').focus();

      await page.evaluate(() => {
        const w = window as unknown as {
          __mountHud: (p: Record<string, unknown>) => void;
          __dismissCount?: number;
        };
        w.__dismissCount = 0;
        const onDismiss = () => {
          w.__dismissCount = (w.__dismissCount ?? 0) + 1;
          w.__mountHud({ visible: false, triggerKey: 1, serverName: 'Server One', sessionName: 'alpha', shortcutKeycaps: ['Ctrl', '↓'], onDismiss });
        };
        w.__mountHud({
          visible: true,
          triggerKey: 1,
          serverName: 'Server One',
          sessionName: 'alpha',
          shortcutKeycaps: ['Ctrl', '↓'],
          holdMs: 220,
          exitMs: 240,
          onDismiss,
        });
      });

      await page.waitForSelector('.server-switch-watermark');
      await page.waitForTimeout(170);
      const heldStyle = await page.evaluate(() => {
        const card = document.querySelector('.server-switch-watermark-card') as HTMLElement;
        const serverName = document.querySelector('.server-switch-watermark-server-name') as HTMLElement;
        const session = document.querySelector('.server-switch-watermark-session') as HTMLElement;
        const kbd = document.querySelector('.server-switch-watermark-kbd') as HTMLElement;
        const cs = getComputedStyle(card);
        const serverCs = getComputedStyle(serverName);
        const sessionCs = getComputedStyle(session);
        const kbdCs = getComputedStyle(kbd);
        return {
          state: card.parentElement?.getAttribute('data-state'),
          opacity: Number(cs.opacity),
          transform: cs.transform,
          pointerEvents: cs.pointerEvents,
          backgroundColor: cs.backgroundColor,
          borderStyle: cs.borderTopStyle,
          boxShadow: cs.boxShadow,
          backdropFilter: cs.backdropFilter,
          serverFontSize: parseFloat(serverCs.fontSize),
          serverColor: serverCs.color,
          sessionColor: sessionCs.color,
          kbdBackgroundColor: kbdCs.backgroundColor,
          kbdBorderStyle: kbdCs.borderTopStyle,
          kbdColor: kbdCs.color,
          activeId: document.activeElement?.id,
        };
      });
      expect(heldStyle.state).toBe('visible');
      expect(heldStyle.opacity).toBeGreaterThan(0.99);
      expect(heldStyle.pointerEvents).toBe('none');
      expect(heldStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(heldStyle.borderStyle).toBe('none');
      expect(heldStyle.boxShadow).toBe('none');
      expect(heldStyle.backdropFilter).toBe('none');
      expect(heldStyle.serverFontSize).toBeGreaterThanOrEqual(48);
      expect(heldStyle.serverColor).toMatch(/^rgba\([^)]+,\s*0\.\d+\)$/);
      expect(heldStyle.sessionColor).toMatch(/^rgba\([^)]+,\s*0\.\d+\)$/);
      expect(heldStyle.kbdBackgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(heldStyle.kbdBorderStyle).toBe('none');
      expect(heldStyle.kbdColor).toMatch(/^rgba\([^)]+,\s*0\.\d+\)$/);
      expect(heldStyle.activeId).toBe('focus-guard');

      await page.waitForFunction(() => document.querySelector('.server-switch-watermark')?.getAttribute('data-state') === 'exiting');
      await page.waitForTimeout(80);
      const midExit = await page.evaluate(() => {
        const card = document.querySelector('.server-switch-watermark-card') as HTMLElement;
        const cs = getComputedStyle(card);
        return {
          state: card.parentElement?.getAttribute('data-state'),
          opacity: Number(cs.opacity),
          transform: cs.transform,
          fillMode: cs.animationFillMode,
        };
      });
      expect(midExit.state).toBe('exiting');
      expect(midExit.opacity).toBeLessThan(0.95);
      expect(midExit.opacity).toBeGreaterThan(0);
      expect(midExit.transform).not.toBe(heldStyle.transform);

      // 2. Rapid retrigger mid-exit restores visible opacity=1 cleanly, updates server/keycaps, cancels old dismiss, then exits cleanly
      await page.evaluate(() => {
        const w = window as unknown as {
          __mountHud: (p: Record<string, unknown>) => void;
          __dismissCount?: number;
        };
        const onDismiss = () => {
          w.__dismissCount = (w.__dismissCount ?? 0) + 1;
          w.__mountHud({ visible: false, triggerKey: 2, serverName: 'Server Two', sessionName: 'delta', shortcutKeycaps: ['Ctrl', '↑'], onDismiss });
        };
        w.__mountHud({
          visible: true,
          triggerKey: 2,
          serverName: 'Server Two',
          sessionName: 'delta',
          shortcutKeycaps: ['Ctrl', '↑'],
          holdMs: 220,
          exitMs: 240,
          onDismiss,
        });
      });

      expect(await page.locator('[data-testid="server-switch-watermark"]').getAttribute('data-state')).toBe('visible');
      expect(await page.locator('[data-testid="server-switch-watermark-server"]').textContent()).toBe('Server Two');
      await page.waitForTimeout(190);
      const retriggeredOpacity = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.server-switch-watermark-card') as HTMLElement).opacity));
      expect(retriggeredOpacity).toBeGreaterThan(0.99);
      expect(await page.evaluate(() => (window as unknown as { __dismissCount: number }).__dismissCount)).toBe(0);

      await page.waitForFunction(() => document.querySelector('.server-switch-watermark')?.getAttribute('data-state') === 'exiting');
      await page.waitForTimeout(80);
      const secondExitOpacity = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.server-switch-watermark-card') as HTMLElement).opacity));
      expect(secondExitOpacity).toBeLessThan(0.95);

      await page.waitForFunction(() => (window as unknown as { __dismissCount: number }).__dismissCount === 1);
      expect(await page.locator('.server-switch-watermark').count()).toBe(0);

      // 3. Reduced motion disables entry animation & exit transition cleanly
      const reducedPage = await browser.newPage({ viewport: { width: 1100, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce' });
      await reducedPage.setContent(`<style>${css}</style><div id="root"></div>`);
      await reducedPage.addScriptTag({ content: bundleCode });
      await reducedPage.evaluate(() => {
        const w = window as unknown as { __mountHud: (p: Record<string, unknown>) => void };
        w.__mountHud({
          visible: true,
          triggerKey: 1,
          serverName: 'Light Server',
          sessionName: 'beta',
          shortcutKeycaps: ['⌘', '↓'],
          holdMs: 120,
          exitMs: 120,
          onDismiss: () => w.__mountHud({ visible: false, triggerKey: 1, serverName: 'Light Server', sessionName: 'beta', onDismiss: () => {} }),
        });
      });
      const reducedHold = await reducedPage.evaluate(() => {
        const card = document.querySelector('.server-switch-watermark-card') as HTMLElement;
        const serverName = document.querySelector('.server-switch-watermark-server-name') as HTMLElement;
        const cs = getComputedStyle(card);
        const serverCs = getComputedStyle(serverName);
        return {
          animationName: cs.animationName,
          transitionDuration: cs.transitionDuration,
          opacity: cs.opacity,
          backgroundColor: cs.backgroundColor,
          boxShadow: cs.boxShadow,
          serverColor: serverCs.color,
        };
      });
      expect(reducedHold.animationName).toBe('none');
      expect(reducedHold.transitionDuration).toBe('0s');
      expect(reducedHold.opacity).toBe('1');
      expect(reducedHold.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(reducedHold.boxShadow).toBe('none');
      expect(reducedHold.serverColor).toMatch(/^rgba\([^)]+,\s*0\.\d+\)$/);

      await reducedPage.waitForFunction(() => document.querySelector('.server-switch-watermark')?.getAttribute('data-state') === 'exiting');
      const reducedExit = await reducedPage.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.server-switch-watermark-card') as HTMLElement);
        return { opacity: cs.opacity, transform: cs.transform };
      });
      expect(reducedExit.opacity).toBe('0');
      expect(reducedExit.transform).toBe('none');
    } finally {
      await browser.close();
    }
  });
});
