/**
 * Mobile history-scroll stability on the dedicated real-ChatView fixture
 * (web/src/fixtures/chat-timeline). Owner report (iPhone recording): "scrolling
 * back through the chat history jumps around" while a turn is still streaming.
 *
 * Drives the PRODUCTION ChatView in a phone viewport (390x844, DPR 3, touch) with
 *   - a Markdown-heavy history (headings, lists, code, tables) whose row heights
 *     differ a lot from the virtual list's estimate,
 *   - a Markdown-heavy reply streaming at 25 Hz with short pauses (the pauses are
 *     what flips the streaming block between raw text and Markdown),
 *   - backward pagination (older pages prepend after a network delay),
 * and scrolls up through it with REAL touch flings (CDP touch drags that lift while moving: the compositor keeps scrolling on
 * momentum after the finger lifts).
 *
 * Per painted frame it records the content-space position of the rows on screen
 * and every programmatic scroll write the app makes. Two verdicts:
 *   jump    frame-to-frame movement of a visible row that neither the user's
 *           scrolling nor the app's own scroll write accounts for (layout shift
 *           the reader saw), must be <= 1 px;
 *   writes  programmatic scrollTop writes made while the reader is touching or
 *           coasting on momentum (iOS cancels/jumps momentum on such writes) while
 *           not pinned to the bottom, must be 0.
 *
 * Env: IMC_PERF_FIXTURE_URL (default http://127.0.0.1:4300),
 *      IMC_CHAT_SCROLL_OUTPUT, IMC_CHAT_SCROLL_NO_FAIL=1, IMC_CHAT_SCROLL_ONLY
 *      (comma list of scenario names), IMC_CHAT_SCROLL_FLINGS (per scenario).
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT = process.env.IMC_CHAT_SCROLL_OUTPUT ?? '/tmp/chat-scroll-mobile-history.json';
const NO_FAIL = process.env.IMC_CHAT_SCROLL_NO_FAIL === '1';
const FLINGS = Number(process.env.IMC_CHAT_SCROLL_FLINGS ?? 14);
const TOL = 1;
const VIEWPORT = { label: 'iphone', width: 390, height: 844, dpr: 3, mobile: true };

/** Installed in the page. Builds a Markdown-heavy history + streaming driver and
 * the per-frame / per-write recorder. */
function installDriver({ rows, olderPages, olderPageRows, olderDelayMs, stacks, tall }) {
  window.__mhStacks = !!stacks;
  const sessionId = 'fixture-window-0';
  let seq = 0;
  const mk = (type, payload) => ({ eventId: `mh-${++seq}`, sessionId, epoch: 1, seq, ts: 1_700_000_000_000 + seq * 1_000, type, payload });
  // Deterministic Markdown of very different heights.
  const block = (i) => (tall && i % 4 === 0 ? Array.from({ length: 7 }, (_, k) => block0(i + k)).join('\n\n') : block0(i));
  const block0 = (i) => {
    const kind = i % 6;
    const para = (k) => `Paragraph ${i}.${k}: ${'the quick brown fox jumps over the lazy dog '.repeat(2 + ((i + k) % 5))}`;
    if (kind === 0) return `## Heading ${i}\n\n${para(0)}\n\n- item a ${i}\n- item b ${i}\n- item c ${i}\n\n${para(1)}`;
    if (kind === 1) return `${para(0)}`;
    if (kind === 2) return `${para(0)}\n\n\`\`\`ts\nconst value${i} = compute(${i});\nfor (let n = 0; n < ${i % 9 + 3}; n += 1) {\n  console.log(value${i}, n);\n}\n\`\`\`\n\n${para(1)}`;
    if (kind === 3) return `### Table ${i}\n\n| col a | col b | col c |\n|---|---|---|\n| ${i} | x | y |\n| ${i + 1} | z | w |\n\n${para(0)}`;
    if (kind === 4) return `${para(0)}\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n1. first\n2. second\n3. third`;
    return `**Summary ${i}**\n\n${para(0)}\n\n> quoted line ${i}\n\n${para(1)}`;
  };
  const makeRow = (i, ts) => ({ ...mk(i % 3 === 0 ? 'user.message' : 'assistant.text', { text: block(i), streaming: false }), ts });
  const baseTs = 1_700_000_000_000;
  const total = rows + olderPages * olderPageRows;
  const all = Array.from({ length: total }, (_, i) => makeRow(i, baseTs + i * 1_000));
  // Newest `rows` are the initial timeline; the rest are older pages, newest page first.
  const events = all.slice(olderPages * olderPageRows);
  const pages = [];
  for (let p = olderPages - 1; p >= 0; p -= 1) pages.push(all.slice(p * olderPageRows, (p + 1) * olderPageRows));
  const harness = window.__chatTimelineHarness;
  harness.setEvents(events);
  harness.setOlderPages(pages, olderDelayMs);
  // The harness owns the list (older pages prepend into it): grow the stream through it.
  const driver = {
    streamId: null, chunkCount: 0,
    openStream() { driver.streamId = harness.appendEvent({ type: 'assistant.text', text: '' }); },
    chunk() {
      if (!driver.streamId) driver.openStream();
      const n = ++driver.chunkCount;
      const piece = n % 23 === 0 ? '\n\n## Section\n\n- point a\n- point b\n\n```js\nconst x = 1;\n```\n\n' : `${' word'.repeat(1 + (n % 4))}`;
      harness.appendStreamingChunk(piece);
    },
    timer: null,
    start(hz = 25) {
      driver.stop();
      let n = 0; let pauseUntil = 0;
      driver.timer = setInterval(() => {
        const now = performance.now();
        if (now < pauseUntil) return; // a network stall: Markdown catches up (raw -> markdown flip)
        n += 1;
        if (n % 60 === 0) pauseUntil = now + 320;
        driver.chunk();
      }, 1000 / hz);
    },
    stop() { if (driver.timer) clearInterval(driver.timer); driver.timer = null; },
  };
  window.__mhDriver = driver;

  const rec = { recording: false, frames: [], writes: [], phase: 'idle', touching: false, lastUserScrollAt: -1e9, root: null, started: false };
  window.__mh = rec;
  const findRoot = () => (rec.root?.isConnected ? rec.root : (rec.root = document.querySelector('.chat-view:not(.chat-view-preview)')));
  // Touch state (capture: the app stops propagation on some gestures).
  const setTouch = (v) => () => { rec.touching = v; };
  document.addEventListener('touchstart', setTouch(true), { capture: true, passive: true });
  document.addEventListener('touchend', setTouch(false), { capture: true, passive: true });
  document.addEventListener('touchcancel', setTouch(false), { capture: true, passive: true });
  // Programmatic writes: instrument the chat root instance (setter + scrollTo/By).
  const hook = () => {
    const root = findRoot();
    if (!root || root.__mhHooked) return;
    root.__mhHooked = true;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const log = (kind, to) => {
      const from = desc.get.call(root);
      const gap = Math.max(0, root.scrollHeight - root.clientHeight - from);
      rec.writes.push({ stack: window.__mhStacks ? (new Error().stack || '').split('\n').slice(2, 7).map((l) => l.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+\//, '(')).join(' < ') : undefined, t: performance.now(), kind, from, to, delta: to - from, gap, touching: rec.touching, sinceUserScrollMs: performance.now() - rec.lastUserScrollAt, phase: rec.phase });
    };
    Object.defineProperty(root, 'scrollTop', { configurable: true, get() { return desc.get.call(this); }, set(v) { if (rec.recording) log('scrollTop=', v); desc.set.call(this, v); } });
    const origTo = root.scrollTo.bind(root); const origBy = root.scrollBy.bind(root);
    root.scrollTo = (...a) => { const o = typeof a[0] === 'object' ? a[0] : { top: a[1] }; if (rec.recording && typeof o.top === 'number') log('scrollTo', o.top); return origTo(...a); };
    root.scrollBy = (...a) => { const o = typeof a[0] === 'object' ? a[0] : { top: a[1] }; if (rec.recording && typeof o.top === 'number') log('scrollBy', desc.get.call(root) + o.top); return origBy(...a); };
    // A user scroll = scroll event with no write in the preceding task.
    root.addEventListener('scroll', () => {
      const last = rec.writes.at(-1);
      if (!last || performance.now() - last.t > 60) rec.lastUserScrollAt = performance.now();
    }, { passive: true });
  };
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const root = findRoot();
    if (!rec.recording || !root) return;
    const rootRect = root.getBoundingClientRect();
    const top = root.scrollTop;
    const rowsOnScreen = [];
    for (const node of root.querySelectorAll('[data-event-id]')) {
      const id = node.getAttribute('data-event-id');
      if (!id || id === driver.streamId) continue;
      const r = node.getBoundingClientRect();
      if (r.bottom <= rootRect.top + 1) continue;
      if (r.top >= rootRect.bottom - 1) break;
      rowsOnScreen.push({ id, content: r.top - rootRect.top + top, visible: Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top), h: r.height });
      if (rowsOnScreen.length >= 4) break;
    }
    // Blank = part of the viewport covered by a virtual spacer (no message painted there).
    let blank = 0;
    for (const c of root.children) { if (c.getAttribute('aria-hidden') !== 'true') continue; const r = c.getBoundingClientRect(); blank += Math.max(0, Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top)); }
    rec.frames.push({ t: performance.now(), blank, phase: rec.phase, top, sh: root.scrollHeight, ch: root.clientHeight, gap: Math.max(0, root.scrollHeight - root.clientHeight - top), touching: rec.touching, rows: rowsOnScreen, mounted: root.querySelectorAll('[data-virtual-key]').length, vrows: window.__mhStacks ? [...root.querySelectorAll('[data-virtual-key]')].map((n) => [n.getAttribute('data-virtual-key'), Math.round(n.getBoundingClientRect().height)]) : undefined, spacers: window.__mhStacks ? [...root.children].filter((c) => c.getAttribute('aria-hidden') === 'true').map((c) => Math.round(c.getBoundingClientRect().height)) : undefined, events: window.__chatTimelineHarness.eventCount(), olderLeft: window.__chatTimelineHarness.olderPagesRemaining() });
  };
  const tick = () => { requestAnimationFrame(tick); if (rec.recording) { hook(); channel.port2.postMessage(0); } };
  rec.begin = (phase) => { rec.frames = []; rec.writes = []; rec.phase = phase; rec.recording = true; hook(); if (!rec.started) { rec.started = true; requestAnimationFrame(tick); } };
  rec.setPhase = (phase) => { rec.phase = phase; };
  rec.end = () => { rec.recording = false; const out = { frames: rec.frames, writes: rec.writes }; rec.frames = []; rec.writes = []; return out; };
  rec.teleport = (top) => { const r = findRoot(); const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'); desc.set.call(r, top); return desc.get.call(r); };
  rec.geometry = () => { const r = findRoot(); return { top: r.scrollTop, sh: r.scrollHeight, ch: r.clientHeight }; };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (v) => Math.round(v * 100) / 100;

/** Per painted frame: how far did a row visible in both frames move in content
 * space, minus the app's own scroll writes in between (a write compensates by
 * design). Non-zero = layout shifted under the reader without compensation. */
function analyze({ frames, writes }, label) {
  const out = { label, maxBlankPx: 0, blankFrames: 0, frames: frames.length, writes: writes.length, maxJumpPx: 0, jumpAt: null, jumpContext: [], activeWrites: 0, activeWritePx: 0, activeWriteSamples: [], olderLoads: 0, olderRequests: 0, maxAbsWritePx: 0 };
  let prevEvents = frames[0]?.events ?? 0;
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1]; const b = frames[i];
    if (b.events > prevEvents + 20) out.olderLoads += 1;
    if (b.olderLeft < a.olderLeft) out.olderRequests += 1;
    // A small gap above the very first message while the reader is parked at the top
    // (scrollTop ~ 0) is the top edge settling; blank anywhere else is a real hole.
    if (b.blank > 1 && b.top > 40) { out.blankFrames += 1; out.maxBlankPx = Math.max(out.maxBlankPx, b.blank); }
    prevEvents = b.events;
    const common = b.rows.find((r) => a.rows.some((q) => q.id === r.id));
    if (!common) continue;
    const before = a.rows.find((q) => q.id === common.id);
    const written = writes.filter((w) => w.t > a.t && w.t <= b.t).reduce((s, w) => s + w.delta, 0);
    // content-space row position is constant unless layout above it changed; a
    // scrollTop write shifts what is on screen but not content, so the visual
    // jump is the content shift NOT matched by a write, plus a write NOT matched
    // by a content shift (the app moved the viewport).
    const contentShift = common.content - before.content;
    const jump = Math.abs(contentShift - written);
    if (jump > out.maxJumpPx) { out.maxJumpPx = jump; out.jumpAt = i; out.jumpContext = frames.slice(Math.max(0, i - 2), i + 2).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.sh, gap: round(f.gap), touching: f.touching, mounted: f.mounted, row0: f.rows[0] ? `${f.rows[0].id}@${round(f.rows[0].content)}` : null })); out.jumpWritten = round(written); out.jumpContentShift = round(contentShift); }
  }
  for (const w of writes) {
    out.maxAbsWritePx = Math.max(out.maxAbsWritePx, Math.abs(w.delta));
    if (w.gap > 50 && (w.touching || w.sinceUserScrollMs < 150)) { out.activeWrites += 1; out.activeWritePx += Math.abs(w.delta); if (out.activeWriteSamples.length < (process.env.IMC_CHAT_SCROLL_STACKS === '1' ? 400 : 8)) out.activeWriteSamples.push({ stack: w.stack, t: round(w.t), kind: w.kind, from: round(w.from), to: round(w.to), delta: round(w.delta), touching: w.touching, sinceUserScrollMs: round(w.sinceUserScrollMs), phase: w.phase }); }
  }
  out.maxBlankPx = round(out.maxBlankPx);
  out.maxJumpPx = round(out.maxJumpPx); out.activeWritePx = round(out.activeWritePx); out.maxAbsWritePx = round(out.maxAbsWritePx);
  return out;
}

async function fling(cdp, box, distance, speed) {
  // Real touch drag that LIFTS WHILE MOVING, so Chromium's compositor keeps
  // scrolling on momentum after the finger is gone (the phone case). Finger moves
  // DOWN the screen = older rows revealed. `speed` is px/s at ~60 Hz move events.
  const x = box.x + box.width / 2;
  const perStep = Math.max(6, Math.round(speed / 60));
  const steps = Math.max(4, Math.round(distance / perStep));
  const y0 = box.y + box.height * 0.15;
  const yMax = box.y + box.height * 0.9;
  let y = y0;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < steps; i += 1) {
    y = Math.min(yMax, y + perStep);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const SCENARIOS = {
  // Scroll up through never-measured rows in the middle of a long, Markdown-heavy
  // history while the reply streams (virtual rows mount above the reader).
  'history-scroll': { rows: 900, olderPages: 0, olderPageRows: 0, stream: true, teleportFrac: 0.6, flings: FLINGS },
  // Scroll up into the top of the loaded history so older pages are requested and
  // prepended while the reader is still moving.
  'older-pages': { rows: 120, olderPages: 4, olderPageRows: 120, stream: true, teleportTop: 300, flings: FLINGS + 14, expectOlderRequests: 1 },
  // Messages taller than the 844px viewport (a long reply is one row, and the reader
  // is inside it): the anchor row spans the whole screen.
  'tall-rows': { rows: 400, olderPages: 0, olderPageRows: 0, stream: true, teleportFrac: 0.6, flings: FLINGS, tall: true },
  // Same, no streaming: isolates pagination/measurement from stream growth.
  'history-scroll-quiet': { rows: 900, olderPages: 0, olderPageRows: 0, stream: false, teleportFrac: 0.6, flings: FLINGS },
};

/** A scenario that hangs the page (runaway render loop) must fail, not stall the run. */
let hangProbe = { cdp: null };
async function runScenario(browser, name, cfg) {
  const limitMs = Number(process.env.IMC_CHAT_SCROLL_SCENARIO_TIMEOUT_MS ?? 240_000);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(async () => {
      const out = { name, viewport: VIEWPORT.label, config: cfg, phases: {}, error: `scenario exceeded ${limitMs} ms (page hung?)` };
      // Where is the main thread? Pause the debugger and read the stack.
      try {
        const cdp = hangProbe.cdp;
        const paused = new Promise((r) => cdp.once('Debugger.paused', r));
        await cdp.send('Debugger.pause');
        const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 5000))]);
        out.hangStack = ev ? ev.callFrames.slice(0, 14).map((f) => `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.location.lineNumber}`) : 'no pause (thread busy in native code?)';
      } catch (error) { out.hangStack = `probe failed: ${error}`; }
      resolve(out);
    }, limitMs);
  });
  try { return await Promise.race([runScenarioInner(browser, name, cfg), timeout]); } finally { clearTimeout(timer); }
}

async function runScenarioInner(browser, name, cfg) {
  const context = await browser.newContext({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.dpr, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  hangProbe.cdp = cdp;
  await cdp.send('Debugger.enable');
  const result = { name, viewport: VIEWPORT.label, config: cfg, phases: {} };
  try {
    await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&windows=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
    await page.evaluate(installDriver, { rows: cfg.rows, olderPages: cfg.olderPages, olderPageRows: cfg.olderPageRows, olderDelayMs: 300, tall: !!cfg.tall, stacks: process.env.IMC_CHAT_SCROLL_STACKS === '1' });
    await page.waitForSelector('.chat-view:not(.chat-view-preview) [data-virtual-key], .chat-view:not(.chat-view-preview) .chat-event', { timeout: 30_000 });
    await sleep(2000);
    if (cfg.stream) await page.evaluate(() => window.__mhDriver.start(25));
    await sleep(1500);
    const box = await page.locator('.chat-view:not(.chat-view-preview)').first().boundingBox();
    // Get off the bottom, into the region under test.
    const geo = await page.evaluate(() => window.__mh.geometry());
    const target = cfg.teleportTop ?? Math.round((geo.sh - geo.ch) * cfg.teleportFrac);
    await page.evaluate((t) => window.__mh.teleport(t), target);
    await sleep(1200); // let virtual measurement of the landing range settle
    await page.evaluate(() => window.__mh.begin('scroll-up'));
    const olderAtStart = await page.evaluate(() => window.__chatTimelineHarness.olderPagesRemaining());
    // A scenario that expects pagination keeps flicking (bounded) until a page was requested,
    // so it exercises loading older history however far the first flicks got.
    const maxFlings = cfg.expectOlderRequests ? cfg.flings + 30 : cfg.flings;
    for (let i = 0; i < maxFlings; i += 1) {
      if (i >= cfg.flings && (!cfg.expectOlderRequests || (await page.evaluate(() => window.__chatTimelineHarness.olderPagesRemaining())) < olderAtStart)) break;
      await fling(cdp, box, 500 + (i % 4) * 250, 1800 + (i % 3) * 1400);
      await sleep(400 + (i % 3) * 250); // partly coasting into the next flick, like a real reader
    }
    await sleep(800);
    const data = await page.evaluate(() => window.__mh.end());
    result.phases.scrollUp = analyze(data, 'scroll-up');
    if (process.env.IMC_CHAT_SCROLL_STACKS === '1') result.phases.scrollUp.frameDump = data.frames.map((f) => ({ t: round(f.t), blank: round(f.blank), events: f.events, olderLeft: f.olderLeft, top: round(f.top), sh: f.sh, spacers: f.spacers, touching: f.touching, vrows: f.vrows }));
    result.phases.scrollUp.finalTop = round(data.frames.at(-1)?.top ?? -1);
    result.phases.scrollUp.startTop = round(data.frames[0]?.top ?? -1);
    if (cfg.stream) await page.evaluate(() => window.__mhDriver.stop());
  } catch (error) {
    result.error = String(error?.stack ?? error);
  } finally {
    await context.close();
  }
  return result;
}

function verdicts(result) {
  const failures = [];
  if (result.error) failures.push(`error: ${result.error.split('\n')[0]}`);
  const p = result.phases.scrollUp;
  if (!p) return failures;
  if (p.frames < 30) failures.push(`scroll-up: only ${p.frames} frames`);
  if (Math.abs(p.startTop - p.finalTop) < 300) failures.push(`scroll-up: gestures did not move the viewport (${p.startTop} -> ${p.finalTop})`);
  if (p.maxJumpPx > TOL) failures.push(`scroll-up: visible row jumped ${p.maxJumpPx}px between frames`);
  if (result.config.expectOlderRequests && p.olderRequests < result.config.expectOlderRequests) failures.push(`scroll-up: expected >= ${result.config.expectOlderRequests} older-page request(s), saw ${p.olderRequests} (scenario did not exercise pagination)`);
  if (p.blankFrames > 3) failures.push(`scroll-up: ${p.blankFrames} frames showed blank space (max ${p.maxBlankPx}px) where messages should be`);
  if (p.activeWrites > 0) failures.push(`scroll-up: ${p.activeWrites} programmatic scroll writes (${p.activeWritePx}px total) while touching/coasting`);
  return failures;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const results = [];
  try {
    const only = (process.env.IMC_CHAT_SCROLL_ONLY ?? '').split(',').filter(Boolean);
    for (const [name, cfg] of Object.entries(SCENARIOS)) {
      if (only.length && !only.includes(name)) continue;
      results.push(await runScenario(browser, name, cfg));
    }
  } finally { await browser.close(); }
  let failed = 0;
  for (const r of results) { r.failures = verdicts(r); r.pass = r.failures.length === 0; if (!r.pass) failed += 1; }
  writeFileSync(OUTPUT, JSON.stringify({ revision: process.env.GIT_HEAD ?? 'unknown', tolerancePx: TOL, cases: results }, null, 2));
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.viewport}/${r.name} ${JSON.stringify(r.failures)}\n`);
  process.stdout.write(`chat-scroll-mobile-history: ${results.length - failed}/${results.length} passed -> ${OUTPUT}\n`);
  if (failed && !NO_FAIL) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
