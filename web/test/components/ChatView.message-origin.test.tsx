/**
 * @vitest-environment jsdom
 *
 * Only the human's own input is right-aligned. Agent-to-agent deliveries and
 * every daemon injection (supervision, task pairs, heartbeat, cron, P2P,
 * OpenSpec) are `user.message` events too, but they are incoming messages and
 * sit on the left, in main sessions and sub-sessions alike.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { AGENT_DELEGATION_SENDER_MARKER } from '../../../shared/agent-delegation.js';
import { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } from '../../../shared/chat-message-origin.js';
import { CRON_CONTROL_PROTOCOL } from '../../../shared/cron-types.js';
import { TASK_PAIR_AUTOMATION_KIND } from '../../../shared/task-pair.js';
import { SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND } from '../../../shared/supervision-config.js';

let seq = 0;
function userMessage(sessionId: string, payload: Record<string, unknown>): TimelineEvent {
  seq += 1;
  return {
    eventId: `evt-${seq}`,
    sessionId,
    ts: 1_700_000_000_000 + seq * 1000,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'user.message',
    payload,
  } as TimelineEvent;
}

const agentDelivery = (text: string) =>
  `${AGENT_DELEGATION_SENDER_MARKER}\nMessage from IM.codes session: deck_sub_0g0i8s4f (label: Cx2)\n\n${text}`;

function originOf(container: HTMLElement, text: string): string | null {
  const bubble = [...container.querySelectorAll<HTMLElement>('.chat-user')]
    .find((node) => (node.textContent ?? '').includes(text));
  if (!bubble) throw new Error(`no bubble for ${text}`);
  return bubble.getAttribute('data-message-origin');
}

afterEach(() => cleanup());

describe('ChatView user.message alignment by origin', () => {
  for (const sessionId of ['deck_origin_brain', 'deck_sub_origin1']) {
    it(`puts only the human's input on the right (${sessionId})`, () => {
      const events = [
        userMessage(sessionId, { text: 'typed on the web', commandId: 'cmd_web' }),
        userMessage(sessionId, { text: 'spoken on the phone', commandId: 'cmd_voice' }),
        userMessage(sessionId, { text: agentDelivery('收到，本次复审已结束。') }),
        userMessage(sessionId, { text: 'pair nudge', automation: true, automationKind: TASK_PAIR_AUTOMATION_KIND }),
        userMessage(sessionId, { text: 'still waiting', automation: true, automationKind: SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND }),
        userMessage(sessionId, { text: `${CRON_CONTROL_PROTOCOL.OPEN_TAG}id="c1">nightly report</imcodes-cron-control>` }),
        userMessage(sessionId, { text: 'p2p round prompt', p2pRunId: 'run_1' }),
        userMessage(sessionId, { text: 'openspec apply prompt', commandId: 'cmd_os', [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM }),
      ];
      const { container } = render(
        <ChatView events={events} loading={false} hasOlderHistory={false} sessionId={sessionId} />,
      );

      expect(originOf(container, 'typed on the web')).toBe(CHAT_MESSAGE_ORIGINS.USER);
      expect(originOf(container, 'spoken on the phone')).toBe(CHAT_MESSAGE_ORIGINS.USER);
      expect(originOf(container, '收到，本次复审已结束。')).toBe(CHAT_MESSAGE_ORIGINS.AGENT);
      expect(originOf(container, 'nightly report')).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
      expect(originOf(container, 'p2p round prompt')).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);
      expect(originOf(container, 'openspec apply prompt')).toBe(CHAT_MESSAGE_ORIGINS.SYSTEM);

      const bubbles = [...container.querySelectorAll<HTMLElement>('.chat-user')];
      // Every rendered user.message row carries its origin class; supervision-kind
      // automation renders as the compact prompt row, still tagged system.
      expect(bubbles).toHaveLength(events.length);
      const byOrigin = (origin: string) => bubbles.filter((node) => node.classList.contains(`chat-user-origin-${origin}`)).length;
      expect(byOrigin(CHAT_MESSAGE_ORIGINS.USER)).toBe(2);
      expect(byOrigin(CHAT_MESSAGE_ORIGINS.AGENT)).toBe(1);
      expect(byOrigin(CHAT_MESSAGE_ORIGINS.SYSTEM)).toBe(5);
    });
  }

  it('right-aligns only the user origin in the stylesheet', () => {
    const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.chat-user \{[^}]*align-self: flex-end;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-agent,\s*\.chat-user\.chat-user-origin-system \{[^}]*align-self: flex-start;/);
  });
});
