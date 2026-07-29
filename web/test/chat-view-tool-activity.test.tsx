/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.tool_activity_label') return 'Tools';
      if (key === 'chat.tool_activity_summary') {
        return `${vars?.total} tools: ${vars?.completed} completed, ${vars?.running} running, ${vars?.failed} failed`;
      }
      if (key === 'chat.tool_activity_expand') return 'Expand tool details';
      if (key === 'chat.tool_activity_collapse') return 'Collapse tool details';
      return key.split('.').pop() ?? key;
    },
  }),
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false,
    rawValue: false,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { ChatView } from '../src/components/ChatView.js';
import type { TimelineEvent } from '../src/ws-client.js';

function makeEvent(
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
  seq: number,
): TimelineEvent {
  return {
    eventId,
    sessionId: 'tool-activity-test',
    ts: 1_000 + seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  } as TimelineEvent;
}

describe('ChatView compact tool activity', () => {
  afterEach(() => cleanup());

  it('shows live aggregate counts and expands exact tool details on demand', () => {
    const readCall = makeEvent('read-call', 'tool.call', {
      tool: 'Read',
      input: { file_path: 'README.md' },
    }, 1);
    const readResult = makeEvent('read-result', 'tool.result', {
      output: 'contents',
    }, 2);
    const assistantProgress = makeEvent('assistant-progress', 'assistant.text', {
      text: 'Checking the result before continuing.',
    }, 3);
    const bashCall = makeEvent('bash-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'npm test' },
    }, 4);

    const { container, rerender } = render(
      <ChatView events={[readCall, readResult, assistantProgress, bashCall]} loading={false} />,
    );

    expect(container.querySelectorAll('.chat-tool-activity')).toHaveLength(1);
    const activity = container.querySelector('.chat-tool-activity') as HTMLButtonElement | null;
    expect(activity).not.toBeNull();
    expect(activity?.getAttribute('aria-expanded')).toBe('false');
    expect(activity?.getAttribute('aria-label')).toContain('2 tools: 1 completed, 1 running, 0 failed');
    expect(container.querySelector('.chat-tool-activity-total')?.textContent).toBe('2');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓1');
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
    expect(container.querySelectorAll('.chat-tool-activity-segment')).toHaveLength(2);
    expect(container.querySelector('.chat-tool')).toBeNull();

    fireEvent.click(activity!);

    expect(activity?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.chat-tool-activity-details')).not.toBeNull();
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('Bash');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('npm test');

    const bashResult = makeEvent('bash-result', 'tool.result', {
      output: 'passed',
    }, 5);
    rerender(<ChatView events={[readCall, readResult, assistantProgress, bashCall, bashResult]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-total')?.textContent).toBe('2');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓2');
    expect(container.querySelector('.chat-tool-activity-stat.is-running')).toBeNull();
    expect(container.querySelectorAll('.chat-tool-activity-segment')).toHaveLength(1);
  });

  it('keeps failed tools visible in the compact rail', () => {
    const call = makeEvent('failed-call', 'tool.call', {
      tool: 'Write',
      input: { file_path: 'locked.txt' },
    }, 1);
    const result = makeEvent('failed-result', 'tool.result', {
      error: 'permission denied',
    }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    const activity = container.querySelector('.chat-tool-activity');
    expect(activity?.classList.contains('has-error')).toBe(true);
    expect(activity?.getAttribute('aria-label')).toContain('1 tools: 0 completed, 0 running, 1 failed');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓0');
    expect(container.querySelector('.chat-tool-activity-stat.is-failed')?.textContent).toBe('×1');
    expect(container.querySelector('.chat-tool-activity-segment.is-failed')).not.toBeNull();
    expect(container.querySelector('.chat-tool')).toBeNull();
  });
});
