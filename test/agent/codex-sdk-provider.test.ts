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

const codexMock = vi.hoisted(() => {
  const threads: Array<{ mode: 'start' | 'resume'; id: string | null; options: Record<string, unknown>; events: any[] }> = [];
  const Codex = vi.fn().mockImplementation(() => ({
    startThread: (options: Record<string, unknown>) => {
      const thread = { mode: 'start' as const, id: null, options, events: [] as any[] };
      threads.push(thread);
      return {
        get id() { return thread.id; },
        runStreamed: async () => ({ events: (async function* () { for (const event of thread.events) yield event; })() }),
      };
    },
    resumeThread: (id: string, options: Record<string, unknown>) => {
      const thread = { mode: 'resume' as const, id, options, events: [] as any[] };
      threads.push(thread);
      return {
        get id() { return thread.id; },
        runStreamed: async () => ({ events: (async function* () { for (const event of thread.events) yield event; })() }),
      };
    },
  }));
  return { Codex, threads };
});

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexMock.Codex,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CodexSdkProvider', () => {
  beforeEach(() => {
    codexMock.Codex.mockClear();
    codexMock.threads.length = 0;
  });

  it('starts a thread, captures resume id, emits tool calls, and completes from agent_message', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });

    const tools: string[] = [];
    const completed: string[] = [];
    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onToolCall((_, tool) => tools.push(`${tool.name}:${tool.status}`));
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));

    const sendPromise = provider.send('route-1', 'hello');
    const thread = codexMock.threads[0];
    thread.events.push(
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'OK' } },
      { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } },
    );
    await sendPromise;
    await flush();

    expect(tools).toEqual(['Bash:running', 'Bash:complete']);
    expect(completed).toEqual(['OK']);
    expect(sessionInfo).toContainEqual({ resumeId: 'thread-1' });
  });

  it('resumes with stored thread id on existing session', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-2', cwd: '/tmp/project', resumeId: 'thread-existing' });

    const sendPromise = provider.send('route-2', 'hello');
    const thread = codexMock.threads[0];
    expect(thread.mode).toBe('resume');
    expect(thread.id).toBe('thread-existing');
    thread.events.push(
      { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'ACK' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    );
    await sendPromise;
  });
});
