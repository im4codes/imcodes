import type {
  ContextNamespace,
  ContextReplicationState,
  ProcessedContextProjection,
  ProcessedContextReplicationBody,
} from '../../shared/context-types.js';
import {
  getReplicationState,
  listProcessedProjections,
  listReplicationStates,
  setReplicationState,
} from '../store/context-store.js';

export interface ProcessedContextReplicationCredentials {
  workerUrl: string;
  serverId: string;
  token: string;
}

export interface ProcessedContextReplicationResult {
  replicatedNamespaces: number;
  replicatedProjections: number;
  failures: Array<{ namespace: ContextNamespace; error: string }>;
}

export async function replicatePendingProcessedContext(
  credentials: ProcessedContextReplicationCredentials,
  namespaces?: ContextNamespace[],
): Promise<ProcessedContextReplicationResult> {
  const states = resolveStates(namespaces);
  let replicatedNamespaces = 0;
  let replicatedProjections = 0;
  const failures: Array<{ namespace: ContextNamespace; error: string }> = [];

  for (const state of states) {
    if (state.pendingProjectionIds.length === 0) continue;
    const projections = selectPendingProjections(state.namespace, state.pendingProjectionIds);
    if (projections.length === 0) {
      setReplicationState(state.namespace, {
        pendingProjectionIds: state.pendingProjectionIds,
        lastReplicatedAt: state.lastReplicatedAt,
        lastError: 'pending_projection_missing_locally',
      });
      failures.push({ namespace: state.namespace, error: 'pending_projection_missing_locally' });
      continue;
    }

    try {
      await postProcessedContext(credentials, {
        namespace: state.namespace,
        projections,
      });
      replicatedNamespaces += 1;
      replicatedProjections += projections.length;
      setReplicationState(state.namespace, {
        pendingProjectionIds: state.pendingProjectionIds.filter((id) => !projections.some((projection) => projection.id === id)),
        lastReplicatedAt: Date.now(),
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setReplicationState(state.namespace, {
        pendingProjectionIds: state.pendingProjectionIds,
        lastReplicatedAt: state.lastReplicatedAt,
        lastError: message,
      });
      failures.push({ namespace: state.namespace, error: message });
    }
  }

  return {
    replicatedNamespaces,
    replicatedProjections,
    failures,
  };
}

function resolveStates(namespaces?: ContextNamespace[]): ContextReplicationState[] {
  if (!namespaces || namespaces.length === 0) {
    return listReplicationStates().filter((state) => state.pendingProjectionIds.length > 0);
  }
  return namespaces
    .map((namespace) => getReplicationState(namespace))
    .filter((state): state is ContextReplicationState => !!state && state.pendingProjectionIds.length > 0);
}

function selectPendingProjections(namespace: ContextNamespace, pendingIds: string[]): ProcessedContextProjection[] {
  const wanted = new Set(pendingIds);
  return listProcessedProjections(namespace).filter((projection) => wanted.has(projection.id));
}

async function postProcessedContext(
  credentials: ProcessedContextReplicationCredentials,
  body: ProcessedContextReplicationBody,
): Promise<void> {
  const response = await fetch(`${credentials.workerUrl}/api/server/${credentials.serverId}/shared-context/processed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`processed_remote_replication_failed:${response.status}`);
  }
}
