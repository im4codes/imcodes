import { afterEach, describe, expect, it, vi } from 'vitest';

import { getActiveP2pRunsBlockingDaemonUpgrade, getActiveTransportSessionsBlockingDaemonUpgrade } from '../../src/daemon/command-handler.js';
import * as sessionManager from '../../src/agent/session-manager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getActiveP2pRunsBlockingDaemonUpgrade', () => {
  it('returns active runs that should block daemon upgrades', () => {
    const blocked = getActiveP2pRunsBlockingDaemonUpgrade([
      { id: 'run_running', status: 'running' },
      { id: 'run_dispatched', status: 'dispatched' },
      { id: 'run_completed', status: 'completed' },
      { id: 'run_cancelled', status: 'cancelled' },
    ] as any);

    expect(blocked.map((run) => run.id)).toEqual(['run_running', 'run_dispatched']);
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

describe('getActiveTransportSessionsBlockingDaemonUpgrade', () => {
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
      { name: 'deck_proj_brain', runtimeType: 'transport' },
      { name: 'deck_proj_idle', runtimeType: 'transport' },
      { name: 'deck_proj_worker', runtimeType: 'process' },
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
      { name: 'deck_stuck_error', runtimeType: 'transport' },
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
      { name: 'deck_streaming', runtimeType: 'transport' },
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
      { name: 'deck_dispatching', runtimeType: 'transport' },
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
      { name: 'deck_queued', runtimeType: 'transport' },
    ] as any);

    expect(blocked.map((s) => s.name)).toEqual(['deck_queued']);
  });
});
