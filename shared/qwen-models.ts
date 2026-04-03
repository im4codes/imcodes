import { QWEN_AUTH_TYPES, type QwenAuthType } from './qwen-auth.js';

export interface QwenModelOption {
  id: string;
  description: string;
}

export const QWEN_OAUTH_MODEL_OPTIONS: QwenModelOption[] = [
  { id: 'coder-model', description: 'Qwen latest model via OAuth free tier' },
] as const;

export const QWEN_CODING_PLAN_MODEL_OPTIONS: QwenModelOption[] = [
  { id: 'qwen3.5-plus', description: 'Thinking-enabled Coding Plan model' },
  { id: 'qwen3-coder-plus', description: 'Optimized for coding tasks' },
  { id: 'qwen3-coder-next', description: 'Next-generation coding model' },
  { id: 'qwen3-max-2026-01-23', description: 'High-capability max model' },
  { id: 'glm-4.7', description: 'GLM model available in Coding Plan' },
  { id: 'glm-5', description: 'Latest GLM model available in Coding Plan' },
  { id: 'MiniMax-M2.5', description: 'MiniMax model available in Coding Plan' },
  { id: 'kimi-k2.5', description: 'Kimi model available in Coding Plan' },
] as const;

export const QWEN_OAUTH_MODEL_IDS = QWEN_OAUTH_MODEL_OPTIONS.map((model) => model.id);
export const QWEN_CODING_PLAN_MODEL_IDS = QWEN_CODING_PLAN_MODEL_OPTIONS.map((model) => model.id);
export const QWEN_MODEL_OPTIONS = [...QWEN_OAUTH_MODEL_OPTIONS, ...QWEN_CODING_PLAN_MODEL_OPTIONS] as const;
export const QWEN_MODEL_IDS = QWEN_MODEL_OPTIONS.map((model) => model.id);

const DESCRIPTION_BY_ID = new Map(QWEN_MODEL_OPTIONS.map((model) => [model.id, model.description]));

export function getKnownQwenModelOptions(authType?: QwenAuthType | string | null): QwenModelOption[] {
  switch (authType) {
    case QWEN_AUTH_TYPES.OAUTH:
      return [...QWEN_OAUTH_MODEL_OPTIONS];
    case QWEN_AUTH_TYPES.CODING_PLAN:
      return [...QWEN_CODING_PLAN_MODEL_OPTIONS];
    default:
      return [...QWEN_MODEL_OPTIONS];
  }
}

export function getKnownQwenModelDescription(id: string): string {
  return DESCRIPTION_BY_ID.get(id) ?? '';
}
