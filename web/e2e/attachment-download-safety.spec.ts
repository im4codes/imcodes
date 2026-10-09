import { expect, test, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { attachmentContentDisposition, resolveAttachmentDelivery } from '../../shared/attachment-delivery.js';

/**
 * Real-browser proof for the attachment download policy (shared/attachment-delivery.ts, applied by the download routes).
 *
 * The routes answer on the app's own origin, so a script-bearing SVG served inline would run there. Here Chromium receives the exact
 * headers the server computes for each type, on the app origin (`page.route` fulfils same-origin requests), and we observe what the
 * browser DOES: previews through `<img>` still render (SVG and PNG), navigating to the link downloads instead of rendering, and no
 * script ever runs. A control response with the OLD behaviour (SVG inline, no CSP) does run its script, so the check can fail.
 */
const SCRIPT_SVG = (beacon: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/><script>fetch("${beacon}")</script></svg>`;
const SCRIPT_HTML = (beacon: string) => `<!doctype html><title>x</title><script>fetch("${beacon}")</script>`;
// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function serve(page: Page): Promise<{ beacons: () => number }> {
  let beacons = 0;
  // On the context: a popup is a different page, and a script that ran there must still be seen.
  await page.context().route('**/beacon/**', async (route) => { beacons += 1; await route.fulfill({ status: 204 }); });
  const fulfillWithPolicy = (mime: string, filename: string, body: Buffer | string) => async (route: Route) => {
    const delivery = resolveAttachmentDelivery(mime);
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': delivery.contentType,
        'Content-Disposition': attachmentContentDisposition(delivery.disposition, filename),
        ...delivery.securityHeaders,
      },
      body,
    });
  };
  await page.route('**/dl/evil.svg', fulfillWithPolicy('image/svg+xml', 'evil.svg', SCRIPT_SVG('/beacon/svg')));
  await page.route('**/dl/evil.html', fulfillWithPolicy('text/html', 'evil.html', SCRIPT_HTML('/beacon/html')));
  await page.route('**/dl/pic.png', fulfillWithPolicy('image/png', 'pic.png', PNG));
  // CONTROL: what the routes did before the fix (every image/* inline, no CSP, no nosniff).
  await page.route('**/dl/old-evil.svg', async (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'inline; filename="old-evil.svg"' },
    body: SCRIPT_SVG('/beacon/old-svg'),
  }));
  await page.route('**/probe', async (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>probe</title><img id="svg" src="/dl/evil.svg"><img id="png" src="/dl/pic.png">',
  }));
  return { beacons: () => beacons };
}

test('previews through <img> still render SVG and PNG, and nothing runs', async ({ page }) => {
  const seen = await serve(page);
  await page.goto('/probe');
  await expect.poll(() => page.evaluate(() => (document.getElementById('svg') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (document.getElementById('png') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.waitForTimeout(300); // the time a script inside the SVG would have needed
  expect(seen.beacons()).toBe(0);
});

for (const [name, path] of [['an SVG with a script', '/dl/evil.svg'], ['an HTML file with a script', '/dl/evil.html']] as const) {
  test(`opening the link of ${name} downloads it and runs nothing`, async ({ page }) => {
    const seen = await serve(page);
    await page.goto('/probe');
    const downloaded = page.waitForEvent('download');
    // A navigation that ends as a download rejects goto with ERR_ABORTED; that IS the expected outcome.
    await page.goto(path).catch(() => undefined);
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(path.split('/').pop());
    await page.waitForTimeout(300);
    expect(seen.beacons()).toBe(0);
  });
}

test('CONTROL: the previous behaviour (SVG inline, no CSP) does run its script on the app origin', async ({ page }) => {
  const seen = await serve(page);
  await page.goto('/dl/old-evil.svg');
  await expect.poll(() => seen.beacons(), { message: 'the old response should have executed its script' }).toBeGreaterThan(0);
});

/**
 * The REAL web code path: the chat attachment chip calls `previewAttachment` (web/src/api.ts), which fetches the download and used to turn
 * the body into a `blob:` URL it opened on the app origin -- the server's attachment/CSP headers do not survive that. The production
 * module is bundled and run in Chromium against the exact server headers; a replica of the old behaviour is the control.
 */
let apiBundle = '';
test.beforeAll(async () => {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await build({
    absWorkingDir: webRoot,
    entryPoints: ['src/api.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'ImcodesApi',
    write: false,
    alias: { '@shared': path.resolve(webRoot, '../shared') },
    define: { 'import.meta.env': '{}', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"test"' },
    logLevel: 'error',
    platform: 'browser',
    target: 'es2022',
  });
  apiBundle = result.outputFiles[0]!.text;
});

async function serveDownloads(page: Page): Promise<{ beacons: () => number }> {
  let beacons = 0;
  // On the context: a popup is a different page, and a script that ran there must still be seen.
  await page.context().route('**/beacon/**', async (route) => { beacons += 1; await route.fulfill({ status: 204 }); });
  // The beacon URL is absolute: a script inside a blob: document resolves a relative URL against the blob URL, which would hide it.
  const asAttachment = (mime: string, filename: string, bodyFor: (origin: string) => Buffer | string) => async (route: Route) => {
    const delivery = resolveAttachmentDelivery(mime);
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': delivery.contentType, 'Content-Disposition': attachmentContentDisposition(delivery.disposition, filename), ...delivery.securityHeaders },
      body: bodyFor(new URL(route.request().url()).origin),
    });
  };
  await page.route('**/api/server/srv-1/uploads/svg/download*', asAttachment('image/svg+xml', 'evil.svg', (origin) => SCRIPT_SVG(`${origin}/beacon/chip-svg`)));
  await page.route('**/api/server/srv-1/uploads/html/download*', asAttachment('text/html', 'evil.html', (origin) => SCRIPT_HTML(`${origin}/beacon/chip-html`)));
  await page.route('**/api/server/srv-1/uploads/png/download*', asAttachment('image/png', 'pic.png', () => PNG));
  await page.route('**/probe', async (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>probe</title>' }));
  return { beacons: () => beacons };
}

for (const [name, id] of [['an SVG with a script', 'svg'], ['an HTML file with a script', 'html']] as const) {
  test(`clicking the attachment chip of ${name} (previewAttachment) saves it and runs nothing`, async ({ page }) => {
    const seen = await serveDownloads(page);
    await page.goto('/probe');
    await page.addScriptTag({ content: apiBundle });
    let popups = 0;
    page.context().on('page', () => { popups += 1; });
    const downloaded = page.waitForEvent('download');
    await page.evaluate(async (attachmentId) => {
      const api = (window as unknown as { ImcodesApi: { configure(base: string): void; previewAttachment(serverId: string, id: string, session?: string): Promise<void> } }).ImcodesApi;
      api.configure('');
      await api.previewAttachment('srv-1', attachmentId, 'deck_p_brain');
    }, id);
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`evil.${id}`);
    await page.waitForTimeout(300);
    expect(popups).toBe(0); // nothing was opened as a document in a new page
    expect(seen.beacons()).toBe(0);
  });
}

test('clicking the chip of a PNG still opens the preview, and it is an image, not a document', async ({ page, context }) => {
  const seen = await serveDownloads(page);
  await page.goto('/probe');
  await page.addScriptTag({ content: apiBundle });
  const popup = context.waitForEvent('page');
  await page.evaluate(async () => {
    const api = (window as unknown as { ImcodesApi: { configure(base: string): void; previewAttachment(serverId: string, id: string, session?: string): Promise<void> } }).ImcodesApi;
    api.configure('');
    await api.previewAttachment('srv-1', 'png', 'deck_p_brain');
  });
  const opened = await popup;
  await opened.waitForLoadState();
  expect(await opened.evaluate(() => document.contentType)).toBe('image/png');
  expect(seen.beacons()).toBe(0);
});

test('CONTROL: the previous previewAttachment (blob: URL of the response, window.open) runs the SVG script on the app origin', async ({ page, context }) => {
  const seen = await serveDownloads(page);
  await page.goto('/probe');
  const popup = context.waitForEvent('page');
  await page.evaluate(async () => {
    const res = await fetch('/api/server/srv-1/uploads/svg/download');
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  });
  await popup;
  await expect.poll(() => seen.beacons(), { message: 'the old behaviour should have executed the SVG script' }).toBeGreaterThan(0);
});
