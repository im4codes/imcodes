/**
 * Real-browser streaming-flicker probe on the dedicated real-ChatView fixture
 * (web/src/fixtures/chat-timeline), reusing the chat-scroll driver
 * (chat-scroll-fixture.spec.mjs: same streaming cadence, rows and tool cards).
 *
 * While a reply streams the streaming row must keep ONE DOM identity and only
 * its text may grow; nothing around it may blank, re-mount or jump. Per frame
 * (rAF and painted-state) the probe records:
 *
 *   identity   DOM node ids of the streaming row's wrapper / event element /
 *              text container, and of the rows next to it (remounts = distinct-1)
 *   mutations  element and text-node adds/removes, characterData and attribute
 *              writes inside the streaming row, the neighbour rows and elsewhere
 *   blanking   text length of the streaming row shrinking, opacity/visibility/
 *              display changes, CSS animations/transitions that START on a row
 *   layout     streaming row content-top (row top in scroll-content coordinates;
 *              must not move while only its own text grows), height, width
 *   scroll     every scrollTop / scrollTo / scrollBy write on the chat root
 *              (count per frame, net delta), viewport clientWidth (scrollbar toggles)
 *
 * Variants: prose (default), code (unclosed fenced block growing), list, long
 * (one very long single message). Viewports: desktop + mobile (390x844, DPR2,
 * touch); IMC_FLICKER_REDUCED_MOTION=1 emulates prefers-reduced-motion.
 *
 * Env: IMC_PERF_FIXTURE_URL, IMC_FLICKER_OUTPUT (results json), IMC_FLICKER_MS
 * (20000), IMC_FLICKER_ONLY (comma list of "<viewport>/<variant>"),
 * IMC_FLICKER_NO_FAIL=1, IMC_FLICKER_REDUCED_MOTION=1.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { installDriver, sleep, round, VIEWPORTS, STREAM_FIXTURES } from './chat-scroll-fixture.spec.mjs';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_FIXTURE_URL ?? 'http://127.0.0.1:4300';
const OUTPUT = process.env.IMC_FLICKER_OUTPUT ?? '/tmp/chat-stream-flicker.json';
const STREAM_MS = Number(process.env.IMC_FLICKER_MS ?? 20_000);
const NO_FAIL = process.env.IMC_FLICKER_NO_FAIL === '1';
const REDUCED = process.env.IMC_FLICKER_REDUCED_MOTION === '1';
const TOL = 1;
const VARIANTS = [
  { label: 'prose', pieceMode: 'prose', rows: 240 },
  { label: 'code', pieceMode: 'code', rows: 240 },
  { label: 'list', pieceMode: 'list', rows: 240 },
  // Over RICH_TEXT_ENHANCEMENT_CHAR_LIMIT (20k chars) a message is plain text by design: it must be raw from the first frame and never flip.
  { label: 'long', pieceMode: 'prose', rows: 240, seedChars: 30_000, expectRaw: true },
  // Crosses the limit while streaming: Markdown -> plain text exactly once, never back.
  { label: 'long-cross', pieceMode: 'prose', rows: 240, seedChars: 19_800, maxFlips: 1, allowRawTail: true },
  // The owner's recording: a Markdown-heavy reply (heading, ---, **bold**, lists)
  // arriving in token-sized pieces in bursts. Uniform 25 Hz never triggered it.
  { label: 'markdown-bursty', pieceMode: 'md', cadence: 'bursty', rows: 240 },
  { label: 'markdown-uniform', pieceMode: 'md', cadence: 'uniform', rows: 240 },
];

/** Installed in the page (after installDriver). */
export function installFlickerProbe() {
  const P = { recording: false, frames: [], painted: [], ids: new WeakMap(), nextId: 1, identity: new Map(), acc: null, animStarts: [], scrollWrites: [], lastLen: new Map(), lastText: new Map(), shrinkLog: [], remounts: [], removedLog: [] };
  window.__flicker = P;
  const idOf = (node) => { let v = P.ids.get(node); if (v === undefined) { v = P.nextId; P.nextId += 1; P.ids.set(node, v); } return v; };
  // Fixture: the single real ChatView and the driver's streaming event. Real app
  // (many-windows): window.__flickerRoot() / __flickerStreamKey() pick the
  // measured window and its currently streaming eventId.
  const root = () => (window.__flickerRoot ? window.__flickerRoot() : document.querySelector('.chat-view:not(.chat-view-preview)'));
  const newAcc = () => ({ stream: { elAdd: 0, elDel: 0, txtAdd: 0, txtDel: 0, chr: 0, attr: 0 }, near: { elAdd: 0, elDel: 0, txtAdd: 0, txtDel: 0, chr: 0, attr: 0 }, other: { elAdd: 0, elDel: 0, txtAdd: 0, txtDel: 0, chr: 0, attr: 0 } });
  P.acc = newAcc();
  const streamKey = () => (window.__flickerStreamKey ? window.__flickerStreamKey() : (window.__scrollDriver?.streamId ?? null));
  const rowOf = (node) => { const el = node?.nodeType === 1 ? node : node?.parentElement; return el?.closest?.('[data-virtual-key]') ?? el?.closest?.('[data-event-id]') ?? null; };
  const classify = (row) => {
    if (!row) return 'other';
    const key = row.getAttribute('data-virtual-key') ?? row.getAttribute('data-event-id');
    const sk = streamKey();
    if (key === sk) return 'stream';
    const stream = sk ? (root()?.querySelector(`[data-virtual-key="${CSS.escape(sk)}"]`) ?? root()?.querySelector(`[data-event-id="${CSS.escape(sk)}"]`)) : null;
    if (stream && (row === stream.previousElementSibling || row === stream.nextElementSibling || row === stream.previousElementSibling?.previousElementSibling)) return 'near';
    return 'other';
  };
  const mo = new MutationObserver((records) => {
    if (!P.recording) return;
    for (const r of records) {
      const bucket = P.acc[classify(rowOf(r.target))];
      if (r.type === 'characterData') bucket.chr += 1;
      else if (r.type === 'attributes') bucket.attr += 1;
      else {
        for (const n of r.addedNodes) { if (n.nodeType === 1) bucket.elAdd += 1; else if (n.nodeType === 3) bucket.txtAdd += 1; }
        for (const n of r.removedNodes) {
          if (n.nodeType === 1) { bucket.elDel += 1; if (P.removedLog.length < 24 && P.acc.stream === bucket) P.removedLog.push({ t: performance.now(), el: `${n.tagName}.${String(n.className).slice(0, 40)}`, parent: `${r.target.tagName}.${String(r.target.className).slice(0, 40)}` }); } else if (n.nodeType === 3) bucket.txtDel += 1;
        }
      }
    }
  });
  const observe = () => { const r = root(); if (r && P.observed !== r) { mo.disconnect(); mo.observe(r, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] }); P.observed = r; } };
  // scrollTop / scrollTo / scrollBy writes on the chat root
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return desc.get.call(this); }, set(v) { if (P.recording && this === root()) P.scrollWrites.push({ t: performance.now(), from: desc.get.call(this), to: v, via: 'scrollTop' }); desc.set.call(this, v); } });
  for (const name of ['scrollTo', 'scrollBy']) {
    const orig = Element.prototype[name];
    Element.prototype[name] = function patched(...args) { if (P.recording && this === root()) P.scrollWrites.push({ t: performance.now(), from: desc.get.call(this), to: args, via: name }); return orig.apply(this, args); };
  }
  // CSS animations / transitions that start on a chat row
  for (const type of ['animationstart', 'transitionrun']) {
    document.addEventListener(type, (event) => {
      if (!P.recording) return;
      const row = rowOf(event.target);
      if (!row) return;
      P.animStarts.push({ t: performance.now(), type, name: event.animationName ?? event.propertyName, cls: classify(row), tag: `${event.target.tagName}.${String(event.target.className).slice(0, 40)}` });
    }, true);
  }
  const sample = () => {
    const r = root();
    if (!r) return null;
    observe();
    const rootRect = r.getBoundingClientRect();
    const sk = streamKey();
    // A virtualized list wraps every row in [data-virtual-key]; a short (non-virtualized) chat has the event element itself.
    const event = sk ? r.querySelector(`[data-event-id="${CSS.escape(sk)}"]`) : null;
    const wrapper = (sk ? r.querySelector(`[data-virtual-key="${CSS.escape(sk)}"]`) : null) ?? event;
    const textEl = event?.firstElementChild ?? null;
    const track = (label, node) => {
      if (!node) return;
      const k = `${sk}:${label}`;
      let set = P.identity.get(k); if (!set) { set = new Set(); P.identity.set(k, set); }
      const id = idOf(node);
      if (set.size > 0 && !set.has(id)) P.remounts.push({ t: performance.now(), part: label, html: node.outerHTML.slice(0, 160), prevCount: set.size, len: (event?.textContent ?? '').length });
      set.add(id);
    };
    track('wrapper', wrapper); track('event', event); track('text', textEl);
    const near = [wrapper?.previousElementSibling, wrapper?.previousElementSibling?.previousElementSibling, wrapper?.nextElementSibling].filter(Boolean);
    near.forEach((n, i) => track(`near${i}:${n.getAttribute('data-virtual-key') ?? n.getAttribute('data-event-id')}`, n));
    const cs = event ? getComputedStyle(event) : null;
    const len = (event?.textContent ?? '').length;
    // Render mode of the streaming bubble: 'raw' = one bare <span> of text (the
    // un-parsed fallback), 'markdown' = block elements, 'empty' before any text.
    const rich = event?.querySelector('.chat-rich-text') ?? null;
    const mode = !rich ? 'empty' : (rich.children.length === 1 && rich.firstElementChild.tagName === 'SPAN' ? 'raw' : 'markdown');
    const prevLen = P.lastLen.get(sk) ?? 0;
    const text = event?.textContent ?? '';
    const prevText = P.lastText.get(sk) ?? '';
    if (len < prevLen && prevText && P.shrinkLog.length < 6) P.shrinkLog.push({ t: performance.now(), key: sk, prevLen, len, prevHead: prevText.slice(0, 90), prevTail: prevText.slice(-90), nowHead: text.slice(0, 90), nowTail: text.slice(-90) });
    P.lastText.set(sk, text);
    P.lastLen.set(sk, Math.max(prevLen, len));
    const rect = wrapper?.getBoundingClientRect();
    return {
      t: performance.now(), key: sk, mounted: !!wrapper, mode, len, shrunk: len < prevLen, rootScrollTop: r.scrollTop, clientWidth: r.clientWidth, clientHeight: r.clientHeight, scrollHeight: r.scrollHeight,
      contentTop: rect ? rect.top - rootRect.top + r.scrollTop : null, viewportTop: rect ? rect.top - rootRect.top : null, absTop: rect?.top ?? null, absBottom: rect?.bottom ?? null, height: rect?.height ?? null, width: rect?.width ?? null,
      opacity: cs ? Number(cs.opacity) : null, visibility: cs?.visibility ?? null, display: cs?.display ?? null,
      anims: event ? event.getAnimations({ subtree: true }).length : 0,
      acc: P.acc, writes: P.scrollWrites.length,
    };
  };
  const flush = () => { const acc = P.acc; P.acc = newAcc(); return acc; };
  const tick = () => {
    requestAnimationFrame(tick);
    if (!P.recording) return;
    const s = sample();
    if (s) { s.acc = flush(); P.frames.push(s); }
  };
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (!P.recording) return;
    const s = sample();
    if (s) { s.acc = null; P.painted.push(s); }
  };
  const paintedTick = () => { requestAnimationFrame(paintedTick); if (P.recording) channel.port2.postMessage(0); };
  P.begin = () => { P.frames = []; P.painted = []; P.animStarts = []; P.scrollWrites = []; P.remounts = []; P.removedLog = []; P.lastText = new Map(); P.shrinkLog = []; P.identity = new Map(); P.lastLen = new Map(); P.acc = newAcc(); P.recording = true; if (!P.started) { P.started = true; requestAnimationFrame(tick); requestAnimationFrame(paintedTick); } };
  P.end = () => {
    P.recording = false;
    const identity = {}; for (const [k, set] of P.identity) identity[k] = set.size;
    return { frames: P.frames, painted: P.painted, animStarts: P.animStarts, scrollWrites: P.scrollWrites, identity, remountEvents: P.remounts, removedLog: P.removedLog, shrinkLog: P.shrinkLog };
  };
}

function sum(frames, bucket, field) { return frames.reduce((a, f) => a + (f.acc?.[bucket]?.[field] ?? 0), 0); }

export function analyze({ frames, painted, animStarts, scrollWrites, identity, remountEvents, removedLog, shrinkLog }) {
  // Identity: distinct DOM nodes per (stream, part); >1 means the node was re-created while streaming.
  const remounts = { wrapper: 0, event: 0, text: 0, near: 0 };
  const perPart = [];
  for (const [k, n] of Object.entries(identity)) {
    const part = k.slice(k.indexOf(':') + 1);
    const bucket = part.startsWith('near') ? 'near' : part;
    if (n > 1) { remounts[bucket] = (remounts[bucket] ?? 0) + (n - 1); perPart.push({ key: k, distinct: n }); }
  }
  // Layout: the streaming row's top in content coordinates must not move while only its own text grows.
  const jitter = (list) => {
    let max = 0; let at = null; let atIdx = -1; const stepsOver = [];
    let prev = null;
    list.forEach((f, i) => {
      if (f.contentTop === null || !f.mounted) { prev = null; return; }
      if (prev && prev.key === f.key) { const d = Math.abs(f.contentTop - prev.contentTop); if (d > max) { max = d; at = f.t; atIdx = i; } if (d > TOL) stepsOver.push(round(d)); }
      prev = f;
    });
    const ctx = atIdx < 0 ? [] : list.slice(Math.max(0, atIdx - 2), atIdx + 2).map((f) => ({ t: round(f.t), key: f.key, contentTop: round(f.contentTop), h: round(f.height), sh: f.scrollHeight, st: round(f.rootScrollTop), len: f.len }));
    return { maxContentTopStepPx: round(max), atMs: at === null ? null : round(at), framesOverTol: stepsOver.length, samples: stepsOver.slice(0, 8), context: ctx };
  };
  const viewportTopJitter = (list) => {
    // Detects back-and-forth motion of the streaming row in the viewport: sign flips of the frame-to-frame step.
    let flips = 0; let prevStep = 0; let prev = null; let maxBack = 0;
    for (const f of list) {
      if (f.viewportTop === null || !f.mounted) { prev = null; prevStep = 0; continue; }
      if (prev && prev.key === f.key) {
        const step = f.viewportTop - prev.viewportTop;
        if (Math.abs(step) > TOL && Math.abs(prevStep) > TOL && Math.sign(step) !== Math.sign(prevStep)) flips += 1;
        if (step > maxBack) maxBack = step; // downward step of the row top in the viewport while pinned = row pushed back
        prevStep = step;
      }
      prev = f;
    }
    return { directionFlips: flips, maxDownStepPx: round(maxBack) };
  };
  const bottomJitter = (list) => {
    let max = 0; let at = null; let over = 0; let prev = null; let atIdx = -1;
    list.forEach((f, i) => {
      if (f.absBottom === null || !f.mounted) { prev = null; return; }
      // SCREEN coordinates: a banner/composer mounting beside the list moves the
      // chat root's own top edge, which is not the text moving.
      const bottom = f.absBottom;
      if (prev && prev.key === f.key) { const d = Math.abs(bottom - prev.bottom); if (d > max) { max = d; at = f.t; atIdx = i; } if (d > TOL) over += 1; }
      prev = { key: f.key, bottom };
    });
    const ctx = atIdx < 0 ? [] : list.slice(Math.max(0, atIdx - 2), atIdx + 2).map((f) => ({ t: round(f.t), key: f.key, top: round(f.absTop), h: round(f.height), sh: f.scrollHeight, st: round(f.rootScrollTop), ch: f.clientHeight, len: f.len }));
    return { maxBottomStepPx: round(max), framesOverTol: over, atMs: at === null ? null : round(at), context: ctx };
  };
  // Render-mode flips of the streaming bubble (raw <-> Markdown) and height regressions.
  const modeStats = (list) => {
    let flips = 0; let raw = 0; let prev = null; const flipAt = [];
    for (const f of list) {
      if (!f.mounted || f.mode === 'empty') { prev = null; continue; }
      if (f.mode === 'raw') raw += 1;
      if (prev && prev.key === f.key && prev.mode !== f.mode) { flips += 1; if (flipAt.length < 6) flipAt.push({ t: round(f.t), from: prev.mode, to: f.mode, len: f.len }); }
      prev = f;
    }
    return { flips, rawFrames: raw, flipAt };
  };
  const heightStats = (list) => {
    let maxDrop = 0; let drops = 0; let prev = null; let atIdx = -1;
    list.forEach((f, i) => {
      if (!f.mounted || f.height === null) { prev = null; return; }
      if (prev && prev.key === f.key) { const d = prev.height - f.height; if (d > maxDrop) { maxDrop = d; atIdx = i; } if (d > TOL) drops += 1; }
      prev = f;
    });
    return { maxDropPx: round(maxDrop), dropFrames: drops, context: atIdx < 0 ? [] : list.slice(Math.max(0, atIdx - 2), atIdx + 2).map((f) => ({ t: round(f.t), h: round(f.height), len: f.len, mode: f.mode })) };
  };
  const unmountedFrames = frames.filter((f) => !f.mounted).length;
  const blank = frames.filter((f) => f.mounted && (f.shrunk || f.opacity === 0 || f.visibility === 'hidden' || f.display === 'none')).length;
  const fades = frames.filter((f) => f.mounted && f.opacity !== null && f.opacity < 1).length;
  const widthChanges = (() => { let c = 0; for (let i = 1; i < frames.length; i += 1) if (frames[i].clientWidth !== frames[i - 1].clientWidth) c += 1; return c; })();
  const writesPerFrame = frames.length ? round(scrollWrites.length / frames.length) : 0;
  const nonPin = scrollWrites.filter((w) => w.via === 'scrollTop').length;
  return {
    frames: frames.length, paintedFrames: painted.length, streamsSeen: new Set(frames.map((f) => f.key).filter(Boolean)).size,
    remounts, remountDetail: perPart.slice(0, 10), remountEvents: (remountEvents ?? []).slice(0, 8), removedElements: removedLog ?? [], shrinkLog: shrinkLog ?? [],
    mutations: {
      stream: { elAdd: sum(frames, 'stream', 'elAdd'), elDel: sum(frames, 'stream', 'elDel'), txtAdd: sum(frames, 'stream', 'txtAdd'), txtDel: sum(frames, 'stream', 'txtDel'), chr: sum(frames, 'stream', 'chr'), attr: sum(frames, 'stream', 'attr') },
      near: { elAdd: sum(frames, 'near', 'elAdd'), elDel: sum(frames, 'near', 'elDel'), txtAdd: sum(frames, 'near', 'txtAdd'), txtDel: sum(frames, 'near', 'txtDel'), chr: sum(frames, 'near', 'chr'), attr: sum(frames, 'near', 'attr') },
    },
    renderMode: { rAF: modeStats(frames), painted: modeStats(painted) }, height: { rAF: heightStats(frames), painted: heightStats(painted) }, blankingFrames: blank, unmountedStreamFrames: unmountedFrames, fadingFrames: fades,
    animationStartsOnRows: animStarts.length, animationStartDetail: animStarts.slice(0, 8),
    layout: { rAF: jitter(frames), painted: jitter(painted), bottomRAF: bottomJitter(frames), bottomPainted: bottomJitter(painted), viewportRAF: viewportTopJitter(frames), viewportPainted: viewportTopJitter(painted) },
    scroll: { writes: scrollWrites.length, writesPerFrame, scrollTopAssignments: nonPin, clientWidthChanges: widthChanges },
  };
}

export function verdicts(result, variant = {}) {
  const failures = [];
  const a = result.analysis;
  if (result.error) { failures.push(`error: ${result.error.split('\n')[0]}`); return failures; }
  const need = (cond, msg) => { if (!cond) failures.push(msg); };
  need(a.frames >= 30, `only ${a.frames} frames`);
  need(a.remounts.wrapper === 0 && a.remounts.event === 0 && a.remounts.text === 0, `streaming row remounted (${JSON.stringify(a.remounts)})`);
  need(a.remounts.near === 0, `neighbour rows remounted (${a.remounts.near})`);
  need(a.blankingFrames === 0, `${a.blankingFrames} blanking frames (text shrank / opacity 0 / hidden)`);
  const maxFlips = variant.maxFlips ?? 0;
  need(a.renderMode.rAF.flips <= maxFlips && a.renderMode.painted.flips <= maxFlips, `streaming bubble flipped raw<->Markdown ${a.renderMode.rAF.flips}x (rAF) / ${a.renderMode.painted.flips}x (painted), allowed ${maxFlips}`);
  if (variant.expectRaw) need(a.renderMode.rAF.rawFrames === a.frames - a.unmountedStreamFrames || a.renderMode.rAF.flips === 0, 'oversized message should be plain text throughout');
  else if (!variant.allowRawTail) need(a.renderMode.rAF.rawFrames === 0 && a.renderMode.painted.rawFrames === 0, `streaming bubble shown as raw text in ${a.renderMode.rAF.rawFrames} rAF / ${a.renderMode.painted.rawFrames} painted frames`);
  need(variant.allowRawTail || (a.height.rAF.dropFrames === 0 && a.height.painted.dropFrames === 0), `streaming bubble height shrank in ${a.height.rAF.dropFrames} rAF / ${a.height.painted.dropFrames} painted frames (max ${a.height.rAF.maxDropPx}px)`);
  need(a.animationStartsOnRows === 0, `${a.animationStartsOnRows} CSS animations/transitions started on chat rows`);
  need(a.layout.bottomRAF.maxBottomStepPx <= TOL && a.layout.bottomPainted.maxBottomStepPx <= TOL, `streaming row bottom moved ${a.layout.bottomRAF.maxBottomStepPx}px (rAF) / ${a.layout.bottomPainted.maxBottomStepPx}px (painted) on screen while pinned`);
  need(a.scroll.clientWidthChanges === 0, `viewport width changed ${a.scroll.clientWidthChanges}x (scrollbar toggling reflows the text)`);
  return failures;
}

async function runVariant(browser, viewport, variant) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.dpr, isMobile: viewport.mobile, hasTouch: viewport.mobile, reducedMotion: REDUCED ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const result = { label: variant.label, viewport: viewport.label, reducedMotion: REDUCED, rows: variant.rows };
  try {
    await page.goto(`${BASE_URL}/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&windows=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-chat-timeline-harness="ready"]', { timeout: 60_000 });
    await page.evaluate(installDriver, { rows: variant.rows, ...STREAM_FIXTURES });
    await page.evaluate(installFlickerProbe);
    await page.waitForSelector('.chat-view:not(.chat-view-preview) [data-virtual-key], .chat-view:not(.chat-view-preview) .chat-event', { timeout: 30_000 });
    await sleep(1500);
    await page.evaluate(({ pieceMode, seedChars, cadence }) => {
      const d = window.__scrollDriver;
      d.pieceMode = pieceMode;
      d.cadence = cadence ?? 'uniform';
      d.mdPos = 0;
      d.seedText = seedChars ? `${'A long single streamed message paragraph with several words in it. '.repeat(Math.ceil(seedChars / 64))}\n\n`.slice(0, seedChars) : '';
    }, { pieceMode: variant.pieceMode, seedChars: variant.seedChars ?? 0, cadence: variant.cadence });
    await page.evaluate(() => window.__scrollDriver.start(25));
    await sleep(1500);
    await page.evaluate(() => window.__flicker.begin());
    await sleep(STREAM_MS);
    const raw = await page.evaluate(() => window.__flicker.end());
    await page.evaluate(() => window.__scrollDriver.stop());
    result.analysis = analyze(raw);
  } catch (error) {
    result.error = String(error?.stack ?? error);
  } finally {
    await context.close();
  }
  result.failures = verdicts(result, variant);
  result.pass = result.failures.length === 0;
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const results = [];
  try {
    const only = (process.env.IMC_FLICKER_ONLY ?? '').split(',').filter(Boolean);
    for (const viewport of VIEWPORTS) {
      for (const variant of VARIANTS) {
        if (only.length && !only.includes(`${viewport.label}/${variant.label}`)) continue;
        results.push(await runVariant(browser, viewport, variant));
      }
    }
  } finally { await browser.close(); }
  writeFileSync(OUTPUT, JSON.stringify({ revision: process.env.GIT_HEAD ?? 'unknown', streamMs: STREAM_MS, cases: results }, null, 2));
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed += 1;
    const a = r.analysis;
    process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.viewport}/${r.label}${REDUCED ? '/reduced' : ''} ${a ? `frames=${a.frames} remounts=${JSON.stringify(a.remounts)} modeFlips=${a.renderMode.rAF.flips}/${a.renderMode.painted.flips} raw=${a.renderMode.rAF.rawFrames}/${a.renderMode.painted.rawFrames} heightDrops=${a.height.rAF.dropFrames}/${a.height.painted.dropFrames} blank=${a.blankingFrames} anims=${a.animationStartsOnRows} bottomStep=${a.layout.bottomRAF.maxBottomStepPx}/${a.layout.bottomPainted.maxBottomStepPx} scrollWrites/frame=${a.scroll.writesPerFrame} widthChg=${a.scroll.clientWidthChanges} streamMut=${JSON.stringify(a.mutations.stream)}` : ''} ${JSON.stringify(r.failures)}\n`);
  }
  process.stdout.write(`chat-stream-flicker: ${results.length - failed}/${results.length} passed -> ${OUTPUT}\n`);
  if (failed && !NO_FAIL) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
