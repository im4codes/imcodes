export const CC_PRESET_MSG = {
  LIST: 'cc.presets.list',
  LIST_RESPONSE: 'cc.presets.list_response',
  SAVE: 'cc.presets.save',
  SAVE_RESPONSE: 'cc.presets.save_response',
  DISCOVER_MODELS: 'cc.presets.discover_models',
  DISCOVER_MODELS_RESPONSE: 'cc.presets.discover_models_response',
} as const;

export interface CcPresetSaveResponse {
  type: typeof CC_PRESET_MSG.SAVE_RESPONSE;
  requestId?: string;
  ok: boolean;
  error?: string;
}

export type CcPresetTransportMode =
  | 'qwen-compatible-api'
  | 'claude-cli-preset';

export type CcPresetAuthType = 'anthropic';

export interface CcPresetModelInfo {
  id: string;
  name?: string;
}

export interface CcPreset {
  name: string;
  env: Record<string, string>;
  contextWindow?: number;
  initMessage?: string;
  transportMode?: CcPresetTransportMode;
  authType?: CcPresetAuthType;
  availableModels?: CcPresetModelInfo[];
  defaultModel?: string;
  lastDiscoveredAt?: number;
  modelDiscoveryError?: string;
}

export function normalizeCcPresetName(name: string): string {
  return name.trim().toLowerCase();
}

function addUniqueModel(target: string[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed && !target.includes(trimmed)) target.push(trimmed);
}

/**
 * Runtime-authoritative model for a preset.
 *
 * CC presets are env bundles first; `defaultModel` is UI/discovery metadata.
 * Prefer the launch env model so stale discovery data cannot override what the
 * preset actually pins for provider startup.
 */
export function getCcPresetEffectiveModel(preset: Pick<CcPreset, 'defaultModel' | 'env'>): string | undefined {
  const model = preset.env['ANTHROPIC_MODEL']?.trim()
    || preset.defaultModel?.trim()
    || preset.env['OPENAI_MODEL']?.trim()
    || '';
  return model || undefined;
}

export function getCcPresetAvailableModelIds(
  preset: Pick<CcPreset, 'availableModels' | 'defaultModel' | 'env'>,
): string[] {
  const models: string[] = [];
  addUniqueModel(models, preset.env['ANTHROPIC_MODEL']);
  addUniqueModel(models, preset.defaultModel);
  addUniqueModel(models, preset.env['OPENAI_MODEL']);
  for (const model of preset.availableModels ?? []) addUniqueModel(models, model.id);
  return models;
}
