/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.tool_group_more') return `${String(vars?.count ?? '')} more`;
      if (key === 'chat.tool_detail_toggle') return 'details';
      if (key === 'chat.tool_detail_input') return 'input';
      if (key === 'chat.tool_detail_output') return 'output';
      if (key === 'chat.tool_detail_meta') return 'meta';
      if (key === 'chat.tool_detail_raw') return 'raw';
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

  it('hides meaningless empty object tool inputs', () => {
    const events = [
      makeEvent({
        type: 'tool.call',
        payload: { tool: 'web_search', input: {} },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('web_search')).toBeDefined();
    expect(screen.queryByText('{}')).toBeNull();
  });

  it('renders transport Codex tool calls alongside streaming assistant text', () => {
    const events = [
      makeEvent({
        eventId: 'transport:test:msg-1',
        type: 'assistant.text',
        payload: { text: 'Running `pwd`', streaming: true },
      }),
      makeEvent({
        eventId: 'transport-tool:test:call-1:call',
        type: 'tool.call',
        payload: { tool: 'Bash', input: { command: '/usr/bin/bash -lc pwd' } },
      }),
      makeEvent({
        eventId: 'transport-tool:test:call-1:result',
        type: 'tool.result',
        payload: { output: '/tmp/project\n' },
      }),
      makeEvent({
        eventId: 'transport:test:msg-2',
        type: 'assistant.text',
        payload: { text: '/tmp/project', streaming: false },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText(/\/usr\/bin\/bash -lc pwd/)).toBeDefined();
    expect(screen.getAllByText('/tmp/project').length).toBeGreaterThan(0);
  });

  it('renders Claude-style merged tool rows when tool.call is followed by tool.result', () => {
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:read-1:call',
        type: 'tool.call',
        payload: { tool: 'Read', input: { file_path: 'package.json' }, detail: { kind: 'tool_use', input: { file_path: 'package.json' }, raw: { file_path: 'package.json' } } },
      }),
      makeEvent({
        eventId: 'transport-tool:test:read-1:result',
        type: 'tool.result',
        payload: { detail: { kind: 'tool_result', output: { ok: true } } },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getAllByText(/package\.json/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('details'));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.getByText('output')).toBeDefined();
  });
});
