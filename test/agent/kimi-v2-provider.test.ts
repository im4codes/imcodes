import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
