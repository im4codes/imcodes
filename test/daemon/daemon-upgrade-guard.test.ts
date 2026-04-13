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
});
