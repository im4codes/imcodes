export const CALLBACK_MCP_TOOLS = {
  UPDATE: 'callback_update',
} as const;

export const CALLBACK_SOURCES = {
  REPO: 'repo',
} as const;

export type CallbackSource = string;

export const CALLBACK_STATUSES = ['pending', 'in_progress', 'done', 'ignored', 'failed'] as const;
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

export const CALLBACK_UPDATE_STATUSES = ['in_progress', 'done', 'ignored', 'failed'] as const;
export type CallbackUpdateStatus = (typeof CALLBACK_UPDATE_STATUSES)[number];

export const CALLBACK_ID_PREFIX = 'cb_' as const;
export const CALLBACK_ID_PATTERN = /^cb_[a-zA-Z0-9_-]{4,120}$/;
export const CALLBACK_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const CALLBACK_MAX_ID_CHARS = 128;
export const CALLBACK_MAX_SOURCE_CHARS = 64;
export const CALLBACK_MAX_SUMMARY_CHARS = 2_000;
export const CALLBACK_MAX_RELATED_TASK_ID_CHARS = 128;
export const CALLBACK_MAX_METADATA_BYTES = 4_096;

export interface CallbackTaskRecord {
  callbackId: string;
  source: CallbackSource;
  eventType: string;
  scopeKey: string;
  entityKey: string;
  dedupKey: string;
  title: string;
  url?: string;
  targetSession: string;
  status: CallbackStatus;
  summary: string;
  relatedTaskId?: string;
  metadata?: Record<string, unknown>;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export function isValidCallbackId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CALLBACK_MAX_ID_CHARS && CALLBACK_ID_PATTERN.test(value);
}

export function buildCallbackId(source: CallbackSource, suffix: string): string {
  const safeSource = source.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 88) || 'event';
  return `${CALLBACK_ID_PREFIX}${safeSource}_${safeSuffix}`;
}

export function normalizeCallbackSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > CALLBACK_MAX_SOURCE_CHARS) return null;
  return CALLBACK_SOURCE_PATTERN.test(trimmed) ? trimmed : null;
}

export function isCallbackStatus(value: unknown): value is CallbackStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done' || value === 'ignored' || value === 'failed';
}

export function isCallbackUpdateStatus(value: unknown): value is CallbackUpdateStatus {
  return value === 'in_progress' || value === 'done' || value === 'ignored' || value === 'failed';
}

export function validateCallbackMetadata(
  value: unknown,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'metadata must be a plain JSON object' };
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { ok: false, error: 'metadata must be JSON-serializable' };
  }
  if (new TextEncoder().encode(encoded).byteLength > CALLBACK_MAX_METADATA_BYTES) {
    return { ok: false, error: `metadata exceeds ${CALLBACK_MAX_METADATA_BYTES} bytes` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
