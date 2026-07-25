import type { ContextNamespace } from '../../shared/context-types.js';
import { createHash } from 'node:crypto';
import { encodeBase32 } from '../util/base32.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
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
let persistedLoaded = false;

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
 * anywhere it mattered. Handles are a pure function of the id and re-register on
 * the next injection, so no import of the legacy file is needed.
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
    // Older derivations produced handles that denote different records now.
    if (parsed.schemaVersion !== SHORT_REF_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return imported;
    for (const raw of parsed.entries) {
      const normalized = normalizeEntry(raw);
      if (!normalized) continue;
      const bucket = entriesByRef.get(normalized.ref) ?? [];
      if (bucket.some((entry) => entry.kind === normalized.entry.kind
        && entry.id === normalized.entry.id
        && sameNamespace(entry.namespace, normalized.entry.namespace))) continue;
      bucket.push(normalized.entry);
      entriesByRef.set(normalized.ref, bucket);
      imported.push(normalized);
    }
    if (imported.length > 0) incrementCounter('mem.short_ref.legacy_import', { source: 'json_file' });
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

function isContextNamespace(value: unknown): value is ContextNamespace {
  if (!value || typeof value !== 'object') return false;
  const scope = (value as { scope?: unknown }).scope;
  return typeof scope === 'string' && scope.length > 0;
}

function normalizeEntry(raw: unknown): { ref: string; entry: MemoryShortRefEntry } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const ref = typeof record.ref === 'string' ? normalizeRef(record.ref) : undefined;
  const kind = record.kind;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
  if (!ref || !isMemoryShortRefKind(kind) || !id) return undefined;
  const namespace = isContextNamespace(record.namespace) ? record.namespace : undefined;
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
    if (!Array.isArray(parsed.entries)) return;
    for (const raw of parsed.entries) {
      const normalized = normalizeEntry(raw);
      if (!normalized) continue;
      const bucket = entriesByRef.get(normalized.ref) ?? [];
      if (!bucket.some((entry) => entry.kind === normalized.entry.kind
        && entry.id === normalized.entry.id
        && sameNamespace(entry.namespace, normalized.entry.namespace))) {
        bucket.push(normalized.entry);
        entriesByRef.set(normalized.ref, bucket);
      }
    }
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
function reportShortRefFailure(stage: 'persist_store' | 'persist_file' | 'warm_load' | 'load_file', error: unknown, extra: Record<string, unknown> = {}): void {
  incrementCounter('mem.short_ref.persist_failure', { stage });
  warnOncePerHour(`mem.short_ref.persist_failure.${stage}`, {
    ...extra,
    error: error instanceof Error ? error.message : String(error),
  });
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
  const rows = touched.map(({ ref, entry }) => ({
    ref,
    kind: entry.kind,
    id: entry.id,
    namespaceKey: namespaceKey(entry.namespace),
    namespaceJson: entry.namespace ? JSON.stringify(entry.namespace) : null,
    lastSeenAt: entry.lastSeenAt ?? Date.now(),
  }));
  void getContextStoreClient()
    .run('upsertMemoryShortRefs', [rows])
    .catch((error: unknown) => {
      // Non-fatal for this process — the in-memory index still resolves, handles
      // are a pure function of the id, and sourceLookup full ids stay canonical.
      // But it IS the failure this change exists to make visible: handles that
      // never land stop resolving after a restart.
      reportShortRefFailure('persist_store', error, { rows: rows.length });
    });
}

/**
 * Warm the in-memory index from the context store once at daemon startup.
 *
 * Resolution stays synchronous (it is called from synchronous render paths), so
 * the store is read once here instead of per lookup. Handles registered before
 * this resolves are unaffected — the in-memory index is authoritative in-process.
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
    let loaded = 0;
    for (const row of rows) {
      const normalized = normalizeEntry({
        ref: row.ref,
        kind: row.kind,
        id: row.id,
        lastSeenAt: row.lastSeenAt,
        namespace: typeof row.namespaceJson === 'string' ? safeParseNamespace(row.namespaceJson) : undefined,
      });
      if (!normalized) continue;
      const bucket = entriesByRef.get(normalized.ref) ?? [];
      if (bucket.some((entry) => entry.kind === normalized.entry.kind
        && entry.id === normalized.entry.id
        && sameNamespace(entry.namespace, normalized.entry.namespace))) continue;
      bucket.push(normalized.entry);
      entriesByRef.set(normalized.ref, bucket);
      loaded += 1;
    }
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

export function resetMemoryShortRefsForTests(): void {
  entriesByRef.clear();
  persistedLoaded = true;
}

export function reloadMemoryShortRefsForTests(): void {
  entriesByRef.clear();
  persistedLoaded = false;
  ensurePersistedLoaded();
}
