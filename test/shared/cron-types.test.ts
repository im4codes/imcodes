import { describe, expect, it } from 'vitest';
import {
  CRON_COMPLETION_POLICY,
  CRON_CONTROL_CONTRACT,
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
  it('pins the complete v1 operational semantics behind the compact reference', () => {
    expect(CRON_CONTROL_CONTRACT).toEqual({
      contractId: 'supervision_cron_control_v1',
      version: 1,
      constraints: {
        updateSelf: 'explicit_user_request_only',
        cancelRecurring: 'explicit_user_request_only',
        cancelUntilComplete: 'overall_goal_complete_only',
        silent: 'first_non_empty_SILENT_stops_immediately_no_more_tools',
        network: 'explicit_task_request_only',
        finalResponse: 'exactly_one',
      },
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
      cronControl: { ...CRON_CONTROL_CONTRACT, scheduleId: 'job-1', version: 2 },
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
