import type { DatabaseSync } from 'node:sqlite';

export interface FinalizeSqliteLegacyScrubOptions {
  db: DatabaseSync;
  isFileBacked: boolean;
  scrubbedRows: number;
  alreadyCompleted: boolean;
  markCompleted: () => void;
  clearCompleted: () => void;
}

function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { errcode?: unknown; code?: unknown; message?: unknown };
  if (record.errcode === 5 || record.errcode === 6) return true;
  const msg = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return msg.includes('busy') || msg.includes('locked');
}

/**
 * Completes legacy plaintext scrubbing for SQLite WAL stores by compacting freed
 * pages (`VACUUM`) and verifying `PRAGMA wal_checkpoint(TRUNCATE)` actually
 * truncated the WAL with `busy === 0` before recording completion.
 *
 * Returns `true` when the store is clean and marked complete, or `false` when a
 * concurrent WAL snapshot kept checkpoint/vacuum busy so future opens retry.
 */
export function finalizeSqliteLegacyScrub(options: FinalizeSqliteLegacyScrubOptions): boolean {
  const { db, isFileBacked, scrubbedRows, alreadyCompleted, markCompleted, clearCompleted } = options;
  if (alreadyCompleted && scrubbedRows === 0) return true;
  if (!isFileBacked) {
    markCompleted();
    return true;
  }

  // If new legacy plaintext rows were modified despite an earlier marker, clear
  // the marker before vacuuming so an interrupted or busy run must retry.
  if (alreadyCompleted && scrubbedRows > 0) {
    clearCompleted();
  }

  try {
    db.exec('VACUUM;');
  } catch (error) {
    if (isSqliteBusyError(error)) {
      clearCompleted();
      return false;
    }
    throw error;
  }

  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  const busy = Number(checkpoint?.busy ?? 1);
  const logFrames = Number(checkpoint?.log ?? -1);
  const checkpointedFrames = Number(checkpoint?.checkpointed ?? -1);
  const truncated =
    checkpoint !== undefined
    && busy === 0
    && (logFrames === -1 || (logFrames >= 0 && checkpointedFrames === logFrames));

  if (!truncated) {
    clearCompleted();
    return false;
  }

  markCompleted();
  return true;
}
