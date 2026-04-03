export const QWEN_AUTH_TYPES = {
  OAUTH: 'qwen-oauth',
  CODING_PLAN: 'coding-plan',
  API_KEY: 'api-key',
  UNKNOWN: 'unknown',
} as const;

export type QwenAuthType = typeof QWEN_AUTH_TYPES[keyof typeof QWEN_AUTH_TYPES];

export const QWEN_AUTH_TIERS = {
  FREE: 'free',
  PAID: 'paid',
  BYO: 'byo',
  UNKNOWN: 'unknown',
} as const;

export type QwenAuthTier = typeof QWEN_AUTH_TIERS[keyof typeof QWEN_AUTH_TIERS];

export function getQwenAuthTier(authType?: string | null): QwenAuthTier {
  switch (authType) {
    case QWEN_AUTH_TYPES.OAUTH:
      return QWEN_AUTH_TIERS.FREE;
    case QWEN_AUTH_TYPES.CODING_PLAN:
      return QWEN_AUTH_TIERS.PAID;
    case QWEN_AUTH_TYPES.API_KEY:
      return QWEN_AUTH_TIERS.BYO;
    default:
      return QWEN_AUTH_TIERS.UNKNOWN;
  }
}
