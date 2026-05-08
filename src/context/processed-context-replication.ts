import type {
  ContextNamespace,
  ContextReplicationState,
  ProcessedContextProjection,
  ProcessedContextReplicationBody,
  ReplicableProcessedContextClass,
} from '../../shared/context-types.js';
import {
  getReplicationState,
  listProcessedProjections,
  listReplicationStates,
  setReplicationState,
  listAllProcessedProjectionsByNamespace,
  parseNamespaceKey,
} from '../store/context-store.js';
import { getContextModelConfig } from './context-model-config.js';
import logger from '../util/logger.js';

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

type ReplicableProcessedProjection = Omit<ProcessedContextProjection, 'class'> & { class: ReplicableProcessedContextClass };

export async function replicatePendingProcessedContext(
  credentials: ProcessedContextReplicationCredentials,
  namespaces?: ContextNamespace[],
): Promise<ProcessedContextReplicationResult> {
  const config = getContextModelConfig();
  const personalSyncEnabled = config.enablePersonalMemorySync === true;
  const states = resolveStates(namespaces);
  if (states.length > 0) {
    logger.info({ personalSyncEnabled, stateCount: states.length }, 'Replication poller: found pending states');
  }
  let replicatedNamespaces = 0;
  let replicatedProjections = 0;
  const failures: Array<{ namespace: ContextNamespace; error: string }> = [];

  for (const state of states) {
    if (state.pendingProjectionIds.length === 0) continue;
    // Personal namespaces skip replication unless cloud sync is enabled
    if (state.namespace.scope === 'personal' && !personalSyncEnabled) continue;
    const projections = selectPendingProjections(state.namespace, state.pendingProjectionIds);
    // Cloud only stores processed projections — filter out any raw/staged content
    const processedProjections = projections.filter(isReplicableProjection);
    if (processedProjections.length === 0 && projections.length > 0) {
      // All pending projections were non-processed (shouldn't happen, but guard)
      continue;
    }
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
        projections: processedProjections,
      });
      replicatedNamespaces += 1;
      replicatedProjections += processedProjections.length;
      setReplicationState(state.namespace, {
        pendingProjectionIds: state.pendingProjectionIds.filter((id) => !processedProjections.some((projection) => projection.id === id)),
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

/**
 * Re-queue ALL local processed projections for replication, ignoring
 * what was previously marked as sent. Use when the server-side data is
 * suspected to be missing despite the daemon believing it was replicated.
 */
export function requeueAllForReplication(): number {
  const allProjections = listAllProcessedProjectionsByNamespace();
  let requeued = 0;
  for (const [namespaceKey, ids] of allProjections) {
    if (ids.length === 0) continue;
    const existing = getReplicationState(parseNamespaceKey(namespaceKey));
    setReplicationState(parseNamespaceKey(namespaceKey), {
      pendingProjectionIds: ids,
      lastReplicatedAt: existing?.lastReplicatedAt,
      lastError: undefined,
    });
    requeued += ids.length;
  }
  logger.info({ requeued }, 'Re-queued all projections for replication');
  return requeued;
}

function resolveStates(namespaces?: ContextNamespace[]): ContextReplicationState[] {
  const allowPersonalSync = getContextModelConfig().enablePersonalMemorySync === true;
  if (!namespaces || namespaces.length === 0) {
    return listReplicationStates().filter((state) => (
      state.pendingProjectionIds.length > 0
      && (allowPersonalSync || state.namespace.scope !== 'personal')
    ));
  }
  return namespaces
    .map((namespace) => getReplicationState(namespace))
    .filter((state): state is ContextReplicationState => (
      !!state
      && state.pendingProjectionIds.length > 0
      && (allowPersonalSync || state.namespace.scope !== 'personal')
    ));
}

function selectPendingProjections(namespace: ContextNamespace, pendingIds: string[]): ProcessedContextProjection[] {
  const wanted = new Set(pendingIds);
  return listProcessedProjections(namespace)
    .filter((projection) => wanted.has(projection.id))
    .map((projection) => ({
      ...projection,
      // Legacy rows created before post-1.1 origin metadata are backfilled at
      // the replication boundary; new materialization/write paths set origin explicitly.
      origin: projection.origin ?? 'chat_compacted',
    }));
}

function isReplicableProjection(projection: ProcessedContextProjection): projection is ReplicableProcessedProjection {
  return projection.class === 'recent_summary' || projection.class === 'durable_memory_candidate';
}

interface ReplicationAck {
  ok: boolean;
  projectionCount?: number;
  replicatedAt?: number;
  error?: string;
}

async function postProcessedContext(
  credentials: ProcessedContextReplicationCredentials,
  body: ProcessedContextReplicationBody,
): Promise<ReplicationAck> {
  const sentCount = body.projections.length;
  const response = await fetch(`${credentials.workerUrl}/api/server/${credentials.serverId}/shared-context/processed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`processed_remote_replication_failed:${response.status}:${text}`);
  }
  const ack = await response.json().catch(() => ({})) as ReplicationAck;
  if (typeof ack.projectionCount === 'number' && ack.projectionCount !== sentCount) {
    logger.warn({ sentCount, ackCount: ack.projectionCount, scope: body.namespace.scope, projectId: body.namespace.projectId },
      'Replication ACK count mismatch — server accepted fewer projections than sent');
  }
  logger.info({ scope: body.namespace.scope, projectId: body.namespace.projectId, sentCount, ackCount: ack.projectionCount ?? 'unknown' },
    'Processed context replicated');
  return ack;
}
