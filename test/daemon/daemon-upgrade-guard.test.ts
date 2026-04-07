import { describe, expect, it } from 'vitest';

import { getActiveP2pRunsBlockingDaemonUpgrade } from '../../src/daemon/command-handler.js';

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
