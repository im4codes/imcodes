/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

// Mock FileBrowser to avoid heavy hljs imports
vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/api.js', () => ({
  downloadAttachment: vi.fn().mockResolvedValue(undefined),
  previewAttachment: vi.fn().mockResolvedValue(undefined),
}));

import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';
import { downloadAttachment, previewAttachment } from '../../src/api.js';

function makeEvent(overrides: Partial<TimelineEvent> & { type: string; payload: Record<string, unknown> }): TimelineEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: 'test-session',
    ts: Date.now(),
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    ...overrides,
  } as TimelineEvent;
}

describe('ChatView attachment download', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(downloadAttachment).mockClear();
    vi.mocked(previewAttachment).mockClear();
  });

  it('renders download buttons when user.message has attachments and serverId is set', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'check this file',
        attachments: [
          { id: 'abc123.png', originalName: 'photo.png', mime: 'image/png', size: 2048 },
        ],
      },
    })];

    render(<ChatView events={events} loading={false} serverId="srv-1" />);

    const btn = screen.getByTitle('photo.png');
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('photo.png');
    expect(btn.textContent).toContain('2KB');
  });

  it('uses originalName for download button label', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'here is my file',
        attachments: [
          { id: 'deadbeef1234.txt', originalName: 'notes.txt', size: 512 },
        ],
      },
    })];

    render(<ChatView events={events} loading={false} serverId="srv-1" />);

    const btn = screen.getByTitle('notes.txt');
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('notes.txt');
  });

  it('falls back to id when originalName is missing', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'file attached',
        attachments: [
          { id: 'abc123def456.bin' },
        ],
      },
    })];

    render(<ChatView events={events} loading={false} serverId="srv-1" />);

    const btn = screen.getByTitle('abc123def456.bin');
    expect(btn).toBeDefined();
  });

  it('does NOT render download buttons when serverId is missing', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'some message',
        attachments: [
          { id: 'test.txt', originalName: 'test.txt' },
        ],
      },
    })];

    render(<ChatView events={events} loading={false} />);

    expect(screen.queryByTitle('test.txt')).toBeNull();
  });

  it('does NOT render download buttons when no attachments', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: { text: 'plain message, no files' },
    })];

    render(<ChatView events={events} loading={false} serverId="srv-1" />);

    expect(screen.queryByRole('button', { name: /📎/ })).toBeNull();
  });

  it('renders multiple attachment buttons for multiple files', () => {
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'two files',
        attachments: [
          { id: 'a.txt', originalName: 'readme.txt', size: 100 },
          { id: 'b.png', originalName: 'logo.png', size: 5000 },
        ],
      },
    })];

    render(<ChatView events={events} loading={false} serverId="srv-1" />);

    expect(screen.getByTitle('readme.txt')).toBeDefined();
    expect(screen.getByTitle('logo.png')).toBeDefined();
  });

  it('shows daemonPath HTML render after download while primary click opens source preview', () => {
    const onPreviewFile = vi.fn();
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'render this',
        attachments: [
          { id: 'html-1', originalName: 'page.html', size: 1024, daemonPath: './page.HTML' },
        ],
      },
    })];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        serverId="srv-1"
        ws={{} as any}
        workdir="/repo"
        onPreviewFile={onPreviewFile}
      />,
    );

    const row = container.querySelector('.chat-attachment-row') as HTMLElement;
    const buttons = Array.from(row.querySelectorAll('button'));
    expect(buttons).toHaveLength(3);
    expect(buttons[1].getAttribute('title')).toBe('download_file');
    expect(buttons[2].classList.contains('chat-html-preview-btn')).toBe(true);

    fireEvent.click(buttons[0]);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/repo/./page.HTML',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/./page.HTML' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    }));
    expect(onPreviewFile.mock.calls[0][0].previewViewMode).not.toBe('html-render');

    fireEvent.click(buttons[2]);
    expect(onPreviewFile).toHaveBeenLastCalledWith(expect.objectContaining({
      path: '/repo/./page.HTML',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/./page.HTML' },
      rootPath: '/repo',
      sourcePreviewLive: false,
    }));
  });

  it('does not show a render action for HTML attachments without daemonPath', async () => {
    const onPreviewFile = vi.fn();
    const events = [makeEvent({
      type: 'user.message',
      payload: {
        text: 'html upload',
        attachments: [
          { id: 'html-no-path', originalName: 'upload.html', size: 1024 },
        ],
      },
    })];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        serverId="srv-1"
        ws={{} as any}
        workdir="/repo"
        onPreviewFile={onPreviewFile}
      />,
    );

    const row = container.querySelector('.chat-attachment-row') as HTMLElement;
    const buttons = Array.from(row.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(row.querySelector('.chat-html-preview-btn')).toBeNull();

    fireEvent.click(buttons[1]);
    await waitFor(() => {
      expect(downloadAttachment).toHaveBeenCalledWith('srv-1', 'html-no-path');
    });
    expect(previewAttachment).not.toHaveBeenCalled();
    expect(onPreviewFile).not.toHaveBeenCalled();
  });
});
