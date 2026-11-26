import { describe, expect, it } from 'vitest';
import { PROVIDER_ERROR_CODES } from '../../shared/provider-error-codes.js';
import {
  classifyProviderError,
  isTransientProviderRefusalText,
  PROVIDER_ERROR_CLASSES as C,
  PROVIDER_ERROR_KINDS as K,
  shouldRetryProviderErrorWithBackoff,
} from '../../shared/provider-error-classifier.js';

const PE = PROVIDER_ERROR_CODES.PROVIDER_ERROR;

interface Case {
  provider: string;
  /** `real`: copied from this daemon's logs; `shape`: the documented wire shape of that provider's error. */
  origin: 'real' | 'shape';
  error: { code?: string; message?: string; details?: unknown };
  class: string;
  kind: string;
}

const CASES: Case[] = [
  // codex-sdk — real messages from the daemon log
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: 'Selected model is at capacity. Please try a different model.' }, class: C.TRANSIENT, kind: K.CAPACITY },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: 'Error running remote compact task: Selected model is at capacity. Please try a different model.' }, class: C.TRANSIENT, kind: K.CAPACITY },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: 'exceeded retry limit, last status: 429 Too Many Requests, request id: a45e0b66-fc39-4c91-a807-a4992a871970' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account."}}' }, class: C.PERMANENT, kind: K.INVALID_MODEL },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: '{"detail":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}' }, class: C.PERMANENT, kind: K.INVALID_MODEL },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: 'failed to enqueue running thread resume for thread 01a0dd65: thread listener command channel is closed' }, class: C.UNKNOWN, kind: K.UNKNOWN },
  { provider: 'codex-sdk', origin: 'real', error: { code: PE, message: 'Codex turn failed' }, class: C.UNKNOWN, kind: K.UNKNOWN },
  // codex-sdk — structured `codexErrorInfo` (turn.error passed as details)
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Codex turn failed', details: { message: 'x', codexErrorInfo: 'serverOverloaded' } }, class: C.TRANSIENT, kind: K.OVERLOADED },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Codex turn failed', details: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } } }, class: C.TRANSIENT, kind: K.OVERLOADED },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'stream ended', details: { codexErrorInfo: 'responseStreamDisconnected' } }, class: C.TRANSIENT, kind: K.NETWORK },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Codex turn failed', details: { codexErrorInfo: 'usageLimitExceeded' } }, class: C.PERMANENT, kind: K.USAGE_LIMIT },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Codex turn failed', details: { codexErrorInfo: 'unauthorized' } }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Codex turn failed', details: { codexErrorInfo: 'badRequest' } }, class: C.PERMANENT, kind: K.INVALID_REQUEST },
  { provider: 'codex-sdk', origin: 'shape', error: { code: PE, message: 'Your access token could not be refreshed because your refresh token was already used.' }, class: C.PERMANENT, kind: K.AUTH },
  // claude-code-sdk — real messages from the daemon log and the documented API bodies
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'API Error: 529 Overloaded' }, class: C.TRANSIENT, kind: K.OVERLOADED },
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'API Error: 401 Invalid authentication credentials' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'API Error: 403 Request not allowed' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'API Error: 401 invalid access token or token expired' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'Invalid API key' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'claude-code-sdk', origin: 'real', error: { code: PE, message: 'Claude Code process exited with code 1' }, class: C.UNKNOWN, kind: K.UNKNOWN },
  { provider: 'claude-code-sdk', origin: 'shape', error: { code: PE, message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }, class: C.TRANSIENT, kind: K.OVERLOADED },
  { provider: 'claude-code-sdk', origin: 'shape', error: { code: PE, message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'claude-code-sdk', origin: 'shape', error: { code: PE, message: 'Credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' }, class: C.PERMANENT, kind: K.BILLING },
  { provider: 'claude-code-sdk', origin: 'shape', error: { code: PE, message: 'Claude AI usage limit reached|1759257600' }, class: C.PERMANENT, kind: K.USAGE_LIMIT },
  { provider: 'claude-code-sdk', origin: 'shape', error: { code: PE, message: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' }, class: C.TRANSIENT, kind: K.SERVER_ERROR },
  // gemini
  { provider: 'gemini', origin: 'shape', error: { code: PE, message: '[503] The model is overloaded. Please try again later.' }, class: C.TRANSIENT, kind: K.OVERLOADED },
  { provider: 'gemini', origin: 'shape', error: { code: PE, message: '[429 Too Many Requests] Quota exceeded for quota metric \'Generate Content API requests per minute\' RESOURCE_EXHAUSTED' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'gemini', origin: 'shape', error: { code: PE, message: 'You exceeded your current quota, please check your plan and billing details.' }, class: C.PERMANENT, kind: K.BILLING },
  { provider: 'gemini', origin: 'shape', error: { code: PE, message: 'API key not valid. Please pass a valid API key.' }, class: C.PERMANENT, kind: K.AUTH },
  // qwen / OpenAI-compatible
  { provider: 'qwen', origin: 'shape', error: { code: PE, message: 'Requests rate limit exceeded, please try again later.' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'qwen', origin: 'shape', error: { code: PE, message: 'Throttling.RateQuota: Request was denied due to exceeding rate quota.' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'qwen', origin: 'shape', error: { code: PE, message: 'InvalidApiKey: Incorrect API key provided.' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'qwen', origin: 'shape', error: { code: PE, message: '429 insufficient_quota: You exceeded your current quota' }, class: C.PERMANENT, kind: K.BILLING },
  { provider: 'openai-compatible', origin: 'shape', error: { code: PE, message: 'The server had an error while processing your request. Sorry about that!' }, class: C.TRANSIENT, kind: K.SERVER_ERROR },
  { provider: 'openai-compatible', origin: 'shape', error: { code: PE, message: 'The model `gpt-9` does not exist or you do not have access to it.' }, class: C.PERMANENT, kind: K.INVALID_MODEL },
  { provider: 'openai-compatible', origin: 'shape', error: { code: PE, message: 'Rate limit reached for gpt-4 in organization org-x on tokens per min (TPM): Limit 10000.' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'openai-compatible', origin: 'shape', error: { code: PE, message: '502 Bad Gateway' }, class: C.TRANSIENT, kind: K.SERVER_ERROR },
  { provider: 'openai-compatible', origin: 'shape', error: { code: PE, message: '504 Gateway Timeout' }, class: C.TRANSIENT, kind: K.SERVER_ERROR },
  // network (any provider that shells out to fetch / a socket)
  { provider: 'network', origin: 'real', error: { code: PE, message: 'fetch failed' }, class: C.TRANSIENT, kind: K.NETWORK },
  { provider: 'network', origin: 'real', error: { code: PE, message: 'read ECONNRESET' }, class: C.TRANSIENT, kind: K.NETWORK },
  { provider: 'network', origin: 'shape', error: { code: PE, message: 'socket hang up' }, class: C.TRANSIENT, kind: K.NETWORK },
  { provider: 'network', origin: 'shape', error: { code: PE, message: 'x', details: Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }) }, class: C.TRANSIENT, kind: K.NETWORK },
  // structured provider codes
  { provider: 'code', origin: 'shape', error: { code: PROVIDER_ERROR_CODES.AUTH_FAILED, message: 'anything' }, class: C.PERMANENT, kind: K.AUTH },
  { provider: 'code', origin: 'shape', error: { code: PROVIDER_ERROR_CODES.RATE_LIMITED, message: 'anything' }, class: C.TRANSIENT, kind: K.RATE_LIMIT },
  { provider: 'code', origin: 'shape', error: { code: PROVIDER_ERROR_CODES.CONNECTION_LOST, message: 'Codex app-server not connected' }, class: C.TRANSIENT, kind: K.NETWORK },
  { provider: 'code', origin: 'shape', error: { code: PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, message: 'Codex binary not found' }, class: C.PERMANENT, kind: K.CONFIG },
  { provider: 'code', origin: 'shape', error: { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'Codex turn cancelled' }, class: C.UNKNOWN, kind: K.UNKNOWN },
];

describe('classifyProviderError', () => {
  it.each(CASES)('$provider ($origin): $error.message $error.details -> $class/$kind', (testCase) => {
    const got = classifyProviderError(testCase.error);
    expect({ class: got.class, kind: got.kind }).toEqual({ class: testCase.class, kind: testCase.kind });
  });

  it('structured evidence wins over wording', () => {
    // The text says "capacity" but the structured status/type is an authentication failure.
    expect(classifyProviderError({ code: PE, message: 'capacity', details: { status: 401 } }).kind).toBe(K.AUTH);
    // A 429 that carries an insufficient_quota code is billing, not a throttle.
    expect(classifyProviderError({ code: PE, message: 'x', details: { status: 429, error: { code: 'insufficient_quota' } } })).toMatchObject({ class: C.PERMANENT, kind: K.BILLING });
    // A bare 5xx status in details is transient even with an unhelpful message.
    expect(classifyProviderError({ code: PE, message: 'Codex turn failed', details: { statusCode: 502 } })).toMatchObject({ class: C.TRANSIENT, basis: 'structured' });
  });

  it('"try a different model" in a capacity refusal is not an invalid-model error', () => {
    expect(classifyProviderError({ code: PE, message: 'Selected model is at capacity. Please try a different model.' }).kind).toBe(K.CAPACITY);
  });

  it('is bounded: a huge message or a deeply nested details object cannot blow up', () => {
    let nested: Record<string, unknown> = { status: 503 };
    for (let i = 0; i < 200; i += 1) nested = { error: nested };
    expect(() => classifyProviderError({ code: PE, message: 'x'.repeat(5_000_000), details: nested })).not.toThrow();
    expect(classifyProviderError(undefined)).toMatchObject({ class: C.UNKNOWN });
  });
});

describe('shouldRetryProviderErrorWithBackoff', () => {
  it('retries transient failures, even when the SDK marked them non-recoverable', () => {
    expect(shouldRetryProviderErrorWithBackoff({ code: PE, message: 'Selected model is at capacity. Please try a different model.' })).toBe(true);
    expect(shouldRetryProviderErrorWithBackoff({ code: PE, message: 'API Error: 529 Overloaded' })).toBe(true);
  });

  it('COUNTEREXAMPLE: a permanent failure (auth, invalid model, billing, usage limit) fails fast', () => {
    for (const message of [
      'API Error: 401 Invalid authentication credentials',
      "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
      'Credit balance is too low',
      'Claude AI usage limit reached|1759257600',
    ]) {
      expect(shouldRetryProviderErrorWithBackoff({ code: PE, message }), message).toBe(false);
    }
    expect(shouldRetryProviderErrorWithBackoff({ code: PROVIDER_ERROR_CODES.AUTH_FAILED, message: 'x' })).toBe(false);
  });

  it('leaves the codes that already own a recovery path alone (failover, relaunch, user stop)', () => {
    expect(shouldRetryProviderErrorWithBackoff({ code: PROVIDER_ERROR_CODES.RATE_LIMITED, message: 'rate limit' })).toBe(false);
    expect(shouldRetryProviderErrorWithBackoff({ code: PROVIDER_ERROR_CODES.CONNECTION_LOST, message: 'fetch failed' })).toBe(false);
    expect(shouldRetryProviderErrorWithBackoff({ code: PROVIDER_ERROR_CODES.CANCELLED, message: 'capacity' })).toBe(false);
    expect(shouldRetryProviderErrorWithBackoff({ code: PE, message: 'something nobody has seen before' })).toBe(false);
  });
});

describe('isTransientProviderRefusalText (pair heartbeat hold)', () => {
  it('keeps the wording the pair scheduler already held, and still never holds a permanent failure', () => {
    expect(isTransientProviderRefusalText('Error: Selected model is at capacity. Please try a different model.')).toBe(true);
    expect(isTransientProviderRefusalText('429 Too Many Requests')).toBe(true);
    expect(isTransientProviderRefusalText('You have hit your usage limit')).toBe(true);
    expect(isTransientProviderRefusalText('Invalid API key')).toBe(false);
    expect(isTransientProviderRefusalText(undefined)).toBe(false);
  });
});
