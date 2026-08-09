import type { ContextNamespace } from '../../shared/context-types.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import { normalizeDaemonLocalMemoryNamespace } from '../../shared/memory-namespace.js';
import { MEMORY_SHORT_REF_HEALTH_ERROR_MAX_CHARS, type MemoryShortRefHealth } from '../../shared/memory-short-ref-health.js';
import { createHash } from 'node:crypto';
import { encodeBase32 } from '../util/base32.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import logger from '../util/logger.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type MemoryShortRefKind = 'projection' | 'observation';

export interface MemoryShortRefEntry {
  kind: MemoryShortRefKind;
  id: string;
  namespace?: ContextNamespace;
  lastSeenAt?: number;
}

const MAX_SHORT_REF_ENTRIES = 10_000;

/**
 * base32 characters kept from the md5 digest. 5 bits per character, so 13 chars
 * ≈ 65 bits: a birthday collision needs ~6e9 distinct ids in one namespace,
 * versus the previous 40-bit handle which collided at ~0.5% by 100k ids.
 * Collisions here are not benign — a handle that maps to several records
 * resolves to an arbitrary one, i.e. the agent silently fetches the WRONG
 * memory. base32 carries the same 65 bits in 13 chars that hex needs 16 for.
 */
const MEMORY_SHORT_REF_LENGTH = 13;

/** Bumped whenever the ref derivation changes, so cached refs from an older
 *  algorithm are dropped instead of resolving to a stale/wrong record. */
const SHORT_REF_SCHEMA_VERSION = 2;
const entriesByRef = new Map<string, MemoryShortRefEntry[]>();
const persistedRefHydrations = new Map<string, Promise<number>>();
let persistedLoaded = false;
let shortRefHealth: MemoryShortRefHealth | undefined;

interface MemoryShortRefStoreRow {
  ref: string;
  kind: MemoryShortRefKind;
  id: string;
  namespaceKey: string;
  namespaceJson: string | null;
  lastSeenAt: number;
}

const SHORT_REF_STORE_BATCH_SIZE = 250;
const SHORT_REF_STORE_RETRY_BASE_MS = 1_000;
const SHORT_REF_STORE_RETRY_MAX_MS = 60_000;
const pendingStoreRows = new Map<string, MemoryShortRefStoreRow>();
let storeFlushPromise: Promise<void> | null = null;
let storeRetryTimer: NodeJS.Timeout | null = null;
let storeRetryAttempt = 0;
let shortRefStateGeneration = 0;

function refPrefix(kind: MemoryShortRefKind): 'proj' | 'obs' {
  return kind === 'projection' ? 'proj' : 'obs';
}

function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

function namespaceKey(namespace: ContextNamespace | undefined): string {
  if (!namespace) return '';
  return [
    namespace.scope,
    namespace.userId ?? '',
    namespace.projectId ?? '',
    namespace.workspaceId ?? '',
    namespace.enterpriseId ?? '',
  ].join('\u0000');
}

function sameNamespace(a: ContextNamespace | undefined, b: ContextNamespace | undefined): boolean {
  return namespaceKey(a) === namespaceKey(b);
}

/**
 * Namespace key for the persisted row.
 *
 * `namespaceKey()` separates fields with NUL, which is fine in memory. Older
 * node:sqlite versions returned only the leading scope when reading it as TEXT;
 * current versions return the complete string. The bytes are stored intact and
 * the primary key was never affected, but the version-dependent read shape is a
 * poor persisted identity. JSON keeps the same field order with no embedded NUL
 * and round-trips consistently.
 */
function namespaceStorageKey(namespace: ContextNamespace | undefined): string {
  if (!namespace) return '';
  return JSON.stringify([
    namespace.scope,
    namespace.userId ?? '',
    namespace.projectId ?? '',
    namespace.workspaceId ?? '',
    namespace.enterpriseId ?? '',
  ]);
}

function pruneShortRefs(): void {
  let count = 0;
  for (const bucket of entriesByRef.values()) count += bucket.length;
  if (count <= MAX_SHORT_REF_ENTRIES) return;
  const flattened: Array<{ ref: string; entry: MemoryShortRefEntry }> = [];
  for (const [ref, bucket] of entriesByRef) {
    for (const entry of bucket) flattened.push({ ref, entry });
  }
  flattened.sort((a, b) => (a.entry.lastSeenAt ?? 0) - (b.entry.lastSeenAt ?? 0));
  for (const victim of flattened.slice(0, count - MAX_SHORT_REF_ENTRIES)) {
    const bucket = entriesByRef.get(victim.ref);
    if (!bucket) continue;
    const next = bucket.filter((entry) => entry !== victim.entry);
    if (next.length === 0) entriesByRef.delete(victim.ref);
    else entriesByRef.set(victim.ref, next);
  }
}

/**
 * JSON file target, or undefined to use the context store.
 *
 * ONLY an explicit `IMCODES_MEMORY_SHORT_REF_PATH` selects the file. The default
 * — including production — is the store.
 *
 * This used to fall back to `~/.imcodes/memory-short-refs.json` whenever the
 * process wasn't a test, which inverted the intended routing: tests took the
 * store path while real daemons kept writing the JSON file, so the migration off
 * that file (and the failure reporting added alongside it) never executed
 * anywhere it mattered. Handles written to that file while it was still the
 * write target are carried over once by importLegacyShortRefFile().
 */
function shortRefStorePath(): string | undefined {
  const configured = process.env.IMCODES_MEMORY_SHORT_REF_PATH?.trim();
  return configured ? configured : undefined;
}

/**
 * Where the retired JSON cache lives. Read-only: handles are only ever written
 * to the store now. Overridable so tests never read the developer's real file.
 */
function legacyShortRefFilePath(): string {
  const configured = process.env.IMCODES_MEMORY_SHORT_REF_LEGACY_PATH?.trim();
  return configured ? configured : join(homedir(), '.imcodes', 'memory-short-refs.json');
}

/**
 * One-way bridge off the retired JSON cache.
 *
 * Handles written while persistence still went to a file are valid, so import
 * them into the store on the first warm-load rather than stranding them until
 * their memory happens to be injected again. Strictly read-only, and the file is
 * left in place as a manual recovery point — it is simply never written again.
 * The counter shows when this stops finding anything, which is when the file can
 * be dropped for good.
 */
function importLegacyShortRefFile(): Array<{ ref: string; entry: MemoryShortRefEntry }> {
  const path = legacyShortRefFilePath();
  const imported: Array<{ ref: string; entry: MemoryShortRefEntry }> = [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; entries?: unknown[] };
    // Older derivations produced handles that denote different records now, so
    // rejecting that whole file is expected and stays quiet.
    if (parsed.schemaVersion !== SHORT_REF_SCHEMA_VERSION) return imported;
    // A current-schema file whose entries are not an array is corrupt, and every
    // handle in it vanishes — that is a failure, not a steady state.
    if (!Array.isArray(parsed.entries)) {
      reportShortRefFailure('load_file', new Error('legacy cache entries is not an array'), { path, legacy: true });
      return imported;
    }
    let discarded = 0;
    for (const raw of parsed.entries) {
      const normalized = normalizeEntry(raw);
      if (!normalized) { discarded += 1; continue; }
      const bucket = entriesByRef.get(normalized.ref) ?? [];
      if (bucket.some((entry) => entry.kind === normalized.entry.kind
        && entry.id === normalized.entry.id
        && sameNamespace(entry.namespace, normalized.entry.namespace))) continue;
      bucket.push(normalized.entry);
      entriesByRef.set(normalized.ref, bucket);
      imported.push(normalized);
    }
    reportDiscardedShortRefRows('legacy_file', discarded);
    if (imported.length > 0) {
      incrementCounter('mem.short_ref.legacy_import', { source: 'json_file' });
      // The counter lives in an in-process map that a restart clears, so the
      // "has this stopped finding anything yet" question needs a durable line
      // in the log too — that is the signal for retiring the fallback.
      logger.info({ imported: imported.length, path }, 'memory short-ref: imported handles from the retired JSON cache');
    }
  } catch (error) {
    // A missing file is the expected steady state once everyone has migrated.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      reportShortRefFailure('load_file', error, { path, legacy: true });
    }
  }
  return imported;
}

function isMemoryShortRefKind(value: unknown): value is MemoryShortRefKind {
  return value === 'projection' || value === 'observation';
}

/** Namespace identity fields; every one must be a string when present. */
const NAMESPACE_IDENTITY_FIELDS = [
  'projectId', 'userId', 'workspaceId', 'enterpriseId', 'localTenant', 'canonicalRepoId',
] as const;

/**
 * Decode a stored namespace, refusing anything it cannot fully validate.
 *
 * `{ ok: false }` means the row carried a namespace that is not usable, and the
 * caller must discard the whole row. Degrading such a row to namespace-less
 * instead — which an earlier `scope is a non-empty string` check did — loads an
 * entry that looks healthy but can never resolve for a namespaced caller, and
 * counts it as loaded, so the handle disappears with no signal at all.
 */
function decodeNamespace(
  raw: unknown,
): { ok: true; namespace: ContextNamespace | undefined; preBackfillNamespace?: ContextNamespace } | { ok: false } {
  // Only a value that is not there at all means "no namespace". An explicit
  // null — including a column holding the JSON text `null` — is a value that
  // failed to describe a namespace, and degrading it to namespace-less loads a
  // handle no namespaced caller can ever reach.
  if (raw === undefined) return { ok: true, namespace: undefined };
  if (raw === null || typeof raw !== 'object') return { ok: false };
  const record = raw as Record<string, unknown>;
  if (!isMemoryScope(record.scope)) return { ok: false };
  for (const field of NAMESPACE_IDENTITY_FIELDS) {
    const value = record[field];
    if (value !== undefined && typeof value !== 'string') return { ok: false };
  }
  // A scope also dictates which identity fields must be present and which are
  // forbidden. `{ scope: 'personal' }` with no userId/projectId is structurally
  // fine but names no actual namespace, so it would resolve for nobody.
  //
  // Owner-private rows written before registration filled the owner in have no
  // `userId`, and `personal` requires one — so they failed validation and were
  // DISCARDED at every daemon start. That silently destroyed 290 of 302 stored
  // handles on a real machine. This store is per-device and a device has exactly
  // one owner, so an owner-less owner-private row is not ambiguous: it belongs to
  // this daemon. Backfill the sentinel and keep the row instead of dropping the
  // user's memory handles on a technicality.
  const rawNamespace = record as unknown as ContextNamespace;
  const namespace = normalizeDaemonLocalMemoryNamespace(rawNamespace);
  // Hand back the PRE-backfill namespace rather than a boolean, so the loader can
  // rebuild the key this row was actually written with instead of assuming the
  // absent owner was the empty string. The helper treats a whitespace-only owner
  // as missing too, and a row that stored `" "` in both its JSON and its key was
  // being discarded because the reconstruction guessed `''`. Carrying the real
  // value removes the guess.
  const ownerBackfilled = namespace !== rawNamespace;
  const identity = {
    user_id: namespace.userId,
    project_id: namespace.projectId,
    workspace_id: namespace.workspaceId,
    org_id: namespace.enterpriseId,
    tenant_id: namespace.localTenant,
  };
  if (!validateMemoryScopeIdentity(record.scope, identity).ok) return { ok: false };
  return { ok: true, namespace, ...(ownerBackfilled ? { preBackfillNamespace: rawNamespace } : {}) };
}

function isContextNamespace(value: unknown): value is ContextNamespace {
  const decoded = decodeNamespace(value);
  return decoded.ok && decoded.namespace !== undefined;
}

function normalizeEntry(raw: unknown): { ref: string; entry: MemoryShortRefEntry } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const ref = typeof record.ref === 'string' ? normalizeRef(record.ref) : undefined;
  const kind = record.kind;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
  if (!ref || !isMemoryShortRefKind(kind) || !id) return undefined;
  // A row that carries a namespace it cannot validate is discarded, never
  // silently loaded namespace-less.
  const decodedNamespace = decodeNamespace(record.namespace);
  if (!decodedNamespace.ok) return undefined;
  const namespace = decodedNamespace.namespace;
  const lastSeenAt = typeof record.lastSeenAt === 'number' && Number.isFinite(record.lastSeenAt)
    ? record.lastSeenAt
    : undefined;
  return {
    ref,
    entry: { kind, id, namespace, lastSeenAt },
  };
}

function ensurePersistedLoaded(): void {
  if (persistedLoaded) return;
  persistedLoaded = true;
  const path = shortRefStorePath();
  if (!path) return;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; entries?: unknown[] };
    // Refs cached by an older derivation must NOT be trusted: the same ref
    // string can denote a different record under the new algorithm, which would
    // resolve to the wrong memory. Drop the whole file and re-register lazily.
    if (parsed.schemaVersion !== SHORT_REF_SCHEMA_VERSION) return;
    // Current schema with non-array entries is corruption, not an empty cache:
    // every handle in the file disappears, so it has to be reported.
    if (!Array.isArray(parsed.entries)) {
      reportShortRefFailure('load_file', new Error('cache entries is not an array'), { path });
      return;
    }
    let discarded = 0;
    for (const raw of parsed.entries) {
      const normalized = normalizeEntry(raw);
      if (!normalized) { discarded += 1; continue; }
      const bucket = entriesByRef.get(normalized.ref) ?? [];
      if (!bucket.some((entry) => entry.kind === normalized.entry.kind
        && entry.id === normalized.entry.id
        && sameNamespace(entry.namespace, normalized.entry.namespace))) {
        bucket.push(normalized.entry);
        entriesByRef.set(normalized.ref, bucket);
      }
    }
    reportDiscardedShortRefRows('json_file', discarded);
    pruneShortRefs();
  } catch (error) {
    // A missing file is the normal first run. Anything else — unreadable, or
    // corrupt JSON — silently strands every handle written before this start,
    // which is the same invisible failure this module exists to avoid.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    reportShortRefFailure('load_file', error, { path });
  }
}

function persistShortRefsToFile(): void {
  const path = shortRefStorePath();
  if (!path) return;
  const entries: Array<{ ref: string } & MemoryShortRefEntry> = [];
  for (const [ref, bucket] of entriesByRef) {
    for (const entry of bucket) entries.push({ ref, ...entry });
  }
  entries.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: SHORT_REF_SCHEMA_VERSION,
      entries: entries.slice(0, MAX_SHORT_REF_ENTRIES),
    }), 'utf8');
    // The file branch rewrites the complete in-memory index, so one successful
    // write also repairs every handle covered by a prior failed write.
    if (shortRefHealth?.stage === 'persist_file') shortRefHealth = undefined;
  } catch (error) {
    // Non-fatal, but never silent: an unwritable file is exactly how handles
    // used to disappear without a trace.
    reportShortRefFailure('persist_file', error, { path });
  }
}

/**
 * A handle that fails to persist still resolves in this process but dies on the
 * next restart, so every such failure gets a fixed-cardinality counter and an
 * hourly-throttled warning. `stage` is a constant per call site — error text and
 * volatile fields stay in the warning payload, never in metric labels.
 */
/** Rows dropped while loading are a silent form of handle loss, so count them
 *  under a fixed-cardinality source and warn once per hour. */
function reportDiscardedShortRefRows(
  source: 'warm_load' | 'hydrate_ref' | 'legacy_file' | 'json_file',
  discarded: number,
): void {
  if (discarded <= 0) return;
  incrementCounter('mem.short_ref.discarded_row', { source });
  warnOncePerHour(`mem.short_ref.discarded_row.${source}`, { discarded });
  // Discarded rows are handle loss too: those memories stop being reachable by
  // handle after a restart. Route them to the same off-box signal as write and
  // load failures instead of leaving them in machine-local counters.
  recordShortRefFailure(`discarded_${source}`, `${discarded} unusable row(s) discarded`);
}

function reportShortRefFailure(
  stage: 'persist_store' | 'persist_file' | 'warm_load' | 'hydrate_ref' | 'load_file',
  error: unknown,
  extra: Record<string, unknown> = {},
): void {
  const message = error instanceof Error ? error.message : String(error);
  incrementCounter('mem.short_ref.persist_failure', { stage });
  warnOncePerHour(`mem.short_ref.persist_failure.${stage}`, { ...extra, error: message });
  // Both signals above stay on this machine: the counter is a process-local map
  // and the warning lands in the daemon log, on the same disk whose exhaustion
  // is usually what failed — with write errors swallowed. Hold the failure in
  // memory so the heartbeat can carry it off the box over the socket instead.
  recordShortRefFailure(stage, message);
}

function recordShortRefFailure(stage: string, message: string): void {
  shortRefHealth = {
    stage,
    failures: (shortRefHealth?.failures ?? 0) + 1,
    lastFailureAt: Date.now(),
    lastError: message.slice(0, MEMORY_SHORT_REF_HEALTH_ERROR_MAX_CHARS),
  };
}

function storeRowKey(row: MemoryShortRefStoreRow): string {
  return JSON.stringify([row.ref, row.kind, row.id, row.namespaceKey]);
}

function clearRecoveredStoreHealth(): void {
  if (pendingStoreRows.size === 0 && shortRefHealth?.stage === 'persist_store') {
    shortRefHealth = undefined;
  }
}

function scheduleStoreRetry(generation: number): void {
  if (generation !== shortRefStateGeneration || storeRetryTimer || pendingStoreRows.size === 0) return;
  const exponent = Math.max(0, storeRetryAttempt - 1);
  const delay = Math.min(SHORT_REF_STORE_RETRY_BASE_MS * (2 ** Math.min(exponent, 10)), SHORT_REF_STORE_RETRY_MAX_MS);
  storeRetryTimer = setTimeout(() => {
    storeRetryTimer = null;
    flushPendingStoreRows();
  }, delay);
  if (typeof storeRetryTimer.unref === 'function') storeRetryTimer.unref();
}

function flushPendingStoreRows(): void {
  if (storeFlushPromise || storeRetryTimer || pendingStoreRows.size === 0) {
    clearRecoveredStoreHealth();
    return;
  }
  const generation = shortRefStateGeneration;
  const batch = [...pendingStoreRows.entries()].slice(0, SHORT_REF_STORE_BATCH_SIZE);
  let succeeded = false;
  let operation!: Promise<void>;
  operation = getContextStoreClient()
    .run('upsertMemoryShortRefs', [batch.map(([, row]) => row)])
    .then(() => {
      if (generation !== shortRefStateGeneration) return;
      succeeded = true;
      storeRetryAttempt = 0;
      for (const [key, row] of batch) {
        // A newer registration for the same identity may have refreshed
        // lastSeenAt while this batch was in flight. Keep that newer row queued.
        if (pendingStoreRows.get(key) === row) pendingStoreRows.delete(key);
      }
      clearRecoveredStoreHealth();
    })
    .catch((error: unknown) => {
      if (generation !== shortRefStateGeneration) return;
      storeRetryAttempt += 1;
      // Keep the exact failed rows queued. A later successful retry is what
      // makes these already-issued handles durable and clears the heartbeat.
      reportShortRefFailure('persist_store', error, { rows: batch.length });
    })
    .finally(() => {
      if (generation !== shortRefStateGeneration || storeFlushPromise !== operation) return;
      storeFlushPromise = null;
      if (pendingStoreRows.size === 0) {
        clearRecoveredStoreHealth();
      } else if (succeeded) {
        // Drain a large backlog batch-by-batch without a timer delay once the
        // worker has proved healthy again.
        queueMicrotask(flushPendingStoreRows);
      } else {
        scheduleStoreRetry(generation);
      }
    });
  storeFlushPromise = operation;
}

/**
 * Latest unresolved persistence failure, or undefined while healthy. Store
 * write failures remain visible until the retained rows have all been retried
 * successfully, so reconnecting readers see a real standing fault rather than
 * either a missed edge or a stale, already-repaired incident.
 */
export function getMemoryShortRefHealth(): MemoryShortRefHealth | undefined {
  return shortRefHealth;
}

/**
 * Persist the handles just registered.
 *
 * Default path is the context store (SQLite): an incremental upsert of only the
 * touched rows, rather than rewriting a whole JSON file on every registration —
 * that rewrite silently stopped persisting anything once the disk filled up,
 * because the write error was swallowed. Fire-and-forget so the synchronous
 * registration path (called from render functions) never blocks on I/O.
 *
 * `IMCODES_MEMORY_SHORT_REF_PATH` still selects the JSON file, which keeps tests
 * hermetic and gives a debuggable plain-text dump.
 */
function persistShortRefs(touched: ReadonlyArray<{ ref: string; entry: MemoryShortRefEntry }>): void {
  if (shortRefStorePath()) {
    persistShortRefsToFile();
    return;
  }
  if (touched.length === 0) return;
  const rows: MemoryShortRefStoreRow[] = touched.map(({ ref, entry }) => ({
    ref,
    kind: entry.kind,
    id: entry.id,
    namespaceKey: namespaceStorageKey(entry.namespace),
    namespaceJson: entry.namespace ? JSON.stringify(entry.namespace) : null,
    lastSeenAt: entry.lastSeenAt ?? Date.now(),
  }));
  for (const row of rows) pendingStoreRows.set(storeRowKey(row), row);
  // Registration stays synchronous/non-fatal. The async flusher retains failed
  // rows and retries with bounded backoff until every issued handle is durable.
  flushPendingStoreRows();
}

function normalizePersistedShortRefRow(
  row: Record<string, unknown>,
): { ref: string; entry: MemoryShortRefEntry } | undefined {
  // A row that stored a namespace but can no longer produce one must be
  // dropped, not loaded namespace-less: the entry would look healthy while
  // being unresolvable for every namespaced caller — silent handle loss
  // wearing the shape of a successful load.
  const namespaceColumnPresent = typeof row.namespaceJson === 'string' && row.namespaceJson.trim().length > 0;
  const parsed = namespaceColumnPresent ? safeParseNamespace(row.namespaceJson as string) : undefined;
  if (namespaceColumnPresent && parsed === undefined) return undefined;
  const decoded = decodeNamespace(parsed);
  if (!decoded.ok) return undefined;
  const namespace = decoded.namespace;
  // namespace_key records what the row was written under; a disagreement
  // means the row's identity is corrupt and loading it would file the handle
  // under the wrong namespace.
  //
  // Rows written before the key became a JSON tuple used NUL-separated
  // fields. Older node:sqlite versions truncate that TEXT value at the
  // first NUL when converting it to a JS string, while current versions
  // return the complete string. Accept both read-back shapes so upgrading
  // Node cannot discard every handle written before the key migration.
  const storedNamespaceKey = typeof row.namespaceKey === 'string' ? row.namespaceKey : '';
  const legacyNamespaceKey = namespaceKey(namespace);
  const legacyTruncatedKey = namespace ? namespace.scope : '';
  // Rows written before the owner was made explicit recorded their key WITHOUT
  // it, so the keys recomputed from the backfilled namespace no longer match.
  // Accept that shape ONLY when decodeNamespace actually backfilled the owner.
  const preBackfillNamespace = decoded.preBackfillNamespace;
  if (storedNamespaceKey !== namespaceStorageKey(namespace)
    && storedNamespaceKey !== legacyNamespaceKey
    && storedNamespaceKey !== legacyTruncatedKey
    && !(preBackfillNamespace
      && (storedNamespaceKey === namespaceStorageKey(preBackfillNamespace)
        || storedNamespaceKey === namespaceKey(preBackfillNamespace)))) {
    return undefined;
  }
  return normalizeEntry({
    ref: row.ref,
    kind: row.kind,
    id: row.id,
    lastSeenAt: row.lastSeenAt,
    namespace,
  });
}

function mergePersistedShortRefRows(
  rows: readonly Record<string, unknown>[],
  options: { touchLastSeenAt?: boolean } = {},
): { loaded: number; discarded: number } {
  let loaded = 0;
  let discarded = 0;
  const touchedAt = options.touchLastSeenAt ? Date.now() : undefined;
  for (const row of rows) {
    const normalized = normalizePersistedShortRefRow(row);
    if (!normalized) {
      discarded += 1;
      continue;
    }
    if (touchedAt !== undefined) normalized.entry.lastSeenAt = touchedAt;
    const bucket = entriesByRef.get(normalized.ref) ?? [];
    if (bucket.some((entry) => entry.kind === normalized.entry.kind
      && entry.id === normalized.entry.id
      && sameNamespace(entry.namespace, normalized.entry.namespace))) continue;
    bucket.push(normalized.entry);
    entriesByRef.set(normalized.ref, bucket);
    loaded += 1;
  }
  return { loaded, discarded };
}

/**
 * Warm the in-memory index from the context store once at daemon startup.
 *
 * Synchronous render paths continue to use this warm index. Independent MCP
 * processes additionally perform an indexed SQLite lookup on a local miss,
 * because another process can persist a handle after this warm-load finishes.
 */
export async function loadMemoryShortRefsFromStore(): Promise<number> {
  if (shortRefStorePath()) return 0;
  try {
    const rows = await getContextStoreClient()
      .run<Array<Record<string, unknown>>>('listMemoryShortRefs', [MAX_SHORT_REF_ENTRIES]);
    if (!Array.isArray(rows)) {
      // Contract violation rather than an ordinary failure, but the effect is
      // the same as a failed load — report instead of returning a 0 that reads
      // as "nothing stored".
      reportShortRefFailure('warm_load', new Error('listMemoryShortRefs returned a non-array response'));
      return 0;
    }
    const merged = mergePersistedShortRefRows(rows);
    let loaded = merged.loaded;
    // A well-formed array of malformed rows loads nothing and leaves every
    // earlier handle unresolvable — indistinguishable from an empty store
    // unless the discards are reported.
    reportDiscardedShortRefRows('warm_load', merged.discarded);
    // Carry over anything still only in the retired JSON cache, and write it to
    // the store so the next start no longer depends on that file.
    const legacy = importLegacyShortRefFile();
    if (legacy.length > 0) persistShortRefs(legacy);
    loaded += legacy.length;
    pruneShortRefs();
    persistedLoaded = true;
    return loaded;
  } catch (error) {
    // A failed warm-load means every handle issued before this restart is
    // unresolvable for the life of the process — report rather than return a
    // zero that is indistinguishable from "nothing stored".
    reportShortRefFailure('warm_load', error);
    return 0;
  }
}

function safeParseNamespace(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Derive the compact handle for an id.
 *
 * A hash prefix — NOT a prefix of the id itself. The previous algorithm kept the
 * first 10 hex-looking characters of the id, which scavenged them from arbitrary
 * positions across the string. For structured ids such as
 * `md-ingest:personal::::::::local/<hash>:CLAUDE.md:<sha256>` every record that
 * shares the constant prefix collapsed onto the SAME ref (the discriminating
 * sha256 sits past the 10th kept character), so one ref mapped to dozens of
 * records and resolution silently picked whichever was newest.
 *
 * A digest gives a uniform distribution for ANY id shape. Being a pure function
 * of the id also means the handle is reproducible: the same memory always yields
 * the same handle across sessions, restarts and machines, so the ref→id table is
 * a REBUILDABLE index rather than the only source of truth (a random handle
 * would be permanently dead if that table were ever lost). md5 is used purely
 * as a fast non-cryptographic digest here, never for security.
 */
export function makeMemoryShortRef(kind: MemoryShortRefKind, id: string): string {
  const digest = createHash('md5').update(id, 'utf8').digest();
  const compact = encodeBase32(digest).slice(0, MEMORY_SHORT_REF_LENGTH);
  return `${refPrefix(kind)}:${compact}`;
}

function registerMemoryShortRefWithoutPersist(entry: MemoryShortRefEntry): string {
  const ref = normalizeRef(makeMemoryShortRef(entry.kind, entry.id));
  const bucket = entriesByRef.get(ref) ?? [];
  const nextEntry = { ...entry, lastSeenAt: entry.lastSeenAt ?? Date.now() };
  const next = bucket.filter((existing) => existing.kind !== entry.kind
    || existing.id !== entry.id
    || !sameNamespace(existing.namespace, entry.namespace));
  next.push(nextEntry);
  entriesByRef.set(ref, next);
  return ref;
}

export function registerMemoryShortRef(entry: MemoryShortRefEntry): string {
  ensurePersistedLoaded();
  const ref = registerMemoryShortRefWithoutPersist(entry);
  pruneShortRefs();
  persistShortRefs([{ ref, entry }]);
  return ref;
}

/**
 * Batch variant for surfaces that register many refs at once (startup/recall
 * memory injection registers every injected item so the agent can redeem the
 * ref via get_memory_sources). Persists ONCE instead of per entry — the
 * per-entry path rewrites the whole cache file, which would otherwise mean N
 * full-file writes on the session send path.
 */
export function registerMemoryShortRefs(entries: readonly MemoryShortRefEntry[]): string[] {
  ensurePersistedLoaded();
  const refs = entries.map((entry) => registerMemoryShortRefWithoutPersist(entry));
  if (refs.length > 0) {
    pruneShortRefs();
    persistShortRefs(refs.map((ref, index) => ({ ref, entry: entries[index]! })));
  }
  return refs;
}

/**
 * Every record in this namespace that derived `ref` — normally one.
 *
 * Registration keys entries by (kind, id, namespace), so two survivors mean a
 * genuine digest collision. Rather than silently answering with one of them,
 * read paths can surface both and let the caller pick; a 65-bit collision should
 * never occur, so it is also counted and warned about.
 */
export function resolveMemoryShortRefCandidates(ref: string, namespace: ContextNamespace): MemoryShortRefEntry[] {
  ensurePersistedLoaded();
  const bucket = entriesByRef.get(normalizeRef(ref));
  if (!bucket || bucket.length === 0) return [];
  const sameNs = bucket.filter((entry) => sameNamespace(entry.namespace, namespace));
  if (sameNs.length > 1) {
    incrementCounter('mem.short_ref.collision', { kind: sameNs[0]!.kind });
    warnOncePerHour('mem.short_ref.collision', {
      ref: normalizeRef(ref),
      ids: sameNs.map((entry) => entry.id).slice(0, 4),
    });
  }
  return sameNs;
}

export function resolveMemoryShortRef(ref: string, namespace?: ContextNamespace): MemoryShortRefEntry | undefined {
  ensurePersistedLoaded();
  const bucket = entriesByRef.get(normalizeRef(ref));
  if (!bucket || bucket.length === 0) return undefined;
  if (namespace) {
    const sameNs = resolveMemoryShortRefCandidates(ref, namespace);
    // More than one survivor means two different records genuinely derived the
    // same handle. Callers that ACT on the result (archive/delete/update) must
    // never operate on a guess, so this strict accessor refuses. Read paths can
    // use resolveMemoryShortRefCandidates and present the alternatives instead.
    if (sameNs.length > 1) return undefined;
    const exact = sameNs[0];
    if (exact) return exact;
  }
  // Cross-namespace isolation: a handle registered under another namespace must
  // NOT resolve here, even when it is the only entry for this ref. Callers other
  // than get_memory_sources (archive/delete/update) also resolve refs, so this
  // stays the strict boundary rather than deferring to a downstream check.
  if (namespace) return undefined;
  return bucket.length === 1 ? bucket[0] : undefined;
}

/**
 * Hydrate one handle from SQLite after an in-process miss.
 *
 * The memory MCP server is a separate, long-lived process. Startup/recall can
 * persist new handles from the daemon after the MCP process has populated its
 * local Map, so a one-time warm-load cannot keep the two processes coherent.
 * Querying by exact ref uses the memory_short_refs primary-key prefix and avoids
 * rescanning the bounded warm-load window on every miss.
 */
async function hydrateMemoryShortRefFromStore(ref: string): Promise<number> {
  if (shortRefStorePath()) return 0;
  const normalizedRef = normalizeRef(ref);
  if (!normalizedRef) return 0;
  const existing = persistedRefHydrations.get(normalizedRef);
  if (existing) return existing;
  const hydration = (async () => {
    try {
      const rows = await getContextStoreClient()
        .run<Array<Record<string, unknown>>>('listMemoryShortRefsByRef', [normalizedRef]);
      if (!Array.isArray(rows)) {
        reportShortRefFailure('hydrate_ref', new Error('listMemoryShortRefsByRef returned a non-array response'), {
          ref: normalizedRef,
        });
        return 0;
      }
      // This ref is being actively redeemed. Promote hydrated rows in the
      // process-local LRU before pruning so an old persisted handle cannot be
      // inserted and immediately evicted while the index is at its 10k cap.
      const merged = mergePersistedShortRefRows(rows, { touchLastSeenAt: true });
      reportDiscardedShortRefRows('hydrate_ref', merged.discarded);
      pruneShortRefs();
      return merged.loaded;
    } catch (error) {
      reportShortRefFailure('hydrate_ref', error, { ref: normalizedRef });
      return 0;
    }
  })();
  persistedRefHydrations.set(normalizedRef, hydration);
  try {
    return await hydration;
  } finally {
    if (persistedRefHydrations.get(normalizedRef) === hydration) {
      persistedRefHydrations.delete(normalizedRef);
    }
  }
}

/**
 * Async resolver for MCP reads. It preserves the synchronous resolver's exact
 * namespace and collision semantics, adding only an indexed SQLite retry when
 * this process has no candidate in the caller namespace.
 */
export async function resolveMemoryShortRefCandidatesWithStore(
  ref: string,
  namespace: ContextNamespace,
): Promise<MemoryShortRefEntry[]> {
  const candidates = resolveMemoryShortRefCandidates(ref, namespace);
  if (candidates.length > 0) return candidates;
  await hydrateMemoryShortRefFromStore(ref);
  return resolveMemoryShortRefCandidates(ref, namespace);
}

/**
 * Strict async resolver for MCP mutations. Ambiguous handles and handles from a
 * different namespace remain unresolved; the store lookup never authorizes a
 * cross-namespace fallback.
 */
export async function resolveMemoryShortRefWithStore(
  ref: string,
  namespace?: ContextNamespace,
): Promise<MemoryShortRefEntry | undefined> {
  const resolved = resolveMemoryShortRef(ref, namespace);
  if (resolved) return resolved;
  await hydrateMemoryShortRefFromStore(ref);
  return resolveMemoryShortRef(ref, namespace);
}

/**
 * Force several records onto one handle. A 65-bit digest collision cannot be
 * produced by registering real ids, so the ambiguous-handle paths would
 * otherwise be untestable above the resolver.
 */
export function seedMemoryShortRefCollisionForTests(ref: string, entries: readonly MemoryShortRefEntry[]): void {
  ensurePersistedLoaded();
  entriesByRef.set(normalizeRef(ref), entries.map((entry) => ({ ...entry, lastSeenAt: entry.lastSeenAt ?? Date.now() })));
}

export function resetMemoryShortRefsForTests(): void {
  shortRefStateGeneration += 1;
  if (storeRetryTimer) clearTimeout(storeRetryTimer);
  storeRetryTimer = null;
  storeFlushPromise = null;
  storeRetryAttempt = 0;
  pendingStoreRows.clear();
  entriesByRef.clear();
  persistedRefHydrations.clear();
  shortRefHealth = undefined;
  persistedLoaded = true;
}

export function reloadMemoryShortRefsForTests(): void {
  entriesByRef.clear();
  persistedRefHydrations.clear();
  persistedLoaded = false;
  ensurePersistedLoaded();
}
