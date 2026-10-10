/**
 * tsk_854675e1e2: `cron.command_result` carried a job id / execution id chosen by the daemon and the UPDATE keyed on it alone, so a
 * daemon of another user who knew an execution id (the cron routes list them to share participants) could overwrite its detail, or
 * set `pending_dispatch` and make the dispatcher run the victim's action again.
 */
import { describe, expect, it } from 'vitest';
import { buildCronExecutionResultUpdate } from '../src/cron/execution-result.js';

describe('buildCronExecutionResultUpdate', () => {
  it('binds every statement to the jobs of the authenticated server', () => {
    const withExecution = buildCronExecutionResultUpdate({ authenticatedServerId: 'srv-A', jobId: 'job-1', executionId: 'exec-1', status: 'error', detail: 'd' })!;
    expect(withExecution.sql).toContain('job_id IN (SELECT id FROM cron_jobs WHERE server_id = $3)');
    expect(withExecution.params).toContain('srv-A');
    expect(withExecution.params).toEqual(['d', 'error', 'srv-A', 'exec-1', 'job-1']);

    const latest = buildCronExecutionResultUpdate({ authenticatedServerId: 'srv-A', jobId: 'job-1', detail: 'd' })!;
    expect(latest.sql).toContain('cron_jobs WHERE server_id = $2');
    expect(latest.sql).toContain('job_id = $3');
    expect(latest.params).toEqual(['d', 'srv-A', 'job-1']);
  });

  it('never lets a daemon set the dispatcher\'s own states (pending_dispatch re-runs the job)', () => {
    for (const status of ['pending_dispatch', 'dispatching']) {
      expect(buildCronExecutionResultUpdate({ authenticatedServerId: 'srv-A', jobId: 'j', executionId: 'e', status, detail: 'd' })).toBeNull();
    }
    expect(buildCronExecutionResultUpdate({ authenticatedServerId: 'srv-A', jobId: 'j', executionId: 'e', status: 'skipped_busy', detail: 'd' })).not.toBeNull();
  });

  it('writes nothing without an authenticated server or a job', () => {
    expect(buildCronExecutionResultUpdate({ authenticatedServerId: '', jobId: 'j', detail: 'd' })).toBeNull();
    expect(buildCronExecutionResultUpdate({ authenticatedServerId: 's', jobId: '', detail: 'd' })).toBeNull();
  });
});
