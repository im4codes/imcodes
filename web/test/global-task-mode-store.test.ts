import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
  GLOBAL_TASK_TICKET_PATH,
  GLOBAL_TASK_WS_PATH,
  type GlobalTaskBrainSummary,
  type GlobalTaskBrainTextEvent,
  type GlobalTaskServerFrame,
  type GlobalTaskServerSummary,
  type GlobalTaskSummaryRow,
} from '@shared/global-task-mode.js';
import { configure as configureApi, configureApiKey, clearApiKey } from '../src/api.js';
import {
  clearGlobalTaskModeSessionState,
  computeDefaultMutedServerIds,
  formatTaskReplyMessage,
  GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY,
  GlobalTaskModeStore,
  MAX_RECENT_BRAINS,
  resolveQuickDispatchBrains,
  sortGlobalTaskCards,
  sortGlobalTaskServers,
} from '../src/global-task-mode-store.js';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Set<(ev: any) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(frame: GlobalTaskServerFrame): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  simulateUnexpectedClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason: 'lost' });
  }

  private emit(type: string, ev: any): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn(ev);
    }
  }
}

function makeTask(overrides: Partial<GlobalTaskSummaryRow> = {}): GlobalTaskSummaryRow {
  return {
    serverId: 'srv-1',
    serverName: 'Server 1',
    serverOnline: true,
    projectName: 'imcodes',
    brainSession: 'deck_imcodes_brain',
    brainLabel: 'Main Brain',
    taskId: 'tsk_1',
    title: 'Implement feature',
    status: 'working',
    flags: [],
    round: 1,
    checklist: { total: 4, implemented: 2, audited: 1 },
    createdAt: 1_000,
    updatedAt: 2_000,
    isTerminal: false,
    needsAttention: false,
    ...overrides,
  };
}

function makeBrain(overrides: Partial<GlobalTaskBrainSummary> = {}): GlobalTaskBrainSummary {
  return {
    serverId: 'srv-1',
    serverName: 'Server 1',
    serverOnline: true,
    sessionName: 'deck_imcodes_brain',
    projectName: 'imcodes',
    label: 'Main Brain',
    state: 'idle',
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('global-task-mode-store', () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const OriginalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let ticketCount = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    clearGlobalTaskModeSessionState();
    MockWebSocket.instances = [];
    ticketCount = 0;
    configureApi('https://app.im.codes');
    configureApiKey('test-bearer-key');

    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(GLOBAL_TASK_TICKET_PATH)) {
        ticketCount += 1;
        return new Response(JSON.stringify({ ticket: `ticket-${ticketCount}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/session/send')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ tasks: [], brains: [], servers: [], ts: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    clearGlobalTaskModeSessionState();
    clearApiKey();
    vi.useRealTimers();
    globalThis.WebSocket = OriginalWebSocket;
    globalThis.fetch = OriginalFetch;
  });

  it('opens strictly 1 WebSocket connection even across 30+ servers, sends set_filter, and closes on stop()', async () => {
    const store = new GlobalTaskModeStore();
    store.setMutedServerIds(['srv-muted']);

    await store.start();
    await store.start(); // duplicate start must not create another connection
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toBe(`wss://app.im.codes${GLOBAL_TASK_WS_PATH}?ticket=ticket-1`);
    ws.simulateOpen();
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({
      type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
      mutedServerIds: ['srv-muted'],
    });

    const servers: GlobalTaskServerSummary[] = Array.from({ length: 30 }, (_, idx) => ({
      id: `srv-${idx + 1}`,
      name: `Node ${idx + 1}`,
      online: true,
    }));
    const tasks = servers.map((srv, idx) => makeTask({ serverId: srv.id, serverName: srv.name, taskId: `tsk_${idx + 1}` }));
    const brains = servers.map((srv) => makeBrain({ serverId: srv.id, serverName: srv.name }));
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      tasks,
      brains,
      servers,
      ts: 12345,
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(store.getState().servers).toHaveLength(30);
    expect(store.getState().tasks).toHaveLength(30);

    store.stop();
    expect(ws.closeCalls).toHaveLength(1);
    expect(store.getState().connected).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects with exponential backoff after unexpected disconnect', async () => {
    const store = new GlobalTaskModeStore();
    await store.start();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateUnexpectedClose();

    expect(store.getState().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1]!;
    expect(ws2.url).toContain('ticket=ticket-2');
    ws2.simulateOpen();
    expect(store.getState().connected).toBe(true);
    store.stop();
  });

  it('merges snapshot, upsert, server_state, mutedServerIds filtering, and deduplicated brain_text', async () => {
    const store = new GlobalTaskModeStore();
    const receivedBrainTexts: GlobalTaskBrainTextEvent[] = [];
    const unsubText = store.subscribeBrainText((ev) => receivedBrainTexts.push(ev));

    await store.start();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      servers: [
        { id: 'srv-1', name: 'Node 1', online: true },
        { id: 'srv-2', name: 'Node 2', online: true },
      ],
      brains: [
        makeBrain({ serverId: 'srv-1', sessionName: 'brain_1', label: 'B1' }),
        makeBrain({ serverId: 'srv-2', sessionName: 'brain_2', label: 'B2' }),
      ],
      tasks: [
        makeTask({ serverId: 'srv-1', taskId: 'tsk_1', status: 'working', updatedAt: 100 }),
        makeTask({ serverId: 'srv-2', taskId: 'tsk_2', status: 'queued', updatedAt: 50 }),
      ],
      ts: 1000,
    });

    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.UPSERT,
      task: makeTask({
        serverId: 'srv-1',
        taskId: 'tsk_1',
        status: 'in_audit',
        checklist: { total: 4, implemented: 4, audited: 2 },
        updatedAt: 300,
      }),
    });
    expect(store.getState().tasks.find((t) => t.taskId === 'tsk_1')?.checklist).toEqual({
      total: 4,
      implemented: 4,
      audited: 2,
    });

    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SERVER_STATE,
      serverId: 'srv-1',
      online: false,
    });
    expect(store.getState().servers.find((s) => s.id === 'srv-1')?.online).toBe(false);
    expect(store.getState().tasks.find((t) => t.serverId === 'srv-1')?.serverOnline).toBe(false);
    expect(store.getState().brains.find((b) => b.serverId === 'srv-1')?.serverOnline).toBe(false);

    // Brain text delivery + eventId dedup
    const brainEvent: GlobalTaskBrainTextEvent = {
      serverId: 'srv-1',
      serverName: 'Node 1',
      sessionName: 'brain_1',
      projectName: 'imcodes',
      eventId: 'evt-1',
      text: 'Task audit passed cleanly.',
      ts: 400,
    };
    ws.simulateMessage({ type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT, event: brainEvent });
    ws.simulateMessage({ type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT, event: brainEvent });
    expect(receivedBrainTexts).toHaveLength(1);
    expect(store.getLatestBrainText('srv-1', 'brain_1')?.text).toBe('Task audit passed cleanly.');

    // Muting srv-2 filters tasks/brains immediately & sends set_filter to server
    store.setMutedServerIds(['srv-2']);
    expect(store.getState().tasks.some((t) => t.serverId === 'srv-2')).toBe(false);
    expect(store.getState().brains.some((b) => b.serverId === 'srv-2')).toBe(false);
    expect(ws.sent.map((s) => JSON.parse(s))).toContainEqual({
      type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
      mutedServerIds: ['srv-2'],
    });

    // Ignored brain_text for muted srv-2
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
      event: { ...brainEvent, serverId: 'srv-2', sessionName: 'brain_2', eventId: 'evt-muted' },
    });
    expect(receivedBrainTexts).toHaveLength(1);

    // Revocation snapshot (server removed from snapshot.servers) purges cached latestBrainTexts/tasks/brains
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      servers: [{ id: 'srv-2', name: 'Node 2', online: true }],
      brains: [],
      tasks: [],
      ts: 2000,
    });
    expect(store.getLatestBrainText('srv-1', 'brain_1')).toBeUndefined();

    unsubText();
    store.stop();
  });

  it('formats task reply prefixes in zh and en without duplicate wrapping', () => {
    expect(formatTaskReplyMessage('Fix\nBug\r\nTitle', '请继续', 'zh-CN')).toBe(
      '[关于任务「Fix Bug Title」]\n请继续',
    );
    expect(formatTaskReplyMessage('Fix Bug Title', 'Please check logs', 'en-US')).toBe(
      '[Regarding task "Fix Bug Title"]\nPlease check logs',
    );
    const alreadyZh = '[关于任务「Fix Bug Title」]\n请继续';
    expect(formatTaskReplyMessage('Fix Bug Title', alreadyZh, 'zh-CN')).toBe(alreadyZh);
    const alreadyEn = '[Regarding task "Fix Bug Title"]\nCheck';
    expect(formatTaskReplyMessage('Fix Bug Title', alreadyEn, 'en-US')).toBe(alreadyEn);
  });

  it('sorts active cards by priority and terminal cards by updatedAt desc', () => {
    const sorted = sortGlobalTaskCards([
      makeTask({ taskId: 'done_old', status: 'done', isTerminal: true, updatedAt: 100 }),
      makeTask({ taskId: 'done_new', status: 'cancelled', isTerminal: true, updatedAt: 900 }),
      makeTask({ taskId: 'queued', status: 'queued', updatedAt: 800 }),
      makeTask({ taskId: 'passed', status: 'passed', updatedAt: 700 }),
      makeTask({ taskId: 'working_old', status: 'working', updatedAt: 300 }),
      makeTask({ taskId: 'audit_new', status: 'in_audit', updatedAt: 600 }),
      makeTask({ taskId: 'attention', status: 'awaiting_brain_decision', needsAttention: true, updatedAt: 200 }),
    ]);
    expect(sorted.map((t) => t.taskId)).toEqual([
      'attention',
      'audit_new',
      'working_old',
      'passed',
      'queued',
      'done_new',
      'done_old',
    ]);
  });

  it('sends global Brain messages with or without taskTitle and updates recentBrains capped at 8', async () => {
    const store = new GlobalTaskModeStore();
    await store.sendGlobalBrainMessage({
      serverId: 'srv-1',
      sessionName: 'deck_a_brain',
      text: 'Approve merge',
      taskTitle: 'Global Store',
      locale: 'zh-CN',
      projectName: 'imcodes',
      label: 'A Brain',
    });

    const firstCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
    expect(firstCall).toBeDefined();
    const firstBody = JSON.parse(String((firstCall![1] as RequestInit).body));
    expect(firstBody.sessionName).toBe('deck_a_brain');
    expect(firstBody.text).toBe('[关于任务「Global Store」]\nApprove merge');

    for (let i = 0; i < 10; i++) {
      await store.sendGlobalBrainMessage({
        serverId: `srv-${i}`,
        sessionName: `brain_${i}`,
        text: `Raw dispatch ${i}`,
      });
    }

    const lastCall = fetchSpy.mock.calls.at(-1)!;
    expect(String(lastCall[0])).toContain('/api/server/srv-9/session/send');
    const lastBody = JSON.parse(String((lastCall[1] as RequestInit).body));
    expect(lastBody.text).toBe('Raw dispatch 9');
    expect(store.getState().recentBrains).toHaveLength(MAX_RECENT_BRAINS);
    expect(store.getState().recentBrains[0]?.sessionName).toBe('brain_9');
  });

  it('resolves quick dispatch Brains with pinned sessions only, keeping recent metadata and muted exclusion', () => {
    const brains: GlobalTaskBrainSummary[] = [
      makeBrain({ serverId: 'srv-1', sessionName: 'b1', label: 'One', serverOnline: true }),
      makeBrain({ serverId: 'srv-2', sessionName: 'b2', label: 'Two', serverOnline: true }),
      makeBrain({ serverId: 'srv-3', sessionName: 'b3', label: 'Three', serverOnline: false }),
    ];
    const quick = resolveQuickDispatchBrains(
      [
        { serverId: 'srv-2', sessionName: 'b2', label: 'Two' },
        { serverId: 'srv-1', sessionName: 'b1', label: 'One' },
      ],
      [
        { serverId: 'srv-3', sessionName: 'b3', lastUsedAt: 500 },
        { serverId: 'srv-1', sessionName: 'b1', lastUsedAt: 400 },
        { serverId: 'srv-2', sessionName: 'b2', lastUsedAt: 900 },
      ],
      brains,
      ['srv-1'],
    );
    // srv-1 is muted, srv-3 is only recent (unpinned) -> only pinned+unmuted srv-2 appears
    expect(quick.map((item) => ({ s: item.serverId, pinned: item.pinned, recent: item.recent }))).toEqual([
      { s: 'srv-2', pinned: true, recent: true },
    ]);
  });

  it('includes ONLY Tier 0 (serverPinned+sessionPinned) and Tier 1 (sessionPinned) in strict priority order, excluding all unpinned sessions', () => {
    const brains: GlobalTaskBrainSummary[] = [
      // Unpinned server + unpinned session (online, recently used) -> MUST be excluded
      makeBrain({ serverId: 'srv-plain-1', serverName: 'Plain 1', serverOnline: true, sessionName: 's_plain', label: 'Plain' }),
      // Pinned server + unpinned session -> MUST be excluded
      makeBrain({ serverId: 'srv-pin-b', serverName: 'Pinned B', serverOnline: true, sessionName: 's_pin_srv_only', label: 'PinSrvOnly' }),
      // Tier 1: unpinned server + workspace pinned session (same sessionName as Tier 0!)
      makeBrain({ serverId: 'srv-plain-2', serverName: 'Plain 2', serverOnline: true, sessionName: 'deck_shared_brain', label: 'SharedOnPlain' }),
      // Tier 1: unpinned server + task-mode starred session
      makeBrain({ serverId: 'srv-plain-1', serverName: 'Plain 1', serverOnline: true, sessionName: 's_starred_plain', label: 'StarredOnPlain' }),
      // Tier 0: pinned server (offline!) + workspace pinned session -> still stays Tier 0 above online Tier 1
      makeBrain({ serverId: 'srv-pin-b', serverName: 'Pinned B', serverOnline: false, sessionName: 'deck_shared_brain', label: 'SharedOnPinBOffline' }),
      // Tier 0: pinned server + workspace pinned session (online)
      makeBrain({ serverId: 'srv-pin-a', serverName: 'Pinned A', serverOnline: true, sessionName: 's_ws_pin_a', label: 'WsPinA' }),
      // Tier 0: pinned server + task-mode starred session
      makeBrain({ serverId: 'srv-pin-a', serverName: 'Pinned A', serverOnline: true, sessionName: 's_star_pin_a', label: 'StarPinA' }),
      // Muted pinned server -> must still be excluded
      makeBrain({ serverId: 'srv-pin-muted', serverName: 'Pinned Muted', serverOnline: true, sessionName: 's_ws_pin_a', label: 'MutedPin' }),
    ];

    const quick = resolveQuickDispatchBrains(
      [
        { serverId: 'srv-pin-a', sessionName: 's_star_pin_a', label: 'StarPinA' },
        { serverId: 'srv-plain-1', sessionName: 's_starred_plain', label: 'StarredOnPlain' },
      ],
      [
        { serverId: 'srv-plain-1', sessionName: 's_plain', lastUsedAt: 9_000 },
        { serverId: 'srv-pin-b', sessionName: 's_pin_srv_only', lastUsedAt: 8_000 },
        { serverId: 'srv-plain-2', sessionName: 'deck_shared_brain', lastUsedAt: 5_000 },
      ],
      brains,
      ['srv-pin-muted'],
      {
        pinnedServerIds: new Set(['srv-pin-a', 'srv-pin-b', 'srv-pin-muted']),
        pinnedSessionNames: new Set(['deck_shared_brain', 's_ws_pin_a']),
        serverOrder: ['srv-pin-b', 'srv-pin-a', 'srv-plain-2', 'srv-plain-1'],
        tabOrder: ['s_ws_pin_a', 'deck_shared_brain'],
      },
    );

    expect(quick.map((item) => `${item.serverId}:${item.sessionName}`)).toEqual([
      // Tier 0: explicit star first, then online before offline (same recent=0)
      'srv-pin-a:s_star_pin_a',
      'srv-pin-a:s_ws_pin_a',
      'srv-pin-b:deck_shared_brain',
      // Tier 1: explicit star first, then workspace pinned session (recent)
      'srv-plain-1:s_starred_plain',
      'srv-plain-2:deck_shared_brain',
    ]);
    expect(quick[0]).toMatchObject({ serverPinned: true, sessionPinned: true });
    expect(quick[2]).toMatchObject({ serverPinned: true, sessionPinned: true, serverOnline: false });
    expect(quick[3]).toMatchObject({ serverPinned: false, sessionPinned: true });
    expect(quick[4]).toMatchObject({ serverPinned: false, sessionPinned: true });
  });

  it('breaks ties within a tier by star order, lastUsedAt, online, serverOrder, tabOrder, and label', () => {
    const brains: GlobalTaskBrainSummary[] = [
      makeBrain({ serverId: 'srv-b', serverName: 'Zulu', serverOnline: true, sessionName: 'tab-2', label: 'Beta' }),
      makeBrain({ serverId: 'srv-a', serverName: 'Alpha', serverOnline: true, sessionName: 'tab-1', label: 'Alpha' }),
      makeBrain({ serverId: 'srv-a', serverName: 'Alpha', serverOnline: true, sessionName: 'tab-0', label: 'Gamma' }),
    ];

    const quick = resolveQuickDispatchBrains(
      [],
      [],
      brains,
      [],
      {
        pinnedServerIds: new Set(['srv-a', 'srv-b']),
        pinnedSessionNames: new Set(['tab-0', 'tab-1', 'tab-2']),
        serverOrder: ['srv-b', 'srv-a'],
        tabOrder: ['tab-1', 'tab-0'],
      },
    );

    // All Tier 0, unstarred, same lastUsedAt, all online -> serverOrder puts srv-b first, then tabOrder puts tab-1 before tab-0
    expect(quick.map((b) => `${b.serverId}:${b.sessionName}`)).toEqual([
      'srv-b:tab-2',
      'srv-a:tab-1',
      'srv-a:tab-0',
    ]);
  });

  it('sorts servers with pinned servers first (by serverOrder then name), then online-first unpinned servers', () => {
    const servers: GlobalTaskServerSummary[] = [
      { id: 'u-off', name: 'A-Offline', online: false },
      { id: 'u-on-b', name: 'B-Online', online: true },
      { id: 'u-on-a', name: 'A-Online', online: true },
      { id: 'p-off', name: 'Z-PinnedOffline', online: false },
      { id: 'p-on', name: 'M-PinnedOnline', online: true },
    ];

    const sorted = sortGlobalTaskServers(
      servers,
      new Set(['p-off', 'p-on']),
      ['p-off', 'u-on-b'],
    );

    expect(sorted.map((s) => s.id)).toEqual([
      'p-off',
      'p-on',
      'u-on-b',
      'u-on-a',
      'u-off',
    ]);
  });

  it('computes default muted servers from pinnedServerIds and falls back cleanly when none match', () => {
    const servers: GlobalTaskServerSummary[] = [
      { id: 'srv-pin', name: 'Pinned', online: true },
      { id: 'srv-a', name: 'A', online: true },
      { id: 'srv-b', name: 'B', online: false },
    ];

    expect(computeDefaultMutedServerIds(servers, new Set(['srv-pin']))).toEqual(['srv-a', 'srv-b']);
    expect(computeDefaultMutedServerIds(servers, new Set(['srv-pin', 'srv-a', 'srv-b']))).toEqual([]);
    expect(computeDefaultMutedServerIds(servers, new Set())).toEqual([]);
    expect(computeDefaultMutedServerIds(servers, undefined)).toEqual([]);
    expect(computeDefaultMutedServerIds(servers, new Set(['srv-missing']))).toEqual([]);
    expect(computeDefaultMutedServerIds([], new Set(['srv-pin']))).toEqual([]);
  });

  it('applies default muted filter idempotently without writing localStorage and never overwrites explicit user choices', async () => {
    const store = new GlobalTaskModeStore();
    expect(store.hasExplicitMutedServerFilter()).toBe(false);

    await store.start();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    // Consume initial SET_FILTER on open
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: [] },
    ]);

    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      ts: 1_000,
      servers: [
        { id: 'srv-pin', name: 'Pinned', online: true },
        { id: 'srv-unpin', name: 'Unpinned', online: true },
      ],
      tasks: [
        makeTask({ serverId: 'srv-pin', taskId: 'tsk_pin' }),
        makeTask({ serverId: 'srv-unpin', taskId: 'tsk_unpin' }),
      ],
      brains: [
        makeBrain({ serverId: 'srv-pin', sessionName: 's_pin' }),
        makeBrain({ serverId: 'srv-unpin', sessionName: 's_unpin' }),
      ],
    });

    const listener = vi.fn();
    store.subscribe(listener);

    // First default application mutes unpinned server and syncs SET_FILTER, without touching localStorage
    expect(store.applyDefaultMutedServerIds(['srv-unpin'])).toBe(true);
    expect(store.getState().mutedServerIds).toEqual(['srv-unpin']);
    expect(store.getState().tasks.map((t) => t.taskId)).toEqual(['tsk_pin']);
    expect(store.getState().brains.map((b) => b.sessionName)).toEqual(['s_pin']);
    expect(localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY)).toBeNull();
    expect(store.hasExplicitMutedServerFilter()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: [] },
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: ['srv-unpin'] },
    ]);

    // Idempotent re-application does not emit or send SET_FILTER
    expect(store.applyDefaultMutedServerIds(['srv-unpin'])).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(2);

    // Explicit user toggle to unmute all persists '[]' and blocks default override
    store.toggleMutedServer('srv-unpin');
    expect(store.hasExplicitMutedServerFilter()).toBe(true);
    expect(store.getState().mutedServerIds).toEqual([]);
    expect(localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY)).toBe('[]');
    expect(store.applyDefaultMutedServerIds(['srv-unpin'])).toBe(false);
    expect(store.getState().mutedServerIds).toEqual([]);

    // clearSessionState resets explicit flag
    store.clearSessionState();
    expect(store.hasExplicitMutedServerFilter()).toBe(false);

    // Pre-existing explicit '[]' in localStorage is respected by fresh store instance
    localStorage.setItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY, '[]');
    const restored = new GlobalTaskModeStore();
    expect(restored.hasExplicitMutedServerFilter()).toBe(true);
    expect(restored.applyDefaultMutedServerIds(['srv-unpin'])).toBe(false);
    expect(restored.getState().mutedServerIds).toEqual([]);
  });

  it('filters out terminal tasks older than 2 days on SNAPSHOT and UPSERT while preserving older active tasks', async () => {
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const store = new GlobalTaskModeStore();
    await store.start();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      servers: [{ id: 'srv-1', name: 'Node 1', online: true }],
      brains: [],
      tasks: [
        makeTask({ taskId: 'active_5d', status: 'working', isTerminal: false, updatedAt: now - 5 * 24 * 60 * 60 * 1000 }),
        makeTask({ taskId: 'done_boundary', status: 'done', isTerminal: true, updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS }),
        makeTask({ taskId: 'done_1d', status: 'done', isTerminal: true, updatedAt: now - 24 * 60 * 60 * 1000 }),
        makeTask({ taskId: 'done_stale', status: 'done', isTerminal: true, updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS - 1 }),
        makeTask({ taskId: 'cancelled_stale', status: 'cancelled', isTerminal: true, updatedAt: now - 3 * 24 * 60 * 60 * 1000 }),
      ],
      ts: now,
    });

    expect(store.getState().tasks.map((t) => t.taskId)).toEqual(['active_5d', 'done_1d', 'done_boundary']);

    // Stale terminal UPSERT for an unseen task is ignored
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.UPSERT,
      task: makeTask({
        taskId: 'unseen_stale_done',
        status: 'done',
        isTerminal: true,
        updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS - 1,
      }),
    });
    expect(store.getState().tasks.map((t) => t.taskId)).toEqual(['active_5d', 'done_1d', 'done_boundary']);

    // Stale terminal UPSERT closing an active task removes it from state instead of leaving an active ghost
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.UPSERT,
      task: makeTask({
        taskId: 'active_5d',
        status: 'done',
        isTerminal: true,
        updatedAt: now - GLOBAL_TASK_TERMINAL_WINDOW_MS - 1_000,
      }),
    });
    expect(store.getState().tasks.map((t) => t.taskId)).toEqual(['done_1d', 'done_boundary']);

    // Recent terminal UPSERT is retained
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.UPSERT,
      task: makeTask({
        taskId: 'done_fresh',
        status: 'cancelled',
        isTerminal: true,
        updatedAt: now - 1_000,
      }),
    });
    expect(store.getState().tasks.map((t) => t.taskId)).toEqual(['done_fresh', 'done_1d', 'done_boundary']);

    store.stop();
  });

  it('delivers global_tasks.notification frames with eventId dedup regardless of Task Mode UI mutedServerIds and refcounts acquire()', async () => {
    const store = new GlobalTaskModeStore();
    const received: unknown[] = [];
    const unsub = store.subscribeNotifications((ev) => received.push(ev));

    const release1 = store.acquire();
    const release2 = store.acquire();
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    // Mute srv-2 in Task Mode UI — notification frames for srv-2 still propagate to desktop notifier
    store.setMutedServerIds(['srv-2']);
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.NOTIFICATION,
      event: {
        eventId: 'notif-evt-1',
        title: 'Srv2 · brain',
        body: 'Waiting input',
        notificationType: 'waiting_input',
        serverId: 'srv-2',
        session: 'deck_srv2_brain',
        ts: 5000,
      },
    });
    // Duplicate eventId is dropped
    ws.simulateMessage({
      type: GLOBAL_TASK_MODE_MSG.NOTIFICATION,
      event: {
        eventId: 'notif-evt-1',
        title: 'Srv2 · brain',
        body: 'Waiting input',
        notificationType: 'waiting_input',
        serverId: 'srv-2',
        session: 'deck_srv2_brain',
        ts: 5000,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventId: 'notif-evt-1', serverId: 'srv-2' });

    // Releasing first consumer keeps connection open; releasing last stops it
    release1();
    expect(ws.closeCalls).toHaveLength(0);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    release2();
    expect(ws.closeCalls).toHaveLength(1);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    unsub();
  });

  it('resolves readable display labels and ignores stale internal session IDs in pinned/recent storage', () => {
    const store = new GlobalTaskModeStore();
    // Stale internal ID stored as label falls back cleanly to projectName / live formatted label
    const resolved = resolveQuickDispatchBrains(
      [
        { serverId: 'srv-1', sessionName: 'deck_cd_brain', label: 'deck_cd_brain', projectName: 'cd' },
        { serverId: 'srv-1', sessionName: 'deck_discord_brain', label: 'discord:1476187408042033309#general', projectName: 'discord-proj' },
      ],
      [],
      [
        makeBrain({ serverId: 'srv-1', sessionName: 'deck_cd_brain', label: 'deck_cd_brain', projectName: 'cd' }),
        makeBrain({ serverId: 'srv-1', sessionName: 'deck_discord_brain', label: 'discord:1476187408042033309#general', projectName: 'discord-proj' }),
      ],
      [],
    );
    expect(resolved.find((b) => b.sessionName === 'deck_cd_brain')?.label).toBe('cd');
    expect(resolved.find((b) => b.sessionName === 'deck_discord_brain')?.label).toBe('discord#general');

    store.togglePinnedBrain({
      serverId: 'srv-1',
      sessionName: 'deck_cd_brain',
      label: 'deck_cd_brain',
      projectName: 'cd',
    });
    expect(store.getState().pinnedBrains[0]?.label).toBe('cd');

    store.recordRecentBrain({
      serverId: 'srv-1',
      sessionName: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
      label: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
    });
    expect(store.getState().recentBrains[0]?.label).toBeUndefined();

    // Stale internal-only entries with no projectName and no live snapshot must never expose raw IDs
    const staleInternalOnly = resolveQuickDispatchBrains(
      [
        { serverId: 'srv-1', sessionName: 'deck_cd_brain', label: 'deck_cd_brain' },
        { serverId: 'srv-1', sessionName: 'bootmainxowfy6', label: 'bootmainxowfy6' },
        { serverId: 'srv-1', sessionName: 'deck_sub_pair_auto_6ac6fe82aa0aecfc', label: 'deck_sub_pair_auto_6ac6fe82aa0aecfc' },
      ],
      [],
      [],
      [],
    );
    expect(staleInternalOnly.find((b) => b.sessionName === 'deck_cd_brain')?.label).toBe('Brain');
    expect(staleInternalOnly.find((b) => b.sessionName === 'bootmainxowfy6')?.label).toBe('Brain');
    expect(staleInternalOnly.find((b) => b.sessionName === 'deck_sub_pair_auto_6ac6fe82aa0aecfc')?.label).toBe('Worker');
    for (const item of staleInternalOnly) {
      expect(item.label).not.toMatch(/^(deck_|bootmain)/);
    }
  });
});
