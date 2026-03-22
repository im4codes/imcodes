/**
 * P2P run status constants — shared between daemon and frontend.
 * Single source of truth for status → UI state mapping.
 */

export type P2pRunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'awaiting_next_hop'
  | 'completed'
  | 'timed_out'
  | 'failed'
  | 'interrupted'
  | 'cancelling'
  | 'cancelled';

/** Statuses that mean the run is finished (no more updates expected). */
export const P2P_TERMINAL_STATUSES = new Set<P2pRunStatus>([
  'completed', 'failed', 'timed_out', 'cancelled',
]);

/** Statuses that map to UI "done" state. */
export const P2P_DONE_STATUSES = new Set<P2pRunStatus>(['completed']);

/** Statuses that map to UI "failed" state. */
export const P2P_FAILED_STATUSES = new Set<P2pRunStatus>([
  'failed', 'timed_out', 'cancelled',
]);

/** Statuses that map to UI "running" state (active, doing work). */
export const P2P_RUNNING_STATUSES = new Set<P2pRunStatus>([
  'running', 'awaiting_next_hop', 'dispatched',
]);

/** Map P2P orchestrator status to UI display state. */
export function mapP2pStatusToUiState(status: string): 'done' | 'failed' | 'running' | 'setup' {
  if (P2P_DONE_STATUSES.has(status as P2pRunStatus)) return 'done';
  if (P2P_FAILED_STATUSES.has(status as P2pRunStatus)) return 'failed';
  if (P2P_RUNNING_STATUSES.has(status as P2pRunStatus)) return 'running';
  return 'setup';
}
