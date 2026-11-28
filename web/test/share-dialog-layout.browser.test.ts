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

describe('ShareSessionDialog mobile 375x667 & desktop layout in Chromium', () => {
  it('keeps Russian warning cleanly wrapped and submit button visible on initial render (375x667)', { timeout: 35000 }, async () => {
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
    const ruJson = JSON.parse(readFileSync(resolve(webDir, 'src/i18n/locales/ru.json'), 'utf8'));
    const dialogPath = resolve(webDir, 'src/components/ShareSessionDialog.tsx');

    const compiled = await build({
      stdin: {
        contents: `
          import { h, render } from 'preact';
          import { useState } from 'preact/hooks';
          import { ShareSessionDialog } from ${JSON.stringify(dialogPath)};

          window.__mountShareDialog = (props = {}) => {
            const root = document.getElementById('root');
            const defaultTarget = {
              serverId: 'srv-1',
              serverLabel: 'Сервер разработки',
              sessionName: 'main-session',
              tabLabel: 'Вкладка 1',
            };
            const App = () => {
              const [open, setOpen] = useState(true);
              if (!open) return null;
              return h(ShareSessionDialog, {
                target: defaultTarget,
                onClose: () => setOpen(false),
                ...props,
              });
            };
            render(h(App), root);
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
      plugins: [
        {
          name: 'stub-modules',
          setup(b) {
            b.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'react-i18next', namespace: 'stub-i18n' }));
            b.onLoad({ filter: /.*/, namespace: 'stub-i18n' }, () => {
              return {
                contents: `
                  const ru = ${JSON.stringify(ruJson)};
                  function lookup(obj, path) {
                    const parts = path.split('.');
                    let cur = obj;
                    for (const p of parts) {
                      if (!cur || typeof cur !== 'object') return path;
                      cur = cur[p];
                    }
                    return typeof cur === 'string' ? cur : path;
                  }
                  export function useTranslation() {
                    return {
                      t: (k, vars) => {
                        let res = lookup(ru, k);
                        if (vars) {
                          for (const [vKey, vVal] of Object.entries(vars)) {
                            res = res.replace(new RegExp('{{' + vKey + '}}', 'g'), String(vVal));
                          }
                        }
                        return res;
                      },
                      i18n: { language: 'ru' },
                    };
                  }
                `,
                loader: 'js',
              };
            });

            b.onResolve({ filter: /RemoteDesktopOwnerAccess(\.js)?$/ }, () => ({ path: 'RemoteDesktopOwnerAccess', namespace: 'stub-rdp' }));
            b.onLoad({ filter: /.*/, namespace: 'stub-rdp' }, () => ({
              contents: `export function RemoteDesktopOwnerAccess() { return null; }`,
              loader: 'js',
              resolveDir: webDir,
            }));

            b.onResolve({ filter: /api(\.js)?$/ }, (args) => {
              if (args.importer.includes('ShareSessionDialog')) {
                return { path: 'api', namespace: 'stub-api' };
              }
            });
            b.onLoad({ filter: /.*/, namespace: 'stub-api' }, () => ({
              contents: `
                export class ApiError extends Error {}
                export async function listSharesForTarget() { return []; }
                export async function createShare() { return { id: 'sh-1', targetUserId: 'u1', role: 'viewer', status: 'active' }; }
                export async function updateShare() { return { id: 'sh-1', role: 'participant' }; }
                export async function revokeShare() { return { id: 'sh-1', status: 'revoked' }; }
              `,
              loader: 'js',
              resolveDir: webDir,
            }));
          },
        },
      ],
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
      await page.route('https://imcodes.share.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: TEST_HTML }),
      );
      await page.goto('https://imcodes.share.test/');
      await page.addStyleTag({ content: css });
      await page.evaluate(compiled.outputFiles[0].text);
      await page.evaluate(() => (window as unknown as { __mountShareDialog: () => void }).__mountShareDialog());

      // 1. Verify warning is present and wraps cleanly within mobile width
      const warning = page.locator('[data-testid="share-security-warning"]');
      await expect.poll(() => warning.count()).toBe(1);
      const warningRect = await warning.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, top: r.top, bottom: r.bottom, text: el.textContent };
      });
      expect(warningRect.width).toBeLessThanOrEqual(375);
      expect(warningRect.height).toBeGreaterThan(60); // Wrapped Russian text
      expect(warningRect.text).toContain('Предупреждение высокого риска: Совместная работа позволяет участникам напрямую использовать Shell');

      // 2. Verify Submit button is visible on initial render (rect.bottom <= 667)
      const submitBtn = page.locator('.ask-dialog .ask-btn-submit');
      await expect.poll(() => submitBtn.count()).toBe(1);
      const submitRect = await submitBtn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, disabled: (el as HTMLButtonElement).disabled };
      });
      expect(submitRect.bottom).toBeLessThanOrEqual(667);
      expect(submitRect.top).toBeGreaterThanOrEqual(0);
      expect(submitRect.height).toBeGreaterThan(20);
      expect(submitRect.disabled).toBe(true);

      // 3. Fill recipient input
      const input = page.locator('#share-target-user');
      await input.fill('developer@example.com');
      const submitAfterFill = await submitBtn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, disabled: (el as HTMLButtonElement).disabled };
      });
      expect(submitAfterFill.disabled).toBe(false);
      expect(submitAfterFill.bottom).toBeLessThanOrEqual(667);

      // 4. Toggle target radio to Whole server
      const radios = page.locator('.share-choice input[type="radio"]');
      await radios.nth(1).check(); // "Весь сервер"
      const warningServer = await warning.evaluate((el) => el.textContent);
      expect(warningServer).toContain('Предупреждение высокого риска: Совместная работа на этом компьютере/сервере');

      // Submit button must remain visible
      const submitAfterToggle = await submitBtn.evaluate((el) => el.getBoundingClientRect().bottom);
      expect(submitAfterToggle).toBeLessThanOrEqual(667);

      // Select participant role: panel scrolls if needed, actions stay pinned, warning escalates
      const participantRadio = page.locator('.share-choice input[type="radio"][value="participant"], .share-choice:has-text("Участник") input, .share-choice input').nth(3);
      await participantRadio.check();
      const trustDisclosure = page.locator('.share-trust-disclosure');
      await expect.poll(() => trustDisclosure.count()).toBe(1);
      expect(await warning.evaluate((el) => el.classList.contains('is-participant'))).toBe(true);

      // Verify submit button is still visible above the fold
      const submitWithTrust = await submitBtn.evaluate((el) => el.getBoundingClientRect().bottom);
      expect(submitWithTrust).toBeLessThanOrEqual(667);

      // Verify panel is scrollable when content overflows
      const panelScroll = await page.locator('.share-dialog-panel').evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(panelScroll.overflowY).toBe('auto');

      // 5. Test desktop viewport (1280x800)
      await page.setViewportSize({ width: 1280, height: 800 });
      const desktopSubmit = await submitBtn.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      expect(desktopSubmit.bottom).toBeLessThanOrEqual(800);
      const dialogWidth = await page.locator('.share-dialog').evaluate((el) => el.getBoundingClientRect().width);
      expect(dialogWidth).toBeLessThanOrEqual(520);
    } finally {
      await browser.close();
    }
  });
});
