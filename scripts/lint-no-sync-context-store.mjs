#!/usr/bin/env node
/**
 * Exact-path import guard for the context-store worker isolation.
 *
 * Daemon production code MUST reach the memory/context SQLite store ONLY through
 * the asynchronous `context-store-worker-client`, never by importing the
 * synchronous `src/store/context-store.js` directly (that would open/own a
 * second long-lived connection on the daemon main thread and defeat WAL
 * `TRUNCATE` convergence).
 *
 * This guard scans `src/` for any static OR dynamic import of `context-store.js`
 * and fails on any importer not in the allowlist below.
 *
 *  - PERMANENT  : the strict end-state allowlist — the worker (the single
 *                 long-lived DB owner) and the short-lived CLI. (Tests live in
 *                 `test/` and are not scanned.)
 *  - TRANSITION : modules not yet migrated to the async client, or that keep a
 *                 documented in-process fallback / exception. This set MUST
 *                 shrink to empty; when it does, the guard is at its strict end
 *                 state. Each entry is verified to still import the store (no
 *                 stale entries) by the accompanying test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const srcRoot = join(repoRoot, 'src');

export const PERMANENT_IMPORTERS = [
  // ── The worker + its shared dispatch/recall layer ──
  // These RUN IN the context-store worker (the single long-lived DB owner) AND
  // double as the bounded in-process COLD fallback the client uses only when the
  // worker is not ready (the brief pre-`whenReady` startup window, unit tests
  // that never spawn the worker, and the CLI) — never in steady-state daemon
  // production. Daemon CALLER modules reach the store ONLY through the async
  // client (`run`/`callOrElse`/`fireAndForget`), never these modules directly.
  'store/context-store-worker.ts', // the worker entry point
  'store/context-store-op-handlers.ts', // shared op→handler map (worker + cold fallback)
  'context/memory-recall-core.ts', // worker-side recall leaf (collect/rank/redact)
  'context/memory-recall-bounded.ts', // worker-side L3 bounded recall RPC impl
  'context/memory-search.ts', // main-thread recall fallback (runs only when worker cold)
  // ── Documented single-owner exception ──
  // `recordTurnUsage` stays SYNCHRONOUS by design (audit finding A1: the deferred
  // path lost rows under SIGTERM races). Routing it through the worker would need
  // a guaranteed shutdown drain to preserve A1; until then it is a documented
  // limited exception (design Decision 5).
  'daemon/timeline-emitter.ts',
  // ── Non-daemon CLI ──
  'index.ts', // short-lived memory commands; worker spawn not warranted
];

// STRICT END STATE REACHED: every daemon CALLER module now reaches the store
// only through the async worker-client. This set is empty; the guard now
// enforces that no new direct importer appears outside PERMANENT_IMPORTERS.
export const TRANSITION_IMPORTERS = [];

const ALLOWED = new Set([...PERMANENT_IMPORTERS, ...TRANSITION_IMPORTERS]);

export const MEMORY_SEARCH_IMPORTERS = [
  'context/memory-recall-client.ts', // centralized R1/R5 facade owns the cold fallback
  'index.ts', // short-lived CLI memory commands
];
const MEMORY_SEARCH_ALLOWED = new Set(MEMORY_SEARCH_IMPORTERS);

// Matches a static `import`/`export … from '…/context-store.js'` clause (the
// part between the keyword and `from`) without crossing a previous statement's
// string literal or semicolon. Also detect dynamic + side-effect imports.
// Targets `…/context-store.js` but NOT `context-store-worker.js` /
// `context-store-worker-client.js` / `context-store-op-handlers.js` / `…-rpc.js`.
const STATIC_RE = /\b(?:import|export)\s+([^'";]*?)\s+from\s*['"][^'"]*\/context-store\.js['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"][^'"]*\/context-store\.js['"]/;
const SIDE_EFFECT_RE = /\bimport\s+['"][^'"]*\/context-store\.js['"]/;
const MEMORY_SEARCH_STATIC_RE = /\b(?:import|export)\s+([^'";]*?)\s+from\s*['"][^'"]*\/memory-search\.js['"]/g;
const MEMORY_SEARCH_DYNAMIC_RE = /\bimport\s*\(\s*['"][^'"]*\/memory-search\.js['"]/;
const MEMORY_SEARCH_SIDE_EFFECT_RE = /\bimport\s+['"][^'"]*\/memory-search\.js['"]/;

/** A `type`-only import/export clause has NO runtime effect (it is erased at
 *  compile time and opens no DB connection), so it is NOT a freeze-risk importer
 *  and is exempt from the guard. Handles `import type {…}` / `export type {…}`
 *  and the inline-qualified `{ type A, type B }` form. */
function isTypeOnlyClause(clause) {
  if (/^type\b/.test(clause)) return true;
  const brace = clause.match(/^\{([^}]*)\}$/);
  if (brace) {
    const specs = brace[1].split(',').map((s) => s.trim()).filter(Boolean);
    return specs.length > 0 && specs.every((s) => /^type\s/.test(s));
  }
  return false;
}

/** True if the file imports `context-store.js` in a way that has RUNTIME effect
 *  (a value/namespace/default import, a re-export, or a dynamic/side-effect
 *  import) — type-only imports are ignored. */
function hasRuntimeStoreImport(file) {
  return hasRuntimeImport(file, STATIC_RE, DYNAMIC_RE, SIDE_EFFECT_RE);
}

function hasRuntimeMemorySearchImport(file) {
  return hasRuntimeImport(file, MEMORY_SEARCH_STATIC_RE, MEMORY_SEARCH_DYNAMIC_RE, MEMORY_SEARCH_SIDE_EFFECT_RE);
}

function hasRuntimeImport(file, staticRe, dynamicRe, sideEffectRe) {
  const src = readFileSync(file, 'utf8');
  if (dynamicRe.test(src) || sideEffectRe.test(src)) return true;
  staticRe.lastIndex = 0;
  let m;
  while ((m = staticRe.exec(src)) !== null) {
    if (!isTypeOnlyClause(m[1].trim())) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function relOf(file) {
  return relative(srcRoot, file).split('\\').join('/');
}

/** Files that import the sync store at RUNTIME but are NOT in the allowlist. */
export function findSyncContextStoreViolations() {
  return walk(srcRoot)
    .filter((file) => hasRuntimeStoreImport(file))
    .map(relOf)
    .filter((rel) => !ALLOWED.has(rel))
    .sort();
}

export function findSyncMemorySearchViolations() {
  return walk(srcRoot)
    .filter((file) => hasRuntimeMemorySearchImport(file))
    .map(relOf)
    .filter((rel) => !MEMORY_SEARCH_ALLOWED.has(rel))
    .sort();
}

/** TRANSITION entries that no longer import the sync store at runtime (stale —
 *  should be removed from the list as the module finished migrating). */
export function findStaleTransitionEntries() {
  const importing = new Set(walk(srcRoot).filter(hasRuntimeStoreImport).map(relOf));
  return TRANSITION_IMPORTERS.filter((rel) => !importing.has(rel)).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findSyncContextStoreViolations();
  const memorySearchViolations = findSyncMemorySearchViolations();
  const stale = findStaleTransitionEntries();
  if (violations.length > 0) {
    console.error('FAIL: daemon production modules must use the async context-store-worker-client,');
    console.error('not import src/store/context-store.js directly. Unexpected direct importers:');
    for (const v of violations) console.error(`  - src/${v}`);
    process.exit(1);
  }
  if (memorySearchViolations.length > 0) {
    console.error('FAIL: daemon production modules must not import src/context/memory-search.js directly;');
    console.error('use the R1/R5 worker facades in memory-recall-client instead. Unexpected importers:');
    for (const v of memorySearchViolations) console.error(`  - src/${v}`);
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error('FAIL: these TRANSITION allowlist entries no longer import the store — remove them');
    console.error('from TRANSITION_IMPORTERS (they have finished migrating):');
    for (const s of stale) console.error(`  - src/${s}`);
    process.exit(1);
  }
  const endState = TRANSITION_IMPORTERS.length === 0 ? ' [STRICT END STATE]' : '';
  console.log(
    `lint-no-sync-context-store: OK — ${PERMANENT_IMPORTERS.length} permanent + ` +
      `${TRANSITION_IMPORTERS.length} transition importers${endState}. ` +
      'Daemon caller modules reach the store ONLY through the async worker-client.',
  );
}
