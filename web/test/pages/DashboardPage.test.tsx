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
    localStorage.clear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(),
      },
    });
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

  it('renders segmented tabs with Devices & Shares selected by default and hides inactive visited panels cleanly', async () => {
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
    expect(document.getElementById('dashboard-tabpanel-devices')?.hidden).toBe(false);
    expect(document.getElementById('dashboard-tabpanel-keys')).toBeNull();
    expect(document.getElementById('dashboard-tabpanel-account')).toBeNull();
    expect(listPasskeysMock).not.toHaveBeenCalled();

    // Switch to API Keys tab
    fireEvent.click(keysTab);
    expect(keysTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('cli-main')).toBeTruthy();
    expect(document.getElementById('dashboard-tabpanel-devices')?.hidden).toBe(true);
    expect(document.getElementById('dashboard-tabpanel-devices')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('dashboard-tabpanel-keys')?.hidden).toBe(false);

    // Switch to Security & Account tab
    fireEvent.click(accountTab);
    expect(accountTab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('passkey.title')).toBeTruthy();
    expect(screen.getByText('account.delete_title')).toBeTruthy();
    expect(document.getElementById('dashboard-tabpanel-keys')?.hidden).toBe(true);
    expect(document.getElementById('dashboard-tabpanel-account')?.hidden).toBe(false);
    expect(document.querySelectorAll('.dashboard-card .input').length).toBeGreaterThanOrEqual(1);

    // Keyboard navigation between tabs
    fireEvent.keyDown(accountTab, { key: 'Home' });
    expect(devicesTab.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('dashboard-tabpanel-devices')?.hidden).toBe(false);
    expect(document.getElementById('dashboard-tabpanel-account')?.hidden).toBe(true);
    fireEvent.keyDown(devicesTab, { key: 'ArrowRight' });
    expect(keysTab.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('dashboard-tabpanel-keys')?.hidden).toBe(false);

    // Localized header actions
    fireEvent.click(screen.getByRole('button', { name: 'usageSummary.title' }));
    expect(onOpenUsageSummary).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'dashboard.logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('preserves a pending ApiKeyManager generation across tab switches, allows copying, and stays gone after dismiss', async () => {
    let keysList: { id: string; label: string | null; createdAt: number; revokedAt: number | null }[] = [];
    let resolveCreate!: (value: { id: string; apiKey: string }) => void;
    const createPromise = new Promise<{ id: string; apiKey: string }>((resolve) => {
      resolveCreate = resolve;
    });

    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server') {
        return {
          servers: [
            { id: 'srv-1', name: 'Prod Node', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1_700_000_000_000 },
          ],
        };
      }
      if (path === '/api/auth/user/me/keys' && init?.method === 'POST') {
        return createPromise;
      }
      if (path === '/api/auth/user/me/keys') {
        return { keys: keysList };
      }
      return {};
    });

    render(
      <DashboardPage
        onSelectServer={vi.fn()}
        onLogout={vi.fn()}
        onOpenUsageSummary={vi.fn()}
        sharedEntries={[]}
        sharedEntriesLoading={false}
        sharedEntriesLoaded={true}
        sharedEntriesError={null}
        openingSharedEntryId={null}
        onOpenSharedEntry={vi.fn()}
        onRefreshSharedEntries={vi.fn()}
      />,
    );

    const keysTab = await screen.findByRole('tab', { name: /dashboard\.tabs\.api_keys/ });
    const accountTab = screen.getByRole('tab', { name: /dashboard\.tabs\.account/ });

    fireEvent.click(keysTab);
    fireEvent.click(screen.getByRole('button', { name: 'api_key.generate' }));

    // Switch away while POST is still pending
    fireEvent.click(accountTab);
    expect(await screen.findByText('passkey.title')).toBeTruthy();

    // Resolve POST while ApiKeyManager's panel is hidden
    keysList = [{ id: 'k-new', label: null, createdAt: Date.now(), revokedAt: null }];
    resolveCreate({ id: 'k-new', apiKey: 'ONLY_COPY_OF_NEW_SECRET' });

    await waitFor(() => {
      expect(keysTab.querySelector('.dashboard-tab-badge')?.textContent).toBe('1');
    });

    // Return to API Keys: one-time secret banner is visible and copyable
    fireEvent.click(keysTab);
    expect(screen.getByText('ONLY_COPY_OF_NEW_SECRET')).toBeTruthy();
    expect(screen.getByText('https://app.im.codes/bind/ONLY_COPY_OF_NEW_SECRET')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'api_key.copy_bind_command' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('imcodes bind https://app.im.codes/bind/ONLY_COPY_OF_NEW_SECRET');

    // Switch away again while revealed without dismissing: secret remains intact on return
    fireEvent.click(accountTab);
    fireEvent.click(keysTab);
    expect(screen.getByText('ONLY_COPY_OF_NEW_SECRET')).toBeTruthy();

    // Positive control: after dismiss, switching away and back does NOT bring secret back
    fireEvent.click(screen.getByRole('button', { name: 'api_key.dismiss' }));
    expect(screen.queryByText('ONLY_COPY_OF_NEW_SECRET')).toBeNull();
    fireEvent.click(accountTab);
    fireEvent.click(keysTab);
    expect(screen.queryByText('ONLY_COPY_OF_NEW_SECRET')).toBeNull();
  });

  it('preserves a pending GettingStarted key generation across tab switches without falling back to placeholder', async () => {
    let keysList: { id: string; label: string | null; createdAt: number; revokedAt: number | null }[] = [];
    let resolveCreate!: (value: { id: string; apiKey: string }) => void;
    const createPromise = new Promise<{ id: string; apiKey: string }>((resolve) => {
      resolveCreate = resolve;
    });

    localStorage.setItem('rcc_auth', JSON.stringify({ baseUrl: 'https://app.im.codes' }));
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server') return { servers: [] };
      if (path === '/api/auth/user/me/keys' && init?.method === 'POST') return createPromise;
      if (path === '/api/auth/user/me/keys') return { keys: keysList };
      return {};
    });

    render(
      <DashboardPage
        onSelectServer={vi.fn()}
        onLogout={vi.fn()}
        onOpenUsageSummary={vi.fn()}
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

    // Trigger key creation in GettingStarted while on Devices tab
    fireEvent.click(await screen.findByRole('button', { name: 'api_key.generate' }));

    // Switch to Security & Account while POST is pending
    fireEvent.click(accountTab);
    expect(await screen.findByText('passkey.title')).toBeTruthy();

    // Resolve POST while Devices panel is hidden
    keysList = [{ id: 'k-first', label: 'first-key', createdAt: Date.now(), revokedAt: null }];
    resolveCreate({ id: 'k-first', apiKey: 'ONLY_COPY_OF_FIRST_SECRET' });

    await waitFor(() => {
      expect(keysTab.querySelector('.dashboard-tab-badge')?.textContent).toBe('1');
    });

    // Return to Devices tab: full secret command is shown, NOT <your-api-key> placeholder
    fireEvent.click(devicesTab);
    expect(screen.getByText(/ONLY_COPY_OF_FIRST_SECRET/)).toBeTruthy();
    expect(screen.queryByText(/<your-api-key>/)).toBeNull();
  });

  it('defines dark-theme .input, .btn-ghost, hidden tabpanel, and mobile responsive dashboard CSS rules', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(css).toContain('.btn-ghost {');
    expect(css).toContain('.input {');
    expect(css).toContain('.dashboard-tabs {');
    expect(css).toContain('.dashboard-tabpanel[hidden] {');
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
