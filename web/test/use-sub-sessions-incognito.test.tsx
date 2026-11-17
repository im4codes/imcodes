/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/preact';
import { useSubSessions, buildSubSessionRebuildInputs, type SubSession } from '../src/hooks/useSubSessions.js';
import { createSubSession, listSubSessions, patchSubSession } from '../src/api.js';
import {
  isIncognitoTimelineSession,
  syncIncognitoTimelineSessions,
  ingestTimelineEventForCache,
  __getTimelineCacheForTests,
  __resetTimelineCacheForTests,
} from '../src/hooks/useTimeline.js';
import { SESSION_INCOGNITO_UNSUPPORTED } from '../../shared/session-incognito-types.js';

vi.mock('../src/api.js', () => ({
  listSubSessions: vi.fn().mockResolvedValue([]),
  createSubSession: vi.fn(),
  patchSubSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

type MsgHandler = (msg: any) => void;

function createMockWs() {
  const handlers: MsgHandler[] = [];
  return {
    ws: {
      subSessionRebuildAll: vi.fn(),
      subSessionStart: vi.fn(),
      subSessionStop: vi.fn(),
      subSessionClose: vi.fn(),
      subSessionRestart: vi.fn(),
      subSessionRename: vi.fn(),
      onMessage: vi.fn((fn: MsgHandler) => {
        handlers.push(fn);
        return () => {
          const i = handlers.indexOf(fn);
          if (i >= 0) handlers.splice(i, 1);
        };
      }),
      send: vi.fn(),
    } as any,
    emit(msg: any) {
      for (const h of [...handlers]) h(msg);
    },
  };
}

let apiRef: ReturnType<typeof useSubSessions> | null = null;

function Harness({ serverId = 'srv1', ws, connected }: { serverId?: string | null; ws: any; connected: boolean }) {
  apiRef = useSubSessions(serverId, ws, connected, null);
  return null;
}

describe('useSubSessions incognito lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    __resetTimelineCacheForTests();
    localStorage.clear();
    sessionStorage.clear();
    apiRef = null;
  });

  it('creates ephemeral incognito sub-session, survives main session_list sync, skips DB PATCH on rename, blocks restart, survives disconnect/reconnect, and cleans up only on manual close/remove', async () => {
    vi.mocked(createSubSession).mockResolvedValue({
      id: 'subinc01',
      sessionName: 'deck_sub_subinc01',
      subSession: {
        id: 'subinc01',
        server_id: 'srv1',
        type: 'claude-code-sdk',
        shell_bin: null,
        cwd: '/tmp/secret',
        label: 'Secret',
        closed_at: null,
        cc_session_id: null,
        gemini_session_id: null,
        parent_session: 'deck_main_brain',
        incognito: true,
      },
    } as any);

    const { ws, emit } = createMockWs();
    const view = render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef).toBeTruthy());

    let created: SubSession | null = null;
    await act(async () => {
      created = await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'Secret', {
        parentSession: 'deck_main_brain',
        incognito: true,
      });
    });

    expect(created).toBeTruthy();
    expect(created!.incognito).toBe(true);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.start',
      id: 'subinc01',
      sessionType: 'claude-code-sdk',
      cwd: '/tmp/secret',
      incognito: true,
    }));
    expect(apiRef!.subSessions.find((s) => s.id === 'subinc01')?.incognito).toBe(true);

    // Main session_list reconciliation MUST NOT evict active incognito sub-sessions from timeline registry
    syncIncognitoTimelineSessions('srv1', [{ name: 'deck_main_brain', incognito: false }]);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(true);

    // Rename skips DB patch for incognito sub-session
    await act(async () => {
      await apiRef!.rename('subinc01', 'Renamed Secret');
    });
    expect(patchSubSession).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith({
      type: 'subsession.rename',
      sessionName: 'deck_sub_subinc01',
      label: 'Renamed Secret',
    });

    // Restart is blocked for incognito sub-session
    act(() => {
      apiRef!.restart('subinc01');
    });
    expect(ws.subSessionRestart).not.toHaveBeenCalled();

    // subsession.removed evicts sub-session and forgets incognito timeline key
    act(() => {
      emit({ type: 'subsession.removed', id: 'subinc01', sessionName: 'deck_sub_subinc01' });
    });
    expect(apiRef!.subSessions.some((s) => s.id === 'subinc01')).toBe(false);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(false);

    // Disconnect (!connected) & reconnect + PG list refresh MUST preserve remaining incognito sub-sessions and their memory timelines
    await act(async () => {
      await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'Secret 2', { incognito: true });
    });
    expect(apiRef!.subSessions.length).toBe(1);
    ingestTimelineEventForCache({
      eventId: 'inc-ev-1',
      sessionId: 'deck_sub_subinc01',
      epoch: 1,
      seq: 1,
      ts: Date.now(),
      type: 'assistant.text',
      source: 'daemon',
      confidence: 'high',
      payload: { text: 'SECRET-MEMORY-MSG', streaming: false, incognito: true },
    }, 'srv1');
    expect(__getTimelineCacheForTests('srv1:deck_sub_subinc01')?.length).toBe(1);

    // buildSubSessionRebuildInputs must never emit incognito sub-sessions
    expect(buildSubSessionRebuildInputs(apiRef!.subSessions)).toEqual([]);

    view.rerender(<Harness ws={ws} connected={false} />);
    await waitFor(() => expect(apiRef!.subSessions).toHaveLength(1));
    expect(apiRef!.subSessions[0]?.incognito).toBe(true);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(true);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subinc01')?.some((e) => e.eventId === 'inc-ev-1')).toBe(true);

    // Reconnect and PG listSubSessions (which omits incognito) must still preserve it
    vi.mocked(listSubSessions).mockResolvedValueOnce([{
      id: 'dbsub1',
      server_id: 'srv1',
      type: 'shell',
      shell_bin: '/bin/zsh',
      cwd: '/tmp/proj',
      label: 'Normal Shell',
      closed_at: null,
      cc_session_id: null,
      gemini_session_id: null,
      parent_session: 'deck_main_brain',
    } as any]);
    view.rerender(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef!.subSessions.some((s) => s.id === 'dbsub1')).toBe(true));
    expect(apiRef!.subSessions.some((s) => s.id === 'subinc01' && s.incognito === true)).toBe(true);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subinc01')?.some((e) => e.eventId === 'inc-ev-1')).toBe(true);

    // Runtime session.error after live creation (even mentioning incognito) must NOT close or wipe an active incognito sub-session
    act(() => {
      emit({
        type: 'subsession.created',
        id: 'subinc01',
        sessionName: 'deck_sub_subinc01',
        sessionType: 'claude-code-sdk',
        state: 'idle',
        incognito: true,
      });
      emit({
        type: 'session.error',
        id: 'subinc01',
        sessionName: 'deck_sub_subinc01',
        message: 'Transient incognito turn error',
      });
    });
    expect(apiRef!.subSessions.some((s) => s.id === 'subinc01')).toBe(true);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(true);

    // Manual close clears only on explicit close / subsession.removed
    await act(async () => {
      await apiRef!.close('subinc01');
    });
    expect(ws.subSessionStop).toHaveBeenCalledWith('deck_sub_subinc01');
    act(() => {
      emit({ type: 'subsession.removed', id: 'subinc01', sessionName: 'deck_sub_subinc01' });
    });
    expect(apiRef!.subSessions.some((s) => s.id === 'subinc01')).toBe(false);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subinc01')).toBe(false);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subinc01')).toBeUndefined();
  });

  it('preserves incognito sub-sessions and RAM timelines across switching between servers and back without writing to localStorage', async () => {
    vi.mocked(createSubSession).mockResolvedValue({
      id: 'subsrv1',
      sessionName: 'deck_sub_subsrv1',
      subSession: {
        id: 'subsrv1',
        server_id: 'srv1',
        type: 'claude-code-sdk',
        shell_bin: null,
        cwd: '/tmp/secret',
        label: 'Srv1 Incog',
        closed_at: null,
        cc_session_id: null,
        gemini_session_id: null,
        parent_session: 'deck_main_brain',
        incognito: true,
      },
    } as any);
    vi.mocked(listSubSessions).mockResolvedValue([]);

    const { ws, emit } = createMockWs();
    const view = render(<Harness serverId="srv1" ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef).toBeTruthy());

    await act(async () => {
      await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'Srv1 Incog', {
        parentSession: 'deck_main_brain',
        incognito: true,
      });
    });
    ingestTimelineEventForCache({
      eventId: 'srv1-msg-1',
      sessionId: 'deck_sub_subsrv1',
      epoch: 1,
      seq: 1,
      ts: Date.now(),
      type: 'assistant.text',
      source: 'daemon',
      confidence: 'high',
      payload: { text: 'SRV1-SECRET-KEEP', streaming: false, incognito: true },
    }, 'srv1');

    // Switch to srv2 (disconnect old ws -> connect srv2)
    view.rerender(<Harness serverId="srv2" ws={ws} connected={false} />);
    view.rerender(<Harness serverId="srv2" ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef!.subSessions).toEqual([]));
    // srv1 timeline cache & registry must still be intact in memory
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subsrv1')).toBe(true);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subsrv1')?.map((e) => e.eventId)).toEqual(['srv1-msg-1']);

    // Switch back to srv1
    view.rerender(<Harness serverId="srv1" ws={ws} connected={false} />);
    expect(apiRef!.subSessions.some((s) => s.id === 'subsrv1' && s.incognito === true)).toBe(true);
    view.rerender(<Harness serverId="srv1" ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef!.loadedServerId).toBe('srv1'));
    expect(apiRef!.subSessions.some((s) => s.id === 'subsrv1' && s.incognito === true)).toBe(true);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subsrv1')?.map((e) => e.eventId)).toEqual(['srv1-msg-1']);
    expect(JSON.stringify({ ...localStorage })).not.toContain('subsrv1');
    expect(JSON.stringify({ ...localStorage })).not.toContain('SRV1-SECRET-KEEP');

    // Explicit manual close on srv1 clears everything
    await act(async () => {
      await apiRef!.close('subsrv1');
    });
    act(() => {
      emit({ type: 'subsession.removed', id: 'subsrv1', sessionName: 'deck_sub_subsrv1' });
    });
    expect(apiRef!.subSessions).toEqual([]);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subsrv1')).toBe(false);
    expect(__getTimelineCacheForTests('srv1:deck_sub_subsrv1')).toBeUndefined();
  });

  it('removes rejected incognito sub-session on targeted or untargeted session.error and clears incognito timeline registration', async () => {
    vi.mocked(createSubSession).mockResolvedValue({
      id: 'subnocap',
      sessionName: 'deck_sub_subnocap',
      subSession: {
        id: 'subnocap',
        server_id: 'srv1',
        type: 'claude-code-sdk',
        shell_bin: null,
        cwd: '/tmp/secret',
        label: 'NoCap',
        closed_at: null,
        cc_session_id: null,
        gemini_session_id: null,
        parent_session: 'deck_main_brain',
        incognito: true,
      },
    } as any);

    const { ws, emit } = createMockWs();
    render(<Harness ws={ws} connected={true} />);
    await waitFor(() => expect(apiRef).toBeTruthy());

    await act(async () => {
      await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'NoCap', {
        parentSession: 'deck_main_brain',
        incognito: true,
      });
    });
    expect(apiRef!.subSessions.some((s) => s.id === 'subnocap')).toBe(true);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subnocap')).toBe(true);

    // Untargeted session.error from stale daemon removes pending incognito sub-session
    act(() => {
      emit({ type: 'session.error', message: SESSION_INCOGNITO_UNSUPPORTED });
    });
    expect(apiRef!.subSessions).toEqual([]);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subnocap')).toBe(false);

    // Targeted session.error with id/sessionName also removes cleanly
    await act(async () => {
      await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'NoCap 2', {
        parentSession: 'deck_main_brain',
        incognito: true,
      });
    });
    expect(apiRef!.subSessions.some((s) => s.id === 'subnocap')).toBe(true);
    act(() => {
      emit({
        type: 'session.error',
        id: 'subnocap',
        sessionName: 'deck_sub_subnocap',
        message: SESSION_INCOGNITO_UNSUPPORTED,
      });
    });
    expect(apiRef!.subSessions).toEqual([]);
    expect(isIncognitoTimelineSession('srv1', 'deck_sub_subnocap')).toBe(false);
  });
});
