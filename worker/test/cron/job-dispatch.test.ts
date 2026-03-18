import { describe, it, expect, vi } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock audit logger
vi.mock('../../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { jobDispatchCron } from '../../src/cron/job-dispatch.js';

function makeStmt(rows: unknown[] = []) {
  return {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: rows }),
    run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
  };
}

function mockEnv(dueJobs: unknown[] = []) {
  const jobsStmt = makeStmt(dueJobs);
  const updateStmt = makeStmt();

  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT')) return jobsStmt;
    return updateStmt;
  });

  const mockStub = {
    fetch: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
  };
  const daemonBridge = {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue(mockStub),
  };

  return {
    DB: { prepare },
    DAEMON_BRIDGE: daemonBridge,
    _jobsStmt: jobsStmt,
    _updateStmt: updateStmt,
    _stub: mockStub,
  };
}

describe('jobDispatchCron', () => {
  it('is a function', () => {
    expect(typeof jobDispatchCron).toBe('function');
  });

  it('resolves without error when no jobs are due', async () => {
    const env = mockEnv([]);
    await expect(jobDispatchCron(env as never)).resolves.toBeUndefined();
  });

  it('queries cron_jobs for due jobs', async () => {
    const env = mockEnv([]);
    await jobDispatchCron(env as never);

    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('cron_jobs'),
    );
  });

  it('dispatches each due job via DaemonBridge', async () => {
    const dueJobs = [
      { id: 'job-1', server_id: 'srv-1', user_id: 'u1', name: 'Job 1', schedule: '*/5 * * * *', action: 'restart', next_run_at: 1000 },
    ];
    const env = mockEnv(dueJobs);

    await jobDispatchCron(env as never);

    expect(env.DAEMON_BRIDGE.idFromName).toHaveBeenCalledWith('srv-1');
    expect(env._stub.fetch).toHaveBeenCalledOnce();
  });

  it('updates next_run_at after dispatching a job', async () => {
    const dueJobs = [
      { id: 'job-1', server_id: 'srv-1', user_id: 'u1', name: 'Job 1', schedule: '*/5 * * * *', action: 'restart', next_run_at: 1000 },
    ];
    const env = mockEnv(dueJobs);

    await jobDispatchCron(env as never);

    expect(env._updateStmt.run).toHaveBeenCalled();
  });

  it('handles dispatch failure gracefully without throwing', async () => {
    const dueJobs = [
      { id: 'job-1', server_id: 'srv-1', user_id: 'u1', name: 'Bad Job', schedule: '*/1 * * * *', action: 'fail', next_run_at: 1000 },
    ];
    const env = mockEnv(dueJobs);
    // Make the DaemonBridge stub return a non-ok response
    env._stub.fetch.mockResolvedValue(new Response('error', { status: 500 }));

    await expect(jobDispatchCron(env as never)).resolves.toBeUndefined();
  });
});

// calculateNextRun is not exported — test its behavior indirectly via schedule patterns
describe('schedule interval behavior (via jobDispatchCron)', () => {
  it('processes */5 * * * * schedule without error', async () => {
    const dueJobs = [
      { id: 'job-1', server_id: 'srv-1', user_id: 'u1', name: 'J', schedule: '*/5 * * * *', action: 'act', next_run_at: 1 },
    ];
    const env = mockEnv(dueJobs);
    await expect(jobDispatchCron(env as never)).resolves.toBeUndefined();
  });

  it('processes unknown schedule format without error (defaults to 1hr)', async () => {
    const dueJobs = [
      { id: 'job-2', server_id: 'srv-1', user_id: 'u1', name: 'J', schedule: '0 9 * * 1', action: 'act', next_run_at: 1 },
    ];
    const env = mockEnv(dueJobs);
    await expect(jobDispatchCron(env as never)).resolves.toBeUndefined();
  });
});
