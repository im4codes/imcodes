import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createExecutionPoolMcpToolHandlers } from '../../src/daemon/execution-pool-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { normalizeSupervisorDefaultConfig, SUPERVISION_USER_DEFAULT_PREF_KEY } from '../../shared/supervision-config.js';
import { buildSupervisionExecutionCapabilityId, SUPERVISION_EXECUTION_POOL_ROLES } from '../../shared/supervision-execution-pool.js';
import { listTaskPairCandidates, roleEligibleProvisionConfig } from '../../src/daemon/task-pairs/pool.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  refreshSupervisorDefaultsCache, updateSupervisorDefaultsCache, getCachedSupervisorDefaults,
  __resetSupervisorDefaultsCacheForTests, __setCachedSupervisorDefaultsForTests,
  __reloadSupervisorDefaultsCacheFromDiskForTests,
} from '../../src/daemon/supervisor-defaults-cache.js';

const boundary = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), creds: vi.fn(), failSave: false }));
vi.mock('../../src/bind/bind-flow.js', () => ({ loadCredentials: boundary.creds }));
// Only external identities/DB transport are substituted. Both HTTP handlers,
// their normalization and the complete daemon/cache/MCP/picker are production.
vi.mock('../../server/src/security/authorization.js', async (original) => ({
  ...await original<object>(), requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('userId', 'participant'); c.set('role', 'owner'); await next();
  },
}));
vi.mock('../../server/src/security/daemon-auth.js', () => ({
  authenticateDaemonServer: async (_c: unknown, id: string) => ({ ok: true, auth: { userId: id === 'other-server' ? 'other-owner' : 'pool-owner' } }),
  daemonAuthFailure: () => { throw new Error('unexpected auth failure'); },
}));
vi.mock('../../server/src/routes/share-http-auth.js', async (original) => ({
  ...await original<object>(), resolveHttpShareAccessForCoveredSession: async () => ({ actor: { kind: 'share', effectiveActorRole: 'participant' } }),
}));
vi.mock('../../server/src/ws/bridge.js', () => ({ WsBridge: { get: () => ({ sendToDaemon: () => undefined }) } }));
vi.mock('../../server/src/db/queries.js', async (original) => ({
  ...await original<object>(),
  getServerById: async (_db: unknown, id: string) => ({ id, user_id: id === 'other-server' ? 'other-owner' : 'pool-owner' }),
  getUserPref: (...args: unknown[]) => boundary.get(...args),
  setUserPref: (...args: unknown[]) => boundary.set(...args),
  getSubSessionsByServer: async () => [1, 2].map((n) => ({
    id: `e2e_poolroles_${n}`, parent_session: 'deck_e2e_poolroles_brain', type: 'codex-sdk',
    runtime_type: 'transport', active_model: 'gpt-6-luna', provider_id: 'openai', label: `Worker ${n}`,
  })),
}));
const serverId = 'pool-role-server';
const brain = 'deck_e2e_poolroles_brain';
const endpoint = `/api/server/${serverId}/sessions/${brain}/supervision/defaults`;
const config = { agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport' as const, model: 'gpt-6-luna' };
const capabilityId = buildSupervisionExecutionCapabilityId(config);
const caller = { sessionName: brain, projectName: 'e2e_poolroles', userId: 'pool-owner', serverId } as McpRuntimeCaller;
const defaults = (role?: 'executor' | 'auditor' | 'both') => normalizeSupervisorDefaultConfig({
  executionPools: { state: 'configured', primaryDevelopmentPool: { configs: [{ ...config, capabilityId, ...(role ? { role } : {}) }] }, economyTaskPool: { configs: [] } },
});
async function stack() {
  __resetSupervisorDefaultsCacheForTests();
  boundary.failSave = false;
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE prefs (owner TEXT, key TEXT, value TEXT, PRIMARY KEY(owner,key))');
  boundary.get.mockImplementation(async (_db, owner, key) => (sql.prepare('SELECT value FROM prefs WHERE owner=? AND key=?').get(owner, key) as any)?.value ?? null);
  boundary.set.mockImplementation(async (_db, owner, key, value) => {
    if (boundary.failSave) throw new Error('isolated persistence failure');
    sql.prepare('INSERT OR REPLACE INTO prefs VALUES (?,?,?)').run(owner, key, value);
  });
  await boundary.set({}, 'pool-owner', SUPERVISION_USER_DEFAULT_PREF_KEY, JSON.stringify(defaults()));
  const { sessionMgmtRoutes } = await import('../../server/src/routes/session-mgmt.js');
  const { serverRoutes } = await import('../../server/src/routes/server.js');
  const app = new Hono();
  app.use('*', async (c, next) => { (c as any).env = { DB: {} }; await next(); });
  app.route('/api/server', sessionMgmtRoutes);
  app.route('/api/server', serverRoutes);
  boundary.creds.mockResolvedValue({ workerUrl: 'http://pool-fixture', serverId, token: 'isolated-token' });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => app.request(new URL(url).pathname, init));
  const mcp = createExecutionPoolMcpToolHandlers(caller, {
    getDefaults: async () => { await refreshSupervisorDefaultsCache(); return getCachedSupervisorDefaults(); },
    setDefaults: (_caller, value) => updateSupervisorDefaultsCache(value), isProjectBrain: () => true,
  });
  return { app, sql, mcp };
}
function provePicking(role: 'executor' | 'auditor' | 'both') {
  // Cache is authoritative even with a stale Both session snapshot.
  const parent = { name: brain, role: 'brain', agentType: 'codex-sdk', projectName: 'e2e_poolroles', transportConfig: { supervision: { executionPools: defaults().executionPools } } } as SessionRecord;
  const worker = { ...parent, ...config, name: 'deck_sub_e2e_poolroles_1', parentSession: brain, role: 'w1', state: 'idle', activeModel: config.model, sessionInstanceId: 'i', runtimeEpoch: 'r', updatedAt: 1 } as SessionRecord;
  const deps = { listSessions: () => [parent, worker], getSession: (name: string) => name === brain ? parent : worker, hasPendingMessages: () => false };
  for (const pickRole of ['executor', 'auditor'] as const) {
    const allowed = role === 'both' || role === pickRole;
    expect(listTaskPairCandidates({ brain, role: pickRole, pool: 'primary', exclude: new Set() }, deps).map((s) => s.name)).toEqual(allowed ? [worker.name] : []);
    expect(!!roleEligibleProvisionConfig({ brain, role: pickRole, pool: 'primary' }, deps)).toBe(allowed);
  }
}
afterEach(() => { __resetSupervisorDefaultsCacheForTests(); vi.unstubAllGlobals(); });
describe('owner preference HTTP → SQLite mirror → MCP → automatic pool selection', () => {
  it('preserves every role through both save paths, restart and scopes without read-side writes', async () => {
    const { app, sql, mcp } = await stack();
    try {
      for (const role of SUPERVISION_EXECUTION_POOL_ROLES) {
        const saved = await app.request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaults: defaults(role) }) });
        expect(saved.status).toBe(200);
        await refreshSupervisorDefaultsCache();
        __setCachedSupervisorDefaultsForTests(null);
        __reloadSupervisorDefaultsCacheFromDiskForTests();
        const writes = boundary.set.mock.calls.length;
        await expect(mcp.execution_pool_get()).resolves.toMatchObject({ entries: [{ role }] });
        expect(boundary.set.mock.calls.length).toBe(writes);
        provePicking(role);
        const other = await app.request(endpoint.replace(serverId, 'other-server'));
        expect(await other.json()).toEqual({ defaults: null });
        // Existing scope is machine-owner ACCOUNT-wide, not project-local.
        const sameOwner = await app.request(endpoint.replace(brain, 'deck_e2e_otherproject_brain'));
        expect(await sameOwner.json()).toMatchObject({ defaults: { executionPools: defaults(role).executionPools } });
        await expect(mcp.execution_pool_set({ entries: [{ model: config.model, provider: config.agentType, role }] })).resolves.toMatchObject({ status: 'ok', entries: [{ role }] });
        expect(await (await app.request(endpoint)).json()).toMatchObject({ defaults: { executionPools: defaults(role).executionPools } });
      }
      boundary.failSave = true;
      await expect(mcp.execution_pool_set({ entries: [{ model: config.model, provider: config.agentType, role: 'executor' }] })).resolves.toMatchObject({ status: 'error' });
    } finally { sql.close(); }
  });

  it.runIf(!!process.env.IMC_POOL_ROLE_BROWSER_URL)('real browser selection/save/reload uses the same owner HTTP preference and MCP reader', async () => {
    const { app, sql, mcp } = await stack();
    const require = createRequire(resolve('web/package.json'));
    const { chromium } = require('@playwright/test') as typeof import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.on('pageerror', (error) => console.error('browser:', error.message));
      await page.addInitScript(() => { localStorage.setItem('i18nextLng', 'en'); });
      await page.route('**/api/**', async (route: any) => {
        const req = route.request();
        const path = new URL(req.url()).pathname;
        if (path.endsWith('/supervision/defaults') || path.endsWith('/execution-pool-catalog')) {
          const response = await app.request(path, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
          await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
        } else await route.fulfill({ json: { ok: true } });
      });
      const url = `${process.env.IMC_POOL_ROLE_BROWSER_URL}/src/fixtures/execution-pool/index.html`;
      for (const role of SUPERVISION_EXECUTION_POOL_ROLES) {
        await page.goto(url);
        const select = page.getByTestId(`supervision-execution-pool-role-${capabilityId}`);
        await select.selectOption(role);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByTestId('settings-closed').waitFor({ state: 'attached' });
        await page.reload();
        await page.waitForFunction(({ id, role }) => (document.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement)?.value === role,
          { id: `supervision-execution-pool-role-${capabilityId}`, role }, { timeout: 5000 });
        expect(await select.inputValue()).toBe(role);
        await expect(mcp.execution_pool_get()).resolves.toMatchObject({ entries: [{ role }] });
        __setCachedSupervisorDefaultsForTests(null);
        __reloadSupervisorDefaultsCacheFromDiskForTests();
        provePicking(role);
      }
      // A rejected real HTTP write stays in the dialog and displays its error.
      boundary.failSave = true;
      await page.getByTestId(`supervision-execution-pool-role-${capabilityId}`).selectOption('executor');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.session-settings-error').waitFor();
      expect(await page.getByTestId('settings-closed').count()).toBe(0);
      if (process.env.IMC_POOL_ROLE_SCREENSHOT) {
        mkdirSync(resolve(process.env.IMC_POOL_ROLE_SCREENSHOT, '..'), { recursive: true });
        await page.screenshot({ path: process.env.IMC_POOL_ROLE_SCREENSHOT, fullPage: true });
      }
    } finally { await browser.close(); sql.close(); }
  }, 60000);
});
