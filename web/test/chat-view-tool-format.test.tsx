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
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.tool_group_more') return `${String(vars?.count ?? '')} more`;
      return key.split('.').pop() ?? key;
    },
  }),
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

import { ChatView } from '../src/components/ChatView.js';
import type { TimelineEvent } from '../src/ws-client.js';

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

describe('ChatView tool payload formatting', () => {
  afterEach(() => cleanup());

  it('renders summarized tool input instead of [object Object] for merged tool rows', () => {
    const events = [
      makeEvent({
        type: 'tool.call',
        payload: { tool: 'web_search', input: { query: 'Qwen code release date' } },
      }),
      makeEvent({
        type: 'tool.result',
        payload: {},
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText(/Qwen code release date/)).toBeDefined();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });

  it('renders summarized standalone tool result output objects', () => {
    const events = [
      makeEvent({
        type: 'tool.result',
        payload: { output: { path: '/tmp/readme.md' } },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('/tmp/readme.md')).toBeDefined();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });
});
