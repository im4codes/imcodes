#!/usr/bin/env node
/**
 * One-shot backfill for `context_processed_local.embedding` rows that
 * lack a vector.
 *
 * Why: rows are populated whenever the daemon writes a new projection,
 * but the embedding column was added later AND can be NULL during any
 * window the embedding pipeline was unavailable (network failure on
 * first model download, EACCES on the cache dir, sticky-disable from
 * a transient ERR_DLOPEN_FAILED, etc.). On observed production dbs
 * 80%+ of `recent_summary` rows had no embedding, which makes them
 * invisible to `searchLocalMemorySemantic` (cosine ranking ignores
 * NULLs). Result: "I don't see related past work" even though the
 * memory IS there in the durable store — it just can't be retrieved
 * by semantic similarity.
 *
 * What this does:
 *   1. Open the daemon's SQLite db (default ~/.imcodes/shared-agent-context.sqlite).
 *   2. Pick rows with `embedding IS NULL` for class='recent_summary',
 *      status='active', non-empty summary text. (Drafts and tombstoned
 *      rows are skipped.)
 *   3. Run each summary through the SAME pipeline + model the daemon
 *      uses (Xenova/paraphrase-multilingual-MiniLM-L12-v2, q8) so the
 *      vectors are in the same coordinate space as live writes.
 *   4. UPDATE the row with the encoded BLOB and `embedding_source`.
 *
 * Idempotent — re-running only touches rows still NULL. Safe to run
 * while the daemon is live (each row is a separate UPDATE; SQLite WAL
 * makes the reads non-blocking).
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs              # use default db
 *   node scripts/backfill-embeddings.mjs --dry-run    # report counts only
 *   node scripts/backfill-embeddings.mjs --db <path>  # alternate db
 *   node scripts/backfill-embeddings.mjs --limit N    # stop after N rows
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

// ── arg parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const dryRun = flag('--dry-run');
const dbPath = value('--db', join(homedir(), '.imcodes', 'shared-agent-context.sqlite'));
const limit = Number(value('--limit', '0')) || 0;

if (!existsSync(dbPath)) {
  console.error(`[backfill] db not found: ${dbPath}`);
  process.exit(1);
}

// Match the daemon's cache-dir resolution so the model file gets reused
// instead of downloaded again into a temp location.
process.env.IMCODES_EMBEDDING_CACHE_DIR = process.env.IMCODES_EMBEDDING_CACHE_DIR
  || join(homedir(), '.imcodes', 'embedding-cache');

// Use the same model + dtype constants the daemon uses so the vectors we
// write here land in the same coordinate space as live daemon writes.
const { EMBEDDING_MODEL, EMBEDDING_DTYPE, EMBEDDING_DIM } = await import('../dist/shared/embedding-config.js');

// Load transformers directly. We deliberately do NOT go through
// `dist/src/context/embedding.js` — that module pulls in pino (which
// crashes the script on exit with "sonic boom is not ready yet") and
// its dynamic `import('@huggingface/transformers')` resolves against
// the wrong base when called from a sibling script context. Spinning
// up our own pipeline matches what the daemon does at the call site
// granularity, only without the daemon's logger plumbing.
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = process.env.IMCODES_EMBEDDING_CACHE_DIR;

/** Match `embedding.ts:encodeEmbedding` byte-for-byte. */
function encodeEmbedding(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

console.log(`[backfill] db:        ${dbPath}`);
console.log(`[backfill] cache:     ${process.env.IMCODES_EMBEDDING_CACHE_DIR}`);
console.log(`[backfill] model:     ${EMBEDDING_MODEL} (dim=${EMBEDDING_DIM})`);
console.log(`[backfill] dry-run:   ${dryRun}`);
if (limit) console.log(`[backfill] limit:     ${limit}`);

// ── open db (read-write; SQLite WAL means concurrent daemon reads are fine) ──
const db = new DatabaseSync(dbPath);

// Count first so the progress meter has a denominator.
const totalRow = db.prepare(`
  SELECT COUNT(*) AS n
  FROM context_processed_local
  WHERE embedding IS NULL
    AND class = 'recent_summary'
    AND status = 'active'
    AND summary IS NOT NULL
    AND length(trim(summary)) > 0
`).get();
const total = Number(totalRow?.n ?? 0);

console.log(`[backfill] candidate rows: ${total}`);
if (total === 0) {
  console.log('[backfill] nothing to do');
  db.close();
  process.exit(0);
}

const selectStmt = db.prepare(`
  SELECT id, summary, namespace_key
  FROM context_processed_local
  WHERE embedding IS NULL
    AND class = 'recent_summary'
    AND status = 'active'
    AND summary IS NOT NULL
    AND length(trim(summary)) > 0
  ORDER BY updated_at DESC
  ${limit > 0 ? 'LIMIT ' + limit : ''}
`);
const updateStmt = db.prepare(`
  UPDATE context_processed_local
  SET embedding = ?, embedding_source = ?
  WHERE id = ?
`);

const rows = selectStmt.all();

// Warm the pipeline once so the per-row latency stat reflects steady state,
// not first-call model download/init.
console.log('[backfill] loading + warming pipeline...');
const warmT0 = performance.now();
const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE });
const warm = await pipe('warmup', { pooling: 'mean', normalize: true });
if (!warm?.data || warm.data.length !== EMBEDDING_DIM) {
  console.error(`[backfill] warmup vector wrong shape (got ${warm?.data?.length}) — aborting`);
  db.close();
  process.exit(2);
}
console.log(`[backfill] pipeline ready in ${((performance.now() - warmT0) / 1000).toFixed(1)}s`);

async function generateEmbedding(text) {
  const r = await pipe(text, { pooling: 'mean', normalize: true });
  return r.data;
}

// ── main loop ───────────────────────────────────────────────────────────────
let done = 0;
let failed = 0;
let skipped = 0;
const startTs = performance.now();
const PROGRESS_EVERY = 50;

for (const row of rows) {
  // Bound the per-row input. Long summaries are paraphrases of paraphrases
  // (see PREVIOUS_SUMMARY_MAX_CHARS in summary-compressor.ts) — embedding
  // the first ~8000 chars captures the essence and keeps per-row latency
  // bounded around 5–20 ms on q8.
  const text = row.summary.length > 8000 ? row.summary.slice(0, 8000) : row.summary;
  let vec;
  try {
    vec = await generateEmbedding(text);
  } catch (err) {
    failed++;
    console.error(`[backfill] FAIL ${row.id}: ${err?.message ?? err}`);
    continue;
  }
  if (!vec) {
    skipped++;
    continue;
  }

  if (!dryRun) {
    try {
      updateStmt.run(encodeEmbedding(vec), EMBEDDING_MODEL, row.id);
    } catch (err) {
      failed++;
      console.error(`[backfill] WRITE FAIL ${row.id}: ${err?.message ?? err}`);
      continue;
    }
  }

  done++;
  if (done % PROGRESS_EVERY === 0) {
    const elapsed = (performance.now() - startTs) / 1000;
    const rate = done / elapsed;
    const eta = ((rows.length - done) / rate).toFixed(0);
    console.log(`[backfill] ${done}/${rows.length}  rate=${rate.toFixed(1)}/s  ETA=${eta}s`);
  }
}

const elapsed = ((performance.now() - startTs) / 1000).toFixed(1);
console.log(`[backfill] done in ${elapsed}s — ${done} embedded, ${skipped} pipeline-null, ${failed} failed`);

db.close();
process.exit(failed > 0 ? 3 : 0);
