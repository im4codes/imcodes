/**
 * Owner requirement: "还有你管理任务的时候 不相关的任务合理的拆分执行 不要混在一起. 这个写进系统合同的pair任务管理里".
 * Unrelated goals, bugs or features must be split into separate task pairs so each pair has a narrow scope and independent
 * audit/merge lifecycle.
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_SPLIT_UNRELATED_RULE,
  buildTaskPairMarkerContract,
} from '../../shared/task-pair.js';
import { buildProviderContextPayload } from '../../src/agent/transport-runtime-assembly.js';
import {
  BRAIN_MANUAL_AUDITED_WORK,
  BRAIN_PAIRS_SUPERVISED_WORK,
} from '../../src/daemon/supervision-prompts.js';

describe('the "split unrelated tasks" owner rule', () => {
  it('states clearly that unrelated tasks must be split into separate pairs', () => {
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('Split unrelated tasks');
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('separate');
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('never mix unrelated work into one pair');
  });

  it('lives inside the task-pair marker contract and both Brain pair contracts', () => {
    expect(buildTaskPairMarkerContract()).toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
    expect(BRAIN_PAIRS_SUPERVISED_WORK.taskSplitting).toBe(
      'split_unrelated_tasks_into_separate_pairs_never_mix_unrelated_work_in_one_pair',
    );
    expect(BRAIN_MANUAL_AUDITED_WORK.pairs.taskSplitting).toBe(
      BRAIN_PAIRS_SUPERVISED_WORK.taskSplitting,
    );

    const payload = buildProviderContextPayload(
      {
        id: 'mock',
        displayName: 'Mock',
        connectionMode: 'sdk',
        sessionOwnership: 'managed',
        capabilities: {
          streaming: true,
          reasoning: false,
          toolCalling: true,
          imageInput: false,
          fileInput: false,
          maxContextTokens: 128000,
          compact: { supported: false },
        },
        initialize: async () => { throw new Error('unused'); },
        createSession: async () => '',
        send: async () => {},
        endSession: async () => {},
        listModels: async () => [],
      } as never,
      {
        userMessage: 'manage these tasks',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        brainContractRegistered: false,
        taskPairEngine: 'pairs',
      },
    );
    expect(payload.sessionSystemText).toContain('split_unrelated_tasks_into_separate_pairs_never_mix_unrelated_work_in_one_pair');
  });
});
