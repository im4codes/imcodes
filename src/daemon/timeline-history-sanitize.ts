import type { TimelineEvent } from './timeline-event.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import {
  TIMELINE_DETAIL_FIELD_PATHS,
  type TimelineDetailFieldPath,
  type TimelineDetailRef,
} from '../../shared/timeline-protocol.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  buildSdkSubagentMinimalReplayDetail,
  buildSdkSubagentTimelinePayload,
  parseSdkSubagentDetail,
} from '../../shared/sdk-subagent-status.js';

export const DEFAULT_TIMELINE_HISTORY_MAX_EVENT_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_EVENT;
export const DEFAULT_TIMELINE_HISTORY_MAX_RESPONSE_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE;

const NORMAL_STRING_BYTES = 4 * 1024;
const TIGHT_STRING_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.FIELD_PREVIEW;
const TOOL_OUTPUT_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.FIELD_PREVIEW;
const TOOL_RAW_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.FIELD_PREVIEW;
const DETAIL_RESPONSE_HEADROOM_BYTES = 16 * 1024;
export const TIMELINE_HISTORY_DETAIL_CANDIDATE_VALUE_MAX_BYTES =
  TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL - DETAIL_RESPONSE_HEADROOM_BYTES;
export const TIMELINE_HISTORY_DETAIL_CANDIDATE_RESPONSE_MAX_BYTES =
  Math.min(256 * 1024, Math.floor(DEFAULT_TIMELINE_HISTORY_MAX_RESPONSE_BYTES / 2));

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
  detailSink?: TimelineHistoryDetailSink;
  collectDetailRefs?: boolean;
}

export interface TimelineHistoryDetailSink {
  put(input: {
    sessionName: string;
    epoch: number;
    eventId: string;
    fieldPath: string;
    value: string;
    previewBytes?: number;
    mediaType?: string;
  }): TimelineDetailRef | undefined;
}

export interface TimelineHistoryDetailCandidate {
  sessionName: string;
  epoch: number;
  eventId: string;
  fieldPath: TimelineDetailFieldPath;
  value: string;
  valueBytes: number;
  valueMaxBytes: number;
  previewBytes: number;
  mediaType?: string;
}

export interface TimelineHistorySanitizeResult {
  events: TimelineEvent[];
  payloadBytes: number;
  droppedEvents: number;
  truncatedEvents: number;
  detailRefs: TimelineDetailRef[];
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

function estimateJsonBytesBounded(
  value: unknown,
  limit = TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
  depth = 0,
): number {
  if (value === null) return 4;
  if (value === undefined) return 0;
  if (typeof value === 'string') return Math.min(limit + 1, value.length * 4 + 2);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return Math.min(limit + 1, String(value).length + 2);
  }
  if (typeof value !== 'object') return Math.min(limit + 1, String(value).length + 2);
  if (depth >= 5) return limit + 1;

  let total = Array.isArray(value) ? 2 : 2;
  let count = 0;
  const add = (bytes: number): boolean => {
    total += bytes;
    return total <= limit;
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (count >= 100) return limit + 1;
      if (!add((count > 0 ? 1 : 0) + estimateJsonBytesBounded(item, Math.max(1, limit - total), depth + 1))) return limit + 1;
      count += 1;
    }
    return total;
  }

  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (count >= 100) return limit + 1;
    if (!add((count > 0 ? 1 : 0) + key.length * 4 + 3)) return limit + 1;
    if (!add(estimateJsonBytesBounded((value as Record<string, unknown>)[key], Math.max(1, limit - total), depth + 1))) return limit + 1;
    count += 1;
  }
  return total;
}

function eventWithPayload(event: TimelineEvent, payload: Record<string, unknown>): TimelineEvent {
  const next: TimelineEvent = {
    eventId: event.eventId,
    sessionId: event.sessionId,
    ts: event.ts,
    seq: event.seq,
    epoch: event.epoch,
    source: event.source,
    confidence: event.confidence,
    type: event.type,
    payload,
  };
  if (event.hidden !== undefined) next.hidden = event.hidden;
  return next;
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
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (count >= policy.maxObjectKeys) {
        stats.truncatedValues += 1;
        break;
      }
      out[key] = sanitizeValue(record[key], policy, stats, depth + 1);
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
  const sdkDetail = parseSdkSubagentDetail(detail);
  if (sdkDetail.kind === 'ok') {
    return sdkDetail.detail;
  }
  if (sdkDetail.kind === 'malformed-sdk') {
    stats.truncatedValues += 1;
    return {
      kind: SDK_SUBAGENT_DETAIL_KIND,
      malformed: true,
      reason: sdkDetail.reason,
    };
  }
  const out: Record<string, unknown> = {};
  const record = detail as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (count >= NORMAL_POLICY.maxObjectKeys) {
      stats.truncatedValues += 1;
      break;
    }
    const value = record[key];
    if (key === 'raw') {
      out[key] = sanitizeValue(value, RAW_POLICY, stats);
    } else if (key === 'output') {
      out[key] = sanitizeValue(value, { ...NORMAL_POLICY, maxStringBytes: TOOL_OUTPUT_BYTES }, stats);
    } else if (key === 'input') {
      out[key] = sanitizeValue(value, { ...NORMAL_POLICY, maxStringBytes: NORMAL_STRING_BYTES }, stats);
    } else {
      out[key] = sanitizeValue(value, NORMAL_POLICY, stats);
    }
    count += 1;
  }
  return out;
}

function isTextTimelineEvent(event: TimelineEvent): boolean {
  return event.type === 'user.message'
    || event.type === 'assistant.text'
    || event.type === 'assistant.thinking';
}

function sanitizeTextPayload(
  payload: Record<string, unknown>,
  stats: MutableSanitizeStats,
  policy: ValuePolicy,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key in payload) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    if (count >= policy.maxObjectKeys) {
      stats.truncatedValues += 1;
      break;
    }
    const value = payload[key];
    out[key] = key === 'text' && typeof value === 'string'
      ? value
      : sanitizeValue(value, policy, stats);
    count += 1;
  }
  return out;
}

function sanitizePayload(event: TimelineEvent, stats: MutableSanitizeStats, policy = NORMAL_POLICY): Record<string, unknown> {
  const payload = event.payload ?? {};
  if (event.type === 'tool.call' || event.type === 'tool.result') {
    const sdkDetail = parseSdkSubagentDetail(payload.detail);
    if (sdkDetail.kind === 'ok') {
      const sdkPayload = buildSdkSubagentTimelinePayload({
        id: event.eventId,
        name: typeof payload.tool === 'string' ? payload.tool : 'Agent',
        status: event.type === 'tool.call'
          ? 'running'
          : sdkDetail.detail.meta.normalizedStatus === 'error' || sdkDetail.detail.meta.normalizedStatus === 'unknown'
            ? 'error'
            : 'complete',
        detail: sdkDetail.detail,
      }, { allowRaw: Boolean(sdkDetail.detail.meta.diagnosticCode) });
      if (sdkPayload) return sdkPayload.payload;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key in payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      if (count >= policy.maxObjectKeys) {
        stats.truncatedValues += 1;
        break;
      }
      const value = payload[key];
      if (key === 'detail') {
        out[key] = sanitizeToolDetail(value, stats);
      } else if (key === 'output') {
        out[key] = sanitizeValue(value, { ...policy, maxStringBytes: TOOL_OUTPUT_BYTES }, stats);
      } else if (key === 'input') {
        out[key] = sanitizeValue(value, { ...policy, maxStringBytes: NORMAL_STRING_BYTES }, stats);
      } else {
        out[key] = sanitizeValue(value, policy, stats);
      }
      count += 1;
    }
    return out;
  }

  if (isTextTimelineEvent(event) && typeof payload.text === 'string') {
    return sanitizeTextPayload(payload, stats, policy);
  }

  return sanitizeValue(payload, policy, stats) as Record<string, unknown>;
}

function minimalPayload(event: TimelineEvent, originalPayloadBytes: number, stats: MutableSanitizeStats): Record<string, unknown> {
  const payload = event.payload ?? {};
  const out: Record<string, unknown> = {
    historyPayloadTruncated: true,
    originalPayloadBytesBucket: bucketBytes(originalPayloadBytes),
  };
  const sdkDetail = parseSdkSubagentDetail(payload.detail);
  if ((event.type === 'tool.call' || event.type === 'tool.result') && sdkDetail.kind === 'ok') {
    if (typeof payload.tool === 'string') out.tool = payload.tool;
    out.detail = buildSdkSubagentMinimalReplayDetail(sdkDetail.detail);
    stats.truncatedValues += 1;
    return out;
  }
  if (isTextTimelineEvent(event) && typeof payload.text === 'string') out.text = payload.text;
  else if (typeof payload.text === 'string') out.text = truncateStringByUtf8Bytes(payload.text, TIGHT_STRING_BYTES);
  if (typeof payload.tool === 'string') out.tool = payload.tool;
  if (typeof payload.error === 'string') out.error = truncateStringByUtf8Bytes(payload.error, TIGHT_STRING_BYTES);
  if (typeof payload.output === 'string') out.output = truncateStringByUtf8Bytes(payload.output, TIGHT_STRING_BYTES);
  stats.truncatedValues += 1;
  return out;
}

function compareTimelineEventsForReplay(a: TimelineEvent, b: TimelineEvent): number {
  return a.ts - b.ts || a.seq - b.seq || a.eventId.localeCompare(b.eventId);
}

function isNewerTimelineEvent(candidate: TimelineEvent, current: TimelineEvent): boolean {
  return compareTimelineEventsForReplay(candidate, current) >= 0;
}

function detailStringAtPath(event: TimelineEvent, fieldPath: string): string | undefined {
  const parts = fieldPath.split('.');
  let current: unknown = event as unknown;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function collectTimelineHistoryDetailCandidates(event: TimelineEvent): TimelineHistoryDetailCandidate[] {
  const fieldCandidates: Array<{ fieldPath: TimelineDetailFieldPath; previewBytes: number; mediaType?: string }> = [
    { fieldPath: TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_OUTPUT, previewBytes: TOOL_OUTPUT_BYTES, mediaType: 'text/plain' },
    { fieldPath: TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_ERROR, previewBytes: TIGHT_STRING_BYTES, mediaType: 'text/plain' },
    { fieldPath: TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_DETAIL_OUTPUT, previewBytes: TOOL_OUTPUT_BYTES, mediaType: 'text/plain' },
  ];
  const candidates: TimelineHistoryDetailCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of fieldCandidates) {
    const value = detailStringAtPath(event, candidate.fieldPath);
    if (value === undefined) continue;
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes <= candidate.previewBytes) continue;
    if (valueBytes > TIMELINE_HISTORY_DETAIL_CANDIDATE_VALUE_MAX_BYTES) continue;
    const duplicateKey = `${valueBytes}:${value.slice(0, 128)}:${value.slice(-128)}`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    candidates.push({
      sessionName: event.sessionId,
      epoch: event.epoch,
      eventId: event.eventId,
      fieldPath: candidate.fieldPath,
      value,
      valueBytes,
      valueMaxBytes: TIMELINE_HISTORY_DETAIL_CANDIDATE_VALUE_MAX_BYTES,
      previewBytes: candidate.previewBytes,
      mediaType: candidate.mediaType,
    });
  }
  return candidates;
}

function collectDetailRefs(event: TimelineEvent, sink: TimelineHistoryDetailSink | undefined): TimelineDetailRef[] {
  if (!sink) return [];
  const refs: TimelineDetailRef[] = [];
  for (const candidate of collectTimelineHistoryDetailCandidates(event)) {
    const ref = sink.put({
      sessionName: candidate.sessionName,
      epoch: candidate.epoch,
      eventId: candidate.eventId,
      fieldPath: candidate.fieldPath,
      value: candidate.value,
      previewBytes: candidate.previewBytes,
      mediaType: candidate.mediaType,
    });
    if (ref) refs.push(ref);
  }
  return refs;
}

function shouldCollectDetailRefsFromSanitizedEvent(event: TimelineEvent): boolean {
  if (event.type !== 'tool.call' && event.type !== 'tool.result') return false;
  const parsed = parseSdkSubagentDetail(event.payload?.detail);
  return parsed.kind !== 'not-sdk';
}

function bucketBytes(bytes: number): string {
  if (bytes < 1024) return '<1KiB';
  if (bytes < 4 * 1024) return '1-4KiB';
  if (bytes < 16 * 1024) return '4-16KiB';
  if (bytes < 64 * 1024) return '16-64KiB';
  if (bytes < 256 * 1024) return '64-256KiB';
  if (bytes < 1024 * 1024) return '256KiB-1MiB';
  return '>1MiB';
}

export function sanitizeTimelineHistoryEventForTransport(
  event: TimelineEvent,
  options: TimelineHistorySanitizeOptions = {},
): { event: TimelineEvent; bytes: number; truncated: boolean; detailRefs: TimelineDetailRef[] } {
  const maxEventBytes = Math.max(1024, Math.trunc(options.maxEventBytes ?? DEFAULT_TIMELINE_HISTORY_MAX_EVENT_BYTES));
  const stats: MutableSanitizeStats = { truncatedValues: 0 };
  const originalPayloadBytes = estimateJsonBytesBounded(event.payload);
  const beforeTruncations = stats.truncatedValues;

  let next = eventWithPayload(event, sanitizePayload(event, stats));
  let bytes = jsonBytes(next);

  if (bytes > maxEventBytes && !isTextTimelineEvent(event)) {
    next = eventWithPayload(event, sanitizePayload(next, stats, TIGHT_POLICY));
    bytes = jsonBytes(next);
  }

  if (bytes > maxEventBytes && !isTextTimelineEvent(event)) {
    next = eventWithPayload(event, minimalPayload(event, originalPayloadBytes, stats));
    bytes = jsonBytes(next);
  }

  const truncated = stats.truncatedValues > beforeTruncations
    || (!isTextTimelineEvent(event) && originalPayloadBytes > maxEventBytes);
  return {
    event: next,
    bytes,
    truncated,
    detailRefs: options.collectDetailRefs === false
      ? []
      : collectDetailRefs(shouldCollectDetailRefsFromSanitizedEvent(event) ? next : event, options.detailSink),
  };
}

export function sanitizeTimelineHistoryEventsForTransport(
  events: readonly TimelineEvent[],
  options: TimelineHistorySanitizeOptions = {},
): TimelineHistorySanitizeResult {
  const maxResponseBytes = Math.max(64 * 1024, Math.trunc(options.maxResponseBytes ?? DEFAULT_TIMELINE_HISTORY_MAX_RESPONSE_BYTES));
  const dedupedByEventId = new Map<string, TimelineEvent>();
  for (const event of events) {
    const current = dedupedByEventId.get(event.eventId);
    if (!current || isNewerTimelineEvent(event, current)) dedupedByEventId.set(event.eventId, event);
  }
  const inputEvents = Array.from(dedupedByEventId.values()).sort(compareTimelineEventsForReplay);
  const selectedEntries: Array<ReturnType<typeof sanitizeTimelineHistoryEventForTransport> & { originalEvent: TimelineEvent }> = [];
  let payloadBytes = 2;
  let droppedEvents = 0;
  let truncatedEvents = 0;

  for (let index = inputEvents.length - 1; index >= 0; index -= 1) {
    const entry = sanitizeTimelineHistoryEventForTransport(inputEvents[index]!, {
      ...options,
      collectDetailRefs: false,
    });
    const nextBytes = payloadBytes + entry.bytes + (selectedEntries.length > 0 ? 1 : 0);
    if (nextBytes > maxResponseBytes && selectedEntries.length > 0) {
      droppedEvents += index + 1;
      break;
    }
    selectedEntries.push({ ...entry, originalEvent: inputEvents[index]! });
    payloadBytes = nextBytes;
    if (entry.truncated) truncatedEvents += 1;
  }
  selectedEntries.reverse();
  const selected = selectedEntries.map((entry) => entry.event);
  const detailRefs = options.detailSink
    ? selectedEntries.flatMap((entry) => collectDetailRefs(
        shouldCollectDetailRefsFromSanitizedEvent(entry.originalEvent) ? entry.event : entry.originalEvent,
        options.detailSink,
      ))
    : [];

  if (droppedEvents > 0) truncatedEvents += droppedEvents;
  return {
    events: selected,
    payloadBytes,
    droppedEvents,
    truncatedEvents,
    detailRefs,
  };
}
