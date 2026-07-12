/**
 * Shared controllable-machine data hook (web), mirroring `useAliases`.
 *
 * Fetches the caller's controllable machines via `/api/machines` and exposes
 * them across every machine surface (inline `^` autocomplete, @ picker) from a
 * single shared resource. Read-only (no CRUD): a machine is enrolled/revoked
 * elsewhere, not created from the composer.
 *
 * Filtering by `q` is an in-memory NFC substring match over refName + display
 * name, keeping keystroke filtering instant against the already-loaded list.
 */
import { useMemo } from 'preact/hooks';
import { nfc } from '@shared/machine-reference.js';
import { createSharedResource } from '../stores/shared-resource.js';
import { listControllableMachines, type MachineListItem } from '../api/machines.js';

// Does NOT swallow errors — the send path blocks a marker-bearing send when the
// machine list is not successfully loaded (fail-closed), so a rejected fetch
// must surface as `error`, not an empty list.
const machineResource = createSharedResource<MachineListItem[]>({
  fetcher: (): Promise<MachineListItem[]> => listControllableMachines(),
});

function matchesQuery(m: MachineListItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${nfc(m.refName)}\n${nfc(m.displayName)}`;
  return haystack.includes(needle);
}

/** Filter a machine list in memory by an NFC substring over refName + displayName. */
export function filterMachines(list: readonly MachineListItem[], q?: string): MachineListItem[] {
  const needle = nfc((q ?? '').trim());
  if (!needle) return [...list];
  return list.filter((m) => matchesQuery(m, needle));
}

export interface UseMachinesResult {
  machines: MachineListItem[];
  /** In-memory filtered view over refName + displayName for the provided query. */
  filtered: MachineListItem[];
  loaded: boolean;
  loading: boolean;
  error: unknown | null;
  stale: boolean;
  refetch: () => void;
}

/** Shared machine data (read-only). Pass an optional `query` for a filtered view. */
export function useMachines(query?: string): UseMachinesResult {
  const snapshot = machineResource.use();
  const machines = snapshot.value ?? [];
  const filtered = useMemo(() => filterMachines(machines, query), [machines, query]);
  return {
    machines,
    filtered,
    loaded: snapshot.loaded,
    loading: snapshot.loading,
    error: snapshot.error,
    stale: snapshot.stale,
    refetch: machineResource.invalidate,
  };
}

/** Test-only: dispose the shared machine resource between test cases. */
export function __resetMachinesForTests(): void {
  machineResource.disposeForTests();
}
