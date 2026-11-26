/**
 * Regression: a STALE stored paneId must never strand a terminal stream — and,
 * crucially, must never leak a pipe reader.
 *
 * Scenario (observed on a migrated box): `sessions.json` is copied to a fresh
 * machine, so every session's stored paneId (`%N`) points at a tmux pane that
 * does not exist on the new host. The OLD code piped straight into that dead
 * pane: it spawned the `cat` FIFO reader BEFORE `tmux pipe-pane` ran, and when
 * pipe-pane failed the reader was left blocked in the kernel (D-state) —
 * unkillable, and (under the daemon's systemd `KillMode=process`) surviving to
 * brick the daemon's own restart. We saw ~12 such `cat` children stall a
 * restart.
 *
 * The fix has two layers. This file pins the STREAMER layer:
 *   - `startPipe` checks the stored paneId is live; if it's gone it re-resolves
 *     a fresh pane from tmux and pipes into THAT (and persists it).
 *   - If no live pane can be resolved (e.g. the tmux server is momentarily
 *     unreachable) it keeps the stored id and defers to `startPipePaneStream`'s
 *     hard guard — so the streamer never invents a paneId and the existing
 *     rebind/retry path is preserved.
 *
 * The other layer — `startPipePaneStream` refusing to spawn a reader for a dead
 * pane at all — is pinned by the tmux integration test (real tmux required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  capturePaneVisible: vi.fn().mockResolvedValue('snapshot\nlines'),
  capturePaneHistory: vi.fn().mockResolvedValue(''),
  getPaneId: vi.fn().mockResolvedValue('%fresh'),
  getPaneIdentity: vi.fn().mockResolvedValue(undefined),
  getPaneSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
  paneExists: vi.fn().mockResolvedValue(true),
  sessionExists: vi.fn().mockResolvedValue(true),
  startPipePaneStream: vi.fn(),
  stopPipePaneStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

import { getPaneId, getPaneIdentity, paneExists, startPipePaneStream } from '../../src/agent/tmux.js';
import { getSession, upsertSession } from '../../src/store/session-store.js';
import { TerminalStreamer } from '../../src/daemon/terminal-streamer.js';

const mockGetPaneId = getPaneId as ReturnType<typeof vi.fn>;
const mockGetPaneIdentity = getPaneIdentity as ReturnType<typeof vi.fn>;
const mockPaneExists = paneExists as ReturnType<typeof vi.fn>;
const mockStartPipe = startPipePaneStream as ReturnType<typeof vi.fn>;
const mockGetSession = getSession as ReturnType<typeof vi.fn>;
const mockUpsert = upsertSession as ReturnType<typeof vi.fn>;

/** Flush pending timers + microtasks so bootstrapSubscriber → startPipe runs. */
const flush = () => vi.advanceTimersByTimeAsync(200);

describe('TerminalStreamer — stale stored paneId self-heal', () => {
  let streamer: TerminalStreamer;

  beforeEach(() => {
    vi.useFakeTimers();
    const noopStream = { on: vi.fn(), destroy: vi.fn() };
    mockStartPipe.mockReset().mockResolvedValue({ stream: noopStream, cleanup: vi.fn().mockResolvedValue(undefined) });
    mockGetPaneId.mockReset().mockResolvedValue('%fresh');
    mockGetPaneIdentity.mockReset().mockResolvedValue(undefined);
    mockPaneExists.mockReset().mockResolvedValue(true);
    mockGetSession.mockReset();
    mockUpsert.mockReset();
    streamer = new TerminalStreamer();
  });

  afterEach(() => {
    streamer.destroy();
    vi.useRealTimers();
  });

  it('re-resolves a live pane and persists it when the stored paneId is stale', async () => {
    const session = 'deck_migrated_w1';
    mockGetSession.mockReturnValue({ paneId: '%stale' });
    // The stored pane is gone; the freshly-created pane on this host is %fresh.
    mockPaneExists.mockImplementation(async (p: string) => p === '%fresh');
    mockGetPaneId.mockResolvedValue('%fresh');

    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();

    // Pipe was started against the LIVE pane, not the stale stored one.
    expect(mockStartPipe).toHaveBeenCalledTimes(1);
    expect(mockStartPipe).toHaveBeenCalledWith(session, '%fresh');
    // The fresh paneId was persisted back to the store so the next start is direct.
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%fresh' }));
  });

  it('keeps the stored paneId (defers to the pipe guard) when no live pane resolves', async () => {
    const session = 'deck_offline_w1';
    mockGetSession.mockReturnValue({ paneId: '%stale' });
    mockPaneExists.mockResolvedValue(false);                       // stored pane is gone
    mockGetPaneId.mockRejectedValue(new Error('no server running')); // …and tmux can't resolve one

    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();

    // The streamer did NOT invent a paneId — it passes the stored one through so
    // startPipePaneStream's hard guard is the single rejection point, and the
    // normal rebind path (unchanged) takes over.
    expect(mockStartPipe).toHaveBeenCalledWith(session, '%stale');
    // No bogus pane was persisted.
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('uses the stored paneId directly without re-resolving when it is live', async () => {
    const session = 'deck_live_w1';
    mockGetSession.mockReturnValue({ paneId: '%7' });
    mockPaneExists.mockResolvedValue(true); // stored pane is alive

    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();

    expect(mockStartPipe).toHaveBeenCalledWith(session, '%7');
    // Live stored pane → no re-resolution, no store churn.
    expect(mockGetPaneId).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('restarts the pipe when the session was killed and recreated even though tmux reused the same paneId', async () => {
    // Real bug (tsk_cd_resubscribe_after_reconnect): tmux's `%N` pane-id
    // counter is scoped to the whole server and gets REUSED once every other
    // session is gone -- a lone kill-session + new-session under the same
    // name routinely reallocates the exact same paneId. A staleness check
    // that compares paneId alone can never see this: the pipe reads from a
    // dead pane forever and new keystrokes are silently lost. session_created
    // changes on every fresh session even when the paneId coincidentally
    // repeats, so it is the signal that must catch this.
    const session = 'deck_reconnect_w1';
    mockGetSession.mockReturnValue(undefined); // e.g. an ad-hoc/raw tmux session, no store record
    mockPaneExists.mockResolvedValue(true);
    // startPipe resolves the paneId it actually pipes into via getPaneId
    // (getPaneIdentity is only consulted for the extra staleness signal), so
    // both must agree on the reused "%0" for this test to isolate the
    // session_created-only change.
    mockGetPaneId.mockResolvedValue('%0');
    mockGetPaneIdentity.mockResolvedValue({ paneId: '%0', sessionCreated: '1000' });

    // First subscribe: starts a pipe for "generation 1" of the session.
    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();
    expect(mockStartPipe).toHaveBeenCalledTimes(1);
    const firstStream = mockStartPipe.mock.results[0]!.value as Promise<{ stream: { destroy: ReturnType<typeof vi.fn> } }>;
    const { stream: firstStreamHandle } = await firstStream;

    // The session was killed and recreated under the same name; tmux
    // reallocates the exact same "%0" (the reported real bug), but
    // session_created moves forward.
    mockGetPaneIdentity.mockResolvedValue({ paneId: '%0', sessionCreated: '2000' });

    // Second subscribe: simulates the resubscribe that follows a daemon or
    // browser reconnect, while the OLD (now-dead) pipe is still registered.
    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();

    // The stale pipe must be torn down (never left silently forwarding
    // nothing) and a fresh one started for the new session.
    expect(firstStreamHandle.destroy).toHaveBeenCalled();
    expect(mockStartPipe).toHaveBeenCalledTimes(2);
  });

  it('does NOT restart the pipe across a resubscribe when neither the paneId nor session_created changed', async () => {
    const session = 'deck_stable_w1';
    mockGetSession.mockReturnValue(undefined);
    mockPaneExists.mockResolvedValue(true);
    mockGetPaneId.mockResolvedValue('%0');
    mockGetPaneIdentity.mockResolvedValue({ paneId: '%0', sessionCreated: '1000' });

    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();
    expect(mockStartPipe).toHaveBeenCalledTimes(1);

    // Same session, same pane: an ordinary re-subscribe (e.g. a second
    // browser tab) must reuse the live pipe, not restart it.
    streamer.subscribe({ sessionName: session, send: vi.fn() });
    await flush();

    expect(mockStartPipe).toHaveBeenCalledTimes(1);
  });
});
