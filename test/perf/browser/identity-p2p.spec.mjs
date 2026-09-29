/**
 * Real-machine row for identity-over-lease (tsk_cd_identity_p2p_phase2):
 * a REAL Chromium (real ICE/DTLS/SCTP), a REAL built daemon, a REAL server,
 * against a REAL Postgres. Two scenarios:
 *
 *   - direct: normal Chromium, same-network ICE negotiates a direct
 *     host/srflx candidate pair -- shows ROUTE metric = direct.
 *   - forced relay: Chromium launched with
 *     --force-webrtc-ip-handling-policy=disable_non_proxied_udp (hides
 *     host/reflexive candidates from ICE gathering), against a real coturn
 *     TURN server -- shows ROUTE metric = relay.
 *
 * Both scenarios SET then GET a large (>=250k chars) PROJECT-scope identity
 * profile, verify the SHA256 the browser computed matches the daemon's own
 * on-disk content (via identity-daemon.mjs's /local-content control
 * endpoint -- no assumption that the browser and daemon agree, an actual
 * cross-process check), and that the save completes well inside 20s (the
 * owner's explicit "save never times out" bound, shared/session-identity.ts's
 * SESSION_IDENTITY_REFRESH_TIMEOUT_MS).
 *
 * Drives the identity functions directly via a test-only, opt-in
 * (?identityTestHooks=1) window hook (web/src/app.tsx) rather than the
 * settings UI: this is still the real browser's real WebRTC stack end to
 * end, just without depending on exact dialog/button selectors that would
 * make this spec brittle to unrelated UI changes.
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_identity_real_server';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'imc_identity_perf_browser_key';
const SESSION_NAME = process.env.IMC_PERF_IDENTITY_SESSION ?? 'deck_identity_perf_brain';
const PROJECT_ID = process.env.IMC_PERF_IDENTITY_PROJECT_ID ?? 'identity-perf-org/identity-perf-repo';
const CONTROL_URL = process.env.IMC_PERF_IDENTITY_CONTROL_URL ?? 'http://127.0.0.1:19140';
const CONTENT_CHARS = 260_000; // >= the owner's 250k-char bound; comfortably under SESSION_IDENTITY_PROJECT_MAX_CHARS (300k).
const SAVE_BUDGET_MS = 20_000; // the owner's "save never times out" bound.

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64(JSON.stringify({ sub: 'imc_identity_perf_user', role: 'owner', type: 'web', iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function waitForDaemonReady() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(`${CONTROL_URL}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* the daemon is still connecting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('identity-daemon readiness timeout');
}

async function readDaemonLocalContent(scope, scopeKey) {
  const url = `${CONTROL_URL}/local-content?scope=${encodeURIComponent(scope)}&scopeKey=${encodeURIComponent(scopeKey)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`local-content probe failed: ${response.status}`);
  return response.json();
}

/**
 * Runs the full set-then-get identity-over-lease cycle in one real page,
 * returning the observed ROUTE metrics and timings. `chromiumArgs` is how
 * the two scenarios differ -- everything else about the flow is identical.
 */
async function runScenario(chromiumArgs, label) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', ...chromiumArgs] });
  const routeMetrics = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
    await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-identity-perf-csrf-token', url: BASE_URL }]);
    await context.addInitScript(({ apiKey, baseUrl, serverId, session }) => {
      localStorage.setItem('rcc_api_key', apiKey);
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_identity_perf_user', baseUrl }));
      localStorage.setItem('rcc_server', serverId);
    }, { apiKey: API_KEY, baseUrl: BASE_URL, serverId: SERVER_ID, session: SESSION_NAME });
    const page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      process.stderr.write(`[${label}] [browser console] ${msg.type()} ${text}\n`);
      // web/src/direct-file-transfer.ts's recordDirectFileTransferMetric logs
      // via console.debug('[direct-file-transfer]', {metric, route, ...}) --
      // Playwright only gives us the formatted text, so parse the JSON tail.
      if (text.includes('[direct-file-transfer]') && text.includes('"metric":"route"')) {
        const jsonStart = text.indexOf('{');
        if (jsonStart >= 0) {
          try { routeMetrics.push(JSON.parse(text.slice(jsonStart))); } catch { /* not JSON on this line */ }
        }
      }
    });
    page.on('requestfailed', (req) => process.stderr.write(`[${label}] [browser requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}\n`));

    await page.goto(
      `${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION_NAME)}?identityTestHooks=1`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
    const REQUIRED_CAPABILITIES = [
      'file.transfer.direct.lease.v2',
      'file.transfer.direct.upload_recovery.v2',
      'file.transfer.direct.preview_download.v2',
    ];
    await page.waitForFunction((required) => {
      const ws = window.__identityTestWs__;
      const mod = window.__identityTestDirectFileTransfer__;
      if (!ws?.connected || !mod?.setSessionIdentityDirect || !mod?.getSessionIdentityDirect) return false;
      const snapshot = ws.getDaemonCapabilitySnapshot?.();
      return Boolean(snapshot) && required.every((capability) => snapshot.capabilities.includes(capability));
    }, REQUIRED_CAPABILITIES, { timeout: 30_000 });

    const content = 'identity-perf-content-'.repeat(Math.ceil(CONTENT_CHARS / 23)).slice(0, CONTENT_CHARS);
    const expectedHash = sha256Hex(content);

    const setStarted = Date.now();
    const setResult = await page.evaluate(async ({ serverId, projectId, content }) => {
      const mod = window.__identityTestDirectFileTransfer__;
      const ws = window.__identityTestWs__;
      const result = await mod.setSessionIdentityDirect(ws, serverId, 'project', projectId, content);
      return result;
    }, { serverId: SERVER_ID, projectId: PROJECT_ID, content });
    const setElapsedMs = Date.now() - setStarted;
    if (setElapsedMs > SAVE_BUDGET_MS) throw new Error(`[${label}] SET took ${setElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    if (setResult.contentHash !== expectedHash) {
      throw new Error(`[${label}] SET returned contentHash ${setResult.contentHash}, expected ${expectedHash}`);
    }

    const daemonRow = await readDaemonLocalContent('project', PROJECT_ID);
    if (!daemonRow) throw new Error(`[${label}] daemon has no local content for the project scope after SET`);
    if (daemonRow.contentHash !== expectedHash || daemonRow.content !== content) {
      throw new Error(`[${label}] daemon's on-disk content/hash does not match what the browser sent`);
    }

    const getStarted = Date.now();
    const getResult = await page.evaluate(async ({ serverId, projectId }) => {
      const mod = window.__identityTestDirectFileTransfer__;
      const ws = window.__identityTestWs__;
      return await mod.getSessionIdentityDirect(ws, serverId, 'project', projectId);
    }, { serverId: SERVER_ID, projectId: PROJECT_ID });
    const getElapsedMs = Date.now() - getStarted;
    if (getElapsedMs > SAVE_BUDGET_MS) throw new Error(`[${label}] GET took ${getElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    if (getResult.content !== content) throw new Error(`[${label}] GET returned content that does not match what was SET`);

    await context.close();
    return { setElapsedMs, getElapsedMs, contentHash: expectedHash, routeMetrics };
  } finally {
    await browser.close();
  }
}

export async function runIdentityP2pScenario() {
  await waitForDaemonReady();

  const direct = await runScenario([], 'direct');
  const directRoutes = direct.routeMetrics.map((entry) => entry.route);
  if (!directRoutes.includes('direct') && !directRoutes.includes('lan_direct')) {
    throw new Error(`[direct] expected a direct/lan_direct ROUTE metric, got: ${JSON.stringify(directRoutes)}`);
  }

  const relay = await runScenario(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], 'forced-relay');
  const relayRoutes = relay.routeMetrics.map((entry) => entry.route);
  if (!relayRoutes.includes('relay')) {
    throw new Error(`[forced-relay] expected a relay ROUTE metric, got: ${JSON.stringify(relayRoutes)}`);
  }

  return { direct, relay };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runIdentityP2pScenario();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
