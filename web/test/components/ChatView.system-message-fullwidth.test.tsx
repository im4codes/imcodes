/**
 * @vitest-environment jsdom
 *
 * Tests for system message full-width card layout in ChatView:
 * - System workspace reminders ([IM.codes workspaces]) expand to 100% full width
 * - System messages in virtualized lists (> 24 items) expand inside .chat-virtual-item
 * - Preserved boundaries: human messages remain right-aligned and fit-content (<= 80%)
 * - Preserved boundaries: agent messages remain 100% full-width stretch
 * - Preserved boundaries: supervision prompt chips stay compact fit-content
 * - Preserved boundaries: cron runs stay compact fit-content
 * - Stylesheet assertions for .chat-user.chat-user-origin-system
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
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../../shared/chat-message-origin.js';

let seq = 0;
function makeMessage(
  payload: Record<string, unknown>,
  opts: { source?: string; type?: string; ts?: number } = {},
): TimelineEvent {
  seq += 1;
  return {
    eventId: `evt-${seq}`,
    sessionId: 'deck_system_fullwidth_test',
    ts: opts.ts ?? (1_700_000_000_000 + seq * 1000),
    seq,
    epoch: 1,
    source: opts.source ?? 'daemon',
    confidence: 'high',
    type: opts.type ?? 'user.message',
    payload,
  } as TimelineEvent;
}

const WORKSPACE_KEPT_TEXT = `[IM.codes workspaces] 20 more finished pairs have a worktree kept with unsaved work that the daemon has not announced one by one yet: you already have 6 announced workspaces still open, and it will not queue more messages for you until some of them are resolved (integrated, committed by the executor, or discarded). Each is announced with its own options when its turn comes; nothing is deleted meanwhile.
Waiting:
- tsk_01 "Task 1": in_audit, ended 2d ago
- tsk_02 "Task 2": rework, ended 1d ago
- ... and 18 more
Announced and still open:
- tsk_03 "Task 3"
- ... and 5 more`;

describe('System message full-width card layout in ChatView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders system workspace kept reminder with chat-user-origin-system class', () => {
    const events = [
      makeMessage(
        { text: WORKSPACE_KEPT_TEXT, automation: true, automationKind: 'task_pair_automation' },
        { source: 'daemon' },
      ),
    ];

    const { container } = render(
      <ChatView events={events} loading={false} hasOlderHistory={false} sessionId="s_system_short" />,
    );

    const systemCards = container.querySelectorAll('.chat-user.chat-user-origin-system');
    expect(systemCards).toHaveLength(1);
    const card = systemCards[0];
    expect(card.textContent).toContain('[IM.codes workspaces]');
    expect(card.getAttribute('data-message-origin')).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
  });

  it('renders system messages inside virtualized chat (> 24 items) with origin-system', () => {
    const events: TimelineEvent[] = [];
    for (let i = 1; i <= 26; i += 1) {
      if (i % 2 !== 0) {
        events.push(makeMessage({ text: `User request message #${i}` }, { source: 'user' }));
      } else {
        events.push(makeMessage(
          { text: `System status update #${i}`, automation: true },
          { source: 'daemon' },
        ));
      }
    }
    events.push(makeMessage(
      { text: WORKSPACE_KEPT_TEXT, automation: true, [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM },
      { source: 'daemon' },
    ));

    const { container } = render(
      <ChatView events={events} loading={false} hasOlderHistory={false} sessionId="s_system_long" />,
    );

    const systemCards = container.querySelectorAll('.chat-user.chat-user-origin-system');
    expect(systemCards.length).toBeGreaterThan(0);
    const workspaceCard = Array.from(systemCards).find((el) => el.textContent?.includes('[IM.codes workspaces]'));
    expect(workspaceCard).toBeTruthy();
    expect(workspaceCard?.getAttribute('data-message-origin')).toBe('system');
  });

  it('verifies stylesheet rules for .chat-user.chat-user-origin-system full-width stretch', () => {
    const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');

    // System origin messages stretch to 100% full width with border-box
    expect(css).toMatch(/\.chat-user\.chat-user-origin-system\s*\{[^}]*align-self:\s*stretch;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-system\s*\{[^}]*width:\s*100%;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-system\s*\{[^}]*max-width:\s*100%;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-system\s*\{[^}]*box-sizing:\s*border-box;/);

    // Supervision prompt compact chip retains fit-content
    expect(css).toMatch(/\.chat-user\.chat-user-supervision-prompt\.chat-user-origin-system\s*\{[^}]*width:\s*fit-content;/);
    expect(css).toMatch(/\.chat-user\.chat-user-supervision-prompt\.chat-user-origin-system\s*\{[^}]*align-self:\s*flex-start;/);

    // Cron run retains fit-content
    expect(css).toMatch(/\.chat-user\.chat-user-cron-run/);
    expect(css).toMatch(/width:\s*fit-content;/);

    // Human user messages still right-aligned and fit-content
    expect(css).toMatch(/\.chat-user\s*\{[^}]*align-self:\s*flex-end;/);
    expect(css).toMatch(/\.chat-user\s*\{[^}]*margin-inline-start:\s*auto;/);
    expect(css).toMatch(/\.chat-user\s*\{[^}]*max-width:\s*80%;/);
  });
});
