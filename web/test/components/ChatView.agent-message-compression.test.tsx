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

import { ChatView, __ChatEventForTests as ChatEvent } from '../../src/components/ChatView.js';
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

  it('renders no empty footer when showTime is false for short agent message without status', () => {
    const { container } = render(
      <ChatView
        events={[{
          ...makeMessage({ text: agentReportWithSender('Short message with showTime=false') }),
          ts: 0,
        }]}
        loading={false}
        hasOlderHistory={false}
        sessionId="s4-notime"
      />,
    );
    const bubble = container.querySelector('.chat-user.chat-user-origin-agent');
    expect(bubble).toBeTruthy();
    // No time and not folded -> no .chat-user-footer rendered at all
    expect(bubble?.querySelector('.chat-user-footer')).toBeNull();
  });

  it('preserves pending, queued with time, and failed retry states in the agent footer', () => {
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

    // Queued bubble: contains both queued label and time
    const queuedFooter = bubbles[1].querySelector('.chat-user-footer .chat-user-footer-right');
    expect(queuedFooter).toBeTruthy();
    expect(queuedFooter?.querySelector('.chat-user-status-queued')).toBeTruthy();
    expect(queuedFooter?.querySelector('.chat-bubble-time')).toBeTruthy();

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

    // Narrow/zoomed controls stay in one flex row without reducing the font.
    expect(css).toMatch(/\.chat-user-footer \.chat-user-message-fold-toggle\s*\{[^}]*flex:\s*0 1 auto;/);
    expect(css).toMatch(/\.chat-user-footer-right \.chat-bubble-time\s*\{[^}]*white-space:\s*normal;/);

    // Merged footer flex styles
    expect(css).toMatch(/\.chat-user-footer\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.chat-user-footer\s+\.chat-bubble-time,\s*\.chat-user-footer\s+\.chat-user-status\s*\{[^}]*margin-left:\s*auto;/);
  });
});


const footerOrigins = [
  { name: 'human', payload: { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.USER }, origin: CHAT_MESSAGE_ORIGINS.USER, limit: 10 },
  { name: 'legacy missing stamp', payload: {}, origin: CHAT_MESSAGE_ORIGINS.USER, limit: 10 },
  { name: 'agent', payload: { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.AGENT }, origin: CHAT_MESSAGE_ORIGINS.AGENT, limit: 7 },
  { name: 'system', payload: { [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM }, origin: CHAT_MESSAGE_ORIGINS.SYSTEM, limit: 10 },
];
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Unmodified line ${i + 1}`).join('\n');

describe.each(footerOrigins)('Shared message footer: $name', ({ payload, origin, limit }) => {
  it('keeps Show full and collapse with the single timestamp, without changing origin or content', () => {
    const { container } = render(<ChatEvent event={makeMessage({ ...payload, text: lines(11) })} showTime />);
    const bubble = container.querySelector('.chat-user')!;
    expect(bubble.getAttribute('data-message-origin')).toBe(origin);
    const footer = bubble.querySelector('.chat-user-footer');
    expect(footer).toBeTruthy();
    expect(footer?.querySelector('.chat-user-message-fold-toggle')).toBeTruthy();
    expect(footer?.querySelector('.chat-bubble-time')).toBeTruthy();
    expect(bubble.querySelectorAll('.chat-bubble-time')).toHaveLength(1);
    expect(bubble.querySelector('.chat-bubble-content')?.textContent).toBe(lines(11));
    const toggle = footer!.querySelector('button')!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(footer?.querySelector('.chat-bubble-time')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bubble.querySelectorAll('.chat-user-footer')).toHaveLength(1);
  });
  it.each([0, 1, 7, 8, 10, 11])('preserves the hard-line threshold for %i lines', n => {
    const { container } = render(<ChatEvent event={makeMessage({ ...payload, text: lines(n) })} />);
    expect(container.querySelector('.chat-user-message-fold-toggle') !== null).toBe(n > limit);
    expect(container.querySelectorAll('.chat-bubble-time')).toHaveLength(1);
    if (n === 0) expect(container.querySelector('.chat-user-footer')).toBeNull();
  });
  it.each([
    { showTime: false, ts: 1_700_000_000_000 },
    { showTime: true, ts: 0 },
    { showTime: true, ts: -1 },
    { showTime: true, ts: Number.NaN },
    { showTime: true, ts: Number.POSITIVE_INFINITY },
    { showTime: true, ts: undefined },
  ])('does not fabricate time or an empty footer for $showTime/$ts', ({ showTime, ts }) => {
    const short = { ...makeMessage({ ...payload, text: 'Short' }), ts } as TimelineEvent;
    const view = render(<ChatEvent event={short} showTime={showTime} />);
    expect(view.container.querySelector('.chat-bubble-time')).toBeNull();
    expect(view.container.querySelector('.chat-user-footer')).toBeNull();
    view.rerender(<ChatEvent event={{ ...short, payload: { ...short.payload, text: lines(11) } }} showTime={showTime} />);
    expect(view.container.querySelector('.chat-bubble-time')).toBeNull();
    expect(view.container.querySelector('.chat-user-footer button')).toBeTruthy();
    expect(view.container.querySelector('.chat-user-footer-right')).toBeNull();
  });
  it('preserves pending/queued/failed priority, retry payload and attachment-only time', () => {
    const retry = vi.fn();
    const text = lines(11);
    const event = makeMessage({ ...payload, text, pending: true, queued: true });
    const view = render(<ChatEvent event={event} onResendFailed={retry} />);
    expect(view.container.querySelector('.chat-user-footer .chat-user-status-pending')).toBeTruthy();
    expect(view.container.querySelector('.chat-user-status-queued')).toBeNull();
    expect(view.container.querySelector('.chat-bubble-time')).toBeNull();
    view.rerender(<ChatEvent event={{ ...event, payload: { ...payload, text, queued: true } }} onResendFailed={retry} />);
    expect(view.container.querySelector('.chat-user-footer-right .chat-user-status-queued')).toBeTruthy();
    expect(view.container.querySelectorAll('.chat-bubble-time')).toHaveLength(1);
    view.rerender(<ChatEvent event={{ ...event, payload: { ...payload, text, failed: true, queued: true, commandId: 'footer-retry' } }} onResendFailed={retry} />);
    expect(view.container.querySelector('.chat-user-status-queued')).toBeNull();
    expect(view.container.querySelector('.chat-bubble-time')).toBeNull();
    fireEvent.click(view.container.querySelector('.chat-user-footer .chat-user-retry-btn')!);
    expect(retry).toHaveBeenCalledWith('footer-retry', text);
    const attachments = [{ id: 'fixture-attachment', originalName: 'report.txt', mime: 'text/plain', daemonPath: '/fixture/report.txt' }];
    view.rerender(<ChatEvent event={{ ...event, payload: { ...payload, text: '', attachments } }} serverId="fixture-server" />);
    expect(view.container.querySelector('.chat-user-message-fold')).toBeNull();
    expect(view.container.querySelector('.chat-user-footer')).toBeNull();
    expect(view.container.querySelectorAll('.chat-bubble-time')).toHaveLength(1);
    expect(view.container.textContent).toContain('report.txt');
    view.rerender(<ChatEvent event={{ ...event, payload: { ...payload, text: 'With attachment', attachments } }} serverId="fixture-server" />);
    expect(view.container.querySelectorAll('.chat-bubble-time')).toHaveLength(1);
    expect(view.container.querySelector('.chat-user-footer') !== null).toBe(origin === CHAT_MESSAGE_ORIGINS.AGENT);
    expect(view.container.textContent).toContain('report.txt');
  });
});
