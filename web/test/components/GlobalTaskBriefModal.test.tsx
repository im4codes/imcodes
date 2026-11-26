/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_PAIR_BRIEF_ERROR, TASK_PAIR_BRIEF_TIMEOUT_MS } from '@shared/task-pair-brief.js';
import en from '../../src/i18n/locales/en.json';
import { configure as configureApi, configureApiKey, clearApiKey, TASK_PAIR_BRIEF_HTTP_TIMEOUT_MS } from '../../src/api.js';
import { clearGlobalTaskModeSessionState, globalTaskModeStore } from '../../src/global-task-mode-store.js';
import { clearGlobalTaskBriefCache } from '../../src/components/GlobalTaskBriefModal.js';

const i18nMock = vi.hoisted(() => ({ language: 'en-US' }));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      const lookup = (obj: Record<string, unknown>, path: string): string | undefined => {
        let cur: unknown = obj;
        for (const part of path.split('.')) {
          if (!cur || typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[part];
        }
        return typeof cur === 'string' ? cur : undefined;
      };
      let text = lookup(en as unknown as Record<string, unknown>, key)
        ?? (typeof opts === 'string' ? opts : undefined)
        ?? (typeof opts === 'object' && opts && typeof opts.defaultValue === 'string' ? opts.defaultValue : key);
      if (opts && typeof opts === 'object') {
        for (const [k, v] of Object.entries(opts)) {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    i18n: {
      get language() { return i18nMock.language; },
      get resolvedLanguage() { return i18nMock.language; },
    },
  }),
}));

class NoopWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 1;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

describe('GlobalTaskModeView Brief & Checklist HUD', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    clearGlobalTaskModeSessionState();
    clearGlobalTaskBriefCache();
    configureApi('https://api.example.com');
    configureApiKey('test-key');
    globalThis.WebSocket = NoopWebSocket as never;
  });

  afterEach(() => {
    cleanup();
    clearApiKey();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  function seedTasks() {
    globalTaskModeStore.setState({
      loading: false,
      connected: true,
      connecting: false,
      servers: [{ id: 'srv-1', name: 'M3', online: true }],
      brains: [],
      tasks: [
        {
          serverId: 'srv-1',
          serverName: 'M3',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_cd_brain',
          brainLabel: 'Main',
          taskId: 'tsk_with_check',
          title: 'Add HUD brief viewer',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 3, implemented: 2, audited: 1 },
          executorLabel: 'Exec1',
          auditorLabel: 'Aud1',
          executorModel: 'gemini-4-neon-high',
          auditorModel: 'gpt-6.2-astra',
          createdAt: 1000,
          updatedAt: 2000,
          isTerminal: false,
          needsAttention: false,
        },
        {
          serverId: 'srv-1',
          serverName: 'M3',
          serverOnline: false,
          projectName: 'imcodes',
          brainSession: 'deck_cd_brain',
          brainLabel: 'Main',
          taskId: 'tsk_no_check',
          title: 'Queued brief only',
          status: 'queued',
          flags: [],
          round: 0,
          checklist: { total: 0, implemented: 0, audited: 0 },
          createdAt: 1000,
          updatedAt: 2000,
          isTerminal: false,
          needsAttention: false,
        },
      ],
    });
  }

  it('opens Checklist HUD from inline progress row without expanding the card and switches to Brief markdown', async () => {
    const sampleBrief = [
      '### Goal',
      'Render a glowing HUD viewer on demand.',
      '',
      '### Acceptance',
      '- [x][x] 1. Add server brief RPC',
      '- [x][ ] 2. Render checklist items',
      '- [ ] 3. Single-box documentation note',
    ].join('\n');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        return new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_with_check',
          brief: sampleBrief,
          briefRevision: 'rev-1',
          checklist: { total: 3, implemented: 2, audited: 1 },
          updatedAt: 2000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ticket: 't1' }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const onJump = vi.fn();
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={onJump} />);
    seedTasks();

    const progressBtn = await screen.findByTestId('task-mode-progress-btn-tsk_with_check');
    fireEvent.click(progressBtn);

    // Must NOT toggle card expansion
    expect(screen.queryByTestId('task-mode-details-tsk_with_check')).toBeNull();
    expect(screen.getByTestId('global-task-brief-hud')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-checklist-items')).toBeTruthy();
    });

    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Add server brief RPC');
    expect(screen.getByTestId('global-task-brief-item-1-impl').textContent).toContain('✓');
    expect(screen.getByTestId('global-task-brief-item-1-audit').textContent).toContain('✓');
    expect(screen.getByTestId('global-task-brief-item-2-impl').textContent).toContain('✓');
    expect(screen.getByTestId('global-task-brief-item-2-audit').textContent).toContain('○');
    expect(screen.getByTestId('global-task-brief-item-3-audit').textContent).toContain('—');

    // Switch to Brief tab
    fireEvent.click(screen.getByTestId('global-task-brief-tab-brief'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain('Render a glowing HUD viewer on demand.');
    });

    // Open session closes modal and jumps with task context
    fireEvent.click(screen.getByTestId('global-task-brief-open-session'));
    expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();
    expect(onJump).toHaveBeenCalledWith('srv-1', 'deck_cd_brain', {
      taskId: 'tsk_with_check',
      title: 'Add HUD brief viewer',
      status: 'working',
    });
  });

  it('supports zero-checklist inline brief button, expanded action button, Escape dismiss, and offline retry', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_no_check/brief')) {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({
            ok: false,
            error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE,
          }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_no_check',
          brief: '### Goal\nRecovered brief after retry.',
          briefRevision: 'rev-2',
          checklist: { total: 0, implemented: 0, audited: 0 },
          updatedAt: 2500,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ticket: 't1' }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    // Inline brief icon button opens Brief tab for 0-checklist task without expanding card
    fireEvent.click(await screen.findByTestId('task-mode-brief-btn-tsk_no_check'));
    expect(screen.queryByTestId('task-mode-details-tsk_no_check')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');
    });

    fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain('Recovered brief after retry.');
    });

    // Escape key closes HUD
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();
    });

    // Expand card and open via expanded detail Brief & Progress button
    fireEvent.click(screen.getByTestId('task-mode-card-tsk_no_check'));
    expect(screen.getByTestId('task-mode-details-tsk_no_check')).toBeTruthy();
    expect(screen.getByTestId('task-mode-jump-tsk_no_check')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-mode-detail-brief-tsk_no_check'));
    expect(screen.getByTestId('global-task-brief-hud')).toBeTruthy();
  });

  it('preserves active Brief tab across live updatedAt updates and ignores out-of-order stale responses', async () => {
    const pending: Array<{
      resolve: (res: Response) => void;
    }> = [];
    let callIdx = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        callIdx += 1;
        if (callIdx === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            taskId: 'tsk_with_check',
            brief: '### Goal\nInitial brief v1.\n\n- [x][ ] 1. Step 1',
            briefRevision: 'rev-1',
            checklist: { total: 1, implemented: 1, audited: 0 },
            updatedAt: 2000,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return new Promise<Response>((resolve) => {
          pending.push({ resolve });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    // Open on Checklist tab, then switch to Brief tab
    fireEvent.click(await screen.findByTestId('task-mode-progress-btn-tsk_with_check'));
    fireEvent.click(screen.getByTestId('global-task-brief-tab-brief'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain('Initial brief v1.');
    });

    // Advance live updatedAt (spawns request #2) -> user MUST remain on Brief tab
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 3000, checklist: { total: 1, implemented: 1, audited: 1 } }
          : item)),
      });
    });
    await waitFor(() => {
      expect(pending.length).toBe(1);
    });
    expect(screen.getByTestId('global-task-brief-tab-brief').getAttribute('aria-selected')).toBe('true');

    // Trigger manual Refresh (spawns request #3) while request #2 is still pending
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    await waitFor(() => {
      expect(pending.length).toBe(2);
    });

    // Resolve newer request #3 FIRST, then older request #2 AFTERWARD (out-of-order completion)
    await act(async () => {
      pending[1]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_with_check',
        brief: '### Goal\nLatest brief v3.\n\n- [x][x] 1. Step 1',
        briefRevision: 'rev-3',
        checklist: { total: 1, implemented: 1, audited: 1 },
        updatedAt: 3000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain('Latest brief v3.');
    });

    await act(async () => {
      pending[0]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_with_check',
        brief: '### Goal\nStale brief v2.\n\n- [x][ ] 1. Step 1',
        briefRevision: 'rev-2',
        checklist: { total: 1, implemented: 1, audited: 0 },
        updatedAt: 2500,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    // Stale response #2 must NOT overwrite v3, and Brief tab remains selected
    expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain('Latest brief v3.');
    expect(screen.getByTestId('global-task-brief-tab-brief').getAttribute('aria-selected')).toBe('true');
  });

  it('displays initial uncached brief across continuous live updatedAt bursts and coalesces follow-up', async () => {
    const pending: Array<{ resolve: (res: Response) => void }> = [];
    let briefCalls = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        briefCalls += 1;
        return new Promise<Response>((resolve) => {
          pending.push({ resolve });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    fireEvent.click(await screen.findByTestId('task-mode-progress-btn-tsk_with_check'));
    await waitFor(() => {
      expect(briefCalls).toBe(1);
    });
    expect(screen.getByTestId('global-task-brief-loading')).toBeTruthy();

    // Push multiple live updatedAt updates while request #1 is still in flight
    for (const ts of [2100, 2200, 2300]) {
      await act(async () => {
        const prevTasks = globalTaskModeStore.getState().tasks;
        globalTaskModeStore.setState({
          tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
            ? { ...item, updatedAt: ts }
            : item)),
        });
      });
    }

    // Must not flood with one request per live update while request #1 is in flight
    expect(briefCalls).toBe(1);

    // Resolve request #1 -> first valid content must appear immediately (never discarded!)
    await act(async () => {
      pending[0]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_with_check',
        brief: '### Goal\nFirst synced brief.\n\n- [x][ ] 1. Initial item',
        briefRevision: 'rev-1',
        checklist: { total: 1, implemented: 1, audited: 0 },
        updatedAt: 2000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-checklist-items')).toBeTruthy();
    });
    expect(screen.queryByTestId('global-task-brief-loading')).toBeNull();
    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Initial item');

    // Exactly one coalesced follow-up request runs for the latest updatedAt (2300)
    await waitFor(() => {
      expect(briefCalls).toBe(2);
    });

    await act(async () => {
      pending[1]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_with_check',
        brief: '### Goal\nLatest synced brief.\n\n- [x][x] 1. Finalized item',
        briefRevision: 'rev-2',
        checklist: { total: 1, implemented: 1, audited: 1 },
        updatedAt: 2300,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Finalized item');
    });
    expect(briefCalls).toBe(2);
  });

  it('bounds hanging HTTP fetch and hanging response body with timeout error and allows retry', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs);
        return controller.signal;
      });
      let attempt = 0;
      const signals: AbortSignal[] = [];

      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
          attempt += 1;
          if (init?.signal) signals.push(init.signal);
          if (attempt === 1) {
            // Hanging connection (never resolves)
            return new Promise<Response>(() => {});
          }
          if (attempt === 2) {
            // Hanging response body (200 headers arrive, body never settles)
            return Promise.resolve({
              ok: true,
              status: 200,
              headers: new Headers({ 'Content-Type': 'application/json' }),
              json: () => new Promise(() => {}),
              text: () => new Promise(() => {}),
            } as unknown as Response);
          }
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            taskId: 'tsk_with_check',
            brief: '### Goal\nRecovered after hang.\n\n- [x][x] 1. Recovered item',
            briefRevision: 'rev-ok',
            checklist: { total: 1, implemented: 1, audited: 1 },
            updatedAt: 2000,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
      });
      globalThis.fetch = fetchMock as typeof fetch;

      const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
      render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
      seedTasks();

      const progressBtn = await screen.findByTestId('task-mode-progress-btn-tsk_with_check');
      fireEvent.click(progressBtn);
      expect(screen.getByTestId('global-task-brief-loading')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_PAIR_BRIEF_HTTP_TIMEOUT_MS + 50);
      });

      expect(TASK_PAIR_BRIEF_HTTP_TIMEOUT_MS).toBeGreaterThan(TASK_PAIR_BRIEF_TIMEOUT_MS);
      expect(signals[0]?.aborted).toBe(true);
      expect(screen.queryByTestId('global-task-brief-loading')).toBeNull();
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('timed out');

      // Retry #2 hits hanging body
      fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TASK_PAIR_BRIEF_HTTP_TIMEOUT_MS + 50);
      });

      expect(signals[1]?.aborted).toBe(true);
      expect(screen.queryByTestId('global-task-brief-loading')).toBeNull();
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('timed out');

      // Retry #3 succeeds
      fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Recovered item');
      expect(screen.queryByTestId('global-task-brief-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains loaded content during refresh and recoverable errors, clears cache on FORBIDDEN, and isolates same taskId across servers', async () => {
    let srv1Calls = 0;
    let srv1NextError: { status: number; error: string } | null = null;
    const srv1Pending: Array<{ resolve: (res: Response) => void; signal?: AbortSignal }> = [];
    let holdSrv1 = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_shared/brief')) {
        srv1Calls += 1;
        if (holdSrv1) {
          return new Promise<Response>((resolve) => {
            srv1Pending.push({ resolve, signal: init?.signal ?? undefined });
          });
        }
        if (srv1NextError) {
          const err = srv1NextError;
          srv1NextError = null;
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: err.error }), {
            status: err.status,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_shared',
          brief: `### Goal\nServer 1 brief call #${srv1Calls}.\n\n- [x][ ] 1. Server 1 step`,
          briefRevision: `srv1-${srv1Calls}`,
          checklist: { total: 1, implemented: 1, audited: 0 },
          updatedAt: 2000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.includes('/api/server/srv-2/task-pairs/tsk_shared/brief')) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_shared',
          brief: '',
          checklist: { total: 0, implemented: 0, audited: 0 },
          updatedAt: 2000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);

    globalTaskModeStore.setState({
      loading: false,
      connected: true,
      connecting: false,
      servers: [
        { id: 'srv-1', name: 'Node 1', online: true },
        { id: 'srv-2', name: 'Node 2', online: true },
      ],
      brains: [],
      tasks: [
        {
          serverId: 'srv-1',
          serverName: 'Node 1',
          serverOnline: true,
          projectName: 'p1',
          brainSession: 'deck_p1_brain',
          brainLabel: 'Main',
          taskId: 'tsk_shared',
          title: 'Node 1 shared id task',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 1, implemented: 1, audited: 0 },
          createdAt: 1000,
          updatedAt: 2000,
          isTerminal: false,
          needsAttention: false,
        },
        {
          serverId: 'srv-2',
          serverName: 'Node 2',
          serverOnline: true,
          projectName: 'p2',
          brainSession: 'deck_p2_brain',
          brainLabel: 'Main',
          taskId: 'tsk_shared',
          title: 'Node 2 shared id task',
          status: 'queued',
          flags: [],
          round: 0,
          checklist: { total: 0, implemented: 0, audited: 0 },
          createdAt: 1000,
          updatedAt: 2000,
          isTerminal: false,
          needsAttention: false,
        },
      ],
    });

    // Open srv-1 task on Checklist tab -> loads v1
    const srv1Cards = await screen.findAllByTestId('task-mode-progress-btn-tsk_shared');
    fireEvent.click(srv1Cards[0]!);
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Server 1 step');
    });

    // Manual refresh fails with recoverable DAEMON_OFFLINE while live summary counts are newer ->
    // previously loaded body stays readable AND header progress uses newer live summary counts without regressing.
    srv1NextError = { status: 503, error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE };
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.serverId === 'srv-1' && item.taskId === 'tsk_shared'
          ? { ...item, updatedAt: 2500, checklist: { total: 5, implemented: 5, audited: 2 } }
          : item)),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');
    });
    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Server 1 step');
    expect(screen.getByTestId('global-task-brief-hud-progress').textContent).toContain('5/5');
    expect(screen.getByTestId('global-task-brief-hud-progress').textContent).toContain('2/5');

    // Rapid duplicate manual refresh clicks while manual refresh is in flight are coalesced
    holdSrv1 = true;
    const callsBeforeManualHold = srv1Calls;
    fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    expect(srv1Calls).toBe(callsBeforeManualHold + 1);
    // Loaded content stays visible while refreshing
    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Server 1 step');

    // Close modal while srv-1 request is in flight -> signal aborts, and late resolution does not pollute srv-2
    fireEvent.click(screen.getByTestId('global-task-brief-hud-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();
    });
    expect(srv1Pending[0]?.signal?.aborted).toBe(true);

    // Open srv-2 task with the SAME taskId (empty brief & no checklist)
    const briefBtns = await screen.findAllByTestId('task-mode-brief-btn-tsk_shared');
    expect(briefBtns).toHaveLength(2);
    fireEvent.click(briefBtns[1]!);
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-empty')).toBeTruthy();
    });

    // Resolve late srv-1 response after switching to srv-2 -> must NOT overwrite srv-2 empty brief
    await act(async () => {
      srv1Pending[0]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_shared',
        brief: '### Goal\nLate srv-1 leak.\n\n- [x][x] 1. Leak',
        briefRevision: 'leak',
        checklist: { total: 1, implemented: 1, audited: 1 },
        updatedAt: 2000,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    expect(screen.getByTestId('global-task-brief-empty')).toBeTruthy();
    expect(screen.queryByText('Late srv-1 leak.')).toBeNull();

    // Switch back to srv-1 -> stale (2500 > 2000) refreshes once, then reopen hits fresh cache
    fireEvent.click(screen.getByTestId('global-task-brief-hud-close'));
    holdSrv1 = false;
    const callsBeforeReopen = srv1Calls;
    fireEvent.click((await screen.findAllByTestId('task-mode-progress-btn-tsk_shared'))[0]!);
    await waitFor(() => {
      expect(srv1Calls).toBe(callsBeforeReopen + 1);
    });
    // Wait for the in-flight refresh response to settle into cache (not just pre-refresh cached DOM)
    fireEvent.click(screen.getByTestId('global-task-brief-tab-brief'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-markdown').textContent).toContain(`Server 1 brief call #${callsBeforeReopen + 1}.`);
    });
    fireEvent.click(screen.getByTestId('global-task-brief-hud-close'));
    fireEvent.click((await screen.findAllByTestId('task-mode-progress-btn-tsk_shared'))[0]!);
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Server 1 step');
    });
    expect(srv1Calls).toBe(callsBeforeReopen + 1);

    // FORBIDDEN on refresh clears previously loaded/cached content per access boundary
    srv1NextError = { status: 403, error: TASK_PAIR_BRIEF_ERROR.FORBIDDEN };
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('permission');
    });
    expect(screen.queryByTestId('global-task-brief-checklist-items')).toBeNull();
    expect(screen.queryByTestId('global-task-brief-item-1')).toBeNull();

    // Reload valid brief, then NOT_FOUND on refresh must also clear cached content and body
    fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Server 1 step');
    });
    srv1NextError = { status: 404, error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND };
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('not found');
    });
    expect(screen.queryByTestId('global-task-brief-checklist-items')).toBeNull();
    expect(screen.queryByTestId('global-task-brief-item-1')).toBeNull();
  });

  it('surfaces server 404 not_found and 504 daemon timeout errors accurately', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.NOT_FOUND }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.TIMEOUT }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ticket: 't1' }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    fireEvent.click(await screen.findByTestId('task-mode-progress-btn-tsk_with_check'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('not found');
    });

    fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('timed out');
    });
  });

  it('consumes newest live update after recoverable error without auto-retrying same version or terminal denials', async () => {
    const pending: Array<{ resolve: (res: Response) => void }> = [];
    let briefCalls = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        briefCalls += 1;
        return new Promise<Response>((resolve) => {
          pending.push({ resolve });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    // Open uncached at updatedAt=2000 -> spawns request #1
    fireEvent.click(await screen.findByTestId('task-mode-progress-btn-tsk_with_check'));
    await waitFor(() => {
      expect(briefCalls).toBe(1);
    });

    // Publish newer live updatedAt=2300 while request #1 hangs
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 2300 }
          : item)),
      });
    });
    expect(briefCalls).toBe(1);

    // Settle request #1 with recoverable 503 DAEMON_OFFLINE ->
    // error/retry must become visible AND newest 2300 update must trigger request #2
    await act(async () => {
      pending[0]!.resolve(new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    await waitFor(() => {
      expect(briefCalls).toBe(2);
    });
    expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');
    expect(screen.getByTestId('global-task-brief-retry-btn')).toBeTruthy();
    expect(screen.getByTestId('global-task-brief-loading')).toBeTruthy();

    // If request #2 (2300) also fails with no newer update, it must stop without auto-retrying 2300
    await act(async () => {
      pending[1]!.resolve(new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('global-task-brief-loading')).toBeNull();
    });
    expect(briefCalls).toBe(2);
    expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');

    // Manual retry at 2300 while live updatedAt advances to 2400 -> consumes 2400 and renders
    fireEvent.click(screen.getByTestId('global-task-brief-retry-btn'));
    await waitFor(() => {
      expect(briefCalls).toBe(3);
    });
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 2400 }
          : item)),
      });
    });
    await act(async () => {
      pending[2]!.resolve(new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.TIMEOUT }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    await waitFor(() => {
      expect(briefCalls).toBe(4);
    });
    expect(screen.getByTestId('global-task-brief-error').textContent).toContain('timed out');

    await act(async () => {
      pending[3]!.resolve(new Response(JSON.stringify({
        ok: true,
        taskId: 'tsk_with_check',
        brief: '### Goal\nRecovered newest 2400.\n\n- [x][x] 1. Recovered newest',
        briefRevision: 'rev-2400',
        checklist: { total: 1, implemented: 1, audited: 1 },
        updatedAt: 2400,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Recovered newest');
    });
    expect(screen.queryByTestId('global-task-brief-error')).toBeNull();

    // Terminal denials (FORBIDDEN / NOT_FOUND) must NOT auto-retry even when a newer live update arrived in flight
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    await waitFor(() => {
      expect(briefCalls).toBe(5);
    });
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 2500 }
          : item)),
      });
    });
    await act(async () => {
      pending[4]!.resolve(new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.FORBIDDEN }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('permission');
    });
    expect(briefCalls).toBe(5);
    expect(screen.queryByTestId('global-task-brief-loading')).toBeNull();
  });

  it('keeps a manual refresh error when cached brief version exceeds queued and delayed live updates', async () => {
    const pending: Array<{ resolve: (res: Response) => void }> = [];
    let briefCalls = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/server/srv-1/task-pairs/tsk_with_check/brief')) {
        briefCalls += 1;
        if (briefCalls === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            taskId: 'tsk_with_check',
            brief: '### Goal\nCached v2500 ahead of live summary.\n\n- [x][x] 1. Ahead v2500',
            briefRevision: 'rev-2500',
            checklist: { total: 1, implemented: 1, audited: 1 },
            updatedAt: 2500,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return new Promise<Response>((resolve) => {
          pending.push({ resolve });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ticket: 't1' }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(<GlobalTaskModeView onExit={() => {}} onJumpToSession={() => {}} />);
    seedTasks();

    // Open at live updatedAt=2000; HTTP response already carries updatedAt=2500
    fireEvent.click(await screen.findByTestId('task-mode-progress-btn-tsk_with_check'));
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Ahead v2500');
    });
    expect(briefCalls).toBe(1);

    // Start manual Refresh at 2000; while in flight, live summary advances 2000 -> 2300
    fireEvent.click(screen.getByTestId('global-task-brief-refresh-btn'));
    await waitFor(() => {
      expect(briefCalls).toBe(2);
    });
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 2300 }
          : item)),
      });
    });

    // Settle manual refresh with 503 DAEMON_OFFLINE -> cached body, error, and Retry MUST remain, with no extra request
    await act(async () => {
      pending[0]!.resolve(new Response(JSON.stringify({ ok: false, error: TASK_PAIR_BRIEF_ERROR.DAEMON_OFFLINE }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');
    });
    expect(screen.getByTestId('global-task-brief-retry-btn')).toBeTruthy();
    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Ahead v2500');
    expect(briefCalls).toBe(2);

    // Delayed post-settlement live update still covered by cache (2300 -> 2400 <= 2500) must also retain error/Retry
    await act(async () => {
      const prevTasks = globalTaskModeStore.getState().tasks;
      globalTaskModeStore.setState({
        tasks: prevTasks.map((item) => (item.taskId === 'tsk_with_check'
          ? { ...item, updatedAt: 2400 }
          : item)),
      });
    });
    expect(screen.getByTestId('global-task-brief-error').textContent).toContain('offline');
    expect(screen.getByTestId('global-task-brief-retry-btn')).toBeTruthy();
    expect(screen.getByTestId('global-task-brief-item-1').textContent).toContain('Ahead v2500');
    expect(briefCalls).toBe(2);
  });
});
