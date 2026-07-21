import { describe, expect, it } from 'vitest';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS,
  OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
  OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS,
  isOpenSpecAutoDeliverStage,
  materializeOpenSpecAutoDeliverPreset,
} from '../../shared/openspec-auto-deliver-constants.js';
import * as openSpecAutoDeliverCombos from '../../shared/openspec-auto-deliver-combos.js';
import {
  activeOpenSpecPromptIdForAutoDeliverStage,
  evaluateOpenSpecAutoDeliverComboCompatibility,
} from '../../shared/openspec-auto-deliver-combos.js';
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
  validateOpenSpecAutoDeliverLaunchRequest,
  validateOpenSpecAutoDeliverVerdictPayload,
} from '../../shared/openspec-auto-deliver-validators.js';

function validVerdictPayload() {
  return {
    verdict: 'PASS',
    module_scores: OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.map((module, index) => ({
      module,
      score: Math.max(7, 10 - index),
      max_score: 10,
      summary: `${module} is covered.`,
    })),
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
      maxImplementationPrompts: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
      maxElapsedMinutes: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
    });
    expect(materializeOpenSpecAutoDeliverPreset('deep')).toEqual({
      specAuditRepairRounds: 2,
      implementationAuditRepairRounds: 3,
      maxImplementationPrompts: 24,
      maxElapsedMinutes: 960,
    });
  });

  it('keeps Auto Deliver lifecycle values canonical', () => {
    expect(isOpenSpecAutoDeliverStage('implementation_task_loop')).toBe(true);
    expect(isOpenSpecAutoDeliverStage('stopping')).toBe(true);
    expect(isOpenSpecAutoDeliverStage('running')).toBe(false);
    expect(isOpenSpecAutoDeliverStage('active')).toBe(false);
  });

  it('validates custom materialized launch limits and fills implementation defaults', () => {
    const result = validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-custom',
      serverId: 'srv-1',
      sessionName: 'deck_proj_brain',
      changeName: 'openspec-auto-delivery',
      presetId: 'custom',
      selectedTeamComboId: OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      locale: 'zh-CN',
      autoCommitPush: true,
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
        locale: 'zh-CN',
        autoCommitPush: true,
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
    })).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ autoCommitPush: false }),
    }));
    expect(validateOpenSpecAutoDeliverLaunchRequest({
      requestId: 'req-1',
      serverId: 'srv-1',
      sessionName: 'deck_proj_brain',
      changeName: '../escape',
      presetId: 'custom',
    }).ok).toBe(false);
  });

  it('maps active OpenSpec prompt ids while allowing valid Team combos and denying invalid or legacy ids', () => {
    expect(activeOpenSpecPromptIdForAutoDeliverStage('spec_audit_repair')).toBe('proposal_audit');
    expect(activeOpenSpecPromptIdForAutoDeliverStage('implementation_audit_repair')).toBe('implementation_audit');
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: true });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      'audit>plan',
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: true });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      'audit>unknown',
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'combo_unsupported' });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_UNSUPPORTED_LEGACY_COMBO_IDS.SPEC_AUDIT_REPAIR,
      'spec_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'legacy_combo_unsupported' });
    expect(evaluateOpenSpecAutoDeliverComboCompatibility(
      OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
      'implementation_audit_repair',
      'proposal_audit',
    )).toEqual({ ok: false, reason: 'invalid_stage_prompt' });
    expect(openSpecAutoDeliverCombos).not.toHaveProperty('materializeOpenSpecAutoDeliverStageRound');
  });

  it('validates strict verdict payloads', () => {
    expect(validateOpenSpecAutoDeliverVerdictPayload(validVerdictPayload()).ok).toBe(true);

    const invalidVerdict = validVerdictPayload();
    invalidVerdict.verdict = 'DONE';
    expect(validateOpenSpecAutoDeliverVerdictPayload(invalidVerdict).ok).toBe(false);

    const missingModule = validVerdictPayload();
    missingModule.module_scores = missingModule.module_scores.filter((score) => score.module !== 'risk');
    expect(validateOpenSpecAutoDeliverVerdictPayload(missingModule).ok).toBe(false);

    const duplicateModule = validVerdictPayload();
    duplicateModule.module_scores[0] = { ...duplicateModule.module_scores[1]! };
    expect(validateOpenSpecAutoDeliverVerdictPayload(duplicateModule).ok).toBe(false);

    const invalidScore = validVerdictPayload();
    invalidScore.module_scores[0] = { ...invalidScore.module_scores[0]!, score: 11 };
    expect(validateOpenSpecAutoDeliverVerdictPayload(invalidScore).ok).toBe(false);

    const invalidMaxScore = validVerdictPayload();
    invalidMaxScore.module_scores[0] = { ...invalidMaxScore.module_scores[0]!, max_score: 100 };
    expect(validateOpenSpecAutoDeliverVerdictPayload(invalidMaxScore).ok).toBe(false);

    const contradictory = validVerdictPayload();
    contradictory.unchecked_tasks = ['Task still open'];
    expect(validateOpenSpecAutoDeliverVerdictPayload(contradictory).ok).toBe(false);
  });

  it('validates optional repair completion status for final acceptance payloads', () => {
    const payload = validVerdictPayload() as ReturnType<typeof validVerdictPayload> & { repair_completion?: Record<string, unknown> };
    payload.repair_completion = {
      status: 'complete',
      previous_items_complete: true,
      completed_items: ['previous repair checklist completed'],
      incomplete_items: [],
      blocked_items: [],
      summary: 'All previous repair items were verified.',
    };
    expect(validateOpenSpecAutoDeliverVerdictPayload(payload).ok).toBe(true);

    const invalid = validVerdictPayload() as ReturnType<typeof validVerdictPayload> & { repair_completion?: Record<string, unknown> };
    invalid.repair_completion = {
      status: 'maybe',
      previous_items_complete: 'yes',
      completed_items: ['done'],
      incomplete_items: [],
      blocked_items: [],
      summary: '',
    };
    const result = validateOpenSpecAutoDeliverVerdictPayload(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        'invalid_repair_completion_status',
        'invalid_repair_completion_previous_items_complete',
        'invalid_repair_completion_summary',
      ]));
    }
  });

  it('accepts free-form authoritative evidence source labels', () => {
    for (const source of ['OpenSpec CLI', 'openspec/changes/platform-foundation']) {
      const payload = validVerdictPayload();
      payload.evidence = [{ source, summary: 'free-form provenance should be preserved' }];
      expect(validateOpenSpecAutoDeliverVerdictPayload(payload), source).toEqual(expect.objectContaining({ ok: true }));
    }
  });

  it('defaults missing evidence source labels to none', () => {
    const payload = validVerdictPayload();
    payload.evidence = [{ summary: 'source label has no gate value' } as typeof payload.evidence[number]];
    const result = validateOpenSpecAutoDeliverVerdictPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidence[0]?.source).toBe('none');
  });

  it('centralizes strict authoritative result field contracts', () => {
    expect(OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS).toEqual([
      'auto_deliver',
      'verdict',
      'module_scores',
      'unchecked_tasks',
      'required_changes',
      'repairs_applied',
      'evidence',
    ]);
    expect(OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS).toContain('authoritativeResultPath');
    expect(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS).toEqual(['spec', 'tasks', 'implementation', 'tests', 'risk']);
  });

  it('parses only raw authoritative JSON payloads', () => {
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(JSON.stringify(validVerdictPayload())).ok).toBe(true);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(`Before\n\`\`\`json\n${JSON.stringify(validVerdictPayload())}\n\`\`\``).ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(`${'x'.repeat(70 * 1024)}\n${JSON.stringify(validVerdictPayload())}`).ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('no json here').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('```json\n{}\n```\n```json\n{}\n```').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('{ nope }').ok).toBe(false);
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
