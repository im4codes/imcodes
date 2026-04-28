import type { ContextModelConfig, SharedContextRuntimeBackend } from './context-types.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from './context-model-defaults.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';
import {
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  MEMORY_SCORING_WEIGHT_STEP,
  normalizeMemoryScoringWeights,
  RECALL_MIN_FLOOR,
} from './memory-scoring.js';
export { DEFAULT_MEMORY_SCORING_WEIGHTS, normalizeMemoryScoringWeights } from './memory-scoring.js';

export const SHARED_CONTEXT_RUNTIME_BACKENDS = ['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw'] as const satisfies readonly SharedContextRuntimeBackend[];
export const DEFAULT_PRIMARY_CONTEXT_BACKEND: SharedContextRuntimeBackend = 'claude-code-sdk';
export const DEFAULT_CONTEXT_MODEL_BY_BACKEND: Record<SharedContextRuntimeBackend, string> = {
  'claude-code-sdk': DEFAULT_PRIMARY_CONTEXT_MODEL,
  'codex-sdk': CODEX_MODEL_IDS[0],
  qwen: 'qwen3-coder-plus',
  openclaw: DEFAULT_PRIMARY_CONTEXT_MODEL,
};

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
    primaryContextModel: DEFAULT_CONTEXT_MODEL_BY_BACKEND[DEFAULT_PRIMARY_CONTEXT_BACKEND],
    primaryContextPreset: undefined,
    backupContextBackend: undefined,
    backupContextModel: undefined,
    backupContextPreset: undefined,
    memoryRecallMinScore: DEFAULT_MEMORY_RECALL_MIN_SCORE,
    memoryScoringWeights: { ...DEFAULT_MEMORY_SCORING_WEIGHTS },
    enablePersonalMemorySync: false,
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
  return undefined;
}

export function getDefaultSharedContextModelForBackend(backend: SharedContextRuntimeBackend): string {
  return DEFAULT_CONTEXT_MODEL_BY_BACKEND[backend];
}

export function doesSharedContextBackendSupportPresets(backend: SharedContextRuntimeBackend | null | undefined): boolean {
  return backend === 'qwen';
}

export function isKnownSharedContextModelForBackend(
  backend: SharedContextRuntimeBackend,
  model: string | null | undefined,
  preset?: string | null | undefined,
): boolean {
  const trimmed = model?.trim();
  if (!trimmed) return false;
  switch (backend) {
    case 'claude-code-sdk':
      return CLAUDE_CODE_MODEL_IDS.includes(trimmed as typeof CLAUDE_CODE_MODEL_IDS[number]);
    case 'codex-sdk':
      return CODEX_MODEL_IDS.includes(trimmed as typeof CODEX_MODEL_IDS[number]);
    case 'qwen':
      return preset?.trim()
        ? true
        : QWEN_MODEL_IDS.includes(trimmed as typeof QWEN_MODEL_IDS[number]);
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
  const normalizedBackupBackendCandidate = normalizeSharedContextRuntimeBackend(input?.backupContextBackend)
    ?? inferSharedContextRuntimeBackend(input?.backupContextModel);
  const rawBackupContextModel = trimModelValue(input?.backupContextModel);
  const backupContextBackend = normalizedBackupBackendCandidate;
  const backupContextPreset = normalizeSharedContextPresetValue(backupContextBackend, input?.backupContextPreset);
  const backupContextModel = backupContextBackend
    ? (rawBackupContextModel
      ? (isKnownSharedContextModelForBackend(backupContextBackend, rawBackupContextModel, backupContextPreset)
        ? rawBackupContextModel
        : getDefaultSharedContextModelForBackend(backupContextBackend))
      : getDefaultSharedContextModelForBackend(backupContextBackend))
    : undefined;
  const rawMinInterval = input?.materializationMinIntervalMs;
  const materializationMinIntervalMs = typeof rawMinInterval === 'number' && rawMinInterval > 0 ? rawMinInterval : undefined;
  const memoryRecallMinScore = normalizeMemoryRecallMinScore(input?.memoryRecallMinScore);
  const memoryScoringWeights = normalizeMemoryScoringWeights(input?.memoryScoringWeights);
  return {
    primaryContextBackend: normalizedPrimaryBackend,
    primaryContextModel,
    primaryContextPreset,
    primaryContextSdk: trimModelValue(input?.primaryContextSdk),
    backupContextBackend,
    backupContextModel,
    backupContextPreset,
    backupContextSdk: trimModelValue(input?.backupContextSdk),
    materializationMinIntervalMs,
    memoryRecallMinScore,
    memoryScoringWeights,
    enablePersonalMemorySync: input?.enablePersonalMemorySync === true,
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
    defaultPrimaryContextModel: DEFAULT_CONTEXT_MODEL_BY_BACKEND[DEFAULT_PRIMARY_CONTEXT_BACKEND],
  };
}
