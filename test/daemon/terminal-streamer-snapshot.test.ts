import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux functions before any imports that pull them in
vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  capturePaneVisible: vi.fn(),
  capturePaneHistory: vi.fn(),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneSize: vi.fn(),
  sessionExists: vi.fn().mockResolvedValue(true),
  startPipePaneStream: vi.fn(),
  stopPipePaneStream: vi.fn().mockResolvedValue(undefined),
}));

import { stopPipePaneStream } from '../../src/agent/tmux.js';
const mockStopPipe = stopPipePaneStream as ReturnType<typeof vi.fn>;

// Mock session-store so getSession returns a valid paneId (needed by startPipe)
vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn().mockReturnValue({ paneId: '%1' }),
  upsertSession: vi.fn(),
}));

import { capturePaneVisible, capturePaneHistory, getPaneId, getPaneSize, startPipePaneStream, sessionExists } from '../../src/agent/tmux.js';
import { getSession } from '../../src/store/session-store.js';
import { TerminalStreamer } from '../../src/daemon/terminal-streamer.js';
import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';

// We need to intercept the timelineEmitter singleton used inside terminal-streamer.
// Re-export the singleton and spy on it via vi.spyOn.
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

const mockCapture = capturePaneVisible as ReturnType<typeof vi.fn>;
const mockHistory = capturePaneHistory as ReturnType<typeof vi.fn>;
const mockGetPaneId = getPaneId as ReturnType<typeof vi.fn>;
const mockSize = getPaneSize as ReturnType<typeof vi.fn>;
const mockStartPipe = startPipePaneStream as ReturnType<typeof vi.fn>;
const mockSessionExists = sessionExists as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;

/** Flush all pending timers + microtasks so the capture loop runs. */
const flush = () => vi.advanceTimersByTimeAsync(200);

describe('TerminalStreamer — snapshot behavior', () => {
  let streamer: TerminalStreamer;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Default mock responses
    mockSize.mockResolvedValue({ cols: 80, rows: 4 });
    mockCapture.mockResolvedValue('line0\nline1\nline2\nline3');
    mockHistory.mockResolvedValue('');
    mockGetPaneId.mockResolvedValue('%1');
    mockSessionExists.mockResolvedValue(true);
    mockGetSession.mockReturnValue({ paneId: '%1' });

    // Mock startPipePaneStream to return a no-op stream (never emits data)
    const noopStream = { on: vi.fn(), destroy: vi.fn() };
    mockStartPipe.mockResolvedValue({ stream: noopStream, cleanup: vi.fn().mockResolvedValue(undefined) });

    // Spy on the shared timelineEmitter used by TerminalStreamer
    emitSpy = vi.spyOn(timelineEmitter, 'emit');

    streamer = new TerminalStreamer();
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('first frame after subscribe has snapshotRequested=false and does NOT emit terminal.snapshot', async () => {
    const received: import('../../src/daemon/terminal-streamer.js').TerminalDiff[] = [];

    streamer.subscribe({
      sessionName: 'test-session',
      send: (diff) => received.push(diff),
    });

    await flush();

    expect(received.length).toBeGreaterThan(0);
    const firstFrame = received[0];
    expect(firstFrame.fullFrame).toBe(true);
    expect(firstFrame.snapshotRequested).toBe(false);

    // terminal.snapshot event should NOT have been emitted
    const snapshotCalls = emitSpy.mock.calls.filter(
      ([, type]) => type === 'terminal.snapshot',
    );
    expect(snapshotCalls).toHaveLength(0);
  });

  it('terminal.snapshot_request triggers fullFrame with snapshotRequested=true and DOES emit terminal.snapshot', async () => {
    const session = 'snap-session';
    const received: import('../../src/daemon/terminal-streamer.js').TerminalDiff[] = [];

    streamer.subscribe({
      sessionName: session,
      send: (diff) => received.push(diff),
    });

    // First frame (initial subscribe)
    await flush();
    expect(received[0].fullFrame).toBe(true);
    expect(received[0].snapshotRequested).toBe(false);
    emitSpy.mockClear();

    // Now change the screen content so a diff is possible, then request snapshot
    mockCapture.mockResolvedValue('new0\nnew1\nnew2\nnew3');

    // Request snapshot — this clears lastFrames and sets pendingSnapshot
    streamer.requestSnapshot(session);

    await flush();

    // Find the full frame with snapshotRequested=true
    const snapFrame = received.find((d) => d.snapshotRequested);
    expect(snapFrame).toBeDefined();
    expect(snapFrame!.fullFrame).toBe(true);

    // terminal.snapshot timeline event SHOULD have been emitted
    const snapshotCalls = emitSpy.mock.calls.filter(
      ([, type]) => type === 'terminal.snapshot',
    );
    expect(snapshotCalls.length).toBeGreaterThan(0);
    const [snapshotSessionId, snapshotType, snapshotPayload] = snapshotCalls[0];
    expect(snapshotSessionId).toBe(session);
    expect(snapshotType).toBe('terminal.snapshot');
    expect(snapshotPayload).toHaveProperty('lines');
    expect(snapshotPayload).toHaveProperty('cols');
    expect(snapshotPayload).toHaveProperty('rows');
  });

  it('subscribe sends history on first connection when sendHistory is provided', async () => {
    const session = 'hist-session';
    mockHistory.mockResolvedValue('history line 1\nhistory line 2');

    const historyReceived: import('../../src/daemon/terminal-streamer.js').TerminalHistory[] = [];

    streamer.subscribe({
      sessionName: session,
      send: () => {},
      sendHistory: (h) => historyReceived.push(h),
    });

    // Flush microtasks for the capturePaneHistory promise
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(historyReceived.length).toBeGreaterThan(0);
    expect(historyReceived[0].content).toContain('history line 1');
  });

  it('unsubscribe stops the capture loop', async () => {
    const session = 'unsub-session';
    const received: import('../../src/daemon/terminal-streamer.js').TerminalDiff[] = [];

    const unsub = streamer.subscribe({
      sessionName: session,
      send: (d) => received.push(d),
    });

    await flush();
    const countAfterFirst = received.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    unsub();
    mockCapture.mockResolvedValue('changed line');

    await flush();
    // No new diffs after unsubscribe
    expect(received.length).toBe(countAfterFirst);
  });

  it('emits a session-scoped error after pipe-pane rebind retries are exhausted', async () => {
    const session = 'broken-stream-session';
    mockStartPipe.mockRejectedValue(new Error('cat spawn failed'));

    streamer.subscribe({
      sessionName: session,
      send: () => {},
      onError: () => {},
    });

    await flush();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(emitSpy).toHaveBeenCalledWith(
      session,
      'assistant.text',
      expect.objectContaining({
        text: '⚠️ Error: Terminal stream unavailable after max retries',
        streaming: false,
      }),
      expect.any(Object),
    );
  });

  it('suppresses pane-id inline errors for transport sessions', async () => {
    const session = 'deck_sub_qwen';
    mockGetSession.mockReturnValue({ agentType: 'qwen', runtimeType: 'transport' });
    mockGetPaneId.mockResolvedValue(undefined);

    streamer.subscribe({
      sessionName: session,
      send: () => {},
      onError: () => {},
    });

    await flush();

    expect(emitSpy).not.toHaveBeenCalledWith(
      session,
      'assistant.text',
      expect.objectContaining({
        text: '⚠️ Error: Terminal stream unavailable: pane id not available. Restart the session to fix.',
      }),
      expect.any(Object),
    );
  });

  it('unexpected pipe close reaps the FIFO reader subprocess (no orphan `cat stream.fifo`)', async () => {
    // Regression test: previously `handlePipeClose` deleted the pipeState
    // tracking entry but never called `pipeState.cleanup()` or
    // `stopPipePaneStream()`. The backing `cat /tmp/.../stream.fifo` child
    // process stayed alive forever, draining bytes into a dangling Node
    // stream whose buffer grew unbounded — ~425MB/min growth until OOM. On
    // one leaking production daemon we observed 10 orphan cat processes.
    const session = 'orphan-fifo-session';

    // Build a stream that we can trigger 'close' on.
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const stream = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(cb);
      }),
      destroy: vi.fn(),
    };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    mockStartPipe.mockResolvedValue({ stream, cleanup });
    mockStopPipe.mockClear();
    // mockClear() wipes mockResolvedValue too — re-prime so handlePipeClose's
    // `await stopPipePaneStream(sessionName).catch(...)` sees a real Promise.
    mockStopPipe.mockResolvedValue(undefined);

    streamer.subscribe({
      sessionName: session,
      send: () => {},
      onError: () => {},
    });

    // Wait for startPipe to register the stream listeners.
    await flush();

    // Simulate an unexpected FIFO close (e.g. tmux session died). This is
    // the code path that previously leaked the child.
    const closeCbs = listeners.get('close');
    expect(closeCbs, 'startPipe must register a close listener').toBeTruthy();
    closeCbs!.forEach((cb) => cb());

    await flush();

    // The stream's destroy() must be invoked so the Node readable side
    // stops buffering.
    expect(stream.destroy).toHaveBeenCalled();
    // The pipeState's cleanup closure must run so provider-side resources
    // get released.
    expect(cleanup).toHaveBeenCalled();
    // stopPipePaneStream must be called so tmux kills the `cat` reader.
    expect(mockStopPipe).toHaveBeenCalledWith(session);
  });

  it('concurrent subscribes for the same session spawn only one pipe (no orphan cat)', async () => {
    // Regression: `startPipe` was a non-locking async; two subscribes
    // arriving in the same tick both saw `this.pipes.has() === false`,
    // both awaited `startPipePaneStream`, both spawned a `cat` via tmux,
    // and the second's `pipes.set(...)` orphaned the first — its cat
    // kept running with no tracking entry, feeding bytes into a Node
    // stream that `handlePipeClose` could never find. On one production
    // daemon this surfaced as ~5% orphan rate (10 of 215 pipe starts).
    const session = 'race-session';

    let startInvocations = 0;
    // Make startPipePaneStream "slow" — returns a promise that only
    // resolves on our signal. This reproduces the race: two subscribes
    // both find `pipes.has === false`, both enter startPipe, both await.
    let resolveFirst: (() => void) | null = null;
    const firstResolved = new Promise<void>((r) => { resolveFirst = r; });
    mockStartPipe.mockImplementation(async () => {
      startInvocations++;
      // Only the first call awaits the gate; any additional concurrent
      // call must NOT even reach here (the guard in startPipe should
      // drop it).
      await firstResolved;
      const stream = { on: vi.fn(), destroy: vi.fn() };
      return { stream, cleanup: vi.fn().mockResolvedValue(undefined) };
    });

    streamer.subscribe({ sessionName: session, send: () => {} });
    streamer.subscribe({ sessionName: session, send: () => {} });

    // Let the microtasks flush so both subscribes enter startPipe.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // Both subscribes have queued; only ONE of them should have reached
    // the `startPipePaneStream` call. The other was dropped by the
    // `pipes.has() || pipeStartLocks.has()` guard.
    expect(startInvocations).toBe(1);

    // Release the gate so the in-flight start completes cleanly.
    resolveFirst?.();
    await flush();

    // Still exactly one invocation — no deferred spawn after release.
    expect(startInvocations).toBe(1);
  });

  it('suppresses pane-id inline errors when the session record is not yet in the store', async () => {
    // Simulates the launch race for transport sub-sessions (copilot-sdk /
    // cursor-headless): the web UI subscribes before `launchTransportSession`
    // has finished persisting the session record. Without this guard, users
    // see a permanent "Terminal stream unavailable: pane id not available.
    // Restart the session to fix." error stamped into the timeline of a
    // session that's only a handful of milliseconds old.
    const session = 'deck_sub_copilot_race';
    mockGetSession.mockReturnValue(undefined);
    mockGetPaneId.mockResolvedValue(undefined);

    streamer.subscribe({
      sessionName: session,
      send: () => {},
      onError: () => {},
    });

    await flush();

    expect(emitSpy).not.toHaveBeenCalledWith(
      session,
      'assistant.text',
      expect.objectContaining({
        text: '⚠️ Error: Terminal stream unavailable: pane id not available. Restart the session to fix.',
      }),
      expect.any(Object),
    );
  });
});
