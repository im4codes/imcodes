/**
 * @vitest-environment jsdom
 *
 * Tests for incoming agent message card compression:
 * - 100% full width and 7-line fold threshold for agent messages (vs 10 for human)
 * - Compact merged footer containing the fold toggle and timestamp on the same row
 * - Preserved status flags (pending, queued, failed retry) and no impact on human messages
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
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
import { AGENT_DELEGATION_SENDER_MARKER } from '../../../shared/agent-delegation.js';
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../../shared/chat-message-origin.js';

let seq = 0;
function makeMessage(payload: Record<string, unknown>, ts = 1_700_000_000_000): TimelineEvent {
  seq += 1;
  return {
    eventId: `evt-${seq}`,
    sessionId: 'deck_agent_compression_test',
    ts,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'user.message',
    payload,
  } as TimelineEvent;
}

const agentReportWithSender = (text: string) =>
  `${AGENT_DELEGATION_SENDER_MARKER}\nMessage from IM.codes session: deck_sub_ag2 (label: Ag2)\n\n${text}`;

afterEach(() => cleanup());

describe('Incoming agent message card compression & footer merge', () => {
  it('folds agent message at 7 lines while human message remains unfolded at 7 lines', () => {
    const sevenLineText = Array.from({ length: 7 }, (_, i) => `line-${i + 1}`).join('\n');
    const eightLineText = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join('\n');

    // Human message with 8 lines does NOT fold (limit is 10)
    const { container: humanContainer } = render(
      <ChatView events={[makeMessage({ text: eightLineText })]} loading={false} hasOlderHistory={false} sessionId="s1" />,
    );
    expect(humanContainer.querySelector('.chat-user-message-fold')?.classList.contains('is-foldable')).toBe(false);
    expect(humanContainer.querySelector('.chat-user-footer')).toBeNull();
    cleanup();

    // Agent message with 7 lines does NOT fold
    const { container: agent7Container } = render(
      <ChatView events={[makeMessage({ text: agentReportWithSender(sevenLineText) })]} loading={false} hasOlderHistory={false} sessionId="s2" />,
    );
    expect(agent7Container.querySelector('.chat-user-message-fold')?.classList.contains('is-foldable')).toBe(false);
    // But agent message still has .chat-user-footer containing the time
    const agent7Footer = agent7Container.querySelector('.chat-user-footer');
    expect(agent7Footer).toBeTruthy();
    expect(agent7Footer?.querySelector('.chat-bubble-time')).toBeTruthy();
    expect(agent7Footer?.querySelector('.chat-user-message-fold-toggle')).toBeNull();
    cleanup();

    // Agent message with 8 lines DOES fold (exceeds 7 lines)
    const { container: agent8Container } = render(
      <ChatView events={[makeMessage({ text: agentReportWithSender(eightLineText) })]} loading={false} hasOlderHistory={false} sessionId="s3" />,
    );
    const fold = agent8Container.querySelector('.chat-user-message-fold');
    expect(fold?.classList.contains('is-foldable')).toBe(true);
    expect(fold?.classList.contains('is-folded')).toBe(true);

    // Toggle and time are merged into .chat-user-footer
    const footer = agent8Container.querySelector('.chat-user-footer');
    expect(footer).toBeTruthy();
    const toggle = footer?.querySelector('.chat-user-message-fold-toggle');
    const time = footer?.querySelector('.chat-bubble-time');
    expect(toggle).toBeTruthy();
    expect(time).toBeTruthy();

    // Expand and collapse toggle
    fireEvent.click(screen.getByRole('button', { name: 'chat.user_message_expand' }));
    expect(fold?.classList.contains('is-folded')).toBe(false);
    expect(screen.getByRole('button', { name: 'chat.user_message_collapse' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat.user_message_collapse' }));
    expect(fold?.classList.contains('is-folded')).toBe(true);
  });

  it('keeps short agent messages compact with time in footer without fold toggle', () => {
    const { container } = render(
      <ChatView events={[makeMessage({ text: agentReportWithSender('Single line status update.') })]} loading={false} hasOlderHistory={false} sessionId="s4" />,
    );
    const bubble = container.querySelector('.chat-user.chat-user-origin-agent');
    expect(bubble).toBeTruthy();
    const footer = bubble?.querySelector('.chat-user-footer');
    expect(footer).toBeTruthy();
    expect(footer?.querySelector('.chat-bubble-time')).toBeTruthy();
    expect(footer?.querySelector('.chat-user-message-fold-toggle')).toBeNull();
  });

  it('preserves pending, queued, and failed retry states in the agent footer', () => {
    const onResend = vi.fn();
    const { container } = render(
      <ChatView
        events={[
          makeMessage({ text: agentReportWithSender('Report pending'), pending: true }),
          makeMessage({ text: agentReportWithSender('Report queued'), queued: true }),
          makeMessage({ text: agentReportWithSender('Report failed'), failed: true, commandId: 'cmd-1' }),
        ]}
        loading={false}
        hasOlderHistory={false}
        sessionId="s5"
        onResendFailed={onResend}
      />,
    );
    const bubbles = container.querySelectorAll('.chat-user.chat-user-origin-agent');
    expect(bubbles).toHaveLength(3);

    // Pending bubble
    expect(bubbles[0].querySelector('.chat-user-footer .chat-user-status-pending')).toBeTruthy();

    // Queued bubble
    expect(bubbles[1].querySelector('.chat-user-footer .chat-user-status-queued')).toBeTruthy();

    // Failed bubble with retry button
    const retryBtn = bubbles[2].querySelector('.chat-user-footer .chat-user-retry-btn') as HTMLButtonElement | null;
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn!);
    expect(onResend).toHaveBeenCalledWith('cmd-1', expect.stringContaining('Report failed'));
  });

  it('keeps human user messages right-aligned without .chat-user-footer', () => {
    const { container } = render(
      <ChatView
        events={[makeMessage({ text: 'Hello from human' })]}
        loading={false}
        hasOlderHistory={false}
        sessionId="s6"
      />,
    );
    const humanBubble = container.querySelector('.chat-user.chat-user-origin-user');
    expect(humanBubble).toBeTruthy();
    expect(humanBubble?.querySelector('.chat-user-footer')).toBeNull();
    // Time is a direct child of .chat-user
    expect(humanBubble?.querySelector(':scope > .chat-bubble-time')).toBeTruthy();
  });

  it('verifies CSS rules in stylesheet for full-width agent card and 7-line fold', () => {
    const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');

    // Agent message full width
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s*\{[^}]*width:\s*100%;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s*\{[^}]*align-self:\s*stretch;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s*\{[^}]*box-sizing:\s*border-box;/);

    // 7-line fold threshold for agent
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s+\.chat-user-message-fold-content\.is-folded[^}]*max-height:\s*calc\(1\.45em\s*\*\s*7\);/);

    // Mask offset
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s+\.chat-user-message-fold\.is-folded::after\s*\{[^}]*bottom:\s*24px;/);

    // Merged footer flex styles
    expect(css).toMatch(/\.chat-user-footer\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.chat-user-footer\s+\.chat-bubble-time,\s*\.chat-user-footer\s+\.chat-user-status\s*\{[^}]*margin-left:\s*auto;/);
  });
});
