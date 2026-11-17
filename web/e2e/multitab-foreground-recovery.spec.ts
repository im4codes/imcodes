import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { generateChatTimelineFixture } from '../src/fixtures/chat-timeline/generators.js';
import { TIMELINE_MESSAGES, TIMELINE_ASSISTANT_TEXT_EVENT_TYPE } from '@shared/timeline-protocol.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '@shared/timeline-payload-budget.js';
import { DAEMON_COMMAND_TYPES } from '@shared/daemon-command-types.js';
import { SHARE_BROWSER_COMMANDS, SHARE_DAEMON_MESSAGE_TYPES } from '@shared/tab-sharing.js';
import { MSG_COMMAND_ACK } from '@shared/ack-protocol.js';
import { MESSAGE_PIN_EVENT_TYPES } from '@shared/message-pins.js';
import type { TimelineEvent } from '../src/ws-client.js';

type Tab = {
  page: Page; name: string; server: string; sockets: WebSocketRoute[]; counts: Record<string, number>;
  errors: string[]; durable: TimelineEvent[]; received: string[]; ping: boolean; initialBytes: number;
};
test.use({ serviceWorkers: 'block', trace: 'off' });
const servers = Array.from({ length: 4 }, (_, i) => `browser-multitab-server-${i}`);
function frame(event: TimelineEvent): string {
  const value = JSON.stringify({ type: TIMELINE_MESSAGES.EVENT, event });
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);
  return value;
}
function event(tab: Tab, id: string, seq: number, type: TimelineEvent['type'], payload: TimelineEvent['payload']): TimelineEvent {
  return { eventId: id, sessionId: tab.name, type, payload, epoch: 1, seq, ts: 1_800_000_000_000 + seq, source: 'daemon', confidence: 'high' };
}
async function openTab(page: Page, index: number): Promise<Tab> {
  const tab: Tab = { page, name: `deck_e2e_multitab_${index}_brain`, server: servers[index % 4], sockets: [],
    counts: {}, errors: [], durable: [], received: [], ping: true, initialBytes: 0 };
  page.on('pageerror', error => tab.errors.push(error.message));
  await page.addInitScript(({ name, server }) => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'browser-multitab-user', baseUrl: location.origin }));
    localStorage.setItem('rcc_server', server);
    localStorage.setItem(`rcc_session_${server}`, name);
    localStorage.setItem('i18nextLng', 'en');
    const root = window as any;
    const probe = root.__multitabProbe = { visibility: 'visible', offset: 0, longtasks: [] as number[],
      gaps: [] as number[], last: performance.now(), fullCopies: 0, sourceScans: 0, scanStacks: [] as string[], delivered: [] as Array<{ id: string; streaming: boolean }> };
    const now = Date.now.bind(Date);
    Date.now = () => now() + probe.offset;
    // Headless Chromium does not expose OS occlusion to these pages. The test
    // uses actual CDP freezing plus explicit visibility/time fault injection;
    // it is not evidence of a physical device's three-minute background sleep.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => probe.visibility });
    new PerformanceObserver(list => { for (const item of list.getEntries()) probe.longtasks.push(item.duration); })
      .observe({ type: 'longtask' });
    setInterval(() => { const n = performance.now(); probe.gaps.push(n - probe.last); probe.last = n; }, 50);
    const stringify = JSON.stringify;
    JSON.stringify = function (value: any, ...args: any[]) {
      if (typeof value?.payload?.text === 'string' && value.payload.text.startsWith('COMPLETED-HISTORY-')
        && value.payload.text.length > 256 * 1024) probe.fullCopies++;
      return stringify(value, ...args);
    } as typeof JSON.stringify;
    const replace = String.prototype.replace;
    String.prototype.replace = function (this: string, ...args: Parameters<typeof replace>) {
      if (this.length > 256 * 1024 && String(this).startsWith('COMPLETED-HISTORY-')) { probe.sourceScans++; if (probe.scanStacks.length < 4) probe.scanStacks.push(String(args[0]) + new Error().stack); }
      return replace.apply(this, args);
    } as typeof String.prototype.replace;
  }, { name: tab.name, server: tab.server });
  const sourceRows = [500, 2_000, 8_000][index % 3];
  const initial = generateChatTimelineFixture({ targetPresentationRows: sourceRows, seed: 424242 }).events
    .slice(-20).map(row => ({ ...row, sessionId: tab.name }));
  tab.initialBytes = Buffer.byteLength(JSON.stringify(initial));
  expect(tab.initialBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
  await page.route('https://picsum.photos/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>' }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    tab.counts[path] = (tab.counts[path] ?? 0) + 1;
    let json: unknown = {};
    if (path === '/api/auth/user/me') json = { id: 'browser-multitab-user' };
    else if (path === '/api/server') json = { servers: servers.map(id => ({ id, name: id, status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() })) };
    else if (path === '/api/shares') json = { entries: [] };
    else if (path.endsWith('/ws-ticket')) json = { ticket: 'synthetic-multitab-ticket' };
    else if (path.endsWith('/sessions')) json = { sessions: [] };
    else if (path.endsWith('/timeline/history/full')) json = { events: tab.durable, status: 'ok', hasMore: false };
    else if (path.startsWith('/api/preferences/')) json = { value: true };
    await route.fulfill({ json }).catch(() => {});
  });
  await page.routeWebSocket('**/api/server/**/ws?*', socket => {
    tab.sockets.push(socket);
    socket.onMessage(raw => {
      if (typeof raw !== 'string') return;
      const msg = JSON.parse(raw);
      tab.counts[`ws:${msg.type}`] = (tab.counts[`ws:${msg.type}`] ?? 0) + 1;
      if (msg.type === 'ping' && tab.ping) socket.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'get_sessions') socket.send(JSON.stringify({ type: SHARE_DAEMON_MESSAGE_TYPES.SESSION_LIST, sessions: [{ name: tab.name,
        project: 'e2e_multitab', role: 'brain', agentType: 'codex-sdk', state: 'idle', runtimeType: 'transport' }] }));
      if (msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST) socket.send(JSON.stringify({ type: TIMELINE_MESSAGES.HISTORY,
        sessionName: tab.name, requestId: msg.requestId, status: 'ok', source: 'worker_sqlite', epoch: 1,
        events: [...initial, ...tab.durable], hasMore: false }));
      if (msg.type === SHARE_BROWSER_COMMANDS.SESSION_SEND || msg.type === DAEMON_COMMAND_TYPES.SESSION_CANCEL) {
        tab.received.push(msg.type);
        socket.send(JSON.stringify({ type: MSG_COMMAND_ACK, commandId: msg.commandId, sessionName: tab.name, status: 'accepted' }));
      }
    });
  });
  await page.goto(`/?identityTestHooks=1#/${tab.server}`);
  await expect(page.locator('.controls-input')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).__identityTestWs__?.connected);
  await page.evaluate((timelineEventType) => {
    const root = window as any;
    root.__identityTestWs__.onMessage((msg: any) => {
      if (msg.type === timelineEventType) root.__multitabProbe.delivered.push({ id: msg.event.eventId, streaming: msg.event.payload.streaming === true });
    });
  }, TIMELINE_MESSAGES.EVENT);
  // Equivalent to many completed, individually legal native outputs, NOT a
  // giant history envelope. Only four tabs use the heaviest 32-answer shape.
  const answers = index % 4 === 0 ? 32 : index % 4 === 1 ? 8 : 0;
  for (let i = 0; i < answers; i++) {
    const seq = 1_000_000 + i * 4;
    for (const row of [
      event(tab, `question-${index}-${i}`, seq, MESSAGE_PIN_EVENT_TYPES.USER, { text: `isolated question ${i}` }),
      event(tab, `answer-${index}-${i}`, seq + 1, TIMELINE_ASSISTANT_TEXT_EVENT_TYPE,
        { text: `COMPLETED-HISTORY-${index}-${i}:` + 'synthetic completed output. '.repeat(12_000), streaming: false }),
      event(tab, `call-${index}-${i}`, seq + 2, 'tool.call', { tool: 'shell', toolCallId: `c-${i}`, input: 'isolated' }),
      event(tab, `result-${index}-${i}`, seq + 3, 'tool.result', { tool: 'shell', toolCallId: `c-${i}`, output: 'done' }),
    ]) tab.sockets.at(-1)!.send(frame(row));
  }
  if (answers) {
    await page.waitForFunction(id => (window as any).__multitabProbe.delivered.some((row: { id: string }) => row.id === id), `result-${index}-${answers - 1}`);
    // The real virtual list can be parked above the tail while its initial
    // large row heights settle. Position the fixture at the latest row before
    // starting the measured background/recovery operation.
    await expect.poll(async () => page.evaluate(() => {
      const view = document.querySelector('.chat-view')!;
      view.scrollTop = view.scrollHeight;
      return [...document.querySelectorAll('.chat-assistant')].at(-1)?.textContent?.slice(0, 80);
    }), { timeout: 15_000 }).toContain(`COMPLETED-HISTORY-${index}-${answers - 1}:`);
  }
  await page.waitForTimeout(1_000); // settle existing debounced cache writer, not a recovery workaround
  return tab;
}

async function cycle(tabs: Tab[], round: number) {
  const context = tabs[0].page.context();
  const before = tabs.map(tab => ({ sockets: tab.sockets.length, history: tab.counts[`ws:${TIMELINE_MESSAGES.HISTORY_REQUEST}`] ?? 0 }));
  const clients = [];
  for (const tab of tabs) {
    await tab.page.evaluate(() => {
      const p = (window as any).__multitabProbe;
      p.fullCopies = 0; p.sourceScans = 0; p.scanStacks = []; p.longtasks = []; p.gaps = []; p.delivered = []; p.visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const cdp = await context.newCDPSession(tab.page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    clients.push(cdp);
  }
  if (round === 2) await context.setOffline(true);
  for (const [index, tab] of tabs.entries()) {
    const seq = 2_000_000 + round * 100;
    const final = event(tab, `recovered-${round}-${index}`, seq + 40, TIMELINE_ASSISTANT_TEXT_EVENT_TYPE,
      { text: `RECOVERED-${round}-${index}`, streaming: false });
    const tool = event(tab, `recovered-tool-${round}-${index}`, seq + 41, 'tool.result', { tool: 'shell', output: `TOOL-${round}-${index}` });
    tab.durable = [final, tool];
    if (round === 2) tab.sockets.at(-1)!.close({ code: 1012, reason: 'isolated offline recovery' });
    else {
      // Real websocket delivery is frozen. Cumulative copies must coalesce;
      // the final body, tool and control state must not be discarded.
      for (let i = 0; i < 30; i++) tab.sockets.at(-1)!.send(frame({ ...final, seq: seq + i,
        payload: { text: 'busy synthetic text/tool context '.repeat(1_000) + i, streaming: true } }));
      tab.sockets.at(-1)!.send(frame(final));
      tab.sockets.at(-1)!.send(frame(tool));
    }
    if (round === 1) tab.ping = false;
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  if (round === 2) await context.setOffline(false);
  for (let i = 0; i < tabs.length; i++) {
    await clients[i].send('Page.setWebLifecycleState', { state: 'active' });
    await tabs[i].page.bringToFront(); // actual page focus, alongside the controlled visibility overlap
    await tabs[i].page.evaluate((round) => {
      const p = (window as any).__multitabProbe;
      if (round > 0) p.offset += 180_000;
      p.last = performance.now(); p.visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      if (round === 2) window.dispatchEvent(new Event('online'));
    }, round);
    tabs[i].ping = true;
  }
  const results = await Promise.all(tabs.map(async (tab, index) => {
    const start = Date.now();
    await tab.page.locator('.controls-input').fill(`isolated draft ${round}/${index}`);
    const inputMs = Date.now() - start;
    await expect.poll(async () => tab.page.locator('.chat-assistant').last().evaluate(el => el.textContent?.slice(-120)),
      { timeout: 20_000 }).toContain(`RECOVERED-${round}-${index}`);
    const readyMs = Date.now() - start;
    const toggle = tab.page.locator('button.btn[title="Session tree"]');
    const pressed = await toggle.getAttribute('aria-pressed');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true');
    const interactionMs = Date.now() - start;
    await tab.page.waitForTimeout(850);
    const metrics = await tab.page.evaluate(() => {
      const p = (window as any).__multitabProbe;
      return { fullCopies: p.fullCopies, sourceScans: p.sourceScans, scanStacks: p.scanStacks, longtasks: p.longtasks,
        maxGap: Math.max(0, ...p.gaps), pending: (window as any).__identityTestWs__.pendingTimelineEvents.length,
        delivered: p.delivered, rendered: document.querySelectorAll('.chat-event').length,
        heapBytes: (performance as any).memory?.usedJSHeapSize ?? null };
    });
    expect(tab.errors).toEqual([]);
    expect(metrics.pending).toBe(0);
    const finalId = `recovered-${round}-${index}`;
    if (round !== 2) expect(metrics.delivered.filter((row: { id: string; streaming: boolean }) => row.id === finalId && !row.streaming)).toHaveLength(1);
    if (round === 0) {
      expect(tab.sockets.length).toBe(before[index].sockets);
      expect(tab.counts[`ws:${TIMELINE_MESSAGES.HISTORY_REQUEST}`] ?? 0).toBe(before[index].history);
    }
    // Deterministic CPU-work guards complement noisy wall-clock samples. No
    // unchanged completed >256KiB body may be recopied for an 8..256KiB seed.
    expect(metrics.fullCopies, `old snapshot body copied on tab ${index}`).toBe(0);
    expect(metrics.sourceScans, `old display body rescanned on tab ${index}: ${JSON.stringify(metrics.scanStacks)}`).toBe(0);
    return { index, round, inputMs, readyMs, interactionMs, ...metrics, sockets: tab.sockets.length, counts: { ...tab.counts }, initialHistoryBytes: tab.initialBytes };
  }));
  for (const client of clients) await client.detach();
  return results;
}

test('sixteen same-origin App tabs recover three times without rescanning unchanged completed bodies', async ({ context }, info) => {
  test.setTimeout(240_000);
  const tabs: Tab[] = [];
  const results: unknown[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      tabs.push(await openTab(await context.newPage(), i));
      // Diagnostic controls use the same real pages, never DOM-card substitutes.
      if ([1, 4, 8].includes(tabs.length)) results.push({ tabs: tabs.length, diagnostic: true, metrics: await cycle(tabs, 0) });
    }
    for (let round = 0; round < 3; round++) results.push({ tabs: 16, round, metrics: await cycle(tabs, round) });
    // The actual input/urgent-control paths, not a paid provider invocation.
    const first = tabs[0];
    await first.page.locator('.controls-input').fill('isolated post-recovery send');
    await first.page.locator('.controls-input').press('Enter');
    await expect.poll(() => first.received.filter(type => type === SHARE_BROWSER_COMMANDS.SESSION_SEND).length).toBe(1);
    await first.page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => first.received.filter(type => type === DAEMON_COMMAND_TYPES.SESSION_CANCEL).length).toBe(1);
  } finally {
    await info.attach('multitab-metrics.json', { body: JSON.stringify({ browser: context.browser()?.version(),
      background: 'CDP frozen/active + controlled visibility; virtual 180s on stale/offline rounds, 250ms real freeze', results }, null, 2), contentType: 'application/json' });
    for (const tab of tabs) await tab.page.close();
  }
});
