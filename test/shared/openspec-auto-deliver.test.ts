import { describe, expect, it } from 'vitest';
import {
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  materializeOpenSpecAutoDeliverPreset,
} from '../../shared/openspec-auto-deliver-constants.js';
import {
  OPENSPEC_AUTO_DELIVER_COMBO_DESCRIPTORS,
  assertOpenSpecAutoDeliverCombosValid,
  resolveOpenSpecAutoDeliverCombo,
} from '../../shared/openspec-auto-deliver-combos.js';
import { buildOpenSpecAutoDeliverValidationRecommendations } from '../../shared/openspec-auto-deliver-validation-recommendations.js';
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

  it('validates designated combo descriptors and resolver copies', () => {
    assertOpenSpecAutoDeliverCombosValid();
    expect(OPENSPEC_AUTO_DELIVER_COMBO_DESCRIPTORS).toHaveLength(2);
    const specCombo = resolveOpenSpecAutoDeliverCombo(OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR);
    expect(specCombo?.capability.requiredPermissionScope).toBe('artifact_generation');
    expect(specCombo?.capability.allowedMutationScopes).toContain('openspec_change_artifacts');
    if (specCombo) specCombo.capability.allowedMutationScopes.length = 0;
    expect(resolveOpenSpecAutoDeliverCombo(OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR)?.capability.allowedMutationScopes).toContain('openspec_change_artifacts');

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
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload(`${'x'.repeat(70 * 1024)}\n\`\`\`json\n${JSON.stringify(validVerdictPayload())}\n\`\`\``).ok).toBe(true);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('no json here').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('```json\n{}\n```\n```json\n{}\n```').ok).toBe(false);
    expect(parseOpenSpecAutoDeliverAuthoritativeJsonPayload('```json\n{ nope }\n```').ok).toBe(false);
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
    ]);
    expect(recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'pnpm test', safety: 'recommended' }),
      expect.objectContaining({ command: 'pnpm typecheck', safety: 'recommended' }),
      expect.objectContaining({ command: 'pnpm deploy', safety: 'unsafe' }),
    ]));
  });
});
