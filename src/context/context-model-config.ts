import type { ContextModelConfig } from '../../shared/context-types.js';
import { DEFAULT_PRIMARY_CONTEXT_MODEL } from '../../shared/context-model-defaults.js';

export function getContextModelConfig(overrides?: Partial<ContextModelConfig>): ContextModelConfig {
  const primaryContextModel = overrides?.primaryContextModel
    ?? process.env.IMCODES_PRIMARY_CONTEXT_MODEL
    ?? DEFAULT_PRIMARY_CONTEXT_MODEL;
  const backupContextModel = overrides?.backupContextModel
    ?? process.env.IMCODES_BACKUP_CONTEXT_MODEL
    ?? undefined;
  return {
    primaryContextModel,
    backupContextModel,
  };
}
