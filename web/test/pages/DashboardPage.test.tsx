/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';

const { apiFetchMock, listPasskeysMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  listPasskeysMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  getApiBaseUrl: () => 'https://app.im.codes',
  listPasskeys: (...args: unknown[]) => listPasskeysMock(...args),
  deletePasskey: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
}));

import { DashboardPage } from '../../src/pages/DashboardPage.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectLeafKeys(v as Record<string, unknown>, next));
    } else {
      keys.push(next);
    }
  }
  return keys.sort();
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPasskeysMock.mockResolvedValue({ credentials: [] });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/server') {
        return {
          servers: [
            { id: 'srv-1', name: 'Prod Node', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1_700_000_000_000 },
          ],
        };
      }
      if (path === '/api/auth/user/me/keys') {
        return {
          keys: [
            { id: 'k-1', label: 'cli-main', createdAt: 1_700_000_000_000, revokedAt: null },
            { id: 'k-2', label: 'old-key', createdAt: 1_700_000_000_000, revokedAt: 1_700_000_100_000 },
          ],
        };
      }
      return {};
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders segmented tabs with Devices & Shares selected by default and switches panels cleanly', async () => {
    const onLogout = vi.fn();
    const onOpenUsageSummary = vi.fn();

    render(
      <DashboardPage
        onSelectServer={vi.fn()}
        onLogout={onLogout}
        onOpenUsageSummary={onOpenUsageSummary}
        sharedEntries={[]}
        sharedEntriesLoading={false}
        sharedEntriesLoaded={true}
        sharedEntriesError={null}
        openingSharedEntryId={null}
        onOpenSharedEntry={vi.fn()}
        onRefreshSharedEntries={vi.fn()}
      />,
    );

    const devicesTab = await screen.findByRole('tab', { name: /dashboard\.tabs\.devices/ });
    const keysTab = screen.getByRole('tab', { name: /dashboard\.tabs\.api_keys/ });
    const accountTab = screen.getByRole('tab', { name: /dashboard\.tabs\.account/ });

    expect(devicesTab.getAttribute('aria-selected')).toBe('true');
    expect(keysTab.getAttribute('aria-selected')).toBe('false');
    expect(accountTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('Prod Node')).toBeTruthy();
    expect(screen.queryByText('cli-main')).toBeNull();
    expect(screen.queryByText('passkey.title')).toBeNull();

    // Switch to API Keys tab
    fireEvent.click(keysTab);
    expect(keysTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('cli-main')).toBeTruthy();
    expect(screen.queryByText('Prod Node')).toBeNull();

    // Switch to Security & Account tab
    fireEvent.click(accountTab);
    expect(accountTab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('passkey.title')).toBeTruthy();
    expect(screen.getByText('account.delete_title')).toBeTruthy();
    expect(document.querySelectorAll('.dashboard-card .input').length).toBeGreaterThanOrEqual(1);

    // Keyboard navigation between tabs
    fireEvent.keyDown(accountTab, { key: 'Home' });
    expect(devicesTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(devicesTab, { key: 'ArrowRight' });
    expect(keysTab.getAttribute('aria-selected')).toBe('true');

    // Localized header actions
    fireEvent.click(screen.getByRole('button', { name: 'usageSummary.title' }));
    expect(onOpenUsageSummary).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('defines dark-theme .input, .btn-ghost, and mobile responsive dashboard CSS rules', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(css).toContain('.btn-ghost {');
    expect(css).toContain('.input {');
    expect(css).toContain('.dashboard-tabs {');
    expect(css).toContain('.mobile-dashboard-menu-button + .dashboard-page .dashboard-brand');
    expect(css).toContain('.api-key-row {');
  });

  it('ships complete dashboard and api_key translations across all 7 locales', () => {
    const enJson = JSON.parse(readFileSync(resolve(WEB_ROOT, 'src/i18n/locales/en.json'), 'utf8')) as {
      dashboard: Record<string, unknown>;
      api_key: Record<string, unknown>;
    };
    const expectedDashboardKeys = collectLeafKeys(enJson.dashboard);
    const expectedApiKeyKeys = collectLeafKeys(enJson.api_key);

    for (const locale of SUPPORTED_LOCALES) {
      const json = JSON.parse(readFileSync(resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`), 'utf8')) as {
        dashboard?: Record<string, unknown>;
        api_key?: Record<string, unknown>;
      };
      expect(json.dashboard, `missing dashboard in ${locale}`).toBeTruthy();
      expect(json.api_key, `missing api_key in ${locale}`).toBeTruthy();
      expect(collectLeafKeys(json.dashboard!)).toEqual(expectedDashboardKeys);
      expect(collectLeafKeys(json.api_key!)).toEqual(expectedApiKeyKeys);
    }
  });
});
