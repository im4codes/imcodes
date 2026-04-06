import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const claudeRuns: Array<{ options: Record<string, unknown>; prompt: string }> = [];
  const codexRuns: Array<{ mode: 'start' | 'resume'; id: string | null; options: Record<string, unknown>; input: string }> = [];
  return { store, claudeRuns, codexRuns };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb?.(null, 'ok\n', '');
    return {} as never;
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    mocks.claudeRuns.push({ prompt, options });
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: String(options.resume ?? options.sessionId), model: 'claude-sonnet-4-6' };
      yield { type: 'result', subtype: 'success', is_error: false, session_id: String(options.resume ?? options.sessionId), result: prompt.includes('token') ? 'BANANA' : 'ACK', usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0 } };
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
        mocks.codexRuns.push({ mode: 'start', id: null, options, input });
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: 'thread-restored' };
            yield { type: 'item.completed', item: { id: 'msg-start', type: 'agent_message', text: input.includes('token') ? 'MANGO' : 'ACK' } };
            yield { type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 } };
          })(),
        };
      },
    }),
    resumeThread: (id: string, options: Record<string, unknown>) => ({
      get id() { return id; },
      runStreamed: async (input: string) => {
        mocks.codexRuns.push({ mode: 'resume', id, options, input });
        return {
          events: (async function* () {
            yield { type: 'item.completed', item: { id: 'msg-resume', type: 'agent_message', text: input.includes('token') ? 'MANGO' : 'ACK' } };
            yield { type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 } };
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

vi.mock('../../src/daemon/transport-relay.js', () => ({
  wireProviderToRelay: vi.fn(),
  broadcastProviderStatus: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn(), killSession: vi.fn(), sessionExists: vi.fn(), isPaneAlive: vi.fn(), respawnPane: vi.fn(),
  sendKeys: vi.fn(), sendKey: vi.fn(), capturePane: vi.fn(), showBuffer: vi.fn(), getPaneId: vi.fn(), getPaneCwd: vi.fn(), getPaneStartCommand: vi.fn(), cleanupOrphanFifos: vi.fn(), BACKEND: 'tmux',
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({ startWatching: vi.fn(), startWatchingFile: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findJsonlPathBySessionId: vi.fn() }));
vi.mock('../../src/daemon/codex-watcher.js', () => ({ startWatching: vi.fn(), startWatchingSpecificFile: vi.fn(), startWatchingById: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findRolloutPathByUuid: vi.fn(async () => null) }));
vi.mock('../../src/daemon/gemini-watcher.js', () => ({ startWatching: vi.fn(), startWatchingLatest: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({ startWatching: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({ resolveStructuredSessionBootstrap: vi.fn(async (x) => x) }));
vi.mock('../../src/agent/qwen-runtime-config.js', () => ({ getQwenRuntimeConfig: vi.fn(async () => null) }));
vi.mock('../../src/agent/provider-display.js', () => ({ getQwenDisplayMetadata: vi.fn(() => ({})) }));
vi.mock('../../src/agent/provider-quota.js', () => ({ getQwenOAuthQuotaUsageLabel: vi.fn(() => '') }));
vi.mock('../../src/agent/agent-version.js', () => ({ getAgentVersion: vi.fn(async () => 'test') }));
vi.mock('../../src/agent/signal.js', () => ({ setupCCStopHook: vi.fn(async () => {}) }));
vi.mock('../../src/agent/notify-setup.js', () => ({ setupCodexNotify: vi.fn(async () => {}), setupOpenCodePlugin: vi.fn(async () => {}) }));
vi.mock('../../src/repo/cache.js', () => ({ repoCache: { invalidate: vi.fn() } }));
vi.mock('../../src/agent/brain-dispatcher.js', () => ({ BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })) }));

import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import { getTransportRuntime, restoreTransportSessions } from '../../src/agent/session-manager.js';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('sdk transport session restore', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.claudeRuns.length = 0;
    mocks.codexRuns.length = 0;
  });

  afterEach(async () => {
    await disconnectAll();
  });

  it('restores claude-code-sdk sessions with persisted resume id and sends via resumed continuity', async () => {
    mocks.store.set('deck_sdk_cc_brain', {
      name: 'deck_sdk_cc_brain',
      projectName: 'sdkcc',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/sdk-cc',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'route-cc-restore',
      ccSessionId: 'cc-session-restore',
    });

    await connectProvider('claude-code-sdk', {});
    await restoreTransportSessions('claude-code-sdk');

    const runtime = getTransportRuntime('deck_sdk_cc_brain');
    expect(runtime).toBeDefined();
    expect(runtime?.providerSessionId).toBe('route-cc-restore');

    runtime!.send('What token did I ask you to remember?');
    await flush();

    expect(mocks.claudeRuns).toHaveLength(1);
    expect(mocks.claudeRuns[0].options.resume).toBe('cc-session-restore');
    expect(mocks.store.get('deck_sdk_cc_brain')?.modelDisplay).toBe('claude-sonnet-4-6');
  });

  it('restores codex-sdk sessions with persisted thread id and sends via resumeThread()', async () => {
    mocks.store.set('deck_sdk_cx_brain', {
      name: 'deck_sdk_cx_brain',
      projectName: 'sdkcx',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/sdk-cx',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'route-cx-restore',
      codexSessionId: 'codex-thread-restore',
    });

    await connectProvider('codex-sdk', {});
    await restoreTransportSessions('codex-sdk');

    const runtime = getTransportRuntime('deck_sdk_cx_brain');
    expect(runtime).toBeDefined();
    expect(runtime?.providerSessionId).toBe('route-cx-restore');

    runtime!.send('What token did I ask you to remember?');
    await flush();

    expect(mocks.codexRuns).toHaveLength(1);
    expect(mocks.codexRuns[0]).toMatchObject({ mode: 'resume', id: 'codex-thread-restore' });
  });
});
