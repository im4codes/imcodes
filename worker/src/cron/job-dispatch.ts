/**
 * Cron handler: every minute — find due jobs, dispatch actions via DaemonBridge.
 */
import type { Env } from '../types.js';
import { logAudit } from '../security/audit.js';
import logger from '../util/logger.js';

interface CronJob {
  id: string;
  server_id: string;
  user_id: string;
  name: string;
  schedule: string;
  action: string;
  next_run_at: number;
}

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();

  const dueJobs = await env.DB
    .prepare(
      "SELECT * FROM cron_jobs WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50",
    )
    .bind(now)
    .all<CronJob>();

  for (const job of dueJobs.results) {
    try {
      await dispatchJob(job, env);

      // Calculate next run time using schedule
      const nextRun = calculateNextRun(job.schedule, now);
      await env.DB
        .prepare('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?')
        .bind(now, nextRun, job.id)
        .run();

      await logAudit(
        {
          userId: job.user_id,
          serverId: job.server_id,
          action: 'cron.job.dispatched',
          details: { jobId: job.id, jobName: job.name, action: job.action },
        },
        env.DB,
      );
    } catch (err) {
      logger.error({ jobId: job.id, err }, 'Cron job dispatch failed');
    }
  }

  if (dueJobs.results.length > 0) {
    logger.info({ dispatched: dueJobs.results.length }, 'Job dispatch cron complete');
  }
}

async function dispatchJob(job: CronJob, env: Env): Promise<void> {
  // Forward job action to daemon via DaemonBridge
  const doId = env.DAEMON_BRIDGE.idFromName(job.server_id);
  const stub = env.DAEMON_BRIDGE.get(doId);

  const payload = JSON.stringify({
    type: 'cron.action',
    jobId: job.id,
    jobName: job.name,
    action: job.action,
    timestamp: Date.now(),
  });

  const res = await stub.fetch(
    new Request('https://dummy/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
  );

  if (!res.ok) {
    throw new Error(`DaemonBridge dispatch failed: ${res.status}`);
  }
}

/**
 * Simple cron schedule parser for next run time.
 * Supports: every N minutes (* / N * * * *), hourly, daily.
 * For production, use a proper cron library.
 */
function calculateNextRun(schedule: string, fromMs: number): number {
  // Parse basic patterns: */5 * * * * = every 5 minutes
  const match = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (match) {
    const intervalMin = parseInt(match[1], 10);
    return fromMs + intervalMin * 60 * 1000;
  }

  // Default: 1 hour
  return fromMs + 3600 * 1000;
}
