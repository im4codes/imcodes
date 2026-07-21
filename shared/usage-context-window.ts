export const USAGE_CONTEXT_WINDOW_SOURCES = {
  PROVIDER: 'provider',
  PRESET: 'preset',
} as const;

export type UsageContextWindowSource =
  (typeof USAGE_CONTEXT_WINDOW_SOURCES)[keyof typeof USAGE_CONTEXT_WINDOW_SOURCES];

export function isUsageContextWindowSource(value: unknown): value is UsageContextWindowSource {
  return Object.values(USAGE_CONTEXT_WINDOW_SOURCES).includes(value as UsageContextWindowSource);
}

/**
 * Provider-reported and user-configured preset windows are both authoritative.
 * Model-name inference is only a fallback and must not replace either value.
 */
export function isAuthoritativeUsageContextWindowSource(value: unknown): value is UsageContextWindowSource {
  return value === USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER
    || value === USAGE_CONTEXT_WINDOW_SOURCES.PRESET;
}

/** Provider metadata outranks a configured preset, and both outrank a
 * model-name inference that has no explicit source. */
export function usageContextWindowSourceRank(value: unknown): number {
  if (value === USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER) return 2;
  if (value === USAGE_CONTEXT_WINDOW_SOURCES.PRESET) return 1;
  return 0;
}
