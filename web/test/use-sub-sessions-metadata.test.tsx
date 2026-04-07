/**
 * @vitest-environment jsdom
 *
 * Tests for sub-session metadata propagation via subsession.created and subsession.sync.
 * Verifies that provider display metadata (model, plan, quota) survives the WS → hook → state pipeline.
 */
import { render, cleanup, waitFor, act } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSubSessions, type SubSession } from '../src/hooks/useSubSessions.js';

vi.mock('../src/api.js', () => ({
  listSubSessions: vi.fn().mockResolvedValue([]),
  createSubSession: vi.fn(),
  patchSubSession: vi.fn(),
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
