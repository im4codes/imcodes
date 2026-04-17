import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const claudeRuns: Array<{ options: Record<string, unknown>; prompt: string }> = [];
  const codexRuns: Array<{ mode: 'start' | 'resume'; id: string | null; options: Record<string, unknown>; input: string }> = [];
  return { store, claudeRuns, codexRuns };
});

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());

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
            mocks.codexRuns.push({ mode: 'start', id: null, options: msg.params ?? {}, input: '' });
            stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-restored' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-restored' } } }) + '\n');
          }
          if (msg.method === 'thread/resume' && typeof msg.id === 'number') {
            const threadId = String(msg.params?.threadId ?? 'thread-restored');
            mocks.codexRuns.push({ mode: 'resume', id: threadId, options: msg.params ?? {}, input: '' });
            stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: threadId } } }) + '\n');
          }
          if (msg.method === 'turn/start' && typeof msg.id === 'number') {
            const last = mocks.codexRuns[mocks.codexRuns.length - 1];
            if (last) last.input = String(msg.params?.input?.[0]?.text ?? '');
            stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-restore', status: 'inProgress', items: [], error: null } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: String(msg.params?.threadId ?? 'thread-restored'), turnId: 'turn-restore', item: { id: 'msg-restore', type: 'agentMessage', text: 'MANGO' } } }) + '\n');
            stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: String(msg.params?.threadId ?? 'thread-restored'), turn: { id: 'turn-restore', status: 'completed', error: null } } }) + '\n');
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
    execFile: vi.fn((..._args: unknown[]) => {
      const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      cb?.(null, 'ok\n', '');
      return {} as never;
    }),
  };
});

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
  timelineEmitter: { emit: timelineEmitterEmitMock, on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn().mockResolvedValue(undefined), killSession: vi.fn().mockResolvedValue(undefined), sessionExists: vi.fn(), isPaneAlive: vi.fn(), respawnPane: vi.fn(),
  sendKeys: vi.fn(), sendKey: vi.fn(), capturePane: vi.fn(), showBuffer: vi.fn(), getPaneId: vi.fn().mockResolvedValue(undefined), getPaneCwd: vi.fn().mockResolvedValue('/tmp'), getPaneStartCommand: vi.fn().mockResolvedValue(''), cleanupOrphanFifos: vi.fn(), BACKEND: 'tmux',
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingFile: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findJsonlPathBySessionId: vi.fn(() => '/tmp/mock.jsonl') }));
vi.mock('../../src/daemon/codex-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined), startWatchingById: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findRolloutPathByUuid: vi.fn(async () => null) }));
vi.mock('../../src/daemon/gemini-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingLatest: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({ resolveStructuredSessionBootstrap: vi.fn(async (x) => x) }));
vi.mock('../../src/agent/qwen-runtime-config.js', () => ({ getQwenRuntimeConfig: vi.fn(async () => null) }));
vi.mock('../../src/agent/sdk-runtime-config.js', () => ({ getClaudeSdkRuntimeConfig: vi.fn(async () => ({})) }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({ getCodexRuntimeConfig: vi.fn(async () => ({})) }));
vi.mock('../../src/agent/provider-display.js', () => ({ getQwenDisplayMetadata: vi.fn(() => ({})) }));
vi.mock('../../src/agent/provider-quota.js', () => ({ getQwenOAuthQuotaUsageLabel: vi.fn(() => '') }));
vi.mock('../../src/agent/agent-version.js', () => ({ getAgentVersion: vi.fn(async () => 'test') }));
vi.mock('../../src/agent/signal.js', () => ({ setupCCStopHook: vi.fn(async () => {}) }));
vi.mock('../../src/agent/notify-setup.js', () => ({ setupCodexNotify: vi.fn(async () => {}), setupOpenCodePlugin: vi.fn(async () => {}) }));
vi.mock('../../src/repo/cache.js', () => ({ repoCache: { invalidate: vi.fn() } }));
vi.mock('../../src/agent/brain-dispatcher.js', () => ({ BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })) }));

import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import { getTransportRuntime, launchTransportSession, relaunchSessionWithSettings, restoreTransportSessions, setSessionEventCallback } from '../../src/agent/session-manager.js';
import { newSession } from '../../src/agent/tmux.js';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('sdk transport session restore', () => {
  let tempDir: string;

  beforeEach(() => {
    mocks.store.clear();
    mocks.claudeRuns.length = 0;
    mocks.codexRuns.length = 0;
    setSessionEventCallback(() => {});
  });

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('sdk-transport-restore');
  });

  afterEach(async () => {
    await disconnectAll();
    await cleanupIsolatedSharedContextDb(tempDir);
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
      requestedModel: 'sonnet',
      activeModel: 'sonnet',
      effort: 'high',
      transportConfig: { provider: { mode: 'safe' } },
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
    expect(mocks.claudeRuns[0].options.model).toBe('sonnet');
    expect(mocks.claudeRuns[0].options.effort).toBe('high');
    expect(mocks.store.get('deck_sdk_cc_brain')?.state).toBe('idle');
    expect(mocks.store.get('deck_sdk_cc_brain')?.modelDisplay).toBe('claude-sonnet-4-6');
    expect(mocks.store.get('deck_sdk_cc_brain')?.requestedModel).toBe('sonnet');
    expect(mocks.store.get('deck_sdk_cc_brain')?.effort).toBe('high');
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
      requestedModel: 'gpt-5.4',
      activeModel: 'gpt-5.4',
      effort: 'medium',
      transportConfig: { provider: { mode: 'balanced' } },
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
    expect(mocks.store.get('deck_sdk_cx_brain')?.state).toBe('idle');
    expect(mocks.store.get('deck_sdk_cx_brain')?.requestedModel).toBe('gpt-5.4');
    expect(mocks.store.get('deck_sdk_cx_brain')?.effort).toBe('medium');
  });

  it('emits started idle when launching a new transport session', async () => {
    const onSessionEvent = vi.fn();
    setSessionEventCallback(onSessionEvent);

    await connectProvider('claude-code-sdk', {});
    await launchTransportSession({
      name: 'deck_sdk_new_brain',
      projectName: 'sdknew',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/sdk-new',
      requestedModel: 'sonnet',
      effort: 'high',
    });

    expect(mocks.store.get('deck_sdk_new_brain')?.state).toBe('idle');
    expect(onSessionEvent).toHaveBeenCalledWith('started', 'deck_sdk_new_brain', 'idle');
  });

  it('emits startup memory.context on first successful transport dispatch when bootstrap finds recent processed memory', async () => {
    writeProcessedProjection({
      namespace: {
        scope: 'personal',
        projectId: 'sdk-startup-repo',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-startup'],
      summary: 'Seeded transport startup memory for observability',
      content: { kind: 'startup' },
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
    });

    await connectProvider('codex-sdk', {});
    await launchTransportSession({
      name: 'deck_sdk_startup_brain',
      projectName: 'sdkstartup',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/sdk-startup',
      transportConfig: {
        sharedContextNamespace: {
          scope: 'personal',
          projectId: 'sdk-startup-repo',
        },
      },
    });

    const runtime = getTransportRuntime('deck_sdk_startup_brain');
    expect(runtime).toBeDefined();
    runtime!.send('/status');
    await flush();

    const startupCall = timelineEmitterEmitMock.mock.calls.find(([session, type, payload]) =>
      session === 'deck_sdk_startup_brain'
      && type === 'memory.context'
      && (payload as Record<string, unknown>).reason === 'startup',
    );
    expect(startupCall).toBeDefined();
    expect(startupCall?.[2]).toEqual(expect.objectContaining({
      reason: 'startup',
      runtimeFamily: 'transport',
      authoritySource: 'processed_local',
      sourceKind: 'local_processed',
      injectionSurface: expect.stringMatching(/^(system-text|normalized-payload|degraded-message-side)$/),
      injectedText: expect.stringContaining('# Recent project memory'),
      items: expect.arrayContaining([
        expect.objectContaining({
          projectId: 'sdk-startup-repo',
          summary: 'Seeded transport startup memory for observability',
        }),
      ]),
    }));
  });

  it('removes stale transport runtime from the map before awaiting a fresh kill', async () => {
    await connectProvider('claude-code-sdk', {});
    await launchTransportSession({
      name: 'deck_sdk_fresh_brain',
      projectName: 'sdkfresh',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/sdk-fresh',
      requestedModel: 'sonnet',
    });

    const existingRuntime = getTransportRuntime('deck_sdk_fresh_brain');
    expect(existingRuntime).toBeDefined();

    let releaseKill: (() => void) | null = null;
    const killBarrier = new Promise<void>((resolve) => { releaseKill = resolve; });
    const originalKill = existingRuntime!.kill.bind(existingRuntime);
    const killSpy = vi.spyOn(existingRuntime!, 'kill').mockImplementation(async () => {
      await killBarrier;
      await originalKill();
    });

    const relaunchPromise = launchTransportSession({
      name: 'deck_sdk_fresh_brain',
      projectName: 'sdkfresh',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/sdk-fresh',
      requestedModel: 'sonnet',
      fresh: true,
      ccSessionId: 'cc-session-fresh',
    });

    await flush();
    expect(getTransportRuntime('deck_sdk_fresh_brain')).toBeUndefined();

    releaseKill?.();
    await relaunchPromise;

    expect(getTransportRuntime('deck_sdk_fresh_brain')).toBeDefined();
    killSpy.mockRestore();
  });

  it('resumes Claude conversation when switching from cli to sdk', async () => {
    const name = 'deck_switch_ccsdk_brain';
    const record = {
      name,
      projectName: 'switchccsdk',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp/switch-ccsdk',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'process',
      ccSessionId: 'cc-session-switch',
    };
    mocks.store.set(name, record);

    await connectProvider('claude-code-sdk', {});
    await relaunchSessionWithSettings(record as any, { agentType: 'claude-code-sdk' });

    const runtime = getTransportRuntime(name);
    expect(runtime).toBeDefined();
    expect(mocks.store.get(name)?.agentType).toBe('claude-code-sdk');
    expect(mocks.store.get(name)?.ccSessionId).toBe('cc-session-switch');

    runtime!.send('What token did I ask you to remember?');
    await flush();

    expect(mocks.claudeRuns.at(-1)?.options.resume).toBe('cc-session-switch');
    expect(mocks.claudeRuns.at(-1)?.options.sessionId).toBeUndefined();
  });

  it('relaunches claude-code-sdk with a fresh provider route key while preserving the Claude resume id', async () => {
    const name = 'deck_restart_ccsdk_brain';
    const record = {
      name,
      projectName: 'restartccsdk',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/restart-ccsdk',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'route-cc-old',
      ccSessionId: 'cc-session-restart',
    };
    mocks.store.set(name, record);

    await connectProvider('claude-code-sdk', {});
    await relaunchSessionWithSettings(record as any, { agentType: 'claude-code-sdk' });

    const next = mocks.store.get(name);
    expect(next?.agentType).toBe('claude-code-sdk');
    expect(next?.ccSessionId).toBe('cc-session-restart');
    expect(next?.providerSessionId).toBeTruthy();
    expect(next?.providerSessionId).not.toBe('route-cc-old');

    const runtime = getTransportRuntime(name);
    expect(runtime?.providerSessionId).toBe(next?.providerSessionId);

    runtime!.send('What token did I ask you to remember?');
    await flush();

    expect(mocks.claudeRuns.at(-1)?.options.resume).toBe('cc-session-restart');
    expect(mocks.claudeRuns.at(-1)?.options.sessionId).toBeUndefined();
  });

  it('starts a fresh claude-code cli conversation when relaunching with fresh', async () => {
    const name = 'deck_clear_cccli_brain';
    const record = {
      name,
      projectName: 'clearcccli',
      role: 'brain',
      agentType: 'claude-code',
      projectDir: '/tmp/clear-cccli',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ccSessionId: 'cc-session-old',
    };
    mocks.store.set(name, record);

    await relaunchSessionWithSettings(record as any, { fresh: true });

    expect(mocks.store.get(name)?.ccSessionId).not.toBe('cc-session-old');
    expect(String(vi.mocked(newSession).mock.calls.at(-1)?.[1] ?? '')).not.toContain('cc-session-old');
  });

  it('starts a fresh codex cli conversation when relaunching with fresh', async () => {
    const name = 'deck_clear_cxcli_brain';
    const record = {
      name,
      projectName: 'clearcxcli',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/tmp/clear-cxcli',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      codexSessionId: 'codex-thread-old',
    };
    mocks.store.set(name, record);

    await relaunchSessionWithSettings(record as any, { fresh: true });

    expect(mocks.store.get(name)?.codexSessionId).not.toBe('codex-thread-old');
    expect(String(vi.mocked(newSession).mock.calls.at(-1)?.[1] ?? '')).not.toContain('codex-thread-old');
  });

  it('preserves Claude resume id when switching from sdk to cli', async () => {
    const name = 'deck_switch_cccli_brain';
    const record = {
      name,
      projectName: 'switchcccli',
      role: 'brain',
      agentType: 'claude-code-sdk',
      projectDir: '/tmp/switch-cccli',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'route-cc-switch',
      ccSessionId: 'cc-session-switch',
    };
    mocks.store.set(name, record);

    await connectProvider('claude-code-sdk', {});
    await relaunchSessionWithSettings(record as any, { agentType: 'claude-code' });

    expect(mocks.store.get(name)?.agentType).toBe('claude-code');
    expect(mocks.store.get(name)?.ccSessionId).toBe('cc-session-switch');
    expect(String(vi.mocked(newSession).mock.calls.at(-1)?.[1] ?? '')).toContain('cc-session-switch');
  });

  it('preserves Codex thread id when switching from sdk to cli', async () => {
    const name = 'deck_switch_cxcli_brain';
    const record = {
      name,
      projectName: 'switchcxcli',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/switch-cxcli',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'route-cx-switch',
      codexSessionId: 'codex-thread-switch',
    };
    mocks.store.set(name, record);

    await connectProvider('codex-sdk', {});
    await relaunchSessionWithSettings(record as any, { agentType: 'codex' });

    expect(mocks.store.get(name)?.agentType).toBe('codex');
    expect(mocks.store.get(name)?.codexSessionId).toBe('codex-thread-switch');
    expect(String(vi.mocked(newSession).mock.calls.at(-1)?.[1] ?? '')).toContain('codex-thread-switch');
  });
});
