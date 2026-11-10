import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { TIMELINE_ASSISTANT_TEXT_EVENT_TYPE, TIMELINE_MESSAGES } from '@shared/timeline-protocol.js';

async function openRecoveryApp(page: Page, streaming = false) {
  let slowTickets = false;
  let tickets = 0;
  const sockets: WebSocketRoute[] = [];
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
      if (msg.type === 'get_sessions') socket.send(JSON.stringify({ type: 'session_list', sessions: [{ name: 'deck_e2e_recovery_brain', project: 'e2e_recovery', role: 'brain', agentType: streaming ? 'codex-sdk' : 'shell', state: 'idle', runtimeType: streaming ? 'transport' : 'process' }] }));
    });
  });
  await page.goto(`${streaming ? '/?identityTestHooks=1' : '/'}#/browser-recovery-server`);
  await expect(page.locator('.tab-ws-dot')).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  return { sockets, errors, tickets: () => tickets, slowTickets: () => { slowTickets = true; } };
}

test('recovers after disconnect when ticket acquisition exceeds the recovery pulse interval', async ({ page }) => {
  const fixture = await openRecoveryApp(page);
  const dot = page.locator('.tab-ws-dot');
  await expect(dot).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  fixture.slowTickets();
  fixture.sockets[0].close({ code: 1012, reason: 'isolated recovery test' });
  await expect(dot).toHaveAttribute('title', 'Disconnected');
  await expect.poll(fixture.tickets).toBe(2);
  // Focus/pageshow/visibility can cluster on desktop resume. None should
  // replace an attempt that still owns its ticket/open deadline.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(dot).toHaveAttribute('title', /ms$/, { timeout: 15_000 });
  expect(fixture.tickets()).toBe(2);
  expect(fixture.sockets).toHaveLength(2);
  // A local interaction also remains usable after recovery (no reload).
  const treeToggle = page.getByRole('button', { name: '⊞', exact: true });
  const wasPressed = await treeToggle.getAttribute('aria-pressed');
  await treeToggle.click();
  await expect(treeToggle).toHaveAttribute('aria-pressed', wasPressed === 'true' ? 'false' : 'true');
  expect(fixture.errors).toEqual([]);
});

test('resumes a stalled stream queue without replaying every cumulative text copy', async ({ page }) => {
  // Hold only zero-delay consumer timers; real WebSocket IO and Preact's
  // frame/fallback scheduling continue. This is bounded background-throttling
  // fault injection, not a claim of real OS sleep.
  await page.addInitScript(() => {
    const root = window as any;
    const schedule = window.setTimeout.bind(window);
    const cancel = window.clearTimeout.bind(window);
    const pending = new Map<number, () => void>();
    let held = false;
    let nextId = 9_000_000;
    window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
      if (held && delay === 0 && typeof handler === 'function') {
        const id = nextId++;
        pending.set(id, () => handler(...args));
        return id;
      }
      return schedule(handler, delay, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = id => { if (!pending.delete(id!)) cancel(id); };
    root.__streamQueueProbe = {
      hold() { held = true; },
      release() { held = false; for (const run of pending.values()) schedule(run, 0); pending.clear(); },
    };
  });
  const fixture = await openRecoveryApp(page, true);
  await page.evaluate(() => {
    const root = window as any;
    root.__streamDelivered = 0;
    root.__identityTestWs__.onMessage((msg: { type: string }) => {
      if (msg.type === 'timeline.event') root.__streamDelivered++;
    });
    root.__streamQueueProbe.hold();
  });
  const count = 300;
  const text = 'Cumulative assistant output from an isolated test. '.repeat(1_200);
  for (let i = 0; i < count; i++) fixture.sockets[0].send(JSON.stringify({ type: TIMELINE_MESSAGES.EVENT, event: {
    eventId: 'transport:deck_e2e_recovery_brain:stream', sessionId: 'deck_e2e_recovery_brain',
    type: TIMELINE_ASSISTANT_TEXT_EVENT_TYPE, epoch: 1, seq: i + 1, ts: Date.now(), source: 'daemon', confidence: 'high',
    payload: { text: `${text}\nRECOVERY-SNAPSHOT-${i}`, streaming: true },
  } }));
  await page.waitForFunction(() => (window as any).__identityTestWs__.pendingTimelineEvents.at(-1)?.event.payload.text.endsWith('RECOVERY-SNAPSHOT-299'));
  expect(await page.evaluate(() => (window as any).__identityTestWs__.pendingTimelineEvents.length)).toBe(1);
  await page.evaluate(() => (window as any).__streamQueueProbe.release());
  await expect(page.locator('.chat-assistant').last()).toContainText('RECOVERY-SNAPSHOT-299');
  expect(await page.evaluate(() => (window as any).__streamDelivered)).toBe(2);
  const toggle = page.locator('button[aria-pressed]').filter({ hasText: '⊞' });
  const pressed = await toggle.getAttribute('aria-pressed');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
  expect(fixture.errors).toEqual([]);
});
