import { expect, test } from '@playwright/test';

/**
 * Smoke coverage for the restored `correctness` Playwright project.
 *
 * The project itself is what this file exists to keep honest: playwright.config
 * has always documented a correctness/performance split, but only the
 * performance project was ever declared, so `web/e2e` could not hold anything
 * except perf specs. One real assertion here proves the project selects, boots
 * the production bundle, and stays disjoint from `*.perf.spec.ts`.
 *
 * Deliberately shallow. Driving this shell into an authenticated shared session
 * would require standing in for the credential store and the WebSocket — which
 * are not backend seams and would amount to rebuilding the jsdom module mocks
 * inside the browser. See the assignment notes on why the
 * "reload not committed" hypothesis is recorded as unavailable rather than
 * chased with a test-only architecture.
 */
test('serves the production app shell and mounts its pre-authentication surface', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.route('**/api/**', async (route) => route.fulfill({ json: {} }));

  await page.goto('/');

  // The bundle must actually execute and mount something: an empty body would
  // mean the fixtures build served a shell this project cannot exercise.
  await expect
    .poll(async () => (await page.evaluate(() => document.body.innerText.trim().length)), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // With every /api/** stubbed empty the shell cannot finish authenticating, so
  // it settles on its initializing/sign-in surface. Either is proof the bundle
  // executed and mounted; asserting a specific authenticated view would require
  // the credential-store and WebSocket stand-ins this project deliberately avoids.
  const text = await page.evaluate(() => document.body.innerText);
  expect(text, `app shell rendered no recognisable entry point. body=${text.slice(0, 200)}`)
    .toMatch(/INITIALIZING|Sign in|Passkey|codes/i);
  expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// Exercise the production switcher with HTTP/WS boundary fixtures, not a CSS clone.
test.describe('mobile server switcher', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', viewport: { width: 390, height: 844 } });

  for (const sharedCount of [1, 30]) {
    test(`fills available height and keeps all ${sharedCount} shares reachable`, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'browser-nav-user', baseUrl: location.origin }));
        localStorage.setItem('rcc_server', 'browser-nav-server');
        localStorage.setItem('rcc_server_name', 'Local');
        localStorage.setItem('i18nextLng', 'en');
      });
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        let json: unknown = {};
        if (path === '/api/auth/user/me') json = { id: 'browser-nav-user' };
        else if (path === '/api/server') json = { servers: [{ id: 'browser-nav-server', name: 'Local', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() }] };
        else if (path === '/api/shares') json = { entries: Array.from({ length: sharedCount }, (_, index) => ({
          id: `browser-share-${index}`, serverId: `browser-server-${index}`, serverName: `Shared server ${index}`,
          targetLabel: `Shared project ${index}`, role: 'participant', status: 'active',
          target: { kind: 'main', serverId: `browser-server-${index}`, sessionName: `deck_e2e_nav_${index}_brain` },
        })) };
        else if (path.endsWith('/ws-ticket')) json = { ticket: 'browser-nav-ticket' };
        else if (path.endsWith('/sessions')) json = { sessions: [] };
        await route.fulfill({ json });
      });
      await page.routeWebSocket('**/api/server/**/ws?*', (socket) => {
        socket.onMessage((message) => {
          if (typeof message === 'string' && JSON.parse(message).type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        });
      });
      await page.goto('/#/browser-nav-server');
      const trigger = page.locator('.mobile-server-btn');
      await trigger.click();
      const menu = page.locator('.mobile-server-menu');
      await expect(menu).toBeVisible();
      const checkHeight = async () => {
        const box = (await menu.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.height).toBeGreaterThan(viewport.height * 0.7);
        expect(Math.abs(box.y + box.height - (viewport.height - 8))).toBeLessThanOrEqual(2);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      };
      await checkHeight();
      const expand = menu.locator('.shared-entries-toggle[aria-expanded="false"]');
      if (await expand.count()) await expand.click();
      const lastEntry = menu.locator('.shared-entry-title').filter({ hasText: `Shared project ${sharedCount - 1}` });
      await lastEntry.scrollIntoViewIfNeeded();
      await expect(lastEntry).toBeInViewport();
      if (sharedCount > 1) {
        expect(await menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await menu.locator('.shared-entries-list').evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      }
      await page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(async () => (await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeCloseTo(382, 0);
      await checkHeight();
      await page.mouse.click(820, 200);
      await expect(menu).not.toBeVisible();
      await trigger.click();
      await expect(menu).toBeVisible();
      await checkHeight();
    });
  }
});
