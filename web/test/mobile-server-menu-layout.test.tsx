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

function menu(onOpen = vi.fn(), onSelectServer = vi.fn(), onClose = vi.fn()) {
  return render(
    <div class="layout-mobile">
      <div class="mobile-server-bar">
        <div class="mobile-server-switcher-wrap">
          <button class="mobile-server-btn">Servers</button>
          <MobileServerMenu footer={<button>Language</button>}>
            <button class="mobile-server-menu-item" onClick={onClose}>Home</button>
            {Array.from({ length: 12 }, (_, index) => (
              <button
                key={index}
                class="mobile-server-menu-item mobile-server-menu-server"
                onClick={() => onSelectServer(index)}
              >
                <span>●</span><span class="mobile-server-menu-name">{`Owned ${index}`}</span>
              </button>
            ))}
            <MobileSharedEntriesMenu entries={entries} onOpen={onOpen} onRefresh={vi.fn()} />
          </MobileServerMenu>
        </div>
      </div>
      <div class="mobile-server-backdrop" onClick={onClose} />
      <div class="main">
        <div class="chat-container">
          <p>Main active session behind backdrop</p>
        </div>
      </div>
    </div>
  );
}

function desktopMenu(onOpen = vi.fn()) {
  return render(
    <div class="layout">
      <div class="mobile-server-bar">
        <button class="mobile-server-btn">Hidden Mobile Bar</button>
      </div>
      <aside class="sidebar">
        <div class="sidebar-header">Servers</div>
        <div class="sidebar-body">
          <div class="sidebar-servers">
            {Array.from({ length: 4 }, (_, index) => (
              <button key={index} class="server-item">
                <span>●</span><span>{`Desktop Server ${index}`}</span>
              </button>
            ))}
            <MobileSharedEntriesMenu entries={entries.slice(0, 5)} onOpen={onOpen} onRefresh={vi.fn()} />
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="chat-container">
          <p>Desktop main workspace</p>
        </div>
      </main>
    </div>
  );
}

describe('mobile server menu shared-entry reachability', () => {
  it('opens the exact shared server selected at the end of a long list', () => {
    const onOpen = vi.fn();
    menu(onOpen);
    fireEvent.click(screen.getByRole('button', { name: /Shared 35/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(entries[35]);
  });

  it('runs desktop smoke verifying mobile bar is hidden and sidebar shared entries are interactive', async () => {
    const browserType = (require('playwright') as typeof import('playwright')).chromium;
    if (!require('node:fs').existsSync(browserType.executablePath())) {
      return;
    }
    const view = desktopMenu();
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${view.container.innerHTML}</body></html>`);
      const mobileBarDisplay = await page.locator('.mobile-server-bar').evaluate((el) => getComputedStyle(el).display);
      expect(mobileBarDisplay).toBe('none');
      const sidebarDisplay = await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).display);
      expect(sidebarDisplay).not.toBe('none');
      const firstShared = page.locator('.shared-entry-row').first();
      expect(await firstShared.isVisible()).toBe(true);
      await firstShared.click();
    } finally {
      await browser.close();
    }
  });

  for (const engine of ['chromium', 'webkit'] as const) {
    it(`keeps three columns and scrolls the entire shared list up/down with backdrop in ${engine}`, async (context) => {
      const browserType = (require('playwright') as typeof import('playwright'))[engine];
      if (!require('node:fs').existsSync(browserType.executablePath())) {
        context.skip();
        return;
      }
      const view = menu();
      view.container.querySelector('.mobile-server-menu')!.removeAttribute('style');
      const browser = await browserType.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true });
        // Test required mobile viewports: 320 (compact), 393 (iPhone standard), 430 (iPhone Max), and 812x375 (landscape)
        const viewports = [
          { width: 320, height: 640 },
          { width: 393, height: 852 },
          { width: 430, height: 932 },
          { width: 812, height: 375 },
        ];
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${view.container.innerHTML}</body></html>`);
          const metrics = await page.locator('.mobile-server-menu-body').evaluate((element) => {
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

          const footerBefore = await page.locator('.mobile-server-menu-language').boundingBox();
          const menuBox = await page.locator('.mobile-server-menu').boundingBox();
          expect(footerBefore!.y + footerBefore!.height).toBeGreaterThan(menuBox!.y + menuBox!.height - 40);
          // Verify owned server button is clickable through native tap without backdrop obstruction
          const ownedBtn = page.getByRole('button', { name: 'Owned 0', exact: false });
          expect(await ownedBtn.isVisible()).toBe(true);
          await ownedBtn.tap({ timeout: 2000 });

          const bounds = await page.locator('.mobile-server-menu').boundingBox();
          await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
          await page.mouse.wheel(0, 10000);
          await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu-body').evaluate((element) => element.scrollTop)).toBeGreaterThan(0));

          // Native hit-testing must reach the actual last entry, not hidden overflow inside a shrunken shared section
          const last = page.locator('.shared-entry-row').last();
          await last.tap({ timeout: 2000 });
          await page.getByRole('button', { name: 'Language', exact: true }).tap();
          expect(await page.locator('.mobile-server-menu-language').boundingBox()).toEqual(footerBefore);

          if (engine === 'chromium' && viewport.width === 393) {
            const session = await page.context().newCDPSession(page);
            const x = bounds!.x + bounds!.width / 2;
            const y = bounds!.y + 80;
            const before = await page.locator('.mobile-server-menu-body').evaluate((element) => element.scrollTop);
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 6; step++) {
              await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 35 }] });
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu-body').evaluate((element) => element.scrollTop)).toBeLessThan(before));
            await session.detach();
          }

          await page.mouse.wheel(0, -10000);
          await vi.waitFor(async () => expect(await page.locator('.mobile-server-menu-body').evaluate((element) => element.scrollTop)).toBe(0));
          await page.getByRole('button', { name: 'Owned 0', exact: false }).tap();
        }
      } finally { await browser.close(); }
    }, 45_000);
  }
});
