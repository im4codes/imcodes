import { describe, expect, it } from 'vitest';
import {
  buildSupervisionExecutionCapabilityId,
  evaluateSupervisionExecutionBinding,
  mayFinalizeEconomyAssignment,
  migrateLegacySupervisionExecutionPools,
  normalizeSupervisionExecutionModel,
  normalizeSupervisionExecutionPools,
  planSupervisionExecutionCapacity,
  evaluateSupervisionObservedIdentity,
  SUPERVISION_AUDIT_ROUTING_REASONS,
  type SupervisionExecutionConfig,
} from '../../shared/supervision-execution-pool.js';

function config(agentType: string, providerFamily: string, model: string): SupervisionExecutionConfig {
  const runtimeType = 'transport' as const;
  return { agentType, providerFamily, model, runtimeType, capabilityId: buildSupervisionExecutionCapabilityId({ agentType, providerFamily, model, runtimeType }) };
}
const opus = config('claude-code-sdk', 'claude', 'opus[1M]');
const gpt56 = config('codex-sdk', 'codex', 'gpt-5.6');
const pools = normalizeSupervisionExecutionPools({
  state: 'configured',
  primaryDevelopmentPool: { configs: [opus, gpt56] },
  economyTaskPool: { configs: [] },
});
const actual = (entry: SupervisionExecutionConfig, overrides = {}) => ({
  sessionName: 'deck_alpha_w1', sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1',
  agentType: entry.agentType, providerFamily: entry.providerFamily, runtimeType: entry.runtimeType, model: entry.model,
  ...overrides,
});

describe('supervision execution pools', () => {
  it('keeps migration narrow and never auto-enables small or 27B models', () => {
    expect(migrateLegacySupervisionExecutionPools({ backend: 'codex-sdk', model: 'gpt-5.6' }).primaryDevelopmentPool.configs).toEqual([gpt56]);
    for (const model of ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'qwen-27b']) {
      expect(migrateLegacySupervisionExecutionPools({ backend: 'codex-sdk', model }).state).toBe('legacy_unconfigured');
    }
  });

  it('accepts either selected vendor and fails closed for unselected, drift, unknown and the current 27B session', () => {
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(opus) }).ok).toBe(true);
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(gpt56) }).ok).toBe(true);
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(config('gemini-sdk', 'gemini', 'gemini-2.5-pro')) })).toEqual({ ok: false, reason: 'unselected_config' });
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(gpt56, { model: 'gpt-5.5' }), requestedCapabilityId: gpt56.capabilityId })).toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(gpt56, { model: undefined }) })).toEqual({ ok: false, reason: 'unknown_model' });
    // Session exclusion is OBSERVED CONFIG POLICY, not a literal: the same
    // session binds normally unless the operator pins it through config.
    expect(evaluateSupervisionExecutionBinding({ pools, pool: 'primary', actual: actual(gpt56, { sessionName: 'deck_sub_2x4j6f3j' }) }).ok).toBe(true);
    expect(evaluateSupervisionExecutionBinding({
      pools, pool: 'primary', actual: actual(gpt56, { sessionName: 'deck_sub_2x4j6f3j' }),
      excludedSessionNames: ['deck_sub_2x4j6f3j'],
    })).toEqual({ ok: false, reason: 'excluded_session' });
  });

  // ── observed-vs-canonical model namespace ────────────────────────────────
  // Pool configs are written in the canonical picker namespace; the daemon
  // observes a versioned id. Raw equality between the two can never hold, which
  // pinned the primary pool at identity_mismatch permanently.
  it.each([['claude-opus-5'], ['claude-opus-5[1m]'], ['opus'], ['opus[1M]']])(
    'binds an observed %s to the canonical opus[1M] config',
    (observed) => {
      const result = evaluateSupervisionExecutionBinding({
        pools, pool: 'primary', actual: actual(opus, { model: observed }),
      });
      expect(result).toMatchObject({ ok: true, requested: { model: 'opus[1M]' } });
    },
  );

  it('only normalizes within the Claude Code family, never across agent types', () => {
    // The gate matters for a NON-Claude agentType hosting a model whose NAME
    // would normalize -- e.g. a third-party harness proxying a Claude id.
    // Without the gate that id silently collapses into the Claude bucket and
    // takes on a Claude capabilityId it has no right to.
    expect(normalizeSupervisionExecutionModel('claude-code-sdk', 'claude-opus-5')).toBe('opus[1M]');
    expect(normalizeSupervisionExecutionModel('deepseek-harness', 'claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeSupervisionExecutionModel('cursor-headless', 'claude-sonnet-9')).toBe('claude-sonnet-9');
    expect(buildSupervisionExecutionCapabilityId({ agentType: 'deepseek-harness', providerFamily: 'deepseek-harness', runtimeType: 'transport', model: 'claude-opus-5' }))
      .toContain('claude-opus-5');
  });

  it('never folds a third-party model hosted on claude-code-sdk into a Claude bucket', () => {
    // claude-code-sdk also hosts MiniMax-M3 / qwen3.8-27b. Those must stay verbatim.
    const mini = config('claude-code-sdk', 'claude', 'MiniMax-M3');
    expect(mini.model).toBe('MiniMax-M3');
    const withMini = normalizeSupervisionExecutionPools({
      state: 'configured', primaryDevelopmentPool: { configs: [mini] }, economyTaskPool: { configs: [] },
    });
    expect(evaluateSupervisionExecutionBinding({ pools: withMini, pool: 'primary', actual: actual(mini) }))
      .toMatchObject({ ok: true, requested: { model: 'MiniMax-M3' } });
    // ...and a genuinely different model still fails closed.
    expect(evaluateSupervisionExecutionBinding({ pools: withMini, pool: 'primary', actual: actual(mini, { model: 'gpt-5.6' }) }).ok)
      .toBe(false);
  });

  it('treats two sessions on the same excluded model identically', () => {
    // The old hardcoded list pinned ONE of two live qwen3.8-27b sessions, so
    // identical runtimes got opposite treatment purely by id.
    for (const sessionName of ['deck_sub_2x4j6f3j', 'deck_sub_2a4p2a40']) {
      expect(evaluateSupervisionExecutionBinding({
        pools, pool: 'primary', actual: actual(opus, { model: 'qwen3.8-27b', sessionName }),
      }), sessionName).toEqual({ ok: false, reason: 'excluded_model' });
    }
  });

  it('migrates any observed backend+model without a hardcoded id allowlist', () => {
    // The live Claude id migrates even though it is not the canonical literal.
    expect(migrateLegacySupervisionExecutionPools({ backend: 'claude-code-sdk', model: 'claude-opus-5' }))
      .toMatchObject({ state: 'configured', primaryDevelopmentPool: { configs: [{ model: 'opus[1M]', providerFamily: 'claude' }] } });
    expect(migrateLegacySupervisionExecutionPools({ backend: 'codex-sdk', model: 'gpt-5.6-sol' }))
      .toMatchObject({ state: 'configured', primaryDevelopmentPool: { configs: [{ model: 'gpt-5.6-sol', providerFamily: 'codex' }] } });
  });

  it('keeps economy fail-closed and prevents direct finalization', () => {
    expect(evaluateSupervisionExecutionBinding({ pools: { ...pools, economyTaskPool: { ...pools.economyTaskPool, configs: [gpt56] } }, pool: 'economy', actual: actual(gpt56) })).toEqual({ ok: false, reason: 'economy_policy_required' });
    expect(mayFinalizeEconomyAssignment({ pool: 'economy', primaryReviewPassed: false, crossVendorAuditPassed: true })).toBe(false);
    expect(mayFinalizeEconomyAssignment({ pool: 'economy', primaryReviewPassed: true, crossVendorAuditPassed: true })).toBe(true);
  });

  it('exports NO audit-route selector: the Brain chooses auditors, not the daemon', async () => {
    // Architecture guard. A daemon-side selector used to live here and pick a
    // cross-vendor auditor. It must not come back, and it must not come back
    // renamed -- so this asserts on SHAPE, not just on the old name.
    const mod = await import('../../shared/supervision-execution-pool.js') as Record<string, unknown>;
    expect(Object.keys(mod)).not.toContain('selectSupervisionAuditRoute');
    const selectorish = Object.keys(mod).filter((name) => /(select|choose|pick|route).*(audit|vendor|auditor)/i.test(name)
      || /(audit|vendor|auditor).*(select|choose|pick|route)/i.test(name));
    expect(selectorish, `daemon must not select auditors: ${selectorish.join(', ')}`).toEqual([]);
    // The Brain's stated reason is still persistable -- that is not selection.
    expect(SUPERVISION_AUDIT_ROUTING_REASONS.length).toBeGreaterThan(0);
  });

  const definition = pools.primaryDevelopmentPool;
  const base = { pool: 'primary' as const, definition, candidates: [] as never[], activeAssignments: 0, activeSpawned: 0, providerCapacity: { claude: { total: 3, inUse: 1 }, codex: { total: 2, inUse: 1 } }, parentSessionName: 'deck_alpha_brain', parentRunId: 'run-1', parentStage: 'implementation', idempotencyKey: 'spawn-1', now: 100 };

  it('reuses first, spawns same selected config idempotently, and enforces limits/headroom', () => {
    const spawned = planSupervisionExecutionCapacity(base);
    expect(spawned).toMatchObject({ action: 'spawn', request: { selectedConfig: opus, pool: 'primary' }, idempotentReplay: false });
    if (spawned.action !== 'spawn') throw new Error('expected spawn');
    expect(planSupervisionExecutionCapacity({ ...base, existingSpawnRequest: spawned.request })).toMatchObject({ action: 'spawn', idempotentReplay: true, request: spawned.request });
    expect(planSupervisionExecutionCapacity({ ...base, candidates: [{ config: gpt56, actual: actual(gpt56), available: true, limited: false, staleRuntime: false }] })).toMatchObject({ action: 'reuse' });
    expect(planSupervisionExecutionCapacity({ ...base, activeAssignments: definition.controls.maxConcurrency })).toEqual({ action: 'blocked', reason: 'max_concurrency' });
    expect(planSupervisionExecutionCapacity({ ...base, activeSpawned: definition.controls.maxSpawned })).toEqual({ action: 'blocked', reason: 'max_spawned' });
    expect(planSupervisionExecutionCapacity({ ...base, providerCapacity: { claude: { total: 2, inUse: 1 }, codex: { total: 2, inUse: 1 } } })).toEqual({ action: 'blocked', reason: 'audit_headroom' });
  });

  it('REFUSES reuse when the selected config and the OBSERVED identity disagree', () => {
    // Cx3 blocker: the slot is selected as Codex/gpt-5.6 but the session is
    // really running Claude/qwen3.8-27b. The old planner accepted any candidate
    // that merely HAD an `actual`, so this reused a foreign runtime.
    const impostor = {
      config: gpt56,
      actual: {
        sessionName: 'deck_alpha_w1', sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1',
        agentType: 'claude-code-sdk', providerFamily: 'claude',
        runtimeType: 'transport' as const, model: 'qwen3.8-27b',
      },
      available: true, limited: false, staleRuntime: false,
    };
    const plan = planSupervisionExecutionCapacity({ ...base, candidates: [impostor] });
    expect(plan.action).not.toBe('reuse');
    expect(plan).toMatchObject({ action: 'spawn' });
  });

  it('REFUSES reuse on each identity axis independently', () => {
    const honest = actual(gpt56);
    const axes: Array<[string, Record<string, unknown>]> = [
      ['agentType', { agentType: 'claude-code-sdk' }],
      ['providerFamily', { providerFamily: 'claude' }],
      ['runtimeType', { runtimeType: 'process' }],
      ['model', { model: 'qwen3.8-27b' }],
      ['sessionInstanceId missing', { sessionInstanceId: '' }],
      ['runtimeEpoch missing', { runtimeEpoch: '' }],
      ['model unknown', { model: '' }],
    ];
    for (const [label, override] of axes) {
      const plan = planSupervisionExecutionCapacity({
        ...base,
        candidates: [{ config: gpt56, actual: { ...honest, ...override } as never, available: true, limited: false, staleRuntime: false }],
      });
      expect(plan.action, label).not.toBe('reuse');
    }
    // ...and the honest candidate still reuses, so the gate is not vacuous.
    expect(planSupervisionExecutionCapacity({
      ...base, candidates: [{ config: gpt56, actual: honest, available: true, limited: false, staleRuntime: false }],
    })).toMatchObject({ action: 'reuse' });
  });

  it('REFUSES a laundered capabilityId: canonical contract wins over candidate.config', () => {
    // Cx5 counterexample. The caller presents a Codex-shaped config object that
    // carries the SELECTED Claude capabilityId, with an `actual` that matches
    // its own forged config. The old planner looked the capabilityId up in a
    // Set and then validated `actual` against `candidate.config`, so the forged
    // pair agreed with itself and reused. Binding must be to the canonical
    // config resolved from the pool definition.
    const laundered = {
      config: { ...gpt56, capabilityId: opus.capabilityId },
      actual: actual(gpt56),
      available: true, limited: false, staleRuntime: false,
    };
    const plan = planSupervisionExecutionCapacity({ ...base, candidates: [laundered] });
    expect(plan.action).not.toBe('reuse');
    expect(plan).toMatchObject({ action: 'spawn' });
    // The honest canonical pairing still reuses, so this is not vacuous.
    expect(planSupervisionExecutionCapacity({
      ...base, candidates: [{ config: opus, actual: actual(opus), available: true, limited: false, staleRuntime: false }],
    })).toMatchObject({ action: 'reuse' });
  });

  it('REFUSES reuse when the candidate config drifts from the canonical contract', () => {
    for (const drift of [{ model: 'qwen3.8-27b' }, { providerFamily: 'openai' }, { agentType: 'codex-sdk' }]) {
      const candidate = {
        config: { ...opus, ...drift },
        actual: actual({ ...opus, ...drift } as never),
        available: true, limited: false, staleRuntime: false,
      };
      expect(planSupervisionExecutionCapacity({ ...base, candidates: [candidate] }).action,
        JSON.stringify(drift)).not.toBe('reuse');
    }
  });

  it('requires a nonempty observed sessionName, distinctly from exclusion', () => {
    const honest = actual(opus);
    for (const name of [undefined, '', '   ']) {
      expect(evaluateSupervisionObservedIdentity({
        config: opus, actual: { ...honest, sessionName: name as never }, pool: 'primary',
      }), String(name)).toEqual({ ok: false, reason: 'identity_mismatch' });
    }
    // A PRESENT but excluded name still reports excluded_session, not the
    // missing-identity reason — the two failures stay distinguishable.
    expect(evaluateSupervisionObservedIdentity({
      config: opus, actual: honest, pool: 'primary', excludedSessionNames: [honest.sessionName],
    })).toEqual({ ok: false, reason: 'excluded_session' });
    expect(evaluateSupervisionObservedIdentity({ config: opus, actual: honest, pool: 'primary' }))
      .toEqual({ ok: true });
  });

  it('REFUSES reuse of an excluded actual model or excluded session', () => {
    const honest = actual(opus);
    const excludedModel = planSupervisionExecutionCapacity({
      ...base,
      candidates: [{ config: opus, actual: { ...honest, model: 'qwen3.8-27b' } as never, available: true, limited: false, staleRuntime: false }],
    });
    expect(excludedModel.action).not.toBe('reuse');
    const excludedSession = planSupervisionExecutionCapacity({
      ...base,
      excludedSessionNames: ['deck_alpha_w1'],
      candidates: [{ config: opus, actual: honest, available: true, limited: false, staleRuntime: false }],
    });
    expect(excludedSession.action).not.toBe('reuse');
  });
});
