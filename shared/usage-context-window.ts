export const USAGE_CONTEXT_WINDOW_SOURCES = {
  PROVIDER: 'provider',
} as const;

export type UsageContextWindowSource =
  (typeof USAGE_CONTEXT_WINDOW_SOURCES)[keyof typeof USAGE_CONTEXT_WINDOW_SOURCES];

export function isUsageContextWindowSource(value: unknown): value is UsageContextWindowSource {
  return Object.values(USAGE_CONTEXT_WINDOW_SOURCES).includes(value as UsageContextWindowSource);
}
