import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1280]) {
  test(`external URL icon copies the entire signed link without navigation at ${width}px`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const page = await context.newPage();
      await page.route('**/api/**', route => route.fulfill({ json: { pins: [], tasks: [], records: [] } }));
      await page.addInitScript(() => { localStorage.setItem('imcodes_lang', 'en'); });
      await page.goto('/src/fixtures/chat-timeline/index.html?size=smoke&rows=1');
      await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
      const url = 'https://example.com/%E6%96%87%E4%BB%B6.zip?X-Amz-Signature=' + 'abcdef'.repeat(160) + '&key=a%2Bb#download';
      await page.evaluate(text => (window as any).__chatTimelineHarness.setEvents([{
        eventId: 'external-copy', sessionId: 'fixture-window-0', type: 'assistant.text', ts: 1700000000000,
        seq: 1, epoch: 1, source: 'daemon', confidence: 'high', payload: { text },
      }]), url);
      await page.getByRole('link', { name: url, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Open External Link' });
      await expect(dialog).toBeVisible();
      const button = dialog.locator('.external-link-copy');
      await expect(button).toHaveText('');
      await expect(button).toHaveAccessibleName('Copy');
      if (width < 768) await button.tap(); else { await button.focus(); await page.keyboard.press('Enter'); }
      await expect(button).toHaveAccessibleName('Copied!');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
      await expect(dialog).toBeVisible();
      expect(page.url()).toContain('/src/fixtures/chat-timeline/index.html');
      const box = await dialog.evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth, rowScroll: el.querySelector('.external-link-url-row')!.scrollWidth, rowWidth: el.querySelector('.external-link-url-row')!.clientWidth, buttonWidth: el.querySelector('.external-link-copy')!.getBoundingClientRect().width }));
      expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
      expect(box.scroll).toBeLessThanOrEqual(box.client + 1); expect(box.rowScroll).toBeLessThanOrEqual(box.rowWidth + 1);
      expect(box.buttonWidth).toBe(40);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    } finally { await context.close(); }
  });
}
