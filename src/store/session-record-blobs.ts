/**
 * Large string fields of a session record live ONCE in the database, not once per record.
 *
 * `externalizeSessionRecord` turns a record into the small JSON payload that is stored in its row plus the
 * blobs (hash -> text) that payload refers to; `hydrateSessionRecord` is the inverse. Identical texts (the
 * same user identity contract on 117 sessions) hash to the same blob and, once loaded, are one shared string
 * in memory. `identityPrompt` keeps the legacy sessions.json reference name (`identityPromptRef`) so the
 * compatibility export can hand it to older readers as the `identityPrompts` table they already understand.
 */
import { createHash } from 'node:crypto';
import { SESSION_RECORD_INLINE_STRING_MAX_CHARS } from '../../shared/session-store-compat.js';
import { SESSION_BLOB_CACHE_MAX_CHARS } from '../../shared/daemon-memory-guard.js';

export const SESSION_IDENTITY_REF_FIELD = 'identityPromptRef';
export const SESSION_BLOB_REFS_FIELD = 'blobRefs';
const IDENTITY_FIELD = 'identityPrompt';
const HASH_CACHE_MAX = 512;
const INTERN_MAX = 1024;

export interface SessionBlob { hash: string; text: string }
export interface ExternalizedSessionRecord { payload: string; blobs: SessionBlob[] }

// V8 caches a string's hash inside the string, and a Map hit on the SAME string object is a pointer comparison,
// so re-serialising a record whose 550 KB prompt did not change costs a lookup, not a 550 KB hash.
const hashByText = new Map<string, string>();
const internedByText = new Map<string, string>();
// Both caches are keyed by the large strings themselves: bounded by characters held, not only by entry count, so
// stale versions of an edited prompt cannot pile up (the whole cache is dropped when the budget would be crossed).
let hashChars = 0;
let internChars = 0;

export function sessionBlobCacheStatsForTests(): { hashChars: number; internChars: number; hashEntries: number; internEntries: number } {
  return { hashChars, internChars, hashEntries: hashByText.size, internEntries: internedByText.size };
}

export function hashSessionBlob(text: string): string {
  const known = hashByText.get(text);
  if (known) return known;
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
  if (hashByText.size >= HASH_CACHE_MAX || hashChars + text.length > SESSION_BLOB_CACHE_MAX_CHARS) { hashByText.clear(); hashChars = 0; }
  hashByText.set(text, hash);
  hashChars += text.length;
  return hash;
}

/** One canonical string object per distinct text, so 117 copies loaded from rows cost one. */
export function internSessionText(text: string): string {
  const known = internedByText.get(text);
  if (known !== undefined) return known;
  if (internedByText.size >= INTERN_MAX || internChars + text.length > SESSION_BLOB_CACHE_MAX_CHARS) { internedByText.clear(); internChars = 0; }
  internedByText.set(text, text);
  internChars += text.length;
  return text;
}

export function resetSessionBlobCachesForTests(): void {
  hashByText.clear();
  internedByText.clear();
  hashChars = 0;
  internChars = 0;
}

function isLargeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > SESSION_RECORD_INLINE_STRING_MAX_CHARS;
}

export function externalizeSessionRecord(record: object): ExternalizedSessionRecord {
  const blobs: SessionBlob[] = [];
  const out: Record<string, unknown> = {};
  let refs: Record<string, string> | undefined;
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (key === SESSION_IDENTITY_REF_FIELD || key === SESSION_BLOB_REFS_FIELD) continue; // never carry stale references forward
    if (isLargeString(value)) {
      const hash = hashSessionBlob(value);
      blobs.push({ hash, text: value });
      if (key === IDENTITY_FIELD) out[SESSION_IDENTITY_REF_FIELD] = hash;
      else (refs ??= {})[key] = hash;
      continue;
    }
    out[key] = value;
  }
  if (refs) out[SESSION_BLOB_REFS_FIELD] = refs;
  return { payload: JSON.stringify(out), blobs };
}

/** The hashes a payload string refers to, without parsing it (cheap enough for every committed row). */
export function blobHashesOfPayload(payload: string): string[] {
  if (!payload.includes(SESSION_IDENTITY_REF_FIELD) && !payload.includes(SESSION_BLOB_REFS_FIELD)) return [];
  const hashes = new Set<string>();
  for (const match of payload.matchAll(/"identityPromptRef":"([0-9a-f]{32})"/g)) hashes.add(match[1]!);
  const refsAt = payload.indexOf(`"${SESSION_BLOB_REFS_FIELD}":{`);
  if (refsAt >= 0) {
    const end = payload.indexOf('}', refsAt);
    for (const match of payload.slice(refsAt, end + 1).matchAll(/:"([0-9a-f]{32})"/g)) hashes.add(match[1]!);
  }
  return [...hashes];
}

/**
 * Put the externalised fields back. A reference whose blob is missing leaves the field absent (never a wrong
 * value); an inline long string from a row written by an older build is interned so copies share one string.
 */
export function hydrateSessionRecord(
  parsed: Record<string, unknown>,
  lookup: (hash: string) => string | undefined,
  onMissing?: (field: string, hash: string) => void,
): Record<string, unknown> {
  const record = { ...parsed };
  const identityRef = record[SESSION_IDENTITY_REF_FIELD];
  delete record[SESSION_IDENTITY_REF_FIELD];
  if (typeof identityRef === 'string') {
    const text = lookup(identityRef);
    if (text !== undefined) record[IDENTITY_FIELD] = internSessionText(text);
    else onMissing?.(IDENTITY_FIELD, identityRef);
  }
  const refs = record[SESSION_BLOB_REFS_FIELD];
  delete record[SESSION_BLOB_REFS_FIELD];
  if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
    for (const [field, hash] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof hash !== 'string') continue;
      const text = lookup(hash);
      if (text !== undefined) record[field] = internSessionText(text);
      else onMissing?.(field, hash);
    }
  }
  for (const [field, value] of Object.entries(record)) {
    if (isLargeString(value)) record[field] = internSessionText(value);
  }
  return record;
}

/** The identity blob a payload refers to (what the export's `identityPrompts` table is keyed by). */
export function identityRefOfPayload(payload: string): string | undefined {
  if (!payload.includes(SESSION_IDENTITY_REF_FIELD)) return undefined;
  return /"identityPromptRef":"([0-9a-f]{32})"/.exec(payload)?.[1];
}

/** True when a payload refers to blobs other than the identity (those are inlined into the compatibility export). */
export function hasGenericBlobRefs(payload: string): boolean {
  return payload.includes(`"${SESSION_BLOB_REFS_FIELD}":{`);
}
