import { expect, test, type Page } from '@playwright/test';
import { TASK_PAIR_SNAPSHOT_EVENT } from '../../shared/task-pair.js';
const URL = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&subWindow=1';
async function open(page: Page) {
  await page.route('**/api/**', route => route.fulfill({ json: { tasks: [], records: [], entries: [], pins: [], aliases: [], machines: [] } }));
  await page.addInitScript(() => { localStorage.setItem('imcodes_lang', 'en'); });
  await page.goto(URL);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}
async function publish(page: Page, title = 'Build current task', status = 'working', serverId = 'fixture-server') {
  await page.evaluate(({ event, title, status, serverId }) => {
    const detail = { authoritative: true, serverId, tasks: [{ taskId: 'header-task', title, updatedAt: 1, pair: { status, executor: 'fixture-window-0', auditor: 'fixture-auditor', updatedAt: 1 } }] };
    (window as any).__imcodesTaskPairSnapshot = detail;
    window.dispatchEvent(new CustomEvent(event, { detail }));
  }, { event: TASK_PAIR_SNAPSHOT_EVENT, title, status, serverId });
}
async function verify(page: Page) {
  const header = page.locator('.subsession-header');
  const baseHeight = (await header.boundingBox())!.height;
  await expect(header.locator('.subsession-hidden-actions')).toBeHidden();
  for (const button of await header.locator('.subsession-hidden-actions button').all()) await expect(button).toBeHidden();
  await expect(header.getByRole('button', { name: 'Minimize', exact: true })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  await publish(page);
  await expect(header.locator('.subsession-task-name')).toHaveText('Build current task');
  await expect(header.locator('.subsession-task-state')).toHaveText('Working');
  await publish(page, 'Review latest task', 'in_audit');
  await expect(header.locator('.subsession-task-name')).toHaveText('Review latest task');
  await expect(header.locator('.subsession-task-state')).toHaveText('In audit');
  await publish(page, 'Long title 中文 '.repeat(40));
  const g = await header.evaluate(e => ({ height: e.getBoundingClientRect().height, overflow: e.scrollWidth > e.clientWidth, name: e.querySelector('.subsession-task-name')!.getBoundingClientRect().width, status: e.querySelector('.subsession-task-state')!.getBoundingClientRect().width }));
  expect(g.height).toBeLessThanOrEqual(baseHeight + 1); expect(g.overflow).toBe(false); expect(g.name).toBeGreaterThan(0); expect(g.status).toBeGreaterThan(0);
  await publish(page, 'Another server task', 'working', 'wrong-server');
  await expect(header.locator('.subsession-task-title')).toHaveCount(0);
  await expect(header.locator('.subsession-title')).toContainText('Fixture worker');
  await publish(page);
  await page.evaluate(event => window.dispatchEvent(new CustomEvent(event, { detail: { scopeReset: true } })), TASK_PAIR_SNAPSHOT_EVENT);
  await expect(header.locator('.subsession-task-title')).toHaveCount(0);
}
test('desktop sub-window keeps only useful chrome and live task title without growing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 }); await open(page); await verify(page);
  await page.locator('.subsession-header').getByRole('button', { name: 'Maximize', exact: true }).click();
  await expect(page.locator('.subsession-window')).toHaveClass(/subsession-window-maximized/);
  await publish(page, 'Maximized task', 'rework'); await expect(page.locator('.subsession-task-state')).toHaveText('Rework');
  const costs = await page.evaluate(async event => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({ taskId: `shape-${i}`, title: `Synthetic task ${i}`, pair: { status: 'working', executor: i === 999 ? 'fixture-window-0' : `other-${i}` } }));
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const before = performance.now();
      window.dispatchEvent(new CustomEvent(event, { detail: { authoritative: true, serverId: 'fixture-server', tasks } }));
      await Promise.resolve();
      document.querySelector('.subsession-task-title')?.getBoundingClientRect();
      samples.push(performance.now() - before);
    }
    return samples;
  }, TASK_PAIR_SNAPSHOT_EVENT);
  console.log('HEADER_SNAPSHOT_RENDER_COST_1000_TASKS', JSON.stringify({ maxMs: Math.max(...costs), medianMs: [...costs].sort((a,b) => a-b)[15] }));
});
test('phone sub-window hides the same four actions and keeps task name/state in one row', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  try { const page = await context.newPage(); await open(page); await verify(page); } finally { await context.close(); }
});
