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
    ...(scenario.mobile || scenario.hasTouch || scenario.userAgent ? {
      isMobile: scenario.isMobileContext ?? scenario.mobile,
      hasTouch: scenario.hasTouch ?? scenario.mobile,
      userAgent: scenario.userAgent ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    } : {}),
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
  if (scenario.pinned) {
    // MessagePinsBar subscribes in an effect; repeat the fixture event after
    // mount so pin/no-pin cases are deterministic across browsers.
    await page.waitForTimeout(100);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('imcodes:message-pins-changed', { detail: {
      serverId: 'fixture-server',
      pins: [{ id: 'fixture-pin', sessionName: 'fixture-window-0', eventId: 'fixture-event', eventTs: Date.now(), eventType: 'user.message', text: 'Pinned message preview' }],
    } })));
  }
  const panel = page.locator('[data-testid="task-pair-status-panel"]:visible').first();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const titlebar = page.locator('.chat-titlebar').first();
  await titlebar.waitFor({ state: 'visible' });
  // A fresh fixture can mount once before the responsive media effect settles;
  // normalize to the owner-requested collapsed state before measuring it.
  if (await panel.locator('.task-pair-status-compact').count() === 0 && !await panel.locator('.task-pair-status-rows').isVisible().catch(() => false)) {
    const collapse = panel.getByRole('button', { name: /collapse task status|收起任务状态|收起任務狀態/i }).first();
    if (await collapse.count()) await collapse.click();
  }
  if (scenario.mobile && await panel.locator('.task-pair-status-compact').count() === 0) {
    const diagnostic = await page.evaluate(() => ({
      panelClass: document.querySelector('[data-testid="task-pair-status-panel"]')?.className,
      media: window.matchMedia('(max-width: 720px)').matches,
      pointer: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
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
  const result = {
    ...scenario,
    parentClass,
    titlebarHeight,
    panelStyle,
    hasCollapseArrow: await panel.locator('.task-pair-status-collapse-icon').count() > 0,
    hasCompact: await page.evaluate(() => Boolean(document.querySelector('[data-testid="task-pair-status-panel"] .task-pair-status-compact'))),
    compactText: await page.evaluate(() => document.querySelector('[data-testid="task-pair-status-panel"] .task-pair-status-compact')?.textContent ?? ''),
    pinControlWidth: scenario.pinned ? await page.getByTestId('message-pins-trigger').first().evaluate((element) => element.getBoundingClientRect().width) : null,
  };
  const assertNoCollision = async (state) => {
    const collisions = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('[data-testid="task-pair-status-panel"]')]
        .filter((panel) => panel.getClientRects().length > 0);
      const rect = (element) => element.getBoundingClientRect();
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return panels.flatMap((panel) => {
        const scope = panel.closest('.chat-timeline-fixture-window') ?? document;
        const controls = [...scope.querySelectorAll('.chat-top-actions button, .chat-titlebar button, .chat-titlebar [data-testid="message-pins-trigger"]')];
        return controls.filter((control) => !panel.contains(control) && intersects(rect(panel), rect(control))).map((control) => ({
          html: control.outerHTML.slice(0, 160), panel: rect(panel).toJSON(), control: rect(control).toJSON(),
        }));
      });
    });
    assert.deepEqual(collisions, [], `${scenario.label} ${state}: status overlaps a header control ${JSON.stringify(collisions)}`);
  };
  const ensureCollapsed = async () => {
    if (await panel.locator('.task-pair-status-compact').count() === 0) {
      const button = panel.locator('.task-pair-status-toggle').first();
      if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    }
    await panel.locator('.task-pair-status-panel, .task-pair-status-compact').first().waitFor().catch(() => {});
  };
  await ensureCollapsed();
  await assertNoCollision('collapsed');
  if (scenario.mobile) {
    assert.equal(await panel.locator('.task-pair-status-collapse-icon').count(), 0);
  } else {
    assert.ok(await panel.locator('.task-pair-status-toggle[aria-expanded="false"]').count() > 0, `${scenario.label}: desktop collapse control missing`);
  }
  await panel.locator('.task-pair-status-toggle').first().click();
  await panel.locator('.task-pair-status-rows').waitFor({ state: 'visible' });
  await assertNoCollision('expanded');
  await panel.locator('.task-pair-status-toggle').first().click();
  assert.equal(await panel.locator('.task-pair-status-rows').count() > 0 ? await panel.locator('.task-pair-status-rows').isVisible() : false, false, `${scenario.label}: toggle did not collapse`);
  if (scenario.mobile) {
    assert.match(parentClass, /chat-titlebar/);
    assert.equal(await panel.locator('.task-pair-status-compact').count() > 0, true, `${scenario.label}: compact mobile strip missing`);
    const collapsedStyle = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.border, boxShadow: style.boxShadow };
    });
    assert.match(collapsedStyle.border, /^0px none /);
    assert.equal(collapsedStyle.boxShadow, 'none');
    assert.ok(titlebarHeight <= 40, `${scenario.label}: status changed titlebar height`);
    if (scenario.pinned) assert.ok(result.pinControlWidth >= 24, `${scenario.label}: pinned control lost its tap target`);
    const visiblePanels = page.locator('[data-testid="task-pair-status-panel"]:visible');
    const panelCount = await visiblePanels.count();
    assert.ok(panelCount >= 1, `${scenario.label}: no visible task status panel`);
    for (let index = 0; index < panelCount; index += 1) {
      assert.match(await visiblePanels.nth(index).evaluate((element) => element.parentElement?.className ?? ''), /chat-titlebar/);
    }
  } else {
    assert.match(parentClass, /chat-titlebar/);
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
    ...[
      { label: 'android-412', width: 412, height: 915, mobile: true, hasTouch: true, pinned: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36' },
      { label: 'ipad-desktop-1024', width: 1024, height: 768, mobile: true, hasTouch: true, isMobileContext: false, pinned: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' },
      // Desktop-site mode on a phone commonly exposes a wide (~1024px) CSS
      // viewport while retaining a touch surface; the width-only base path
      // misclassifies it as desktop.
      { label: 'desktop-site-phone-1024', width: 1024, height: 768, mobile: true, hasTouch: true, isMobileContext: false, pinned: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36' },
    ],
    ...[1280, 1024, 800].flatMap((width) => [true, false].map((pinned) => ({
      label: `desktop-${width}-${pinned ? 'pinned' : 'no-pinned'}`, width, height: 900, mobile: false, pinned,
    }))),
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
