import { expect, test } from '@playwright/test';

test('recovers after disconnect when ticket acquisition exceeds the recovery pulse interval', async ({ page }) => {
  let slowTickets = false;
  let tickets = 0;
  const sockets: Array<{ close(options: { code: number; reason: string }): void }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'browser-recovery-user', baseUrl: location.origin }));
    localStorage.setItem('rcc_server', 'browser-recovery-server');
    localStorage.setItem('rcc_session_browser-recovery-server', 'deck_e2e_recovery_brain');
    localStorage.setItem('i18nextLng', 'en');
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === '/api/auth/user/me') json = { id: 'browser-recovery-user' };
    else if (path === '/api/server') json = { servers: [{ id: 'browser-recovery-server', name: 'Isolated recovery', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() }] };
    else if (path === '/api/shares') json = { entries: [] };
    else if (path.endsWith('/ws-ticket')) {
      tickets++;
      if (slowTickets) await new Promise((resolve) => setTimeout(resolve, 8_000));
      json = { ticket: 'browser-recovery-ticket' };
    } else if (path.endsWith('/sessions')) json = { sessions: [] };
    await route.fulfill({ json }).catch(() => {});
  });
  await page.routeWebSocket('**/api/server/**/ws?*', (socket) => {
    sockets.push(socket);
    socket.onMessage((message) => {
      if (typeof message !== 'string') return;
      const msg = JSON.parse(message) as { type: string };
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'get_sessions') socket.send(JSON.stringify({ type: 'session_list', sessions: [{ name: 'deck_e2e_recovery_brain', project: 'e2e_recovery', role: 'brain', agentType: 'shell', state: 'idle', runtimeType: 'process' }] }));
    });
  });
  await page.goto('/#/browser-recovery-server');
  const dot = page.locator('.tab-ws-dot');
  await expect(dot).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  slowTickets = true;
  sockets[0].close({ code: 1012, reason: 'isolated recovery test' });
  await expect(dot).toHaveAttribute('title', 'Disconnected');
  await expect.poll(() => tickets).toBe(2);
  // Focus/pageshow/visibility can cluster on desktop resume. None should
  // replace an attempt that still owns its ticket/open deadline.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(dot).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  expect(tickets).toBe(2);
  expect(sockets).toHaveLength(2);
  // A local interaction also remains usable after recovery (no reload).
  const treeToggle = page.getByRole('button', { name: '⊞', exact: true });
  const wasPressed = await treeToggle.getAttribute('aria-pressed');
  await treeToggle.click();
  await expect(treeToggle).toHaveAttribute('aria-pressed', wasPressed === 'true' ? 'false' : 'true');
  expect(errors).toEqual([]);
});
