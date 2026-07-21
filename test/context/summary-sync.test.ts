import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  collectRecentSummarySyncCandidates,
  fingerprintRecentSummary,
} from '../../src/context/summary-sync.js';
import { fetchBackendStartupMemoryItems } from '../../src/context/backend-startup-memory.js';
import {
  clearSummarySyncHistory,
  commitSummarySyncReservation,
  getSummarySyncFingerprints,
  reserveUnsyncedSummaryFingerprints,
  resetAllSummarySyncHistories,
  rollbackSummarySyncReservation,
} from '../../src/context/summary-sync-history.js';
import { getSession, removeSession, upsertSession } from '../../src/store/session-store.js';

const NAMESPACE: ContextNamespace = { scope: 'personal', projectId: 'summary-sync-project' };
const SESSION = 'deck_summary_sync_brain';

function item(
  id: string,
  summary: string,
  updatedAt: number,
  projectionClass: 'recent_summary' | 'durable_memory_candidate' = 'recent_summary',
  sourceSessionName?: string,
) {
  return {
    type: 'processed' as const,
    id,
    projectId: NAMESPACE.projectId!,
    scope: NAMESPACE.scope,
    projectionClass,
    ...(sourceSessionName ? { sourceSessionName } : {}),
    summary,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('recent summary synchronization', () => {
  beforeEach(() => {
    resetAllSummarySyncHistories();
    try { removeSession(SESSION); } catch { /* absent */ }
  });

  it('merges local and remote recent summaries newest-first and deduplicates equal content', async () => {
    const candidates = await collectRecentSummarySyncCandidates(NAMESPACE, {
      selectLocal: async () => [
        item('local-old', 'older local work', 10),
        item('local-copy', 'same result', 20),
        item('durable', 'not a recent summary', 100, 'durable_memory_candidate'),
      ],
      fetchRemote: async () => [
        item('remote-new', 'new remote work', 30),
        item('remote-copy', 'same   result', 25),
      ],
    });

    expect(candidates.map((candidate) => candidate.item.id)).toEqual([
      'remote-new',
      'remote-copy',
      'local-old',
    ]);
    expect(candidates[0]?.item.sourceKind).toBe('remote_processed');
    expect(candidates).toHaveLength(3);
  });

  it('uses one stable delivery identity for a remote preview and the full local summary', async () => {
    const fullSummary = `${'long project summary '.repeat(20)}tail only present locally`;
    const remotePreview = fullSummary.slice(0, 240);
    const candidates = await collectRecentSummarySyncCandidates(NAMESPACE, {
      selectLocal: async () => [item('shared-projection', fullSummary, 20)],
      fetchRemote: async () => [item('shared-projection', remotePreview, 30)],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.item.id).toBe('shared-projection');
    expect(fingerprintRecentSummary(fullSummary)).toBe(fingerprintRecentSummary(remotePreview));
  });

  it('excludes the current conversation while keeping sibling summaries', async () => {
    const fetchRemote = vi.fn(async () => [
      item('remote-self', 'own remote summary', 40, 'recent_summary', SESSION),
      item('remote-sibling', 'remote sibling summary', 30, 'recent_summary', 'deck_sub_remote'),
    ]);
    const candidates = await collectRecentSummarySyncCandidates(NAMESPACE, {
      currentSessionName: SESSION,
      selectLocal: async () => [
        item('local-self', 'own local summary', 50, 'recent_summary', SESSION),
        item('local-sibling', 'local sibling summary', 20, 'recent_summary', 'deck_sub_local'),
      ],
      fetchRemote,
    });

    expect(fetchRemote).toHaveBeenCalledWith(NAMESPACE, 50, SESSION);
    expect(candidates.map((candidate) => candidate.item.id)).toEqual([
      'remote-sibling',
      'local-sibling',
    ]);
  });

  it('fails closed when a remote server does not confirm source-session exclusion', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        id: 'possibly-self',
        scope: 'personal',
        class: 'recent_summary',
        preview: 'Could belong to the current conversation',
        projectId: NAMESPACE.projectId,
        updatedAt: 20,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const rows = await fetchBackendStartupMemoryItems(
      { workerUrl: 'https://worker.example', serverId: 'srv-1', token: 'test-token' },
      NAMESPACE,
      30,
      { fetchImpl: fetchImpl as unknown as typeof fetch, excludeSourceSessionName: SESSION },
    );

    expect(rows).toEqual([]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      excludeSourceSessionName: SESSION,
    }));
  });

  it('treats summaries with the same server-visible 240-character prefix as one delivery identity', () => {
    const sharedPreview = 'x'.repeat(240);

    expect(fingerprintRecentSummary(`${sharedPreview} first private tail`)).toBe(
      fingerprintRecentSummary(`${sharedPreview} second private tail`),
    );
  });

  it('reserves once across concurrent sends, commits only on success, and rolls back failures', () => {
    const a = fingerprintRecentSummary('summary A');
    const b = fingerprintRecentSummary('summary B');
    const first = reserveUnsyncedSummaryFingerprints(SESSION, [a, b]);
    expect(first?.fingerprints).toEqual([a, b]);
    expect(reserveUnsyncedSummaryFingerprints(SESSION, [a, b])).toBeUndefined();

    rollbackSummarySyncReservation(first);
    const retry = reserveUnsyncedSummaryFingerprints(SESSION, [a, b]);
    expect(retry?.fingerprints).toEqual([a, b]);
    commitSummarySyncReservation(retry);
    expect(reserveUnsyncedSummaryFingerprints(SESSION, [a, b])).toBeUndefined();
  });

  it('persists the exact conversation ledger across restart and clears it for a fresh conversation', () => {
    upsertSession({
      name: SESSION,
      projectName: 'summary-sync-project',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'idle',
    } as any);
    const fingerprint = fingerprintRecentSummary('delivered once');
    const reservation = reserveUnsyncedSummaryFingerprints(SESSION, [fingerprint]);
    commitSummarySyncReservation(reservation);
    expect(getSession(SESSION)?.summarySyncFingerprints).toEqual([fingerprint]);

    resetAllSummarySyncHistories();
    expect(getSummarySyncFingerprints(SESSION)).toEqual([fingerprint]);
    expect(reserveUnsyncedSummaryFingerprints(SESSION, [fingerprint])).toBeUndefined();

    clearSummarySyncHistory(SESSION);
    resetAllSummarySyncHistories();
    expect(getSummarySyncFingerprints(SESSION)).toEqual([]);
    expect(reserveUnsyncedSummaryFingerprints(SESSION, [fingerprint])?.fingerprints).toEqual([fingerprint]);
  });
});
