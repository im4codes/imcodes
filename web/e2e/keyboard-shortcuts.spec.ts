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

async function openDesktopApp(
  page: Page,
  platform: 'MacIntel' | 'Linux x86_64',
  options?: {
    subSessions?: Array<{
      id: string;
      server_id: string;
      type: string;
      runtime_type: 'transport' | 'process';
      label: string;
      parent_session?: string | null;
      cwd?: string | null;
    }>;
  },
) {
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
    } else if (path.endsWith('/sub-sessions')) {
      const match = path.match(/\/api\/server\/([^/]+)\/sub-sessions$/);
      const sid = match?.[1] ?? 'srv-1';
      json = {
        subSessions: (options?.subSessions ?? []).filter((sub) => sub.server_id === sid).map((sub) => ({
          id: sub.id,
          server_id: sub.server_id,
          type: sub.type,
          shell_bin: null,
          runtime_type: sub.runtime_type,
          provider_id: null,
          provider_session_id: null,
          cwd: sub.cwd ?? '/tmp',
          label: sub.label,
          closed_at: null,
          created_at: 1000,
          updated_at: 1000,
          cc_session_id: null,
          gemini_session_id: null,
          parent_session: sub.parent_session ?? null,
          description: null,
          cc_preset_id: null,
          requested_model: null,
          active_model: null,
          effort: null,
          transport_config: null,
        })),
      };
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

test('renders sub-session sequence badges, opens & focuses composer via configurable modifier + 1..9, and closes all via modifier + 0', async ({ page }) => {
  const { errors } = await openDesktopApp(page, 'Linux x86_64', {
    subSessions: [
      {
        id: 'sub-e2e-1',
        server_id: 'srv-1',
        type: 'claude-code-sdk',
        runtime_type: 'transport',
        label: 'Sub One',
        parent_session: 'deck_gamma_brain',
      },
      {
        id: 'sub-e2e-2',
        server_id: 'srv-1',
        type: 'codex-sdk',
        runtime_type: 'transport',
        label: 'Sub Two',
        parent_session: 'deck_gamma_brain',
      },
    ],
  });

  // Sequence badges appear on sub-session strip items in display order (1, 2) floating at bottom-left without inflating card height
  await expect(page.getByTestId('subsession-seq-sub-e2e-1')).toHaveText('1');
  await expect(page.getByTestId('subsession-seq-sub-e2e-2')).toHaveText('2');
  const liveSeqGeometry = await page.evaluate(() => {
    return ['sub-e2e-1', 'sub-e2e-2'].map((id) => {
      const card = document.querySelector(`[data-sub-id="${id}"]`) as HTMLElement;
      const seq = card.querySelector('.subsession-card-seq') as HTMLElement;
      const clone = card.cloneNode(true) as HTMLElement;
      clone.classList.remove('has-seq');
      clone.querySelector('.subsession-card-seq')?.remove();
      clone.style.visibility = 'hidden';
      card.parentElement?.appendChild(clone);
      const cr = card.getBoundingClientRect();
      const unbadgedHeight = clone.getBoundingClientRect().height;
      clone.remove();
      const sr = seq.getBoundingClientRect();
      const seqStyle = getComputedStyle(seq);
      return {
        id,
        inside: sr.left >= cr.left - 0.5 && sr.right <= cr.right + 0.5 && sr.top >= cr.top - 0.5 && sr.bottom <= cr.bottom + 0.5,
        bottomLeft: sr.left < cr.left + cr.width / 2 && sr.top >= cr.top + cr.height / 2,
        sameHeightAsUnbadged: Math.abs(cr.height - unbadgedHeight) < 0.5,
        floating: seqStyle.position === 'absolute' && seqStyle.pointerEvents === 'none',
      };
    });
  });
  expect(liveSeqGeometry).toEqual([
    { id: 'sub-e2e-1', inside: true, bottomLeft: true, sameHeightAsUnbadged: true, floating: true },
    { id: 'sub-e2e-2', inside: true, bottomLeft: true, sameHeightAsUnbadged: true, floating: true },
  ]);

  // Ctrl+1 while focused in main composer opens sub-e2e-1 and auto-focuses its .controls-input
  await page.locator('.controls-input').first().click();
  await page.keyboard.press('Control+Digit1');
  const subWin1 = page.locator('.subsession-window[data-subsession-id="sub-e2e-1"]');
  await expect(subWin1).toBeVisible();
  await expect(subWin1.locator('.controls-input')).toBeFocused();

  // Typing immediately inserts text into sub-session 1's composer
  await page.keyboard.type('hello sub one');
  await expect(subWin1.locator('.controls-input')).toContainText('hello sub one');

  // Ctrl+2 opens sub-e2e-2 and auto-focuses sub-session 2's composer
  await page.keyboard.press('Control+Digit2');
  const subWin2 = page.locator('.subsession-window[data-subsession-id="sub-e2e-2"]');
  await expect(subWin2).toBeVisible();
  await expect(subWin2.locator('.controls-input')).toBeFocused();

  // Repeated Ctrl+2 toggles sub-e2e-2 closed while leaving sub-e2e-1 open
  await page.keyboard.press('Control+Digit2');
  await expect(subWin2).toBeHidden();
  await expect(subWin1).toBeVisible();

  // Ctrl+2 again re-opens sub-e2e-2, then Ctrl+0 closes all open sub-session windows
  await page.keyboard.press('Control+Digit2');
  await expect(subWin2).toBeVisible();
  await page.keyboard.press('Control+Digit0');
  await expect(page.locator('.subsession-window:visible')).toHaveCount(0);
  await expect(subWin1).toBeHidden();
  await expect(subWin2).toBeHidden();

  // Configure custom Ctrl+Shift modifier for 1–9 and Alt+Shift+X for Close All in Settings -> Shortcuts
  await page.locator('button.server-icon[title="Settings"]').click();
  await page.locator('#settings-tab-shortcuts').click();
  await expect(page.getByTestId('subsession-quick-shortcuts-section')).toBeVisible();
  await expect(page.getByTestId('subsession-quick-preview-close')).toHaveCount(0);
  await page.getByTestId('shortcut-record-subSessionCloseAll').click();
  await page.keyboard.press('Alt+Shift+KeyX');
  await expect(page.getByTestId('shortcut-record-subSessionCloseAll')).toContainText('X');
  await page.getByTestId('subsession-mod-shift').click();
  await expect(page.getByTestId('subsession-quick-preview-open')).toContainText('Shift');
  await page.locator('.settings-back-btn').click();

  // Plain Ctrl+1 and Ctrl+0 no longer trigger, while Ctrl+Shift+1 toggles open/close and Alt+Shift+X closes all
  await page.locator('.controls-input').first().click();
  await page.keyboard.press('Control+Digit1');
  await expect(page.locator('.subsession-window:visible')).toHaveCount(0);

  await page.keyboard.press('Control+Shift+Digit1');
  await expect(subWin1).toBeVisible();
  await expect(subWin1.locator('.controls-input')).toBeFocused();

  await page.keyboard.press('Control+Shift+Digit1');
  await expect(subWin1).toBeHidden();

  await page.keyboard.press('Control+Shift+Digit1');
  await expect(subWin1).toBeVisible();
  await page.keyboard.press('Control+Digit0');
  await expect(subWin1).toBeVisible();

  await page.keyboard.press('Alt+Shift+KeyX');
  await expect(page.locator('.subsession-window:visible')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('floating bottom-left sequence badges do not increase sub-session button height and remain non-overlapping in expanded headers', async ({ page }) => {
  await openDesktopApp(page, 'Linux x86_64');

  const inspectGeometry = async () => page.evaluate(() => {
    const existing = document.getElementById('e2e-seq-geometry-fixture');
    existing?.remove();

    const host = document.createElement('div');
    host.id = 'e2e-seq-geometry-fixture';
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.top = '0';
    host.style.zIndex = '99999';
    host.style.background = '#080d16';
    host.innerHTML = `
      <div class="subsession-bar">
        <button id="geom-h-noseq" class="subsession-card mobile">
          <span class="subsession-card-icon">CC</span>
          <span class="subsession-card-label">Sub One</span>
          <span class="subsession-card-pin">📌</span>
          <span class="share-state-indicator">S</span>
          <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:50%"></span></span>
        </button>
        <button id="geom-h1" class="subsession-card has-seq mobile">
          <sup class="subsession-card-seq">1</sup>
          <span class="subsession-card-icon">CC</span>
          <span class="subsession-card-label">Sub One</span>
          <span class="subsession-card-pin">📌</span>
          <span class="share-state-indicator">S</span>
          <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:50%"></span></span>
        </button>
        <button id="geom-h12" class="subsession-card has-seq mobile open focused">
          <sup class="subsession-card-seq">12</sup>
          <span class="subsession-card-icon">CX</span>
          <span class="subsession-card-label">LongSession1</span>
          <span class="subsession-card-model">sonnet</span>
          <span class="subsession-card-pin">📌</span>
          <span class="share-state-indicator">S</span>
          <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:75%"></span></span>
        </button>
      </div>
      <div class="subsession-vertical-rail-host" style="height:260px">
        <div class="subsession-vertical-rail">
          <div class="subsession-vertical-rail-scroll">
            <button id="geom-r-noseq" class="subsession-card subsession-card-rail mobile">
              <span class="subsession-card-icon">CC</span>
              <span class="subsession-card-label">Sub One</span>
              <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:45%"></span></span>
            </button>
            <button id="geom-r1" class="subsession-card subsession-card-rail has-seq mobile">
              <sup class="subsession-card-seq">1</sup>
              <span class="subsession-card-icon">CC</span>
              <span class="subsession-card-label">Sub One</span>
              <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:45%"></span></span>
            </button>
            <button id="geom-r12" class="subsession-card subsession-card-rail has-seq mobile">
              <sup class="subsession-card-seq">12</sup>
              <span class="subsession-card-icon">CC</span>
              <span class="subsession-card-label">LongSession1</span>
              <span class="subsession-card-model">opus</span>
              <span class="subsession-card-pin">📌</span>
              <span class="share-state-indicator">S</span>
              <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:65%"></span></span>
            </button>
          </div>
        </div>
      </div>
      <div class="subsession-overflow-pills" style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 6px">
        <button id="geom-o-noseq" class="subsession-card mobile subsession-pill">
          <span class="subsession-card-icon">OC</span>
          <span class="subsession-card-label">Overflow12</span>
          <span class="subsession-card-model">gpt</span>
          <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:35%"></span></span>
        </button>
        <button id="geom-o12" class="subsession-card has-seq mobile subsession-pill">
          <sup class="subsession-card-seq">12</sup>
          <span class="subsession-card-icon">OC</span>
          <span class="subsession-card-label">Overflow12</span>
          <span class="subsession-card-model">gpt</span>
          <span class="subsession-card-ctx" style="width:100%"><span class="subsession-card-ctx-fill" style="width:35%"></span></span>
        </button>
      </div>
      <div class="subcard" style="width:240px">
        <div id="geom-eh1" class="subcard-header has-seq">
          <sup class="subcard-seq">1</sup>
          <span class="subcard-icon">CC</span>
          <span class="subcard-label">Expanded One</span>
          <span class="share-state-indicator">S</span>
        </div>
      </div>
      <div class="subcard subcard-preview-placeholder" style="width:240px">
        <div id="geom-eh12" class="subcard-header has-seq">
          <sup class="subcard-seq">12</sup>
          <span class="subcard-icon">CX</span>
          <span class="subcard-label">Placeholder Twelve</span>
          <span class="subcard-model">opus</span>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const overlapArea = (a: DOMRect, b: DOMRect) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

    const heightPairs = [
      ['geom-h-noseq', 'geom-h1'],
      ['geom-r-noseq', 'geom-r1'],
      ['geom-o-noseq', 'geom-o12'],
    ].map(([noSeqId, withSeqId]) => ({
      id: withSeqId,
      withoutHeight: document.getElementById(noSeqId)!.getBoundingClientRect().height,
      withHeight: document.getElementById(withSeqId)!.getBoundingClientRect().height,
    }));

    const compactIds = ['geom-h1', 'geom-h12', 'geom-r1', 'geom-r12', 'geom-o12'];
    const compactResults = compactIds.map((id) => {
      const card = document.getElementById(id)!;
      const cr = card.getBoundingClientRect();
      const seq = card.querySelector('.subsession-card-seq')!.getBoundingClientRect();
      return {
        id,
        inside: seq.left >= cr.left - 0.5 && seq.right <= cr.right + 0.5 && seq.top >= cr.top - 0.5 && seq.bottom <= cr.bottom + 0.5,
        bottomLeft: seq.left < cr.left + cr.width / 2 && seq.top >= cr.top + cr.height / 2,
      };
    });

    const expandedResults = ['geom-eh1', 'geom-eh12'].map((id) => {
      const hdr = document.getElementById(id)!;
      const hr = hdr.getBoundingClientRect();
      const seq = hdr.querySelector('.subcard-seq')!.getBoundingClientRect();
      const overlaps: Record<string, number> = {};
      for (const sel of ['.subcard-icon', '.subcard-label', '.subcard-model', '.share-state-indicator']) {
        const child = hdr.querySelector(sel);
        if (child) overlaps[sel] = overlapArea(seq, child.getBoundingClientRect());
      }
      return {
        id,
        inside: seq.left >= hr.left - 0.5 && seq.right <= hr.right + 0.5 && seq.top >= hr.top - 0.5 && seq.bottom <= hr.bottom + 0.5,
        bottomLeft: seq.left < hr.left + hr.width / 2 && seq.bottom <= hr.bottom + 0.5,
        overlaps,
      };
    });

    host.remove();
    return { heightPairs, compactResults, expandedResults };
  });

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const { heightPairs, compactResults, expandedResults } = await inspectGeometry();
    for (const pair of heightPairs) {
      expect(pair.withHeight, `${viewport.width}px ${pair.id} same height as unbadged`).toBeCloseTo(pair.withoutHeight, 1);
    }
    for (const r of compactResults) {
      expect(r.inside, `${viewport.width}px ${r.id} inside`).toBe(true);
      expect(r.bottomLeft, `${viewport.width}px ${r.id} bottomLeft`).toBe(true);
    }
    for (const r of expandedResults) {
      expect(r.inside, `${viewport.width}px ${r.id} inside`).toBe(true);
      expect(r.bottomLeft, `${viewport.width}px ${r.id} bottomLeft`).toBe(true);
      for (const [sel, area] of Object.entries(r.overlaps)) {
        expect(area, `${viewport.width}px ${r.id} vs ${sel}`).toBe(0);
      }
    }
  }
});
