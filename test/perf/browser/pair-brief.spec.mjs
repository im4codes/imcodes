import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT_DIR = process.env.IMC_PAIR_BRIEF_OUTPUT_DIR ?? '/repo/perf-results/task-panel-scroll';

const cases = [
  { label: 'desktop-1280x720-main', width: 1280, height: 720, windows: 1 },
  { label: 'desktop-1440x900-main', width: 1440, height: 900, windows: 1 },
  { label: 'desktop-1440x900-subwindows', width: 1440, height: 900, windows: 4 },
  { label: 'mobile-390x844-main', width: 390, height: 844, windows: 1 },
  { label: 'mobile-390x844-subwindows', width: 390, height: 844, windows: 4 },
];

function buildData() {
  const brief = '# Browser brief\n\nThe full **task content** is visible.\n\n- [x][ ] Implement the UI\n- [ ][x] Audit the UI\n\n' +
    Array.from({ length: 24 }, (_, index) => `Additional brief line ${index + 1}.`).join('\n');
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
  return { events, snapshot: { authoritative: true, tasks, assignments: [] } };
}

async function checkCase(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=30&windows=${scenario.windows}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
  const data = buildData();
  await page.evaluate(({ nextEvents, nextSnapshot }) => {
    window.__imcodesTaskPairSnapshot = nextSnapshot;
    window.__chatTimelineHarness?.setEvents(nextEvents);
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: nextSnapshot }));
  }, { nextEvents: data.events, nextSnapshot: data.snapshot });

  const panel = page.getByTestId('task-pair-status-panel').first();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const expand = panel.getByRole('button', { name: /show task content|显示任务内容|顯示任務內容|mostrar contenido|タスク内容を表示|작업 내용 표시|показать содержание/i }).first();
  if (await expand.count()) await expand.click();
  if (scenario.width <= 720) {
    const compact = panel.locator('.task-pair-status-compact').first();
    if (await compact.count()) await compact.click();
    const mobileExpand = panel.getByRole('button', { name: /show task content|显示任务内容|顯示任務內容|mostrar contenido|タスク内容を表示|작업内容を表示|작업 내용 표시|показать содержание/i }).first();
    if (await mobileExpand.count()) await mobileExpand.click();
  }
  const rows = panel.locator('.task-pair-status-row');
  await rows.nth(29).waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await rows.count(), 30);
  const expandedBrief = panel.locator('.task-pair-brief-content').first();
  await expandedBrief.getByText('task content', { exact: false }).waitFor({ state: 'visible' });
  const rowsScroller = panel.getByTestId('task-pair-status-rows');
  const chatMain = page.locator('.chat-main').first();
  const panelBox = await panel.boundingBox();
  const chatBox = await chatMain.boundingBox();
  assert.ok(panelBox && chatBox, `${scenario.label}: panel/chat geometry available`);
  assert.ok(panelBox.y >= chatBox.y - 1, `${scenario.label}: panel starts inside chat pane`);
  assert.ok(panelBox.y + panelBox.height <= chatBox.y + chatBox.height + 1, `${scenario.label}: panel bottom stays inside chat pane`);

  if (scenario.label === 'desktop-1440x900-main') {
    const briefMetrics = await expandedBrief.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop };
    });
    assert.ok(briefMetrics.scrollHeight >= briefMetrics.clientHeight, `${scenario.label}: expanded brief remains independently scrollable`);
  }
  await rowsScroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(50);
  const lastRow = rows.nth(29);
  const lastBox = await lastRow.boundingBox();
  const rowsBox = await rowsScroller.boundingBox();
  assert.ok(lastBox && rowsBox && lastBox.y + lastBox.height <= rowsBox.y + rowsBox.height + 2, `${scenario.label}: last task row is reachable`);
  const screenshot = `${OUTPUT_DIR}/${scenario.label}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  const result = { ...scenario, rows: await rows.count(), lastRowVisible: await page.getByText('Browser-visible pair title 30').first().isVisible(), screenshot };
  await context.close();
  return result;
}

export async function runPairBriefScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const results = [];
  try {
    for (const scenario of cases) results.push(await checkCase(browser, scenario));
  } finally {
    await browser.close();
  }
  return { cases: results, allLastRowsReachable: results.every((entry) => entry.lastRowVisible) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPairBriefScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
