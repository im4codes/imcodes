/**
 * Built-in rule: single pairs use the daemon pair heartbeat (never per-pair
 * cron_create_self nudges), whereas multi-phase long tasks require Brain to
 * automatically schedule cron_create_self with completionPolicy="until_complete"
 * and auto-cancel it once all phases complete.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TASK_PAIR_BRIEF_STRUCTURE_RULE,
  TASK_PAIR_MULTI_PHASE_CRON_RULE,
  TASK_PAIR_MULTI_PHASE_CRON_TOKEN,
  TASK_PAIR_SPLIT_UNRELATED_RULE,
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

describe('the multi-phase long-task supervisor cron rule', () => {
  it('distinguishes single-pair daemon heartbeats from multi-phase until_complete supervisor crons', () => {
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('daemon pair heartbeat');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('never create per-pair cron_create_self nudges');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('cron_create_self');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('drives execution continuously via reactive wakeups');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('strictly a keepalive fallback');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('NEVER a polling loop');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('completionPolicy="until_complete"');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('>= 20 minutes');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('*/20 * * * *');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('never more frequent than every 20 minutes');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('scale/extend the interval appropriately based on task complexity');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('30m/45m/60m+');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('cron_cancel_self');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('all phases are complete');
    expect(TASK_PAIR_MULTI_PHASE_CRON_RULE).toContain('shorter than 20-minute interval is allowed ONLY when the user');
    expect(TASK_PAIR_MULTI_PHASE_CRON_TOKEN).toBe(
      'single_pair_no_cron_multi_phase_long_task_must_cron_create_self_keepalive_fallback_not_polling_min_20m_unless_special_user_request_scaled_by_complexity_completionPolicy_until_complete_auto_cancel_when_all_phases_done',
    );
  });

  it('lives inside task_pair_markers_v1 and both pairs Brain contracts while preserving single-pair brainCronSelf=forbidden', () => {
    const markerContract = buildTaskPairMarkerContract();
    expect(markerContract).toContain(TASK_PAIR_MULTI_PHASE_CRON_RULE);
    expect(markerContract.indexOf(TASK_PAIR_SPLIT_UNRELATED_RULE))
      .toBeLessThan(markerContract.indexOf(TASK_PAIR_MULTI_PHASE_CRON_RULE));
    expect(markerContract.indexOf(TASK_PAIR_MULTI_PHASE_CRON_RULE))
      .toBeLessThan(markerContract.indexOf(TASK_PAIR_BRIEF_STRUCTURE_RULE));

    expect(BRAIN_PAIRS_SUPERVISED_WORK.multiPhaseCron).toBe(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);
    expect(BRAIN_PAIRS_SUPERVISED_WORK.heartbeat).toBe('daemon_pair_heartbeat');
    expect(BRAIN_MANUAL_AUDITED_WORK.pairs.multiPhaseCron).toBe(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);
    expect(BRAIN_MANUAL_AUDITED_WORK.pairs.brainCronSelf).toBe('forbidden');

    const supervisedJson = JSON.parse(
      buildBrainSupervisedWorkDelegationContract(undefined, { taskPairEngine: 'pairs' }),
    ) as { heartbeat: { source: string; brainCronSelf: string }; pairs: { multiPhaseCron: string; heartbeat: string } };
    expect(supervisedJson.heartbeat).toEqual({ source: 'daemon_builtin', brainCronSelf: 'forbidden' });
    expect(supervisedJson.pairs.heartbeat).toBe('daemon_pair_heartbeat');
    expect(supervisedJson.pairs.multiPhaseCron).toBe(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);

    const manualJson = JSON.parse(
      buildBrainManualOnlyDelegationContract(undefined, { taskPairEngine: 'pairs' }),
    ) as { manual: { auditedWork: { multiPhaseCron: string; brainCronSelf: string } } };
    expect(manualJson.manual.auditedWork.brainCronSelf).toBe('forbidden');
    expect(manualJson.manual.auditedWork.multiPhaseCron).toBe(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);
  });

  it('reaches transport Brain (supervised and manual) and pair participants on pairs engine, and stays out of off/legacy', () => {
    for (const automaticSupervisionEnabled of [true, false, undefined]) {
      const firstBrain = buildProviderContextPayload(mockProvider, {
        userMessage: 'manage multi-phase project',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled,
        brainContractRegistered: false,
        taskPairEngine: 'pairs',
      });
      expect(firstBrain.sessionSystemText).toContain(TASK_PAIR_MULTI_PHASE_CRON_RULE);
      expect(firstBrain.sessionSystemText).toContain(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);

      const laterBrain = buildProviderContextPayload(mockProvider, {
        userMessage: 'next phase',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled,
        brainContractRegistered: true,
        taskPairEngine: 'pairs',
      });
      expect(laterBrain.sessionSystemText).toContain(TASK_PAIR_MULTI_PHASE_CRON_RULE);
    }

    const worker = buildProviderContextPayload(mockProvider, {
      userMessage: 'do pair work',
      sessionIdentity: { sessionName: 'deck_sub_w1', label: 'W1', role: 'w1' },
      namespace: { scope: 'personal', projectId: 'repo-1' },
      taskPairEngine: 'pairs',
    });
    expect(worker.sessionSystemText).toContain(TASK_PAIR_MULTI_PHASE_CRON_RULE);
    expect(worker.sessionSystemText).not.toContain(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);

    for (const engine of ['off', 'legacy'] as const) {
      const inert = buildProviderContextPayload(mockProvider, {
        userMessage: 'manage multi-phase project',
        sessionIdentity: { sessionName: 'deck_proj_brain', label: 'Brain', role: 'brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
        automaticSupervisionEnabled: true,
        brainContractRegistered: false,
        taskPairEngine: engine,
      });
      expect(inert.sessionSystemText ?? '').not.toContain(TASK_PAIR_MULTI_PHASE_CRON_RULE);
      expect(inert.sessionSystemText ?? '').not.toContain(TASK_PAIR_MULTI_PHASE_CRON_TOKEN);
    }
  });

  it('has one SSOT definition in shared/task-pair.ts with no duplicate literals across source trees', () => {
    const roots = ['shared', 'src', 'web/src', 'server/src'];
    const repo = join(__dirname, '..', '..');
    const home = join(repo, 'shared', 'task-pair.ts');
    const fragments = [
      'Multi-phase long-task supervisor cron (Brain):',
      'never create per-pair cron_create_self nudges',
      TASK_PAIR_MULTI_PHASE_CRON_TOKEN,
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|json)$/.test(name) || path === home) continue;
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
