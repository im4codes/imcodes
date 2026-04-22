/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';

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

vi.mock('../src/api.js', () => ({
  downloadAttachment: vi.fn().mockResolvedValue(undefined),
}));

import { ChatView } from '../src/components/ChatView.js';
import type { TimelineEvent } from '../src/ws-client.js';
import { downloadAttachment } from '../src/api.js';

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

  it('prefers the completed WebSearch query over a generic started-state fallback label', () => {
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:websearch-late:call',
        type: 'tool.call',
        payload: {
          tool: 'WebSearch',
          input: { query: '(other)' },
          detail: {
            kind: 'webSearch',
            summary: '(other)',
            input: { query: '(other)', action: { type: 'other' } },
            meta: { actionType: 'other' },
          },
        },
      }),
      makeEvent({
        eventId: 'transport-tool:test:websearch-late:result',
        type: 'tool.result',
        payload: {
          detail: {
            kind: 'webSearch',
            summary: 'apple stock today',
            input: { query: 'apple stock today', action: { type: 'search', query: 'apple stock today' } },
            meta: { actionType: 'search' },
          },
        },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('WebSearch')).toBeDefined();
    expect(screen.getAllByText(/apple stock today/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('details'));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.queryByText(/\(other\)/)).toBeNull();
  });

  it('shows a single timestamp on the final merged tool row', () => {
    const events = [
      makeEvent({
        eventId: 'tool-group-call',
        type: 'tool.call',
        ts: 1_000,
        payload: { tool: 'Read', input: { file_path: 'README.md' } },
      }),
      makeEvent({
        eventId: 'tool-group-result',
        type: 'tool.result',
        ts: 2_000,
        payload: { output: { path: '/tmp/README.md' } },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    expect(container.querySelectorAll('.chat-tool .chat-bubble-time')).toHaveLength(1);
  });

  it('renders tool-call summary from detail.input when live payload.input is missing', () => {
    const events = [
      makeEvent({
        type: 'tool.call',
        payload: {
          tool: 'Read',
          detail: {
            kind: 'tool_use',
            input: { file_path: 'src/app.tsx' },
            raw: { file_path: 'src/app.tsx' },
          },
        },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('Read')).toBeDefined();
    const summary = document.querySelector('.chat-tool-input');
    expect(summary?.textContent).toContain('src/app.tsx');
  });

  it('renders merged tool-call summary from detail.raw.args when payload.input is missing', () => {
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:oc-arg-only:call',
        type: 'tool.call',
        payload: {
          tool: 'sessions_send',
          detail: {
            kind: 'openclaw.tool',
            raw: {
              phase: 'start',
              name: 'sessions_send',
              toolCallId: 'oc-arg-only',
              args: { sessionKey: 'agent:emma:main', message: 'hello from arg fallback' },
            },
          },
        },
      }),
      makeEvent({
        eventId: 'transport-tool:test:oc-arg-only:result',
        type: 'tool.result',
        payload: {
          detail: {
            kind: 'openclaw.tool',
            output: { delivered: true },
          },
        },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('sessions_send')).toBeDefined();
    const summary = document.querySelector('.chat-tool-input');
    expect(summary?.textContent).toContain('agent:emma:main');
    expect(summary?.textContent).toContain('hello from arg fallback');
  });

  it('connects Windows file paths in tool output to preview and download', async () => {
    const fsReadFile = vi.fn(() => 'req-win-path');
    const onMessage = vi.fn(() => vi.fn());
    const events = [
      makeEvent({
        type: 'tool.result',
        payload: { output: { path: 'C:\\Users\\admin\\screenshot.png' } },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{ fsReadFile, onMessage } as any}
        serverId="server-1"
      />,
    );

    const link = container.querySelector('.chat-path-link') as HTMLElement | null;
    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(link?.textContent).toBe('C:\\Users\\admin\\screenshot.png');
    expect(button).not.toBeNull();

    fireEvent.click(button!);

    expect(fsReadFile).toHaveBeenCalledWith('C:\\Users\\admin\\screenshot.png');
    onMessage.mock.calls[0][0]({
      type: 'fs.read_response',
      requestId: 'req-win-path',
      downloadId: 'dl-win-path',
    });
    await waitFor(() => {
      expect(downloadAttachment).toHaveBeenCalledWith('server-1', 'dl-win-path');
    });
  });

  it('keeps adjacent Chinese-punctuated URLs as external links instead of file paths', () => {
    const events = [
      makeEvent({
        type: 'assistant.text',
        payload: {
          text: 'https://blog.csdn.net/2502_91125447/article/details/146912737（CSDN博客 - PCDN市场深水区）https://m.c114.com.cn/w16-1296322.html⬇（C114 - PCDN即将成为历史）',
          streaming: false,
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const externalLinks = Array.from(container.querySelectorAll('.chat-external-link')) as HTMLAnchorElement[];
    expect(externalLinks.map((el) => el.textContent)).toEqual([
      'https://blog.csdn.net/2502_91125447/article/details/146912737',
      'https://m.c114.com.cn/w16-1296322.html',
    ]);
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();
  });

  it('renders OpenClaw transport tool rows for realistic sessions_send payloads', () => {
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:oc-1:call',
        type: 'tool.call',
        payload: {
          tool: 'sessions_send',
          input: { sessionKey: 'agent:emma:main', message: 'hello from openclaw' },
          detail: {
            kind: 'openclaw.tool',
            summary: 'sessions_send',
            input: { sessionKey: 'agent:emma:main', message: 'hello from openclaw' },
            raw: {
              phase: 'start',
              name: 'sessions_send',
              toolCallId: 'oc-1',
              args: { sessionKey: 'agent:emma:main', message: 'hello from openclaw' },
            },
          },
        },
      }),
      makeEvent({
        eventId: 'transport-tool:test:oc-1:result',
        type: 'tool.result',
        payload: {
          output: JSON.stringify({ delivered: true, target: 'agent:emma:main' }),
          detail: {
            kind: 'openclaw.tool',
            output: { delivered: true, target: 'agent:emma:main' },
            meta: { durationMs: 42 },
          },
        },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('sessions_send')).toBeDefined();
    expect(screen.getAllByText(/agent:emma:main/).length).toBeGreaterThan(0);
    expect(screen.queryByText('[object Object]')).toBeNull();

    fireEvent.click(screen.getByText('details'));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.getByText('output')).toBeDefined();
    expect(screen.getAllByText(/delivered/).length).toBeGreaterThan(0);
  });
});
