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

/** Free-text provider overload/capacity wording.  Rate-limit-shaped wording
 * is included for legacy providers that do not emit structured evidence; a
 * structured RATE_LIMITED code must still take the failover path. */
const TRANSIENT_PROVIDER_ERROR_RE = /\bat capacity\b|\bcapacity\b.*\b(?:model|reached|exceeded)\b|rate[ _-]?limit|too many requests|\b429\b|\b529\b|\b503\b|overloaded|temporarily unavailable|usage limit|quota (?:exceeded|exhausted)/i;

export function isTransientProviderError(message: string | undefined): boolean {
  return !!message && TRANSIENT_PROVIDER_ERROR_RE.test(message);
}

/** Capacity/overload retry signal, excluding structured account limits. */
export function isTransientProviderCapacityError(error: { code?: string; message?: string; details?: unknown } | undefined): boolean {
  if (!error || error.code === PROVIDER_ERROR_CODES.RATE_LIMITED) return false;
  const code = error.code?.toLowerCase() ?? '';
  const detailsCode = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? String((error.details as Record<string, unknown>).code ?? '').toLowerCase()
    : '';
  if (/rate[ _-]?limit|quota/.test(code) || /rate[ _-]?limit|quota/.test(detailsCode)) return false;
  return /capacity|overload|service.?unavailable|temporar/.test(code)
    || isTransientProviderError(error.message);
}
