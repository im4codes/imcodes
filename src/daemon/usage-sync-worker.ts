import {
  USAGE_ANALYTICS_SCHEMA_VERSION,
  USAGE_INGEST_PATH_HEADER,
  USAGE_INGEST_ROUTE_SUFFIX,
  type UsageFactResult,
  type UsageIngestEnvelope,
  type UsageIngestResult,
} from '../../shared/usage-analytics.js';
import { getContextStoreClient, type ContextStoreWorkerClient } from '../store/context-store-worker-client.js';
import type {
  TurnUsageSyncRecord,
  TurnUsageSyncRequestFailureInput,
} from '../store/context-store.js';
import logger from '../util/logger.js';

export interface UsageSyncWorkerCredentials {
  workerUrl: string;
  serverId: string;
  token: string;
}

export interface UsageSyncWorkerOptions extends UsageSyncWorkerCredentials {
  intervalMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
  storeClient?: ContextStoreWorkerClient;
  credentialsProvider?: () => Promise<UsageSyncWorkerCredentials | null> | UsageSyncWorkerCredentials | null;
}

export interface UsageSyncWorker {
  start(): void;
  stop(): void;
  syncOnce(reason?: string): Promise<{ ok: boolean; uploaded: number; retryable?: boolean; reason?: string }>;
  isRunning(): boolean;
}

const DEFAULT_USAGE_SYNC_INTERVAL_MS = 60_000;
const DEFAULT_USAGE_SYNC_BATCH_SIZE = 100;

export function createUsageSyncWorker(options: UsageSyncWorkerOptions): UsageSyncWorker {
  const intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? DEFAULT_USAGE_SYNC_INTERVAL_MS));
  const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? DEFAULT_USAGE_SYNC_BATCH_SIZE)));
  const storeClient = options.storeClient ?? getContextStoreClient();
  const fetchImpl = options.fetchImpl ?? fetch;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const syncOnce = async (reason = 'manual'): Promise<{ ok: boolean; uploaded: number; retryable?: boolean; reason?: string }> => {
    if (inFlight) {
      return { ok: true, uploaded: 0 };
    }
    inFlight = true;
    let batch: TurnUsageSyncRecord[] = [];
    try {
      const credentials = await resolveCredentials(options);
      if (!credentials) {
        return { ok: false, uploaded: 0, retryable: true, reason: 'auth_failed' };
      }
      batch = await storeClient.run<TurnUsageSyncRecord[]>('selectTurnUsageSyncBatch', [{ limit: batchSize }], { timeoutMs: 30_000 });
      if (batch.length === 0) {
        return { ok: true, uploaded: 0 };
      }
      const envelope: UsageIngestEnvelope = {
        schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
        clientBatchId: `usage-sync:${Date.now()}`,
        facts: batch.map((row) => row.fact),
      };
      const response = await fetchImpl(buildIngestUrl(credentials.workerUrl, credentials.serverId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.token}`,
          [USAGE_INGEST_PATH_HEADER]: credentials.serverId,
        },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) {
        const retryable = response.status === 401
          || response.status === 403
          || response.status === 408
          || response.status === 409
          || response.status === 429
          || response.status >= 500;
        const failure = buildRequestFailure(batch, retryable, requestFailureReason(response.status));
        await storeClient.run('recordTurnUsageSyncRequestFailure', [failure], { timeoutMs: 30_000 });
        return { ok: false, uploaded: 0, retryable, reason: failure.reason };
      }
      const result = await parseUsageIngestResult(response);
      if (!result) {
        const failure = buildRequestFailure(batch, true, 'schema_invalid');
        await storeClient.run('recordTurnUsageSyncRequestFailure', [failure], { timeoutMs: 30_000 });
        return { ok: false, uploaded: 0, retryable: true, reason: failure.reason };
      }
      const results = normalizeIngestResults(result, batch);
      await storeClient.run('recordTurnUsageSyncResults', [{ results }], { timeoutMs: 30_000 });
      const diagnostics = await storeClient.run('getTurnUsageSyncDiagnostics', [], { timeoutMs: 5_000 });
      logger.info({ reason, uploaded: batch.length, diagnostics }, 'usage sync batch uploaded');
      return { ok: true, uploaded: batch.length };
    } catch (error) {
      if (batch.length > 0) {
        const failure = buildRequestFailure(batch, true, 'server_unavailable');
        await storeClient.run('recordTurnUsageSyncRequestFailure', [failure], { timeoutMs: 30_000 }).catch(() => {});
      }
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'usage sync failed');
      return { ok: false, uploaded: 0, retryable: true, reason: 'server_unavailable' };
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void syncOnce('poll');
      }, intervalMs);
      timer.unref?.();
      void syncOnce('startup');
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    syncOnce,
    isRunning(): boolean {
      return timer !== null;
    },
  };
}

async function resolveCredentials(options: UsageSyncWorkerOptions): Promise<UsageSyncWorkerCredentials | null> {
  if (options.credentialsProvider) {
    const credentials = await options.credentialsProvider();
    return credentials?.workerUrl && credentials.serverId && credentials.token ? credentials : null;
  }
  if (options.workerUrl && options.serverId && options.token) {
    return {
      workerUrl: options.workerUrl,
      serverId: options.serverId,
      token: options.token,
    };
  }
  return null;
}

function buildIngestUrl(workerUrl: string, serverId: string): string {
  const base = workerUrl.replace(/\/+$/, '');
  return `${base}/api/server/${encodeURIComponent(serverId)}/${USAGE_INGEST_ROUTE_SUFFIX}`;
}

function requestFailureReason(status: number): string {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 413) return 'body_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_unavailable';
  return 'schema_invalid';
}

function buildRequestFailure(batch: TurnUsageSyncRecord[], retryable: boolean, reason: string): TurnUsageSyncRequestFailureInput {
  const now = Date.now();
  return {
    usageFactIds: batch.map((row) => row.usageFactId),
    retryable,
    reason,
    nextAttemptAtMs: retryable ? now + 60_000 : null,
    now,
  };
}

async function parseUsageIngestResult(response: Response): Promise<UsageIngestResult | null> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return null;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const record = result as Partial<UsageIngestResult>;
  if (record.schemaVersion !== USAGE_ANALYTICS_SCHEMA_VERSION || !Array.isArray(record.results)) {
    return null;
  }
  return record as UsageIngestResult;
}

function normalizeIngestResults(result: UsageIngestResult, batch: TurnUsageSyncRecord[]): UsageFactResult[] {
  const returned = Array.isArray(result.results) ? result.results : [];
  const byId = new Map<string, UsageFactResult>();
  for (const item of returned) {
    if (
      item
      && typeof item.usageFactId === 'string'
      && (
        item.status === 'accepted'
        || item.status === 'duplicate'
        || item.status === 'conflict'
        || item.status === 'invalid'
        || item.status === 'too_old'
        || item.status === 'clock_skew_too_far'
      )
    ) {
      byId.set(item.usageFactId, {
        usageFactId: item.usageFactId,
        status: item.status,
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      });
    }
  }
  return batch.map((row) => byId.get(row.usageFactId) ?? {
    usageFactId: row.usageFactId,
    status: 'invalid',
    reason: 'missing_per_fact_result',
  });
}
