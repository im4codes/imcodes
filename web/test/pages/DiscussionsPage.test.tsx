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

describe('DiscussionsPage', () => {
  let handler: ((msg: ServerMessage) => void) | null = null;
  let ws: WsClient;
  let scrollToMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollToMock = vi.fn();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollToMock,
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
    expect(ws.send).toHaveBeenLastCalledWith({ type: 'p2p.read_discussion', id: 'disc-1' });

    const scrollEl = container.querySelector('.discussions-detail-scroll') as HTMLDivElement;
    Object.defineProperty(scrollEl, 'scrollHeight', {
      configurable: true,
      value: 640,
    });

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-1',
        content: 'Updated markdown',
      } as ServerMessage);
    });

    expect((screen.getByLabelText('p2p.discussions.auto_follow_latest') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith({ top: 640, behavior: 'smooth' });
    });
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

    await act(async () => {
      handler?.({
        type: 'p2p.read_discussion_response',
        id: 'disc-2',
        content: 'Initial content',
      } as ServerMessage);
    });

    scrollToMock.mockClear();

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

    expect(scrollToMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('p2p.discussions.scroll_top'));
    expect(checkbox.checked).toBe(false);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

    scrollToMock.mockClear();

    fireEvent.click(screen.getByTitle('p2p.discussions.scroll_bottom'));
    expect(checkbox.checked).toBe(true);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 720, behavior: 'smooth' });
  });
});
