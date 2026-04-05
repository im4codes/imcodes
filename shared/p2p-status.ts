/**
 * Shared P2P status and run-update contract.
 *
 * Keep the existing top-level run status field compatible for current
 * server/web consumers, and expose richer parallel-hop progress through
 * additive fields.
 */

export const P2P_RUN_STATUS_VALUES = [
  'queued',
  'dispatched',
  'running',
  'awaiting_next_hop',
  'completed',
  'timed_out',
  'failed',
  'interrupted',
  'cancelling',
  'cancelled',
] as const;

export type P2pRunStatus = (typeof P2P_RUN_STATUS_VALUES)[number];

export const P2P_HOP_STATUS_VALUES = [
  'queued',
  'dispatched',
  'running',
  'completed',
  'timed_out',
  'failed',
  'cancelled',
] as const;

export type P2pHopStatus = (typeof P2P_HOP_STATUS_VALUES)[number];

export const P2P_RUN_PHASE_VALUES = [
  'preparing',
  'round_execution',
  'summarizing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type P2pRunPhase = (typeof P2P_RUN_PHASE_VALUES)[number];

export const P2P_ACTIVE_PHASE_VALUES = [
  'queued',
  'initial',
  'hop',
  'summary',
] as const;

export type P2pActivePhase = (typeof P2P_ACTIVE_PHASE_VALUES)[number];

export const P2P_SUMMARY_PHASE_VALUES = [
  'pending',
  'running',
  'completed',
  'failed',
] as const;

export type P2pSummaryPhase = (typeof P2P_SUMMARY_PHASE_VALUES)[number];

export const P2P_PROGRESS_NODE_STATUS_VALUES = [
  'done',
  'active',
  'pending',
  'skipped',
] as const;

export type P2pProgressNodeStatus = (typeof P2P_PROGRESS_NODE_STATUS_VALUES)[number];

export const P2P_PROGRESS_NODE_PHASE_VALUES = [
  'initial',
  'hop',
  'summary',
] as const;

export type P2pProgressNodePhase = (typeof P2P_PROGRESS_NODE_PHASE_VALUES)[number];

export const P2P_TERMINAL_RUN_STATUSES = new Set<P2pRunStatus>([
  'completed',
  'timed_out',
  'failed',
  'cancelled',
]);

export const P2P_TERMINAL_HOP_STATUSES = new Set<P2pHopStatus>([
  'completed',
  'timed_out',
  'failed',
  'cancelled',
]);

export const P2P_DONE_RUN_STATUSES = new Set<P2pRunStatus>(['completed']);

export const P2P_FAILED_RUN_STATUSES = new Set<P2pRunStatus>([
  'failed',
  'timed_out',
  'cancelled',
]);

export const P2P_RUNNING_RUN_STATUSES = new Set<P2pRunStatus>([
  'running',
  'dispatched',
  'awaiting_next_hop',
]);

export interface P2pHopProgress {
  hop_index: number;
  round_index: number;
  session: string;
  mode: string;
  status: P2pHopStatus;
  started_at: number | null;
  completed_at: string | null;
  error: string | null;
  output_path?: string | null;
}

export interface P2pHopCounts {
  total: number;
  queued: number;
  dispatched: number;
  running: number;
  completed: number;
  timed_out: number;
  failed: number;
  cancelled: number;
}

export interface P2pProgressNode {
  session?: string;
  label: string;
  displayLabel?: string;
  display_label?: string;
  agentType: string;
  agent_type?: string;
  ccPreset?: string | null;
  cc_preset?: string | null;
  mode?: string;
  phase?: P2pProgressNodePhase;
  status: P2pProgressNodeStatus;
}

export interface P2pRunUpdatePayload {
  id: string;
  discussion_id: string;
  status: P2pRunStatus;
  mode_key: string;
  current_round_mode?: string;
  current_round: number;
  total_rounds: number;
  total_count?: number;
  total_hops?: number;
  completed_hops_count?: number;
  active_hop_number?: number | null;
  active_round_hop_number?: number | null;
  active_phase?: P2pActivePhase;
  hop_started_at?: number | null;
  initiator_label?: string | null;
  current_target_session?: string | null;
  current_target_label?: string | null;
  result_summary?: string | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  all_nodes?: P2pProgressNode[];
  progress_snapshot?: string | Record<string, unknown>;
  run_phase?: P2pRunPhase;
  summary_phase?: P2pSummaryPhase | null;
  hop_states?: P2pHopProgress[];
  hop_counts?: P2pHopCounts;
  completed_round_hops_count?: number;
  terminal_reason?: 'completed' | 'timed_out' | 'failed' | 'cancelled' | null;
  [key: string]: unknown;
}

/** Map top-level run status to existing UI display state. */
export function mapP2pStatusToUiState(status: string): 'done' | 'failed' | 'running' | 'setup' {
  if (P2P_DONE_RUN_STATUSES.has(status as P2pRunStatus)) return 'done';
  if (P2P_FAILED_RUN_STATUSES.has(status as P2pRunStatus)) return 'failed';
  if (P2P_RUNNING_RUN_STATUSES.has(status as P2pRunStatus)) return 'running';
  return 'setup';
}
