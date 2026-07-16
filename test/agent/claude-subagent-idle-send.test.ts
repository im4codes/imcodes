import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';

/**
 * Regression: while ONLY a subagent was running, a message could not be sent in.
 *
 * A Task subagent runs INSIDE the parent query, and closeSettledQueryIfNoSubagents
 * deliberately holds that query open while subagents are active. But `send()`
 * rejected with "already busy" whenever `currentQuery` existed, so the exact
 * window where the main agent is idle-but-waiting was also the window where no
 * message could get in. `/stop` was the only way through, and it closes the query
 * — killing the subagent with it.
 *
 * Fix: drive the SDK in streaming-input mode (`prompt: AsyncIterable`) and, in
 * that subagent-only window, push the message into the LIVE query instead of
 * rejecting it. These tests pin both the new behaviour and the guard that the
 * old rejection still applies while the main turn is genuinely running.
 */

// The provider resolves + spawns the `claude` binary. CI runners have no
// `claude` on PATH (a dev box running Claude Code does), so without this the
// suite passes locally and dies with `spawn claude ENOENT` in CI. Mirrors the
// mock in claude-code-sdk-provider.test.ts.
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

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sdkMock = vi.hoisted(() => {
  let nextMessages: any[] = [];
  let nextRunMessages: any[][] = [];
  const runs: Array<{ prompt: unknown; options: Record<string, unknown>; closed: boolean }> = [];
  const query = vi.fn(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const run = { prompt, options, closed: false };
    runs.push(run);
    const runMessages = nextRunMessages.shift() ?? nextMessages;
    async function* gen() {
      for (const pendingMessage of runMessages) {
        const message = await pendingMessage;
        if (message?.__end === true) return;
        yield message;
      }
      // Never end: mirrors a query held open while subagents run.
      await new Promise<void>(() => {});
    }
    const iterator: any = gen();
    iterator.close = () => { run.closed = true; };
    iterator.interrupt = async () => {};
    iterator.stopTask = async () => {};
    return iterator;
  });
  return {
    query,
    runs,
    setNextMessages(messages: any[]) { nextMessages = messages; },
    setNextRunMessages(messages: any[][]) { nextRunMessages = messages; },
    reset() { runs.length = 0; nextMessages = []; nextRunMessages = []; query.mockClear(); },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkMock.query,
}));

const { ClaudeCodeSdkProvider } = await import('../../src/agent/providers/claude-code-sdk.js');

/** Drain the texts the SDK would read off the provider's streaming-input queue. */
function queuedTexts(prompt: unknown): string[] {
  const buffer = (prompt as { buffer?: Array<{ message?: { content?: unknown } }> })?.buffer ?? [];
  return buffer
    .map((entry) => entry?.message?.content)
    .filter((content): content is string => typeof content === 'string');
}

const SESSION = 'session-subagent-idle-send';

async function startSessionWithActiveSubagent() {
  // The parent reaches an explicit end_turn while a task_notification leaves a
  // subagent active → the query stays open. This is the bug window.
  sdkMock.setNextMessages([
    { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
    {
      type: 'system',
      subtype: 'task_notification',
      session_id: SESSION,
      uuid: 'uuid-task-start',
      task_id: 'task-1',
      tool_use_id: 'tool-use-1',
      description: 'Long running subagent',
    },
    {
      type: 'assistant',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: 'Foreground done' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        stop_reason: 'end_turn',
      },
    },
  ]);

  const provider = new ClaudeCodeSdkProvider();
  await provider.connect({ binaryPath: 'claude' });
  await provider.createSession({
    sessionKey: 'route-subagent-idle-send',
    sessionName: 'deck_project_claude_subagent_idle',
    cwd: '/tmp/project',
    resumeId: SESSION,
  } as never);
  await provider.send('route-subagent-idle-send', 'kick off the subagent');
  // Let the mocked stream drain into the provider.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return provider;
}

beforeEach(() => sdkMock.reset());

describe('claude-code-sdk — sending while only a subagent runs', () => {
  it('drives the SDK in streaming-input mode (prompt is an async iterable, not a string)', async () => {
    const provider = await startSessionWithActiveSubagent();
    const prompt = sdkMock.runs[0]?.prompt;
    expect(typeof prompt).not.toBe('string');
    expect(typeof (prompt as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator]).toBe('function');
    // The first user message still reaches the SDK unchanged.
    expect(queuedTexts(prompt)).toContain('kick off the subagent');
    await provider.endSession('route-subagent-idle-send');
  });

  it('delivers a message into the LIVE query instead of rejecting it (no second query, subagent survives)', async () => {
    const provider = await startSessionWithActiveSubagent();
    expect(sdkMock.runs).toHaveLength(1);

    // The bug: this used to throw "Claude SDK session is already busy".
    await expect(provider.send('route-subagent-idle-send', 'follow-up while subagent runs')).resolves.toBeUndefined();

    // No new query was started → the running subagent is untouched, and the
    // message landed on the existing query's input channel.
    expect(sdkMock.runs).toHaveLength(1);
    expect(sdkMock.runs[0]?.closed).toBe(false);
    expect(queuedTexts(sdkMock.runs[0]?.prompt)).toContain('follow-up while subagent runs');
    await provider.endSession('route-subagent-idle-send');
  });

  it('still rejects as busy while the main turn is genuinely running (no result yet)', async () => {
    // No result message → state.completed stays false → not the subagent-only window.
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        uuid: 'uuid-task-start',
        task_id: 'task-1',
        tool_use_id: 'tool-use-1',
        description: 'Subagent inside a still-running turn',
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-busy',
      sessionName: 'deck_project_claude_subagent_busy',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-subagent-busy', 'first');
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(provider.send('route-subagent-busy', 'second')).rejects.toThrow(/already busy/i);
    expect(sdkMock.runs).toHaveLength(1);
    await provider.endSession('route-subagent-busy');
  });

  it('settles a text-only foreground reply when active subagents keep the SDK query open without a result', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-no-result',
        tool_use_id: 'tool-no-result',
        description: 'Background work survives the foreground reply',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        message: {
          content: [{ type: 'text', text: 'Foreground is done; the background task is still running.' }],
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0 },
          stop_reason: 'end_turn',
        },
      },
      // Intentionally no result: this is the live production failure mode.
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-no-result',
      sessionName: 'deck_project_claude_subagent_no_result',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-subagent-no-result', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual(['Foreground is done; the background task is still running.']);
    expect(provider.getActiveWorkSnapshot('route-subagent-no-result')?.backgroundWorkCount).toBe(1);
    await expect(provider.send('route-subagent-no-result', 'follow-up after visible completion')).resolves.toBeUndefined();
    expect(sdkMock.runs).toHaveLength(1);
    expect(queuedTexts(sdkMock.runs[0]?.prompt)).toContain('follow-up after visible completion');
    await provider.endSession('route-subagent-no-result');
  });

  it('does not settle an assistant response that contains a foreground tool call', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-tool-follows',
        tool_use_id: 'tool-task-follows',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        message: {
          content: [
            { type: 'text', text: 'I will inspect one more thing.' },
            { type: 'tool_use', id: 'bash-after-text', name: 'Bash', input: { command: 'true' } },
          ],
          stop_reason: 'tool_use',
        },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-tool-after-text',
      sessionName: 'deck_project_claude_subagent_tool_after_text',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-subagent-tool-after-text', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual([]);
    await expect(provider.send('route-subagent-tool-after-text', 'must remain queued/busy')).rejects.toThrow(/already busy/i);
    await provider.endSession('route-subagent-tool-after-text');
  });

  it('does not treat a child-agent assistant message as the parent foreground boundary', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-child-text',
        tool_use_id: 'tool-child-text',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        parent_tool_use_id: 'tool-child-text',
        message: { content: [{ type: 'text', text: 'Child agent progress is not parent completion.' }], stop_reason: 'end_turn' },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-child-text',
      sessionName: 'deck_project_claude_subagent_child_text',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-subagent-child-text', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual([]);
    await provider.endSession('route-subagent-child-text');
  });

  it('settles the parent end_turn even while its Agent tool remains represented as an active child', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-agent-tool-active', tool_use_id: 'agent-tool-active', description: 'Background child',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'agent-tool-active', name: 'Agent', input: { description: 'Background child' } }],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Parent is done while the child continues.' }], stop_reason: 'end_turn' },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-parent-done-agent-active',
      sessionName: 'deck_project_parent_done_agent_active',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-parent-done-agent-active', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual(['Parent is done while the child continues.']);
    expect(provider.getActiveWorkSnapshot('route-parent-done-agent-active')?.backgroundWorkCount).toBe(1);
    await provider.endSession('route-parent-done-agent-active');
  });

  it('keeps task-notification result frames separate from foreground completion', async () => {
    const taskNotificationResult = new Promise((resolve) => setTimeout(() => resolve({
      type: 'result',
      session_id: SESSION,
      subtype: 'success',
      is_error: false,
      result: 'task progress',
      origin: { kind: 'task-notification' },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    }), 100));
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-notification-during-grace',
        tool_use_id: 'tool-notification-during-grace',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Parent foreground is complete.' }], stop_reason: 'end_turn' },
      },
      taskNotificationResult,
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-task-notification-grace',
      sessionName: 'deck_project_task_notification_grace',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-task-notification-grace', 'start');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(completed).toEqual(['Parent foreground is complete.']);
    await provider.endSession('route-task-notification-grace');
  });

  it('requires an explicit terminal stop reason before treating text as a foreground boundary', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-no-end-turn',
        tool_use_id: 'tool-no-end-turn',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'A non-terminal text update.' }], stop_reason: null },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-no-end-turn',
      sessionName: 'deck_project_no_end_turn',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-no-end-turn', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual([]);
    await provider.endSession('route-no-end-turn');
  });

  it.each([
    { stopReason: 'max_tokens', text: 'Partial final answer.' },
    { stopReason: 'end_turn', text: '' },
  ])('settles retained terminal assistant messages with stop_reason=$stopReason and text=$text', async ({ stopReason, text }) => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: `task-terminal-${stopReason}-${text.length}`, tool_use_id: `tool-terminal-${stopReason}-${text.length}`,
        description: 'Background task',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: text ? [{ type: 'text', text }] : [], stop_reason: stopReason },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: `route-terminal-${stopReason}-${text.length}`,
      sessionName: `deck_project_terminal_${stopReason}_${text.length}`,
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send(`route-terminal-${stopReason}-${text.length}`, 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual([text]);
    await provider.endSession(`route-terminal-${stopReason}-${text.length}`);
  });

  it('drains a runtime-queued message through the real Claude provider after an end_turn boundary', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-runtime-drain',
        tool_use_id: 'tool-runtime-drain',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Foreground complete; retain child.' }], stop_reason: 'end_turn' },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    const runtime = new TransportSessionRuntime(provider, 'deck_runtime_soft_completion_drain');
    await runtime.initialize({
      sessionKey: 'route-runtime-soft-completion-drain',
      sessionName: 'deck_runtime_soft_completion_drain',
      cwd: '/tmp/project',
      resumeId: SESSION,
      startupMemoryAlreadyInjected: true,
    } as never);

    expect(runtime.send('/start-soft-boundary', 'runtime-soft-start')).toBe('sent');
    expect(runtime.send('/queued-soft-followup', 'runtime-soft-followup')).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    await vi.waitFor(() => expect(
      runtime.pendingCount,
      JSON.stringify(runtime.getDiagnosticSnapshot()),
    ).toBe(0), { timeout: 2_500, interval: 25 });
    expect(sdkMock.runs).toHaveLength(1);
    expect(queuedTexts(sdkMock.runs[0]?.prompt)).toContain('/queued-soft-followup');
    await runtime.kill();
  });

  it('keeps the real runtime idle and sends immediately while the child remains background work', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-runtime-idle', tool_use_id: 'tool-runtime-idle', description: 'Background task',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Foreground done; child remains active.' }], stop_reason: 'end_turn' },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    await provider.connect({ binaryPath: 'claude' });
    const runtime = new TransportSessionRuntime(provider, 'deck_runtime_subagent_background_idle');
    await runtime.initialize({
      sessionKey: 'route-runtime-subagent-background-idle',
      sessionName: 'deck_runtime_subagent_background_idle',
      cwd: '/tmp/project',
      resumeId: SESSION,
      startupMemoryAlreadyInjected: true,
    } as never);

    expect(runtime.send('/start-background-child', 'runtime-background-start')).toBe('sent');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 1_000, interval: 20 });
    const snapshot = provider.getActiveWorkSnapshot('route-runtime-subagent-background-idle');
    expect(snapshot?.backgroundWorkCount).toBe(1);
    expect(snapshot?.activeWorkCount).toBe(1);
    expect(runtime.send('/follow-up-must-not-queue', 'runtime-background-followup')).toBe('sent');
    expect(runtime.pendingCount).toBe(0);
    expect(sdkMock.runs).toHaveLength(1);
    await vi.waitFor(() => expect(
      queuedTexts(sdkMock.runs[0]?.prompt),
    ).toContain('/follow-up-must-not-queue'), { timeout: 1_000, interval: 10 });
    await runtime.kill();
  });

  it('keeps the retained query open so a terminal task notification can wake the parent agent', async () => {
    let resolveTaskFinished!: (message: unknown) => void;
    let resolveWokenTerminal!: (message: unknown) => void;
    const taskFinished = new Promise((resolve) => { resolveTaskFinished = resolve; });
    const wokenTerminal = new Promise((resolve) => { resolveWokenTerminal = resolve; });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-wakes-parent', tool_use_id: 'tool-wakes-parent', description: 'Background task',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Parent idle while child runs.' }], stop_reason: 'end_turn' },
      },
      taskFinished,
      {
        type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'message-task-wake-parent' } },
      },
      {
        type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
        event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'Child finished; parent woke and reported it.' },
        },
      },
      wokenTerminal,
      {
        // Some SDK versions also flush the full assistant frame after the
        // stream terminal. It must not duplicate the already-settled wake reply.
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Child finished; parent woke and reported it.' }],
          stop_reason: 'end_turn',
        },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_runtime_task_notification_wake');
    await provider.connect({ binaryPath: 'claude' });
    await runtime.initialize({
      sessionKey: 'route-runtime-task-notification-wake',
      sessionName: 'deck_runtime_task_notification_wake',
      cwd: '/tmp/project',
      resumeId: SESSION,
      startupMemoryAlreadyInjected: true,
    } as never);

    expect(runtime.send('/start-background-child', 'runtime-task-wake-start')).toBe('sent');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    expect(provider.getActiveWorkSnapshot('route-runtime-task-notification-wake')?.backgroundWorkCount).toBe(1);

    resolveTaskFinished({
      type: 'system', subtype: 'task_notification', session_id: SESSION,
      task_id: 'task-wakes-parent', tool_use_id: 'tool-wakes-parent',
      status: 'completed', summary: 'Background task finished', output_file: '/tmp/task-wakes-parent.output',
    });
    await vi.waitFor(() => expect(
      provider.getSessionDiagnostics('route-runtime-task-notification-wake')?.completed,
    ).toBe(false));
    expect(sdkMock.runs[0]?.closed).toBe(false);
    expect(provider.getSessionDiagnostics('route-runtime-task-notification-wake')?.currentQueryActive).toBe(true);
    expect(provider.getSessionDiagnostics('route-runtime-task-notification-wake')?.currentTextLength).toBe(44);

    resolveWokenTerminal({
      type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    });
    await vi.waitFor(() => expect(runtime.getHistory().filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([
      'Parent idle while child runs.',
      'Child finished; parent woke and reported it.',
    ]));
    expect(runtime.getStatus()).toBe('idle');
    expect(sdkMock.runs[0]?.closed).toBe(true);
    expect(provider.getSessionDiagnostics('route-runtime-task-notification-wake')?.currentQueryActive).toBe(false);
    await runtime.kill();
  });

  it('falls back to one retained-query wake for duplicate stale terminals that emit no native continuation', async () => {
    let resolveTaskStale!: (message: unknown) => void;
    let resolveFallbackAssistant!: (message: unknown) => void;
    const taskStale = new Promise((resolve) => { resolveTaskStale = resolve; });
    const fallbackAssistant = new Promise((resolve) => { resolveFallbackAssistant = resolve; });
    const staleNotification = {
      type: 'system', subtype: 'task_notification', session_id: SESSION,
      task_id: 'task-stale-no-native-wake', tool_use_id: 'tool-stale-no-native-wake',
      status: 'stale', summary: 'Background task became stale', output_file: '/tmp/task-stale.output',
    };
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-stale-no-native-wake', tool_use_id: 'tool-stale-no-native-wake',
        description: 'Background task that will become stale',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Parent idle before stale terminal.' }], stop_reason: 'end_turn' },
      },
      taskStale,
      // Provider replay of the identical terminal must not arm a second wake.
      staleNotification,
      // A delayed full frame from the already-settled predecessor is not proof
      // that the task notification woke a new assistant continuation.
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Parent idle before stale terminal.' }], stop_reason: 'end_turn' },
      },
      fallbackAssistant,
      {
        type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
        event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'Parent reported stale child once.' },
        },
      },
      {
        type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
        event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_runtime_task_stale_fallback');
    await provider.connect({ binaryPath: 'claude' });
    await runtime.initialize({
      sessionKey: 'route-runtime-task-stale-fallback',
      sessionName: 'deck_runtime_task_stale_fallback',
      cwd: '/tmp/project',
      resumeId: SESSION,
      startupMemoryAlreadyInjected: true,
    } as never);

    expect(runtime.send('/start-stale-background-child', 'runtime-task-stale-start')).toBe('sent');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    resolveTaskStale(staleNotification);

    await vi.waitFor(() => {
      const fallbacks = queuedTexts(sdkMock.runs[0]?.prompt)
        .filter((text) => text.includes('# IM.codes background task completion'));
      expect(fallbacks).toHaveLength(1);
    }, { timeout: 3_000 });
    expect(provider.getSessionDiagnostics('route-runtime-task-stale-fallback')?.completed).toBe(false);

    resolveFallbackAssistant({
      type: 'stream_event', session_id: SESSION, parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'message-stale-fallback' } },
    });
    await vi.waitFor(() => expect(runtime.getHistory().filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([
      'Parent idle before stale terminal.',
      'Parent reported stale child once.',
    ]));
    expect(runtime.getStatus()).toBe('idle');
    expect(sdkMock.runs[0]?.closed).toBe(true);
    await runtime.kill();
  });

  it('keeps the real runtime stably idle after a terminal foreground with no subagent or result', async () => {
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Standalone foreground done.' }], stop_reason: 'end_turn' },
      },
      // Intentionally no result frame. The terminal assistant is authoritative.
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_runtime_standalone_idle');
    await provider.connect({ binaryPath: 'claude' });
    await runtime.initialize({
      sessionKey: 'route-runtime-standalone-idle',
      sessionName: 'deck_runtime_standalone_idle',
      cwd: '/tmp/project',
      resumeId: SESSION,
      startupMemoryAlreadyInjected: true,
    } as never);

    expect(runtime.send('/standalone-first', 'runtime-standalone-first')).toBe('sent');
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 1_000, interval: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.getStatus()).toBe('idle');
    expect(provider.getActiveWorkSnapshot('route-runtime-standalone-idle')).toMatchObject({
      activeWorkCount: 0,
      backgroundWorkCount: 0,
    });

    expect(runtime.send('/standalone-follow-up', 'runtime-standalone-followup')).toBe('sent');
    expect(runtime.pendingCount).toBe(0);
    await vi.waitFor(() => expect(sdkMock.runs).toHaveLength(2), { timeout: 1_000, interval: 10 });
    await runtime.kill();
  });

  it('rejects buffered frames from a closed no-subagent iterator after the next query starts', async () => {
    let resolveOldResult!: (message: unknown) => void;
    let resolveSecondAssistant!: (message: unknown) => void;
    const oldResult = new Promise((resolve) => { resolveOldResult = resolve; });
    const secondAssistant = new Promise((resolve) => { resolveSecondAssistant = resolve; });
    sdkMock.setNextRunMessages([
      [
        { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
        {
          type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: 'First standalone completion.' }], stop_reason: 'end_turn' },
        },
        oldResult,
      ],
      [
        { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
        secondAssistant,
      ],
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-stale-closed-iterator',
      sessionName: 'deck_project_stale_closed_iterator',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);

    await provider.send('route-stale-closed-iterator', 'first');
    await vi.waitFor(() => expect(completed).toEqual(['First standalone completion.']));
    await provider.send('route-stale-closed-iterator', 'second');
    await vi.waitFor(() => expect(sdkMock.runs).toHaveLength(2));

    resolveOldResult({
      type: 'result', session_id: SESSION, subtype: 'success', is_error: false,
      result: 'First standalone completion.',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['First standalone completion.']);
    expect(provider.getSessionDiagnostics('route-stale-closed-iterator')?.currentQueryActive).toBe(true);

    resolveSecondAssistant({
      type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Second standalone completion.' }], stop_reason: 'end_turn' },
    });
    await vi.waitFor(() => expect(completed).toEqual([
      'First standalone completion.',
      'Second standalone completion.',
    ]));
    await provider.endSession('route-stale-closed-iterator');
  });

  it('ignores all delayed success results after switching to retained-subagent completion boundaries', async () => {
    let resolveFollowupAssistant!: (message: unknown) => void;
    let resolveLateResult!: (message: unknown) => void;
    let resolveFollowupResult!: (message: unknown) => void;
    const followupAssistant = new Promise((resolve) => { resolveFollowupAssistant = resolve; });
    const lateResult = new Promise((resolve) => { resolveLateResult = resolve; });
    const followupResult = new Promise((resolve) => { resolveFollowupResult = resolve; });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-late-result',
        tool_use_id: 'tool-late-result',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        message: { content: [{ type: 'text', text: 'Visible completion.' }], stop_reason: 'end_turn' },
      },
      followupAssistant,
      lateResult,
      followupResult,
      { __end: true },
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-subagent-late-result',
      sessionName: 'deck_project_claude_subagent_late_result',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-subagent-late-result', 'start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['Visible completion.']);
    await provider.send('route-subagent-late-result', 'new foreground turn');
    resolveFollowupAssistant({
      type: 'assistant',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'New foreground completion.' }], stop_reason: 'end_turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['Visible completion.', 'New foreground completion.']);

    resolveLateResult({
      type: 'result',
      session_id: SESSION,
      subtype: 'success',
      is_error: false,
      result: 'Visible completion.',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['Visible completion.', 'New foreground completion.']);
    expect(provider.getActiveWorkSnapshot('route-subagent-late-result')?.backgroundWorkCount).toBe(1);

    resolveFollowupResult({
      type: 'result',
      session_id: SESSION,
      subtype: 'success',
      is_error: false,
      result: 'New foreground completion.',
      usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['Visible completion.', 'New foreground completion.']);
    await provider.endSession('route-subagent-late-result');
  });

  it('supports multiple foreground end_turn boundaries while one subagent query is retained', async () => {
    let resolveSecondAssistant!: (message: unknown) => void;
    let resolveFirstResult!: (message: unknown) => void;
    let resolveSecondResult!: (message: unknown) => void;
    const secondAssistant = new Promise((resolve) => { resolveSecondAssistant = resolve; });
    const firstResult = new Promise((resolve) => { resolveFirstResult = resolve; });
    const secondResult = new Promise((resolve) => { resolveSecondResult = resolve; });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system',
        subtype: 'task_notification',
        session_id: SESSION,
        task_id: 'task-multiple-soft-epochs',
        tool_use_id: 'tool-multiple-soft-epochs',
        description: 'Background task',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'First soft completion.' }], stop_reason: 'end_turn' },
      },
      secondAssistant,
      firstResult,
      secondResult,
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-multiple-soft-epochs',
      sessionName: 'deck_project_multiple_soft_epochs',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-multiple-soft-epochs', 'first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await provider.send('route-multiple-soft-epochs', 'second');
    resolveSecondAssistant({
      type: 'assistant',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Second soft completion.' }], stop_reason: 'end_turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['First soft completion.', 'Second soft completion.']);

    resolveFirstResult({
      type: 'result', session_id: SESSION, subtype: 'success', is_error: false,
      result: 'First soft completion.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['First soft completion.', 'Second soft completion.']);
    expect(provider.getActiveWorkSnapshot('route-multiple-soft-epochs')?.backgroundWorkCount).toBe(1);

    resolveSecondResult({
      type: 'result', session_id: SESSION, subtype: 'success', is_error: false,
      result: 'Second soft completion.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['First soft completion.', 'Second soft completion.']);
    await provider.endSession('route-multiple-soft-epochs');
  });

  it('completes and closes a retained query when its child finishes before the follow-up end_turn', async () => {
    let resolveTaskFinished!: (message: unknown) => void;
    let resolveFollowupAssistant!: (message: unknown) => void;
    const taskFinished = new Promise((resolve) => { resolveTaskFinished = resolve; });
    const followupAssistant = new Promise((resolve) => { resolveFollowupAssistant = resolve; });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-finishes-before-followup', tool_use_id: 'tool-finishes-before-followup', description: 'Background task',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'First foreground done.' }], stop_reason: 'end_turn' },
      },
      taskFinished,
      followupAssistant,
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-child-finishes-before-followup',
      sessionName: 'deck_project_child_finishes_before_followup',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-child-finishes-before-followup', 'first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await provider.send('route-child-finishes-before-followup', 'follow-up');

    resolveTaskFinished({
      type: 'system', subtype: 'task_notification', session_id: SESSION,
      task_id: 'task-finishes-before-followup', tool_use_id: 'tool-finishes-before-followup',
      status: 'completed', summary: 'Child finished',
    });
    resolveFollowupAssistant({
      type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Follow-up done after child.' }], stop_reason: 'end_turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual(['First foreground done.', 'Follow-up done after child.']);
    expect(sdkMock.runs[0]?.closed).toBe(true);
    expect(provider.getSessionDiagnostics('route-child-finishes-before-followup')?.currentQueryActive).toBe(false);
    await provider.endSession('route-child-finishes-before-followup');
  });

  it('does not let a predecessor result complete a follow-up after the last child drains', async () => {
    let resolveTaskFinished!: (message: unknown) => void;
    let resolvePredecessorResult!: (message: unknown) => void;
    let resolveFollowupAssistant!: (message: unknown) => void;
    const taskFinished = new Promise((resolve) => { resolveTaskFinished = resolve; });
    const predecessorResult = new Promise((resolve) => { resolvePredecessorResult = resolve; });
    const followupAssistant = new Promise((resolve) => { resolveFollowupAssistant = resolve; });
    sdkMock.setNextMessages([
      { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-4-6' },
      {
        type: 'system', subtype: 'task_notification', session_id: SESSION,
        task_id: 'task-drains-before-old-result', tool_use_id: 'tool-drains-before-old-result', description: 'Background task',
      },
      {
        type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Predecessor foreground done.' }], stop_reason: 'end_turn' },
      },
      taskFinished,
      predecessorResult,
      followupAssistant,
    ]);
    const provider = new ClaudeCodeSdkProvider();
    const completed: string[] = [];
    provider.onComplete((_sessionId, message) => completed.push(String(message.content)));
    await provider.connect({ binaryPath: 'claude' });
    await provider.createSession({
      sessionKey: 'route-drained-child-old-result',
      sessionName: 'deck_project_drained_child_old_result',
      cwd: '/tmp/project',
      resumeId: SESSION,
    } as never);
    await provider.send('route-drained-child-old-result', 'first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toEqual(['Predecessor foreground done.']);
    await provider.send('route-drained-child-old-result', 'follow-up');

    resolveTaskFinished({
      type: 'system', subtype: 'task_notification', session_id: SESSION,
      task_id: 'task-drains-before-old-result', tool_use_id: 'tool-drains-before-old-result',
      status: 'completed', summary: 'Child finished',
    });
    resolvePredecessorResult({
      type: 'result', session_id: SESSION, subtype: 'success', is_error: false,
      result: 'Predecessor foreground done.',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual(['Predecessor foreground done.']);
    expect(provider.getSessionDiagnostics('route-drained-child-old-result')?.currentQueryActive).toBe(true);

    resolveFollowupAssistant({
      type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Actual follow-up completion.' }], stop_reason: 'end_turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completed).toEqual(['Predecessor foreground done.', 'Actual follow-up completion.']);
    expect(sdkMock.runs[0]?.closed).toBe(true);
    expect(provider.getSessionDiagnostics('route-drained-child-old-result')?.currentQueryActive).toBe(false);
    await provider.endSession('route-drained-child-old-result');
  });
});
