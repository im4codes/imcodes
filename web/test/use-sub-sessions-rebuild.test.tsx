/**
 * @vitest-environment jsdom
 */
import { render, cleanup, waitFor, act } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSubSessions } from '../src/hooks/useSubSessions.js';

const listSubSessions = vi.fn();

vi.mock('../src/api.js', () => ({
  listSubSessions: (...args: any[]) => listSubSessions(...args),
  createSubSession: vi.fn(),
  patchSubSession: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useSubSessions rebuild gating', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not rebuild stale sub-sessions before a fresh reconnect load completes', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const stale = [{ id: 'old1', type: 'shell', shellBin: null, cwd: null, label: null, parentSession: 'deck_reconntest8e1ile_w10', createdAt: Date.now(), updatedAt: Date.now() }];
    listSubSessions.mockResolvedValueOnce(stale);

    function Harness(props: { connected: boolean }) {
      useSubSessions('srv1', ws, props.connected, null);
      return null;
    }

    const view = render(<Harness connected={true} />);
    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1));

    view.rerender(<Harness connected={false} />);

    const fresh = deferred<any[]>();
    listSubSessions.mockReturnValueOnce(fresh.promise);
    view.rerender(<Harness connected={true} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);

    fresh.resolve([]);
    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);
  });

  it('preserves transport runtime metadata in rebuild payloads', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    listSubSessions.mockResolvedValueOnce([{
      id: 'q1',
      serverId: 'srv1',
      type: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'qwen-session-1',
      shellBin: null,
      cwd: '/tmp/project',
      label: 'qwen worker',
      parentSession: 'deck_proj_brain',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);

    function Harness() {
      useSubSessions('srv1', ws, true, 'deck_proj_brain');
      return null;
    }

    render(<Harness />);

    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'q1',
        type: 'qwen',
        runtimeType: 'transport',
        providerId: 'qwen',
        providerSessionId: 'qwen-session-1',
      }),
    ]);
  });

  it('infers copilot-sdk as transport when persisted runtimeType is missing', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    listSubSessions.mockResolvedValueOnce([{
      id: 'cp1',
      serverId: 'srv1',
      type: 'copilot-sdk',
      runtimeType: null,
      providerId: null,
      providerSessionId: null,
      shellBin: null,
      cwd: '/tmp/project',
      label: 'copilot worker',
      parentSession: 'deck_proj_brain',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);

    function Harness() {
      useSubSessions('srv1', ws, true, 'deck_proj_brain');
      return null;
    }

    render(<Harness />);

    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'cp1',
        type: 'copilot-sdk',
        runtimeType: 'transport',
      }),
    ]);
  });

  // Regression: a half-open socket healed by a ping/pong probe arrives as a
  // `connected`/`probe_recovered` event WITHOUT the `connected` boolean ever
  // flipping. Sub-session reload + rebuild (→ subsession.sync carrying fresh
  // runtime state) must still re-fire, otherwise a sub-session that went idle
  // while the frontend was away stays stuck on `running` (perpetual card pulse).
  it('resyncs sub-sessions on probe-recovery reconnect even when `connected` never flips', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const ws = {
      subSessionRebuildAll: vi.fn(),
      onMessage: vi.fn((cb: (msg: any) => void) => { handlers.push(cb); return () => {}; }),
    } as any;
    const fire = (msg: any) => { for (const h of [...handlers]) h(msg); };
    const sub = { id: 's1', type: 'shell', shellBin: null, cwd: null, label: null, parentSession: 'deck_probetest_w1', createdAt: Date.now(), updatedAt: Date.now() };
    listSubSessions.mockResolvedValue([sub]); // same membership on every load

    function Harness() {
      // `connected` stays true the whole test — a probe recovery never flips it.
      useSubSessions('srv1', ws, true, null);
      return null;
    }
    render(<Harness />);

    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1));

    await act(async () => {
      fire({ type: 'session.event', event: 'connected', session: '', state: 'connected', reason: 'probe_recovered' });
    });

    // Reload re-fires, cascading into a fresh rebuild → subsession.sync(state).
    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(2));
  });

  // The trigger is precise: only `probe_recovered` (where the boolean can't flip)
  // re-syncs. A `probe_start` (`probing`) event must NOT reload, or every flaky
  // probe cycle would hammer the API.
  it('does not resync on a probe-start event', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const ws = {
      subSessionRebuildAll: vi.fn(),
      onMessage: vi.fn((cb: (msg: any) => void) => { handlers.push(cb); return () => {}; }),
    } as any;
    const fire = (msg: any) => { for (const h of [...handlers]) h(msg); };
    listSubSessions.mockResolvedValue([{ id: 's1', type: 'shell', shellBin: null, cwd: null, label: null, parentSession: 'deck_probetest_w1', createdAt: Date.now(), updatedAt: Date.now() }]);

    function Harness() {
      useSubSessions('srv1', ws, true, null);
      return null;
    }
    render(<Harness />);
    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(1));

    await act(async () => {
      fire({ type: 'session.event', event: 'probing', session: '', state: 'probing', reason: 'probe_start' });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(listSubSessions).toHaveBeenCalledTimes(1);
  });
});
