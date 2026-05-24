import type { ContextNamespace } from '../../shared/context-types.js';
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

const MAX_SHORT_REF_ENTRIES = 4096;
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown[] };
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
      schemaVersion: 1,
      entries: entries.slice(0, MAX_SHORT_REF_ENTRIES),
    }), 'utf8');
  } catch {
    // Ref persistence is a convenience cache. Do not break memory search/source reads.
  }
}

export function makeMemoryShortRef(kind: MemoryShortRefKind, id: string): string {
  const compact = id.replace(/[^a-f0-9]/gi, '').slice(0, 10) || id.slice(0, 10);
  return `${refPrefix(kind)}:${compact}`;
}

export function registerMemoryShortRef(entry: MemoryShortRefEntry): string {
  ensurePersistedLoaded();
  const ref = normalizeRef(makeMemoryShortRef(entry.kind, entry.id));
  const bucket = entriesByRef.get(ref) ?? [];
  const nextEntry = { ...entry, lastSeenAt: entry.lastSeenAt ?? Date.now() };
  const next = bucket.filter((existing) => existing.kind !== entry.kind
    || existing.id !== entry.id
    || !sameNamespace(existing.namespace, entry.namespace));
  next.push(nextEntry);
  entriesByRef.set(ref, next);
  pruneShortRefs();
  persistShortRefs();
  return ref;
}

export function resolveMemoryShortRef(ref: string, namespace?: ContextNamespace): MemoryShortRefEntry | undefined {
  ensurePersistedLoaded();
  const bucket = entriesByRef.get(normalizeRef(ref));
  if (!bucket || bucket.length === 0) return undefined;
  const exact = namespace ? newestEntry(bucket.filter((entry) => sameNamespace(entry.namespace, namespace))) : undefined;
  if (exact) return exact;
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
