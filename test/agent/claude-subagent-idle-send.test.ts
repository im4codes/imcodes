import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: while ONLY a subagent was running, a message could not be sent in.
 *
 * A Task subagent runs INSIDE the parent query, and closeSettledBackgroundQuery
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

const sdkMock = vi.hoisted(() => {
  let nextMessages: any[] = [];
  const runs: Array<{ prompt: unknown; options: Record<string, unknown>; closed: boolean }> = [];
  const query = vi.fn(({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const run = { prompt, options, closed: false };
    runs.push(run);
    async function* gen() {
      for (const message of nextMessages) yield message;
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
    reset() { runs.length = 0; nextMessages = []; query.mockClear(); },
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
  // Foreground turn settles (result) but a task_notification leaves a subagent
  // active → the query stays open. This is the bug window.
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
      type: 'result',
      session_id: SESSION,
      subtype: 'success',
      is_error: false,
      result: 'Foreground done',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
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
});
