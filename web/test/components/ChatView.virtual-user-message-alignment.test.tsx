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

    // Unified 95% max-width and distinct pale-blue styling for human user bubble
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s*\{[^}]*max-width:\s*95%;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s*\{[^}]*border-right:\s*2px solid rgba\(125,\s*211,\s*252/);

    // Pending / failed states and restored 10-line unified fold height for human user bubble
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\.chat-pending\s*\{/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\.chat-failed\s*\{/);
    expect(css).toMatch(/\.chat-user-message-fold-content\.is-folded[\s\S]*?max-height:\s*calc\(1\.45em \* 10\);/);
    expect(css).not.toMatch(/calc\(1\.45em \* 22\)/);

    // Integrated image caption, left/right split layout, compact thumbnail heights, and attachments wrap
    expect(css).toMatch(/\.chat-path-actions-badge\s*\{[^}]*display:\s*inline-flex;/);
    expect(css).toMatch(/@media\s*\(min-width:\s*720px\)\s*\{[^}]*\.chat-user\.chat-user-origin-user\s+\.chat-user-message-fold\.has-split-layout\s+\.chat-user-split-layout\s*\{[^}]*flex-direction:\s*row;/);
    expect(css).toMatch(/\.chat-user-attachments\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s+\.chat-local-image-preview\s*\{[^}]*display:\s*inline-flex;[^}]*max-width:\s*min\(260px,\s*100%\);/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s+\.chat-user-message-fold\.has-multi-images\s+\.chat-local-image-preview\s*\{[^}]*max-width:\s*min\(210px,\s*100%\);/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s+\.chat-local-image-preview-img\s*\{[^}]*max-height:\s*150px;/);
    expect(css).toMatch(/\.chat-user\.chat-user-origin-user\s+\.chat-user-message-fold\.has-multi-images\s+\.chat-local-image-preview-img\s*\{[^}]*max-height:\s*112px;/);
    expect(css).toMatch(/\.chat-local-image-preview-caption\s*\{[^}]*display:\s*flex;/);
  });

  it('renders image badges inside preview captions without duplicating in prose, omits empty text pane on image-only messages, and folds at 10 lines', async () => {
    const { fireEvent } = await import('@testing-library/preact');
    const ws = {
      fsReadFile: vi.fn(() => 'read-image-preview'),
      onMessage: vi.fn(() => () => undefined),
    };
    const onPreviewFile = vi.fn();
    const events = [
      makeMessage({ text: '单图消息 #1:(/Users/k/.imcodes/uploads/ff26735e930883fe84068ff9424c80aa/one.png)' }),
      makeMessage({
        text: '多图平铺 #1:(/Users/k/.imcodes/uploads/a/one.png) #2:(/Users/k/.imcodes/uploads/b/two.jpg) 附带 /Users/k/docs/spec.pdf',
        attachments: [{ id: 'att-1', originalName: 'spec.txt', mime: 'text/plain', size: 120 }],
      }),
      makeMessage({ text: '#1:(/Users/k/.imcodes/uploads/a/only1.png) #2:(/Users/k/.imcodes/uploads/b/only2.png)' }),
      makeMessage({
        text: `#1:(/Users/k/.imcodes/uploads/a/shot.png)\n${Array.from({ length: 14 }, (_, i) => `line-${i + 1}`).join('\n')}`,
      }),
      makeMessage({
        text: `#1:(/Users/k/.imcodes/uploads/a/short.png)\nline-1\nline-2`,
      }),
      makeMessage({ text: agentDelivery('Agent msg /tmp/a.png /tmp/b.png') }, { source: 'daemon' }),
      makeMessage({ text: 'System notice /tmp/sys/audit.log', messageOrigin: 'system' }, { source: 'daemon' }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        hasOlderHistory={false}
        sessionId="s_images"
        serverId="srv-1"
        ws={ws as any}
        onPreviewFile={onPreviewFile}
      />,
    );

    const userBubbles = container.querySelectorAll('.chat-user.chat-user-origin-user');
    expect(userBubbles).toHaveLength(5);

    // 1. Single image + text: #1 badge lives inside image caption (NOT duplicated in text pane), split layout inside fold content
    const singleBubble = userBubbles[0];
    const singleFold = singleBubble.querySelector('.chat-user-message-fold');
    expect(singleFold?.classList.contains('has-images')).toBe(true);
    expect(singleFold?.classList.contains('has-multi-images')).toBe(false);
    expect(singleFold?.classList.contains('has-split-layout')).toBe(true);
    expect(singleFold?.querySelector('.chat-user-message-fold-content > .chat-user-split-layout')).toBeTruthy();
    expect(singleBubble.querySelectorAll('.chat-user-media-pane .chat-local-image-preview')).toHaveLength(1);
    expect(singleBubble.querySelector('.chat-user-text-pane .chat-path-actions-badge')).toBeNull();
    const singleCaptionBadge = singleBubble.querySelector('.chat-local-image-preview-caption .chat-path-actions-badge');
    expect(singleCaptionBadge).toBeTruthy();
    expect(singleCaptionBadge?.querySelector('.chat-path-badge-index')?.textContent).toBe('#1');
    const singleLink = singleCaptionBadge?.querySelector('.chat-path-link') as HTMLElement | null;
    expect(singleLink?.textContent).toBe('one.png');
    expect(singleLink?.getAttribute('title')).toBe('/Users/k/.imcodes/uploads/ff26735e930883fe84068ff9424c80aa/one.png');
    expect(singleBubble.textContent).not.toContain('ff26735e930883fe84068ff9424c80aa');
    fireEvent.click(singleLink!);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: '/Users/k/.imcodes/uploads/ff26735e930883fe84068ff9424c80aa/one.png',
    }));

    // 2. Multi-image + non-image path + attachments: image badges only in captions, non-image badge only in text pane
    const multiBubble = userBubbles[1];
    const multiFold = multiBubble.querySelector('.chat-user-message-fold');
    expect(multiFold?.classList.contains('has-images')).toBe(true);
    expect(multiFold?.classList.contains('has-multi-images')).toBe(true);
    expect(multiFold?.classList.contains('has-split-layout')).toBe(true);
    expect(multiBubble.querySelectorAll('.chat-user-media-pane .chat-local-image-preview')).toHaveLength(2);
    expect(multiBubble.querySelector('.chat-user-attachments')).toBeTruthy();
    expect(Array.from(multiBubble.querySelectorAll('.chat-local-image-preview-caption .chat-path-link')).map((el) => el.textContent)).toEqual(['one.png', 'two.jpg']);
    expect(Array.from(multiBubble.querySelectorAll('.chat-user-text-pane .chat-path-link')).map((el) => el.textContent)).toEqual(['spec.pdf']);
    expect(multiBubble.textContent).not.toContain('/Users/k/docs/');

    // 3. Images-only message: omits empty .chat-user-text-pane and keeps badges in image captions
    const imagesOnlyFold = userBubbles[2].querySelector('.chat-user-message-fold');
    expect(imagesOnlyFold?.classList.contains('has-images')).toBe(true);
    expect(imagesOnlyFold?.classList.contains('has-multi-images')).toBe(true);
    expect(imagesOnlyFold?.classList.contains('has-split-layout')).toBe(false);
    expect(userBubbles[2].querySelector('.chat-user-text-pane')).toBeNull();
    expect(userBubbles[2].querySelectorAll('.chat-user-media-pane .chat-local-image-preview')).toHaveLength(2);
    expect(Array.from(userBubbles[2].querySelectorAll('.chat-local-image-preview-caption .chat-path-link')).map((el) => el.textContent)).toEqual(['only1.png', 'only2.png']);

    // 4. Unified 10-line fold threshold: 14 lines with image folds cleanly, short 3-line message stays unfolded
    const fourteenLinesFold = userBubbles[3].querySelector('.chat-user-message-fold');
    expect(fourteenLinesFold?.classList.contains('is-foldable')).toBe(true);
    expect(fourteenLinesFold?.classList.contains('is-folded')).toBe(true);
    const shortLinesFold = userBubbles[4].querySelector('.chat-user-message-fold');
    expect(shortLinesFold?.classList.contains('is-foldable')).toBe(false);

    // 5. Incoming agent & system bubbles remain untouched (no basename badge collapse)
    const agentBubble = container.querySelector('.chat-user.chat-user-origin-agent');
    expect(agentBubble).toBeTruthy();
    expect(agentBubble?.querySelector('.chat-path-actions-badge')).toBeNull();
    expect(agentBubble?.textContent).toContain('/tmp/a.png');

    const systemBubble = container.querySelector('.chat-user.chat-user-origin-system');
    expect(systemBubble).toBeTruthy();
    expect(systemBubble?.querySelector('.chat-path-actions-badge')).toBeNull();
    expect(systemBubble?.textContent).toContain('/tmp/sys/audit.log');
  });
});
