import { expect, test, type Locator, type Page } from '@playwright/test';

const MAIN_FIXTURE_URL = '/src/fixtures/chat-timeline/index.html?mobileImageTap=1';
const SUBBAR_FIXTURE_URL = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&subBar=1';

async function openFixture(page: Page, url: string, options: { enableVoiceSpeech: boolean; lang?: string }) {
  await page.route('**/api/**', (route) => route.fulfill({ json: { tasks: [], records: [], entries: [], pins: [], aliases: [], machines: [] } }));
  await page.addInitScript(({ withSpeech, lang }) => {
    localStorage.setItem('imcodes_lang', lang);
    if (withSpeech) {
      (window as any).webkitSpeechRecognition = function MockSpeechRecognition() {};
    } else {
      delete (window as any).webkitSpeechRecognition;
      delete (window as any).SpeechRecognition;
    }
  }, { withSpeech: options.enableVoiceSpeech, lang: options.lang ?? 'en' });
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}

async function expectSingleLineControls(controlsRoot: Locator) {
  await expect(controlsRoot).not.toHaveClass(/controls-mobile-multiline/);
  await expect(controlsRoot.locator('.btn-attachment-embedded')).toBeVisible();
  await expect(controlsRoot.locator('.btn-attachment-mobile-stacked')).toHaveCount(0);
  await expect(controlsRoot.locator('.btn-input-expand-floating')).toHaveCount(0);
}

async function expectMultilineControls(controlsRoot: Locator) {
  await expect(controlsRoot).toHaveClass(/controls-mobile-multiline/);
  await expect(controlsRoot.locator('.btn-attachment-embedded')).toHaveCount(0);
  await expect(controlsRoot.locator('.btn-attachment-mobile-stacked')).toBeVisible();
  await expect(controlsRoot.locator('.btn-input-expand-floating')).toBeVisible();
}

for (const width of [320, 390, 430]) {
  for (const enableVoiceSpeech of [true, false]) {
    test(`mobile ${width}px empty/single-line stays embedded (voiceAvailable=${enableVoiceSpeech})`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({
        baseURL,
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await openFixture(page, MAIN_FIXTURE_URL, { enableVoiceSpeech, lang: 'zh' });
        const controls = page.locator('.controls');
        const composer = page.locator('.controls-input');

        await expectSingleLineControls(controls);

        await composer.tap();
        await expectSingleLineControls(controls);

        await page.keyboard.type('hi 世界 😀');
        await expectSingleLineControls(controls);
      } finally {
        await context.close();
      }
    });
  }
}

test('mobile 390x844: edge typing does not oscillate, 2 lines stacks attachment, send/delete restores embedded', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await openFixture(page, MAIN_FIXTURE_URL, { enableVoiceSpeech: true, lang: 'en' });
    const controls = page.locator('.controls');
    const composer = page.locator('.controls-input');

    await expectSingleLineControls(controls);
    await composer.tap();

    // Type single characters across the right-edge wrap boundary and assert
    // monotonic transition (single-line -> multiline) with zero ping-pong.
    let sawMultiline = false;
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
      await page.keyboard.type(ch);
      const isMulti = await controls.evaluate((el) => el.classList.contains('controls-mobile-multiline'));
      if (sawMultiline) {
        expect(isMulti).toBe(true);
      }
      if (isMulti) {
        sawMultiline = true;
      }
    }
    expect(sawMultiline).toBe(true);
    await expectMultilineControls(controls);

    // Deleting back to genuinely 1-line text restores embedded attachment.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Backspace');
    }
    await expectSingleLineControls(controls);

    // Explicit newline promotes to multiline; sending (Enter -> clearComposerState)
    // restores embedded attachment and keeps Hold to talk single-line.
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line 2');
    await expectMultilineControls(controls);

    await page.keyboard.press('Enter');
    await expect(composer).toHaveText('');
    await expectSingleLineControls(controls);

    // Expand multiline composer, clear all text inside fullscreen view, and collapse:
    // collapsed composer must recover single-line embedded state.
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    await expectMultilineControls(controls);

    await controls.locator('.btn-input-expand-floating').click();
    await expect(page.locator('.controls-composer-mobile-expanded')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.locator('.controls-wrapper-mobile-expanded .btn-input-expand-floating').click();
    await expect(page.locator('.controls-composer-mobile-expanded')).toHaveCount(0);
    await expectSingleLineControls(controls);
  } finally {
    await context.close();
  }
});

test('mobile subcard compact composer stays embedded on empty/1-line, stacks on 2 lines, restores after send', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await openFixture(page, SUBBAR_FIXTURE_URL, { enableVoiceSpeech: true, lang: 'en' });
    const subcardControls = page.locator('.subcard .controls').first();
    const subcardComposer = subcardControls.locator('.controls-input');

    await expectSingleLineControls(subcardControls);
    await subcardComposer.tap();
    await page.keyboard.type('one line');
    await expectSingleLineControls(subcardControls);

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('two lines');
    await expectMultilineControls(subcardControls);

    await page.keyboard.press('Enter');
    await expect(subcardComposer).toHaveText('');
    await expectSingleLineControls(subcardControls);
  } finally {
    await context.close();
  }
});

test('desktop > 640px keeps mobileComposerMultiline disabled even with multiline text', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
  });
  try {
    const page = await context.newPage();
    await openFixture(page, MAIN_FIXTURE_URL, { enableVoiceSpeech: false, lang: 'en' });
    const controls = page.locator('.controls');
    const composer = page.locator('.controls-input');

    await composer.click();
    await page.keyboard.type('line 1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line 2');

    await expect(controls).not.toHaveClass(/controls-mobile-multiline/);
    await expect(controls.locator('.btn-attachment-mobile-stacked')).toHaveCount(0);
    await expect(controls.locator('.btn-input-expand-floating')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
