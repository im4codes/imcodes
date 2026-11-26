/**
 * Test-side view of the SQLite session store: read what is persisted, or write
 * rows as a foreign process would, without going through the store under test.
 */
import { join } from 'node:path';
import {
  SESSION_DB_FILE,
  closeSessionDb,
  commitSessionChanges,
  openSessionDbForWrite,
  openSessionDbReadOnly,
  readSessionBlobs,
  readSessionPayloads,
} from '../../src/store/session-store-db.js';

export function sessionDbPathForHome(home: string): string {
  return join(home, '.imcodes', SESSION_DB_FILE);
}

/** Every persisted session, parsed; `{}` when there is no database yet. */
export function persistedSessions(home: string): Record<string, Record<string, unknown>> {
  const handle = openSessionDbReadOnly(sessionDbPathForHome(home));
  if (!handle) return {};
  try {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, payload] of readSessionPayloads(handle)) out[name] = JSON.parse(payload) as Record<string, unknown>;
    return out;
  } finally {
    closeSessionDb(handle);
  }
}

/** Replace the persisted sessions as another process would: same database, its own connection. */
export function replacePersistedSessions(home: string, records: Array<Record<string, unknown> & { name: string }>): void {
  const handle = openSessionDbForWrite(sessionDbPathForHome(home));
  try {
    const existing = [...readSessionPayloads(handle).keys()];
    commitSessionChanges(handle, {
      upserts: records.map((record) => ({
        name: record.name,
        projectName: String(record.projectName ?? ''),
        parentSession: typeof record.parentSession === 'string' ? record.parentSession : null,
        agentType: String(record.agentType ?? ''),
        state: String(record.state ?? ''),
        updatedAt: Number(record.updatedAt ?? 0),
        payload: JSON.stringify(record),
      })),
      deletes: existing.filter((name) => !records.some((record) => record.name === name)),
      allowEmpty: true,
    });
  } finally {
    closeSessionDb(handle);
  }
}

/** The large-field blobs persisted beside the rows (hash -> text); empty when there is no database. */
export function persistedSessionBlobs(home: string): Map<string, string> {
  const handle = openSessionDbReadOnly(sessionDbPathForHome(home));
  if (!handle) return new Map();
  try {
    return readSessionBlobs(handle);
  } finally {
    closeSessionDb(handle);
  }
}
