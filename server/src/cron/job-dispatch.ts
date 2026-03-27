/**
 * Cron handler: every minute — find due cron_jobs, dispatch via WsBridge.
 */
import type { Env } from '../env.js';
import { WsBridge } from '../ws/bridge.js';
import { logAudit } from '../security/audit.js';
import logger from '../util/logger.js';

interface CronJob {
  id: string;
  server_id: string;
  user_id: string;
  name: string;
  cron_expr: string;
  action: string;
  next_run_at: number;
}

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();

  const dueJobs = await env.DB.query<CronJob>(
    "SELECT * FROM cron_jobs WHERE status = 'active' AND next_run_at <= $1 ORDER BY next_run_at ASC LIMIT 50",
    [now],
  );

  for (const job of dueJobs) {
    try {
      const payload = JSON.stringify({ type: 'cron.dispatch', job: { id: job.id, name: job.name, action: job.action } });
      WsBridge.get(job.server_id).sendToDaemon(payload);

      const nextRun = calculateNextRun(job.cron_expr, now);
      await env.DB.execute(
        'UPDATE cron_jobs SET last_run_at = $1, next_run_at = $2 WHERE id = $3',
        [now, nextRun, job.id],
      );

      await logAudit(
        {
          userId: job.user_id,
          serverId: job.server_id,
          action: 'cron.job.dispatched',
          details: { jobId: job.id, jobName: job.name },
        },
        env.DB,
      );
    } catch (err) {
      logger.error({ jobId: job.id, err }, 'Cron job dispatch failed');
    }
  }

  if (dueJobs.length > 0) {
    logger.info({ dispatched: dueJobs.length }, 'Job dispatch cron complete');
  }
}

/** Calculate next run time from a cron expression using node-cron interval logic. */
function calculateNextRun(cronExpr: string, fromMs: number): number {
  // Simple approximation: parse cron fields and advance to next occurrence.
  // For production use, integrate croner or cron-parser library.
  const parts = cronExpr.split(' ');
  const minutePart = parts[0];
  const intervalMs = minutePart === '*' ? 60_000
    : minutePart.startsWith('*/') ? parseInt(minutePart.slice(2), 10) * 60_000
    : 60_000;
  return fromMs + intervalMs;
}
