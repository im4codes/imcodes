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
