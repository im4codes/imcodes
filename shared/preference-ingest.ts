import { computeMemoryFingerprint } from './memory-fingerprint.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, memoryFeatureFlagEnvKey } from './feature-flags.js';
import type { MemoryOrigin } from './memory-origin.js';
import type { ObservationClass, ObservationState } from './memory-observation.js';
import { renderMemoryContextItem } from './memory-render-policy.js';
import type { MemoryScope } from './memory-scope.js';
import {
  DEFAULT_SEND_ORIGIN,
  isTrustedPreferenceWriteOrigin,
  normalizeSendOrigin,
  type SendOrigin,
} from './send-origin.js';

export const PREFERENCE_COMMAND_PREFIX = '@pref:';
export const PREFERENCE_MAX_BYTES = 8 * 1024;
export const PREFERENCE_INGEST_SCOPE = 'user_private' as const satisfies MemoryScope;
export const PREFERENCE_INGEST_ORIGIN = 'user_note' as const satisfies MemoryOrigin;
export const PREFERENCE_INGEST_OBSERVATION_CLASS = 'preference' as const satisfies ObservationClass;
export const PREFERENCE_INGEST_OBSERVATION_STATE = 'active' as const satisfies ObservationState;
export const PREFERENCE_CONTEXT_START = '<imcodes-user-preferences>';
export const PREFERENCE_CONTEXT_END = '</imcodes-user-preferences>';
export const PREFERENCE_CONTEXT_MAX_ITEMS = 8;
export const PREFERENCE_CONTEXT_ITEM_MAX_BYTES = 1024;
export const PREFERENCE_IDEMPOTENCY_PREFIX = 'pref:v1';

export type PreferenceIngestOutcome =
  | 'disabled_pass_through'
  | 'no_preference'
  | 'persist'
  | 'duplicate_ignored'
  | 'rejected_untrusted'
  | 'rejected_oversize';

export interface PreferenceIngestRecord {
  text: string;
  fingerprint: string;
  idempotencyKey: string;
}

export interface PreferenceProviderContextRecord {
  text: string;
  fingerprint?: string;
  updatedAt?: number;
}

export interface PreferenceIngestResult {
  outcome: PreferenceIngestOutcome;
  providerText: string;
  records: PreferenceIngestRecord[];
  telemetry: Array<{
    counter: 'mem.preferences.duplicate_ignored' | 'mem.preferences.rejected_untrusted';
    sendOrigin: SendOrigin;
  }>;
}

export interface ProcessPreferenceLinesOptions {
  text: string;
  featureEnabled: boolean;
  sendOrigin?: unknown;
  userId: string;
  scopeKey: string;
  messageId?: string;
  seenIdempotencyKeys?: ReadonlySet<string>;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function splitLeadingPreferenceLines(text: string): { preferences: string[]; rest: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const preferences: string[] = [];
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!line.trimStart().toLowerCase().startsWith(PREFERENCE_COMMAND_PREFIX)) break;
    preferences.push(line.trimStart().slice(PREFERENCE_COMMAND_PREFIX.length).trim());
  }
  return { preferences: preferences.filter(Boolean), rest: lines.slice(index).join('\n') };
}

export function buildPreferenceIdempotencyKey(input: {
  userId: string;
  scopeKey: string;
  messageId?: string;
  fingerprint: string;
}): string {
  return [
    PREFERENCE_IDEMPOTENCY_PREFIX,
    input.userId.trim(),
    input.scopeKey.trim(),
    input.messageId?.trim() || 'message:unknown',
    input.fingerprint,
  ].join('\u0000');
}

function normalizePreferenceContextText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function renderPreferenceProviderContext(
  records: readonly PreferenceProviderContextRecord[],
): string {
  const rendered: string[] = [];
  const seen = new Set<string>();
  const ordered = [...records].sort((left, right) => {
    const leftTime = left.updatedAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.updatedAt ?? Number.MAX_SAFE_INTEGER;
    return rightTime - leftTime;
  });
  for (const record of ordered) {
    if (rendered.length >= PREFERENCE_CONTEXT_MAX_ITEMS) break;
    const key = record.fingerprint?.trim() || normalizePreferenceContextText(record.text);
    if (!key || seen.has(key)) continue;
    const item = renderMemoryContextItem({
      kind: 'preference',
      content: record.text,
      maxBytes: PREFERENCE_CONTEXT_ITEM_MAX_BYTES,
    });
    if (!item.ok || !item.text.trim()) continue;
    seen.add(key);
    rendered.push(`- ${item.text}`);
  }
  if (rendered.length === 0) return '';
  return [
    PREFERENCE_CONTEXT_START,
    'User-authored preferences for this and future turns. Follow them unless they conflict with higher-priority instructions or this turn explicitly overrides them.',
    ...rendered,
    PREFERENCE_CONTEXT_END,
  ].join('\n');
}

export function prependPreferenceProviderContext(providerText: string, preferenceContext: string): string {
  const context = preferenceContext.trim();
  if (!context) return providerText;
  const text = providerText.trim();
  return text ? `${context}\n\n${text}` : context;
}

/**
 * Parse trusted leading @pref lines without touching the daemon receipt ack path.
 * The caller can persist returned records asynchronously; disabled or untrusted
 * paths preserve provider-bound text exactly as required by the send contract.
 */
export function processPreferenceLines(options: ProcessPreferenceLinesOptions): PreferenceIngestResult {
  const sendOrigin = normalizeSendOrigin(options.sendOrigin ?? DEFAULT_SEND_ORIGIN);
  if (!options.featureEnabled) {
    return { outcome: 'disabled_pass_through', providerText: options.text, records: [], telemetry: [] };
  }

  const parsed = splitLeadingPreferenceLines(options.text);
  if (parsed.preferences.length === 0) {
    return { outcome: 'no_preference', providerText: options.text, records: [], telemetry: [] };
  }

  if (!isTrustedPreferenceWriteOrigin(sendOrigin)) {
    return {
      outcome: 'rejected_untrusted',
      providerText: options.text,
      records: [],
      telemetry: [{ counter: 'mem.preferences.rejected_untrusted', sendOrigin }],
    };
  }

  const records: PreferenceIngestRecord[] = [];
  const telemetry: PreferenceIngestResult['telemetry'] = [];
  let duplicateSeen = false;
  for (const preference of parsed.preferences) {
    if (utf8Bytes(preference) > PREFERENCE_MAX_BYTES) {
      return { outcome: 'rejected_oversize', providerText: options.text, records: [], telemetry };
    }
    const fingerprint = computeMemoryFingerprint({ kind: 'preference', content: preference, scopeKey: options.scopeKey });
    const idempotencyKey = buildPreferenceIdempotencyKey({
      userId: options.userId,
      scopeKey: options.scopeKey,
      messageId: options.messageId,
      fingerprint,
    });
    if (options.seenIdempotencyKeys?.has(idempotencyKey)) {
      duplicateSeen = true;
      telemetry.push({ counter: 'mem.preferences.duplicate_ignored', sendOrigin });
      continue;
    }
    records.push({ text: preference, fingerprint, idempotencyKey });
  }

  return {
    outcome: records.length > 0 ? 'persist' : duplicateSeen ? 'duplicate_ignored' : 'no_preference',
    providerText: parsed.rest,
    records,
    telemetry,
  };
}

export const PREFERENCE_FEATURE_FLAG = MEMORY_FEATURE_FLAGS_BY_NAME.preferences;
export const PREFERENCE_FEATURE_ENV_KEY = memoryFeatureFlagEnvKey(PREFERENCE_FEATURE_FLAG);
