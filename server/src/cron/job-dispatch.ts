/**
 * Cron handler: every minute — find due cron_jobs, dispatch via WsBridge.
 */
import { Cron } from 'croner';
import type { Env } from '../env.js';
import type { DbCronJob } from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import { logAudit } from '../security/audit.js';
import { randomHex } from '../security/crypto.js';
import {
  CRON_MSG,
  CRON_STATUS,
  normalizeCronCompletionPolicy,
  registerCronControlAction,
  type CronAction,
  type CronDispatchMessage,
} from '../../../shared/cron-types.js';
import logger from '../util/logger.js';

type PreparedCronAction =
  | { ok: true; action: CronAction }
  | { ok: false; reason: string };

/** Parse, validate and durably register legacy self-managed actions before use. */
async function prepareCronAction(env: Env, job: DbCronJob): Promise<PreparedCronAction> {
  let action: CronAction;
  try {
    action = JSON.parse(job.action) as CronAction;
  } catch {
    return { ok: false, reason: 'invalid_action' };
  }
  if (action.type !== 'command' || action.selfManaged !== true) return { ok: true, action };
  if (typeof action.command !== 'string') return { ok: false, reason: 'missing_authoritative_body' };
  const registered = registerCronControlAction(
    action,
    job.id,
    normalizeCronCompletionPolicy(job.completion_policy),
  );
  if (!registered.ok) return registered;
  if (registered.migrated) {
    const nextAction = JSON.stringify(registered.action);
    const result = await env.DB.execute(
      'UPDATE cron_jobs SET action = $1, updated_at = $2 WHERE id = $3 AND action = $4',
      [nextAction, Date.now(), job.id, job.action],
    );
    if (result.changes !== 1) return { ok: false, reason: 'cron_control_migration_conflict' };
    job.action = nextAction;
  }
  return { ok: true, action: registered.action };
}

/** Immediately dispatch a single cron job (for manual "Run Now" trigger). */
export async function dispatchJobNow(env: Env, job: DbCronJob): Promise<void> {
  const prepared = await prepareCronAction(env, job);
  if (!prepared.ok) {
    await logExecution(env, randomHex(12), job.id, 'error', prepared.reason);
    throw new Error(prepared.reason);
  }
  const action = prepared.action;

  const bridge = WsBridge.get(job.server_id);
  if (!bridge.isDaemonConnected()) {
    await logExecution(env, randomHex(12), job.id, 'skipped_offline');
    throw new Error('daemon_offline');
  }

  if (!job.target_role) {
    logger.warn({ jobId: job.id }, 'Cron manual trigger: target_role is NULL, defaulting to brain');
  }
  const executionId = randomHex(12);
  const msg: CronDispatchMessage = {
    type: CRON_MSG.DISPATCH,
    jobId: job.id,
    executionId,
    jobName: job.name,
    serverId: job.server_id,
    projectName: job.project_name ?? '',
    targetRole: job.target_role ?? 'brain',
    cronExpr: job.cron_expr,
    timezone: job.timezone,
    expiresAt: job.expires_at,
    completionPolicy: normalizeCronCompletionPolicy(job.completion_policy),
    ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
    action,
  };
  bridge.sendToDaemon(JSON.stringify(msg));

  await logExecution(env, executionId, job.id, 'manual_trigger');
  logger.info({ jobId: job.id, jobName: job.name }, 'Cron job manually triggered');
}

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();

  // Atomic select + lock — prevents double-dispatch from concurrent ticks
  const dueJobs = await env.DB.query<DbCronJob>(
    `WITH due AS (
       SELECT id FROM cron_jobs
       WHERE status = $2 AND next_run_at <= $1
         AND (expires_at IS NULL OR expires_at >= $1)
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     UPDATE cron_jobs SET last_run_at = $1
     FROM due WHERE cron_jobs.id = due.id
     RETURNING cron_jobs.*`,
    [now, CRON_STATUS.ACTIVE],
  );

  // Periodic cleanup of old execution history (~1% of ticks)
  if (Math.random() < 0.01) {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    await env.DB.execute('DELETE FROM cron_executions WHERE created_at < $1', [thirtyDaysAgo]).catch(() => {});
  }

  for (const job of dueJobs) {
    try {
      const prepared = await prepareCronAction(env, job);
      if (!prepared.ok) {
        logger.error({ jobId: job.id, reason: prepared.reason }, 'Cron job has invalid action/control state, marking as error');
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.ERROR, job.id]);
        await logExecution(env, randomHex(12), job.id, 'error', prepared.reason);
        continue;
      }
      const action = prepared.action;

      // Skip if daemon offline (fire-and-forget)
      const bridge = WsBridge.get(job.server_id);
      if (!bridge.isDaemonConnected()) {
        logger.debug({ jobId: job.id }, 'Cron skipped: daemon offline');
        const nextRun = calculateNextRun(job.cron_expr, now, job.timezone);
        await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);
        await logExecution(env, randomHex(12), job.id, 'skipped_offline');
        continue;
      }

      // Dispatch to daemon
      if (!job.target_role) {
        logger.warn({ jobId: job.id }, 'Cron: target_role is NULL, defaulting to brain');
      }
      const msg: CronDispatchMessage = {
        type: CRON_MSG.DISPATCH,
        jobId: job.id,
        executionId: randomHex(12),
        jobName: job.name,
        serverId: job.server_id,
        projectName: job.project_name ?? '',
        targetRole: job.target_role ?? 'brain',
        cronExpr: job.cron_expr,
        timezone: job.timezone,
        expiresAt: job.expires_at,
        completionPolicy: normalizeCronCompletionPolicy(job.completion_policy),
        ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
        action,
      };
      bridge.sendToDaemon(JSON.stringify(msg));

      // Advance schedule
      const nextRun = calculateNextRun(job.cron_expr, now, job.timezone);
      await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);

      // Auto-expire if next run is past expiration
      if (job.expires_at && nextRun > job.expires_at) {
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.EXPIRED, job.id]);
      }

      await logExecution(env, msg.executionId!, job.id, 'dispatched');

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

async function logExecution(env: Env, executionId: string, jobId: string, status: string, detail?: string): Promise<void> {
  await env.DB.execute(
    'INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
    [executionId, jobId, status, detail ?? null, Date.now()],
  ).catch((err) => logger.error({ jobId, err }, 'Failed to log cron execution'));
}

function calculateNextRun(cronExpr: string, fromMs: number, timezone?: string | null): number {
  try {
    const opts = timezone ? { timezone } : undefined;
    const job = new Cron(cronExpr, opts);
    const next = job.nextRun(new Date(fromMs));
    return next ? next.getTime() : fromMs + 60_000;
  } catch {
    return fromMs + 60_000;
  }
}
