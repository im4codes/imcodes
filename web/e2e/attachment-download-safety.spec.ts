import { expect, test, type Page, type Route } from '@playwright/test';
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
  await page.route('**/beacon/**', async (route) => { beacons += 1; await route.fulfill({ status: 204 }); });
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
