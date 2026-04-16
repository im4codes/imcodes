import {
  pruneLocalMemory as pruneLocal,
  restoreArchivedMemory as restoreArchived,
} from '../store/context-store.js';
import logger from '../util/logger.js';

/**
 * Archive stale local memories and log the result.
 * Called on daemon startup and can be invoked manually.
 */
export function pruneLocalMemory(now?: number): { archived: number } {
  const result = pruneLocal(now);
  if (result.archived > 0) {
    logger.info({ archived: result.archived }, 'memory-pruning: archived stale local memories');
  }
  return result;
}

/**
 * Restore a previously archived projection back to active status.
 */
export function restoreArchivedMemory(id: string): boolean {
  const restored = restoreArchived(id);
  if (restored) {
    logger.info({ id }, 'memory-pruning: restored archived memory');
  }
  return restored;
}
