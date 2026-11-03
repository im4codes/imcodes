/** @vitest-environment jsdom */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedStateIndicator } from '../src/components/SharedStateIndicator.js';
import { ServerIconBar } from '../src/components/ServerIconBar.js';
import { MobileServerMenu } from '../src/components/MobileServerMenu.js';
import { MobileSharedEntriesMenu } from '../src/components/MobileSharedEntriesMenu.js';
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
  ];

  const owned = [
    { id: 'srv-1', name: 'MacBook Pro', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 100 },
  ];

  it('merges whole-server share into 3-column list and removes it from the shared panel', () => {
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

    // 1. Both servers are in the top server grid
    const serverButtons = container.querySelectorAll('.mobile-server-menu-server');
    expect(serverButtons).toHaveLength(2);
    expect(serverButtons[0].textContent).toContain('MacBook Pro');
    expect(serverButtons[1].textContent).toContain('Whole Server Project');

    // 2. Shared server item has the return arrow indicator
    expect(serverButtons[1].querySelector('.share-state-indicator-shared-in')).not.toBeNull();

    // 3. Clicking shared server calls onOpenShared with the full server grant
    fireEvent.click(serverButtons[1]);
    expect(onOpenShared).toHaveBeenCalledWith(allShares[0]);

    // 4. Restricted panel only contains 'university' (whole-server is NOT duplicated here)
    const sharedPanelRows = container.querySelectorAll('.shared-entry-row');
    expect(sharedPanelRows).toHaveLength(1);
    expect(sharedPanelRows[0].textContent).toContain('university');
    expect(sharedPanelRows[0].textContent).not.toContain('Whole Server Project');
  });
});

describe('Chromium responsive layout and interaction verification', () => {
  it('renders and interacts across 320px, 390px, and 1280px viewports (simulated Chromium, non-physical device)', async (ctx) => {
    const playwright = require('playwright') as typeof import('playwright');
    if (!existsSync(playwright.chromium.executablePath())) {
      ctx.skip();
      return;
    }

    // Generate 60 servers (30 owned + 30 shared with mix of pinned, active, Chinese/English names)
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

    const ownedIds = new Set(ownedList.map((s) => s.id));
    const unified = projectUnifiedServerList(
      ownedList,
      sharedGrants,
      ownedIds,
      ['dev-0', 'shared-node-0'],
      ['dev-0', 'shared-node-0'],
    );

    const view = render(
      <div class="layout-mobile">
        <div class="mobile-server-bar">
          <div class="mobile-server-switcher-wrap">
            <button class="mobile-server-btn">
              <span>☁</span>
              <span>Active Server</span>
              <SharedStateIndicator variant="shared-in" iconOnly />
            </button>
            <MobileServerMenu footer={<button class="footer-btn">Switch Language (ZH/EN)</button>}>
              <button class="mobile-server-menu-item">← Home</button>
              {unified.map((s) => (
                <button
                  key={s.id}
                  class={`mobile-server-menu-item mobile-server-menu-server${s.id === 'dev-0' ? ' pinned active' : ''}`}
                >
                  <span style={{ color: s.online ? '#4ade80' : '#475569' }}>{s.online ? '●' : '○'}</span>
                  <span class="mobile-server-menu-name">{s.name}</span>
                  {s.isSharedIn && <SharedStateIndicator variant="shared-in" iconOnly />}
                </button>
              ))}
            </MobileServerMenu>
          </div>
        </div>
      </div>,
    );
    view.container.querySelector('.mobile-server-menu')?.removeAttribute('style');

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ hasTouch: true });
      const viewports = [
        { width: 320, height: 568 }, // iPhone SE compact
        { width: 390, height: 844 }, // iPhone 12/13/14 standard
        { width: 1280, height: 800 }, // Desktop display
      ];

      for (const vp of viewports) {
        await page.setViewportSize(vp);
        await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${view.container.innerHTML}</body></html>`);

        // Take screenshot for audit artifact
        await page.screenshot({ path: `/home/k/.gemini/antigravity-cli/brain/e0bca12b-f252-43dc-831a-cb50a2902641/nav-viewport-${vp.width}.png` });

        // Check mobile server menu grid structure if mobile
        if (vp.width <= 430) {
          const bodyMetrics = await page.locator('.mobile-server-menu-body').evaluate((el) => {
            const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length;
            return {
              columns: cols,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              hasScroll: el.scrollHeight > el.clientHeight,
            };
          });

          // Must maintain 3 columns in mobile server menu
          expect(bodyMetrics.columns).toBe(3);
          // With 24+ items, it must scroll vertically within its bounded container
          expect(bodyMetrics.hasScroll).toBe(true);

          // Fixed language footer must remain visible at the bottom
          const footerBox = await page.locator('.mobile-server-menu-language').boundingBox();
          expect(footerBox).not.toBeNull();
          expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(vp.height);

          // Verify interactive hit-test tap on a shared server item
          const sharedBtn = page.locator('.mobile-server-menu-server', { hasText: 'Shared-Remote-1' }).first();
          expect(await sharedBtn.isVisible()).toBe(true);
          await sharedBtn.tap({ timeout: 2000 });
        }
      }
    } finally {
      await browser.close();
    }
  }, 45_000);
});
