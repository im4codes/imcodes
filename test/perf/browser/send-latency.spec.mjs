/**
 * "Click Send -> the sending spinner ends" on a REAL daemon, with and without
 * a stalled daemon main thread (test-only; isolated compose stack).
 *
 * The core-lane link worker acknowledges `session.send` from its own thread in
 * milliseconds, so a healthy web client can end the spinner then. A client that
 * waits for the daemon's main thread (queue snapshot / delivery / echo) shows
 * the spinner for as long as the main thread is busy -- the owner's "send
 * spins for ~10 s". This spec measures exactly that in a real browser against
 * the real daemon, using the daemon's own gated main-thread block hook
 * (`POST <control>/block`) as the controlled stall.
 *
 * Series:  idle   -- no stall (control),
 *          block  -- the daemon main thread is blocked for IMC_PERF_BLOCK_MS
 *                    (the daemon container must be started with
 *                    IMC_PERF_CORE_LANE_BLOCK_MS=<same value>); several messages
 *                    are sent at fixed offsets INSIDE that one window.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const SESSION = process.env.IMC_PERF_LATENCY_SESSION ?? 'deck_latency_qwen_brain';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const CONTROL_URL = process.env.IMC_PERF_SHELL_CONTROL_URL ?? 'http://shell-daemon:19139';
const OUT = process.env.IMC_PERF_LATENCY_OUT ?? '/repo/perf-results/send-latency.json';
const REVISION = process.env.IMC_PERF_REVISION ?? 'unknown';
const IDLE_TRIALS = Number(process.env.IMC_PERF_IDLE_TRIALS ?? 12);
// The daemon's block hook is ONE-SHOT per daemon lifetime, so the stalled series
// sends several messages inside that single window instead of re-arming it.
const BLOCK_SENDS = Number(process.env.IMC_PERF_BLOCK_SENDS ?? 5);
const BLOCK_SEND_GAP_MS = Number(process.env.IMC_PERF_BLOCK_SEND_GAP_MS ?? 1000);
const BLOCK_MS = Number(process.env.IMC_PERF_BLOCK_MS ?? 8000);
const TRIAL_TIMEOUT_MS = Number(process.env.IMC_PERF_TRIAL_TIMEOUT_MS ?? BLOCK_MS + 20_000);

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: 'imc_shell_perf_user', role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(trials) {
  const spinner = trials.map((trial) => trial.spinnerMs).filter((value) => typeof value === 'number');
  const ack = trials.map((trial) => trial.ackMs).filter((value) => typeof value === 'number');
  return {
    trials: trials.length,
    spinnerEndedTrials: spinner.length,
    spinnerMs: { p50: percentile(spinner, 0.5), p95: percentile(spinner, 0.95), max: spinner.length ? Math.max(...spinner) : null },
    ackMs: { p50: percentile(ack, 0.5), p95: percentile(ack, 0.95), max: ack.length ? Math.max(...ack) : null },
    endReasons: trials.reduce((acc, trial) => { acc[trial.endReason] = (acc[trial.endReason] ?? 0) + 1; return acc; }, {}),
  };
}

async function control(path, method = 'GET') {
  const response = await fetch(`${CONTROL_URL}${path}`, { method, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}

async function waitForBlockEnd() {
  const deadline = Date.now() + BLOCK_MS + 30_000;
  while (Date.now() < deadline) {
    try {
      const status = await control('/block-status');
      if (status.status === 200 && status.body?.endedAt) return status.body;
    } catch { /* the daemon is still blocked; keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('daemon block did not end');
}

async function openSession(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: 'rcc_session', value: jwt(), url: BASE_URL },
    { name: 'rcc_csrf', value: 'imc-shell-perf-csrf-token', url: BASE_URL },
  ]);
  await context.addInitScript(({ serverId }) => {
    window.__IMC_SHELL_BROWSER_TEST__ = true;
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
    localStorage.setItem('rcc_api_key', 'imc_shell_perf_browser_key');
    localStorage.setItem('rcc_server', serverId);
    // Page-side probes share ONE clock (performance.now) with the click.
    window.__lat = { acks: [], frames: [] };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const payload = JSON.parse(event.data);
            const at = performance.now();
            if (payload?.type === 'command.ack') window.__lat.acks.push({ commandId: payload.commandId, status: payload.status, at });
            // Frame kinds only (never payloads): evidence of WHICH daemon events arrived and when.
            if (payload?.type && payload.type !== 'terminal.output') {
              window.__lat.frames.push({ type: payload.type, ev: payload.event?.type ?? payload.status ?? undefined, at });
            }
          } catch { /* unrelated frame */ }
        });
        return socket;
      },
    });
  }, { serverId: SERVER_ID });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-onboarding="chat-input"]', { timeout: 120_000 });
  return { context, page };
}

/** Types `marker` and clicks Send in-page so click time and observer share one clock. */
async function sendAndObserve(page, marker) {
  await page.evaluate((text) => {
    const input = document.querySelector('[data-onboarding="chat-input"]');
    input.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, text);
  }, marker);
  await page.waitForFunction(() => {
    const send = [...document.querySelectorAll('button.btn-primary')].find((node) => /^(send|发送|發送)$/i.test((node.textContent ?? '').trim()));
    return !!send && !send.disabled;
  }, undefined, { timeout: 30_000 });
  return page.evaluate(({ text, timeoutMs }) => new Promise((resolve) => {
    const ackBase = window.__lat.acks.length;
    const frameBase = window.__lat.frames.length;
    const state = { t0: 0, appearedAt: null, spinnerEndAt: null, endReason: 'timeout' };
    const bubbles = () => [...document.querySelectorAll('.chat-user')].filter((node) => (node.textContent ?? '').includes(text));
    const inspect = () => {
      const nodes = bubbles();
      const now = performance.now();
      if (nodes.length && state.appearedAt === null) state.appearedAt = now;
      if (state.appearedAt === null || state.spinnerEndAt !== null) return;
      const node = nodes[0];
      if (!node) { state.spinnerEndAt = now; state.endReason = 'bubble_retired'; return finish(); }
      if (node.classList.contains('chat-failed')) { state.spinnerEndAt = now; state.endReason = 'failed'; return finish(); }
      if (!node.querySelector('.chat-user-status-pending') && !node.classList.contains('chat-pending')) {
        state.spinnerEndAt = now;
        state.endReason = 'spinner_cleared';
        return finish();
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      clearTimeout(timer);
      observer.disconnect();
      const ack = window.__lat.acks.slice(ackBase).find((entry) => entry.status === 'accepted' || entry.status === 'ok');
      resolve({
        spinnerMs: state.spinnerEndAt === null ? null : state.spinnerEndAt - state.t0,
        appearMs: state.appearedAt === null ? null : state.appearedAt - state.t0,
        ackMs: ack ? ack.at - state.t0 : null,
        endReason: state.endReason,
        frames: window.__lat.frames.slice(frameBase).slice(0, 12).map((frame) => ({ ...frame, atMs: Math.round(frame.at - state.t0) })).map(({ at, ...rest }) => rest),
      });
    }
    const send = [...document.querySelectorAll('button.btn-primary')].find((node) => /^(send|发送|發送)$/i.test((node.textContent ?? '').trim()));
    state.t0 = performance.now();
    send.click();
    inspect();
  }), { text: marker, timeoutMs: TRIAL_TIMEOUT_MS });
}

export async function runSendLatencyScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const { context, page } = await openSession(browser);
  const idle = [];
  const blocked = [];
  try {
    for (let i = 0; i < IDLE_TRIALS; i += 1) {
      idle.push(await sendAndObserve(page, `lat-idle-${i}-${crypto.randomUUID().slice(0, 8)}`));
      await page.waitForTimeout(400);
    }
    const start = BLOCK_SENDS > 0 ? await control('/block', 'POST') : { status: 200 };
    if (start.status !== 200) throw new Error(`block start failed: ${JSON.stringify(start)}`);
    const blockStartedAt = Date.now();
    const pending = [];
    for (let i = 0; i < BLOCK_SENDS; i += 1) {
      const sentAtMs = Date.now() - blockStartedAt;
      // Observers are independent, so the next message is typed while the
      // previous one is still (possibly) spinning.
      const observed = sendAndObserve(page, `lat-block-${i}-${crypto.randomUUID().slice(0, 8)}`)
        .then((trial) => ({ ...trial, sentAtBlockMs: sentAtMs, blockRemainingMs: Math.max(0, BLOCK_MS - sentAtMs) }));
      pending.push(observed);
      await page.waitForTimeout(BLOCK_SEND_GAP_MS);
    }
    blocked.push(...await Promise.all(pending));
    if (BLOCK_SENDS > 0) await waitForBlockEnd();
  } finally {
    await context.close();
    await browser.close();
  }
  const result = {
    revision: REVISION,
    blockMs: BLOCK_MS,
    idle: { summary: summarize(idle), trials: idle },
    block: { summary: summarize(blocked), trials: blocked },
  };
  await mkdir(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSendLatencyScenario();
  process.stdout.write(`${JSON.stringify({ revision: result.revision, blockMs: result.blockMs, idle: result.idle.summary, block: result.block.summary })}\n`);
}
