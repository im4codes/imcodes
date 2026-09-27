import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
import { buildWorkload } from './load-generator.mjs';
import { aggregate, collectMetrics, installObservers } from './metrics.mjs';

const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_perf_harness_server';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'deck_perf_browser_key';
const JWT_SIGNING_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const durationMs = Number(process.env.IMC_PERF_DURATION_MS ?? 10_000);
const openTimeoutMs = Number(process.env.IMC_PERF_OPEN_TIMEOUT_MS ?? 120_000);
const windowOpenTimeoutMs = Number(process.env.IMC_PERF_WINDOW_TIMEOUT_MS ?? 90_000);

function perfJwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  // The compose-only user is an owner so the real SPA's owner-scoped
  // capabilities probe is authorized. This signing key is test-only and is
  // never accepted by production deployments.
  const claims = b64(JSON.stringify({ sub: 'imc_perf_user', role: 'owner', type: 'web', iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  return `${input}.${crypto.createHmac('sha256', JWT_SIGNING_KEY).update(input).digest('base64url')}`;
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
  const diagnostics = { console: [], failedRequests: [] };
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
  const ws = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, seqGaps: [], historyTimings: [], pendingHistory: {}, byMode: { [mode]: 0 }, sessionModes: {}, finalSessions: {}, mode, expectedHiddenFullBytes: 0, hiddenSummaryBytes: 0 };
  const record = (payload, direction, requestId = 'unknown') => {
    const bytes = Buffer.byteLength(payload, 'utf8');
    ws[direction === 'sent' ? 'sent' : 'received'] += 1;
    ws[direction === 'sent' ? 'bytesSent' : 'bytesReceived'] += bytes;
    try {
      const msg = JSON.parse(payload);
      if (direction === 'sent' && msg.type === 'timeline.subscribe' && msg.sessionName) {
        ws.sessionModes[msg.sessionName] = msg.mode === 'summary' ? 'summary' : 'full';
        if (msg.sessionName === session.name) ws.mode = ws.sessionModes[msg.sessionName];
      }
      const type = msg.event?.type ?? msg.type ?? 'unknown';
      if (direction === 'received') {
        const eventSession = msg.sessionId ?? msg.event?.sessionId ?? msg.event?.payload?.sessionId;
        const eventMode = eventSession && ws.sessionModes[eventSession] ? ws.sessionModes[eventSession] : ws.mode;
        ws.byMode[eventMode] = (ws.byMode[eventMode] ?? 0) + bytes;
        if (eventMode === 'summary') ws.hiddenSummaryBytes += bytes;
        if (type === 'assistant.text' && msg.event?.payload?.streaming === false) ws.finalSessions[eventSession ?? 'unknown'] = true;
      }
      if (direction === 'sent' && (msg.type === 'timeline.history_request' || msg.type === 'timeline.page_request' || msg.type === 'timeline.replay_request') && msg.requestId) {
        ws.pendingHistory[msg.requestId] = { requestId: msg.requestId, type: msg.type, sentAt: Date.now() };
      }
      if (direction === 'received' && (msg.type === 'timeline.history' || msg.type === 'timeline.page' || msg.type === 'timeline.replay') && msg.requestId) {
        const pending = ws.pendingHistory[msg.requestId];
        if (pending) { ws.historyTimings.push({ ...pending, receivedAt: Date.now(), durationMs: Date.now() - pending.sentAt, bytes }); delete ws.pendingHistory[msg.requestId]; }
      }
      ws.byType[type] = (ws.byType[type] ?? 0) + bytes;
      ws.framesByType[type] = (ws.framesByType[type] ?? 0) + 1;
      const socket = ws.sockets[requestId] ??= { requestId, mode: ws.mode, sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, bufferedAmount: 0 };
      if (direction === 'sent' && msg.type === 'timeline.subscribe' && msg.sessionName) socket.mode = ws.sessionModes[msg.sessionName] ?? ws.mode;
      socket[direction === 'sent' ? 'sent' : 'received'] += 1;
      socket[direction === 'sent' ? 'bytesSent' : 'bytesReceived'] += bytes;
      socket.byType[type] = (socket.byType[type] ?? 0) + bytes;
      if (direction === 'received' && type === 'timeline.seq_gap' && ws.seqGaps.length < 20) {
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
  try { cdp = await cdpWithTimeout(context.newCDPSession(page), 'newCDPSession'); } catch (error) {
    session.__cdpError = error instanceof Error ? error.message : String(error);
  }
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
    try { await cdpWithTimeout(cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink,disabled-by-default-v8.cpu_profiler', options: 'sampling-frequency=10000', transferMode: 'ReportEvents' }), 'Tracing.start'); } catch (error) { session.__traceError = error instanceof Error ? error.message : String(error); }
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
    return { networkLog: [...networkLog], tracePath, profilePath, performanceSamples: [...performanceSamples] };
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
  if (manualProtocol) { session.__diagnostics.phase = 'manual-protocol'; await Promise.race([page.evaluate(async ({ serverId, sessionName, mode }) => {
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
        socket.send(JSON.stringify({ type: 'timeline.subscribe', sessionName, mode }));
        // Request the authoritative timeline immediately. This exercises the
        // real server backfill path and lets the browser verify that reveals
        // converge without relying on a fabricated client-side history.
        socket.send(JSON.stringify({ type: 'timeline.history_request', sessionName, requestId: `perf-${sessionName}`, afterSeq: 0, limit: historyLimit }));
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
  }, { serverId: SERVER_ID, sessionName: session.name, mode }), new Promise((_, reject) => setTimeout(() => reject(new Error('manual protocol timeout')), 8_000))]); }
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
    const targetWindows = Math.max(1, Number(process.env.IMC_PERF_SUB_WINDOWS ?? (workload.sessions.length - 1)));
    const started = Date.now();
    let seen = 0;
    const boundedStep = (promise, label, timeoutMs = 2_000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
    ]);
    while (Date.now() - started < windowOpenTimeoutMs && seen < targetWindows) {
      let state = { domNodes: 0, heapBytes: 0, globalDiagnosticKeys: [], globalDiagnosticKeyCount: 0, textLength: 0 };
      let count = 0;
      let visible = 0;
      try { state = await boundedStep(collectWindowDiagnostics(page), 'window diagnostics'); } catch (error) { correctness.failures.push(`window diagnostics stalled: ${error.message}`); break; }
      try { count = await boundedStep(page.locator('.subsession-window').count(), 'window count'); } catch (error) { correctness.failures.push(`window count stalled: ${error.message}`); break; }
      try { visible = await boundedStep(page.locator('.subsession-window').evaluateAll((items) => items.filter((item) => getComputedStyle(item).display !== 'none').length), 'visible window count'); } catch {}
      if (count > seen) {
        seen = count;
        windowCurve.push({ index: seen, sessionId: main.name, subWindows: count, visibleSubWindows: visible, ...state });
        if (seen === 5 || seen === 10) windowCurve.at(-1).heapSnapshot = await captureHeapSnapshot(page, `single-page-windows-${seen}`);
        await persistCheckpoint({ status: 'opening-single-page', windowCurve, stallDiagnostics, correctness });
      }
      if (seen >= targetWindows) break;
      await pageWait(250);
    }
    if (seen < targetWindows) {
      correctness.failures.push(`single-page sub-window stall ${seen}/${targetWindows}`);
      correctness.restored = false;
      await persistCheckpoint({ status: 'stalled-single-page', stalledAt: seen, windowCurve, stallDiagnostics, correctness });
    }
    // Minimize ten mounted sub-windows through the same close/hide controls a
    // user operates. This exercises summary subscriptions rather than merely
    // marking localStorage ids as hidden.
    const hiddenTarget = Math.min(10, seen);
    const mountedWindows = page.locator('.subsession-window');
    for (let index = 0; index < hiddenTarget; index += 1) {
      await mountedWindows.nth(index).locator('.subsession-close-btn').click({ timeout: 2_000 }).catch(() => {});
    }
    if (hiddenTarget) await pageWait(1_000);
    const hiddenFinals = Object.keys(page.__perfWs?.finalSessions ?? {}).length;
    if (hiddenTarget && hiddenFinals < hiddenTarget) {
      correctness.hiddenFinal = false;
      correctness.failures.push(`hidden final frames ${hiddenFinals}/${hiddenTarget}`);
    } else if (hiddenTarget) correctness.hiddenFinal = true;
    // Exercise the application's own quick close/restore UI, not a synthetic
    // visibility flag. The same control is used by real users to minimize all
    // floating sub-session windows and restore them from the quick-closed list.
    const quick = page.locator('.subsession-close-all-strip');
    if (await boundedStep(quick.count(), 'quick-close control', 2_000).catch(() => 0)) {
      await quick.click({ timeout: 2_000 }).catch(() => {});
      await pageWait(500);
      await quick.click({ timeout: 2_000 }).catch(() => {});
      await pageWait(1_000);
    } else {
      correctness.toggled = false;
      correctness.failures.push('single-page quick close/restore control missing');
    }
    const body = await Promise.race([readBodyText(page, 3_000), pageWait(3_000).then(() => null)]);
    if (!body?.includes('Final answer for') && !hiddenTarget) {
      correctness.hiddenFinal = false;
      correctness.failures.push('single-page missing authoritative final');
    }
    // Keep the primary one-page scenario alive for the requested measurement
    // duration instead of ending immediately after mount/restore.
    await pageWait(durationMs);
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
    return { workload: { ...workload, sessions: workload.sessions.map(({ events, __page, __diagnostics, ...session }) => session) }, correctness, restoreMs: 0, restoreTotalMs: 0, windowCurve, stallDiagnostics, longChats: {}, diagnostics: { tracePath: lowLevel?.tracePath ?? null, profilePath: lowLevel?.profilePath ?? null, networkLog: lowLevel?.networkLog ?? [], httpCounts, performanceSamples: lowLevel?.performanceSamples ?? [], companion: Boolean(companionItem) }, serverDebug: await page.evaluate(() => window.__perfServerDebug ?? []).catch(() => []), metrics: aggregate(companionItem ? [item, companionItem] : [item]) };
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
  const workload = buildWorkload({ seed: Number(process.env.IMC_PERF_SEED ?? 0x4d57494e), sessions: requestedSessions, hiddenSessions: Math.min(10, Math.max(0, requestedSessions - 1)), streamingSessions: Math.min(5, requestedSessions) });
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  // Chromium only exposes crypto.randomUUID in secure contexts. The compose
  // server is intentionally HTTP-only, so provide the standards-equivalent
  // test shim before the real app bundle runs.
  await context.addInitScript(() => {
    if (!globalThis.crypto?.randomUUID) {
      globalThis.crypto.randomUUID = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
    }
  });
  await context.addCookies([
    { name: 'rcc_session', value: perfJwt(), url: BASE_URL },
    // The compose server uses the standard double-submit CSRF check for the
    // browser WS-ticket endpoint. This deterministic token is test-only.
    { name: 'rcc_csrf', value: 'imc-perf-csrf-token', url: BASE_URL },
  ]);
  await context.addInitScript(({ apiKey, baseUrl }) => {
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', 'imc_perf_harness_server');
  }, { apiKey: API_KEY, baseUrl: BASE_URL });
  if (process.env.IMC_PERF_LAYOUT !== 'tabs') {
    const subIds = Array.from({ length: Math.max(0, requestedSessions - 1) }, (_, index) => `perfsub${index.toString(36)}`);
    await context.addInitScript(({ main, subIds }) => {
      localStorage.setItem(`rcc_open_subs_${main}`, JSON.stringify(subIds));
    }, { main: workload.sessions[0]?.name, subIds });
  }
  const pages = [];
  const pageBySession = new Map();
  const windowCurve = [];
  const stallDiagnostics = [];
  const correctness = { fullStream: true, hiddenFinal: true, restored: true, toggled: true, authoritativeBackfill: true, failures: [] };
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
    correctness.authoritativeBackfill = pages.every((page) => (page.__perfWs?.byType?.['timeline.history'] ?? 0) > 0);
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
    const expectedPerHidden = full.length ? full.reduce((sum, item) => sum + item.ws.bytesReceived, 0) / full.length : 0;
    for (const item of hidden) item.ws.expectedHiddenFullBytes = expectedPerHidden;
    correctness.longChats = longChatCorrectness;
    correctness.failures.push(...Object.entries(longChatCorrectness).filter(([, ok]) => !ok).map(([size]) => `missing long-chat final ${size}`));
    return { workload: { ...workload, sessions: workload.sessions.map(({ events, __page, __diagnostics, ...session }) => session) }, correctness, restoreMs, restoreTotalMs, windowCurve, stallDiagnostics, longChats, serverDebug: serverDebugSamples, metrics: aggregate(metrics) };
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
