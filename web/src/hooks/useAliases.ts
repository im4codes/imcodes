/**
 * Shared alias data hook (web).
 *
 * Fetches the caller's aliases via the `/api/aliases` client and exposes them
 * across every alias surface (inline autocomplete, @ picker, panel) from a
 * single shared resource so a mutation on one surface is reflected on the
 * others without a page reload. Mutations (`create`/`remove`) invalidate the
 * resource, triggering a refetch.
 *
 * Deliberately does NOT reuse QuickInputPanel's `useQuickData` debounced
 * quick-data storage: aliases are server-authoritative and must reflect
 * immediately, so this uses a plain `createSharedResource` with no debounce or
 * optimistic-add bookkeeping.
 *
 * Filtering by `q` is an in-memory NFC substring match over name + description
 * (the server also supports `?q=`; the in-memory filter keeps keystroke
 * filtering instant against the already-loaded list without extra round-trips).
 */

import { useMemo } from 'preact/hooks';
import { nfc, type AliasEntry } from '@shared/alias-types.js';
import { createSharedResource } from '../stores/shared-resource.js';
import {
  deleteAlias,
  listAliases,
  upsertAlias,
  type UpsertAliasInput,
} from '../api/aliases.js';

// The fetcher deliberately does NOT swallow errors (audit finding Cx1-4).
// `createSharedResource.reload()` already keeps the previous `value` while
// setting `error` on a rejected fetch, so re-throwing lets callers distinguish
// "loaded (empty)" from "load failed / stale" instead of masking a failure as
// an empty list. The send path relies on this to block a marker-bearing send
// when the alias list is not successfully loaded.
const aliasResource = createSharedResource<AliasEntry[]>({
  fetcher: (): Promise<AliasEntry[]> => listAliases(),
});

/** Case-sensitive NFC substring match over name + description. */
function matchesQuery(entry: AliasEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${nfc(entry.name)}\n${nfc(entry.description ?? '')}`;
  return haystack.includes(needle);
}

/** Filter an alias list in memory by an NFC substring over name + description. */
export function filterAliases(list: readonly AliasEntry[], q?: string): AliasEntry[] {
  const needle = nfc((q ?? '').trim());
  if (!needle) return [...list];
  return list.filter((entry) => matchesQuery(entry, needle));
}

export interface UseAliasesResult {
  /** Full alias list from the server (unfiltered). */
  aliases: AliasEntry[];
  /** In-memory filtered view over name + description for the provided query. */
  filtered: AliasEntry[];
  loaded: boolean;
  loading: boolean;
  error: unknown | null;
  /** True when the current value is known to be stale (invalidated, awaiting refetch). */
  stale: boolean;
  /** Force a refetch. */
  refetch: () => void;
  /** Upsert an alias, then invalidate so all surfaces refresh. Rejects on validation error. */
  create: (input: UpsertAliasInput) => Promise<void>;
  /** Delete an alias by name, then invalidate so all surfaces refresh. */
  remove: (name: string) => Promise<void>;
}

/**
 * Shared alias data + mutations. Pass an optional `query` to get an in-memory
 * filtered view; the unfiltered `aliases` list is always available too.
 */
export function useAliases(query?: string): UseAliasesResult {
  const snapshot = aliasResource.use();
  const aliases = snapshot.value ?? [];

  const filtered = useMemo(() => filterAliases(aliases, query), [aliases, query]);

  const create = async (input: UpsertAliasInput): Promise<void> => {
    await upsertAlias(input);
    aliasResource.invalidate();
  };

  const remove = async (name: string): Promise<void> => {
    await deleteAlias(name);
    aliasResource.invalidate();
  };

  return {
    aliases,
    filtered,
    loaded: snapshot.loaded,
    loading: snapshot.loading,
    error: snapshot.error,
    stale: snapshot.stale,
    refetch: () => aliasResource.invalidate(),
    create,
    remove,
  };
}

/** Test-only: dispose the shared alias resource between test cases. */
export function __resetAliasesForTests(): void {
  aliasResource.disposeForTests();
}
