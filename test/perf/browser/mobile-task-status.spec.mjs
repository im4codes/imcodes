import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT_DIR = process.env.IMC_MOBILE_TASK_STATUS_OUTPUT ?? '/repo/perf-results/mobile-task-status';

const taskSnapshot = {
  authoritative: true,
  tasks: [{ taskId: 'mobile-status-task', title: 'Mobile status task', pair: { status: 'working', updatedAt: Date.now() } }],
  assignments: [],
};

async function openCase(browser, scenario) {
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: 2,
    ...(scenario.mobile ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } : {}),
  });
  const page = await context.newPage();
  const pins = scenario.pinned ? '&pins=1' : '';
  const windows = scenario.windows ? `&windows=${scenario.windows}` : '';
  await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke${pins}${windows}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
  await page.evaluate(({ snapshot, pinned }) => {
    window.__imcodesTaskPairSnapshot = snapshot;
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: snapshot }));
    if (pinned) {
      window.dispatchEvent(new CustomEvent('imcodes:message-pins-changed', { detail: {
        serverId: 'fixture-server',
        pins: [{ id: 'fixture-pin', sessionName: 'fixture-window-0', eventId: 'fixture-event', eventTs: Date.now(), eventType: 'user.message', text: 'Pinned message preview' }],
      } }));
    }
  }, { snapshot: taskSnapshot, pinned: scenario.pinned });
  const panel = page.locator('[data-testid="task-pair-status-panel"]:visible').first();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const titlebar = page.locator('.chat-titlebar').first();
  await titlebar.waitFor({ state: 'visible' });
  // A fresh fixture can mount once before the responsive media effect settles;
  // normalize to the owner-requested collapsed state before measuring it.
  if (scenario.mobile && await panel.locator('.task-pair-status-compact').count() === 0) {
    const collapse = panel.getByRole('button', { name: /collapse task status|收起任务状态|收起任務狀態/i }).first();
    if (await collapse.count()) await collapse.click();
  }
  if (scenario.mobile && await panel.locator('.task-pair-status-compact').count() === 0) {
    const diagnostic = await page.evaluate(() => ({
      panelClass: document.querySelector('[data-testid="task-pair-status-panel"]')?.className,
      media: window.matchMedia('(max-width: 720px)').matches,
      userAgent: navigator.userAgent,
    }));
    throw new Error(`${scenario.label}: mobile compact strip missing ${JSON.stringify(diagnostic)}`);
  }
  const parentClass = await panel.evaluate((element) => element.parentElement?.className ?? '');
  const titlebarHeight = (await titlebar.boundingBox())?.height ?? 0;
  const panelStyle = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.border, height: style.height, boxShadow: style.boxShadow };
  });
  const compact = panel.locator('.task-pair-status-compact');
  const result = {
    ...scenario,
    parentClass,
    titlebarHeight,
    panelStyle,
    hasCollapseArrow: await panel.locator('.task-pair-status-collapse-icon').count() > 0,
    hasCompact: await page.evaluate(() => Boolean(document.querySelector('[data-testid="task-pair-status-panel"] .task-pair-status-compact'))),
    compactText: await page.evaluate(() => document.querySelector('[data-testid="task-pair-status-panel"] .task-pair-status-compact')?.textContent ?? ''),
    pinControlWidth: scenario.pinned ? await page.getByTestId('message-pins-trigger').first().evaluate((element) => element.getBoundingClientRect().width) : null,
    headerCollisions: scenario.mobile ? await page.evaluate(() => {
      const panels = [...document.querySelectorAll('[data-testid="task-pair-status-panel"]:not(.is-expanded)')];
      const controls = [...document.querySelectorAll('.chat-top-actions button, .chat-titlebar button')];
      const rect = (element) => element.getBoundingClientRect();
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return panels.flatMap((panel) => controls.filter((control) => !panel.contains(control) && intersects(rect(panel), rect(control))).map((control) => control.outerHTML.slice(0, 160)));
    }) : [],
  };
  if (scenario.mobile) {
    assert.match(parentClass, /chat-titlebar/);
    assert.equal(result.hasCollapseArrow, false);
    assert.equal(result.hasCompact, true, `${scenario.label}: compact mobile strip missing`);
    assert.deepEqual(result.headerCollisions, [], `${scenario.label}: status overlaps a header control`);
    assert.match(panelStyle.border, /^0px none /);
    assert.equal(panelStyle.boxShadow, 'none');
    assert.ok(titlebarHeight <= 40, `${scenario.label}: status changed titlebar height`);
    if (scenario.pinned) assert.ok(result.pinControlWidth >= 24, `${scenario.label}: pinned control lost its tap target`);
    const visiblePanels = page.locator('[data-testid="task-pair-status-panel"]:visible');
    const panelCount = await visiblePanels.count();
    assert.ok(panelCount >= 1, `${scenario.label}: no visible task status panel`);
    for (let index = 0; index < panelCount; index += 1) {
      assert.match(await visiblePanels.nth(index).evaluate((element) => element.parentElement?.className ?? ''), /chat-titlebar/);
    }
  } else {
    assert.match(parentClass, /chat-main/);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  const screenshot = `${OUTPUT_DIR}/${scenario.label}.png`;
  await page.screenshot({ path: screenshot, fullPage: true });
  await context.close();
  return { ...result, screenshot };
}

export async function runMobileTaskStatusScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const scenarios = [
    ...[390, 360, 320].flatMap((width) => [true, false].flatMap((pinned) => [1, 4].map((windows) => ({
      label: `mobile-${width}x${width === 390 ? 844 : width === 360 ? 780 : 640}-${windows === 1 ? 'main' : 'subwindows'}-${pinned ? 'pinned' : 'no-pinned'}`,
      width, height: width === 390 ? 844 : width === 360 ? 780 : 640, mobile: true, pinned, windows,
    })))),
    { label: 'desktop-1440x900-pinned', width: 1440, height: 900, mobile: false, pinned: true },
  ];
  try {
    const results = [];
    for (const scenario of scenarios) results.push(await openCase(browser, scenario));
    return results;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runMobileTaskStatusScenario();
  process.stdout.write(`${JSON.stringify({ scenarios: results }, null, 2)}\n`);
}
