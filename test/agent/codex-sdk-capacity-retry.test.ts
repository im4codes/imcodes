/**
 * End to end for the reported incident: a REAL CodexSdkProvider talking to a fake `codex app-server`, driven by a REAL
 * TransportSessionRuntime. The app-server fails the turn with "Selected model is at capacity"; the session must keep the turn
 * queued, retry it at 1 → 2 → 4 → 8 → 15 s (never above 15 s, no give-up) and go back to idle once capacity returns. On the
 * base build the first retry came after 30 s, the interval grew to 8 minutes and the episode was abandoned after 60 minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

interface FakeChild {
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: () => boolean };
  requests: Array<{ id?: number; method?: string; params?: Record<string, any> }>;
  emits: (message: Record<string, unknown>) => void;
}

const appServer = vi.hoisted(() => {
  const children: FakeChild[] = [];
  let turnCounter = 0;
  const spawn = vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let record!: FakeChild;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as FakeChild['requests'][number];
          record.requests.push(message);
          if (typeof message.id !== 'number') continue;
          if (message.method === 'initialize') record.emits({ id: message.id, result: { userAgent: 'test' } });
          else if (message.method === 'thread/start') {
            record.emits({ id: message.id, result: { thread: { id: 'thread-1' } } });
            record.emits({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
          } else if (message.method === 'turn/start') {
            turnCounter += 1;
            record.emits({ id: message.id, result: { turn: { id: `turn-${turnCounter}`, status: 'inProgress', items: [], error: null } } });
          } else if (message.method === 'mcpServerStatus/list') record.emits({ id: message.id, error: { message: 'no inventory' } });
          else if (message.method === 'mcpServer/tool/call') record.emits({ id: message.id, result: { content: [{ type: 'text', text: '{}' }] } });
          else if (message.method === 'config/mcpServer/reload') record.emits({ id: message.id, result: {} });
          else if (message.method === 'turn/interrupt' || message.method === 'thread/compact/start') record.emits({ id: message.id, result: {} });
          else if (message.method === 'thread/unsubscribe') record.emits({ id: message.id, result: { status: 'unsubscribed' } });
        }
        callback();
      },
    });
    const child = new EventEmitter() as FakeChild['child'];
    Object.assign(child, { stdout, stderr, stdin, killed: false });
    child.kill = () => { child.killed = true; child.emit('exit', 0); return true; };
    record = { child, requests: [], emits: (message) => { stdout.write(`${JSON.stringify(message)}\n`); } };
    children.push(record);
    return child;
  });
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = (typeof args[2] === 'function' ? args[2] : args[3]) as ((e: Error | null, out: string, err: string) => void) | undefined;
    callback?.(null, 'ok\n', '');
    return {} as never;
  });
  return { children, spawn, execFile, turnStarts: () => children.flatMap((c) => c.requests).filter((r) => r.method === 'turn/start').length, resetTurns: () => { turnCounter = 0; } };
});

vi.mock('node:child_process', () => ({ spawn: appServer.spawn, execFile: appServer.execFile }));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({ availableModels: ['gpt-5.5'], models: [{ id: 'gpt-5.5' }] })),
  getCodexBaseInstructions: vi.fn(async () => '[catalog-prompt]'),
}));

import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

const CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';

const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;

/** Advance the fake clock, then let the provider's real async work (fs, streams) finish without moving the fake clock. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => realSetImmediate(resolve));
}

/** After the retry timer fired: let the provider's own dispatch chain (a few real awaits and short timers) reach the app-server. */
async function untilSent(sends: number): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 100 && appServer.turnStarts() === sends; i += 1) {
    await vi.advanceTimersByTimeAsync(10);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2));
  }
  return Date.now() - started;
}

describe('codex-sdk "model at capacity" against a fake app-server', () => {
  let provider: CodexSdkProvider;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    resetTransportQueueStoreForTests();
    appServer.children.length = 0;
    appServer.resetTurns();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    runtime = new TransportSessionRuntime(provider, 'deck_codex_capacity');
    await runtime.initialize({ sessionKey: 'deck_codex_capacity', cwd: '/tmp/project' } as never);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await provider.disconnect().catch(() => {});
    resetTransportQueueStoreForTests();
  });

  /** The app-server fails the newest turn exactly as codex reports a saturated model. */
  const failNewestTurn = async (message = CAPACITY_MESSAGE) => {
    const child = appServer.children.at(-1)!;
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${appServer.turnStarts()}`, status: 'failed', error: { message } } } });
    await settle();
  };

  it('keeps the turn, retries at <=15 s with no give-up for 30+ minutes, and returns to idle when capacity is back', async () => {
    runtime.send('implement the feature', 'msg-codex-1');
    for (let i = 0; i < 200 && appServer.turnStarts() < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(appServer.turnStarts()).toBe(1);
    vi.useFakeTimers();

    const gaps: number[] = [];
    let sends = appServer.turnStarts();
    await failNewestTurn();
    for (let attempt = 1; attempt <= 130; attempt += 1) {
      expect(runtime.pendingMessages).toEqual(['implement the feature']); // still queued, never dropped
      expect(runtime.getStatus()).toBe('thinking'); // busy and waiting, not error
      expect(runtime.lastProviderError?.message ?? CAPACITY_MESSAGE).toBe(CAPACITY_MESSAGE);
      // The runtime's own schedule: how long from this failure to the next attempt.
      const scheduled = runtime.getDiagnosticSnapshot().capacityRetry!.retryAt - Date.now();
      gaps.push(scheduled);
      expect(scheduled).toBeLessThanOrEqual(15_000);
      // Move the fake clock to just before the timer, in small steps (the provider has timers of its own): nothing may be sent early…
      for (let waited = 0; waited < scheduled - 1; waited += 50) await settle(Math.min(50, scheduled - 1 - waited));
      expect(appServer.turnStarts()).toBe(sends);
      // …and at the timer the runtime hands the turn to the provider again. The provider's own dispatch chain does real I/O, so
      // wait for it in REAL time while the fake clock stays where the timer fired.
      await vi.advanceTimersByTimeAsync(1);
      const latency = await untilSent(sends);
      expect(appServer.turnStarts()).toBe(sends + 1);
      expect(latency).toBeLessThanOrEqual(200); // provider dispatch latency on top of the runtime's <=15 s timer
      sends = appServer.turnStarts();
      await failNewestTurn();
    }
    expect(gaps.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(Math.max(...gaps)).toBe(15_000);
    expect(gaps.reduce((a, b) => a + b, 0)).toBeGreaterThan(30 * 60_000);

    // Capacity is back: the next retry succeeds and the turn completes.
    const finalDelay = runtime.getDiagnosticSnapshot().capacityRetry!.retryAt - Date.now();
    expect(finalDelay).toBeLessThanOrEqual(15_000);
    for (let waited = 0; waited < finalDelay; waited += 50) await settle(Math.min(50, finalDelay - waited));
    await untilSent(sends);
    expect(appServer.turnStarts()).toBe(sends + 1);
    const child = appServer.children.at(-1)!;
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${appServer.turnStarts()}`, status: 'completed', error: null } } });
    await settle(1_000);
    expect(runtime.getDiagnosticSnapshot().capacityRetry).toBeUndefined();
    expect(runtime.pendingMessages).toEqual([]);
    expect(runtime.getStatus()).toBe('idle');
    // The user's message went out on every attempt, always as the same turn text.
    const userTexts = appServer.children.flatMap((c) => c.requests).filter((r) => r.method === 'turn/start')
      .map((r) => JSON.stringify(r.params?.input ?? r.params));
    expect(userTexts.every((text) => text.includes('implement the feature'))).toBe(true);
  }, 120_000);

  it('COUNTEREXAMPLE: a permanent refusal (invalid model) from the same app-server is NOT retried and fails fast', async () => {
    runtime.send('needs auth', 'msg-codex-auth');
    for (let i = 0; i < 200 && appServer.turnStarts() < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    vi.useFakeTimers();
    // Real message from this daemon's log: a permanent invalid-model refusal, reported by the same app-server.
    await failNewestTurn('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}');
    await settle(120_000);
    expect(appServer.turnStarts()).toBe(1);
    expect(runtime.getDiagnosticSnapshot().capacityRetry).toBeUndefined();
    expect(runtime.getStatus()).toBe('error');
  });
});
