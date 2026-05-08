import {
  DEFAULT_PREVIEW_READ_WORKERS_TARGET,
  DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP,
  HARD_MAX_PREVIEW_READ_WORKERS,
  MIN_PREVIEW_READ_WORKERS_TARGET,
} from './file-preview-read-types.js';

export const DEFAULT_PREVIEW_READ_DEADLINE_MS = 18_000;
export const DEFAULT_PREVIEW_READ_SAFETY_MARGIN_MS = 2_000;
export const DEFAULT_PREVIEW_READ_T_ESTIMATE_MS = 1_500;
export const DEFAULT_PREVIEW_READ_ESTIMATE_SAMPLE_SIZE = 16;
export const DEFAULT_PREVIEW_READ_ATTACHED_CAP = 32;

export interface PreviewReadClock {
  now(): number;
}

export interface PreviewReadAdmissionOptions {
  workersTarget?: number;
  queueCap?: number;
  attachedCap?: number;
  deadlineMs?: number;
  safetyMarginMs?: number;
  tEstimateMs?: number;
  estimateSampleSize?: number;
  clock?: PreviewReadClock;
}

export type PreviewReadAdmissionRejectReason = 'queue_cap' | 'projected_wait';

export interface PreviewReadAdmissionDecision {
  admitted: boolean;
  projectedWaitMs: number;
  projectedTotalMs: number;
  availableBudgetMs: number;
  reason?: PreviewReadAdmissionRejectReason;
}

const systemClock: PreviewReadClock = { now: () => Date.now() };

export class PreviewReadAdmissionController {
  readonly workersTarget: number;
  readonly queueCap: number;
  readonly attachedCap: number;
  readonly deadlineMs: number;
  readonly safetyMarginMs: number;
  readonly estimateSampleSize: number;
  readonly clock: PreviewReadClock;
  private readonly completedDurationsMs: number[] = [];
  private seededEstimateMs: number;

  constructor(options: PreviewReadAdmissionOptions = {}) {
    this.workersTarget = clampPreviewReadWorkersTarget(options.workersTarget ?? DEFAULT_PREVIEW_READ_WORKERS_TARGET);
    this.queueCap = Math.max(0, Math.trunc(options.queueCap ?? DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP));
    this.attachedCap = Math.max(1, Math.trunc(options.attachedCap ?? DEFAULT_PREVIEW_READ_ATTACHED_CAP));
    this.deadlineMs = Math.max(1, Math.trunc(options.deadlineMs ?? DEFAULT_PREVIEW_READ_DEADLINE_MS));
    this.safetyMarginMs = Math.max(0, Math.trunc(options.safetyMarginMs ?? DEFAULT_PREVIEW_READ_SAFETY_MARGIN_MS));
    this.seededEstimateMs = Math.max(1, Math.trunc(options.tEstimateMs ?? DEFAULT_PREVIEW_READ_T_ESTIMATE_MS));
    this.estimateSampleSize = Math.max(1, Math.trunc(options.estimateSampleSize ?? DEFAULT_PREVIEW_READ_ESTIMATE_SAMPLE_SIZE));
    this.clock = options.clock ?? systemClock;
  }

  get tEstimateMs(): number {
    if (this.completedDurationsMs.length === 0) return this.seededEstimateMs;
    const sorted = [...this.completedDurationsMs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid]!;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  setTestEstimateMs(value: number): void {
    this.completedDurationsMs.length = 0;
    this.seededEstimateMs = Math.max(1, Math.trunc(value));
  }

  recordJobDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.completedDurationsMs.push(durationMs);
    while (this.completedDurationsMs.length > this.estimateSampleSize) {
      this.completedDurationsMs.shift();
    }
  }

  decide(queueDepth: number): PreviewReadAdmissionDecision {
    const boundedQueueDepth = Math.max(0, Math.trunc(queueDepth));
    const projectedWaitMs = ((boundedQueueDepth + 1) * this.tEstimateMs) / this.workersTarget;
    const projectedTotalMs = projectedWaitMs + this.tEstimateMs;
    const availableBudgetMs = this.deadlineMs - this.safetyMarginMs;

    if (boundedQueueDepth >= this.queueCap) {
      return {
        admitted: false,
        projectedWaitMs,
        projectedTotalMs,
        availableBudgetMs,
        reason: 'queue_cap',
      };
    }

    if (projectedTotalMs > availableBudgetMs) {
      return {
        admitted: false,
        projectedWaitMs,
        projectedTotalMs,
        availableBudgetMs,
        reason: 'projected_wait',
      };
    }

    return {
      admitted: true,
      projectedWaitMs,
      projectedTotalMs,
      availableBudgetMs,
    };
  }

  deadlineFromNow(now = this.clock.now()): { admittedAt: number; deadlineAt: number } {
    return { admittedAt: now, deadlineAt: now + this.deadlineMs };
  }
}

export const PREVIEW_READ_WORKER_LIMITS = {
  DEFAULT_WORKERS_TARGET: DEFAULT_PREVIEW_READ_WORKERS_TARGET,
  MIN_WORKERS_TARGET: MIN_PREVIEW_READ_WORKERS_TARGET,
  HARD_MAX_WORKERS: HARD_MAX_PREVIEW_READ_WORKERS,
  DEFAULT_QUEUE_CAP: DEFAULT_PREVIEW_READ_POOL_QUEUE_CAP,
  DEFAULT_ATTACHED_CAP: DEFAULT_PREVIEW_READ_ATTACHED_CAP,
  DEFAULT_DEADLINE_MS: DEFAULT_PREVIEW_READ_DEADLINE_MS,
  DEFAULT_SAFETY_MARGIN_MS: DEFAULT_PREVIEW_READ_SAFETY_MARGIN_MS,
  DEFAULT_T_ESTIMATE_MS: DEFAULT_PREVIEW_READ_T_ESTIMATE_MS,
} as const;

function clampPreviewReadWorkersTarget(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_PREVIEW_READ_WORKERS_TARGET;
  return Math.min(
    HARD_MAX_PREVIEW_READ_WORKERS,
    Math.max(MIN_PREVIEW_READ_WORKERS_TARGET, Math.trunc(value as number)),
  );
}
