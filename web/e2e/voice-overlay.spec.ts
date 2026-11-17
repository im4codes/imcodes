import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('imcodes_lang', 'en');
    class Speech {
      static latest: Speech;
      onresult?: (event: unknown) => void;
      onend?: () => void;
      start() { Speech.latest = this; }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: Speech });
    // No real microphone or ASR: only the native browser event/DOM/CSS path is under test.
    Object.assign(window, {
      emitSpeech: (text: string) => Speech.latest.onresult?.({ results: [{ 0: { transcript: text }, isFinal: false }] }),
    });
  });
});
const fixture = '/src/fixtures/voice-overlay/index.html';

test('touch capture release toggles once, one status and animated masked ring, keyboard viewport stays usable', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture);
  const status = page.locator('.voice-overlay-status');
  await expect(status).toContainText('Listening');
  const mic = page.locator('.voice-overlay-mic');
  await mic.tap();
  await expect(status).toContainText('Tap the microphone');
  // Replay the reported WebKit ordering in a real browser; not an iOS device claim.
  // Use an actual active pointer so setPointerCapture does not fail on a
  // synthetic pointerdown with no browser-owned pointer.
  await page.waitForTimeout(400);
  const micBox = await mic.boundingBox();
  await page.mouse.move(micBox!.x + micBox!.width / 2, micBox!.y + micBox!.height / 2);
  await page.mouse.down();
  await mic.dispatchEvent('lostpointercapture', { pointerId: 1 });
  await page.mouse.up();
  await expect(status).toContainText('Listening');
  await page.evaluate(() => (window as unknown as { emitSpeech(text: string): void }).emitSpeech('COMMIT GITHUB is legitimate spoken text'));
  await expect(status).toContainText('Recognizing');
  await expect(page.locator('.voice-overlay-status [role="status"]')).toHaveCount(1);
  await expect(page.locator('.voice-overlay-buffering, .voice-recognizing-pill')).toHaveCount(0);
  await expect(page.locator('.voice-overlay-text')).toHaveValue('COMMIT GITHUB is legitimate spoken text');
  const active = page.locator('.voice-editor-marquee');
  await expect(active).toHaveCount(1);
  const before = await active.evaluate(el => getComputedStyle(el, '::before').getPropertyValue('--voice-ring-angle'));
  await page.waitForTimeout(120);
  const after = await active.evaluate(el => getComputedStyle(el, '::before').getPropertyValue('--voice-ring-angle'));
  expect(after).not.toBe(before);
  expect(await active.evaluate(el => getComputedStyle(el, '::before').backgroundImage)).toContain('conic-gradient');
  expect(await page.locator('.voice-overlay-backdrop').evaluate(el => getComputedStyle(el).backdropFilter)).toContain('blur');
  await page.screenshot({ path: testInfo.outputPath('voice-listening.png') });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 390 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.voice-overlay')).toHaveCSS('height', '390px');
  const send = await page.locator('.voice-overlay-send').boundingBox();
  expect(send!.y + send!.height).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('voice-keyboard.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await active.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  await mic.tap();
  await expect(page.locator('.voice-editor-marquee')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('edit opening is ready, not paused; real hold and release drains once without send', async ({ page }) => {
  await page.goto(`${fixture}?edit`);
  await expect(page.locator('.voice-overlay-status')).toContainText('Tap the microphone');
  const mic = page.locator('.voice-overlay-mic');
  const box = await mic.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(page.locator('.voice-overlay-status')).toContainText('Listening');
  await page.mouse.up();
  await expect(page.locator('.voice-overlay-status')).toContainText('Tap the microphone');
  await expect(page.locator('output')).toBeEmpty();
});
