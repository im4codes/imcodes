import { expect, test, type Page } from '@playwright/test';
import { TASK_PAIR_STATUS_PANEL_WIDTH_STORAGE_KEY as TASK_PAIR_PANEL_WIDTH_KEY } from '../../shared/task-pair.js';
const URL = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1';
async function publish(page: Page) {
  await page.evaluate(() => (window as any).__chatTimelineHarness.setEvents([{ eventId: 'width-event', sessionId: 'fixture-window-0', type: 'task_pair.event', ts: 1700000000000, seq: 1, epoch: 0, source: 'daemon', confidence: 'high', payload: { taskId: 'width-task', title: 'Synthetic resizable task', writer: 'daemon', verb: 'WORKING', toStatus: 'working', executor: 'fixture-window-0', auditor: 'fixture-auditor' } }]));
}
async function open(page: Page, width = 1280, extra = '') {
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/api/**', route => route.fulfill({ json: { value: true, pins: [] } }));
  await page.goto(URL + extra);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
  await publish(page);
}
const panel = (page: Page) => page.locator('.task-pair-status-panel').first();
async function dimensions(page: Page) {
  return panel(page).evaluate(p => {
    const wrap = p.closest('.chat-view-wrap')!;
    return { width: p.getBoundingClientRect().width, padding: parseFloat(getComputedStyle(wrap.querySelector('.chat-view')!).paddingRight), wrap: wrap.getBoundingClientRect().width };
  });
}
test('desktop drag resizes chat reservation and survives reload and collapse', async ({ page }) => {
  await open(page);
  const handle = panel(page).getByRole('separator'); await expect(handle).toBeVisible();
  expect((await dimensions(page)).width).toBeCloseTo(300, 0);
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + 3, h.y + 60); await page.mouse.down(); await page.mouse.move(h.x - 197, h.y + 60, { steps: 8 });
  expect(await page.evaluate(key => localStorage.getItem(key), TASK_PAIR_PANEL_WIDTH_KEY)).toBeNull();
  await page.mouse.up();
  const size = await dimensions(page); expect(size.width).toBeCloseTo(500, 0); expect(size.padding).toBeCloseTo(512, 0);
  expect(await page.evaluate(key => localStorage.getItem(key), TASK_PAIR_PANEL_WIDTH_KEY)).toBe('500');
  await page.reload(); await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready); await publish(page);
  expect((await dimensions(page)).width).toBeCloseTo(500, 0);
  await panel(page).locator('.task-pair-status-toggle').click(); await expect(handle).toHaveCount(0);
  expect((await dimensions(page)).padding).toBe(12);
  await panel(page).locator('.task-pair-status-toggle').click(); await expect(handle).toBeVisible(); expect((await dimensions(page)).width).toBeCloseTo(500, 0);
  await handle.focus(); await page.keyboard.press('ArrowLeft'); expect((await dimensions(page)).width).toBeCloseTo(524, 0);
  await page.keyboard.press('ArrowRight'); expect((await dimensions(page)).width).toBeCloseTo(500, 0);
});
test('responsive split panes clamp visually without destroying the remembered width', async ({ page }) => {
  await open(page); await panel(page).getByRole('separator').focus(); await page.keyboard.press('End');
  expect((await dimensions(page)).width).toBeCloseTo(720, 0);
  await page.locator('.chat-timeline-fixture-window').evaluate(e => { e.style.width = '500px'; });
  await expect.poll(async () => (await dimensions(page)).width).toBeCloseTo(325, 0);
  expect(await page.evaluate(key => localStorage.getItem(key), TASK_PAIR_PANEL_WIDTH_KEY)).toBe('720');
  await page.locator('.chat-timeline-fixture-window').evaluate(e => { e.style.width = '100vw'; });
  await expect.poll(async () => (await dimensions(page)).width).toBeCloseTo(720, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 640, height: 844 }); await expect(panel(page).getByRole('separator')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 844 }); await expect(panel(page).getByRole('separator')).toBeVisible(); expect((await dimensions(page)).width).toBeCloseTo(720, 0);
});
test('phone keeps its original layout and never offers resizing', async ({ page }) => {
  await open(page, 390); await expect(panel(page)).toHaveClass(/is-collapsed/);
  await panel(page).locator('.task-pair-status-toggle').click(); await expect(panel(page).getByRole('separator')).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), TASK_PAIR_PANEL_WIDTH_KEY)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
