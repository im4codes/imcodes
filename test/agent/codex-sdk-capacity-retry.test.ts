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
  // Simulates a starved event loop (a loaded CI runner): every app-server message reaches the provider this many REAL ms late.
  let lagMs = 0;
  const realSetTimeout = setTimeout;
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
    record = {
      child,
      requests: [],
      emits: (message) => {
        const line = `${JSON.stringify(message)}\n`;
        if (lagMs > 0) realSetTimeout(() => { stdout.write(line); }, lagMs); // equal lag keeps message order
        else stdout.write(line);
      },
    };
    children.push(record);
    return child;
  });
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = (typeof args[2] === 'function' ? args[2] : args[3]) as ((e: Error | null, out: string, err: string) => void) | undefined;
    callback?.(null, 'ok\n', '');
    return {} as never;
  });
  return { children, spawn, execFile, setLagMs: (ms: number) => { lagMs = ms; }, turnStarts: () => children.flatMap((c) => c.requests).filter((r) => r.method === 'turn/start').length, resetTurns: () => { turnCounter = 0; } };
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

/** Advance the fake clock and flush microtasks. It does NOT wait for the provider's real I/O: use {@link waitFor} for that. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/**
 * Wait, in REAL time and with the fake clock frozen, for a condition that depends on the provider's real async work (stream
 * parsing, fs). A fixed number of event-loop turns raced that work on a loaded runner (the CI flake: the check ran before the
 * provider had processed the app-server's `turn/completed`), so every such wait is on the observable signal itself, with a
 * generous real-time bound that only matters when something is genuinely stuck.
 */
async function waitFor(what: string, condition: () => boolean, realTimeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + realTimeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2));
  }
}

describe('codex-sdk "model at capacity" against a fake app-server', () => {
  let provider: CodexSdkProvider;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    resetTransportQueueStoreForTests();
    appServer.children.length = 0;
    appServer.resetTurns();
    appServer.setLagMs(0);
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
  const failNewestTurn = (message = CAPACITY_MESSAGE) => {
    const child = appServer.children.at(-1)!;
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${appServer.turnStarts()}`, status: 'failed', error: { message } } } });
  };
  /** The provider has parsed the failure and the runtime has armed retry number `attempt` (the signal, not a guess about timing). */
  const retryArmed = (attempt: number) => () => {
    const retry = runtime.getDiagnosticSnapshot().capacityRetry;
    return retry?.attempt === attempt && retry.retryAt > 0;
  };

  it.each([0, 25])('keeps the turn, retries at <=15 s with no give-up for 30+ minutes, and returns to idle when capacity is back (app-server messages arrive %i ms late)', async (lagMs) => {
    appServer.setLagMs(lagMs);
    runtime.send('implement the feature', 'msg-codex-1');
    await waitFor('the first turn/start to reach the app-server', () => appServer.turnStarts() >= 1);
    expect(appServer.turnStarts()).toBe(1);
    vi.useFakeTimers();

    const gaps: number[] = [];
    let sends = appServer.turnStarts();
    failNewestTurn();
    for (let attempt = 1; attempt <= 130; attempt += 1) {
      await waitFor(`retry ${attempt} to be armed`, retryArmed(attempt));
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
      // wait for it in REAL time with the fake clock frozen: the send must not need any further virtual time.
      await vi.advanceTimersByTimeAsync(1);
      const firedAt = Date.now();
      await waitFor(`retry ${attempt} to reach the app-server`, () => appServer.turnStarts() === sends + 1);
      expect(Date.now()).toBe(firedAt);
      sends = appServer.turnStarts();
      failNewestTurn();
    }
    expect(gaps.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(Math.max(...gaps)).toBe(15_000);
    expect(gaps.reduce((a, b) => a + b, 0)).toBeGreaterThan(30 * 60_000);

    // Capacity is back: the next retry succeeds and the turn completes.
    await waitFor('retry 131 to be armed', retryArmed(131));
    const finalDelay = runtime.getDiagnosticSnapshot().capacityRetry!.retryAt - Date.now();
    expect(finalDelay).toBeLessThanOrEqual(15_000);
    for (let waited = 0; waited < finalDelay; waited += 50) await settle(Math.min(50, finalDelay - waited));
    await waitFor('the final retry to reach the app-server', () => appServer.turnStarts() === sends + 1);
    const child = appServer.children.at(-1)!;
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${appServer.turnStarts()}`, status: 'completed', error: null } } });
    // The COMPLETION must clear the episode. Wait on that signal with the fake clock frozen (advancing it 30 s would let the
    // runtime's own "survived 30 s" timer end the episode and hide a completion that failed to).
    const completedAt = Date.now();
    await waitFor('the completion to clear the capacity retry state', () => runtime.getDiagnosticSnapshot().capacityRetry === undefined && runtime.getStatus() === 'idle');
    expect(Date.now() - completedAt).toBeLessThan(30_000);
    expect(runtime.pendingMessages).toEqual([]);
    // The user's message went out on every attempt, always as the same turn text.
    const userTexts = appServer.children.flatMap((c) => c.requests).filter((r) => r.method === 'turn/start')
      .map((r) => JSON.stringify(r.params?.input ?? r.params));
    expect(userTexts.every((text) => text.includes('implement the feature'))).toBe(true);
  }, 120_000);

  it('COUNTEREXAMPLE: a permanent refusal (invalid model) from the same app-server is NOT retried and fails fast', async () => {
    runtime.send('needs auth', 'msg-codex-auth');
    await waitFor('the first turn/start to reach the app-server', () => appServer.turnStarts() >= 1);
    vi.useFakeTimers();
    // Real message from this daemon's log: a permanent invalid-model refusal, reported by the same app-server.
    failNewestTurn('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}');
    await waitFor('the permanent refusal to fail the session', () => runtime.getStatus() === 'error');
    await settle(120_000);
    expect(appServer.turnStarts()).toBe(1);
    expect(runtime.getDiagnosticSnapshot().capacityRetry).toBeUndefined();
    expect(runtime.getStatus()).toBe('error');
  });
});
