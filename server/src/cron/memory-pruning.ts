/**
 * Cron handler: delete archived cloud memory projections older than 90 days.
 */
import type { Env } from '../env.js';
import logger from '../util/logger.js';

const ARCHIVED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function memoryPruningCron(env: Env): Promise<void> {
  const cutoff = Date.now() - ARCHIVED_MAX_AGE_MS;

  const result = await env.DB.execute(
    `DELETE FROM shared_context_projections
     WHERE status = 'archived'
       AND updated_at < $1`,
    [cutoff],
  );

  const deleted = result.changes;
  if (deleted > 0) {
    logger.info({ deleted }, 'memory-pruning: deleted archived cloud projections');
  }
}
