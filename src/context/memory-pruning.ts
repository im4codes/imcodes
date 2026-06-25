import { getContextStoreClient } from '../store/context-store-worker-client.js';
import logger from '../util/logger.js';

/**
 * Archive stale local memories and log the result.
 * Called on daemon startup and can be invoked manually.
 */
export async function pruneLocalMemory(now?: number): Promise<{ archived: number }> {
  const result = await getContextStoreClient().run<{ archived: number }>('pruneLocalMemory', [now]);
  if (result.archived > 0) {
    logger.info({ archived: result.archived }, 'memory-pruning: archived stale local memories');
  }
  return result;
}

/**
 * Restore a previously archived projection back to active status.
 */
export async function restoreArchivedMemory(id: string): Promise<boolean> {
  const restored = await getContextStoreClient().run<boolean>('restoreArchivedMemory', [id]);
  if (restored) {
    logger.info({ id }, 'memory-pruning: restored archived memory');
  }
  return restored;
}
