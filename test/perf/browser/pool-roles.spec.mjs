import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const SESSION = process.env.IMC_PERF_SHELL_SESSION ?? 'deck_shell_perf_brain';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const SCREENSHOT = process.env.IMC_POOL_ROLES_SCREENSHOT ?? '/repo/perf-results/pool-roles.png';
const CSRF_TOKEN = 'imc-shell-perf-csrf-token';

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: 'imc_shell_perf_user', role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

const capability = (model, agentType, providerFamily, role) => ({
  model, agentType, providerFamily, runtimeType: 'transport',
  capabilityId: `supervision-exec-v1:transport:${agentType}:${providerFamily}:${model}`,
  role,
});

async function runPoolRoleScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: 'rcc_session', value: jwt(), url: BASE_URL },
    { name: 'rcc_csrf', value: 'imc-shell-perf-csrf-token', url: BASE_URL },
  ]);
  await context.addInitScript(({ serverId }) => {
    window.__IMC_SHELL_BROWSER_TEST__ = true;
    localStorage.setItem('rcc_api_key', 'imc_shell_perf_browser_key');
    localStorage.setItem('rcc_server', serverId);
  }, { serverId: SERVER_ID });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION)}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('.terminal-container', { timeout: 180_000 });
  } catch (error) {
    console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000) }));
    throw error;
  }

  const result = await page.evaluate(async ({ serverId, session, csrf }) => {
    const endpoint = `/api/server/${encodeURIComponent(serverId)}/sessions/${encodeURIComponent(session)}/supervision/defaults`;
    const controls = { maxConcurrency: 4, maxSpawned: 2, leaseMs: 1800000, changeBudget: 200, auditHeadroomPerProviderFamily: 1 };
    const defaults = {
      backend: 'codex-sdk', model: 'gpt-6-luna', timeoutMs: 30000, promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: 2, maxAutoContinueTotal: 0,
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: {
          configs: [
            { model: 'gpt-6-luna', agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6-luna', role: 'executor' },
            { model: 'claude-opus-4-7', agentType: 'claude-code-sdk', providerFamily: 'anthropic', runtimeType: 'transport', capabilityId: 'supervision-exec-v1:transport:claude-code-sdk:anthropic:claude-opus-4-7', role: 'auditor' },
          ], controls,
        },
        economyTaskPool: { configs: [], controls },
      },
    };
    const save = await fetch(endpoint, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ defaults }) });
    if (!save.ok) throw new Error(`pool role save failed: ${save.status}`);
    const saved = await save.json();
    const reload = await fetch(endpoint, { credentials: 'include' });
    if (!reload.ok) throw new Error(`pool role reload failed: ${reload.status}`);
    const reloaded = await reload.json();
    const configs = reloaded.defaults?.executionPools?.primaryDevelopmentPool?.configs ?? [];
    return {
      saved: saved.defaults?.executionPools?.primaryDevelopmentPool?.configs ?? [],
      reloaded: configs,
      executor: configs.find((entry) => entry.role === 'executor')?.model,
      auditor: configs.find((entry) => entry.role === 'auditor')?.model,
    };
  }, { serverId: SERVER_ID, session: SESSION, csrf: CSRF_TOKEN });

  assert.equal(result.executor, 'gpt-6-luna');
  assert.equal(result.auditor, 'opus[1M]');
  assert.equal(result.reloaded.find((entry) => entry.model === 'gpt-6-luna')?.role, 'executor');
  assert.equal(result.reloaded.find((entry) => entry.model === 'opus[1M]')?.role, 'auditor');
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  await browser.close();
  return { rolePersistence: true, executor: result.executor, auditor: result.auditor, screenshot: SCREENSHOT };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPoolRoleScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export { runPoolRoleScenario };
