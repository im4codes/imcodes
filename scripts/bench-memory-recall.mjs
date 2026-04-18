#!/usr/bin/env node
/**
 * Micro-benchmark for memory recall latency.
 *
 * Measures:
 *   1. Cold embedding pipeline load (first query)
 *   2. Per-query `generateEmbedding` latency (steady state)
 *   3. End-to-end `searchLocalMemorySemantic` latency with N stored candidates
 *
 * Run: node scripts/bench-memory-recall.mjs [N]
 */

import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Isolate the DB so we don't touch the user's real one.
const benchDir = mkdtempSync(join(tmpdir(), 'bench-memory-'));
mkdirSync(benchDir, { recursive: true });
process.env.HOME = benchDir;
process.env.IMCODES_EMBEDDING_CACHE_DIR = process.env.IMCODES_EMBEDDING_CACHE_DIR
  || join(benchDir, '.cache', 'imcodes-embeddings');
mkdirSync(process.env.IMCODES_EMBEDDING_CACHE_DIR, { recursive: true });

const candidateCount = Number(process.argv[2] ?? 40);

const { writeProcessedProjection } = await import('../dist/src/store/context-store.js');
const { searchLocalMemorySemantic } = await import('../dist/src/context/memory-search.js');
const { generateEmbedding } = await import('../dist/src/context/embedding.js');

const namespace = { scope: 'personal', projectId: 'github.com/bench/memory-recall' };

const SUMMARIES = [
  'Key decisions: Docker caching — pin HF transformers version separate from server package.json.',
  'Provider reconnection fix: queue sends in command-handler.ts when runtime is null, drain on reconnect, handle cancel/expiry.',
  'Optimistic send UX: addOptimisticUserMessage with commandId, markOptimisticFailed on command.ack error, retry button in ChatView.',
  'Cross-agent P2P discussion: multiple models review each other in audit / review / brainstorm / plan phases.',
  'Embedding model preload: stage 1.5 of server/Dockerfile downloads Xenova/paraphrase-multilingual-MiniLM-L12-v2 q8 into /app/embedding-cache.',
  'Watch app optimistic send: WatchConversationItem with isPending/isFailed, 6-second poll interval when detail view open.',
  'File change diff rendering: per-row +/- sign column with brighter green background (rgba 0.28).',
  'Session-close semantics: closeSingleSession handles transport vs tmux separately, clearResend drops queued on stop.',
  'Template-prompt filter: isTemplatePrompt skips recall for OpenSpec / skill invocations / imperative commands.',
  'Memory recall dedup: writeProcessedProjection now reuses existing UUID for same normalized-summary in same namespace.',
];

console.log(`[bench] seeding ${candidateCount} projections into ${benchDir}`);
const seedStart = performance.now();
for (let i = 0; i < candidateCount; i++) {
  // Force fresh UUIDs so the bench measures the worst-case "before dedup
  // landed" scenario — N distinct rows that all need embedding.
  writeProcessedProjection({
    id: `bench-${i}`,
    namespace,
    class: i % 2 === 0 ? 'durable_memory_candidate' : 'recent_summary',
    sourceEventIds: [`evt-${i}`],
    summary: `${SUMMARIES[i % SUMMARIES.length]} — variant ${i}`,
    content: { turn: i },
    createdAt: Date.now() - (candidateCount - i) * 1000,
    updatedAt: Date.now() - (candidateCount - i) * 1000,
  });
}
console.log(`[bench] seeded in ${(performance.now() - seedStart).toFixed(0)} ms`);

// 1. Cold pipeline load.
console.log('[bench] warming up pipeline (cold load)...');
const coldStart = performance.now();
await generateEmbedding('warmup');
const coldMs = performance.now() - coldStart;
console.log(`[bench] cold load + first embedding: ${coldMs.toFixed(0)} ms`);

// 2. Steady-state generateEmbedding.
console.log('[bench] measuring steady-state generateEmbedding (10 x)');
const steady = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await generateEmbedding(`bench steady state query ${i}`);
  steady.push(performance.now() - t0);
}
steady.sort((a, b) => a - b);
const p50 = steady[Math.floor(steady.length / 2)];
const p95 = steady[Math.floor(steady.length * 0.95)];
console.log(`[bench] single embedding p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);

// 3. End-to-end searchLocalMemorySemantic.
console.log('[bench] measuring searchLocalMemorySemantic end-to-end (5 x)');
const endToEnd = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  const result = await searchLocalMemorySemantic({
    query: 'docker caching',
    namespace,
    limit: 5,
  });
  endToEnd.push({ ms: performance.now() - t0, count: result.items.length });
}
console.log('[bench] per-call recall latency:');
for (const [i, e] of endToEnd.entries()) {
  console.log(`  #${i + 1}: ${e.ms.toFixed(0)} ms  (returned ${e.count} items)`);
}
endToEnd.sort((a, b) => a.ms - b.ms);
console.log(`[bench] recall p50=${endToEnd[Math.floor(endToEnd.length / 2)].ms.toFixed(0)}ms`);
