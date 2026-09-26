import type { ContextModelConfig, SharedContextRuntimeBackend } from './context-types.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from './context-model-defaults.js';
import {
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  DEFAULT_CODEX_AUTOMATION_MODEL,
  looksLikeCodexModelId,
  normalizeClaudeCodeModelId,
} from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';
import {
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  MEMORY_SCORING_WEIGHT_STEP,
  normalizeMemoryScoringWeights,
  RECALL_MIN_FLOOR,
} from './memory-scoring.js';
export { DEFAULT_MEMORY_SCORING_WEIGHTS, normalizeMemoryScoringWeights } from './memory-scoring.js';

export const SHARED_CONTEXT_RUNTIME_BACKENDS = ['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw'] as const satisfies readonly SharedContextRuntimeBackend[];
export const DEFAULT_PRIMARY_CONTEXT_BACKEND: SharedContextRuntimeBackend = 'codex-sdk';
export const DEFAULT_CONTEXT_MODEL_BY_BACKEND: Record<SharedContextRuntimeBackend, string> = {
  'claude-code-sdk': DEFAULT_PRIMARY_CONTEXT_MODEL,
  'codex-sdk': DEFAULT_CODEX_AUTOMATION_MODEL,
  qwen: 'qwen3-coder-plus',
  openclaw: DEFAULT_PRIMARY_CONTEXT_MODEL,
};
export const DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL = DEFAULT_CONTEXT_MODEL_BY_BACKEND[DEFAULT_PRIMARY_CONTEXT_BACKEND];

export const SHARED_CONTEXT_RUNTIME_CONFIG_MSG = {
  APPLY: 'shared_context.runtime_config.apply',
} as const;

export const SHARED_CONTEXT_RUNTIME_CONFIG_ERROR = {
  INVALID_CONFIG: 'invalid_shared_context_runtime_config',
} as const;

export const DEFAULT_MEMORY_RECALL_MIN_SCORE = RECALL_MIN_FLOOR;
export const MEMORY_RECALL_MIN_SCORE_MIN = 0;
export const MEMORY_RECALL_MIN_SCORE_MAX = 1;
export const MEMORY_RECALL_MIN_SCORE_STEP = 0.01;
export const MEMORY_SCORING_WEIGHT_MIN = 0;
export const MEMORY_SCORING_WEIGHT_MAX = 1;
export const MEMORY_SCORING_WEIGHT_INPUT_STEP = MEMORY_SCORING_WEIGHT_STEP;

export interface SharedContextRuntimeConfigSnapshot {
  persisted: ContextModelConfig;
  effective: ContextModelConfig;
  envPrimaryOverrideActive: boolean;
  envBackupOverrideActive: boolean;
  defaultPrimaryContextBackend: SharedContextRuntimeBackend;
  defaultPrimaryContextModel: string;
}

export function defaultSharedContextRuntimeConfig(): ContextModelConfig {
  return {
    primaryContextBackend: DEFAULT_PRIMARY_CONTEXT_BACKEND,
    primaryContextModel: DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
    primaryContextPreset: undefined,
    backupContextBackend: undefined,
    backupContextModel: undefined,
    backupContextPreset: undefined,
    memoryRecallMinScore: DEFAULT_MEMORY_RECALL_MIN_SCORE,
    memoryScoringWeights: { ...DEFAULT_MEMORY_SCORING_WEIGHTS },
    enablePersonalMemorySync: true,
  };
}

export function normalizeMemoryRecallMinScore(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MEMORY_RECALL_MIN_SCORE;
  if (value <= MEMORY_RECALL_MIN_SCORE_MIN) return MEMORY_RECALL_MIN_SCORE_MIN;
  if (value >= MEMORY_RECALL_MIN_SCORE_MAX) return MEMORY_RECALL_MIN_SCORE_MAX;
  return Math.round(value * 100) / 100;
}

export function normalizeSharedContextRuntimeBackend(value: string | null | undefined): SharedContextRuntimeBackend | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return SHARED_CONTEXT_RUNTIME_BACKENDS.includes(trimmed as SharedContextRuntimeBackend)
    ? trimmed as SharedContextRuntimeBackend
    : undefined;
}

export function inferSharedContextRuntimeBackend(model: string | null | undefined): SharedContextRuntimeBackend | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (CLAUDE_CODE_MODEL_IDS.includes(trimmed as typeof CLAUDE_CODE_MODEL_IDS[number])) return 'claude-code-sdk';
  if (CODEX_MODEL_IDS.includes(trimmed as typeof CODEX_MODEL_IDS[number])) return 'codex-sdk';
  if (QWEN_MODEL_IDS.includes(trimmed as typeof QWEN_MODEL_IDS[number])) return 'qwen';
  // A live model the daemon's SDK/provider probe returned isn't in any static
  // list yet (a newly released id such as `gpt-6-luna` or `claude-opus-4-7`).
  // Classify it by naming convention instead of leaving it unclassified,
  // which would otherwise silently fall back to the default backend and
  // validate the model against the WRONG provider's catalog.
  if (normalizeClaudeCodeModelId(trimmed)) return 'claude-code-sdk';
  if (looksLikeCodexModelId(trimmed)) return 'codex-sdk';
  return undefined;
}

export function getDefaultSharedContextModelForBackend(backend: SharedContextRuntimeBackend): string {
  return DEFAULT_CONTEXT_MODEL_BY_BACKEND[backend];
}

export function doesSharedContextBackendSupportPresets(backend: SharedContextRuntimeBackend | null | undefined): boolean {
  // Anthropic-compatible third-party presets (ANTHROPIC_BASE_URL/API_KEY/MODEL)
  // run either through the Qwen OpenAI-compat transport or natively on the
  // Claude Code SDK. The CC SDK path is preferred (it strips leaked <think>).
  return backend === 'qwen' || backend === 'claude-code-sdk';
}

/**
 * Whether `model` is an acceptable value for `backend`.
 *
 * The static `*_MODEL_IDS` lists are a fallback suggestion list, not an
 * allowlist: the daemon's live SDK/provider probe routinely returns models
 * released after this file was last updated (`gpt-6-luna`, `claude-opus-4-7`,
 * ...), and a static membership check silently rejected/replaced them. This
 * only rejects a model that is recognizably a DIFFERENT backend's model (by
 * static membership or naming pattern) — cross-backend confusion (a Claude
 * alias configured under `qwen`, say) is still a real mistake worth catching.
 * Anything else, including an unrecognized-but-plausible live id for the
 * given backend, is accepted.
 */
export function isKnownSharedContextModelForBackend(
  backend: SharedContextRuntimeBackend,
  model: string | null | undefined,
  preset?: string | null | undefined,
): boolean {
  const trimmed = model?.trim();
  if (!trimmed) return false;
  // A preset pins the model its third-party endpoint serves (e.g. MiniMax-M3),
  // which won't match any provider's own naming pattern — accept any non-empty
  // model while a preset is active.
  if (preset?.trim() && doesSharedContextBackendSupportPresets(backend)) return true;
  // A bare backend id (e.g. "qwen") is never a real model id for any backend
  // -- it is a degenerate/placeholder value (an unset field synced verbatim
  // from its own backend name), not a live model the static list doesn't
  // know about yet.
  if ((SHARED_CONTEXT_RUNTIME_BACKENDS as readonly string[]).includes(trimmed)) return false;
  const isClaudeShaped = CLAUDE_CODE_MODEL_IDS.includes(trimmed as typeof CLAUDE_CODE_MODEL_IDS[number])
    || !!normalizeClaudeCodeModelId(trimmed);
  const isCodexShaped = CODEX_MODEL_IDS.includes(trimmed as typeof CODEX_MODEL_IDS[number])
    || looksLikeCodexModelId(trimmed);
  const isQwenShaped = QWEN_MODEL_IDS.includes(trimmed as typeof QWEN_MODEL_IDS[number]);
  switch (backend) {
    case 'claude-code-sdk':
      return !isCodexShaped && !isQwenShaped;
    case 'codex-sdk':
      return !isClaudeShaped && !isQwenShaped;
    case 'qwen':
      return !isClaudeShaped && !isCodexShaped;
    case 'openclaw':
      return true;
  }
}

function trimModelValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSharedContextPresetValue(
  backend: SharedContextRuntimeBackend | undefined,
  preset: string | undefined,
): string | undefined {
  const trimmed = trimModelValue(preset);
  if (!trimmed || !backend || !doesSharedContextBackendSupportPresets(backend)) return undefined;
  return trimmed;
}

export interface OptionalSharedContextRuntimeSelection {
  backend?: SharedContextRuntimeBackend;
  model?: string;
  preset?: string;
}

/**
 * Normalize an optional fallback runtime without manufacturing one when the
 * user left it unset. Shared Context and automatic supervision deliberately
 * use the same backend/model/preset semantics so third-party presets behave
 * identically in both features.
 */
export function normalizeOptionalSharedContextRuntimeSelection(input: {
  backend?: string | null;
  model?: string | null;
  preset?: string | null;
} | null | undefined): OptionalSharedContextRuntimeSelection {
  const backend = normalizeSharedContextRuntimeBackend(input?.backend)
    ?? inferSharedContextRuntimeBackend(input?.model);
  if (!backend) return {};
  const preset = normalizeSharedContextPresetValue(backend, input?.preset ?? undefined);
  const rawModel = trimModelValue(input?.model ?? undefined);
  const model = rawModel && isKnownSharedContextModelForBackend(backend, rawModel, preset)
    ? rawModel
    : getDefaultSharedContextModelForBackend(backend);
  return {
    backend,
    model,
    ...(preset ? { preset } : {}),
  };
}

export function normalizeSharedContextRuntimeConfig(
  input: Partial<ContextModelConfig> | null | undefined,
): ContextModelConfig {
  const normalizedPrimaryBackend = normalizeSharedContextRuntimeBackend(input?.primaryContextBackend)
    ?? inferSharedContextRuntimeBackend(input?.primaryContextModel)
    ?? DEFAULT_PRIMARY_CONTEXT_BACKEND;
  const primaryContextPreset = normalizeSharedContextPresetValue(normalizedPrimaryBackend, input?.primaryContextPreset);
  const rawPrimaryContextModel = trimModelValue(input?.primaryContextModel);
  const primaryContextModel = rawPrimaryContextModel && isKnownSharedContextModelForBackend(normalizedPrimaryBackend, rawPrimaryContextModel, primaryContextPreset)
    ? rawPrimaryContextModel
    : getDefaultSharedContextModelForBackend(normalizedPrimaryBackend);
  const backup = normalizeOptionalSharedContextRuntimeSelection({
    backend: input?.backupContextBackend,
    model: input?.backupContextModel,
    preset: input?.backupContextPreset,
  });
  const rawMinInterval = input?.materializationMinIntervalMs;
  const materializationMinIntervalMs = typeof rawMinInterval === 'number' && rawMinInterval > 0 ? rawMinInterval : undefined;
  const memoryRecallMinScore = normalizeMemoryRecallMinScore(input?.memoryRecallMinScore);
  const memoryScoringWeights = normalizeMemoryScoringWeights(input?.memoryScoringWeights);
  return {
    primaryContextBackend: normalizedPrimaryBackend,
    primaryContextModel,
    primaryContextPreset,
    primaryContextSdk: trimModelValue(input?.primaryContextSdk),
    backupContextBackend: backup.backend,
    backupContextModel: backup.model,
    backupContextPreset: backup.preset,
    backupContextSdk: trimModelValue(input?.backupContextSdk),
    materializationMinIntervalMs,
    memoryRecallMinScore,
    memoryScoringWeights,
    enablePersonalMemorySync: input?.enablePersonalMemorySync !== false,
  };
}

export function buildSharedContextRuntimeConfigSnapshot(
  persisted: Partial<ContextModelConfig> | null | undefined,
  effective?: Partial<ContextModelConfig> | null,
): SharedContextRuntimeConfigSnapshot {
  return {
    persisted: normalizeSharedContextRuntimeConfig(persisted),
    effective: normalizeSharedContextRuntimeConfig(effective ?? persisted),
    envPrimaryOverrideActive: false,
    envBackupOverrideActive: false,
    defaultPrimaryContextBackend: DEFAULT_PRIMARY_CONTEXT_BACKEND,
    defaultPrimaryContextModel: DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
  };
}
