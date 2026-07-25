import type { ContextNamespace } from '../../shared/context-types.js';
import { createHash } from 'node:crypto';
import { encodeBase32 } from '../util/base32.js';
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

function newestEntry(entries: MemoryShortRefEntry[]): MemoryShortRefEntry | undefined {
  return [...entries].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
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

function shortRefStorePath(): string | undefined {
  const configured = process.env.IMCODES_MEMORY_SHORT_REF_PATH?.trim();
  if (configured) return configured;
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return undefined;
  return join(homedir(), '.imcodes', 'memory-short-refs.json');
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
  } catch {
    // Missing or corrupt cache is non-fatal: sourceLookup full ids remain canonical.
  }
}

function persistShortRefs(): void {
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
  } catch {
    // Ref persistence is a convenience cache. Do not break memory search/source reads.
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
  persistShortRefs();
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
    persistShortRefs();
  }
  return refs;
}

export function resolveMemoryShortRef(ref: string, namespace?: ContextNamespace): MemoryShortRefEntry | undefined {
  ensurePersistedLoaded();
  const bucket = entriesByRef.get(normalizeRef(ref));
  if (!bucket || bucket.length === 0) return undefined;
  const exact = namespace ? newestEntry(bucket.filter((entry) => sameNamespace(entry.namespace, namespace))) : undefined;
  if (exact) return exact;
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
