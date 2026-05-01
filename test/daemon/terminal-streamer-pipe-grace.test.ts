/**
 * Pins the pipe-stop grace window — when subscribers go to 0, the pipe
 * does NOT tear down immediately. A new subscriber attaching within
 * `PIPE_STOP_GRACE_MS` (30 s) reuses the live pipe with zero churn.
 *
 * Real-world bug this protects against: a dock with 16+ SubSessionCard
 * components that all unmount + remount on a parent re-render. Each
 * card's TerminalView ran subscribe → unsubscribe → subscribe in a tight
 * loop, taking subs from N→0→N for every visible session simultaneously.
 * Without grace, every cycle did a full pipe-pane stop + start (each
 * with a tmux capture-pane snapshot), and the user saw every shell
 * "freeze for several seconds" while the pipes spun back up.
 *
 * With grace, the unsubscribe→resubscribe round-trip is a no-op: the
 * timer is set, then cancelled before it fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn().mockReturnValue({ paneId: '%1' }),
  upsertSession: vi.fn(),
}));

import {
  capturePaneVisible,
  capturePaneHistory,
  getPaneId,
  getPaneSize,
  startPipePaneStream,
  stopPipePaneStream,
  sessionExists,
} from '../../src/agent/tmux.js';
import { TerminalStreamer } from '../../src/daemon/terminal-streamer.js';

const mockCapture = capturePaneVisible as ReturnType<typeof vi.fn>;
const mockHistory = capturePaneHistory as ReturnType<typeof vi.fn>;
const mockGetPaneId = getPaneId as ReturnType<typeof vi.fn>;
const mockSize = getPaneSize as ReturnType<typeof vi.fn>;
const mockStartPipe = startPipePaneStream as ReturnType<typeof vi.fn>;
const mockStopPipeNative = stopPipePaneStream as ReturnType<typeof vi.fn>;
const mockSessionExists = sessionExists as ReturnType<typeof vi.fn>;

const flush = () => vi.advanceTimersByTimeAsync(200);

describe('TerminalStreamer — pipe-stop grace window', () => {
  let streamer: TerminalStreamer;

  beforeEach(() => {
    vi.useFakeTimers();
    // Explicit mockClear() — `vi.clearAllMocks()` in afterEach can run
    // BEFORE async cleanup work (`streamer.destroy()` calls `stopPipe`
    // which awaits, deferring `stopPipePaneStream` past the afterEach
    // tick). Without this clear, leftover calls from the previous test's
    // teardown bleed into the current test's call counts.
    mockSize.mockReset().mockResolvedValue({ cols: 80, rows: 4 });
    mockCapture.mockReset().mockResolvedValue('a\nb\nc\nd');
    mockHistory.mockReset().mockResolvedValue('');
    mockGetPaneId.mockReset().mockResolvedValue('%1');
    mockSessionExists.mockReset().mockResolvedValue(true);
    const noopStream = { on: vi.fn(), destroy: vi.fn() };
    mockStartPipe.mockReset().mockResolvedValue({ stream: noopStream, cleanup: vi.fn().mockResolvedValue(undefined) });
    mockStopPipeNative.mockReset().mockResolvedValue(undefined);

    streamer = new TerminalStreamer();
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
  });

  it('unsubscribe-then-resubscribe within the grace window does NOT restart the pipe', async () => {
    const session = 'graced-session';
    const sub1 = { sessionName: session, send: vi.fn() };
    const sub2 = { sessionName: session, send: vi.fn() };

    // First subscribe → starts the pipe.
    const cleanup1 = streamer.subscribe(sub1);
    await flush();
    expect(mockStartPipe).toHaveBeenCalledTimes(1);

    // Unsubscribe → grace timer scheduled, pipe NOT yet stopped.
    cleanup1();
    // Advance only a small amount — well inside the grace window.
    await vi.advanceTimersByTimeAsync(500);
    expect(mockStopPipeNative).not.toHaveBeenCalled();

    // Re-subscribe within the grace window. Pipe stays alive — no
    // additional startPipePaneStream call, no stopPipePaneStream.
    streamer.subscribe(sub2);
    await flush();
    expect(mockStartPipe).toHaveBeenCalledTimes(1); // still 1
    expect(mockStopPipeNative).not.toHaveBeenCalled();
  });

  it('unsubscribe with no resubscribe within grace window DOES tear down the pipe', async () => {
    const session = 'expiring-session';
    const sub = { sessionName: session, send: vi.fn() };

    streamer.subscribe(sub);
    await flush();
    expect(mockStartPipe).toHaveBeenCalledTimes(1);

    streamer.unsubscribe(sub);

    // Just under the grace window — still alive.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mockStopPipeNative).not.toHaveBeenCalled();

    // Cross the grace boundary → teardown fires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockStopPipeNative).toHaveBeenCalledWith(session);
  });

  it('mass dock-remount churn does not restart the pipe (the user-reported repro)', async () => {
    // Simulate the exact regression: 16 sessions, each goes through
    // subscribe → unsubscribe → subscribe in <200 ms (component
    // re-mount). Without grace this triggered 16 pipe-pane restarts
    // visible in the daemon log. With grace, ZERO restarts.
    const sessionNames = Array.from({ length: 16 }, (_, i) => `dock_session_${i}`);

    const subs1 = sessionNames.map((name) => ({ sessionName: name, send: vi.fn() }));
    for (const s of subs1) streamer.subscribe(s);
    await flush();

    const initialStartCount = mockStartPipe.mock.calls.length;
    expect(initialStartCount).toBe(16);

    // Mass unsubscribe (parent component re-render begins).
    for (const s of subs1) streamer.unsubscribe(s);

    // ~50ms later the new subscribers attach (re-render commit).
    await vi.advanceTimersByTimeAsync(50);
    const subs2 = sessionNames.map((name) => ({ sessionName: name, send: vi.fn() }));
    for (const s of subs2) streamer.subscribe(s);
    await flush();

    // No additional pipe restarts.
    expect(mockStartPipe.mock.calls.length).toBe(initialStartCount);
    expect(mockStopPipeNative).not.toHaveBeenCalled();
  });

  it('streamer.destroy() clears pending grace timers (no leak)', async () => {
    const session = 'destroy-mid-grace';
    const sub = { sessionName: session, send: vi.fn() };
    streamer.subscribe(sub);
    await flush();
    streamer.unsubscribe(sub);
    // Grace timer is now pending.

    streamer.destroy();
    // Advance past the grace window — the timer must NOT fire (would
    // race against destroyed state).
    await vi.advanceTimersByTimeAsync(35_000);
    // No throw, no double-stop. (mockStopPipeNative may have been called
    // by destroy itself synchronously, but at most once per session.)
    expect(mockStopPipeNative.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
