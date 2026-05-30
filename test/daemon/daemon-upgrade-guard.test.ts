import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveP2pRunsBlockingDaemonUpgrade,
  getActiveSessionsBlockingDaemonUpgrade,
  getActiveTransportSessionsBlockingDaemonUpgrade,
  getTransportSessionUpgradeBlockReason,
} from '../../src/daemon/command-handler.js';
import * as sessionManager from '../../src/agent/session-manager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getActiveP2pRunsBlockingDaemonUpgrade', () => {
  it('returns active runs that should block daemon upgrades', () => {
    const blocked = getActiveP2pRunsBlockingDaemonUpgrade([
      { id: 'run_running', status: 'running' },
      { id: 'run_dispatched', status: 'dispatched' },
      { id: 'run_awaiting', status: 'awaiting_next_hop' },
      { id: 'run_cancelling', status: 'cancelling' },
      { id: 'run_completed', status: 'completed' },
      { id: 'run_cancelled', status: 'cancelled' },
    ] as any);

    // Regression-lock: every non-terminal P2P run must block daemon upgrades.
    // `running`, `dispatched`, `awaiting_next_hop`, `cancelling` are all in
    // flight from the user's perspective — restarting the daemon mid-run
    // discards their state and breaks reproducibility.
    expect(blocked.map((run) => run.id)).toEqual([
      'run_running',
      'run_dispatched',
      'run_awaiting',
      'run_cancelling',
    ]);
  });

  it('returns an empty list when all runs are terminal', () => {
    const blocked = getActiveP2pRunsBlockingDaemonUpgrade([
      { id: 'run_completed', status: 'completed' },
      { id: 'run_failed', status: 'failed' },
      { id: 'run_cancelled', status: 'cancelled' },
      { id: 'run_timed_out', status: 'timed_out' },
    ] as any);

    expect(blocked).toEqual([]);
  });
});

// ── Transport-only helper (legacy / backward-compat) ──────────────────────────
//
// Pre-existing tests pinning transport-runtime block behaviour are retained;
// the new combined helper extends — does NOT replace — these guarantees.

describe('getActiveTransportSessionsBlockingDaemonUpgrade (backward-compat wrapper)', () => {
  it('returns transport sessions that still have active turns', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') {
        return {
          getStatus: () => 'thinking',
          sending: true,
          pendingCount: 1,
        } as any;
      }
      if (name === 'deck_proj_idle') {
        return {
          getStatus: () => 'idle',
          sending: false,
          pendingCount: 0,
        } as any;
      }
      return undefined;
    });

    const blocked = getActiveTransportSessionsBlockingDaemonUpgrade([
      { name: 'deck_proj_brain', runtimeType: 'transport', state: 'running' },
      { name: 'deck_proj_idle', runtimeType: 'transport', state: 'idle' },
      // The legacy wrapper, by name, restricts itself to transport-runtime
      // sessions. The combined helper (covered below) is what actually
      // blocks process agents — this test only locks the wrapper's scope.
      { name: 'deck_proj_worker', runtimeType: 'process', state: 'running' },
    ] as any);

    expect(blocked.map((session) => session.name)).toEqual(['deck_proj_brain']);
  });

  // Regression: when a transport runtime hits a sticky 'error' state (e.g.
  // codex-sdk refresh-token failure, qwen compression timeout) the runtime
  // never transitions back to 'idle' on its own. Pre-fix we treated every
  // non-'idle' status as an active turn and forever-blocked daemon
  // upgrades — even though session.state was reported as 'idle' to the UI
  // and the user had no way of knowing why upgrades silently stalled. The
  // fix narrows the in-progress set to {'thinking','streaming'}; 'error'
  // must NOT block the upgrade restart that may itself clear the stuck state.
  it("does NOT block on a stuck runtime in 'error' status (no pending, not sending)", () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation((name: string) => {
      if (name === 'deck_stuck_error') {
        return {
          getStatus: () => 'error',
          sending: false,
          pendingCount: 0,
        } as any;
      }
      return undefined;
    });

    const blocked = getActiveTransportSessionsBlockingDaemonUpgrade([
      { name: 'deck_stuck_error', runtimeType: 'transport', state: 'idle' },
    ] as any);

    expect(blocked).toEqual([]);
  });

  it("still blocks on 'streaming' status", () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation(() => ({
      getStatus: () => 'streaming',
      sending: false,
      pendingCount: 0,
    }) as any);

    const blocked = getActiveTransportSessionsBlockingDaemonUpgrade([
      { name: 'deck_streaming', runtimeType: 'transport', state: 'running' },
    ] as any);

    expect(blocked.map((s) => s.name)).toEqual(['deck_streaming']);
  });

  it('still blocks when sending=true even if status is idle', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation(() => ({
      getStatus: () => 'idle',
      sending: true,
      pendingCount: 0,
    }) as any);

    const blocked = getActiveTransportSessionsBlockingDaemonUpgrade([
      { name: 'deck_dispatching', runtimeType: 'transport', state: 'idle' },
    ] as any);

    expect(blocked.map((s) => s.name)).toEqual(['deck_dispatching']);
  });

  it('still blocks when pendingCount > 0 even if status is idle', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation(() => ({
      getStatus: () => 'idle',
      sending: false,
      pendingCount: 3,
    }) as any);

    const blocked = getActiveTransportSessionsBlockingDaemonUpgrade([
      { name: 'deck_queued', runtimeType: 'transport', state: 'idle' },
    ] as any);

    expect(blocked.map((s) => s.name)).toEqual(['deck_queued']);
  });
});

// ── Combined helper (covers process AND transport agents) ─────────────────────
//
// Regression: the production daemon upgrade was killing process-agent CLIs
// (claude-code, codex, opencode, gemini in tmux) mid-turn because the only
// active-turn check looked at transport-runtime sessions. The combined
// helper below is the new gate; these tests lock the contract.

describe('getActiveSessionsBlockingDaemonUpgrade — process + transport coverage', () => {
  it('blocks process-agent sessions whose state is "running"', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockReturnValue(undefined);

    const blocked = getActiveSessionsBlockingDaemonUpgrade([
      { name: 'deck_repo_brain', runtimeType: 'process', state: 'running', agentType: 'claude-code' },
      { name: 'deck_repo_idle', runtimeType: 'process', state: 'idle', agentType: 'claude-code' },
    ] as any);

    expect(blocked.map((reason) => reason.name)).toEqual(['deck_repo_brain']);
    expect(blocked[0]).toMatchObject({
      runtimeType: 'process',
      sessionState: 'running',
      transport: null,
    });
  });

  it('does NOT block process-agent sessions in idle/error/stopped state', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockReturnValue(undefined);

    const blocked = getActiveSessionsBlockingDaemonUpgrade([
      { name: 'deck_idle', runtimeType: 'process', state: 'idle' },
      { name: 'deck_error', runtimeType: 'process', state: 'error' },
      { name: 'deck_stopped', runtimeType: 'process', state: 'stopped' },
    ] as any);

    expect(blocked).toEqual([]);
  });

  it('blocks process AND transport in the same call, with full reason payload', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation((name: string) => {
      if (name === 'deck_sdk') {
        return {
          getStatus: () => 'streaming',
          sending: false,
          pendingCount: 0,
        } as any;
      }
      return undefined;
    });

    const blocked = getActiveSessionsBlockingDaemonUpgrade([
      { name: 'deck_sdk', runtimeType: 'transport', state: 'running' },
      { name: 'deck_cli', runtimeType: 'process', state: 'running', agentType: 'codex' },
      { name: 'deck_idle', runtimeType: 'process', state: 'idle', agentType: 'opencode' },
    ] as any);

    expect(blocked).toHaveLength(2);
    expect(blocked.find((r) => r.name === 'deck_sdk')).toMatchObject({
      runtimeType: 'transport',
      sessionState: 'running',
      transport: { blockReason: 'status_streaming' },
    });
    expect(blocked.find((r) => r.name === 'deck_cli')).toMatchObject({
      runtimeType: 'process',
      sessionState: 'running',
      transport: null,
    });
  });

  it('returns an empty list when no session has an active turn', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation(() => ({
      getStatus: () => 'idle',
      sending: false,
      pendingCount: 0,
    }) as any);

    const blocked = getActiveSessionsBlockingDaemonUpgrade([
      { name: 'deck_t', runtimeType: 'transport', state: 'idle' },
      { name: 'deck_p', runtimeType: 'process', state: 'idle' },
    ] as any);

    expect(blocked).toEqual([]);
  });

  /*
   * R3 v2 PR-κ — User-reported regression: dispatching a turn that lands
   * in `'queued'` state and then issuing `daemon.upgrade` would silently
   * kill the queued turn because the gate only counted `'running'` as
   * busy. The web client's `isRunningSessionState` already counts
   * `'queued'` as busy; the gate now matches.
   */
  it('blocks process-agent sessions whose state is "queued" (R3 v2 PR-κ)', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockReturnValue(undefined);

    const blocked = getActiveSessionsBlockingDaemonUpgrade([
      { name: 'deck_repo_brain', runtimeType: 'process', state: 'queued', agentType: 'claude-code' },
      { name: 'deck_repo_running', runtimeType: 'process', state: 'running', agentType: 'codex' },
      { name: 'deck_repo_idle', runtimeType: 'process', state: 'idle', agentType: 'gemini' },
    ] as any);

    // BOTH 'running' and 'queued' must show up — only 'idle' is allowed through.
    expect(blocked.map((r) => r.name).sort()).toEqual(['deck_repo_brain', 'deck_repo_running']);
    const queuedReason = blocked.find((r) => r.name === 'deck_repo_brain');
    expect(queuedReason).toMatchObject({
      runtimeType: 'process',
      sessionState: 'queued',
      transport: null,
    });
  });
});

// ── Phantom-turn staleness guard ──────────────────────────────────────────────
//
// Production incident: a codex-sdk sub-session got wedged in `status:'streaming'
// sending:true` (lost `onComplete`) while `session.state` read `idle`. Every
// auto-upgrade attempt for 8+ hours was blocked by that ONE phantom session, so
// the daemon stayed pinned on a stale version. The fix: a transport turn that
// reports in-progress but has produced no provider activity past a threshold is
// treated as a phantom and does NOT block the upgrade. A live turn refreshes
// `lastActivityAt` on every delta, so a real generation never trips this.

describe('getTransportSessionUpgradeBlockReason — phantom-turn staleness', () => {
  const NOW = 1_000_000_000;
  const STALE_MS = 60_000;

  function mockRuntime(over: { status: string; sending?: boolean; pendingCount?: number; lastActivityAt?: number }) {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockReturnValue({
      getStatus: () => over.status,
      sending: over.sending ?? false,
      pendingCount: over.pendingCount ?? 0,
      ...(over.lastActivityAt !== undefined ? { lastActivityAt: over.lastActivityAt } : {}),
    } as any);
  }

  it('does NOT block a "streaming" turn whose activity is older than the stale threshold', () => {
    mockRuntime({ status: 'streaming', sending: true, lastActivityAt: NOW - STALE_MS - 1 });
    expect(
      getTransportSessionUpgradeBlockReason('deck_phantom', { now: NOW, staleTurnMs: STALE_MS }),
    ).toBeNull();
  });

  it('does NOT block exactly AT the stale threshold (age >= staleMs)', () => {
    mockRuntime({ status: 'streaming', lastActivityAt: NOW - STALE_MS });
    expect(
      getTransportSessionUpgradeBlockReason('deck_edge', { now: NOW, staleTurnMs: STALE_MS }),
    ).toBeNull();
  });

  it('STILL blocks a "streaming" turn with recent activity (live generation)', () => {
    mockRuntime({ status: 'streaming', lastActivityAt: NOW - STALE_MS + 1 });
    expect(
      getTransportSessionUpgradeBlockReason('deck_live', { now: NOW, staleTurnMs: STALE_MS }),
    ).toMatchObject({ blockReason: 'status_streaming' });
  });

  it('treats a stale "sending" (status idle) turn as phantom too', () => {
    mockRuntime({ status: 'idle', sending: true, lastActivityAt: NOW - STALE_MS - 1 });
    expect(
      getTransportSessionUpgradeBlockReason('deck_stale_send', { now: NOW, staleTurnMs: STALE_MS }),
    ).toBeNull();
  });

  it('treats stale pending (status idle) as phantom too', () => {
    mockRuntime({ status: 'idle', pendingCount: 3, lastActivityAt: NOW - STALE_MS - 1 });
    expect(
      getTransportSessionUpgradeBlockReason('deck_stale_pending', { now: NOW, staleTurnMs: STALE_MS }),
    ).toBeNull();
  });

  it('falls back to always-block when the runtime exposes no lastActivityAt (legacy/mock)', () => {
    mockRuntime({ status: 'streaming' }); // no lastActivityAt
    expect(
      getTransportSessionUpgradeBlockReason('deck_legacy', { now: NOW, staleTurnMs: STALE_MS }),
    ).toMatchObject({ blockReason: 'status_streaming' });
  });

  it('via the combined helper: a stale phantom session is dropped from the blocking set', () => {
    vi.spyOn(sessionManager, 'getTransportRuntime').mockImplementation((name: string) => {
      if (name === 'deck_phantom') {
        return { getStatus: () => 'streaming', sending: true, pendingCount: 0, lastActivityAt: NOW - STALE_MS - 1 } as any;
      }
      if (name === 'deck_live') {
        return { getStatus: () => 'streaming', sending: false, pendingCount: 0, lastActivityAt: NOW - 1 } as any;
      }
      return undefined;
    });

    const blocked = getActiveSessionsBlockingDaemonUpgrade(
      [
        { name: 'deck_phantom', runtimeType: 'transport', state: 'idle' },
        { name: 'deck_live', runtimeType: 'transport', state: 'running' },
      ] as any,
      { now: NOW, staleTurnMs: STALE_MS },
    );

    expect(blocked.map((r) => r.name)).toEqual(['deck_live']);
  });
});
