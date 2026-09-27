import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const SCREENSHOT = process.env.IMC_PAIR_BRIEF_SCREENSHOT ?? '/repo/perf-results/pair-brief-desktop.png';
const MOBILE_SCREENSHOT = process.env.IMC_PAIR_BRIEF_MOBILE_SCREENSHOT ?? '/repo/perf-results/pair-brief-mobile.png';

export async function runPairBriefScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=30&windows=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
  const brief = '# Browser brief\n\nThe full **task content** is visible.\n\n- [x][ ] Implement the UI\n- [ ][x] Audit the UI\n\n' + Array.from({ length: 24 }, (_, index) => `Additional brief line ${index + 1}.`).join('\n');
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    taskId: `pair-brief-browser-${index + 1}`,
    title: `Browser-visible pair title ${index + 1}`,
    status: 'working',
    updatedAt: Date.now() + index,
    brief,
    pair: { status: 'working', updatedAt: Date.now() + index, brief },
  }));
  const events = tasks.map((task, index) => ({
    eventId: `pair-brief-event-${index + 1}`,
    sessionId: 'fixture-window-0',
    epoch: 1,
    seq: index + 1,
    ts: Date.now() + index,
    type: 'task_pair.event',
    payload: { taskId: task.taskId, title: task.title, toStatus: 'working', startedAt: task.updatedAt, updatedAt: task.updatedAt, brief },
  }));
  const snapshot = { authoritative: true, tasks, assignments: [] };
  await page.evaluate(({ nextEvents, nextSnapshot }) => {
    window.__chatTimelineHarness?.setEvents(nextEvents);
    window.__imcodesTaskPairSnapshot = nextSnapshot;
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: nextSnapshot }));
  }, { nextEvents: events, nextSnapshot: snapshot });
  const panel = page.getByTestId('task-pair-status-panel');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const expand = panel.getByRole('button', { name: /show task content|显示任务内容|顯示任務內容|mostrar contenido|タスク内容を表示|작업 내용 표시|показать содержание/i }).first();
  await expand.click();
  await panel.getByText('Browser-visible pair title 30').waitFor({ state: 'visible' });
  const expandedBrief = panel.locator('.task-pair-brief-content').first();
  await expandedBrief.getByText('task content', { exact: false }).waitFor({ state: 'visible' });
  const rows = panel.locator('.task-pair-status-row');
  const numbers = panel.locator('.task-pair-status-sequence');
  const rowsScroller = panel.getByTestId('task-pair-status-rows');
  await expandedBrief.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const outerBeforeWheel = await rowsScroller.evaluate((element) => element.scrollTop);
  await expandedBrief.hover();
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(50);
  const outerAfterWheel = await rowsScroller.evaluate((element) => element.scrollTop);
  assert.ok(outerAfterWheel > outerBeforeWheel, 'brief edge scroll chains to the outer task list');
  assert.equal(await rows.count(), 30);
  assert.equal(await numbers.nth(0).textContent(), '1');
  assert.equal(await numbers.nth(29).textContent(), '30');
  await rowsScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(50);
  const lastRow = rows.nth(29);
  const lastBox = await lastRow.boundingBox();
  const rowsBox = await rowsScroller.boundingBox();
  assert.ok(lastBox && rowsBox && lastBox.y + lastBox.height <= rowsBox.y + rowsBox.height + 2, 'last task row is reachable');
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await rowsScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const mobileLastBox = await lastRow.boundingBox();
  const mobileRowsBox = await rowsScroller.boundingBox();
  assert.ok(mobileLastBox && mobileRowsBox && mobileLastBox.y + mobileLastBox.height <= mobileRowsBox.y + mobileRowsBox.height + 2, 'mobile last task row is reachable');
  await page.screenshot({ path: MOBILE_SCREENSHOT, fullPage: true });
  const result = { rows: await rows.count(), lastRow: await panel.getByText('Browser-visible pair title 30').isVisible(), sequence: true, nestedBrief: true, desktopScreenshot: SCREENSHOT, mobileScreenshot: MOBILE_SCREENSHOT };
  await browser.close();
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPairBriefScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
