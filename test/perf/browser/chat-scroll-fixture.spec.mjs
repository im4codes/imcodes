/**
 * Real-browser chat scroll-stability matrix on the dedicated real-ChatView
 * fixture (web/src/fixtures/chat-timeline). Drives the PRODUCTION ChatView with
 * live streaming and records EVERY animation frame, for desktop and mobile
 * (390x844, DPR2, touch) viewports:
 *
 *   pinned          pinned to the bottom while text streams + rows/tool cards arrive
 *   scroll-up       real wheel (desktop) / real touch gesture (mobile) up while
 *                   streaming; the reading row must not move afterwards and the
 *                   gesture must never be reversed by the app
 *   back-to-bottom  real gesture back down; the viewport must re-pin and stay
 *                   pinned on every frame while streaming continues
 *   tool-card       real click on a tool card's toggle at the bottom (expand + collapse)
 *   long-history    the same pinned / scroll-up / re-pin matrix on a long
 *                   (virtualized) history
 *
 * Per frame: scrollTop, scrollHeight, clientHeight, bottomGap and the reading
 * row's viewport offset (a real message row, never a streaming placeholder).
 *
 * Env: IMC_PERF_FIXTURE_URL (default http://127.0.0.1:4300),
 *      IMC_CHAT_SCROLL_OUTPUT (results json), IMC_CHAT_SCROLL_PINNED_MS (20000),
 *      IMC_CHAT_SCROLL_LONG_ROWS (3000), IMC_CHAT_SCROLL_NO_FAIL=1 (never exit 1).
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { MD_STREAM_SCRIPT, MD_PIECE_LENGTHS, burstyGaps } from './stream-script.mjs';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT = process.env.IMC_CHAT_SCROLL_OUTPUT ?? '/tmp/chat-scroll-fixture.json';
const PINNED_MS = Number(process.env.IMC_CHAT_SCROLL_PINNED_MS ?? 20_000);
const LONG_ROWS = Number(process.env.IMC_CHAT_SCROLL_LONG_ROWS ?? 3_000);
const NO_FAIL = process.env.IMC_CHAT_SCROLL_NO_FAIL === '1';
export const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 720, dpr: 1, mobile: false },
  { label: 'mobile', width: 390, height: 844, dpr: 2, mobile: true },
];
// Tolerances (product acceptance): no reverse movement > 1 px, bottomGap <= 1 px,
// reading row drift <= 1 px.
const TOL = 1;
/** Shared streaming fixtures handed to the in-page driver (installDriver is serialized). */
export const STREAM_FIXTURES = { gaps: burstyGaps(), mdScript: MD_STREAM_SCRIPT, mdPieceLengths: MD_PIECE_LENGTHS };

/** Installed in the page: builds the event list, streams into the real ChatView
 * through the fixture harness, and samples every animation frame. */
export function installDriver({ rows, gaps = [], mdScript = '', mdPieceLengths = [4] }) {
  // gaps / mdScript / mdPieceLengths: the shared streaming fixtures (stream-script.mjs)
  const sessionId = 'fixture-window-0';
  let seq = 0;
  let events = [];
  const mk = (type, payload) => ({ eventId: `scroll-${++seq}`, sessionId, epoch: 1, seq, ts: 1_700_000_000_000 + seq * 1_000, type, payload });
  const paragraph = (i) => {
    const lines = 1 + (i * 7) % 5;
    return Array.from({ length: lines }, (_, k) => `row ${i} line ${k}: ${'lorem ipsum dolor sit amet '.repeat(1 + ((i + k) % 4))}`).join('\n\n');
  };
  for (let i = 0; i < rows; i += 1) events.push(mk(i % 2 ? 'user.message' : 'assistant.text', { text: paragraph(i), streaming: false }));
  const cur0OpenText = (event) => typeof event?.payload?.text === 'string' && event.payload.text.includes('```');
  const harness = window.__chatTimelineHarness;
  const publish = () => harness.setEvents(events);
  let streamingIndex = -1;
  const driver = {
    events: () => events,
    streamId: null,
    chunkCount: 0,
    toolCount: 0,
    /** 'prose' (default) | 'code' (an unclosed fenced block growing line by line) | 'list' (bullet list)
     *  | 'md' (a Markdown-heavy reply - heading, ---, **bold**, lists, inline code - streamed in 2-7 character token-sized pieces) */
    pieceMode: 'prose',
    /** 'uniform' (default: one chunk every 1000/hz ms) | 'bursty' (3-6 chunks 20 ms apart, then a 150-350 ms pause, like a real token stream) */
    cadence: 'uniform',
    mdPos: 0,
    /** Text the next opened stream starts with (very long single message). */
    seedText: '',
    openStream() {
      const e = mk('assistant.text', { text: driver.seedText, streaming: true });
      events = [...events, e]; streamingIndex = events.length - 1; driver.streamId = e.eventId; publish();
    },
    chunk() {
      if (streamingIndex < 0) driver.openStream();
      const n = ++driver.chunkCount;
      const piece = driver.pieceMode === 'md'
        ? (() => { const len = mdPieceLengths[n % mdPieceLengths.length]; const out = mdScript.slice(driver.mdPos, driver.mdPos + len); driver.mdPos = (driver.mdPos + len) % mdScript.length; return out || ' '; })()
        : driver.pieceMode === 'code'
        ? (cur0OpenText(events[streamingIndex]) ? `const value${n} = compute(${n}, 'streamed line ${n}');\n` : '```ts\n')
        : driver.pieceMode === 'list'
          ? (n % 3 === 0 ? `\n- item ${n}${' word'.repeat(1 + (n % 5))}` : `${' word'.repeat(1 + (n % 4))}`)
          : n % 37 === 0 ? '\n\n## Section\n- point a\n- point b\n\n' : `${' word'.repeat(1 + (n % 4))}`;
      const cur = events[streamingIndex];
      const next = [...events];
      next[streamingIndex] = { ...cur, payload: { ...cur.payload, text: `${cur.payload.text}${piece}`, streaming: true } };
      events = next; publish();
    },
    finishStream() {
      if (streamingIndex < 0) return;
      const cur = events[streamingIndex];
      const next = [...events];
      next[streamingIndex] = { ...cur, payload: { ...cur.payload, streaming: false } };
      events = next; streamingIndex = -1; publish();
    },
    row() { driver.finishStream(); events = [...events, mk('assistant.text', { text: paragraph(events.length), streaming: false })]; publish(); },
    tool() {
      driver.finishStream();
      const toolCallId = `scroll-tool-${++driver.toolCount}`;
      const call = mk('tool.call', { toolCallId, tool: 'shell', input: { command: `echo scroll-${driver.toolCount}` }, detail: { kind: 'tool_use', input: { command: `echo scroll-${driver.toolCount}` } }, status: 'running' });
      const result = mk('tool.result', { toolCallId, tool: 'shell', output: Array.from({ length: 12 }, (_, i) => `scroll-fixture output ${i}`).join('\n'), detail: { kind: 'tool_result', output: 'scroll-fixture' }, status: 'complete', terminalStatus: 'succeeded' });
      events = [...events, call, result]; publish();
    },
    timer: null,
    start(hz = 25) {
      driver.stop();
      let n = 0;
      const step = () => {
        n += 1;
        driver.chunk();
        if (n % 90 === 0) { driver.mdPos = 0; driver.row(); }
        if (n % 200 === 0) driver.tool();
      };
      if (driver.cadence === 'bursty') {
        let gapIndex = 0;
        const next = () => { step(); driver.timer = setTimeout(next, gaps[gapIndex++ % gaps.length]); };
        driver.timer = setTimeout(next, gaps[0]);
      } else {
        driver.timer = setInterval(step, 1000 / hz);
      }
    },
    stop() { if (driver.timer) { clearInterval(driver.timer); clearTimeout(driver.timer); } driver.timer = null; },
  };
  window.__scrollDriver = driver;

  const jit = { frames: [], painted: [], phase: 'idle', recording: false, started: false, anchorKey: null, root: null };
  const findRoot = () => (jit.root?.isConnected ? jit.root : (jit.root = document.querySelector('.chat-view:not(.chat-view-preview)')));
  const tick = () => {
    requestAnimationFrame(tick);
    if (!jit.recording) return;
    const root = findRoot();
    if (root) {
      const rootRect = root.getBoundingClientRect();
      let anchorOffset = null; let anchorHeight = 0;
      if (jit.anchorKey) {
        const node = root.querySelector(`[data-event-id="${CSS.escape(jit.anchorKey)}"]`);
        if (node) { const r = node.getBoundingClientRect(); anchorOffset = r.top - rootRect.top; anchorHeight = r.height; }
      }
      jit.frames.push({
        t: performance.now(), phase: jit.phase, top: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
        bottomGap: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop), anchorOffset, anchorInView: anchorOffset !== null && anchorOffset + anchorHeight > 0 && anchorOffset < root.clientHeight,
        follow: !document.querySelector('.chat-scroll-btn'), // scroll-to-bottom button is shown iff follow is off
        // Diagnostics: what moved. topSpacer = leading virtual spacer, mounted = rows in DOM.
        topSpacer: (() => { const c = root.firstElementChild; return c && c.getAttribute('aria-hidden') === 'true' ? Math.round(c.getBoundingClientRect().height) : null; })(),
        mounted: root.querySelectorAll('[data-virtual-key]').length,
        rows: [...root.querySelectorAll('[data-virtual-key]')].map((n) => `${(n.getAttribute('data-virtual-key') || '').slice(-14)}:${Math.round(n.getBoundingClientRect().height)}`),
        firstChild: (() => { const c = root.firstElementChild; return c ? `${c.tagName}.${(c.className || '').toString().slice(0, 30)}:${Math.round(c.getBoundingClientRect().height)}` : null; })(),
        rowsAbove: (() => { if (!jit.anchorKey) return null; const a = root.querySelector(`[data-event-id="${CSS.escape(jit.anchorKey)}"]`); if (!a) return null; const item = a.closest('[data-virtual-key]'); if (!item) return null; let sum = 0; for (let n = item.previousElementSibling; n; n = n.previousElementSibling) sum += n.getBoundingClientRect().height; return Math.round(sum); })(),
      });
    }
  };
  // Painted-state sampler: a task queued from the rAF callback runs AFTER that
  // frame was rendered, so it sees what the user saw, whereas a rAF-time read
  // forces layout before ResizeObserver corrections of the same frame ran.
  jit.painted = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const root = findRoot();
    if (!jit.recording || !root) return;
    jit.painted.push({ t: performance.now(), phase: jit.phase, top: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, bottomGap: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop), anchorOffset: null });
  };
  const paintedTick = () => { requestAnimationFrame(paintedTick); if (jit.recording) channel.port2.postMessage(0); };
  window.__jit = jit;
  // Programmatic scroll writes by the app (setter on the chat root), so a jump can be
  // told apart from the browser/harness moving the viewport (e.g. an automation click
  // scrolling its target into view).
  jit.writes = [];
  const hookWrites = () => {
    const root = findRoot();
    if (!root || root.__jitHooked) return;
    root.__jitHooked = true;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(root, 'scrollTop', { configurable: true, get() { return desc.get.call(this); }, set(v) { if (jit.recording) jit.writes.push({ t: performance.now(), phase: jit.phase, from: desc.get.call(this), to: v }); desc.set.call(this, v); } });
  };
  jit.begin = (phase) => {
    hookWrites();
    jit.writes = [];
    jit.frames = []; jit.painted = []; jit.phase = phase; jit.recording = true;
    if (!jit.started) { jit.started = true; requestAnimationFrame(tick); requestAnimationFrame(paintedTick); }
  };
  jit.setPhase = (phase) => { jit.phase = phase; };
  jit.end = () => { jit.recording = false; const out = { frames: jit.frames, painted: jit.painted, writes: jit.writes }; jit.frames = []; jit.painted = []; return out; };
  /** Picks a real, fully visible message row (not the streaming/last row). */
  jit.pickAnchor = () => {
    const root = findRoot();
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    // A REAL message row (never the streaming one) with a substantial visible part.
    const visiblePx = (r) => Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top);
    const target = [...root.querySelectorAll('[data-event-id]')].find((n) => {
      const r = n.getBoundingClientRect();
      const id = n.getAttribute('data-event-id');
      return r.height > 8 && visiblePx(r) >= Math.min(40, r.height) && id !== driver.streamId;
    });
    jit.anchorKey = target?.getAttribute('data-event-id') ?? null;
    return jit.anchorKey;
  };
  jit.clearAnchor = () => { jit.anchorKey = null; };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function analyzePinned(frames) {
  let maxReverse = 0; let maxGap = 0; let reverseAt = null; let gapAt = null;
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i].bottomGap > maxGap) { maxGap = frames[i].bottomGap; gapAt = i; }
    if (i > 0) {
      // Backward viewport movement NOT explained by the content getting shorter
      // (a finalized/re-rendered row legitimately lowers scrollHeight; the browser
      // then clamps scrollTop by the same amount and gap stays 0).
      const shrink = Math.max(0, frames[i - 1].scrollHeight - frames[i].scrollHeight);
      const back = frames[i - 1].top - frames[i].top - shrink;
      if (back > maxReverse) { maxReverse = back; reverseAt = i; }
    }
  }
  // Keep the frames around the worst reverse / gap so a failure is diagnosable
  // from results.json alone (top, scrollHeight, clientHeight, bottomGap).
  const around = (i) => (i === null ? [] : frames.slice(Math.max(0, i - 3), i + 3).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.scrollHeight, ch: f.clientHeight, gap: round(f.bottomGap) })));
  return { frames: frames.length, maxReversePx: round(maxReverse), maxBottomGapPx: round(maxGap), reverseAtFrame: reverseAt, gapAtFrame: gapAt, reverseContext: around(reverseAt), gapContext: around(gapAt) };
}
/** rAF-time frames (what Cx22's probe measured) plus painted-state frames. */
function analyzeBoth({ frames, painted, writes }) {
  const raf = analyzePinned(frames);
  raf.appWrites = (writes ?? []).length;
  if (raf.maxReversePx > TOL || raf.maxBottomGapPx > TOL) raf.appWriteList = (writes ?? []).slice(0, 8).map((w) => ({ t: round(w.t), from: round(w.from), to: round(w.to) }));
  raf.painted = analyzePinned(painted);
  return raf;
}
function analyzeReading(frames) {
  const offs = frames.map((f) => f.anchorOffset).filter((v) => typeof v === 'number');
  if (offs.length === 0) return { frames: frames.length, anchoredFrames: 0, maxDriftPx: Infinity };
  const base = offs[0];
  let drift = 0; let firstAt = null; let worstAt = null;
  const anchored = frames.filter((f) => typeof f.anchorOffset === 'number');
  anchored.forEach((f, i) => {
    const d = Math.abs(f.anchorOffset - base);
    if (firstAt === null && d > TOL) firstAt = i;
    if (d > drift) { drift = d; worstAt = i; }
  });
  const around = (i) => (i === null ? [] : anchored.slice(Math.max(0, i - 3), i + 3).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.scrollHeight, off: round(f.anchorOffset), spacer: f.topSpacer, mounted: f.mounted, above: f.rowsAbove, rows: f.rows, firstChild: f.firstChild })));
  const missing = frames.length - offs.length;
  return { frames: frames.length, anchoredFrames: offs.length, missingAnchorFrames: missing, maxDriftPx: round(drift), firstDriftFrame: firstAt, driftStartContext: around(firstAt), driftWorstContext: around(worstAt) };
}
/** Largest downward jump between frames (the app forcing a scrolled-up reader). */
function maxForcedDown(frames) {
  let m = 0; let at = null;
  // A reader who scrolled up must never be moved down by the app, whatever the content does.
  for (let i = 1; i < frames.length; i += 1) { const d = frames[i].top - frames[i - 1].top; if (d > m) { m = d; at = i; } }
  return { px: round(m), context: at === null ? [] : frames.slice(Math.max(0, at - 3), at + 3).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.scrollHeight, ch: f.clientHeight, gap: round(f.bottomGap) })) };
}
export function round(v) { return Math.round(v * 100) / 100; }

async function gesture(page, cdp, viewport, direction, distance) {
  // direction 'up' = reveal older content. Real wheel on desktop, real touch
  // drag (compositor-driven synthesizeScrollGesture) on mobile.
  const box = await page.locator('.chat-view:not(.chat-view-preview)').first().boundingBox();
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  if (!viewport.mobile) {
    await page.mouse.move(x, y);
    const steps = 6;
    for (let i = 0; i < steps; i += 1) { await page.mouse.wheel(0, (direction === 'up' ? -1 : 1) * (distance / steps)); await sleep(30); }
  } else {
    // Real touch pipeline: finger moving DOWN drags content down (reveals older
    // rows); moving UP scrolls toward the tail. Dispatched as CDP touch events
    // so both the DOM touch handlers and the compositor scroll see them.
    const dir = direction === 'up' ? 1 : -1;
    const half = Math.min(distance, box.height * 0.8) / 2;
    const y0 = y - dir * half; const y1 = y + dir * half;
    const steps = 14;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] });
      await sleep(16);
    }
    // Hold still before lifting so the compositor sees ~zero release velocity
    // (otherwise Chromium flings and the "reading row" keeps moving on its own).
    await sleep(250);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

async function runScenario(browser, viewport, { rows, pinnedMs, label, windows = 1 }) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, isMobile: viewport.mobile, hasTouch: viewport.mobile });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const result = { label, viewport: viewport.label, rows, phases: {} };
  try {
    await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&windows=${windows}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
    await page.evaluate(installDriver, { rows, ...STREAM_FIXTURES });
    await page.waitForSelector('.chat-view:not(.chat-view-preview) [data-virtual-key], .chat-view:not(.chat-view-preview) .chat-event', { timeout: 30_000 });
    // Settle the initial history layout at the tail, then start streaming.
    await sleep(1500);
    // Wait for the initial history layout to stop moving before the measured stream.
    await page.waitForFunction(() => {
      const r = document.querySelector('.chat-view:not(.chat-view-preview)');
      if (!r) return false;
      const sig = `${r.scrollHeight}:${r.scrollTop}`;
      const st = window.__settle;
      if (!st || st.sig !== sig) { window.__settle = { sig, since: performance.now() }; return false; }
      return performance.now() - st.since > 700;
    }, undefined, { timeout: 15_000, polling: 100 }).catch(() => {});
    await page.evaluate(() => window.__scrollDriver.start(25));

    // 1. pinned streaming
    await page.evaluate(() => window.__jit.begin('pinned'));
    await sleep(pinnedMs);
    result.phases.pinned = analyzeBoth(await page.evaluate(() => window.__jit.end()));
    const pinnedAtEnd = await page.evaluate(() => { const r = document.querySelector('.chat-view:not(.chat-view-preview)'); return r.scrollHeight - r.clientHeight - r.scrollTop; });
    result.phases.pinned.finalGapPx = round(pinnedAtEnd);

    // 2. scroll up while streaming, then hold: reading row must be still
    // Track a real message row that is visible when the gesture starts. While the
    // user drags/wheels toward older content that row only ever moves DOWN the
    // screen; any frame where it moves UP means the app pushed the viewport down.
    // (Raw scrollTop cannot be used here: reader-anchor compensation legitimately
    // changes scrollTop when previously unmeasured rows above are measured.)
    result.phases.gestureStartAnchor = await page.evaluate(() => window.__jit.pickAnchor());
    await page.evaluate(() => window.__jit.begin('gesture-up'));
    await gesture(page, cdp, viewport, 'up', 1400);
    const gestureFrames = (await page.evaluate(() => window.__jit.end())).frames;
    await page.evaluate(() => window.__jit.clearAnchor());
    // Judge from the first frame in which the viewport actually moved toward older
    // content: until the gesture registers, the pane is still (correctly) following
    // the stream, which moves the row up the screen.
    const startAt = gestureFrames.findIndex((f, i) => i > 0 && gestureFrames[i - 1].top - f.top > TOL);
    const anchored = gestureFrames.slice(Math.max(0, startAt)).filter((f) => typeof f.anchorOffset === 'number' && f.anchorInView);
    let pushedUp = 0; let pushAt = null;
    for (let i = 1; i < anchored.length; i += 1) { const d = anchored[i - 1].anchorOffset - anchored[i].anchorOffset; if (d > pushedUp) { pushedUp = d; pushAt = i; } }
    result.phases.gestureUp = { pushContext: pushAt === null ? [] : anchored.slice(Math.max(0, pushAt - 4), pushAt + 3).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.scrollHeight, off: round(f.anchorOffset), follow: f.follow })), frames: gestureFrames.length, anchoredFrames: anchored.length, maxAnchorPushedUpPx: round(pushedUp), topTrace: gestureFrames.filter((_, i) => i % Math.max(1, Math.floor(gestureFrames.length / 12)) === 0).map((f) => round(f.top)), endGapPx: round(gestureFrames.at(-1)?.bottomGap ?? 0) };
    await sleep(700); // let the gesture/animation and any deferred release finish
    const anchor = await page.evaluate(() => window.__jit.pickAnchor());
    result.phases.readingAnchor = anchor;
    await page.evaluate(() => window.__jit.begin('reading'));
    await sleep(Math.min(6_000, Math.max(3_000, pinnedMs / 3)));
    const reading = (await page.evaluate(() => window.__jit.end())).frames;
    result.phases.reading = { ...analyzeReading(reading), maxForcedDownPx: maxForcedDown(reading).px, forcedDownContext: maxForcedDown(reading).context, gapPx: round(reading.at(-1)?.bottomGap ?? 0) };

    // 3. back to the bottom with real gestures -> must re-pin and stay pinned
    await page.evaluate(() => { window.__jit.pickAnchor(); window.__jit.begin('return'); });
    for (let i = 0; i < 12; i += 1) {
      await gesture(page, cdp, viewport, 'down', 1600);
      await sleep(350);
      const gap = await page.evaluate(() => { const r = document.querySelector('.chat-view:not(.chat-view-preview)'); return r.scrollHeight - r.clientHeight - r.scrollTop; });
      if (gap <= 2) break;
    }
    await sleep(500);
    const arrival = (await page.evaluate(() => window.__jit.end())).frames;
    await page.evaluate(() => window.__jit.clearAnchor());
    // The reader is scrolling DOWN: a tracked real row may only move UP the screen.
    // A frame where it moves down means the app pushed the viewport back toward older content.
    const returned = arrival.filter((f) => typeof f.anchorOffset === 'number' && f.anchorInView);
    let pushedDown = 0; let pushDownAt = null;
    for (let i = 1; i < returned.length; i += 1) { const d = returned[i].anchorOffset - returned[i - 1].anchorOffset; if (d > pushedDown) { pushedDown = d; pushDownAt = i; } }
    result.phases.returnGesture = { frames: arrival.length, anchoredFrames: returned.length, maxAnchorPushedBackPx: round(pushedDown), pushContext: pushDownAt === null ? [] : returned.slice(Math.max(0, pushDownAt - 4), pushDownAt + 3).map((f) => ({ t: round(f.t), top: round(f.top), sh: f.scrollHeight, off: round(f.anchorOffset), follow: f.follow })) };
    await page.evaluate(() => window.__jit.begin('repinned'));
    await sleep(4_000);
    result.phases.repinned = analyzeBoth(await page.evaluate(() => window.__jit.end()));

    // 4. tool card expand / collapse at the bottom (real clicks)
    await page.evaluate(() => { window.__scrollDriver.tool(); });
    await sleep(800);
    const toggle = page.locator('.chat-tool-block-toggle:visible').last();
    if (await toggle.count()) {
      await page.evaluate(() => window.__jit.begin('tool-expand'));
      await toggle.click({ timeout: 5_000 }).catch(() => {});
      await sleep(900);
      result.phases.toolExpand = analyzeBoth(await page.evaluate(() => window.__jit.end()));
      await page.evaluate(() => window.__jit.begin('tool-collapse'));
      await toggle.click({ timeout: 5_000 }).catch(() => {});
      await sleep(900);
      result.phases.toolCollapse = analyzeBoth(await page.evaluate(() => window.__jit.end()));
    } else {
      result.phases.toolExpand = { skipped: 'no tool toggle rendered' };
    }
    await page.evaluate(() => window.__scrollDriver.stop());
  } catch (error) {
    result.error = String(error?.stack ?? error);
  } finally {
    await context.close();
  }
  return result;
}


/** Main-thread CPU while nothing changes (must stay ~idle: no per-frame work) and while
 * 4 panes stream. CDP Performance metrics are cumulative seconds; we report ms per second. */
async function runCpuScenario(browser, windows) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const snap = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const perSecond = (a, b, ms) => Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((k) => [k, round(((b[k] - a[k]) * 1000) / (ms / 1000))]));
  const out = { windows };
  try {
    await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&windows=${windows}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
    await page.evaluate(installDriver, { rows: 240, ...STREAM_FIXTURES });
    await sleep(2500);
    // Idle at the bottom, pinned, nothing arriving. Count rAF callbacks the page itself schedules.
    await page.evaluate(() => { window.__rafCount = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => raf((t) => { window.__rafCount += 1; cb(t); }); });
    let a = await snap(); await sleep(10_000); let b = await snap();
    out.idle = { msPerSecond: perSecond(a, b, 10_000), rafCallbacksPerSecond: round((await page.evaluate(() => window.__rafCount)) / 10) };
    await page.evaluate(() => window.__scrollDriver.start(25));
    await sleep(1500);
    a = await snap(); await sleep(10_000); b = await snap();
    out.streaming = { msPerSecond: perSecond(a, b, 10_000) };
    await page.evaluate(() => window.__scrollDriver.stop());
  } catch (error) { out.error = String(error?.stack ?? error); } finally { await context.close(); }
  return out;
}

function verdicts(result) {
  const p = result.phases; const failures = [];
  const need = (cond, msg) => { if (!cond) failures.push(msg); };
  if (result.error) failures.push(`error: ${result.error.split('\n')[0]}`);
  const pinned = (name, v) => { if (!v || v.skipped) { failures.push(`${name}: missing`); return; } need(v.frames >= 10, `${name}: only ${v.frames} frames`); need(v.maxReversePx <= TOL, `${name}: reverse ${v.maxReversePx}px`); need(v.maxBottomGapPx <= TOL, `${name}: bottomGap ${v.maxBottomGapPx}px`); need(!v.painted || (v.painted.maxReversePx <= TOL && v.painted.maxBottomGapPx <= TOL), `${name}: painted-state reverse ${v.painted?.maxReversePx}px / gap ${v.painted?.maxBottomGapPx}px`); };
  pinned('pinned', p.pinned); pinned('repinned', p.repinned); pinned('toolExpand', p.toolExpand); pinned('toolCollapse', p.toolCollapse);
  need(p.gestureUp && p.gestureUp.anchoredFrames >= 3 && p.gestureUp.maxAnchorPushedUpPx <= TOL, `gestureUp: reading row pushed ${p.gestureUp?.maxAnchorPushedUpPx}px against the gesture (${p.gestureUp?.anchoredFrames} anchored frames)`);
  need(p.gestureUp && p.gestureUp.endGapPx > 100, `gestureUp: gesture did not leave the bottom (gap ${p.gestureUp?.endGapPx})`);
  need(p.readingAnchor, 'reading: no real message row found to anchor');
  need(p.reading && p.reading.anchoredFrames >= 10 && p.reading.maxDriftPx <= TOL, `reading: drift ${p.reading?.maxDriftPx}px over ${p.reading?.anchoredFrames} frames`);
  // (raw scrollTop increases while reading are legitimate anchor compensation; drift above is the verdict)
  need(p.reading && p.reading.gapPx > 100, `reading: reader was returned to the bottom (gap ${p.reading?.gapPx})`);
  need(p.returnGesture && p.returnGesture.anchoredFrames >= 3 && p.returnGesture.maxAnchorPushedBackPx <= TOL, `return: reading row pushed back ${p.returnGesture?.maxAnchorPushedBackPx}px while the user scrolled down (${p.returnGesture?.anchoredFrames} anchored frames)`);
  return failures;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const results = [];
  const cpuResults = [];
  try {
    const only = (process.env.IMC_CHAT_SCROLL_ONLY ?? '').split(',').filter(Boolean);
    const wanted = (viewport, label) => only.length === 0 || only.includes(`${viewport.label}/${label}`);
    for (const viewport of VIEWPORTS) {
      if (wanted(viewport, 'short-history')) results.push(await runScenario(browser, viewport, { rows: 240, pinnedMs: PINNED_MS, label: 'short-history' }));
      if (wanted(viewport, 'long-history')) results.push(await runScenario(browser, viewport, { rows: LONG_ROWS, pinnedMs: Math.min(PINNED_MS, 12_000), label: 'long-history' }));
    }
    if (process.env.IMC_CHAT_SCROLL_CPU === '1') {
      // Repeated in-process so a noisy host shows up as spread, not as a false regression.
      for (let rep = 0; rep < Number(process.env.IMC_CHAT_SCROLL_CPU_REPS ?? 1); rep += 1) cpuResults.push(await runCpuScenario(browser, 1), await runCpuScenario(browser, 4));
    }
  } finally { await browser.close(); }
  let failed = 0;
  for (const r of results) { r.failures = verdicts(r); r.pass = r.failures.length === 0; if (!r.pass) failed += 1; }
  writeFileSync(OUTPUT, JSON.stringify({ revision: process.env.GIT_HEAD ?? 'unknown', tolerancePx: TOL, cases: results, cpu: cpuResults }, null, 2));
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.viewport}/${r.label} ${JSON.stringify(r.failures)}\n`);
  process.stdout.write(`chat-scroll-fixture: ${results.length - failed}/${results.length} passed -> ${OUTPUT}\n`);
  if (failed && !NO_FAIL) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
