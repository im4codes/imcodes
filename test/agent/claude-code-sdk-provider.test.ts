import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  // Accept both (file, args, cb) and (file, args, opts, cb) signatures.
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    cb?.(null, 'ok\n', '');
    return {} as never;
  }),
  spawn: vi.fn(() => ({} as never)),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

const sdkMock = vi.hoisted(() => {
  let nextMessages: any[] = [];
  let waitForClose = false;
  const runs: Array<{ prompt: string; options: Record<string, unknown>; closed: boolean; interrupted: boolean }> = [];
  const query = vi.fn(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    const run = { prompt, options, closed: false, interrupted: false };
    runs.push(run);
    async function* gen() {
      for (const message of nextMessages) yield message;
      if (waitForClose) {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (run.closed) {
              clearInterval(timer);
              resolve();
            }
          }, 0);
        });
      }
    }
    const iterator = gen() as AsyncGenerator<any, void> & { close(): void; interrupt(): Promise<void> };
    iterator.close = () => { run.closed = true; };
    iterator.interrupt = async () => { run.interrupted = true; };
    return iterator;
  });
  return {
    query,
    runs,
    setNextMessages(messages: any[]) { nextMessages = messages; },
    setWaitForClose(value: boolean) { waitForClose = value; },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMock.query,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ClaudeCodeSdkProvider', () => {
  beforeEach(() => {
    sdkMock.query.mockClear();
    sdkMock.runs.length = 0;
    sdkMock.setNextMessages([]);
    sdkMock.setWaitForClose(false);
  });

  it('uses stable resume id, emits cumulative text deltas, and completes from result', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet-4-6' },
      { type: 'stream_event', session_id: 'session-1', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', session_id: 'session-1', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } } } },
      { type: 'stream_event', session_id: 'session-1', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', session_id: 'session-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', session_id: 'session-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      { type: 'assistant', session_id: 'session-1', message: { content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'result', session_id: 'session-1', subtype: 'success', is_error: false, result: 'Hello', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project', resumeId: 'session-1' });

    const deltas: string[] = [];
    const completed: string[] = [];
    const tools: string[] = [];
    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onToolCall?.((_sid, tool) => tools.push(`${tool.name}:${tool.status}:${JSON.stringify(tool.input ?? null)}`));
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));

    await provider.send('route-1', 'hello');
    await flush();

    const run = sdkMock.runs[0];
    expect(run.options.sessionId).toBe('session-1');
    expect(run.options.resume).toBeUndefined();
    expect(run.options.includePartialMessages).toBe(true);
    expect(run.options.permissionMode).toBe('bypassPermissions');
    expect(tools).toEqual([
      'Read:running:{"file_path":"a.ts"}',
      'Read:complete:{"file_path":"a.ts"}',
    ]);
    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);
    expect(sessionInfo.some((info) => info.resumeId === 'session-1')).toBe(true);
    expect(sessionInfo.some((info) => info.model === 'claude-sonnet-4-6')).toBe(true);
  });

  it('uses the last assistant usage for completion metadata instead of cumulative result usage', async () => {
    sdkMock.setNextMessages([
      {
        type: 'assistant',
        session_id: 'session-usage',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 120,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 20,
            output_tokens: 10,
          },
        },
      },
      {
        type: 'result',
        session_id: 'session-usage',
        subtype: 'success',
        is_error: false,
        result: 'Hello',
        usage: {
          input_tokens: 999,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 300,
          output_tokens: 50,
        },
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-usage', cwd: '/tmp/project', resumeId: 'session-usage' });

    const completed: AgentMessage[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg));

    await provider.send('route-usage', 'hello');
    await flush();

    expect(completed).toHaveLength(1);
    expect(completed[0]?.metadata).toMatchObject({
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 20,
        output_tokens: 10,
      },
      totalUsage: {
        input_tokens: 999,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 300,
        output_tokens: 50,
      },
    });
  });

  it('emits cancelled on cancel()', async () => {
    sdkMock.setWaitForClose(true);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-2', cwd: '/tmp/project', resumeId: 'session-2' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.code));

    await provider.send('route-2', 'hello');
    await provider.cancel('route-2');
    await flush();

    const run = sdkMock.runs[0];
    expect(run.interrupted).toBe(true);
    expect(run.closed).toBe(true);
    expect(errors).toContain('CANCELLED');
  });

  it('fresh createSession ignores previous internal continuity for the same route', async () => {
    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-fresh', cwd: '/tmp/project', resumeId: 'old-session' });
    await provider.createSession({ sessionKey: 'route-fresh', cwd: '/tmp/project', fresh: true, resumeId: 'new-session' });

    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'new-session', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'new-session', subtype: 'success', is_error: false, result: 'ACK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    await provider.send('route-fresh', 'hello');
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.options.sessionId).toBe('new-session');
    expect(run.options.resume).toBeUndefined();
  });

  it('uses resume mode when createSession marks an inherited session as existing', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-existing', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-existing', subtype: 'success', is_error: false, result: 'ACK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-existing',
      cwd: '/tmp/project',
      resumeId: 'session-existing',
      skipCreate: true,
    });

    await provider.send('route-existing', 'hello');
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.options.resume).toBe('session-existing');
    expect(run.options.sessionId).toBeUndefined();
  });

  it('falls back to sessionId create when inherited resume id no longer exists', async () => {
    const makeIterator = (messages: any[]) => {
      async function* gen() {
        for (const message of messages) yield message;
      }
      const iterator = gen() as AsyncGenerator<any, void> & { close(): void; interrupt(): Promise<void> };
      iterator.close = () => {};
      iterator.interrupt = async () => {};
      return iterator;
    };

    sdkMock.query
      .mockImplementationOnce(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
        sdkMock.runs.push({ prompt, options, closed: false, interrupted: false });
        return makeIterator([
          {
            type: 'result',
            session_id: 'session-missing',
            subtype: 'error',
            is_error: true,
            errors: ['No conversation found with session ID: session-missing'],
          },
        ]);
      })
      .mockImplementationOnce(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
        sdkMock.runs.push({ prompt, options, closed: false, interrupted: false });
        return makeIterator([
          { type: 'system', subtype: 'init', session_id: 'session-missing', model: 'claude-sonnet-4-6' },
          { type: 'result', session_id: 'session-missing', subtype: 'success', is_error: false, result: 'ACK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
        ]);
      });

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-missing',
      cwd: '/tmp/project',
      resumeId: 'session-missing',
      skipCreate: true,
    });

    const completed: string[] = [];
    const errors: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onError((_sid, err) => errors.push(err.message));

    await provider.send('route-missing', 'hello');
    await flush();

    expect(sdkMock.runs).toHaveLength(2);
    expect(sdkMock.runs[0]?.options.resume).toBe('session-missing');
    expect(sdkMock.runs[0]?.options.sessionId).toBeUndefined();
    expect(sdkMock.runs[1]?.options.sessionId).toBe('session-missing');
    expect(sdkMock.runs[1]?.options.resume).toBeUndefined();
    expect(completed).toEqual(['ACK']);
    expect(errors).toEqual([]);
  });

  it('passes session env through to the Claude SDK query options', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-env', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-env', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-env',
      cwd: '/tmp/project',
      resumeId: 'session-env',
      env: {
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        ANTHROPIC_MODEL: 'claude-haiku-test',
      },
    });

    await provider.send('route-env', 'hello');
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ANTHROPIC_MODEL: 'claude-haiku-test',
    });
  });

  it('passes runtime-only system prompts without polluting description', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-system', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-system', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-system',
      cwd: '/tmp/project',
      resumeId: 'session-system',
      description: 'Visible description',
      systemPrompt: 'Runtime note only',
    });

    await provider.send('route-system', 'hello');
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.options.appendSystemPrompt).toBe('Visible description\n\nRuntime note only');
  });

  it('emits a fallback streaming delta from assistant text when the SDK does not send text_delta events', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-fallback', model: 'claude-sonnet-4-6' },
      { type: 'assistant', session_id: 'session-fallback', message: { content: [{ type: 'text', text: 'STREAM_OK' }] } },
      { type: 'result', session_id: 'session-fallback', subtype: 'success', is_error: false, result: 'STREAM_OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-fallback', cwd: '/tmp/project', resumeId: 'session-fallback' });

    const deltas: string[] = [];
    const completed: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-fallback', 'hello');
    await flush();

    expect(deltas).toEqual(['STREAM_OK']);
    expect(completed).toEqual(['STREAM_OK']);
  });

  it('builds tool input from input_json_delta events', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-tool-json', model: 'claude-sonnet-4-6' },
      { type: 'stream_event', session_id: 'session-tool-json', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-json', name: 'Bash' } } },
      { type: 'stream_event', session_id: 'session-tool-json', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{\"command\":\"echo' } } },
      { type: 'stream_event', session_id: 'session-tool-json', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' hi\"}' } } },
      { type: 'stream_event', session_id: 'session-tool-json', event: { type: 'content_block_stop', index: 0 } },
      { type: 'result', session_id: 'session-tool-json', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-tool-json', cwd: '/tmp/project', resumeId: 'session-tool-json' });

    const tools: ToolEventSnapshot[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input }));

    await provider.send('route-tool-json', 'hello');
    await flush();

    expect(tools).toEqual([
      { name: 'Bash', status: 'running', input: undefined },
      { name: 'Bash', status: 'complete', input: { command: 'echo hi' } },
    ]);
  });

  it('emits tool events from assistant/user message content when stream events are absent', async () => {
    sdkMock.setNextMessages([
      {
        type: 'assistant',
        session_id: 'session-tool-msg',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-msg-1', name: 'WebSearch', input: { query: 'nyc weather' } },
            { type: 'text', text: 'Checking.' },
          ],
        },
      },
      {
        type: 'user',
        session_id: 'session-tool-msg',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-msg-1', content: 'Sunny 12C', is_error: false },
          ],
        },
      },
      { type: 'result', session_id: 'session-tool-msg', subtype: 'success', is_error: false, result: 'Sunny 12C', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-tool-msg', cwd: '/tmp/project', resumeId: 'session-tool-msg' });

    const tools: ToolEventSnapshot[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, output: tool.output, detail: tool.detail }));

    await provider.send('route-tool-msg', 'hello');
    await flush();

    expect(tools).toEqual([
      {
        name: 'WebSearch',
        status: 'running',
        input: { query: 'nyc weather' },
        output: undefined,
        detail: {
          kind: 'tool_use',
          summary: 'WebSearch',
          input: { query: 'nyc weather' },
          raw: { type: 'tool_use', id: 'tool-msg-1', name: 'WebSearch', input: { query: 'nyc weather' } },
        },
      },
      {
        name: 'tool',
        status: 'complete',
        input: undefined,
        output: 'Sunny 12C',
        detail: {
          kind: 'tool_result',
          output: 'Sunny 12C',
          raw: { type: 'tool_result', tool_use_id: 'tool-msg-1', content: 'Sunny 12C', is_error: false },
        },
      },
    ]);
  });

  it('applies thinking level to subsequent Claude SDK turns', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-think', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-think', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-think', cwd: '/tmp/project', resumeId: 'session-think', effort: 'medium' });
    provider.setSessionEffort('route-think', 'high');

    await provider.send('route-think', 'hello');
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.options.effort).toBe('high');
  });

  it('emits compacting status updates from Claude SDK system status messages', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-status', model: 'claude-sonnet-4-6' },
      { type: 'system', subtype: 'status', session_id: 'session-status', status: 'compacting' },
      { type: 'system', subtype: 'status', session_id: 'session-status', status: null },
      { type: 'result', session_id: 'session-status', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-status', cwd: '/tmp/project', resumeId: 'session-status' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('route-status', 'hello');
    await flush();

    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null },
    ]);
  });

  it('emits compacting status from compact boundary system messages', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-boundary', model: 'claude-sonnet-4-6' },
      { type: 'system', subtype: 'compact_boundary', session_id: 'session-boundary' },
      { type: 'result', session_id: 'session-boundary', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-boundary', cwd: '/tmp/project', resumeId: 'session-boundary' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('route-boundary', 'hello');
    await flush();

    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
    ]);
  });
});

type ToolEventSnapshot = { name: string; status: string; input: unknown; output?: unknown; detail?: unknown };
