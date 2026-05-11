import type { TimelineEvent } from './timeline-event.js';

export const DEFAULT_TIMELINE_HISTORY_MAX_EVENT_BYTES = 32 * 1024;
export const DEFAULT_TIMELINE_HISTORY_MAX_RESPONSE_BYTES = 1024 * 1024;

const NORMAL_STRING_BYTES = 16 * 1024;
const TIGHT_STRING_BYTES = 4 * 1024;
const TOOL_OUTPUT_BYTES = 12 * 1024;
const TOOL_RAW_BYTES = 4 * 1024;
const TEXT_EVENT_BYTES = 24 * 1024;

interface ValuePolicy {
  maxStringBytes: number;
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
}

interface MutableSanitizeStats {
  truncatedValues: number;
}

export interface TimelineHistorySanitizeOptions {
  maxEventBytes?: number;
  maxResponseBytes?: number;
}

export interface TimelineHistorySanitizeResult {
  events: TimelineEvent[];
  payloadBytes: number;
  droppedEvents: number;
  truncatedEvents: number;
}

const NORMAL_POLICY: ValuePolicy = {
  maxStringBytes: NORMAL_STRING_BYTES,
  maxDepth: 5,
  maxArrayItems: 80,
  maxObjectKeys: 80,
};

const TIGHT_POLICY: ValuePolicy = {
  maxStringBytes: TIGHT_STRING_BYTES,
  maxDepth: 3,
  maxArrayItems: 24,
  maxObjectKeys: 32,
};

const RAW_POLICY: ValuePolicy = {
  maxStringBytes: TOOL_RAW_BYTES,
  maxDepth: 3,
  maxArrayItems: 20,
  maxObjectKeys: 32,
};

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function truncateStringByUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return value;

  const marker = '\n[history truncated]';
  const targetBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let end = Math.min(value.length, targetBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > targetBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${value.slice(0, end)}${marker}`;
}

function sanitizeValue(
  value: unknown,
  policy: ValuePolicy,
  stats: MutableSanitizeStats,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    const next = truncateStringByUtf8Bytes(value, policy.maxStringBytes);
    if (next !== value) stats.truncatedValues += 1;
    return next;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    if (depth >= policy.maxDepth) {
      stats.truncatedValues += 1;
      return `[history omitted array:${value.length}]`;
    }
    const items = value.slice(0, policy.maxArrayItems).map((item) => sanitizeValue(item, policy, stats, depth + 1));
    if (items.length < value.length) stats.truncatedValues += 1;
    return items;
  }
  if (typeof value === 'object') {
    if (depth >= policy.maxDepth) {
      stats.truncatedValues += 1;
      return '[history omitted object]';
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (count >= policy.maxObjectKeys) {
        stats.truncatedValues += 1;
        break;
      }
      out[key] = sanitizeValue(child, policy, stats, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

function sanitizeToolDetail(detail: unknown, stats: MutableSanitizeStats): unknown {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return sanitizeValue(detail, NORMAL_POLICY, stats);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (key === 'raw') {
      out[key] = sanitizeValue(value, RAW_POLICY, stats);
    } else if (key === 'output') {
      out[key] = sanitizeValue(value, { ...NORMAL_POLICY, maxStringBytes: TOOL_OUTPUT_BYTES }, stats);
    } else if (key === 'input') {
      out[key] = sanitizeValue(value, { ...NORMAL_POLICY, maxStringBytes: NORMAL_STRING_BYTES }, stats);
    } else {
      out[key] = sanitizeValue(value, NORMAL_POLICY, stats);
    }
  }
  return out;
}

function sanitizePayload(event: TimelineEvent, stats: MutableSanitizeStats, policy = NORMAL_POLICY): Record<string, unknown> {
  const payload = event.payload ?? {};
  if (event.type === 'tool.call' || event.type === 'tool.result') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'detail') {
        out[key] = sanitizeToolDetail(value, stats);
      } else if (key === 'output') {
        out[key] = sanitizeValue(value, { ...policy, maxStringBytes: TOOL_OUTPUT_BYTES }, stats);
      } else if (key === 'input') {
        out[key] = sanitizeValue(value, { ...policy, maxStringBytes: NORMAL_STRING_BYTES }, stats);
      } else {
        out[key] = sanitizeValue(value, policy, stats);
      }
    }
    return out;
  }

  if ((event.type === 'user.message' || event.type === 'assistant.text' || event.type === 'assistant.thinking') && typeof payload.text === 'string') {
    return {
      ...sanitizeValue(payload, policy, stats) as Record<string, unknown>,
      text: truncateStringByUtf8Bytes(payload.text, TEXT_EVENT_BYTES),
    };
  }

  return sanitizeValue(payload, policy, stats) as Record<string, unknown>;
}

function minimalPayload(event: TimelineEvent, originalPayloadBytes: number, stats: MutableSanitizeStats): Record<string, unknown> {
  const payload = event.payload ?? {};
  const out: Record<string, unknown> = {
    historyPayloadTruncated: true,
    originalPayloadBytes,
  };
  if (typeof payload.text === 'string') out.text = truncateStringByUtf8Bytes(payload.text, TEXT_EVENT_BYTES);
  if (typeof payload.tool === 'string') out.tool = payload.tool;
  if (typeof payload.error === 'string') out.error = truncateStringByUtf8Bytes(payload.error, TIGHT_STRING_BYTES);
  if (typeof payload.output === 'string') out.output = truncateStringByUtf8Bytes(payload.output, TIGHT_STRING_BYTES);
  stats.truncatedValues += 1;
  return out;
}

export function sanitizeTimelineHistoryEventForTransport(
  event: TimelineEvent,
  options: TimelineHistorySanitizeOptions = {},
): { event: TimelineEvent; bytes: number; truncated: boolean } {
  const maxEventBytes = Math.max(1024, Math.trunc(options.maxEventBytes ?? DEFAULT_TIMELINE_HISTORY_MAX_EVENT_BYTES));
  const stats: MutableSanitizeStats = { truncatedValues: 0 };
  const originalPayloadBytes = jsonBytes(event.payload);
  const beforeTruncations = stats.truncatedValues;

  let next: TimelineEvent = {
    ...event,
    payload: sanitizePayload(event, stats),
  };
  let bytes = jsonBytes(next);

  if (bytes > maxEventBytes) {
    next = {
      ...event,
      payload: sanitizePayload(next, stats, TIGHT_POLICY),
    };
    bytes = jsonBytes(next);
  }

  if (bytes > maxEventBytes) {
    next = {
      ...event,
      payload: minimalPayload(event, originalPayloadBytes, stats),
    };
    bytes = jsonBytes(next);
  }

  const truncated = stats.truncatedValues > beforeTruncations || bytes < jsonBytes(event);
  return { event: next, bytes, truncated };
}

export function sanitizeTimelineHistoryEventsForTransport(
  events: readonly TimelineEvent[],
  options: TimelineHistorySanitizeOptions = {},
): TimelineHistorySanitizeResult {
  const maxResponseBytes = Math.max(64 * 1024, Math.trunc(options.maxResponseBytes ?? DEFAULT_TIMELINE_HISTORY_MAX_RESPONSE_BYTES));
  const sanitized = events.map((event) => sanitizeTimelineHistoryEventForTransport(event, options));
  let truncatedEvents = sanitized.filter((entry) => entry.truncated).length;
  const selected: TimelineEvent[] = [];
  let payloadBytes = 2;
  let droppedEvents = 0;

  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const entry = sanitized[index]!;
    const nextBytes = payloadBytes + entry.bytes + (selected.length > 0 ? 1 : 0);
    if (nextBytes > maxResponseBytes && selected.length > 0) {
      droppedEvents += 1;
      continue;
    }
    selected.push(entry.event);
    payloadBytes = nextBytes;
  }
  selected.reverse();

  if (droppedEvents > 0) truncatedEvents += droppedEvents;
  return {
    events: selected,
    payloadBytes,
    droppedEvents,
    truncatedEvents,
  };
}
