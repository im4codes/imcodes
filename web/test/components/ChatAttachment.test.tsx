/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup } from '@testing-library/preact';

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

import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

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
  afterEach(() => cleanup());

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
});
