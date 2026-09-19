import { useSyncExternalStore } from 'preact/compat';
import type { CapabilityOperationView } from './api/capabilities.js';

type Listener = () => void;

const operations = new Map<string, Map<string, CapabilityOperationView>>();
const cachedSnapshots = new Map<string, CapabilityOperationView[]>();
const listeners = new Set<Listener>();

function keyFor(serverId?: string | null): string {
  return serverId?.trim() || '__no_server__';
}

function emit(): void {
  for (const listener of listeners) listener();
}

function newestOperation(
  current: CapabilityOperationView | undefined,
  next: CapabilityOperationView,
): CapabilityOperationView {
  return current && current.revision >= next.revision ? current : next;
}

export function getCapabilityOperationSnapshot(serverId?: string | null): CapabilityOperationView | null {
  const values = getCapabilityOperationSnapshots(serverId);
  return values.find((operation) => !operation.terminal) ?? values[0] ?? null;
}

export function getCapabilityOperationSnapshots(serverId?: string | null): CapabilityOperationView[] {
  const key = keyFor(serverId);
  const cached = cachedSnapshots.get(key);
  if (cached) return cached;
  const snapshot = [...(operations.get(key)?.values() ?? [])]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  cachedSnapshots.set(key, snapshot);
  return snapshot;
}

export function setCapabilityOperationSnapshot(serverId: string | null | undefined, operation: CapabilityOperationView | null): void {
  const key = keyFor(serverId);
  if (!operation) {
    if (!operations.has(key)) return;
    operations.delete(key);
    cachedSnapshots.delete(key);
    emit();
    return;
  }
  const current = operations.get(key) ?? new Map<string, CapabilityOperationView>();
  const newest = newestOperation(current.get(operation.id), operation);
  if (current.get(operation.id) === newest) return;
  current.set(operation.id, newest);
  operations.set(key, current);
  cachedSnapshots.delete(key);
  emit();
}

export function setCapabilityOperationSnapshots(
  serverId: string | null | undefined,
  next: readonly CapabilityOperationView[],
  replace = false,
): void {
  const key = keyFor(serverId);
  const previous = operations.get(key);
  const current = replace ? new Map<string, CapabilityOperationView>() : new Map(previous);
  for (const operation of next) current.set(operation.id, newestOperation(previous?.get(operation.id), operation));
  if (current.size) operations.set(key, current);
  else operations.delete(key);
  cachedSnapshots.delete(key);
  emit();
}

export function useCapabilityOperationSnapshot(serverId?: string | null): CapabilityOperationView | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getCapabilityOperationSnapshot(serverId),
  );
}

export function useCapabilityOperationSnapshots(serverId?: string | null): CapabilityOperationView[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getCapabilityOperationSnapshots(serverId),
  );
}

export function resetCapabilityOperationStoreForTests(): void {
  operations.clear();
  cachedSnapshots.clear();
  emit();
}
