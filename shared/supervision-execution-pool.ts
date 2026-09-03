import { getSessionRuntimeType, isClaudeCodeFamily } from './agent-types.js';
import { resolvePeerAuditProviderFamily } from './peer-audit.js';
import { normalizeClaudeCodeModelId } from '../src/shared/models/options.js';
import {
  doesSharedContextBackendSupportPresets,
  normalizeSharedContextRuntimeBackend,
} from './shared-context-runtime-config.js';

export const SUPERVISION_EXECUTION_POOL_KINDS = ['primary', 'economy'] as const;
export type SupervisionExecutionPoolKind = typeof SUPERVISION_EXECUTION_POOL_KINDS[number];

export const SUPERVISION_EXECUTION_POOL_CONFIG_STATES = ['configured', 'legacy_unconfigured'] as const;
export type SupervisionExecutionPoolConfigState = typeof SUPERVISION_EXECUTION_POOL_CONFIG_STATES[number];

export const SUPERVISION_EXECUTION_ORIGINS = ['reused', 'spawned'] as const;
export type SupervisionExecutionOrigin = typeof SUPERVISION_EXECUTION_ORIGINS[number];

export const SUPERVISION_AUDIT_ROUTING_REASONS = [
  'cross_vendor_preferred',
  'no_cross_vendor_available',
  'same_family_degraded',
  'brain_selected_same_family',
] as const;
export type SupervisionAuditRoutingReason = typeof SUPERVISION_AUDIT_ROUTING_REASONS[number];

export const SUPERVISION_AUDIT_DEGRADED_REASONS = [
  'no_cross_vendor_configured',
  'cross_vendor_limited',
  'cross_vendor_offline',
  'cross_vendor_unavailable',
  'cross_vendor_provision_failed',
  'cross_vendor_provision_timeout',
  'no_independent_session',
] as const;
export type SupervisionAuditDegradedReason = typeof SUPERVISION_AUDIT_DEGRADED_REASONS[number];

export const SUPERVISION_PROVISION_POOLS = ['primary', 'economy', 'audit'] as const;
export type SupervisionProvisionPool = typeof SUPERVISION_PROVISION_POOLS[number];

export const SUPERVISION_PROVISION_FAILURE_REASONS = [
  'pool_unconfigured',
  'no_selected_config',
  'unsupported_config',
  'provider_limited',
  'provider_offline',
  'max_spawned',
  'cooldown',
  'launch_failed',
  'readiness_timeout',
  'identity_collision',
  'parent_unavailable',
  'audited_unavailable',
] as const;
export type SupervisionProvisionFailureReason = typeof SUPERVISION_PROVISION_FAILURE_REASONS[number];

export interface SupervisionProvisioningEvidence {
  selectedPool: SupervisionProvisionPool;
  selectedConfig?: SupervisionExecutionConfig;
  origin?: SupervisionExecutionOrigin;
  provisionAttemptId?: string;
  createdSessionName?: string;
  failureReason?: SupervisionProvisionFailureReason;
  degradedReason?: SupervisionAuditDegradedReason;
}

export const SUPERVISION_ECONOMY_TASK_KINDS = [
  'read_only_inventory',
  'ownership_status_projection',
  'log_ci_triage',
  'deterministic_mechanical_edit',
  'narrow_test_fixture',
] as const;
export type SupervisionEconomyTaskKind = typeof SUPERVISION_ECONOMY_TASK_KINDS[number];

/** Ten known small/cheap presets are never migrated into ordinary development. */
export const SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_MODELS = [
  'haiku',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash',
  'o4-mini',
  'deepseek-v4-flash-free',
  'minimax-m2.5',
  'minimax-m2.7',
] as const;

/**
 * Session exclusions are OBSERVED CONFIG POLICY, never a literal in this file.
 *
 * A hardcoded session name was both redundant and inconsistent: the model policy
 * below already excludes any `27b` runtime, and the one pinned name covered only
 * one of the two live sessions running that same model -- so identical runtimes
 * received opposite treatment purely by id. Operators may still pin a specific
 * session through pools config; the default is empty and model policy decides.
 */
export const SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS: readonly string[] = [];

export interface SupervisionExecutionConfig {
  capabilityId: string;
  agentType: string;
  providerFamily: string;
  runtimeType: 'process' | 'transport';
  model: string;
  ccPresetId?: string;
}

export interface SupervisionExecutionPoolControls {
  maxConcurrency: number;
  maxSpawned: number;
  leaseMs: number;
  changeBudget: number;
  auditHeadroomPerProviderFamily: number;
}

export interface SupervisionExecutionPoolDefinition {
  configs: SupervisionExecutionConfig[];
  controls: SupervisionExecutionPoolControls;
}

export interface SupervisionExecutionPoolsConfig {
  state: SupervisionExecutionPoolConfigState;
  primaryDevelopmentPool: SupervisionExecutionPoolDefinition;
  economyTaskPool: SupervisionExecutionPoolDefinition;
}

export interface SupervisionObservedExecutionIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  agentType: string;
  providerFamily: string;
  runtimeType: 'process' | 'transport';
  model: string;
  ccPresetId?: string;
}

export interface SupervisionExecutionBinding {
  pool: SupervisionExecutionPoolKind;
  requested: SupervisionExecutionConfig;
  actual: SupervisionObservedExecutionIdentity;
  origin: SupervisionExecutionOrigin;
  parentSessionName?: string;
  parentRunId?: string;
  parentStage?: string;
  leaseExpiresAt?: number;
  capacitySlot?: number;
}

export interface SupervisionEconomyTaskPolicy {
  taskKind: SupervisionEconomyTaskKind;
  lowComplexity: true;
  lowRisk: true;
  scopeFiles: string[];
  changeBudget: number;
  requiresPrimaryReview: true;
}

export function normalizeSupervisionEconomyTaskPolicy(value: unknown): SupervisionEconomyTaskPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (!(SUPERVISION_ECONOMY_TASK_KINDS as readonly unknown[]).includes(source.taskKind)
    || source.lowComplexity !== true || source.lowRisk !== true || source.requiresPrimaryReview !== true
    || !Array.isArray(source.scopeFiles) || !source.scopeFiles.every((item) => typeof item === 'string' && item.length > 0)
    || typeof source.changeBudget !== 'number' || !Number.isFinite(source.changeBudget) || source.changeBudget <= 0) return undefined;
  return {
    taskKind: source.taskKind as SupervisionEconomyTaskKind,
    lowComplexity: true,
    lowRisk: true,
    requiresPrimaryReview: true,
    scopeFiles: [...source.scopeFiles] as string[],
    changeBudget: Math.floor(source.changeBudget),
  };
}

export const DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS: Readonly<Record<SupervisionExecutionPoolKind, SupervisionExecutionPoolControls>> = {
  primary: { maxConcurrency: 4, maxSpawned: 2, leaseMs: 30 * 60_000, changeBudget: 200, auditHeadroomPerProviderFamily: 1 },
  economy: { maxConcurrency: 4, maxSpawned: 2, leaseMs: 15 * 60_000, changeBudget: 40, auditHeadroomPerProviderFamily: 1 },
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : undefined;
}

/**
 * Collapse a vendor-versioned model onto its canonical pool identity.
 *
 * Pool configs are written in the canonical picker namespace (`opus[1M]`) while
 * the daemon OBSERVES a versioned id (`claude-opus-5`, `claude-opus-5[1m]`).
 * Comparing those raw strings can never succeed, which pinned the primary pool
 * at `identity_mismatch` permanently. Normalizing BOTH sides fixes that without
 * hardcoding today's live ids -- a future `claude-opus-6` keeps binding.
 *
 * Gated on the Claude Code family on purpose: `claude-code-sdk` also hosts
 * third-party models (MiniMax-M3, qwen3.8-27b), and those must pass through
 * verbatim rather than be folded into a Claude family bucket.
 */
export function normalizeSupervisionExecutionModel(agentType: string, model: string): string {
  const trimmed = model.trim();
  if (!trimmed || !isClaudeCodeFamily(agentType)) return trimmed;
  return normalizeClaudeCodeModelId(trimmed) ?? trimmed;
}

export function buildSupervisionExecutionCapabilityId(input: Omit<SupervisionExecutionConfig, 'capabilityId'>): string {
  const model = normalizeSupervisionExecutionModel(input.agentType, input.model);
  const base = `supervision-exec-v1:${input.runtimeType}:${input.agentType}:${input.providerFamily}:${model}`;
  if (input.ccPresetId === undefined) return base;
  const backend = normalizeSharedContextRuntimeBackend(input.agentType);
  if (!backend || !doesSharedContextBackendSupportPresets(backend)
    || !input.ccPresetId || input.ccPresetId.trim() !== input.ccPresetId) {
    throw new Error('invalid_supervision_execution_cc_preset');
  }
  // Preset-backed constraints use a disjoint namespace. Appending to the
  // legacy id would let an ordinary model containing the suffix grammar alias
  // a preset-backed capability.
  return `supervision-exec-v1-cc-preset:${input.runtimeType}:${input.agentType}:${input.providerFamily}:${encodeURIComponent(input.ccPresetId)}:${model}`;
}

export function isExcludedDevelopmentModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('27b')
    || (SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_MODELS as readonly string[]).includes(normalized);
}

export function normalizeSupervisionExecutionConfig(value: unknown): SupervisionExecutionConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const agentType = text(source.agentType);
  const providerFamily = text(source.providerFamily);
  const model = text(source.model);
  const runtimeType = source.runtimeType === 'process' || source.runtimeType === 'transport' ? source.runtimeType : undefined;
  if (!agentType || !providerFamily || !model || !runtimeType) return undefined;
  const ccPresetId = source.ccPresetId === undefined ? undefined : text(source.ccPresetId);
  const backend = normalizeSharedContextRuntimeBackend(agentType);
  if (source.ccPresetId !== undefined
    && (!ccPresetId || !backend || !doesSharedContextBackendSupportPresets(backend))) return undefined;
  const canonical = normalizeSupervisionExecutionModel(agentType, model);
  const expected = buildSupervisionExecutionCapabilityId({ agentType, providerFamily, runtimeType, model: canonical, ccPresetId });
  if (source.capabilityId !== expected) return undefined;
  return { capabilityId: expected, agentType, providerFamily, runtimeType, model: canonical, ...(ccPresetId ? { ccPresetId } : {}) };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : fallback;
}

function normalizePool(value: unknown, kind: SupervisionExecutionPoolKind): SupervisionExecutionPoolDefinition {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const controls = source.controls && typeof source.controls === 'object' && !Array.isArray(source.controls)
    ? source.controls as Record<string, unknown> : {};
  const configs = Array.isArray(source.configs)
    ? source.configs.map(normalizeSupervisionExecutionConfig).filter((item): item is SupervisionExecutionConfig => !!item)
    : [];
  const poolEligibleConfigs = kind === 'primary' ? configs.filter((item) => !isExcludedDevelopmentModel(item.model)) : configs;
  return {
    configs: [...new Map(poolEligibleConfigs.map((item) => [item.capabilityId, item])).values()],
    controls: {
      maxConcurrency: positive(controls.maxConcurrency, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].maxConcurrency),
      maxSpawned: positive(controls.maxSpawned, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].maxSpawned),
      leaseMs: positive(controls.leaseMs, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].leaseMs),
      changeBudget: positive(controls.changeBudget, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].changeBudget),
      auditHeadroomPerProviderFamily: positive(controls.auditHeadroomPerProviderFamily, DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS[kind].auditHeadroomPerProviderFamily),
    },
  };
}

/**
 * Why automatic supervision may not save or start yet.
 *
 * These are the only two ways the canonical pool config can be unusable, and
 * both must fail closed: an install that never opted in, and an install that
 * opted in but selected nothing to run on.
 */
export const SUPERVISION_AUTOMATION_POOL_GATE_REASONS = {
  LEGACY_UNCONFIGURED: 'supervision_pools_legacy_unconfigured',
  NO_POOL_SELECTED: 'supervision_pool_not_selected',
} as const;

export type SupervisionAutomationPoolGateReason =
  typeof SUPERVISION_AUTOMATION_POOL_GATE_REASONS[
    keyof typeof SUPERVISION_AUTOMATION_POOL_GATE_REASONS];

export type SupervisionAutomationPoolGate =
  | { ok: true }
  | { ok: false; reason: SupervisionAutomationPoolGateReason };

/**
 * The single precondition for saving or starting automatic supervision.
 *
 * Reads only canonical `SupervisionExecutionPoolsConfig` fields, so the UI and
 * the authoritative save entry cannot drift apart or disagree about what
 * "configured" means. Deliberately fail-closed: anything other than an explicit
 * `configured` state carrying a real primary selection is refused, and a legacy
 * migration never silently satisfies it.
 */
export function evaluateSupervisionAutomationPoolGate(
  pools: SupervisionExecutionPoolsConfig | null | undefined,
): SupervisionAutomationPoolGate {
  if (!pools || pools.state !== 'configured') {
    return { ok: false, reason: SUPERVISION_AUTOMATION_POOL_GATE_REASONS.LEGACY_UNCONFIGURED };
  }
  if (!Array.isArray(pools.primaryDevelopmentPool?.configs)
    || pools.primaryDevelopmentPool.configs.length === 0) {
    return { ok: false, reason: SUPERVISION_AUTOMATION_POOL_GATE_REASONS.NO_POOL_SELECTED };
  }
  return { ok: true };
}

/**
 * Operator-facing guidance for a refusal, in the seven supported UI locales.
 *
 * Takes a plain locale string rather than importing the locale list, because
 * shared/supervision-config.ts already imports this module and a value import
 * back would be a runtime cycle. Locale parity is enforced by test.
 */
export function buildSupervisionPoolGateGuidance(
  reason: SupervisionAutomationPoolGateReason,
  locale?: string,
): string {
  const guidance: Record<SupervisionAutomationPoolGateReason, Record<string, string>> = {
    [SUPERVISION_AUTOMATION_POOL_GATE_REASONS.LEGACY_UNCONFIGURED]: {
      en: 'Automatic supervision is off until you configure the execution pools. Open supervision settings and confirm the primary development pool; no legacy default is applied for you.',
      'zh-CN': '在配置执行池之前，自动监督保持关闭。请打开监督设置并确认主开发池；系统不会为你套用任何旧版默认值。',
      'zh-TW': '在設定執行池之前，自動監督維持關閉。請開啟監督設定並確認主開發池；系統不會為你套用任何舊版預設值。',
      es: 'La supervisión automática permanece desactivada hasta que configures los grupos de ejecución. Abre los ajustes de supervisión y confirma el grupo de desarrollo principal; no se aplica ningún valor heredado por ti.',
      ru: 'Автоматический надзор выключен, пока не настроены пулы выполнения. Откройте настройки надзора и подтвердите основной пул разработки; устаревшие значения по умолчанию не применяются автоматически.',
      ja: '実行プールを構成するまで自動監督は無効のままです。監督設定を開いてプライマリ開発プールを確認してください。レガシーの既定値が自動適用されることはありません。',
      ko: '실행 풀을 구성하기 전까지 자동 감독은 꺼져 있습니다. 감독 설정을 열어 기본 개발 풀을 확인하세요. 레거시 기본값이 자동으로 적용되지 않습니다.',
    },
    [SUPERVISION_AUTOMATION_POOL_GATE_REASONS.NO_POOL_SELECTED]: {
      en: 'The execution pools are configured but the primary development pool has no runtime selected. Choose at least one execution config before enabling automatic supervision.',
      'zh-CN': '执行池已配置，但主开发池尚未选择任何运行时。请在启用自动监督前至少选择一个执行配置。',
      'zh-TW': '執行池已設定，但主開發池尚未選擇任何執行階段。請在啟用自動監督前至少選擇一個執行設定。',
      es: 'Los grupos de ejecución están configurados, pero el grupo de desarrollo principal no tiene ningún runtime seleccionado. Elige al menos una configuración de ejecución antes de activar la supervisión automática.',
      ru: 'Пулы выполнения настроены, но в основном пуле разработки не выбрана среда выполнения. Выберите хотя бы одну конфигурацию выполнения перед включением автоматического надзора.',
      ja: '実行プールは構成済みですが、プライマリ開発プールにランタイムが選択されていません。自動監督を有効にする前に、実行構成を少なくとも 1 つ選択してください。',
      ko: '실행 풀은 구성되었지만 기본 개발 풀에 선택된 런타임이 없습니다. 자동 감독을 켜기 전에 실행 구성을 하나 이상 선택하세요.',
    },
  };
  const byLocale = guidance[reason];
  return byLocale[locale ?? 'en'] ?? byLocale.en;
}

export function normalizeSupervisionExecutionPools(value: unknown): SupervisionExecutionPoolsConfig {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const primaryDevelopmentPool = normalizePool(source.primaryDevelopmentPool, 'primary');
  const economyTaskPool = normalizePool(source.economyTaskPool, 'economy');
  const explicitlyConfigured = source.state === 'configured';
  return {
    state: explicitlyConfigured ? 'configured' : 'legacy_unconfigured',
    primaryDevelopmentPool,
    economyTaskPool,
  };
}

export function migrateLegacySupervisionExecutionPools(input: {
  backend?: string | null;
  model?: string | null;
  executionPools?: unknown;
}): SupervisionExecutionPoolsConfig {
  const normalized = normalizeSupervisionExecutionPools(input.executionPools);
  if (normalized.state === 'configured') return normalized;
  const backend = input.backend?.trim();
  const rawModel = input.model?.trim();
  // No hardcoded model allowlist. Any observed backend+model may migrate, and
  // eligibility is decided by the SAME exclusion policy the pool uses -- so the
  // small/cheap and 27B runtimes stay out without naming today's ids here.
  const model = backend && rawModel ? normalizeSupervisionExecutionModel(backend, rawModel) : undefined;
  const migration = backend && model && !isExcludedDevelopmentModel(model)
    ? {
      agentType: backend,
      providerFamily: resolvePeerAuditProviderFamily({ agentType: backend }),
      runtimeType: getSessionRuntimeType(backend),
      model,
    }
    : undefined;
  if (!migration) return normalized;
  const config = { ...migration, capabilityId: buildSupervisionExecutionCapabilityId(migration) };
  return { ...normalized, state: 'configured', primaryDevelopmentPool: { ...normalized.primaryDevelopmentPool, configs: [config] } };
}

export type SupervisionExecutionEligibilityReason = 'eligible' | 'pool_unconfigured' | 'unselected_config' | 'excluded_session' | 'excluded_model' | 'unknown_model' | 'identity_mismatch' | 'economy_policy_required';

/**
 * The single observed-identity gate.
 *
 * Both the binding evaluator and the reuse planner call this, so a session can
 * never be reused on a weaker check than it was bound on. Fail-closed: every
 * branch returns a reason, and a missing field is a mismatch rather than a
 * skipped comparison.
 */
export function evaluateSupervisionObservedIdentity(input: {
  config: SupervisionExecutionConfig;
  actual: Partial<SupervisionObservedExecutionIdentity>;
  pool: SupervisionExecutionPoolKind;
  excludedSessionNames?: readonly string[];
}): { ok: true } | { ok: false; reason: SupervisionExecutionEligibilityReason } {
  // A missing observed sessionName is not "not excluded" -- it is no identity at
  // all. Previously an absent name reached `excluded.includes('')`, which is
  // false, so it sailed past this gate and was never required anywhere after.
  const observedSessionName = input.actual.sessionName?.trim() ?? '';
  if (!observedSessionName) return { ok: false, reason: 'identity_mismatch' };
  const excluded = input.excludedSessionNames ?? SUPERVISION_DEFAULT_EXCLUDED_DEVELOPMENT_SESSIONS;
  if (excluded.includes(observedSessionName)) return { ok: false, reason: 'excluded_session' };
  if (!input.actual.model) return { ok: false, reason: 'unknown_model' };
  // Checked against the ACTUAL model, never the selected one: a config naming an
  // allowed model cannot launder a session actually running an excluded one.
  if (input.pool === 'primary' && isExcludedDevelopmentModel(input.actual.model)) {
    return { ok: false, reason: 'excluded_model' };
  }
  if (!input.actual.sessionInstanceId || !input.actual.runtimeEpoch || !input.actual.agentType
    || !input.actual.providerFamily || !input.actual.runtimeType) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  // Compare in the canonical namespace: `actual.model` is the daemon-OBSERVED id
  // (e.g. `claude-opus-5`), configs hold the picker id (`opus[1M]`).
  const canonicalConfig = normalizeSupervisionExecutionConfig(input.config);
  if (!canonicalConfig) return { ok: false, reason: 'identity_mismatch' };
  const observedModel = normalizeSupervisionExecutionModel(input.actual.agentType, input.actual.model);
  const observedPreset = input.actual.ccPresetId === undefined ? undefined : text(input.actual.ccPresetId);
  const observedBackend = normalizeSharedContextRuntimeBackend(input.actual.agentType);
  if (input.actual.ccPresetId !== undefined
    && (!observedPreset || !observedBackend || !doesSharedContextBackendSupportPresets(observedBackend))) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (canonicalConfig.agentType !== input.actual.agentType
    || canonicalConfig.providerFamily !== input.actual.providerFamily
    || canonicalConfig.runtimeType !== input.actual.runtimeType
    || canonicalConfig.model !== observedModel
    || canonicalConfig.ccPresetId !== observedPreset) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  return { ok: true };
}

export function evaluateSupervisionExecutionBinding(input: {
  pools: SupervisionExecutionPoolsConfig;
  pool: SupervisionExecutionPoolKind;
  actual: Partial<SupervisionObservedExecutionIdentity>;
  requestedCapabilityId?: string;
  economyPolicy?: SupervisionEconomyTaskPolicy;
  /** Observed config policy. Defaults to empty; model policy does the work. */
  excludedSessionNames?: readonly string[];
}): { ok: true; requested: SupervisionExecutionConfig } | { ok: false; reason: SupervisionExecutionEligibilityReason } {
  if (input.pools.state !== 'configured') return { ok: false, reason: 'pool_unconfigured' };
  if (input.pool === 'economy' && !input.economyPolicy) return { ok: false, reason: 'economy_policy_required' };
  const pool = input.pool === 'primary' ? input.pools.primaryDevelopmentPool : input.pools.economyTaskPool;
  const observedModel = input.actual.model
    ? normalizeSupervisionExecutionModel(input.actual.agentType ?? '', input.actual.model)
    : '';
  const requested = pool.configs.find((config) => config.capabilityId === input.requestedCapabilityId)
    ?? (!input.requestedCapabilityId ? pool.configs.find((config) => config.agentType === input.actual.agentType
      && config.providerFamily === input.actual.providerFamily && config.runtimeType === input.actual.runtimeType
      && config.model === observedModel && config.ccPresetId === input.actual.ccPresetId) : undefined);
  // Order matters: a caller naming a capability that is not in the pool gets
  // `unselected_config`, which must not be masked by an identity reason.
  const preCheck = evaluateSupervisionObservedIdentity({
    config: requested ?? { capabilityId: '', agentType: '', providerFamily: '', runtimeType: 'process', model: '' } as SupervisionExecutionConfig,
    actual: input.actual, pool: input.pool, excludedSessionNames: input.excludedSessionNames,
  });
  if (!preCheck.ok && preCheck.reason !== 'identity_mismatch') return preCheck;
  if (!requested) return { ok: false, reason: 'unselected_config' };
  if (!preCheck.ok) return preCheck;
  return { ok: true, requested };
}

/**
 * AUDIT ROUTING IS NOT A DAEMON DECISION.
 *
 * A `selectSupervisionAuditRoute()` helper used to live here and pick a
 * cross-vendor auditor. It is removed deliberately: the Supervisor Brain
 * chooses who audits and how to cross vendor, and the daemon must never select
 * a target, vendor or model. The daemon's whole role is to validate, persist
 * and deliver the exact route the Brain supplied, and to wake the Brain when
 * one is absent -- never to synthesise one, and never under another name.
 *
 * `SupervisionAuditRoutingReason` intentionally REMAINS: the Brain states the
 * reason it chose, and the registry persists that statement verbatim.
 */

export function mayFinalizeEconomyAssignment(input: { pool?: SupervisionExecutionPoolKind; primaryReviewPassed: boolean; crossVendorAuditPassed: boolean }): boolean {
  return input.pool !== 'economy' || (input.primaryReviewPassed && input.crossVendorAuditPassed);
}

export interface SupervisionExecutionCapacityCandidate {
  config: SupervisionExecutionConfig;
  actual?: SupervisionObservedExecutionIdentity;
  available: boolean;
  limited: boolean;
  staleRuntime: boolean;
}

export interface SupervisionExecutionSpawnRequest {
  idempotencyKey: string;
  pool: SupervisionExecutionPoolKind;
  selectedConfig: SupervisionExecutionConfig;
  parentSessionName: string;
  parentRunId: string;
  parentStage: string;
  leaseExpiresAt: number;
}

export type SupervisionExecutionCapacityPlan =
  | { action: 'reuse'; candidate: SupervisionExecutionCapacityCandidate }
  | { action: 'spawn'; request: SupervisionExecutionSpawnRequest; idempotentReplay: boolean }
  | { action: 'blocked'; reason: 'pool_exhausted' | 'max_concurrency' | 'max_spawned' | 'audit_headroom' | 'no_selected_config' };

export function planSupervisionExecutionCapacity(input: {
  pool: SupervisionExecutionPoolKind;
  definition: SupervisionExecutionPoolDefinition;
  candidates: readonly SupervisionExecutionCapacityCandidate[];
  activeAssignments: number;
  activeSpawned: number;
  providerCapacity: Readonly<Record<string, { total: number; inUse: number }>>;
  parentSessionName: string;
  parentRunId: string;
  parentStage: string;
  idempotencyKey: string;
  now: number;
  existingSpawnRequest?: SupervisionExecutionSpawnRequest;
  /** Observed config policy, threaded through to the reuse identity gate. */
  excludedSessionNames?: readonly string[];
}): SupervisionExecutionCapacityPlan {
  // Reuse binds to the CANONICAL config from the pool definition, looked up by
  // capabilityId -- never to `candidate.config`, which the caller supplies.
  //
  // Two separate holes closed here. First, reuse used to accept any candidate
  // that merely HAD an `actual`, so a slot selected as Codex/gpt-5.6 could be
  // reused while the session really ran Claude/qwen3.8-27b. Second, validating
  // `actual` against `candidate.config` let a caller launder a selected
  // capabilityId onto an otherwise foreign config object and have the identity
  // gate cheerfully compare the actual against that attacker-chosen contract.
  const canonicalByCapability = new Map(
    input.definition.configs.map((config) => [config.capabilityId, config] as const),
  );
  const reusable = input.candidates.find((candidate) => {
    const canonical = canonicalByCapability.get(candidate.config.capabilityId);
    if (!canonical) return false;
    if (!candidate.actual || !candidate.available || candidate.limited || candidate.staleRuntime) return false;
    return evaluateSupervisionObservedIdentity({
      config: canonical, actual: candidate.actual, pool: input.pool,
      excludedSessionNames: input.excludedSessionNames,
    }).ok;
  });
  if (reusable) return { action: 'reuse', candidate: reusable };
  if (input.existingSpawnRequest?.idempotencyKey === input.idempotencyKey) {
    return { action: 'spawn', request: input.existingSpawnRequest, idempotentReplay: true };
  }
  if (input.definition.configs.length === 0) return { action: 'blocked', reason: 'no_selected_config' };
  if (input.activeAssignments >= input.definition.controls.maxConcurrency) return { action: 'blocked', reason: 'max_concurrency' };
  if (input.activeSpawned >= input.definition.controls.maxSpawned) return { action: 'blocked', reason: 'max_spawned' };
  const selectedConfig = input.definition.configs.find((config) => {
    const capacity = input.providerCapacity[config.providerFamily];
    return capacity && capacity.total - capacity.inUse > input.definition.controls.auditHeadroomPerProviderFamily;
  });
  if (!selectedConfig) return { action: 'blocked', reason: 'audit_headroom' };
  return {
    action: 'spawn',
    idempotentReplay: false,
    request: {
      idempotencyKey: input.idempotencyKey,
      pool: input.pool,
      selectedConfig,
      parentSessionName: input.parentSessionName,
      parentRunId: input.parentRunId,
      parentStage: input.parentStage,
      leaseExpiresAt: input.now + input.definition.controls.leaseMs,
    },
  };
}
