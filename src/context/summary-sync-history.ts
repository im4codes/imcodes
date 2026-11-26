import { randomUUID } from 'node:crypto';
import { getSession, upsertSession } from '../store/session-store.js';

export interface SummarySyncReservation {
  id: string;
  sessionKey: string;
  fingerprints: string[];
}

interface SummarySyncState {
  committed: Set<string>;
  reservations: Map<string, Set<string>>;
}

const states = new Map<string, SummarySyncState>();

function stateFor(sessionKey: string): SummarySyncState {
  const existing = states.get(sessionKey);
  if (existing) return existing;
  let persisted: string[] = [];
  try {
    const record = getSession(sessionKey);
    if (Array.isArray(record?.summarySyncFingerprints)) {
      persisted = record.summarySyncFingerprints.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
    }
  } catch { /* store unavailable in isolated tests */ }
  const created: SummarySyncState = {
    committed: new Set(persisted),
    reservations: new Map(),
  };
  states.set(sessionKey, created);
  return created;
}

function persistCommitted(sessionKey: string, state: SummarySyncState): void {
  try {
    const record = getSession(sessionKey);
    if (!record) return;
    upsertSession({
      ...record,
      summarySyncFingerprints: [...state.committed],
      updatedAt: Date.now(),
    });
  } catch { /* delivery dedup remains valid for this daemon lifetime */ }
}

export function reserveUnsyncedSummaryFingerprints(
  sessionKey: string | undefined,
  fingerprints: readonly string[],
): SummarySyncReservation | undefined {
  if (!sessionKey || fingerprints.length === 0) return undefined;
  const state = stateFor(sessionKey);
  const unavailable = new Set(state.committed);
  for (const reserved of state.reservations.values()) {
    for (const fingerprint of reserved) unavailable.add(fingerprint);
  }
  const selected = [...new Set(fingerprints)].filter((fingerprint) => !unavailable.has(fingerprint));
  if (selected.length === 0) return undefined;
  const id = randomUUID();
  state.reservations.set(id, new Set(selected));
  return { id, sessionKey, fingerprints: selected };
}

export function commitSummarySyncReservation(reservation: SummarySyncReservation | undefined): void {
  if (!reservation) return;
  const state = stateFor(reservation.sessionKey);
  const reserved = state.reservations.get(reservation.id);
  if (!reserved) return;
  state.reservations.delete(reservation.id);
  for (const fingerprint of reserved) state.committed.add(fingerprint);
  persistCommitted(reservation.sessionKey, state);
}

export function rollbackSummarySyncReservation(reservation: SummarySyncReservation | undefined): void {
  if (!reservation) return;
  stateFor(reservation.sessionKey).reservations.delete(reservation.id);
}

export function recordSyncedSummaryFingerprints(
  sessionKey: string | undefined,
  fingerprints: readonly string[],
): void {
  if (!sessionKey || fingerprints.length === 0) return;
  const state = stateFor(sessionKey);
  let changed = false;
  for (const fingerprint of fingerprints) {
    if (!state.committed.has(fingerprint)) {
      state.committed.add(fingerprint);
      changed = true;
    }
  }
  if (changed) persistCommitted(sessionKey, state);
}

export function clearSummarySyncHistory(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  states.set(sessionKey, { committed: new Set(), reservations: new Map() });
  try {
    const record = getSession(sessionKey);
    if (record?.summarySyncFingerprints?.length) {
      upsertSession({ ...record, summarySyncFingerprints: [], updatedAt: Date.now() });
    }
  } catch { /* best effort */ }
}

export function getSummarySyncFingerprints(sessionKey: string | undefined): string[] {
  if (!sessionKey) return [];
  return [...stateFor(sessionKey).committed];
}

export function resetAllSummarySyncHistories(): void {
  states.clear();
}
