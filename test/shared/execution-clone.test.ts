import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLONE_HARD_TIMEOUT_MS,
  DEFAULT_CLONE_RETENTION_MS,
  DEFAULT_MAX_PARALLEL_CLONES,
  DEFAULT_MAX_QUEUED_CLONES,
  EXECUTION_CLONE_CAPABILITY_V1,
  EXECUTION_CLONE_CLEANUP_STATES,
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_PARENT_STAGES,
  EXECUTION_CLONE_TERMINAL_REASONS,
  EXECUTION_CLONE_TIMELINE,
  EXECUTION_ROUTING_PREF_KEY,
  MAX_CLONE_HARD_TIMEOUT_MS,
  MAX_CLONE_RETENTION_MS,
  MAX_MAX_PARALLEL_CLONES,
  MAX_MAX_QUEUED_CLONES,
  MIN_CLONE_HARD_TIMEOUT_MS,
  MIN_CLONE_RETENTION_MS,
  MIN_MAX_PARALLEL_CLONES,
  MIN_MAX_QUEUED_CLONES,
  defaultDedicatedExecutionRoutingPreference,
  executionTemplatePrefKey,
  isExecutionCloneParentStage,
  parseDedicatedExecutionRoutingPreference,
  serializeDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '../../shared/execution-clone.js';

describe('execution-clone shared constants', () => {
  it('exposes the NEW stable capability id (not the group-clone one)', () => {
    expect(EXECUTION_CLONE_CAPABILITY_V1).toBe('execution-clone:v1');
    // Must be distinct from session-group-clone:v1.
    expect(EXECUTION_CLONE_CAPABILITY_V1).not.toBe('session-group-clone:v1');
  });

  it('pins the kind discriminant and timeline event name', () => {
    expect(EXECUTION_CLONE_KIND).toBe('execution_clone');
    expect(EXECUTION_CLONE_TIMELINE.TERMINAL).toBe('execution_clone.terminal');
  });

  it('keeps the parent-stage list + guard stable', () => {
    expect(EXECUTION_CLONE_PARENT_STAGES).toEqual([
      'generic_execution',
      'team_final_execution',
      'openspec_implementation',
      'auto_deliver_implementation',
    ]);
    for (const stage of EXECUTION_CLONE_PARENT_STAGES) {
      expect(isExecutionCloneParentStage(stage)).toBe(true);
    }
    expect(isExecutionCloneParentStage('main')).toBe(false);
    expect(isExecutionCloneParentStage('')).toBe(false);
    expect(isExecutionCloneParentStage(undefined)).toBe(false);
    expect(isExecutionCloneParentStage(42)).toBe(false);
  });

  it('keeps the cleanup-state machine stable', () => {
    expect(EXECUTION_CLONE_CLEANUP_STATES).toEqual([
      'active',
      'collecting',
      'destroying',
      'destroyed',
    ]);
  });

  it('keeps the terminal-reason list stable', () => {
    expect(EXECUTION_CLONE_TERMINAL_REASONS).toEqual([
      'reply',
      'pane_death',
      'hard_timeout',
      'destroyed',
      'sweep',
    ]);
  });

  it('keeps the error-code map stable', () => {
    expect(EXECUTION_CLONE_ERROR_CODES).toEqual({
      CAPACITY_FULL: 'capacity_full',
      CAPACITY_EXTERNALLY_SATURATED: 'capacity_externally_saturated',
      TEMPLATE_INELIGIBLE: 'template_ineligible',
      CLONE_OF_CLONE_FORBIDDEN: 'clone_of_clone_forbidden',
      WORKER_CLONE_FORBIDDEN: 'worker_clone_forbidden',
      CRON_CLONE_FORBIDDEN: 'cron_clone_forbidden',
      TARGET_NOT_FOUND: 'target_not_found',
      DESTROY_FORBIDDEN: 'destroy_forbidden',
    });
  });
});

describe('executionTemplatePrefKey (per-project, server-namespaced)', () => {
  it('namespaces by serverId and yields distinct keys per server', () => {
    const a = executionTemplatePrefKey('srv-a');
    const b = executionTemplatePrefKey('srv-b');
    expect(a).toBe('exec_routing.template:srv-a');
    expect(b).toBe('exec_routing.template:srv-b');
    expect(a).not.toBe(b);
  });

  it('falls back to a stable default scope for null/undefined/empty serverId', () => {
    const fromUndefined = executionTemplatePrefKey(undefined);
    const fromNull = executionTemplatePrefKey(null);
    const fromEmpty = executionTemplatePrefKey('');
    expect(fromUndefined).toBe('exec_routing.template:default');
    expect(fromNull).toBe(fromUndefined);
    expect(fromEmpty).toBe(fromUndefined);
    // The default key is distinct from any real serverId key.
    expect(fromUndefined).not.toBe(executionTemplatePrefKey('default-server-id'));
  });

  it('uses the dedicated global routing key separate from the template key', () => {
    expect(EXECUTION_ROUTING_PREF_KEY).toBe('exec_routing.global.v1');
    expect(EXECUTION_ROUTING_PREF_KEY).not.toBe(executionTemplatePrefKey('srv-a'));
  });
});

describe('dedicated execution routing preference — defaults', () => {
  it('default factory is disabled with canonical defaults', () => {
    expect(defaultDedicatedExecutionRoutingPreference()).toEqual({
      enabled: false,
      maxParallelClones: DEFAULT_MAX_PARALLEL_CLONES,
      maxQueuedClones: DEFAULT_MAX_QUEUED_CLONES,
      cloneHardTimeoutMs: DEFAULT_CLONE_HARD_TIMEOUT_MS,
      cloneRetentionMs: DEFAULT_CLONE_RETENTION_MS,
    });
  });

  it('pins the canonical default values', () => {
    expect(DEFAULT_MAX_PARALLEL_CLONES).toBe(3);
    expect(DEFAULT_MAX_QUEUED_CLONES).toBe(64);
    expect(DEFAULT_CLONE_HARD_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_CLONE_RETENTION_MS).toBe(5 * 60 * 1000);
  });

  it('parse(undefined / null / non-object) → disabled defaults', () => {
    const expected = defaultDedicatedExecutionRoutingPreference();
    expect(parseDedicatedExecutionRoutingPreference(undefined)).toEqual(expected);
    expect(parseDedicatedExecutionRoutingPreference(null)).toEqual(expected);
    expect(parseDedicatedExecutionRoutingPreference('nope')).toEqual(expected);
    expect(parseDedicatedExecutionRoutingPreference(123)).toEqual(expected);
    expect(parseDedicatedExecutionRoutingPreference([])).toEqual(expected);
    expect(parseDedicatedExecutionRoutingPreference(true)).toEqual(expected);
  });
});

describe('dedicated execution routing preference — clamping', () => {
  it('clamps zero / negative / huge values into their bounds', () => {
    const tooSmall = parseDedicatedExecutionRoutingPreference({
      enabled: true,
      maxParallelClones: 0,
      maxQueuedClones: -5,
      cloneHardTimeoutMs: -1,
      cloneRetentionMs: -100,
    });
    expect(tooSmall.maxParallelClones).toBe(MIN_MAX_PARALLEL_CLONES);
    expect(tooSmall.maxQueuedClones).toBe(MIN_MAX_QUEUED_CLONES);
    expect(tooSmall.cloneHardTimeoutMs).toBe(MIN_CLONE_HARD_TIMEOUT_MS);
    expect(tooSmall.cloneRetentionMs).toBe(MIN_CLONE_RETENTION_MS);

    const tooBig = parseDedicatedExecutionRoutingPreference({
      enabled: true,
      maxParallelClones: 9999,
      maxQueuedClones: 9_999_999,
      cloneHardTimeoutMs: Number.MAX_SAFE_INTEGER,
      cloneRetentionMs: Number.MAX_SAFE_INTEGER,
    });
    expect(tooBig.maxParallelClones).toBe(MAX_MAX_PARALLEL_CLONES);
    expect(tooBig.maxQueuedClones).toBe(MAX_MAX_QUEUED_CLONES);
    expect(tooBig.cloneHardTimeoutMs).toBe(MAX_CLONE_HARD_TIMEOUT_MS);
    expect(tooBig.cloneRetentionMs).toBe(MAX_CLONE_RETENTION_MS);
  });

  it('falls back to the field default when a numeric field is missing or NaN', () => {
    const defaults = defaultDedicatedExecutionRoutingPreference();
    const partial = parseDedicatedExecutionRoutingPreference({
      enabled: true,
      maxParallelClones: Number.NaN,
      // other numeric fields omitted entirely
    });
    expect(partial.maxParallelClones).toBe(defaults.maxParallelClones);
    expect(partial.maxQueuedClones).toBe(defaults.maxQueuedClones);
    expect(partial.cloneHardTimeoutMs).toBe(defaults.cloneHardTimeoutMs);
    expect(partial.cloneRetentionMs).toBe(defaults.cloneRetentionMs);
  });

  it('rounds fractional numeric values', () => {
    const parsed = parseDedicatedExecutionRoutingPreference({
      enabled: true,
      maxParallelClones: 4.7,
      maxQueuedClones: 10.2,
      cloneHardTimeoutMs: 120_000.9,
      cloneRetentionMs: 60_000.4,
    });
    expect(parsed.maxParallelClones).toBe(5);
    expect(parsed.maxQueuedClones).toBe(10);
    expect(parsed.cloneHardTimeoutMs).toBe(120_001);
    expect(parsed.cloneRetentionMs).toBe(60_000);
  });
});

describe('dedicated execution routing preference — enabled coercion', () => {
  it('enabled is true ONLY for the literal boolean true', () => {
    expect(parseDedicatedExecutionRoutingPreference({ enabled: true }).enabled).toBe(true);
    expect(parseDedicatedExecutionRoutingPreference({ enabled: false }).enabled).toBe(false);
    expect(parseDedicatedExecutionRoutingPreference({ enabled: 'true' }).enabled).toBe(false);
    expect(parseDedicatedExecutionRoutingPreference({ enabled: 1 }).enabled).toBe(false);
    expect(parseDedicatedExecutionRoutingPreference({ enabled: 'yes' }).enabled).toBe(false);
    expect(parseDedicatedExecutionRoutingPreference({ enabled: {} }).enabled).toBe(false);
    expect(parseDedicatedExecutionRoutingPreference({}).enabled).toBe(false);
  });
});

describe('dedicated execution routing preference — retired cloneTtlMs', () => {
  it('ignores a legacy cloneTtlMs field entirely (never in output)', () => {
    const parsed = parseDedicatedExecutionRoutingPreference({
      enabled: true,
      maxParallelClones: 2,
      maxQueuedClones: 8,
      cloneHardTimeoutMs: 120_000,
      cloneRetentionMs: 90_000,
      cloneTtlMs: 999_999,
    });
    expect(parsed).not.toHaveProperty('cloneTtlMs');
    expect(Object.keys(parsed).sort()).toEqual([
      'cloneHardTimeoutMs',
      'cloneRetentionMs',
      'enabled',
      'maxParallelClones',
      'maxQueuedClones',
    ]);
    // serialize never re-introduces cloneTtlMs either.
    const serialized = serializeDedicatedExecutionRoutingPreference(
      parsed as DedicatedExecutionRoutingGlobalPreference,
    );
    expect(serialized).not.toHaveProperty('cloneTtlMs');
  });
});

describe('dedicated execution routing preference — round-trip', () => {
  it('parse(serialize(x)) === x for a valid in-bounds preference', () => {
    const valid: DedicatedExecutionRoutingGlobalPreference = {
      enabled: true,
      maxParallelClones: 4,
      maxQueuedClones: 12,
      cloneHardTimeoutMs: 30 * 60 * 1000,
      cloneRetentionMs: 2 * 60 * 1000,
    };
    const serialized = serializeDedicatedExecutionRoutingPreference(valid);
    expect(serialized).toEqual(valid);
    expect(parseDedicatedExecutionRoutingPreference(serialized)).toEqual(valid);
  });

  it('serialize normalizes an out-of-bounds preference idempotently', () => {
    const messy: DedicatedExecutionRoutingGlobalPreference = {
      enabled: true,
      maxParallelClones: 1000,
      maxQueuedClones: -1,
      cloneHardTimeoutMs: 10,
      cloneRetentionMs: 99_999_999,
    };
    const once = serializeDedicatedExecutionRoutingPreference(messy);
    const twice = serializeDedicatedExecutionRoutingPreference(once);
    expect(twice).toEqual(once);
    expect(once.maxParallelClones).toBe(MAX_MAX_PARALLEL_CLONES);
    expect(once.maxQueuedClones).toBe(MIN_MAX_QUEUED_CLONES);
    expect(once.cloneHardTimeoutMs).toBe(MIN_CLONE_HARD_TIMEOUT_MS);
    expect(once.cloneRetentionMs).toBe(MAX_CLONE_RETENTION_MS);
  });
});
