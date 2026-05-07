import { describe, expect, it } from 'vitest';
import {
  PreviewReadAdmissionController,
  PREVIEW_READ_WORKER_LIMITS,
} from '../../src/daemon/file-preview-read-admission.js';

describe('PreviewReadAdmissionController', () => {
  it('clamps workersTarget to the v1 1..4 range', () => {
    expect(new PreviewReadAdmissionController({ workersTarget: 0 }).workersTarget).toBe(1);
    expect(new PreviewReadAdmissionController({ workersTarget: 9 }).workersTarget).toBe(4);
    expect(new PreviewReadAdmissionController().workersTarget).toBe(PREVIEW_READ_WORKER_LIMITS.DEFAULT_WORKERS_TARGET);
  });

  it('uses the documented projected-wait formula exactly', () => {
    const admission = new PreviewReadAdmissionController({
      workersTarget: 2,
      tEstimateMs: 1500,
      deadlineMs: 18_000,
      safetyMarginMs: 2_000,
      queueCap: 32,
    });

    const decision = admission.decide(3);

    expect(decision.admitted).toBe(true);
    expect(decision.projectedWaitMs).toBe(((3 + 1) * 1500) / 2);
    expect(decision.projectedTotalMs).toBe((((3 + 1) * 1500) / 2) + 1500);
    expect(decision.availableBudgetMs).toBe(16_000);
  });

  it('keeps the default daemon deadline below the server bridge pending timeout', () => {
    expect(PREVIEW_READ_WORKER_LIMITS.DEFAULT_DEADLINE_MS).toBe(18_000);
    expect(PREVIEW_READ_WORKER_LIMITS.DEFAULT_DEADLINE_MS).toBeLessThan(20_000);
  });

  it('rejects at the deterministic boundary with preview-worker queue-full semantics', () => {
    const admission = new PreviewReadAdmissionController({
      workersTarget: 1,
      tEstimateMs: 8000,
      deadlineMs: 18_000,
      safetyMarginMs: 2_000,
      queueCap: 32,
    });

    expect(admission.decide(0).admitted).toBe(true);
    expect(admission.decide(1)).toMatchObject({
      admitted: false,
      reason: 'projected_wait',
      projectedTotalMs: 24_000,
      availableBudgetMs: 16_000,
    });
  });

  it('applies queue cap as an upper-bound safeguard', () => {
    const admission = new PreviewReadAdmissionController({
      workersTarget: 4,
      tEstimateMs: 1,
      deadlineMs: 18_000,
      safetyMarginMs: 2_000,
      queueCap: 2,
    });

    expect(admission.decide(1).admitted).toBe(true);
    expect(admission.decide(2)).toMatchObject({ admitted: false, reason: 'queue_cap' });
  });

  it('uses a rolling median of the last completed jobs', () => {
    const admission = new PreviewReadAdmissionController({
      tEstimateMs: 1500,
      estimateSampleSize: 4,
    });

    expect(admission.tEstimateMs).toBe(1500);
    for (const duration of [100, 300, 500, 700]) admission.recordJobDuration(duration);
    expect(admission.tEstimateMs).toBe(400);
    admission.recordJobDuration(900);
    expect(admission.tEstimateMs).toBe(600);
  });
});
