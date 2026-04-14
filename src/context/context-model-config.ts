import type { ContextModelConfig } from '../../shared/context-types.js';
import {
  buildSharedContextRuntimeConfigSnapshot,
  defaultSharedContextRuntimeConfig,
  normalizeSharedContextRuntimeConfig,
  type SharedContextRuntimeConfigSnapshot,
} from '../../shared/shared-context-runtime-config.js';

let runtimeConfigOverride: Partial<ContextModelConfig> | null = null;

export function setContextModelRuntimeConfig(overrides: Partial<ContextModelConfig> | null): void {
  runtimeConfigOverride = overrides ? normalizeSharedContextRuntimeConfig(overrides) : null;
}

export function getContextModelConfig(overrides?: Partial<ContextModelConfig>): ContextModelConfig {
  if (overrides) return normalizeSharedContextRuntimeConfig(overrides);
  return runtimeConfigOverride ? normalizeSharedContextRuntimeConfig(runtimeConfigOverride) : defaultSharedContextRuntimeConfig();
}

export function getContextModelConfigSnapshot(persisted: Partial<ContextModelConfig> | null): SharedContextRuntimeConfigSnapshot {
  return buildSharedContextRuntimeConfigSnapshot(persisted, getContextModelConfig());
}
