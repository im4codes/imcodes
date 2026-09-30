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
 *   fling              a reader flinging with REAL touch drags (momentum after the finger lifts) while pages land:
 *                      max px an on-screen row moved that neither the user's scrolling nor an app scroll write accounts
 *                      for, and the app's scrollTop writes while the finger/momentum owns the scroller (must be 0)
 *   *-stream           a reply streaming at the bottom while pages land above (pinned stays pinned, reader stays put)
 *   idbRows/gapRecord  what the local cache holds at the end and whether a hole is still recorded
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TIMELINE_MESSAGES } from '../../../shared/timeline-protocol.ts';
import { signPerfJwt } from './perf-auth.mjs';
import { STALE_SESSION_NAME, buildStaleTimeline, newestStaleText } from './stale-timeline.mjs';
import { fling } from './touch-fling.mjs';

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
const UPLOAD_ROOT = process.env.IMC_PERF_UPLOAD_ROOT ?? '/tmp/imc-perf-uploads';
const REQUEST_LOG = process.env.IMC_PERF_STALE_LOG ?? `${UPLOAD_ROOT}/stale-history.ndjson`;
const FLIP_FILE = `${UPLOAD_ROOT}/stale-flip`;
// While this file exists the fake daemon streams a reply into the stale session (a streaming message at the bottom).
const STREAM_FILE = `${UPLOAD_ROOT}/stale-stream`;
const LATEST_AFTER_CACHE_BUDGET_MS = Number(process.env.IMC_PERF_STALE_LATEST_BUDGET_MS ?? 1000);
const DRIFT_BUDGET_PX = 1;
const MIN_FLINGS = Number(process.env.IMC_PERF_STALE_MIN_FLINGS ?? 8);
const SAMPLE_WINDOW_MS = Number(process.env.IMC_PERF_STALE_SAMPLE_MS ?? 20_000);
const SAMPLE_CAP_MS = Number(process.env.IMC_PERF_STALE_CAP_MS ?? 150_000);
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
  // The app's own backfill trace (console.debug) — kept with the results so a run can be explained after the fact.
  await context.addInitScript(() => { window.__deck_debug_backfill = true; });
  await context.addInitScript(({ apiKey, baseUrl, session }) => {
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', 'imc_perf_harness_server');
    localStorage.setItem('rcc_viewModes', JSON.stringify({ [session]: 'chat' }));
  }, { apiKey: API_KEY, baseUrl: BASE_URL, session: STALE_SESSION_NAME });
  return context;
}

/**
 * The phone's stale local cache, built the way it really gets built: the real app opens the chat while the fake daemon
 * still serves only the session's OLD block (the daemon holds the stale view until the flip file appears), keeps it
 * on screen long enough to persist it (IndexedDB + localStorage tail snapshot + module cache), and is closed.
 * Then the daemon "moves on" to its full live history and a fresh page (the app relaunched) opens the same chat.
 */
async function buildStaleCache(context, route) {
  await rm(FLIP_FILE, { force: true });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#app', { timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.includes('long8000'), undefined, { timeout: 60_000, polling: 250 });
  await page.waitForTimeout(500);
  await page.evaluate((hash) => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); }, route);
  await page.waitForFunction((needle) => (document.querySelector('.chat-view')?.textContent ?? '').includes(needle), newestCachedText, { timeout: 60_000, polling: 250 });
  // Let the tail snapshot / IndexedDB writes land, then close the page (pagehide flushes the snapshot).
  await page.waitForTimeout(4000);
  await page.close({ runBeforeUnload: true });
  await writeFile(FLIP_FILE, '1');
  return CACHED_EVENTS;
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

// Scenario modes: pinned | reading | fling (reading + real touch flings) | pinned-stream | reading-stream.
const isPinnedMode = (mode) => mode === 'pinned' || mode === 'pinned-stream';
const isStreamMode = (mode) => mode.endsWith('-stream');

async function runScenario(browser, mode) {
  const context = await newContext(browser);
  const route = `#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(STALE_SESSION_NAME)}`;
  const seeded = await buildStaleCache(context, route);
  if (isStreamMode(mode)) await writeFile(STREAM_FILE, '1'); else await rm(STREAM_FILE, { force: true });
  const before = (await readRequestLog()).length;
  const page = await context.newPage();
  const consoleLines = [];
  const cdp = await context.newCDPSession(page);
  if (CPU_RATE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  // Where the time goes between opening and the newest message: when the peek left the phone and when its answer arrived.
  const wsTiming = { peekSentAt: null, peekRequestId: null, peekReceivedAt: null, firstHistorySentAt: null };
  let openedAtNode = 0;
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', ({ response }) => {
    if (!openedAtNode || typeof response?.payloadData !== 'string' || !response.payloadData.includes(TIMELINE_MESSAGES.HISTORY_REQUEST)) return;
    let message; try { message = JSON.parse(response.payloadData); } catch { return; }
    if (wsTiming.firstHistorySentAt === null) wsTiming.firstHistorySentAt = Date.now() - openedAtNode;
    if (message.contentFilter === 'text' && wsTiming.peekSentAt === null) { wsTiming.peekSentAt = Date.now() - openedAtNode; wsTiming.peekRequestId = message.requestId; }
  });
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    if (!wsTiming.peekRequestId || wsTiming.peekReceivedAt !== null || typeof response?.payloadData !== 'string') return;
    if (response.payloadData.includes(wsTiming.peekRequestId) && response.payloadData.includes(TIMELINE_MESSAGES.HISTORY)) wsTiming.peekReceivedAt = Date.now() - openedAtNode;
  });

  page.on('console', (message) => { if (consoleLines.length < 400) consoleLines.push(`${message.type()}: ${message.text().slice(0, 300)}`); });
  page.on('pageerror', (error) => { if (consoleLines.length < 60) consoleLines.push(`pageerror: ${String(error).slice(0, 300)}`); });
  // "Open" = the app relaunches on the phone and restores the chat it had open (the app remembers its selection), so
  // everything is measured from navigation start. A frame loop installed before any script runs timestamps the first
  // frame each thing is on screen: the stale cache (any cached message: small indices), the newest readable message
  // and the earlier-messages marker. It reads the chat's textContent only.
  await page.addInitScript(({ newest, cachedMax }) => {
    const marks = { cache: null, latest: null, gapMarker: null };
    window.__imcMarks = marks;
    const cachedPattern = /stale-(?:msg|user)-(\d+)/g;
    const frame = () => {
      const chat = document.querySelector('.chat-view');
      if (chat) {
        const text = chat.textContent ?? '';
        const now = performance.now();
        if (marks.cache === null) {
          for (const match of text.matchAll(cachedPattern)) { if (Number(match[1]) <= cachedMax) { marks.cache = now; break; } }
        }
        if (marks.latest === null && text.includes(newest)) marks.latest = now;
        if (marks.gapMarker === null && chat.querySelector('[data-testid="chat-history-gap-marker"]')) marks.gapMarker = now;
      }
      if (marks.latest === null) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, { newest: newestText, cachedMax: CACHED_EVENTS });
  openedAtNode = Date.now();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.__imcMarks?.latest !== null, undefined, { timeout: 60_000, polling: 100 }).catch(async (error) => {
    await mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(OUT_DIR, `timeout-${mode}.png`) }).catch(() => {});
    const body = await page.evaluate(() => ({ url: location.href, marks: window.__imcMarks, text: document.body.innerText.slice(0, 1500), hasChat: !!document.querySelector('.chat-view') })).catch(() => null);
    await writeFile(path.join(OUT_DIR, `timeout-${mode}.json`), JSON.stringify({ waitingFor: newestText, body, console: consoleLines }, null, 2));
    throw error;
  });
  const marks = await page.evaluate(() => window.__imcMarks);
  const tCachePaintMs = marks.cache === null ? null : Math.round(marks.cache);
  const tLatestTextMs = Math.round(marks.latest);

  const result = {
    mode, seededCachedEvents: seeded, totalEvents: TOTAL_EVENTS,
    tCachePaintMs, tLatestTextMs,
    // Null when the cache never got a frame of its own (the newest content arrived first): then latest-first is
    // measured from navigation start.
    latestAfterCacheMs: tCachePaintMs === null ? tLatestTextMs : tLatestTextMs - tCachePaintMs,
    gapMarkerAtMs: marks.gapMarker === null ? null : Math.round(marks.gapMarker),
    wsTiming,
  };

  if (!isPinnedMode(mode)) {
    // The reader starts once the hole's backfill is under way: what is measured is pages arriving ABOVE a reader,
    // not the initial merge of the peeked tail with the newest window.
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const seen = (await readRequestLog()).slice(before);
      if (seen.some((request) => request.beforeTs !== null && request.beforeTs !== undefined && request.contentFilter === null && request.afterTs !== undefined)) break;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1200);
  }
  // Sample layout on every frame while the older pages arrive.
  const flinging = mode === 'fling';
  await page.evaluate(({ mode: sampleMode, windowMs, capMs, gapKey, flinging }) => {
    const root = document.querySelector('.chat-view');
    const state = { active: true, done: false, samples: [], markerSeen: false, markerGoneAt: null, startedAt: performance.now(), anchorId: null, anchorTop0: null, gapSeen: false, gapClosedAt: null, lastGapCheck: 0 };
    const gapRecorded = () => {
      try { return !!JSON.parse(localStorage.getItem('imcodes.timelineGaps.v1') ?? '{}')[gapKey]; } catch { return false; }
    };
    window.__imcStale = state;
    if (!root) { state.error = 'no .chat-view'; return; }
    if (sampleMode === 'reading') {
      root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - 900);
    }
    // Touch flings: per painted frame the content-space position of the rows on screen, and every programmatic scroll write
    // with whether a finger / recent user scrolling owned the scroller at that moment.
    const rec = { touching: false, lastUserScrollAt: -1e9, writes: [], frames: [] };
    state.rec = rec;
    if (flinging) {
      const setTouch = (value) => () => { rec.touching = value; };
      document.addEventListener('touchstart', setTouch(true), { capture: true, passive: true });
      document.addEventListener('touchend', setTouch(false), { capture: true, passive: true });
      document.addEventListener('touchcancel', setTouch(false), { capture: true, passive: true });
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      const logWrite = (to) => {
        const from = desc.get.call(root);
        rec.writes.push({ t: performance.now(), delta: to - from, gap: Math.max(0, root.scrollHeight - root.clientHeight - from), touching: rec.touching, sinceUserScrollMs: performance.now() - rec.lastUserScrollAt });
      };
      Object.defineProperty(root, 'scrollTop', { configurable: true, get() { return desc.get.call(this); }, set(value) { logWrite(value); desc.set.call(this, value); } });
      const origTo = root.scrollTo.bind(root); const origBy = root.scrollBy.bind(root);
      root.scrollTo = (...args) => { const o = typeof args[0] === 'object' ? args[0] : { top: args[1] }; if (typeof o.top === 'number') logWrite(o.top); return origTo(...args); };
      root.scrollBy = (...args) => { const o = typeof args[0] === 'object' ? args[0] : { top: args[1] }; if (typeof o.top === 'number') logWrite(desc.get.call(root) + o.top); return origBy(...args); };
      // A user scroll = a scroll event with no app write in the preceding task.
      root.addEventListener('scroll', () => {
        const last = rec.writes.at(-1);
        if (!last || performance.now() - last.t > 60) rec.lastUserScrollAt = performance.now();
      }, { passive: true });
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
      sample.scrollTop = root.scrollTop; sample.scrollHeight = root.scrollHeight; sample.t = now - state.startedAt;
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
      if (flinging) {
        const rows = [];
        for (const node of root.querySelectorAll('[data-event-id]')) {
          const r = node.getBoundingClientRect();
          if (r.bottom <= rootRect.top + 1) continue;
          if (r.top >= rootRect.bottom - 1) break;
          // The streaming row legitimately changes height; every other row's content position must hold still.
          if ((node.textContent ?? '').includes('stream-msg-')) continue;
          rows.push({ id: node.getAttribute('data-event-id'), content: r.top - rootRect.top + root.scrollTop });
          if (rows.length >= 4) break;
        }
        rec.frames.push({ t: now, rows });
      }
      if (now - state.lastGapCheck > 500) {
        state.lastGapCheck = now;
        const recorded = gapRecorded();
        if (recorded) state.gapSeen = true;
        else if (state.gapSeen && state.gapClosedAt === null) state.gapClosedAt = now - state.startedAt;
      }
      const elapsed = now - state.startedAt;
      // Sample until the hole is closed (plus a moment to see the layout settle), never past the cap; a run that never
      // recorded a hole (older revision) is sampled for the fixed window.
      const finished = state.gapSeen
        ? (state.gapClosedAt !== null && elapsed - state.gapClosedAt > 1500) || elapsed > capMs
        : elapsed > windowMs;
      if (finished) { state.active = false; state.done = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { mode: isPinnedMode(mode) ? 'pinned' : 'reading', windowMs: SAMPLE_WINDOW_MS, capMs: SAMPLE_CAP_MS, gapKey: cacheKey, flinging });

  let flingCount = 0;
  if (flinging) {
    // A finger keeps flinging the chat (alternating older / newer so the reader stays inside what is loaded) while the
    // hole's pages land above it.
    const box = await page.evaluate(() => { const r = document.querySelector('.chat-view').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    while (!(await page.evaluate(() => window.__imcStale.done === true))) {
      await fling(cdp, box, 500 + (flingCount % 4) * 250, 1800 + (flingCount % 3) * 1400, flingCount % 2 === 0 ? 1 : -1);
      flingCount += 1;
      await page.waitForTimeout(150);
    }
  }
  await page.waitForFunction(() => window.__imcStale?.done === true, undefined, { timeout: SAMPLE_CAP_MS + 30_000, polling: 250 });
  const layout = await page.evaluate(() => {
    const state = window.__imcStale;
    return { error: state.error ?? null, samples: state.samples.length, markerSeen: state.markerSeen, markerGoneAtMs: state.markerGoneAt, gapClosedAtMs: state.gapClosedAt, anchorId: state.anchorId, anchorTop0: state.anchorTop0, samplesRaw: state.samples, frames: state.rec.frames, writes: state.rec.writes };
  });
  const anchorTops = layout.samplesRaw.map((sample) => sample.anchorTop).filter((value) => typeof value === 'number');
  const drift = layout.anchorTop0 === null || anchorTops.length === 0 ? null : Math.max(...anchorTops.map((top) => Math.abs(top - layout.anchorTop0)));
  const bottomGap = Math.max(0, ...layout.samplesRaw.map((sample) => sample.bottomGap));
  // Every frame on which the anchored row moved: enough to see WHAT moved it (scroll offset vs content height).
  const anchorMoves = [];
  for (let i = 1; i < layout.samplesRaw.length && anchorMoves.length < 25; i += 1) {
    const prev = layout.samplesRaw[i - 1]; const cur = layout.samplesRaw[i];
    if (typeof prev.anchorTop === 'number' && typeof cur.anchorTop === 'number' && Math.abs(cur.anchorTop - prev.anchorTop) > 1) {
      anchorMoves.push({ t: Math.round(cur.t), anchorFrom: Math.round(prev.anchorTop), anchorTo: Math.round(cur.anchorTop), scrollTop: [Math.round(prev.scrollTop), Math.round(cur.scrollTop)], scrollHeight: [Math.round(prev.scrollHeight), Math.round(cur.scrollHeight)] });
    }
  }
  if (flinging) result.fling = analyzeFling(layout.frames, layout.writes, flingCount);
  const gapRecord = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('imcodes.timelineGaps.v1') ?? '{}'); } catch { return {}; }
  });
  result.layout = { samples: layout.samples, markerSeen: layout.markerSeen, markerGoneAtMs: layout.markerGoneAtMs, gapClosedAtMs: layout.gapClosedAtMs, anchorId: layout.anchorId, driftPx: drift, maxBottomGapPx: bottomGap, anchorMoves, error: layout.error };
  if (isStreamMode(mode)) result.streamedAtBottom = await page.evaluate(() => (document.querySelector('.chat-view')?.textContent ?? '').includes('stream-msg-'));
  result.markerPresentAtEnd = await page.evaluate(() => !!document.querySelector('[data-testid="chat-history-gap-marker"]'));
  result.idbRows = await countIdbRows(page);
  result.gapRecord = gapRecord[cacheKey] ?? null;
  result.appTrace = consoleLines.filter((line) => line.includes('[backfill]')).slice(0, 120);
  result.requests = (await readRequestLog()).slice(before);
  await context.close();
  return result;
}

/**
 * Per painted frame: how far did a row visible in both frames move in CONTENT space, minus the app's own scroll writes in
 * between (a write compensates by design)? Non-zero = layout shifted under the reader uncompensated. Also the programmatic
 * scrollTop writes made while a finger or its momentum owns the scroller and the reader is not pinned (iOS cancels the
 * momentum on such a write): must be 0.
 */
function analyzeFling(frames, writes, flings) {
  let maxJumpPx = 0; let jumpAt = null;
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1]; const b = frames[i];
    const common = b.rows.find((row) => a.rows.some((other) => other.id === row.id));
    if (!common) continue;
    const before = a.rows.find((other) => other.id === common.id);
    const written = writes.filter((write) => write.t > a.t && write.t <= b.t).reduce((sum, write) => sum + write.delta, 0);
    const jump = Math.abs(common.content - before.content - written);
    if (jump > maxJumpPx) { maxJumpPx = jump; jumpAt = Math.round(b.t); }
  }
  const active = writes.filter((write) => write.gap > 50 && (write.touching || write.sinceUserScrollMs < 150));
  return { flings, frames: frames.length, writes: writes.length, maxJumpPx: Math.round(maxJumpPx * 100) / 100, jumpAtMs: jumpAt, activeWrites: active.length, activeWriteSamples: active.slice(0, 8) };
}

function analyzeOrder(requests) {
  const first = requests[0];
  const peekFirst = !!first && first.contentFilter === 'text' && first.limit <= 30;
  // Backfill pages walk DOWN: every page that has an upper bound is below the previous one's.
  const bounded = requests.filter((request) => request.beforeTs !== null && request.beforeTs !== undefined && request.contentFilter === null);
  let descending = true;
  for (let i = 1; i < bounded.length; i += 1) if (!(bounded[i].beforeTs < bounded[i - 1].beforeTs)) descending = false;
  // No hole between consecutive pages: each page's newest event reaches the previous page's oldest one (the +1 overlap).
  let contiguous = bounded.length > 0;
  for (let i = 1; i < bounded.length; i += 1) if (!(bounded[i].newestTs >= bounded[i - 1].oldestTs)) contiguous = false;
  return { peekFirst, backfillPages: bounded.length, descending, contiguous };
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
  if (scenario.gapMarkerAtMs === null && scenario.layout.markerSeen !== true) failures.push(`${mode}: the earlier-messages marker never appeared`);
  if (scenario.markerPresentAtEnd) failures.push(`${mode}: the earlier-messages marker is still shown at the end`);
  if (scenario.gapRecord !== null) failures.push(`${mode}: a hole is still recorded at the end: ${JSON.stringify(scenario.gapRecord)}`);
  // Pages are written to IndexedDB as they arrive; the app then trims each session's local copy to its newest
  // LOCAL_RETAINED_EVENTS_PER_SESSION (1000) in the background, so the final row count can only be checked against that floor.
  if (scenario.idbRows < Math.min(TOTAL_EVENTS, 1000) - 5) failures.push(`${mode}: local cache holds only ${scenario.idbRows} events`);
  if (!scenario.order.contiguous) failures.push(`${mode}: the backfill pages left a hole between them (${JSON.stringify(scenario.order)})`);
  // A flinging reader is moved by the finger: the anchored row's screen position is not constant, so it has its own verdict.
  if (!isPinnedMode(mode) && mode !== 'fling' && (scenario.layout.driftPx === null || scenario.layout.driftPx > DRIFT_BUDGET_PX)) failures.push(`${mode}: on-screen row moved ${scenario.layout.driftPx} px (budget ${DRIFT_BUDGET_PX})`);
  if (isPinnedMode(mode) && scenario.layout.maxBottomGapPx > DRIFT_BUDGET_PX) failures.push(`${mode}: view drifted ${scenario.layout.maxBottomGapPx} px from the bottom (budget ${DRIFT_BUDGET_PX})`);
  if (mode === 'fling') {
    const { fling: result } = scenario;
    if (result.flings < MIN_FLINGS) failures.push(`fling: only ${result.flings} flings landed while pages arrived (need ${MIN_FLINGS})`);
    if (result.maxJumpPx > DRIFT_BUDGET_PX) failures.push(`fling: an on-screen row jumped ${result.maxJumpPx} px with no scroll or write to account for it (budget ${DRIFT_BUDGET_PX})`);
    if (result.activeWrites > 0) failures.push(`fling: ${result.activeWrites} programmatic scrollTop write(s) while the finger/momentum owned the scroller: ${JSON.stringify(result.activeWriteSamples)}`);
  }
  if (isStreamMode(mode) && !scenario.streamedAtBottom) failures.push(`${mode}: no reply streamed into the chat while the pages landed (the scenario did not exercise streaming)`);
}

const output = { revision, generatedAt: new Date().toISOString(), config: { TOTAL_EVENTS, CACHED_EVENTS, CPU_RATE, LATEST_AFTER_CACHE_BUDGET_MS }, pass: failures.length === 0, failures, scenarios: Object.fromEntries(Object.entries(scenarios).map(([mode, scenario]) => [mode, { ...scenario, requests: undefined, requestCount: scenario.requests.length, requestHead: scenario.requests.slice(0, 6) }])) };
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, `results-${revision}.json`), JSON.stringify(output, null, 2));
await writeFile(path.join(OUT_DIR, `requests-${revision}.json`), JSON.stringify(Object.fromEntries(Object.entries(scenarios).map(([mode, scenario]) => [mode, scenario.requests])), null, 2));
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
