import { createHash } from 'node:crypto';
import type {
  ContextNamespace,
  MemoryRecallSourceKind,
  TransportMemoryRecallItem,
} from '../../shared/context-types.js';
import { normalizeSummaryForFingerprint } from '../../shared/memory-fingerprint.js';
import { fetchBackendStartupMemoryItems } from './backend-startup-memory.js';
import type { MemorySearchResultItem } from './memory-search.js';
import { selectStartupMemoryForBootstrap } from './memory-recall-client.js';
import { getSharedContextRuntimeCredentials } from './shared-context-runtime.js';

export const SUMMARY_SYNC_RECENT_LIMIT = 30;
// The control-plane search API intentionally returns only this many summary
// characters. Fingerprint the same canonical prefix locally so a full local
// projection and its remote preview share one delivery identity.
const SUMMARY_SYNC_FINGERPRINT_PREFIX_LENGTH = 240;

export interface SummarySyncCandidate {
  fingerprint: string;
  item: TransportMemoryRecallItem;
}

export interface CollectRecentSummarySyncOptions {
  limit?: number;
  selectLocal?: (
    namespace: ContextNamespace,
    limit: number,
  ) => Promise<MemorySearchResultItem[]>;
  fetchRemote?: (
    namespace: ContextNamespace,
    limit: number,
  ) => Promise<MemorySearchResultItem[]>;
}

export function fingerprintRecentSummary(summary: string): string {
  const normalized = normalizeSummaryForFingerprint(
    summary.slice(0, SUMMARY_SYNC_FINGERPRINT_PREFIX_LENGTH),
  );
  return createHash('sha256')
    .update(`recent_summary\u0000${normalized}`)
    .digest('hex');
}

function toTransportItem(
  item: MemorySearchResultItem,
  sourceKind: Exclude<MemoryRecallSourceKind, 'mixed_processed'>,
): TransportMemoryRecallItem {
  return {
    id: item.id,
    type: 'processed',
    projectId: item.projectId,
    scope: item.scope,
    ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...(item.userId ? { userId: item.userId } : {}),
    summary: item.summary,
    projectionClass: 'recent_summary',
    ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
    sourceKind,
  };
}

async function selectLocalRecent(
  namespace: ContextNamespace,
  limit: number,
): Promise<MemorySearchResultItem[]> {
  return selectStartupMemoryForBootstrap(namespace, {
    durableLimit: 0,
    recentLimit: limit,
    totalLimit: limit,
  });
}

async function fetchRemoteRecent(
  namespace: ContextNamespace,
  limit: number,
): Promise<MemorySearchResultItem[]> {
  const credentials = getSharedContextRuntimeCredentials();
  if (!credentials) return [];
  return fetchBackendStartupMemoryItems(credentials, namespace, limit);
}

/**
 * Collect the newest project summaries independently from semantic recall.
 * Local and control-plane reads run together so this adds at most one bounded
 * front-of-turn wait, not two serial waits. Content fingerprints collapse the
 * same summary even when old/new writers assigned different projection IDs.
 */
export async function collectRecentSummarySyncCandidates(
  namespace: ContextNamespace | undefined,
  options: CollectRecentSummarySyncOptions = {},
): Promise<SummarySyncCandidate[]> {
  if (!namespace?.projectId?.trim()) return [];
  const limit = Math.max(0, Math.floor(options.limit ?? SUMMARY_SYNC_RECENT_LIMIT));
  if (limit === 0) return [];
  const selectLocal = options.selectLocal ?? selectLocalRecent;
  const fetchRemote = options.fetchRemote ?? fetchRemoteRecent;
  const [local, remote] = await Promise.all([
    selectLocal(namespace, limit).catch(() => []),
    // The server endpoint returns one mixed durable/recent page (max 50), so
    // request the full page before filtering to recent summaries. Otherwise a
    // durable-heavy project could hide a newly-created recent summary.
    fetchRemote(namespace, Math.max(limit, 50)).catch(() => []),
  ]);
  const rows = [
    ...remote
      .filter((item) => item.type === 'processed' && item.projectionClass === 'recent_summary')
      .map((item) => ({ item, sourceKind: 'remote_processed' as const })),
    ...local
      .filter((item) => item.type === 'processed' && item.projectionClass === 'recent_summary')
      .map((item) => ({ item, sourceKind: 'local_processed' as const })),
  ].sort((a, b) => (
    (b.item.updatedAt ?? b.item.createdAt ?? 0)
    - (a.item.updatedAt ?? a.item.createdAt ?? 0)
  ));

  const seenIds = new Set<string>();
  const seen = new Set<string>();
  const result: SummarySyncCandidate[] = [];
  for (const row of rows) {
    if (seenIds.has(row.item.id)) continue;
    seenIds.add(row.item.id);
    const fingerprint = fingerprintRecentSummary(row.item.summary);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push({
      fingerprint,
      item: toTransportItem(row.item, row.sourceKind),
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function recentSummaryFingerprintsFromItems(
  items: readonly Pick<TransportMemoryRecallItem, 'projectionClass' | 'summary'>[],
): string[] {
  return items
    .filter((item) => item.projectionClass === 'recent_summary')
    .map((item) => fingerprintRecentSummary(item.summary));
}

export function resolveSummarySyncSourceKind(
  items: readonly Pick<TransportMemoryRecallItem, 'sourceKind'>[],
): MemoryRecallSourceKind {
  const hasRemote = items.some((item) => item.sourceKind === 'remote_processed');
  const hasLocal = items.some((item) => item.sourceKind !== 'remote_processed');
  if (hasRemote && hasLocal) return 'mixed_processed';
  return hasRemote ? 'remote_processed' : 'local_processed';
}
