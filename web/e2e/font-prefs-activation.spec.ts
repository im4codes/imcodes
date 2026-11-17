import { expect, test, type Page } from '@playwright/test';

const FIXTURE = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1&pins=1';
const KEY = 'imcodes_fontPrefs:chat';
async function open(page: Page, extra = '') {
  await page.route('**/api/**', route => route.fulfill({ json: { pins: [], tasks: [], entries: [] } }));
  await page.addInitScript(() => {
    localStorage.setItem('imcodes_lang', 'en');
    const writes: number[] = [];
    (window as any).__fontWrites = writes;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'imcodes_fontPrefs:chat') writes.push(JSON.parse(value).size);
      return original.call(this, key, value);
    };
  });
  await page.goto(FIXTURE + extra);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
  await page.getByRole('button', { name: 'Aa', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Font', exact: true })).toBeVisible();
}
function control(page: Page, name = '+') { return page.getByRole('dialog', { name: 'Font', exact: true }).getByRole('button', { name, exact: true }); }
async function writes(page: Page) { return page.evaluate(() => (window as any).__fontWrites as number[]); }
async function mouseGesture(page: Page, name: string) {
  const button = control(page, name);
  await button.hover();
  await page.mouse.down();
  // A real task boundary, not an assumed mouse-click event ordering. The old
  // 0ms suppression timer expires before the physical release/click.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  await page.mouse.up();
}

test('mouse down across a timer then release changes once, not on press, and preserves focus/menu', async ({ page }, info) => {
  await open(page);
  await mouseGesture(page, '+');
  expect(await writes(page)).toEqual([15]);
  await expect(control(page)).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Font', exact: true })).toBeVisible();
  await mouseGesture(page, '−');
  expect(await writes(page)).toEqual([15, 14]);
  await page.screenshot({ path: info.outputPath('desktop-font-menu.png') });
});

test('Enter, Space and assistive click each activate once without a keyboard duplicate', async ({ page }) => {
  await open(page);
  await control(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await control(page, '−').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await control(page).evaluate(button => button.click());
  expect(await writes(page)).toEqual([15, 16, 15, 14, 15]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('rapid independent clicks/double-click, alternating buttons and clamp do not lose steps', async ({ page }) => {
  await open(page);
  await control(page).dblclick();
  for (let i = 0; i < 3; i++) await control(page).click();
  for (const name of ['−', '+', '−', '+']) await control(page, name).click();
  expect(await writes(page)).toEqual([15, 16, 17, 18, 19, 18, 19, 18, 19]);
  // Several AT activations in one JS task still use the newest pending value.
  await control(page).evaluate(button => { button.click(); button.click(); button.click(); });
  expect((await writes(page)).slice(-3)).toEqual([20, 21, 22]);
  await control(page).click(); await control(page).click();
  await expect(control(page)).toBeDisabled();
  await control(page).evaluate(button => button.click());
  expect((await writes(page)).at(-1)).toBe(24);
  for (let i = 0; i < 14; i++) await control(page, '−').click();
  await expect(control(page, '−')).toBeDisabled();
  expect((await writes(page)).slice(-14)).toEqual(Array.from({ length: 14 }, (_, i) => 23 - i));
});

test('drag release outside cancels without changing size; next normal click is not suppressed', async ({ page }) => {
  await open(page);
  await control(page).hover(); await page.mouse.down();
  await page.mouse.move(4, 700); await page.mouse.up();
  expect(await writes(page)).toEqual([]);
  await control(page).click();
  expect(await writes(page)).toEqual([15]);
  await page.mouse.click(4, 700);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Aa', exact: true }).click();
  await control(page, '−').click();
  expect(await writes(page)).toEqual([15, 14]);
});

for (const width of [320, 390]) test(`touch start across task then end, tap and native touchCancel at ${width}px`, async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(); await open(page);
    const session = await context.newCDPSession(page);
    const rect = (await control(page).boundingBox())!;
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => writes(page)).toEqual([15]);
    await control(page, '−').tap();
    expect(await writes(page)).toEqual([15, 14]);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await writes(page)).toEqual([15, 14]);
    await control(page).tap();
    expect(await writes(page)).toEqual([15, 14, 15]);
    await page.screenshot({ path: info.outputPath('touch-font-menu.png') });
  } finally { await context.close(); }
});

test('same-page windows and another real tab sync the value, persist on reload without extra increments', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await open(page, '&windows=4');
  const peer = await context.newPage(); await open(peer, '&subWindow=1');
  await control(page).click();
  expect(await writes(page)).toEqual([15]);
  await expect.poll(() => peer.evaluate(key => JSON.parse(localStorage.getItem(key)!).size, KEY)).toBe(15);
  await expect(peer.getByRole('dialog', { name: 'Font', exact: true })).toContainText('15');
  expect(await writes(peer)).toEqual([]);
  await control(peer, '−').click();
  expect(await writes(peer)).toEqual([14]);
  await expect(page.getByRole('dialog', { name: 'Font', exact: true })).toContainText('14');
  // Each of the other mounted ChatViews gets the same value, not +1 again.
  const triggers = page.getByRole('button', { name: 'Aa', exact: true });
  for (let index = 1; index < 4; index++) {
    await triggers.nth(index).click();
    await expect(page.getByRole('dialog', { name: 'Font', exact: true })).toContainText('14');
  }
  await control(page).click();
  expect(await writes(page)).toEqual([15, 15]);
  const saved = await page.evaluate(key => localStorage.getItem(key), KEY);
  await page.reload();
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
  await page.getByRole('button', { name: 'Aa', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Font', exact: true })).toContainText('15');
  expect(await writes(page)).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(saved);
});
