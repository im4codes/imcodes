/**
 * Stale chat window, opened on a phone-shaped browser (test-only; compose `stale` profile).
 *
 * A session whose local cache ends long before the live head (production-shaped timeline, thousands of events,
 * every 9th tool result 30 KB) is reopened. The real SPA runs against the real server; the fake daemon serves
 * history exactly as the real one does (newest `limit` of (afterTs, beforeTs), text-only on request) with a per-request
 * latency and logs every request. Measured per scenario, from the real DOM:
 *
 *   tCachePaintMs      the stale cache is on screen (as today)
 *   tLatestTextMs      the newest readable message is on screen
 *   latestAfterCacheMs tLatestTextMs - tCachePaintMs          <- "latest messages within ~1 s of open"
 *   requestOrder       the daemon's history requests in arrival order (peek first, then newest -> oldest pages)
 *   drift              reading scenario: max px an on-screen row moved while backfill pages arrived ABOVE it
 *   bottomGap          pinned scenario: max px the view drifted from the bottom while pages arrived
 *   idbRows/gapRecord  what the local cache holds at the end and whether a hole is still recorded
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { signPerfJwt } from './perf-auth.mjs';
import { STALE_SESSION_NAME, buildStaleTimeline, newestStaleText } from './stale-timeline.mjs';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium, devices } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_perf_harness_server';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'deck_perf_browser_key';
const JWT_SIGNING_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const TOTAL_EVENTS = Number(process.env.IMC_PERF_STALE_EVENTS ?? 6000);
const CACHED_EVENTS = Number(process.env.IMC_PERF_STALE_CACHED ?? 150);
const CPU_RATE = Number(process.env.IMC_PERF_STALE_CPU_RATE ?? 4);
const OUT_DIR = process.env.IMC_PERF_STALE_OUT ?? '/repo/perf-results/stale-window';
const REQUEST_LOG = process.env.IMC_PERF_STALE_LOG ?? '/tmp/imc-perf-uploads/stale-history.ndjson';
const LATEST_AFTER_CACHE_BUDGET_MS = Number(process.env.IMC_PERF_STALE_LATEST_BUDGET_MS ?? 1000);
const DRIFT_BUDGET_PX = 1;
const SAMPLE_WINDOW_MS = Number(process.env.IMC_PERF_STALE_SAMPLE_MS ?? 20_000);
const DB_NAME = 'imcodes-timeline';
const STORE_NAME = 'events';

const timeline = buildStaleTimeline({ total: TOTAL_EVENTS });
const cached = timeline.slice(0, CACHED_EVENTS);
const newestText = newestStaleText(timeline);
const newestCachedText = newestStaleText(cached);
const cacheKey = `${SERVER_ID}:${STALE_SESSION_NAME}`;

async function readRequestLog() {
  try {
    return (await readFile(REQUEST_LOG, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function newContext(browser) {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  await context.addInitScript(() => {
    if (!globalThis.crypto?.randomUUID) {
      globalThis.crypto.randomUUID = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    }
  });
  await context.addCookies([
    { name: 'rcc_session', value: signPerfJwt(JWT_SIGNING_KEY), url: BASE_URL },
    { name: 'rcc_csrf', value: 'imc-perf-csrf-token', url: BASE_URL },
  ]);
  await context.addInitScript(({ apiKey, baseUrl, session }) => {
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', 'imc_perf_harness_server');
    localStorage.setItem('rcc_viewModes', JSON.stringify({ [session]: 'chat' }));
  }, { apiKey: API_KEY, baseUrl: BASE_URL, session: STALE_SESSION_NAME });
  return context;
}

/** Boot the app once (it creates its IndexedDB), then write the OLD block of the session as the stale local cache. */
async function seedStaleCache(context) {
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(async (name) => {
    const dbs = await indexedDB.databases?.();
    return !dbs || dbs.some((db) => db.name === name);
  }, DB_NAME, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const written = await page.evaluate(async ({ dbName, storeName, rows, key }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const row of rows) store.put({ ...row, sessionId: key });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return rows.length;
  }, { dbName: DB_NAME, storeName: STORE_NAME, rows: cached, key: cacheKey });
  await page.close();
  return written;
}

async function countIdbRows(page) {
  return page.evaluate(async ({ dbName, storeName, key }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const index = tx.objectStore(storeName).index('session_ts');
      const request = index.count(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  }, { dbName: DB_NAME, storeName: STORE_NAME, key: cacheKey }).catch(() => -1);
}

async function runScenario(browser, mode) {
  const context = await newContext(browser);
  const seeded = await seedStaleCache(context);
  const before = (await readRequestLog()).length;
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (CPU_RATE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

  const opened = Date.now();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(STALE_SESSION_NAME)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const contains = (text, timeout) => page.waitForFunction((needle) => document.body.innerText.includes(needle), text, { polling: 'raf', timeout });
  await contains(newestCachedText, 60_000);
  const tCachePaintMs = Date.now() - opened;
  await contains(newestText, 60_000);
  const tLatestTextMs = Date.now() - opened;

  const result = {
    mode, seededCachedEvents: seeded, totalEvents: TOTAL_EVENTS,
    tCachePaintMs, tLatestTextMs, latestAfterCacheMs: tLatestTextMs - tCachePaintMs,
  };

  // Sample layout on every frame while the older pages arrive.
  await page.evaluate(({ mode: sampleMode, windowMs }) => {
    const root = document.querySelector('.chat-view');
    const state = { active: true, done: false, samples: [], markerSeen: false, markerGoneAt: null, startedAt: performance.now(), anchorId: null, anchorTop0: null };
    window.__imcStale = state;
    if (!root) { state.error = 'no .chat-view'; return; }
    if (sampleMode === 'reading') {
      root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - 900);
    }
    const pickAnchor = () => {
      const rootTop = root.getBoundingClientRect().top;
      for (const node of root.querySelectorAll('[data-event-id]')) {
        const rect = node.getBoundingClientRect();
        if (rect.top >= rootTop + 8 && rect.bottom <= rootTop + root.clientHeight) return { id: node.getAttribute('data-event-id'), top: rect.top - rootTop };
      }
      return null;
    };
    const tick = () => {
      if (!state.active) return;
      const now = performance.now();
      const rootRect = root.getBoundingClientRect();
      const marker = document.querySelector('[data-testid="chat-history-gap-marker"]');
      if (marker) state.markerSeen = true;
      if (state.markerSeen && !marker && state.markerGoneAt === null) state.markerGoneAt = now - state.startedAt;
      const sample = { bottomGap: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop) };
      if (sampleMode === 'reading') {
        if (state.anchorId === null) {
          const anchor = pickAnchor();
          if (anchor) { state.anchorId = anchor.id; state.anchorTop0 = anchor.top; }
        }
        if (state.anchorId !== null) {
          const node = root.querySelector(`[data-event-id="${CSS.escape(state.anchorId)}"]`);
          if (node) sample.anchorTop = node.getBoundingClientRect().top - rootRect.top;
        }
      }
      state.samples.push(sample);
      if (now - state.startedAt > windowMs) { state.active = false; state.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { mode, windowMs: SAMPLE_WINDOW_MS });

  await page.waitForFunction(() => window.__imcStale?.done === true, undefined, { timeout: SAMPLE_WINDOW_MS + 30_000, polling: 250 });
  const layout = await page.evaluate(() => {
    const state = window.__imcStale;
    return { error: state.error ?? null, samples: state.samples.length, markerSeen: state.markerSeen, markerGoneAtMs: state.markerGoneAt, anchorId: state.anchorId, anchorTop0: state.anchorTop0, samplesRaw: state.samples };
  });
  const anchorTops = layout.samplesRaw.map((sample) => sample.anchorTop).filter((value) => typeof value === 'number');
  const drift = layout.anchorTop0 === null || anchorTops.length === 0 ? null : Math.max(...anchorTops.map((top) => Math.abs(top - layout.anchorTop0)));
  const bottomGap = Math.max(0, ...layout.samplesRaw.map((sample) => sample.bottomGap));
  const gapRecord = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('imcodes.timelineGaps.v1') ?? '{}'); } catch { return {}; }
  });
  result.layout = { samples: layout.samples, markerSeen: layout.markerSeen, markerGoneAtMs: layout.markerGoneAtMs, anchorId: layout.anchorId, driftPx: drift, maxBottomGapPx: bottomGap, error: layout.error };
  result.idbRows = await countIdbRows(page);
  result.gapRecord = gapRecord[cacheKey] ?? null;
  result.requests = (await readRequestLog()).slice(before);
  await context.close();
  return result;
}

function analyzeOrder(requests) {
  const first = requests[0];
  const peekFirst = !!first && first.contentFilter === 'text' && first.limit <= 30;
  // Backfill pages walk DOWN: every page that has an upper bound is below the previous one's.
  const bounded = requests.filter((request) => request.beforeTs !== null && request.beforeTs !== undefined && request.contentFilter === null);
  let descending = true;
  for (let i = 1; i < bounded.length; i += 1) if (!(bounded[i].beforeTs < bounded[i - 1].beforeTs)) descending = false;
  return { peekFirst, backfillPages: bounded.length, descending };
}

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
const failures = [];
const scenarios = {};
try {
  for (const mode of (process.env.IMC_PERF_STALE_MODES ?? 'pinned,reading').split(',')) {
    scenarios[mode] = await runScenario(browser, mode);
    scenarios[mode].order = analyzeOrder(scenarios[mode].requests);
  }
} finally {
  await browser.close();
}

const revision = process.env.IMC_PERF_REVISION ?? 'unknown';
const headBehaviour = process.env.IMC_PERF_STALE_EXPECT_HEAD !== '0';
for (const [mode, scenario] of Object.entries(scenarios)) {
  if (scenario.layout.error) failures.push(`${mode}: ${scenario.layout.error}`);
  if (!headBehaviour) continue;
  if (scenario.latestAfterCacheMs > LATEST_AFTER_CACHE_BUDGET_MS) failures.push(`${mode}: latest message ${scenario.latestAfterCacheMs} ms after the cache paint (budget ${LATEST_AFTER_CACHE_BUDGET_MS})`);
  if (!scenario.order.peekFirst) failures.push(`${mode}: the first history request was not the tiny text-only peek`);
  if (!scenario.order.descending || scenario.order.backfillPages < 2) failures.push(`${mode}: backfill pages did not walk newest -> oldest (${JSON.stringify(scenario.order)})`);
  if (scenario.layout.markerSeen !== true) failures.push(`${mode}: the earlier-messages marker never appeared`);
  if (scenario.layout.markerGoneAtMs === null) failures.push(`${mode}: the earlier-messages marker never went away`);
  if (scenario.gapRecord !== null) failures.push(`${mode}: a hole is still recorded at the end: ${JSON.stringify(scenario.gapRecord)}`);
  if (scenario.idbRows < TOTAL_EVENTS - 5) failures.push(`${mode}: local cache holds ${scenario.idbRows} of ${TOTAL_EVENTS} events (holes)`);
  if (mode === 'reading' && (scenario.layout.driftPx === null || scenario.layout.driftPx > DRIFT_BUDGET_PX)) failures.push(`reading: on-screen row moved ${scenario.layout.driftPx} px (budget ${DRIFT_BUDGET_PX})`);
  if (mode === 'pinned' && scenario.layout.maxBottomGapPx > DRIFT_BUDGET_PX) failures.push(`pinned: view drifted ${scenario.layout.maxBottomGapPx} px from the bottom (budget ${DRIFT_BUDGET_PX})`);
}

const output = { revision, generatedAt: new Date().toISOString(), config: { TOTAL_EVENTS, CACHED_EVENTS, CPU_RATE, LATEST_AFTER_CACHE_BUDGET_MS }, pass: failures.length === 0, failures, scenarios: Object.fromEntries(Object.entries(scenarios).map(([mode, scenario]) => [mode, { ...scenario, requests: undefined, requestCount: scenario.requests.length, requestHead: scenario.requests.slice(0, 6) }])) };
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, `results-${revision}.json`), JSON.stringify(output, null, 2));
await writeFile(path.join(OUT_DIR, `requests-${revision}.json`), JSON.stringify(Object.fromEntries(Object.entries(scenarios).map(([mode, scenario]) => [mode, scenario.requests])), null, 2));
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
