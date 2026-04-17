import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';

const SESSION_CC = `deck_ccsdk_${Math.random().toString(36).slice(2, 8)}_brain`;
const SESSION_CX = `deck_cxsdk_${Math.random().toString(36).slice(2, 8)}_brain`;

const flushAsync = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => process.nextTick(resolve));
};

async function waitForCondition(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const emitted: Array<{ session: string; type: string; payload: Record<string, any>; opts?: Record<string, any> }> = [];
  const claudeCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const codexCalls: Array<{ mode: 'start' | 'resume'; id: string | null; input: string; options: Record<string, unknown> }> = [];
  return { store, emitted, claudeCalls, codexCalls };
});

const PRESET_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'test-token',
  ANTHROPIC_API_KEY: 'test-token',
  ANTHROPIC_MODEL: 'MiniMax-M2.7',
  ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.7',
  IMCODES_CONTEXT_WINDOW: '200000',
};

vi.mock('../../src/daemon/cc-presets.js', () => ({
  getPreset: vi.fn(async (name: string) => (
    name.trim().toLowerCase() === 'minimax'
      ? { name: 'minimax', env: PRESET_ENV, contextWindow: 200000 }
      : undefined
  )),
  resolvePresetEnv: vi.fn(async (name: string) => (
    name.trim().toLowerCase() === 'minimax' ? { ...PRESET_ENV } : {}
  )),
  getPresetTransportOverrides: vi.fn(async (name: string) => (
    name.trim().toLowerCase() === 'minimax'
      ? {
          model: 'MiniMax-M2.7',
          systemPrompt: 'Authoritative runtime model: MiniMax-M2.7.',
        }
      : {}
  )),
  getPresetInitMessage: vi.fn(() => 'preset-init'),
  invalidateCache: vi.fn(),
}));

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
    execFile: vi.fn((
      _file: string,
      _args: string[],
      optionsOrCb?: Record<string, unknown> | ((err: Error | null, stdout: string, stderr: string) => void),
      maybeCb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
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
import { newSession } from '../../src/agent/tmux.js';

describe('sdk transport flow e2e', () => {
  let sharedContextTempDir: string;

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

  it('emits a brain-session inline error when session.restart fails', async () => {
    const tmuxNewSession = newSession as ReturnType<typeof vi.fn>;
    tmuxNewSession.mockRejectedValueOnce(new Error('tmux create failed'));

    mocks.store.set('deck_restart_fail_brain', {
      name: 'deck_restart_fail_brain',
      projectName: 'restart_fail',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/tmp/restart-fail',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.restart',
      project: 'restart_fail',
    }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.error',
      project: 'restart_fail',
      message: 'tmux create failed',
    }));
    expect(mocks.emitted).toContainEqual(expect.objectContaining({
      session: 'deck_restart_fail_brain',
      type: 'assistant.text',
      payload: expect.objectContaining({
        text: '⚠️ Error: tmux create failed',
        streaming: false,
      }),
    }));
  });

  it('pushes an updated session_list after settings restart switches a main session to claude-code-sdk', async () => {
    mocks.store.set('deck_settings_switch_brain', {
      name: 'deck_settings_switch_brain',
      projectName: 'settings_switch',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp/settings-switch',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      ccSessionId: 'cc-settings-switch',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.restart',
      sessionName: 'deck_settings_switch_brain',
      agentType: 'claude-code-sdk',
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'session_list'));

    const sessionListPayload = serverLink.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg?.type === 'session_list');
    const switched = sessionListPayload?.sessions?.find((session: any) => session.name === 'deck_settings_switch_brain');

    expect(switched).toMatchObject({
      name: 'deck_settings_switch_brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
    });
  });

  it('applies live main-session transportConfig supervision updates without restart and re-syncs session_list', async () => {
    mocks.store.set('deck_live_supervision_brain', {
      name: 'deck_live_supervision_brain',
      projectName: 'live_supervision',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/live-supervision-main',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'deck_live_supervision_brain',
      codexSessionId: 'thread-codex-live-main',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_live_supervision_brain',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'session_list'));

    const record = mocks.store.get('deck_live_supervision_brain');
    expect(record).toMatchObject({
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'deck_live_supervision_brain',
      codexSessionId: 'thread-codex-live-main',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
        },
      },
    });

    const sessionListPayload = serverLink.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg?.type === 'session_list');
    const synced = sessionListPayload?.sessions?.find((session: any) => session.name === 'deck_live_supervision_brain');
    expect(synced?.transportConfig).toMatchObject({
      supervision: {
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.3-codex-spark',
      },
    });
  });

  it('preserves cc presets when settings restart switches a main session to claude-code-sdk', async () => {
    mocks.store.set('deck_settings_preset_brain', {
      name: 'deck_settings_preset_brain',
      projectName: 'settings_preset',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp/settings-preset',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      ccSessionId: 'cc-settings-preset',
      ccPreset: 'MiniMax',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.restart',
      sessionName: 'deck_settings_preset_brain',
      agentType: 'claude-code-sdk',
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'session_list'));

    const switched = mocks.store.get('deck_settings_preset_brain');
    expect(switched?.agentType).toBe('claude-code-sdk');
    expect(switched?.ccPreset).toBe('MiniMax');

    handleWebCommand({ type: 'session.send', session: 'deck_settings_preset_brain', text: 'hello', commandId: 'cmd-settings-preset' }, serverLink);
    await flushAsync();

    const claudeCall = mocks.claudeCalls.at(-1);
    expect(claudeCall?.options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: expect.any(String),
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
    });
    expect(claudeCall?.options.model).toBe('MiniMax-M2.7');
    expect(String(claudeCall?.options.appendSystemPrompt ?? '')).toContain('Authoritative runtime model: MiniMax-M2.7.');
  });

  it('pushes a corrective session_list when settings restart fails', async () => {
    const tmuxNewSession = newSession as ReturnType<typeof vi.fn>;
    tmuxNewSession.mockRejectedValueOnce(new Error('tmux create failed'));
    mocks.store.set('deck_settings_fail_brain', {
      name: 'deck_settings_fail_brain',
      projectName: 'settings_fail',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/tmp/settings-fail',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: 'session.restart',
      sessionName: 'deck_settings_fail_brain',
      agentType: 'shell',
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'session.error'));
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'session_list'));

    const sessionListPayload = serverLink.send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg?.type === 'session_list');
    const session = sessionListPayload?.sessions?.find((entry: any) => entry.name === 'deck_settings_fail_brain');

    expect(session).toMatchObject({
      name: 'deck_settings_fail_brain',
      agentType: 'shell',
    });
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

  it('accepts /model opus as an alias for opus[1M] on claude-code-sdk', async () => {
    await launchSession({
      name: SESSION_CC,
      projectName: 'ccsdk',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/ccsdk-e2e',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SESSION_CC, text: '/model opus', commandId: 'cmd-ccsdk-model-opus' }, serverLink);
    await flushAsync();
    await waitForCondition(() => mocks.store.get(SESSION_CC)?.modelDisplay != null);

    const record = mocks.store.get(SESSION_CC);
    expect(record?.modelDisplay).toBe('opus[1M]');
  });



  it('includes codex-sdk quota metadata when a sub-session is created', async () => {
    const serverLink = { send: vi.fn() } as any;

    handleWebCommand({
      type: 'subsession.start',
      id: 'cxsdk_created',
      sessionType: 'codex-sdk',
      cwd: '/tmp/cxsdk-sub-created',
      parentSession: 'deck_parent_brain',
      thinking: 'high',
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.length > 0, 10000);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'cxsdk_created',
      sessionType: 'codex-sdk',
      planLabel: 'Pro',
      quotaLabel: expect.stringContaining('5h 11%'),
      effort: 'high',
    }));
  });

  it('re-syncs codex-sdk quota metadata during sub-session rebuild', async () => {
    const sessionName = 'deck_sub_cxsdk_rebuild';
    const serverLink = { send: vi.fn() } as any;
    mocks.store.set(sessionName, {
      name: sessionName,
      projectName: sessionName,
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-sub-rebuild',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'deck_sub_cxsdk_rebuild',
      parentSession: 'deck_parent_brain',
      requestedModel: 'gpt-5.4-mini',
      activeModel: 'gpt-5.4-mini',
      modelDisplay: 'gpt-5.4-mini',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    handleWebCommand({
      type: 'subsession.rebuild_all',
      subSessions: [{
        id: 'cxsdk_rebuild',
        type: 'codex-sdk',
        runtimeType: 'transport',
        providerId: 'codex-sdk',
        providerSessionId: 'deck_sub_cxsdk_rebuild',
        cwd: '/tmp/cxsdk-sub-rebuild',
        parentSession: 'deck_parent_brain',
        requestedModel: 'gpt-5.4-mini',
      }],
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => {
      const record = mocks.store.get(sessionName);
      return record?.agentType === 'codex-sdk' && record?.modelDisplay === 'gpt-5.4-mini';
    }, 10000);

    const record = mocks.store.get(sessionName);
    expect(record).toEqual(expect.objectContaining({
      agentType: 'codex-sdk',
      modelDisplay: 'gpt-5.4-mini',
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'cxsdk_rebuild',
    }));
  });

  it('applies live sub-session transportConfig supervision updates without restart and re-syncs the sub-session', async () => {
    const sessionName = 'deck_sub_live_supervision';
    mocks.store.set(sessionName, {
      name: sessionName,
      projectName: sessionName,
      role: 'w1',
      label: 'LiveAuto',
      agentType: 'codex-sdk',
      projectDir: '/tmp/live-supervision-sub',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: sessionName,
      parentSession: 'deck_parent_brain',
      codexSessionId: 'thread-codex-live-sub',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SUBSESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName,
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12000,
          promptVersion: 'supervision_decision_v1',
          taskRunPromptVersion: 'supervision_continue_v1',
          maxParseRetries: 1,
          auditConfig: {
            mode: 'audit',
            maxAuditLoops: 2,
          },
        },
      },
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.some((call) => call[0]?.type === 'subsession.sync' && call[0]?.id === 'live_supervision'));

    const record = mocks.store.get(sessionName);
    expect(record).toMatchObject({
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: sessionName,
      codexSessionId: 'thread-codex-live-sub',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          auditConfig: {
            mode: 'audit',
            maxAuditLoops: 2,
          },
        },
      },
    });

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'live_supervision',
      transportConfig: expect.objectContaining({
        supervision: expect.objectContaining({
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
        }),
      }),
    }));
  });

  it('syncs codex-sdk sub-session model changes back to the frontend', async () => {
    const SUB = 'deck_sub_cxsdk_e2e';
    mocks.store.set(SUB, {
      name: SUB,
      projectName: 'deck_sub_cxsdk_e2e',
      role: 'w1',
      label: 'Cx1',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-sub-e2e',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: SUB,
      parentSession: 'deck_parent_brain',
      codexSessionId: 'thread-codex-e2e',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await launchSession({
      name: SUB,
      projectName: 'deck_sub_cxsdk_e2e',
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-sub-e2e',
      label: 'Cx1',
      fresh: false,
      codexSessionId: 'thread-codex-e2e',
      parentSession: 'deck_parent_brain',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SUB, text: '/model gpt-5.4', commandId: 'cmd-cxsdk-sub-model' }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'cxsdk_e2e',
      modelDisplay: 'gpt-5.4',
      quotaLabel: expect.stringContaining('5h 11%'),
    }));
  });

  it('syncs codex-sdk sub-session thinking changes back to the frontend', async () => {
    const SUB = 'deck_sub_cxsdk_effort';
    mocks.store.set(SUB, {
      name: SUB,
      projectName: 'deck_sub_cxsdk_effort',
      role: 'w1',
      label: 'Cx2',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-sub-e2e',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: SUB,
      parentSession: 'deck_parent_brain',
      codexSessionId: 'thread-codex-e2e',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await launchSession({
      name: SUB,
      projectName: 'deck_sub_cxsdk_effort',
      role: 'w1',
      agentType: 'codex-sdk',
      projectDir: '/tmp/cxsdk-sub-e2e',
      label: 'Cx2',
      fresh: false,
      codexSessionId: 'thread-codex-e2e',
      parentSession: 'deck_parent_brain',
    });

    const serverLink = { send: vi.fn() } as any;
    handleWebCommand({ type: 'session.send', session: SUB, text: '/thinking high', commandId: 'cmd-cxsdk-sub-thinking' }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'cxsdk_effort',
      effort: 'high',
    }));
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

  it('persists and applies cc presets for claude-code-sdk main sessions', async () => {
    const serverLink = { send: vi.fn() } as any;

    handleWebCommand({
      type: 'session.start',
      project: 'ccsdk minimax',
      dir: '/tmp/ccsdk-minimax-e2e',
      agentType: 'claude-code-sdk',
      ccPreset: 'MiniMax',
    }, serverLink);
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessionName = 'deck_ccsdk_minimax_brain';
    await waitForCondition(() => !!mocks.store.get(sessionName));
    const record = mocks.store.get(sessionName);
    expect(record?.ccPreset).toBe('MiniMax');

    handleWebCommand({ type: 'session.send', session: sessionName, text: 'hello', commandId: 'cmd-ccsdk-minimax' }, serverLink);
    await flushAsync();

    const claudeCall = mocks.claudeCalls.at(-1);
    expect(claudeCall?.options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: expect.any(String),
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
    });
    expect(claudeCall?.options.model).toBe('MiniMax-M2.7');
    expect(String(claudeCall?.options.appendSystemPrompt ?? '')).toContain('Authoritative runtime model: MiniMax-M2.7.');
  });

  it('persists and applies cc presets for claude-code-sdk sub-sessions', async () => {
    const serverLink = { send: vi.fn() } as any;

    handleWebCommand({
      type: 'subsession.start',
      id: 'ccsdk_minimax_sub',
      sessionType: 'claude-code-sdk',
      cwd: '/tmp/ccsdk-minimax-sub-e2e',
      parentSession: 'deck_parent_brain',
      ccPreset: 'MiniMax',
    }, serverLink);
    await flushAsync();
    await waitForCondition(() => serverLink.send.mock.calls.length > 0);

    const sessionName = 'deck_sub_ccsdk_minimax_sub';
    const record = mocks.store.get(sessionName);
    expect(record?.ccPreset).toBe('MiniMax');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'ccsdk_minimax_sub',
      ccPresetId: 'MiniMax',
    }));

    handleWebCommand({ type: 'session.send', session: sessionName, text: 'hello', commandId: 'cmd-ccsdk-minimax-sub' }, serverLink);
    await flushAsync();

    const claudeCall = mocks.claudeCalls.at(-1);
    expect(claudeCall?.options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: expect.any(String),
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
    });
    expect(claudeCall?.options.model).toBe('MiniMax-M2.7');
    expect(String(claudeCall?.options.appendSystemPrompt ?? '')).toContain('Authoritative runtime model: MiniMax-M2.7.');
  });

  beforeEach(async () => {
    sharedContextTempDir = await createIsolatedSharedContextDb('sdk-transport-flow');
    mocks.store.clear();
    mocks.emitted.length = 0;
    mocks.claudeCalls.length = 0;
    mocks.codexCalls.length = 0;
  });

  afterEach(async () => {
    await disconnectAll();
    await cleanupIsolatedSharedContextDb(sharedContextTempDir);
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

    expect(streaming.map((e) => e.payload.text)).toEqual(['Claude']);
    expect(streaming[0]?.opts?.eventId).toBe(stableEventId);
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

    expect(streaming.map((e) => e.payload.text)).toEqual(['Codex']);
    expect(streaming[0]?.opts?.eventId).toBe(`transport:${SESSION_CX}:msg-codex-e2e`);
    expect(final?.payload.text).toBe('Codex: hello');
    expect(final?.opts?.eventId).toBe(`transport:${SESSION_CX}:msg-codex-e2e`);
    expect(usage?.payload.inputTokens).toBe(7);
    expect(toolCall?.payload.tool).toBe('Bash');
    expect(toolResult?.payload.output).toBe('hi\n');
    expect(ack?.payload.status).toBe('accepted');
  });
});
