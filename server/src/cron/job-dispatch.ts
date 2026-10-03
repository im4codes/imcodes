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

type ClaimedCronJob = DbCronJob & {
  previous_run_at?: number | null;
  /** Stable outbox id; present for transactional claims and recovery. */
  execution_id?: string;
};

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
    previousRunAt: job.last_run_at,
    nextRunAt: job.next_run_at,
    ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
    action,
  };
  bridge.sendToDaemon(JSON.stringify(msg));

  await logExecution(env, executionId, job.id, 'manual_trigger');
  logger.info({ jobId: job.id, jobName: job.name }, 'Cron job manually triggered');
}

/**
 * Claim due occurrences before doing any external work.
 *
 * The old dispatcher only advanced `last_run_at` in the claim statement and
 * advanced `next_run_at` after sending to the daemon.  A process crash (or a
 * pod restart) in that window left the same occurrence due, so the next tick
 * sent it again.  Keep the lock, schedule advancement, and returned claim in
 * one transaction; once it commits, a restart can only observe the following
 * occurrence.  The send itself remains outside the transaction so a slow or
 * disconnected daemon never holds a row lock.
 */
async function claimDueJobs(
  env: Env,
  now: number,
): Promise<ClaimedCronJob[]> {
  const selectDue = async (db: typeof env.DB): Promise<ClaimedCronJob[]> => (
    db.query<DbCronJob & { previous_run_at?: number | null }>(
      `SELECT *, last_run_at AS previous_run_at FROM cron_jobs
       WHERE status = $2 AND next_run_at <= $1
         AND (expires_at IS NULL OR expires_at >= $1)
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED`,
      [now, CRON_STATUS.ACTIVE],
    )
  );

  // Production Database always exposes transaction().  Keep the direct path
  // for the small database-shaped test seams and older embedders; it still
  // advances each occurrence before its external send (see the loop below).
  const transaction = (env.DB as typeof env.DB & {
    transaction?: <T>(fn: (tx: typeof env.DB) => Promise<T>) => Promise<T>;
  }).transaction;
  if (typeof transaction === 'function') {
    return await transaction.call(env.DB, async (tx) => {
      const jobs = await selectDue(tx);
      const claimed: ClaimedCronJob[] = [];
      for (const job of jobs) {
        const nextRun = calculateNextRun(job.cron_expr, now, job.timezone);
        const result = await tx.execute(
          'UPDATE cron_jobs SET last_run_at = $1, next_run_at = $2 WHERE id = $3 AND status = $4 AND next_run_at <= $1',
          [now, nextRun, job.id, CRON_STATUS.ACTIVE],
        );
        if (result.changes !== 1) continue;
        const executionId = randomHex(12);
        // cron_executions doubles as a small durable outbox.  The schedule
        // claim and its dispatch intent commit together, so a restart can
        // recover the intent even if it dies before the WS send.
        await tx.execute(
          'INSERT INTO cron_executions (id, job_id, status, detail, created_at) VALUES ($1, $2, $3, $4, $5)',
          [executionId, job.id, 'pending_dispatch', JSON.stringify({ previousRunAt: job.last_run_at, nextRunAt: nextRun }), now],
        );
        claimed.push({ ...job, last_run_at: now, next_run_at: nextRun, execution_id: executionId });
      }
      return claimed;
    }) as ClaimedCronJob[];
  }

  // Compatibility fallback: the query's row lock is released when the query
  // returns, so advance each row immediately before it is sent.  Real
  // deployments use the transactional path above.
  const jobs = await env.DB.query<DbCronJob & { previous_run_at?: number | null }>(
    `WITH due AS (
       SELECT id, last_run_at AS previous_run_at FROM cron_jobs
       WHERE status = $2 AND next_run_at <= $1
         AND (expires_at IS NULL OR expires_at >= $1)
       ORDER BY next_run_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
     )
     UPDATE cron_jobs SET last_run_at = $1
     FROM due WHERE cron_jobs.id = due.id
     RETURNING cron_jobs.*, due.previous_run_at`,
    [now, CRON_STATUS.ACTIVE],
  );
  return jobs;
}

async function recoverPendingDispatches(env: Env): Promise<ClaimedCronJob[]> {
  // Older database-shaped test seams and embedders do not have the
  // transaction/outbox contract; their CTE claim remains the compatibility
  // path and has no recoverable intent rows.
  if (typeof (env.DB as typeof env.DB & { transaction?: unknown }).transaction !== 'function') return [];
  const transaction = (env.DB as typeof env.DB & {
    transaction?: <T>(fn: (tx: typeof env.DB) => Promise<T>) => Promise<T>;
  }).transaction!;
  const now = Date.now();
  return transaction(async (tx) => {
    const rows = await tx.query<ClaimedCronJob & { execution_detail?: string | null }>(
      `SELECT j.*, e.id AS execution_id, e.detail AS execution_detail
         FROM cron_executions e
         JOIN cron_jobs j ON j.id = e.job_id
        WHERE e.status = 'pending_dispatch'
           OR (e.status = 'dispatching' AND e.created_at <= $1)
        ORDER BY e.created_at ASC
        LIMIT 50
        FOR UPDATE OF e SKIP LOCKED`,
      [now - 60_000],
    );
    const claimed: ClaimedCronJob[] = [];
    for (const row of rows.filter((candidate) => typeof candidate.execution_id === 'string' && candidate.execution_id.length > 0)) {
      let detail: { previousRunAt?: number | null; nextRunAt?: number } = {};
      try {
        detail = row.execution_detail ? JSON.parse(row.execution_detail) as typeof detail : {};
      } catch { /* malformed outbox detail is handled as the current job */ }
      await tx.execute(
        'UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status IN ($4, $5)',
        ['dispatching', JSON.stringify({ ...detail, claimedAt: now }), row.execution_id, 'pending_dispatch', 'dispatching'],
      );
      claimed.push({
        ...row,
        ...(detail.previousRunAt !== undefined ? { previous_run_at: detail.previousRunAt } : {}),
        ...(detail.nextRunAt !== undefined ? { next_run_at: detail.nextRunAt } : {}),
      });
    }
    return claimed;
  });
}

export async function jobDispatchCron(env: Env): Promise<void> {
  const now = Date.now();
  // Replay durable intents first.  They were claimed by a prior tick but may
  // not have reached the daemon before a server restart.
  const pendingJobs = await recoverPendingDispatches(env);
  const dueJobs = [...pendingJobs, ...(await claimDueJobs(env, now))];

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
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
            'error', prepared.reason, job.execution_id, 'dispatching',
          ]);
        }
        await logExecution(env, randomHex(12), job.id, 'error', prepared.reason);
        continue;
      }
      const action = prepared.action;

      // Skip if daemon offline (fire-and-forget)
      const bridge = WsBridge.get(job.server_id);
      if (!bridge.isDaemonConnected()) {
        logger.debug({ jobId: job.id }, 'Cron skipped: daemon offline');
        const nextRun = job.next_run_at ?? calculateNextRun(job.cron_expr, now, job.timezone);
        await env.DB.execute('UPDATE cron_jobs SET next_run_at = $1 WHERE id = $2', [nextRun, job.id]);
        if (job.execution_id) {
          await env.DB.execute('UPDATE cron_executions SET status = $1 WHERE id = $2 AND status = $3', [
            'pending_dispatch', job.execution_id, 'dispatching',
          ]);
        } else {
          await logExecution(env, randomHex(12), job.id, 'skipped_offline');
        }
        continue;
      }

      // Dispatch to daemon.  Transactional claims already advanced the
      // schedule.  Database-shaped fallback callers claim only last_run_at,
      // so advance next_run_at immediately before this external side effect.
      if (!(env.DB as typeof env.DB & { transaction?: unknown }).transaction) {
        const fallbackNextRun = calculateNextRun(job.cron_expr, now, job.timezone);
        const fallbackExecutionId = randomHex(12);
        // Compatibility databases without Database.transaction still get one
        // PostgreSQL statement for schedule advancement + outbox insertion;
        // there is no update→insert crash gap. Production always takes the
        // stronger transaction path above.
        await env.DB.execute(
          `WITH claimed AS (
             UPDATE cron_jobs SET next_run_at = $1
              WHERE id = $2 AND last_run_at = $3
              RETURNING id
           )
           INSERT INTO cron_executions (id, job_id, status, detail, created_at)
           SELECT $4, id, $5, $6, $7 FROM claimed`,
          [fallbackNextRun, job.id, now, fallbackExecutionId, 'pending_dispatch', JSON.stringify({ previousRunAt: job.previous_run_at ?? job.last_run_at, nextRunAt: fallbackNextRun }), now],
        );
        job.next_run_at = fallbackNextRun;
        job.execution_id = fallbackExecutionId;
      }
      if (!job.target_role) {
        logger.warn({ jobId: job.id }, 'Cron: target_role is NULL, defaulting to brain');
      }
      // Use the value written by the claim, rather than recalculating it after
      // the claim, so the payload always describes the durable occurrence.
      const nextRun = job.next_run_at ?? calculateNextRun(job.cron_expr, now, job.timezone);
      const msg: CronDispatchMessage = {
        type: CRON_MSG.DISPATCH,
        jobId: job.id,
        executionId: job.execution_id ?? randomHex(12),
        jobName: job.name,
        serverId: job.server_id,
        projectName: job.project_name ?? '',
        targetRole: job.target_role ?? 'brain',
        cronExpr: job.cron_expr,
        timezone: job.timezone,
        expiresAt: job.expires_at,
        completionPolicy: normalizeCronCompletionPolicy(job.completion_policy),
        previousRunAt: Object.prototype.hasOwnProperty.call(job, 'previous_run_at')
          ? job.previous_run_at
          : job.last_run_at,
        nextRunAt: nextRun,
        ...(job.target_session_name ? { targetSessionName: job.target_session_name } : {}),
        action,
      };
      bridge.sendToDaemon(JSON.stringify(msg));

      // Transactional claims advanced the schedule before this send.  The
      // fallback advanced it immediately above; do not leave a post-send
      // write window in which a restart can redispatch the same occurrence.

      // Auto-expire if next run is past expiration
      if (job.expires_at && nextRun > job.expires_at) {
        await env.DB.execute('UPDATE cron_jobs SET status = $1 WHERE id = $2', [CRON_STATUS.EXPIRED, job.id]);
      }

      if (job.execution_id) {
        await env.DB.execute('UPDATE cron_executions SET status = $1, detail = $2 WHERE id = $3 AND status = $4', [
          'dispatched', null, job.execution_id, 'dispatching',
        ]);
      } else {
        await logExecution(env, msg.executionId!, job.id, 'dispatched');
      }

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
