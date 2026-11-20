import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_TASK_MODE_MSG,
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
  formatTaskReplyMessage,
  GlobalTaskModeStore,
  MAX_RECENT_BRAINS,
  resolveQuickDispatchBrains,
  sortGlobalTaskCards,
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

  it('resolves quick dispatch Brains with pinned first, recent backfill, and muted exclusion', () => {
    const brains: GlobalTaskBrainSummary[] = [
      makeBrain({ serverId: 'srv-1', sessionName: 'b1', label: 'One', serverOnline: true }),
      makeBrain({ serverId: 'srv-2', sessionName: 'b2', label: 'Two', serverOnline: true }),
      makeBrain({ serverId: 'srv-3', sessionName: 'b3', label: 'Three', serverOnline: false }),
    ];
    const quick = resolveQuickDispatchBrains(
      [{ serverId: 'srv-2', sessionName: 'b2', label: 'Two' }],
      [
        { serverId: 'srv-3', sessionName: 'b3', lastUsedAt: 500 },
        { serverId: 'srv-1', sessionName: 'b1', lastUsedAt: 400 },
        { serverId: 'srv-2', sessionName: 'b2', lastUsedAt: 900 },
      ],
      brains,
      ['srv-1'],
    );
    expect(quick.map((item) => ({ s: item.serverId, pinned: item.pinned, recent: item.recent }))).toEqual([
      { s: 'srv-2', pinned: true, recent: true },
      { s: 'srv-3', pinned: false, recent: true },
    ]);
  });
});
