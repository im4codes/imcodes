/**
 * tsk_f2a967730b: a terminal that dropped bytes asks the daemon for a snapshot and
 * discards every byte until it gets one. The daemon used to answer that request
 * with silence in three ways - a capture already running "covered" it, a recent
 * capture was "reused" even though output had been forwarded since, and a capture
 * that raced live output was thrown away without a retry - so under real output
 * the requester stayed on its last picture indefinitely.
 *
 * Invariant pinned here: a snapshot request stays OWED until a snapshot that is
 * not older than the raw already forwarded has been published.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  capturePaneVisible: vi.fn(),
  capturePaneScreen: vi.fn(),
  capturePaneHistory: vi.fn(),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneSize: vi.fn(),
  paneExists: vi.fn().mockResolvedValue(true),
  sessionExists: vi.fn().mockResolvedValue(true),
  startPipePaneStream: vi.fn(),
  stopPipePaneStream: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn().mockReturnValue({ paneId: '%1' }),
  upsertSession: vi.fn(),
}));

import { capturePaneScreen, getPaneSize, startPipePaneStream } from '../../src/agent/tmux.js';
import { TerminalStreamer, type TerminalDiff } from '../../src/daemon/terminal-streamer.js';

const mockScreen = capturePaneScreen as ReturnType<typeof vi.fn>;
const mockSize = getPaneSize as ReturnType<typeof vi.fn>;
const mockStartPipe = startPipePaneStream as ReturnType<typeof vi.fn>;

const screenOf = (marker: string) => ({ visible: `${marker}0\n${marker}1\n${marker}2\n${marker}3` });

describe('TerminalStreamer — an owed snapshot is never answered with silence', () => {
  let streamer: TerminalStreamer;
  let frames: TerminalDiff[];
  let emitRaw: (text: string) => void;
  const SESSION = 'resync-session';

  beforeEach(async () => {
    vi.useFakeTimers();
    mockSize.mockResolvedValue({ cols: 80, rows: 4 });
    mockScreen.mockResolvedValue(screenOf('boot'));
    const stream = { on: vi.fn(), destroy: vi.fn() };
    mockStartPipe.mockResolvedValue({ stream, cleanup: vi.fn().mockResolvedValue(undefined) });
    streamer = new TerminalStreamer();
    frames = [];
    streamer.subscribe({ sessionName: SESSION, send: (diff) => frames.push(diff), sendRaw: () => {} });
    await vi.advanceTimersByTimeAsync(200);
    const onData = stream.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (chunk: Buffer) => void;
    emitRaw = (text) => onData(Buffer.from(text));
    frames.length = 0;
    mockScreen.mockClear();
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const requested = () => frames.filter((frame) => frame.snapshotRequested && frame.fullFrame);

  it('a request that raced live output is retried and answered by a capture taken after that output', async () => {
    let release: (value: ReturnType<typeof screenOf>) => void = () => {};
    mockScreen.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(1);
    emitRaw('output while capturing');
    release(screenOf('stale'));
    await vi.advanceTimersByTimeAsync(1);
    expect(requested(), 'the stale capture is not published').toHaveLength(0);

    mockScreen.mockResolvedValue(screenOf('fresh'));
    await vi.advanceTimersByTimeAsync(500);
    expect(requested()).toHaveLength(1);
    expect(requested()[0]!.lines[0]![1]).toBe('fresh0');
  });

  it('a request made while an EARLIER capture is running gets its own, newer capture', async () => {
    let release: (value: ReturnType<typeof screenOf>) => void = () => {};
    mockScreen.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(20);
    // The requester's gap happened after the running capture began.
    streamer.requestSnapshot(SESSION);
    mockScreen.mockResolvedValue(screenOf('second'));
    release(screenOf('first'));
    await vi.advanceTimersByTimeAsync(200);
    expect(mockScreen).toHaveBeenCalledTimes(2);
    expect(requested().at(-1)!.lines[0]![1]).toBe('second0');
  });

  it('a request after a published snapshot is NOT answered with it once output was forwarded since', async () => {
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(20);
    expect(requested()).toHaveLength(1);
    emitRaw('bytes the requester may have dropped');
    await vi.advanceTimersByTimeAsync(2);
    mockScreen.mockResolvedValue(screenOf('newer'));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(50);
    expect(mockScreen).toHaveBeenCalledTimes(2);
    expect(requested().at(-1)!.lines[0]![1]).toBe('newer0');
  });

  it('still collapses a burst, and reuses a snapshot nothing has been forwarded after', async () => {
    for (let i = 0; i < 8; i += 1) streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(20);
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(20);
    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(requested()).toHaveLength(1);
  });

  it('on a stream that is never quiet a snapshot is still published (forced), then corrected once it pauses', async () => {
    // Every capture is overtaken by output: no clean capture is possible.
    mockScreen.mockImplementation(async () => {
      emitRaw('flood');
      return screenOf('flood');
    });
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(requested().length, 'the requester must not be left frozen').toBeGreaterThanOrEqual(1);
    const forced = requested().length;

    // Output stops: the settle capture is clean and is the true final state.
    mockScreen.mockReset();
    mockScreen.mockResolvedValue(screenOf('final'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requested().length).toBeGreaterThan(forced);
    expect(requested().at(-1)!.lines[0]![1]).toBe('final0');
  });

  it('a saturated tmux (every capture slow, every capture raced) is answered within the deadline + one capture, not N captures', async () => {
    // Production shape on a busy CI runner: under a `yes` flood one capture-pane
    // takes ~1.4 s, and output arrives during each of them. The give-up rule used
    // to count ATTEMPTS (five clean ones, then force), i.e. five slow captures
    // plus the forced one: ~7 s with the requester frozen the whole time.
    let calls = 0;
    mockScreen.mockImplementation(() => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => { emitRaw('flood'); resolve(screenOf(`capture${calls}-`)); }, 1_400);
    }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(requested(), 'published as soon as the first overdue capture completes').toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('with moderately slow captures the deadline, not the attempt count, ends the retries', async () => {
    let calls = 0;
    mockScreen.mockImplementation(() => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => { emitRaw('flood'); resolve(screenOf(`capture${calls}-`)); }, 400);
    }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(990);
    expect(requested(), 'before the deadline a raced capture is still withheld').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(requested()).toHaveLength(1);
  });

  it('stops retrying when nobody is subscribed any more', async () => {
    let release: (value: ReturnType<typeof screenOf>) => void = () => {};
    mockScreen.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(1);
    emitRaw('x');
    streamer.destroy();
    release(screenOf('stale'));
    mockScreen.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockScreen).not.toHaveBeenCalled();
  });

  it('a resize burst produces ONE trailing snapshot request', async () => {
    for (let i = 0; i < 6; i += 1) {
      streamer.invalidateSize(SESSION);
      streamer.scheduleResizeSnapshot(SESSION);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(mockScreen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(requested()).toHaveLength(1);
  });
});

describe('TerminalStreamer — the snapshot carries what the next raw byte assumes', () => {
  it('reports the cursor and the alternate screen with the saved normal screen', async () => {
    vi.useFakeTimers();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 4 });
      mockScreen.mockResolvedValue({
        visible: 'alt-top\nalt-1\nalt-2\nalt-3',
        cursor: { x: 7, y: 2, visible: false },
        altScreen: true,
        normal: 'n0\nn1\n$ prompt',
      });
      mockStartPipe.mockResolvedValue({ stream: { on: vi.fn(), destroy: vi.fn() }, cleanup: vi.fn().mockResolvedValue(undefined) });
      const streamer = new TerminalStreamer();
      const frames: TerminalDiff[] = [];
      streamer.subscribe({ sessionName: 'cursor-session', send: (diff) => frames.push(diff) });
      await vi.advanceTimersByTimeAsync(200);
      const frame = frames[0]!;
      expect(frame.cursor).toEqual({ x: 7, y: 2, visible: false });
      expect(frame.altScreen).toBe(true);
      expect(frame.normalLines).toEqual([[0, 'n0'], [1, 'n1'], [2, '$ prompt'], [3, '']]);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps clamping a cursor that lies outside the declared screen', async () => {
    vi.useFakeTimers();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 4 });
      mockScreen.mockResolvedValue({ visible: 'a', cursor: { x: 9_999, y: 9_999, visible: true }, altScreen: false });
      mockStartPipe.mockResolvedValue({ stream: { on: vi.fn(), destroy: vi.fn() }, cleanup: vi.fn().mockResolvedValue(undefined) });
      const streamer = new TerminalStreamer();
      const frames: TerminalDiff[] = [];
      streamer.subscribe({ sessionName: 'clamp-session', send: (diff) => frames.push(diff) });
      await vi.advanceTimersByTimeAsync(200);
      expect(frames[0]!.cursor).toEqual({ x: 80, y: 3, visible: true });
      expect(frames[0]!.altScreen).toBeUndefined();
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TerminalStreamer — joining a busy session does not apply bytes twice', () => {
  it('bytes buffered before the capture began are in the snapshot already and are not replayed on top of it', async () => {
    vi.useFakeTimers();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 2 });
      mockScreen.mockResolvedValue(screenOf('boot'));
      const stream = { on: vi.fn(), destroy: vi.fn() };
      mockStartPipe.mockResolvedValue({ stream, cleanup: vi.fn().mockResolvedValue(undefined) });
      const streamer = new TerminalStreamer();
      // A first subscriber starts the pipe, then leaves; the pipe lingers (grace).
      const unsubscribe = streamer.subscribe({ sessionName: 'busy-session', send: () => {}, sendRaw: () => {} });
      await vi.advanceTimersByTimeAsync(200);
      const onData = stream.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (chunk: Buffer) => void;
      unsubscribe();

      // Joining the live pipe: raw is buffered until the snapshot is published.
      let release: (value: ReturnType<typeof screenOf>) => void = () => {};
      mockScreen.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      const seen: string[] = [];
      const frames: TerminalDiff[] = [];
      streamer.subscribe({
        sessionName: 'busy-session',
        send: (diff) => frames.push(diff),
        sendRaw: (data) => seen.push(data.toString()),
      });
      onData(Buffer.from('EARLY'));           // before the capture starts: part of the snapshot
      vi.setSystemTime(Date.now() + 5);
      await vi.advanceTimersByTimeAsync(1);   // bootstrap reaches the (held) capture
      onData(Buffer.from('DURING'));          // while it runs: may be newer than the frame
      release(screenOf('joined'));
      await vi.advanceTimersByTimeAsync(50);
      onData(Buffer.from('AFTER'));
      expect(frames.filter((frame) => frame.fullFrame)).toHaveLength(1);
      expect(seen).toEqual(['DURING', 'AFTER']);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('when the first paint fails nothing was published, so EVERYTHING buffered is replayed', async () => {
    vi.useFakeTimers();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 2 });
      mockScreen.mockResolvedValue(screenOf('boot'));
      const stream = { on: vi.fn(), destroy: vi.fn() };
      mockStartPipe.mockResolvedValue({ stream, cleanup: vi.fn().mockResolvedValue(undefined) });
      const streamer = new TerminalStreamer();
      const unsubscribe = streamer.subscribe({ sessionName: 'failed-paint', send: () => {}, sendRaw: () => {} });
      await vi.advanceTimersByTimeAsync(200);
      const onData = stream.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (chunk: Buffer) => void;
      unsubscribe();

      mockScreen.mockRejectedValueOnce(new Error('capture-pane exploded'));
      const seen: string[] = [];
      streamer.subscribe({ sessionName: 'failed-paint', send: () => {}, sendRaw: (data) => seen.push(data.toString()) });
      onData(Buffer.from('EARLY'));
      vi.setSystemTime(Date.now() + 5);
      await vi.advanceTimersByTimeAsync(50);
      expect(seen).toEqual(['EARLY']);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TerminalStreamer — the first subscriber has no gap between its snapshot and the raw stream', () => {
  it('attaches the pipe BEFORE the snapshot, and replays what the pane printed while it was captured', async () => {
    vi.useFakeTimers();
    mockScreen.mockReset();
    mockStartPipe.mockReset();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 2 });
      const stream = { on: vi.fn(), destroy: vi.fn() };
      mockStartPipe.mockResolvedValue({ stream, cleanup: vi.fn().mockResolvedValue(undefined) });
      let release: (value: ReturnType<typeof screenOf>) => void = () => {};
      mockScreen.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      const streamer = new TerminalStreamer();
      const seen: string[] = [];
      const frames: TerminalDiff[] = [];
      streamer.subscribe({ sessionName: 'first-subscriber', send: (diff) => frames.push(diff), sendRaw: (data) => seen.push(data.toString()) });
      await vi.advanceTimersByTimeAsync(1);

      // The pipe is attached while the capture is still running.
      expect(mockStartPipe).toHaveBeenCalled();
      expect(mockScreen).toHaveBeenCalledTimes(1);
      expect(mockStartPipe.mock.invocationCallOrder[0]!).toBeLessThan(mockScreen.mock.invocationCallOrder[0]!);
      const onData = stream.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (chunk: Buffer) => void;
      expect(onData).toBeTypeOf('function');

      // Output the pane produces while the capture runs: it was not in the frame,
      // and (before this fix) it never reached the browser at all.
      onData(Buffer.from('PRINTED-DURING-CAPTURE'));
      expect(seen).toEqual([]); // held behind the snapshot
      release(screenOf('first'));
      await vi.advanceTimersByTimeAsync(50);
      expect(frames.filter((frame) => frame.fullFrame)).toHaveLength(1);
      expect(seen).toEqual(['PRINTED-DURING-CAPTURE']);
      onData(Buffer.from('AFTER'));
      expect(seen).toEqual(['PRINTED-DURING-CAPTURE', 'AFTER']);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pipe that never finishes starting does not block the first paint', async () => {
    vi.useFakeTimers();
    try {
      mockSize.mockResolvedValue({ cols: 80, rows: 2 });
      mockScreen.mockResolvedValue(screenOf('painted'));
      mockStartPipe.mockReturnValue(new Promise(() => { /* wedged pipe-pane start */ }));
      const streamer = new TerminalStreamer();
      const frames: TerminalDiff[] = [];
      streamer.subscribe({ sessionName: 'wedged-pipe', send: (diff) => frames.push(diff), sendRaw: () => {} });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(frames.filter((frame) => frame.fullFrame).length).toBeGreaterThanOrEqual(1);
      streamer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

