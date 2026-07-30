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
      if (key === 'chat.tool_fold_collapse') return 'collapse';
      if (key === 'chat.tool_detail_input') return 'input';
      if (key === 'chat.tool_detail_output') return 'output';
      if (key === 'chat.tool_detail_meta') return 'meta';
      if (key === 'chat.tool_detail_raw') return 'raw';
      if (key === 'chat.tool_result_done') return 'done';
      if (key === 'chat.tool_result_done_with_command') return `done · ${String(vars?.command ?? '')}`;
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
// See ChatView.test.tsx — opt this suite into the developer branch of the
// show_tool_calls preference so tool-row markup is rendered.
vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: true,
    rawValue: true,
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

    const { container } = render(<ChatView events={events} loading={false} />);

    const output = screen.getByText('/tmp/readme.md');
    const fold = container.querySelector('.chat-tool-block-fold');
    expect(output).toBeDefined();
    expect(screen.queryByText('[object Object]')).toBeNull();
    expect(fold?.classList.contains('is-collapsed')).toBe(true);
    fireEvent.click(output);
    expect(fold?.classList.contains('is-expanded')).toBe(true);
    fireEvent.click(output);
    expect(fold?.classList.contains('is-collapsed')).toBe(true);
  });

  it('shows the completed command when a standalone result has no output', () => {
    const command = '/bin/zsh -lc "ssh root@example.test docker logs app | tail -n 120"';
    const events = [
      makeEvent({
        type: 'tool.result',
        payload: {
          detail: {
            meta: {
              status: 'completed',
              exitCode: 0,
              durationMs: 564,
            },
            raw: {
              type: 'commandExecution',
              id: 'exec-command-done',
              command,
              cwd: '/tmp/project',
              processId: '50746',
            },
          },
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const header = container.querySelector('.chat-tool-result-row .chat-tool-output');
    expect(header?.textContent).toBe(`done · ${command}`);
    expect(header?.textContent).not.toBe('done');
  });

  it('formats argv commands without exposing object payloads as commands', () => {
    const renderCommand = (command: unknown): string | null | undefined => {
      const { container, unmount } = render(
        <ChatView
          events={[
            makeEvent({
              type: 'tool.result',
              payload: { detail: { raw: { command } } },
            }),
          ]}
          loading={false}
        />,
      );
      const output = container.querySelector('.chat-tool-result-row .chat-tool-output')?.textContent;
      unmount();
      return output;
    };

    expect(renderCommand(['/bin/sh', '-lc', 'echo hi && ls']))
      .toBe("done · /bin/sh -lc 'echo hi && ls'");
    expect(renderCommand({ name: 'Bash', id: 3 })).toBe('done');
    expect(renderCommand({ alpha: 1, beta: 2 })).toBe('done');
  });

  it('keeps errors and real output ahead of completed command summaries', () => {
    const events = [
      makeEvent({
        eventId: 'evt-command-error',
        type: 'tool.result',
        payload: {
          error: 'permission denied',
          detail: { raw: { command: 'SHOULD_NOT_SHOW_ERROR' } },
        },
      }),
      makeEvent({
        eventId: 'evt-command-output',
        type: 'tool.result',
        payload: {
          output: 'REAL_OUTPUT_TEXT',
          detail: { raw: { command: 'SHOULD_NOT_SHOW_OUTPUT' } },
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const outputs = Array.from(container.querySelectorAll(
      '.chat-tool-result-row .chat-tool-error, .chat-tool-result-row .chat-tool-output',
    )).map((element) => element.textContent);
    expect(outputs).toEqual(['error: permission denied', 'REAL_OUTPUT_TEXT']);
    expect(container.textContent).not.toContain('SHOULD_NOT_SHOW');
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
    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.getByText('output')).toBeDefined();
  });

  it('preserves complete commands and outputs in the one-line preview and bounded expansion', () => {
    const command = `printf '${'command-segment-'.repeat(24)}COMMAND_TAIL_9f6e'`;
    const output = `${'output-segment-'.repeat(360)}OUTPUT_TAIL_4c21`;
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:full-fidelity:call',
        type: 'tool.call',
        payload: {
          tool: 'Bash',
          input: { command },
        },
      }),
      makeEvent({
        eventId: 'transport-tool:test:full-fidelity:result',
        type: 'tool.result',
        payload: { output },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const fold = container.querySelector('.chat-tool-block-fold');
    const commandPreview = container.querySelector('.chat-tool-input');
    const outputPreview = container.querySelector('.chat-tool-output');
    const toolName = screen.getByText('Bash');

    expect(command.length).toBeGreaterThan(240);
    expect(output.length).toBeGreaterThan(4_096);
    expect(commandPreview?.textContent).toBe(` ${command}`);
    expect(outputPreview?.textContent).toBe(output);
    expect(commandPreview?.textContent).toContain('COMMAND_TAIL_9f6e');
    expect(outputPreview?.textContent).toContain('OUTPUT_TAIL_4c21');
    expect(container.textContent).not.toContain('…');

    const toggle = screen.getByRole('button', { name: 'details' });
    expect(toggle.textContent).toBe('▸');
    expect(toggle.nextElementSibling).toBe(toolName);
    expect(toggle.textContent).not.toContain('details');
    expect(fold?.classList.contains('is-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toolName);
    expect(fold?.classList.contains('is-expanded')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toolName);
    expect(fold?.classList.contains('is-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(fold?.classList.contains('is-expanded')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('collapse');
    expect(toggle.textContent).toBe('▾');
    expect(toggle.textContent).not.toContain('collapse');
    expect(container.querySelector('.chat-tool-detail')).not.toBeNull();
    const detailText = Array.from(container.querySelectorAll('.chat-tool-detail-pre'))
      .map((node) => node.textContent)
      .join('\n');
    expect(detailText).toContain(command);
    expect(detailText).toContain(output);
    expect(detailText).toContain('COMMAND_TAIL_9f6e');
    expect(detailText).toContain('OUTPUT_TAIL_4c21');
  });

  it('keeps only the first Bash command line in the sticky header', () => {
    const command = 'printf first\nprintf second\nprintf third';
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:multiline-command:call',
        type: 'tool.call',
        payload: {
          tool: 'Bash',
          input: { command },
        },
      }),
      makeEvent({
        eventId: 'transport-tool:test:multiline-command:result',
        type: 'tool.result',
        payload: { output: 'done' },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const headerInput = container.querySelector('.chat-tool-fold-header .chat-tool-input');
    const continuationInput = container.querySelector('.chat-tool-fold-continuation .chat-tool-input');

    expect(headerInput?.textContent).toBe(' printf first');
    expect(continuationInput?.textContent).toBe('printf second\nprintf third');
    expect(headerInput?.textContent).not.toContain('printf second');

    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    const detailText = Array.from(container.querySelectorAll('.chat-tool-detail-pre'))
      .map((node) => node.textContent)
      .join('\n');
    expect(detailText).toContain('printf first');
    expect(detailText).toContain('printf second');
    expect(detailText).toContain('printf third');
  });

  it('keeps only the first standalone result line in the sticky header', () => {
    const output = 'first result\nsecond result\nthird result';
    const events = [
      makeEvent({
        eventId: 'tool-result:test:multiline',
        type: 'tool.result',
        payload: { output },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const headerOutput = container.querySelector('.chat-tool-fold-header .chat-tool-output');
    const continuationOutput = container.querySelector('.chat-tool-fold-continuation .chat-tool-output');

    expect(headerOutput?.textContent).toBe('first result');
    expect(continuationOutput?.textContent).toBe('second result\nthird result');
    expect(headerOutput?.textContent).not.toContain('second result');

    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    expect(container.querySelector('.chat-tool-detail-pre')?.textContent).toBe(output);
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
    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.queryByText(/\(other\)/)).toBeNull();
  });

  it('drops the cryptic "(other)" token when a reasoning-model web search reports no query', () => {
    // Real codex payload: `web_search_end` with query:"" + action:{type:'other'}
    // on both the call and the result — the query is withheld, so there is
    // nothing to show and the row must not leak the raw "(other)" enum.
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:websearch-other:call',
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
        eventId: 'transport-tool:test:websearch-other:result',
        type: 'tool.result',
        payload: {
          detail: {
            kind: 'webSearch',
            summary: '(other)',
            input: { query: '(other)', action: { type: 'other' } },
            meta: { actionType: 'other' },
          },
        },
      }),
    ];

    render(<ChatView events={events} loading={false} />);

    expect(screen.getByText('WebSearch')).toBeDefined();
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
    for (const [handler] of onMessage.mock.calls) {
      handler({
        type: 'fs.read_response',
        requestId: 'req-win-path',
        downloadId: 'dl-win-path',
      });
    }
    await waitFor(() => {
      expect(downloadAttachment).toHaveBeenCalledWith('server-1', 'dl-win-path');
    });
  });

  it('downloads relative Chinese file paths from chat text through the current workdir', async () => {
    vi.mocked(downloadAttachment).mockClear();
    const fsReadFile = vi.fn(() => 'req-cn-ppt');
    const onMessage = vi.fn(() => vi.fn());
    const events = [
      makeEvent({
        type: 'assistant.text',
        payload: {
          text: '文件： ppt/qisi_antidrug/广西缉毒AI嗅觉方案_政企4K.pptx!',
          streaming: false,
        },
      }),
    ];

    const { container } = render(
      <ChatView
        events={events}
        loading={false}
        ws={{ fsReadFile, onMessage } as any}
        serverId="server-1"
        workdir="/repo/project"
      />,
    );

    const link = container.querySelector('.chat-path-link') as HTMLElement | null;
    const button = container.querySelector('.chat-dl-btn') as HTMLButtonElement | null;
    expect(link?.textContent).toBe('ppt/qisi_antidrug/广西缉毒AI嗅觉方案_政企4K.pptx');
    expect(link?.title).toBe('ppt/qisi_antidrug/广西缉毒AI嗅觉方案_政企4K.pptx');
    expect(container.textContent).toContain('!');
    expect(button).not.toBeNull();

    fireEvent.click(button!);

    expect(fsReadFile).toHaveBeenCalledWith('/repo/project/ppt/qisi_antidrug/广西缉毒AI嗅觉方案_政企4K.pptx');
    for (const [handler] of onMessage.mock.calls) {
      handler({
        type: 'fs.read_response',
        requestId: 'req-cn-ppt',
        downloadId: 'dl-cn-ppt',
      });
    }
    await waitFor(() => {
      expect(downloadAttachment).toHaveBeenCalledWith('server-1', 'dl-cn-ppt');
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

  it('opens user-authored public mp4 URLs as external links instead of local file previews', () => {
    const url = 'https://media.example.test/public-results/pixelle/demo-video.mp4';
    const events = [
      makeEvent({
        type: 'user.message',
        payload: {
          text: `公网链接：${url}⬇为什么被标记为内部链接了, 这不是http url吗?`,
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const externalLink = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(externalLink).not.toBeNull();
    expect(externalLink?.textContent).toBe(url);
    expect(externalLink?.href).toBe(url);
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();

    fireEvent.click(externalLink!);

    expect(screen.getByText('external_link_title')).toBeDefined();
    expect(container.querySelector('.external-link-url')?.textContent).toBe(url);
  });

  it('opens public rich mp4 URLs as external links instead of file preview paths', () => {
    const url = 'https://media.example.test/public-results/pixelle/demo-video-rich.mp4';
    const events = [
      makeEvent({
        type: 'user.message',
        payload: { text: url },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);

    const externalLink = container.querySelector('.chat-external-link') as HTMLAnchorElement | null;
    expect(externalLink).not.toBeNull();
    expect(externalLink?.textContent).toBe(url);
    expect(externalLink?.href).toBe(url);
    expect(container.querySelector('.chat-path-link')).toBeNull();
    expect(container.querySelector('.chat-dl-btn')).toBeNull();

    fireEvent.click(externalLink!);

    expect(screen.getByText('external_link_title')).toBeDefined();
    expect(container.querySelector('.external-link-url')?.textContent).toBe(url);
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

    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    expect(screen.getByText('input')).toBeDefined();
    expect(screen.getByText('output')).toBeDefined();
    expect(screen.getAllByText(/delivered/).length).toBeGreaterThan(0);
  });
});
