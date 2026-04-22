export interface CcPresetEntry {
  name: string;
  env: Record<string, string>;
  contextWindow?: number;
  initMessage?: string;
}

export interface CcPresetDraft {
  name: string;
  baseUrl: string;
  token: string;
  model: string;
  contextWindow: string;
  customEnv: Array<{ key: string; value: string }>;
  initMessage: string;
}

export const DEFAULT_CC_PRESET_BASE_URL = 'https://api.minimax.io/anthropic';
export const DEFAULT_CC_PRESET_MODEL = 'MiniMax-M2.7';
export const DEFAULT_CC_PRESET_CONTEXT_WINDOW = '1000000';
export const DEFAULT_CC_PRESET_INIT_MSG =
  'For web searches, use: curl -s "https://html.duckduckgo.com/html/?q=QUERY" | head -200. Replace QUERY with URL-encoded search terms.';

const DEFAULT_CC_PRESET_CUSTOM_ENV_TEMPLATE = Object.freeze([
  { key: 'API_TIMEOUT_MS', value: '3000000' },
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
]);

const INLINE_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
]);

function cloneCustomEnv(items: ReadonlyArray<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return items.map((item) => ({ key: item.key, value: item.value }));
}

export function createDefaultCcPresetDraft(): CcPresetDraft {
  return {
    name: '',
    baseUrl: DEFAULT_CC_PRESET_BASE_URL,
    token: '',
    model: DEFAULT_CC_PRESET_MODEL,
    contextWindow: DEFAULT_CC_PRESET_CONTEXT_WINDOW,
    customEnv: cloneCustomEnv(DEFAULT_CC_PRESET_CUSTOM_ENV_TEMPLATE),
    initMessage: DEFAULT_CC_PRESET_INIT_MSG,
  };
}

export function createCcPresetDraftFromPreset(preset: CcPresetEntry): CcPresetDraft {
  return {
    name: preset.name,
    baseUrl: preset.env.ANTHROPIC_BASE_URL ?? DEFAULT_CC_PRESET_BASE_URL,
    token: preset.env.ANTHROPIC_AUTH_TOKEN ?? '',
    model: preset.env.ANTHROPIC_MODEL ?? DEFAULT_CC_PRESET_MODEL,
    contextWindow: preset.contextWindow ? String(preset.contextWindow) : DEFAULT_CC_PRESET_CONTEXT_WINDOW,
    customEnv: Object.entries(preset.env)
      .filter(([key]) => !INLINE_ENV_KEYS.has(key))
      .map(([key, value]) => ({ key, value })),
    initMessage: preset.initMessage ?? DEFAULT_CC_PRESET_INIT_MSG,
  };
}

export function buildCcPresetFromDraft(draft: CcPresetDraft): CcPresetEntry {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: draft.baseUrl.trim(),
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
  if (draft.token.trim()) env.ANTHROPIC_AUTH_TOKEN = draft.token.trim();
  if (draft.model.trim()) env.ANTHROPIC_MODEL = draft.model.trim();
  for (const { key, value } of draft.customEnv) {
    if (key.trim()) env[key.trim()] = value;
  }

  const preset: CcPresetEntry = { name: draft.name.trim(), env };
  const contextWindow = parseInt(draft.contextWindow, 10);
  if (contextWindow) preset.contextWindow = contextWindow;
  if (draft.initMessage.trim()) preset.initMessage = draft.initMessage.trim();
  return preset;
}
