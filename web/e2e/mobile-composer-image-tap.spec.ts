import { expect, test, type Page } from '@playwright/test';

const URL = '/src/fixtures/chat-timeline/index.html?mobileImageTap=1';

async function openFixture(page: Page, enableVoiceSpeech: boolean) {
  await page.route('**/api/**', (route) => route.fulfill({ json: { tasks: [], records: [], entries: [], pins: [], aliases: [], machines: [] } }));
  await page.addInitScript((withSpeech: boolean) => {
    localStorage.setItem('imcodes_lang', 'en');
    if (withSpeech) {
      (window as any).webkitSpeechRecognition = function MockSpeechRecognition() {};
    } else {
      delete (window as any).webkitSpeechRecognition;
      delete (window as any).SpeechRecognition;
    }
  }, enableVoiceSpeech);
  await page.goto(URL);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}

for (const enableVoiceSpeech of [true, false]) {
  test(`mobile touch: tapping unfocused .controls-input after image preview shifts layout without opening ImageLightbox (voiceAvailable=${enableVoiceSpeech})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    });
    try {
      const page = await context.newPage();
      await openFixture(page, enableVoiceSpeech);

      const composer = page.locator('.controls-input');
      const img = page.locator('.chat-local-image-preview-img');
      const subBar = page.locator('.subcard-bar');

      await expect(composer).toBeVisible();
      await expect(img).toBeVisible();
      await expect(subBar).toBeVisible();
      await expect(composer).toHaveAttribute('contenteditable', enableVoiceSpeech ? 'false' : 'true');

      const tapBox = (await composer.boundingBox())!;
      const tapY = tapBox.y + tapBox.height / 2;

      // Real touch tap on the unfocused composer -> triggers .input-focused, collapses .subcard-bar/.session-usage-footer,
      // and shifts the bottom image into the original tap coordinates.
      await composer.tap();

      await expect(page.locator('html')).toHaveClass(/input-focused/);
      expect(await subBar.evaluate((el) => getComputedStyle(el).display)).toBe('none');

      const shiftedImgBox = (await img.boundingBox())!;
      expect(tapY).toBeGreaterThanOrEqual(shiftedImgBox.y);
      expect(tapY).toBeLessThanOrEqual(shiftedImgBox.y + shiftedImgBox.height);

      // Compatibility click under the tap point must NOT open ImageLightbox and composer must stay focused & editable
      await expect(page.locator('.fb-lightbox')).toHaveCount(0);
      expect(await composer.evaluate((el) => document.activeElement === el)).toBe(true);
      await expect(composer).toHaveAttribute('contenteditable', 'true');

      await page.keyboard.type('hello mobile');
      await expect(composer).toContainText('hello mobile');

      // Positive control: genuinely tapping the image afterwards opens ImageLightbox
      await img.tap();
      await expect(page.locator('.fb-lightbox')).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
