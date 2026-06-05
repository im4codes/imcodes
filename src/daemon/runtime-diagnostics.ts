import { collectTransportQueueDiagnostics } from '../agent/session-manager.js';
import { listP2pRuns } from './p2p-orchestrator.js';
import { listP2pDiscussionWriteQueueSnapshots } from './p2p-discussion-writer.js';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import {
  setDaemonRuntimeDiagnosticsProvider,
  type DaemonRuntimeDiagnosticsSnapshot,
} from '../util/daemon-status.js';

export function installDaemonRuntimeDiagnosticsProvider(): void {
  setDaemonRuntimeDiagnosticsProvider(() => collectDaemonRuntimeDiagnostics());
}

export function collectDaemonRuntimeDiagnostics(nowMs: number = Date.now()): DaemonRuntimeDiagnosticsSnapshot {
  const writeQueues = listP2pDiscussionWriteQueueSnapshots();
  const runs = listP2pRuns();
  const activeRuns = runs.filter((run) => !P2P_TERMINAL_RUN_STATUSES.has(run.status));
  return {
    capturedAt: nowMs,
    transportQueues: collectTransportQueueDiagnostics(nowMs),
    p2p: {
      activeCount: activeRuns.length,
      discussionWriteQueueCount: writeQueues.length,
      discussionWritePendingBytes: writeQueues.reduce((sum, queue) => sum + queue.pendingBytes, 0),
      runs: runs.map((run) => ({
        id: run.id,
        discussionId: run.discussionId,
        status: run.status,
        runPhase: run.runPhase,
        activePhase: run.activePhase,
        currentRound: run.currentRound,
        totalRounds: run.rounds,
        currentTargetSession: run.currentTargetSession,
        currentTargetLabel: run.currentTargetSession,
        hopStartedAt: run.hopStartedAt,
        hopElapsedMs: run.hopStartedAt ? Math.max(0, nowMs - run.hopStartedAt) : null,
        executionAttempt: run.executionAttempt ?? null,
        executionCycleCurrent: run.executionCycleCurrent ?? null,
        executionCycleTotal: run.executionCycleTotal ?? null,
        executionMarkerPath: run.executionMarkerPath ?? null,
        error: run.error,
      })),
    },
  };
}
