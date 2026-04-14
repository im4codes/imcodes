import type { ContextModelConfig, SharedContextRuntimeBackend } from './context-types.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from './context-model-defaults.js';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../src/shared/models/options.js';
import { QWEN_MODEL_IDS } from './qwen-models.js';

export const SHARED_CONTEXT_RUNTIME_BACKENDS = ['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw'] as const satisfies readonly SharedContextRuntimeBackend[];
export const DEFAULT_PRIMARY_CONTEXT_BACKEND: SharedContextRuntimeBackend = 'claude-code-sdk';

export const SHARED_CONTEXT_RUNTIME_CONFIG_MSG = {
  APPLY: 'shared_context.runtime_config.apply',
} as const;

export const SHARED_CONTEXT_RUNTIME_CONFIG_ERROR = {
  INVALID_CONFIG: 'invalid_shared_context_runtime_config',
} as const;

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
    primaryContextModel: DEFAULT_PRIMARY_CONTEXT_MODEL,
    backupContextBackend: undefined,
    backupContextModel: undefined,
  };
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

function trimModelValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSharedContextRuntimeConfig(
  input: Partial<ContextModelConfig> | null | undefined,
): ContextModelConfig {
  const primaryContextModel = trimModelValue(input?.primaryContextModel) ?? DEFAULT_PRIMARY_CONTEXT_MODEL;
  const backupContextModel = trimModelValue(input?.backupContextModel);
  return {
    primaryContextBackend: normalizeSharedContextRuntimeBackend(input?.primaryContextBackend)
      ?? inferSharedContextRuntimeBackend(primaryContextModel)
      ?? DEFAULT_PRIMARY_CONTEXT_BACKEND,
    primaryContextModel,
    backupContextBackend: backupContextModel
      ? (normalizeSharedContextRuntimeBackend(input?.backupContextBackend)
        ?? inferSharedContextRuntimeBackend(backupContextModel)
        ?? normalizeSharedContextRuntimeBackend(input?.primaryContextBackend)
        ?? inferSharedContextRuntimeBackend(primaryContextModel)
        ?? DEFAULT_PRIMARY_CONTEXT_BACKEND)
      : undefined,
    backupContextModel,
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
    defaultPrimaryContextModel: DEFAULT_PRIMARY_CONTEXT_MODEL,
  };
}
