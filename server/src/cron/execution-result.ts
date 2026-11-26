/**
 * What a daemon may write into `cron_executions`.
 *
 * `cron.command_result` / `cron.p2p_linked` carry a job id and an execution id chosen by the daemon. Execution ids are visible to
 * share participants (the cron routes list them), so the id alone must never be the key: every statement is bound to the jobs of the
 * AUTHENTICATED server, or a daemon of another user could overwrite a victim's execution rows. It also must not be able to set the
 * scheduler's own states -- `pending_dispatch` makes the dispatcher run the job's action again.
 */
export const CRON_DISPATCHER_OWNED_STATUSES: ReadonlySet<string> = new Set(['pending_dispatch', 'dispatching']);

export interface CronExecutionResultUpdate {
  sql: string;
  params: unknown[];
}

const OWN_JOB = 'job_id IN (SELECT id FROM cron_jobs WHERE server_id = $SERVER)';

/** Update of the execution a daemon reports on, or null when nothing may be written. */
export function buildCronExecutionResultUpdate(input: {
  authenticatedServerId: string;
  jobId: string;
  executionId?: string;
  status?: string;
  detail: string;
}): CronExecutionResultUpdate | null {
  if (!input.authenticatedServerId || !input.jobId) return null;
  if (input.status && CRON_DISPATCHER_OWNED_STATUSES.has(input.status)) return null;
  const params: unknown[] = [input.detail];
  const next = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  const setStatus = input.status ? `, status = ${next(input.status)}` : '';
  const server = next(input.authenticatedServerId);
  const own = OWN_JOB.replace('$SERVER', server);
  if (input.executionId) {
    const execution = next(input.executionId);
    const job = next(input.jobId);
    return {
      sql: `UPDATE cron_executions SET detail = $1${setStatus} WHERE id = ${execution} AND job_id = ${job} AND ${own}`,
      params,
    };
  }
  const job = next(input.jobId);
  return {
    sql: `UPDATE cron_executions SET detail = $1${setStatus} WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = ${job} AND ${own} ORDER BY created_at DESC LIMIT 1
           )`,
    params,
  };
}
