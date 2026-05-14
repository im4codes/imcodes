import { P2P_WORKFLOW_PROJECTION_VERSION } from '../../shared/p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import type { P2pWorkflowStatusProjection } from '../../shared/p2p-workflow-types.js';

/**
 * Mark an advanced workflow run stale after daemon restart.
 *
 * v1a does not durably persist private runtime state, so any advanced run
 * that survives a daemon restart cannot be safely resumed (frozen artifact
 * identity, capability snapshot vs. current policy, in-flight script process
 * state, discussion read offsets, etc. are all gone). Per spec, we mark such
 * runs `stale` rather than silently resuming dangerous work.
 *
 * Pure helper — emits the canonical projection + diagnostic so the caller
 * (server-link relay, command-handler bootstrap, persistence reads) can
 * surface a deterministic terminal state.
 */
export interface MarkAdvancedRunStaleArgs {
  runId: string;
  workflowId: string;
  /** Optional last-known node id to preserve audit context. */
  currentNodeId?: string;
  /** Already-completed nodes from the prior run, if known. */
  completedNodeIds?: readonly string[];
  /** Optional human reason; default summarizes restart staleness. */
  reasonSummary?: string;
  /** ISO timestamp; defaults to "now". */
  updatedAt?: string;
  /** Pre-existing diagnostics to preserve (will be deduped against the new stale diagnostic). */
  existingDiagnostics?: P2pWorkflowStatusProjection['diagnostics'];
  /** Optional capability snapshot to retain in the projection for audit. */
  capabilitySnapshot?: P2pWorkflowStatusProjection['capabilitySnapshot'];
}

export function markAdvancedRunStaleAfterRestart(
  args: MarkAdvancedRunStaleArgs,
): P2pWorkflowStatusProjection {
  const diagnostic = makeP2pWorkflowDiagnostic('workflow_stale_after_restart', 'bind', {
    runId: args.runId,
    summary: args.reasonSummary ?? 'Advanced workflow could not be safely resumed after daemon restart',
  });
  const existing = args.existingDiagnostics ?? [];
  const alreadyHasStale = existing.some(
    (d) => d.code === 'workflow_stale_after_restart' && d.runId === args.runId,
  );
  const diagnostics = alreadyHasStale
    ? existing.map((d) => ({ ...d }))
    : [...existing.map((d) => ({ ...d })), diagnostic];

  const projection: P2pWorkflowStatusProjection = {
    projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
    runId: args.runId,
    workflowId: args.workflowId,
    status: 'stale',
    completedNodeIds: args.completedNodeIds ? [...args.completedNodeIds] : [],
    diagnostics,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
    ...(args.currentNodeId !== undefined ? { currentNodeId: args.currentNodeId } : {}),
    ...(args.capabilitySnapshot !== undefined ? { capabilitySnapshot: args.capabilitySnapshot } : {}),
  };
  return projection;
}
