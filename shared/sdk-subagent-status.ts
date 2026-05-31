import type { ToolCallDetail } from './agent-message.js';
import type { ToolCallEvent } from './agent-message.js';

export const SDK_SUBAGENT_DETAIL_KIND = 'sdkSubagent' as const;
export const SDK_SUBAGENT_SCHEMA_VERSION = 1 as const;

export const SDK_SUBAGENT_PROVIDERS = {
  CLAUDE_CODE_SDK: 'claude-code-sdk',
  CODEX_SDK: 'codex-sdk',
} as const;

export const SDK_SUBAGENT_PROVIDER_KINDS = {
  CLAUDE_TASK: 'claudeTask',
  CLAUDE_RUNTIME_AGENT: 'claudeRuntimeAgent',
  CODEX_COLLAB_AGENT: 'codexCollabAgent',
  CODEX_RUNTIME_AGENT: 'codexRuntimeAgent',
} as const;

export const SDK_SUBAGENT_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETE: 'complete',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
  STALE: 'stale',
  UNKNOWN: 'unknown',
} as const;

export const SDK_SUBAGENT_DIAGNOSTIC = {
  UNSUPPORTED_RUNTIME: 'unsupportedRuntime',
  UNKNOWN_RUNTIME_SUPPORT: 'unknownRuntimeSupport',
  MALFORMED_PAYLOAD: 'malformedPayload',
  MISSING_ID: 'missingId',
  UNKNOWN_STATE: 'unknownState',
  STALE_WITHOUT_TERMINAL: 'staleWithoutTerminal',
  SNAPSHOT_ONLY: 'snapshotOnly',
} as const;

export const SDK_SUBAGENT_TERMINAL_RETENTION_MS = 300_000;
export const SDK_SUBAGENT_MAX_TERMINAL_ROWS = 5;
export const SDK_SUBAGENT_SAFE_TEXT_MAX_LENGTH = 240;
export const SDK_SUBAGENT_SAFE_RAW_STRING_MAX_LENGTH = 512;
export const SDK_SUBAGENT_SAFE_RAW_MAX_DEPTH = 4;
export const SDK_SUBAGENT_SAFE_RAW_MAX_ARRAY_ITEMS = 16;
export const SDK_SUBAGENT_SAFE_RAW_MAX_OBJECT_KEYS = 32;
export const SDK_SUBAGENT_SAFE_RAW_MAX_TOTAL_BYTES = 4096;
export const SDK_SUBAGENT_CANONICAL_KEY_MAX_LENGTH = 192;
export const SDK_SUBAGENT_CANONICAL_COMPONENT_MAX_LENGTH = 48;
export const SDK_SUBAGENT_MAX_CHILD_COUNT = 999;
export const SDK_SUBAGENT_REDACTED_VALUE = '[REDACTED]';

export type SdkSubagentProvider = typeof SDK_SUBAGENT_PROVIDERS[keyof typeof SDK_SUBAGENT_PROVIDERS];
export type SdkSubagentProviderKind = typeof SDK_SUBAGENT_PROVIDER_KINDS[keyof typeof SDK_SUBAGENT_PROVIDER_KINDS];
export type SdkSubagentNormalizedStatus = typeof SDK_SUBAGENT_STATUS[keyof typeof SDK_SUBAGENT_STATUS];
export type SdkSubagentDiagnosticCode = typeof SDK_SUBAGENT_DIAGNOSTIC[keyof typeof SDK_SUBAGENT_DIAGNOSTIC];

export interface SdkSubagentDetailMeta {
  [key: string]: unknown;
  isSdkSubagent: true;
  schemaVersion: typeof SDK_SUBAGENT_SCHEMA_VERSION;
  provider: SdkSubagentProvider;
  providerKind: SdkSubagentProviderKind;
  canonicalKey: string;
  normalizedStatus: SdkSubagentNormalizedStatus;
  rawStatus?: string;
  active: boolean;
  terminal: boolean;
  parentSessionId?: string;
  parentToolUseId?: string;
  parentItemId?: string;
  agentPath?: string;
  agentName?: string;
  taskId?: string;
  receiverThreadId?: string;
  receiverIndex?: number;
  receiverCount?: number;
  runningChildCount?: number;
  childStatusSummary?: string;
  diagnosticCode?: SdkSubagentDiagnosticCode;
}

export interface SdkSubagentDetail extends ToolCallDetail {
  kind: typeof SDK_SUBAGENT_DETAIL_KIND;
  summary?: string;
  input?: {
    action?: string;
    receiverCount?: number;
    description?: string;
  };
  output?: string;
  meta: SdkSubagentDetailMeta;
  raw?: unknown;
}

export type SdkSubagentDetailParseResult =
  | { kind: 'not-sdk' }
  | { kind: 'malformed-sdk'; reason: string }
  | { kind: 'ok'; detail: SdkSubagentDetail };

export interface SdkSubagentSafeDetailOptions {
  allowRaw?: boolean;
}

const PROVIDER_VALUES = new Set<string>(Object.values(SDK_SUBAGENT_PROVIDERS));
const PROVIDER_KIND_VALUES = new Set<string>(Object.values(SDK_SUBAGENT_PROVIDER_KINDS));
const STATUS_VALUES = new Set<string>(Object.values(SDK_SUBAGENT_STATUS));
const DIAGNOSTIC_VALUES = new Set<string>(Object.values(SDK_SUBAGENT_DIAGNOSTIC));
const REDACT_KEY_RE = /(?:prompt|message|messages|content|secret|token|api[-_]?key|authorization|password|input)/i;
const SENSITIVE_TEXT_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@|Bearer\s+[A-Za-z0-9._-]{8,})\b/g;
const SAFE_META_STRING_KEYS = new Set([
  'rawStatus',
  'parentSessionId',
  'parentToolUseId',
  'parentItemId',
  'agentPath',
  'agentName',
  'taskId',
  'receiverThreadId',
  'childStatusSummary',
  'lastToolName',
  'taskType',
  'workflowName',
]);
const SAFE_META_NUMBER_KEYS = new Set([
  'receiverIndex',
  'receiverCount',
  'runningChildCount',
  'usageTotalTokens',
  'usageToolUses',
  'usageDurationMs',
]);
const SAFE_META_BOOLEAN_KEYS = new Set(['backgrounded']);

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

export function normalizeSdkSubagentKeyComponent(value: unknown): string {
  const text = sanitizeSdkSubagentText(value, 512) ?? 'unknown';
  const normalized = text.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  if (normalized.length <= SDK_SUBAGENT_CANONICAL_COMPONENT_MAX_LENGTH) return normalized;
  const prefix = normalized.slice(0, Math.max(8, SDK_SUBAGENT_CANONICAL_COMPONENT_MAX_LENGTH - 10)).replace(/_+$/g, '');
  return `${prefix}:${hashString(normalized)}`;
}

export function normalizeSdkSubagentCanonicalKey(value: unknown): string {
  const text = sanitizeSdkSubagentText(value, 1024) ?? 'sdk:unknown';
  const normalized = text
    .split(':')
    .map((part) => normalizeSdkSubagentKeyComponent(part))
    .join(':');
  if (normalized.length <= SDK_SUBAGENT_CANONICAL_KEY_MAX_LENGTH) return normalized;
  const prefix = normalized.slice(0, SDK_SUBAGENT_CANONICAL_KEY_MAX_LENGTH - 10).replace(/:+$/g, '');
  return `${prefix}:${hashString(normalized)}`;
}

export function makeClaudeSubagentCanonicalKey(sessionId: string, taskId: string): string {
  return normalizeSdkSubagentCanonicalKey(`claude:${normalizeSdkSubagentKeyComponent(sessionId)}:${normalizeSdkSubagentKeyComponent(taskId)}`);
}

export function makeCodexSubagentCanonicalKey(sessionId: string, itemId: string, receiverThreadId?: string): string {
  return normalizeSdkSubagentCanonicalKey(receiverThreadId
    ? `codex:${normalizeSdkSubagentKeyComponent(sessionId)}:${normalizeSdkSubagentKeyComponent(itemId)}:${normalizeSdkSubagentKeyComponent(receiverThreadId)}`
    : `codex:${normalizeSdkSubagentKeyComponent(sessionId)}:${normalizeSdkSubagentKeyComponent(itemId)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sanitizeSdkSubagentText(value: unknown, maxLength = SDK_SUBAGENT_SAFE_TEXT_MAX_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const redacted = normalized.replace(SENSITIVE_TEXT_RE, SDK_SUBAGENT_REDACTED_VALUE);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeFiniteNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function safeMeta(meta: SdkSubagentDetailMeta): SdkSubagentDetailMeta {
  const next: SdkSubagentDetailMeta = {
    isSdkSubagent: true,
    schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
    provider: meta.provider,
    providerKind: meta.providerKind,
    canonicalKey: normalizeSdkSubagentCanonicalKey(meta.canonicalKey),
    normalizedStatus: meta.normalizedStatus,
    active: meta.active,
    terminal: meta.terminal,
  };
  if (meta.diagnosticCode) next.diagnosticCode = meta.diagnosticCode;
  for (const key of SAFE_META_STRING_KEYS) {
    const value = sanitizeSdkSubagentText(meta[key], key === 'childStatusSummary' ? 160 : 120);
    if (value !== undefined) next[key] = value;
  }
  for (const key of SAFE_META_NUMBER_KEYS) {
    const max = key === 'receiverIndex' || key === 'receiverCount' || key === 'runningChildCount'
      ? SDK_SUBAGENT_MAX_CHILD_COUNT
      : 1_000_000_000;
    const value = safeFiniteNumber(meta[key], max);
    if (value !== undefined) next[key] = value;
  }
  for (const key of SAFE_META_BOOLEAN_KEYS) {
    if (typeof meta[key] === 'boolean') next[key] = meta[key];
  }
  return next;
}

function sanitizeRawValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeSdkSubagentText(value, SDK_SUBAGENT_SAFE_RAW_STRING_MAX_LENGTH);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    if (depth >= SDK_SUBAGENT_SAFE_RAW_MAX_DEPTH) return `[omitted array:${value.length}]`;
    return value.slice(0, SDK_SUBAGENT_SAFE_RAW_MAX_ARRAY_ITEMS).map((entry) => sanitizeRawValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= SDK_SUBAGENT_SAFE_RAW_MAX_DEPTH) return '[omitted object]';
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= SDK_SUBAGENT_SAFE_RAW_MAX_OBJECT_KEYS) {
        out.truncated = true;
        break;
      }
      out[key] = REDACT_KEY_RE.test(key) ? SDK_SUBAGENT_REDACTED_VALUE : sanitizeRawValue(value[key], depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  return text.length;
}

function bucketBytes(bytes: number): string {
  if (bytes < 1024) return '<1KiB';
  if (bytes < 4 * 1024) return '1-4KiB';
  if (bytes < 16 * 1024) return '4-16KiB';
  if (bytes < 64 * 1024) return '16-64KiB';
  if (bytes < 256 * 1024) return '64-256KiB';
  return '>=256KiB';
}

export function sanitizeSdkSubagentRawValue(raw: unknown): unknown {
  const sanitized = sanitizeRawValue(raw);
  const bytes = jsonByteLength(sanitized);
  if (bytes <= SDK_SUBAGENT_SAFE_RAW_MAX_TOTAL_BYTES) return sanitized;
  return {
    truncated: true,
    originalBytesBucket: bucketBytes(bytes),
  };
}

export function buildSdkSubagentSafeDetail(
  detail: SdkSubagentDetail,
  options: SdkSubagentSafeDetailOptions = {},
): SdkSubagentDetail {
  const summary = sanitizeSdkSubagentText(detail.summary);
  const output = sanitizeSdkSubagentText(detail.output);
  const inputRecord = isRecord(detail.input) ? detail.input : undefined;
  const action = sanitizeSdkSubagentText(inputRecord?.action, 80);
  const receiverCount = safeFiniteNumber(inputRecord?.receiverCount, SDK_SUBAGENT_MAX_CHILD_COUNT);
  const safeInput = action !== undefined || receiverCount !== undefined
    ? {
        ...(action !== undefined ? { action } : {}),
        ...(receiverCount !== undefined ? { receiverCount } : {}),
      }
    : undefined;
  return {
    kind: SDK_SUBAGENT_DETAIL_KIND,
    ...(summary !== undefined ? { summary } : {}),
    ...(safeInput ? { input: safeInput } : {}),
    ...(output !== undefined ? { output } : {}),
    meta: safeMeta(detail.meta),
    ...(options.allowRaw && detail.raw !== undefined ? { raw: sanitizeSdkSubagentRawValue(detail.raw) } : {}),
  };
}

export function buildSdkSubagentMinimalReplayDetail(detail: SdkSubagentDetail): SdkSubagentDetail {
  const safe = buildSdkSubagentSafeDetail(detail, { allowRaw: false });
  return {
    kind: SDK_SUBAGENT_DETAIL_KIND,
    ...(safe.summary ? { summary: safe.summary } : {}),
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: safe.meta.provider,
      providerKind: safe.meta.providerKind,
      canonicalKey: safe.meta.canonicalKey,
      normalizedStatus: safe.meta.normalizedStatus,
      active: safe.meta.active,
      terminal: safe.meta.terminal,
      ...(safe.meta.diagnosticCode ? { diagnosticCode: safe.meta.diagnosticCode } : {}),
      ...(typeof safe.meta.receiverCount === 'number' ? { receiverCount: safe.meta.receiverCount } : {}),
      ...(typeof safe.meta.runningChildCount === 'number' ? { runningChildCount: safe.meta.runningChildCount } : {}),
      ...(safe.meta.rawStatus ? { rawStatus: safe.meta.rawStatus } : {}),
      ...(safe.meta.childStatusSummary ? { childStatusSummary: safe.meta.childStatusSummary } : {}),
    },
  };
}

export function buildSdkSubagentTimelinePayload(
  tool: ToolCallEvent,
  options: SdkSubagentSafeDetailOptions = {},
): { detail: SdkSubagentDetail; payload: Record<string, unknown> } | null {
  const parsed = parseSdkSubagentDetail(tool.detail);
  if (parsed.kind !== 'ok') return null;
  const detail = buildSdkSubagentSafeDetail(parsed.detail, options);
  if (tool.status === 'running') {
    return {
      detail,
      payload: {
        tool: tool.name,
        ...(detail.input !== undefined ? { input: detail.input } : {}),
        detail,
      },
    };
  }
  const payload: Record<string, unknown> = { detail };
  if (tool.status === 'error') payload.error = detail.output ?? 'error';
  else if (detail.output !== undefined) payload.output = detail.output;
  return { detail, payload };
}

export function sdkSubagentDedupSignature(tool: Pick<ToolCallEvent, 'name' | 'status' | 'input' | 'output' | 'detail'>): string {
  const detail = isSdkSubagentDetail(tool.detail)
    ? buildSdkSubagentSafeDetail(tool.detail, { allowRaw: false })
    : tool.detail ?? null;
  return JSON.stringify({
    status: tool.status,
    name: tool.name,
    output: sanitizeSdkSubagentText(tool.output) ?? null,
    detail,
  });
}

export function parseSdkSubagentDetail(detail: unknown): SdkSubagentDetailParseResult {
  if (!isRecord(detail) || detail.kind !== SDK_SUBAGENT_DETAIL_KIND) return { kind: 'not-sdk' };
  if (!isRecord(detail.meta)) return { kind: 'malformed-sdk', reason: 'missing-meta' };
  const meta = detail.meta as Partial<SdkSubagentDetailMeta>;
  if (meta.isSdkSubagent !== true) return { kind: 'malformed-sdk', reason: 'missing-marker' };
  if (meta.schemaVersion !== SDK_SUBAGENT_SCHEMA_VERSION) return { kind: 'malformed-sdk', reason: 'schema-version' };
  if (typeof meta.provider !== 'string' || !PROVIDER_VALUES.has(meta.provider)) return { kind: 'malformed-sdk', reason: 'provider' };
  if (typeof meta.providerKind !== 'string' || !PROVIDER_KIND_VALUES.has(meta.providerKind)) return { kind: 'malformed-sdk', reason: 'provider-kind' };
  if (typeof meta.canonicalKey !== 'string' || !meta.canonicalKey.trim()) return { kind: 'malformed-sdk', reason: 'canonical-key' };
  if (typeof meta.normalizedStatus !== 'string' || !STATUS_VALUES.has(meta.normalizedStatus)) return { kind: 'malformed-sdk', reason: 'normalized-status' };
  if (typeof meta.active !== 'boolean') return { kind: 'malformed-sdk', reason: 'active' };
  if (typeof meta.terminal !== 'boolean') return { kind: 'malformed-sdk', reason: 'terminal' };
  if (meta.diagnosticCode !== undefined && (typeof meta.diagnosticCode !== 'string' || !DIAGNOSTIC_VALUES.has(meta.diagnosticCode))) {
    return { kind: 'malformed-sdk', reason: 'diagnostic-code' };
  }
  const normalized = buildSdkSubagentSafeDetail(detail as unknown as SdkSubagentDetail, {
    allowRaw: Boolean(meta.diagnosticCode),
  });
  return { kind: 'ok', detail: normalized };
}

export function isSdkSubagentDetail(detail: unknown): detail is SdkSubagentDetail {
  return parseSdkSubagentDetail(detail).kind === 'ok';
}

export function isSdkSubagentToolDetail(detail: ToolCallDetail | undefined): detail is SdkSubagentDetail {
  return isSdkSubagentDetail(detail);
}
