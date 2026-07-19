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
  spawn: vi.fn(() => ({
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
    once: vi.fn(),
    on: vi.fn(),
  }) as never),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

const sdkMock = vi.hoisted(() => {
  let nextMessages: any[] = [];
  let nextMessageBatches: any[][] | null = null;
  let waitForClose = false;
  let interruptNeverResolves = false;
  let nextContextUsage: { totalTokens?: number } | null = null;
  const runs: Array<{ prompt: string; options: Record<string, unknown>; closed: boolean; interrupted: boolean; stoppedTasks: string[]; contextUsageCalls: number; resolveClose?: () => void }> = [];
  // The provider drives the SDK in streaming-input mode, so `prompt` is an
  // AsyncIterable<SDKUserMessage>, not a string — that is what lets a message
  // reach a query still running subagents. This mock stands in for the SDK, so it
  // resolves the queue to the user text the SDK would read, keeping `run.prompt`
  // a string for every assertion below.
  const readPromptText = (prompt: unknown): string => {
    if (typeof prompt === 'string') return prompt;
    const buffered = (prompt as { buffer?: Array<{ message?: { content?: unknown } }> })?.buffer?.[0];
    const content = buffered?.message?.content;
    return typeof content === 'string' ? content : '';
  };
  const query = vi.fn(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const run = { prompt: readPromptText(prompt), options, closed: false, interrupted: false, stoppedTasks: [] as string[], contextUsageCalls: 0, resolveClose: undefined as (() => void) | undefined };
    runs.push(run);
    const messages = nextMessageBatches?.shift() ?? nextMessages;
    async function* gen() {
      for (const message of messages) yield message;
      if (waitForClose && !run.closed) {
        await new Promise<void>((resolve) => {
          run.resolveClose = resolve;
        });
      }
    }
    const iterator = gen() as AsyncGenerator<any, void> & { close(): void; interrupt(): Promise<void>; stopTask(taskId: string): Promise<void>; getContextUsage(): Promise<{ totalTokens?: number }> };
    iterator.close = () => {
      run.closed = true;
      run.resolveClose?.();
    };
    iterator.interrupt = async () => {
      run.interrupted = true;
      if (interruptNeverResolves) {
        await new Promise<void>(() => {});
      }
    };
    iterator.stopTask = async (taskId: string) => {
      run.stoppedTasks.push(taskId);
    };
    iterator.getContextUsage = async () => {
      run.contextUsageCalls += 1;
      return nextContextUsage ?? {};
    };
    return iterator;
  });
  return {
    query,
    runs,
    readPromptText,
    setNextMessages(messages: any[]) { nextMessages = messages; nextMessageBatches = null; },
    setNextMessageBatches(batches: any[][]) { nextMessageBatches = batches.map((batch) => [...batch]); },
    setWaitForClose(value: boolean) { waitForClose = value; },
    setInterruptNeverResolves(value: boolean) { interruptNeverResolves = value; },
    setNextContextUsage(value: { totalTokens?: number } | null) { nextContextUsage = value; },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMock.query,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';
import type { AgentMessage, ToolCallEvent } from '../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
  makeClaudeSubagentCanonicalKey,
} from '../../shared/sdk-subagent-status.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sdkSubagentTools = (tools: ToolCallEvent[]) => tools.filter((tool) => tool.detail?.kind === SDK_SUBAGENT_DETAIL_KIND);

describe('ClaudeCodeSdkProvider', () => {
  beforeEach(() => {
    vi.useRealTimers();
    sdkMock.query.mockClear();
    sdkMock.runs.length = 0;
    sdkMock.setNextMessages([]);
    sdkMock.setWaitForClose(false);
    sdkMock.setInterruptNeverResolves(false);
    sdkMock.setNextContextUsage(null);
    childProcessMock.spawn.mockClear();
  });

  const collectToolsForMessages = async (
    messages: any[],
    routeId: string,
    sessionName = 'deck_project_claude',
  ): Promise<{ tools: ToolCallEvent[]; run: { prompt: string; options: Record<string, unknown> } }> => {
    sdkMock.setNextMessages(messages);
    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: routeId,
      sessionName,
      cwd: '/tmp/project',
      resumeId: `session-${routeId}`,
    });
    const tools: ToolCallEvent[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push(tool));
    await provider.send(routeId, 'hello');
    await flush();
    return { tools, run: sdkMock.runs.at(-1)! };
  };

  it('reports Memory MCP ready after provider connect', async () => {
    const provider = new ClaudeCodeSdkProvider();
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'claude-code-sdk',
      status: MEMORY_MCP_STATUS.UNKNOWN,
      connected: false,
      degradedReasons: [],
    });

    await provider.connect({ binaryPath: 'claude' });

    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'claude-code-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    });
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
    // Native scheduling tools are disabled so the agent uses our imcodes-memory
    // MCP cron instead of creating claude.ai routines via RemoteTrigger.
    expect(run.options.disallowedTools).toContain('RemoteTrigger');
    expect(run.options.disallowedTools).toContain('CronCreate');
    expect(tools).toEqual([
      'Read:running:{"file_path":"a.ts"}',
      'Read:complete:{"file_path":"a.ts"}',
    ]);
    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);
    expect(sessionInfo.some((info) => info.resumeId === 'session-1')).toBe(true);
    expect(sessionInfo.some((info) => info.model === 'claude-sonnet-4-6')).toBe(true);
  });

  it('resets the streaming accumulator across messages so a second message is not prefixed with the first', async () => {
    // A single turn with a tool round produces TWO assistant messages, each
    // with its own message_start id. The second message's streaming deltas must
    // start fresh — not carry the first message's full text as a prefix.
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-multi', model: 'claude-sonnet-4-6' },
      { type: 'stream_event', session_id: 'session-multi', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', session_id: 'session-multi', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check.' } } },
      { type: 'assistant', session_id: 'session-multi', message: { content: [{ type: 'text', text: 'Let me check.' }] } },
      // ── tool round happens here; the model then continues in a NEW message ──
      { type: 'stream_event', session_id: 'session-multi', event: { type: 'message_start', message: { id: 'msg-2' } } },
      { type: 'stream_event', session_id: 'session-multi', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The answer' } } },
      { type: 'stream_event', session_id: 'session-multi', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' is 42.' } } },
      { type: 'assistant', session_id: 'session-multi', message: { content: [{ type: 'text', text: 'The answer is 42.' }] } },
      { type: 'result', session_id: 'session-multi', subtype: 'success', is_error: false, result: 'The answer is 42.', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-multi', cwd: '/tmp/project', resumeId: 'session-multi' });

    const deltas: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    await provider.send('route-multi', 'hello');
    await flush();

    // Message 2's deltas must be its OWN text only, never prefixed with msg-1.
    const msg2Deltas = deltas.filter((d) => d.id === 'msg-2').map((d) => d.text);
    expect(msg2Deltas).toEqual(['The answer', 'The answer is 42.']);
    // Guard: no delta should ever contain both messages concatenated.
    expect(deltas.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
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

  it('reports usage that arrives in the full assistant frame after a terminal stream delta', async () => {
    sdkMock.setNextMessages([
      {
        type: 'stream_event',
        session_id: 'session-late-usage',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'msg-late-usage' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-late-usage',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-late-usage',
        parent_tool_use_id: null,
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      },
      {
        type: 'assistant',
        session_id: 'session-late-usage',
        parent_tool_use_id: null,
        message: {
          id: 'msg-late-usage',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 12_000,
            cache_read_input_tokens: 700_000,
            output_tokens: 80,
          },
        },
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-late-usage',
      cwd: '/tmp/project',
      resumeId: 'session-late-usage',
      agentId: 'MiniMax-M3',
    });

    const completed: AgentMessage[] = [];
    const usageUpdates: Array<Record<string, unknown>> = [];
    provider.onComplete((_sid, msg) => completed.push(msg));
    provider.onUsage?.((_sid, update) => usageUpdates.push(update as unknown as Record<string, unknown>));

    await provider.send('route-late-usage', 'hello');
    await flush();

    expect(completed).toHaveLength(1);
    expect(usageUpdates).toEqual([{
      messageId: 'msg-late-usage',
      model: 'MiniMax-M3',
      usage: {
        input_tokens: 12_000,
        cache_read_input_tokens: 700_000,
        output_tokens: 80,
      },
    }]);
  });

  it('reports result-only usage that trails a terminal stream delta', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-result-usage', model: 'MiniMax-M3' },
      {
        type: 'stream_event',
        session_id: 'session-result-usage',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'msg-result-usage' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-result-usage',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-result-usage',
        parent_tool_use_id: null,
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      },
      {
        type: 'result',
        session_id: 'session-result-usage',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        usage: {
          input_tokens: 14_000,
          cache_read_input_tokens: 710_000,
          output_tokens: 90,
        },
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-result-usage',
      cwd: '/tmp/project',
      resumeId: 'session-result-usage',
      agentId: 'MiniMax-M3',
    });

    const completed: AgentMessage[] = [];
    const usageUpdates: Array<Record<string, unknown>> = [];
    provider.onComplete((_sid, msg) => completed.push(msg));
    provider.onUsage?.((_sid, update) => usageUpdates.push(update as unknown as Record<string, unknown>));

    await provider.send('route-result-usage', 'hello');
    await flush();

    expect(completed).toHaveLength(1);
    expect(usageUpdates).toEqual([{
      messageId: 'msg-result-usage',
      model: 'MiniMax-M3',
      usage: {
        input_tokens: 14_000,
        cache_read_input_tokens: 710_000,
        output_tokens: 90,
      },
    }]);
  });

  it('uses the SDK live context meter when a compatible endpoint reports zero usage', async () => {
    sdkMock.setNextContextUsage({ totalTokens: 734_321 });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-live-context', model: 'MiniMax-M3' },
      {
        type: 'stream_event',
        session_id: 'session-live-context',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'msg-live-context' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-live-context',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-live-context',
        parent_tool_use_id: null,
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      },
      {
        type: 'result',
        session_id: 'session-live-context',
        subtype: 'success',
        is_error: false,
        result: 'Done',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-live-context',
      cwd: '/tmp/project',
      resumeId: 'session-live-context',
      agentId: 'MiniMax-M3',
    });

    const usageUpdates: Array<Record<string, unknown>> = [];
    provider.onUsage?.((_sid, update) => usageUpdates.push(update as unknown as Record<string, unknown>));

    await provider.send('route-live-context', 'hello');
    await flush();

    expect(sdkMock.runs.at(-1)?.contextUsageCalls).toBeGreaterThanOrEqual(1);
    expect(usageUpdates.at(-1)).toEqual({
      messageId: 'msg-live-context',
      model: 'MiniMax-M3',
      usage: {
        input_tokens: 734_321,
        output_tokens: 0,
      },
    });
  });

  it('falls back to completing from result when the SDK iterator never closes', async () => {
    vi.useFakeTimers();
    sdkMock.setWaitForClose(true);
    sdkMock.setNextMessages([
      { type: 'result', session_id: 'session-result-stuck', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-result-stuck', cwd: '/tmp/project', resumeId: 'session-result-stuck' });

    const completed: AgentMessage[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg));

    await provider.send('route-result-stuck', 'hello');
    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(completed.map((msg) => msg.content)).toEqual(['Done']);
    expect(completed[0]?.metadata).toMatchObject({ completionFallback: 'result-timeout' });
    expect(sdkMock.runs[0]?.closed).toBe(true);
  });

  it('does not close the SDK query after foreground result while a background Claude task is active', async () => {
    vi.useFakeTimers();
    sdkMock.setWaitForClose(true);
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-background-result', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-background-result',
        uuid: 'uuid-background-result-start',
        task_id: 'task-background-result',
        tool_use_id: 'tool-use-background-result',
        description: 'Run in background',
      },
      { type: 'result', session_id: 'session-background-result', subtype: 'success', is_error: false, result: 'Background task started', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-background-result',
      sessionName: 'deck_project_claude_background_result',
      cwd: '/tmp/project',
      resumeId: 'session-background-result',
    });
    const completed: AgentMessage[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg));

    await provider.send('route-background-result', 'hello');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(completed.map((msg) => msg.content)).toEqual(['Background task started']);
    expect(completed[0]?.metadata).toMatchObject({ completionFallback: 'result-timeout' });
    expect(sdkMock.runs[0]?.closed).toBe(false);
    expect(provider.getActiveWorkSnapshot('route-background-result')).toMatchObject({
      activeWorkCount: 1,
      busyReasons: ['background_monitor'],
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

  it('force-kills the Claude child when cancel interrupt hangs', async () => {
    vi.useFakeTimers();
    sdkMock.setWaitForClose(true);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-hung-cancel', cwd: '/tmp/project', resumeId: 'session-hung-cancel' });

    await provider.send('route-hung-cancel', 'hello');
    const run = sdkMock.runs[0]!;
    const spawnFn = run.options.spawnClaudeCodeProcess as ((req: { command: string; args: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }) => any);
    const child = spawnFn({ command: 'claude', args: ['--fake'] });
    sdkMock.setInterruptNeverResolves(true);

    const cancelPromise = provider.cancel('route-hung-cancel');
    await vi.advanceTimersByTimeAsync(1_600);
    await cancelPromise;

    expect(run.closed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
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
      .mockImplementationOnce(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
        sdkMock.runs.push({ prompt: sdkMock.readPromptText(prompt), options, closed: false, interrupted: false });
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
      .mockImplementationOnce(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
        sdkMock.runs.push({ prompt: sdkMock.readPromptText(prompt), options, closed: false, interrupted: false });
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

  it('interrupts a stuck connection-closed result and auto-continues the same session twice', async () => {
    const connectionError = 'API Error: Connection closed mid-response. The response above may be incomplete.';
    const makeIterator = (messages: any[], waitForClose: boolean) => {
      const run = {
        prompt: '',
        options: {} as Record<string, unknown>,
        closed: false,
        interrupted: false,
        stoppedTasks: [] as string[],
        resolveClose: undefined as (() => void) | undefined,
      };
      async function* gen() {
        for (const message of messages) yield message;
        if (waitForClose && !run.closed) {
          await new Promise<void>((resolve) => { run.resolveClose = resolve; });
        }
      }
      const iterator = gen() as AsyncGenerator<any, void> & { close(): void; interrupt(): Promise<void>; stopTask(taskId: string): Promise<void> };
      iterator.close = () => {
        run.closed = true;
        run.resolveClose?.();
      };
      iterator.interrupt = async () => { run.interrupted = true; };
      iterator.stopTask = async (taskId: string) => { run.stoppedTasks.push(taskId); };
      return { run, iterator };
    };
    // The provider now drives the SDK in streaming-input mode, so `prompt` is an
    // AsyncIterable<SDKUserMessage> rather than a string (this is what lets a
    // message reach a query that is still running subagents). This mock stands in
    // for the SDK, so it resolves the queue to the user text the SDK would read —
    // keeping `run.prompt` a string for the assertions below.
    const readPromptText = (prompt: unknown): string => {
      if (typeof prompt === 'string') return prompt;
      const buffered = (prompt as { buffer?: Array<{ message?: { content?: unknown } }> })?.buffer?.[0];
      const content = buffered?.message?.content;
      return typeof content === 'string' ? content : '';
    };
    const queueRun = (messages: any[], waitForClose: boolean) => ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
      const { run, iterator } = makeIterator(messages, waitForClose);
      run.prompt = readPromptText(prompt);
      run.options = options;
      sdkMock.runs.push(run);
      return iterator;
    };

    sdkMock.query
      .mockImplementationOnce(queueRun([
        { type: 'system', subtype: 'init', session_id: 'session-connection-retry', model: 'claude-sonnet-4-6' },
        { type: 'assistant', session_id: 'session-connection-retry', message: { content: [{ type: 'text', text: connectionError }] } },
        // Exact production shape: the useful reason is in assistant text and
        // the terminal result omits errors[]. Recovery must still engage.
        { type: 'result', session_id: 'session-connection-retry', subtype: 'error', is_error: true },
      ], true))
      .mockImplementationOnce(queueRun([
        { type: 'result', session_id: 'session-connection-retry', subtype: 'error', is_error: true, errors: [connectionError] },
      ], true))
      .mockImplementationOnce(queueRun([
        { type: 'result', session_id: 'session-connection-retry', subtype: 'success', is_error: false, result: 'Recovered answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
      ], false));

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-connection-retry', cwd: '/tmp/project' });
    const completed: string[] = [];
    const errors: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onError((_sid, err) => errors.push(err.message));

    await provider.send('route-connection-retry', 'original work');
    for (let i = 0; i < 8; i++) await flush();

    expect(sdkMock.runs.map((run) => run.prompt)).toEqual(['original work', 'continue', 'continue']);
    expect(sdkMock.runs.slice(0, 2).every((run) => run.interrupted && run.closed)).toBe(true);
    expect(sdkMock.runs.slice(1).every((run) => run.options.resume === 'session-connection-retry')).toBe(true);
    expect(completed).toEqual(['Recovered answer']);
    expect(errors).toEqual([]);
  });

  it('tells users to logout, fully exit, and login again after a 401', async () => {
    const authError = 'Failed to authenticate. API Error: 401 Invalid authentication credentials';
    sdkMock.setNextMessages([
      {
        type: 'assistant',
        session_id: 'session-auth-guidance',
        message: { content: [{ type: 'text', text: authError }] },
      },
      {
        type: 'result',
        session_id: 'session-auth-guidance',
        subtype: 'error',
        is_error: true,
        errors: [authError],
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-auth-guidance', cwd: '/tmp/project' });
    const deltas: string[] = [];
    const errors: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onError((_sid, error) => errors.push(error.message));

    await provider.send('route-auth-guidance', 'hello');
    await flush();

    for (const message of [...deltas, ...errors]) {
      expect(message).toContain(authError);
      expect(message).toContain('run `/logout`');
      expect(message).toContain('fully exit Claude Code');
      expect(message).toContain('run `/login`');
    }
    expect(deltas).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('stops after two auto-continues and emits a recoverable terminal error', async () => {
    const connectionError = 'Claude Code returned an error result: API Error: Connection closed mid-response.';
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-connection-exhausted', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-connection-exhausted', subtype: 'error', is_error: true, errors: [connectionError] },
    ]);
    sdkMock.setWaitForClose(true);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-connection-exhausted', cwd: '/tmp/project' });
    const errors: Array<{ message: string; recoverable: boolean }> = [];
    provider.onError((_sid, err) => errors.push({ message: err.message, recoverable: err.recoverable }));

    await provider.send('route-connection-exhausted', 'original work');
    for (let i = 0; i < 10; i++) await flush();

    expect(sdkMock.runs.map((run) => run.prompt)).toEqual(['original work', 'continue', 'continue']);
    expect(sdkMock.runs.every((run) => run.interrupted && run.closed)).toBe(true);
    expect(errors).toEqual([{ message: connectionError, recoverable: true }]);
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

  it('declares /compact as a verified Claude slash command capability', async () => {
    const provider = new ClaudeCodeSdkProvider();

    expect(provider.capabilities.compact).toEqual(expect.objectContaining({
      execution: 'slash-command',
      verified: true,
      completion: 'status-only',
      cancellation: 'provider-cancel',
    }));
  });

  it('forwards raw /compact to Claude Code SDK as a slash command', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-compact', model: 'claude-sonnet-4-6' },
      { type: 'system', subtype: 'status', session_id: 'session-compact', status: 'compacting' },
      { type: 'system', subtype: 'status', session_id: 'session-compact', status: null },
      { type: 'result', session_id: 'session-compact', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-compact', cwd: '/tmp/project', resumeId: 'session-compact' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('route-compact', {
      userMessage: '/compact',
      assembledMessage: '/compact',
      systemText: undefined,
      messagePreamble: undefined,
      attachments: undefined,
      context: {
        systemText: undefined,
        messagePreamble: undefined,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.prompt).toBe('/compact');
    expect(run.options.appendSystemPrompt).toBeUndefined();
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null },
    ]);
  });

  it('surfaces claude-agent-sdk thinking_tokens as a live thinking status with the running estimate', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-think', model: 'claude-opus-4-8' },
      { type: 'system', subtype: 'thinking_tokens', session_id: 'session-think', estimated_tokens: 1234, estimated_tokens_delta: 1234 },
      { type: 'system', subtype: 'thinking_tokens', session_id: 'session-think', estimated_tokens: 2680, estimated_tokens_delta: 1446 },
      { type: 'result', session_id: 'session-think', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-think', cwd: '/tmp/project', resumeId: 'session-think' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('route-think', 'hello');
    await flush();

    // Each distinct estimate yields one live thinking status (emitStatus dedups
    // by label, so equal estimates collapse). Compact format: 1234 -> 1.2k.
    const thinking = statuses.filter((s) => s.status === 'thinking');
    expect(thinking).toEqual([
      { status: 'thinking', label: 'Thinking (1.2k tokens)' },
      { status: 'thinking', label: 'Thinking (2.7k tokens)' },
    ]);
  });

  it('maps normalized provider payloads without re-assembling prompt state in the caller', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-payload', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-payload', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-payload',
      cwd: '/tmp/project',
      resumeId: 'session-payload',
      description: 'Visible description',
      systemPrompt: 'Runtime note only',
    });

    const payload: ProviderContextPayload = {
      userMessage: 'actual user message',
      assembledMessage: 'Context block\n\nactual user message',
      systemText: 'Normalized system text',
      messagePreamble: 'Context block',
      attachments: [],
      context: {
        systemText: 'Normalized system text',
        messagePreamble: 'Context block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-payload' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    };

    await provider.send('route-payload', payload);
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.prompt).toBe('Context block\n\nactual user message');
    expect(run.options.appendSystemPrompt).toBe('Normalized system text');
  });

  it('keeps split stable system text in appendSystemPrompt and moves turn text into the prompt', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-split', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-split', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-split',
      cwd: '/tmp/project',
      resumeId: 'session-split',
    });

    const makePayload = (turnSystemText: string): ProviderContextPayload => ({
      userMessage: 'ship it',
      assembledMessage: 'Relevant history\n\nship it',
      sessionSystemText: 'Stable IM.codes runtime rules',
      turnSystemText,
      systemText: `Stable IM.codes runtime rules\n\n${turnSystemText}`,
      messagePreamble: 'Relevant history',
      attachments: undefined,
      context: {
        sessionSystemText: 'Stable IM.codes runtime rules',
        turnSystemText,
        systemText: `Stable IM.codes runtime rules\n\n${turnSystemText}`,
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [turnSystemText],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-split' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });

    await provider.send('route-split', makePayload('Required shared context:\n- First file rule'));
    await flush();
    await provider.send('route-split', makePayload('Required shared context:\n- Second file rule'));
    await flush();

    const [first, second] = sdkMock.runs.slice(-2);
    expect(first.options.appendSystemPrompt).toBe('Stable IM.codes runtime rules');
    expect(second.options.appendSystemPrompt).toBe('Stable IM.codes runtime rules');
    expect(first.prompt).toContain('Required shared context:\n- First file rule');
    expect(first.prompt).not.toContain('Second file rule');
    expect(second.prompt).toContain('Required shared context:\n- Second file rule');
    expect(second.prompt).not.toContain('First file rule');
    expect(second.prompt).not.toContain('Stable IM.codes runtime rules');
  });

  it('accepts a normalized provider payload', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-payload', model: 'claude-sonnet-4-6' },
      { type: 'result', session_id: 'session-payload', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-payload',
      cwd: '/tmp/project',
      resumeId: 'session-payload',
    });

    await provider.send('route-payload', {
      userMessage: 'hello',
      assembledMessage: 'Relevant history\n\nhello',
      systemText: 'Enterprise standard',
      messagePreamble: 'Relevant history',
      attachments: undefined,
      context: {
        systemText: 'Enterprise standard',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'repo' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });
    await flush();

    const run = sdkMock.runs.at(-1)!;
    expect(run.prompt).toBe('Relevant history\n\nhello');
    expect(run.options.appendSystemPrompt).toBe('Enterprise standard');
  });

  it('rejects normalized payloads combined with legacy extraSystemPrompt', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-payload', model: 'claude-sonnet-4-6' },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-payload',
      cwd: '/tmp/project',
      resumeId: 'session-payload',
    });

    await expect(provider.send('route-payload', {
      userMessage: 'hello',
      assembledMessage: 'Relevant history\n\nhello',
      systemText: 'Enterprise standard',
      messagePreamble: 'Relevant history',
      attachments: undefined,
      context: {
        systemText: 'Enterprise standard',
        messagePreamble: 'Relevant history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'repo' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    }, undefined, 'legacy raw context')).rejects.toThrow(/legacy extraSystemPrompt/i);
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

  it('retries third-party resumed sessions fresh when Claude returns the no-response seed artifact', async () => {
    sdkMock.setNextMessageBatches([
      [
        { type: 'system', subtype: 'init', session_id: 'old-session', model: 'MiniMax-M3' },
        {
          type: 'assistant',
          session_id: 'old-session',
          message: {
            content: [{ type: 'text', text: 'No response requested.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0 },
          },
        },
        {
          type: 'result',
          session_id: 'old-session',
          subtype: 'success',
          is_error: false,
          result: 'No response requested.',
          usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0 },
        },
      ],
      [
        { type: 'system', subtype: 'init', session_id: 'fresh-session', model: 'MiniMax-M3' },
        { type: 'assistant', session_id: 'fresh-session', message: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } },
        { type: 'result', session_id: 'fresh-session', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
      ],
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-minimax-resume',
      cwd: '/tmp/project',
      resumeId: 'old-session',
      skipCreate: true,
      env: { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic' },
    });

    const completed: string[] = [];
    const resumeIds: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onSessionInfo((_sid, info) => {
      if (info.resumeId) resumeIds.push(info.resumeId);
    });

    await provider.send('route-minimax-resume', 'hello');
    await flush();
    await flush();

    expect(sdkMock.runs).toHaveLength(2);
    expect(sdkMock.runs[0]?.options.resume).toBe('old-session');
    expect(sdkMock.runs[1]?.options.sessionId).toEqual(expect.any(String));
    expect(sdkMock.runs[1]?.options.sessionId).not.toBe('old-session');
    expect(sdkMock.runs[1]?.prompt).toBe('hello');
    expect(completed).toEqual(['OK']);
    expect(resumeIds).toContain('fresh-session');
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

  it('normalizes Claude update_plan bare array input into a plan checklist tool call', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-tool-plan', model: 'claude-sonnet-4-6' },
      { type: 'stream_event', session_id: 'session-tool-plan', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-plan', name: 'update_plan' } } },
      {
        type: 'stream_event',
        session_id: 'session-tool-plan',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '[{"content":"梳理重启恢复入口和活跃信号","status":"in_progress"},{"content":"实现优先/延迟恢复与提示语","status":"pending"}]',
          },
        },
      },
      { type: 'stream_event', session_id: 'session-tool-plan', event: { type: 'content_block_stop', index: 0 } },
      { type: 'result', session_id: 'session-tool-plan', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-tool-plan', cwd: '/tmp/project', resumeId: 'session-tool-plan' });

    const tools: ToolEventSnapshot[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-tool-plan', 'hello');
    await flush();

    expect(tools[0]).toMatchObject({ name: 'update_plan', status: 'running', input: undefined });
    expect(tools[1]).toMatchObject({
      name: 'update_plan',
      status: 'complete',
      input: {
        plan: [
          { content: '梳理重启恢复入口和活跃信号', status: 'in_progress' },
          { content: '实现优先/延迟恢复与提示语', status: 'pending' },
        ],
      },
      detail: {
        kind: 'plan',
        summary: 'Plan',
        input: {
          plan: [
            { content: '梳理重启恢复入口和活跃信号', status: 'in_progress' },
            { content: '实现优先/延迟恢复与提示语', status: 'pending' },
          ],
        },
      },
    });
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

  it('reports active-work snapshots while Claude tool calls are open', async () => {
    sdkMock.setNextMessages([
      {
        type: 'stream_event',
        session_id: 'session-active-work',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-active-1', name: 'Read', input: { file_path: 'a.ts' } },
        },
      },
    ]);
    sdkMock.setWaitForClose(true);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({ sessionKey: 'route-active-work', cwd: '/tmp/project', resumeId: 'session-active-work' });
    await provider.send('route-active-work', 'hello');
    await flush();

    expect(provider.getActiveWorkSnapshot('route-active-work')).toMatchObject({
      status: 'current',
      activeWorkCount: 2,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item', 'background_monitor'],
    });

    sdkMock.runs.at(-1)?.resolveClose?.();
    await flush();
  });

  it('emits a running SDK subagent snapshot for Claude task_started', async () => {
    const sessionName = 'deck_project_claude_start';
    const taskId = 'task-start-1';
    const prompt = 'FULL CHILD PROMPT should not appear in input';
    const { tools, run } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-start', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-start',
        uuid: 'uuid-task-start',
        task_id: taskId,
        tool_use_id: 'tool-use-agent-1',
        description: 'Investigate the failing tests',
        task_type: 'agent',
        model: 'haiku',
        prompt,
      },
      { type: 'result', session_id: 'session-route-subagent-start', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-start', sessionName);

    const [tool] = sdkSubagentTools(tools);
    const canonicalKey = makeClaudeSubagentCanonicalKey(sessionName, taskId);
    expect(run.options.agentProgressSummaries).toBe(false);
    expect(run.options.forwardSubagentText).toBe(false);
    expect(tool).toMatchObject({
      id: canonicalKey,
      name: 'Agent',
      status: 'running',
      input: {
        action: 'claude-task',
        description: 'Investigate the failing tests',
      },
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        summary: 'Claude task',
        input: {
          action: 'claude-task',
          description: 'Investigate the failing tests',
        },
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
          canonicalKey,
          parentToolUseId: 'tool-use-agent-1',
          taskId,
          model: 'haiku',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
        },
      },
    });
    expect(JSON.stringify(tool?.input ?? null)).not.toContain(prompt);
    expect(tool?.detail?.raw).toBeUndefined();
  });

  it('closes stale Claude task snapshots so background monitor evidence cannot block forever', async () => {
    const previousStaleMs = process.env.IMCODES_CLAUDE_SUBAGENT_STALE_MS;
    process.env.IMCODES_CLAUDE_SUBAGENT_STALE_MS = '1000';
    try {
      sdkMock.setNextMessages([
        { type: 'system', subtype: 'init', session_id: 'session-route-subagent-stale', model: 'claude-sonnet-4-6' },
        {
          type: 'system',
          subtype: 'task_started',
          session_id: 'session-route-subagent-stale',
          uuid: 'uuid-task-stale-start',
          task_id: 'task-stale-1',
          tool_use_id: 'tool-use-stale',
          description: 'Run a background task that never reports terminal',
        },
        { type: 'result', session_id: 'session-route-subagent-stale', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
      ]);

      const provider = new ClaudeCodeSdkProvider();
      await provider.connect({ binaryPath: 'claude' });
      await provider.createSession({
        sessionKey: 'route-subagent-stale',
        sessionName: 'deck_project_claude_stale',
        cwd: '/tmp/project',
        resumeId: 'session-route-subagent-stale',
      });
      const tools: ToolCallEvent[] = [];
      provider.onToolCall?.((_sid, tool) => tools.push(tool));

      await provider.send('route-subagent-stale', 'hello');
      await flush();

      expect(provider.getActiveWorkSnapshot('route-subagent-stale')).toMatchObject({
        activeWorkCount: 1,
        activeToolCount: 0,
        busyReasons: ['background_monitor'],
      });

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 1_001);
      expect(provider.getActiveWorkSnapshot('route-subagent-stale')).toMatchObject({
        activeWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });
      vi.useRealTimers();

      const staleTerminal = sdkSubagentTools(tools).at(-1);
      expect(staleTerminal).toMatchObject({
        id: makeClaudeSubagentCanonicalKey('deck_project_claude_stale', 'task-stale-1'),
        status: 'error',
        detail: {
          meta: {
            rawStatus: 'stale',
            normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
            diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.STALE_WITHOUT_TERMINAL,
            active: false,
            terminal: true,
          },
        },
      });
    } finally {
      vi.useRealTimers();
      if (previousStaleMs === undefined) delete process.env.IMCODES_CLAUDE_SUBAGENT_STALE_MS;
      else process.env.IMCODES_CLAUDE_SUBAGENT_STALE_MS = previousStaleMs;
    }
  });

  it('excludes backgrounded Claude tasks from provider active-work snapshots after the foreground turn completes', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-backgrounded', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-backgrounded',
        uuid: 'uuid-task-backgrounded-start',
        task_id: 'task-backgrounded-1',
        tool_use_id: 'tool-use-backgrounded',
        description: 'Run a detached task',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'session-route-subagent-backgrounded',
        uuid: 'uuid-task-backgrounded-update',
        task_id: 'task-backgrounded-1',
        patch: { status: 'running', is_backgrounded: true },
      },
      { type: 'result', session_id: 'session-route-subagent-backgrounded', subtype: 'success', is_error: false, result: 'Foreground done', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-backgrounded',
      sessionName: 'deck_project_claude_backgrounded',
      cwd: '/tmp/project',
      resumeId: 'session-route-subagent-backgrounded',
    });
    const tools: ToolCallEvent[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('route-subagent-backgrounded', 'hello');
    await flush();

    expect(provider.getActiveWorkSnapshot('route-subagent-backgrounded')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
    expect(sdkSubagentTools(tools).at(-1)?.detail).toMatchObject({
      meta: {
        provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
        backgrounded: true,
        active: true,
        terminal: false,
      },
    });
  });

  it('stops active Claude tasks through SDK stopTask before local cancellation state', async () => {
    vi.useFakeTimers();
    sdkMock.setWaitForClose(true);
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-cancel-after-result', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-cancel-after-result',
        uuid: 'uuid-task-cancel-after-result',
        task_id: 'task-cancel-after-result',
        tool_use_id: 'tool-use-cancel-after-result',
        description: 'Run a background task that will be stopped later',
      },
      { type: 'result', session_id: 'session-route-subagent-cancel-after-result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-cancel-after-result',
      sessionName: 'deck_project_claude_cancel_after_result',
      cwd: '/tmp/project',
      resumeId: 'session-route-subagent-cancel-after-result',
    });
    const tools: ToolCallEvent[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('route-subagent-cancel-after-result', 'hello');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getActiveWorkSnapshot('route-subagent-cancel-after-result')).toMatchObject({
      activeWorkCount: 1,
      activeToolCount: 0,
      busyReasons: ['background_monitor'],
    });

    await provider.cancel('route-subagent-cancel-after-result');
    await vi.advanceTimersByTimeAsync(0);

    expect(sdkMock.runs[0]?.stoppedTasks).toEqual(['task-cancel-after-result']);
    expect(provider.getActiveWorkSnapshot('route-subagent-cancel-after-result')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
    const cancelledTerminal = sdkSubagentTools(tools).at(-1);
    expect(cancelledTerminal).toMatchObject({
      id: makeClaudeSubagentCanonicalKey('deck_project_claude_cancel_after_result', 'task-cancel-after-result'),
      status: 'error',
      detail: {
        meta: {
          rawStatus: 'interrupted',
          normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED,
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('keeps a stopped-task notification alive until the retained parent reports it', async () => {
    sdkMock.setWaitForClose(true);
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-stopped-notification', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-stopped-notification',
        uuid: 'uuid-task-stopped-notification-start',
        task_id: 'task-stopped-notification',
        tool_use_id: 'tool-use-stopped-notification',
        description: 'Run a background task that stops after the foreground result',
      },
      {
        type: 'assistant', session_id: 'session-route-subagent-stopped-notification', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Foreground done' }], stop_reason: 'end_turn' },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'session-route-subagent-stopped-notification',
        uuid: 'uuid-task-stopped-notification',
        task_id: 'task-stopped-notification',
        status: 'stopped',
        summary: 'Background task stopped',
      },
      {
        type: 'user', session_id: 'session-route-subagent-stopped-notification', parent_tool_use_id: null,
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'The background task stopped.' },
      },
      {
        type: 'stream_event', session_id: 'session-route-subagent-stopped-notification', parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'message-stopped-task-wake' } },
      },
      {
        type: 'stream_event', session_id: 'session-route-subagent-stopped-notification', parent_tool_use_id: null,
        event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'Stopped task reported to parent' },
        },
      },
      {
        type: 'stream_event', session_id: 'session-route-subagent-stopped-notification', parent_tool_use_id: null,
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      },
    ]);

    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-stopped-notification',
      sessionName: 'deck_project_claude_stopped_notification',
      cwd: '/tmp/project',
      resumeId: 'session-route-subagent-stopped-notification',
    });
    const completed: AgentMessage[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg));
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('route-subagent-stopped-notification', 'hello');

    await vi.waitFor(() => {
      expect(sdkMock.runs[0]?.closed).toBe(true);
      expect(completed.map((msg) => msg.content)).toEqual(['Foreground done', 'Stopped task reported to parent']);
    });
    expect(provider.getActiveWorkSnapshot('route-subagent-stopped-notification')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
    expect(sdkSubagentTools(tools).at(-1)).toMatchObject({
      id: makeClaudeSubagentCanonicalKey('deck_project_claude_stopped_notification', 'task-stopped-notification'),
      status: 'error',
      detail: {
        meta: {
          rawStatus: 'stopped',
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('ignores task-notification result messages as foreground completions', async () => {
    const provider = new ClaudeCodeSdkProvider();
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: 'session-task-notification-result', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-task-notification-result',
        uuid: 'uuid-task-notification-result-start',
        task_id: 'task-notification-result',
        tool_use_id: 'tool-use-task-notification-result',
        description: 'Run verification',
      },
      { type: 'result', session_id: 'session-task-notification-result', subtype: 'success', is_error: false, result: 'Main turn complete', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'session-task-notification-result',
        uuid: 'uuid-task-notification-result',
        task_id: 'task-notification-result',
        status: 'completed',
        summary: 'Background task complete',
      },
      {
        type: 'result',
        session_id: 'session-task-notification-result',
        subtype: 'success',
        is_error: false,
        result: 'Synthetic task notification follow-up',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        origin: { kind: 'task-notification' },
      },
    ]);

    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-task-notification-result',
      sessionName: 'deck_project_claude_task_notification_result',
      cwd: '/tmp/project',
      resumeId: 'session-task-notification-result',
    });
    const completed: AgentMessage[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg));
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('route-task-notification-result', 'hello');
    await flush();

    expect(completed.map((msg) => msg.content)).toEqual(['Main turn complete']);
    expect(sdkSubagentTools(tools).at(-1)).toMatchObject({
      id: makeClaudeSubagentCanonicalKey('deck_project_claude_task_notification_result', 'task-notification-result'),
      status: 'complete',
      output: 'Background task complete',
    });
  });

  it('emits SDK subagent snapshots for Claude runtime subagent notifications', async () => {
    const sessionName = 'deck_project_claude_runtime';
    const agentPath = '019e7f1c-cc';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-runtime', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'subagent_notification',
        session_id: 'session-route-subagent-runtime',
        agent_path: agentPath,
        status: 'running',
        name: 'Hooke',
        prompt: 'Wait for the read-only sync worker',
        is_backgrounded: true,
      },
      {
        type: 'system',
        subtype: 'subagent_status',
        session_id: 'session-route-subagent-runtime',
        subagent: {
          agentPath: agentPath,
          status: { completed: 'Completed the read-only sync wait. No files modified.' },
          nickname: 'Hooke',
        },
      },
      { type: 'result', session_id: 'session-route-subagent-runtime', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-runtime', sessionName);

    const subagents = sdkSubagentTools(tools);
    const canonicalKey = makeClaudeSubagentCanonicalKey(sessionName, `runtime:${agentPath}`);
    expect(subagents).toHaveLength(2);
    expect(subagents[0]).toMatchObject({
      id: canonicalKey,
      name: 'Agent',
      status: 'running',
      input: {
        action: 'claude-runtime-subagent',
        description: 'Wait for the read-only sync worker',
      },
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        summary: 'Claude sub-agent Hooke',
        input: {
          action: 'claude-runtime-subagent',
          description: 'Wait for the read-only sync worker',
        },
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
          canonicalKey,
          agentPath,
          agentName: 'Hooke',
          rawStatus: 'running',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          backgrounded: true,
        },
      },
    });
    expect(subagents[1]).toMatchObject({
      id: canonicalKey,
      name: 'Agent',
      status: 'complete',
      output: 'Completed the read-only sync wait. No files modified.',
      detail: {
        output: 'Completed the read-only sync wait. No files modified.',
        meta: {
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
          canonicalKey,
          rawStatus: 'completed',
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('emits SDK subagent snapshots for raw Claude runtime subagent notification tags', async () => {
    const sessionName = 'deck_project_claude_runtime_tag';
    const agentPath = '019e7f1c-cc-raw';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-runtime-tag', model: 'claude-sonnet-4-6' },
      {
        type: 'assistant',
        session_id: 'session-route-subagent-runtime-tag',
        message: {
          content: [{
            type: 'text',
            text: `<subagent_notification>{"agent_path":"${agentPath}","status":"running"}</subagent_notification>`,
          }],
        },
      },
      { type: 'result', session_id: 'session-route-subagent-runtime-tag', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-runtime-tag', sessionName);

    const [tool] = sdkSubagentTools(tools);
    const canonicalKey = makeClaudeSubagentCanonicalKey(sessionName, `runtime:${agentPath}`);
    expect(tool).toMatchObject({
      id: canonicalKey,
      name: 'Agent',
      status: 'running',
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        summary: `Claude sub-agent ${agentPath}`,
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
          canonicalKey,
          agentPath,
          rawStatus: 'running',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
        },
      },
    });
  });

  it('diagnoses Claude runtime subagent notifications without an agent id', async () => {
    const sessionName = 'deck_project_claude_runtime_missing_id';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-runtime-missing-id', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'subagent_notification',
        session_id: 'session-route-subagent-runtime-missing-id',
        status: 'running',
      },
      { type: 'result', session_id: 'session-route-subagent-runtime-missing-id', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-runtime-missing-id', sessionName);

    const [tool] = sdkSubagentTools(tools);
    expect(tool).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'runtime:subagent_notification'),
      name: 'Agent',
      status: 'error',
      detail: {
        meta: {
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
          normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
          active: false,
          terminal: true,
          diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID,
        },
      },
    });
  });

  it('emits detail-only Claude task_progress updates instead of generic tool dedup dropping them', async () => {
    const sessionName = 'deck_project_claude_progress';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-progress', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-progress',
        uuid: 'uuid-task-progress-start',
        task_id: 'task-progress-1',
        tool_use_id: 'tool-use-agent-progress',
        description: 'Analyze the provider',
      },
      {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'session-route-subagent-progress',
        uuid: 'uuid-task-progress',
        task_id: 'task-progress-1',
        tool_use_id: 'tool-use-agent-progress',
        description: 'Analyze the provider',
        summary: 'Reading task lifecycle messages',
        usage: { total_tokens: 42, tool_uses: 2, duration_ms: 3000 },
        last_tool_name: 'Read',
      },
      { type: 'result', session_id: 'session-route-subagent-progress', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-progress', sessionName);

    const subagents = sdkSubagentTools(tools);
    expect(subagents).toHaveLength(2);
    expect(subagents[1]?.id).toBe(makeClaudeSubagentCanonicalKey(sessionName, 'task-progress-1'));
    expect(subagents[1]?.detail).toMatchObject({
      summary: 'Reading task lifecycle messages',
      meta: {
        usageTotalTokens: 42,
        usageToolUses: 2,
        usageDurationMs: 3000,
        lastToolName: 'Read',
      },
    });
  });

  it('creates a running SDK subagent row when Claude task_progress arrives before start', async () => {
    const sessionName = 'deck_project_claude_progress_first';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-progress-first', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'session-route-subagent-progress-first',
        uuid: 'uuid-task-progress-first',
        task_id: 'task-progress-first',
        tool_use_id: 'tool-use-progress-first',
        description: 'Searching the repo',
        summary: 'Searching for handlers',
        usage: { total_tokens: 5, tool_uses: 1, duration_ms: 100 },
      },
      { type: 'result', session_id: 'session-route-subagent-progress-first', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-progress-first', sessionName);

    expect(sdkSubagentTools(tools)).toHaveLength(1);
    expect(sdkSubagentTools(tools)[0]).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'task-progress-first'),
      status: 'running',
      detail: {
        meta: {
          taskId: 'task-progress-first',
          parentToolUseId: 'tool-use-progress-first',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
        },
      },
    });
  });

  it('merges Claude task_updated by task_id when tool_use_id is absent', async () => {
    const sessionName = 'deck_project_claude_update';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-update', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-update',
        uuid: 'uuid-task-update-start',
        task_id: 'task-update-1',
        tool_use_id: 'tool-use-update-original',
        description: 'Inspect implementation',
      },
      {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'session-route-subagent-update',
        uuid: 'uuid-task-update',
        task_id: 'task-update-1',
        patch: { description: 'Inspect implementation and tests' },
      },
      { type: 'result', session_id: 'session-route-subagent-update', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-update', sessionName);

    const subagents = sdkSubagentTools(tools);
    expect(subagents).toHaveLength(2);
    expect(new Set(subagents.map((tool) => tool.id))).toEqual(new Set([makeClaudeSubagentCanonicalKey(sessionName, 'task-update-1')]));
    expect(subagents[0]?.detail).toMatchObject({
      meta: { parentToolUseId: 'tool-use-update-original' },
    });
    expect(subagents.at(-1)?.detail).toMatchObject({
      input: {
        action: 'claude-task',
        description: 'Inspect implementation and tests',
      },
      meta: { parentToolUseId: 'tool-use-update-original' },
    });
  });

  it('emits a terminal complete SDK subagent snapshot for Claude task_notification completed', async () => {
    const sessionName = 'deck_project_claude_complete';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-complete', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-complete',
        uuid: 'uuid-task-complete-start',
        task_id: 'task-complete-1',
        tool_use_id: 'tool-use-complete',
        description: 'Run verification',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'session-route-subagent-complete',
        uuid: 'uuid-task-complete',
        task_id: 'task-complete-1',
        status: 'completed',
        output_file: '/tmp/full-output.log',
        summary: 'Verification passed',
        usage: { total_tokens: 100, tool_uses: 3, duration_ms: 7000 },
      },
      { type: 'result', session_id: 'session-route-subagent-complete', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-complete', sessionName);

    const terminal = sdkSubagentTools(tools).at(-1);
    expect(terminal).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'task-complete-1'),
      status: 'complete',
      output: 'Verification passed',
      detail: {
        meta: {
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
          parentToolUseId: 'tool-use-complete',
        },
      },
    });
    expect(JSON.stringify(terminal?.input ?? null)).not.toContain('/tmp/full-output.log');
  });

  it.each(['failed', 'stopped', 'killed'] as const)('emits terminal error SDK subagent snapshots for Claude task_notification %s', async (status) => {
    const sessionName = `deck_project_claude_${status}`;
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: `session-route-subagent-${status}`, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: `session-route-subagent-${status}`,
        uuid: `uuid-task-${status}-start`,
        task_id: `task-${status}-1`,
        description: 'Attempt delegated work',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: `session-route-subagent-${status}`,
        uuid: `uuid-task-${status}`,
        task_id: `task-${status}-1`,
        status,
        output_file: '/tmp/full-output.log',
        summary: `Task ${status}`,
      },
      { type: 'result', session_id: `session-route-subagent-${status}`, subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], `route-subagent-${status}`, sessionName);

    expect(sdkSubagentTools(tools).at(-1)).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, `task-${status}-1`),
      status: 'error',
      detail: {
        meta: {
          rawStatus: status,
          normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('emits terminal interrupted SDK subagent snapshots for Claude task_notification interrupted', async () => {
    const sessionName = 'deck_project_claude_interrupted';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-interrupted', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-interrupted',
        uuid: 'uuid-task-interrupted-start',
        task_id: 'task-interrupted-1',
        description: 'Attempt delegated work',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'session-route-subagent-interrupted',
        uuid: 'uuid-task-interrupted',
        task_id: 'task-interrupted-1',
        status: 'interrupted',
        summary: 'Task interrupted',
      },
      { type: 'result', session_id: 'session-route-subagent-interrupted', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-interrupted', sessionName);

    expect(sdkSubagentTools(tools).at(-1)).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'task-interrupted-1'),
      status: 'error',
      detail: {
        meta: {
          rawStatus: 'interrupted',
          normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED,
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('does not let late Claude progress return a terminal task to running', async () => {
    const sessionName = 'deck_project_claude_late';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-late', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-late',
        uuid: 'uuid-task-late-start',
        task_id: 'task-late-1',
        description: 'Do delegated work',
      },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'session-route-subagent-late',
        uuid: 'uuid-task-late-complete',
        task_id: 'task-late-1',
        status: 'completed',
        output_file: '/tmp/full-output.log',
        summary: 'Delegated work finished',
      },
      {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'session-route-subagent-late',
        uuid: 'uuid-task-late-progress',
        task_id: 'task-late-1',
        description: 'Do delegated work',
        summary: 'Late progress detail',
        usage: { total_tokens: 150, tool_uses: 4, duration_ms: 9000 },
      },
      { type: 'result', session_id: 'session-route-subagent-late', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-late', sessionName);

    const latest = sdkSubagentTools(tools).at(-1);
    expect(sdkSubagentTools(tools)).toHaveLength(3);
    expect(latest).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'task-late-1'),
      status: 'complete',
      detail: {
        summary: 'Late progress detail',
        meta: {
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
          usageTotalTokens: 150,
        },
      },
    });
  });

  it('emits a diagnostic SDK subagent event when a Claude task message is missing task_id', async () => {
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-missing-id', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'session-route-subagent-missing-id',
        uuid: 'uuid-task-missing-id',
        description: 'No task id here',
        usage: { total_tokens: 1, tool_uses: 0, duration_ms: 10 },
      },
      { type: 'result', session_id: 'session-route-subagent-missing-id', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-missing-id');

    expect(sdkSubagentTools(tools)).toHaveLength(1);
    expect(sdkSubagentTools(tools)[0]).toMatchObject({
      status: 'error',
      output: 'Claude task_progress message was missing task_id',
      detail: {
        meta: {
          diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID,
          normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
          active: false,
          terminal: true,
        },
      },
    });
  });

  it('redacts prompt-like diagnostic raw fields and keeps them out of normal summaries', async () => {
    const secret = 'SECRET_CHILD_PROMPT_DO_NOT_STORE';
    const { tools } = await collectToolsForMessages([
      { type: 'system', subtype: 'init', session_id: 'session-route-subagent-redact', model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'session-route-subagent-redact',
        uuid: 'uuid-task-redact',
        childPrompt: secret,
        messages: [{ content: secret }],
        token: secret,
      },
      { type: 'result', session_id: 'session-route-subagent-redact', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-redact');

    const [diagnostic] = sdkSubagentTools(tools);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(diagnostic?.detail?.raw).toMatchObject({
      childPrompt: '[REDACTED]',
      messages: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('keeps generic Claude Agent tool events separate from SDK subagent task rows', async () => {
    const sessionName = 'deck_project_claude_generic_agent';
    const { tools } = await collectToolsForMessages([
      {
        type: 'assistant',
        session_id: 'session-route-subagent-generic-agent',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-agent-generic', name: 'Agent', input: { description: 'Legacy Agent tool' } },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        session_id: 'session-route-subagent-generic-agent',
        uuid: 'uuid-task-generic-agent',
        task_id: 'task-generic-agent',
        tool_use_id: 'tool-agent-generic',
        description: 'Structured SDK task',
      },
      { type: 'result', session_id: 'session-route-subagent-generic-agent', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ], 'route-subagent-generic-agent', sessionName);

    const genericAgent = tools.find((tool) => tool.id === 'tool-agent-generic');
    const subagents = sdkSubagentTools(tools);
    const runtimeAgent = subagents.find((tool) => tool.id === makeClaudeSubagentCanonicalKey(sessionName, 'runtime:tool-agent-generic'));
    const structuredTask = subagents.find((tool) => tool.id === makeClaudeSubagentCanonicalKey(sessionName, 'task-generic-agent'));
    expect(genericAgent).toMatchObject({
      id: 'tool-agent-generic',
      name: 'Agent',
      status: 'running',
      detail: { kind: 'tool_use' },
    });
    expect(runtimeAgent).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'runtime:tool-agent-generic'),
      status: 'running',
      input: {
        action: 'claude-agent-tool',
        description: 'Legacy Agent tool',
      },
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        input: {
          action: 'claude-agent-tool',
          description: 'Legacy Agent tool',
        },
        meta: {
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
          agentPath: 'tool-agent-generic',
          parentToolUseId: 'tool-agent-generic',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
        },
      },
    });
    expect(structuredTask).toMatchObject({
      id: makeClaudeSubagentCanonicalKey(sessionName, 'task-generic-agent'),
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        meta: { parentToolUseId: 'tool-agent-generic' },
      },
    });
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
