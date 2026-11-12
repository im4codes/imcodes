import { expect, test, type Page } from '@playwright/test';

const URL = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&subBar=1';

async function openFixture(page: Page, extra = '') {
  await page.route('**/api/**', (route) => route.fulfill({ json: { tasks: [], records: [], entries: [], pins: [], aliases: [], machines: [] } }));
  await page.addInitScript(() => {
    localStorage.setItem('imcodes_lang', 'en');
    localStorage.setItem('rcc_subcard_collapsed', 'false');
  });
  await page.goto(`${URL}${extra}`);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}

test('mobile touch: main input hides .subcard-bar, while SubSessionCard input keeps .subcard-bar visible, focused, and isolated from outer toggle', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  try {
    const page = await context.newPage();
    await openFixture(page);

    const host = page.getByTestId('fixture-subbar-host');
    const bar = page.locator('.subcard-bar');
    const mainComposer = page.getByTestId('main-composer');

    // Positive control: focusing main-session input sets .input-focused and hides .subcard-bar under pointer:coarse
    await expect(bar).toBeVisible();
    await mainComposer.tap();
    await expect(page.locator('html')).toHaveClass(/input-focused/);
    await expect(page.locator('html')).not.toHaveClass(/subcard-input-focused/);
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).toBe('none');

    // Blur back -> .subcard-bar restores
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(bar).toBeVisible();
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');

    // Tap compact SessionControls composer on sub-tr card: stays visible even with .input-focused + .kb-open, never toggles card open/close
    const subCardComposer = page.locator('.subcard-input-area [contenteditable="true"].controls-input').first();
    await subCardComposer.tap();
    await expect(page.locator('html')).toHaveClass(/input-focused/);
    await expect(page.locator('html')).toHaveClass(/subcard-input-focused/);
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    expect(await subCardComposer.evaluate((el) => document.activeElement === el)).toBe(true);
    await expect(host).toHaveAttribute('data-open-ids', '');

    // Simulate soft-keyboard shrink -> .kb-open becomes active, .subcard-bar STILL remains visible and input remains focused
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 480 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.locator('html')).toHaveClass(/kb-open/);
    await expect(page.locator('html')).toHaveClass(/subcard-input-focused/);
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    expect(await subCardComposer.evaluate((el) => document.activeElement === el)).toBe(true);

    // Simulated DOM composition events (browser focus/layout is real; composition is synthetic)
    await subCardComposer.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'n' }));
      el.textContent = 'ni';
      el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ni' }));
      el.textContent = '你';
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    });
    expect(await subCardComposer.evaluate((el) => document.activeElement === el)).toBe(true);
    await expect(host).toHaveAttribute('data-open-ids', '');

    // Positive control: tapping blank card preview toggles open state
    const blankHeader = page.locator('.subcard-header').first();
    await blankHeader.tap();
    await expect(host).toHaveAttribute('data-open-ids', 'sub-tr');

    // Fallback <input class="subcard-input"> also stays visible, focused, and isolated from outer toggle on tap
    await openFixture(page, '&fallback=1');
    const subFallbackInput = page.locator('.subcard-input-area input.subcard-input').first();
    await subFallbackInput.tap();
    await expect(page.locator('html')).toHaveClass(/input-focused/);
    await expect(page.locator('html')).toHaveClass(/subcard-input-focused/);
    expect(await page.locator('.subcard-bar').evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    expect(await subFallbackInput.evaluate((el) => document.activeElement === el)).toBe(true);
    await expect(page.getByTestId('fixture-subbar-host')).toHaveAttribute('data-open-ids', '');
  } finally {
    await context.close();
  }
});

test('mobile SubSessionWindow composer yields .subcard-bar while keeping window visible & focused', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  try {
    const page = await context.newPage();
    await openFixture(page, '&openWindow=1');

    const host = page.getByTestId('fixture-subbar-host');
    const win = page.locator('.subsession-window');
    const bar = page.locator('.subcard-bar');
    const winComposer = win.locator('.controls-input');

    await expect(win).toBeVisible();
    await expect(winComposer).toBeVisible();
    await winComposer.tap();
    await expect(page.locator('html')).toHaveClass(/input-focused/);
    await expect(page.locator('html')).not.toHaveClass(/subcard-input-focused/);
    expect(await bar.evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(await win.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
    expect(await winComposer.evaluate((el) => document.activeElement === el)).toBe(true);
    await expect(host).toHaveAttribute('data-window-minimized-count', '0');
  } finally {
    await context.close();
  }
});

test('desktop: .subcard-input-area disables parent .subcard-drag-wrap draggable on pointerdown and blocks dblclick maximize, while blank area toggles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await openFixture(page);

  const host = page.getByTestId('fixture-subbar-host');
  const wrap = page.locator('.subcard-drag-wrap').first();
  const input = page.locator('.subcard-input-area [contenteditable="true"].controls-input').first();

  await expect(wrap).toHaveAttribute('draggable', 'true');
  const box = (await input.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await wrap.evaluate((el) => (el as HTMLDivElement).draggable)).toBe(false);
  await page.mouse.up();
  expect(await wrap.evaluate((el) => (el as HTMLDivElement).draggable)).toBe(true);

  await input.dblclick();
  await expect(host).toHaveAttribute('data-open-ids', '');
  await expect(host).toHaveAttribute('data-maximized-ids', '');

  // Positive control: blank card header click opens card
  await page.locator('.subcard-header').first().click();
  await expect(host).toHaveAttribute('data-open-ids', 'sub-tr');
});
