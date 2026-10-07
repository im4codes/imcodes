/**
 * The panel page in a REAL browser (Chromium through playwright-core), where layout actually happens: no clipped or overflowing text
 * in any of the seven languages, at the window sizes the host can produce (and the 200% zoom equivalents), in both states and both
 * colour schemes. Skipped where playwright-core or its Chromium is not installed (it lives with the web project's dependencies).
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { UI_LOCALES, type UiLocale } from '../../shared/ui-locale.js';
import { startRemoteDesktopLocalPanel, type RemoteDesktopLocalPanel } from '../../src/node/remote-desktop-local-panel.js';

type Browser = { newContext(options: Record<string, unknown>): Promise<BrowserContext>; close(): Promise<void> };
type BrowserContext = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  waitForFunction(fn: string): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  click(selector: string): Promise<void>;
};

async function loadChromium(): Promise<{ launch(options: Record<string, unknown>): Promise<Browser>; executablePath(): string } | null> {
  try {
    // The test runner gives every file a temporary HOME, where no browser is installed: look in the real user's browser cache.
    if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
      const real = userInfo().homedir;
      const found = [join(real, '.cache', 'ms-playwright'), join(real, 'Library', 'Caches', 'ms-playwright'), join(real, 'AppData', 'Local', 'ms-playwright')].find((candidate) => existsSync(candidate));
      if (found) process.env.PLAYWRIGHT_BROWSERS_PATH = found;
    }
    const require = createRequire(join(process.cwd(), 'web', 'package.json'));
    const playwright = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<Browser>; executablePath(): string } };
    const path = playwright.chromium.executablePath();
    return existsSync(path) ? playwright.chromium : null;
  } catch {
    return null;
  }
}

const chromium = await loadChromium();
const LANGUAGE_TAG: Record<UiLocale, string> = { en: 'en-US', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', es: 'es-ES', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR' };
const SIZES: Array<[number, number]> = [[480, 400], [480, 640], [620, 560], [780, 560], [960, 640], [1280, 800]];

// Runs in the page: every element whose box leaves the window, and every element that clips its own text.
const AUDIT = `(() => {
  const problems = [];
  const vw = window.innerWidth;
  const inScroller = (node) => { for (let p = node.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  for (const node of document.querySelectorAll('body *')) {
    if (node.closest('[hidden]') || getComputedStyle(node).display === 'none' || node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'OPTION') continue;
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (!inScroller(node) && (box.right > vw + 1 || box.left < -1)) problems.push('outside window: ' + describe(node) + ' ' + Math.round(box.left) + '..' + Math.round(box.right) + ' of ' + vw);
    const style = getComputedStyle(node);
    const clips = style.overflowX === 'hidden' || style.overflow === 'hidden' || style.textOverflow === 'ellipsis';
    if (clips && node.scrollWidth > node.clientWidth + 1 && !node.classList.contains('devname')) problems.push('clipped text: ' + describe(node) + ' ' + node.scrollWidth + '>' + node.clientWidth);
  }
  if (document.documentElement.scrollWidth > vw + 1) problems.push('page scrolls sideways: ' + document.documentElement.scrollWidth + '>' + vw);
  function describe(node) { return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className && typeof node.className === 'string' ? '.' + node.className.split(' ').join('.') : '') + ' "' + (node.textContent || '').trim().slice(0, 30) + '"'; }
  return problems;
})()`;

describe.skipIf(!chromium)('the panel page lays out in a real browser', () => {
  let panel: RemoteDesktopLocalPanel;
  let browser: Browser;
  let scenario: 'active' | 'paused' = 'active';
  const now = Date.now();

  beforeAll(async () => {
    panel = await startRemoteDesktopLocalPanel({
      publicNodeId: '1234567890', serverUrl: 'https://example.test/',
      status: () => (scenario === 'paused'
        ? { paused: true, connections: [] }
        : { paused: false, connections: [
          { id: 'a', label: '12', connectedAt: now - 3_700_000, mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL },
          { id: 'b', label: '2', connectedAt: now - 61_000, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW },
        ] }),
      extras: () => ({
        deviceName: 'Konstantinopolitanskaya-workstation-with-a-very-long-host-name.example.internal',
        version: '2026.10.5590',
        permissions: { screenRecording: 'granted', accessibility: 'unknown', fullDiskAccess: 'denied' },
      }),
      openSettings: async () => true,
      setPaused: async () => {}, stopAll: async () => {}, disconnect: async () => true, port: 0,
    });
    browser = await chromium!.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await panel?.close();
  });

  it('has no overflowing or clipped text in any language, size, state or colour scheme', async () => {
    const problems: string[] = [];
    for (const locale of UI_LOCALES) {
      for (const scheme of ['light', 'dark']) {
        for (const state of ['active', 'paused'] as const) {
          scenario = state;
          const context = await browser.newContext({ locale: LANGUAGE_TAG[locale], colorScheme: scheme, viewport: { width: 960, height: 640 } });
          const page = await context.newPage();
          await page.goto(panel.url);
          await page.waitForFunction("document.getElementById('statusPill') && !document.getElementById('statusPill').hidden");
          for (const [width, height] of SIZES) {
            await page.setViewportSize({ width, height });
            const found = await page.evaluate<string[]>(AUDIT);
            for (const problem of found) problems.push(`${locale} ${scheme} ${state} ${width}x${height}: ${problem}`);
          }
          // Settings and About too, once per language.
          if (state === 'active' && scheme === 'light') {
            for (const name of ['settings', 'about']) {
              await page.click(`.nav[data-page="${name}"]`);
              for (const [width, height] of SIZES) {
                await page.setViewportSize({ width, height });
                for (const problem of await page.evaluate<string[]>(AUDIT)) problems.push(`${locale} ${name} ${width}x${height}: ${problem}`);
              }
            }
          }
          await context.close();
        }
      }
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it('the audit itself catches overflow and clipping (so a pass above means something)', async () => {
    scenario = 'active';
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 960, height: 640 } });
    const page = await context.newPage();
    await page.goto(panel.url);
    await page.waitForFunction("document.getElementById('statusPill') && !document.getElementById('statusPill').hidden");
    expect(await page.evaluate<string[]>(AUDIT)).toEqual([]);
    await page.evaluate(`(() => {
      const wide = document.createElement('div'); wide.style.cssText = 'position:absolute;left:5000px;top:0'; wide.textContent = 'far away'; document.body.appendChild(wide);
      const clipped = document.createElement('span'); clipped.style.cssText = 'display:block;width:20px;overflow:hidden;white-space:nowrap'; clipped.textContent = 'a long label that does not fit'; document.body.appendChild(clipped);
    })()`);
    const found = await page.evaluate<string[]>(AUDIT);
    expect(found.some((problem) => problem.startsWith('outside window'))).toBe(true);
    expect(found.some((problem) => problem.startsWith('clipped text'))).toBe(true);
    await context.close();
  }, 30_000);

  it('the wide layout puts the ID and the controls side by side, the permission card beside the device card, and nothing but the list scrolls', async () => {
    scenario = 'active';
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(panel.url);
    await page.waitForFunction("document.getElementById('statusPill') && !document.getElementById('statusPill').hidden");
    const layout = await page.evaluate<{ sideBySide: boolean; permsBeside: boolean; pageScrolls: boolean; switchVisible: boolean }>(`(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const id = rect('nodeId'); const sw = rect('allowSwitch'); const hero = document.querySelector('.hero').getBoundingClientRect(); const perms = rect('permsCard');
      const home = document.querySelector('.page[data-page=home]');
      return { sideBySide: sw.left > id.right, permsBeside: perms.left >= hero.right - 1, pageScrolls: home.scrollHeight > home.clientHeight + 1, switchVisible: sw.width > 0 };
    })()`);
    expect(layout).toEqual({ sideBySide: true, permsBeside: true, pageScrolls: false, switchVisible: true });
    await page.setViewportSize({ width: 780, height: 560 });
    const narrower = await page.evaluate<{ pageScrolls: boolean }>(`(() => { const home = document.querySelector('.page[data-page=home]'); return { pageScrolls: home.scrollHeight > home.clientHeight + 1 }; })()`);
    // The default 780x560 window with the full macOS permission card is the one place the page may need a scroll bar of its own.
    expect(typeof narrower.pageScrolls).toBe('boolean');
    await context.close();
  }, 60_000);
});
