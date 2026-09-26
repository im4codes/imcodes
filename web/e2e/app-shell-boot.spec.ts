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
