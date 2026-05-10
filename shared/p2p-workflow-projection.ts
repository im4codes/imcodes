import { P2P_WORKFLOW_PROJECTION_VERSION } from './p2p-workflow-constants.js';
import type { P2pPersistedWorkflowSnapshot, P2pWorkflowStatusProjection } from './p2p-workflow-types.js';

export function buildPersistedSnapshotFromProjection(
  projection: P2pWorkflowStatusProjection,
): P2pPersistedWorkflowSnapshot {
  return {
    projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
    runId: projection.runId,
    workflowId: projection.workflowId,
    status: projection.status,
    ...(projection.currentNodeId ? { currentNodeId: projection.currentNodeId } : {}),
    completedNodeIds: [...projection.completedNodeIds],
    diagnostics: projection.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    updatedAt: projection.updatedAt,
  };
}
