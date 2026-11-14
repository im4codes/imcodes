/** @vitest-environment jsdom */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedStateIndicator } from '../src/components/SharedStateIndicator.js';
import { ServerIconBar } from '../src/components/ServerIconBar.js';
import { MobileServerMenu } from '../src/components/MobileServerMenu.js';
import { MobileSharedEntriesMenu } from '../src/components/MobileSharedEntriesMenu.js';
import { SharedEntriesPanel } from '../src/components/SharedEntriesPanel.js';
import {
  projectUnifiedServerList,
  filterRestrictedSharedEntries,
  type UnifiedServerItem,
} from '../src/unified-server-projection.js';
import type { SharedEntrySummary } from '../src/api.js';

const require = createRequire(import.meta.url);
const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'share.indicatorSharedIn') return 'Shared with me';
      if (key === 'share.indicatorSharedOut') return 'Shared with others';
      if (key === 'sidebar.serverNav') return 'Server Navigation';
      if (key === 'session.pinned') return 'Pinned';
      if (key === 'share.sharedWithMe.title') return 'Shared with me';
      if (options?.defaultValue && typeof options.defaultValue === 'string') return options.defaultValue;
      return key;
    },
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SharedStateIndicator variants', () => {
  it('renders distinct SVG bent return arrow and title for shared-in variant', () => {
    const { container } = render(<SharedStateIndicator variant="shared-in" iconOnly />);
    const indicator = container.querySelector('.share-state-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.classList.contains('share-state-indicator-shared-in')).toBe(true);
    expect(indicator?.classList.contains('share-state-indicator-shared-out')).toBe(false);
    expect(indicator?.getAttribute('aria-label')).toBe('Shared with me');
    expect(indicator?.getAttribute('title')).toBe('Shared with me');

    const svgIcon = container.querySelector('svg.share-state-icon-return');
    expect(svgIcon).not.toBeNull();
    expect(svgIcon?.querySelector('polyline')).not.toBeNull();
  });

  it('renders 👥 icon and distinct classes for shared-out variant', () => {
    const { container } = render(<SharedStateIndicator variant="shared-out" iconOnly state={{ outgoing: true }} />);
    const indicator = container.querySelector('.share-state-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator?.classList.contains('share-state-indicator-shared-out')).toBe(true);
    expect(indicator?.classList.contains('share-state-indicator-shared-in')).toBe(false);
    expect(indicator?.getAttribute('aria-label')).toBe('Shared with others');
    expect(indicator?.textContent).toContain('👥');
  });
});

describe('ServerIconBar navigation with unified servers', () => {
  const unifiedServers: UnifiedServerItem[] = [
    {
      id: 'srv-owned',
      name: 'Primary Node',
      status: 'online',
      lastHeartbeatAt: Date.now(),
      createdAt: 1000,
      isSharedIn: false,
      online: true,
      daemonVersion: '0.9.0',
      latestDaemonVersion: '0.9.0',
    },
    {
      id: 'srv-shared',
      name: 'Partner Cloud',
      status: 'active',
      lastHeartbeatAt: null,
      createdAt: 2000,
      isSharedIn: true,
      sharedEntry: {
        id: 'grant-partner',
        serverId: 'srv-shared',
        serverName: 'Partner Cloud',
        role: 'participant',
        status: 'active',
        target: { kind: 'server', serverId: 'srv-shared' },
        targetLabel: 'Partner Cloud',
      },
      online: false,
    },
  ];

  it('routes clicking owned server to onSelectServer and clicking shared-in to onOpenSharedEntry', () => {
    const onSelectServer = vi.fn();
    const onOpenSharedEntry = vi.fn();
    const onServerContextMenu = vi.fn();

    const { getByTitle } = render(
      <ServerIconBar
        servers={unifiedServers}
        activeServerId="srv-owned"
        onSelectServer={onSelectServer}
        onOpenSharedEntry={onOpenSharedEntry}
        onServerContextMenu={onServerContextMenu}
      />,
    );

    // 1. Click owned server
    fireEvent.click(getByTitle('Primary Node'));
    expect(onSelectServer).toHaveBeenCalledWith('srv-owned', 'Primary Node');
    expect(onOpenSharedEntry).not.toHaveBeenCalled();

    // 2. Click shared-in server
    fireEvent.click(getByTitle('Partner Cloud'));
    expect(onOpenSharedEntry).toHaveBeenCalledWith(unifiedServers[1].sharedEntry);

    // 3. Right-click context menu: allowed on owned, suppressed on shared-in
    fireEvent.contextMenu(getByTitle('Primary Node'));
    expect(onServerContextMenu).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(getByTitle('Partner Cloud'));
    expect(onServerContextMenu).toHaveBeenCalledTimes(1); // Not called for shared-in
  });

  it('renders shared-in return arrow indicator on the shared icon button', () => {
    const { getByTitle } = render(
      <ServerIconBar
        servers={unifiedServers}
        activeServerId={null}
        onSelectServer={vi.fn()}
      />,
    );

    const sharedBtn = getByTitle('Partner Cloud');
    const returnArrow = sharedBtn.querySelector('.share-state-indicator-shared-in svg.share-state-icon-return');
    expect(returnArrow).not.toBeNull();
  });

  it('renders deduplicated merged shared-session virtual servers once per serverId in ServerIconBar and routes click to best grant', () => {
    const sharedSessionGrants: SharedEntrySummary[] = [
      {
        id: 'grant-sub-1',
        serverId: 'srv-cluster',
        serverName: 'Merged Cluster',
        role: 'participant',
        status: 'active',
        target: { kind: 'subsession', serverId: 'srv-cluster', sessionName: 'deck_sub_1', subSessionId: 'sub1' },
        targetLabel: 'Sub 1',
      },
      {
        id: 'grant-main-1',
        serverId: 'srv-cluster',
        serverName: 'Merged Cluster',
        role: 'viewer',
        status: 'active',
        target: { kind: 'main', serverId: 'srv-cluster', sessionName: 'deck_main_1' },
        targetLabel: 'Main 1',
      },
      {
        id: 'grant-sub-2',
        serverId: 'srv-cluster',
        serverName: 'Merged Cluster',
        role: 'viewer',
        status: 'active',
        target: { kind: 'subsession', serverId: 'srv-cluster', sessionName: 'deck_sub_2', subSessionId: 'sub2' },
        targetLabel: 'Sub 2',
      },
    ];
    const projected = projectUnifiedServerList(
      [{ id: 'srv-owned', name: 'Primary Node', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1000 }],
      sharedSessionGrants,
      new Set(['srv-owned']),
    );
    const onOpenSharedEntry = vi.fn();

    const { getAllByTitle } = render(
      <ServerIconBar
        servers={projected}
        activeServerId="srv-owned"
        onSelectServer={vi.fn()}
        onOpenSharedEntry={onOpenSharedEntry}
      />,
    );

    const clusterButtons = getAllByTitle('Merged Cluster');
    expect(clusterButtons).toHaveLength(1);
    fireEvent.click(clusterButtons[0]);
    expect(onOpenSharedEntry).toHaveBeenCalledWith(sharedSessionGrants[1]); // main grant chosen
  });
});

describe('Mobile 3-column server menu with unified servers and deduplicated shared panel', () => {
  const allShares: SharedEntrySummary[] = [
    {
      id: 'share-server-entry',
      serverId: 'srv-shared-whole',
      serverName: 'Whole Server Project',
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: 'srv-shared-whole' },
      targetLabel: 'Whole Server Project',
    },
    {
      id: 'share-tab-univ',
      serverId: 'srv-univ',
      serverName: 'Univ Cluster',
      role: 'viewer',
      status: 'active',
      target: { kind: 'main', serverId: 'srv-univ', sessionName: 'university' },
      targetLabel: 'university',
    },
    {
      id: 'share-sub-univ',
      serverId: 'srv-univ',
      serverName: 'Univ Cluster',
      role: 'participant',
      status: 'active',
      target: { kind: 'subsession', serverId: 'srv-univ', sessionName: 'deck_sub_jdzs', subSessionId: 'jdzs' },
      targetLabel: 'jdzs',
    },
  ];

  const owned = [
    { id: 'srv-1', name: 'MacBook Pro', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 100 },
  ];

  it('merges whole-server and deduplicated shared-session grants into 3-column list without duplicating server buttons', () => {
    const ownedIds = new Set(['srv-1']);
    const unified = projectUnifiedServerList(owned, allShares, ownedIds);
    const restricted = filterRestrictedSharedEntries(allShares);

    const onOpenShared = vi.fn();
    const onSelectOwned = vi.fn();

    const { container } = render(
      <MobileServerMenu footer={<div class="lang-footer">Language</div>}>
        <button class="mobile-server-menu-item">← Home</button>
        {unified.map((s) => (
          <button
            key={s.id}
            class="mobile-server-menu-item mobile-server-menu-server"
            onClick={() => {
              if (s.isSharedIn && s.sharedEntry) onOpenShared(s.sharedEntry);
              else onSelectOwned(s.id, s.name);
            }}
          >
            <span class="mobile-server-menu-name">{s.name}</span>
            {s.isSharedIn && <SharedStateIndicator variant="shared-in" iconOnly />}
          </button>
        ))}
        {restricted.length > 0 && (
          <MobileSharedEntriesMenu
            entries={restricted}
            onOpen={onOpenShared}
            onRefresh={vi.fn()}
          />
        )}
      </MobileServerMenu>,
    );

    // 1. Owned + whole-server + single merged shared-session server in the top grid (not 4!)
    const serverButtons = container.querySelectorAll('.mobile-server-menu-server');
    expect(serverButtons).toHaveLength(3);
    expect(serverButtons[0].textContent).toContain('MacBook Pro');
    expect(serverButtons[1].textContent).toContain('Whole Server Project');
    expect(serverButtons[2].textContent).toContain('Univ Cluster');

    // 2. Shared server items have the return arrow indicator
    expect(serverButtons[1].querySelector('.share-state-indicator-shared-in')).not.toBeNull();
    expect(serverButtons[2].querySelector('.share-state-indicator-shared-in')).not.toBeNull();

    // 3. Clicking whole-server calls onOpenShared with the full server grant; clicking Univ Cluster uses preferred main grant
    fireEvent.click(serverButtons[1]);
    expect(onOpenShared).toHaveBeenCalledWith(allShares[0]);
    fireEvent.click(serverButtons[2]);
    expect(onOpenShared).toHaveBeenCalledWith(allShares[1]);

    // 4. Restricted panel keeps individual restricted entries (whole-server is NOT duplicated here)
    const sharedPanelRows = container.querySelectorAll('.shared-entry-row');
    expect(sharedPanelRows).toHaveLength(2);
    expect(sharedPanelRows[0].textContent).toContain('university');
    expect(sharedPanelRows[1].textContent).toContain('jdzs');
    expect(sharedPanelRows[0].textContent).not.toContain('Whole Server Project');
  });
});

describe('Chromium responsive layout and interaction verification', () => {
  it('renders and interacts across 320px, 390px, and 1280px viewports with real DOM event dispatches', async (ctx) => {
    const playwright = require('playwright') as typeof import('playwright');
    if (!existsSync(playwright.chromium.executablePath())) {
      ctx.skip();
      return;
    }

    const artifactDir = process.env.ARTIFACT_DIR || resolve(__dirname, '../artifacts/screenshots');
    if (!existsSync(artifactDir)) {
      mkdirSync(artifactDir, { recursive: true });
    }

    // 60 servers (30 owned + 30 shared with mix of pinned, active, Chinese/English names)
    const ownedList = Array.from({ length: 30 }, (_, i) => ({
      id: `dev-${i}`,
      name: i % 2 === 0 ? `测试开发服务器-${i}-长名测试` : `Server-Dev-${i}`,
      status: 'online',
      lastHeartbeatAt: Date.now(),
      createdAt: 1000 + i,
    }));

    const sharedGrants: SharedEntrySummary[] = Array.from({ length: 30 }, (_, i) => ({
      id: `grant-${i}`,
      serverId: `shared-node-${i}`,
      serverName: i === 0 ? '共享远程机器-非常长的中文服务器名称' : `Shared-Remote-${i}`,
      role: 'participant',
      status: 'active',
      target: { kind: 'server', serverId: `shared-node-${i}` },
      targetLabel: `Shared-Remote-${i}`,
    }));

    const restrictedGrants: SharedEntrySummary[] = [
      {
        id: 'grant-univ',
        serverId: 'restricted-node-1',
        serverName: 'University Machine',
        role: 'viewer',
        status: 'active',
        target: { kind: 'main', serverId: 'restricted-node-1', sessionName: 'university' },
        targetLabel: 'university',
      },
    ];

    // Bundle live Preact navigation fixture with esbuild to mount production components in Chromium
    const originalUint8Array = globalThis.Uint8Array;
    globalThis.Uint8Array = new TextEncoder().encode('').constructor as any;
    let clientBundle = '';
    try {
      const esbuild = (await import('esbuild')).default;
      const bundleResult = await esbuild.build({
      stdin: {
        contents: `
          import { h, render } from 'preact';
          import { useState } from 'preact/hooks';
          import { ServerIconBar } from './src/components/ServerIconBar.js';
          import { MobileServerMenu } from './src/components/MobileServerMenu.js';
          import { MobileServerMenuToolbar } from './src/components/MobileServerMenuToolbar.js';
          import { MobileSharedEntriesMenu } from './src/components/MobileSharedEntriesMenu.js';
          import { SharedEntriesPanel } from './src/components/SharedEntriesPanel.js';
          import { SharedStateIndicator } from './src/components/SharedStateIndicator.js';
          import { projectUnifiedServerList, filterRestrictedSharedEntries } from './src/unified-server-projection.js';

          window.__appLog = [];
          const log = (action, payload) => {
            window.__appLog.push({ action, payload, time: Date.now() });
          };

          export function DesktopNavApp({ servers, sharedGrants, restrictedGrants }) {
            const [activeServerId, setActiveServerId] = useState('dev-0');
            const ownedIds = new Set(servers.map(s => s.id));
            const unified = projectUnifiedServerList(servers, sharedGrants, ownedIds, ['dev-0']);
            const restricted = filterRestrictedSharedEntries(restrictedGrants);

            return h('div', { class: 'layout' },
              h('div', { class: 'mobile-server-bar', style: { display: 'none' } },
                h('button', { class: 'mobile-server-btn' }, 'Mobile Bar')
              ),
              h(ServerIconBar, {
                servers: unified,
                activeServerId: activeServerId,
                onSelectServer: (id, name) => {
                  setActiveServerId(id);
                  log('select-server', { id, name });
                },
                onOpenSharedEntry: (entry) => {
                  log('open-shared-entry', entry);
                }
              }),
              h('aside', { class: 'sidebar' },
                h('div', { class: 'sidebar-header', style: { padding: '12px' } }, 'Servers'),
                h(SharedEntriesPanel, {
                  entries: restricted,
                  onOpen: (entry) => log('open-restricted-shared', entry),
                  onRefresh: () => log('refresh-shared', null)
                })
              ),
              h('main', { class: 'main', style: { flex: 1, padding: '24px' } },
                h('h1', null, 'Desktop Workspace'),
                h('p', null, 'Active: ' + activeServerId)
              )
            );
          }

          export function MobileNavApp({ servers, sharedGrants, restrictedGrants, isNative }) {
            const [activeServerId, setActiveServerId] = useState('dev-0');
            const [lang, setLang] = useState('English');
            const [serverCtxMenu, setServerCtxMenu] = useState(null);

            const ownedIds = new Set(servers.map(s => s.id));
            const unified = projectUnifiedServerList(servers, sharedGrants, ownedIds, ['dev-0']);
            const restricted = filterRestrictedSharedEntries(restrictedGrants);

            return h('div', { class: 'layout-mobile' },
              h('div', { class: 'mobile-server-bar' },
                h('div', { class: 'mobile-server-switcher-wrap' },
                  h('button', { class: 'mobile-server-btn' },
                    h('span', null, '☁'),
                    h('span', { class: 'mobile-server-btn-name' }, activeServerId)
                  ),
                  h(MobileServerMenu, {
                    footer: h('button', {
                      class: 'footer-btn',
                      id: 'lang-btn',
                      onClick: () => {
                        const next = lang === 'English' ? '中文' : 'English';
                        setLang(next);
                        log('change-lang', next);
                      }
                    }, lang)
                  },
                    h(MobileServerMenuToolbar, {
                      onHome: () => log('click-home', null),
                      onChangeServer: () => log('click-change-server', null),
                      onOpenControlledNodes: () => log('click-ai-desk', null),
                      isNativeApp: typeof isNative === 'boolean' ? isNative : true,
                    }),
                    unified.map(s => {
                      const presence = s.presence || (s.online ? 'online' : 'offline');
                      const color = presence === 'online' ? '#4ade80' : presence === 'offline' ? '#475569' : '#94a3b8';
                      const symbol = presence === 'online' ? '●' : presence === 'offline' ? '○' : '◌';
                      return h('button', {
                        key: s.id,
                        'data-server-id': s.id,
                        'data-shared-in': s.isSharedIn ? 'true' : 'false',
                        class: 'mobile-server-menu-item mobile-server-menu-server' + (s.id === activeServerId ? ' active' : '') + (s.isSharedIn ? ' mobile-shared-in' : ''),
                        onClick: () => {
                          if (s.isSharedIn) {
                            if (s.sharedEntry) log('open-shared-entry', s.sharedEntry);
                            return;
                          }
                          setActiveServerId(s.id);
                          log('select-server', { id: s.id, name: s.name });
                        },
                        onContextMenu: s.isSharedIn ? (e) => {
                          e.preventDefault();
                          log('suppressed-shared-contextmenu', s.id);
                        } : (e) => {
                          e.preventDefault();
                          const ownedServer = s.server || servers.find(srv => srv.id === s.id && ownedIds.has(srv.id));
                          if (ownedServer) {
                            setServerCtxMenu(ownedServer);
                            log('open-owned-contextmenu', s.id);
                          }
                        }
                      },
                        h('span', { class: 'mobile-server-menu-dot mobile-server-menu-dot-' + presence, style: { color: color } }, symbol),
                        h('span', { class: 'mobile-server-menu-name' }, s.name),
                        s.isSharedIn && h(SharedStateIndicator, { variant: 'shared-in', iconOnly: true })
                      );
                    }),
                    restricted.length > 0 && h(MobileSharedEntriesMenu, {
                      entries: restricted,
                      onOpen: (entry) => log('open-restricted-shared', entry),
                      onRefresh: () => log('refresh-shared', null)
                    })
                  )
                )
              ),
              serverCtxMenu && h('div', { id: 'mobile-server-ctx-menu', class: 'server-context-menu', style: { position: 'fixed', zIndex: 9999, top: '50px', left: '50px', background: '#0f172a', padding: '16px', border: '1px solid #334155' } },
                h('span', null, 'server-context-menu'),
                h('button', { id: 'mobile-ctx-delete' }, 'server-menu-delete'),
                h('button', { id: 'mobile-ctx-close', onClick: () => setServerCtxMenu(null) }, 'server-menu-close')
              )
            );
          }

          window.mountDesktopNav = (props) => {
            render(h(DesktopNavApp, props), document.getElementById('root'));
          };

          window.mountMobileNav = (props) => {
            render(h(MobileNavApp, props), document.getElementById('root'));
          };
        `,
        resolveDir: resolve(__dirname, '..'),
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      plugins: [
        {
          name: 'mock-i18n',
          setup(build) {
            build.onResolve({ filter: /react-i18next/ }, (args) => ({ path: args.path, namespace: 'mock' }));
            build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              contents: 'export const useTranslation = () => ({ t: (k, opt) => (opt && opt.defaultValue) || k });',
              loader: 'js',
            }));
          },
        },
      ],
    });
    clientBundle = bundleResult.outputFiles[0].text;
    } finally {
      globalThis.Uint8Array = originalUint8Array;
    }

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ hasTouch: true });

      const viewports = [
        { width: 320, height: 568, mode: 'mobile' },  // iPhone SE compact
        { width: 390, height: 844, mode: 'mobile' },  // iPhone standard
        { width: 1280, height: 800, mode: 'desktop' }, // Desktop display
      ];

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });

        if (vp.mode === 'mobile') {
          await page.setContent(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${clientBundle}</script><script>
              window.__servers = ${JSON.stringify(ownedList)};
              window.__sharedGrants = ${JSON.stringify(sharedGrants)};
              window.__restrictedGrants = ${JSON.stringify(restrictedGrants)};
              window.mountMobileNav({
                servers: window.__servers,
                sharedGrants: window.__sharedGrants,
                restrictedGrants: window.__restrictedGrants,
                isNative: true,
              });
            </script></body></html>`,
          );

          // Save portable screenshot
          const screenshotPath = resolve(artifactDir, `nav-viewport-${vp.width}.png`);
          await page.screenshot({ path: screenshotPath });

          // 1. Mobile bar must be visible
          const mobileBarDisplay = await page.locator('.mobile-server-bar').evaluate((el) => getComputedStyle(el).display);
          expect(mobileBarDisplay).not.toBe('none');

          // 2. Grid must strictly maintain 3 columns
          const bodyMetrics = await page.locator('.mobile-server-menu-body').evaluate((el) => {
            const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length;
            return {
              columns: cols,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              hasScroll: el.scrollHeight > el.clientHeight,
            };
          });
          expect(bodyMetrics.columns).toBe(3);
          expect(bodyMetrics.hasScroll).toBe(true);

          // 3. Fixed language footer must be visible and at bottom
          const footerBox = await page.locator('.mobile-server-menu-language').boundingBox();
          expect(footerBox).not.toBeNull();
          expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(vp.height);

          // Top row layout: Home on left, Switch Cloud Server on right
          const homeBox = await page.locator('.mobile-server-menu-home').boundingBox();
          const changeBox = await page.locator('.mobile-server-menu-change').boundingBox();
          const aiDeskBox = await page.locator('.mobile-server-menu-controlled-nodes').boundingBox();
          expect(homeBox).not.toBeNull();
          expect(changeBox).not.toBeNull();
          expect(aiDeskBox).not.toBeNull();
          // Home is to the left of Switch Cloud Server
          expect(homeBox!.x).toBeLessThan(changeBox!.x);
          // Both buttons sit on the same top row
          expect(Math.abs(homeBox!.y - changeBox!.y)).toBeLessThanOrEqual(5);
          // AI Desk is on dedicated second row below top row
          expect(aiDeskBox!.y).toBeGreaterThanOrEqual(homeBox!.y + homeBox!.height - 2);

          // Taps on Home, Switch Cloud Server, AI Desk
          await page.locator('.mobile-server-menu-home').tap({ timeout: 2000 });
          await page.locator('.mobile-server-menu-change').tap({ timeout: 2000 });
          await page.locator('.mobile-server-menu-controlled-nodes').tap({ timeout: 2000 });

          // Non-native check: switch cloud server is suppressed
          await page.evaluate(() => {
            (window as any).mountMobileNav({
              servers: (window as any).__servers,
              sharedGrants: (window as any).__sharedGrants,
              restrictedGrants: (window as any).__restrictedGrants,
              isNative: false,
            });
          });
          expect(await page.locator('.mobile-server-menu-change').count()).toBe(0);
          expect(await page.locator('.mobile-server-menu-home').count()).toBe(1);
          expect(await page.locator('.mobile-server-menu-controlled-nodes').count()).toBe(1);
          // Restore native mode for remaining interactions
          await page.evaluate(() => {
            (window as any).mountMobileNav({
              servers: (window as any).__servers,
              sharedGrants: (window as any).__sharedGrants,
              restrictedGrants: (window as any).__restrictedGrants,
              isNative: true,
            });
          });

          // 4. Perform genuine vertical scrolling inside the container
          await page.locator('.mobile-server-menu-body').evaluate((el) => { el.scrollTop = 300; });
          const scrollPos = await page.locator('.mobile-server-menu-body').evaluate((el) => el.scrollTop);
          expect(scrollPos).toBeGreaterThan(0);

          // 5. Interactive tap on shared server button executes production onOpenSharedEntry callback
          const sharedBtn = page.locator('.mobile-server-menu-server[data-shared-in="true"]').first();
          expect(await sharedBtn.isVisible()).toBe(true);
          await sharedBtn.tap({ timeout: 2000 });

          // 6. Interactive tap on language switcher executes real Preact state change
          const langBtn = page.locator('#lang-btn');
          expect(await langBtn.textContent()).toBe('English');
          await langBtn.tap({ timeout: 2000 });
          expect(await langBtn.textContent()).toBe('中文');

          // 7. Right-click contextmenu on owned server opens management menu
          const ownedBtn = page.locator('.mobile-server-menu-server[data-shared-in="false"]').first();
          await ownedBtn.click({ button: 'right' });
          expect(await page.locator('#mobile-server-ctx-menu').isVisible()).toBe(true);
          await page.locator('#mobile-ctx-close').click({ timeout: 5000, force: true });
          expect(await page.locator('#mobile-server-ctx-menu').count()).toBe(0);

          // 8. Right-click contextmenu on shared server suppresses management menu
          await sharedBtn.click({ button: 'right' });
          expect(await page.locator('#mobile-server-ctx-menu').count()).toBe(0);

          // Verify production application log
          const logs = await page.evaluate(() => (window as any).__appLog);
          expect(logs.some((l: any) => l.action === 'click-home')).toBe(true);
          expect(logs.some((l: any) => l.action === 'click-change-server')).toBe(true);
          expect(logs.some((l: any) => l.action === 'click-ai-desk')).toBe(true);
          expect(logs.some((l: any) => l.action === 'open-shared-entry')).toBe(true);
          expect(logs.some((l: any) => l.action === 'change-lang' && l.payload === '中文')).toBe(true);
          expect(logs.some((l: any) => l.action === 'open-owned-contextmenu')).toBe(true);
          expect(logs.some((l: any) => l.action === 'suppressed-shared-contextmenu')).toBe(true);
        } else {
          // Desktop mode (1280px)
          await page.setContent(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${clientBundle}</script><script>
              window.mountDesktopNav({
                servers: ${JSON.stringify(ownedList)},
                sharedGrants: ${JSON.stringify(sharedGrants)},
                restrictedGrants: ${JSON.stringify(restrictedGrants)}
              });
            </script></body></html>`,
          );

          // Save portable screenshot
          const screenshotPath = resolve(artifactDir, `nav-viewport-${vp.width}.png`);
          await page.screenshot({ path: screenshotPath });

          // 1. Mobile bar must be completely hidden on desktop
          const mobileBarDisplay = await page.locator('.mobile-server-bar').evaluate((el) => getComputedStyle(el).display);
          expect(mobileBarDisplay).toBe('none');

          // 2. ServerIconBar must be visible
          const iconBarDisplay = await page.locator('.server-icon-bar').evaluate((el) => getComputedStyle(el).display);
          expect(iconBarDisplay).not.toBe('none');

          // 3. Shared server icon button has the return arrow indicator
          const sharedIconBtn = page.locator('.server-icon-shared-in').first();
          expect(await sharedIconBtn.isVisible()).toBe(true);
          const hasReturnIndicator = await sharedIconBtn.locator('.share-state-indicator-shared-in').count();
          expect(hasReturnIndicator).toBeGreaterThan(0);

          // 4. Interactive click on desktop shared server icon triggers onOpenSharedEntry
          await sharedIconBtn.click({ timeout: 2000 });

          // 5. Interactive click on owned server icon triggers onSelectServer
          const ownedIconBtn = page.locator('.server-icon-bar button:not(.server-icon-shared-in)').first();
          await ownedIconBtn.click({ timeout: 2000 });

          // 6. Right-click context menu suppression on shared server
          await sharedIconBtn.click({ button: 'right' });

          const logs = await page.evaluate(() => (window as any).__appLog);
          expect(logs.some((l: any) => l.action === 'open-shared-entry')).toBe(true);
          expect(logs.some((l: any) => l.action === 'select-server')).toBe(true);
        }
      }
    } finally {
      await browser.close();
    }
  }, 45_000);
});
