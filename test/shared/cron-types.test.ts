import { describe, expect, it } from 'vitest';
import {
  CRON_COMPLETION_POLICY,
  CRON_CONTROL_CONTRACT,
  CRON_MSG,
  LEGACY_CRON_CONTROL_CONTRACT_V1,
  buildCronRunTimelineProjection,
  buildRegisteredCronSystemContract,
  buildLegacyCronControlBlock,
  normalizeCronExecutionDetail,
  registerCronControlAction,
  validateRegisteredCronControlAction,
} from '../../shared/cron-types.js';

describe('normalizeCronExecutionDetail', () => {
  it('recovers the newest snapshot from legacy cumulative streaming history', () => {
    const snapshots = [
      '主人',
      '主人，大头开始',
      '主人，大头开始执行今天',
      '主人，大头开始执行今天的统一追踪。\n先筛',
      '主人，大头开始执行今天的统一追踪。\n先筛一只不重复的新股票。',
    ];

    expect(normalizeCronExecutionDetail(snapshots.join('\n'))).toBe(snapshots.at(-1));
  });

  it('recovers the latest available partial snapshot when the old 4KB cap cut off the final event', () => {
    const snapshots = [
      'The answer',
      'The answer for',
      'The answer for today',
      'The answer for today contains',
      'The answer for today contains the latest partial result',
    ];
    expect(normalizeCronExecutionDetail(snapshots.join('\n'))).toBe(snapshots.at(-1));
  });

  it('does not rewrite ordinary multiline Markdown or short prefix-shaped prose', () => {
    const markdown = '# Result\n\n- first\n- second\n\n```ts\nconst value = 1;\n```';
    const prefixShapedProse = 'Step\nStep one\nStep one complete';
    const longerPrefixExample = 'A longer example\nA longer example one\nA longer example one two\nA longer example one two three';

    expect(normalizeCronExecutionDetail(markdown)).toBe(markdown);
    expect(normalizeCronExecutionDetail(prefixShapedProse)).toBe(prefixShapedProse);
    expect(normalizeCronExecutionDetail(longerPrefixExample)).toBe(longerPrefixExample);
  });
});

describe('registered cron control state', () => {
  it('pins the complete v2 execution authority behind the compact reference', () => {
    expect(CRON_CONTROL_CONTRACT).toEqual({
      contractId: 'supervision_cron_control_v2',
      version: 2,
      constraints: {
        authorization: 'user_authorized_scheduled_execution',
        executeTaskBody: 'must_execute_authoritative_task_body_now',
        scope: 'authoritative_task_body_only',
        secrets: 'never_echo_secrets',
        updateSelf: 'explicit_user_request_only',
        cancelRecurring: 'explicit_user_request_only',
        cancelUntilComplete: 'overall_goal_complete_only',
        silent: 'first_non_empty_SILENT_stops_immediately_no_more_tools',
        network: 'explicit_task_request_only',
        finalResponse: 'exactly_one',
      },
    });
  });

  it('makes execution mandatory without weakening scope, secrets, SILENT, or explicit network authority', () => {
    const action = { type: 'command', command: 'SSH to the named host and call the specified webhook.', selfManaged: true } as const;
    const contract = buildRegisteredCronSystemContract(action, 'job-authorized');
    expect(contract.body).toContain('user-authorized scheduled execution');
    expect(contract.body).toContain('MUST execute authoritative.taskBody now');
    expect(contract.body).toContain('Network, SSH, and webhook actions are allowed only when authoritative.taskBody explicitly requests them');
    expect(contract.body).toContain('never echo secrets');
    expect(contract.body).toContain('first_non_empty_SILENT_stops_immediately_no_more_tools');
    expect(contract.body).toContain('"network":"explicit_task_request_only"');
  });

  it('migrates only the exact legacy v1 registration and rejects tampered legacy state', () => {
    const legacy = {
      type: 'command', command: 'task', selfManaged: true,
      cronControl: { ...LEGACY_CRON_CONTROL_CONTRACT_V1, scheduleId: 'job-1' },
    } as const;
    const result = registerCronControlAction(legacy, 'job-1', CRON_COMPLETION_POLICY.RECURRING);
    expect(result).toMatchObject({ ok: true, migrated: true, action: { cronControl: {
      contractId: CRON_CONTROL_CONTRACT.contractId,
      version: CRON_CONTROL_CONTRACT.version,
    } } });
    expect(registerCronControlAction({
      ...legacy,
      cronControl: { ...legacy.cronControl, constraints: { ...legacy.cronControl.constraints, network: 'always' } },
    }, 'job-1', CRON_COMPLETION_POLICY.RECURRING)).toEqual({ ok: false, reason: 'tampered_contract_ref' });
  });

  it('builds a bounded live/reload cron-run projection with schedule metadata', () => {
    const projection = buildCronRunTimelineProjection({
      type: CRON_MSG.DISPATCH, jobId: 'job-1', executionId: 'run-1', jobName: 'Daily review',
      serverId: 'server-1', projectName: 'project', targetRole: 'brain', cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai', completionPolicy: CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
      previousRunAt: 10, nextRunAt: 20, action: { type: 'command', command: 'Review the build.' },
    });
    expect(projection).toMatchObject({
      scheduleId: 'job-1', name: 'Daily review', executionId: 'run-1', cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai', previousRunAt: 10, nextRunAt: 20, taskBody: 'Review the build.',
      contractId: CRON_CONTROL_CONTRACT.contractId, status: 'dispatched',
    });
  });

  it('migrates a legacy full block once and keeps restart hydration idempotent', () => {
    const scheduleId = 'job-legacy';
    const body = 'Inspect progress';
    const legacy = `${body}\n\n${buildLegacyCronControlBlock(
      scheduleId,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    )}`;
    const first = registerCronControlAction(
      { type: 'command', command: legacy, selfManaged: true },
      scheduleId,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    );
    expect(first).toEqual({
      ok: true,
      migrated: true,
      action: {
        type: 'command', command: body, selfManaged: true,
        cronControl: {
          contractId: CRON_CONTROL_CONTRACT.contractId,
          version: CRON_CONTROL_CONTRACT.version,
          scheduleId,
          constraints: CRON_CONTROL_CONTRACT.constraints,
        },
      },
    });
    if (!first.ok) throw new Error(first.reason);
    expect(registerCronControlAction(
      first.action,
      scheduleId,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    )).toEqual({ ok: true, action: first.action, migrated: false });
    expect(validateRegisteredCronControlAction(first.action, scheduleId))
      .toEqual({ ok: true, action: first.action, migrated: false });
  });

  it.each([
    ['missing body', { type: 'command', command: ' ', selfManaged: true }, 'missing_authoritative_body'],
    ['missing contract', { type: 'command', command: 'task', selfManaged: true }, 'missing_authoritative_contract'],
    ['unknown version', {
      type: 'command', command: 'task', selfManaged: true,
      cronControl: { ...CRON_CONTROL_CONTRACT, scheduleId: 'job-1', version: 9 },
    }, 'unknown_contract_version'],
    ['task mismatch', {
      type: 'command', command: 'task', selfManaged: true,
      cronControl: { ...CRON_CONTROL_CONTRACT, scheduleId: 'job-other' },
    }, 'task_id_mismatch'],
    ['tampered ref', {
      type: 'command', command: 'task', selfManaged: true,
      cronControl: { ...CRON_CONTROL_CONTRACT, scheduleId: 'job-1', contractId: 'unknown_v9' },
    }, 'tampered_contract_ref'],
    ['tampered body', {
      type: 'command', command: 'task', selfManaged: true,
      cronControl: {
        ...CRON_CONTROL_CONTRACT, scheduleId: 'job-1',
        constraints: { ...CRON_CONTROL_CONTRACT.constraints, network: 'always' },
      },
    }, 'tampered_contract_body'],
  ] as const)('fails closed for %s', (_label, action, reason) => {
    expect(validateRegisteredCronControlAction(action, 'job-1')).toEqual({ ok: false, reason });
  });

  it('does not strip a legacy block whose schedule binding is different', () => {
    expect(registerCronControlAction({
      type: 'command', selfManaged: true,
      command: `task\n\n${buildLegacyCronControlBlock('other-job', CRON_COMPLETION_POLICY.RECURRING)}`,
    }, 'job-1', CRON_COMPLETION_POLICY.RECURRING)).toEqual({
      ok: false,
      reason: 'legacy_contract_mismatch',
    });
  });
});
