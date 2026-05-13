import { randomUUID } from 'node:crypto';
import { TIMELINE_DETAIL_ERROR_REASONS, type TimelineDetailErrorReason } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import type { TimelineDetailRef } from '../../shared/timeline-protocol.js';

const DEFAULT_DETAIL_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DETAIL_RESPONSE_HEADROOM_BYTES = 16 * 1024;
export const TIMELINE_DETAIL_VALUE_MAX_BYTES =
  TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL - DETAIL_RESPONSE_HEADROOM_BYTES;

export interface TimelineDetailStorePutInput {
  sessionName: string;
  epoch: number;
  generation?: string;
  eventId: string;
  fieldPath: string;
  value: string;
  previewBytes?: number;
  mediaType?: string;
}

export interface TimelineDetailStoreGetInput {
  sessionName: string;
  epoch: number;
  generation?: string;
  detailStoreGeneration?: string;
  detailId: string;
  eventId?: string;
  fieldPath?: string;
}

export interface TimelineDetailStoreEntry {
  detailId: string;
  sessionName: string;
  epoch: number;
  generation: string;
  eventId: string;
  fieldPath: string;
  value?: string;
  valueBytes: number;
  previewBytes?: number;
  mediaType?: string;
  expiresAt: number;
  oversized: boolean;
}

export type TimelineDetailStoreGetResult =
  | { ok: true; entry: TimelineDetailStoreEntry }
  | { ok: false; reason: TimelineDetailErrorReason };

export interface TimelineDetailStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export class TimelineDetailStore {
  readonly generation: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, TimelineDetailStoreEntry>();
  private totalBytes = 0;

  constructor(options: TimelineDetailStoreOptions = {}) {
    this.generation = `tdg_${randomUUID()}`;
    this.ttlMs = Math.max(1, Math.trunc(options.ttlMs ?? DEFAULT_DETAIL_TTL_MS));
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.maxTotalBytes = Math.max(0, Math.trunc(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES));
    this.now = options.now ?? (() => Date.now());
  }

  put(input: TimelineDetailStorePutInput): TimelineDetailRef | undefined {
    if (!input.sessionName || !input.eventId || !input.fieldPath) return undefined;
    const valueBytes = Buffer.byteLength(input.value, 'utf8');
    const expiresAt = this.now() + this.ttlMs;
    const entry: TimelineDetailStoreEntry = {
      detailId: `td_${randomUUID()}`,
      sessionName: input.sessionName,
      epoch: input.epoch,
      generation: input.generation ?? this.generation,
      eventId: input.eventId,
      fieldPath: input.fieldPath,
      value: valueBytes <= TIMELINE_DETAIL_VALUE_MAX_BYTES ? input.value : undefined,
      valueBytes,
      previewBytes: input.previewBytes,
      mediaType: input.mediaType,
      expiresAt,
      oversized: valueBytes > TIMELINE_DETAIL_VALUE_MAX_BYTES,
    };
    this.entries.set(entry.detailId, entry);
    this.totalBytes += entry.value ? valueBytes : 0;
    this.evictExpired();
    this.evictToBounds();
    return {
      detailId: entry.detailId,
      sessionName: entry.sessionName,
      epoch: entry.epoch,
      detailStoreGeneration: entry.generation,
      eventId: entry.eventId,
      fieldPath: entry.fieldPath,
      previewBytes: entry.previewBytes,
      expiresAt: entry.expiresAt,
      mediaType: entry.mediaType,
    };
  }

  get(input: TimelineDetailStoreGetInput): TimelineDetailStoreGetResult {
    const entry = this.entries.get(input.detailId);
    if (!entry) {
      this.evictExpired();
      return { ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING };
    }
    if (entry.expiresAt <= this.now()) {
      this.delete(input.detailId);
      return { ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.EXPIRED };
    }
    const inputGeneration = input.detailStoreGeneration ?? input.generation;
    if (
      entry.sessionName !== input.sessionName
      || entry.epoch !== input.epoch
      || (inputGeneration !== undefined && entry.generation !== inputGeneration)
    ) {
      return { ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING };
    }
    if (
      (input.eventId !== undefined && input.eventId !== entry.eventId)
      || (input.fieldPath !== undefined && input.fieldPath !== entry.fieldPath)
    ) {
      return { ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.MISSING };
    }
    if (entry.oversized || entry.value === undefined) {
      return { ok: false, reason: TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED };
    }
    this.entries.delete(entry.detailId);
    this.entries.set(entry.detailId, entry);
    return { ok: true, entry };
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private delete(detailId: string): void {
    const entry = this.entries.get(detailId);
    if (!entry) return;
    this.entries.delete(detailId);
    if (entry.value) this.totalBytes -= Buffer.byteLength(entry.value, 'utf8');
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [detailId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(detailId);
    }
  }

  private evictToBounds(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
    }
  }
}

const defaultTimelineDetailStore = new TimelineDetailStore();

export function getDefaultTimelineDetailStore(): TimelineDetailStore {
  return defaultTimelineDetailStore;
}
