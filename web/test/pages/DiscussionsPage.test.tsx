/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/preact';
import type { ServerMessage, WsClient } from '../../src/ws-client.js';
import { DiscussionsPage } from '../../src/pages/DiscussionsPage.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'openspec.auto.reason.auto_deliver_active') return 'Auto Deliver is already running for this session.';
      if (key === 'openspec.auto.reason.missing_authoritative_json') return 'The audit did not produce a final authoritative JSON result.';
      if (key === 'openspec.auto.status.active') return 'Active';
      if (key === 'openspec.auto.status.implementation_task_loop') return 'Active';
      if (key === 'openspec.auto.stage.implementation_task_loop') return 'Implementation';
      if (key === 'openspec.auto.stage.implementation_audit_repair') return 'Implementation audit';
      if (key === 'p2p.mode_audit') return 'Audit';
      if (key === 'p2p.mode_review') return 'Review';
      if (key === 'p2p.mode_plan') return 'Plan';
      return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
    },
  }),
}));

// Forward onClick + the discussion shape so the click-to-select test
// below can fire the click handler DiscussionsPage hands the live
// cards. Production P2pProgressCard renders a complex SVG layout we
// don't need here; only the click contract matters for this test
// surface.
vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: (props: { discussion: { id: string; fileId?: string }; onClick?: () => void }) => (
    <button
      type="button"
      data-testid={`p2p-progress-card-${props.discussion.id}`}
      data-file-id={props.discussion.fileId ?? ''}
      onClick={props.onClick}
    >progress card {props.discussion.id}</button>
  ),
}));

vi.mock('../../src/components/FilePreviewPane.js', () => ({
  FilePreviewPane: ({ content }: { content: string }) => <div data-testid="discussion-preview">{content}</div>,
}));

describe('DiscussionsPage', () => {
  let handler: ((msg: ServerMessage) => void) | null = null;
  let ws: WsClient;
  let clipboardWriteText: ReturnType<typeof vi.fn>;
  let nextP2pRequestIndex = 0;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    nextP2pRequestIndex = 0;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    const nextP2pRequestId = () => `p2p-test-${++nextP2pRequestIndex}`;
    const send = vi.fn();
    let rafTime = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafTime += 120;
      cb(rafTime);
      return rafTime;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });

    ws = {
      send,
      p2pListDiscussions: vi.fn((scope?: { sessionName?: string; projectDir?: string; cwd?: string }) => {
        const requestId = nextP2pRequestId();
        send({ type: 'p2p.list_discussions', requestId, ...scope });
        return requestId;
      }),
      p2pReadDiscussion: vi.fn((id: string, scope?: { sessionName?: string; projectDir?: string; cwd?: string }) => {
        const requestId = nextP2pRequestId();
        send({ type: 'p2p.read_discussion', id, requestId, ...scope });
        return requestId;
      }),
      onMessage: (next: (msg: ServerMessage) => void) => {
        handler = next;
        return () => { handler = null; };
      },
    } as unknown as WsClient;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    handler = null;
  });

  it('defaults to auto-follow latest and scrolls to bottom when discussion content updates', async () => {
    const { container } = render(<DiscussionsPage ws={ws} />);

    expect(ws.p2pListDiscussions).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'p2p.list_discussions',
      requestId: 'p2p-test-1',
    }));

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: 'disc-1', fileName: 'disc-1.md', preview: 'Topic 1', mtime: 100 }],
      } as ServerMessage);
    });

    fireEvent.click(screen.getByText('Topic 1'));
    expect(ws.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'p2p.read_discussion', id: 'disc-1' }));

    const scrollEl = container.querySelector('.discussions-detail-scroll') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-1',
        content: 'Updated markdown',
      } as ServerMessage);
    });

    expect(screen.getByTestId('discussion-preview').textContent).toBe('Updated markdown');
    expect((screen.getByLabelText('p2p.discussions.auto_follow_latest') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(scrollEl.scrollTop).toBe(640));
    expect(screen.getByTitle('p2p.discussions.scroll_top')).toBeTruthy();
    expect(screen.getByTitle('p2p.discussions.scroll_bottom')).toBeTruthy();
  });

  it('passes discussion request scope into typed list and read helpers', async () => {
    render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_proj_brain', projectDir: '/repo/project' }} />);

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'p2p.list_discussions',
      requestId: 'p2p-test-1',
      sessionName: 'deck_proj_brain',
      projectDir: '/repo/project',
    }));

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        requestId: 'p2p-test-1',
        discussions: [{ id: 'disc-1', fileName: 'disc-1.md', preview: 'Topic 1', mtime: 100 }],
      } as ServerMessage);
    });

    fireEvent.click(screen.getByText('Topic 1'));
    expect(ws.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'p2p.read_discussion',
      id: 'disc-1',
      sessionName: 'deck_proj_brain',
      projectDir: '/repo/project',
    }));
  });

  it('disables follow when unchecked, and re-enables it from the bottom arrow', async () => {
    const { container } = render(<DiscussionsPage ws={ws} />);

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: 'disc-2', fileName: 'disc-2.md', preview: 'Topic 2', mtime: 100 }],
      } as ServerMessage);
    });

    fireEvent.click(screen.getByText('Topic 2'));

    const scrollEl = container.querySelector('.discussions-detail-scroll') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      value: 720,
    });
    Object.defineProperty(scrollEl, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-2',
        content: 'Initial content',
      } as ServerMessage);
    });

    const checkbox = screen.getByLabelText('p2p.discussions.auto_follow_latest') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-2',
        content: 'New content after manual scroll',
      } as ServerMessage);
    });

    expect(screen.getByTestId('discussion-preview').textContent).toBe('New content after manual scroll');
    expect(scrollEl.scrollTop).toBe(720);

    scrollEl.scrollTop = 720;
    fireEvent.click(screen.getByTitle('p2p.discussions.scroll_top'));
    expect(checkbox.checked).toBe(false);
    expect(scrollEl.scrollTop).toBe(0);

    fireEvent.click(screen.getByTitle('p2p.discussions.scroll_bottom'));
    expect(checkbox.checked).toBe(true);
    expect(scrollEl.scrollTop).toBe(720);
  });

  it('copies discussion path from the list action menu', async () => {
    render(<DiscussionsPage ws={ws} />);

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: 'disc-3', fileName: 'disc-3.md', path: '/tmp/disc-3.md', preview: 'Topic 3', mtime: 100 }],
      } as ServerMessage);
    });

    fireEvent.click(screen.getByText('Topic 3'));
    const readReq = vi.mocked(ws.send).mock.calls.at(-1)?.[0] as { requestId?: string };
    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-3',
        requestId: readReq.requestId,
        content: 'Preview 3',
      } as ServerMessage);
    });

    fireEvent.click(screen.getByLabelText('common.copy'));
    fireEvent.click(screen.getByText('p2p.discussions.copy_path'));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('/tmp/disc-3.md');
    });
  });

  it('copies the current discussion content from the detail dock', async () => {
    render(<DiscussionsPage ws={ws} />);

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [
          { id: 'disc-4', fileName: 'disc-4.md', path: '/tmp/disc-4.md', preview: 'Topic 4', mtime: 100 },
        ],
      } as ServerMessage);
    });

    fireEvent.click(screen.getByText('Topic 4'));
    const initialRead = vi.mocked(ws.send).mock.calls.at(-1)?.[0] as { requestId?: string };

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-4',
        requestId: initialRead.requestId,
        content: 'Current preview content',
      } as ServerMessage);
    });

    fireEvent.click(screen.getByLabelText('common.copy'));
    fireEvent.click(screen.getByText('p2p.discussions.copy_content'));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('Current preview content');
    });
    expect(screen.getByTestId('discussion-preview').textContent).toBe('Current preview content');
  });

  it('refreshes via the typed p2pListDiscussions helper, never the legacy discussionList', async () => {
    // PR-H regression: app.tsx and the DiscussionsPage must always go through
    // the project-scoped `p2pListDiscussions` helper. The legacy
    // `discussionList()` predates the daemon's scope guard and would yield
    // empty/forbidden results under the new server-side enforcement.
    const legacyDiscussionList = vi.fn();
    const wsWithLegacy = {
      ...(ws as unknown as Record<string, unknown>),
      discussionList: legacyDiscussionList,
    } as unknown as WsClient;

    render(<DiscussionsPage ws={wsWithLegacy} requestScope={{ sessionName: 'deck_proj_brain' }} />);

    expect(wsWithLegacy.p2pListDiscussions).toHaveBeenCalledTimes(1);
    expect(wsWithLegacy.p2pListDiscussions).toHaveBeenCalledWith({ sessionName: 'deck_proj_brain' });
    expect(legacyDiscussionList).not.toHaveBeenCalled();
  });

  it('renders copy and scroll controls in the top nav controls instead of inside the list', async () => {
    const { container } = render(<DiscussionsPage ws={ws} />);

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: 'disc-6', fileName: 'disc-6.md', path: '/tmp/disc-6.md', preview: 'Topic 6', mtime: 100 }],
      } as ServerMessage);
    });

    expect(container.querySelector('.discussions-list .discussions-copy-btn')).toBeNull();

    fireEvent.click(screen.getByText('Topic 6'));
    const readReq = vi.mocked(ws.send).mock.calls.at(-1)?.[0] as { requestId?: string };
    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-6',
        requestId: readReq.requestId,
        content: 'Preview 6',
      } as ServerMessage);
    });

    expect(container.querySelector('.discussions-nav-controls .discussions-copy-btn')).toBeTruthy();
    expect(container.querySelectorAll('.discussions-nav-controls .discussions-scroll-btn-floating')).toHaveLength(3);
  });

  // Audit fix (live-bar ↔ list connection) — clicking a live P2P
  // progress card on the discussions page used to do nothing (the
  // bar at the top and the file list below were unrelated). Users
  // had to manually find the matching entry in the list by id.
  // The fix wires `onClick` on the cards to `selectDiscussion(fileId)`,
  // which sends a `p2p.read_discussion` and highlights the matching
  // list entry as active.
  it('clicking a live P2P progress card opens the matching discussion file', async () => {
    const FILE_ID = 'live-disc-7';
    const liveDiscussion = {
      id: `p2p_${FILE_ID}`,
      fileId: FILE_ID,
      topic: 'Live P2P run',
      state: 'running',
      currentRound: 1,
      maxRounds: 3,
    } as Parameters<typeof DiscussionsPage>[0]['liveDiscussions'][number];

    const { container } = render(
      <DiscussionsPage ws={ws} liveDiscussions={[liveDiscussion]} />,
    );

    // Seed the file list with the matching entry so the active-class
    // assertion has something to match against.
    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: FILE_ID, fileName: `${FILE_ID}.md`, preview: 'Topic live', mtime: 100 }],
      } as ServerMessage);
    });

    // Clicking the live card should send a p2p.read_discussion for
    // FILE_ID — same code path as clicking the list entry.
    const card = screen.getByTestId(`p2p-progress-card-p2p_${FILE_ID}`);
    expect(card.getAttribute('data-file-id')).toBe(FILE_ID);

    const sendCallsBefore = vi.mocked(ws.send).mock.calls.length;
    fireEvent.click(card);
    const sendCallsAfter = vi.mocked(ws.send).mock.calls.length;
    expect(sendCallsAfter).toBeGreaterThan(sendCallsBefore);

    const lastSend = vi.mocked(ws.send).mock.calls.at(-1)?.[0] as { type?: string; id?: string };
    expect(lastSend.type).toBe('p2p.read_discussion');
    expect(lastSend.id).toBe(FILE_ID);

    // Matching list entry must get the `active` class so the user
    // sees the connection between bar and list.
    const matchingItem = container.querySelector(`.discussions-list-item.active`);
    expect(matchingItem).not.toBeNull();
    expect(matchingItem?.textContent).toContain('Topic live');
  });

  // Audit fix (DiscussionsPage spam-fetch loop) — regression for the
  // "加载中…" + "p2p per-socket pending cap exceeded" bug. Parent
  // re-renders that pass a fresh inline `requestScope` object literal
  // used to make `loadList`'s `useCallback` re-identify, which fired
  // the mount effect again and dispatched another
  // `p2p.list_discussions` request — saturating the bridge's
  // per-socket cap until no response could come back.
  //
  // Contract pinned here: even when the parent supplies different
  // request-scope object identities across renders, the page must
  // dispatch only ONE list request per content-equal scope.
  it('does not spam p2p.list_discussions on parent rerender with content-equal scope', async () => {
    const view = render(
      <DiscussionsPage
        ws={ws}
        // Inline literal — each render produces a new identity but
        // identical content. The fix in app.tsx wraps the prop in
        // useMemo; this test verifies DiscussionsPage tolerates the
        // mistake even if a future refactor reverts the memoization.
        requestScope={{ sessionName: 'deck_proj_brain' }}
      />,
    );

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
    });

    // Force several parent rerenders with NEW object identities but
    // identical content.
    for (let i = 0; i < 5; i += 1) {
      view.rerender(
        <DiscussionsPage
          ws={ws}
          requestScope={{ sessionName: 'deck_proj_brain' }}
        />,
      );
      await act(async () => { /* yield microtask */ });
    }

    const listCalls = vi.mocked(ws.send).mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === 'p2p.list_discussions',
    );
    // Expected: exactly 1 dispatch on initial mount. Pre-fix would
    // produce 6+ (mount + 5 rerenders).
    expect(
      listCalls.length,
      `expected 1 list_discussions dispatch across 5 rerenders, got ${listCalls.length}`,
    ).toBeLessThanOrEqual(2); // ≤2 to allow a single in-flight retry
  });

  it('debounces list_discussions across a burst of RUN_UPDATE messages', async () => {
    render(<DiscussionsPage ws={ws} />);
    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
    });
    const baselineCalls = vi.mocked(ws.send).mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'p2p.list_discussions',
    ).length;

    // Burst 10 RUN_UPDATE messages in rapid succession.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        handler?.({
          type: 'p2p.run_update',
          run: { id: `run-${i}`, status: 'running', discussion_id: `disc-${i}` },
        } as unknown as ServerMessage);
      });
    }
    // Wait past the debounce window (250ms) for the coalesced fetch.
    await new Promise((r) => setTimeout(r, 350));

    const finalCalls = vi.mocked(ws.send).mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'p2p.list_discussions',
    ).length;
    // Pre-fix would produce 10 new dispatches (one per RUN_UPDATE).
    // Post-fix: at most 1 coalesced dispatch.
    expect(
      finalCalls - baselineCalls,
      `expected ≤1 list_discussions dispatch from 10 RUN_UPDATEs, got ${finalCalls - baselineCalls}`,
    ).toBeLessThanOrEqual(1);
  });

  it('loads Auto Deliver recovery rows into the dedicated list tab', async () => {
    const { container } = render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} />);
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.list_request',
      sessionName: 'deck_sub_1',
    }));

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [{
          runId: 'auto-run-1',
          projectionVersion: 2,
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: 'deck_proj_brain',
          targetImplementationSessionName: 'deck_sub_1',
          selectedTeamComboId: 'audit>review>plan',
        }],
      } as unknown as ServerMessage);
    });

    expect(screen.getByRole('button', { name: 'openspec.auto.list_title' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'p2p.discussions.title' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'openspec.auto.list_title' }));
    expect(screen.getAllByText('openspec-auto-delivery').length).toBeGreaterThanOrEqual(1);
    const autoRow = container.querySelector('.discussions-list-item') as HTMLElement;
    expect(autoRow).toBeTruthy();
    expect(autoRow.textContent).toContain('Implementation');
    expect(autoRow.textContent).toContain('Active');
    expect(autoRow.textContent).not.toContain('implementation_task_loop');

    fireEvent.click(autoRow);
    expect(autoRow.className).toContain('active');
    expect(screen.getByText('deck_proj_brain')).toBeDefined();
    expect(screen.getByText('deck_sub_1')).toBeDefined();
    expect(screen.getByText('Audit→Review→Plan')).toBeDefined();
    expect(screen.queryByText('audit>review>plan')).toBeNull();
  });

  it('can open directly on the Auto Deliver list tab', async () => {
    render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} initialTab="auto" />);

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [{ id: 'team-1', preview: 'Team row', fileName: 'team-1.md', mtime: 1 }] } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [{
          runId: 'auto-run-direct',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'direct-auto',
          status: 'implementation_task_loop',
          stage: 'spec_audit_repair',
          owningMainSessionName: 'deck_proj_brain',
        }],
      } as unknown as ServerMessage);
    });

    expect(screen.getAllByText('direct-auto').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Team row')).toBeNull();
  });

  it('keeps the Auto Deliver list category available on mobile', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} initialTab="auto" />);

    await act(async () => {
      handler?.({
        type: 'p2p.list_discussions_response',
        discussions: [{ id: 'team-1', preview: 'Team row', fileName: 'team-1.md', mtime: 1 }],
      } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [{
          runId: 'auto-run-mobile-visible',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'visible-auto',
          status: 'implementation_task_loop',
          stage: 'spec_audit_repair',
          owningMainSessionName: 'deck_proj_brain',
        }],
      } as unknown as ServerMessage);
    });

    expect(screen.getByRole('button', { name: 'openspec.auto.list_title' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'p2p.discussions.title' })).toBeDefined();
    expect(screen.getAllByText('visible-auto').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Team row')).toBeNull();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.list_request',
      sessionName: 'deck_sub_1',
    }));
  });

  it('renders Auto Deliver conflict rows without change names and localizes conflict reasons', async () => {
    const { container } = render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} initialTab="auto" />);

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [{
          runId: 'auto-conflict-1',
          projectionVersion: 3,
          visibility: 'conflict',
          status: 'implementation_task_loop',
          stage: 'implementation_audit_repair',
          owningMainSessionName: 'deck_proj_brain',
          reason: 'auto_deliver_active',
          changeName: 'private-change-name',
          latestRepairSummary: 'private repair summary',
          evidence: [{ summary: 'private evidence' }],
          uncheckedTaskLabels: ['private unchecked task'],
          changedFiles: ['/Users/k/private/file.ts'],
          findings: ['private finding'],
          validationOutput: 'private validation output',
          rawPrompt: 'private prompt',
          rawP2pInternals: { sessionName: 'deck_secret_worker' },
          apiToken: 'secret-token',
        }],
      } as unknown as ServerMessage);
    });

    expect(screen.queryByText('private-change-name')).toBeNull();
    expect(screen.queryByText('private repair summary')).toBeNull();
    expect(screen.queryByText('private evidence')).toBeNull();
    expect(screen.queryByText('private unchecked task')).toBeNull();
    expect(screen.queryByText('/Users/k/private/file.ts')).toBeNull();
    expect(screen.queryByText('private finding')).toBeNull();
    expect(screen.queryByText('private validation output')).toBeNull();
    expect(screen.queryByText('private prompt')).toBeNull();
    expect(screen.queryByText('deck_secret_worker')).toBeNull();
    expect(screen.queryByText('secret-token')).toBeNull();
    const autoRow = container.querySelector('.discussions-list-item') as HTMLElement;
    expect(autoRow.textContent).toContain('deck_proj_brain');
    expect(autoRow.textContent).not.toContain('private-change-name');

    fireEvent.click(autoRow);
    expect(screen.getByText('Auto Deliver is already running for this session.')).toBeDefined();
    expect(screen.queryByText('auto_deliver_active')).toBeNull();
  });

  it('drops malformed Auto Deliver list rows before recovery state can render them', async () => {
    render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} initialTab="auto" />);

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [
          {
            runId: 'missing-visibility',
            projectionVersion: 1,
            changeName: 'leaked-missing-visibility',
            status: 'active',
            stage: 'implementation_task_loop',
            owningMainSessionName: 'deck_proj_brain',
          },
          {
            runId: 'missing-stage',
            projectionVersion: 2,
            visibility: 'full',
            changeName: 'leaked-missing-stage',
            status: 'active',
            owningMainSessionName: 'deck_proj_brain',
          },
          {
            runId: 'bad-version',
            projectionVersion: Number.POSITIVE_INFINITY,
            visibility: 'conflict',
            status: 'active',
            stage: 'implementation_task_loop',
            owningMainSessionName: 'deck_proj_brain',
            reason: 'auto_deliver_active',
          },
          {
            runId: 'valid-row',
            projectionVersion: 3,
            visibility: 'full',
            changeName: 'visible-valid-row',
            status: 'implementation_task_loop',
            stage: 'implementation_task_loop',
            owningMainSessionName: 'deck_proj_brain',
          },
        ],
      } as unknown as ServerMessage);
    });

    expect(screen.getAllByText('visible-valid-row').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('leaked-missing-visibility')).toBeNull();
    expect(screen.queryByText('leaked-missing-stage')).toBeNull();
    expect(screen.queryByText('bad-version')).toBeNull();
  });

  it('localizes Auto Deliver terminal reasons in recovery row details', async () => {
    const { container } = render(<DiscussionsPage ws={ws} requestScope={{ sessionName: 'deck_sub_1' }} initialTab="auto" />);

    await act(async () => {
      handler?.({ type: 'p2p.list_discussions_response', discussions: [] } as ServerMessage);
      handler?.({
        type: 'openspec_auto_deliver.list_response',
        rows: [{
          runId: 'auto-terminal-1',
          projectionVersion: 4,
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
          status: 'needs_human',
          stage: 'needs_human',
          viewMode: 'compactRecovery',
          owningMainSessionName: 'deck_proj_brain',
          targetImplementationSessionName: 'deck_sub_1',
          terminalReason: 'missing_authoritative_json',
        }],
      } as unknown as ServerMessage);
    });

    const autoRow = container.querySelector('.discussions-list-item') as HTMLElement;
    fireEvent.click(autoRow);
    expect(screen.getByText('The audit did not produce a final authoritative JSON result.')).toBeDefined();
    expect(screen.queryByText('missing_authoritative_json')).toBeNull();
  });

  it('clicking a live progress card with NO fileId is a no-op (orphan run mid-bind)', async () => {
    const liveDiscussion = {
      id: 'p2p_orphan',
      // fileId intentionally omitted — runs that never produced a file
      // (failed bind, supervision-internal, etc.) shouldn't crash the
      // page on click.
      topic: 'Orphan',
      state: 'queued',
      currentRound: 0,
      maxRounds: 1,
    } as Parameters<typeof DiscussionsPage>[0]['liveDiscussions'][number];

    render(<DiscussionsPage ws={ws} liveDiscussions={[liveDiscussion]} />);
    const card = screen.getByTestId('p2p-progress-card-p2p_orphan');
    const sendCallsBefore = vi.mocked(ws.send).mock.calls.length;
    fireEvent.click(card);
    // No onClick wired (fileId missing) — no new send calls.
    expect(vi.mocked(ws.send).mock.calls.length).toBe(sendCallsBefore);
  });
});
