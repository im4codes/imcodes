/**
 * Per-session empty-store write authorization set.
 *
 * Kept outside `session-store.ts` so callers that confirm session shutdown
 * (`stopProject` / `stopSubSession`) can record authorized session names without
 * breaking test suites that partially mock `session-store.js`.
 */
const authorizedClosedSessionRemovals = new Set<string>();

export function authorizeClosedSessionRemoval(name: string): void {
  authorizedClosedSessionRemovals.add(name);
}

export function revokeClosedSessionRemovalAuthorization(name: string): void {
  authorizedClosedSessionRemovals.delete(name);
}

export function areClosedSessionRemovalsAuthorized(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => authorizedClosedSessionRemovals.has(name));
}

export function isClosedSessionRemovalAuthorized(name: string): boolean {
  return authorizedClosedSessionRemovals.has(name);
}

export function pruneClosedSessionRemovalAuthorizations(shouldKeep: (name: string) => boolean): void {
  for (const name of authorizedClosedSessionRemovals) {
    if (!shouldKeep(name)) authorizedClosedSessionRemovals.delete(name);
  }
}

export function clearClosedSessionRemovalAuthorizations(): void {
  authorizedClosedSessionRemovals.clear();
}
