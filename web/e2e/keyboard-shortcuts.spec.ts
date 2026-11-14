import { expect, test, type Page } from '@playwright/test';

interface MockSession {
  name: string;
  project: string;
  role: 'brain' | 'w1';
  agentType: string;
  runtimeType: 'transport';
  state: 'idle' | 'running';
  label?: string;
}

const SERVERS = [
  { id: 'srv-1', name: 'Alpha Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() },
  { id: 'srv-2', name: 'Beta Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() },
];

const SERVER_SESSIONS: Record<string, MockSession[]> = {
  'srv-1': [
    { name: 'deck_alpha_brain', project: 'alpha', role: 'brain', agentType: 'claude-code-sdk', runtimeType: 'transport', state: 'idle', label: 'Alpha Tab' },
    { name: 'deck_beta_brain', project: 'beta', role: 'brain', agentType: 'claude-code-sdk', runtimeType: 'transport', state: 'idle', label: 'Beta Tab' },
    { name: 'deck_gamma_brain', project: 'gamma', role: 'brain', agentType: 'claude-code-sdk', runtimeType: 'transport', state: 'idle', label: 'Gamma Tab' },
  ],
  'srv-2': [
    { name: 'deck_s2_brain', project: 'second', role: 'brain', agentType: 'claude-code-sdk', runtimeType: 'transport', state: 'idle', label: 'Second Server Tab' },
  ],
};

async function openDesktopApp(page: Page, platform: 'MacIntel' | 'Linux x86_64') {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    // Rapid server switching unmounts hidden TerminalView/xterm instances mid-RAF, which can emit
    // a pre-existing xterm disposal error unrelated to keyboard navigation.
    if (err.message === "Cannot read properties of undefined (reading 'dimensions')") return;
    errors.push(err.message);
  });

  const prefs = new Map<string, unknown>([
    ['tab_pinned', { v: ['deck_gamma_brain'], t: 1000 }],
    ['tab_order', { v: ['deck_beta_brain', 'deck_alpha_brain'], t: 1000 }],
  ]);

  await page.addInitScript((mockPlatform) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: mockPlatform });
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { platform: mockPlatform === 'MacIntel' ? 'macOS' : 'Linux' },
    });
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'e2e-shortcut-user', baseUrl: location.origin }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session_srv-1', 'deck_gamma_brain');
    localStorage.setItem('rcc_session_srv-2', 'deck_s2_brain');
    localStorage.setItem('i18nextLng', 'en');
  }, platform);

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let json: unknown = {};

    if (path === '/api/auth/user/me') {
      json = { id: 'e2e-shortcut-user', username: 'tester' };
    } else if (path === '/api/server') {
      json = { servers: SERVERS };
    } else if (path === '/api/shares') {
      json = { entries: [] };
    } else if (path.startsWith('/api/preferences/')) {
      const key = decodeURIComponent(path.slice('/api/preferences/'.length));
      if (req.method() === 'PUT' || req.method() === 'POST') {
        try {
          const body = req.postDataJSON() as { value?: unknown } | null;
          if (body && 'value' in body) prefs.set(key, body.value);
          else prefs.set(key, body);
        } catch { /* ignore */ }
        json = { ok: true };
      } else {
        json = { value: prefs.get(key) ?? null };
      }
    } else if (path.endsWith('/ws-ticket')) {
      json = { ticket: 'e2e-shortcut-ticket' };
    } else if (path.endsWith('/sessions')) {
      const match = path.match(/\/api\/server\/([^/]+)\/sessions$/);
      const sid = match?.[1] ?? 'srv-1';
      json = { sessions: SERVER_SESSIONS[sid] ?? [] };
    }
    await route.fulfill({ json }).catch(() => {});
  });

  await page.routeWebSocket('**/api/server/**/ws?*', (socket) => {
    const url = new URL(socket.url());
    const match = url.pathname.match(/\/api\/server\/([^/]+)\/ws$/);
    const sid = match?.[1] ?? 'srv-1';
    socket.onMessage((message) => {
      if (typeof message !== 'string') return;
      const msg = JSON.parse(message) as { type: string };
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'get_sessions') {
        socket.send(JSON.stringify({ type: 'session_list', sessions: SERVER_SESSIONS[sid] ?? [] }));
      }
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/srv-1');
  await expect(page.locator('.tab-ws-dot')).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  // Ensure pinned + tab_order preferences hydrated before asserting tab navigation sequence
  await expect(page.locator('.tab').nth(0)).toContainText('Gamma Tab');
  await expect(page.locator('.tab').nth(1)).toContainText('Beta Tab');
  await expect(page.locator('.tab').nth(2)).toContainText('Alpha Tab');
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');
  return { errors };
}

/**
 * Wait for a server switch to finish WS/session hydration into transport chat mode so
 * global navigation shortcuts are no longer blocked by the pre-hydration terminal fallback.
 */
async function expectActiveServerAndTabReady(page: Page, serverName: string, tabLabel: string) {
  await expect(page.locator('.server-icon-server.server-icon-active')).toContainText(serverName);
  await expect(page.locator('.tab.active')).toContainText(tabLabel);
  await expect(page.locator('.tab.active .tab-ws-dot')).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  await expect(page.locator('.controls-input').first()).toBeVisible();
}

test('macOS defaults support Alt+i/k/j/l primary and Ctrl+w/s/a/d secondary, allow clearing Ctrl+a alone across reload, and respect overrides', async ({ page }) => {
  const { errors } = await openDesktopApp(page, 'MacIntel');

  // Verify macOS Settings keycaps render primary ⌥+I/K/J/L AND secondary ⌃+W/S/A/D
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('⌥');
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('J');
  await expect(page.getByTestId('shortcut-record-tabNext')).toContainText('⌥');
  await expect(page.getByTestId('shortcut-record-tabNext')).toContainText('L');
  await expect(page.getByTestId('shortcut-record-serverPrev')).toContainText('⌥');
  await expect(page.getByTestId('shortcut-record-serverPrev')).toContainText('I');
  await expect(page.getByTestId('shortcut-record-serverNext')).toContainText('⌥');
  await expect(page.getByTestId('shortcut-record-serverNext')).toContainText('K');
  await expect(page.getByTestId('shortcut-record-tabPrev-secondary')).toContainText('⌃');
  await expect(page.getByTestId('shortcut-record-tabPrev-secondary')).toContainText('A');
  await expect(page.getByTestId('shortcut-record-tabNext-secondary')).toContainText('⌃');
  await expect(page.getByTestId('shortcut-record-tabNext-secondary')).toContainText('D');
  await expect(page.getByTestId('shortcut-record-serverPrev-secondary')).toContainText('⌃');
  await expect(page.getByTestId('shortcut-record-serverPrev-secondary')).toContainText('W');
  await expect(page.getByTestId('shortcut-record-serverNext-secondary')).toContainText('⌃');
  await expect(page.getByTestId('shortcut-record-serverNext-secondary')).toContainText('S');

  // Settings overlay blocks tab switching shortcuts
  await page.keyboard.press('Alt+l');
  await page.locator('.settings-back-btn').click();
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');

  // Inside composer (.controls-input): BOTH secondary Ctrl+d/a/s/w and primary Alt+l/j/k/i work and show pressed-slot keycaps
  const composer = page.locator('.controls-input').first();
  await composer.click();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('⌃');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('D');

  await page.keyboard.press('Alt+l');
  await expect(page.locator('.tab.active')).toContainText('Alpha Tab');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('⌥');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('L');

  // Legacy Meta+ArrowLeft does NOT trigger tab switch under unified defaults
  await page.keyboard.press('Meta+ArrowLeft');
  await expect(page.locator('.tab.active')).toContainText('Alpha Tab');

  // With non-editable sidebar control focused: Ctrl+a / Alt+j switch Alpha -> Beta -> Gamma
  await page.locator('.sidebar-toggle-icon').first().focus();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await page.keyboard.press('Alt+j');
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');

  // Server switching works with both Alt+k/i and Ctrl+s/w
  await page.keyboard.press('Control+s');
  await expectActiveServerAndTabReady(page, 'Beta Server', 'Second Server Tab');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('⌃');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('S');
  await page.keyboard.press('Alt+i');
  await expectActiveServerAndTabReady(page, 'Alpha Server', 'Gamma Tab');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('⌥');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('I');

  // Clear ONLY secondary Ctrl+a -> persists across reload without resurrecting Ctrl+a, while primary ⌥J keeps working
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/preferences/keyboard_shortcuts_v1') && res.request().method() === 'PUT'),
    page.getByTestId('shortcut-clear-tabPrev-secondary').click(),
  ]);
  await expect(page.getByTestId('shortcut-record-tabPrev-secondary')).toContainText('Not set');

  await page.reload();
  await expect(page.locator('.tab-ws-dot')).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  await expect(page.getByTestId('shortcut-record-tabPrev-secondary')).toContainText('Not set');
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('⌥');
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('J');
  await page.locator('.settings-back-btn').click();

  // Ctrl+a is no longer intercepted in composer, while Alt+l / Alt+j still switch tabs
  const reloadedComposer = page.locator('.controls-input').first();
  await reloadedComposer.click();
  await page.keyboard.press('Alt+l');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  const ctrlAPrevented = await page.locator('.controls-input').first().evaluate((el) => {
    const evt = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(evt);
    return evt.defaultPrevented;
  });
  expect(ctrlAPrevented).toBe(false);
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await page.keyboard.press('Alt+j');
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');

  // Explicitly overriding tabNext primary to Meta+ArrowRight applies immediately
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  const tabNextRecordBtn = page.getByTestId('shortcut-record-tabNext');
  await tabNextRecordBtn.click();
  await expect(tabNextRecordBtn).toHaveAttribute('data-shortcut-recording', 'true');
  await page.keyboard.press('Meta+ArrowRight');
  await expect(tabNextRecordBtn).toContainText('⌘');
  await expect(tabNextRecordBtn).toContainText('→');
  await page.locator('.settings-back-btn').click();

  await page.locator('.controls-input').first().click();
  await page.keyboard.press('Meta+ArrowRight');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  expect(errors).toEqual([]);
});

test('non-macOS defaults use Alt+i/k/j/l primary, unassigned secondary, and support custom 2nd combo when primary cleared', async ({ page }) => {
  const { errors } = await openDesktopApp(page, 'Linux x86_64');

  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('Alt');
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('J');
  await expect(page.getByTestId('shortcut-record-tabNext')).toContainText('Alt');
  await expect(page.getByTestId('shortcut-record-tabNext')).toContainText('L');
  await expect(page.getByTestId('shortcut-record-serverPrev')).toContainText('Alt');
  await expect(page.getByTestId('shortcut-record-serverPrev')).toContainText('I');
  await expect(page.getByTestId('shortcut-record-serverNext')).toContainText('Alt');
  await expect(page.getByTestId('shortcut-record-serverNext')).toContainText('K');
  await expect(page.getByTestId('shortcut-record-tabPrev-secondary')).toContainText('Not set');
  await page.locator('.settings-back-btn').click();

  // Ctrl+w/s/a/d are NOT intercepted by default on Linux/Windows
  await page.locator('.controls-input').first().click();
  const ctrlIntercepted = await page.locator('.controls-input').first().evaluate((el) => {
    const prevented: string[] = [];
    for (const [key, code] of [
      ['w', 'KeyW'],
      ['s', 'KeyS'],
      ['a', 'KeyA'],
      ['d', 'KeyD'],
    ] as const) {
      const evt = new KeyboardEvent('keydown', { key, code, ctrlKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(evt);
      if (evt.defaultPrevented) prevented.push(key);
    }
    return prevented;
  });
  expect(ctrlIntercepted).toEqual([]);

  await page.keyboard.press('Alt+l');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await page.keyboard.press('Alt+j');
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');

  await page.keyboard.press('Alt+k');
  await expectActiveServerAndTabReady(page, 'Beta Server', 'Second Server Tab');
  await page.keyboard.press('Alt+i');
  await expectActiveServerAndTabReady(page, 'Alpha Server', 'Gamma Tab');

  // Bind Ctrl+ArrowLeft as secondary for tabPrev and clear primary tabPrev -> only Ctrl+ArrowLeft fires
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  const tabPrevSecondaryBtn = page.getByTestId('shortcut-record-tabPrev-secondary');
  await tabPrevSecondaryBtn.click();
  await expect(tabPrevSecondaryBtn).toHaveAttribute('data-shortcut-recording', 'true');
  await page.keyboard.press('Control+ArrowLeft');
  await expect(tabPrevSecondaryBtn).toContainText('Ctrl');
  await expect(tabPrevSecondaryBtn).toContainText('←');
  await page.getByTestId('shortcut-clear-tabPrev').click();
  await expect(page.getByTestId('shortcut-record-tabPrev')).toContainText('Not set');
  await page.locator('.settings-back-btn').click();

  await page.locator('.controls-input').first().click();
  await page.keyboard.press('Alt+l');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await page.keyboard.press('Alt+j');
  await expect(page.locator('.tab.active')).toContainText('Beta Tab');
  await page.keyboard.press('Control+ArrowLeft');
  await expect(page.locator('.tab.active')).toContainText('Gamma Tab');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('Ctrl');
  await expect(page.getByTestId('server-switch-watermark-shortcut')).toContainText('←');
  expect(errors).toEqual([]);
});
