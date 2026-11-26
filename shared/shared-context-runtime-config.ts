import type {
  ContextModelConfig,
  SharedContextModelSelectionMode,
  SharedContextRuntimeBackend,
} from './context-types.js';
import {
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  looksLikeCodexModelId,
  normalizeClaudeCodeModelId,
} from '../src/shared/models/options.js';
import { AGY_FALLBACK_MODEL_IDS, isAgyModelId } from './agy-agent.js';
import {
  DEFAULT_MEMORY_SCORING_WEIGHTS,
  MEMORY_SCORING_WEIGHT_STEP,
  normalizeMemoryScoringWeights,
  RECALL_MIN_FLOOR,
} from './memory-scoring.js';
export { DEFAULT_MEMORY_SCORING_WEIGHTS, normalizeMemoryScoringWeights } from './memory-scoring.js';

export const SHARED_CONTEXT_RUNTIME_BACKENDS = [
  'claude-code-sdk',
  'codex-sdk',
  'agy-sdk',
  'opencode-sdk',
  'openclaw',
] as const satisfies readonly SharedContextRuntimeBackend[];
export const LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS = [
  'claude-code-sdk',
  'codex-sdk',
  'qwen',
  'openclaw',
] as const;
export const SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL = {
  AUTH_BACKENDS_FIELD: 'sharedContextRuntimeBackends',
  HTTP_BACKENDS_HEADER: 'X-Imcodes-Shared-Context-Backends',
} as const;
export const DEFAULT_PRIMARY_CONTEXT_BACKEND: SharedContextRuntimeBackend = 'codex-sdk';
export const DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL = 'gpt-6-luna';
export const DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND: SharedContextRuntimeBackend = 'codex-sdk';
export const DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL = 'gpt-6-luna';
export const DEFAULT_AGY_CONTEXT_MODEL = 'gemini-3.8-flash-low';
export const DEFAULT_OPENCODE_CONTEXT_MODEL = 'opencode/big-pickle';
export const DEFAULT_OPENCLAW_CONTEXT_MODEL = 'default';
export const OPENCODE_FALLBACK_MODEL_IDS = [DEFAULT_OPENCODE_CONTEXT_MODEL] as const;
export const DEFAULT_CONTEXT_MODEL_BY_BACKEND: Record<SharedContextRuntimeBackend, string> = {
  'claude-code-sdk': 'haiku',
  'codex-sdk': DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL,
  'agy-sdk': DEFAULT_AGY_CONTEXT_MODEL,
  'opencode-sdk': DEFAULT_OPENCODE_CONTEXT_MODEL,
  openclaw: DEFAULT_OPENCLAW_CONTEXT_MODEL,
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
    modelSelectionMode: 'auto',
    primaryContextBackend: DEFAULT_PRIMARY_CONTEXT_BACKEND,
    primaryContextModel: DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
    primaryContextPreset: undefined,
    backupContextBackend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
    backupContextModel: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
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

export function parseOpenCodeModelIdentity(
  value: string | null | undefined,
): { providerID: string; modelID: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const providerID = trimmed.slice(0, slash);
  const modelID = trimmed.slice(slash + 1);
  if (!providerID || !modelID || modelID.startsWith('/')) return undefined;
  return { providerID, modelID };
}

export function inferSharedContextRuntimeBackend(model: string | null | undefined): SharedContextRuntimeBackend | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (CLAUDE_CODE_MODEL_IDS.includes(trimmed as typeof CLAUDE_CODE_MODEL_IDS[number])) return 'claude-code-sdk';
  if (CODEX_MODEL_IDS.includes(trimmed as typeof CODEX_MODEL_IDS[number])) return 'codex-sdk';
  if (
    (OPENCODE_FALLBACK_MODEL_IDS as readonly string[]).includes(trimmed)
    || parseOpenCodeModelIdentity(trimmed)
  ) {
    return 'opencode-sdk';
  }
  if (
    (AGY_FALLBACK_MODEL_IDS as readonly string[]).includes(trimmed)
    || isAgyModelId(trimmed)
  ) {
    return 'agy-sdk';
  }
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
  // Compatible third-party presets (OpenAI or Anthropic compatible API)
  // run through Claude Code SDK or Codex SDK.
  return backend === 'claude-code-sdk' || backend === 'codex-sdk';
}

const LEGACY_QWEN_MODEL_IDS = new Set([
  'coder-model',
  'vision-model',
  'qwen3.5-plus',
  'qwen3-coder-plus',
  'qwen3-coder-flash',
  'qwen3-coder-next',
  'qwen3-max-2026-01-23',
]);

/**
 * Whether `model` is an acceptable value for `backend`.
 *
 * The static `*_MODEL_IDS` lists are a fallback suggestion list, not an
 * allowlist: the daemon's live SDK/provider probe routinely returns models
 * released after this file was last updated (`gpt-6-luna`, `claude-opus-4-7`,
 * ...), and a static membership check silently rejected/replaced them. This
 * only rejects a model that is recognizably a DIFFERENT backend's model (by
 * static membership or naming pattern) — cross-backend confusion (a Claude
 * alias configured under `codex-sdk`, say) is still a real mistake worth catching.
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
  // A bare backend id (e.g. "qwen", "agy-sdk", "opencode-sdk") is never a real model id for any backend
  // -- it is a degenerate/placeholder value (an unset field synced verbatim
  // from its own backend name), not a live model the static list doesn't
  // know about yet.
  if (
    (SHARED_CONTEXT_RUNTIME_BACKENDS as readonly string[]).includes(trimmed)
    || trimmed === 'qwen'
    || trimmed === 'agy'
    || trimmed === 'opencode'
  ) {
    return false;
  }
  const openCodeIdentity = parseOpenCodeModelIdentity(trimmed);
  const hasMalformedSlash = trimmed.includes('/') && !openCodeIdentity;
  if (backend === 'opencode-sdk') {
    if (openCodeIdentity) return true;
    if (hasMalformedSlash) return false;
  }
  const isAgyShaped = (AGY_FALLBACK_MODEL_IDS as readonly string[]).includes(trimmed) || isAgyModelId(trimmed);
  const isOpenCodeShaped = (OPENCODE_FALLBACK_MODEL_IDS as readonly string[]).includes(trimmed) || !!openCodeIdentity;
  const isQwenShaped = LEGACY_QWEN_MODEL_IDS.has(trimmed) || trimmed.toLowerCase().startsWith('qwen');
  const isClaudeShaped = !isAgyShaped && (
    CLAUDE_CODE_MODEL_IDS.includes(trimmed as typeof CLAUDE_CODE_MODEL_IDS[number])
    || !!normalizeClaudeCodeModelId(trimmed)
  );
  const isCodexShaped = !isAgyShaped && (
    CODEX_MODEL_IDS.includes(trimmed as typeof CODEX_MODEL_IDS[number])
    || looksLikeCodexModelId(trimmed)
  );
  switch (backend) {
    case 'claude-code-sdk':
      return !hasMalformedSlash && !isCodexShaped && !isAgyShaped && !isOpenCodeShaped && !isQwenShaped;
    case 'codex-sdk':
      return !hasMalformedSlash && !isClaudeShaped && !isAgyShaped && !isOpenCodeShaped && !isQwenShaped;
    case 'agy-sdk':
      return !hasMalformedSlash && !isClaudeShaped && !isCodexShaped && !isOpenCodeShaped && !isQwenShaped;
    case 'opencode-sdk':
      return !isClaudeShaped && !isCodexShaped && !isAgyShaped && !isQwenShaped;
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

const DEPRECATED_CODEX_MODELS = new Set(['gpt-5.3-codex-spark']);

function resolveNormalizedSharedContextModel(
  backend: SharedContextRuntimeBackend,
  rawModel: string | undefined,
  preset: string | undefined,
  forceCodexLunaWithoutPreset = false,
): string {
  if (backend === 'codex-sdk' && !preset) {
    // Shared Context primary/backup strictly pin Codex without a preset to
    // gpt-6-luna; callers shared with supervision preserve explicit non-deprecated models.
    if (forceCodexLunaWithoutPreset) {
      return DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL;
    }
    if (rawModel && DEPRECATED_CODEX_MODELS.has(rawModel.toLowerCase())) {
      return DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL;
    }
  }
  if (!rawModel || !isKnownSharedContextModelForBackend(backend, rawModel, preset)) {
    return getDefaultSharedContextModelForBackend(backend);
  }
  return rawModel;
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
export function normalizeOptionalSharedContextRuntimeSelection(
  input: {
    backend?: string | null;
    model?: string | null;
    preset?: string | null;
  } | null | undefined,
  options?: { forceCodexLunaWithoutPreset?: boolean },
): OptionalSharedContextRuntimeSelection {
  const explicitBackend = input?.backend?.trim();
  const normalizedExplicitBackend = normalizeSharedContextRuntimeBackend(explicitBackend);
  // If an explicit legacy/unsupported backend was specified (e.g. 'qwen'), do not
  // silently re-infer another backend from its stale model/preset fields.
  if (explicitBackend && !normalizedExplicitBackend) return {};
  const backend = normalizedExplicitBackend ?? inferSharedContextRuntimeBackend(input?.model);
  if (!backend) return {};
  const preset = normalizeSharedContextPresetValue(backend, input?.preset ?? undefined);
  const rawModel = trimModelValue(input?.model ?? undefined);
  const model = resolveNormalizedSharedContextModel(
    backend,
    rawModel,
    preset,
    options?.forceCodexLunaWithoutPreset === true,
  );
  return {
    backend,
    model,
    ...(preset ? { preset } : {}),
  };
}

export type SharedContextRuntimeConfigInput = Partial<Omit<ContextModelConfig, 'primaryContextBackend' | 'backupContextBackend'>> & {
  primaryContextBackend?: SharedContextRuntimeBackend | string | null;
  backupContextBackend?: SharedContextRuntimeBackend | string | null;
};

export function hasExplicitSharedContextModelSelection(
  input: SharedContextRuntimeConfigInput | null | undefined,
): boolean {
  return Boolean(
    input?.primaryContextBackend?.trim()
      || input?.primaryContextModel?.trim()
      || input?.primaryContextPreset?.trim()
      || input?.backupContextBackend?.trim()
      || input?.backupContextModel?.trim()
      || input?.backupContextPreset?.trim(),
  );
}

export function resolveIncomingSharedContextModelSelectionMode(
  input: SharedContextRuntimeConfigInput | null | undefined,
): SharedContextModelSelectionMode {
  if (input?.modelSelectionMode === 'auto' || input?.modelSelectionMode === 'manual') {
    return input.modelSelectionMode;
  }
  // Empty / metadata-only payloads default to 'auto'; legacy payloads that
  // already carry backend/model/preset fields without modelSelectionMode stay
  // 'manual' so older servers/clients never have user choices overridden.
  return hasExplicitSharedContextModelSelection(input) ? 'manual' : 'auto';
}

export function normalizeSharedContextRuntimeConfig(
  input: SharedContextRuntimeConfigInput | null | undefined,
): ContextModelConfig {
  const modelSelectionMode = resolveIncomingSharedContextModelSelectionMode(input);
  const forceCodexLunaWithoutPreset = modelSelectionMode !== 'manual';
  const explicitPrimaryBackend = input?.primaryContextBackend?.trim();
  const parsedPrimaryBackend = normalizeSharedContextRuntimeBackend(explicitPrimaryBackend);
  const hasUnsupportedExplicitPrimaryBackend = Boolean(explicitPrimaryBackend && !parsedPrimaryBackend);
  const normalizedPrimaryBackend = parsedPrimaryBackend
    ?? (hasUnsupportedExplicitPrimaryBackend ? undefined : inferSharedContextRuntimeBackend(input?.primaryContextModel))
    ?? DEFAULT_PRIMARY_CONTEXT_BACKEND;
  const primaryContextPreset = hasUnsupportedExplicitPrimaryBackend
    ? undefined
    : normalizeSharedContextPresetValue(normalizedPrimaryBackend, input?.primaryContextPreset);
  const rawPrimaryContextModel = hasUnsupportedExplicitPrimaryBackend
    ? undefined
    : trimModelValue(input?.primaryContextModel);
  const primaryContextModel = resolveNormalizedSharedContextModel(
    normalizedPrimaryBackend,
    rawPrimaryContextModel,
    primaryContextPreset,
    forceCodexLunaWithoutPreset,
  );
  const hasBackupSelection = Boolean(
    input?.backupContextBackend?.trim()
      || input?.backupContextModel?.trim()
      || input?.backupContextPreset?.trim(),
  );
  const parsedBackup = hasBackupSelection
    ? normalizeOptionalSharedContextRuntimeSelection({
      backend: input?.backupContextBackend,
      model: input?.backupContextModel,
      preset: input?.backupContextPreset,
    }, { forceCodexLunaWithoutPreset })
    : undefined;
  const backup: OptionalSharedContextRuntimeSelection = parsedBackup?.backend && parsedBackup?.model
    ? parsedBackup
    : {
      backend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
      model: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
    };
  const rawMinInterval = input?.materializationMinIntervalMs;
  const materializationMinIntervalMs = typeof rawMinInterval === 'number' && rawMinInterval > 0 ? rawMinInterval : undefined;
  const memoryRecallMinScore = normalizeMemoryRecallMinScore(input?.memoryRecallMinScore);
  const memoryScoringWeights = normalizeMemoryScoringWeights(input?.memoryScoringWeights);
  return {
    modelSelectionMode,
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

export function parseSupportedSharedContextRuntimeBackendsHeader(
  rawHeader: string | null | undefined,
): readonly string[] | null {
  const trimmed = rawHeader?.trim();
  if (!trimmed) return null;
  const items = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

export function adaptSharedContextRuntimeConfigForSupportedBackends(
  config: ContextModelConfig,
  supportedBackends: readonly string[] | null | undefined,
): ContextModelConfig {
  const supported = new Set(
    supportedBackends && supportedBackends.length > 0
      ? supportedBackends
      : LEGACY_SHARED_CONTEXT_RUNTIME_BACKENDS,
  );
  const primarySupported = supported.has(config.primaryContextBackend);
  const backupSupported = !config.backupContextBackend || supported.has(config.backupContextBackend);
  if (primarySupported && backupSupported) return config;
  return {
    ...config,
    ...(primarySupported
      ? {}
      : {
          primaryContextBackend: DEFAULT_PRIMARY_CONTEXT_BACKEND,
          primaryContextModel: DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
          primaryContextPreset: undefined,
        }),
    ...(backupSupported
      ? {}
      : {
          backupContextBackend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
          backupContextModel: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
          backupContextPreset: undefined,
        }),
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

export interface SharedContextUsageContext {
  sessionAgentType?: string | null;
  activeSessionAgentTypes?: ReadonlyArray<string | null | undefined>;
}

export function mapAgentTypeToSharedContextRuntimeSelection(
  agentType: string | null | undefined,
): { backend: SharedContextRuntimeBackend; model: string } | undefined {
  const normalized = agentType?.trim().toLowerCase();
  if (!normalized) return undefined;
  switch (normalized) {
    case 'codex':
    case 'codex-sdk':
      return {
        backend: 'codex-sdk',
        model: DEFAULT_MEMORY_PRIMARY_CONTEXT_MODEL,
      };
    case 'claude-code':
    case 'claude-code-sdk':
      return {
        backend: 'claude-code-sdk',
        model: DEFAULT_CONTEXT_MODEL_BY_BACKEND['claude-code-sdk'],
      };
    case 'agy':
    case 'agy-sdk':
      return {
        backend: 'agy-sdk',
        model: DEFAULT_CONTEXT_MODEL_BY_BACKEND['agy-sdk'],
      };
    case 'opencode':
    case 'opencode-sdk':
      return {
        backend: 'opencode-sdk',
        model: DEFAULT_CONTEXT_MODEL_BY_BACKEND['opencode-sdk'],
      };
    case 'openclaw':
      return {
        backend: 'openclaw',
        model: DEFAULT_CONTEXT_MODEL_BY_BACKEND['openclaw'],
      };
    default:
      return undefined;
  }
}

export function resolveEffectiveSharedContextRuntimeConfig(
  config: ContextModelConfig,
  usage?: SharedContextUsageContext,
): ContextModelConfig {
  if (config.modelSelectionMode === 'manual') {
    return config;
  }
  const seenBackends = new Set<SharedContextRuntimeBackend>();
  const candidates: Array<{ backend: SharedContextRuntimeBackend; model: string }> = [];
  for (const rawAgentType of [usage?.sessionAgentType, ...(usage?.activeSessionAgentTypes ?? [])]) {
    const mapped = mapAgentTypeToSharedContextRuntimeSelection(rawAgentType);
    if (!mapped || seenBackends.has(mapped.backend)) continue;
    seenBackends.add(mapped.backend);
    candidates.push(mapped);
  }
  const primary = candidates[0] ?? {
    backend: DEFAULT_PRIMARY_CONTEXT_BACKEND,
    model: DEFAULT_PRIMARY_CONTEXT_RUNTIME_MODEL,
  };
  const distinctBackup = candidates.find((candidate) => candidate.backend !== primary.backend);
  const backup = distinctBackup
    ?? (primary.backend !== DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND
      ? {
          backend: DEFAULT_MEMORY_BACKUP_CONTEXT_BACKEND,
          model: DEFAULT_MEMORY_BACKUP_CONTEXT_MODEL,
        }
      : undefined);
  return {
    ...config,
    modelSelectionMode: 'auto',
    primaryContextBackend: primary.backend,
    primaryContextModel: primary.model,
    primaryContextPreset: undefined,
    backupContextBackend: backup?.backend,
    backupContextModel: backup?.model,
    backupContextPreset: undefined,
  };
}
