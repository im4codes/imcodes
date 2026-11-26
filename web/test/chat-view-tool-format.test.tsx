/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';

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
import {
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  getDownloadTransfers,
} from '../src/download-transfer-store.js';

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

  it.each(['tool.call', 'tool.result'])('keeps large %s payloads out of the collapsed DOM and reveals them on demand', (type) => {
    const tail = 'FULL_PAYLOAD_TAIL_7246';
    const text = 'x'.repeat(300_000) + tail;
    const event = makeEvent({ type, payload: type === 'tool.call'
      ? { tool: 'Bash', input: { command: text } }
      : { output: { content: text, ok: true } } });
    const { container, rerender } = render(<ChatView events={[event]} loading={false} />);
    const fold = container.querySelector('.chat-tool-block-fold')!;
    expect(fold.textContent!.length).toBeLessThan(4096);
    expect(fold.textContent).not.toContain(tail);
    expect(fold.querySelector('.chat-tool-detail')).toBeNull();
    fireEvent.click(fold.querySelector('.chat-tool-block-toggle')!);
    expect(fold.textContent).toContain(tail);
    // Hydration/retries can replace a payload under the same ID while open.
    const updated = { ...event, payload: type === 'tool.call'
      ? { tool: 'Bash', input: { command: text + '-updated' } }
      : { output: { content: text + '-updated', ok: true } } };
    rerender(<ChatView events={[updated]} loading={false} />);
    expect(fold.textContent).toContain(tail + '-updated');
    fireEvent.click(fold.querySelector('.chat-tool-block-toggle')!);
    expect(fold.textContent!.length).toBeLessThan(4096);
    expect(fold.textContent).not.toContain(tail);
    expect(event.payload).toEqual(type === 'tool.call'
      ? { tool: 'Bash', input: { command: text } }
      : { output: { content: text, ok: true } });
  });

  it('bounds multiline merged outputs and errors without discarding their original content', () => {
    const tail = 'RESULT_ERROR_TAIL_6382';
    const output = 'row\n'.repeat(60_000) + tail;
    const call = makeEvent({ type: 'tool.call', payload: { tool: 'Bash', toolCallId: 'large' } });
    const result = makeEvent({ type: 'tool.result', payload: { toolCallId: 'large', output } });
    const { container, rerender } = render(<ChatView events={[call, result]} loading={false} />);
    let fold = container.querySelector('.chat-tool-block-fold')!;
    expect(fold.textContent!.length).toBeLessThan(4096);
    expect(fold.textContent).not.toContain(tail);
    fireEvent.click(fold.querySelector('.chat-tool-block-toggle')!);
    expect(fold.textContent).toContain(output);
    rerender(<ChatView events={[makeEvent({ type: 'tool.result', payload: { error: output } })]} loading={false} />);
    fold = container.querySelector('.chat-tool-block-fold')!;
    expect(fold.textContent!.length).toBeLessThan(4096);
    fireEvent.click(fold.querySelector('.chat-tool-block-toggle')!);
    expect(fold.textContent).toContain(tail);
    expect(fold.querySelector('.chat-tool-fold-continuation')?.textContent).toBe(output.slice(output.indexOf('\n') + 1));
  });

  it('bounds collapsed output previews and preserves complete commands and outputs on expansion', () => {
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
    expect(outputPreview?.textContent!.length).toBeLessThan(4096);
    expect(commandPreview?.textContent).toContain('COMMAND_TAIL_9f6e');
    expect(outputPreview?.textContent).not.toContain('OUTPUT_TAIL_4c21');
    expect(outputPreview?.textContent).toContain('…');

    const toggle = screen.getByRole('button', { name: 'details' });
    expect(toggle.textContent).toBe('▸');
    expect(toggle.nextElementSibling).toBe(toolName);
    expect(toggle.textContent).not.toContain('details');
    expect(fold?.classList.contains('is-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toolName);
    expect(fold?.classList.contains('is-expanded')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.chat-tool-output')?.textContent).toBe(output);
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

  it('offers a second collapse control at the bottom of an expanded tool call', () => {
    const events = [
      makeEvent({
        eventId: 'transport-tool:test:bottom-collapse:call',
        type: 'tool.call',
        payload: {
          tool: 'Bash',
          input: { command: 'printf bottom-collapse' },
          _merged: true,
          _output: 'line\n'.repeat(120),
        },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const fold = container.querySelector('.chat-tool-block-fold');

    fireEvent.click(screen.getByRole('button', { name: 'details' }));

    const footerButton = container.querySelector<HTMLButtonElement>(
      '.chat-tool-fold-footer .chat-tool-fold-collapse',
    );
    expect(fold?.classList.contains('is-expanded')).toBe(true);
    expect(screen.getAllByRole('button', { name: 'collapse' })).toHaveLength(2);
    expect(footerButton?.textContent).toContain('collapse');
    expect(footerButton?.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(footerButton!);

    expect(fold?.classList.contains('is-collapsed')).toBe(true);
    expect(container.querySelector('.chat-tool-fold-footer')).toBeNull();
    expect(screen.getByRole('button', { name: 'details' })).toBeDefined();
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

    // An image path is also read by the inline preview, so count the reads the
    // click adds rather than matching an earlier call with the same path.
    const readsBeforeClick = fsReadFile.mock.calls.length;
    fireEvent.click(button!);

    // The save dialog opens first (it needs the click), so the handle request
    // follows a tick later rather than synchronously.
    await waitFor(() => expect(fsReadFile).toHaveBeenCalledTimes(readsBeforeClick + 1));
    // The daemon now resolves chat-referenced paths itself (candidate roots,
    // real stat verification), so the client sends the exact bytes the click
    // target carried instead of pre-resolving them.
    expect(fsReadFile).toHaveBeenLastCalledWith('C:\\Users\\admin\\screenshot.png', undefined, { chatFileReference: true });
    for (const [handler] of onMessage.mock.calls) {
      handler({
        type: 'fs.read_response',
        requestId: 'req-win-path',
        downloadId: 'dl-win-path',
      });
    }
    await waitFor(() => {
      // No save picker in this browser: the HTTP download is the fallback, now
      // cancellable from the download center.
      expect(downloadAttachment).toHaveBeenCalledWith('server-1', 'dl-win-path', undefined, expect.any(AbortSignal));
    });
  });

  it('downloads relative Chinese file paths from chat text through the current workdir', async () => {
    vi.mocked(downloadAttachment).mockClear();
    __resetDownloadTransfersForTests();
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

    // An image path is also read by the inline preview, so count the reads the
    // click adds rather than matching an earlier call with the same path.
    const readsBeforeClick = fsReadFile.mock.calls.length;
    fireEvent.click(button!);

    // The save dialog opens first (it needs the click), so the handle request
    // follows a tick later rather than synchronously.
    await waitFor(() => expect(fsReadFile).toHaveBeenCalledTimes(readsBeforeClick + 1));
    // The daemon now resolves the relative reference itself against the
    // session's candidate roots (cwd/worktree/project/home) instead of the
    // client pre-joining it with `workdir`, so the raw relative bytes are
    // what's sent -- matching acceptance item 3 (relative-path resolution).
    expect(fsReadFile).toHaveBeenLastCalledWith(
      'ppt/qisi_antidrug/广西缉毒AI嗅觉方案_政企4K.pptx', undefined, { chatFileReference: true },
    );
    for (const [handler] of onMessage.mock.calls) {
      handler({
        type: 'fs.read_response',
        requestId: 'req-cn-ppt',
        downloadId: 'dl-cn-ppt',
      });
    }
    await waitFor(() => {
      // No save picker in this browser: the HTTP download is the fallback, now
      // cancellable from the download center.
      expect(downloadAttachment).toHaveBeenCalledWith('server-1', 'dl-cn-ppt', undefined, expect.any(AbortSignal));
    });
    // A chat download now shows up in the download center like the file
    // browser's, which is where its Show in folder button lives.
    // Without a save picker this browser hands the file to its own download
    // manager, so the row settles as handed off.
    await waitFor(() => {
      expect(getDownloadTransfers()).toEqual([expect.objectContaining({
        name: '广西缉毒AI嗅觉方案_政企4K.pptx',
        status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      })]);
    });
    __resetDownloadTransfersForTests();
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

  it('shows running state, start time, and live elapsed duration for in-flight tool.call rows and swaps to completion duration on merge', async () => {
    vi.useFakeTimers();
    try {
      const startTs = 1_700_000_000_000;
      vi.setSystemTime(startTs + 2_300);
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const runningCall = makeEvent({
        eventId: 'tool-live:1:call',
        type: 'tool.call',
        ts: startTs,
        payload: { tool: 'schedule', toolCallId: 'live-1', input: { DurationSeconds: 420 } },
      });
      const { container, rerender, unmount } = render(<ChatView events={[runningCall]} loading={false} />);

      const state = container.querySelector('.chat-tool-meta .chat-tool-state.is-running');
      expect(state).not.toBeNull();
      expect(container.querySelector('.chat-tool-meta .chat-bubble-time')).not.toBeNull();
      expect(container.querySelector('.chat-tool-meta .chat-tool-duration')?.textContent).toBe('2.3s');
      expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 1000)).toBe(true);

      // Advance 2s while running — elapsed duration updates live.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(container.querySelector('.chat-tool-meta .chat-tool-duration')?.textContent).toBe('4.3s');

      // Complete with _resultTs — switches to ✓, exact duration, and clears the ticker.
      const completedResult = makeEvent({
        eventId: 'tool-live:1:result',
        type: 'tool.result',
        ts: startTs + 12_000,
        payload: { toolCallId: 'live-1', output: 'scheduled ok' },
      });
      rerender(<ChatView events={[runningCall, completedResult]} loading={false} />);
      expect(container.querySelector('.chat-tool-meta .chat-tool-state.is-complete')?.textContent).toBe('✓');
      expect(container.querySelector('.chat-tool-meta .chat-tool-duration')?.textContent).toBe('12s');
      expect(container.querySelector('.chat-tool-result-preview')?.textContent).toContain('scheduled ok');
      expect(clearIntervalSpy).toHaveBeenCalled();

      unmount();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('creates zero interval timers for 100+ historical completed tool calls', () => {
    vi.useFakeTimers();
    try {
      const baseTs = 1_700_000_000_000;
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const events: TimelineEvent[] = [];
      for (let i = 0; i < 110; i++) {
        events.push(
          makeEvent({
            eventId: `hist:${i}:call`,
            type: 'tool.call',
            ts: baseTs + i * 2_000,
            payload: { tool: 'Read', toolCallId: `hist-${i}`, input: { file_path: `file-${i}.ts` } },
          }),
          makeEvent({
            eventId: `hist:${i}:result`,
            type: 'tool.result',
            ts: baseTs + i * 2_000 + 500,
            payload: { toolCallId: `hist-${i}`, output: `ok-${i}` },
          }),
        );
      }

      const { container } = render(<ChatView events={events} loading={false} />);
      const tickerCalls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000);
      expect(tickerCalls).toHaveLength(0);
      expect(container.querySelectorAll('.chat-tool-meta .chat-tool-state.is-complete').length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('surfaces detail.output and bounded error summaries outside the collapsed fold without expanding', () => {
    const startTs = 1_700_000_000_000;
    const hugeError = `exit 1: ${'err-part-'.repeat(60_000)}ERROR_TAIL_9911`;
    const events: TimelineEvent[] = [
      makeEvent({
        eventId: 'detail-out:call',
        type: 'tool.call',
        ts: startTs,
        payload: { tool: 'Read', toolCallId: 'detail-out', input: { file_path: 'a.ts' } },
      }),
      makeEvent({
        eventId: 'detail-out:result',
        type: 'tool.result',
        ts: startTs + 400,
        payload: { toolCallId: 'detail-out', detail: { kind: 'tool_result', output: 'from-detail-output' } },
      }),
      makeEvent({
        eventId: 'sep-1',
        type: 'assistant.text',
        ts: startTs + 1_000,
        payload: { text: 'step 1', streaming: false },
      }),
      makeEvent({
        eventId: 'err-call:call',
        type: 'tool.call',
        ts: startTs + 5_000,
        payload: { tool: 'Bash', toolCallId: 'err-call', input: { command: 'false' } },
      }),
      makeEvent({
        eventId: 'err-call:result',
        type: 'tool.result',
        ts: startTs + 3_000, // skewed earlier than call ts: duration must clamp to 0s
        payload: { toolCallId: 'err-call', error: hugeError },
      }),
      makeEvent({
        eventId: 'sep-2',
        type: 'assistant.text',
        ts: startTs + 6_000,
        payload: { text: 'step 2', streaming: false },
      }),
      makeEvent({
        eventId: 'standalone:result',
        type: 'tool.result',
        ts: Number.NaN, // invalid ts must not emit NaN or crash
        payload: { error: 'standalone failed' },
      }),
    ];

    const { container } = render(<ChatView events={events} loading={false} />);
    const folds = container.querySelectorAll('.chat-tool-block-fold');
    expect(folds.length).toBe(3);

    // 1. detail.output surfaced directly in .chat-tool-result-preview outside fold
    expect(folds[0].querySelector('.chat-tool-result-preview .chat-tool-output')?.textContent).toBe('from-detail-output');
    expect(folds[0].querySelector('.chat-tool-meta .chat-tool-state.is-complete')?.textContent).toBe('✓');
    expect(folds[0].querySelector('.chat-tool-meta .chat-tool-duration')?.textContent).toBe('0.4s');

    // 2. Merged error surfaced & bounded outside fold; skewed ts clamped to 0.0s
    const errPreview = folds[1].querySelector('.chat-tool-result-preview .chat-tool-error');
    expect(errPreview?.textContent).toContain('error: exit 1:');
    expect(errPreview?.textContent!.length).toBeLessThan(4096);
    expect(errPreview?.textContent).not.toContain('ERROR_TAIL_9911');
    expect(folds[1].querySelector('.chat-tool-meta .chat-tool-state.is-failed')?.textContent).toBe('×');
    expect(folds[1].querySelector('.chat-tool-meta .chat-tool-duration')?.textContent).toBe('0.0s');

    // 3. Standalone tool.result shows × status and handles invalid ts gracefully
    expect(folds[2].querySelector('.chat-tool-meta .chat-tool-state.is-failed')?.textContent).toBe('×');
    expect(folds[2].querySelector('.chat-tool-meta .chat-bubble-time')).toBeNull();
    expect(container.textContent).not.toContain('NaN');
  });
});
