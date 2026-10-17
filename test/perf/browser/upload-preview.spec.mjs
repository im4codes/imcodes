import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const BASE_URL = process.env.IMC_PERF_BASE_URL ?? 'http://127.0.0.1:19138';
const SERVER_ID = process.env.IMC_PERF_SERVER_ID ?? 'imc_perf_harness_server';
const JWT_KEY = process.env.IMC_PERF_JWT_SIGNING_KEY ?? 'perf-only-jwt-jwt-signing-key-32-bytes-minimum';
const API_KEY = process.env.IMC_PERF_API_KEY ?? 'deck_perf_browser_key';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const UPLOAD_ROOT = process.env.IMC_PERF_UPLOAD_ROOT ?? '/tmp/imc-perf-uploads';

async function assertPersistedUploads(page, session, expected) {
  const manifestText = await readFile(`${UPLOAD_ROOT}/manifest.ndjson`, 'utf8');
  const records = manifestText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (records.length < expected.length) throw new Error(`expected ${expected.length} persisted uploads, got ${records.length}`);
  const recent = records.slice(-expected.length);
  const ids = new Set(recent.map((record) => record.id));
  if (ids.size !== recent.length) throw new Error('upload ids collided');
  const remaining = [...recent];
  const matched = [];
  for (const fixture of expected) {
    const index = remaining.findIndex((record) => record.originalName === fixture.name && record.sanitizedName === fixture.sanitizedName);
    if (index < 0) throw new Error(`no persisted record for ${fixture.name}`);
    const [record] = remaining.splice(index, 1);
    if (record.originalName !== fixture.name) throw new Error(`original name mismatch for ${fixture.name}`);
    if (!record.filePath.startsWith(`${UPLOAD_ROOT}/${record.id}/`)) throw new Error('upload path is not id-scoped');
    if (record.sanitizedName !== fixture.sanitizedName) throw new Error(`sanitized name mismatch for ${fixture.name}: ${record.sanitizedName}`);
    const onDisk = await readFile(record.filePath);
    if (!onDisk.equals(fixture.buffer)) throw new Error(`persisted bytes mismatch for ${fixture.name}`);
    const response = await page.request.get(`${BASE_URL}/api/server/${encodeURIComponent(SERVER_ID)}/uploads/${record.id}/download?sessionName=${encodeURIComponent(session)}`);
    if (!response.ok()) throw new Error(`download route failed for ${fixture.name}: ${response.status()}`);
    const downloaded = await response.body();
    if (!downloaded.equals(fixture.buffer)) throw new Error(`download bytes mismatch for ${fixture.name}`);
    if (!response.headers()['content-type']?.startsWith(fixture.mime.split(';')[0])) throw new Error(`download MIME mismatch for ${fixture.name}`);
    matched.push(record);
  }
  return { records: matched.map(({ id, originalName, sanitizedName, filePath, size }) => ({ id, originalName, sanitizedName, filePath, size })) };
}

function jwt() {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64(JSON.stringify({ sub: 'imc_perf_user', role: 'owner', type: 'web', iat: now, exp: now + 3600 }));
  const input = `${header}.${claims}`;
  return `${input}.${crypto.createHmac('sha256', JWT_KEY).update(input).digest('base64url')}`;
}

async function runViewport(browser, width, screenshot) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, bypassCSP: true });
  await context.addCookies([{ name: 'rcc_session', value: jwt(), url: BASE_URL }, { name: 'rcc_csrf', value: 'imc-perf-csrf-token', url: BASE_URL }]);
  const session = process.env.IMC_PERF_SESSION ?? 'deck_perflat_imcperf-lgjccu-0_brain';
  await context.addInitScript(({ apiKey, baseUrl, serverId, session }) => {
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
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'imc_perf_user', baseUrl }));
    localStorage.setItem('rcc_server', serverId);
    localStorage.setItem(`rcc_open_subs_${session}`, JSON.stringify(['perfsub0']));
  }, { apiKey: API_KEY, baseUrl: BASE_URL, serverId: SERVER_ID, session });
  const page = await context.newPage();
  page.on('console', (msg) => process.stderr.write(`[browser console] ${msg.type()} ${msg.text()}\n`));
  page.on('requestfailed', (req) => process.stderr.write(`[browser requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}\n`));
  await page.goto(`${BASE_URL}/#/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(session)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 60_000 });
  const fixtures = [
    { name: '截图 2026.png', mimeType: 'image/png', mime: 'image/png', buffer: PNG, sanitizedName: '截图 2026.png' },
    { name: '报价单 v2.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('xlsx'), sanitizedName: '报价单 v2.xlsx' },
    { name: 'a<b>:c?.txt', mimeType: 'text/plain', mime: 'text/plain', buffer: Buffer.from('text'), sanitizedName: 'a_b_c_.txt' },
    { name: 'CON.txt', mimeType: 'text/plain', mime: 'text/plain', buffer: Buffer.from('con'), sanitizedName: 'file' },
    { name: '截图 2026.png', mimeType: 'image/png', mime: 'image/png', buffer: PNG, sanitizedName: '截图 2026.png' },
  ];
  await input.setInputFiles(fixtures);
  const badges = page.locator('.attachment-badge');
  try {
    await badges.nth(4).waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    process.stderr.write(`[diagnostic] badges=${await badges.count()} uploads=${await page.locator('[data-testid=\"composer-upload-row\"]').allTextContents()}\n`);
    throw error;
  }
  const names = await badges.locator('.attachment-badge-name').allTextContents();
  if (!names.includes('截图 2026.png') || !names.includes('报价单 v2.xlsx')) throw new Error('original attachment names not rendered');
  const openPreview = async (badge, imageIndex = 'first') => {
    // The sub-window can visually cover the main composer. Dispatch the same
    // pointer/mouse entry events as a real hover so the portalized popover is
    // exercised even when Playwright's hit testing sees the overlay.
    await badge.dispatchEvent('pointerenter', { pointerType: 'mouse' });
    await badge.dispatchEvent('mouseenter');
    const preview = page.locator('.attachment-hover-preview').last();
    await preview.waitFor({ state: 'visible', timeout: 15_000 });
    const imageLocator = page.locator('.attachment-hover-preview img');
    const image = imageIndex === 'last' ? imageLocator.last() : imageLocator.first();
    await image.waitFor({ state: 'visible', timeout: 15_000 });
    return image;
  };
  const image = await openPreview(badges.nth(0));
  await image.waitFor({ state: 'visible', timeout: 15_000 });
  const naturalWidth = await image.evaluate((node) => node.naturalWidth);
  if (naturalWidth <= 0) throw new Error('image preview did not decode');
  const composer = page.getByRole('textbox', { name: 'Message input' }).first();
  await composer.fill('sent upload preview');
  if (width <= 480) await composer.press('Enter');
  else await page.getByRole('button', { name: 'Send' }).first().click();
  const sentAttachment = page.locator('.chat-attachment-row').first();
  await sentAttachment.waitFor({ state: 'visible', timeout: 15_000 });
  const sentLabel = await sentAttachment.locator('.chat-attachment-dl').getAttribute('title');
  if (!sentLabel?.includes('截图 2026.png')) throw new Error('sent message attachment name missing');
  const subWindow = page.locator('.subsession-window:visible').first();
  await subWindow.waitFor({ state: 'visible', timeout: 20_000 });
  const subInput = subWindow.locator('input[type=file]').first();
  await subInput.setInputFiles({ name: 'subwindow.png', mimeType: 'image/png', buffer: PNG });
  const subBadge = subWindow.locator('.attachment-badge').first();
  await subBadge.waitFor({ state: 'visible', timeout: 30_000 });
  await subBadge.dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await subBadge.dispatchEvent('mouseenter');
  // Preview popovers are portaled to the document body rather than nested in
  // the sub-window; scope the badge to the window but locate its popover
  // globally after the forced hover (the main composer can be underneath it).
  const subPreview = page.locator('.attachment-hover-preview').last();
  await subPreview.waitFor({ state: 'visible', timeout: 15_000 });
  const subImage = page.locator('.attachment-hover-preview img').last();
  await subImage.waitFor({ state: 'visible', timeout: 15_000 });
  const subNaturalWidth = await subImage.evaluate((node) => node.naturalWidth);
  if (subNaturalWidth <= 0) throw new Error('subwindow image preview did not decode');
  const persisted = await assertPersistedUploads(page, session, [...fixtures, { name: 'subwindow.png', mime: 'image/png', buffer: PNG, sanitizedName: 'subwindow.png' }]);
  await page.screenshot({ path: screenshot, fullPage: true });
  const badgeCount = await badges.count();
  await context.close();
  return { width, badges: badgeCount, naturalWidth, names, sentLabel, subNaturalWidth, persisted };
}

export async function runUploadPreviewScenario() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    return {
      desktop: await runViewport(browser, 1280, process.env.IMC_UPLOAD_DESKTOP_SCREENSHOT ?? '/tmp/upload-preview-desktop.png'),
      mobile: await runViewport(browser, 390, process.env.IMC_UPLOAD_MOBILE_SCREENSHOT ?? '/tmp/upload-preview-mobile.png'),
    };
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(`${JSON.stringify(await runUploadPreviewScenario())}\n`);
