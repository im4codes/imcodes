import type { SharedEntrySummary } from './api.js';
import { shareTargetKey } from './tab-sharing-ui.js';

const SHARED_TAB_RESTORE_STORAGE_KEY = 'imcodes:shared-tab-restore:v1';
const SHARED_TAB_RESTORE_VERSION = 1;
const MAX_RESTORE_FIELD_LENGTH = 512;

export interface SharedTabRestoreMarker {
  version: typeof SHARED_TAB_RESTORE_VERSION;
  entryId: string;
  serverId: string;
  targetKey: string;
}

function isBoundedField(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RESTORE_FIELD_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function decodeSharedTabRestoreMarker(value: unknown): SharedTabRestoreMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== SHARED_TAB_RESTORE_VERSION
    || !isBoundedField(row.entryId)
    || !isBoundedField(row.serverId)
    || !isBoundedField(row.targetKey)) {
    return null;
  }
  return {
    version: SHARED_TAB_RESTORE_VERSION,
    entryId: row.entryId,
    serverId: row.serverId,
    targetKey: row.targetKey,
  };
}

export function readSharedTabRestoreMarker(): SharedTabRestoreMarker | null {
  try {
    const raw = sessionStorage.getItem(SHARED_TAB_RESTORE_STORAGE_KEY);
    if (!raw) return null;
    const marker = decodeSharedTabRestoreMarker(JSON.parse(raw));
    if (!marker) sessionStorage.removeItem(SHARED_TAB_RESTORE_STORAGE_KEY);
    return marker;
  } catch {
    try {
      sessionStorage.removeItem(SHARED_TAB_RESTORE_STORAGE_KEY);
    } catch { /* ignore unavailable storage */ }
    return null;
  }
}

export function rememberSharedTab(entry: SharedEntrySummary): void {
  const targetKey = shareTargetKey(entry.target);
  if (!isBoundedField(entry.id)
    || !isBoundedField(entry.serverId)
    || !isBoundedField(targetKey)) {
    clearSharedTabRestoreMarker();
    return;
  }
  const marker: SharedTabRestoreMarker = {
    version: SHARED_TAB_RESTORE_VERSION,
    entryId: entry.id,
    serverId: entry.serverId,
    targetKey,
  };
  try {
    sessionStorage.setItem(SHARED_TAB_RESTORE_STORAGE_KEY, JSON.stringify(marker));
  } catch { /* ignore unavailable storage */ }
}

export function clearSharedTabRestoreMarker(): void {
  try {
    sessionStorage.removeItem(SHARED_TAB_RESTORE_STORAGE_KEY);
  } catch { /* ignore unavailable storage */ }
}

export function findRememberedSharedEntry(
  entries: readonly SharedEntrySummary[],
  marker: SharedTabRestoreMarker,
): SharedEntrySummary | null {
  return entries.find((entry) => (
    entry.status === 'active'
    && entry.id === marker.entryId
    && entry.serverId === marker.serverId
    && shareTargetKey(entry.target) === marker.targetKey
  )) ?? null;
}
