export const PROVIDER_STATUS_REASON = {
  PROVIDER_NOT_CONNECTED: 'provider_not_connected',
} as const;

export type ProviderStatusReason =
  (typeof PROVIDER_STATUS_REASON)[keyof typeof PROVIDER_STATUS_REASON];
