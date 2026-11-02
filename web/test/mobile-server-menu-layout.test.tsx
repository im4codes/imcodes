/** @vitest-environment jsdom */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileServerMenu } from '../src/components/MobileServerMenu.js';
import { MobileSharedEntriesMenu } from '../src/components/MobileSharedEntriesMenu.js';
import type { SharedEntrySummary } from '../src/api.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const require = createRequire(import.meta.url);
const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const entries: SharedEntrySummary[] = Array.from({ length: 36 }, (_, index) => ({
  id: `shared-${index}`, serverId: `server-${index}`, serverName: `Server ${index}`,
  targetLabel: index === 0 ? '共享项目 very-long-name-without-spaces-0123456789' : `Shared ${index}`,
  role: 'participant', status: 'active', target: { kind: 'server', serverId: `server-${index}` },
}));

afterEach(() => { cleanup(); localStorage.clear(); });

function menu(onOpen = vi.fn()) {
  return render(<div class="layout-mobile"><div class="mobile-server-bar">
    <div class="mobile-server-switcher-wrap">
      <button class="mobile-server-btn">Servers</button>
      <MobileServerMenu>
        <button class="mobile-server-menu-item">Home</button>
        {Array.from({ length: 12 }, (_, index) => <button key={index}
          class="mobile-server-menu-item mobile-server-menu-server">
          <span>●</span><span class="mobile-server-menu-name">{`Owned ${index}`}</span>
        </button>)}
        <MobileSharedEntriesMenu entries={entries} onOpen={onOpen} onRefresh={vi.fn()} />
        <div class="mobile-server-menu-language"><button>Language</button></div>
      </MobileServerMenu>
    </div>
  </div></div>);
}

describe('mobile server menu shared-entry reachability', () => {
  it('opens the exact shared server selected at the end of a long list', () => {
    const onOpen = vi.fn();
    menu(onOpen);
    fireEvent.click(screen.getByRole('button', { name: /Shared 35/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(entries[35]);
  });

  for (const engine of ['chromium', 'webkit'] as const) {
    it(`keeps three columns and scrolls the entire shared list up/down in ${engine}`, async (context) => {
      const browserType = (require('playwright') as typeof import('playwright'))[engine];
      if (!require('node:fs').existsSync(browserType.executablePath())) {
        context.skip();
        return;
      }
      const view = menu();
      // Height tracking is tested separately with visualViewport; let the real
      // CSS viewport fallback size this serialized production component tree.
      view.container.querySelector('.mobile-server-menu')!.removeAttribute('style');
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true });
        for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 812, height: 375 }]) {
          await page.setViewportSize(viewport);
          await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${view.container.innerHTML}</body></html>`);
          const metrics = await page.locator('.mobile-server-menu').evaluate((element) => {
            const shared = element.querySelector('.shared-entries-list')!;
            return {
              scrollHeight: element.scrollHeight, height: element.clientHeight,
              columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
              sharedColumns: getComputedStyle(shared).gridTemplateColumns.split(' ').length,
              horizontalOverflow: element.scrollWidth - element.clientWidth,
              bottom: element.getBoundingClientRect().bottom,
            };
          });
          expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
          expect(metrics.columns).toBe(3);
          expect(metrics.sharedColumns).toBe(3);
          expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
          expect(metrics.bottom).toBeLessThanOrEqual(viewport.height);
          const bounds = await page.locator('.mobile-server-menu').boundingBox();
          await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
          await page.mouse.wheel(0, 10000);
          await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu').evaluate((element) => element.scrollTop)).toBeGreaterThan(0));
          const last = page.locator('.shared-entry-row').last();
          // Native hit-testing must reach the actual last entry, not hidden
          // overflow inside a shrunken shared section.
          await last.tap({ timeout: 2000 });
          await page.getByRole('button', { name: 'Language', exact: true }).tap();
          if (engine === 'chromium' && viewport.width === 375) {
            const session = await page.context().newCDPSession(page);
            const x = bounds!.x + bounds!.width / 2;
            const y = bounds!.y + 80;
            const before = await page.locator('.mobile-server-menu').evaluate((element) => element.scrollTop);
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 6; step++) {
              await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 35 }] });
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu').evaluate((element) => element.scrollTop)).toBeLessThan(before));
            await session.detach();
          }
          await page.mouse.wheel(0, -10000);
          await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu').evaluate((element) => element.scrollTop)).toBe(0));
          await page.getByRole('button', { name: 'Owned 0', exact: false }).tap();
        }
      } finally { await browser.close(); }
    }, 30_000);
  }
});
