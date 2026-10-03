/**
 * Real-browser layout check for the EXPANDED task-status panel (任务状态).
 *
 * Owner report (2026-09-30, iPhone): the expanded panel extended below the
 * visible chat area, so its bottom sat under the context progress bar, agent
 * row and composer and the 3rd card was cut off mid-card with the rest
 * unreachable. This drives the real ChatView (fixture harness, `chrome=1` adds
 * a stand-in for the bottom chrome) in Chromium at phone/tablet/desktop sizes
 * and measures, per scenario:
 *   - the expanded panel's bottom edge against the chat area, the progress
 *     bar's top and the composer's top (must be >= 0 px above),
 *   - that the collapse toggle stays inside the panel and the viewport,
 *   - that scrolling the rows list brings the LAST card fully into view,
 *   - (desktop) the panel rect, so a base-vs-fixed run can be diffed.
 * The page harness is served by `vite` (default http://127.0.0.1:4300).
 *
 *   IMC_PERF_FIXTURE_URL=http://127.0.0.1:4300 \
 *   IMC_TASK_PANEL_FIT_OUTPUT=/tmp/task-panel-fit-fixed \
 *   node test/perf/browser/mobile-task-panel-fit.spec.mjs
 *
 * Exit code 1 (and `failures` in the JSON) when any measurement is violated.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT_DIR = process.env.IMC_TASK_PANEL_FIT_OUTPUT ?? '/tmp/task-panel-fit';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
const STATUSES = ['working', 'working', 'in_audit', 'queued', 'awaiting_brain_decision'];
const LONG_TITLE = 'A very long task title that keeps going and going so that it has to wrap over several lines inside the narrow phone card '.repeat(3);

function snapshot(count, longTitle) {
  return {
    authoritative: true,
    tasks: Array.from({ length: count }, (_, index) => ({
      taskId: `fit-task-${index + 1}`,
      title: longTitle && index === 1 ? LONG_TITLE : `Task ${index + 1}: chat scroll jitter, focus and layout regression`,
      brief: `Brief for task ${index + 1}. `.repeat(6),
      pair: { status: STATUSES[index % STATUSES.length], round: 1 + (index % 3), blocking: ['P0'], updatedAt: Date.now() - index * 1000, startedAt: Date.now() - (index + 1) * 3_600_000 },
    })),
    assignments: [],
  };
}

const PHONE = { mobile: true, hasTouch: true, userAgent: IPHONE_UA, deviceScaleFactor: 3 };
const SCENARIOS = [
  { label: 'iphone-390x844-5', width: 390, height: 844, pairs: 5, ...PHONE },
  { label: 'iphone-390x844-1', width: 390, height: 844, pairs: 1, ...PHONE },
  // Themes follow prefers-color-scheme; the layout must be identical in light.
  { label: 'iphone-390x844-5-light', width: 390, height: 844, pairs: 5, colorScheme: 'light', ...PHONE },
  { label: 'iphone-se-375x667-5-light', width: 375, height: 667, pairs: 5, colorScheme: 'light', ...PHONE },
  { label: 'iphone-390x844-20', width: 390, height: 844, pairs: 20, ...PHONE },
  { label: 'iphone-390x844-longtitle', width: 390, height: 844, pairs: 6, longTitle: true, ...PHONE },
  { label: 'iphone-se-375x667-5', width: 375, height: 667, pairs: 5, ...PHONE },
  // Software keyboard open: the visual viewport shrinks (emulated by resizing the viewport).
  { label: 'iphone-390-keyboard-390x520-5', width: 390, height: 520, pairs: 5, ...PHONE },
  // Less than ~96px of chat left (tiny viewport, landscape phone): the panel
  // must present the collapsed strip -- never a clipped panel.
  { label: 'iphone-390-keyboard-390x420-cramped', width: 390, height: 420, pairs: 5, allowCramped: true, ...PHONE },
  { label: 'iphone-landscape-844x390-cramped', width: 844, height: 390, pairs: 5, allowCramped: true, ...PHONE },
  { label: 'ipad-820x1180-5', width: 820, height: 1180, pairs: 5, mobile: true, hasTouch: true, userAgent: IPAD_UA, deviceScaleFactor: 2, isMobileContext: false },
  { label: 'subwindows-390x844-5-cramped', width: 390, height: 844, pairs: 5, windows: 4, allowCramped: true, ...PHONE },
  { label: 'desktop-1440x900-5', width: 1440, height: 900, pairs: 5, desktop: true, deviceScaleFactor: 1 },
  { label: 'desktop-1440x900-1', width: 1440, height: 900, pairs: 1, desktop: true, deviceScaleFactor: 1 },
  { label: 'desktop-1440x900-20', width: 1440, height: 900, pairs: 20, desktop: true, deviceScaleFactor: 1 },
];

async function measure(page, windowIndex) {
  return page.evaluate((index) => {
    const scope = document.querySelectorAll('.chat-timeline-fixture-window')[index] ?? document;
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const panel = scope.querySelector('[data-testid="task-pair-status-panel"]');
    const rows = scope.querySelector('[data-testid="task-pair-status-rows"]');
    const toggle = panel?.querySelector('.task-pair-status-toggle');
    const cards = [...(rows?.querySelectorAll('.task-pair-status-row') ?? [])];
    const main = scope.querySelector('.chat-main');
    const vv = window.visualViewport;
    return {
      panelClass: panel?.className ?? null,
      panel: rect(panel),
      main: rect(main),
      rows: rect(rows),
      toggle: rect(toggle),
      progress: rect(scope.querySelector('[data-testid="fixture-progress-bar"]')),
      composer: rect(scope.querySelector('[data-testid="fixture-composer"]')),
      chromeTop: rect(scope.querySelector('[data-testid="fixture-bottom-chrome"]')),
      viewportBottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
      cardCount: cards.length,
      rowsScroll: rows ? { scrollHeight: rows.scrollHeight, clientHeight: rows.clientHeight, overflowY: getComputedStyle(rows).overflowY } : null,
      expanded: Boolean(rows && rows.getClientRects().length > 0),
      panelStyle: panel ? (() => { const s = getComputedStyle(panel); return { position: s.position, height: s.height, maxHeight: s.maxHeight, top: s.top }; })() : null,
    };
  }, windowIndex);
}

async function lastCardReachable(page, windowIndex) {
  return page.evaluate((index) => {
    const scope = document.querySelectorAll('.chat-timeline-fixture-window')[index] ?? document;
    const rows = scope.querySelector('[data-testid="task-pair-status-rows"]');
    if (!rows) return null;
    rows.scrollTop = rows.scrollHeight;
    const cards = [...rows.querySelectorAll('.task-pair-status-row')];
    const last = cards.at(-1);
    if (!last) return null;
    const rr = rows.getBoundingClientRect();
    const lr = last.getBoundingClientRect();
    return { lastTop: lr.top, lastBottom: lr.bottom, rowsTop: rr.top, rowsBottom: rr.bottom, scrollTop: rows.scrollTop, scrollHeight: rows.scrollHeight, clientHeight: rows.clientHeight };
  }, windowIndex);
}

async function runScenario(browser, scenario) {
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: scenario.deviceScaleFactor,
    colorScheme: scenario.colorScheme ?? 'dark',
    ...(scenario.desktop ? {} : {
      isMobile: scenario.isMobileContext ?? scenario.mobile,
      hasTouch: scenario.hasTouch,
      userAgent: scenario.userAgent,
    }),
  });
  const page = await context.newPage();
  const windows = scenario.windows ? `&windows=${scenario.windows}` : '';
  await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke&chrome=1${windows}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
  const detail = snapshot(scenario.pairs, scenario.longTitle);
  await page.evaluate((snap) => {
    window.__imcodesTaskPairSnapshot = snap;
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: snap }));
  }, detail);
  const windowIndex = 0;
  const panel = page.locator('[data-testid="task-pair-status-panel"]:visible').first();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  // Normalise to a known state, then expand exactly as a user would.
  const rowsVisible = () => panel.locator('.task-pair-status-rows').isVisible().catch(() => false);
  if (!await rowsVisible()) await panel.locator('.task-pair-status-toggle').first().click();
  await page.waitForTimeout(250);
  const before = await measure(page, windowIndex);
  const failures = [];
  const fail = (message) => failures.push(`${scenario.label}: ${message}`);
  const result = { label: scenario.label, ...before };
  const isMobilePanel = /is-mobile/.test(before.panelClass ?? '');
  if (!before.expanded) {
    // A cramped viewport may present the panel collapsed; that is a clean state
    // only if no rows are shown and the strip itself fits.
    result.collapsedInsteadOfExpanded = true;
    if (!scenario.allowCramped) fail('panel could not be expanded');
    const stripBottom = before.panel?.bottom ?? Infinity;
    const stripLimit = Math.min(before.main?.bottom ?? Infinity, before.viewportBottom);
    if (stripBottom > stripLimit + 0.5) fail(`collapsed strip bottom ${stripBottom} is below the visible chat bottom ${stripLimit}`);
    if (before.rowsVisibleWhileCollapsed) fail('rows visible while the panel presents collapsed');
  } else if (scenario.desktop) {
    // Desktop layout is unchanged by the mobile fit: record the panel rect so a
    // base-vs-fixed run can be diffed, but do not hold it to the phone bound.
    result.desktopUnchangedRecord = before.panel;
  } else if (before.panel && before.main) {
    const limits = [before.main.bottom, before.viewportBottom];
    if (before.progress) limits.push(before.progress.top);
    if (before.composer) limits.push(before.composer.top);
    if (before.chromeTop) limits.push(before.chromeTop.top);
    const limit = Math.min(...limits);
    result.panelBottomAboveLimitPx = limit - before.panel.bottom;
    if (before.panel.bottom > limit + 0.5) fail(`panel bottom ${before.panel.bottom.toFixed(1)} is ${(before.panel.bottom - limit).toFixed(1)}px below the visible chat bottom ${limit.toFixed(1)}`);
    if (before.toggle && (before.toggle.top < before.panel.top - 0.5 || before.toggle.bottom > before.panel.bottom + 0.5)) fail('collapse toggle is outside the panel');
    if (before.toggle && before.toggle.bottom > before.viewportBottom) fail('collapse toggle is below the viewport');
    const reach = await lastCardReachable(page, windowIndex);
    result.lastCard = reach;
    if (!reach) fail('no cards rendered');
    else {
      if (reach.lastBottom > reach.rowsBottom + 1) fail(`last card bottom ${reach.lastBottom.toFixed(1)} is below the rows viewport ${reach.rowsBottom.toFixed(1)} after scrolling to the end`);
      if (reach.lastTop < reach.rowsTop - 1 && before.cardCount > 1 && reach.lastBottom - reach.lastTop < reach.clientHeight) fail('last card is above the rows viewport');
      const bottomInside = reach.lastBottom <= Math.min(reach.rowsBottom, limit) + 1;
      if (!bottomInside) fail('last card is not fully inside the visible list');
    }
    result.isMobilePanel = isMobilePanel;
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  result.screenshot = `${OUTPUT_DIR}/${scenario.label}.png`;
  await page.screenshot({ path: result.screenshot });
  // Collapse again: the toggle must always be reachable.
  const toggle = panel.locator('.task-pair-status-toggle').first();
  const toggleBox = await toggle.boundingBox();
  result.toggleBox = toggleBox;
  if (before.expanded && toggleBox) {
    await toggle.click();
    await page.waitForTimeout(150);
    if (await rowsVisible()) fail('toggle did not collapse the panel');
  }
  await context.close();
  return { result, failures };
}

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const all = [];
const failures = [];
try {
  const only = process.env.IMC_TASK_PANEL_FIT_ONLY?.split(',');
  for (const scenario of SCENARIOS) {
    if (only && !only.some((label) => scenario.label.includes(label))) continue;
    const { result, failures: scenarioFailures } = await runScenario(browser, scenario);
    all.push(result);
    failures.push(...scenarioFailures);
  }
} finally {
  await browser.close();
}
await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(`${OUTPUT_DIR}/results.json`, JSON.stringify({ failures, scenarios: all }, null, 2));
process.stdout.write(`${JSON.stringify({ failures, scenarios: all.map((entry) => ({ label: entry.label, expanded: entry.expanded, panelBottomAboveLimitPx: entry.panelBottomAboveLimitPx, panelHeight: entry.panel?.height, mainBottom: entry.main?.bottom, progressTop: entry.progress?.top, cards: entry.cardCount })) }, null, 2)}\n`);
process.exit(failures.length > 0 ? 1 : 0);
