/**
 * Owner requirement: "还有你管理任务的时候 不相关的任务合理的拆分执行 不要混在一起. 这个写进系统合同的pair任务管理里".
 * Unrelated goals, bugs or features must be split into separate task pairs so each pair has a narrow scope and independent
 * audit/merge lifecycle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  TASK_PAIR_BRAIN_PAIR_CREATE_RULE,
  TASK_PAIR_BRIEF_STRUCTURE_RULE,
  TASK_PAIR_SPLIT_UNRELATED_RULE,
  TASK_PAIR_SPLIT_UNRELATED_TOKEN,
  buildTaskPairMarkerContract,
} from '../../shared/task-pair.js';
import { buildProviderContextPayload } from '../../src/agent/transport-runtime-assembly.js';
import {
  BRAIN_MANUAL_AUDITED_WORK,
  BRAIN_PAIRS_SUPERVISED_WORK,
  buildBrainManualOnlyDelegationContract,
  buildBrainSupervisedWorkDelegationContract,
} from '../../src/daemon/supervision-prompts.js';

const mockProvider = {
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
} as never;

describe('the "split unrelated tasks" owner rule', () => {
  it('states clearly that unrelated tasks must be split into separate pairs', () => {
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('Split unrelated tasks');
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('separate');
    expect(TASK_PAIR_SPLIT_UNRELATED_RULE).toContain('never mix unrelated work into one pair');
    expect(TASK_PAIR_SPLIT_UNRELATED_TOKEN).toBe(
      'split_unrelated_tasks_into_separate_pairs_never_mix_unrelated_work_in_one_pair',
    );
  });

  it('lives inside task_pair_markers_v1, both Brain pair contracts, and pair_create MCP schema', () => {
    const markerContract = buildTaskPairMarkerContract();
    expect(markerContract).toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
    expect(markerContract.indexOf(TASK_PAIR_BRAIN_PAIR_CREATE_RULE))
      .toBeLessThan(markerContract.indexOf(TASK_PAIR_SPLIT_UNRELATED_RULE));
    expect(markerContract.indexOf(TASK_PAIR_SPLIT_UNRELATED_RULE))
      .toBeLessThan(markerContract.indexOf(TASK_PAIR_BRIEF_STRUCTURE_RULE));

    expect(BRAIN_PAIRS_SUPERVISED_WORK.taskSplitting).toBe(TASK_PAIR_SPLIT_UNRELATED_TOKEN);
    expect(BRAIN_MANUAL_AUDITED_WORK.pairs.taskSplitting).toBe(TASK_PAIR_SPLIT_UNRELATED_TOKEN);

    const supervisedJson = JSON.parse(
      buildBrainSupervisedWorkDelegationContract(undefined, { taskPairEngine: 'pairs' }),
    ) as { pairs: { taskSplitting: string } };
    expect(supervisedJson.pairs.taskSplitting).toBe(TASK_PAIR_SPLIT_UNRELATED_TOKEN);

    const manualJson = JSON.parse(
      buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'pairs' }),
    ) as { manual: { auditedWork: { taskSplitting: string } } };
    expect(manualJson.manual.auditedWork.taskSplitting).toBe(TASK_PAIR_SPLIT_UNRELATED_TOKEN);

    // Process and transport Brains alike create pairs via pair_create.
    expect(MEMORY_MCP_TOOL_CONTRACTS[MEMORY_MCP_TOOL_NAMES.PAIR_CREATE].description)
      .toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
  });

  it('reaches transport Brain (supervised and manual) and pair participants on pairs engine, and stays out of off/legacy', () => {
    for (const automaticSupervisionEnabled of [true, false, undefined]) {
      const firstBrain = buildProviderContextPayload(mockProvider, {
        userMessage: 'manage these tasks',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled,
        brainContractRegistered: false,
        taskPairEngine: 'pairs',
      });
      expect(firstBrain.sessionSystemText).toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
      expect(firstBrain.sessionSystemText).toContain(TASK_PAIR_SPLIT_UNRELATED_TOKEN);

      const laterBrain = buildProviderContextPayload(mockProvider, {
        userMessage: 'next turn',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled,
        brainContractRegistered: true,
        taskPairEngine: 'pairs',
      });
      expect(laterBrain.sessionSystemText).toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
    }

    const worker = buildProviderContextPayload(mockProvider, {
      userMessage: 'do pair work',
      sessionIdentity: { sessionName: 'deck_sub_w1', label: 'W1', role: 'w1' },
      namespace: { scope: 'personal', projectId: 'repo-1' },
      taskPairEngine: 'pairs',
    });
    expect(worker.sessionSystemText).toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
    expect(worker.sessionSystemText).not.toContain(TASK_PAIR_SPLIT_UNRELATED_TOKEN);

    for (const engine of ['off', 'legacy'] as const) {
      const inert = buildProviderContextPayload(mockProvider, {
        userMessage: 'manage these tasks',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled: true,
        brainContractRegistered: false,
        taskPairEngine: engine,
      });
      expect(inert.sessionSystemText ?? '').not.toContain(TASK_PAIR_SPLIT_UNRELATED_RULE);
      expect(inert.sessionSystemText ?? '').not.toContain(TASK_PAIR_SPLIT_UNRELATED_TOKEN);
    }
  });

  it('has one SSOT definition in shared/task-pair.ts with no duplicate literals across source trees', () => {
    const roots = ['shared', 'src', 'web/src', 'server/src'];
    const repo = join(__dirname, '..', '..');
    const home = join(repo, 'shared', 'task-pair.ts');
    const fragments = [
      'Split unrelated tasks (Brain):',
      'never mix unrelated work into one pair',
      TASK_PAIR_SPLIT_UNRELATED_TOKEN,
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|json)$/.test(name) || path === home) continue;
        if (name === 'memory-mcp-bootstrap-catalog.json') continue;
        const text = readFileSync(path, 'utf8');
        if (fragments.some((fragment) => text.includes(fragment))) {
          offenders.push(relative(repo, path).split(sep).join('/'));
        }
      }
    };
    for (const root of roots) {
      try { walk(join(repo, root)); } catch { /* directory optional */ }
    }
    expect(offenders).toEqual([]);
  });
});
