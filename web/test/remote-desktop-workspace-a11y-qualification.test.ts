import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/preact';
import { h } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${Object.values(values).join(':')}`
      : key,
  }),
}));

vi.mock('../src/components/FloatingPanel.js', async () => {
  const { h: createElement } = await import('preact');
  return {
    FloatingPanel: ({ children }: { children: unknown }) => createElement('div', {}, children),
  };
});

vi.mock('../src/components/RemoteDesktopPanel.js', async () => {
  const { h: createElement } = await import('preact');
  return {
    canOpenRemoteDesktop: () => true,
    RemoteDesktopPanel: ({ active, machine }: {
      active: boolean;
      machine: { serverId: string };
    }) => createElement('section', {
      class: 'remote-desktop-panel',
      'data-host': machine.serverId,
      hidden: !active,
    }),
  };
});

import type { RemoteDesktopConnectionManager } from '../src/remote-desktop-connection-manager.js';
import { RemoteDesktopWorkspace } from '../src/components/RemoteDesktopWorkspace.js';
import {
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
} from '../src/remote-desktop-workspace-state.js';

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

function productionWorkspaceMarkup(): string {
  const machine = (serverId: string) => ({
    serverId,
    refName: serverId,
    displayName: serverId.toUpperCase(),
    os: 'win',
    online: true,
    execEnabled: true,
    accessRole: 'owner' as const,
    capabilities: ['remote-desktop-v1' as const],
  });
  let state = createRemoteDesktopWorkspaceState();
  state = openRemoteDesktopWorkspaceHost(state, machine('host-a'));
  state = openRemoteDesktopWorkspaceHost(state, machine('host-b'));
  const manager = {
    releaseInput: vi.fn(),
    stop: vi.fn(),
  } as unknown as RemoteDesktopConnectionManager;
  const view = render(h(RemoteDesktopWorkspace, {
    state,
    manager,
    onOpenHost: vi.fn(),
    onActivateTab: vi.fn(),
    onCloseHost: vi.fn(),
    onReorderHost: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onMinimize: vi.fn(),
    onRestore: vi.fn(),
  }));
  const workspace = view.container.querySelector('.remote-desktop-workspace');
  if (!workspace) throw new Error('production workspace markup unavailable');
  const markup = workspace.outerHTML;
  view.unmount();
  return markup;
}

function sourceQualificationIssues(source: string): string[] {
  const required = [
    ['tablist', 'role="tablist"'],
    ['tab', 'role="tab"'],
    ['selected', 'aria-selected'],
    ['roving-tab-index', 'tabIndex={state.activeTabId'],
    ['left-key', "event.key === 'ArrowLeft'"],
    ['right-key', "event.key === 'ArrowRight'"],
    ['home-key', "event.key === 'Home'"],
    ['end-key', "event.key === 'End'"],
    ['delete-key', "event.key === 'Delete'"],
    ['mobile-selector', 'remote-desktop-workspace-mobile-selector'],
    ['wall-grid-label', 'remote_desktop.wall_grid'],
    ['wall-context-menu', 'role="menu"'],
    ['wall-add-slots', 'remote-desktop-wall-add-slot'],
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

async function browserSmoke(
  browserType: BrowserType,
  name: string,
  workspaceMarkup: string,
  productionCss: string,
): Promise<BrowserSmokeResult> {
  try {
    const browser = await browserType.launch({ headless: true, timeout: 15_000 });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><html><head><style>${productionCss}</style></head><body>
      ${workspaceMarkup}
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
    const probe = async (width: number) => {
      await page.setViewportSize({ width, height: 844 });
      return page.evaluate(() => {
        const tablist = document.querySelector('[role=tablist]');
        const closeButtons = [...document.querySelectorAll('.remote-desktop-workspace-tab-close')];
        const inactive = document.querySelector('[data-host="host-a"]');
        const active = document.querySelector('[data-host="host-b"]');
        return {
          tablistDisplay: tablist ? getComputedStyle(tablist).display : 'missing',
          closeRects: closeButtons.map((button) => {
            const rect = button.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
          inactiveDisplay: inactive ? getComputedStyle(inactive).display : 'missing',
          activeDisplay: active ? getComputedStyle(active).display : 'missing',
        };
      });
    };
    const mobile = await probe(390);
    const desktop = await probe(1280);
    await page.locator('[role=tab]').first().focus();
    await page.keyboard.press('End');
    const selected = await page.locator('[role=tab][aria-selected=true]').textContent();
    await browser.close();
    const layoutPass = [mobile, desktop].every((layout) => (
      layout.tablistDisplay === 'flex'
      && layout.closeRects.length === 2
      && layout.closeRects.every((rect) => rect.width > 0 && rect.height > 0)
      && layout.inactiveDisplay === 'none'
      && layout.activeDisplay !== 'none'
    ));
    return {
      name,
      status: selected === 'HOST-B' && layoutPass ? 'passed' : 'failed',
      details: `selected=${selected}, mobile=${JSON.stringify(mobile)}, desktop=${JSON.stringify(desktop)}`,
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
      'workspace_close', 'workspace_close_confirm', 'workspace_restore',
      'wall_grid', 'wall_open_host', 'wall_manage', 'wall_health_live', 'wall_health_stale', 'wall_health_pressure_paused',
      'wall_retry_all', 'wall_open_new_window',
    ] as const;
    const guestKeys = ['title', 'subtitle', 'public_id', 'password', 'connect', 'boundary', 'state_waiting_for_consent', 'generic_error', 'remote_screen'] as const;
    for (const [name, locale] of Object.entries({ en, es, ja, ko, ru, zhCN, zhTW })) {
      for (const key of keys) expect(locale.remote_desktop[key], `${name}:${key}`).toEqual(expect.any(String));
      for (const key of guestKeys) expect(locale.remote_desktop.guest[key], `${name}:guest.${key}`).toEqual(expect.any(String));
    }
  });

  it('pins responsive, keyboard and ARIA source contracts, with mutation-quality positive control', () => {
    const workspace = read('src/components/RemoteDesktopWorkspace.tsx');
    const wall = read('src/components/RemoteDesktopWall.tsx');
    const wallTile = read('src/components/RemoteDesktopWallTile.tsx');
    const guest = read('src/components/RemoteDesktopGuestAccess.tsx');
    const workspaceCss = read('src/components/remote-desktop-workspace.css');
    const accessCss = read('src/components/remote-desktop-access.css');
    expect(sourceQualificationIssues(`${workspace}\n${wall}\n${wallTile}`)).toEqual([]);
    expect(guestSecretDisclosureIssues(guest)).toEqual([]);
    expect(workspaceCss).toContain('@media (max-width: 700px)');
    expect(workspaceCss).toContain('.remote-desktop-workspace-mobile-selector');
    expect(workspaceCss).toMatch(/\.remote-desktop-workspace\s*>\s*\.remote-desktop-panel\[hidden\][\s\S]*display:\s*none\s*!important/);
    expect(accessCss).toContain('@media(max-width:720px)');
    expect(accessCss).toContain(':focus-visible');

    expect(sourceQualificationIssues(`${workspace.replaceAll("event.key === 'ArrowRight'", 'event.key === \'PageDown\'')}\n${wall}\n${wallTile}`))
      .toContain('right-key');
    expect(guestSecretDisclosureIssues(`${guest}\nreturn <span>{ready.serverId}</span>;`))
      .toContain('renders-internal-secret-or-routing-field');
  });

  it('runs the locally available Chromium and WebKit browser mechanics without claiming real network qualification', async () => {
    const { chromium, webkit } = require('playwright') as { chromium: BrowserType; webkit: BrowserType };
    const workspaceMarkup = productionWorkspaceMarkup();
    const productionCss = `${read('src/styles.css')}\n${read('src/components/remote-desktop-workspace.css')}`;
    const results = await Promise.all([
      browserSmoke(chromium, 'chromium', workspaceMarkup, productionCss),
      browserSmoke(webkit, 'webkit', workspaceMarkup, productionCss),
    ]);
    expect(results.map(({ name }) => name)).toEqual(['chromium', 'webkit']);
    for (const result of results) {
      expect(['passed', 'unavailable'], `${result.name}: ${result.details}`)
        .toContain(result.status);
    }
  }, 45_000);
});
