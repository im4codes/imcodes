import { beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import {
  collectRecentSummarySyncCandidates,
  fingerprintRecentSummary,
} from '../../src/context/summary-sync.js';
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
) {
  return {
    type: 'processed' as const,
    id,
    projectId: NAMESPACE.projectId!,
    scope: NAMESPACE.scope,
    projectionClass,
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
