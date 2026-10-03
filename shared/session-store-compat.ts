/**
 * The write-only `sessions.json` compatibility export.
 *
 * The session store lives in SQLite, and the database is the ONLY source of
 * truth: nothing in a build that has the database reads `sessions.json`, except
 * the one-time migration and the read-only fallback while no migrated database
 * exists. The daemon nevertheless keeps writing a v2-format `sessions.json`
 * beside the database so that processes still running OLDER builds (a memory
 * MCP stdio server inside a long-lived tmux agent, an old cli, a downgraded
 * daemon) keep seeing current sessions instead of a stale rotated backup.
 *
 * Removal is ONE switch: `isSessionsJsonCompatExportEnabled` turns false at the
 * sunset instant. Removing the feature afterwards means deleting the export in
 * `src/store/session-store.ts` (marked with this module's name).
 */

/** Bumped when the export layout changes in a way an older reader must be told about. */
export const SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION = 1;

/** Top-level key carrying the format marker; older readers ignore unknown top-level keys. */
export const SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY = 'sessionStoreCompatExport';

/** At most one export per this long, and only after a flush that committed changed rows. */
export const SESSIONS_JSON_COMPAT_EXPORT_MIN_INTERVAL_MS = 5_000;

/** Documented transition period: the export stops being written from this instant on. */
export const SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS = Date.UTC(2027, 0, 1);

export function isSessionsJsonCompatExportEnabled(nowMs: number = Date.now()): boolean {
  return nowMs < SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS;
}
