/**
 * Canonical provider error codes.
 *
 * These live in `shared/` because supervision has to decide, in shared code,
 * whether a provider failure is something a human must personally clear
 * (re-authorization, settings repair) or something the durable heartbeat should
 * simply retry. `src/agent/transport-provider.ts` re-exports this object, so
 * every existing importer keeps its current import path and there is exactly
 * one definition of each code.
 */
export const PROVIDER_ERROR_CODES = {
  AUTH_FAILED:      'AUTH_FAILED',
  CONFIG_ERROR:     'CONFIG_ERROR',
  CONNECTION_LOST:  'CONNECTION_LOST',
  SESSION_NOT_FOUND:'SESSION_NOT_FOUND',
  RATE_LIMITED:     'RATE_LIMITED',
  PROVIDER_ERROR:   'PROVIDER_ERROR',
  CANCELLED:        'CANCELLED',
  PARSE_ERROR:      'PARSE_ERROR',
  PROVIDER_NOT_FOUND:'PROVIDER_NOT_FOUND',
  SDK_TURN_LOST:    'SDK_TURN_LOST',
} as const;

export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES];
