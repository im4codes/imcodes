/**
 * Cron handler: every minute — find due cron_jobs, dispatch via WsBridge.
 */
import { Cron } from 'croner';
import type { Env } from '../env.js';
import type { DbCronJob } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import { logAudit } from '../security/audit.js';
import { randomHex } from '../security/crypto.js';
import { CRON_MSG, CRON_STATUS, type CronAction, type CronDispatchMessage } from '../../../shared/cron-types.js';
import logger from '../util/logger.js';

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();

  // Atomic select + lock — prevents double-dispatch from concurrent ticks
  const dueJobs = await env.DB.query<DbCronJob>(
    `WITH due AS (
       SELECT id FROM cron_jobs
       WHERE status = 'active' AND next_run_at <= $1
         AND (expires_at IS NULL OR expires_at >= $1)
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     UPDATE cron_jobs SET last_run_at = $1
     FROM due WHERE cron_jobs.id = due.id
     RETURNING cron_jobs.*`,
    [now],
  );

  // Periodic cleanup of old execution history (~1% of ticks)
  if (Math.random() < 0.01) {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    await env.DB.execute('DELETE FROM cron_executions WHERE created_at < $1', [thirtyDaysAgo]).catch(() => {});
  }

  for (const job of dueJobs) {
    try {
      // Parse action JSON
      let action: CronAction;
      try {
        action = JSON.parse(job.action);
      } catch {
        logger.error({ jobId: job.id }, 'Cron job has invalid action JSON, marking as error');
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.ERROR, job.id]);
        await logExecution(env, job.id, 'error', 'Invalid action JSON');
        continue;
      }

      // Skip if daemon offline (fire-and-forget)
      const bridge = WsBridge.get(job.server_id);
      if (!bridge.isDaemonConnected()) {
        logger.debug({ jobId: job.id }, 'Cron skipped: daemon offline');
        const nextRun = calculateNextRun(job.cron_expr, now);
        await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);
        await logExecution(env, job.id, 'skipped_offline');
        continue;
      }

      // Dispatch to daemon
      const msg: CronDispatchMessage = {
        type: CRON_MSG.DISPATCH,
        jobId: job.id,
        jobName: job.name,
        serverId: job.server_id,
        projectName: job.project_name ?? '',
        targetRole: job.target_role ?? 'brain',
        action,
      };
      bridge.sendToDaemon(JSON.stringify(msg));

      // Advance schedule
      const nextRun = calculateNextRun(job.cron_expr, now);
      await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);

      // Auto-expire if next run is past expiration
      if (job.expires_at && nextRun > job.expires_at) {
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.EXPIRED, job.id]);
      }

      await logExecution(env, job.id, 'dispatched');

      await logAudit(
        { userId: job.user_id, serverId: job.server_id, action: 'cron.job.dispatched', details: { jobId: job.id, jobName: job.name } },
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

async function logExecution(env: Env, jobId: string, status: string, detail?: string): Promise<void> {
  await env.DB.execute(
    'INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
    [randomHex(12), jobId, status, detail ?? null, Date.now()],
  ).catch((err) => logger.error({ jobId, err }, 'Failed to log cron execution'));
}

function calculateNextRun(cronExpr: string, fromMs: number): number {
  try {
    const job = new Cron(cronExpr);
    const next = job.nextRun(new Date(fromMs));
    return next ? next.getTime() : fromMs + 60_000;
  } catch {
    return fromMs + 60_000;
  }
}
