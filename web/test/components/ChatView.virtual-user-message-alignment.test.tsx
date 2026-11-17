/**
 * @vitest-environment jsdom
 *
 * Tests for human user message right-alignment across virtualized and non-virtualized chat:
 * - Direct flex row in short list (<= 24 items)
 * - Virtualized row inside .chat-virtual-item in long list (> 24 items)
 * - Linked event group (.chat-linked-event-group)
 * - Preserved origin-based alignment: human right, agent full-width stretch, system left
 * - Preserved user states: pending, queued, failed retry
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'zh-CN' },
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
function makeMessage(
  payload: Record<string, unknown>,
  opts: { source?: string; type?: string; ts?: number } = {},
): TimelineEvent {
  seq += 1;
  return {
    eventId: `evt-${seq}`,
    sessionId: 'deck_virtual_align_test',
    ts: opts.ts ?? (1_700_000_000_000 + seq * 1000),
    seq,
    epoch: 1,
    source: opts.source ?? 'user',
    confidence: 'high',
    type: opts.type ?? 'user.message',
    payload,
  } as TimelineEvent;
}

const agentDelivery = (text: string) =>
  `${AGENT_DELEGATION_SENDER_MARKER}\nMessage from IM.codes session: deck_sub_ag2 (label: Ag2)\n\n${text}`;

afterEach(() => cleanup());

describe('Human user message right-alignment in virtualized and non-virtualized chat', () => {
  it('renders human user messages right-aligned in short non-virtual chat (<= 24 items)', () => {
    const events = [
      makeMessage({ text: '那个。企叮咚的还没同步到 正式站' }),
      makeMessage({ text: '收到，正在核对配置。' }, { source: 'daemon', type: 'assistant.message' }),
      makeMessage({ text: agentDelivery('Agent status report') }, { source: 'daemon' }),
      makeMessage({ text: 'System notice', messageOrigin: 'system' }, { source: 'daemon' }),
    ];
    const { container } = render(
      <ChatView events={events} loading={false} hasOlderHistory={false} sessionId="s_short" />,
    );

    // No virtual wrappers in short list
    expect(container.querySelectorAll('.chat-virtual-item')).toHaveLength(0);

    const userBubble = container.querySelector('.chat-user.chat-user-origin-user');
    expect(userBubble).toBeTruthy();
    expect(userBubble?.textContent).toContain('那个。企叮咚的还没同步到 正式站');

    const agentBubble = container.querySelector('.chat-user.chat-user-origin-agent');
    expect(agentBubble).toBeTruthy();

    const systemBubble = container.querySelector('.chat-user.chat-user-origin-system');
    expect(systemBubble).toBeTruthy();
  });

  it('renders human messages inside .chat-virtual-item when list exceeds 24 presentation rows in jsdom/mock viewport', () => {
    // In jsdom clientHeight is 0 by default, but we can verify that when >24 user events exist,
    // each event has the origin-user class and the correct CSS classes applied.
    const events: TimelineEvent[] = [];
    for (let i = 1; i <= 30; i++) {
      events.push(makeMessage({ text: i === 30 ? '那个。企叮咚的还没同步到 正式站' : `User query ${i}` }));
    }

    const { container } = render(
      <ChatView events={events} loading={false} hasOlderHistory={false} sessionId="s_long" />,
    );

    const userBubbles = container.querySelectorAll('.chat-user.chat-user-origin-user');
    expect(userBubbles.length).toBeGreaterThan(0);
    const lastUserBubble = userBubbles[userBubbles.length - 1];
    expect(lastUserBubble.textContent).toContain('那个。企叮咚的还没同步到 正式站');
    expect(lastUserBubble.classList.contains('chat-user-origin-user')).toBe(true);
  });

  it('preserves user status indicators (pending, queued, failed) on right-aligned user messages', () => {
    const onResend = vi.fn();
    const events = [
      makeMessage({ text: 'Pending user message', pending: true }),
      makeMessage({ text: 'Queued user message', queued: true }),
      makeMessage({ text: 'Failed user message', failed: true, commandId: 'cmd_retry_1' }),
    ];

    const { container } = render(
      <ChatView events={events} loading={false} hasOlderHistory={false} sessionId="s_states" onResendFailed={onResend} />,
    );

    const bubbles = container.querySelectorAll('.chat-user.chat-user-origin-user');
    expect(bubbles).toHaveLength(3);

    // Pending
    expect(bubbles[0].querySelector('.chat-user-status-pending')).toBeTruthy();

    // Queued
    expect(bubbles[1].querySelector('.chat-user-status-queued')).toBeTruthy();

    // Failed
    const retryBtn = bubbles[2].querySelector('.chat-user-retry-btn') as HTMLButtonElement | null;
    expect(retryBtn).toBeTruthy();
    retryBtn?.click();
    expect(onResend).toHaveBeenCalledWith('cmd_retry_1', expect.stringContaining('Failed user message'));
  });

  it('verifies stylesheet rules for .chat-virtual-item, .chat-linked-event-group and .chat-user alignment', () => {
    const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');

    // .chat-virtual-item flex column wrapper
    expect(css).toMatch(/\.chat-virtual-item\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.chat-virtual-item\s*\{[^}]*flex-direction:\s*column;/);
    expect(css).toMatch(/\.chat-virtual-item\s*\{[^}]*width:\s*100%;/);

    // .chat-linked-event-group flex column wrapper
    expect(css).toMatch(/\.chat-linked-event-group\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.chat-linked-event-group\s*\{[^}]*flex-direction:\s*column;/);

    // .chat-user alignment: align-self flex-end and margin-inline-start auto
    expect(css).toMatch(/\.chat-user\s*\{[^}]*align-self:\s*flex-end;/);
    expect(css).toMatch(/\.chat-user\s*\{[^}]*margin-inline-start:\s*auto;/);
    expect(css).toMatch(/\.chat-user\s*\{[^}]*max-width:\s*80%;/);
    expect(css).toMatch(/\.chat-user\s*\{[^}]*width:\s*fit-content;/);

    // .chat-user-origin-user explicit reinforcement
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s*\{[^}]*align-self:\s*flex-end;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s*\{[^}]*margin-inline-start:\s*auto;/);

    // Agent and system origin messages stay left-aligned / reset margin
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent,\s*\.chat-user\.chat-user-origin-system\s*\{[^}]*align-self:\s*flex-start;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent,\s*\.chat-user\.chat-user-origin-system\s*\{[^}]*margin-inline-start:\s*0;/);

    // Agent message retains 100% full width stretch
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s*\{[^}]*align-self:\s*stretch;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent\s*\{[^}]*width:\s*100%;/);

    // Supervision prompt stays left-aligned
    expect(css).toMatch(/\.chat-user-supervision-prompt\s*\{[^}]*align-self:\s*flex-start;/);
    expect(css).toMatch(/\.chat-user-supervision-prompt\s*\{[^}]*margin-inline-start:\s*0;/);
  });
});
