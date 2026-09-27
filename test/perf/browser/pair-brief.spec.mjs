import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_shell_real_server';
const SESSION = process.env.IMC_PERF_PAIR_SESSION ?? 'deck_pair_brief_brain';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const SCREENSHOT = process.env.IMC_PAIR_BRIEF_SCREENSHOT ?? '/repo/perf-results/pair-brief-desktop.png';
const MOBILE_SCREENSHOT = process.env.IMC_PAIR_BRIEF_MOBILE_SCREENSHOT ?? '/repo/perf-results/pair-brief-mobile.png';

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const input = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ sub: 'imc_perf_user', role: 'owner', type: 'web', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

export async function runPairBriefScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-shell-perf-csrf-token', url: BASE_URL }]);
  const brief = '# Browser brief\n\nThe full **task content** is visible.\n\n- [x][ ] Implement the UI\n- [ ][x] Audit the UI';
  const snapshot = {
    authoritative: true,
    tasks: [{ taskId: 'pair-brief-browser', title: 'Browser-visible pair title', status: 'working', updatedAt: Date.now(), brief, pair: { status: 'working', updatedAt: Date.now(), brief } }],
    assignments: [],
  };
  await context.addInitScript(({ serverId, initialSnapshot }) => {
    window.__IMC_SHELL_BROWSER_TEST__ = true;
    localStorage.setItem('rcc_api_key', 'deck_perf_browser_key');
    localStorage.setItem('rcc_server', serverId);
    window.__imcodesTaskPairSnapshot = initialSnapshot;
  }, { serverId: SERVER_ID, initialSnapshot: snapshot });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(SESSION)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app', { timeout: 60_000 });
  await page.waitForSelector('button[title="Session actions"]', { timeout: 60_000 });
  const publishSnapshot = async () => page.evaluate((detail) => {
    window.__imcodesTaskPairSnapshot = detail;
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail }));
  }, snapshot);
  // The authoritative controller emits its initial scope-reset after the chat
  // socket settles; publish after that reset and retry briefly to avoid racing
  // the controller while still exercising the real mounted panel.
  await page.waitForTimeout(2_000);
  const panel = page.getByTestId('task-pair-status-panel');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await publishSnapshot();
    if (await panel.isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const expand = panel.getByRole('button', { name: /show task content|显示任务内容|顯示任務內容|mostrar contenido|タスク内容を表示|작업 내용 표시|показать содержание/i });
  await expand.click();
  await panel.getByText('Browser-visible pair title').waitFor({ state: 'visible' });
  await panel.getByText('task content', { exact: false }).waitFor({ state: 'visible' });
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: MOBILE_SCREENSHOT, fullPage: true });
  const result = { title: true, brief: true, checklist: await panel.getByRole('checkbox').count() === 4, desktopScreenshot: SCREENSHOT, mobileScreenshot: MOBILE_SCREENSHOT };
  await browser.close();
  assert.equal(result.checklist, true);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPairBriefScenario();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
