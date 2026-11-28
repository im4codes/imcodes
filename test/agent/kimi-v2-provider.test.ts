import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type { AcpClientConnection, AcpClientHandlers } from '../../src/agent/providers/acp-client-adapter.js';
import { PROVIDER_ERROR_CODES, type ProviderStatusUpdate } from '../../src/agent/transport-provider.js';
import { onConfirmedProviderStop } from '../../src/agent/provider-stop-confirmation.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { TRANSPORT_STOP_QUEUE_TIMEOUT_MS } from '../../shared/transport-queue-types.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { __testing__ as transportRelayTesting } from '../../src/daemon/transport-relay.js';
import { PREFERENCE_CONTEXT_END, PREFERENCE_CONTEXT_START } from '../../shared/preference-ingest.js';
import { SUPERVISION_CONTRACT_PREAMBLE_END, SUPERVISION_CONTRACT_PREAMBLE_START } from '../../shared/supervision-config.js';

const {
  mockSpawn,
  mockKillProcessTree,
  state,
} = vi.hoisted(() => {
  const state = {
    handlers: null as AcpClientHandlers | null,
    conn: null as Record<string, ReturnType<typeof vi.fn>> | null,
    connQueue: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
    spawnError: null as (Error & { code?: string }) | null,
    autoExitOnKill: true,
    children: [] as Array<EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      exitCode: number | null;
      signalCode: string | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    }>,
  };
  return {
    mockSpawn: vi.fn(),
    mockKillProcessTree: vi.fn(async (child: { killed?: boolean; exitCode?: number | null; emit?: (ev: string, ...args: unknown[]) => void }) => {
      if (child && state.autoExitOnKill) {
        child.killed = true;
        child.exitCode = 0;
        child.emit?.('exit', 0, null);
      }
    }),
    state,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawn: mockSpawn,
  };
});

vi.mock('../../src/agent/providers/acp-client-adapter.js', () => ({
  createAcpClientConnection: vi.fn((handlers: AcpClientHandlers) => {
    state.handlers = handlers;
    const next = state.connQueue.shift() ?? state.conn;
    state.conn = next;
    return next as unknown as AcpClientConnection;
  }),
}));

vi.mock('../../src/util/kill-process-tree.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/util/kill-process-tree.js')>();
  return {
    ...orig,
    killProcessTree: mockKillProcessTree,
  };
});

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn() },
}));

import { KimiV2Provider } from '../../src/agent/providers/kimi-v2.js';
import { resolveKimiPathForSdk } from '../../src/agent/transport-paths.js';

function makeFakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.pid = 42424 + state.children.length;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  emitter.kill = vi.fn(() => {
    emitter.killed = true;
    return true;
  });
  return emitter;
}

function makeMockConn(overrides: Record<string, unknown> = {}) {
  return {
    initialize: vi.fn(async () => ({
      protocolVersion: 1,
      agentInfo: { name: 'Kimi Code CLI', version: '2.8.1' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    })),
    newSession: vi.fn(async () => ({
      sessionId: 'kimi-sess-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2.5',
          options: [
            { value: 'kimi-k2.5', name: 'Kimi K2.5' },
            { value: 'kimi-for-coding', name: 'Kimi for Coding' },
          ],
        },
      ],
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'yolo', name: 'Yolo' },
        ],
      },
    })),
    loadSession: vi.fn(async () => ({
      models: {
        currentModelId: 'kimi-k1-legacy',
        availableModels: [{ modelId: 'kimi-k1-legacy', name: 'Legacy Model' }],
      },
    })),
    resumeSession: vi.fn(async () => ({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2.5',
          options: [
            { value: 'kimi-k2.5', name: 'Kimi K2.5' },
            { value: 'kimi-for-coding', name: 'Kimi for Coding' },
          ],
        },
      ],
    })),
    listSessions: vi.fn(async () => ({
      sessions: [
        { sessionId: 'kimi-sess-1', title: 'Repo work', cwd: '/tmp/repo', updatedAt: '2026-11-28T00:00:00.000Z' },
      ],
    })),
    closeSession: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
    unstable_setSessionModel: vi.fn(async () => ({})),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('resolveKimiPathForSdk (v2 + legacy fallback)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeExec(dir: string, relPath: string): string {
    const full = path.join(dir, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '#!/bin/sh\necho ok\n');
    chmodSync(full, 0o755);
    return full;
  }

  it('prefers KIMI_CLI_PATH, then KIMI_CODE_HOME/bin/kimi, then ~/.kimi-code/bin/kimi, before ~/.local/bin/kimi', () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'kimi-path-'));
    tempDirs.push(tmpHome);
    const customHome = path.join(tmpHome, 'custom-kimi-code');
    const overrideBin = makeExec(tmpHome, 'override/kimi-override');
    const customBin = makeExec(customHome, 'bin/kimi');
    const v2Bin = makeExec(tmpHome, '.kimi-code/bin/kimi');
    const legacyBin = makeExec(tmpHome, '.local/bin/kimi');

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      KIMI_CODE_HOME: customHome,
      KIMI_CLI_PATH: overrideBin,
      PATH: '/usr/bin',
    })).toBe(overrideBin);

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      KIMI_CODE_HOME: customHome,
      PATH: '/usr/bin',
    })).toBe(customBin);

    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      PATH: '/usr/bin',
    })).toBe(v2Bin);

    rmSync(v2Bin);
    expect(resolveKimiPathForSdk('kimi', {
      HOME: tmpHome,
      PATH: '/usr/bin',
    })).toBe(legacyBin);
  });
});

describe('KimiV2Provider', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
    state.handlers = null;
    state.spawnError = null;
    state.autoExitOnKill = true;
    state.children = [];
    state.connQueue = [];
    state.conn = makeMockConn();
    mockSpawn.mockReset();
    mockKillProcessTree.mockClear();
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      state.children.push(child);
      if (state.spawnError) {
        const err = state.spawnError;
        queueMicrotask(() => child.emit('error', err));
      }
      return child;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
  });

  it('honors explicit ProviderConfig.binaryPath over KIMI_CLI_PATH and candidate fallbacks', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kimi-binpath-'));
    const origCliPath = process.env.KIMI_CLI_PATH;
    try {
      const envBin = path.join(tmpDir, 'env-kimi');
      const cfgBin = path.join(tmpDir, 'cfg-kimi');
      writeFileSync(envBin, '#!/bin/sh\necho env\n');
      writeFileSync(cfgBin, '#!/bin/sh\necho cfg\n');
      chmodSync(envBin, 0o755);
      chmodSync(cfgBin, 0o755);

      process.env.KIMI_CLI_PATH = envBin;
      const provider = new KimiV2Provider();
      await provider.connect({ binaryPath: cfgBin });
      await provider.createSession({ sessionKey: 'sess-bin', cwd: tmpDir });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]![0]).toBe(cfgBin);
      await provider.disconnect();
    } finally {
      if (origCliPath === undefined) delete process.env.KIMI_CLI_PATH;
      else process.env.KIMI_CLI_PATH = origCliPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('implements send-start admission boundary separately from prompt completion and refuses fake cancel terminal on grace expiry', async () => {
    vi.useFakeTimers();
    state.autoExitOnKill = false;
    let resolvePrompt!: (v: { stopReason: string }) => void;
    state.conn = makeMockConn({
      prompt: vi.fn(() => new Promise((r) => { resolvePrompt = r; })),
    });

    const provider = new KimiV2Provider({ cancelGraceMs: 50 });
    const completes: Array<{ content: string }> = [];
    const errors: Array<{ code: string }> = [];
    provider.onComplete((_, m) => completes.push({ content: m.content }));
    provider.onError((_, e) => errors.push({ code: e.code }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-adm', cwd: os.tmpdir() });

    // send() must resolve right after invoking prompt() even while promptRpc stays pending
    await expect(provider.send('sess-adm', 'turn A')).resolves.toBeUndefined();
    expect(state.conn!.prompt).toHaveBeenCalledTimes(1);
    expect(completes).toHaveLength(0);

    // Busy guard blocks overlapping send() while turn A is still in flight
    await expect(provider.send('sess-adm', 'turn B')).rejects.toThrow(/in-flight/i);

    // Start cancelAndWait while prompt ignores cancel AND child refuses to exit when grace fires
    let stopResolved = false;
    const stopPromise = provider.cancelAndWait('sess-adm').then(() => { stopResolved = true; });
    await vi.advanceTimersByTimeAsync(100);

    // Grace timer cancelled local in-flight state, emitted error, called killProcessTree,
    // yet did NOT fake a physical stop proof because captured prompt & child did not exit.
    expect(mockKillProcessTree).toHaveBeenCalledTimes(1);
    expect(errors.some((e) => e.code === PROVIDER_ERROR_CODES.CANCELLED)).toBe(true);
    expect(stopResolved).toBe(false);

    // Settling the original captured prompt physically completes stop confirmation
    resolvePrompt({ stopReason: 'cancelled' });
    await stopPromise;
    expect(stopResolved).toBe(true);

    await provider.disconnect();
  });

  it('coordinates with TransportSessionRuntime for send-start queuing and Stop-and-send confirmation', async () => {
    let resolveFirst!: (v: { stopReason: string }) => void;
    let resolveSecond!: (v: { stopReason: string }) => void;
    const promptFn = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    state.conn = makeMockConn({ prompt: promptFn });

    const provider = new KimiV2Provider();
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'deck_kimi_v2_rt');
    try {
      await runtime.initialize({ sessionKey: 'deck_kimi_v2_rt', cwd: os.tmpdir() });
      const sentA = runtime.send('msg A', 'id-a');
      await vi.waitFor(() => expect(promptFn).toHaveBeenCalledTimes(1));

      // While A is in flight, B stays queued and cannot preempt A
      const sentB = runtime.send('msg B', 'id-b');
      await Promise.resolve();
      expect(promptFn).toHaveBeenCalledTimes(1);

      // Stop-and-send waits for physical terminal of A before releasing B
      let stopDone = false;
      const cancelPromise = runtime.cancel({ waitForProvider: true }).then(() => { stopDone = true; });
      await vi.waitFor(() => expect(state.conn!.cancel).toHaveBeenCalledWith({ sessionId: 'kimi-sess-1' }));
      expect(stopDone).toBe(false);
      expect(promptFn).toHaveBeenCalledTimes(1);

      resolveFirst({ stopReason: 'cancelled' });
      await Promise.all([sentA, cancelPromise]);
      expect(stopDone).toBe(true);

      await vi.waitFor(() => expect(promptFn).toHaveBeenCalledTimes(2));
      resolveSecond({ stopReason: 'end_turn' });
      await sentB;
    } finally {
      await runtime.kill({ reason: 'test_cleanup' });
    }
  });

  it('triggers late stop proof on runtime stop timeout and rejects physical confirmation on stream error while child stays alive', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (v: { stopReason: string }) => void;
    let resolveSecond!: (v: { stopReason: string }) => void;
    const promptFn = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    state.conn = makeMockConn({ prompt: promptFn });

    const provider = new KimiV2Provider({ cancelGraceMs: 60_000 });
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'deck_kimi_v2_late_stop');
    try {
      await runtime.initialize({ sessionKey: 'deck_kimi_v2_late_stop', cwd: os.tmpdir() });
      const sentA = runtime.send('msg A', 'id-a');
      await vi.advanceTimersByTimeAsync(0);
      expect(promptFn).toHaveBeenCalledTimes(1);

      // Direct WeakMap identity check on returned Promise
      const lateProof = vi.fn();
      const rawStop = provider.cancelAndWait('deck_kimi_v2_late_stop');
      void rawStop.catch(() => {});
      const unsub = onConfirmedProviderStop(rawStop, lateProof);
      expect(typeof unsub).toBe('function');

      // Queue msg B and trigger runtime Stop-and-send that times out after TRANSPORT_STOP_QUEUE_TIMEOUT_MS
      runtime.send('msg B', 'id-b');
      const cancelPromise = runtime.cancel({ waitForProvider: true }).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(TRANSPORT_STOP_QUEUE_TIMEOUT_MS + 100);
      const cancelResult = await cancelPromise;
      expect(cancelResult).toBeInstanceOf(Error);
      expect(lateProof).not.toHaveBeenCalled();
      expect(promptFn).toHaveBeenCalledTimes(1);

      // Late native terminal settles original prompt -> fires onConfirmedProviderStop -> releases B
      resolveFirst({ stopReason: 'cancelled' });
      await vi.advanceTimersByTimeAsync(20);
      expect(lateProof).toHaveBeenCalledTimes(1);
      expect(promptFn).toHaveBeenCalledTimes(2);
      resolveSecond({ stopReason: 'end_turn' });
      await vi.advanceTimersByTimeAsync(10);
      unsub();
    } finally {
      await runtime.kill({ reason: 'test_cleanup' });
    }

    // Stream/transport rejection while captured child is STILL ALIVE must trigger bounded reclaim,
    // keep cancelAndWait unconfirmed until child physically exits, drain runtime queue after exit,
    // and establish a fresh child connection on subsequent send.
    vi.useRealTimers();
    let rejectPrompt!: (e: Error) => void;
    let resolveNextPrompt!: (v: { stopReason: string }) => void;
    const deadConn = makeMockConn({
      prompt: vi.fn(() => new Promise((_, rej) => { rejectPrompt = rej; })),
    });
    const freshConn = makeMockConn({
      resumeSession: vi.fn(async () => ({ configOptions: [] })),
      prompt: vi.fn(() => new Promise((r) => { resolveNextPrompt = r; })),
    });
    state.connQueue.push(deadConn, freshConn);

    let finishControlledKill!: () => void;
    const controlledKillStarted = new Promise<void>((resolveStarted) => {
      mockKillProcessTree.mockImplementationOnce(async (child: { killed?: boolean; exitCode?: number | null; emit?: (ev: string, ...args: unknown[]) => void }) => {
        resolveStarted();
        await new Promise<void>((r) => { finishControlledKill = r; });
        if (child) {
          child.killed = true;
          child.exitCode = 0;
          child.emit?.('exit', 0, null);
        }
      });
    });

    const streamProvider = new KimiV2Provider({ cancelGraceMs: 60_000, closeTimeoutMs: 5_000 });
    await streamProvider.connect({});
    const streamRuntime = new TransportSessionRuntime(streamProvider, 'deck_kimi_v2_dead_stream');
    try {
      await streamRuntime.initialize({ sessionKey: 'deck_kimi_v2_dead_stream', cwd: os.tmpdir() });
      streamRuntime.send('turn on dying stream', 'dead-a');
      await vi.waitFor(() => expect(deadConn.prompt).toHaveBeenCalledTimes(1));

      // Trigger pending approval on origin route so we verify dead stream clears provider_wait on origin too
      const originApprovalPromise = state.handlers!.requestPermission({
        sessionId: 'kimi-sess-1',
        toolCall: { toolCallId: 'tc-dead', title: 'bash', kind: 'execute' },
        options: [{ optionId: 'approve_once', name: 'Allow', kind: 'allow_once' }],
      } as never).catch((e: Error) => e);
      expect(streamProvider.getActiveWorkSnapshot('deck_kimi_v2_dead_stream')?.busyReasons).toContain('provider_wait');

      let stopSettled = false;
      const stopWait = streamProvider.cancelAndWait('deck_kimi_v2_dead_stream').then(() => { stopSettled = true; });
      const lateProofFn = vi.fn();
      const lateProof = streamProvider.cancelAndWait('deck_kimi_v2_dead_stream');
      onConfirmedProviderStop(lateProof, lateProofFn);

      // Stream rejects with non-RequestError while child process stays alive -> triggers reclaim
      rejectPrompt(new Error('stream pipe closed unexpectedly'));
      await controlledKillStarted;
      await Promise.resolve();
      expect(await originApprovalPromise).toBeInstanceOf(Error);
      expect(streamProvider.getActiveWorkSnapshot('deck_kimi_v2_dead_stream')).toMatchObject({
        activeWorkCount: 0,
        busyReasons: [],
      });
      expect(stopSettled).toBe(false);
      expect(lateProofFn).not.toHaveBeenCalled();

      // Dead child finally exits via controlled kill -> confirms original stop proof
      finishControlledKill();
      await Promise.all([stopWait, lateProof]);
      expect(stopSettled).toBe(true);
      expect(lateProofFn).toHaveBeenCalledTimes(1);

      // Next send establishes a brand-new child + connection instead of reusing the dead stream
      const queuedNext = streamRuntime.send('recover after dead stream', 'fresh-b');
      await vi.waitFor(() => expect(freshConn.prompt).toHaveBeenCalledTimes(1));

      resolveNextPrompt({ stopReason: 'end_turn' });
      await queuedNext;
      expect(streamProvider.getSessionDiagnostics('deck_kimi_v2_dead_stream')?.connected).toBe(true);
    } finally {
      await streamRuntime.kill({ reason: 'test_cleanup' });
    }
  });

  it('keeps bindExistingKey local route separate from native resumeId and emits updated resumeId on reconnect fallback', async () => {
    const conn1 = makeMockConn({
      resumeSession: vi.fn(async () => ({ configOptions: [] })),
    });
    const conn2 = makeMockConn({
      resumeSession: vi.fn(async () => { throw new RequestError(-32002, 'Session expired'); }),
      newSession: vi.fn(async () => ({ sessionId: 'native-acp-id-2', configOptions: [] })),
    });
    const conn3 = makeMockConn({
      resumeSession: vi.fn(async () => ({ configOptions: [] })),
    });
    state.connQueue.push(conn1, conn2, conn3);

    const provider = new KimiV2Provider();
    const infoEvents: Array<{ sessionId: string; resumeId?: string }> = [];
    provider.onSessionInfo((sid, info) => infoEvents.push({ sessionId: sid, resumeId: info.resumeId }));
    await provider.connect({});

    // Cold restore receives both local bindExistingKey AND remote resumeId: must resume native ACP id!
    const routeKey = await provider.createSession({
      sessionKey: 'local-route-uuid',
      bindExistingKey: 'local-route-uuid',
      resumeId: 'native-acp-id-1',
      cwd: os.tmpdir(),
    });
    expect(routeKey).toBe('local-route-uuid');
    expect(conn1.resumeSession).toHaveBeenCalledWith({
      sessionId: 'native-acp-id-1',
      cwd: expect.any(String),
      mcpServers: expect.any(Array),
    });

    // Crash child 1 -> send() falls back to newSession() -> MUST emit updated resumeId 'native-acp-id-2'
    state.children[0]!.exitCode = 1;
    state.children[0]!.emit('exit', 1, null);
    await provider.send('local-route-uuid', 'trigger fallback');
    expect(infoEvents.some((e) => e.resumeId === 'native-acp-id-2')).toBe(true);
    await provider.disconnect();

    // Subsequent restart using persisted new resumeId resumes 'native-acp-id-2'
    const provider2 = new KimiV2Provider();
    await provider2.connect({});
    await provider2.createSession({
      sessionKey: 'local-route-uuid',
      bindExistingKey: 'local-route-uuid',
      resumeId: 'native-acp-id-2',
      cwd: os.tmpdir(),
    });
    expect(conn3.resumeSession).toHaveBeenCalledWith({
      sessionId: 'native-acp-id-2',
      cwd: expect.any(String),
      mcpServers: expect.any(Array),
    });
    await provider2.disconnect();
  });

  it('serializes delayed teardown + spawn inside one connecting transaction and fences stale child notifications', async () => {
    const conn1 = makeMockConn({ newSession: vi.fn(async () => ({ sessionId: 'old-acp-1', configOptions: [] })) });
    const conn2 = makeMockConn({
      newSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: 'new-acp-1', configOptions: [] })
        .mockResolvedValueOnce({ sessionId: 'new-acp-2', configOptions: [] }),
    });
    state.connQueue.push(conn1, conn2);

    const provider = new KimiV2Provider();
    await provider.connect({ env: { KIMI_API_KEY: 'k1' } } as never);
    await provider.createSession({ sessionKey: 'seed', cwd: os.tmpdir(), env: { KIMI_API_KEY: 'k1' } });
    const oldHandlers = state.handlers!;
    await provider.detachSession('seed');

    // Reconnect with changed auth env while mockKillProcessTree stalls teardown
    let resolveKill!: () => void;
    mockKillProcessTree.mockImplementationOnce(async (child: { killed?: boolean; exitCode?: number | null; emit?: (ev: string, ...args: unknown[]) => void }) => {
      await new Promise<void>((r) => { resolveKill = r; });
      if (child) {
        child.killed = true;
        child.exitCode = 0;
        child.emit?.('exit', 0, null);
      }
    });

    const pA = provider.createSession({ sessionKey: 'cA', cwd: os.tmpdir(), env: { KIMI_API_KEY: 'k2' } });
    const pB = provider.createSession({ sessionKey: 'cB', cwd: os.tmpdir(), env: { KIMI_API_KEY: 'k2' } });
    await vi.waitFor(() => expect(resolveKill).toBeTypeOf('function'));
    expect(mockSpawn).toHaveBeenCalledTimes(1); // Only initial child so far, no double spawn!

    resolveKill();
    await Promise.all([pA, pB]);
    expect(mockSpawn).toHaveBeenCalledTimes(2); // Exactly ONE replacement child spawned!

    // Stale notification from superseded child 1 handlers must be ignored
    const deltas: string[] = [];
    provider.onDelta((_, d) => deltas.push(d.delta));
    await oldHandlers.sessionUpdate({
      sessionId: 'new-acp-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale-leak' } } as never,
    });
    expect(deltas).toEqual([]);

    await provider.disconnect();
  });

  it('prevents disconnect during delayed teardown and endSession during delayed newSession from reviving retired processes or routes', async () => {
    const conn1 = makeMockConn();
    state.connQueue.push(conn1);

    const provider = new KimiV2Provider();
    await provider.connect({ env: { KIMI_API_KEY: 'v1' } } as never);
    await provider.createSession({ sessionKey: 's-old', cwd: os.tmpdir(), env: { KIMI_API_KEY: 'v1' } });
    await provider.detachSession('s-old');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    let resolveTeardownKill!: () => void;
    mockKillProcessTree.mockImplementationOnce(async (child: { killed?: boolean; exitCode?: number | null; emit?: (ev: string, ...args: unknown[]) => void }) => {
      await new Promise<void>((r) => { resolveTeardownKill = r; });
      if (child) {
        child.killed = true;
        child.exitCode = 0;
        child.emit?.('exit', 0, null);
      }
    });

    // Start createSession that stalls awaiting teardownChildProcess(), then call disconnect()
    const inFlightCreate = provider.createSession({ sessionKey: 's-zombie', cwd: os.tmpdir(), env: { KIMI_API_KEY: 'v2' } }).catch((e: Error) => e);
    await vi.waitFor(() => expect(resolveTeardownKill).toBeTypeOf('function'));

    await provider.disconnect();
    expect(provider.getSessionDiagnostics('s-zombie')).toBeNull();

    // Release delayed teardown kill -> must NOT spawn or publish child/connection on retired provider
    resolveTeardownKill();
    const createErr = await inFlightCreate;
    expect(createErr).toBeInstanceOf(Error);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(provider.getSessionDiagnostics('s-zombie')).toBeNull();

    // Delayed newSession finishing after endSession must not resurrect the ended route
    let resolveDelayedNew!: (v: unknown) => void;
    const delayedConn = makeMockConn({
      newSession: vi.fn(() => new Promise((r) => { resolveDelayedNew = r; })),
    });
    state.connQueue.push(delayedConn);
    const provider2 = new KimiV2Provider();
    await provider2.connect({});
    const delayedCreate = provider2.createSession({ sessionKey: 's-ended', cwd: os.tmpdir() }).catch((e: Error) => e);
    await vi.waitFor(() => expect(resolveDelayedNew).toBeTypeOf('function'));
    await provider2.endSession('s-ended');

    resolveDelayedNew({ sessionId: 'zombie-native-id', configOptions: [] });
    const endedResult = await delayedCreate;
    expect(endedResult).toBeInstanceOf(Error);
    expect(provider2.getSessionDiagnostics('s-ended')).toBeNull();
    expect(provider2.getSessionDiagnostics('zombie-native-id')).toBeNull();
    await provider2.disconnect();
  });

  it('keeps pendingModel unconfirmed after failed switch on reconnect so next send retries model before prompt without recreating session', async () => {
    const v2Conn1 = makeMockConn();
    const v2Conn2 = makeMockConn({
      resumeSession: vi.fn(async () => ({
        configOptions: [{
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k2.5',
          options: [
            { value: 'kimi-k2.5', name: 'Kimi K2.5' },
            { value: 'kimi-for-coding', name: 'Kimi for Coding' },
          ],
        }],
      })),
      setSessionConfigOption: vi.fn()
        .mockRejectedValueOnce(new RequestError(-32603, 'Temporary model backend failure'))
        .mockResolvedValue({ configOptions: [] }),
    });
    state.connQueue.push(v2Conn1, v2Conn2);

    const provider = new KimiV2Provider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-retry-mod', cwd: os.tmpdir(), model: 'kimi-for-coding' });
    expect(provider.getSessionDiagnostics('sess-retry-mod')?.model).toBe('kimi-for-coding');

    // Crash child 1 -> reconnect fails model switch on first send()
    state.children[0]!.exitCode = 1;
    state.children[0]!.emit('exit', 1, null);

    await expect(provider.send('sess-retry-mod', 'first try')).rejects.toThrow(/Temporary model backend failure/);
    expect(v2Conn2.prompt).not.toHaveBeenCalled();
    expect(v2Conn2.resumeSession).toHaveBeenCalledTimes(1);
    expect(provider.getSessionDiagnostics('sess-retry-mod')?.model).toBe('kimi-k2.5');

    // Next send() retries pendingModel ('kimi-for-coding') without calling resumeSession again, then runs prompt
    await provider.send('sess-retry-mod', 'second try');
    expect(v2Conn2.resumeSession).toHaveBeenCalledTimes(1);
    expect(v2Conn2.setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(v2Conn2.prompt).toHaveBeenCalledTimes(1);
    expect(provider.getSessionDiagnostics('sess-retry-mod')?.model).toBe('kimi-for-coding');

    await provider.disconnect();
  });

  it('awaits a single shared initialize across concurrent createSession calls, re-resumes after child crash, and bounds close timeout', async () => {
    let resolveInit!: (val: unknown) => void;
    const conn1 = makeMockConn({
      initialize: vi.fn(() => new Promise((r) => { resolveInit = r; })),
      newSession: vi.fn()
        .mockResolvedValueOnce({ sessionId: 's1', configOptions: [] })
        .mockResolvedValueOnce({ sessionId: 's2', configOptions: [] }),
    });
    const conn2 = makeMockConn({
      resumeSession: vi.fn(async () => ({ configOptions: [] })),
    });
    state.connQueue.push(conn1, conn2);

    const provider = new KimiV2Provider({ closeTimeoutMs: 30 });
    await provider.connect({});

    // Two concurrent createSession calls must share ONE initialize() and wait for capabilities
    const p1 = provider.createSession({ sessionKey: 'k1', cwd: os.tmpdir() });
    const p2 = provider.createSession({ sessionKey: 'k2', cwd: os.tmpdir() });
    await vi.waitFor(() => expect(conn1.initialize).toHaveBeenCalledTimes(1));
    expect(conn1.newSession).not.toHaveBeenCalled();

    resolveInit({
      protocolVersion: 1,
      agentInfo: { name: 'Kimi Code CLI', version: '2.8.1' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    });
    await Promise.all([p1, p2]);
    expect(conn1.initialize).toHaveBeenCalledTimes(1);
    expect(provider.getSessionDiagnostics('k2')).toMatchObject({ capabilities: { resume: true, image: true } });

    // Crash child 1 unexpectedly; next send on k1 must respawn and resumeSession before prompt!
    state.children[0]!.exitCode = 1;
    state.children[0]!.emit('exit', 1, null);

    await provider.send('k1', 'after crash');
    expect(conn2.initialize).toHaveBeenCalledTimes(1);
    expect(conn2.resumeSession).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: expect.any(String),
      mcpServers: expect.any(Array),
    });
    expect(conn2.prompt).toHaveBeenCalledTimes(1);

    // closeSession hanging must not block endSession teardown
    conn2.closeSession.mockImplementationOnce(() => new Promise(() => {}));
    await provider.endSession('k2');
    await provider.endSession('k1');
    expect(mockKillProcessTree).toHaveBeenCalledWith(state.children[1], { ownsProcessGroup: true });
  });

  it('falls back cleanly to newSession when createSession has resumeId but agent supports neither resume nor load', async () => {
    state.conn = makeMockConn({
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Minimal Kimi', version: '1.0.0' },
        agentCapabilities: {},
      })),
      newSession: vi.fn(async () => ({ sessionId: 'fresh-fallback-1' })),
    });

    const provider = new KimiV2Provider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-no-res', cwd: os.tmpdir(), resumeId: 'old-id' });
    expect(state.conn!.newSession).toHaveBeenCalledTimes(1);
    expect(provider.getSessionDiagnostics('sess-no-res')).toMatchObject({ providerSessionId: 'fresh-fallback-1' });
    await provider.disconnect();
  });

  it('gates listSessions by initialize capability, paginates across cursors, and filters by canonical directory', async () => {
    // Even though acp-client-adapter always exposes listSessions(), missing sessionCapabilities.list must skip RPC
    state.conn = makeMockConn({
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Kimi CLI', version: '1.44.0' },
        agentCapabilities: { loadSession: true },
      })),
    });
    const noListProvider = new KimiV2Provider();
    await noListProvider.connect({});
    expect(await noListProvider.listSessions()).toEqual([]);
    expect(state.conn!.listSessions).not.toHaveBeenCalled();
    await noListProvider.disconnect();

    // With list capability: collects multiple pages, stops on repeated cursor, filters cwd
    const dirA = mkdtempSync(path.join(os.tmpdir(), 'kimi-dir-a-'));
    const dirB = mkdtempSync(path.join(os.tmpdir(), 'kimi-dir-b-'));
    try {
      state.conn = makeMockConn({
        listSessions: vi.fn()
          .mockResolvedValueOnce({
            sessions: [
              { sessionId: 's-a1', title: 'A1', cwd: dirA, updatedAt: '2026-11-28T00:00:00Z' },
              { sessionId: 's-b1', title: 'B1', cwd: dirB, updatedAt: '2026-11-28T00:00:00Z' },
            ],
            nextCursor: 'c2',
          })
          .mockResolvedValueOnce({
            sessions: [
              { sessionId: 's-a2', title: 'A2', cwd: dirA, updatedAt: '2026-11-28T01:00:00Z' },
            ],
            nextCursor: 'c2', // repeated cursor guard terminates loop
          }),
      });
      const listProvider = new KimiV2Provider();
      await listProvider.connect({});
      const listed = await listProvider.listSessions({ directory: dirA });
      expect(state.conn!.listSessions).toHaveBeenCalledTimes(2);
      expect(listed.map((s) => s.key)).toEqual(['s-a1', 's-a2']);
      await listProvider.disconnect();
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('keeps existing model when server rejects applySessionModel and renegotiates capabilities on v2 -> v1 reconnect', async () => {
    const v2Conn = makeMockConn({
      setSessionConfigOption: vi.fn()
        .mockRejectedValueOnce(new RequestError(-32602, 'Invalid model'))
        .mockResolvedValue({ configOptions: [] }),
    });
    const v1Conn = makeMockConn({
      initialize: vi.fn(async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'Kimi CLI', version: '1.44.0' },
        agentCapabilities: { loadSession: true },
      })),
      loadSession: vi.fn(async () => ({
        models: {
          currentModelId: 'kimi-k1',
          availableModels: [
            { modelId: 'kimi-k1', name: 'Kimi K1' },
            { modelId: 'kimi-k1-pro', name: 'Kimi K1 Pro' },
          ],
        },
      })),
      unstable_setSessionModel: vi.fn(async () => ({})),
    });
    state.connQueue.push(v2Conn, v1Conn);

    const provider = new KimiV2Provider();
    const completes: Array<{ metadata?: Record<string, unknown> }> = [];
    provider.onComplete((_, m) => completes.push({ metadata: m.metadata }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-mod', cwd: os.tmpdir() });

    // Server rejects invalid switch -> state.model must stay 'kimi-k2.5'
    await expect(provider.applySessionModel('sess-mod', 'bad-model')).rejects.toThrow(/Invalid model/);
    expect(provider.getSessionDiagnostics('sess-mod')?.model).toBe('kimi-k2.5');

    await provider.send('sess-mod', 'hello');
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0]!.metadata?.model).toBe('kimi-k2.5');

    // v2 crashes and reconnects to legacy v1: provider must NOT stick on v2 configOption mode
    state.children[0]!.exitCode = 1;
    state.children[0]!.emit('exit', 1, null);

    await provider.send('sess-mod', 'on legacy now');
    expect(v1Conn.loadSession).toHaveBeenCalledTimes(1);

    await provider.applySessionModel('sess-mod', 'kimi-k1-pro');
    expect(v1Conn.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: 'kimi-sess-1',
      modelId: 'kimi-k1-pro',
    });
    expect(v1Conn.setSessionConfigOption).not.toHaveBeenCalled();

    await provider.disconnect();
  });

  it('emits transient thinking status on agent_thought_chunk without polluting assistant content and clears status on turn end', async () => {
    let resolvePrompt!: (val: { stopReason: string }) => void;
    state.conn = makeMockConn({
      prompt: vi.fn(() => new Promise((r) => { resolvePrompt = r; })),
    });

    const provider = new KimiV2Provider();
    const statuses: ProviderStatusUpdate[] = [];
    const deltas: string[] = [];
    const completes: string[] = [];
    provider.onStatus((_, s) => statuses.push(s));
    provider.onDelta((_, d) => deltas.push(d.delta));
    provider.onComplete((_, m) => completes.push(m.content));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-think', cwd: os.tmpdir() });
    await provider.send('sess-think', 'reason then answer');

    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden chain of thought' } } as never,
    });
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'more thought' } } as never,
    });
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'visible reply' } } as never,
    });

    resolvePrompt({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(completes).toHaveLength(1));

    expect(statuses).toEqual([
      { status: 'thinking', label: 'Thinking...' },
      { status: null, label: null },
    ]);
    expect(deltas).toEqual(['visible reply']);
    expect(completes).toEqual(['visible reply']);

    await provider.disconnect();
  });

  it('covers attachments, usage_update {used, size} + tokens, -32000 auth, ENOENT, requestPermission, and detachSession', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kimi-misc-'));
    try {
      const imgPath = path.join(tmpDir, 'shot.png');
      const txtPath = path.join(tmpDir, 'notes.txt');
      writeFileSync(imgPath, Buffer.from('pngbytes'));
      writeFileSync(txtPath, 'hello notes');

      const usages: unknown[] = [];
      const completes: Array<{ content: string }> = [];
      const provider = new KimiV2Provider();
      provider.onUsage((_, u) => usages.push(u));
      provider.onComplete((_, m) => completes.push({ content: m.content }));

      await provider.connect({});
      await provider.createSession({ sessionKey: 'sess-misc', cwd: tmpDir });

      state.conn!.prompt.mockImplementationOnce(async () => {
        await state.handlers!.sessionUpdate({
          sessionId: 'kimi-sess-1',
          update: { sessionUpdate: 'usage_update', used: 12000, size: 262144 } as never,
        });
        await state.handlers!.sessionUpdate({
          sessionId: 'kimi-sess-1',
          update: { sessionUpdate: 'usage_update', tokens: { input: 500, output: 100, cached: 50, limit: 128000 } } as never,
        });
        await state.handlers!.sessionUpdate({
          sessionId: 'kimi-sess-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } as never,
        });
        return { stopReason: 'end_turn' };
      });

      await provider.send('sess-misc', 'inspect', [
        { id: '1', daemonPath: imgPath, originalName: 'shot.png', mime: 'image/png', type: 'image', size: 8 },
        { id: '2', daemonPath: txtPath, originalName: 'notes.txt', mime: 'text/plain', type: 'file', size: 11 },
      ]);
      await vi.waitFor(() => expect(completes).toHaveLength(1));

      const promptArg = state.conn!.prompt.mock.calls[0]![0] as { prompt: Array<Record<string, unknown>> };
      expect(promptArg.prompt[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(promptArg.prompt[2]).toMatchObject({ type: 'resource_link', name: 'notes.txt' });
      expect(usages).toEqual([
        expect.objectContaining({ usage: { input_tokens: 12000, model_context_window: 262144 } }),
        expect.objectContaining({
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cached_input_tokens: 50,
            cache_read_input_tokens: 50,
            model_context_window: 128000,
          },
        }),
      ]);

      // /compact passes raw '/compact' cleanly without context wrapper
      await provider.send('sess-misc', '/compact');
      const compactArg = state.conn!.prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> };
      expect(compactArg.prompt[0]!.text).toBe('/compact');

      // Approval round-trip & detach without closeSession
      const approvals: Array<{ id: string }> = [];
      provider.onApprovalRequest((_, r) => approvals.push({ id: r.id }));
      const permPromise = state.handlers!.requestPermission({
        sessionId: 'kimi-sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'bash', kind: 'execute' },
        options: [{ optionId: 'approve_once', name: 'Allow', kind: 'allow_once' }],
      } as never);
      await provider.respondApproval('sess-misc', approvals[0]!.id, true);
      expect(await permPromise).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } });

      await provider.detachSession('sess-misc');
      expect(state.conn!.closeSession).not.toHaveBeenCalled();
      await provider.disconnect();

      // -32000 auth error in listModels + ENOENT on spawn
      state.conn = makeMockConn({
        newSession: vi.fn(async () => { throw new RequestError(-32000, 'Authentication required'); }),
      });
      const authProvider = new KimiV2Provider();
      await authProvider.connect({});
      expect(await authProvider.listModels()).toMatchObject({
        models: [],
        isAuthenticated: false,
        error: expect.stringContaining('/login'),
      });
      await authProvider.disconnect();

      state.conn = makeMockConn({ initialize: vi.fn(() => new Promise(() => {})) });
      state.spawnError = Object.assign(new Error('spawn kimi ENOENT'), { code: 'ENOENT' });
      const enoentProvider = new KimiV2Provider();
      await enoentProvider.connect({});
      await expect(enoentProvider.createSession({ sessionKey: 's-missing', cwd: tmpDir })).rejects.toMatchObject({
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: expect.stringContaining('@moonshot-ai/kimi-code'),
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isolates current-context usage_update/_meta from cumulative PromptResponse.usage across turns and keeps multi-session isolation', async () => {
    let sessCounter = 0;
    const statusesA: ProviderStatusUpdate[] = [];
    const statusesB: ProviderStatusUpdate[] = [];
    const usagesA: Array<{ messageId?: string; finalized?: boolean; usage?: Record<string, unknown> }> = [];
    const usagesB: unknown[] = [];
    const completesA: Array<{ metadata?: Record<string, unknown> }> = [];
    const completesB: Array<{ metadata?: Record<string, unknown> }> = [];

    state.conn = makeMockConn({
      newSession: vi.fn(async () => ({ sessionId: `kimi-iso-${++sessCounter}` })),
    });

    const provider = new KimiV2Provider();
    provider.onStatus((sid, s) => {
      if (sid === 'sess-a') statusesA.push(s);
      if (sid === 'sess-b') statusesB.push(s);
    });
    provider.onUsage((sid, u) => {
      if (sid === 'sess-a') usagesA.push(u as never);
      if (sid === 'sess-b') usagesB.push(u);
    });
    provider.onComplete((sid, m) => {
      if (sid === 'sess-a') completesA.push({ metadata: m.metadata });
      if (sid === 'sess-b') completesB.push({ metadata: m.metadata });
    });

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-a', cwd: os.tmpdir() });
    await provider.createSession({ sessionKey: 'sess-b', cwd: os.tmpdir() });

    expect(state.conn.initialize).toHaveBeenCalledWith(expect.objectContaining({
      clientCapabilities: expect.objectContaining({
        session: { compaction: {} },
      }),
    }));

    // Turn 1 on sess-a: compaction commits + live usage_update sets current occupancy,
    // while PromptResponse.usage cumulative totals go strictly to metadata.cumulativeUsage.
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'in_progress' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text: 'Summary' } } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-1', status: 'completed' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: '_vendor_ext_update', extra: 1 } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'usage_update', used: 12000, size: 200000 } as never,
      });
      return {
        stopReason: 'end_turn',
        usage: { totalTokens: 15000, inputTokens: 12000, outputTokens: 3000, cachedReadTokens: 15, cachedWriteTokens: 5 },
      };
    });

    await provider.send('sess-a', {
      context: { sessionSystemText: 'SYS_A' },
      assembledMessage: 'hello a',
      sessionSystemText: 'SYS_A',
    } as never);
    await vi.waitFor(() => expect(completesA).toHaveLength(1));

    expect(statusesA).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed', compactionSessionVerified: true },
    ]);
    expect(statusesB).toEqual([]);
    expect(usagesB).toEqual([]);
    expect(usagesA).toEqual([
      expect.objectContaining({ usage: { input_tokens: 12000, model_context_window: 200000 } }),
    ]);
    expect(completesA[0]!.metadata).toMatchObject({
      compacted: true,
      usage: { input_tokens: 12000, model_context_window: 200000 },
      cumulativeUsage: {
        totalTokens: 15000,
        inputTokens: 12000,
        outputTokens: 3000,
        cachedReadTokens: 15,
        cachedWriteTokens: 5,
      },
    });

    // Turn 2 on sess-a: NO usage_update and NO _meta occupancy, only cumulative PromptResponse.usage (110k/10k).
    // Historical cumulative tokens must NEVER be emitted via onUsage or metadata.usage.
    // Also Turn 1's committed compaction must trigger SYS_A re-injection here.
    usagesA.length = 0;
    statusesA.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => ({
      stopReason: 'end_turn',
      usage: { totalTokens: 120000, inputTokens: 110000, outputTokens: 10000 },
    }));

    await provider.send('sess-a', {
      context: { sessionSystemText: 'SYS_A' },
      assembledMessage: 'turn 2',
      sessionSystemText: 'SYS_A',
    } as never);
    await vi.waitFor(() => expect(completesA).toHaveLength(2));
    const turn2Prompt = (state.conn.prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
    expect(turn2Prompt).toContain('SYS_A');
    expect(usagesA).toEqual([]);
    expect(completesA[1]!.metadata?.usage).toBeUndefined();
    expect(completesA[1]!.metadata?.cumulativeUsage).toEqual({
      totalTokens: 120000,
      inputTokens: 110000,
      outputTokens: 10000,
    });

    // Turn 3 on sess-a: explicit _meta window patch onto usage_update without size, and Turn 4 explicit _meta snapshot.
    usagesA.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'usage_update', used: 19000 } as never,
      });
      return {
        stopReason: 'end_turn',
        usage: { totalTokens: 150000, inputTokens: 140000, outputTokens: 10000 },
        _meta: { model_context_window: 256000 },
      };
    });
    await provider.send('sess-a', {
      context: { sessionSystemText: 'SYS_A' },
      assembledMessage: 'turn 3',
      sessionSystemText: 'SYS_A',
    } as never);
    await vi.waitFor(() => expect(completesA).toHaveLength(3));
    const turn3Prompt = (state.conn.prompt.mock.calls[2]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
    expect(turn3Prompt).not.toContain('SYS_A');
    expect(usagesA).toEqual([
      expect.objectContaining({ usage: { input_tokens: 19000, model_context_window: 200000 } }),
      expect.objectContaining({ finalized: true, usage: { input_tokens: 19000, model_context_window: 256000 } }),
    ]);
    expect(completesA[2]!.metadata).toMatchObject({
      usage: { input_tokens: 19000, model_context_window: 256000 },
      cumulativeUsage: { totalTokens: 150000, inputTokens: 140000, outputTokens: 10000 },
    });

    usagesA.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => ({
      stopReason: 'end_turn',
      usage: { totalTokens: 170000, inputTokens: 160000, outputTokens: 10000 },
      _meta: { used: 21000, size: 256000 },
    }));
    await provider.send('sess-a', 'turn 4');
    await vi.waitFor(() => expect(completesA).toHaveLength(4));
    expect(usagesA).toEqual([
      expect.objectContaining({ finalized: true, usage: { input_tokens: 21000, model_context_window: 256000 } }),
    ]);
    expect(completesA[3]!.metadata).toMatchObject({
      usage: { input_tokens: 21000, model_context_window: 256000 },
      cumulativeUsage: { totalTokens: 170000, inputTokens: 160000, outputTokens: 10000 },
    });

    // Turn 5 on sess-a: `used` already includes cached tokens -> subtract consistent breakdown so relay/Web total stays 1000 (not 1200/1250),
    // and omit unreliable breakdown when cached exceeds `used`.
    usagesA.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'usage_update', used: 1000, size: 4096, tokens: { cached: 200 } } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-iso-1',
        update: { sessionUpdate: 'usage_update', used: 1000, size: 4096, tokens: { cached: 1200 } } as never,
      });
      return {
        stopReason: 'end_turn',
        usage: { totalTokens: 190000, inputTokens: 180000, outputTokens: 10000 },
        _meta: { used: 1000, size: 4096, cachedReadTokens: 200, cachedWriteTokens: 50 },
      };
    });
    await provider.send('sess-a', 'turn 5');
    await vi.waitFor(() => expect(completesA).toHaveLength(5));
    expect(usagesA).toEqual([
      expect.objectContaining({
        usage: { input_tokens: 800, cached_input_tokens: 200, cache_read_input_tokens: 200, model_context_window: 4096 },
      }),
      expect.objectContaining({
        usage: { input_tokens: 1000, model_context_window: 4096 },
      }),
      expect.objectContaining({
        finalized: true,
        usage: {
          input_tokens: 750,
          cached_input_tokens: 200,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
          model_context_window: 4096,
        },
      }),
    ]);
    const relayStream = transportRelayTesting.normalizeUsageUpdatePayload('deck_kimi_iso', usagesA[0]!.usage, undefined);
    expect((relayStream!.inputTokens as number) + ((relayStream!.cacheTokens as number) ?? 0)).toBe(1000);
    const relayMeta = transportRelayTesting.normalizeUsageUpdatePayload(
      'deck_kimi_iso',
      completesA[4]!.metadata?.usage as never,
      undefined,
    );
    expect((relayMeta!.inputTokens as number) + ((relayMeta!.cacheTokens as number) ?? 0)).toBe(1000);
    expect(completesA[4]!.metadata?.cumulativeUsage).toEqual({
      totalTokens: 190000,
      inputTokens: 180000,
      outputTokens: 10000,
    });

    await provider.disconnect();
  });

  it('tracks compactionId interleaving, rejects post-terminal chunks/patches, and handles /compact failed->end_turn, refusal, cancel, and crash cleanly', async () => {
    let resolveCompact!: (v: unknown) => void;
    state.conn = makeMockConn({
      prompt: vi.fn(() => new Promise((r) => { resolveCompact = r; })),
    });

    const provider = new KimiV2Provider({ cancelGraceMs: 50 });
    const statuses: ProviderStatusUpdate[] = [];
    const completes: Array<{ metadata?: Record<string, unknown> }> = [];
    const errors: Array<{ code: string }> = [];
    provider.onStatus((_, s) => statuses.push(s));
    provider.onComplete((_, m) => completes.push({ metadata: m.metadata }));
    provider.onError((_, e) => errors.push({ code: e.code }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-compact', cwd: os.tmpdir() });

    // Initial normal turn establishes SYS_C injected.
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact', {
      context: { sessionSystemText: 'SYS_C' },
      assembledMessage: 'init',
      sessionSystemText: 'SYS_C',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(1));

    // 1) /compact fails via compaction_update failed even though RPC returns end_turn -> failTurn, no committed/compacted, SYS_C NOT cleared.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-fail', status: 'in_progress' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-fail', status: 'failed', error: 'bad summary' } as never,
      });
      return { stopReason: 'end_turn' };
    });
    await provider.send('sess-compact', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(completes).toHaveLength(1);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    // Next turn must NOT re-inject SYS_C after failed compaction.
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact', {
      context: { sessionSystemText: 'SYS_C' },
      assembledMessage: 'after failed compact',
      sessionSystemText: 'SYS_C',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(2));
    const afterFailedPrompt = (state.conn.prompt.mock.calls.at(-1)![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
    expect(afterFailedPrompt).not.toContain('SYS_C');

    // 2) /compact returns stopReason: 'refusal' -> failTurn, failed outcome, no committed/compacted, SYS_C still intact.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'refusal' }));
    await provider.send('sess-compact', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]!.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(completes).toHaveLength(2);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact', {
      context: { sessionSystemText: 'SYS_C' },
      assembledMessage: 'after refusal',
      sessionSystemText: 'SYS_C',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(3));
    const afterRefusalPrompt = (state.conn.prompt.mock.calls.at(-1)![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
    expect(afterRefusalPrompt).not.toContain('SYS_C');

    // 3) Legacy eventless /compact completes -> emits compacting then committed clear.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(() => new Promise((r) => { resolveCompact = r; }));
    await provider.send('sess-compact', '/compact');
    expect(statuses).toEqual([{ status: 'compacting', label: 'Compacting conversation...' }]);
    resolveCompact({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(completes).toHaveLength(4));
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed' },
    ]);
    expect(completes[3]!.metadata).toMatchObject({ compacted: true });

    // 4) Interleaved compaction IDs on same session: A in_progress -> B in_progress -> A completed (stays compacting!) ->
    // post-terminal chunk/patch for A ignored -> B completed (now clears) -> post-settle chunk for B ignored.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(() => new Promise((r) => { resolveCompact = r; }));
    await provider.send('sess-compact', {
      context: { sessionSystemText: 'SYS_C' },
      assembledMessage: 'interleaved',
      sessionSystemText: 'SYS_C',
    } as never);
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-A', status: 'in_progress' } as never,
    });
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-B', status: 'in_progress' } as never,
    });
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-A', status: 'completed' } as never,
    });
    // Still compacting because cmp-B is active!
    expect(statuses).toEqual([{ status: 'compacting', label: 'Compacting conversation...' }]);

    // Terminal chunk/patch for cmp-A must not break or emit duplicate status
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-A', content: { type: 'text', text: 'late A' } } as never,
    });
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-B', status: 'completed' } as never,
    });
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed', compactionSessionVerified: true },
    ]);
    // Post-terminal chunk for cmp-B while turn is still open must NOT reopen compacting
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-B', content: { type: 'text', text: 'late B' } } as never,
    });
    resolveCompact({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(completes).toHaveLength(5));
    // Post-settle chunk for any ID must NOT reopen compacting
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-C-late', content: { type: 'text', text: 'after settle' } } as never,
    });
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed', compactionSessionVerified: true },
    ]);

    // 5) Compaction committed BEFORE turn cancel preserves committed truth + re-injection on next turn.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-pre-cancel', status: 'in_progress' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-pre-cancel', status: 'completed' } as never,
      });
      return { stopReason: 'cancelled' };
    });
    await provider.send('sess-compact', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors[2]!.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed', compactionSessionVerified: true },
    ]);

    // Next turn re-injects SYS_C because cmp-pre-cancel committed before cancel!
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact', {
      context: { sessionSystemText: 'SYS_C' },
      assembledMessage: 'after pre-cancel commit',
      sessionSystemText: 'SYS_C',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(6));
    expect((state.conn.prompt.mock.calls.at(-1)![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text).toContain('SYS_C');

    // 6) /compact cancelled without commit clears status with failed outcome.
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(() => new Promise(() => {}));
    await provider.send('sess-compact', '/compact');
    expect(statuses).toEqual([{ status: 'compacting', label: 'Compacting conversation...' }]);
    await provider.cancel('sess-compact');
    await vi.waitFor(() => expect(errors).toHaveLength(4));
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    // 7) Child crash while compaction_update is active clears status cleanly.
    statuses.length = 0;
    state.conn = makeMockConn({ prompt: vi.fn(() => new Promise(() => {})) });
    await provider.send('sess-compact', 'normal work');
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-crash', status: 'in_progress' } as never,
    });
    expect(statuses).toEqual([{ status: 'compacting', label: 'Compacting conversation...' }]);
    const liveChild = state.children.at(-1)!;
    liveChild.exitCode = 1;
    liveChild.emit('exit', 1, null);
    await vi.waitFor(() => expect(errors).toHaveLength(5));
    expect(statuses.at(-1)).toEqual({ status: null, label: null });

    await provider.disconnect();
  });

  it('fails /compact on max_tokens, max_turn_requests, and non-terminal in_progress->end_turn, while preserving matching-ID commit during cancel', async () => {
    let resolvePrompt!: (v: unknown) => void;
    state.conn = makeMockConn({
      prompt: vi.fn(() => new Promise((r) => { resolvePrompt = r; })),
    });

    const provider = new KimiV2Provider();
    const statuses: ProviderStatusUpdate[] = [];
    const completes: Array<{ metadata?: Record<string, unknown> }> = [];
    const errors: Array<{ code: string }> = [];
    provider.onStatus((_, s) => statuses.push(s));
    provider.onComplete((_, m) => completes.push({ metadata: m.metadata }));
    provider.onError((_, e) => errors.push({ code: e.code }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-compact-r2', cwd: os.tmpdir() });

    // Establish injected SYS_R2
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact-r2', {
      context: { sessionSystemText: 'SYS_R2' },
      assembledMessage: 'init',
      sessionSystemText: 'SYS_R2',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(1));

    // 1) Eventless /compact ending with max_tokens -> failTurn, failed outcome, no committed/compacted, SYS_R2 preserved
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'max_tokens' }));
    await provider.send('sess-compact-r2', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(completes).toHaveLength(1);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    // 2) Eventless /compact ending with max_turn_requests -> failTurn, failed outcome, no committed/compacted, SYS_R2 preserved
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'max_turn_requests' }));
    await provider.send('sess-compact-r2', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]!.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(completes).toHaveLength(1);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    // 3) /compact with compaction_update in_progress (no committed terminal) -> end_turn -> failTurn, failed outcome, no committed/compacted
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(async () => {
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-stalled', status: 'in_progress' } as never,
      });
      return { stopReason: 'end_turn' };
    });
    await provider.send('sess-compact-r2', '/compact');
    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors[2]!.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(completes).toHaveLength(1);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'failed' },
    ]);

    // Verify SYS_R2 was NOT cleared by any of those 3 failed /compact attempts
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact-r2', {
      context: { sessionSystemText: 'SYS_R2' },
      assembledMessage: 'after failed compacts',
      sessionSystemText: 'SYS_R2',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(2));
    expect((state.conn.prompt.mock.calls.at(-1)![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text).not.toContain('SYS_R2');

    // 4) in_progress -> local cancel -> untracked new ID ignored -> matching ID completed accepted -> prompt settles cancelled, committed & SYS_R2 refreshed
    statuses.length = 0;
    state.conn.prompt.mockImplementationOnce(() => new Promise((r) => { resolvePrompt = r; }));
    await provider.send('sess-compact-r2', '/compact');
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-cancel-commit', status: 'in_progress' } as never,
    });
    await provider.cancel('sess-compact-r2');

    // New ID arriving during cancel must be rejected
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-new-ignored', status: 'in_progress' } as never,
    });
    // Matching already-tracked ID completing during cancel must be accepted
    await state.handlers!.sessionUpdate({
      sessionId: 'kimi-sess-1',
      update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-cancel-commit', status: 'completed' } as never,
    });
    resolvePrompt({ stopReason: 'cancelled' });
    await vi.waitFor(() => expect(errors).toHaveLength(4));
    expect(errors[3]!.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    expect(completes).toHaveLength(2);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting conversation...' },
      { status: null, label: null, compactionOutcome: 'committed', compactionSessionVerified: true },
    ]);

    // Next turn re-injects SYS_R2 because cmp-cancel-commit committed during cancel!
    state.conn.prompt.mockImplementationOnce(async () => ({ stopReason: 'end_turn' }));
    await provider.send('sess-compact-r2', {
      context: { sessionSystemText: 'SYS_R2' },
      assembledMessage: 'after cancel commit',
      sessionSystemText: 'SYS_R2',
    } as never);
    await vi.waitFor(() => expect(completes).toHaveLength(3));
    expect((state.conn.prompt.mock.calls.at(-1)![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text).toContain('SYS_R2');

    await provider.disconnect();
  });

  it('invalidates TransportSessionRuntime preference/supervision/contract caches when verified compactionId commits during runtime.cancel(), without restoring working or breaking cancel', async () => {
    let resolveTurn!: (v: unknown) => void;
    state.conn = makeMockConn({
      prompt: vi.fn(() => new Promise((r) => {
        setTimeout(() => r({ stopReason: 'end_turn' }), 5);
      })),
    });

    const provider = new KimiV2Provider();
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'deck_kimi_rt_cancel');
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kimi-rt-cancel-'));
    try {
      await runtime.initialize({
        sessionKey: 'deck_kimi_rt_cancel',
        cwd: tmpDir,
        identityPrompt: 'RUNTIME_IDENTITY_ALPHA',
      });

      const preamble = [
        `${PREFERENCE_CONTEXT_START}\n- PREF_ALPHA\n${PREFERENCE_CONTEXT_END}`,
        `${SUPERVISION_CONTRACT_PREAMBLE_START}\nSUPERVISION_ALPHA\n${SUPERVISION_CONTRACT_PREAMBLE_END}`,
      ].join('\n\n');
      const registeredSystemContract = {
        contractId: 'dyn-contract-1',
        signature: 'sig-v1',
        body: 'DYNAMIC_CONTRACT_ALPHA',
      };

      // Turn 1: seeds identity, preference, supervision, and registered contract.
      runtime.send('turn 1', 'msg-rt-1', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      const prompt1 = (state.conn!.prompt.mock.calls[0]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt1).toContain('RUNTIME_IDENTITY_ALPHA');
      expect(prompt1).toContain('PREF_ALPHA');
      expect(prompt1).toContain('SUPERVISION_ALPHA');
      expect(prompt1).toContain('DYNAMIC_CONTRACT_ALPHA');

      // Turn 2: preference, supervision, and registered contract are already deduplicated (dyn-contract-1 registered in Turn 1),
      // settling KimiV2Provider's steady-state sessionSystemText key.
      runtime.send('turn 2', 'msg-rt-2', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      const prompt2 = (state.conn!.prompt.mock.calls[1]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt2).not.toContain('PREF_ALPHA');
      expect(prompt2).not.toContain('SUPERVISION_ALPHA');
      expect(prompt2).not.toContain('DYNAMIC_CONTRACT_ALPHA');

      // Turn 3: steady-state turn deduplicates ALL 4; compaction starts -> runtime.cancel({ waitForProvider: true })
      // holds _activeDispatchCancelled & _unconfirmedProviderStop -> unknown ID ignored -> matching active ID completed
      // invalidates all runtime caches WITHOUT releasing Stop barrier or restoring working -> cancelled RPC settles Stop cleanly.
      state.conn!.prompt.mockImplementationOnce(() => new Promise((r) => { resolveTurn = r; }));
      runtime.send('turn 3', 'msg-rt-3', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(3));
      const prompt3 = (state.conn!.prompt.mock.calls[2]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt3).not.toContain('RUNTIME_IDENTITY_ALPHA');
      expect(prompt3).not.toContain('PREF_ALPHA');
      expect(prompt3).not.toContain('SUPERVISION_ALPHA');
      expect(prompt3).not.toContain('DYNAMIC_CONTRACT_ALPHA');
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-rt-1', status: 'in_progress' } as never,
      });

      let stopSettled = false;
      const stopPromise = runtime.cancel({ waitForProvider: true }).then(() => { stopSettled = true; });
      await vi.waitFor(() => expect(state.conn!.cancel).toHaveBeenCalledTimes(1));

      // Unknown ID arriving during cancel must be rejected and NOT invalidate runtime caches
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-unknown-rt', status: 'completed' } as never,
      });
      // Matching active ID completing during cancel invalidates runtime caches without releasing Stop barrier or restoring working status
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-rt-1', status: 'completed' } as never,
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(stopSettled).toBe(false);
      expect(runtime.getStatus()).not.toBe('streaming');

      resolveTurn({ stopReason: 'cancelled' });
      await stopPromise;
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));

      // Turn 4: succeeds cleanly (cancel error did NOT leak) and re-injects all 4 caches.
      runtime.send('turn 4', 'msg-rt-4', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(4));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      const prompt4 = (state.conn!.prompt.mock.calls[3]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt4).toContain('RUNTIME_IDENTITY_ALPHA');
      expect(prompt4).toContain('PREF_ALPHA');
      expect(prompt4).toContain('SUPERVISION_ALPHA');
      expect(prompt4).toContain('DYNAMIC_CONTRACT_ALPHA');

      // Turn 5: steady-state turn deduplicates preference, supervision, and registered contract again.
      runtime.send('turn 5', 'msg-rt-5', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(5));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));

      // Negative control — Turn 6 cancelled with NO tracked active compactionId:
      // unknown/stale ID completed during cancel must NOT trigger false re-injection on Turn 7.
      state.conn!.prompt.mockImplementationOnce(() => new Promise((r) => { resolveTurn = r; }));
      runtime.send('turn 6', 'msg-rt-6', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(6));
      await runtime.cancel();
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-rt-1', status: 'completed' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-stale-untracked', status: 'completed' } as never,
      });
      resolveTurn({ stopReason: 'cancelled' });
      await new Promise((r) => setTimeout(r, 10));

      runtime.send('turn 7', 'msg-rt-7', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(7));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      const prompt7 = (state.conn!.prompt.mock.calls[6]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt7).not.toContain('RUNTIME_IDENTITY_ALPHA');
      expect(prompt7).not.toContain('PREF_ALPHA');
      expect(prompt7).not.toContain('SUPERVISION_ALPHA');
      expect(prompt7).not.toContain('DYNAMIC_CONTRACT_ALPHA');

      // Turn 8 + Turn 9 counterexample: earlier `A failed` in the same turn must NOT block a later
      // verified `B completed` (held behind open `C` until `prompt cancelled` retires `C`) from
      // emitting `committed` with `compactionSessionVerified: true` and invalidating all runtime caches.
      const rtStatuses: ProviderStatusUpdate[] = [];
      provider.onStatus((sid, upd) => {
        if (sid === 'deck_kimi_rt_cancel') rtStatuses.push(upd);
      });
      state.conn!.prompt.mockImplementationOnce(() => new Promise((r) => { resolveTurn = r; }));
      runtime.send('turn 8', 'msg-rt-8', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(8));
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-abc-A', status: 'in_progress' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-abc-A', status: 'failed', error: 'transient' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-abc-B', status: 'in_progress' } as never,
      });
      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-abc-C', status: 'in_progress' } as never,
      });

      let stopAbcSettled = false;
      const stopAbcPromise = runtime.cancel({ waitForProvider: true }).then(() => { stopAbcSettled = true; });
      await vi.waitFor(() => expect(state.conn!.cancel).toHaveBeenCalledTimes(3));

      await state.handlers!.sessionUpdate({
        sessionId: 'kimi-sess-1',
        update: { sessionUpdate: 'compaction_update', compactionId: 'cmp-abc-B', status: 'completed' } as never,
      });
      // C is still active so Stop stays held and compacting status has not emitted committed yet
      await new Promise((r) => setTimeout(r, 10));
      expect(stopAbcSettled).toBe(false);
      expect(rtStatuses.some((s) => s.compactionOutcome === 'committed')).toBe(false);

      resolveTurn({ stopReason: 'cancelled' });
      await stopAbcPromise;
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      expect(rtStatuses).toContainEqual({
        status: null,
        label: null,
        compactionOutcome: 'committed',
        compactionSessionVerified: true,
      });

      runtime.send('turn 9', 'msg-rt-9', undefined, preamble, { registeredSystemContract });
      await vi.waitFor(() => expect(state.conn!.prompt).toHaveBeenCalledTimes(9));
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
      const prompt9 = (state.conn!.prompt.mock.calls[8]![0] as { prompt: Array<{ text: string }> }).prompt[0]!.text;
      expect(prompt9).toContain('RUNTIME_IDENTITY_ALPHA');
      expect(prompt9).toContain('PREF_ALPHA');
      expect(prompt9).toContain('SUPERVISION_ALPHA');
      expect(prompt9).toContain('DYNAMIC_CONTRACT_ALPHA');
    } finally {
      await runtime.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces toolExecutionGuard in requestPermission, readTextFile, and writeTextFile BEFORE access and preserves owner turns', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-priv-')));
    try {
      const secretFile = path.join(tmpDir, 'id_ed25519');
      writeFileSync(secretFile, 'PRIVATE-KEY\n');

      state.conn = makeMockConn();
      const provider = new KimiV2Provider();
      let blockSensitive = true;
      provider.setToolExecutionGuard((_sid, req) => {
        if (blockSensitive && JSON.stringify(req.input).includes('id_ed25519')) {
          return { allow: false, reason: 'Sensitive path policy' };
        }
        return { allow: true };
      });

      const approvals: Array<{ id: string }> = [];
      provider.onApprovalRequest((_, r) => approvals.push({ id: r.id }));

      await provider.connect({});
      await provider.createSession({ sessionKey: 'sess-kimi-priv', cwd: tmpDir });

      // 1) requestPermission denies sensitive target before emitting approval
      const permDenied = await state.handlers!.requestPermission({
        sessionId: 'kimi-sess-1',
        toolCall: {
          toolCallId: 'tc-priv',
          title: 'read',
          kind: 'read',
          rawInput: { file_path: secretFile },
        },
        options: [
          { optionId: 'approve_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      } as never);
      expect(permDenied).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
      expect(approvals).toHaveLength(0);

      // 2) readTextFile and writeTextFile deny sensitive paths before fs access
      await expect(state.handlers!.readTextFile({
        sessionId: 'kimi-sess-1',
        path: secretFile,
      } as never)).rejects.toThrow('Sensitive path policy');

      await expect(state.handlers!.writeTextFile({
        sessionId: 'kimi-sess-1',
        path: secretFile,
        content: 'OVERWRITE',
      } as never)).rejects.toThrow('Sensitive path policy');

      // 2b) Relative path is checked and executed against the SAME session cwd (not process.cwd()) and unknown session fails closed
      writeFileSync(path.join(tmpDir, 'rel-note.txt'), 'relative-content\n');
      const relSeenPaths: string[] = [];
      provider.setToolExecutionGuard((_sid, req) => {
        relSeenPaths.push((req.input as { path?: string }).path ?? '');
        if (!blockSensitive) return { allow: true };
        return JSON.stringify(req.input).includes('id_ed25519')
          ? { allow: false, reason: 'Sensitive path policy' }
          : { allow: true };
      });
      await expect(state.handlers!.readTextFile({
        sessionId: 'kimi-sess-1',
        path: 'rel-note.txt',
      } as never)).resolves.toEqual({ content: 'relative-content\n' });
      expect(relSeenPaths.at(-1)).toBe(path.join(tmpDir, 'rel-note.txt'));

      await expect(state.handlers!.writeTextFile({
        sessionId: 'kimi-sess-1',
        path: 'rel-write.txt',
        content: 'written-rel',
      } as never)).resolves.toEqual({});
      expect(relSeenPaths.at(-1)).toBe(path.join(tmpDir, 'rel-write.txt'));
      expect(readFileSync(path.join(tmpDir, 'rel-write.txt'), 'utf8')).toBe('written-rel');

      await expect(state.handlers!.readTextFile({
        sessionId: 'unknown-acp-session',
        path: path.join(tmpDir, 'rel-note.txt'),
      } as never)).rejects.toThrow('Unknown session');
      await expect(state.handlers!.writeTextFile({
        sessionId: 'unknown-acp-session',
        path: path.join(tmpDir, 'rel-note.txt'),
        content: 'tamper',
      } as never)).rejects.toThrow('Unknown session');
      expect(readFileSync(path.join(tmpDir, 'rel-note.txt'), 'utf8')).toBe('relative-content\n');

      // 3) Owner turn on the same session succeeds
      blockSensitive = false;
      const permOwner = state.handlers!.requestPermission({
        sessionId: 'kimi-sess-1',
        toolCall: { toolCallId: 'tc-owner', title: 'read', kind: 'read', rawInput: { file_path: secretFile } },
        options: [{ optionId: 'approve_once', name: 'Allow', kind: 'allow_once' }],
      } as never);
      await vi.waitFor(() => expect(approvals).toHaveLength(1));
      await provider.respondApproval('sess-kimi-priv', approvals[0]!.id, true);
      expect(await permOwner).toEqual({ outcome: { outcome: 'selected', optionId: 'approve_once' } });
      await expect(state.handlers!.readTextFile({ sessionId: 'kimi-sess-1', path: secretFile } as never))
        .resolves.toEqual({ content: 'PRIVATE-KEY\n' });

      await provider.disconnect();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isolates CC Preset credentials in 0o700/0o600 KIMI_SHARE_DIR, preserves non-preset spawns, recycles on preset change, and cleans up on disconnect', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-preset-')));
    let capturedShareDir: string | undefined;
    let capturedToml = '';
    try {
      const provider = new KimiV2Provider();

      // 1) Non-preset default spawn leaves KIMI_SHARE_DIR unset when inherited env lacks it
      const origShareEnv = process.env.KIMI_SHARE_DIR;
      delete process.env.KIMI_SHARE_DIR;
      try {
        await provider.connect({});
        await provider.createSession({ sessionKey: 'sess-default', cwd: tmpDir });
        const defaultCall = mockSpawn.mock.calls[0]!;
        const defaultArgs = defaultCall[1] as string[];
        const defaultOpts = defaultCall[2] as { env: NodeJS.ProcessEnv };
        expect(defaultArgs).toEqual(['acp']);
        expect(defaultOpts.env.KIMI_SHARE_DIR).toBeUndefined();

        // Point KIMI_SHARE_DIR at an isolated test directory BEFORE creating preset sessions so real ~/.kimi is never touched.
        const testBaseShareDir = path.join(tmpDir, 'base-kimi-share');
        mkdirSync(testBaseShareDir, { recursive: true });
        process.env.KIMI_SHARE_DIR = testBaseShareDir;

        // 2) Switching to an Anthropic preset recycles child process with 0o700 KIMI_SHARE_DIR + 0o600 config.toml
        state.connQueue.push(
          makeMockConn({
            newSession: vi.fn(async () => ({
              sessionId: 'kimi-sess-1',
              models: {
                availableModels: [
                  { modelId: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
                  { modelId: 'glm-5.3', name: 'GLM-5.3' },
                ],
                currentModelId: 'glm-5.3-flash',
              },
            })),
          }),
          makeMockConn(), // OpenAI preset route
        );
        await provider.createSession({
          sessionKey: 'sess-preset-anth',
          cwd: tmpDir,
          agentId: 'glm-5.3-flash',
          kimiLlm: {
            provider: 'glm5.3',
            providerType: 'anthropic',
            baseUrl: 'https://open.bigmodel.cn/api/anthropic',
            apiKey: 'secret-preset-key-anth',
            model: 'glm-5.3-flash',
            contextWindow: 1_000_000,
            models: [
              { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', contextWindow: 1_000_000 },
              { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 200_000 },
            ],
          },
        });
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        const anthCall = mockSpawn.mock.calls[1]!;
        const anthArgs = anthCall[1] as string[];
        const anthEnv = (anthCall[2] as { env: NodeJS.ProcessEnv }).env;
        expect(anthArgs).toEqual(['acp']);
        expect(JSON.stringify(anthArgs)).not.toContain('secret-preset-key-anth');
        expect(anthEnv.KIMI_API_KEY).toBeUndefined();

        capturedShareDir = anthEnv.KIMI_SHARE_DIR;
        expect(capturedShareDir).toBeTruthy();
        const { statSync } = await import('node:fs');
        expect(statSync(capturedShareDir!).mode & 0o777).toBe(0o700);
        const cfgPath = path.join(capturedShareDir!, 'config.toml');
        expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
        capturedToml = readFileSync(cfgPath, 'utf8');
        expect(capturedToml).toContain('type = "anthropic"');
        expect(capturedToml).toContain('base_url = "https://open.bigmodel.cn/api/anthropic"');
        expect(capturedToml).toContain('api_key = "secret-preset-key-anth"');
        expect(capturedToml).toContain('telemetry = false');
        expect(capturedToml).toContain('max_context_size = 1000000');

        // usage_update without explicit contextWindow uses preset model contextWindow
        const usages: Array<{ model?: string; usage?: { input_tokens?: number; model_context_window?: number } }> = [];
        provider.onUsage((_, u) => usages.push(u));
        await state.handlers!.sessionUpdate({
          sessionId: 'kimi-sess-1',
          update: { sessionUpdate: 'usage_update', used: 1200 } as never,
        });
        expect(usages.at(-1)).toMatchObject({
          model: 'glm-5.3-flash',
          usage: { input_tokens: 1200, model_context_window: 1_000_000 },
        });

        // Default listModels refreshes on default route without leaking preset models
        const listed = await provider.listModels(false);
        expect(listed.models.map((m) => m.id)).toEqual(['kimi-k2.5', 'kimi-for-coding']);

        // Creating OpenAI preset uses a separate child + share dir; endSession cleans only the ended route.
        await provider.createSession({
          sessionKey: 'sess-preset-openai',
          cwd: tmpDir,
          agentId: 'gpt-compat',
          kimiLlm: {
            provider: 'openai-compat',
            providerType: 'openai_legacy',
            baseUrl: 'https://example.invalid/v1',
            apiKey: 'secret-openai-key',
            model: 'gpt-compat',
            contextWindow: 128_000,
            models: [{ id: 'gpt-compat', contextWindow: 128_000 }],
          },
        });
        expect(mockSpawn).toHaveBeenCalledTimes(3);
        const { existsSync } = await import('node:fs');
        // Anthropic preset session is still open on its own route, so both preset share dirs stay isolated until ended/disconnected.
        expect(existsSync(capturedShareDir!)).toBe(true);
        const openaiEnv = (mockSpawn.mock.calls[2]![2] as { env: NodeJS.ProcessEnv }).env;
        const openaiShareDir = openaiEnv.KIMI_SHARE_DIR!;
        const openaiToml = readFileSync(path.join(openaiShareDir, 'config.toml'), 'utf8');
        expect(openaiToml).toContain('type = "openai_legacy"');
        expect(openaiToml).toContain('api_key = "secret-openai-key"');
        expect(openaiToml).toContain('max_context_size = 128000');

        await provider.endSession('sess-preset-anth');
        expect(existsSync(capturedShareDir!)).toBe(false);
        expect(existsSync(openaiShareDir)).toBe(true);

        await provider.disconnect();
        expect(existsSync(openaiShareDir)).toBe(false);
      } finally {
        if (origShareEnv !== undefined) {
          process.env.KIMI_SHARE_DIR = origShareEnv;
        } else {
          delete process.env.KIMI_SHARE_DIR;
        }
      }
    } finally {
      if (capturedShareDir) rmSync(capturedShareDir, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps concurrent route connections isolated while B launches or default listModels refreshes, and endSession(B) cleans only B', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-iso-')));
    const origShareEnv = process.env.KIMI_SHARE_DIR;
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(baseShareDir, { recursive: true });
    process.env.KIMI_SHARE_DIR = baseShareDir;

    try {
      let resolvePromptA!: (r: PromptResponse) => void;
      const connA = makeMockConn({
        newSession: vi.fn(async () => ({
          sessionId: 'acp-sess-a',
          models: {
            availableModels: [{ modelId: 'kimi-default-a', name: 'Kimi Default A' }],
            currentModelId: 'kimi-default-a',
          },
        })),
        prompt: vi.fn(() => new Promise<PromptResponse>((r) => { resolvePromptA = r; })),
      });
      const connB = makeMockConn({
        newSession: vi.fn(async () => ({
          sessionId: 'acp-sess-b',
          models: {
            availableModels: [{ modelId: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }],
            currentModelId: 'glm-5.3-flash',
          },
        })),
      });
      state.connQueue.push(connA, connB);

      const provider = new KimiV2Provider();
      const deltasA: string[] = [];
      const errorsA: Array<{ code: string }> = [];
      provider.onDelta((sid, d) => {
        if (sid === 'sess-a' && d.delta) deltasA.push(d.delta);
      });
      provider.onError((sid, e) => {
        if (sid === 'sess-a') errorsA.push({ code: e.code });
      });

      await provider.connect({});
      await provider.createSession({ sessionKey: 'sess-a', cwd: tmpDir });
      const handlersA = state.handlers!;
      const childA = state.children[0]!;

      // Start streaming on A
      await provider.send('sess-a', 'turn A');
      await vi.waitFor(() => expect(connA.prompt).toHaveBeenCalledTimes(1));
      await handlersA.sessionUpdate({
        sessionId: 'acp-sess-a',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part-1 ' } } as never,
      });

      // Concurrently launch B on a different preset route -> must NOT disturb or kill A
      await provider.createSession({
        sessionKey: 'sess-b',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'iso-key-b',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      });
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const childB = state.children[1]!;
      const shareDirB = (mockSpawn.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;

      // Generic default listModels() must run against default route and NOT return preset B models
      const defaultCatalog = await provider.listModels(true);
      expect(defaultCatalog.models.map((m) => m.id)).toEqual(['kimi-default-a']);
      expect(defaultCatalog.models.map((m) => m.id)).not.toContain('glm-5.3-flash');

      // Session A continues receiving streaming chunks after B launched & listModels ran
      await handlersA.sessionUpdate({
        sessionId: 'acp-sess-a',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part-2' } } as never,
      });
      expect(deltasA).toEqual(['part-1 ', 'part-2']);

      // Closing B kills ONLY childB and deletes ONLY shareDirB; A keeps running and can cancel cleanly
      await provider.endSession('sess-b');
      const { existsSync } = await import('node:fs');
      expect(existsSync(shareDirB)).toBe(false);
      expect(mockKillProcessTree).toHaveBeenCalledWith(childB, { ownsProcessGroup: true });
      expect(mockKillProcessTree).not.toHaveBeenCalledWith(childA, expect.anything());
      expect(provider.getSessionDiagnostics('sess-a')?.connected).toBe(true);

      await provider.cancel('sess-a');
      await vi.waitFor(() => expect(connA.cancel).toHaveBeenCalledWith({ sessionId: 'acp-sess-a' }));
      resolvePromptA({ stopReason: 'cancelled' });
      await vi.waitFor(() => expect(errorsA).toContainEqual({ code: 'CANCELLED' }));

      await provider.disconnect();
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not kill route A while A is mid-newSession when route B launches, and preserves new-generation shareDir across same-route delayed teardown', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-bindrace-')));
    const origShareEnv = process.env.KIMI_SHARE_DIR;
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(baseShareDir, { recursive: true });
    process.env.KIMI_SHARE_DIR = baseShareDir;

    try {
      let resolveNewSessionA!: (v: unknown) => void;
      const connA = makeMockConn({
        newSession: vi.fn(() => new Promise((r) => { resolveNewSessionA = r; })),
      });
      const connB = makeMockConn({
        newSession: vi.fn(async () => ({ sessionId: 'acp-b-1' })),
      });
      state.connQueue.push(connA, connB);

      const provider = new KimiV2Provider();
      await provider.connect({});

      // Start A; initialize finishes, newSession hangs (so connectingPromise cleared & boundEnvKey not yet set).
      const createA = provider.createSession({ sessionKey: 'sess-a', cwd: tmpDir });
      await vi.waitFor(() => expect(resolveNewSessionA).toBeTypeOf('function'));

      // Concurrently start B on a different preset route -> MUST NOT kill A!
      await provider.createSession({
        sessionKey: 'sess-b',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'bind-key-b',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      });
      expect(mockKillProcessTree).not.toHaveBeenCalled();

      // Release A's newSession -> both sessions bind & send cleanly; closing each cleans only itself
      resolveNewSessionA({ sessionId: 'acp-a-1' });
      await createA;
      await provider.send('sess-a', 'hello A');
      await provider.send('sess-b', 'hello B');
      expect(connA.prompt).toHaveBeenCalledTimes(1);
      expect(connB.prompt).toHaveBeenCalledTimes(1);

      const shareDirB = (mockSpawn.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      const { existsSync } = await import('node:fs');
      await provider.endSession('sess-a');
      expect(existsSync(shareDirB)).toBe(true);
      await provider.endSession('sess-b');
      expect(existsSync(shareDirB)).toBe(false);

      // Same-route delayed teardown: capture old shareDir BEFORE awaiting killProcessTree so reconnect cannot delete new shareDir
      const connC1 = makeMockConn({ newSession: vi.fn(async () => ({ sessionId: 'acp-c-1' })) });
      const connC2 = makeMockConn({ newSession: vi.fn(async () => ({ sessionId: 'acp-c-2' })) });
      state.connQueue.push(connC1, connC2);
      await provider.createSession({
        sessionKey: 'sess-c',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'key-c',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      });
      const shareDirC1 = (mockSpawn.mock.calls[2]![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      expect(existsSync(shareDirC1)).toBe(true);

      let resolveKillC1!: () => void;
      mockKillProcessTree.mockImplementationOnce(async () => {
        await new Promise<void>((r) => { resolveKillC1 = r; });
      });
      const endingC1 = provider.endSession('sess-c');
      await vi.waitFor(() => expect(resolveKillC1).toBeTypeOf('function'));
      // Re-create same preset session while C1 teardown kill is still awaiting
      const recreateC2 = provider.createSession({
        sessionKey: 'sess-c2',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'key-c',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      });
      resolveKillC1();
      await Promise.all([endingC1, recreateC2]);
      const shareDirC2 = (mockSpawn.mock.calls[3]![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      expect(shareDirC2).not.toBe(shareDirC1);
      expect(existsSync(shareDirC1)).toBe(false);
      expect(existsSync(shareDirC2)).toBe(true);

      await provider.disconnect();
      expect(existsSync(shareDirC2)).toBe(false);
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('cleans up orphaned preset child/config/stale state when strictResume fails, while keeping concurrent bound sessions intact', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-fail-cleanup-')));
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(baseShareDir, { recursive: true });
    const origShareEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = baseShareDir;
    const { existsSync } = await import('node:fs');

    try {
      const llm = {
        provider: 'glm5.3',
        providerType: 'anthropic' as const,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'secret-fail-key',
        model: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
      };

      // 1) Lone preset session failing strictResume MUST kill its child, delete shareDir, and roll back stale state
      const connFail1 = makeMockConn({
        resumeSession: vi.fn(async () => { throw new RequestError(-32002, 'Session not found'); }),
        newSession: vi.fn(async () => ({ sessionId: 'should-not-create' })),
      });
      state.connQueue.push(connFail1);
      const provider1 = new KimiV2Provider();
      await provider1.connect({});
      await expect(provider1.createSession({
        sessionKey: 'sess-fail-preset',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        resumeId: 'missing-preset-1',
        strictResume: true,
        kimiLlm: llm,
      })).rejects.toThrow();

      expect(connFail1.newSession).not.toHaveBeenCalled();
      expect(provider1.getSessionDiagnostics('sess-fail-preset')).toBeNull();
      const failedShareDir = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      expect(existsSync(failedShareDir)).toBe(false);
      expect(mockKillProcessTree).toHaveBeenCalledWith(state.children.at(-1)!, { ownsProcessGroup: true });

      // 2) Same preset route with an active bound session MUST NOT kill the active session when another create fails
      mockKillProcessTree.mockClear();
      const connAlive = makeMockConn({
        newSession: vi.fn(async () => ({ sessionId: 'acp-alive-1' })),
        resumeSession: vi.fn(async () => { throw new RequestError(-32002, 'Missing second session'); }),
      });
      state.connQueue.push(connAlive);
      const provider2 = new KimiV2Provider();
      await provider2.connect({});
      await provider2.createSession({
        sessionKey: 'sess-alive',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: llm,
      });
      const aliveShareDir = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      await expect(provider2.createSession({
        sessionKey: 'sess-fail-second',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        resumeId: 'missing-second-2',
        strictResume: true,
        kimiLlm: llm,
      })).rejects.toThrow();

      expect(provider2.getSessionDiagnostics('sess-fail-second')).toBeNull();
      expect(provider2.getSessionDiagnostics('sess-alive')?.connected).toBe(true);
      expect(existsSync(aliveShareDir)).toBe(true);
      expect(mockKillProcessTree).not.toHaveBeenCalled();

      await provider1.disconnect();
      await provider2.disconnect();
      expect(existsSync(aliveShareDir)).toBe(false);
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retains pending teardown when strictResume fails during an active concurrent query and cleans up after query finishes, while preserving already-bound routes', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-conc-query-')));
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(baseShareDir, { recursive: true });
    const origShareEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = baseShareDir;

    const llm: KimiLlmConfig = {
      provider: 'glm5.3',
      providerType: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'secret-concurrent-query-key',
      model: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
    };

    try {
      const { existsSync } = await import('node:fs');

      // Case 1: hanging listSessions on preset route + strictResume failure -> second transient listSessions -> queries finish cleanly -> teardown runs
      let resolvePendingList!: (val: { sessions: Array<{ sessionId: string; cwd: string; title: string }> }) => void;
      const pendingListPromise = new Promise<{ sessions: Array<{ sessionId: string; cwd: string; title: string }> }>((resolve) => {
        resolvePendingList = resolve;
      });
      const conn1 = makeMockConn({
        listSessions: vi.fn()
          .mockImplementationOnce(() => pendingListPromise)
          .mockImplementationOnce(async () => ({
            sessions: [{ sessionId: 'remote-2', cwd: tmpDir, title: 'Second query' }],
          })),
        resumeSession: vi.fn(async () => {
          throw new RequestError(-32002, 'Session not found');
        }),
        loadSession: vi.fn(async () => {
          throw new RequestError(-32002, 'Session not found');
        }),
        newSession: vi.fn(async () => ({ sessionId: 'should-not-create' })),
      });
      // Control connection (route has an already-bound live session + hanging listSessions + strictResume fail)
      let resolveControlList!: (val: { sessions: Array<{ sessionId: string; cwd: string }> }) => void;
      const controlListPromise = new Promise<{ sessions: Array<{ sessionId: string; cwd: string }> }>((resolve) => {
        resolveControlList = resolve;
      });
      const conn2 = makeMockConn({
        newSession: vi.fn(async () => ({ sessionId: 'bound-alive-id' })),
        listSessions: vi.fn(() => controlListPromise),
        resumeSession: vi.fn(async () => {
          throw new RequestError(-32002, 'Session not found');
        }),
        loadSession: vi.fn(async () => {
          throw new RequestError(-32002, 'Session not found');
        }),
      });
      state.connQueue.push(conn1, conn2);

      const provider1 = new KimiV2Provider();
      await provider1.connect({ kimiLlm: llm });

      const listPromise1 = provider1.listSessions({ directory: tmpDir });
      await vi.waitFor(() => expect(conn1.listSessions).toHaveBeenCalledTimes(1));

      const spawnEnv1 = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env;
      const presetShareDir1 = spawnEnv1.KIMI_SHARE_DIR!;
      expect(presetShareDir1).not.toBe(baseShareDir);
      expect(existsSync(path.join(presetShareDir1, 'config.toml'))).toBe(true);

      // strictResume fails while listSessions is concurrently holding inFlightOps on the same preset route
      await expect(provider1.createSession({
        sessionKey: 'sess-fail-concurrent',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        resumeId: 'missing-concurrent-1',
        strictResume: true,
        kimiLlm: llm,
      })).rejects.toThrow();

      // Pending query must NOT be aborted mid-flight; private share dir stays until query releases
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(presetShareDir1)).toBe(true);

      // A second transient query acquiring the route must NOT wipe out pending teardown
      const secondListResult = await provider1.listSessions({ directory: tmpDir });
      expect(secondListResult).toEqual([{ key: 'remote-2', displayName: 'Second query', directory: tmpDir }]);
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(presetShareDir1)).toBe(true);

      // Resolving the hanging query completes normally and triggers idle teardown of child & secret share dir
      resolvePendingList({
        sessions: [{ sessionId: 'remote-1', cwd: tmpDir, title: 'Hanging query' }],
      });
      const firstListResult = await listPromise1;
      expect(firstListResult).toEqual([{ key: 'remote-1', displayName: 'Hanging query', directory: tmpDir }]);
      expect(mockKillProcessTree).toHaveBeenCalledTimes(1);
      expect(existsSync(presetShareDir1)).toBe(false);
      expect(provider1.getSessionDiagnostics('sess-fail-concurrent')).toBeNull();

      // Case 2 (control): already-bound live session + hanging listSessions + strictResume failure -> session & share dir stay intact
      mockKillProcessTree.mockClear();
      const provider2 = new KimiV2Provider();
      await provider2.connect({ kimiLlm: llm });
      await provider2.createSession({
        sessionKey: 'sess-bound-control',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: llm,
      });
      const controlShareDir = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      const controlList = provider2.listSessions({ directory: tmpDir });
      await vi.waitFor(() => expect(conn2.listSessions).toHaveBeenCalledTimes(1));

      await expect(provider2.createSession({
        sessionKey: 'sess-fail-control',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        resumeId: 'missing-concurrent-2',
        strictResume: true,
        kimiLlm: llm,
      })).rejects.toThrow();

      resolveControlList({ sessions: [{ sessionId: 'bound-alive-id', cwd: tmpDir }] });
      expect(await controlList).toEqual([{ key: 'bound-alive-id', directory: tmpDir }]);
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(controlShareDir)).toBe(true);
      expect(provider2.getSessionDiagnostics('sess-bound-control')?.connected).toBe(true);
      expect(provider2.getSessionDiagnostics('sess-fail-control')).toBeNull();

      await provider1.disconnect();
      await provider2.disconnect();
      expect(existsSync(controlShareDir)).toBe(false);
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves a reconnecting preset connection during gated initialize when the last old session closes, completes send on the new session, and tears down only after the new session closes', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-gated-init-')));
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(baseShareDir, { recursive: true });
    const origShareEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = baseShareDir;

    const llm: KimiLlmConfig = {
      provider: 'glm5.3',
      providerType: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'secret-gated-init-key',
      model: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
    };

    try {
      const { existsSync } = await import('node:fs');

      const connOld = makeMockConn({
        newSession: vi.fn(async () => ({ sessionId: 'old-acp-1' })),
      });

      let resolveInitGate!: (val: unknown) => void;
      const initGate = new Promise((resolve) => {
        resolveInitGate = resolve;
      });
      const defaultInitResult = {
        protocolVersion: 1,
        agentInfo: { name: 'Kimi Code CLI', version: '2.8.1' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
      };
      let promptHandler: ((params: { sessionId: string }) => Promise<{ stopReason: string }>) | null = null;
      const connNew = makeMockConn({
        initialize: vi.fn(async () => {
          await initGate;
          return defaultInitResult;
        }),
        newSession: vi.fn(async () => ({ sessionId: 'new-acp-2' })),
        prompt: vi.fn(async (params: { sessionId: string }) => {
          return promptHandler ? promptHandler(params) : { stopReason: 'end_turn' };
        }),
      });
      state.connQueue.push(connOld, connNew);

      const provider = new KimiV2Provider({ kimiLlm: llm });
      const completes: Array<{ sessionId: string; content: string }> = [];
      provider.onComplete((sid, msg) => completes.push({ sessionId: sid, content: msg.content }));
      await provider.connect({ kimiLlm: llm });

      // Start and bind the old session
      await provider.createSession({
        sessionKey: 'sess-old',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: llm,
      });
      const oldChild = state.children[0];
      expect(provider.getSessionDiagnostics('sess-old')?.connected).toBe(true);

      // Simulate old child exiting while sess-old is still registered
      oldChild.exitCode = 0;
      oldChild.emit('exit', 0, null);
      expect(provider.getSessionDiagnostics('sess-old')?.connected).toBe(false);

      // Start new session creation on the same preset route; blocks inside initialize()
      const createNewPromise = provider.createSession({
        sessionKey: 'sess-new',
        cwd: tmpDir,
        agentId: 'glm-5.3-flash',
        kimiLlm: llm,
      });
      await vi.waitFor(() => expect(connNew.initialize).toHaveBeenCalledTimes(1));

      const newChild = state.children[1];
      const newShareDir = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      expect(existsSync(path.join(newShareDir, 'config.toml'))).toBe(true);

      // Close the last old session WHILE initialize() for sess-new is in-flight
      mockKillProcessTree.mockClear();
      await provider.endSession('sess-old');
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(newShareDir)).toBe(true);

      // Release initialize(): ensureConnected must hand off an intact, still-owned connection to sess-new
      resolveInitGate(defaultInitResult);
      await expect(createNewPromise).resolves.toBe('sess-new');
      expect(connNew.newSession).toHaveBeenCalledTimes(1);
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(newShareDir)).toBe(true);
      expect(provider.getSessionDiagnostics('sess-new')?.connected).toBe(true);

      // New session must be able to send a prompt cleanly on that connection
      promptHandler = async ({ sessionId }) => {
        await state.handlers!.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GATED_INIT_SEND_OK' } } as never,
        });
        return { stopReason: 'end_turn' };
      };
      await provider.send('sess-new', 'hello after old session closed');
      await vi.waitFor(() => expect(completes).toEqual([
        { sessionId: 'sess-new', content: 'GATED_INIT_SEND_OK' },
      ]));
      expect(mockKillProcessTree).not.toHaveBeenCalled();
      expect(existsSync(newShareDir)).toBe(true);

      // Closing the new (last) session finally tears down the new child & private share dir
      await provider.endSession('sess-new');
      expect(mockKillProcessTree).toHaveBeenCalledWith(newChild, { ownsProcessGroup: true });
      expect(existsSync(newShareDir)).toBe(false);

      await provider.disconnect();
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps base kimi.json read-only, uses isolated metadata view for default resume, and fails closed on corrupt metadata', async () => {
    const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'imcodes-kimi-wd-view-')));
    const projCwd = path.join(tmpDir, 'never-seen-cwd');
    mkdirSync(projCwd, { recursive: true });
    const baseShareDir = path.join(tmpDir, 'base-share');
    mkdirSync(path.join(baseShareDir, 'credentials'), { recursive: true });
    writeFileSync(path.join(baseShareDir, 'credentials', 'kimi-code.json'), '{"access_token":"default-oauth"}', { mode: 0o600 });
    writeFileSync(path.join(baseShareDir, 'config.toml'), 'default_model = "kimi-k2.5"\n', { mode: 0o600 });
    const originalBaseMetaRaw = JSON.stringify({
      extraOwnerField: 'keep-me',
      work_dirs: [{ path: '/existing/other', kaos: 'local', last_session_id: 'other-sess-9' }],
    });
    const baseKimiJson = path.join(baseShareDir, 'kimi.json');
    writeFileSync(baseKimiJson, originalBaseMetaRaw, { mode: 0o600 });

    const { createHash } = await import('node:crypto');
    const { existsSync, lstatSync } = await import('node:fs');
    const pathMd5 = createHash('md5').update(projCwd, 'utf8').digest('hex');
    mkdirSync(path.join(baseShareDir, 'sessions', pathMd5, 'kimi-shared-1'), { recursive: true });
    writeFileSync(path.join(baseShareDir, 'sessions', pathMd5, 'kimi-shared-1', 'context.jsonl'), '{}\n');

    const origShareEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = baseShareDir;
    try {
      const connPreset = makeMockConn({ newSession: vi.fn(async () => ({ sessionId: 'kimi-shared-1' })) });
      const connDefaultOk = makeMockConn({ resumeSession: vi.fn(async () => ({ configOptions: [] })) });
      const connDefaultFail = makeMockConn({
        resumeSession: vi.fn(async () => { throw new RequestError(-32002, 'Session not found'); }),
        newSession: vi.fn(async () => ({ sessionId: 'should-never-be-created' })),
      });
      state.connQueue.push(connPreset, connDefaultOk, connDefaultFail);

      const provider = new KimiV2Provider();
      await provider.connect({});
      await provider.createSession({
        sessionKey: 'sess-preset',
        cwd: projCwd,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'never-write-to-base-kimi',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      });

      // Shared base kimi.json & config.toml remain 100% untouched by preset launch
      expect(readFileSync(baseKimiJson, 'utf8')).toBe(originalBaseMetaRaw);
      expect(readFileSync(path.join(baseShareDir, 'config.toml'), 'utf8')).toBe('default_model = "kimi-k2.5"\n');

      // Clearing back to default with strictResume uses an isolated metadata view preserving base entries + default credentials
      await provider.endSession('sess-preset');
      await provider.createSession({
        sessionKey: 'sess-default-restored',
        cwd: projCwd,
        resumeId: 'kimi-shared-1',
        strictResume: true,
      });
      expect(connDefaultOk.resumeSession).toHaveBeenCalledWith({
        sessionId: 'kimi-shared-1',
        cwd: projCwd,
        mcpServers: expect.any(Array),
      });
      expect(readFileSync(baseKimiJson, 'utf8')).toBe(originalBaseMetaRaw);

      const viewShareDir = (mockSpawn.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv }).env.KIMI_SHARE_DIR!;
      expect(viewShareDir).not.toBe(baseShareDir);
      const viewMeta = JSON.parse(readFileSync(path.join(viewShareDir, 'kimi.json'), 'utf8')) as {
        extraOwnerField?: string;
        work_dirs?: Array<{ path: string; kaos: string; last_session_id: string | null }>;
      };
      expect(viewMeta.extraOwnerField).toBe('keep-me');
      expect(viewMeta.work_dirs).toEqual([
        { path: '/existing/other', kaos: 'local', last_session_id: 'other-sess-9' },
        { path: projCwd, kaos: 'local', last_session_id: null },
      ]);
      expect(lstatSync(path.join(viewShareDir, 'credentials')).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(viewShareDir, 'sessions')).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(viewShareDir, 'config.toml'), 'utf8')).toBe('default_model = "kimi-k2.5"\n');

      await provider.endSession('sess-default-restored');
      expect(existsSync(viewShareDir)).toBe(false);

      // Strict resume fails loudly and never falls back to newSession when session is missing
      const providerFail = new KimiV2Provider();
      await providerFail.connect({});
      await expect(providerFail.createSession({
        sessionKey: 'sess-strict-fail',
        cwd: projCwd,
        resumeId: 'missing-id',
        strictResume: true,
      })).rejects.toThrow();
      expect(connDefaultFail.newSession).not.toHaveBeenCalled();

      // Corrupt/malformed base kimi.json MUST fail explicitly and remain intact (never overwritten with {})
      writeFileSync(baseKimiJson, '{broken-json', { mode: 0o600 });
      const providerCorrupt = new KimiV2Provider();
      await providerCorrupt.connect({});
      await expect(providerCorrupt.createSession({
        sessionKey: 'sess-corrupt-default',
        cwd: projCwd,
        resumeId: 'kimi-shared-1',
        strictResume: true,
      })).rejects.toThrow(/metadata index/i);
      await expect(providerCorrupt.createSession({
        sessionKey: 'sess-corrupt-preset',
        cwd: projCwd,
        agentId: 'glm-5.3-flash',
        kimiLlm: {
          provider: 'glm5.3',
          providerType: 'anthropic',
          baseUrl: 'https://open.bigmodel.cn/api/anthropic',
          apiKey: 'never-write-to-base-kimi',
          model: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          models: [{ id: 'glm-5.3-flash', contextWindow: 1_000_000 }],
        },
      })).rejects.toThrow(/metadata index/i);
      expect(readFileSync(baseKimiJson, 'utf8')).toBe('{broken-json');

      await provider.disconnect();
      await providerFail.disconnect();
      await providerCorrupt.disconnect();
    } finally {
      if (origShareEnv !== undefined) {
        process.env.KIMI_SHARE_DIR = origShareEnv;
      } else {
        delete process.env.KIMI_SHARE_DIR;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
