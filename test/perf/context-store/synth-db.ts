/**
 * Production-shaped synthetic shared-agent-context.sqlite generator.
 *
 * Reproduces the SHAPE (row counts, per-row sizes, per-namespace skew, class
 * and status mix, index set, meta sentinels) of a long-lived daemon store
 * measured read-only on the owner's machine (schema + counts + length()
 * aggregates only; no content was read or copied). Every text value here is
 * synthetic. Run against a scratch path ONLY:
 *
 *   IMCODES_CONTEXT_DB_PATH=/tmp/x/ctx.sqlite npx tsx test/perf/context-store/synth-db.ts [scale]
 *
 * scale 1 ~= 1.0 GB (66k projections with 1.5 KB embeddings, 63k observations,
 * 150k archived events + trigram FTS, 358k projection sources, ...).
 * The dominant skew, and the one that matters for the wedge: ONE namespace owns
 * 27,313 of the 37,010 recent_summary rows (35 MB of summary text).
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { getContextMeta } from '../../../src/store/context-store.js';
import { serializeContextNamespace, serializeContextTarget } from '../../../src/context/context-keys.js';

const dbPath = process.env.IMCODES_CONTEXT_DB_PATH?.trim();
if (!dbPath || dbPath.includes('/.imcodes/')) {
  throw new Error('IMCODES_CONTEXT_DB_PATH must point at a scratch DB (never the real ~/.imcodes)');
}
const SCALE = Number(process.argv[2] ?? 1);
const n = (count: number): number => Math.max(1, Math.round(count * SCALE));

// ── deterministic PRNG so runs are comparable ────────────────────────────────
let seed = 0x9e3779b9;
function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
/** log-normal-ish length: median ~m, heavy tail capped at max. */
function heavyLen(median: number, sigma: number, max: number): number {
  const u1 = Math.max(rnd(), 1e-9); const u2 = rnd();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(max, Math.max(20, Math.round(median * Math.exp(sigma * z))));
}
const WORDS = ('memory context worker queue timeout session summary decision constraint materialize ingest '
  + 'projection archive namespace target dirty job claim enqueue index sqlite checkpoint respawn latency '
  + 'daemon transport provider timeline event assistant user tool result schema migration fingerprint '
  + 'embedding recall search refactor bugfix feature discovery preference workflow pattern').split(' ');
function text(len: number): string {
  let out = '';
  while (out.length < len) out += `${pick(WORDS)} ${rnd() < 0.08 ? `${int(1, 9999)} ` : ''}`;
  return out.slice(0, len);
}
const uuid = (): string => {
  const b = randomBytes(16).toString('hex');
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`;
};

// Warm the store so ensureDb() creates the real schema/FTS/triggers/indexes.
getContextMeta('__synth_warm__');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA busy_timeout = 30000;');

const NOW = Date.now();
const DAY = 86_400_000;

// ── namespaces / sessions ────────────────────────────────────────────────────
const NS_COUNT = 27;
const namespaces = Array.from({ length: NS_COUNT }, (_, i) => ({
  scope: 'personal' as const,
  userId: 'synthetic-user',
  projectId: `github.com/synthetic/project-${i}`,
}));
const nsKey = (i: number): string => serializeContextNamespace(namespaces[i]!);
/** live skew: recent_summary rows per namespace (sums to ~37,010). */
const recentPerNs = [27313, 2053, 1820, 1546, 734, 733, ...Array.from({ length: NS_COUNT - 6 }, () => 0)];
{
  let rest = 37010 - recentPerNs.reduce((a, b) => a + b, 0);
  for (let i = 6; i < NS_COUNT && rest > 0; i += 1) { const v = Math.min(rest, int(20, 500)); recentPerNs[i] = v; rest -= v; }
}
const sessionsPerNs = (i: number): number => (i === 0 ? 60 : int(2, 12));
const sessionNames: string[][] = namespaces.map((_, i) => Array.from({ length: sessionsPerNs(i) }, (_, k) => `deck_synth${i}_w${k}`));
const targetsKeys: string[] = [];
sessionNames.forEach((sessions, i) => sessions.forEach((s) => targetsKeys.push(serializeContextTarget({ namespace: namespaces[i]!, kind: 'session', sessionName: s }))));
namespaces.forEach((ns) => targetsKeys.push(serializeContextTarget({ namespace: ns, kind: 'project' })));

function insertMany(sql: string, rows: number, gen: (i: number) => unknown[], batch = 5000): void {
  const stmt = db.prepare(sql);
  for (let start = 0; start < rows; start += batch) {
    db.exec('BEGIN');
    const end = Math.min(rows, start + batch);
    for (let i = start; i < end; i += 1) stmt.run(...(gen(i) as never[]));
    db.exec('COMMIT');
  }
}
const log = (msg: string): void => { process.stderr.write(`[synth] ${msg}\n`); };

// ── context_namespaces (observation FK target) ──────────────────────────────
const nsRowIds: string[] = [];
insertMany(`INSERT INTO context_namespaces (id, local_tenant, scope, user_id, project_id, key, visibility, created_at, updated_at)
  VALUES (?, 'daemon-local', ?, ?, ?, ?, 'private', ?, ?)`, 41, (i) => {
  const ns = namespaces[i % NS_COUNT]!;
  const id = `ns-${i}`; nsRowIds.push(id);
  return [id, ns.scope, ns.userId, ns.projectId, `${nsKey(i % NS_COUNT)}#${i}`, NOW - 90 * DAY, NOW - int(0, 30) * DAY];
});

// ── context_processed_local: 66,615 rows (recent_summary/durable/master) ────
type Proj = { id: string };
const projections: Proj[] = [];
{
  const plan: Array<{ ns: number; klass: string; count: number }> = [];
  recentPerNs.forEach((c, i) => { if (c) plan.push({ ns: i, klass: 'recent_summary', count: n(c) }); });
  let durable = n(29360);
  for (let i = 0; durable > 0; i = (i + 1) % NS_COUNT) { const v = Math.min(durable, int(200, 2500)); plan.push({ ns: i, klass: 'durable_memory_candidate', count: v }); durable -= v; }
  for (let i = 0; i < NS_COUNT; i += 1) plan.push({ ns: i, klass: 'master_summary', count: n(9) });
  const flat: Array<{ ns: number; klass: string }> = [];
  for (const p of plan) for (let k = 0; k < p.count; k += 1) flat.push({ ns: p.ns, klass: p.klass });
  // interleave like a real store: rowid order ~ creation order across classes
  for (let i = flat.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [flat[i], flat[j]] = [flat[j]!, flat[i]!]; }
  const perNsSeq = new Array(NS_COUNT).fill(0);
  insertMany(`INSERT INTO context_processed_local (
      id, namespace_key, class, source_event_ids_json, summary, content_json, created_at, updated_at,
      hit_count, last_used_at, status, embedding, embedding_source, summary_fingerprint, content_hash, origin,
      scope, enterprise_id, workspace_id, user_id, project_id, is_noise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?, ?, ?, NULL, NULL, ?, ?, 0)`, flat.length, (i) => {
    const { ns, klass } = flat[i]!;
    const id = uuid(); projections.push({ id });
    const seq = perNsSeq[ns]++;
    const isSession = klass === 'recent_summary' ? rnd() < 0.97 : rnd() < 0.5;
    const sessionName = pick(sessionNames[ns]!);
    const age = int(0, 75) * DAY + int(0, DAY);
    const updated = NOW - age;
    const status = klass === 'recent_summary' && rnd() < 0.357 ? (rnd() < 0.5 ? 'archived' : 'archived_dedup') : 'active';
    const summary = text(heavyLen(640, 0.8, 82_455));
    const content = JSON.stringify({
      targetKind: isSession ? 'session' : 'project',
      ...(isSession ? { sessionName } : {}),
      turn: seq, compressionFromSdk: true, compressionModel: 'synthetic', pad: text(int(120, 260)),
    });
    return [
      id, nsKey(ns), klass,
      JSON.stringify(Array.from({ length: int(1, 8) }, () => uuid())),
      summary, content, updated - int(0, DAY), updated,
      int(0, 5), rnd() < 0.3 ? updated : null, status, randomBytes(1536),
      randomBytes(16).toString('hex'), randomBytes(16).toString('hex'), pick(['chat_compacted', 'agent_learned', 'md_ingest']),
      namespaces[ns]!.scope, namespaces[ns]!.userId, namespaces[ns]!.projectId,
    ];
  });
  log(`processed_local ${flat.length}`);
}

// ── context_event_archive (+ trigram FTS via triggers) ──────────────────────
const archiveIds: string[] = [];
{
  const rows = n(149_655);
  insertMany(`INSERT INTO context_event_archive (id, namespace_key, target_key, event_type, content, metadata_json, created_at, archived_at, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, rows, () => {
    const id = uuid(); archiveIds.push(id);
    const t = pick(targetsKeys);
    const created = NOW - int(0, 60) * DAY - int(0, DAY);
    const content = text(heavyLen(220, 0.9, 272_630));
    return [id, t.split('::').slice(0, 5).join('::'), t, pick(['assistant.text', 'assistant.text', 'user.message', 'tool.result']),
      content, JSON.stringify({ src: 'synthetic' }), created, created + int(1000, 3_600_000), Math.ceil(content.length / 4)];
  }, 2000);
  log(`archive ${rows}`);
}

// ── context_projection_sources: 358,175 ─────────────────────────────────────
insertMany('INSERT OR IGNORE INTO context_projection_sources (projection_id, event_id) VALUES (?, ?)', n(358_175), () =>
  [pick(projections).id, pick(archiveIds)]);
log('projection_sources');

// ── context_observations: 63,265 ────────────────────────────────────────────
insertMany(`INSERT OR IGNORE INTO context_observations (id, namespace_id, scope, class, origin, fingerprint, content_json, text_hash,
    source_event_ids_json, projection_id, state, confidence, created_at, updated_at, promoted_at)
  VALUES (?, ?, 'personal', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`, n(63_265), () => {
  const t = NOW - int(0, 80) * DAY;
  return [uuid(), pick(nsRowIds), pick(['fact', 'decision', 'bugfix', 'feature', 'note']), pick(['chat_compacted', 'agent_learned', 'md_ingest']),
    randomBytes(12).toString('hex'), JSON.stringify({ text: text(heavyLen(1000, 0.4, 6000)) }), randomBytes(12).toString('hex'),
    JSON.stringify([uuid()]), rnd() < 0.7 ? pick(projections).id : null, rnd(), t, t + int(0, DAY)];
});
log('observations');

// ── jobs / dirty targets / staged events ────────────────────────────────────
{
  const sessionTargets = targetsKeys.filter((t) => t.includes('::session::'));
  const mk = (statusOf: () => string, i: number): unknown[] => {
    const tk = pick(sessionTargets);
    const nsIdx = namespaces.findIndex((ns) => tk.startsWith(serializeContextNamespace(ns)));
    const ns = namespaces[Math.max(0, nsIdx)]!;
    const created = NOW - int(0, 60) * DAY - int(0, DAY);
    return [uuid(), nsKey(Math.max(0, nsIdx)), ns.scope, ns.userId, ns.projectId, tk, 'session', tk.split('::').pop() ?? null,
      'materialize_session', pick(['idle', 'threshold', 'schedule']), statusOf(), created, created + int(1000, 600_000), int(1, 3), i];
  };
  const statuses: string[] = [
    ...new Array(n(14_718)).fill('completed'), ...new Array(n(1_084)).fill('materialization_failed'),
    ...new Array(12).fill('pending'), ...new Array(30).fill('running')];
  insertMany(`INSERT INTO context_jobs (id, namespace_key, scope, user_id, project_id, target_key, target_kind, session_name, job_type,
      trigger, status, created_at, updated_at, attempt_count, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  statuses.length, (i) => mk(() => statuses[i]!, i).slice(0, 14));
  const dirty = targetsKeys.filter((t) => t.includes('::session::')).slice(0, 48);
  insertMany(`INSERT OR IGNORE INTO context_dirty_targets (target_key, namespace_key, scope, user_id, project_id, target_kind, session_name,
      event_count, oldest_event_at, newest_event_at, last_trigger, pending_job_id) VALUES (?, ?, 'personal', 'synthetic-user', ?, 'session', ?, ?, ?, ?, NULL, NULL)`,
  dirty.length, (i) => {
    const t = dirty[i]!; const nsIdx = Math.max(0, namespaces.findIndex((ns) => t.startsWith(serializeContextNamespace(ns))));
    return [t, nsKey(nsIdx), namespaces[nsIdx]!.projectId, t.split('::').pop(), int(1, 40), NOW - int(1, 5) * 3_600_000, NOW - int(0, 3) * 60_000];
  });
  insertMany(`INSERT INTO context_staged_events (id, namespace_key, scope, user_id, project_id, target_key, target_kind, session_name, event_type, content, metadata_json, created_at)
    VALUES (?, ?, 'personal', 'synthetic-user', ?, ?, 'session', ?, 'assistant.text', ?, '{}', ?)`, 761, () => {
    const t = pick(dirty); const nsIdx = Math.max(0, namespaces.findIndex((ns) => t.startsWith(serializeContextNamespace(ns))));
    return [uuid(), nsKey(nsIdx), namespaces[nsIdx]!.projectId, t, t.split('::').pop(), text(heavyLen(900, 0.9, 40_000)), NOW - int(0, 6) * 3_600_000];
  });
  log('jobs/dirty/staged');
}

// ── usage / short refs / compression runs / replication ─────────────────────
const usageRows = n(55_251);
insertMany(`INSERT INTO context_turn_usage (created_at, session_name, agent_type, model, input_tokens, cache_tokens, output_tokens, event_id, session_kind)
  VALUES (?, ?, 'claude-code', 'synthetic', ?, ?, ?, ?, 'main')`, usageRows, () =>
  [NOW - int(0, 60) * DAY, pick(sessionNames[0]!), int(100, 90_000), int(0, 90_000), int(20, 6000), uuid()]);
insertMany(`INSERT INTO context_turn_usage_sync (turn_usage_rowid, usage_authority_id, usage_fact_id, payload_hash, sync_status, retry_count,
    metadata_completeness, created_at_ms, updated_at_ms) VALUES (?, 'usage-authority-synthetic', ?, ?, ?, 0, 'complete', ?, ?)`, usageRows, (i) => {
  const t = NOW - int(0, 60) * DAY;
  return [i + 1, uuid(), randomBytes(16).toString('hex'), rnd() < 0.985 ? 'accepted' : pick(['pending', 'retryable_failed']), t, t];
});
insertMany(`INSERT OR IGNORE INTO memory_short_refs (ref, kind, id, namespace_key, namespace_json, last_seen_at) VALUES (?, 'projection', ?, ?, NULL, ?)`,
  n(38_905), () => [randomBytes(4).toString('hex'), pick(projections).id, nsKey(int(0, NS_COUNT - 1)), NOW - int(0, 60) * DAY]);
insertMany(`INSERT INTO context_compression_runs (created_at, backend, model, used_backup, from_sdk, namespace_key, target_kind, session_name,
    trigger, mode, event_count, input_tokens, output_tokens, target_tokens, duration_ms, outcome, projection_id)
  VALUES (?, 'synthetic', 'synthetic', 0, 1, ?, 'session', ?, 'idle', 'auto', ?, ?, ?, ?, ?, 'success', ?)`, n(35_875), () =>
  [NOW - int(0, 60) * DAY, nsKey(0), pick(sessionNames[0]!), int(1, 60), int(500, 40_000), int(100, 3000), int(500, 4000), int(800, 30_000), pick(projections).id]);
insertMany('INSERT OR IGNORE INTO context_replication_state (namespace_key, pending_projection_ids_json) VALUES (?, ?)', 35, (i) =>
  [nsKey(i % NS_COUNT), '[]']);
log('usage/refs/runs');

// ── meta sentinels: mirror the live store (incl. the STALLED noise backfill) ─
const setMeta = db.prepare('INSERT INTO context_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
const maxRowid = (db.prepare('SELECT max(rowid) AS m FROM context_processed_local').get() as { m: number }).m;
for (const [k, v] of Object.entries({
  fts_backfilled: '1', fts_tokenizer: 'trigram', migration_archive_backfilled: '1',
  migration_fingerprint_backfilled_at: String(NOW - 150 * DAY), migration_namespace_filter_columns_backfilled: String(NOW - 148 * DAY),
  maintenance_indexes_cursor: '8', memory_noise_purge_rowid: String(maxRowid), staged_reconcile_rowid: String(maxRowid),
  // live: cursor stalled at ~30% and NO `processed_noise_backfill_complete` key.
  processed_noise_backfill_rowid: String(Math.round(maxRowid * 0.304)),
  last_archive_sweep_at: String(NOW - DAY), last_materialization_repair_at: String(NOW - 3_600_000),
})) setMeta.run(k, v, NOW);
db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // deliberately NO ANALYZE: the live store has no sqlite_stat1
db.close();
const bytes = statSync(dbPath).size;
log(`done: ${(bytes / 1048576).toFixed(0)} MB at ${dbPath}`);
