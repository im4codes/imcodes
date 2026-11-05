import { expect, test, type Page } from '@playwright/test';
import { TASK_PAIR_TIMELINE_EVENT } from '../../shared/task-pair.js';
const payload = { taskId: 'split-canonical-task', title: 'Synthetic split task', writer: 'daemon', verb: 'WORKING', toStatus: 'working', executor: 'deck_sub_split_exec', auditor: 'deck_sub_split_audit', executorLabel: 'Same display', auditorLabel: 'Same display' };
async function open(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/api/**', route => route.fulfill({ json: { value: true, pins: [] } }));
  await page.addInitScript(() => { localStorage.setItem('imcodes_lang', 'zh-CN'); (window as any).__splits = []; (window as any).__reads = 0; (window as any).__nav = [];
    window.addEventListener('deck:pair-split', (e: any) => (window as any).__splits.push(e.detail));
    window.addEventListener('fixture:decision-request', () => (window as any).__reads++);
    window.addEventListener('deck:navigate', (e: any) => (window as any).__nav.push(e.detail.session));
  });
  await page.goto('/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1');
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}
async function publish(page: Page, next = payload) {
  await page.evaluate(({ payload, type }) => (window as any).__chatTimelineHarness.setEvents([{ eventId: 'split-event', sessionId: 'fixture-window-0', type, ts: 1700000000000, seq: 1, epoch: 0, source: 'daemon', confidence: 'high', payload }]), { payload: next, type: TASK_PAIR_TIMELINE_EVENT });
  await page.waitForTimeout(80);
}
test('collapsed split dispatches once per mouse/Enter/Space activation without expansion or preview IO', async ({ page }, info) => {
  await open(page); await publish(page);
  const card = page.locator('.task-pair-event-card'); const toggle = card.locator('.task-pair-card-toggle'); const split = card.locator('.task-pair-card-head > .task-pair-split-btn');
  await expect(split).toHaveCount(1); await expect(split).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card.locator('button button')).toHaveCount(0);
  await card.locator('.task-pair-title-preview-trigger').hover(); await split.hover(); await page.waitForTimeout(250);
  await split.focus(); await page.waitForTimeout(200);
  await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__reads)).toBe(0);
  await split.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(card.locator('.task-pair-card-body')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__splits.length)).toBe(1);
  await split.focus(); await page.keyboard.press('Enter'); await expect.poll(() => page.evaluate(() => (window as any).__splits.length)).toBe(2);
  await page.keyboard.press('Space'); await expect.poll(() => page.evaluate(() => (window as any).__splits.length)).toBe(3);
  const expected = { taskId: payload.taskId, executor: payload.executor, auditor: payload.auditor, action: 'open' };
  expect(await page.evaluate(() => (window as any).__splits)).toEqual([expected, expected, expected]);
  expect(await page.evaluate(() => (window as any).__reads)).toBe(0);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('deck:pair-split-state', { detail: { activeTaskId: id } })), payload.taskId);
  await expect(split).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('deck:pair-split-state', { detail: { activeTaskId: 'other-task' } })));
  await expect(split).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('deck:pair-split-state', { detail: { activeTaskId: null } })));
  for (let i = 0; i < 5; i++) await publish(page, { ...payload, title: `Synthetic stream ${i}` });
  expect(await page.evaluate(() => (window as any).__reads)).toBe(0);
  await card.locator('.task-pair-card-overview .task-pair-chip-session').first().click();
  expect(await page.evaluate(() => (window as any).__nav)).toEqual([payload.executor]);
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(split).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as any).__reads)).toBe(1);
  await split.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => (window as any).__splits)).toEqual([expected, expected, expected, expected]);
  expect(await page.evaluate(() => (window as any).__reads)).toBe(1);
  await expect(card.locator('[aria-label="关闭并列"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('expanded-header-split.png') });
});
test('split header keeps default heights, title/status and bounds at 320/390/1280 and 200%', async ({ page }, info) => {
  await open(page); const rows: Array<{ width: number; long: boolean; zoom: number; splits: number }> = [];
  for (const width of [320, 390, 1280]) for (const long of [false, true]) {
    await page.setViewportSize({ width, height: 844 });
    const title = long ? 'Synthetic long title ' + 'Long 中文 '.repeat(80) : payload.title;
    await publish(page, { ...payload, title });
    const card = page.locator('.task-pair-event-card');
    const g = await card.evaluate(e => { const r = e.getBoundingClientRect(); return { height: r.height, scroll: e.scrollWidth, client: e.clientWidth, titleWidth: e.querySelector('.task-pair-chip-task strong')!.getBoundingClientRect().width, splits: e.querySelectorAll('.task-pair-split-btn').length }; });
    await info.attach(`split-dimension-${width}-${long}`, { body: JSON.stringify(g), contentType: 'application/json' });
    expect(g.scroll).toBeLessThanOrEqual(g.client + 1); expect(g.titleWidth).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(card.locator('.task-pair-chip-task')).toHaveAttribute('title', title.trim());
    await expect(card.locator('.task-pair-chip-status')).toBeVisible();
    rows.push({ width, long, zoom: 1, splits: g.splits });
    await page.screenshot({ path: info.outputPath(`collapsed-${width}-${long ? 'long' : 'short'}.png`) });
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>('#fixture-root')!.style.zoom = '2'; document.querySelector<HTMLElement>('#chat-timeline-fixture-harness')!.style.width = '50vw'; document.querySelector<HTMLElement>('.chat-timeline-fixture-window')!.style.width = '50vw'; });
  await publish(page);
  const zoom = await page.locator('.task-pair-event-card').evaluate(e => ({ height: e.getBoundingClientRect().height, scroll: e.scrollWidth, client: e.clientWidth, splits: e.querySelectorAll('.task-pair-split-btn').length }));
  await info.attach('split-dimension-zoom2', { body: JSON.stringify(zoom), contentType: 'application/json' });
  expect(zoom.scroll).toBeLessThanOrEqual(zoom.client + 1); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('collapsed-200pct.png') });
  expect(rows.map(row => row.splits)).toEqual([0, 0, 0, 0, 1, 1]); expect(zoom.splits).toBe(1);
});
test('touch/mobile remains ineligible even at desktop width and tapping title still expands', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  try {
    await open(page); await publish(page);
    const card = page.locator('.task-pair-event-card'); await expect(card.locator('.task-pair-split-btn')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await card.locator('.task-pair-title-preview-trigger').tap();
    await expect(card.locator('.task-pair-card-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.task-pair-split-btn')).toHaveCount(0); await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__splits)).toEqual([]);
  } finally { await context.close(); }
});
