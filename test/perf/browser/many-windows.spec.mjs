import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { TIMELINE_MESSAGES } from '../../../shared/timeline-protocol.ts';
import { planSubWindows, seedVisibility } from './sub-window-plan.mjs';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
import { buildWorkload } from './load-generator.mjs';
import { signPerfJwt } from './perf-auth.mjs';
import { aggregate, collectMetrics, installObservers } from './metrics.mjs';
import { installFlickerProbe, analyze as analyzeFlicker, verdicts as flickerVerdicts } from './chat-stream-flicker.spec.mjs';

const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_perf_harness_server';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'deck_perf_browser_key';
const JWT_SIGNING_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const durationMs = Number(process.env.IMC_PERF_DURATION_MS ?? 10_000);
const openTimeoutMs = Number(process.env.IMC_PERF_OPEN_TIMEOUT_MS ?? 120_000);
const windowOpenTimeoutMs = Number(process.env.IMC_PERF_WINDOW_TIMEOUT_MS ?? 90_000);

/**
 * Capture the real chat viewport while the daemon emits streaming deltas.
 * A pinned viewport may advance as rows grow, but it must never move
 * backwards or accumulate a visible gap from the bottom.  Keeping this probe
 * in the canonical browser harness makes the regression check run against
 * Chromium's actual layout/ResizeObserver ordering rather than a DOM mock.
 */
function analyzeScrollJitter(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { pass: false, samples: samples?.length ?? 0, maxBackwardPx: 0, maxBottomGapPx: 0, failure: 'insufficient samples' };
  }
  let maxBackwardPx = 0;
  let maxBottomGapPx = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    maxBackwardPx = Math.max(maxBackwardPx, previous.top - current.top);
    maxBottomGapPx = Math.max(maxBottomGapPx, current.bottomGap);
  }
  return {
    pass: maxBackwardPx <= 1 && maxBottomGapPx <= 1,
    samples: samples.length,
    maxBackwardPx,
    maxBottomGapPx,
  };
}

/**
 * Keypress -> paint latency in the focused composer (IMC_PERF_KEYPRESS=1).
 *
 * Real CDP key events are sent to the first visible composer textarea every
 * 300 ms. In the page, `keydown` (capture) records the event's own timestamp;
 * after the resulting `input` event two animation frames are awaited, so the
 * delay covers input queueing, the app's handlers/re-render and the paint.
 */
async function startKeypressProbe(page) {
  if (process.env.IMC_PERF_KEYPRESS !== '1' || !page) return null;
  const ready = await page.evaluate(() => {
    // The chat composer is a contenteditable role=textbox; a plain textarea is the fallback.
    const composer = [...document.querySelectorAll('[data-onboarding="chat-input"][contenteditable="true"], textarea')].find((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 50);
    if (!composer) return false;
    const probe = { delays: [], down: null };
    document.addEventListener('keydown', (event) => { probe.down = event.timeStamp; }, true);
    document.addEventListener('input', () => {
      const started = probe.down;
      probe.down = null;
      if (started == null) return;
      requestAnimationFrame(() => requestAnimationFrame(() => probe.delays.push(performance.now() - started)));
    }, true);
    composer.focus();
    window.__imcKeypressProbe = probe;
    return true;
  }).catch(() => false);
  if (!ready) return { ready: false, stop: async () => ({ samples: 0, error: 'no visible composer' }) };
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await Promise.race([page.keyboard.press('KeyA'), new Promise((resolve) => setTimeout(resolve, 2_000))]); } catch { /* the page may be busy */ }
    busy = false;
  }, 300);
  return {
    ready: true,
    stop: async () => {
      clearInterval(timer);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const delays = await page.evaluate(() => window.__imcKeypressProbe?.delays ?? []).catch(() => []);
      const sorted = [...delays].sort((a, b) => a - b);
      const q = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
      return { samples: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0 };
    },
  };
}

/**
 * Renderer CPU-seconds over a window (IMC_PERF_KEYPRESS=1 or IMC_PERF_CPU=1).
 *
 * Wall-clock "busy" (Performance TaskDuration) inflates when the container's CPU
 * quota is throttled or the host is loaded, so it cannot compare two builds on
 * a shared machine. CDP SystemInfo.getProcessInfo reports the CPU time each
 * browser process actually consumed; the delta over the window divided by wall
 * time is the renderer's real CPU load (in cores).
 */
async function startCpuProbe(context) {
  if (process.env.IMC_PERF_KEYPRESS !== '1' && process.env.IMC_PERF_CPU !== '1') return null;
  let session = null;
  try { session = await context.browser().newBrowserCDPSession(); } catch { return null; }
  const read = async () => {
    try {
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const byType = {};
      for (const info of processInfo) byType[info.type] = (byType[info.type] ?? 0) + info.cpuTime;
      return byType;
    } catch { return null; }
  };
  const before = await read();
  const startedAt = Date.now();
  return {
    stop: async () => {
      const after = await read();
      const wallSeconds = (Date.now() - startedAt) / 1000;
      await session.detach().catch(() => {});
      if (!before || !after) return { error: 'SystemInfo.getProcessInfo unavailable' };
      const delta = (type) => (after[type] ?? 0) - (before[type] ?? 0);
      return {
        wallSeconds,
        rendererCpuSeconds: delta('renderer'),
        rendererCores: delta('renderer') / wallSeconds,
        gpuCpuSeconds: delta('GPU'),
        browserCpuSeconds: delta('browser'),
      };
    },
  };
}

/**
 * How stale is what an on-screen sub-session card shows (IMC_PERF_CARD_LATENCY=1)?
 *
 * The fake daemon's streaming frames carry a unique `stream-<n>` text. An init
 * script (before the app loads) records when each such frame reaches the page
 * (WebSocket message) and a MutationObserver records when that text first
 * appears inside a `.subcard-preview`. latency = appearance - arrival, per
 * frame the card actually rendered (coalesced frames are not counted, so this
 * is the age of the content at the moment the card updates).
 */
/**
 * IMC_PERF_FLICKER=1: the streaming-flicker probe (chat-stream-flicker.spec.mjs)
 * on the REAL app path (server -> useTimeline -> ChatView), measuring the first
 * on-screen chat window that shows a streaming reply. Use with
 * IMC_PERF_STREAM_MODE=growing so the fake daemon streams like the real one
 * (one eventId per message, cumulative text).
 */
async function startFlickerProbe(page) {
  if (process.env.IMC_PERF_FLICKER !== '1') return null;
  await page.evaluate(installFlickerProbe);
  await page.evaluate(() => {
    let chosen = null;
    window.__flickerRoot = () => {
      if (chosen?.isConnected) return chosen;
      chosen = [...document.querySelectorAll('.chat-view:not(.chat-view-preview)')].find((el) => el.getClientRects().length > 0 && el.textContent.includes('stream-')) ?? null;
      return chosen;
    };
    // The fake daemon's markdown content opens every message with 'stream-msg-N': the streaming message is identified by
    // that marker, and its row is whatever row currently shows it (merged blocks hold several messages).
    const markerRe = /stream-msg-\d+(?!\d)/g;
    window.__flickerStreamKey = () => {
      const root = window.__flickerRoot();
      if (!root) return null;
      const all = (root.textContent ?? '').match(markerRe);
      return all?.at(-1) ?? null;
    };
    window.__flickerAllKeys = () => {
      const root = window.__flickerRoot();
      return root ? [...new Set((root.textContent ?? '').match(markerRe) ?? [])] : [];
    };
    window.__flickerFindRow = (key) => {
      const root = window.__flickerRoot();
      if (!root) return null;
      const re = new RegExp(`${key}(?!\\d)`);
      return [...root.querySelectorAll('.chat-assistant[data-event-id]')].find((el) => re.test(el.textContent ?? '')) ?? null;
    };
  });
  await page.evaluate(() => window.__flicker.begin());
  return {
    async stop() {
      const raw = await page.evaluate(() => window.__flicker.end());
      const analysis = analyzeFlicker(raw);
      return { analysis, failures: flickerVerdicts({ analysis }) };
    },
  };
}

async function installCardLatencyProbe(context) {
  if (process.env.IMC_PERF_CARD_LATENCY !== '1') return;
  await context.addInitScript(() => {
    const arrivals = new Map();
    const latencies = [];
    const seen = new Set();
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string' || !event.data.includes('stream-')) return;
          const now = performance.now();
          for (const match of event.data.matchAll(/stream-(\d+)/g)) if (!arrivals.has(match[1])) arrivals.set(match[1], now);
        });
      }
    };
    const inspect = (node) => {
      const text = node.nodeType === 3 ? node.nodeValue : node.textContent;
      if (!text || !text.includes('stream-')) return;
      const element = node.nodeType === 3 ? node.parentElement : node;
      if (!element?.closest?.('.subcard-preview')) return;
      const now = performance.now();
      for (const match of text.matchAll(/stream-(\d+)/g)) {
        const id = match[1];
        if (seen.has(id) || !arrivals.has(id)) continue;
        seen.add(id);
        latencies.push(now - arrivals.get(id));
      }
    };
    const start = () => new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') inspect(record.target);
        for (const added of record.addedNodes) inspect(added);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    window.__imcCardLatency = () => {
      const sorted = [...latencies].sort((a, b) => a - b);
      const q = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
      return { samples: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0 };
    };
  });
}

async function startScrollJitterProbe(page) {
  if (process.env.IMC_PERF_SCROLL_JITTER !== '1' || !page) return false;
  return page.evaluate(() => {
    const root = document.querySelector('.chat-view');
    if (!root) return false;
    const state = { active: true, samples: [] };
    const sample = () => {
      if (!state.active) return;
      state.samples.push({
        t: performance.now(),
        top: root.scrollTop,
        bottomGap: Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop),
      });
      requestAnimationFrame(sample);
    };
    window.__imcScrollJitter = state;
    requestAnimationFrame(sample);
    return true;
  }).catch(() => false);
}

async function stopScrollJitterProbe(page) {
  if (process.env.IMC_PERF_SCROLL_JITTER !== '1' || !page) return null;
  const samples = await page.evaluate(() => {
    const state = window.__imcScrollJitter;
    if (!state) return [];
    state.active = false;
    return state.samples;
  }).catch(() => []);
  return analyzeScrollJitter(samples);
}

function perfJwt() {
  return signPerfJwt(JWT_SIGNING_KEY);
}


async function collectWindowDiagnostics(page) {
  return page.evaluate(() => {
    const globals = Object.keys(window).filter((key) => /event|timeline|cache|listener|timer|session/i.test(key));
    const body = document.body;
    return {
      domNodes: document.querySelectorAll('*').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? 0,
      globalDiagnosticKeys: globals.slice(0, 100),
      globalDiagnosticKeyCount: globals.length,
      textLength: body?.innerText?.length ?? 0,
    };
  }).catch(() => ({ domNodes: 0, heapBytes: 0, globalDiagnosticKeys: [], globalDiagnosticKeyCount: 0, textLength: 0 }));
}

/**
 * Exercise the real resize hit surfaces, not just their DOM existence.  The
 * handles sit over the composer/footer and task-panel overlays in production,
 * so elementsFromPoint plus a real mouse drag is the only useful regression
 * check for this contract.
 */
async function checkResizeHandles(page, outputDir) {
  const directions = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
  const topWindowBox = () => page.locator('.subsession-window:visible').evaluateAll((items) => {
    const visible = items.map((element, index) => ({ element, index, rect: element.getBoundingClientRect(), z: Number.parseInt(getComputedStyle(element).zIndex, 10) || 0 }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      // Equal-z windows are painted in DOM order; pick the last one so the
      // hit-test assertion follows the browser's actual topmost window.
      .sort((a, b) => (b.z - a.z) || (b.index - a.index));
    const item = visible[0];
    return item ? { x: item.rect.x, y: item.rect.y, width: item.rect.width, height: item.rect.height } : null;
  });
  const before = await topWindowBox();
  if (!before) return { pass: false, failures: ['no visible sub-session window'], hitTests: [], drags: [] };
  const hitTests = await page.evaluate((rect) => {
    const points = {
      nw: [rect.left + 8, rect.top + 8], n: [rect.left + rect.width / 2, rect.top + 3],
      ne: [rect.right - 8, rect.top + 8], w: [rect.left + 3, rect.top + rect.height / 2],
      e: [rect.right - 3, rect.top + rect.height / 2], sw: [rect.left + 8, rect.bottom - 8],
      s: [rect.left + rect.width / 2, rect.bottom - 3], se: [rect.right - 8, rect.bottom - 8],
    };
    return Object.entries(points).map(([dir, [x, y]]) => ({
      dir, x, y,
      stack: document.elementsFromPoint(x, y).slice(0, 5).map((el) => ({
        tag: el.tagName, className: typeof el.className === 'string' ? el.className : '',
        testId: el.getAttribute('data-testid'),
      })),
    }));
  }, { left: before.x, top: before.y, right: before.x + before.width, bottom: before.y + before.height, width: before.width, height: before.height });
  const failures = hitTests.filter((entry) => !entry.stack.some((item) => item.className.split?.(/\s+/).includes(`resize-${entry.dir}`)))
    .map((entry) => `hit-test ${entry.dir} top=${JSON.stringify(entry.stack[0] ?? null)}`);
  const output = outputDir ?? '/tmp';
  await page.screenshot({ path: `${output}/resize-handles-before.png`, animations: 'disabled' }).catch(() => {});
  const drags = [];
  const delta = { nw: [-8, -8], n: [0, 8], ne: [8, -8], w: [-8, 0], e: [8, 0], sw: [-8, 8], s: [0, -8], se: [-8, -8] };
  for (const dir of directions) {
    const box = await topWindowBox();
    if (!box) { failures.push(`drag ${dir} window disappeared`); break; }
    const [dx, dy] = delta[dir];
    const point = {
      nw: [box.x + 8, box.y + 8], n: [box.x + box.width / 2, box.y + 3], ne: [box.x + box.width - 8, box.y + 8],
      w: [box.x + 3, box.y + box.height / 2], e: [box.x + box.width - 3, box.y + box.height / 2],
      sw: [box.x + 8, box.y + box.height - 8], s: [box.x + box.width / 2, box.y + box.height - 3], se: [box.x + box.width - 8, box.y + box.height - 8],
    }[dir];
    await page.mouse.move(point[0], point[1]);
    await page.mouse.down();
    await page.mouse.move(point[0] + dx, point[1] + dy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    const after = await topWindowBox();
    const changed = !!after && (Math.abs(after.width - box.width) > 0.5 || Math.abs(after.height - box.height) > 0.5 || Math.abs(after.x - box.x) > 0.5 || Math.abs(after.y - box.y) > 0.5);
    drags.push({ dir, before: { x: box.x, y: box.y, width: box.width, height: box.height }, after: after && { x: after.x, y: after.y, width: after.width, height: after.height }, changed });
    if (!changed) failures.push(`drag ${dir} did not change geometry`);
  }
  await page.screenshot({ path: `${output}/resize-handles-after.png`, animations: 'disabled' }).catch(() => {});
  return { pass: failures.length === 0, failures, hitTests, drags };
}


async function persistCheckpoint(payload) {
  const file = process.env.IMC_PERF_CHECKPOINT;
  if (!file) return;
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), ...payload }) + '\n');
  } catch { /* best effort while a browser is wedged */ }
}

async function captureHeapSnapshot(page, label) {
  const dir = process.env.IMC_PERF_SNAPSHOT_DIR ?? '/repo/perf-results/snapshots';
  try {
    const { mkdir, createWriteStream } = await import('node:fs');
    await new Promise((resolve, reject) => mkdir(dir, { recursive: true }, (error) => error && error.code !== 'EEXIST' ? reject(error) : resolve()));
    const file = `${dir}/${label}.heapsnapshot`;
    const cdp = await page.context().newCDPSession(page);
    const stream = createWriteStream(file);
    let bytes = 0;
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => { bytes += Buffer.byteLength(chunk); stream.write(chunk); });
    await Promise.race([cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }), new Promise((_, reject) => setTimeout(() => reject(new Error('heap-snapshot-timeout')), 60_000))]);
    await new Promise((resolve) => stream.end(resolve));
    await cdp.detach().catch(() => {});
    return { file, bytes };
  } catch (error) {
    return { file: null, bytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function openRealSession(context, session, { manualProtocol = session.index === 0, historyLimit = 200 } = {}) {
  process.stdout.write(`open ${session.id}\n`);
  const page = await context.newPage();
  const evaluateBounded = (fn, arg, timeoutMs, label) => Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
  ]);
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(15_000);
  const diagnostics = { console: [], failedRequests: [], crashed: false };
  page.on('crash', () => { diagnostics.crashed = true; session.__diagnostics = diagnostics; });
  session.__page = page;
  session.__diagnostics = diagnostics;
  page.on('console', (message) => {
    if (diagnostics.console.length < 100) diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 500) });
  });
  page.on('requestfailed', (request) => {
    if (diagnostics.failedRequests.length < 100) diagnostics.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? 'unknown' });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && diagnostics.failedRequests.length < 100) {
      diagnostics.failedRequests.push({ url: response.url(), status: response.status(), error: `HTTP ${response.status()}` });
    }
  });
  await installObservers(page);
  diagnostics.phase = 'observers-installed';
  const mode = session.index < 10 ? 'full' : 'summary';
  const ws = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, byModeType: {}, seqGaps: [], historyTimings: [], pendingHistory: {}, byMode: { [mode]: 0 }, sessionModes: {}, finalSessions: {}, mode, expectedHiddenFullBytes: 0, hiddenSummaryBytes: 0 };
  const record = (payload, direction, requestId = 'unknown') => {
    const bytes = Buffer.byteLength(payload, 'utf8');
    ws[direction === 'sent' ? 'sent' : 'received'] += 1;
    ws[direction === 'sent' ? 'bytesSent' : 'bytesReceived'] += bytes;
    try {
      const msg = JSON.parse(payload);
      if (direction === 'sent' && msg.type === TIMELINE_MESSAGES.SUBSCRIBE && msg.sessionName) {
        ws.sessionModes[msg.sessionName] = msg.mode === 'summary' ? 'summary' : 'full';
        if (msg.sessionName === session.name) ws.mode = ws.sessionModes[msg.sessionName];
      }
      const type = msg.event?.type ?? msg.type ?? 'unknown';
      if (direction === 'received') {
        const eventSession = msg.sessionId ?? msg.event?.sessionId ?? msg.event?.payload?.sessionId;
        const eventMode = eventSession && ws.sessionModes[eventSession] ? ws.sessionModes[eventSession] : ws.mode;
        ws.byMode[eventMode] = (ws.byMode[eventMode] ?? 0) + bytes;
        const modeTypes = ws.byModeType[eventMode] ??= {};
        modeTypes[type] = (modeTypes[type] ?? 0) + bytes;
        if (eventMode === 'summary') ws.hiddenSummaryBytes += bytes;
        if (type === 'assistant.text' && msg.event?.payload?.streaming === false) ws.finalSessions[eventSession ?? 'unknown'] = true;
      }
      if (direction === 'sent' && (msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST || msg.type === TIMELINE_MESSAGES.PAGE_REQUEST || msg.type === TIMELINE_MESSAGES.REPLAY_REQUEST) && msg.requestId) {
        ws.pendingHistory[msg.requestId] = { requestId: msg.requestId, type: msg.type, sentAt: Date.now(), epoch: msg.epoch ?? msg.cursor?.epoch ?? null, afterSeq: msg.afterSeq ?? msg.cursor?.afterSeq ?? null };
      }
      if (direction === 'received' && (msg.type === TIMELINE_MESSAGES.HISTORY || msg.type === TIMELINE_MESSAGES.PAGE || msg.type === TIMELINE_MESSAGES.REPLAY) && msg.requestId) {
        const pending = ws.pendingHistory[msg.requestId];
        if (pending) { ws.historyTimings.push({ ...pending, receivedAt: Date.now(), durationMs: Date.now() - pending.sentAt, bytes }); delete ws.pendingHistory[msg.requestId]; }
      }
      ws.byType[type] = (ws.byType[type] ?? 0) + bytes;
      ws.framesByType[type] = (ws.framesByType[type] ?? 0) + 1;
      const socket = ws.sockets[requestId] ??= { requestId, mode: ws.mode, sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, bufferedAmount: 0 };
      if (direction === 'sent' && msg.type === TIMELINE_MESSAGES.SUBSCRIBE && msg.sessionName) socket.mode = ws.sessionModes[msg.sessionName] ?? ws.mode;
      socket[direction === 'sent' ? 'sent' : 'received'] += 1;
      socket[direction === 'sent' ? 'bytesSent' : 'bytesReceived'] += bytes;
      socket.byType[type] = (socket.byType[type] ?? 0) + bytes;
      if (direction === 'received' && type === TIMELINE_MESSAGES.SEQ_GAP && ws.seqGaps.length < 20) {
        ws.seqGaps.push({ epoch: msg.epoch, fromSeq: msg.fromSeq, toSeq: msg.toSeq, reason: msg.reason, sessionId: msg.sessionId });
      }
    } catch { ws.byType.unknown = (ws.byType.unknown ?? 0) + bytes; }
  };
  ws.sockets = {};
  const cdpWithTimeout = async (promise, label, timeoutMs = 2_000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
  ]);
  let cdp = null;
  diagnostics.phase = 'cdp-connecting';
  // IMC_PERF_LEAN=1: no per-page CDP session. The 1 ms CPU profiler, Performance
  // sampling and Network.webSocketFrame* capture are themselves a large constant
  // load on the renderer (an observer effect that hides differences between
  // builds); lean runs keep only the renderer-CPU and keypress probes.
  if (process.env.IMC_PERF_LEAN !== '1') {
    try { cdp = await cdpWithTimeout(context.newCDPSession(page), 'newCDPSession'); } catch (error) {
      session.__cdpError = error instanceof Error ? error.message : String(error);
    }
  } else session.__cdpError = 'disabled (IMC_PERF_LEAN=1)';
  diagnostics.phase = cdp ? 'cdp-connected' : 'cdp-unavailable';
  const networkLog = [];
  const traceChunks = [];
  let traceStopped = false;
  let traceCompleteResolve;
  let traceStream = null;
  let profilerStarted = false;
  const performanceSamples = [];
  let performanceTimer = null;
  const traceComplete = new Promise((resolve) => { traceCompleteResolve = resolve; });
  if (cdp) {
    cdp.on('Network.requestWillBeSent', (event) => networkLog.push({ kind: 'request', requestId: event.requestId, url: event.request.url, type: event.type, ts: event.timestamp }));
    cdp.on('Network.responseReceived', (event) => networkLog.push({ kind: 'response', requestId: event.requestId, url: event.response.url, type: event.type, status: event.response.status, ts: event.timestamp, encodedDataLength: event.response.encodedDataLength }));
    cdp.on('Network.loadingFinished', (event) => networkLog.push({ kind: 'finished', requestId: event.requestId, ts: event.timestamp, encodedDataLength: event.encodedDataLength }));
    cdp.on('Network.loadingFailed', (event) => networkLog.push({ kind: 'failed', requestId: event.requestId, ts: event.timestamp, errorText: event.errorText }));
    cdp.on('Network.webSocketFrameReceived', ({ response, requestId }) => networkLog.push({ kind: 'ws-received', requestId, ts: Date.now(), payloadLength: Buffer.byteLength(response.payloadData, 'utf8'), type: (() => { try { return JSON.parse(response.payloadData)?.type ?? 'unknown'; } catch { return 'unknown'; } })() }));
    cdp.on('Network.webSocketFrameSent', ({ response, requestId }) => networkLog.push({ kind: 'ws-sent', requestId, ts: Date.now(), payloadLength: Buffer.byteLength(response.payloadData, 'utf8'), type: (() => { try { return JSON.parse(response.payloadData)?.type ?? 'unknown'; } catch { return 'unknown'; } })() }));
    cdp.on('Tracing.dataCollected', ({ value }) => traceChunks.push(...value));
    cdp.on('Tracing.tracingComplete', ({ stream }) => { traceStream = stream ?? null; traceCompleteResolve?.(); });
    try { await cdpWithTimeout(cdp.send('Network.enable'), 'Network.enable'); } catch (error) { session.__cdpError = error instanceof Error ? error.message : String(error); }
    try {
      await cdpWithTimeout(cdp.send('Performance.enable'), 'Performance.enable');
      const sample = async () => {
        try {
          const { metrics } = await cdpWithTimeout(cdp.send('Performance.getMetrics'), 'Performance.getMetrics', 1_000);
          const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
          performanceSamples.push({ at: Date.now(), ...values });
          if (performanceSamples.length > 1_200) performanceSamples.shift();
        } catch {}
      };
      await sample();
      performanceTimer = setInterval(sample, 500);
    } catch (error) { session.__diagnostics.performanceError = error instanceof Error ? error.message : String(error); }
    try {
      await cdpWithTimeout(cdp.send('Profiler.enable'), 'Profiler.enable');
      await cdpWithTimeout(cdp.send('Profiler.setSamplingInterval', { interval: 1_000 }), 'Profiler.setSamplingInterval');
      await cdpWithTimeout(cdp.send('Profiler.start'), 'Profiler.start');
      profilerStarted = true;
    } catch (error) { session.__profilerError = error instanceof Error ? error.message : String(error); }
    // ReportEvents keeps trace records on the CDP event stream. ReturnAsStream
    // is not emitted reliably by the headless shell used on 211; the stream
    // reader below remains as a fallback for Chromium versions that do emit it.
    // IMC_PERF_NO_TRACING=1: profile with the V8 sampler only (tracing at 10 kHz is itself a CPU load).
    if (process.env.IMC_PERF_NO_TRACING === '1') session.__traceError = 'disabled (IMC_PERF_NO_TRACING=1)';
    else try { await cdpWithTimeout(cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink,disabled-by-default-v8.cpu_profiler', options: 'sampling-frequency=10000', transferMode: 'ReportEvents' }), 'Tracing.start'); } catch (error) { session.__traceError = error instanceof Error ? error.message : String(error); }
  }
  if (session.__cdpError) session.__diagnostics.cdpError = session.__cdpError;
  if (session.__traceError) session.__diagnostics.traceError = session.__traceError;
  if (session.__profilerError) session.__diagnostics.profilerError = session.__profilerError;
  session.__diagnostics.phase = 'before-goto';
  session.__stopDiagnostics = async () => {
    if (traceStopped) return { networkLog, tracePath: session.__tracePath ?? null };
    traceStopped = true;
    if (performanceTimer) clearInterval(performanceTimer);
    let profileResult = null;
    if (cdp && profilerStarted) {
      try { profileResult = await cdpWithTimeout(cdp.send('Profiler.stop'), 'Profiler.stop', 5_000); }
      catch (error) { session.__diagnostics.profilerStopError = error instanceof Error ? error.message : String(error); }
    }
    if (cdp && !session.__traceError) { try { await cdpWithTimeout(cdp.send('Tracing.end'), 'Tracing.end', 8_000); } catch {} }
    await Promise.race([traceComplete, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    let tracePath = null;
    let profilePath = null;
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dir = process.env.IMC_PERF_TRACE_DIR ?? '/repo/perf-results/traces';
      await mkdir(dir, { recursive: true });
      tracePath = `${dir}/${session.id}.trace.json`;
      let tracePayload = null;
      if (traceStream) {
        let data = '';
        let eof = false;
        while (!eof && data.length < 100_000_000) {
          const chunk = await cdpWithTimeout(cdp.send('IO.read', { handle: traceStream }), 'IO.read', 2_000);
          data += chunk.data ?? '';
          eof = Boolean(chunk.eof);
        }
        try { await cdpWithTimeout(cdp.send('IO.close', { handle: traceStream }), 'IO.close', 2_000); } catch {}
        tracePayload = data;
      }
      await writeFile(tracePath, tracePayload ?? JSON.stringify({ traceEvents: traceChunks }));
      session.__tracePath = tracePath;
      if (profileResult) {
        profilePath = `${dir}/${session.id}.profile.json`;
        await writeFile(profilePath, JSON.stringify(profileResult));
        session.__profilePath = profilePath;
      }
    } catch {}
    const performanceDeltas = [];
    for (let i = 1; i < performanceSamples.length; i += 1) {
      const prev = performanceSamples[i - 1]; const cur = performanceSamples[i];
      const seconds = Math.max(0.001, (cur.at - prev.at) / 1000);
      performanceDeltas.push({ at: cur.at, seconds, TaskDurationPerSecond: ((cur.TaskDuration ?? 0) - (prev.TaskDuration ?? 0)) / seconds, ScriptDurationPerSecond: ((cur.ScriptDuration ?? 0) - (prev.ScriptDuration ?? 0)) / seconds, LayoutDurationPerSecond: ((cur.LayoutDuration ?? 0) - (prev.LayoutDuration ?? 0)) / seconds, RecalcStyleDurationPerSecond: ((cur.RecalcStyleDuration ?? 0) - (prev.RecalcStyleDuration ?? 0)) / seconds, LayoutCountPerSecond: ((cur.LayoutCount ?? 0) - (prev.LayoutCount ?? 0)) / seconds, RecalcStyleCountPerSecond: ((cur.RecalcStyleCount ?? 0) - (prev.RecalcStyleCount ?? 0)) / seconds });
    }
    return { networkLog: [...networkLog], tracePath, profilePath, performanceSamples: [...performanceSamples], performanceDeltas };
  };

  if (cdp) {
    cdp.on('Network.webSocketFrameReceived', ({ response, requestId }) => record(response.payloadData, 'received', requestId));
    cdp.on('Network.webSocketFrameSent', ({ response, requestId }) => record(response.payloadData, 'sent', requestId));
  }
  session.__diagnostics.phase = 'goto';
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(session.name)}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  session.__diagnostics.phase = 'domcontentloaded';
  await page.waitForSelector('#app', { timeout: 10_000 });
  session.__diagnostics.phase = 'app-mounted';
  await page.waitForTimeout(500);
  session.__diagnostics.phase = 'initial-settle';
  const readiness = await Promise.race([
    page.evaluate(() => ({
      app: Boolean(document.querySelector('#app')),
      sessionPane: Boolean(document.querySelector('[data-session-id], .session-view, .chat-pane, main')),
      textLength: document.body?.innerText?.length ?? 0,
    })),
    new Promise((resolve) => setTimeout(() => resolve({ app: true, sessionPane: false, textLength: 0, timedOut: true }), 2_000)),
  ]);
  session.__diagnostics.readiness = readiness;
  session.__diagnostics.phase = 'route-evaluate';
  await evaluateBounded((hash) => { if (window.location.hash !== hash) window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); }, `#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(session.name)}`, 2_000, 'route evaluate');
  if (manualProtocol) { session.__diagnostics.phase = 'manual-protocol'; await Promise.race([page.evaluate(async ({ serverId, sessionName, mode, messages, historyLimit }) => {
    const csrf = document.cookie.match(/(?:^|; )rcc_csrf=([^;]+)/)?.[1];
    let ticketResponse;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      ticketResponse = await fetch('/api/auth/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) }, body: JSON.stringify({ serverId }) });
      if (ticketResponse.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!ticketResponse?.ok) throw new Error(`ws-ticket ${ticketResponse?.status ?? 'unavailable'}`);
    const { ticket } = await ticketResponse.json();
    if (!ticket) throw new Error('ws-ticket missing token');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/server/${encodeURIComponent(serverId)}/ws?ticket=${encodeURIComponent(ticket)}`);
    window.__perfSocket = socket;
    socket.addEventListener('error', () => { window.__perfSocketError = 'websocket_error'; });
    socket.addEventListener('close', (event) => { window.__perfSocketError = `websocket_close_${event.code}`; });
    window.__perfServerDebug = [];
    socket.addEventListener('message', (event) => {
      window.__perfSocketMessages = (window.__perfSocketMessages ?? 0) + 1;
      try {
        const parsed = JSON.parse(event.data);
        window.__perfSocketLastType = parsed?.type ?? null;
        if (parsed?.type === 'perf.debug.timeline_metrics') window.__perfServerDebug.push(parsed);
      } catch { /* metrics use CDP frames */ }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser websocket open timeout')), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        socket.send(JSON.stringify({ type: messages.SUBSCRIBE, sessionName, mode }));
        // Request the authoritative timeline immediately. This exercises the
        // real server backfill path and lets the browser verify that reveals
        // converge without relying on a fabricated client-side history.
        socket.send(JSON.stringify({ type: messages.HISTORY_REQUEST, sessionName, requestId: `perf-${sessionName}`, afterSeq: 0, limit: historyLimit }));
        socket.send(JSON.stringify({ type: 'perf.debug.timeline_metrics', requestId: `perf-debug-${sessionName}-initial` }));
        window.__perfDebugTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'perf.debug.timeline_metrics', requestId: `perf-debug-${sessionName}-${Date.now()}` }));
        }, 1_000);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        // Browsers intentionally redact the HTTP upgrade reason from the
        // ErrorEvent; let close deliver its code before reporting it.
        setTimeout(() => reject(new Error(`browser websocket error (readyState=${socket.readyState})`)), 50);
      }, { once: true });
      socket.addEventListener('close', (event) => { clearTimeout(timer); reject(new Error(`browser websocket closed (${event.code})`)); }, { once: true });
      });
      window.__perfBufferedSamples = [];
      window.__perfBufferedTimer = setInterval(() => window.__perfBufferedSamples.push(socket.bufferedAmount), 100);
  }, { serverId: SERVER_ID, sessionName: session.name, mode, messages: { SUBSCRIBE: TIMELINE_MESSAGES.SUBSCRIBE, HISTORY_REQUEST: TIMELINE_MESSAGES.HISTORY_REQUEST }, historyLimit }), new Promise((_, reject) => setTimeout(() => reject(new Error('manual protocol timeout')), 8_000))]); }
  // Auth initialization is asynchronous in the real SPA. Re-apply the URL
  // route after its /me request settles so the app performs its own session
  // inventory request rather than leaving the initial empty route selected.
  await page.waitForTimeout(500);
  session.__diagnostics.phase = 'auth-settled';
  await evaluateBounded((hash) => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); }, `#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(session.name)}`, 2_000, 'route settle evaluate');
  await page.waitForTimeout(500);
  session.__diagnostics.phase = 'route-settled';
  if (manualProtocol) {
    const socketState = await page.evaluate(() => ({ error: window.__perfSocketError ?? null, readyState: window.__perfSocket?.readyState ?? -1, messages: window.__perfSocketMessages ?? 0, lastType: window.__perfSocketLastType ?? null }));
    if (socketState.error || socketState.readyState !== 1) throw new Error(`real browser socket did not stay open: ${JSON.stringify(socketState)}`);
  }
  process.stdout.write(`mounted ${session.id}\n`);
  page.__perfWs = ws;
  return page;
}

async function runSinglePageScenario(context, workload, { windowCurve, stallDiagnostics, correctness, pageBySession }) {
  const main = workload.sessions[0];
  if (!main) throw new Error('single-page scenario requires a main session');
  let page;
  try {
    page = await Promise.race([
      // The real SPA owns its socket/subscription lifecycle in the primary
      // scenario. A second page.evaluate-driven socket would itself block on
      // a saturated renderer and distort the measurement.
      openRealSession(context, main, { manualProtocol: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('main-page-open-timeout')), openTimeoutMs)),
    ]);
    pageBySession.set(main.id, page);
    // The spec only SEEDS (and the fake daemon only serves) `sessions - 1` sub
    // sessions; see sub-window-plan.mjs for why a run may not wait for more.
    const seededMinimized = process.env.IMC_PERF_SEED_MINIMIZED !== '0';
    const subPlan = planSubWindows({ sessions: workload.sessions.length, subWindowsEnv: process.env.IMC_PERF_SUB_WINDOWS, seedMinimized: seededMinimized });
    const totalSubWindows = subPlan.total;
    const seededHidden = process.env.IMC_PERF_SEED_MINIMIZED !== '0' && process.env.IMC_PERF_LAYOUT !== 'tabs' && process.env.IMC_PERF_VARIANT !== 'all-hidden';
    // Exactly the visible windows the seed installed (0 is a valid target).
    const targetWindows = seededHidden ? subPlan.target : totalSubWindows;
    const started = Date.now();
    let seen = 0;
    const boundedStep = (promise, label, timeoutMs = 2_000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
    ]);
    process.stdout.write(`${JSON.stringify({ phase: 'opening-single-page', mounted: seen, target: targetWindows })}\n`);
    while (Date.now() - started < windowOpenTimeoutMs && seen < targetWindows) {
      let state = { domNodes: 0, heapBytes: 0, globalDiagnosticKeys: [], globalDiagnosticKeyCount: 0, textLength: 0 };
      let count = 0;
      let visible = 0;
      try { state = await boundedStep(collectWindowDiagnostics(page), 'window diagnostics'); } catch (error) { correctness.failures.push(`window diagnostics stalled: ${error.message}`); break; }
      try { count = await boundedStep(page.locator('.subsession-window').count(), 'window count'); } catch (error) { correctness.failures.push(`window count stalled: ${error.message}`); break; }
      try { visible = await boundedStep(page.locator('.subsession-window').evaluateAll((items) => items.filter((item) => getComputedStyle(item).display !== 'none').length), 'visible window count'); } catch {}
      if (count > seen) {
        seen = count;
        process.stdout.write(`${JSON.stringify({ phase: 'window-mounted', mounted: seen, target: targetWindows })}\n`);
        windowCurve.push({ index: seen, sessionId: main.name, subWindows: count, visibleSubWindows: visible, ...state });
        if (seen === 5 || seen === 10) windowCurve.at(-1).heapSnapshot = await captureHeapSnapshot(page, `single-page-windows-${seen}`);
        await persistCheckpoint({ status: 'opening-single-page', windowCurve, stallDiagnostics, correctness });
      }
      if (seen >= targetWindows) break;
      await pageWait(250);
    }
    if (seen < targetWindows) {
      if (main.__diagnostics?.crashed) correctness.failures.push(`renderer crashed at ${main.__diagnostics.phase ?? 'unknown phase'}`);
      correctness.failures.push(`single-page sub-window stall ${seen}/${targetWindows}`);
      correctness.restored = false;
      const stallState = await Promise.race([
        page.evaluate(() => ({
          readyState: document.readyState,
          url: location.href,
          bodyText: document.body?.innerText?.slice(0, 2_000) ?? '',
          subWindows: document.querySelectorAll('.subsession-window').length,
          retained: document.querySelectorAll('[data-subsession-retained]').length,
          localStorageKeys: Object.keys(localStorage).filter((key) => key.startsWith('rcc_open_subs_')),
          openSubState: (() => { const key = Object.keys(localStorage).find((item) => item.startsWith('rcc_open_subs_')); return key ? localStorage.getItem(key) : null; })(),
        })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 2_000)),
      ]).catch(() => ({ evaluateFailed: true }));
      // Stop the CPU profiler NOW (bounded) so a stalled run still leaves a
      // profile of what the renderer was doing, and record what the page's
      // own state says about the sub-window it never opened.
      const stallProfile = await Promise.race([
        (main.__stopDiagnostics?.() ?? Promise.resolve(null)).then((result) => ({ profilePath: result?.profilePath ?? null, tracePath: result?.tracePath ?? null })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 30_000)),
      ]).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      const stallDom = await Promise.race([
        page.evaluate(() => ({
          storage: Object.fromEntries(Object.keys(localStorage).filter((key) => /^rcc_(open_subs|subcard|session|server)/.test(key)).map((key) => [key, localStorage.getItem(key)?.slice(0, 400)])),
          subClassCounts: Object.fromEntries(['.subsession-window', '.subsession-card', '.sub-session-card', '[data-subsession-retained]', '.chat-view', '.session-pane'].map((selector) => [selector, document.querySelectorAll(selector).length])),
          innerWidth: window.innerWidth, innerHeight: window.innerHeight, maxTouchPoints: navigator.maxTouchPoints, userAgent: navigator.userAgent,
        })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 3_000)),
      ]).catch(() => ({ evaluateFailed: true }));
      stallDiagnostics.push({ sessionId: main.id, phase: 'single-page-window-open', stalledAt: seen, state: stallState, stallProfile, stallDom, ...(main.__diagnostics ?? {}) });
      await persistCheckpoint({ status: 'stalled-single-page', stalledAt: seen, windowCurve, stallDiagnostics, correctness });
    }
    if (seen > 0) {
      const resizeCheck = await checkResizeHandles(page, process.env.IMC_PERF_OUTPUT).catch((error) => ({ pass: false, failures: [`resize harness error: ${error instanceof Error ? error.message : String(error)}`], hitTests: [], drags: [] }));
      correctness.resizeHandles = resizeCheck.pass;
      stallDiagnostics.push({ sessionId: main.name, phase: 'resize-handles', ...resizeCheck });
      for (const failure of resizeCheck.failures) correctness.failures.push(failure);
      await persistCheckpoint({ status: 'resize-handles-checked', windowCurve, stallDiagnostics, correctness });
      process.stdout.write(`${JSON.stringify({ phase: 'resize-handles', ...resizeCheck })}\n`);
    }
    // Minimize ten mounted sub-windows through the same close/hide controls a
    // user operates. This exercises summary subscriptions rather than merely
    // marking localStorage ids as hidden.
    const hiddenTarget = process.env.IMC_PERF_VARIANT === 'all-hidden' ? totalSubWindows : Math.min(10, totalSubWindows);
    const mountedWindows = page.locator('.subsession-window:visible');
    const uiHideCount = seededHidden ? 0 : Math.min(hiddenTarget, seen);
    for (let index = 0; index < uiHideCount; index += 1) {
      // Select the current front visible window. Desktop commands intentionally
      // require a focus click followed by the command click when inactive.
      const hide = mountedWindows.first().locator('.subsession-close-btn');
      await boundedStep(hide.click({ timeout: 1_500, force: true }), 'hide click', 2_500).catch(() => {});
      await pageWait(500);
      await boundedStep(hide.click({ timeout: 1_500, force: true }), 'hide confirm click', 2_500).catch(() => {});
      await pageWait(500);
    }
    if (hiddenTarget) await pageWait(1_000);
    const visibleAfterHide = await boundedStep(page.locator('.subsession-window:visible').count(), 'visible count after hide', 2_000).catch(() => seen);
    const modeAfterHide = { ...(page.__perfWs?.sessionModes ?? {}) };
    const hiddenModeDiagnostics = { hiddenTarget, visibleAfterHide, modeAfterHide };
    const sdkModes = Object.entries(modeAfterHide).filter(([name]) => name.startsWith('deck_sub_')).map(([, mode]) => mode);
    const hiddenModes = sdkModes;
    const expectedSummary = hiddenTarget;
    const expectedFull = Math.max(0, totalSubWindows - hiddenTarget);
    if (hiddenTarget && hiddenModes.filter((mode) => mode === 'summary').length < expectedSummary) {
      correctness.failures.push(`hidden subscription modes ${hiddenModes.filter((mode) => mode === 'summary').length}/${expectedSummary}`);
    }
    if (hiddenTarget && hiddenModes.filter((mode) => mode === 'full').length < expectedFull) {
      correctness.failures.push(`visible subscription modes ${hiddenModes.filter((mode) => mode === 'full').length}/${expectedFull}`);
    }
    // Exercise the application's own quick close/restore UI, not a synthetic
    // visibility flag. The same control is used by real users to minimize all
    // floating sub-session windows and restore them from the quick-closed list.
    const quick = page.locator('.subsession-close-all-strip');
    if (await boundedStep(quick.count(), 'quick-close control', 2_000).catch(() => 0)) {
      await boundedStep(quick.click({ timeout: 1_500 }), 'quick close', 2_500).catch(() => {});
      await pageWait(500);
      await boundedStep(quick.click({ timeout: 1_500 }), 'quick restore', 2_500).catch(() => {});
      await pageWait(1_000);
      hiddenModeDiagnostics.modeAfterRestore = { ...(page.__perfWs?.sessionModes ?? {}) };
    } else if (totalSubWindows > 0) {
      // Nothing to close/restore when the run has no sub-windows at all.
      correctness.toggled = false;
      correctness.failures.push('single-page quick close/restore control missing');
    }
    const restoredModes = Object.entries(hiddenModeDiagnostics.modeAfterRestore ?? {}).filter(([name]) => name.startsWith('deck_sub_')).map(([, mode]) => mode);
    if (hiddenTarget && restoredModes.filter((mode) => mode === 'full').length < seen) {
      correctness.failures.push(`restored subscription modes ${restoredModes.filter((mode) => mode === 'full').length}/${seen}`);
    }
    // The fake daemon emits each session's final text on a fixed tick (every
    // 250 stream ticks, 10 s at the default 25 Hz), so a run with few or no
    // windows to open reaches this point BEFORE the first final. Wait for it
    // (bounded) instead of sampling once. Whether the app then shows the chat
    // (final text in the DOM) or its terminal view for a not-yet-typed session
    // is a startup race, so delivery of the final frame to the browser
    // (the harness's own WebSocket accounting) is accepted as well.
    let body = null;
    const finalReceived = () => Boolean(page.__perfWs?.finalSessions?.[main.name]);
    if (!hiddenTarget) {
      for (const started = Date.now(); Date.now() - started < 25_000;) {
        body = await Promise.race([readBodyText(page, 3_000), pageWait(3_000).then(() => null)]);
        if (body?.includes('Final answer for') || finalReceived()) break;
        await pageWait(500);
      }
    } else body = await Promise.race([readBodyText(page, 3_000), pageWait(3_000).then(() => null)]);
    if (!body?.includes('Final answer for') && !finalReceived() && !hiddenTarget) {
      correctness.hiddenFinal = false;
      correctness.failures.push('single-page missing authoritative final');
      stallDiagnostics.push({ sessionId: main.name, phase: 'missing-final', bodyLength: body?.length ?? null, bodyTail: (body ?? '').slice(-1_200), readiness: main.__diagnostics?.readiness ?? null });
    }
    // Keep the primary one-page scenario alive for the requested measurement
    // duration instead of ending immediately after mount/restore. When
    // enabled, the probe samples the real viewport during this stream.
    await startScrollJitterProbe(page);
    const cpuProbe = await startCpuProbe(context);
    const keypressProbe = await startKeypressProbe(page);
    const flickerProbe = await startFlickerProbe(page);
    await pageWait(durationMs);
    const flicker = flickerProbe ? await flickerProbe.stop() : null;
    const keypress = keypressProbe ? await keypressProbe.stop() : null;
    const rendererCpu = cpuProbe ? await cpuProbe.stop() : null;
    const cardLatency = process.env.IMC_PERF_CARD_LATENCY === '1' ? await page.evaluate(() => window.__imcCardLatency?.() ?? null).catch(() => null) : null;
    const scrollJitter = await stopScrollJitterProbe(page);
    // Finals are emitted by the deterministic daemon during the measurement
    // window.  Evaluate the hidden-final invariant after that window, not
    // immediately after the minimize gesture (which races the first final).
    const hiddenNames = Object.entries(modeAfterHide)
      .filter(([name, mode]) => name.startsWith('deck_sub_') && mode === 'summary')
      .map(([name]) => name);
    const finalSessions = page.__perfWs?.finalSessions ?? {};
    const hiddenFinals = hiddenNames.filter((name) => finalSessions[name]).length;
    if (hiddenTarget && hiddenFinals < hiddenTarget) {
      correctness.hiddenFinal = false;
      correctness.failures.push(`hidden final frames ${hiddenFinals}/${hiddenTarget}`);
    } else if (hiddenTarget) correctness.hiddenFinal = true;
    const item = await Promise.race([
      collectMetrics(page),
      pageWait(5_000).then(() => ({ longTask: { p50: 0, p95: 0, max: 0 }, inputDelay: { p95: 0 }, heapBytes: 0, fps: { frames: 0, dropped: 0 }, bufferedAmount: { p95: 0, max: 0 }, ws: page.__perfWs ?? { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, seqGaps: [], sockets: {}, byMode: {}, bufferedAmount: { p95: 0, max: 0 } } })),
    ]);
    item.ws = page.__perfWs ?? item.ws;
    item.ws.bufferedAmount = item.bufferedAmount;
    const lowLevel = await Promise.race([
      main.__stopDiagnostics?.(),
      new Promise((resolve) => setTimeout(() => resolve({ networkLog: [], tracePath: null, profilePath: null }), 30_000)),
    ]);
    const httpCounts = summarizeHttpEndpoints(lowLevel?.networkLog ?? []);
    // The primary scenario also includes a companion tab (same user, second
    // browser target). Keep it bounded and close it before returning so a
    // saturated main renderer cannot strand the harness.
    let companionItem = null;
    const companion = workload.sessions[1];
    if (companion) {
      try {
        const companionPage = await Promise.race([
          openRealSession(context, companion, { manualProtocol: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('companion open timeout')), 30_000)),
        ]);
        companionItem = await Promise.race([collectMetrics(companionPage), pageWait(5_000).then(() => null)]);
        await companionPage.close({ runBeforeUnload: false }).catch(() => {});
      } catch (error) {
        correctness.failures.push(`companion open failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const metrics = aggregate(companionItem ? [item, companionItem] : [item]);
    const modeEntries = Object.entries(modeAfterHide).filter(([name]) => name.startsWith('deck_sub_'));
    const visibleSdkCount = modeEntries.filter(([, mode]) => mode === 'full').length;
    const hiddenSdkCount = modeEntries.filter(([, mode]) => mode === 'summary').length;
    metrics.ws.expectedHiddenFullBytes = visibleSdkCount
      ? ((metrics.ws.byMode?.full ?? 0) / visibleSdkCount) * hiddenSdkCount
      : 0;
    return { workload: { ...workload, sessions: workload.sessions.map(({ events, __page, __diagnostics, ...session }) => session) }, correctness, restoreMs: 0, restoreTotalMs: 0, windowCurve, stallDiagnostics, longChats: {}, scrollJitter, keypress, rendererCpu, cardLatency, flicker, diagnostics: { tracePath: lowLevel?.tracePath ?? null, profilePath: lowLevel?.profilePath ?? null, networkLog: lowLevel?.networkLog ?? [], httpCounts, performanceSamples: lowLevel?.performanceSamples ?? [], performanceDeltas: lowLevel?.performanceDeltas ?? [], hiddenMode: hiddenModeDiagnostics, companion: Boolean(companionItem) }, serverDebug: await page.evaluate(() => window.__perfServerDebug ?? []).catch(() => []), metrics };
  } catch (error) {
    correctness.failures.push(`single-page open failed: ${error instanceof Error ? error.message : String(error)}`);
    correctness.restored = false;
    const lowLevel = await Promise.race([main.__stopDiagnostics?.(), new Promise((resolve) => setTimeout(() => resolve({ networkLog: [], tracePath: null }), 12_000))]);
    stallDiagnostics.push({ sessionId: main.id, tracePath: lowLevel?.tracePath ?? null, profilePath: lowLevel?.profilePath ?? null, performanceSamples: lowLevel?.performanceSamples ?? [], networkLog: lowLevel?.networkLog ?? [], error: error instanceof Error ? error.message : String(error), url: `${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(main.name)}`, waits: ['domcontentloaded<=15s', '#app<=10s', 'initial settle 8s', 'hashchange', 'auth settle 2s', 'route settle 2s', 'manual WS open<=5s', 'main-page open<=120s'], ...(main.__diagnostics ?? {}) });
    await persistCheckpoint({ status: 'single-page-error', windowCurve, stallDiagnostics, correctness });
    return { workload: { sessions: [] }, correctness, restoreMs: 0, restoreTotalMs: 0, windowCurve, stallDiagnostics, longChats: {}, serverDebug: [], metrics: aggregate([]) };
  }
}

export async function runHarness() {
  const requestedSessions = Number(process.env.IMC_PERF_SESSIONS ?? 20);
  const variant = process.env.IMC_PERF_VARIANT ?? 'baseline';
  const workload = buildWorkload({
    seed: Number(process.env.IMC_PERF_SEED ?? 0x4d57494e),
    sessions: requestedSessions,
    hiddenSessions: Math.min(10, Math.max(0, requestedSessions - 1)),
    streamingSessions: variant === 'streaming-off' ? 0 : Math.min(5, requestedSessions),
    statusHz: Number(process.env.IMC_PERF_STATUS_HZ ?? 12),
    streamHz: Number(process.env.IMC_PERF_STREAM_HZ ?? 25),
  });
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ reducedMotion: variant === 'reduced-motion' ? 'reduce' : undefined });
  await installCardLatencyProbe(context);
  if (variant === 'reduced-motion') {
    await context.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = '*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.documentElement.appendChild(style);
    });
  }
  // Chromium only exposes crypto.randomUUID in secure contexts. The compose
  // server is intentionally HTTP-only, so provide the standards-equivalent
  // test shim before the real app bundle runs.
  await context.addInitScript(() => {
    if (!globalThis.crypto?.randomUUID) {
      globalThis.crypto.randomUUID = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    }
  });
  if (process.env.IMC_PERF_RENDER_DEBUG === '1') {
    await context.addInitScript(() => { window.__imcodesRenderDebug = { enabled: true, frames: [], counts: {} }; });
  }
  await context.addCookies([
    { name: 'rcc_session', value: perfJwt(), url: BASE_URL },
    // The compose server uses the standard double-submit CSRF check for the
    // browser WS-ticket endpoint. This deterministic token is test-only.
    { name: 'rcc_csrf', value: 'imc-perf-csrf-token', url: BASE_URL },
  ]);
  await context.addInitScript(({ apiKey, baseUrl, chatSessions }) => {
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', 'imc_perf_harness_server');
    // The fake sessions are not typed as transport sessions until the session
    // list arrives, and a process session opens in its terminal view by default
    // (no chat timeline subscription, no chat text). Which one a run got was a
    // startup race; the scenarios measure the chat, so pin it.
    localStorage.setItem('rcc_viewModes', JSON.stringify(Object.fromEntries(chatSessions.map((name) => [name, 'chat']))));
  }, { apiKey: API_KEY, baseUrl: BASE_URL, chatSessions: workload.sessions.map((session) => session.name) });
  if (process.env.IMC_PERF_LAYOUT !== 'tabs') {
    // Seed the app's own persisted open + quick-closed sets so the primary
    // scenario starts with nine visible SDK panes and ten minimized summary
    // panes. The subsequent close/restore actions still exercise the real UI.
    const seeded = seedVisibility(requestedSessions, process.env.IMC_PERF_SEED_MINIMIZED !== '0');
    await context.addInitScript(({ main, visible, hidden, serverId }) => {
      localStorage.setItem(`rcc_open_subs_${main}`, JSON.stringify(visible));
      if (hidden.length) localStorage.setItem(`rcc_subcard_quick_closed_v1:${encodeURIComponent(serverId)}:${encodeURIComponent(main)}`, JSON.stringify(hidden));
    }, { main: workload.sessions[0]?.name, visible: seeded.visible, hidden: seeded.hidden, serverId: SERVER_ID });
  }
  const pages = [];
  const pageBySession = new Map();
  const windowCurve = [];
  const stallDiagnostics = [];
  const correctness = { fullStream: true, hiddenFinal: true, restored: true, toggled: true, authoritativeBackfill: true, resizeHandles: true, failures: [] };
  try {
    if (process.env.IMC_PERF_LAYOUT !== 'tabs') {
      return await runSinglePageScenario(context, workload, { windowCurve, stallDiagnostics, correctness, pageBySession });
    }
    for (const session of workload.sessions) {
      let page;
      try {
        page = await Promise.race([
          openRealSession(context, session),
          new Promise((_, reject) => setTimeout(() => reject(new Error('window-open-timeout')), 45_000)),
        ]);
      } catch (error) {
        correctness.failures.push(`window open failed ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
        const failedPage = session.__page;
        let screenshot = null;
        // Abort the underlying Playwright operation immediately; Promise.race
        // alone does not cancel page.goto and can leave a renderer wedged.
        void failedPage?.close({ runBeforeUnload: false }).catch(() => {});
        if (failedPage) {
          screenshot = `/repo/perf-results/stall-${session.id}.png`;
          await Promise.race([
            failedPage.screenshot({ path: screenshot, fullPage: true }),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]).catch(() => { screenshot = null; });
        }
        let pageState = null;
        if (failedPage) {
          pageState = await Promise.race([
            failedPage.evaluate(() => ({ readyState: document.readyState, title: document.title, bodyText: document.body?.innerText?.slice(0, 1000) ?? '', url: location.href })),
            new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
          ]).catch(() => null);
        }
        const lowLevel = await Promise.race([session.__stopDiagnostics?.(), new Promise((resolve) => setTimeout(() => resolve({ networkLog: [], tracePath: null }), 12_000))]);
        stallDiagnostics.push({ sessionId: session.id, tracePath: lowLevel?.tracePath ?? null, profilePath: lowLevel?.profilePath ?? null, networkLog: lowLevel?.networkLog ?? [], error: error instanceof Error ? error.message : String(error), url: `${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(session.name)}`, waits: ['domcontentloaded<=15s', '#app<=10s', 'initial settle 8s', 'hashchange', 'auth settle 2s', 'route settle 2s', 'manual WS open<=5s', 'window open<=45s'], screenshot, pageState, ...(session.__diagnostics ?? {}) });
        await persistCheckpoint({ status: 'stalled', stalledAt: session.index, windowCurve, stallDiagnostics, correctness });
        await Promise.race([failedPage?.close({ runBeforeUnload: false }), new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => {});
        break;
      }
      pages.push(page);
      pageBySession.set(session.id, page);
      windowCurve.push({ index: windowCurve.length, sessionId: session.id, ...(await collectWindowDiagnostics(page)) });
      if (windowCurve.length === 5 || windowCurve.length === 10) { windowCurve.at(-1).heapSnapshot = await captureHeapSnapshot(page, `windows-${windowCurve.length}`); }
      await persistCheckpoint({ status: 'opening', windowCurve, stallDiagnostics, correctness });
    }
    // A companion tab is an independent browser socket with its own full
    // subscription, mirroring a second web tab viewing the active session.
    if (workload.sessions[0] && pages.length === workload.sessions.length) {
      const companionSession = { ...workload.sessions[0], id: `${workload.sessions[0].id}-companion`, index: 0 };
      try {
        const companion = await Promise.race([
          openRealSession(context, companionSession),
          new Promise((_, reject) => setTimeout(() => reject(new Error('companion-open-timeout')), 45_000)),
        ]);
        pages.push(companion);
        windowCurve.push({ index: windowCurve.length, sessionId: companionSession.id, ...(await collectWindowDiagnostics(companion)) });
      } catch (error) {
        correctness.failures.push(`companion open failed: ${error instanceof Error ? error.message : String(error)}`);
        const failedPage = companionSession.__page;
        let screenshot = null;
        void failedPage?.close({ runBeforeUnload: false }).catch(() => {});
        if (failedPage) {
          screenshot = `/repo/perf-results/stall-${companionSession.id}.png`;
          await Promise.race([
            failedPage.screenshot({ path: screenshot, fullPage: true }),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]).catch(() => { screenshot = null; });
        }
        let pageState = null;
        if (failedPage) {
          pageState = await Promise.race([
            failedPage.evaluate(() => ({ readyState: document.readyState, title: document.title, bodyText: document.body?.innerText?.slice(0, 1000) ?? '', url: location.href })),
            new Promise((resolve) => setTimeout(() => resolve(null), 2_000)),
          ]).catch(() => null);
        }
        const lowLevel = await Promise.race([companionSession.__stopDiagnostics?.(), new Promise((resolve) => setTimeout(() => resolve({ networkLog: [], tracePath: null }), 12_000))]);
        stallDiagnostics.push({ sessionId: companionSession.id, tracePath: lowLevel?.tracePath ?? null, profilePath: lowLevel?.profilePath ?? null, networkLog: lowLevel?.networkLog ?? [], error: error instanceof Error ? error.message : String(error), url: `${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(companionSession.name)}`, waits: ['domcontentloaded<=15s', '#app<=10s', 'initial settle 8s', 'hashchange', 'auth settle 2s', 'route settle 2s', 'companion open<=45s'], screenshot, pageState, ...(companionSession.__diagnostics ?? {}) });
        await Promise.race([failedPage?.close({ runBeforeUnload: false }), new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => {});
      }
    }
    // Only the foreground tabs are visible; background Chromium pages exercise
    // the server's summary subscription mode without fabricating frame sizes.
    if (!pages.length) {
      correctness.restored = false;
      correctness.toggled = false;
      correctness.authoritativeBackfill = false;
    }
    if (pages[0]) await pages[0].bringToFront();
    await Promise.all(pages.map((page) => page.evaluate(() => window.__startPerfInput?.()).catch(() => null)));
    await startScrollJitterProbe(pages[0]);
    await pageWait(durationMs);
    // Capture server-side queue/counter samples before restore reloads replace
    // the manual protocol page's in-memory debug buffer.
    const serverDebugSamples = pages[0]
      ? await pages[0].evaluate(() => window.__perfServerDebug ?? []).catch(() => [])
      : [];
    for (const session of workload.sessions.slice(0, pages.length)) {
      const page = pageBySession.get(session.id);
      if (!page) continue;
      const text = await readBodyText(page);
      if (!text || !text.includes('Final answer for')) {
        correctness.hiddenFinal = false;
        correctness.failures.push(`missing authoritative final ${session.id}`);
      }
      if (session.index < workload.streamingSessions && !text?.includes('stream-')) {
        correctness.fullStream = false; correctness.failures.push(`missing stream ${session.id}`);
      }
    }
    const scrollJitter = await stopScrollJitterProbe(pages[0]);
    const restoreStarted = Date.now();
    const restoreDurations = await Promise.all(pages.map(async (page) => {
      const started = Date.now();
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForSelector('#app', { timeout: 45_000 });
      } catch (error) {
        correctness.restored = false;
        correctness.failures.push(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return Date.now() - started;
    }));
    const restoreTotalMs = Date.now() - restoreStarted;
    const restoreMs = Math.max(0, ...restoreDurations);
    for (const page of pages) if (!(await readBodyText(page))) correctness.restored = false;
    const togglePage = pages[0];
    if (togglePage) {
      try {
        await togglePage.evaluate(() => document.body.setAttribute('data-perf-hidden', 'true'));
        await togglePage.bringToFront();
        const toggledText = await readBodyText(togglePage);
        correctness.toggled = Boolean(toggledText);
      } catch (error) {
        correctness.toggled = false;
        correctness.failures.push(`toggle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    correctness.authoritativeBackfill = pages.every((page) => (page.__perfWs?.byType?.[TIMELINE_MESSAGES.HISTORY] ?? 0) > 0);
    const longChats = {};
    const longChatCorrectness = {};
    if (process.env.IMC_PERF_LONG_CHATS !== '0') for (const size of [500, 2000, 8000]) {
      const session = { id: `deck_perflat_imcperf-long${size}_brain`, name: `deck_perflat_imcperf-long${size}_brain`, index: 0 };
      try {
        const page = await openRealSession(context, session);
        longChats[size] = (await collectMetrics(page)).longTask;
        const longText = await readBodyText(page);
        longChatCorrectness[size] = Boolean(longText?.includes(`Long chat final ${size}`));
        await page.close();
      } catch (error) {
        longChats[size] = { p50: 0, p95: 0, max: 0 };
        longChatCorrectness[size] = false;
        correctness.failures.push(`long-chat ${size} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const metrics = await Promise.all(pages.map(async (page) => {
      const item = await collectMetrics(page).catch(() => ({ longTask: { p50: 0, p95: 0, max: 0 }, inputDelay: { p95: 0 }, heapBytes: 0, fps: { frames: 0, dropped: 0 }, bufferedAmount: { p95: 0, max: 0 }, ws: page.__perfWs ?? { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, seqGaps: [], sockets: {}, byMode: {}, bufferedAmount: { p95: 0, max: 0 } } }));
      item.ws = page.__perfWs ?? item.ws;
      item.ws.bufferedAmount = item.bufferedAmount;
      return item;
    }));
    const full = metrics.filter((item) => item.ws.mode === 'full');
    const hidden = metrics.filter((item) => item.ws.mode === 'summary');
    const mainMetric = metrics[0] ?? { ws: { sessionModes: {}, byMode: {} } };
    const sessionModes = mainMetric.ws.sessionModes ?? {};
    const visibleSdkCount = Object.entries(sessionModes).filter(([name, mode]) => name.startsWith('deck_sub_') && mode === 'full').length;
    const hiddenSdkCount = Object.entries(sessionModes).filter(([name, mode]) => name.startsWith('deck_sub_') && mode === 'summary').length;
    const expectedHiddenFullBytes = visibleSdkCount ? ((mainMetric.ws.byMode?.full ?? 0) / visibleSdkCount) * hiddenSdkCount : 0;
    // Store the budget once: it is the sum of per-socket full budgets for all
    // hidden sockets, in the same units as hiddenSummaryBytes.
    mainMetric.ws.expectedHiddenFullBytes = expectedHiddenFullBytes;
    correctness.longChats = longChatCorrectness;
    correctness.failures.push(...Object.entries(longChatCorrectness).filter(([, ok]) => !ok).map(([size]) => `missing long-chat final ${size}`));
    return { workload: { ...workload, sessions: workload.sessions.map(({ events, __page, __diagnostics, ...session }) => session) }, correctness, restoreMs, restoreTotalMs, windowCurve, stallDiagnostics, longChats, scrollJitter, serverDebug: serverDebugSamples, metrics: aggregate(metrics) };
  } finally {
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15_000))]).catch(() => {});
    await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15_000))]).catch(() => {});
  }
}

function pageWait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function summarizeHttpEndpoints(networkLog) {
  const counts = { appBuild: 0, subSessions: 0, timelineHistory: 0, timelinePage: 0, timelineReplay: 0, other: 0 };
  for (const entry of networkLog) {
    if (entry.kind !== 'request' && entry.kind !== 'response') continue;
    const url = entry.url ?? '';
    if (url.includes('app-build')) counts.appBuild += entry.kind === 'request' ? 1 : 0;
    else if (url.includes('/sub-sessions')) counts.subSessions += entry.kind === 'request' ? 1 : 0;
    else if (url.includes('/timeline/history')) counts.timelineHistory += entry.kind === 'request' ? 1 : 0;
    else if (url.includes('/timeline/page')) counts.timelinePage += entry.kind === 'request' ? 1 : 0;
    else if (url.includes('/timeline/replay')) counts.timelineReplay += entry.kind === 'request' ? 1 : 0;
    else if (entry.kind === 'request' && entry.type === 'Fetch') counts.other += 1;
  }
  return counts;
}

async function readBodyText(page, timeout = 5_000) {
  try {
    return await page.locator('body').textContent({ timeout });
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHarness().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { console.error(error); process.exitCode = 1; });
}
