/**
 * @vitest-environment jsdom
 *
 * Tests for sub-session metadata propagation via subsession.created and subsession.sync.
 * Verifies that provider display metadata (model, plan, quota) survives the WS → hook → state pipeline.
 */
import { render, cleanup, waitFor, act } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSubSessions, type SubSession } from '../src/hooks/useSubSessions.js';
import { listSubSessions, patchSubSession } from '../src/api.js';

vi.mock('../src/api.js', () => ({
  listSubSessions: vi.fn().mockResolvedValue([]),
  createSubSession: vi.fn(),
  patchSubSession: vi.fn().mockResolvedValue(undefined),
}));

type MsgHandler = (msg: any) => void;

function createMockWs() {
  const handlers: MsgHandler[] = [];
  return {
    ws: {
      subSessionRebuildAll: vi.fn(),
      onMessage: vi.fn((fn: MsgHandler) => {
        handlers.push(fn);
        return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); };
      }),
    } as any,
    send(msg: any) { handlers.forEach((h) => h(msg)); },
  };
}

let captured: SubSession[] = [];

function Harness({ ws, connected }: { ws: any; connected: boolean }) {
  const { subSessions } = useSubSessions('srv1', ws, connected, null);
  captured = subSessions;
  return null;
}

let closeSubSessionHook: ((id: string) => Promise<void>) | null = null;
let renameSubSessionHook: ((id: string, label: string) => Promise<void>) | null = null;

function CloseHarness({ ws, connected }: { ws: any; connected: boolean }) {
  const { subSessions, close } = useSubSessions('srv1', ws, connected, null);
  captured = subSessions;
  closeSubSessionHook = close;
  return null;
}

function RenameHarness({ ws, connected }: { ws: any; connected: boolean }) {
  const { subSessions, rename } = useSubSessions('srv1', ws, connected, null);
  captured = subSessions;
  renameSubSessionHook = rename;
  return null;
}

describe('sub-session metadata via subsession.created', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; });

  it('stores Qwen metadata fields from subsession.created', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q1',
      sessionName: 'deck_sub_q1',
      sessionType: 'qwen',
      state: 'running',
      cwd: '/tmp/proj',
      label: 'Qwen Worker',
      qwenModel: 'qwen-max-latest',
      qwenAuthType: 'qwen-oauth',
      modelDisplay: 'Qwen Max',
      planLabel: 'Free',
      quotaLabel: '1,000/day',
      quotaUsageLabel: 'today 5/1000',
      effort: 'medium',
    }));

    expect(captured).toHaveLength(1);
    const s = captured[0];
    expect(s.qwenModel).toBe('qwen-max-latest');
    expect(s.qwenAuthType).toBe('qwen-oauth');
    expect(s.modelDisplay).toBe('Qwen Max');
    expect(s.planLabel).toBe('Free');
    expect(s.quotaLabel).toBe('1,000/day');
    expect(s.quotaUsageLabel).toBe('today 5/1000');
    expect(s.effort).toBe('medium');
  });

  it('defaults metadata to null when not provided', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'cc1',
      sessionName: 'deck_sub_cc1',
      sessionType: 'claude-code',
    }));

    expect(captured).toHaveLength(1);
    const s = captured[0];
    expect(s.state).toBe('idle');
    expect(s.modelDisplay).toBeNull();
    expect(s.planLabel).toBeNull();
    expect(s.quotaLabel).toBeNull();
    expect(s.quotaUsageLabel).toBeNull();
    expect(s.qwenModel).toBeNull();
  });
});

describe('sub-session metadata via subsession.sync', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; });

  it('merges metadata into existing sub-session', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q2',
      sessionName: 'deck_sub_q2',
      sessionType: 'qwen',
      state: 'running',
    }));
    expect(captured[0].modelDisplay).toBeNull();

    act(() => send({
      type: 'subsession.sync',
      id: 'q2',
      modelDisplay: 'Qwen Turbo',
      planLabel: 'Paid',
      quotaUsageLabel: 'today 10/5000',
      effort: 'high',
    }));

    expect(captured[0].modelDisplay).toBe('Qwen Turbo');
    expect(captured[0].planLabel).toBe('Paid');
    expect(captured[0].quotaUsageLabel).toBe('today 10/5000');
    expect(captured[0].effort).toBe('high');
  });

  it('ignores sync for unknown id', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'x1',
      sessionName: 'deck_sub_x1',
      sessionType: 'shell',
      state: 'running',
    }));

    const before = [...captured];
    act(() => send({ type: 'subsession.sync', id: 'unknown123', modelDisplay: 'nope' }));
    expect(captured).toEqual(before);
  });


  it('stores codex-sdk model, level, and quota metadata from sync', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'cxsdk1',
      sessionName: 'deck_sub_cxsdk1',
      sessionType: 'codex-sdk',
      state: 'running',
    }));

    act(() => send({
      type: 'subsession.sync',
      id: 'cxsdk1',
      modelDisplay: 'gpt-5.4',
      planLabel: 'Pro',
      quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
      effort: 'high',
    }));

    expect(captured[0].modelDisplay).toBe('gpt-5.4');
    expect(captured[0].planLabel).toBe('Pro');
    expect(captured[0].quotaLabel).toContain('5h 11%');
    expect(captured[0].effort).toBe('high');
  });

  it('partial sync keeps existing values', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q3',
      sessionName: 'deck_sub_q3',
      sessionType: 'qwen',
      state: 'running',
      modelDisplay: 'Qwen Max',
      planLabel: 'Free',
    }));

    // Sync only updates quotaUsageLabel, should keep modelDisplay and planLabel
    act(() => send({ type: 'subsession.sync', id: 'q3', quotaUsageLabel: 'today 20/1000' }));

    expect(captured[0].modelDisplay).toBe('Qwen Max');
    expect(captured[0].planLabel).toBe('Free');
    expect(captured[0].quotaUsageLabel).toBe('today 20/1000');
  });

  it('preserves queued transport messages while the drained send is still running and clears on authoritative idle', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q4',
      sessionName: 'deck_sub_q4',
      sessionType: 'qwen',
      state: 'running',
    }));

    // Queue two messages
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q4',
        payload: {
          state: 'queued',
          pendingMessages: ['queued one', 'queued two'],
          pendingMessageEntries: [
            { clientMessageId: 'msg-1', text: 'queued one' },
            { clientMessageId: 'msg-2', text: 'queued two' },
          ],
        },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual(['queued one', 'queued two']);
    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);

    // Drain: running without pending field → preserves queue (messages still in flight)
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q4',
        payload: { state: 'running' },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual(['queued one', 'queued two']);
    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);

    // Idle without queue fields is state-only; queue must stay visible until
    // an authoritative empty queue snapshot arrives.
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q4',
        payload: { state: 'idle' },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual(['queued one', 'queued two']);
    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'msg-2', text: 'queued two' },
    ]);

    // Authoritative idle with empty queue clears
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q4',
        payload: { state: 'idle', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual([]);
    expect(captured[0].transportPendingMessageEntries).toEqual([]);
  });

  it('clears queue when running event carries explicit empty pending (drain completed)', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q5',
      sessionName: 'deck_sub_q5',
      sessionType: 'qwen',
      state: 'running',
    }));

    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q5',
        payload: {
          state: 'queued',
          pendingMessages: ['msg'],
          pendingMessageEntries: [{ clientMessageId: 'msg-1', text: 'msg' }],
        },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual(['msg']);

    // Running with explicit empty pending — drain dispatched the message.
    // Daemon emits user.message simultaneously, so queue must clear.
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q5',
        payload: { state: 'running', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual([]);
    expect(captured[0].transportPendingMessageEntries).toEqual([]);

    // Subsequent idle is a no-op for queue (already empty)
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q5',
        payload: { state: 'idle', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));

    expect(captured[0].transportPendingMessages).toEqual([]);
    expect(captured[0].transportPendingMessageEntries).toEqual([]);
  });

  it('fills missing queued transport entries from pendingMessages when daemon sends a partial entry snapshot', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'q4',
      sessionName: 'deck_sub_q4',
      sessionType: 'qwen',
      state: 'running',
    }));

    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_q4',
        payload: {
          state: 'queued',
          pendingMessages: ['queued one', 'queued two'],
          pendingMessageEntries: [
            { clientMessageId: 'msg-1', text: 'queued one' },
          ],
        },
      },
    }));

    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'msg-1', text: 'queued one' },
      { clientMessageId: 'deck_sub_q4:legacy:1:queued two', text: 'queued two' },
    ]);
  });
});

describe('sub-session metadata integration', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; });

  it('created → sync sequence yields latest metadata', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'seq1',
      sessionName: 'deck_sub_seq1',
      sessionType: 'qwen',
      state: 'running',
      modelDisplay: 'Initial Model',
      planLabel: 'Free',
    }));

    act(() => send({
      type: 'subsession.sync',
      id: 'seq1',
      modelDisplay: 'Updated Model',
      planLabel: 'Paid',
    }));

    expect(captured[0].modelDisplay).toBe('Updated Model');
    expect(captured[0].planLabel).toBe('Paid');
  });

  it('multiple sub-sessions get independent metadata', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => {
      send({ type: 'subsession.created', id: 'a1', sessionName: 'deck_sub_a1', sessionType: 'qwen', state: 'running', planLabel: 'Free' });
      send({ type: 'subsession.created', id: 'b1', sessionName: 'deck_sub_b1', sessionType: 'codex', state: 'running', planLabel: null });
    });

    act(() => send({ type: 'subsession.sync', id: 'a1', quotaUsageLabel: 'today 1/1000' }));

    const a = captured.find((s) => s.id === 'a1')!;
    const b = captured.find((s) => s.id === 'b1')!;
    expect(a.planLabel).toBe('Free');
    expect(a.quotaUsageLabel).toBe('today 1/1000');
    expect(b.planLabel).toBeNull();
    expect(b.quotaUsageLabel).toBeNull();
  });

  it('subsession.removed cleans up fully', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'rm1',
      sessionName: 'deck_sub_rm1',
      sessionType: 'qwen',
      state: 'running',
      modelDisplay: 'Model',
      planLabel: 'Free',
    }));
    expect(captured).toHaveLength(1);

    act(() => send({ type: 'subsession.removed', id: 'rm1', sessionName: 'deck_sub_rm1' }));
    expect(captured).toHaveLength(0);
  });
});

describe('sub-session realtime state sync', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; });

  it('marks a sub-session running on assistant/tool timeline events and idle on session.idle', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'run1',
      sessionName: 'deck_sub_run1',
      sessionType: 'codex-sdk',
      state: 'idle',
    }));
    expect(captured[0]?.state).toBe('idle');

    act(() => send({
      type: 'timeline.event',
      event: {
        eventId: 'e1',
        sessionId: 'deck_sub_run1',
        ts: 100,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'assistant.text',
        payload: { text: 'working' },
      },
    }));
    expect(captured[0]?.state).toBe('running');

    act(() => send({
      type: 'timeline.event',
      event: {
        eventId: 'e2',
        sessionId: 'deck_sub_run1',
        ts: 101,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'tool.call',
        payload: { tool: 'read_file' },
      },
    }));
    expect(captured[0]?.state).toBe('running');

    act(() => send({
      type: 'session.idle',
      session: 'deck_sub_run1',
    }));
    expect(captured[0]?.state).toBe('idle');
  });

  it('tracks stopping and error states from timeline events', async () => {
    const { ws, send } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());

    act(() => send({
      type: 'subsession.created',
      id: 'run2',
      sessionName: 'deck_sub_run2',
      sessionType: 'codex',
      state: 'running',
    }));

    act(() => send({
      type: 'timeline.event',
      event: {
        eventId: 'e3',
        sessionId: 'deck_sub_run2',
        ts: 200,
        seq: 1,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'session.state',
        payload: { state: 'stopping' },
      },
    }));
    expect(captured[0]?.state).toBe('stopping');

    act(() => send({
      type: 'timeline.event',
      event: {
        eventId: 'e4',
        sessionId: 'deck_sub_run2',
        ts: 201,
        seq: 2,
        epoch: 1,
        source: 'daemon',
        confidence: 'high',
        type: 'session.state',
        payload: { state: 'error' },
      },
    }));
    expect(captured[0]?.state).toBe('error');
  });
});

describe('sub-session close behavior', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; closeSubSessionHook = null; });

  it('marks a sub-session stopping locally and waits for daemon/server confirmation before removal', async () => {
    vi.mocked(listSubSessions).mockResolvedValueOnce([
      {
        id: 'stop1',
        serverId: 'srv1',
        type: 'codex',
        runtimeType: 'process',
        providerId: null,
        providerSessionId: null,
        shellBin: null,
        cwd: '/tmp/proj',
        ccSessionId: null,
        geminiSessionId: null,
        parentSession: 'deck_app_brain',
        label: 'Worker',
        description: null,
        ccPresetId: null,
        requestedModel: null,
        activeModel: null,
        qwenModel: null,
        qwenAuthType: null,
        qwenAvailableModels: null,
        modelDisplay: null,
        planLabel: null,
        quotaLabel: null,
        quotaUsageLabel: null,
        quotaMeta: null,
        effort: null,
        transportConfig: null,
        closedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { ws, send } = createMockWs();
    (ws as any).subSessionStop = vi.fn();
    render(<CloseHarness ws={ws} connected={true} />);
    await waitFor(() => expect(captured).toHaveLength(1));

    await act(async () => {
      await closeSubSessionHook?.('stop1');
    });

    expect((ws as any).subSessionStop).toHaveBeenCalledWith('deck_sub_stop1');
    expect(vi.mocked(patchSubSession)).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.state).toBe('stopping');

    act(() => send({ type: 'subsession.removed', id: 'stop1', sessionName: 'deck_sub_stop1' }));
    expect(captured).toHaveLength(0);
  });
});

describe('sub-session rename behavior', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; renameSubSessionHook = null; });

  it('persists label changes through the API and updates local state without direct ws rename commands', async () => {
    vi.mocked(listSubSessions).mockResolvedValueOnce([
      {
        id: 'rename1',
        serverId: 'srv1',
        type: 'codex',
        runtimeType: 'process',
        providerId: null,
        providerSessionId: null,
        shellBin: null,
        cwd: '/tmp/proj',
        ccSessionId: null,
        geminiSessionId: null,
        parentSession: 'deck_app_brain',
        label: 'Old Label',
        description: null,
        ccPresetId: null,
        requestedModel: null,
        activeModel: null,
        qwenModel: null,
        qwenAuthType: null,
        qwenAvailableModels: null,
        modelDisplay: null,
        planLabel: null,
        quotaLabel: null,
        quotaUsageLabel: null,
        quotaMeta: null,
        effort: null,
        transportConfig: null,
        closedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { ws } = createMockWs();
    (ws as any).subSessionRename = vi.fn();
    render(<RenameHarness ws={ws} connected={true} />);
    await waitFor(() => expect(captured).toHaveLength(1));

    await act(async () => {
      await renameSubSessionHook?.('rename1', 'New Label');
    });

    expect(vi.mocked(patchSubSession)).toHaveBeenCalledWith('srv1', 'rename1', { label: 'New Label' });
    expect(captured[0]?.label).toBe('New Label');
    expect((ws as any).subSessionRename).not.toHaveBeenCalled();
  });
});

describe('queue visibility e2e — queued messages must stay visible until turn completes', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); captured = []; });

  async function setupSession(ws: any, send: (m: any) => void) {
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(ws.onMessage).toHaveBeenCalled());
    act(() => send({
      type: 'subsession.created',
      id: 'eq1',
      sessionName: 'deck_sub_eq1',
      sessionType: 'claude-code-sdk',
      state: 'running',
    }));
  }

  function queueMessages(send: (m: any) => void) {
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: {
          state: 'queued',
          pendingMessages: ['fix the bug', 'then add tests'],
          pendingMessageEntries: [
            { clientMessageId: 'q1', text: 'fix the bug' },
            { clientMessageId: 'q2', text: 'then add tests' },
          ],
        },
      },
    }));
  }

  function expectQueueVisible() {
    expect(captured[0].transportPendingMessages).toEqual(['fix the bug', 'then add tests']);
    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'q1', text: 'fix the bug' },
      { clientMessageId: 'q2', text: 'then add tests' },
    ]);
  }

  function expectQueueCleared() {
    expect(captured[0].transportPendingMessages?.length ?? 0).toBe(0);
    expect(captured[0].transportPendingMessageEntries?.length ?? 0).toBe(0);
  }

  it('preserves queue on idle without pending fields until authoritative empty idle arrives', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // State-only idle must not clear the queue.
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'idle' } },
    }));
    expectQueueVisible();

    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: { state: 'idle', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));
    expectQueueCleared();
  });

  it('does not clear queue on session.idle notification', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    act(() => send({
      type: 'session.idle',
      session: 'deck_sub_eq1',
      project: 'proj',
      agentType: 'codex-sdk',
    }));
    expectQueueVisible();
  });

  it('preserves queue on idle with attached pending snapshot', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);

    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: {
          state: 'idle',
          pendingMessages: ['fix the bug', 'then add tests'],
          pendingMessageEntries: [
            { clientMessageId: 'q1', text: 'fix the bug' },
            { clientMessageId: 'q2', text: 'then add tests' },
          ],
        },
      },
    }));
    expectQueueVisible();
  });

  it('survives drain running event (no pending field) — queue stays', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // onDrain fires running WITHOUT pending fields (drained messages in flight)
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'running' } },
    }));
    expectQueueVisible();
  });

  it('survives streaming status changes (no pending field) — queue stays', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);

    // Multiple running events during streaming (onStatusChange thinking/streaming → running)
    for (let i = 0; i < 5; i++) {
      act(() => send({
        type: 'timeline.event',
        event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'running' } },
      }));
    }
    expectQueueVisible();
  });

  it('clears on authoritative idle (with pending field) — turn completed', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // Runtime idle with authoritative pending=[] (turn truly completed, no more pending)
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: { state: 'idle', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));
    expectQueueCleared();
  });

  it('clears queue on running with explicit empty pending (drain completed)', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // Drain fires → daemon emits running WITH explicit empty pending.
    // user.message simultaneously appears in timeline. Queue must clear now.
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: { state: 'running', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));
    expectQueueCleared();
  });

  it('full lifecycle: queue → running → idle clears', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // Step 1: agent picks up message → running with empty pending
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'running' } },
    }));
    expectQueueVisible(); // running without pending field — queue stays

    // Step 2: streaming status changes (still running)
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'running' } },
    }));
    expectQueueVisible(); // still in flight

    // Step 3: state-only idle does not clear queue
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'idle' } },
    }));
    expectQueueVisible();

    // Step 4: authoritative empty idle clears queue
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: { state: 'idle', pendingMessages: [], pendingMessageEntries: [] },
      },
    }));
    expectQueueCleared();
  });

  it('updates queue when new queued event arrives mid-flight', async () => {
    const { ws, send } = createMockWs();
    await setupSession(ws, send);
    queueMessages(send);
    expectQueueVisible();

    // Drain (no pending field)
    act(() => send({
      type: 'timeline.event',
      event: { type: 'session.state', sessionId: 'deck_sub_eq1', payload: { state: 'running' } },
    }));
    expectQueueVisible();

    // User queues a NEW message while drained turn is in flight
    act(() => send({
      type: 'timeline.event',
      event: {
        type: 'session.state',
        sessionId: 'deck_sub_eq1',
        payload: {
          state: 'queued',
          pendingMessages: ['deploy to prod'],
          pendingMessageEntries: [{ clientMessageId: 'q3', text: 'deploy to prod' }],
        },
      },
    }));

    // Queue updated to only the new message (old ones were drained)
    expect(captured[0].transportPendingMessages).toEqual(['deploy to prod']);
    expect(captured[0].transportPendingMessageEntries).toEqual([
      { clientMessageId: 'q3', text: 'deploy to prod' },
    ]);
  });
});
