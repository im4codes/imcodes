/**
 * Real-machine row for identity-over-lease (tsk_cd_identity_p2p_phase2):
 * a REAL Chromium (real ICE/DTLS/SCTP), a REAL built daemon, a REAL server,
 * against a REAL Postgres. Two scenarios:
 *
 *   - direct: normal Chromium, same-network ICE negotiates a direct
 *     host/srflx candidate pair -- shows ROUTE metric = direct, driving
 *     getSessionIdentityDirect/setSessionIdentityDirect directly.
 *   - forced-relay-fallback: Chromium launched with
 *     --force-webrtc-ip-handling-policy=disable_non_proxied_udp, which
 *     reliably blocks the P2P lease (see the escalated finding: the
 *     browser's RTCPeerConnection never registers a remote ICE candidate
 *     under this policy, root-caused separately -- not this task's bug).
 *     Drives fetchSessionIdentityProfileDirectFirst/
 *     saveSessionIdentityProfileDirectFirst (web/src/session-identity-direct.ts),
 *     which is what the app actually calls: when the direct attempt throws,
 *     it falls back to the phase-1 WS-relayed HTTP path (web/src/api.ts).
 *     Asserts that fallback actually happens (an HTTP PUT/GET to the
 *     identity endpoint is observed), content still round-trips correctly,
 *     and the total time -- including the failed lease attempt -- stays
 *     well inside the owner's "save never times out" bound.
 *
 * Both scenarios verify the SHA256 the browser computed/received matches
 * the daemon's own on-disk content (via identity-daemon.mjs's
 * /local-content control endpoint -- no assumption that the browser and
 * daemon agree, an actual cross-process check).
 *
 * Drives the identity functions directly via a test-only, opt-in
 * (?identityTestHooks=1) window hook (web/src/app.tsx) rather than the
 * settings UI: this is still the real browser's real WebRTC/HTTP stack end
 * to end, just without depending on exact dialog/button selectors that
 * would make this spec brittle to unrelated UI changes.
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
const SAVE_BUDGET_MS = 20_000; // the owner's "save never times out" bound, including a blocked lease attempt.

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

async function launchIdentityPage(chromiumArgs, label, { routeMetrics, pendingRouteReads, httpIdentityRequests }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', ...chromiumArgs] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-identity-perf-csrf-token', url: BASE_URL }]);
  await context.addInitScript(({ apiKey, baseUrl, serverId }) => {
    // BASE_URL is a docker-network hostname (e.g. http://server:19138), not
    // literal localhost/127.0.0.1 -- Chromium's secure-context check only
    // exempts the latter, so crypto.randomUUID() is undefined there. Same
    // polyfill as upload-preview.spec.mjs's proven pattern for this gap.
    if (typeof crypto.randomUUID !== 'function') {
      crypto.randomUUID = () => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    }
    localStorage.setItem('rcc_api_key', apiKey);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_identity_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', serverId);
  }, { apiKey: API_KEY, baseUrl: BASE_URL, serverId: SERVER_ID });
  const page = await context.newPage();
  page.on('console', (msg) => {
    process.stderr.write(`[${label}] [browser console] ${msg.type()} ${msg.text()}\n`);
    // web/src/direct-file-transfer.ts's recordDirectFileTransferMetric logs
    // via console.debug('[direct-file-transfer]', {metric, route, ...}) --
    // a real object arg, not a JSON string (msg.text() renders it with
    // unquoted keys, e.g. "{metric: route, route: direct}", which isn't
    // parseable JSON). Read the real object back via the console message's
    // JSHandle args instead.
    if (msg.text().startsWith('[direct-file-transfer]') && msg.args().length >= 2) {
      pendingRouteReads.push(msg.args()[1].jsonValue().then((fields) => {
        if (fields && typeof fields === 'object' && typeof fields.route === 'string') {
          routeMetrics.push(fields);
        }
      }).catch(() => { /* handle no longer resolvable (page navigated/closed) */ }));
    }
  });
  page.on('requestfailed', (req) => process.stderr.write(`[${label}] [browser requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}\n`));
  page.on('request', (req) => {
    if (req.url().includes('/identity')) httpIdentityRequests.push({ method: req.method(), url: req.url() });
  });

  // app.tsx reads identityTestHooks from window.location.search (the real
  // query string), which comes BEFORE the hash in a hash-routed SPA -- put
  // it there, not inside the #/server/session hash route itself.
  await page.goto(
    `${BASE_URL}/?identityTestHooks=1#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION_NAME)}`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  const REQUIRED_CAPABILITIES = [
    'file.transfer.direct.lease.v2',
    'file.transfer.direct.upload_recovery.v2',
    'file.transfer.direct.preview_download.v2',
  ];
  try {
    await page.waitForFunction((required) => {
      const ws = window.__identityTestWs__;
      const directMod = window.__identityTestDirectFileTransfer__;
      const firstMod = window.__identityTestDirectFirst__;
      if (!ws?.connected || !directMod?.setSessionIdentityDirect || !directMod?.getSessionIdentityDirect
        || !firstMod?.saveSessionIdentityProfileDirectFirst || !firstMod?.fetchSessionIdentityProfileDirectFirst) return false;
      const snapshot = ws.getDaemonCapabilitySnapshot?.();
      return Boolean(snapshot) && required.every((capability) => snapshot.capabilities.includes(capability));
    }, REQUIRED_CAPABILITIES, { timeout: 30_000 });
  } catch (error) {
    const diag = await page.evaluate(() => ({
      hasWs: Boolean(window.__identityTestWs__),
      hasDirectMod: Boolean(window.__identityTestDirectFileTransfer__),
      hasFirstMod: Boolean(window.__identityTestDirectFirst__),
      connected: window.__identityTestWs__?.connected,
      snapshot: window.__identityTestWs__?.getDaemonCapabilitySnapshot?.() ?? null,
    }));
    process.stderr.write(`[${label}] [diagnostic] ${JSON.stringify(diag)}\n`);
    throw error;
  }
  return { browser, context, page };
}

/** Drives getSessionIdentityDirect/setSessionIdentityDirect directly -- proves the real P2P lease path end to end. */
async function runDirectScenario() {
  const routeMetrics = [];
  const pendingRouteReads = [];
  const httpIdentityRequests = [];
  const { browser, context, page } = await launchIdentityPage([], 'direct', { routeMetrics, pendingRouteReads, httpIdentityRequests });
  try {
    const content = 'identity-perf-content-'.repeat(Math.ceil(CONTENT_CHARS / 23)).slice(0, CONTENT_CHARS);
    const expectedHash = sha256Hex(content);

    const setStarted = Date.now();
    const setResult = await page.evaluate(async ({ serverId, projectId, content }) => {
      const mod = window.__identityTestDirectFileTransfer__;
      const ws = window.__identityTestWs__;
      return await mod.setSessionIdentityDirect(ws, serverId, 'project', projectId, content);
    }, { serverId: SERVER_ID, projectId: PROJECT_ID, content });
    const setElapsedMs = Date.now() - setStarted;
    if (setElapsedMs > SAVE_BUDGET_MS) throw new Error(`[direct] SET took ${setElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    if (setResult.contentHash !== expectedHash) {
      throw new Error(`[direct] SET returned contentHash ${setResult.contentHash}, expected ${expectedHash}`);
    }

    const daemonRow = await readDaemonLocalContent('project', PROJECT_ID);
    if (!daemonRow) throw new Error('[direct] daemon has no local content for the project scope after SET');
    if (daemonRow.contentHash !== expectedHash || daemonRow.content !== content) {
      throw new Error("[direct] daemon's on-disk content/hash does not match what the browser sent");
    }

    const getStarted = Date.now();
    const getResult = await page.evaluate(async ({ serverId, projectId }) => {
      const mod = window.__identityTestDirectFileTransfer__;
      const ws = window.__identityTestWs__;
      return await mod.getSessionIdentityDirect(ws, serverId, 'project', projectId);
    }, { serverId: SERVER_ID, projectId: PROJECT_ID });
    const getElapsedMs = Date.now() - getStarted;
    if (getElapsedMs > SAVE_BUDGET_MS) throw new Error(`[direct] GET took ${getElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    if (getResult.content !== content) throw new Error('[direct] GET returned content that does not match what was SET');

    await Promise.all(pendingRouteReads);
    await context.close();
    return { setElapsedMs, getElapsedMs, contentHash: expectedHash, routeMetrics, httpIdentityRequests };
  } finally {
    await browser.close();
  }
}

/**
 * Drives saveSessionIdentityProfileDirectFirst/fetchSessionIdentityProfileDirectFirst
 * under a Chromium policy that blocks the P2P lease -- proves the phase-1
 * WS-relayed HTTP fallback actually engages, content still round-trips
 * correctly, and the whole thing (failed lease attempt included) stays
 * well inside the save-never-times-out budget.
 */
async function runForcedRelayFallbackScenario() {
  const routeMetrics = [];
  const pendingRouteReads = [];
  const httpIdentityRequests = [];
  const chromiumArgs = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  const { browser, context, page } = await launchIdentityPage(chromiumArgs, 'forced-relay-fallback', { routeMetrics, pendingRouteReads, httpIdentityRequests });
  try {
    const content = 'identity-fallback-content-'.repeat(Math.ceil(CONTENT_CHARS / 27)).slice(0, CONTENT_CHARS);
    const expectedHash = sha256Hex(content);

    const setStarted = Date.now();
    const setResult = await page.evaluate(async ({ serverId, sessionName, projectId, content }) => {
      const mod = window.__identityTestDirectFirst__;
      const ws = window.__identityTestWs__;
      return await mod.saveSessionIdentityProfileDirectFirst(
        { scope: 'project', scopeKey: projectId, content },
        { serverId, sessionName },
        ws,
      );
    }, { serverId: SERVER_ID, sessionName: SESSION_NAME, projectId: PROJECT_ID, content });
    const setElapsedMs = Date.now() - setStarted;
    if (setElapsedMs > SAVE_BUDGET_MS) {
      throw new Error(`[forced-relay-fallback] SET (including the blocked lease attempt) took ${setElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    }
    if (setResult.contentHash !== expectedHash) {
      throw new Error(`[forced-relay-fallback] SET returned contentHash ${setResult.contentHash}, expected ${expectedHash}`);
    }

    const daemonRow = await readDaemonLocalContent('project', PROJECT_ID);
    if (!daemonRow) throw new Error('[forced-relay-fallback] daemon has no local content for the project scope after SET');
    if (daemonRow.contentHash !== expectedHash || daemonRow.content !== content) {
      throw new Error("[forced-relay-fallback] daemon's on-disk content/hash does not match what the browser sent");
    }

    const getStarted = Date.now();
    const getResult = await page.evaluate(async ({ serverId, sessionName, projectId }) => {
      const mod = window.__identityTestDirectFirst__;
      const ws = window.__identityTestWs__;
      return await mod.fetchSessionIdentityProfileDirectFirst('project', projectId, { serverId, sessionName }, ws);
    }, { serverId: SERVER_ID, sessionName: SESSION_NAME, projectId: PROJECT_ID });
    const getElapsedMs = Date.now() - getStarted;
    if (getElapsedMs > SAVE_BUDGET_MS) {
      throw new Error(`[forced-relay-fallback] GET (including the blocked lease attempt) took ${getElapsedMs}ms, over the ${SAVE_BUDGET_MS}ms budget`);
    }
    if (!getResult || getResult.content !== content) {
      throw new Error('[forced-relay-fallback] GET returned content that does not match what was SET');
    }

    await Promise.all(pendingRouteReads);
    await context.close();
    return { setElapsedMs, getElapsedMs, contentHash: expectedHash, routeMetrics, httpIdentityRequests };
  } finally {
    await browser.close();
  }
}

export async function runIdentityP2pScenario() {
  await waitForDaemonReady();

  const direct = await runDirectScenario();
  const directRoutes = direct.routeMetrics.map((entry) => entry.route);
  if (!directRoutes.includes('direct') && !directRoutes.includes('lan_direct')) {
    throw new Error(`[direct] expected a direct/lan_direct ROUTE metric, got: ${JSON.stringify(directRoutes)}`);
  }

  const fallback = await runForcedRelayFallbackScenario();
  // The lease must never have reported success under the forced-relay
  // policy -- otherwise this scenario would prove nothing about the
  // fallback path (see the escalated finding on why the lease reliably
  // fails here).
  const fallbackDirectRoutes = fallback.routeMetrics.map((entry) => entry.route);
  if (fallbackDirectRoutes.includes('direct') || fallbackDirectRoutes.includes('lan_direct')) {
    throw new Error(`[forced-relay-fallback] expected the lease to fail, but saw a direct ROUTE metric: ${JSON.stringify(fallbackDirectRoutes)}`);
  }
  const fallbackHttpMethods = fallback.httpIdentityRequests.map((entry) => entry.method);
  if (!fallbackHttpMethods.includes('PUT') || !fallbackHttpMethods.includes('GET')) {
    throw new Error(`[forced-relay-fallback] expected a PUT and a GET to the identity HTTP endpoint (phase-1 fallback), saw: ${JSON.stringify(fallback.httpIdentityRequests)}`);
  }

  return { direct, fallback };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runIdentityP2pScenario();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
