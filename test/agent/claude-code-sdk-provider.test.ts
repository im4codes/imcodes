import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb?.(null, 'ok\n', '');
    return {} as never;
  }),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
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
    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));

    await provider.send('route-1', 'hello');
    await flush();

    const run = sdkMock.runs[0];
    expect(run.options.sessionId).toBe('session-1');
    expect(run.options.resume).toBeUndefined();
    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);
    expect(sessionInfo.some((info) => info.resumeId === 'session-1')).toBe(true);
    expect(sessionInfo.some((info) => info.model === 'claude-sonnet-4-6')).toBe(true);
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
});
