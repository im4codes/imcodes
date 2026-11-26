/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
  <div id="root"></div>
</body>
</html>`;

describe('ask.question option clickability & real computed styles in Chromium', () => {
  it('applies distinct selected/hover/focus computed styles, visible indicators, stacked descriptions, and zero overflow across desktop & zoomed mobile', { timeout: 30000 }, async () => {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as typeof import('playwright');
    if (!existsSync(chromium.executablePath())) {
      return;
    }

    const { build } = require('esbuild') as typeof import('esbuild');
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(here, '..');
    const sharedDir = resolve(webDir, '../shared');
    const css = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');
    const chatViewPath = resolve(webDir, 'src/components/ChatView.tsx');
    const dialogPath = resolve(webDir, 'src/components/AskQuestionDialog.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { h, render } from 'preact';
          import { useState } from 'preact/hooks';
          import { ChatView } from ${JSON.stringify(chatViewPath)};
          import { AskQuestionDialog } from ${JSON.stringify(dialogPath)};

          window.__mountAskFixtures = () => {
            window.__submitted = [];
            const root = document.getElementById('root');
            const App = () => {
              const [modalOpen, setModalOpen] = useState(true);
              const events = [
                {
                  eventId: 'ask-answered',
                  sessionId: 'deck_proj_brain',
                  ts: 1700000000000,
                  seq: 1,
                  epoch: 1,
                  source: 'daemon',
                  confidence: 'high',
                  type: 'ask.question',
                  payload: {
                    toolUseId: 'tu-old',
                    questions: [{ header: 'Old', question: 'Done?', options: [{ label: 'Yes', description: 'Completed' }] }],
                  },
                },
                {
                  eventId: 'u-answered',
                  sessionId: 'deck_proj_brain',
                  ts: 1700000001000,
                  seq: 2,
                  epoch: 1,
                  source: 'user',
                  confidence: 'high',
                  type: 'user.message',
                  payload: { text: 'Yes' },
                },
                {
                  eventId: 'a-normal-msg',
                  sessionId: 'deck_proj_brain',
                  ts: 1700000001500,
                  seq: 3,
                  epoch: 1,
                  source: 'daemon',
                  confidence: 'high',
                  type: 'assistant.text',
                  payload: { text: 'Normal assistant message for touch positive control', streaming: false },
                },
                {
                  eventId: 'ask-pending',
                  sessionId: 'deck_proj_brain',
                  ts: 1700000002000,
                  seq: 3,
                  epoch: 1,
                  source: 'daemon',
                  confidence: 'high',
                  type: 'ask.question',
                  payload: {
                    toolUseId: 'tu-live',
                    questions: [
                      {
                        header: 'Target',
                        question: 'Where should we deploy?',
                        options: [
                          { label: 'Staging', description: 'Internal pre-release validation cluster' },
                          { label: 'Production', description: 'Customer-facing cluster with gradual rollout' },
                        ],
                      },
                      {
                        header: 'Checks',
                        question: 'Which checks should run?',
                        multiSelect: true,
                        options: [
                          { label: 'Unit', description: 'Fast component checks' },
                          { label: 'Browser', description: 'Real Chromium geometry check' },
                        ],
                      },
                    ],
                  },
                },
              ];
              return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh' } }, [
                h(ChatView, {
                  events,
                  loading: false,
                  onAskAnswer: (toolUseId, answer) => {
                    window.__submitted.push({ toolUseId, answer });
                    return true;
                  },
                }),
                modalOpen ? h(AskQuestionDialog, {
                  pending: {
                    sessionName: 'deck_proj_brain',
                    toolUseId: 'tu-modal',
                    waitMs: 300000,
                    questions: [{
                      header: 'Modal',
                      question: 'Choose modal option',
                      options: [
                        { label: 'Modal A', description: 'First modal choice' },
                        { label: 'Modal B', description: 'Second modal choice' },
                      ],
                    }],
                  },
                  onDismiss: () => setModalOpen(false),
                  onSubmit: (answer) => {
                    window.__submitted.push({ toolUseId: 'tu-modal', answer });
                    setModalOpen(false);
                  },
                }) : null,
              ]);
            };
            render(h(App, null), root);
          };
        `,
        resolveDir: webDir,
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      alias: { '@shared': sharedDir },
      plugins: [{
        name: 'stub-i18next',
        setup(b) {
          b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `export function useTranslation() { return { t: (k, o) => (o && typeof o.defaultValue === 'string' ? o.defaultValue : k), i18n: { language: 'en' } }; }`,
            loader: 'js',
          }));
        },
      }],
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('https://imcodes.ask.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: TEST_HTML }),
      );
      await page.goto('https://imcodes.ask.test/');
      await page.addStyleTag({ content: css });
      await page.evaluate(compiled.outputFiles[0].text);
      await page.evaluate(() => (window as unknown as { __mountAskFixtures: () => void }).__mountAskFixtures());

      // 1. Verify AskQuestionDialog modal option click changes computed border & background + stacks vertically
      const modalOptions = page.locator('.ask-dialog label.ask-option');
      await expect.poll(() => modalOptions.count()).toBe(2);
      const modalBefore = await modalOptions.nth(1).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { borderColor: cs.borderColor, backgroundColor: cs.backgroundColor };
      });
      await modalOptions.nth(1).locator('.ask-option-desc').click();
      let modalAfter!: {
        checked: boolean;
        hasClass: boolean;
        borderColor: string;
        backgroundColor: string;
        indicatorW: number;
        indicatorH: number;
        labelBottom: number;
        descTop: number;
      };
      await expect.poll(async () => {
        modalAfter = await modalOptions.nth(1).evaluate((el) => {
          const cs = getComputedStyle(el);
          const input = el.querySelector('input') as HTMLInputElement;
          const indicator = el.querySelector('.ask-option-indicator')!.getBoundingClientRect();
          const label = el.querySelector('.ask-option-label')!.getBoundingClientRect();
          const desc = el.querySelector('.ask-option-desc')!.getBoundingClientRect();
          return {
            checked: input.checked,
            hasClass: el.classList.contains('ask-option-selected'),
            borderColor: cs.borderColor,
            backgroundColor: cs.backgroundColor,
            indicatorW: indicator.width,
            indicatorH: indicator.height,
            labelBottom: label.bottom,
            descTop: desc.top,
          };
        });
        return modalAfter.checked
          && modalAfter.hasClass
          && modalAfter.borderColor !== modalBefore.borderColor
          && modalAfter.backgroundColor !== modalBefore.backgroundColor;
      }).toBe(true);
      expect(modalAfter.indicatorW).toBeGreaterThanOrEqual(12);
      expect(modalAfter.descTop).toBeGreaterThanOrEqual(modalAfter.labelBottom - 1);

      // Dismiss modal so inline timeline card is exposed
      await page.locator('.ask-dialog .ask-btn-cancel').click();
      await expect.poll(() => page.locator('.ask-dialog').count()).toBe(0);

      // 2. Verify answered/read-only card renders compactly with answer summary, zero option boxes, and non-interactive default cursor
      const roCard = page.locator('[data-event-id="ask-answered"]');
      const roInfo = await roCard.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          compact: el.classList.contains('ask-question-timeline-card-compact'),
          answered: el.classList.contains('ask-question-timeline-card-answered'),
          state: el.getAttribute('data-ask-state'),
          cursor: cs.cursor,
          bg: cs.backgroundColor,
          border: cs.borderColor,
          inputs: el.querySelectorAll('input').length,
          buttons: el.querySelectorAll('button').length,
          labels: el.querySelectorAll('label').length,
          indicators: el.querySelectorAll('.ask-option-indicator').length,
          options: el.querySelectorAll('.ask-question-timeline-option').length,
          answerText: el.querySelector('.ask-question-compact-answer')?.textContent?.trim() ?? '',
          text: el.textContent ?? '',
        };
      });
      expect(roInfo.compact).toBe(true);
      expect(roInfo.answered).toBe(true);
      expect(roInfo.state).toBe('answered');
      expect(roInfo.inputs).toBe(0);
      expect(roInfo.buttons).toBe(0);
      expect(roInfo.labels).toBe(0);
      expect(roInfo.indicators).toBe(0);
      expect(roInfo.options).toBe(0);
      expect(roInfo.cursor).toBe('default');
      expect(roInfo.answerText).toBe('Yes');
      expect(roInfo.text).not.toContain('Completed');

      await roCard.hover();
      await page.waitForTimeout(20);
      const roHover = await roCard.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, border: cs.borderColor };
      });
      expect(roHover).toEqual({ bg: roInfo.bg, border: roInfo.border });

      // 2b. Verify pending dock height is NOT artificially capped at min(46vh, 360px) on desktop:
      //     a >360px multi-question card fits at full natural height with Answer button unclipped and no inner scroll.
      const desktopDockMetrics = await page.locator('.chat-pending-ask-dock').evaluate((dock) => {
        const card = dock.querySelector('[data-event-id="ask-pending"]')!;
        const submit = dock.querySelector('button.ask-btn-submit')!;
        const dockRect = dock.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const submitRect = submit.getBoundingClientRect();
        return {
          dockHeight: dockRect.height,
          cardHeight: cardRect.height,
          scrollHeight: dock.scrollHeight,
          clientHeight: dock.clientHeight,
          submitVisibleInDock: submitRect.bottom <= dockRect.bottom + 2,
        };
      });
      expect(desktopDockMetrics.cardHeight).toBeGreaterThan(360);
      expect(desktopDockMetrics.dockHeight).toBeGreaterThan(360);
      expect(desktopDockMetrics.scrollHeight).toBeLessThanOrEqual(desktopDockMetrics.clientHeight + 2);
      expect(desktopDockMetrics.submitVisibleInDock).toBe(true);

      // 3. Verify interactive inline card: unselected vs hover vs selected computed styles + vertical stacking
      const inlineCard = page.locator('[data-event-id="ask-pending"]');
      const inlineOptions = inlineCard.locator('label.ask-question-timeline-option');
      const opt0 = inlineOptions.nth(0);
      const opt1 = inlineOptions.nth(1);

      const beforeSelect = await opt1.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { borderColor: cs.borderColor, backgroundColor: cs.backgroundColor };
      });

      await opt1.hover();
      await expect.poll(async () => {
        const onHover = await opt1.evaluate((el) => {
          const cs = getComputedStyle(el);
          return { borderColor: cs.borderColor, backgroundColor: cs.backgroundColor };
        });
        return onHover.borderColor !== beforeSelect.borderColor || onHover.backgroundColor !== beforeSelect.backgroundColor;
      }).toBe(true);

      // Click visible description of Production (option 1) and Browser (option 3)
      await opt1.locator('.ask-option-desc').click();
      await inlineOptions.nth(3).locator('.ask-option-label').click();

      let afterSelect!: {
        checked: boolean;
        hasClass: boolean;
        borderColor: string;
        backgroundColor: string;
        indBg: string;
        indW: number;
        indH: number;
        labelBottom: number;
        descTop: number;
      };
      await expect.poll(async () => {
        afterSelect = await opt1.evaluate((el) => {
          const cs = getComputedStyle(el);
          const input = el.querySelector('input') as HTMLInputElement;
          const indicator = el.querySelector('.ask-option-indicator')!;
          const indCs = getComputedStyle(indicator);
          const indRect = indicator.getBoundingClientRect();
          const labelRect = el.querySelector('.ask-option-label')!.getBoundingClientRect();
          const descRect = el.querySelector('.ask-option-desc')!.getBoundingClientRect();
          return {
            checked: input.checked,
            hasClass: el.classList.contains('ask-option-selected'),
            borderColor: cs.borderColor,
            backgroundColor: cs.backgroundColor,
            indBg: indCs.backgroundColor,
            indW: indRect.width,
            indH: indRect.height,
            labelBottom: labelRect.bottom,
            descTop: descRect.top,
          };
        });
        return afterSelect.checked
          && afterSelect.hasClass
          && afterSelect.borderColor !== beforeSelect.borderColor
          && afterSelect.backgroundColor !== beforeSelect.backgroundColor;
      }).toBe(true);
      expect(afterSelect.indW).toBeGreaterThanOrEqual(12);
      expect(afterSelect.indH).toBeGreaterThanOrEqual(12);
      expect(afterSelect.descTop).toBeGreaterThanOrEqual(afterSelect.labelBottom - 1);

      // Unselected option stays unselected
      const opt0State = await opt0.evaluate((el) => ({
        checked: (el.querySelector('input') as HTMLInputElement).checked,
        borderColor: getComputedStyle(el).borderColor,
        backgroundColor: getComputedStyle(el).backgroundColor,
      }));
      expect(opt0State.checked).toBe(false);
      expect(opt0State.borderColor).not.toBe(afterSelect.borderColor);

      // 4. Keyboard accessibility: Tab onto checkbox option input -> focus-visible outline + Space toggles
      await inlineCard.locator('input.ask-custom-input').first().focus();
      await page.keyboard.press('Tab');
      const focusedInfo = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const label = active?.closest('label.ask-option');
        return {
          tag: active?.tagName,
          type: (active as HTMLInputElement | null)?.type,
          labelFound: Boolean(label),
          outlineStyle: label ? getComputedStyle(label).outlineStyle : '',
          outlineWidth: label ? getComputedStyle(label).outlineWidth : '',
        };
      });
      expect(focusedInfo.tag).toBe('INPUT');
      expect(focusedInfo.type).toBe('checkbox');
      expect(focusedInfo.labelFound).toBe(true);
      expect(focusedInfo.outlineStyle).toBe('solid');
      expect(parseFloat(focusedInfo.outlineWidth)).toBeGreaterThanOrEqual(2);

      // Keyboard Space toggles focused multi-select option on & off cleanly
      await page.keyboard.press('Space');
      await page.waitForTimeout(20);
      expect(await inlineOptions.nth(2).evaluate((el) => (el.querySelector('input') as HTMLInputElement).checked)).toBe(true);
      await page.keyboard.press('Space');
      await page.waitForTimeout(20);
      expect(await inlineOptions.nth(2).evaluate((el) => (el.querySelector('input') as HTMLInputElement).checked)).toBe(false);

      // 5. Mobile 390x844 across 75%, 85%, 100% zoom: no horizontal overflow and dock stays unconstrained above 300px
      for (const zoom of [0.75, 0.85, 1]) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate((z) => {
          document.documentElement.style.zoom = String(z);
          document.documentElement.style.setProperty('--imcodes-ui-zoom', String(z));
        }, zoom);
        await page.waitForTimeout(30);
        const overflow = await page.evaluate(() => ({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 1);
        if (zoom === 1) {
          const mobileDock = await page.locator('.chat-pending-ask-dock').evaluate((dock) => {
            const submitRect = dock.querySelector('button.ask-btn-submit')!.getBoundingClientRect();
            const dockRect = dock.getBoundingClientRect();
            return {
              dockHeight: dockRect.height,
              scrollHeight: dock.scrollHeight,
              clientHeight: dock.clientHeight,
              submitVisible: submitRect.bottom <= dockRect.bottom + 2,
            };
          });
          expect(mobileDock.dockHeight).toBeGreaterThan(300);
          expect(mobileDock.scrollHeight).toBeLessThanOrEqual(mobileDock.clientHeight + 2);
          expect(mobileDock.submitVisible).toBe(true);
        }
      }

      // Extreme short viewport safety: dock shrinks inside .chat-main (never clipped past bottom) and scrolls cleanly
      await page.setViewportSize({ width: 1280, height: 260 });
      await page.waitForTimeout(30);
      const shortDock = await page.evaluate(() => {
        const main = document.querySelector('.chat-main')!.getBoundingClientRect();
        const dock = document.querySelector('.chat-pending-ask-dock')!;
        const dockRect = dock.getBoundingClientRect();
        return {
          dockH: dockRect.height,
          mainH: main.height,
          dockBottom: dockRect.bottom,
          mainBottom: main.bottom,
          scrollable: dock.scrollHeight > dock.clientHeight,
        };
      });
      expect(shortDock.dockH).toBeLessThanOrEqual(shortDock.mainH + 2);
      expect(shortDock.dockBottom).toBeLessThanOrEqual(shortDock.mainBottom + 2);
      expect(shortDock.scrollable).toBe(true);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(30);

      // Submit inline answer and verify payload + instant transition into compact non-interactive answered card
      await inlineCard.locator('button.ask-btn-submit').click();
      await expect.poll(() => page.locator('.chat-pending-ask-dock').count()).toBe(0);
      const submitted = await page.evaluate(() => (window as unknown as { __submitted: unknown[] }).__submitted);
      expect(submitted).toEqual([
        { toolUseId: 'tu-live', answer: '[Target] Production\n[Checks] Browser' },
      ]);
      const settledInfo = await page.locator('.chat-view [data-event-id="ask-pending"]').evaluate((el) => ({
        compact: el.classList.contains('ask-question-timeline-card-compact'),
        answered: el.classList.contains('ask-question-timeline-card-answered'),
        interactive: el.classList.contains('ask-question-timeline-card-interactive'),
        state: el.getAttribute('data-ask-state'),
        cursor: getComputedStyle(el).cursor,
        inputs: el.querySelectorAll('input').length,
        buttons: el.querySelectorAll('button').length,
        labels: el.querySelectorAll('label').length,
        options: el.querySelectorAll('.ask-question-timeline-option').length,
        height: el.getBoundingClientRect().height,
        answerText: el.querySelector('.ask-question-compact-answer')?.textContent?.trim() ?? '',
      }));
      expect(settledInfo.compact).toBe(true);
      expect(settledInfo.answered).toBe(true);
      expect(settledInfo.interactive).toBe(false);
      expect(settledInfo.state).toBe('answered');
      expect(settledInfo.cursor).toBe('default');
      expect(settledInfo.inputs).toBe(0);
      expect(settledInfo.buttons).toBe(0);
      expect(settledInfo.labels).toBe(0);
      expect(settledInfo.options).toBe(0);
      expect(settledInfo.height).toBeLessThan(desktopDockMetrics.cardHeight);
      expect(settledInfo.answerText).toBe('[Target] Production\n[Checks] Browser');

      // 6. Coarse-pointer touch Chromium context: 540ms+ long-press on normal message opens .chat-sel-menu,
      //    while long-press on interactive ask option does NOT open .chat-sel-menu or highlight, and tap selects cleanly.
      const touchCtx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
      try {
        const touchPage = await touchCtx.newPage();
        await touchPage.route('https://imcodes.ask.test/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: TEST_HTML }),
        );
        await touchPage.goto('https://imcodes.ask.test/');
        await touchPage.addStyleTag({ content: css });
        await touchPage.evaluate(compiled.outputFiles[0].text);
        await touchPage.evaluate(() => (window as unknown as { __mountAskFixtures: () => void }).__mountAskFixtures());
        await touchPage.locator('.ask-dialog .ask-btn-cancel').click();
        await expect.poll(() => touchPage.locator('.ask-dialog').count()).toBe(0);

        const triggerTouchHold = async (selector: string) => {
          await touchPage.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            const r = el.getBoundingClientRect();
            const pt = new Touch({
              identifier: 1,
              target: el,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
            });
            el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [pt], targetTouches: [pt], changedTouches: [pt] }));
          }, selector);
          await touchPage.waitForTimeout(560);
        };

        // Positive control: normal assistant message opens .chat-sel-menu + .chat-highlight
        await triggerTouchHold('[data-event-id="a-normal-msg"]');
        expect(await touchPage.locator('.chat-sel-menu').count()).toBe(1);
        expect(await touchPage.locator('.chat-highlight').count()).toBe(1);

        // Dismiss by clicking outside, then test long-press on interactive ask option
        await touchPage.reload();
        await touchPage.addStyleTag({ content: css });
        await touchPage.evaluate(compiled.outputFiles[0].text);
        await touchPage.evaluate(() => (window as unknown as { __mountAskFixtures: () => void }).__mountAskFixtures());
        await touchPage.locator('.ask-dialog .ask-btn-cancel').click();
        await expect.poll(() => touchPage.locator('.ask-dialog').count()).toBe(0);

        await triggerTouchHold('[data-event-id="ask-pending"] label.ask-question-timeline-option:nth-of-type(2) .ask-option-label');
        expect(await touchPage.locator('.chat-sel-menu').count()).toBe(0);
        expect(await touchPage.locator('.chat-highlight').count()).toBe(0);

        // Real touch tap still selects Production and submits cleanly
        await touchPage.locator('[data-event-id="ask-pending"] label.ask-question-timeline-option').nth(1).tap();
        await touchPage.waitForTimeout(30);
        expect(
          await touchPage.locator('[data-event-id="ask-pending"] label.ask-question-timeline-option').nth(1).evaluate((el) => ({
            checked: (el.querySelector('input') as HTMLInputElement).checked,
            selected: el.classList.contains('ask-option-selected'),
          })),
        ).toEqual({ checked: true, selected: true });
      } finally {
        await touchCtx.close();
      }
    } finally {
      await browser.close();
    }
  });
});
