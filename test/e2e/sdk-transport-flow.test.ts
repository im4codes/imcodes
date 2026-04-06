import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_CC = `deck_ccsdk_${Math.random().toString(36).slice(2, 8)}_brain`;
const SESSION_CX = `deck_cxsdk_${Math.random().toString(36).slice(2, 8)}_brain`;

const flushAsync = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => process.nextTick(resolve));
};

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const emitted: Array<{ session: string; type: string; payload: Record<string, any>; opts?: Record<string, any> }> = [];
  const claudeCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const codexCalls: Array<{ mode: 'start' | 'resume'; id: string | null; input: string; options: Record<string, unknown> }> = [];
  return { store, emitted, claudeCalls, codexCalls };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const spawn = vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any> };
          if (msg.method === 'initialize' && typeof msg.id === 'number') {
            stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'test' } }) + '\n');
          }
          if (msg.method === 'thread/start' && typeof msg.id === 'number') {
            stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-codex-e2e' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-codex-e2e' } } }) + '\n');
          }
          if (msg.method === 'thread/resume' && typeof msg.id === 'number') {
            const threadId = String(msg.params?.threadId ?? 'thread-codex-e2e');
            stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: threadId } } }) + '\n');
          }
          if (msg.method === 'turn/start' && typeof msg.id === 'number') {
            stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-codex-e2e', status: 'inProgress', items: [], error: null } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', item: { id: 'cmd-codex-e2e', type: 'commandExecution', command: 'echo hi', aggregatedOutput: '', status: 'inProgress' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', item: { id: 'cmd-codex-e2e', type: 'commandExecution', command: 'echo hi', aggregatedOutput: 'hi\n', status: 'completed' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/started', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', item: { id: 'msg-codex-e2e', type: 'agentMessage', text: '' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', itemId: 'msg-codex-e2e', delta: 'Codex' } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', itemId: 'msg-codex-e2e', delta: ': hello' } }) + '\n');
            stdout.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', tokenUsage: { last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 4 }, total: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 4, totalTokens: 13, reasoningOutputTokens: 0 }, modelContextWindow: 1000000 } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-codex-e2e', turnId: 'turn-codex-e2e', item: { id: 'msg-codex-e2e', type: 'agentMessage', text: 'Codex: hello' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-codex-e2e', turn: { id: 'turn-codex-e2e', status: 'completed', error: null } } }) + '\n');
          }
          if (msg.method === 'turn/interrupt' && typeof msg.id === 'number') {
            stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n');
          }
          if (msg.method === 'thread/unsubscribe' && typeof msg.id === 'number') {
            stdout.write(JSON.stringify({ id: msg.id, result: { status: 'unsubscribed' } }) + '\n');
          }
        }
        cb();
      },
    });
    const child = new EventEmitter() as actual.ChildProcessWithoutNullStreams;
    child.stdout = stdout as any;
    child.stderr = stderr as any;
    child.stdin = stdin as any;
    child.killed = false;
    child.kill = (() => {
      child.killed = true;
      child.emit('exit', 0);
      return true;
    }) as any;
    return child;
  });
  return {
    ...actual,
    spawn,
    execFile: vi.fn((_file: string, _args: string[], cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb?.(null, 'ok\n', '');
      return {} as never;
    }),
    exec: vi.fn((_cmd: string, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb?.(null, '', '');
      return {} as never;
    }),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    mocks.claudeCalls.push({ prompt, options });
    const sessionId = String(options.resume ?? options.sessionId ?? 'cc-session');
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-4-6' };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'message_start', message: { id: 'msg-cc-e2e' } } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-cc-e2e', name: 'Read', input: { file_path: 'README.md' } } } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 0 } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude' } } };
      yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ': hello' } } };
      yield { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'Claude: hello' }] } };
      yield { type: 'result', session_id: sessionId, subtype: 'success', is_error: false, result: 'Claude: hello', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1 } };
    }
    const q = gen() as AsyncGenerator<any, void> & { close(): void; interrupt(): Promise<void> };
    q.close = () => {};
    q.interrupt = async () => {};
    return q;
  }),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: (options: Record<string, unknown>) => ({
      get id() { return null; },
      runStreamed: async (input: string) => {
        mocks.codexCalls.push({ mode: 'start', id: null, input, options });
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: 'thread-codex-e2e' };
            yield { type: 'item.started', item: { id: 'cmd-codex-e2e', type: 'command_execution', command: 'echo hi', aggregated_output: '', status: 'in_progress' } };
            yield { type: 'item.completed', item: { id: 'cmd-codex-e2e', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } };
            yield { type: 'item.updated', item: { id: 'msg-codex-e2e', type: 'agent_message', text: 'Codex' } };
            yield { type: 'item.completed', item: { id: 'msg-codex-e2e', type: 'agent_message', text: 'Codex: hello' } };
            yield { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 4 } };
          })(),
        };
      },
    }),
    resumeThread: (id: string, options: Record<string, unknown>) => ({
      get id() { return id; },
      runStreamed: async (input: string) => {
        mocks.codexCalls.push({ mode: 'resume', id, input, options });
        return {
          events: (async function* () {
            yield { type: 'item.completed', item: { id: 'msg-codex-e2e', type: 'agent_message', text: 'Codex: hello' } };
            yield { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 4 } };
          })(),
        };
      },
    }),
  })),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => { if (record.name) mocks.store.set(record.name, record); }),
  removeSession: vi.fn((name: string) => { mocks.store.delete(name); }),
  updateSessionState: vi.fn((name: string, state: string) => {
    const existing = mocks.store.get(name);
    if (existing) mocks.store.set(name, { ...existing, state });
  }),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, any>, opts?: Record<string, any>) => {
      mocks.emitted.push({ session, type, payload, opts });
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn().mockResolvedValue('test-version'),
}));

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: vi.fn(async () => null),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(false),
  isPaneAlive: vi.fn().mockResolvedValue(false),
  respawnPane: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendKey: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  showBuffer: vi.fn().mockResolvedValue(''),
  getPaneId: vi.fn().mockResolvedValue(undefined),
  getPaneCwd: vi.fn().mockResolvedValue(undefined),
  getPaneStartCommand: vi.fn().mockResolvedValue(''),
  cleanupOrphanFifos: vi.fn().mockResolvedValue(undefined), BACKEND: 'tmux',
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({ startWatching: vi.fn(), startWatchingFile: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findJsonlPathBySessionId: vi.fn() }));
vi.mock('../../src/daemon/codex-watcher.js', () => ({ startWatching: vi.fn(), startWatchingSpecificFile: vi.fn(), startWatchingById: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findRolloutPathByUuid: vi.fn(async () => null) }));
vi.mock('../../src/daemon/gemini-watcher.js', () => ({ startWatching: vi.fn(), startWatchingLatest: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({ startWatching: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({ resolveStructuredSessionBootstrap: vi.fn(async (x) => x) }));
vi.mock('../../src/agent/provider-display.js', () => ({ getQwenDisplayMetadata: vi.fn(() => ({})) }));
vi.mock('../../src/agent/provider-quota.js', () => ({ getQwenOAuthQuotaUsageLabel: vi.fn(() => '') }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({
    planLabel: 'Pro',
    quotaLabel: expect.stringContaining('5h 11%'),
  })),
}));
vi.mock('../../src/agent/brain-dispatcher.js', () => ({ BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })) }));

import { launchSession } from '../../src/agent/session-manager.js';
import { disconnectAll } from '../../src/agent/provider-registry.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';

describe('sdk transport flow e2e', () => {

  it('rejects duplicate claude-code-sdk main session starts for the same project name', async () => {
    mocks.store.set('deck_ccsdk_main_brain', {
      name: 'deck_ccsdk_main_brain',
      projectName: 'ccsdk_main',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/ccsdk-main-e2e',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'deck_ccsdk_main_brain',
      ccSessionId: 'old-cc-session-id',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.start',
      project: 'ccsdk main',
      dir: '/tmp/ccsdk-main-e2e',
      agentType: 'claude-code-sdk',
    }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.error',
      project: 'ccsdk_main',
      message: expect.stringContaining('already exists'),
    }));
    expect(mocks.claudeCalls).toEqual([]);
    expect(mocks.store.get('deck_ccsdk_main_brain')?.ccSessionId).toBe('old-cc-session-id');
  });

  it('rejects duplicate codex-sdk main session starts for the same project name', async () => {
    mocks.store.set('deck_cxsdk_main_brain', {
      name: 'deck_cxsdk_main_brain',
      projectName: 'cxsdk_main',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-main-e2e',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'deck_cxsdk_main_brain',
      codexSessionId: 'old-codex-thread-id',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.start',
      project: 'cxsdk main',
      dir: '/tmp/cxsdk-main-e2e',
      agentType: 'codex-sdk',
    }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.error',
      project: 'cxsdk_main',
      message: expect.stringContaining('already exists'),
    }));
    expect(mocks.codexCalls).toEqual([]);
    expect(mocks.store.get('deck_cxsdk_main_brain')?.codexSessionId).toBe('old-codex-thread-id');
  });

  it('switches claude-code-sdk model through /model and updates display metadata', async () => {
    await launchSession({
      name: SESSION_CC,
      projectName: 'ccsdk',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/ccsdk-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SESSION_CC, text: '/model haiku', commandId: 'cmd-ccsdk-model' }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = mocks.store.get(SESSION_CC);
    const usage = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'usage.update' && e.payload.model === 'haiku');
    expect(record?.modelDisplay).toBe('haiku');
    expect(usage?.payload.contextWindow).toBe(200000);
  });

  it('switches codex-sdk model through /model and updates display metadata', async () => {
    await launchSession({
      name: SESSION_CX,
      projectName: 'cxsdk',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SESSION_CX, text: '/model gpt-5.4-mini', commandId: 'cmd-cxsdk-model' }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = mocks.store.get(SESSION_CX);
    const usage = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'usage.update' && e.payload.model === 'gpt-5.4-mini');
    expect(record?.modelDisplay).toBe('gpt-5.4-mini');
    expect(usage?.payload.contextWindow).toBe(1000000);
  });
  it('starts a claude-code-sdk main session through session.start without tmux driver errors', async () => {
    const serverLink = { send: vi.fn() } as any;

    handleWebCommand({
      type: 'session.start',
      project: 'ccsdk main',
      dir: '/tmp/ccsdk-main-e2e',
      agentType: 'claude-code-sdk',
    }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = mocks.store.get('deck_ccsdk_main_brain');
    expect(record?.runtimeType).toBe('transport');
    expect(record?.providerId).toBe('claude-code-sdk');
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.error' }));
  });

  beforeEach(() => {
    mocks.store.clear();
    mocks.emitted.length = 0;
    mocks.claudeCalls.length = 0;
    mocks.codexCalls.length = 0;
  });

  afterEach(async () => {
    await disconnectAll();
    vi.clearAllMocks();
  });

  it('launches claude-code-sdk session and emits streaming + final transport timeline events', async () => {
    await launchSession({
      name: SESSION_CC,
      projectName: 'ccsdk',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/ccsdk-e2e',
      extraEnv: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SESSION_CC, text: 'hello', commandId: 'cmd-ccsdk-e2e' }, serverLink);
    await flushAsync();

    const record = mocks.store.get(SESSION_CC);
    expect(record?.runtimeType).toBe('transport');
    expect(record?.providerId).toBe('claude-code-sdk');
    expect(record?.ccSessionId).toBeTruthy();

    const stableEventId = `transport:${SESSION_CC}:msg-cc-e2e`;
    const streaming = mocks.emitted.filter((e) => e.session === SESSION_CC && e.type === 'assistant.text' && e.payload.streaming === true);
    const final = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'assistant.text' && e.payload.streaming === false);
    const usage = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'usage.update');
    const ack = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'command.ack');
    const toolCall = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'tool.call');
    const toolResult = mocks.emitted.find((e) => e.session === SESSION_CC && e.type === 'tool.result');
    const claudeCall = mocks.claudeCalls.at(-1);

    expect(streaming.map((e) => e.payload.text)).toEqual(['Claude', 'Claude: hello']);
    expect(streaming[0]?.opts?.eventId).toBe(stableEventId);
    expect(streaming[1]?.opts?.eventId).toBe(stableEventId);
    expect(final?.payload.text).toBe('Claude: hello');
    expect(final?.opts?.eventId).toBe(stableEventId);
    expect(usage?.payload.model).toBe('claude-sonnet-4-6');
    expect(toolCall?.payload.tool).toBe('Read');
    expect(toolResult?.payload).toEqual(expect.objectContaining({
      detail: expect.objectContaining({ kind: 'tool_use_complete' }),
    }));
    expect(claudeCall?.options.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://example.invalid' });
    expect(ack?.payload.status).toBe('accepted');
  });

  it('launches codex-sdk session and emits final/tool timeline events with learned thread id', async () => {
    await launchSession({
      name: SESSION_CX,
      projectName: 'cxsdk',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SESSION_CX, text: 'hello', commandId: 'cmd-cxsdk-e2e' }, serverLink);
    await flushAsync();

    const record = mocks.store.get(SESSION_CX);
    expect(record?.runtimeType).toBe('transport');
    expect(record?.providerId).toBe('codex-sdk');
    expect(record?.codexSessionId).toBe('thread-codex-e2e');

    const streaming = mocks.emitted.filter((e) => e.session === SESSION_CX && e.type === 'assistant.text' && e.payload.streaming === true);
    const final = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'assistant.text' && e.payload.streaming === false);
    const usage = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'usage.update');
    const toolCall = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'tool.call');
    const toolResult = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'tool.result');
    const ack = mocks.emitted.find((e) => e.session === SESSION_CX && e.type === 'command.ack');

    expect(streaming.map((e) => e.payload.text)).toEqual(['Codex', 'Codex: hello']);
    expect(streaming[0]?.opts?.eventId).toBe(`transport:${SESSION_CX}:msg-codex-e2e`);
    expect(streaming[1]?.opts?.eventId).toBe(`transport:${SESSION_CX}:msg-codex-e2e`);
    expect(final?.payload.text).toBe('Codex: hello');
    expect(final?.opts?.eventId).toBe(`transport:${SESSION_CX}:msg-codex-e2e`);
    expect(usage?.payload.inputTokens).toBe(7);
    expect(toolCall?.payload.tool).toBe('Bash');
    expect(toolResult?.payload.output).toBe('hi\n');
    expect(ack?.payload.status).toBe('accepted');
  });
});
