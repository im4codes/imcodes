import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CRON_COMPLETION_POLICY,
  CRON_STATUS,
  CRON_MSG,
  buildLegacyCronControlBlock,
  type CronDispatchMessage,
} from '../../shared/cron-types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSendToDaemon = vi.fn();
const mockIsDaemonConnected = vi.fn(() => true);
vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: mockSendToDaemon,
      isDaemonConnected: mockIsDaemonConnected,
    }),
  },
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn(),
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: (n: number) => 'a'.repeat(n * 2),
}));

const dbRows: Record<string, unknown>[] = [];
const dbExecutes: Array<{ sql: string; params: unknown[] }> = [];
const mockEnv = {
  DB: {
    query: vi.fn(async () => dbRows),
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      dbExecutes.push({ sql, params });
      return { changes: 1 };
    }),
  },
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('jobDispatchCron', () => {
  let jobDispatchCron: typeof import('../src/cron/job-dispatch.js').jobDispatchCron;
  let dispatchJobNow: typeof import('../src/cron/job-dispatch.js').dispatchJobNow;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbRows.length = 0;
    dbExecutes.length = 0;
    mockIsDaemonConnected.mockReturnValue(true);
    // Force Math.random to return a high value so cleanup doesn't fire
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const mod = await import('../src/cron/job-dispatch.js');
    jobDispatchCron = mod.jobDispatchCron;
    dispatchJobNow = mod.dispatchJobNow;
  });

  it('dispatches due jobs via WsBridge', async () => {
    dbRows.push({
      id: 'j1', server_id: 's1', user_id: 'u1', name: 'Test Job',
      cron_expr: '*/10 * * * *', action: '{"type":"command","command":"hello"}',
      project_name: 'myapp', target_role: 'brain', status: 'active',
      timezone: 'Asia/Shanghai',
      last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    expect(mockSendToDaemon).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockSendToDaemon.mock.calls[0][0]) as CronDispatchMessage;
    expect(sent.type).toBe(CRON_MSG.DISPATCH);
    expect(sent.jobId).toBe('j1');
    expect(sent.executionId).toBe('a'.repeat(24));
    expect(sent.projectName).toBe('myapp');
    expect(sent.targetRole).toBe('brain');
    expect(sent.cronExpr).toBe('*/10 * * * *');
    expect(sent.timezone).toBe('Asia/Shanghai');
    expect(sent.expiresAt).toBeNull();
    expect(sent.completionPolicy).toBe(CRON_COMPLETION_POLICY.RECURRING);
    expect(sent.action).toEqual({ type: 'command', command: 'hello' });
  });

  it('durably migrates a legacy self-managed row before dispatching its registered contract', async () => {
    const legacyCommand = `Inspect progress\n\n${buildLegacyCronControlBlock(
      'legacy-self',
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    )}`;
    dbRows.push({
      id: 'legacy-self', server_id: 's1', user_id: 'u1', name: 'Legacy Self',
      cron_expr: '*/10 * * * *',
      action: JSON.stringify({ type: 'command', command: legacyCommand, selfManaged: true }),
      project_name: 'myapp', target_role: 'brain', status: 'active',
      completion_policy: CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
      timezone: 'Asia/Shanghai', last_run_at: null,
      next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    const migration = dbExecutes.find((entry) => (
      entry.sql.includes('UPDATE cron_jobs SET action') && entry.params.includes('legacy-self')
    ));
    expect(migration).toBeDefined();
    const persisted = JSON.parse(String(migration?.params[0])) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      type: 'command', command: 'Inspect progress', selfManaged: true,
      cronControl: {
        contractId: 'supervision_cron_control_v1', version: 1,
        scheduleId: 'legacy-self',
      },
    });
    const sent = JSON.parse(mockSendToDaemon.mock.calls[0][0]) as CronDispatchMessage;
    expect(sent.action).toEqual(persisted);

    // A restart hydrates the durable registration without rewriting it.
    dbRows[0]!.action = String(migration?.params[0]);
    dbExecutes.length = 0;
    mockSendToDaemon.mockClear();
    await jobDispatchCron(mockEnv);
    expect(mockSendToDaemon).toHaveBeenCalledOnce();
    expect(dbExecutes.some((entry) => entry.sql.includes('UPDATE cron_jobs SET action'))).toBe(false);
  });

  it('hydrates and persists the same registered contract on manual dispatch', async () => {
    const job = {
      id: 'manual-self', server_id: 's1', user_id: 'u1', name: 'Manual Self',
      cron_expr: '*/10 * * * *',
      action: JSON.stringify({ type: 'command', command: 'Inspect manually', selfManaged: true }),
      project_name: 'myapp', target_role: 'brain', target_session_name: null, status: 'active',
      completion_policy: CRON_COMPLETION_POLICY.RECURRING,
      timezone: null, last_run_at: null, next_run_at: Date.now(), expires_at: null,
      created_at: Date.now(), updated_at: null,
    } as any;

    await dispatchJobNow(mockEnv, job);

    const migration = dbExecutes.find((entry) => entry.sql.includes('UPDATE cron_jobs SET action'));
    expect(migration).toBeDefined();
    expect(JSON.parse(String(migration?.params[0]))).toMatchObject({
      command: 'Inspect manually',
      cronControl: { contractId: 'supervision_cron_control_v1', scheduleId: 'manual-self' },
    });
    expect(JSON.parse(mockSendToDaemon.mock.calls[0][0]).action)
      .toEqual(JSON.parse(String(migration?.params[0])));
  });

  it.each([
    ['unknown version', { contractId: 'supervision_cron_control_v1', version: 9, scheduleId: 'bad-control', constraints: {} }],
    ['task mismatch', { contractId: 'supervision_cron_control_v1', version: 1, scheduleId: 'other', constraints: {} }],
    ['tampered ref', { contractId: 'unknown_v9', version: 1, scheduleId: 'bad-control', constraints: {} }],
  ])('fails closed on %s instead of dispatching without constraints', async (_label, cronControl) => {
    dbRows.push({
      id: 'bad-control', server_id: 's1', user_id: 'u1', name: 'Bad Control',
      cron_expr: '*/10 * * * *',
      action: JSON.stringify({ type: 'command', command: 'Inspect progress', selfManaged: true, cronControl }),
      project_name: 'myapp', target_role: 'brain', status: 'active',
      completion_policy: CRON_COMPLETION_POLICY.RECURRING,
      timezone: null, last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(dbExecutes.some((entry) => entry.params.includes(CRON_STATUS.ERROR))).toBe(true);
  });

  it('skips when daemon is offline and advances next_run_at', async () => {
    mockIsDaemonConnected.mockReturnValue(false);
    dbRows.push({
      id: 'j2', server_id: 's1', user_id: 'u1', name: 'Offline Job',
      cron_expr: '*/10 * * * *', action: '{"type":"command","command":"test"}',
      project_name: 'myapp', target_role: 'brain', status: 'active',
      last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    expect(mockSendToDaemon).not.toHaveBeenCalled();
    // next_run_at should be advanced
    const nextRunUpdate = dbExecutes.find(e => e.sql.includes('next_run_at'));
    expect(nextRunUpdate).toBeDefined();
    // execution log should show skipped_offline
    const execLog = dbExecutes.find(e => e.sql.includes('cron_executions'));
    expect(execLog).toBeDefined();
    expect(execLog!.params).toContain('skipped_offline');
  });

  it('marks job as error on invalid JSON action', async () => {
    dbRows.push({
      id: 'j3', server_id: 's1', user_id: 'u1', name: 'Bad JSON',
      cron_expr: '*/10 * * * *', action: 'not valid json {',
      project_name: 'myapp', target_role: 'brain', status: 'active',
      last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    expect(mockSendToDaemon).not.toHaveBeenCalled();
    const statusUpdate = dbExecutes.find(e => e.sql.includes('status') && e.params.includes(CRON_STATUS.ERROR));
    expect(statusUpdate).toBeDefined();
  });

  it('auto-expires job when next_run_at exceeds expires_at', async () => {
    const now = Date.now();
    dbRows.push({
      id: 'j4', server_id: 's1', user_id: 'u1', name: 'Expiring Job',
      cron_expr: '0 0 1 1 *', // once a year — next_run will be far in future
      action: '{"type":"command","command":"yearly"}',
      project_name: 'myapp', target_role: 'brain', status: 'active',
      last_run_at: null, next_run_at: now - 1000,
      expires_at: now + 1000, // expires very soon
      created_at: now, updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    expect(mockSendToDaemon).toHaveBeenCalledOnce();
    const expiredUpdate = dbExecutes.find(e => e.params.includes(CRON_STATUS.EXPIRED));
    expect(expiredUpdate).toBeDefined();
  });

  it('logs execution on successful dispatch', async () => {
    dbRows.push({
      id: 'j5', server_id: 's1', user_id: 'u1', name: 'Log Test',
      cron_expr: '*/10 * * * *', action: '{"type":"command","command":"test"}',
      project_name: 'myapp', target_role: 'brain', status: 'active',
      last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
      created_at: Date.now(), updated_at: null,
    });

    await jobDispatchCron(mockEnv);

    const execLog = dbExecutes.filter(e => e.sql.includes('cron_executions'));
    expect(execLog.length).toBeGreaterThan(0);
    expect(execLog.some(e => e.params.includes('dispatched'))).toBe(true);
  });

  it('runs cleanup probabilistically', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.001); // triggers cleanup

    await jobDispatchCron(mockEnv);

    const cleanup = dbExecutes.find(e => e.sql.includes('DELETE FROM cron_executions'));
    expect(cleanup).toBeDefined();
  });

  it('does not run cleanup when random is high', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await jobDispatchCron(mockEnv);

    const cleanup = dbExecutes.find(e => e.sql.includes('DELETE FROM cron_executions'));
    expect(cleanup).toBeUndefined();
  });

  it('continues processing remaining jobs after one fails JSON parse', async () => {
    dbRows.push(
      {
        id: 'bad', server_id: 's1', user_id: 'u1', name: 'Bad',
        cron_expr: '*/10 * * * *', action: 'INVALID',
        project_name: 'myapp', target_role: 'brain', status: 'active',
        last_run_at: null, next_run_at: Date.now() - 2000, expires_at: null,
        created_at: Date.now(), updated_at: null,
      },
      {
        id: 'good', server_id: 's1', user_id: 'u1', name: 'Good',
        cron_expr: '*/10 * * * *', action: '{"type":"command","command":"ok"}',
        project_name: 'myapp', target_role: 'brain', status: 'active',
        last_run_at: null, next_run_at: Date.now() - 1000, expires_at: null,
        created_at: Date.now(), updated_at: null,
      },
    );

    await jobDispatchCron(mockEnv);

    // Bad job marked as error
    expect(dbExecutes.some(e => e.params.includes(CRON_STATUS.ERROR) && e.params.includes('bad'))).toBe(true);
    // Good job still dispatched
    expect(mockSendToDaemon).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockSendToDaemon.mock.calls[0][0]);
    expect(sent.jobId).toBe('good');
  });
});
