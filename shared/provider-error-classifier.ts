/**
 * ONE answer to "is this provider failure transient or permanent?" for the daemon, the pair heartbeat and the web.
 *
 * Transient = the same request is expected to work again by itself (model at capacity, overloaded, rate-limit or 429, 5xx,
 * a dropped connection): the session keeps the turn queued and retries with backoff (see the capacity retry in
 * transport-session-runtime.ts). Permanent = a human or a config change is needed (auth, invalid/unsupported model, usage
 * limit or billing): it fails fast, never retried.
 *
 * Structured evidence wins over wording: a provider's own code (`AUTH_FAILED`, Codex `codexErrorInfo`), an HTTP status
 * (`status: 529`, `httpStatusCode`, "API Error: 529") and an API error type (`overloaded_error`, `rate_limit_error`,
 * `invalid_request_error`) are read from the error's `details` and from a JSON message body first; message patterns are only
 * the fallback for providers that report plain text ("Selected model is at capacity.").
 */
import { PROVIDER_ERROR_CODES } from './provider-error-codes.js';

export const PROVIDER_ERROR_CLASSES = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
  UNKNOWN: 'unknown',
} as const;
export type ProviderErrorClass = typeof PROVIDER_ERROR_CLASSES[keyof typeof PROVIDER_ERROR_CLASSES];

export const PROVIDER_ERROR_KINDS = {
  // transient
  CAPACITY: 'capacity',
  OVERLOADED: 'overloaded',
  RATE_LIMIT: 'rate_limit',
  SERVER_ERROR: 'server_error',
  NETWORK: 'network',
  // permanent
  AUTH: 'auth',
  INVALID_MODEL: 'invalid_model',
  INVALID_REQUEST: 'invalid_request',
  USAGE_LIMIT: 'usage_limit',
  BILLING: 'billing',
  CONFIG: 'config',
  // neither
  UNKNOWN: 'unknown',
} as const;
export type ProviderErrorKind = typeof PROVIDER_ERROR_KINDS[keyof typeof PROVIDER_ERROR_KINDS];

export interface ProviderErrorClassification {
  class: ProviderErrorClass;
  kind: ProviderErrorKind;
  /** `structured`: decided by a code / status / type; `message`: decided by wording only. */
  basis: 'structured' | 'message' | 'none';
}

export interface ClassifiableProviderError {
  code?: string;
  message?: string;
  details?: unknown;
}

const K = PROVIDER_ERROR_KINDS;
const TRANSIENT_KINDS: ReadonlySet<ProviderErrorKind> = new Set([K.CAPACITY, K.OVERLOADED, K.RATE_LIMIT, K.SERVER_ERROR, K.NETWORK]);

const MAX_TEXT_CHARS = 4_000;
const MAX_WALK_DEPTH = 4;
const MAX_WALK_KEYS = 64;

interface Evidence {
  statuses: number[];
  /** Lower-cased alphanumerics only, so `serverOverloaded`, `ServerOverloaded` and `server_overloaded` all read the same. */
  tags: string[];
  text: string;
}

const STATUS_KEYS = new Set(['status', 'statuscode', 'httpstatus', 'httpstatuscode', 'status_code', 'http_status']);
const TAG_KEYS = new Set(['type', 'code', 'codexerrorinfo', 'errortype', 'error_type', 'reason']);
const TEXT_KEYS = new Set(['message', 'detail', 'additionaldetails', 'error_description']);

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function walk(value: unknown, evidence: Evidence, depth: number): void {
  if (value == null || depth > MAX_WALK_DEPTH) return;
  if (typeof value === 'string') {
    if (evidence.text.length < MAX_TEXT_CHARS) evidence.text += `\n${value.slice(0, MAX_TEXT_CHARS)}`;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) walk(item, evidence, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  let seen = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (seen++ >= MAX_WALK_KEYS) break;
    const lower = key.toLowerCase();
    if (STATUS_KEYS.has(lower) && typeof child === 'number' && child >= 100 && child <= 599) {
      evidence.statuses.push(child);
    } else if (STATUS_KEYS.has(lower) && typeof child === 'string' && /^[1-5]\d\d$/.test(child.trim())) {
      evidence.statuses.push(Number(child));
    } else if (TAG_KEYS.has(lower) && typeof child === 'string') {
      evidence.tags.push(squash(child));
    } else if (TAG_KEYS.has(lower) && child && typeof child === 'object' && !Array.isArray(child)) {
      // Codex reports variants with payload as `{ httpConnectionFailed: { httpStatusCode: 503 } }`.
      for (const variant of Object.keys(child as Record<string, unknown>)) evidence.tags.push(squash(variant));
      walk(child, evidence, depth + 1);
    } else if (TEXT_KEYS.has(lower) && typeof child === 'string') {
      if (evidence.text.length < MAX_TEXT_CHARS) evidence.text += `\n${child.slice(0, MAX_TEXT_CHARS)}`;
    } else if (child && typeof child === 'object') {
      walk(child, evidence, depth + 1);
    }
  }
}

function collectEvidence(input: ClassifiableProviderError): Evidence {
  const evidence: Evidence = { statuses: [], tags: [], text: '' };
  const message = typeof input.message === 'string' ? input.message.slice(0, MAX_TEXT_CHARS) : '';
  evidence.text = message;
  // Some providers put the raw API body in the message: {"type":"error","status":400,"error":{"type":"invalid_request_error",...}}
  const trimmed = message.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { walk(JSON.parse(trimmed), evidence, 0); } catch { /* not JSON: the text is already covered */ }
  }
  if (input.details instanceof Error) {
    evidence.text += `\n${input.details.message.slice(0, MAX_TEXT_CHARS)}`;
    const code = (input.details as { code?: unknown }).code;
    if (typeof code === 'string') evidence.tags.push(squash(code));
  } else {
    walk(input.details, evidence, 0);
  }
  // Plain-text status: "API Error: 529 Overloaded", "last status: 429 Too Many Requests", "HTTP 503", "[503] ...".
  const textStatus = /\b(?:api error|http(?: status)?|status(?: code)?|error code)[:= ]+([45]\d\d)\b|^\s*\[?([45]\d\d)\]?[ :]|\b([45]\d\d) (?:too many requests|service unavailable|bad gateway|gateway time-?out|internal server error|unauthorized|forbidden|not found|bad request|overloaded|payment required)\b/gim;
  for (const match of message.matchAll(textStatus)) {
    const value = Number(match[1] ?? match[2] ?? match[3]);
    if (Number.isFinite(value)) evidence.statuses.push(value);
  }
  return evidence;
}

// ── message patterns (fallback) ─────────────────────────────────────────────────────────────────────────────────────────
const RE_BILLING = /insufficient[_ ]quota|credit balance|out of credits?|purchase more credits|payment required|billing|exceeded your current quota|no remaining quota/i;
const RE_PER_WINDOW = /\bper (?:minute|second|min|sec)\b|requests per|tokens per|rate[ _-]?limit(?:ed| reached| exceeded)?\b/i;
const RE_USAGE_LIMIT = /usage limit|hit your (?:usage |weekly |daily |5[- ]?hour )?limit|quota (?:exceeded|exhausted)|out of (?:usage|quota)|limit reached.{0,40}resets?/i;
const RE_AUTH = /invalid[_ ]?api[_ -]?key|incorrect api key|api key not valid|unauthori[sz]ed|authentication|invalid (?:authentication )?credentials|(?:access )?token (?:expired|invalid|could not be refreshed)|invalid access token|not logged in|please (?:run )?\/?login|forbidden|permission denied|request not allowed|expired token/i;
const RE_INVALID_MODEL = /model.{0,80}(?:is )?(?:not supported|not found|does not exist|not available|unknown|invalid|deprecated|decommissioned)|(?:unknown|invalid|unsupported|unrecognized) model|model_not_found/i;
const RE_CAPACITY = /at capacity|capacity (?:limit|exceeded|reached)|no capacity|over capacity|out of capacity/i;
const RE_OVERLOADED = /overloaded|server is busy|too busy|high demand|service[ _-]?unavailable|temporarily unavailable|currently unavailable|try again (?:later|in|shortly)|please try again/i;
const RE_RATE_LIMIT = /rate[ _-]?limit|too many requests|throttl|\b429\b|resource[_ ]exhausted/i;
const RE_SERVER = /internal server error|bad gateway|gateway time-?out|upstream (?:error|connect|request)|server error|the server had an error|\b(?:500|502|503|504|520|521|522|523|524|529)\b/i;
const RE_NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|EPIPE|socket hang up|fetch failed|network (?:error|is unreachable)|connection (?:reset|closed|lost|refused|error|terminated)|stream (?:disconnected|closed|ended|error)|request timed? ?out|timed out|read timeout/i;

function transientFromStatus(status: number): ProviderErrorKind | null {
  if (status === 529 || status === 503) return K.OVERLOADED;
  if (status === 429 || status === 408 || status === 425) return K.RATE_LIMIT;
  if (status >= 500 && status <= 599) return K.SERVER_ERROR;
  return null;
}

function result(kind: ProviderErrorKind, basis: ProviderErrorClassification['basis']): ProviderErrorClassification {
  if (kind === K.UNKNOWN) return { class: PROVIDER_ERROR_CLASSES.UNKNOWN, kind, basis: 'none' };
  return {
    class: TRANSIENT_KINDS.has(kind) ? PROVIDER_ERROR_CLASSES.TRANSIENT : PROVIDER_ERROR_CLASSES.PERMANENT,
    kind,
    basis,
  };
}

/** Wording-only permanent kinds, checked before the transient wording ("rate limit ... billing" is a billing problem). */
function permanentFromText(text: string): ProviderErrorKind | null {
  if (RE_BILLING.test(text)) return K.BILLING;
  if (RE_USAGE_LIMIT.test(text) && !RE_PER_WINDOW.test(text)) return K.USAGE_LIMIT;
  if (RE_AUTH.test(text)) return K.AUTH;
  if (RE_INVALID_MODEL.test(text) && !RE_CAPACITY.test(text)) return K.INVALID_MODEL;
  return null;
}

function transientFromText(text: string): ProviderErrorKind | null {
  if (RE_CAPACITY.test(text)) return K.CAPACITY;
  if (RE_RATE_LIMIT.test(text)) return K.RATE_LIMIT; // before "try again later", which a rate-limit message also says
  if (RE_OVERLOADED.test(text)) return K.OVERLOADED;
  if (RE_SERVER.test(text)) return K.SERVER_ERROR;
  if (RE_NETWORK.test(text)) return K.NETWORK;
  return null;
}

const TAG_KIND: ReadonlyArray<[RegExp, ProviderErrorKind]> = [
  // Codex `codexErrorInfo` variants and their neighbours.
  [/^(?:serveroverloaded|overloadederror|overloaded|unavailable|serviceunavailable)$/, K.OVERLOADED],
  [/^(?:usagelimitexceeded)$/, K.USAGE_LIMIT],
  [/^(?:unauthorized|authenticationerror|permissionerror|invalidapikey|authfailed|forbidden)$/, K.AUTH],
  [/^(?:responsestreamconnectionfailed|responsestreamdisconnected|responsetoomanyfailedattempts|econnreset|etimedout|econnrefused|eaiagain|enotfound|epipe)$/, K.NETWORK],
  [/^(?:internalservererror|servererror|apierror|internalerror)$/, K.SERVER_ERROR],
  [/^(?:ratelimiterror|ratelimitexceeded|ratelimited|toomanyrequests|throttling|throttlingerror)$/, K.RATE_LIMIT],
  [/^(?:insufficientquota|billinghardlimitreached|billingerror|paymentrequired)$/, K.BILLING],
  [/^(?:modelnotfound|notfounderror)$/, K.INVALID_MODEL],
  [/^(?:contextwindowexceeded|sandboxerror)$/, K.INVALID_REQUEST],
];

/** Classify one provider failure. `unknown` means "no evidence either way": callers keep their existing behaviour. */
export function classifyProviderError(input: ClassifiableProviderError | undefined): ProviderErrorClassification {
  if (!input) return result(K.UNKNOWN, 'none');
  const code = input.code ?? '';

  // 1. The provider's own code.
  if (code === PROVIDER_ERROR_CODES.AUTH_FAILED) return result(K.AUTH, 'structured');
  if (code === PROVIDER_ERROR_CODES.CONFIG_ERROR || code === PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND) return result(K.CONFIG, 'structured');
  if (code === PROVIDER_ERROR_CODES.RATE_LIMITED) return result(K.RATE_LIMIT, 'structured');
  if (code === PROVIDER_ERROR_CODES.CONNECTION_LOST) return result(K.NETWORK, 'structured');
  if (code === PROVIDER_ERROR_CODES.CANCELLED) return result(K.UNKNOWN, 'none');

  const evidence = collectEvidence(input);
  const text = evidence.text;

  // 2. Billing / usage-limit statements are permanent whatever status carried them (a 429 "insufficient_quota" is not a throttle).
  if (RE_BILLING.test(text) || evidence.statuses.includes(402)) return result(K.BILLING, 'structured');
  const usageLimit = RE_USAGE_LIMIT.test(text) && !RE_PER_WINDOW.test(text);

  // 3. Tags: Codex `codexErrorInfo`, API error types, gRPC / Node codes.
  for (const tag of evidence.tags) {
    for (const [pattern, kind] of TAG_KIND) {
      if (pattern.test(tag)) {
        // "invalid_request_error" below is decided by the model wording, not here.
        if (kind === K.INVALID_REQUEST && RE_INVALID_MODEL.test(text)) return result(K.INVALID_MODEL, 'structured');
        if (kind === K.RATE_LIMIT && usageLimit) return result(K.USAGE_LIMIT, 'structured');
        return result(kind, 'structured');
      }
    }
    if (tag === 'invalidrequesterror' || tag === 'badrequest' || tag === 'invalidrequest') {
      return result(RE_INVALID_MODEL.test(text) ? K.INVALID_MODEL : K.INVALID_REQUEST, 'structured');
    }
    if (tag === 'resourceexhausted') {
      // gRPC quota: a per-minute window is a throttle, anything else an exhausted quota.
      return result(RE_PER_WINDOW.test(text) ? K.RATE_LIMIT : K.USAGE_LIMIT, 'structured');
    }
  }
  if (usageLimit) return result(K.USAGE_LIMIT, 'message');

  // 4. HTTP status. 4xx other than 408/425/429 is the caller's problem; 5xx and 429 pass by themselves.
  for (const status of evidence.statuses) {
    if (status === 401 || status === 403) return result(K.AUTH, 'structured');
    const transient = transientFromStatus(status);
    if (transient) return result(transient, 'structured');
  }
  for (const status of evidence.statuses) {
    if (status === 404 || status === 400 || status === 422) {
      return result(RE_INVALID_MODEL.test(text) ? K.INVALID_MODEL : K.INVALID_REQUEST, 'structured');
    }
  }

  // 5. Wording only.
  const permanent = permanentFromText(text);
  if (permanent) return result(permanent, 'message');
  const transient = transientFromText(text);
  if (transient) return result(transient, 'message');
  return result(K.UNKNOWN, 'none');
}

export function isTransientProviderClassification(classification: ProviderErrorClassification): boolean {
  return classification.class === PROVIDER_ERROR_CLASSES.TRANSIENT;
}

/**
 * Should the session keep the failed turn and retry it with backoff? Transient, and not one of the three codes that already
 * have their own recovery path: a structured RATE_LIMITED goes to provider failover, CONNECTION_LOST to the runtime relaunch,
 * CANCELLED is the user's own stop.
 */
export function shouldRetryProviderErrorWithBackoff(error: ClassifiableProviderError | undefined): boolean {
  if (!error) return false;
  if (error.code === PROVIDER_ERROR_CODES.RATE_LIMITED
    || error.code === PROVIDER_ERROR_CODES.CONNECTION_LOST
    || error.code === PROVIDER_ERROR_CODES.CANCELLED) return false;
  return isTransientProviderClassification(classifyProviderError(error));
}

/**
 * Free-text refusal that the pair heartbeat should HOLD and retry on its next tick rather than nudge into: every transient kind,
 * plus wording-only usage-limit text (a provider that reports its limit only as text still must not be nudged into a wall).
 * It is never a rate-limit verdict: a real limit is decided only by structured evidence (SessionRecord.providerLimit).
 */
export function isTransientProviderRefusalText(message: string | undefined): boolean {
  if (!message) return false;
  const classification = classifyProviderError({ message });
  return isTransientProviderClassification(classification) || classification.kind === K.USAGE_LIMIT;
}
