/**
 * @vitest-environment jsdom
 *
 * tsk_cd_send_spinner_console_sync: a local user bubble shows exactly one send
 * indicator. The blocking spinner only while the daemon has not yet received
 * the command; a small, non-blocking "Queued" marker for an Append send the
 * queue still lists (no strip card exists for it); the retryable failure state
 * otherwise. Nothing is shown once the send is simply accepted and delivered.
 */
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));
vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));
vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: preact.ComponentChildren }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false, rawValue: false, loaded: true, loading: false, stale: false, error: null,
    save: async () => undefined, set: () => undefined, reload: async () => true,
  }),
}));

import { ChatView } from '../../src/components/ChatView.js';
import type { TimelineEvent } from '../../src/ws-client.js';

const SESSION = 'deck_send_status';

function local(payload: Record<string, unknown>): TimelineEvent {
  return {
    eventId: `optimistic:${SESSION}:${String(payload.commandId)}`,
    sessionId: SESSION,
    ts: 1_700_000_000_000,
    seq: 0,
    epoch: 0,
    source: 'daemon',
    confidence: 'high',
    type: 'user.message',
    payload,
  } as TimelineEvent;
}

const renderBubble = (payload: Record<string, unknown>) => render(
  <ChatView events={[local(payload)]} loading={false} hasOlderHistory={false} sessionId={SESSION} />,
);

afterEach(() => cleanup());

describe('ChatView local send status indicators', () => {
  it('shows the blocking spinner only while the daemon has not received the command', () => {
    const { container } = renderBubble({ text: 'sending', commandId: 'c1', pending: true });
    expect(container.querySelector('.chat-user-status-pending')).not.toBeNull();
    expect(container.querySelector('.chat-user-status-queued')).toBeNull();
  });

  it('shows nothing once the receipt cleared the spinner (accepted, not queued)', () => {
    const { container } = renderBubble({ text: 'sent', commandId: 'c2', pending: false, acked: true });
    expect(container.querySelector('.chat-user-status-pending')).toBeNull();
    expect(container.querySelector('.chat-user-status-queued')).toBeNull();
    expect(container.querySelector('.chat-user-status-failed')).toBeNull();
  });

  it('shows the small non-blocking Queued marker for a queued Append bubble', () => {
    const { container } = renderBubble({
      text: 'steer', commandId: 'c3', pending: false, acked: true, queued: true, queueAppended: true,
    });
    const marker = container.querySelector('.chat-user-status-queued');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe('Queued');
    expect(container.querySelector('.chat-user-status-pending')).toBeNull();
  });

  it('does not stack the marker on top of the spinner or the failure state', () => {
    const pending = renderBubble({ text: 'a', commandId: 'c4', pending: true, queued: true });
    expect(pending.container.querySelector('.chat-user-status-queued')).toBeNull();
    cleanup();
    const failed = renderBubble({ text: 'b', commandId: 'c5', pending: false, failed: true, queued: true });
    expect(failed.container.querySelector('.chat-user-status-queued')).toBeNull();
    expect(failed.container.querySelector('.chat-user-status-failed')).not.toBeNull();
  });

  it('the marker follows the queued flag alone (appears while queued, clears on delivery)', () => {
    const base = { text: 'steer', commandId: 'c6', pending: false, acked: true, queueAppended: true };
    const view = render(
      <ChatView events={[local(base)]} loading={false} hasOlderHistory={false} sessionId={SESSION} />,
    );
    expect(view.container.querySelector('.chat-user-status-queued')).toBeNull();

    view.rerender(
      <ChatView events={[local({ ...base, queued: true })]} loading={false} hasOlderHistory={false} sessionId={SESSION} />,
    );
    expect(view.container.querySelector('.chat-user-status-queued')).not.toBeNull();

    view.rerender(
      <ChatView events={[local(base)]} loading={false} hasOlderHistory={false} sessionId={SESSION} />,
    );
    expect(view.container.querySelector('.chat-user-status-queued')).toBeNull();
  });
});
