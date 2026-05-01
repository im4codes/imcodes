import {
  MEMORY_COUNTERS,
  MEMORY_SOFT_FAIL_PATH_COUNTERS,
  type MemoryCounter,
  type MemorySoftFailPath,
} from './memory-counters.js';
import { isMemoryFeatureFlag, type MemoryFeatureFlag } from './feature-flags.js';
import { isMemoryOrigin, type MemoryOrigin } from './memory-origin.js';
import { isSendOrigin, type SendOrigin } from './send-origin.js';
import { FINGERPRINT_KINDS, type FingerprintKind } from './memory-fingerprint.js';
import { isObservationClass, type ObservationClass } from './memory-observation.js';
import { isSkillReviewTrigger, type SkillReviewTrigger } from './skill-review-triggers.js';

export const MEMORY_TELEMETRY_LABEL_KEYS = [
  'feature',
  'origin',
  'send_origin',
  'fingerprint_kind',
  'observation_class',
  'skill_review_trigger',
  'outcome',
  'reason',
] as const;

export type MemoryTelemetryLabelKey = (typeof MEMORY_TELEMETRY_LABEL_KEYS)[number];
export type MemoryTelemetryLabels = Partial<Record<MemoryTelemetryLabelKey, string>>;

export const MEMORY_SOFT_FAIL_SURFACES = Object.keys(MEMORY_SOFT_FAIL_PATH_COUNTERS).sort() as MemorySoftFailPath[];
export type MemorySoftFailSurface = MemorySoftFailPath;

export interface MemoryTelemetryEvent {
  counter: MemoryCounter;
  labels: MemoryTelemetryLabels;
  value: number;
  createdAt: number;
}

export interface MemoryTelemetrySink {
  record(event: MemoryTelemetryEvent): Promise<void> | void;
}

export interface MemoryTelemetryBufferOptions {
  maxSize?: number;
  sinkTimeoutMs?: number;
  now?: () => number;
  sink?: MemoryTelemetrySink;
  onDrop?: (event: MemoryTelemetryEvent) => void;
}

const MEMORY_COUNTER_SET: ReadonlySet<string> = new Set(MEMORY_COUNTERS);
const FINGERPRINT_KIND_SET: ReadonlySet<string> = new Set(FINGERPRINT_KINDS);
const MEMORY_TELEMETRY_LABEL_KEY_SET: ReadonlySet<string> = new Set(MEMORY_TELEMETRY_LABEL_KEYS);
const MEMORY_SOFT_FAIL_SURFACE_SET: ReadonlySet<string> = new Set(MEMORY_SOFT_FAIL_SURFACES);
const OUTCOME_VALUES = new Set(['success', 'disabled', 'deduped', 'rejected', 'dropped', 'failed', 'timeout']);
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isFingerprintKind(value: unknown): value is FingerprintKind {
  return typeof value === 'string' && FINGERPRINT_KIND_SET.has(value);
}

export function sanitizeMemoryTelemetryLabels(labels: MemoryTelemetryLabels = {}): MemoryTelemetryLabels {
  const sanitized: MemoryTelemetryLabels = {};
  for (const [rawKey, rawValue] of Object.entries(labels)) {
    if (!MEMORY_TELEMETRY_LABEL_KEY_SET.has(rawKey)) {
      throw new Error(`Unsupported memory telemetry label: ${rawKey}`);
    }
    if (typeof rawValue !== 'string' || rawValue.length === 0) continue;
    const key = rawKey as MemoryTelemetryLabelKey;
    switch (key) {
      case 'feature':
        if (!isMemoryFeatureFlag(rawValue)) throw new Error(`Invalid memory feature telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies MemoryFeatureFlag;
        break;
      case 'origin':
        if (!isMemoryOrigin(rawValue)) throw new Error(`Invalid memory origin telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies MemoryOrigin;
        break;
      case 'send_origin':
        if (!isSendOrigin(rawValue)) throw new Error(`Invalid send origin telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies SendOrigin;
        break;
      case 'fingerprint_kind':
        if (!isFingerprintKind(rawValue)) throw new Error(`Invalid fingerprint kind telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies FingerprintKind;
        break;
      case 'observation_class':
        if (!isObservationClass(rawValue)) throw new Error(`Invalid observation class telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies ObservationClass;
        break;
      case 'skill_review_trigger':
        if (!isSkillReviewTrigger(rawValue)) throw new Error(`Invalid skill review trigger telemetry label: ${rawValue}`);
        sanitized[key] = rawValue satisfies SkillReviewTrigger;
        break;
      case 'outcome':
        if (!OUTCOME_VALUES.has(rawValue)) throw new Error(`Invalid memory telemetry outcome: ${rawValue}`);
        sanitized[key] = rawValue;
        break;
      case 'reason':
        if (!REASON_PATTERN.test(rawValue)) throw new Error(`Invalid memory telemetry reason: ${rawValue}`);
        sanitized[key] = rawValue;
        break;
    }
  }
  return sanitized;
}

export function isMemorySoftFailSurface(value: unknown): value is MemorySoftFailSurface {
  return typeof value === 'string' && MEMORY_SOFT_FAIL_SURFACE_SET.has(value);
}

export function counterForMemorySoftFailSurface(surface: MemorySoftFailSurface): MemoryCounter {
  return MEMORY_SOFT_FAIL_PATH_COUNTERS[surface];
}

export function recordMemorySoftFailure(
  telemetry: Pick<MemoryTelemetryBuffer, 'enqueue'> | undefined,
  surface: MemorySoftFailSurface,
  reason: string,
  labels: MemoryTelemetryLabels = {},
): boolean {
  if (!telemetry) return false;
  return telemetry.enqueue(counterForMemorySoftFailSurface(surface), {
    ...labels,
    outcome: labels.outcome ?? 'failed',
    reason,
  });
}

export class MemoryTelemetryBuffer {
  private readonly maxSize: number;
  private readonly sinkTimeoutMs: number;
  private readonly now: () => number;
  private readonly sink?: MemoryTelemetrySink;
  private readonly onDrop?: (event: MemoryTelemetryEvent) => void;
  private queue: MemoryTelemetryEvent[] = [];
  private flushing = false;

  constructor(options: MemoryTelemetryBufferOptions = {}) {
    this.maxSize = Math.max(1, options.maxSize ?? 256);
    this.sinkTimeoutMs = Math.max(1, options.sinkTimeoutMs ?? 250);
    this.now = options.now ?? Date.now;
    this.sink = options.sink;
    this.onDrop = options.onDrop;
  }

  get size(): number {
    return this.queue.length;
  }

  enqueue(counter: MemoryCounter, labels: MemoryTelemetryLabels = {}, value = 1): boolean {
    if (!MEMORY_COUNTER_SET.has(counter)) {
      throw new Error(`Unsupported memory counter: ${counter}`);
    }
    const event: MemoryTelemetryEvent = {
      counter,
      labels: sanitizeMemoryTelemetryLabels(labels),
      value,
      createdAt: this.now(),
    };
    if (this.queue.length >= this.maxSize) {
      this.onDrop?.(event);
      return false;
    }
    this.queue.push(event);
    void this.flush();
    return true;
  }

  drain(): MemoryTelemetryEvent[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.sink) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (!event) break;
        try {
          await Promise.race([
            Promise.resolve(this.sink.record(event)),
            new Promise<void>((resolve) => setTimeout(resolve, this.sinkTimeoutMs)),
          ]);
        } catch {
          // Telemetry is explicitly best-effort; sink failure must not affect memory behavior.
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
