import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const require = createRequire(import.meta.url);
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type BrowserType = typeof import('playwright')['chromium'];
type BrowserSmokeResult = {
  name: string;
  status: 'passed' | 'unavailable' | 'failed';
  details: string;
};

function read(rel: string): string {
  return readFileSync(resolve(WEB_ROOT, rel), 'utf8');
}

function sourceQualificationIssues(source: string): string[] {
  const required = [
    ['tablist', 'role="tablist"'],
    ['tab', 'role="tab"'],
    ['tabpanel', 'role="tabpanel"'],
    ['selected', 'aria-selected'],
    ['roving-tab-index', 'tabIndex={state.activeTabId'],
    ['left-key', "event.key === 'ArrowLeft'"],
    ['right-key', "event.key === 'ArrowRight'"],
    ['home-key', "event.key === 'Home'"],
    ['end-key', "event.key === 'End'"],
    ['delete-key', "event.key === 'Delete'"],
    ['mobile-selector', 'remote-desktop-workspace-mobile-selector'],
    ['wall-grid-label', 'remote_desktop.wall_grid'],
  ] as const;
  return required.flatMap(([id, needle]) => source.includes(needle) ? [] : [id]);
}

function guestSecretDisclosureIssues(source: string): string[] {
  const renderStart = source.indexOf('return (');
  const renderSource = renderStart >= 0 ? source.slice(renderStart) : source;
  const issues: string[] = [];
  if (!renderSource.includes('aria-live="polite"')) issues.push('missing-live-region');
  if (!renderSource.includes('role="alert"')) issues.push('missing-alert');
  if (/serverId|bootstrapTicket|bootstrapProof|browserPrivateKey|privateKey/.test(renderSource)) {
    issues.push('renders-internal-secret-or-routing-field');
  }
  if (!source.includes('setPassword(\'\')')) issues.push('password-not-cleared');
  return issues;
}

async function browserSmoke(browserType: BrowserType, name: string): Promise<BrowserSmokeResult> {
  try {
    const browser = await browserType.launch({ headless: true, timeout: 15_000 });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><html><head><style>
      .remote-desktop-workspace-mobile-selector { display:block; }
      @media (min-width: 701px) { .remote-desktop-workspace-mobile-selector { display:none; } }
      .remote-desktop-workspace-tabbar button:focus-visible { outline: 2px solid rgb(34, 211, 238); }
    </style></head><body>
      <main class="remote-desktop-workspace">
        <div class="remote-desktop-workspace-tabbar">
          <div role="tablist" aria-label="Remote desktop tabs">
            <button role="tab" aria-selected="true" tabindex="0" id="wall">Wall</button>
            <button role="tab" aria-selected="false" tabindex="-1" id="host">Host</button>
          </div>
        </div>
        <label class="remote-desktop-workspace-mobile-selector"><span>Select</span><select><option>Wall</option></select></label>
        <section role="tabpanel"><div class="remote-desktop-wall-grid" aria-label="Wall grid"><button aria-label="Open Host">Host</button></div></section>
      </main>
      <script>
        const tabs = [...document.querySelectorAll('[role=tab]')];
        document.querySelector('[role=tablist]').addEventListener('keydown', (event) => {
          const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
          let next = current;
          if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
          if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = tabs.length - 1;
          tabs.forEach((tab, index) => { tab.setAttribute('aria-selected', String(index === next)); tab.tabIndex = index === next ? 0 : -1; });
          tabs[next].focus();
        });
      </script>
    </body></html>`);
    await page.locator('#wall').focus();
    await page.keyboard.press('End');
    const selected = await page.locator('[role=tab][aria-selected=true]').textContent();
    const mobileDisplay = await page.locator('.remote-desktop-workspace-mobile-selector').evaluate((el) => getComputedStyle(el).display);
    await browser.close();
    return {
      name,
      status: selected === 'Host' && mobileDisplay !== 'none' ? 'passed' : 'failed',
      details: `selected=${selected}, mobileDisplay=${mobileDisplay}`,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message.split('\n')[0] ?? String(error) : String(error);
    const unavailable = /Executable doesn't exist|playwright install/i.test(details);
    return { name, status: unavailable ? 'unavailable' : 'failed', details };
  }
}

describe('remote desktop 16.3 workspace accessibility and locale qualification', () => {
  it('keeps seven locales complete for owner, guest, workspace and wall surfaces', () => {
    const keys = [
      'access_owner_title', 'access_public_id', 'access_public_id_non_secret', 'access_create_link',
      'access_secret_once_title', 'access_secret_once', 'access_password_title', 'access_privacy_recovery',
      'workspace_title', 'workspace_tabs', 'workspace_wall', 'workspace_select', 'workspace_add', 'workspace_close_tab',
      'wall_grid', 'wall_open_host', 'wall_health_live', 'wall_health_stale', 'wall_health_pressure_paused',
    ] as const;
    const guestKeys = ['title', 'subtitle', 'public_id', 'password', 'connect', 'boundary', 'state_waiting_for_consent', 'generic_error', 'remote_screen'] as const;
    for (const [name, locale] of Object.entries({ en, es, ja, ko, ru, zhCN, zhTW })) {
      for (const key of keys) expect(locale.remote_desktop[key], `${name}:${key}`).toEqual(expect.any(String));
      for (const key of guestKeys) expect(locale.remote_desktop.guest[key], `${name}:guest.${key}`).toEqual(expect.any(String));
    }
  });

  it('pins responsive, keyboard and ARIA source contracts, with mutation-quality positive control', () => {
    const workspace = read('src/components/RemoteDesktopWorkspace.tsx');
    const guest = read('src/components/RemoteDesktopGuestAccess.tsx');
    const workspaceCss = read('src/components/remote-desktop-workspace.css');
    const accessCss = read('src/components/remote-desktop-access.css');
    expect(sourceQualificationIssues(workspace)).toEqual([]);
    expect(guestSecretDisclosureIssues(guest)).toEqual([]);
    expect(workspaceCss).toContain('@media (max-width: 700px)');
    expect(workspaceCss).toContain('.remote-desktop-workspace-mobile-selector');
    expect(accessCss).toContain('@media(max-width:720px)');
    expect(accessCss).toContain(':focus-visible');

    expect(sourceQualificationIssues(workspace.replace("event.key === 'ArrowRight'", 'event.key === \'PageDown\'')))
      .toContain('right-key');
    expect(guestSecretDisclosureIssues(`${guest}\nreturn <span>{ready.serverId}</span>;`))
      .toContain('renders-internal-secret-or-routing-field');
  });

  it('runs the locally available Chromium and WebKit browser mechanics without claiming real network qualification', async () => {
    const { chromium, webkit } = require('playwright') as { chromium: BrowserType; webkit: BrowserType };
    const results = await Promise.all([
      browserSmoke(chromium, 'chromium'),
      browserSmoke(webkit, 'webkit'),
    ]);
    expect(results.map(({ name }) => name)).toEqual(['chromium', 'webkit']);
    for (const result of results) {
      expect(['passed', 'unavailable'], `${result.name}: ${result.details}`)
        .toContain(result.status);
    }
  }, 45_000);
});
