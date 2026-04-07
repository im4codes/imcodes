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

vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: () => null,
}));

vi.mock('../../src/components/FilePreviewPane.js', () => ({
  FilePreviewPane: ({ content }: { content: string }) => <div data-testid="discussion-preview">{content}</div>,
}));

describe('DiscussionsPage', () => {
  let handler: ((msg: ServerMessage) => void) | null = null;
  let ws: WsClient;
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
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
      send: vi.fn(),
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

    expect(ws.send).toHaveBeenCalledWith({ type: 'p2p.list_discussions' });

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

  it('renders copy control next to the floating arrows instead of inside the list', async () => {
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

    expect(container.querySelector('.discussions-scroll-dock .discussions-copy-btn')).toBeTruthy();
    expect(container.querySelectorAll('.discussions-scroll-dock .discussions-scroll-btn-floating')).toHaveLength(3);
  });
});
