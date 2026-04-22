export const CC_PRESET_MSG = {
  LIST: 'cc.presets.list',
  LIST_RESPONSE: 'cc.presets.list_response',
  SAVE: 'cc.presets.save',
  SAVE_RESPONSE: 'cc.presets.save_response',
  DISCOVER_MODELS: 'cc.presets.discover_models',
  DISCOVER_MODELS_RESPONSE: 'cc.presets.discover_models_response',
} as const;

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
