import { PREVIEW_ACCESS_TOKEN_QUERY_PARAM } from '../preview-types.js';

export type Redactable = Record<string, unknown>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const SENSITIVE_KEY_PATTERNS = [
  /_token$/i,
  /_key$/i,
  /_secret$/i,
  /^password$/i,
  /^authorization$/i,
  /^deck_/i,
  /^api_key$/i,
  // camelCase token keys that `/_token$/i` (snake_case-only) misses. Targeted on
  // purpose: a broad /token/i substring would wrongly redact `tokenId`
  // (server/src/routes/auth.ts) and truncated device-token debug fields
  // (server/src/routes/push.ts), which are safe-by-design and meant to stay visible.
  /^access_?token$/i,
  /^preview[A-Za-z_]*token$/i,
];

export const SENSITIVE_VALUE_PATTERNS = [
  /^deck_[0-9a-f]{32,}$/i,
];

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

export function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Sensitive query-param keys whose VALUE must be scrubbed when found inside an
 * arbitrary string (e.g. a logged browser→proxy URL). `preview_access_token` is
 * the canonical preview token; `access_token`/`token` are extra defense-in-depth.
 * The key-based redaction in `redactObject` never sees these because the token
 * is embedded in a URL VALUE, not a structured field key.
 */
const SENSITIVE_QUERY_PARAM_KEYS = [
  PREVIEW_ACCESS_TOKEN_QUERY_PARAM,
  'access_token',
  'token',
];

// Matches `<delim>key=<value>` where delim is one of ? & ; whitespace or
// start-of-string, and value runs until the next param/fragment/whitespace/quote
// or end-of-string. The value group is replaced; delimiter + key are preserved.
const SENSITIVE_QUERY_PARAM_RE = new RegExp(
  `([?&;]|^|\\s)(${SENSITIVE_QUERY_PARAM_KEYS.join('|')})=([^&#\\s"'<>]*)`,
  'gi',
);

/**
 * Replace the VALUE of any sensitive query param (`preview_access_token`,
 * `access_token`, `token`) found anywhere in `value` with `[REDACTED]`, keeping
 * the leading delimiter and key intact. Handles repeated occurrences, empty
 * values (`key=`), and values terminated by `&`, `#`, whitespace, a quote, or
 * end-of-string. A bare key with no `=` and all non-matching text are untouched.
 *
 * KNOWN LIMITATION (accepted for v1): this only scrubs `key=value` URL-form
 * tokens. A bare non-URL token sitting in free-text (e.g. `"the token is abc"`)
 * is NOT scrubbed. In practice the relay/undici errors we log almost always
 * carry the full request URL, so the token appears in `?key=value` form and is
 * caught here.
 */
export function scrubSensitiveQueryParams(value: string): string {
  if (typeof value !== 'string' || value.indexOf('=') === -1) return value;
  return value.replace(
    SENSITIVE_QUERY_PARAM_RE,
    (_match, delim: string, key: string) => `${delim}${key}=${REDACTED}`,
  );
}

/**
 * True for real `Error` instances AND error-like objects that carry a string
 * `message` plus a `stack` slot. Duck-typing here tolerates cross-realm errors
 * (different `Error` constructor) and partially-serialized errors that lost
 * their prototype, which `instanceof` alone would miss.
 */
function isErrorLike(v: unknown): v is Error {
  return (
    v instanceof Error ||
    (!!v &&
      typeof v === 'object' &&
      typeof (v as { message?: unknown }).message === 'string' &&
      'stack' in (v as object))
  );
}

/**
 * Convert an Error (or error-like object) into a plain, log-safe object.
 * `Object.entries` skips Error's non-enumerable `message`/`stack`, so a raw
 * `redactObject({ err })` would collapse to `{}` and silently lose all
 * diagnostics. Here we pull `name`/`message`/`stack` out explicitly, scrub any
 * sensitive query-param values out of the message/stack text, and route the
 * Error's ENUMERABLE own props (e.g. undici `code`, a nested `cause` Error)
 * back through `redactObject` so they keep diagnostics while still getting
 * key-redaction, value-scrub, and nested recursion.
 */
function redactError(e: Error): Redactable {
  const message = (e as { message?: unknown }).message;
  const stack = (e as { stack?: unknown }).stack;
  return {
    name: (e as { name?: unknown }).name as unknown,
    message: scrubSensitiveQueryParams(String(message ?? '')),
    stack: typeof stack === 'string' ? scrubSensitiveQueryParams(stack) : undefined,
    ...redactObject(Object.fromEntries(Object.entries(e)) as Redactable),
  };
}

export function redactObject(obj: Redactable): Redactable {
  const result: Redactable = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      result[k] = REDACTED;
    } else if (isSensitiveValue(v)) {
      result[k] = REDACTED;
    } else if (isErrorLike(v)) {
      result[k] = redactError(v);
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) => (
        isErrorLike(item) ? redactError(item)
          : item && typeof item === 'object' && !Array.isArray(item)
          ? redactObject(item as Redactable)
          : isSensitiveValue(item) ? REDACTED
          : typeof item === 'string' ? scrubSensitiveQueryParams(item)
          : item
      ));
    } else if (v && typeof v === 'object') {
      result[k] = redactObject(v as Redactable);
    } else if (typeof v === 'string') {
      result[k] = scrubSensitiveQueryParams(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}
