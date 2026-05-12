import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_ADVANCED_PRESETS,
  resolveP2pRoundPlan,
  type P2pAdvancedRound,
} from '../../shared/p2p-advanced.js';

describe('resolveP2pRoundPlan', () => {
  it('uses the shared default hop timeout for legacy runs when no override is provided', () => {
    const plan = resolveP2pRoundPlan({
      modeOverride: 'audit',
    });

    expect(plan.advanced).toBe(false);
    expect(plan.rounds).toHaveLength(1);
    expect(plan.rounds[0]?.timeoutMinutes).toBe(8);
  });

  it('treats legacy combo roundsOverride as complete flow cycles', () => {
    const plan = resolveP2pRoundPlan({
      modeOverride: 'brainstorm>discuss',
      roundsOverride: 2,
      hopTimeoutMinutes: 8,
    });

    expect(plan.advanced).toBe(false);
    expect(plan.rounds).toHaveLength(4);
    expect(plan.rounds.map((round) => round.modeKey)).toEqual(['brainstorm', 'discuss', 'brainstorm', 'discuss']);
    expect(plan.rounds.every((round) => round.timeoutMinutes === 8)).toBe(true);
  });

  it('resolves the openspec preset and freezes sdk helper eligibility', () => {
    const plan = resolveP2pRoundPlan({
      advancedPresetKey: 'openspec',
      advancedRunTimeoutMinutes: 45,
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_brain',
      },
      participants: [
        { sessionName: 'deck_proj_brain', agentType: 'claude-code-sdk' },
        { sessionName: 'deck_sub_worker', agentType: 'qwen', parentSession: 'deck_proj_brain' },
        { sessionName: 'deck_proj_cli', agentType: 'codex' },
      ],
    });

    expect(plan.advanced).toBe(true);
    expect(plan.rounds.map((round) => round.id)).toEqual(BUILT_IN_ADVANCED_PRESETS.openspec.map((round) => round.id));
    expect(plan.contextReducer).toEqual({
      mode: 'clone_sdk_session',
      templateSession: 'deck_proj_brain',
    });
    expect(plan.helperEligibleSnapshot).toEqual([
      { sessionName: 'deck_proj_brain', agentType: 'claude-code-sdk' },
      { sessionName: 'deck_sub_worker', agentType: 'qwen', parentSession: 'deck_proj_brain' },
    ]);
    expect(plan.overallRunTimeoutMinutes).toBe(45);
  });

  it('rejects forward jumps in advanced rounds', () => {
    const rounds: P2pAdvancedRound[] = [
      {
        id: 'implement',
        title: 'Implement',
        preset: 'implementation',
        executionMode: 'multi_dispatch',
        permissionScope: 'implementation',
      },
      {
        id: 'audit',
        title: 'Audit',
        preset: 'implementation_audit',
        executionMode: 'single_main',
        permissionScope: 'analysis_only',
        verdictPolicy: 'smart_gate',
        jumpRule: {
          targetRoundId: 'audit',
          marker: 'REWORK',
          minTriggers: 0,
          maxTriggers: 2,
        },
      },
    ];

    expect(() => resolveP2pRoundPlan({ advancedRounds: rounds })).toThrow(/jump backward/i);
  });

  it('rejects artifact-generation rounds without declared outputs', () => {
    const rounds: P2pAdvancedRound[] = [
      {
        id: 'custom_artifact',
        title: 'Custom Artifact',
        preset: 'custom',
        executionMode: 'single_main',
        permissionScope: 'artifact_generation',
      },
    ];

    expect(() => resolveP2pRoundPlan({ advancedRounds: rounds })).toThrow(/must declare artifact outputs/i);
  });

  it('rejects forced_rework rounds whose maxTriggers are below minTriggers', () => {
    const rounds: P2pAdvancedRound[] = [
      {
        id: 'implementation',
        title: 'Implementation',
        preset: 'implementation',
        executionMode: 'single_main',
        permissionScope: 'implementation',
      },
      {
        id: 'implementation_audit',
        title: 'Implementation Audit',
        preset: 'implementation_audit',
        executionMode: 'single_main',
        permissionScope: 'analysis_only',
        verdictPolicy: 'forced_rework',
        jumpRule: {
          targetRoundId: 'implementation',
          marker: 'REWORK',
          minTriggers: 2,
          maxTriggers: 1,
        },
      },
    ];

    expect(() => resolveP2pRoundPlan({ advancedRounds: rounds })).toThrow(/invalid maxTriggers/i);
  });

  it('rejects proposal_audit rounds that attempt to drive routing', () => {
    const rounds: P2pAdvancedRound[] = [
      {
        id: 'discussion',
        title: 'Discussion',
        preset: 'discussion',
        executionMode: 'multi_dispatch',
        permissionScope: 'analysis_only',
      },
      {
        id: 'proposal_audit',
        title: 'Proposal Audit',
        preset: 'proposal_audit',
        executionMode: 'single_main',
        permissionScope: 'analysis_only',
        verdictPolicy: 'smart_gate',
        jumpRule: {
          targetRoundId: 'discussion',
          marker: 'REWORK',
          minTriggers: 0,
          maxTriggers: 2,
        },
      },
    ];

    expect(() => resolveP2pRoundPlan({ advancedRounds: rounds })).toThrow(/proposal_audit cannot drive routing/i);
  });

  it('rejects reducer sessions that are not sdk-backed participants', () => {
    expect(() => resolveP2pRoundPlan({
      advancedPresetKey: 'openspec',
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_proj_cli',
      },
      participants: [
        { sessionName: 'deck_proj_cli', agentType: 'codex' },
      ],
    })).toThrow(/eligible SDK-backed participant/i);
  });

  it('rejects clone-mode reducer templates that are not sdk-backed participants', () => {
    expect(() => resolveP2pRoundPlan({
      advancedPresetKey: 'openspec',
      contextReducer: {
        mode: 'clone_sdk_session',
        templateSession: 'deck_proj_cli',
      },
      participants: [
        { sessionName: 'deck_proj_cli', agentType: 'codex' },
      ],
    })).toThrow(/eligible SDK-backed participant/i);
  });

  /*
   * R3 v2 PR-μ — Workflow round summaries. The legacy combo system always
   * ran a per-round summary; the previous workflow implementation only
   * fired summary on `multi_dispatch` rounds AND lost the rich per-mode
   * prompts. The new behaviour: ANY round with a non-empty
   * `effectiveSummaryPrompt` (set by the workflow adapter) gets
   * `synthesisStyle='initiator_summary'` so the orchestrator dispatches a
   * summary hop on the initiator — including `single_main` rounds.
   */
  /*
   * R3 v2 PR-τ — synthesisStyle is now LOCKED by `executionMode`:
   *   - `single_main` → ALWAYS `synthesisStyle: 'none'` (no second hop;
   *     the worker IS the initiator and there is no ensemble to
   *     consolidate). Even an explicit `effectiveSummaryPrompt` does
   *     NOT cause a synthesis hop to fire — the executor's single_main
   *     branch ignores the flag, so leaving the flag set was just
   *     stale UI noise. PR-τ removes that noise.
   *   - `multi_dispatch` → ALWAYS `synthesisStyle: 'initiator_summary'`
   *     so the parallel workers' isolated outputs always converge into
   *     one authoritative paragraph. Falls back to a generic prompt
   *     when no override / preset prompt is supplied.
   */
  it('R3 v2 PR-τ — single_main MUST have synthesisStyle=none even when effectiveSummaryPrompt is set', () => {
    const round: P2pAdvancedRound = {
      id: 'r1',
      title: 'Implementation',
      preset: 'implementation',
      executionMode: 'single_main',
      permissionScope: 'implementation',
      effectiveSummaryPrompt: 'Write a detailed implementation summary…',
    };
    const plan = resolveP2pRoundPlan({ advancedRounds: [round], participants: [] });
    expect(plan.rounds).toHaveLength(1);
    const resolved = plan.rounds[0]!;
    expect(resolved.synthesisStyle).toBe('none');
    // summaryPrompt may still be populated so the FINAL-RUN synthesis
    // (not the per-round synthesis hop) can pick it up via PR-μ's
    // 3-tier resolution chain when this is the last round of a chain.
    expect(resolved.summaryPrompt).toBe('Write a detailed implementation summary…');
  });

  it('R3 v2 PR-τ — single_main WITHOUT effectiveSummaryPrompt also keeps synthesisStyle=none', () => {
    const round: P2pAdvancedRound = {
      id: 'r1',
      title: 'Implementation',
      preset: 'implementation',
      executionMode: 'single_main',
      permissionScope: 'implementation',
    };
    const plan = resolveP2pRoundPlan({ advancedRounds: [round], participants: [] });
    expect(plan.rounds[0]!.synthesisStyle).toBe('none');
  });

  it('R3 v2 PR-τ — multi_dispatch round MUST have synthesisStyle=initiator_summary even when no prompt was supplied', () => {
    const round: P2pAdvancedRound = {
      id: 'r1',
      title: 'Discuss',
      preset: 'custom',
      executionMode: 'multi_dispatch',
      permissionScope: 'analysis_only',
      // No effectiveSummaryPrompt + 'custom' preset has no entry in
      // SUMMARY_PROMPTS — exactly the case that previously fell through
      // to `synthesisStyle: 'none'` and silently skipped the summary
      // hop. PR-τ falls back to a generic prompt instead.
    };
    const plan = resolveP2pRoundPlan({ advancedRounds: [round], participants: [] });
    expect(plan.rounds[0]!.synthesisStyle).toBe('initiator_summary');
    expect(plan.rounds[0]!.summaryPrompt).toBeTruthy();
    expect(plan.rounds[0]!.summaryPrompt).toMatch(/Synthesize/);
  });

  it('R3 v2 PR-τ — multi_dispatch round inherits the override summary prompt verbatim', () => {
    const round: P2pAdvancedRound = {
      id: 'r1',
      title: 'Discuss',
      preset: 'discussion',
      executionMode: 'multi_dispatch',
      permissionScope: 'analysis_only',
      effectiveSummaryPrompt: 'Custom rich summary prompt for this round.',
    };
    const plan = resolveP2pRoundPlan({ advancedRounds: [round], participants: [] });
    expect(plan.rounds[0]!.summaryPrompt).toBe('Custom rich summary prompt for this round.');
    expect(plan.rounds[0]!.synthesisStyle).toBe('initiator_summary');
  });
});
