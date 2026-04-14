import type { ContextModelConfig } from './context-types.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from './context-model-defaults.js';

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
  defaultPrimaryContextModel: string;
}

export function defaultSharedContextRuntimeConfig(): ContextModelConfig {
  return {
    primaryContextModel: DEFAULT_PRIMARY_CONTEXT_MODEL,
    backupContextModel: undefined,
  };
}

function trimModelValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSharedContextRuntimeConfig(
  input: Partial<ContextModelConfig> | null | undefined,
): ContextModelConfig {
  return {
    primaryContextModel: trimModelValue(input?.primaryContextModel) ?? DEFAULT_PRIMARY_CONTEXT_MODEL,
    backupContextModel: trimModelValue(input?.backupContextModel),
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
    defaultPrimaryContextModel: DEFAULT_PRIMARY_CONTEXT_MODEL,
  };
}
