import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Creating a session must launch in a few seconds whatever state the context store / memory backend is in:
 * memory and context enrichment may never gate launch. The real session-manager, provider registry, codex-sdk
 * provider and TransportSessionRuntime run here against a scripted `codex app-server` child and a context-store
 * client whose every call takes 30 s (the saturated-worker queue guard the owner hit).
 */
const mocks = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
  /** JSON-RPC methods the fake app-server receives and never answers. */
  hung: new Set<string>(),
  received: [] as string[],
  turnStarts: [] as string[],
  contextStoreDelayMs: 0,
  /** Store missing/disabled: every call rejects at once. */
  contextStoreRejects: false,
  contextStoreCalls: [] as string[],
  /** When set, `getCodexRuntimeConfig` (an early step of every codex launch) waits on it. */
  runtimeConfigGate: null as Promise<void> | null,
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
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, any> };
          if (typeof msg.id !== 'number' || !msg.method) continue;
          mocks.received.push(msg.method);
          if (mocks.hung.has(msg.method)) continue;
          if (msg.method === 'initialize') stdout.write(`${JSON.stringify({ id: msg.id, result: { userAgent: 'test' } })}\n`);
          if (msg.method === 'thread/start') {
            stdout.write(`${JSON.stringify({ id: msg.id, result: { thread: { id: 'thread-launch' } } })}\n`);
            stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thread-launch' } } })}\n`);
          }
          if (msg.method === 'thread/unsubscribe') stdout.write(`${JSON.stringify({ id: msg.id, result: { status: 'unsubscribed' } })}\n`);
          if (msg.method === 'turn/start') {
            mocks.turnStarts.push(JSON.stringify(msg.params ?? {}));
            stdout.write(`${JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } })}\n`);
          }
          if (msg.method === 'mcpServerStatus/list') {
            stdout.write(`${JSON.stringify({
              id: msg.id,
              result: { data: [{ name: 'imcodes-memory', runtimeStatus: 'connected', tools: { send_list_targets: {}, send_message: {} } }] },
            })}\n`);
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
    child.kill = (() => { child.killed = true; child.emit('exit', 0); return true; }) as any;
    return child;
  });
  return {
    ...actual,
    spawn,
    execFile: vi.fn((..._args: unknown[]) => {
      const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
        | ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      cb?.(null, 'ok\n', '');
      return {} as never;
    }),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => { if (record.name) mocks.store.set(record.name, record); }),
  removeSession: vi.fn((name: string) => { mocks.store.delete(name); }),
  updateSessionState: vi.fn(),
}));

// Every context-store call takes `contextStoreDelayMs` (unref'd timers so a stuck call never holds the process).
vi.mock('../../src/store/context-store-worker-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/context-store-worker-client.js')>();
  const slow = (op: string): Promise<unknown> => {
    mocks.contextStoreCalls.push(op);
    if (mocks.contextStoreRejects) return Promise.reject(new Error(`context store unavailable: ${op}`));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), mocks.contextStoreDelayMs);
      timer.unref?.();
    });
  };
  const slowClient = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'run' || prop === 'runBounded' || prop === 'call') return (op: string) => slow(String(op));
      return (...args: unknown[]) => (mocks.contextStoreDelayMs > 0 || mocks.contextStoreRejects ? slow(String(prop)) : (actual.getContextStoreClient() as any)[prop](...args));
    },
  });
  return {
    ...actual,
    getContextStoreClient: () => (mocks.contextStoreDelayMs > 0 || mocks.contextStoreRejects ? slowClient : actual.getContextStoreClient()),
  };
});

vi.mock('../../src/daemon/session-resource-service.js', () => ({
  registerTmuxSessionResource: vi.fn().mockResolvedValue(undefined),
  releaseSessionChildResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  releaseSessionResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  resourceOwnerEnv: vi.fn(() => ({})),
  initializeSessionResourceLifecycle: vi.fn().mockResolvedValue({ released: 0, preserved: 0, failed: 0 }),
}));
vi.mock('../../src/daemon/transport-relay.js', () => ({ wireProviderToRelay: vi.fn(), broadcastProviderStatus: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { readByTypesPreferred: vi.fn(async () => []) } }));
vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn().mockResolvedValue(undefined), killSession: vi.fn().mockResolvedValue(undefined), sessionExists: vi.fn(), isPaneAlive: vi.fn(), respawnPane: vi.fn(),
  sendKeys: vi.fn(), sendKey: vi.fn(), capturePane: vi.fn(), showBuffer: vi.fn(), getPaneId: vi.fn().mockResolvedValue(undefined), getPaneCwd: vi.fn().mockResolvedValue('/tmp'), getPaneStartCommand: vi.fn().mockResolvedValue(''), cleanupOrphanFifos: vi.fn(), BACKEND: 'tmux',
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingFile: vi.fn().mockResolvedValue(undefined), reserveSessionFile: vi.fn(), reassignSessionFile: vi.fn(), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findJsonlPathBySessionId: vi.fn(() => '/tmp/mock.jsonl') }));
vi.mock('../../src/daemon/codex-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined), startWatchingById: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false), findRolloutPathByUuid: vi.fn(async () => null) }));
vi.mock('../../src/daemon/gemini-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), startWatchingLatest: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({ startWatching: vi.fn().mockResolvedValue(undefined), stopWatching: vi.fn(), isWatching: vi.fn(() => false) }));
vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({ resolveStructuredSessionBootstrap: vi.fn(async (x) => x) }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => {
    if (mocks.runtimeConfigGate) await mocks.runtimeConfigGate;
    return {};
  }),
}));
vi.mock('../../src/agent/agent-version.js', () => ({ getAgentVersion: vi.fn(async () => 'test') }));
vi.mock('../../src/agent/signal.js', () => ({ setupCCStopHook: vi.fn(async () => {}) }));
vi.mock('../../src/agent/notify-setup.js', () => ({ setupCodexNotify: vi.fn(async () => {}), setupOpenCodePlugin: vi.fn(async () => {}) }));
vi.mock('../../src/repo/cache.js', () => ({ repoCache: { invalidate: vi.fn() } }));
vi.mock('../../src/agent/brain-dispatcher.js', () => ({ BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })) }));

import { connectProvider, disconnectAll, getProvider } from '../../src/agent/provider-registry.js';
import {
  getTransportRuntime,
  launchTransportSession,
  setSessionEventCallback,
  setSessionPersistCallback,
  stopTransportRuntimeSession,
} from '../../src/agent/session-manager.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { clearAllResend } from '../../src/daemon/transport-resend-queue.js';

const STORE_STALL_MS = 30_000;

async function launchCodexMain(name: string, projectDir: string, extra: Record<string, unknown> = {}) {
  await connectProvider('codex-sdk', {});
  await launchTransportSession({
    name,
    projectName: 'launchbudget',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir,
    label: 'Launch budget',
    fresh: true,
    ...extra,
  });
}

describe('session launch is never gated by context/memory enrichment', () => {
  let projectDir: string;
  let sharedDbDir: string;

  beforeEach(async () => {
    mocks.store.clear();
    mocks.hung.clear();
    mocks.received.length = 0;
    mocks.turnStarts.length = 0;
    mocks.contextStoreCalls.length = 0;
    mocks.contextStoreDelayMs = 0;
    mocks.contextStoreRejects = false;
    mocks.runtimeConfigGate = null;
    clearAllResend();
    resetTransportQueueStoreForTests();
    setSessionEventCallback(() => {});
    setSessionPersistCallback(async () => {});
    sharedDbDir = await createIsolatedSharedContextDb('session-launch-context-budget');
    projectDir = await mkdtemp(path.join(os.tmpdir(), 'imc-launch-budget-'));
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '300');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await disconnectAll();
    resetTransportQueueStoreForTests();
    await cleanupIsolatedSharedContextDb(sharedDbDir);
    await rm(projectDir, { recursive: true, force: true });
  });

  it('a fresh codex-sdk main launches within the context budget when every context-store call takes 30 s', async () => {
    mocks.contextStoreDelayMs = STORE_STALL_MS;
    const startedAt = Date.now();
    await launchCodexMain('deck_launch_stalled_store_brain', projectDir);
    const elapsed = Date.now() - startedAt;

    // Budget (300 ms here) + the fake app-server round trips; the base build waits out the 30 s queue guard per call.
    expect(elapsed).toBeLessThan(STORE_STALL_MS / 3);
    expect(elapsed).toBeLessThan(5_000);
    expect(mocks.contextStoreCalls.length).toBeGreaterThan(0);
    const runtime = getTransportRuntime('deck_launch_stalled_store_brain');
    expect(runtime?.providerSessionId).toBeTruthy();
    // The namespace stage needs no store access, so the launch keeps its namespace (MCP memory scope, persisted record).
    expect(mocks.store.get('deck_launch_stalled_store_brain')?.contextNamespace).toEqual(expect.objectContaining({ projectId: expect.any(String) }));
    expect(mocks.store.get('deck_launch_stalled_store_brain')?.contextNamespaceDiagnostics).toContain('context-bootstrap:launch-timeout');
    await stopTransportRuntimeSession('deck_launch_stalled_store_brain');
  });

  it('with the default 2.5 s budget the same launch still completes in under 5 s', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '');
    mocks.contextStoreDelayMs = STORE_STALL_MS;
    const startedAt = Date.now();
    await launchCodexMain('deck_launch_default_budget_brain', projectDir);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(getTransportRuntime('deck_launch_default_budget_brain')?.providerSessionId).toBeTruthy();
    await stopTransportRuntimeSession('deck_launch_default_budget_brain');
  }, 15_000);

  it('sub-session and restart launches are bounded the same way (startup memory already injected)', async () => {
    mocks.contextStoreDelayMs = STORE_STALL_MS;
    mocks.store.set('deck_sub_launchbudget', {
      name: 'deck_sub_launchbudget', projectName: 'launchbudget', role: 'w1', agentType: 'codex-sdk', projectDir,
      state: 'idle', restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now(),
      runtimeType: 'transport', providerId: 'codex-sdk', startupMemoryInjected: true,
    });
    const startedAt = Date.now();
    await launchCodexMain('deck_sub_launchbudget', projectDir, { fresh: false, role: 'w1', parentSession: 'deck_launchbudget_brain' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(getTransportRuntime('deck_sub_launchbudget')?.providerSessionId).toBeTruthy();
    await stopTransportRuntimeSession('deck_sub_launchbudget');
  });

  it('with a healthy store a launch is unaffected: no budget wait, no launch-timeout marker, enrichment still applied', async () => {
    const startedAt = Date.now();
    await launchCodexMain('deck_launch_healthy_brain', projectDir);
    const elapsed = Date.now() - startedAt;
    expect(getTransportRuntime('deck_launch_healthy_brain')?.providerSessionId).toBeTruthy();
    expect(elapsed).toBeLessThan(5_000);
    const record = mocks.store.get('deck_launch_healthy_brain');
    expect(record?.contextNamespaceDiagnostics ?? []).not.toContain('context-bootstrap:launch-timeout');
    expect(record?.contextNamespaceDiagnostics ?? []).not.toContain('context-bootstrap:launch-failed');
    expect(record?.contextNamespace).toEqual(expect.objectContaining({ projectId: expect.any(String) }));
    await stopTransportRuntimeSession('deck_launch_healthy_brain');
  });

  it('a missing/disabled context store (every call rejects) does not fail or slow the launch', async () => {
    mocks.contextStoreRejects = true;
    const startedAt = Date.now();
    await launchCodexMain('deck_launch_missing_store_brain', projectDir);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(getTransportRuntime('deck_launch_missing_store_brain')?.providerSessionId).toBeTruthy();
    expect(mocks.store.get('deck_launch_missing_store_brain')?.contextNamespace).toEqual(expect.objectContaining({ projectId: expect.any(String) }));
    await stopTransportRuntimeSession('deck_launch_missing_store_brain');
  });

  it('a hung app-server `initialize` fails the launch with a clear error instead of waiting forever', async () => {
    mocks.hung.add('initialize');
    const realSetTimeout = globalThis.setTimeout;
    const realSleep = (ms: number) => new Promise<void>((resolve) => { realSetTimeout(resolve, ms); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const settled = launchCodexMain('deck_launch_hung_initialize_brain', projectDir).then(() => 'launched' as const, (err: Error) => err);
    // Real I/O (provider connect, spawn) advances in real time; only the request timer is on the fake clock.
    for (let i = 0; i < 400 && !mocks.received.includes('initialize'); i += 1) await realSleep(10);
    expect(mocks.received).toContain('initialize');

    let early: unknown = 'pending';
    void settled.then((value) => { early = value; });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(early).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/initialize did not settle within 20000ms/);
  });

  it('a hung `thread/unsubscribe` no longer blocks ending the session', async () => {
    await launchCodexMain('deck_launch_hung_unsubscribe_brain', projectDir);
    const runtime = getTransportRuntime('deck_launch_hung_unsubscribe_brain');
    const providerSessionId = runtime?.providerSessionId as string;
    const provider = getProvider('codex-sdk') as unknown as {
      sessions: Map<string, { threadId?: string; loaded: boolean }>;
      endSession(sessionId: string): Promise<void>;
    };
    const state = provider.sessions.get(providerSessionId);
    expect(state).toBeDefined();
    // A thread the app-server has loaded (it is otherwise created lazily on the first turn).
    state!.threadId = 'thread-loaded';
    state!.loaded = true;

    mocks.hung.add('thread/unsubscribe');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ended = provider.endSession(providerSessionId);
    let done = false;
    void ended.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.received).toContain('thread/unsubscribe');
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await ended;
    expect(done).toBe(true);
  });

  it('a wedged earlier launch yields a clear error for the next launch of the same session, not an endless wait', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_LAUNCH_INFLIGHT_WAIT_MS', '200');
    let release!: () => void;
    mocks.runtimeConfigGate = new Promise<void>((resolve) => { release = resolve; });
    await connectProvider('codex-sdk', {});
    const stuck = launchTransportSession({
      name: 'deck_launch_wedged_brain', projectName: 'launchbudget', role: 'brain', agentType: 'codex-sdk', projectDir, fresh: true,
    });
    stuck.catch(() => {});

    const startedAt = Date.now();
    await expect(launchTransportSession({
      name: 'deck_launch_wedged_brain', projectName: 'launchbudget', role: 'brain', agentType: 'codex-sdk', projectDir, fresh: true,
    })).rejects.toThrow(/still starting from an earlier launch/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    // Once the wedge clears, the original launch completes and the session can be launched again.
    release();
    await stuck;
    expect(getTransportRuntime('deck_launch_wedged_brain')?.providerSessionId).toBeTruthy();
    await stopTransportRuntimeSession('deck_launch_wedged_brain');
  });
});
