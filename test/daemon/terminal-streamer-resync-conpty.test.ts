/**
 * tsk_f2a967730b, Windows ConPTY path. ConPTY snapshots are approximate (a text
 * capture of a ring buffer, no cursor / alternate-screen report), so a resync
 * replays the recent raw screen buffer after the frame to rebuild real terminal
 * state. The owed-snapshot guarantee must hold there too, and the raw replay
 * must follow ONLY a snapshot that was actually published: replaying screen
 * bytes after a withheld (raced) capture would paint old state over live output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'conpty',
  capturePaneVisible: vi.fn(),
  capturePaneHistory: vi.fn(),
  getPaneId: vi.fn().mockResolvedValue('conpty-1'),
  getPaneSize: vi.fn(),
  paneExists: vi.fn().mockResolvedValue(true),
  sessionExists: vi.fn().mockResolvedValue(true),
  startPipePaneStream: vi.fn(),
  stopPipePaneStream: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/agent/conpty.js', () => ({
  conptyGetScreenBuffer: vi.fn(() => 'REPLAY-OF-SCREEN'),
  conptyIsPaneAlive: vi.fn(() => true),
}));
vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn().mockReturnValue({ paneId: 'conpty-1' }),
  upsertSession: vi.fn(),
}));

import { capturePaneVisible, getPaneSize, startPipePaneStream } from '../../src/agent/tmux.js';
import { TerminalStreamer, type TerminalDiff } from '../../src/daemon/terminal-streamer.js';

const mockCapture = capturePaneVisible as ReturnType<typeof vi.fn>;

describe('TerminalStreamer — ConPTY resync', () => {
  let streamer: TerminalStreamer;
  let frames: TerminalDiff[];
  let replays: string[];
  let emitRaw: (text: string) => void;
  const SESSION = 'conpty-resync';

  beforeEach(async () => {
    vi.useFakeTimers();
    (getPaneSize as ReturnType<typeof vi.fn>).mockResolvedValue({ cols: 80, rows: 2 });
    mockCapture.mockResolvedValue('boot0\nboot1');
    const stream = { on: vi.fn(), destroy: vi.fn() };
    (startPipePaneStream as ReturnType<typeof vi.fn>).mockResolvedValue({ stream, cleanup: vi.fn().mockResolvedValue(undefined) });
    streamer = new TerminalStreamer();
    frames = [];
    replays = [];
    streamer.subscribe({
      sessionName: SESSION,
      send: (diff) => frames.push(diff),
      sendRaw: (data) => { if (data.toString() === 'REPLAY-OF-SCREEN') replays.push('replay'); },
    });
    await vi.advanceTimersByTimeAsync(200);
    const onData = stream.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (chunk: Buffer) => void;
    emitRaw = (text) => onData(Buffer.from(text));
    frames.length = 0;
    replays.length = 0;
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('a clean snapshot is followed by the raw screen replay, exactly once', async () => {
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(50);
    expect(frames.filter((f) => f.snapshotRequested)).toHaveLength(1);
    expect(replays).toHaveLength(1);
  });

  it('a capture that raced live output publishes nothing and replays nothing; the retry then does both', async () => {
    let release: (value: string) => void = () => {};
    mockCapture.mockReturnValueOnce(new Promise<string>((resolve) => { release = resolve; }));
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(1);
    emitRaw('live output');
    release('stale0\nstale1');
    await vi.advanceTimersByTimeAsync(1);
    expect(frames.filter((f) => f.snapshotRequested)).toHaveLength(0);
    expect(replays).toHaveLength(0);

    mockCapture.mockResolvedValue('fresh0\nfresh1');
    await vi.advanceTimersByTimeAsync(500);
    expect(frames.filter((f) => f.snapshotRequested)).toHaveLength(1);
    expect(frames.at(-1)!.lines[0]![1]).toBe('fresh0');
    expect(replays).toHaveLength(1);
  });

  it('reports no cursor or alternate screen (ConPTY cannot), so the browser keeps its raw-replay behaviour', async () => {
    streamer.requestSnapshot(SESSION);
    await vi.advanceTimersByTimeAsync(50);
    const frame = frames.find((f) => f.snapshotRequested)!;
    expect(frame.cursor).toBeUndefined();
    expect(frame.altScreen).toBeUndefined();
  });
});
