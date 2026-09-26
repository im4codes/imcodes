export const CODEBUDDY_PROVIDER_IDS = {
  CHINA: 'codebuddy-cn',
  INTERNATIONAL: 'codebuddy-international',
} as const;

export type CodeBuddyProviderId =
  typeof CODEBUDDY_PROVIDER_IDS[keyof typeof CODEBUDDY_PROVIDER_IDS];

export const CODEBUDDY_REGIONS = {
  CHINA: 'internal',
  INTERNATIONAL: 'external',
} as const;

export type CodeBuddyRegion = typeof CODEBUDDY_REGIONS[keyof typeof CODEBUDDY_REGIONS];

export const CODEBUDDY_ENVIRONMENT_VARIABLE = 'CODEBUDDY_INTERNET_ENVIRONMENT';
export const CODEBUDDY_CLI_PATH_ENVIRONMENT_VARIABLE = 'CODEBUDDY_CLI_PATH';
export const CODEBUDDY_CHINA_DEFAULT_MODEL = 'hy3';

/**
 * Offline picker fallback only. The live ACP model catalog remains authoritative.
 * Hy3 is intentionally first because the China service currently advertises it
 * as limited-time free; callers must not describe that offer as permanent.
 */
export const CODEBUDDY_CHINA_MODEL_FALLBACK = [
  CODEBUDDY_CHINA_DEFAULT_MODEL,
  'hy3-x',
  'auto',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'minimax-m3',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const;

export const CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK = ['auto'] as const;

export function isCodeBuddyProviderId(value: string | undefined): value is CodeBuddyProviderId {
  return value === CODEBUDDY_PROVIDER_IDS.CHINA
    || value === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL;
}

export function codeBuddyRegionForProvider(providerId: CodeBuddyProviderId): CodeBuddyRegion {
  return providerId === CODEBUDDY_PROVIDER_IDS.CHINA
    ? CODEBUDDY_REGIONS.CHINA
    : CODEBUDDY_REGIONS.INTERNATIONAL;
}
