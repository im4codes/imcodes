import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAG_VALUE_PRECEDENCE,
  MEMORY_FEATURE_FLAGS,
  MEMORY_FEATURE_FLAG_REGISTRY,
  computeEffectiveMemoryFeatureFlags,
  getMemoryFeatureFlagDefinition,
  isMemoryFeatureFlag,
  resolveEffectiveMemoryFeatureFlagValue,
  resolveMemoryFeatureFlagValue,
  type MemoryFeatureFlag,
} from '../../shared/feature-flags.js';
import { MEMORY_COUNTERS, MEMORY_COUNTER_LABEL_ENUMS, isMemoryCounter } from '../../shared/memory-counters.js';

const EXPECTED_FLAGS = [
  'mem.feature.scope_registry_extensions',
  'mem.feature.user_private_sync',
  'mem.feature.self_learning',
  'mem.feature.namespace_registry',
  'mem.feature.observation_store',
  'mem.feature.quick_search',
  'mem.feature.citation',
  'mem.feature.cite_count',
  'mem.feature.cite_drift_badge',
  'mem.feature.md_ingest',
  'mem.feature.preferences',
  'mem.feature.skills',
  'mem.feature.skill_auto_creation',
  'mem.feature.org_shared_authored_standards',
] as const satisfies readonly MemoryFeatureFlag[];

describe('memory feature flags and counters', () => {
  it('defines all memory feature flags as shared constants with default-off registry entries', () => {
    expect(MEMORY_FEATURE_FLAGS).toEqual(EXPECTED_FLAGS);
    for (const flag of MEMORY_FEATURE_FLAGS) {
      expect(isMemoryFeatureFlag(flag)).toBe(true);
      expect(MEMORY_FEATURE_FLAG_REGISTRY[flag].defaultValue).toBe(false);
      expect(MEMORY_FEATURE_FLAG_REGISTRY[flag].disabledBehavior.length).toBeGreaterThan(0);
    }
  });

  it('documents runtime source-of-truth precedence and fails closed on read failure', () => {
    expect(FEATURE_FLAG_VALUE_PRECEDENCE).toEqual([
      'runtime_config_override',
      'persisted_config',
      'environment_startup_default',
      'registry_default',
    ]);
    const flag = 'mem.feature.quick_search';
    expect(resolveMemoryFeatureFlagValue(flag, {
      runtimeConfigOverride: { [flag]: false },
      persistedConfig: { [flag]: true },
      environmentStartupDefault: { [flag]: true },
    })).toBe(false);
    expect(resolveMemoryFeatureFlagValue(flag, {
      persistedConfig: { [flag]: true },
      environmentStartupDefault: { [flag]: false },
    })).toBe(true);
    expect(resolveMemoryFeatureFlagValue(flag, {
      runtimeConfigOverride: { [flag]: true },
      readFailed: true,
    })).toBe(false);
  });

  it('keeps dependent features effectively disabled until parents are enabled', () => {
    const requested = Object.fromEntries(MEMORY_FEATURE_FLAGS.map((flag) => [flag, true])) as Record<MemoryFeatureFlag, boolean>;
    const withoutPrereqs = computeEffectiveMemoryFeatureFlags(requested);
    expect(withoutPrereqs['mem.feature.citation']).toBe(true);
    expect(withoutPrereqs['mem.feature.cite_count']).toBe(true);
    expect(withoutPrereqs['mem.feature.user_private_sync']).toBe(true);
    expect(withoutPrereqs['mem.feature.org_shared_authored_standards']).toBe(false);

    const noParents = computeEffectiveMemoryFeatureFlags({
      'mem.feature.cite_count': true,
      'mem.feature.user_private_sync': true,
      'mem.feature.skill_auto_creation': true,
    });
    expect(noParents['mem.feature.cite_count']).toBe(false);
    expect(noParents['mem.feature.user_private_sync']).toBe(false);
    expect(noParents['mem.feature.skill_auto_creation']).toBe(false);
  });

  it('resolves layered flag values through dependency folding at runtime use sites', () => {
    expect(resolveEffectiveMemoryFeatureFlagValue('mem.feature.md_ingest', {
      environmentStartupDefault: {
        'mem.feature.md_ingest': true,
      },
    })).toBe(false);
    expect(resolveEffectiveMemoryFeatureFlagValue('mem.feature.md_ingest', {
      environmentStartupDefault: {
        'mem.feature.namespace_registry': true,
        'mem.feature.observation_store': true,
        'mem.feature.md_ingest': true,
      },
    })).toBe(true);
  });

  it('encodes the post-1.1 dependency graph', () => {
    expect(getMemoryFeatureFlagDefinition('mem.feature.observation_store').dependencies).toEqual(['mem.feature.namespace_registry']);
    expect(getMemoryFeatureFlagDefinition('mem.feature.citation').dependencies).toEqual(['mem.feature.quick_search']);
    expect(getMemoryFeatureFlagDefinition('mem.feature.cite_count').dependencies).toEqual(['mem.feature.citation']);
    expect(getMemoryFeatureFlagDefinition('mem.feature.cite_drift_badge').dependencies).toEqual(['mem.feature.citation']);
    expect(getMemoryFeatureFlagDefinition('mem.feature.skill_auto_creation').dependencies).toEqual(['mem.feature.skills', 'mem.feature.self_learning']);
    expect(getMemoryFeatureFlagDefinition('mem.feature.user_private_sync').dependencies).toEqual([
      'mem.feature.scope_registry_extensions',
      'mem.feature.namespace_registry',
      'mem.feature.observation_store',
    ]);
    expect(getMemoryFeatureFlagDefinition('mem.feature.org_shared_authored_standards').requiredPrerequisites).toEqual([
      'shared_context_document_migrations',
      'shared_context_version_migrations',
      'shared_context_binding_migrations',
    ]);
  });

  it('defines the closed memory counter registry and label enum boundary', () => {
    expect(MEMORY_COUNTERS).toContain('mem.citation.count_incremented');
    expect(MEMORY_COUNTERS).toContain('mem.preferences.duplicate_ignored');
    expect(MEMORY_COUNTERS).toContain('mem.preferences.rejected_untrusted');
    expect(MEMORY_COUNTERS).toContain('mem.preferences.persistence_failed');
    expect(MEMORY_COUNTERS).toContain('mem.skill.review_throttled');
    expect(MEMORY_COUNTERS).toContain('mem.skill.review_deduped');
    expect(MEMORY_COUNTERS).toContain('mem.skill.review_failed');
    expect(MEMORY_COUNTERS).toContain('mem.observation.unauthorized_promotion_attempt');
    expect(isMemoryCounter('mem.telemetry.buffer_overflow')).toBe(true);
    expect(MEMORY_COUNTER_LABEL_ENUMS).toEqual([
      'MemoryOrigin',
      'SendOrigin',
      'MemoryFeatureFlag',
      'FingerprintKind',
      'ObservationClass',
      'SkillReviewTrigger',
    ]);
  });
});
