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
    t: (key: string) => key,
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
