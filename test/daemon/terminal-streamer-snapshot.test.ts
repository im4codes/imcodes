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

// Mock session-store so getSession returns a valid paneId (needed by startPipe)
vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn().mockReturnValue({ paneId: '%1' }),
  upsertSession: vi.fn(),
}));

import { capturePaneVisible, capturePaneHistory, getPaneSize, startPipePaneStream } from '../../src/agent/tmux.js';
import { TerminalStreamer } from '../../src/daemon/terminal-streamer.js';
import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';

// We need to intercept the timelineEmitter singleton used inside terminal-streamer.
// Re-export the singleton and spy on it via vi.spyOn.
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

const mockCapture = capturePaneVisible as ReturnType<typeof vi.fn>;
const mockHistory = capturePaneHistory as ReturnType<typeof vi.fn>;
const mockSize = getPaneSize as ReturnType<typeof vi.fn>;
const mockStartPipe = startPipePaneStream as ReturnType<typeof vi.fn>;

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
});
