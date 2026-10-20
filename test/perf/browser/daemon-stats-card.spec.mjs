/**
 * Real-machine proof for the empty daemon status card.
 *
 * Runs against the compose `shell` profile: a real server serving the real SPA
 * and a real daemon whose core-lane link worker is on, so liveness-only
 * heartbeats and the main thread's full daemon.stats alternate on the wire
 * exactly as in production. Chromium watches the status strip, the sidebar rows
 * and the daemon detail card for IMC_PERF_STATS_DURATION_MS (default 150 s,
 * i.e. many heartbeat/stats alternations) and fails on any NaN, empty number or
 * placeholder-after-data, and on any daemon.stats frame that misses a number.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const SESSION = process.env.IMC_PERF_SHELL_SESSION ?? 'deck_shell_perf_brain';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'imc_shell_perf_browser_key';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const JWT_USER_ID = process.env.IMC_PERF_JWT_USER_ID ?? 'imc_shell_perf_user';
const CONTROL_URL = process.env.IMC_PERF_SHELL_CONTROL_URL ?? 'http://shell-daemon:19139';
const DURATION_MS = Number(process.env.IMC_PERF_STATS_DURATION_MS ?? 150_000);
const SAMPLE_MS = Number(process.env.IMC_PERF_STATS_SAMPLE_MS ?? 500);
const OUT_DIR = process.env.IMC_PERF_STATS_OUT ?? '/tmp/imc-daemon-stats-card';
const EXPECT_BASELINE_FAILURE = process.env.IMC_PERF_STATS_EXPECT_FAILURE === '1';
const NUMERIC_KEYS = ['cpu', 'memUsed', 'memTotal', 'load1', 'load5', 'load15', 'uptime'];

function jwt() {
  const b64 = (v) => Buffer.from(v).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: JWT_USER_ID, role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 }))}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

async function waitForDaemonReady(timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CONTROL_URL}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`daemon not ready (${response.status})`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error('daemon readiness timeout');
}

/** What a person can see of the daemon numbers right now. */
function readVisibleStats() {
  const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
  return {
    strip: texts('.daemon-stats-inline'),
    sidebar: texts('.sidebar-stats-row'),
    mobileFooter: texts('.mobile-sidebar-daemon-status'),
    card: {
      cpu: texts('.daemon-details-card-cpu strong')[0] ?? null,
      memory: texts('.daemon-details-card-memory strong')[0] ?? null,
      load: texts('.daemon-details-card-load strong')[0] ?? null,
      uptime: texts('.daemon-details-card-uptime strong')[0] ?? null,
    },
    dialogOpen: Boolean(document.querySelector('[role="dialog"] .daemon-details-grid')),
  };
}

const BAD_TEXT = /NaN|undefined|null|Infinity/;
// "CPU %", "CPU  Load" or an empty "/ /" triple are the empty-card symptoms.
const EMPTY_SYMPTOMS = [/CPU\s*%/, /Load\s*(?:·|$)/, /\/\s*\/\s*(?:$|\s)/, /(?:^|\s)%(?:\s|$)/];
const CPU_OK = /(?:CPU\s*|⚙️)\d+(?:\.\d+)?%/;

function problemsIn(sample, haveFullStats) {
  const problems = [];
  const cardValues = Object.entries(sample.card).filter(([, text]) => text !== null);
  const groups = [
    ...sample.strip.map((text) => ['strip', text]),
    ...sample.sidebar.map((text) => ['sidebar', text]),
    ...cardValues.map(([field, text]) => [`card.${field}`, text]),
  ];
  for (const [name, text] of groups) {
    if (BAD_TEXT.test(text)) problems.push(`${name}: bad token in "${text}"`);
    for (const symptom of EMPTY_SYMPTOMS) {
      if (symptom.test(text)) problems.push(`${name}: empty-card symptom ${symptom} in "${text}"`);
    }
  }
  if (haveFullStats) {
    // After the first full frame every readout must keep showing real numbers.
    for (const text of sample.strip) {
      if (!CPU_OK.test(text)) problems.push(`strip lost its CPU number: "${text}"`);
    }
    for (const text of sample.sidebar.filter((entry) => /CPU/.test(entry))) {
      if (!CPU_OK.test(text)) problems.push(`sidebar lost its CPU number: "${text}"`);
    }
    if (sample.dialogOpen) {
      const { cpu, memory, load, uptime } = sample.card;
      if (!/^\d+(?:\.\d+)?%$/.test(cpu ?? '')) problems.push(`card lost CPU: "${cpu}"`);
      if (!/^\d+(?:\.\d+)? \/ \d+(?:\.\d+)? (?:GB|MB)$/.test(memory ?? '')) problems.push(`card lost memory: "${memory}"`);
      if (!/^\d+(?:\.\d+)? \/ \d+(?:\.\d+)? \/ \d+(?:\.\d+)?$/.test(load ?? '')) problems.push(`card lost load: "${load}"`);
      if (!/^(?:\d+d )?\d+h$/.test(uptime ?? '')) problems.push(`card lost uptime: "${uptime}"`);
    }
  }
  return problems;
}

export async function runDaemonStatsCardScenario() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-shell-perf-csrf-token', url: BASE_URL }]);
  await context.addInitScript(({ apiKey, serverId }) => {
    window.__imcFrames = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const payload = JSON.parse(event.data);
            if (payload?.type === 'daemon.stats' || payload?.type === 'daemon.liveness') {
              window.__imcFrames.push({ at: performance.now(), payload });
            }
          } catch { /* unrelated text frame */ }
        });
        return socket;
      },
    });
    // The harness is served over plain HTTP, where crypto.randomUUID does not
    // exist. A handler that throws on it stops the ws-client dispatch loop, so
    // later listeners (the status readouts) would never see a frame.
    if (typeof crypto.randomUUID !== 'function') {
      crypto.randomUUID = () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    }
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_server', serverId);
  }, { apiKey: API_KEY, serverId: SERVER_ID });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => { if (pageErrors.length < 30) pageErrors.push(String(error?.message ?? error)); });
  page.on('console', (message) => { if (message.type() === 'error' && pageErrors.length < 30) pageErrors.push(`console: ${message.text().slice(0, 300)}`); });

  await waitForDaemonReady();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button.session-tree-node', { timeout: 90_000 });

  const problems = [];
  const samples = [];
  const startedAt = Date.now();
  let cardOpened = false;
  let haveFullStats = false;
  let firstFullAt = null;
  while (Date.now() - startedAt < DURATION_MS) {
    const frames = await page.evaluate(() => window.__imcFrames.length);
    if (!haveFullStats) {
      haveFullStats = await page.evaluate(() => window.__imcFrames.some((f) => f.payload.type === 'daemon.stats'));
      if (haveFullStats) firstFullAt = Date.now() - startedAt;
    }
    // Open the detail card once the strip exists and keep it open: that is the
    // card the owner reported empty.
    if (!cardOpened) {
      const trigger = page.locator('.daemon-stats-trigger').first();
      if (await trigger.count()) {
        await trigger.click().catch(() => {});
        cardOpened = await page.locator('[role="dialog"] .daemon-details-grid').count() > 0;
      }
    }
    const sample = await page.evaluate(readVisibleStats);
    const found = problemsIn(sample, haveFullStats);
    if (found.length) problems.push({ atMs: Date.now() - startedAt, frames, problems: found });
    samples.push({ atMs: Date.now() - startedAt, ...sample });
    await page.waitForTimeout(SAMPLE_MS);
  }

  const frames = await page.evaluate(() => window.__imcFrames.map((f) => ({ at: f.at, payload: f.payload })));
  const stats = frames.filter((f) => f.payload.type === 'daemon.stats');
  const liveness = frames.filter((f) => f.payload.type === 'daemon.liveness');
  const statsMissingNumbers = stats.filter((f) => !NUMERIC_KEYS.every((key) => Number.isFinite(f.payload[key])));
  let alternations = 0;
  for (let i = 1; i < frames.length; i += 1) if (frames[i].payload.type !== frames[i - 1].payload.type) alternations += 1;

  await page.screenshot({ path: `${OUT_DIR}/daemon-stats-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1_500);
  const mobile = await page.evaluate(readVisibleStats);
  const mobileProblems = problemsIn(mobile, haveFullStats);
  await page.screenshot({ path: `${OUT_DIR}/daemon-stats-mobile.png` });
  const bodyTail = await page.evaluate(() => document.body.innerText.slice(-600)).catch(() => '');
  await browser.close();

  const result = {
    durationMs: Date.now() - startedAt,
    sampleCount: samples.length,
    firstFullStatsAtMs: firstFullAt,
    cardOpened,
    statsFrames: stats.length,
    livenessFrames: liveness.length,
    alternations,
    statsFramesMissingNumbers: statsMissingNumbers.length,
    livenessFrameSample: liveness[0]?.payload ?? null,
    lastVisible: samples.at(-1),
    mobile,
    pageErrors,
    bodyTail,
    problemCount: problems.length + mobileProblems.length,
    problems: problems.slice(0, 20),
    mobileProblems,
  };
  fs.writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDaemonStatsCardScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (EXPECT_BASELINE_FAILURE) {
    // Baseline control run: the same observation must catch the bug.
    assert.ok(result.problemCount > 0 || result.statsFramesMissingNumbers > 0, 'baseline run unexpectedly clean');
  } else {
    assert.ok(result.durationMs >= DURATION_MS, 'observation window too short');
    assert.equal(result.firstFullStatsAtMs !== null, true, 'no full daemon.stats ever arrived');
    assert.ok(result.statsFrames >= 10, `too few daemon.stats frames (${result.statsFrames})`);
    assert.ok(result.livenessFrames >= 10, `too few daemon.liveness frames (${result.livenessFrames}): the worker heartbeat path was not exercised`);
    assert.ok(result.alternations >= 10, `frames did not alternate (${result.alternations})`);
    assert.equal(result.statsFramesMissingNumbers, 0, 'a daemon.stats frame reached the browser without its numbers');
    assert.equal(result.problemCount, 0, `visible empty/NaN readouts: ${JSON.stringify(result.problems.slice(0, 3))} ${JSON.stringify(result.mobileProblems)}`);
    assert.equal(result.cardOpened, true, 'the daemon detail card could not be opened to inspect');
  }
}
