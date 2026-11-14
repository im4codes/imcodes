/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/preact';
import { useSubSessions, type SubSession } from '../src/hooks/useSubSessions.js';
import { createSubSession, patchSubSession } from '../src/api.js';
import {
  isIncognitoTimelineSession,
  syncIncognitoTimelineSessions,
  __resetTimelineCacheForTests,
} from '../src/hooks/useTimeline.js';

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

function Harness({ ws, connected }: { ws: any; connected: boolean }) {
  apiRef = useSubSessions('srv1', ws, connected, null);
  return null;
}

describe('useSubSessions incognito lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    __resetTimelineCacheForTests();
    apiRef = null;
  });

  it('creates ephemeral incognito sub-session, survives main session_list sync, skips DB PATCH on rename, blocks restart, and cleans up on remove/disconnect', async () => {
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

    // Disconnect (!connected) wipes any remaining incognito sub-sessions
    await act(async () => {
      await apiRef!.create('claude-code-sdk', undefined, '/tmp/secret', 'Secret 2', { incognito: true });
    });
    expect(apiRef!.subSessions.length).toBe(1);
    view.rerender(<Harness ws={ws} connected={false} />);
    await waitFor(() => expect(apiRef!.subSessions).toEqual([]));
  });
});
