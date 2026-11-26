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
  it('does not refetch sub-sessions on probe recovery when the socket stays open', async () => {
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

    // Probe recovery is not a reconnect. The existing list remains valid and
    // must not trigger a control-plane request storm.
    await new Promise((r) => setTimeout(r, 10));
    expect(listSubSessions).toHaveBeenCalledTimes(1);
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);

    // A burst of duplicate probe-recovery notices must not turn one socket
    // recovery into an API storm while the sub-session windows are streaming.
    await act(async () => {
      fire({ type: 'session.event', event: 'connected', session: '', state: 'connected', reason: 'probe_recovered' });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(listSubSessions).toHaveBeenCalledTimes(1);
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

  it('clears loadedServerId across server switches and hides visibleSubSessions while activeSession is null', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    listSubSessions.mockResolvedValueOnce([
      {
        id: 's1',
        serverId: 'srv1',
        type: 'shell',
        shellBin: null,
        cwd: null,
        label: 'S1',
        parentSession: 'deck_srv1_brain',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'orphan',
        serverId: 'srv1',
        type: 'shell',
        shellBin: null,
        cwd: null,
        label: 'Orphan',
        parentSession: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    let state!: ReturnType<typeof useSubSessions>;
    function Harness(props: { serverId: string; activeSession: string | null }) {
      state = useSubSessions(props.serverId, ws, true, props.activeSession);
      return null;
    }

    const view = render(<Harness serverId="srv1" activeSession={null} />);
    await waitFor(() => expect(state.loadedServerId).toBe('srv1'));
    expect(state.subSessions).toHaveLength(2);
    expect(state.visibleSubSessions).toEqual([]);

    view.rerender(<Harness serverId="srv1" activeSession="deck_srv1_brain" />);
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s1', 'orphan']);

    const srv2Pending = deferred<any[]>();
    listSubSessions.mockReturnValueOnce(srv2Pending.promise);
    view.rerender(<Harness serverId="srv2" activeSession={null} />);
    expect(state.loadedServerId).toBeNull();
    expect(state.visibleSubSessions).toEqual([]);

    srv2Pending.resolve([
      {
        id: 's2-other',
        serverId: 'srv2',
        type: 'shell',
        shellBin: null,
        cwd: null,
        label: 'S2 Other',
        parentSession: 'deck_srv2_other',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    await waitFor(() => expect(state.loadedServerId).toBe('srv2'));
    expect(state.visibleSubSessions).toEqual([]);

    view.rerender(<Harness serverId="srv2" activeSession="deck_srv2_brain" />);
    expect(state.visibleSubSessions).toEqual([]);
  });

  it('immediately restores cached sub-sessions and loadedServerId when switching back to a previously visited server without leaking to unvisited servers or dropping incognito', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const ws = {
      subSessionRebuildAll: vi.fn(),
      onMessage: vi.fn((cb: (msg: any) => void) => { handlers.push(cb); return () => {}; }),
    } as any;
    const fire = (msg: any) => { for (const h of [...handlers]) h(msg); };
    const srv1Sub = {
      id: 's1',
      serverId: 'srv1',
      type: 'shell',
      shellBin: null,
      cwd: null,
      label: 'S1',
      parentSession: 'deck_srv1_brain',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const srv2Sub = {
      id: 's2',
      serverId: 'srv2',
      type: 'shell',
      shellBin: null,
      cwd: null,
      label: 'S2',
      parentSession: 'deck_srv2_brain',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    listSubSessions.mockResolvedValueOnce([srv1Sub]);

    let state!: ReturnType<typeof useSubSessions>;
    function Harness(props: { serverId: string; activeSession: string | null }) {
      state = useSubSessions(props.serverId, ws, true, props.activeSession);
      return null;
    }

    const view = render(<Harness serverId="srv1" activeSession="deck_srv1_brain" />);
    await waitFor(() => expect(state.loadedServerId).toBe('srv1'));
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s1']);

    // Add an incognito sub-session on srv1 before switching away.
    await act(async () => {
      fire({
        type: 'subsession.created',
        id: 'inc1',
        sessionName: 'deck_sub_inc1',
        sessionType: 'claude-code',
        parentSession: 'deck_srv1_brain',
        incognito: true,
      });
    });
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s1', 'inc1']);

    // Switching to an unvisited server (srv2) must still leave loadedServerId null until first load.
    const srv2Pending = deferred<any[]>();
    listSubSessions.mockReturnValueOnce(srv2Pending.promise);
    view.rerender(<Harness serverId="srv2" activeSession="deck_srv2_brain" />);
    expect(state.loadedServerId).toBeNull();
    expect(state.visibleSubSessions).toEqual([]);

    srv2Pending.resolve([srv2Sub]);
    await waitFor(() => expect(state.loadedServerId).toBe('srv2'));
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s2']);

    // Switching back to srv1 must seed cached s1 + preserved inc1 immediately with loadedServerId === 'srv1'
    // while listSubSessions('srv1') refreshes in the background.
    const srv1Refresh = deferred<any[]>();
    listSubSessions.mockReturnValueOnce(srv1Refresh.promise);
    view.rerender(<Harness serverId="srv1" activeSession="deck_srv1_brain" />);
    expect(state.loadedServerId).toBe('srv1');
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s1', 'inc1']);

    srv1Refresh.resolve([srv1Sub]);
    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(3));
    expect(state.loadedServerId).toBe('srv1');
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['s1', 'inc1']);
  });

  it('preserves hydrated shared sub-sessions when switching from an owned server or cold-starting, includes nested descendants, and isolates cachedByServerRef', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const ownedSrv1Sub = {
      id: 'own-1',
      serverId: 'srv1',
      type: 'shell',
      shellBin: null,
      cwd: null,
      label: 'Owned 1',
      parentSession: 'deck_srv1_brain',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    listSubSessions.mockResolvedValue([ownedSrv1Sub]);

    let state!: ReturnType<typeof useSubSessions>;
    function Harness(props: { serverId: string | null; activeSession: string | null; disableHttpLoad: boolean }) {
      state = useSubSessions(props.serverId, ws, true, props.activeSession, props.disableHttpLoad);
      return null;
    }

    // 1. Owned server A -> Shared server B (direct + nested sub-session hydrated in same render batch)
    const view = render(<Harness serverId="srv1" activeSession="deck_srv1_brain" disableHttpLoad={false} />);
    await waitFor(() => expect(state.loadedServerId).toBe('srv1'));
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['own-1']);
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);

    const sharedBatch1 = [
      { subSessionId: 'sh-1', title: 'Worker 1', type: 'codex-sdk', parentSessionName: 'deck_shared_main', state: 'running' },
      { subSessionId: 'sh-nested', title: 'Nested 1', type: 'shell', parentSessionName: 'deck_sub_sh-1', state: 'idle' },
      { subSessionId: 'sh-other', title: 'Other Main Child', type: 'shell', parentSessionName: 'deck_other_main', state: 'idle' },
    ];
    act(() => {
      state.hydrateShared('srv-shared', sharedBatch1);
      view.rerender(<Harness serverId="srv-shared" activeSession="deck_shared_main" disableHttpLoad={true} />);
    });

    expect(state.loadedServerId).toBe('srv-shared');
    expect(state.subSessions.map((s) => s.id)).toEqual(['sh-1', 'sh-nested', 'sh-other']);
    expect(state.subSessions.find((s) => s.id === 'sh-1')?.state).toBe('running');
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['sh-1', 'sh-nested']);
    // Shared mode must never call listSubSessions or subSessionRebuildAll
    expect(listSubSessions).toHaveBeenCalledTimes(1);
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);

    // 2. Switching between two shared tabs on the same server replaces subSessions cleanly
    act(() => {
      state.hydrateShared('srv-shared', [
        { subSessionId: 'sh-2', title: 'Tab 2 Worker', type: 'shell', parentSessionName: 'deck_shared_main2', state: 'idle' },
      ]);
      view.rerender(<Harness serverId="srv-shared" activeSession="deck_shared_main2" disableHttpLoad={true} />);
    });
    expect(state.subSessions.map((s) => s.id)).toEqual(['sh-2']);
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['sh-2']);

    // 3. Returning to owned server A restores owned A's sub-sessions without leaking srv-shared or polluting cache
    view.rerender(<Harness serverId="srv1" activeSession="deck_srv1_brain" disableHttpLoad={false} />);
    expect(state.loadedServerId).toBe('srv1');
    expect(state.visibleSubSessions.map((s) => s.id)).toEqual(['own-1']);

    // 4. Cold start (serverId: null -> shared server) preserves all hydrated sub-sessions
    cleanup();
    let coldState!: ReturnType<typeof useSubSessions>;
    function ColdHarness(props: { serverId: string | null; activeSession: string | null; disableHttpLoad: boolean }) {
      coldState = useSubSessions(props.serverId, ws, true, props.activeSession, props.disableHttpLoad);
      return null;
    }
    const coldView = render(<ColdHarness serverId={null} activeSession={null} disableHttpLoad={false} />);
    expect(coldState.subSessions).toEqual([]);
    act(() => {
      coldState.hydrateShared('srv-cold-shared', [
        { subSessionId: 'cold-1', title: 'Cold Worker', type: 'codex', parentSessionName: 'deck_cold_main', state: 'running' },
        { subSessionId: 'cold-2', title: 'Cold Nested', type: 'shell', parentSessionName: 'deck_sub_cold-1' },
      ]);
      coldView.rerender(<ColdHarness serverId="srv-cold-shared" activeSession="deck_cold_main" disableHttpLoad={true} />);
    });
    expect(coldState.loadedServerId).toBe('srv-cold-shared');
    expect(coldState.subSessions.map((s) => s.id)).toEqual(['cold-1', 'cold-2']);
    expect(coldState.visibleSubSessions.map((s) => s.id)).toEqual(['cold-1', 'cold-2']);
  });
});
