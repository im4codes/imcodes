import { describe, expect, it } from 'vitest';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  materializeOpenSpecAutoDeliverPreset,
} from '../../shared/openspec-auto-deliver-constants.js';
import {
  evaluateOpenSpecAutoDeliverComboCompatibility,
  materializeOpenSpecAutoDeliverStageRound,
} from '../../shared/openspec-auto-deliver-combos.js';
import { P2P_PRESET_DEFAULT_SUMMARY_PROMPT } from '../../shared/p2p-workflow-constants.js';
import { buildOpenSpecAutoDeliverValidationRecommendations } from '../../shared/openspec-auto-deliver-validation-recommendations.js';
import type {
  OpenSpecAutoDeliverBrowserConflictProjection,
  OpenSpecAutoDeliverBrowserFullProjection,
  OpenSpecAutoDeliverListRow,
} from '../../shared/openspec-auto-deliver-types.js';
import {
  parseOpenSpecAutoDeliverAuthoritativeJsonPayload,
  parseOpenSpecTasksMarkdown,
  validateOpenSpecAutoDeliverChangeSlug,
  validateOpenSpecAutoDeliverComboDescriptor,
  validateOpenSpecAutoDeliverLaunchRequest,
  validateOpenSpecAutoDeliverVerdictPayload,
} from '../../shared/openspec-auto-deliver-validators.js';

function validVerdictPayload() {
  return {
    verdict: 'PASS',
    module_scores: [
      { module: 'spec', score: 9, max_score: 10, summary: 'Spec is aligned.' },
      { module: 'tasks', score: 10, max_score: 10, summary: 'Tasks are complete.' },
      { module: 'implementation', score: 8, max_score: 10, summary: 'Implementation is sound.' },
      { module: 'tests', score: 7, max_score: 10, summary: 'Tests are adequate.' },
      { module: 'risk', score: 8, max_score: 10, summary: 'Risk is bounded.' },
    ],
    unchecked_tasks: [],
    required_changes: [],
    repairs_applied: [],
    evidence: [{ source: 'daemon', summary: 'typecheck passed', command: 'npm run typecheck', exitCode: 0 }],
  };
}

describe('OpenSpec Auto Deliver shared contracts', () => {
  it('materializes preset limits as immutable copies', () => {
    const first = materializeOpenSpecAutoDeliverPreset('standard');
    first.implementationAuditRepairRounds = 99;
    expect(materializeOpenSpecAutoDeliverPreset('standard')).toEqual({
      specAuditRepairRounds: 1,
      implementationAuditRepairRounds: 2,
    });
    expect(materializeOpenSpecAutoDeliverPreset('deep')).toEqual({
      specAuditRepairRounds: 2,
      implementationAuditRepairRounds: 3,
    });
  });

  it('validates custom materialized launch limits and fills implementation defaults', () => {
    const result = validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-custom',
      serverId: 'srv-1',
      sessionName: 'deck_proj_brain',
      changeName: 'openspec-auto-delivery',
      presetId: 'custom',
      selectedTeamComboId: OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      materializedLimits: {
        specAuditRepairRounds: 3,
        implementationAuditRepairRounds: 5,
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        requestId: 'req-custom',
        serverId: 'srv-1',
        sessionName: 'deck_proj_brain',
        changeName: 'openspec-auto-delivery',
        presetId: 'custom',
        selectedTeamComboId: OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
        materializedLimits: {
          specAuditRepairRounds: 3,
          implementationAuditRepairRounds: 5,
          maxImplementationPrompts: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
          maxElapsedMinutes: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
        },
      },
      issues: [],
    });

    expect(validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-bad-spec',
      sessionName: 'deck_proj_brain',
      changeName: 'openspec-auto-delivery',
      presetId: 'custom',
      materializedLimits: { specAuditRepairRounds: 4, implementationAuditRepairRounds: 1 },
    }).ok).toBe(false);
    expect(validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-bad-impl',
      sessionName: 'deck_proj_brain',
      changeName: 'openspec-auto-delivery',
      presetId: 'custom',
      materializedLimits: { specAuditRepairRounds: 0, implementationAuditRepairRounds: 0 },
    }).ok).toBe(false);
  });

  it('parses task checkboxes outside fenced code and counts nested items', () => {
    const stats = parseOpenSpecTasksMarkdown([
      '- [ ] top',
      '  - [x] nested',
      '```',
      '- [ ] ignored',
      '```',
      '- [X] done',
      '- [y] malformed',
    ].join('\n'));
    expect(stats.total).toBe(3);
    expect(stats.checked).toBe(2);
    expect(stats.unchecked).toBe(1);
    expect(stats.items.map((item) => item.label)).toEqual(['top', 'nested', 'done']);
  });

  it('rejects unsafe change slugs', () => {
    for (const slug of ['', '../x', 'a/b', 'a\\b', '/abs', 'C:\\x', '~home', 'abc\0def']) {
      expect(validateOpenSpecAutoDeliverChangeSlug(slug).ok).toBe(false);
    }
    expect(validateOpenSpecAutoDeliverChangeSlug('openspec-auto-delivery')).toEqual({
      ok: true,
      value: 'openspec-auto-delivery',
      issues: [],
    });
  });

  it('validates launch requests', () => {
    expect(validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-1',
      serverId: 'srv-1',
      sessionName: 'deck_proj_brain',
      changeName: 'openspec-auto-delivery',
      presetId: 'standard',
    }).ok).toBe(true);
    expect(validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-1',
      serverId: 'srv-1',
      sessionName: 'deck_proj_brain',
      changeName: '../escape',
      presetId: 'custom',
    }).ok).toBe(false);
  });

  it('keeps stage materialization helpers valid but denies legacy ids as selected Team combos', () => {
    const invalid = validateOpenSpecAutoDeliverComboDescriptor({
      id: OPENSPEC_AUTO_DELIVER_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR,
      title: 'Invalid',
      capability: {
        stage: 'implementation_audit_repair',
        requiredPermissionScope: 'analysis_only',
        allowedMutationScopes: ['product_files'],
        writeMode: 'single_authoritative_writer',
        strictResultChannel: 'authoritative_summary_json',
        minTransportParticipants: 1,
        supportsGenerationMetadata: true,
        supportsStopCancellation: true,
      },
      rounds: [{}],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues.map((entry) => entry.code)).toContain('implementation_combo_analysis_only');

    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: true });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      'audit>plan',
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'custom_combo_unsupported' });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR,
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'legacy_combo_unsupported' });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      'implementation_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'invalid_stage_prompt' });

    const specRound = materializeOpenSpecAutoDeliverStageRound('spec_audit_repair', OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID);
    expect(specRound).toEqual(expect.objectContaining({
      activeOpenSpecPromptId: 'proposal_audit',
      round: expect.objectContaining({ preset: 'proposal_audit', permissionScope: 'artifact_generation' }),
    }));
    if ('round' in specRound) {
      expect(specRound.round.effectiveSummaryPrompt).toContain(P2P_PRESET_DEFAULT_SUMMARY_PROMPT.proposal_audit);
      expect(specRound.round.effectiveSummaryPrompt).toContain('Proposal Audit Synthesis');
      expect(specRound.round.effectiveSummaryPrompt).toContain('authoritative result file');
    }
    const implementationRound = materializeOpenSpecAutoDeliverStageRound('implementation_audit_repair', OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID);
    expect(implementationRound).toEqual(expect.objectContaining({
      activeOpenSpecPromptId: 'implementation_audit',
      round: expect.objectContaining({ preset: 'implementation_audit', permissionScope: 'implementation' }),
    }));
    if ('round' in implementationRound) {
      expect(implementationRound.round.effectiveSummaryPrompt).toContain(P2P_PRESET_DEFAULT_SUMMARY_PROMPT.implementation_audit);
      expect(implementationRound.round.effectiveSummaryPrompt).toContain('Implementation Audit Synthesis');
      expect(implementationRound.round.effectiveSummaryPrompt).toContain('authoritative result file');
    }
  });

  it('validates strict verdict payloads', () => {
    expect(validateOpenSpecAutoDeliverVerdictPayload(validVerdictPayload()).ok).toBe(true);

    const missingModule = validVerdictPayload();
    missingModule.module_scores = missingModule.module_scores.filter((score) => score.module !== 'risk');
    expect(validateOpenSpecAutoDeliverVerdictPayload(missingModule).ok).toBe(false);

    const contradictory = validVerdictPayload();
    contradictory.unchecked_tasks = ['Task still open'];
    expect(validateOpenSpecAutoDeliverVerdictPayload(contradictory).ok).toBe(false);
  });

  it('extracts exactly one authoritative JSON payload', () => {
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(`Before\n\`\`\`json\n${JSON.stringify(validVerdictPayload())}\n\`\`\``).ok).toBe(true);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(`${'x'.repeat(70 * 1024)}\n\`\`\`json\n${JSON.stringify(validVerdictPayload())}\n\`\`\``).ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('no json here').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('```json\n{}\n```\n```json\n{}\n```').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('```json\n{ nope }\n```').ok).toBe(false);
  });

  it('keeps browser projection and list row contracts redaction-safe', () => {
    const full: OpenSpecAutoDeliverBrowserFullProjection = {
      visibility: 'full',
      projectionVersion: 1,
      runId: 'run-1',
      changeName: 'openspec-auto-delivery',
      status: 'implementation_task_loop',
      stage: 'implementation_task_loop',
      owningMainSessionName: 'deck_proj_brain',
      selectedTeamComboId: OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      activeOpenSpecPromptId: 'implementation_audit',
      taskStats: { total: 1, checked: 0, unchecked: 1, uncheckedLabels: ['private task'] },
    };
    const conflict: OpenSpecAutoDeliverBrowserConflictProjection = {
      visibility: 'conflict',
      projectionVersion: 2,
      runId: 'run-2',
      owningMainSessionName: 'deck_other_brain',
      status: 'spec_audit_repair',
      stage: 'spec_audit_repair',
      busy: true,
      reason: 'auto_deliver_active',
      conflictReason: 'auto_deliver_active',
      canStop: false,
    };
    const row: OpenSpecAutoDeliverListRow = {
      projectionVersion: 1,
      visibility: 'full',
      runId: full.runId,
      owningMainSessionName: full.owningMainSessionName ?? 'deck_proj_brain',
      status: full.status,
      stage: full.stage,
      viewMode: 'fullRunbar',
      changeName: full.changeName,
      selectedTeamComboId: full.selectedTeamComboId ?? undefined,
    };

    expect(full.changeName).toBe('openspec-auto-delivery');
    expect(row.viewMode).toBe('fullRunbar');
    expect(Object.keys(conflict)).not.toContain('changeName');
    expect(Object.keys(conflict)).not.toContain('taskStats');
    expect(Object.keys(conflict)).not.toContain('evidence');
  });

  it('recommends safe validation commands and flags unsafe scripts', () => {
    const recommendations = buildOpenSpecAutoDeliverValidationRecommendations([
      {
        path: 'package.json',
        content: JSON.stringify({
          scripts: {
            test: 'vitest run',
            typecheck: 'tsc --noEmit',
            deploy: 'serverless deploy',
          },
        }),
      },
      { path: 'pnpm-lock.yaml', content: '' },
      { path: 'pyproject.toml', content: '[project]\nname = "demo"\n' },
    ]);
    expect(recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'pnpm test', safety: 'recommended', sourceFile: 'package.json' }),
      expect.objectContaining({ command: 'pnpm typecheck', safety: 'recommended', sourceFile: 'package.json' }),
      expect.objectContaining({ command: 'pnpm deploy', safety: 'unsafe', sourceFile: 'package.json' }),
      expect.objectContaining({ command: 'pytest', safety: 'unknown', sourceFile: 'pyproject.toml' }),
    ]));
    expect(recommendations.map((entry) => entry.command)).not.toContain('npm test');
  });
});
