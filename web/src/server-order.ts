export interface ServerOrderEntry {
  id: string;
}

function uniqueKnownIds<T extends ServerOrderEntry>(entries: T[], ids: readonly string[]): string[] {
  const known = new Set(entries.map((entry) => entry.id));
  const seen = new Set<string>();
  const candidates = Array.isArray(ids) ? ids : [];
  return candidates.filter((id) => {
    if (typeof id !== 'string') return false;
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Keep persisted order bounded to current servers and append new servers. */
export function normalizeServerOrder<T extends ServerOrderEntry>(
  servers: readonly T[],
  order: readonly string[],
): string[] {
  const valid = uniqueKnownIds([...servers], order);
  const seen = new Set(valid);
  for (const server of servers) {
    if (!seen.has(server.id)) {
      seen.add(server.id);
      valid.push(server.id);
    }
  }
  return valid;
}

/** Check whether two string ID lists match element-for-element. */
export function sameOrderIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, idx) => id === b[idx]);
}

/** Append missing IDs while preserving all existing/unseen IDs in their relative slots. */
export function appendMissingOrderIds(
  visibleIds: readonly string[],
  order: readonly string[],
): string[] {
  const candidates = Array.isArray(order) ? order : [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of visibleIds) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

/** Non-destructively append newly discovered server IDs without pruning unseen/other-window IDs. */
export function appendMissingServerOrder<T extends ServerOrderEntry>(
  servers: readonly T[],
  order: readonly string[],
): string[] {
  return appendMissingOrderIds(servers.map((server) => server.id), order);
}

/**
 * Surgically move `fromId` before/after `toId` inside `prev` while keeping every
 * unrelated, pinned/other-group, and unseen/other-window ID in its relative slot.
 */
export function reorderOrderIdsPreservingHidden(
  prev: readonly string[],
  visibleIds: readonly string[],
  fromId: string,
  toId: string,
  insertAfter: boolean,
): string[] {
  if (!fromId || !toId || fromId === toId) return [...(Array.isArray(prev) ? prev : [])];
  if (!visibleIds.includes(fromId) || !visibleIds.includes(toId)) {
    return [...(Array.isArray(prev) ? prev : [])];
  }
  const base = appendMissingOrderIds(visibleIds, prev);
  const fromPos = base.indexOf(fromId);
  const withoutFrom = base.filter((_, idx) => idx !== fromPos);
  const targetPos = withoutFrom.indexOf(toId);
  if (targetPos === -1) return [...(Array.isArray(prev) ? prev : [])];
  withoutFrom.splice(insertAfter ? targetPos + 1 : targetPos, 0, fromId);
  return withoutFrom;
}

/** Explicit server drag that preserves unseen/offline/other-window server IDs. */
export function reorderServerOrder<T extends ServerOrderEntry>(
  prevOrder: readonly string[],
  displayedServers: readonly T[],
  fromId: string,
  toId: string,
  insertAfter: boolean,
): string[] {
  return reorderOrderIdsPreservingHidden(
    prevOrder,
    displayedServers.map((server) => server.id),
    fromId,
    toId,
    insertAfter,
  );
}

/** Sort pinned servers first, preserving pin priority and ordinary order. */
export function sortServersByPreference<T extends ServerOrderEntry>(
  servers: readonly T[],
  order: readonly string[],
  pinned: readonly string[],
): T[] {
  const normalizedOrder = normalizeServerOrder(servers, order);
  const orderRank = new Map(normalizedOrder.map((id, index) => [id, index] as const));
  const normalizedPinned = uniqueKnownIds([...servers], pinned);
  const pinRank = new Map(normalizedPinned.map((id, index) => [id, index] as const));
  return [...servers].sort((a, b) => {
    const aPin = pinRank.get(a.id);
    const bPin = pinRank.get(b.id);
    if (aPin !== undefined || bPin !== undefined) {
      if (aPin === undefined) return 1;
      if (bPin === undefined) return -1;
      return aPin - bPin;
    }
    return (orderRank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (orderRank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function normalizePinnedServers<T extends ServerOrderEntry>(
  servers: readonly T[],
  pinned: readonly string[],
): string[] {
  return uniqueKnownIds([...servers], pinned);
}

/** Explicit user toggle, independent of a temporarily incomplete inventory. */
export function toggleServerPin(pinned: readonly string[], serverId: string): string[] {
  const current = [...new Set((Array.isArray(pinned) ? pinned : []).filter((id) => typeof id === 'string'))];
  return current.includes(serverId) ? current.filter((id) => id !== serverId) : [...current, serverId];
}
