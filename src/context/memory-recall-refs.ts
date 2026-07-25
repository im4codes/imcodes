import type { ContextNamespace, ContextScope } from '../../shared/context-types.js';
import { registerMemoryShortRefs, type MemoryShortRefEntry, type MemoryShortRefKind } from './memory-short-ref.js';

/**
 * The minimum an injected memory item must expose to get a redeemable handle.
 * Deliberately structural rather than tied to one concrete item type: the recall
 * surfaces feed this from `MemorySearchResultItem`, `TransportMemoryRecallItem`
 * and `MemoryContextTimelineItem`, which agree on these fields but not much else.
 */
export interface MemoryShortRefSource {
  id?: string;
  type?: 'raw' | 'processed' | 'observation';
  scope?: string;
  projectId?: string;
  userId?: string;
  workspaceId?: string;
  enterpriseId?: string;
}

/**
 * `get_memory_sources` addresses projections and observations only, so raw staged
 * events get no handle rather than a dead one.
 *
 * Some recall surfaces carry no `type` discriminator at all; those come from the
 * processed-memory path, so they are treated as projections. That default is
 * fail-safe rather than a guess: if such a record were actually an observation,
 * the projection lookup simply misses and the fetch returns zero sources — the
 * same outcome as shipping no handle, never another record's content.
 */
function shortRefKind(type: MemoryShortRefSource['type']): MemoryShortRefKind | undefined {
  if (type === 'observation') return 'observation';
  if (type === 'raw') return undefined;
  return 'projection';
}

/** The namespace the record is STORED in, so the cached entry lines up with what
 *  the record fetch authorizes against. */
function namespaceForItem(item: MemoryShortRefSource): ContextNamespace | undefined {
  if (!item.scope) return undefined;
  return {
    scope: item.scope as ContextScope,
    ...(item.projectId ? { projectId: item.projectId } : {}),
    ...(item.userId ? { userId: item.userId } : {}),
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
  };
}

/**
 * Attach a redeemable handle to every injected memory item.
 *
 * Injected memory used to carry only a summary, while the guidance shipped
 * alongside it told the agent to "call get_memory_sources with that ref" — there
 * was no ref to call with, so a summary that looked relevant was a dead end.
 * Registering here (batched: one cache write, not one per item) is what makes the
 * emitted handle resolvable.
 */
export function attachMemoryShortRefs<T extends MemoryShortRefSource>(
  items: readonly T[],
): Array<T & { ref?: string }> {
  const registrable: Array<{ index: number; entry: MemoryShortRefEntry }> = [];
  items.forEach((item, index) => {
    const kind = shortRefKind(item.type);
    if (!kind || !item.id) return;
    const namespace = namespaceForItem(item);
    registrable.push({
      index,
      entry: { kind, id: item.id, ...(namespace ? { namespace } : {}) },
    });
  });
  const refs = registerMemoryShortRefs(registrable.map((candidate) => candidate.entry));
  const refByIndex = new Map<number, string>();
  registrable.forEach((candidate, position) => {
    const ref = refs[position];
    if (ref) refByIndex.set(candidate.index, ref);
  });
  return items.map((item, index) => {
    const ref = refByIndex.get(index);
    return ref ? { ...item, ref } : item;
  });
}
