import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { serializeContextNamespace } from '../../src/context/context-keys.js';
import * as store from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const NS: ContextNamespace = { scope: 'personal', userId: 'u1', projectId: 'github.com/acme/repo' };
const OTHER_NS: ContextNamespace = { scope: 'personal', userId: 'u1', projectId: 'github.com/acme/other' };
const NOISE = '[API Error: Connection error. (cause: fetch failed)]';
const session = (name: string, namespace = NS) => ({ namespace, kind: 'session' as const, sessionName: name });

let tempDir: string;
let rowSeq = 0;

/** Direct row insert (one transaction) so a test can seed thousands of rows
 * without paying the full write pipeline per row. */
function seed(rows: Array<{
  namespace?: ContextNamespace; cls: 'recent_summary' | 'master_summary'; sessionName?: string;
  targetKind?: 'session' | 'project'; updatedAt: number; summary?: string; status?: string;
}>): void {
  const db = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
  try {
    db.exec('BEGIN');
    const stmt = db.prepare(`INSERT INTO context_processed_local
      (id, namespace_key, class, source_event_ids_json, summary, content_json, created_at, updated_at, status)
      VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      const content: Record<string, unknown> = { targetKind: r.targetKind ?? 'session' };
      if (r.sessionName !== undefined) content.sessionName = r.sessionName;
      stmt.run(`row-${rowSeq++}`, serializeContextNamespace(r.namespace ?? NS), r.cls, r.summary ?? `summary ${rowSeq}`,
        JSON.stringify(content), r.updatedAt, r.updatedAt, r.status ?? 'active');
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function buildIndexes(): void {
  for (let i = 0; i < 40; i += 1) if (store.ensureContextStoreMaintenanceIndexes().done) return;
  throw new Error('maintenance indexes never completed');
}

describe('context-store summary lookups', () => {
  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store-summary-lookup');
    store.getContextMeta('__init__'); // create the schema before direct seeding
    seed([
      { cls: 'recent_summary', sessionName: 'A', updatedAt: 3000 },
      { cls: 'recent_summary', sessionName: 'A', updatedAt: 1000 },
      // newest row of B is noise -> the older real summary must win
      { cls: 'recent_summary', sessionName: 'B', updatedAt: 5000, summary: NOISE },
      { cls: 'recent_summary', sessionName: 'B', updatedAt: 2000 },
      // newest row of C is archived -> the older active one must win
      { cls: 'recent_summary', sessionName: 'C', updatedAt: 6000, status: 'archived' },
      { cls: 'recent_summary', sessionName: 'C', updatedAt: 4000 },
      // D only ever produced noise -> never listed / no timestamp
      { cls: 'recent_summary', sessionName: 'D', updatedAt: 7000, summary: NOISE },
      // project-kind summary has no sessionName
      { cls: 'recent_summary', targetKind: 'project', updatedAt: 8000 },
      // same session name in another namespace must not leak
      { namespace: OTHER_NS, cls: 'recent_summary', sessionName: 'A', updatedAt: 9000 },
      { cls: 'master_summary', sessionName: 'A', updatedAt: 3500 },
      { cls: 'master_summary', sessionName: 'A', updatedAt: 3600, summary: NOISE },
    ]);
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function assertLookups(): void {
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('A'))).toBe(3000);
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('B'))).toBe(2000);
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('C'))).toBe(4000);
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('D'))).toBeUndefined();
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('nope'))).toBeUndefined();
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('A', OTHER_NS))).toBe(9000);
    expect(store.getLatestRecentSummaryUpdatedAtForTarget({ namespace: NS, kind: 'project' })).toBe(8000);
    expect(store.getLatestMasterSummaryUpdatedAt('A', NS)).toBe(3500);
    expect(store.getLatestMasterSummaryUpdatedAt('B', NS)).toBeUndefined();

    const listed = store.listLatestRecentSummarySessions(1000);
    const nsKey = (n: ContextNamespace) => serializeContextNamespace(n);
    expect(listed.map((s) => [s.sessionName, nsKey(s.namespace), s.updatedAt])).toEqual([
      ['A', nsKey(OTHER_NS), 9000],
      ['C', nsKey(NS), 4000],
      ['A', nsKey(NS), 3000],
      ['B', nsKey(NS), 2000],
    ]);
    expect(store.listLatestRecentSummarySessions(2).map((s) => s.updatedAt)).toEqual([9000, 4000]);
    expect(store.listLatestRecentSummarySessions(0)).toEqual([]);
  }

  it('resolves per-target / master / sweep lookups correctly without the maintenance indexes', () => {
    assertLookups();
  });

  it('resolves them identically once the maintenance indexes exist', () => {
    buildIndexes();
    assertLookups();
  });

  it('listProcessedProjections options push filters into SQL and keep the legacy default', () => {
    const all = store.listProcessedProjections(NS, 'recent_summary');
    // legacy: archived rows are still returned, noise (5000, 7000) is dropped
    expect(all.map((p) => p.updatedAt)).toEqual([8000, 6000, 4000, 3000, 2000, 1000]);
    expect(store.listProcessedProjections(NS, 'recent_summary', { excludeArchived: true, limit: 1 }).map((p) => p.updatedAt)).toEqual([8000]);
    expect(store.listProcessedProjections(NS, 'recent_summary', { sessionName: 'A', updatedAfter: 1000, excludeArchived: true }).map((p) => p.updatedAt)).toEqual([3000]);
    expect(store.listProcessedProjections(NS, 'recent_summary', { sessionName: 'B', excludeArchived: true }).map((p) => p.updatedAt)).toEqual([2000]);
    expect(store.listProcessedProjections(NS, 'master_summary', { sessionName: 'A', excludeArchived: true, limit: 1 }).map((p) => p.updatedAt)).toEqual([3500]);
    expect(store.listProcessedProjections(NS, 'recent_summary', { sessionName: 'zzz' })).toEqual([]);
  });

  it('hasProcessedProjectionsInNamespace ignores noise-only namespaces', () => {
    expect(store.hasProcessedProjectionsInNamespace(NS)).toBe(true);
    const noiseOnly: ContextNamespace = { scope: 'personal', userId: 'u1', projectId: 'github.com/acme/noise' };
    seed([{ namespace: noiseOnly, cls: 'recent_summary', sessionName: 'N', updatedAt: 1, summary: NOISE }]);
    expect(store.hasProcessedProjectionsInNamespace(noiseOnly)).toBe(false);
    expect(store.hasProcessedProjectionsInNamespace({ ...noiseOnly, projectId: 'github.com/acme/empty' })).toBe(false);
  });

  // Causal guard for the field wedge: the per-live-event latest-summary lookup
  // used to load and json-parse EVERY recent summary of the namespace (115 ms
  // warm / 4.4 s cold at 27k rows), so its cost tracked namespace size. It must
  // now cost O(one session), i.e. far below a full namespace scan.
  it('per-target latest-summary lookup cost does not scale with the namespace size', () => {
    const rows: Parameters<typeof seed>[0] = [];
    for (let i = 0; i < 8000; i += 1) rows.push({ cls: 'recent_summary', sessionName: `bulk-${i % 40}`, updatedAt: 10_000 + i, summary: `bulk summary ${i} ${'x'.repeat(200)}` });
    rows.push({ cls: 'recent_summary', sessionName: 'target', updatedAt: 50_000 });
    seed(rows);
    buildIndexes();

    const best = (fn: () => unknown): number => {
      let min = Infinity;
      for (let i = 0; i < 7; i += 1) {
        const t0 = performance.now();
        fn();
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    const db = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
    let scanMs: number;
    try {
      const stmt = db.prepare(`SELECT updated_at, summary FROM context_processed_local
        WHERE namespace_key = ? AND class = 'recent_summary' AND json_extract(content_json, '$.targetKind') = 'session'
        ORDER BY updated_at DESC`);
      scanMs = best(() => stmt.all(serializeContextNamespace(NS)));
    } finally {
      db.close();
    }
    expect(store.getLatestRecentSummaryUpdatedAtForTarget(session('target'))).toBe(50_000);
    const lookupMs = best(() => store.getLatestRecentSummaryUpdatedAtForTarget(session('bulk-7')));
    // Base measured ~equal to the scan; head measures <1/50. 1/8 leaves ample
    // headroom for a noisy CI box.
    expect(lookupMs * 8).toBeLessThan(scanMs);
    const sweepMs = best(() => store.listLatestRecentSummarySessions(1000));
    expect(sweepMs * 2).toBeLessThan(scanMs * 4 + 50); // sweep touches one row per session, never the payloads
  });
});
