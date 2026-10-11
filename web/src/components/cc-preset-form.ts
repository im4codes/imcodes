import {
  DEFAULT_CC_PRESET_CONTEXT_WINDOW as DEFAULT_CC_PRESET_CONTEXT_WINDOW_VALUE,
  getCcPresetEffectiveModel,
  normalizeCcPresetContextWindow,
} from '@shared/cc-presets.js';
import type { CcPreset, CcPresetAuthType, CcPresetModelInfo } from '@shared/cc-presets.js';

export type CcPresetEntry = CcPreset;

export interface CcPresetDraft {
  name: string;
  authType: CcPresetAuthType;
  baseUrl: string;
  token: string;
  model: string;
  contextWindow: string;
  customEnv: Array<{ key: string; value: string }>;
  initMessage: string;
  availableModels: CcPresetModelInfo[];
}

export const DEFAULT_CC_PRESET_BASE_URL = 'https://api.minimax.io/anthropic';
export const DEFAULT_CC_PRESET_MODEL = 'MiniMax-M2.7';
export const DEFAULT_OPENAI_PRESET_BASE_URL = 'https://api.minimax.chat/v1';
export const DEFAULT_OPENAI_PRESET_MODEL = 'MiniMax-Text-01';
export const DEFAULT_CC_PRESET_CONTEXT_WINDOW = String(DEFAULT_CC_PRESET_CONTEXT_WINDOW_VALUE);
export const DEFAULT_CC_PRESET_INIT_MSG =
  'For web searches, use: curl -s "https://html.duckduckgo.com/html/?q=QUERY" | head -200. Replace QUERY with URL-encoded search terms.';

const DEFAULT_CC_PRESET_CUSTOM_ENV_TEMPLATE = Object.freeze([
  { key: 'API_TIMEOUT_MS', value: '3000000' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
]);

const INLINE_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
]);

function cloneCustomEnv(items: ReadonlyArray<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return items.map((item) => ({ key: item.key, value: item.value }));
}

export function createDefaultCcPresetDraft(authType: CcPresetAuthType = 'anthropic'): CcPresetDraft {
  const isOpenAi = authType === 'openai';
  return {
    name: '',
    authType,
    baseUrl: isOpenAi ? DEFAULT_OPENAI_PRESET_BASE_URL : DEFAULT_CC_PRESET_BASE_URL,
    token: '',
    model: isOpenAi ? DEFAULT_OPENAI_PRESET_MODEL : DEFAULT_CC_PRESET_MODEL,
    contextWindow: DEFAULT_CC_PRESET_CONTEXT_WINDOW,
    customEnv: cloneCustomEnv(DEFAULT_CC_PRESET_CUSTOM_ENV_TEMPLATE),
    initMessage: DEFAULT_CC_PRESET_INIT_MSG,
    availableModels: [],
  };
}

export function createCcPresetDraftFromPreset(preset: CcPresetEntry): CcPresetDraft {
  const authType: CcPresetAuthType = preset.authType
    ?? (preset.env.OPENAI_BASE_URL && !preset.env.ANTHROPIC_BASE_URL ? 'openai' : 'anthropic');
  const isOpenAi = authType === 'openai';
  const defaultModel = isOpenAi ? DEFAULT_OPENAI_PRESET_MODEL : DEFAULT_CC_PRESET_MODEL;
  const effectiveModel = getCcPresetEffectiveModel(preset) ?? defaultModel;
  const effectiveContextWindow = normalizeCcPresetContextWindow(preset.contextWindow, effectiveModel);
  const defaultBaseUrl = isOpenAi ? DEFAULT_OPENAI_PRESET_BASE_URL : DEFAULT_CC_PRESET_BASE_URL;
  const baseUrl = isOpenAi
    ? (preset.env.OPENAI_BASE_URL ?? preset.env.ANTHROPIC_BASE_URL ?? defaultBaseUrl)
    : (preset.env.ANTHROPIC_BASE_URL ?? preset.env.OPENAI_BASE_URL ?? defaultBaseUrl);
  const token = isOpenAi
    ? (preset.env.OPENAI_API_KEY ?? preset.env.ANTHROPIC_API_KEY ?? preset.env.ANTHROPIC_AUTH_TOKEN ?? '')
    : (preset.env.ANTHROPIC_API_KEY ?? preset.env.ANTHROPIC_AUTH_TOKEN ?? preset.env.OPENAI_API_KEY ?? '');

  return {
    name: preset.name,
    authType,
    baseUrl,
    token,
    model: effectiveModel,
    contextWindow: effectiveContextWindow ? String(effectiveContextWindow) : DEFAULT_CC_PRESET_CONTEXT_WINDOW,
    customEnv: Object.entries(preset.env)
      .filter(([key]) => !INLINE_ENV_KEYS.has(key))
      .map(([key, value]) => ({ key, value })),
    initMessage: preset.initMessage ?? DEFAULT_CC_PRESET_INIT_MSG,
    availableModels: preset.availableModels ?? [],
  };
}

export function buildCcPresetFromDraft(draft: CcPresetDraft): CcPresetEntry {
  const model = draft.model.trim();
  const authType = draft.authType ?? 'anthropic';
  const env: Record<string, string> = {
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
  if (authType === 'openai') {
    env.OPENAI_BASE_URL = draft.baseUrl.trim();
    if (draft.token.trim()) env.OPENAI_API_KEY = draft.token.trim();
    if (model) env.OPENAI_MODEL = model;
  } else {
    env.ANTHROPIC_BASE_URL = draft.baseUrl.trim();
    if (draft.token.trim()) env.ANTHROPIC_API_KEY = draft.token.trim();
    if (model) env.ANTHROPIC_MODEL = model;
  }
  for (const { key, value } of draft.customEnv) {
    if (key.trim()) env[key.trim()] = value;
  }

  const preset: CcPresetEntry = {
    name: draft.name.trim(),
    env,
    transportMode: 'qwen-compatible-api',
    authType,
  };
  const contextWindow = parseInt(draft.contextWindow, 10);
  if (contextWindow) preset.contextWindow = contextWindow;
  if (draft.initMessage.trim()) preset.initMessage = draft.initMessage.trim();
  if (draft.availableModels.length > 0) preset.availableModels = draft.availableModels;
  if (model) preset.defaultModel = model;
  return preset;
}
