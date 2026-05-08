import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';
import {
  SKILL_AUTO_CREATION_FEATURE_FLAG,
  decideSkillReviewClaim,
  decideSkillReviewSchedule,
  makeSkillReviewDailyCountKey,
  nextSkillReviewRetryAt,
  repairSkillReviewJob,
} from '../../shared/skill-review-scheduler.js';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator, type MaterializationSkillReviewJob } from '../../src/context/materialization-coordinator.js';
import { LocalSkillReviewWorker } from '../../src/context/skill-review-worker.js';
import type { CompressionInput, CompressionResult } from '../../src/context/summary-compressor.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';

void SKILL_AUTO_CREATION_FEATURE_FLAG;

const emptyState = {
  pendingKeys: new Set<string>(),
  lastRunByScope: new Map<string, number>(),
  dailyCountByScope: new Map<string, number>(),
};

async function successfulCompressor(input: CompressionInput): Promise<CompressionResult> {
  return {
    summary: `## User Problem\nObserved useful workflow\n\n## Resolution\nCompressed ${input.events.length} post-response events.`,
    model: 'test-model',
    backend: 'test',
    usedBackup: false,
    fromSdk: true,
  };
}

describe('background skill review scheduler', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    resetMetricsForTests();
    tempDir = await createIsolatedSharedContextDb('skill-review-scheduler');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('enqueues only after response delivery and valid trigger', () => {
    const decision = decideSkillReviewSchedule({
      featureEnabled: true,
      delivered: true,
      phase: 'post_response_background',
      trigger: 'tool_iteration_count',
      scopeKey: 'personal:u1:repo',
      responseId: 'r1',
      now: 1000,
      state: emptyState,
      triggerEvidence: { toolIterationCount: 10 },
    });
    expect(decision).toMatchObject({ action: 'enqueue', nextAttemptAt: 1000, maxAttempts: 4 });
  });

  it('requires real tool-iteration evidence before scheduling automatic skill review', () => {
    expect(decideSkillReviewSchedule({
      featureEnabled: true,
      delivered: true,
      phase: 'post_response_background',
      trigger: 'tool_iteration_count',
      scopeKey: 'personal:u1:repo',
      responseId: 'r1',
      now: 1000,
      state: emptyState,
      triggerEvidence: { toolIterationCount: 9 },
    })).toEqual({ action: 'skip', reason: 'below_trigger_threshold' });

    expect(decideSkillReviewSchedule({
      featureEnabled: true,
      delivered: true,
      phase: 'post_response_background',
      trigger: 'manual_review',
      scopeKey: 'personal:u1:repo',
      responseId: 'r2',
      now: 1000,
      state: emptyState,
    })).toMatchObject({ action: 'enqueue' });
  });

  it('skips disabled, foreground/not-delivered, shutdown, invalid, coalesced, min-interval, and daily-cap cases', () => {
    expect(decideSkillReviewSchedule({ featureEnabled: false, delivered: true, trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'disabled' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, phase: 'send_ack', trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'not_background' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, phase: 'provider_delivery', trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'not_background' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, phase: 'stop', trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'not_background' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, phase: 'approval_feedback', trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'not_background' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: false, trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'not_delivered' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, shuttingDown: true, trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'shutdown' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, phase: 'shutdown', trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'shutdown' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, trigger: 'timer', scopeKey: 's', responseId: 'r', now: 1, state: emptyState })).toEqual({ action: 'skip', reason: 'invalid_trigger' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, trigger: 'manual_review', scopeKey: 's', responseId: 'r', now: 1, state: { ...emptyState, pendingKeys: new Set(['skill-review:v1\u0000s\u0000r\u0000manual_review']) } })).toEqual({ action: 'skip', reason: 'coalesced' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, trigger: 'manual_review', scopeKey: 's', responseId: 'r2', now: 100, state: { ...emptyState, runningCountByScope: new Map([['s', 1]]) } })).toEqual({ action: 'skip', reason: 'per_scope_concurrency' });
    expect(decideSkillReviewSchedule({ featureEnabled: true, delivered: true, trigger: 'manual_review', scopeKey: 's', responseId: 'r2', now: 100, state: { ...emptyState, lastRunByScope: new Map([['s', 50]]) } })).toEqual({ action: 'skip', reason: 'min_interval' });
    expect(decideSkillReviewSchedule({
      featureEnabled: true,
      delivered: true,
      trigger: 'manual_review',
      scopeKey: 's',
      responseId: 'r3',
      now: 100,
      state: { ...emptyState, dailyCountByScope: new Map([[makeSkillReviewDailyCountKey({ scopeKey: 's', now: 100 }), MEMORY_DEFAULTS.skillReviewDailyLimit]]) },
    })).toEqual({ action: 'skip', reason: 'daily_cap' });
  });

  it('applies daily cap only within the current day bucket', () => {
    const dayOne = Date.UTC(2026, 0, 1, 12);
    const dayTwo = Date.UTC(2026, 0, 2, 12);
    const cappedYesterday = {
      ...emptyState,
      dailyCountByScope: new Map([[makeSkillReviewDailyCountKey({ scopeKey: 's', now: dayOne }), MEMORY_DEFAULTS.skillReviewDailyLimit]]),
    };

    expect(decideSkillReviewSchedule({
      featureEnabled: true,
      delivered: true,
      trigger: 'manual_review',
      scopeKey: 's',
      responseId: 'r-day2',
      now: dayTwo,
      state: cappedYesterday,
    })).toMatchObject({ action: 'enqueue' });
  });

  it('uses bounded exponential retry/backoff', () => {
    expect(nextSkillReviewRetryAt(1000, 0, { backoffBaseMs: 10, maxRetries: 3 })).toBe(1010);
    expect(nextSkillReviewRetryAt(1000, 9, { backoffBaseMs: 10, maxRetries: 3 })).toBe(1080);
  });

  it('claims due jobs with per-scope concurrency and never claims during shutdown or disabled mode', () => {
    const job = {
      idempotencyKey: 'job-1',
      scopeKey: 'scope-a',
      state: 'pending' as const,
      attempt: 0,
      updatedAt: 1000,
      nextAttemptAt: 1000,
    };

    expect(decideSkillReviewClaim({
      featureEnabled: true,
      job,
      now: 1000,
      runningCountByScope: new Map(),
    })).toEqual({
      action: 'claim',
      state: 'running',
      attempt: 0,
      claimedAt: 1000,
    });
    expect(decideSkillReviewClaim({
      featureEnabled: false,
      job,
      now: 1000,
      runningCountByScope: new Map(),
    })).toEqual({ action: 'skip', reason: 'disabled' });
    expect(decideSkillReviewClaim({
      featureEnabled: true,
      shuttingDown: true,
      job,
      now: 1000,
      runningCountByScope: new Map(),
    })).toEqual({ action: 'skip', reason: 'shutdown' });
    expect(decideSkillReviewClaim({
      featureEnabled: true,
      job,
      now: 1000,
      runningCountByScope: new Map([['scope-a', 1]]),
    })).toEqual({ action: 'skip', reason: 'per_scope_concurrency' });
  });

  it('repairs stale running jobs with bounded retry/backoff', () => {
    expect(repairSkillReviewJob({
      job: {
        idempotencyKey: 'job-1',
        scopeKey: 'scope-a',
        state: 'running',
        attempt: 1,
        updatedAt: 1000,
      },
      now: 2000,
      policy: { staleRunningMs: 500, backoffBaseMs: 10, maxRetries: 3 },
    })).toEqual({
      idempotencyKey: 'job-1',
      action: 'retry',
      state: 'retry_wait',
      nextAttemptAt: 2040,
    });

    expect(repairSkillReviewJob({
      job: {
        idempotencyKey: 'job-2',
        scopeKey: 'scope-a',
        state: 'running',
        attempt: 3,
        updatedAt: 1000,
      },
      now: 2000,
      policy: { staleRunningMs: 500, maxRetries: 3 },
    })).toEqual({
      idempotencyKey: 'job-2',
      action: 'fail',
      state: 'failed',
    });
  });

  it('is scheduled only from the post-response materialization background path and never blocks on job enqueue', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const neverSettles = new Promise<void>(() => {});
    const coordinator = new MaterializationCoordinator({
      compressor: successfulCompressor,
      thresholds: { minIntervalMs: 0 },
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => emptyState,
        enqueue: (job) => {
          enqueued.push(job);
          return neverSettles;
        },
      },
    });

    coordinator.ingestEvent({ id: 'user-1', target, eventType: 'user.turn', content: 'I keep iterating on tools.', createdAt: 100 });
    coordinator.ingestEvent({ id: 'assistant-1', target, eventType: 'assistant.text', content: 'Done after several tool loops.', createdAt: 101 });
    coordinator.recordSkillReviewToolIteration(target, 10);

    const result = await Promise.race([
      coordinator.materializeTarget(target, 'manual', 200).then(() => 'completed' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    expect(result).toBe('completed');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      trigger: 'tool_iteration_count',
      responseId: 'assistant-1',
      projectionId: expect.any(String),
      nextAttemptAt: 200,
      maxAttempts: 4,
    });
  });

  it('does not schedule automatic skill review when materialization lacks enough tool iterations', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const coordinator = new MaterializationCoordinator({
      compressor: successfulCompressor,
      thresholds: { minIntervalMs: 0 },
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => emptyState,
        enqueue: (job) => { enqueued.push(job); },
      },
    });

    coordinator.ingestEvent({ id: 'user-low-tools', target, eventType: 'user.turn', content: 'Small workflow.', createdAt: 100 });
    coordinator.ingestEvent({ id: 'assistant-low-tools', target, eventType: 'assistant.text', content: 'Done.', createdAt: 101 });
    coordinator.recordSkillReviewToolIteration(target, 9);
    await coordinator.materializeTarget(target, 'manual', 200);

    expect(enqueued).toEqual([]);
    expect(getCounter('mem.skill.review_not_eligible', { reason: 'below_trigger_threshold' })).toBe(1);
    expect(getCounter('mem.skill.review_throttled', { reason: 'below_trigger_threshold' })).toBe(0);

    coordinator.ingestEvent({ id: 'user-more-tools', target, eventType: 'user.turn', content: 'Continue workflow.', createdAt: 300 });
    coordinator.ingestEvent({ id: 'assistant-more-tools', target, eventType: 'assistant.text', content: 'Done again.', createdAt: 301 });
    coordinator.recordSkillReviewToolIteration(target, 1);
    await coordinator.materializeTarget(target, 'manual', 400);

    expect(enqueued).toHaveLength(0);

    coordinator.ingestEvent({ id: 'user-enough-tools', target, eventType: 'user.turn', content: 'Continue workflow again.', createdAt: 500 });
    coordinator.ingestEvent({ id: 'assistant-enough-tools', target, eventType: 'assistant.text', content: 'Done again.', createdAt: 501 });
    coordinator.recordSkillReviewToolIteration(target, 10);
    await coordinator.materializeTarget(target, 'manual', 600);

    expect(enqueued).toHaveLength(1);
  });

  it('does not schedule skill review for disabled features or failed compression', async () => {
    const enqueued: MaterializationSkillReviewJob[] = [];
    const disabledCoordinator = new MaterializationCoordinator({
      compressor: successfulCompressor,
      thresholds: { minIntervalMs: 0 },
      skillReviewScheduler: {
        featureEnabled: false,
        getState: () => emptyState,
        enqueue: (job) => { enqueued.push(job); },
      },
    });
    disabledCoordinator.ingestEvent({ id: 'user-disabled', target, eventType: 'user.turn', content: 'x', createdAt: 100 });
    disabledCoordinator.ingestEvent({ id: 'assistant-disabled', target, eventType: 'assistant.text', content: 'y', createdAt: 101 });
    disabledCoordinator.recordSkillReviewToolIteration(target, 10);
    await disabledCoordinator.materializeTarget(target, 'manual', 200);

    const failingCoordinator = new MaterializationCoordinator({
      compressor: async () => ({
        summary: 'local fallback must not commit',
        model: 'local-fallback',
        backend: 'none',
        usedBackup: false,
        fromSdk: false,
      }),
      thresholds: { minIntervalMs: 0 },
      skillReviewScheduler: {
        featureEnabled: true,
        getState: () => emptyState,
        enqueue: (job) => { enqueued.push(job); },
      },
    });
    failingCoordinator.ingestEvent({ id: 'user-failed', target, eventType: 'user.turn', content: 'x', createdAt: 300 });
    failingCoordinator.ingestEvent({ id: 'assistant-failed', target, eventType: 'assistant.text', content: 'y', createdAt: 301 });
    failingCoordinator.recordSkillReviewToolIteration(target, 10);
    await failingCoordinator.materializeTarget(target, 'manual', 400);

    expect(enqueued).toEqual([]);
  });

  it('production local worker creates or updates deterministic user-level skill files in the background lane', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'skill-review-home-'));
    try {
      const projection = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['assistant-1'],
        summary: 'Prefer retrying transient provider failures once before surfacing them.',
        content: { targetKind: 'session', sessionName: target.sessionName },
      });
      const worker = new LocalSkillReviewWorker({ homeDir, featureEnabled: true });
      worker.enqueue({
        idempotencyKey: 'skill-review:test',
        scopeKey: 'personal:user-1:github.com/acme/repo',
        responseId: 'assistant-1',
        trigger: 'manual_review',
        target,
        projectionId: projection.id,
        sourceEventIds: ['assistant-1'],
        nextAttemptAt: 1,
        maxAttempts: 1,
        createdAt: 1,
      });
      await worker.drainDueJobsForTests(2);

      const expectedPath = join(homeDir, '.imcodes', 'skills', 'learned');
      const files = await import('node:fs/promises').then((fs) => fs.readdir(expectedPath));
      expect(files).toHaveLength(1);
      const markdown = await readFile(join(expectedPath, files[0]!), 'utf8');
      expect(markdown).toContain('schemaVersion: 1');
      expect(markdown).toContain('category: learned');
      expect(markdown).toContain('Prefer retrying transient provider failures');

      worker.enqueue({
        idempotencyKey: 'skill-review:test-update',
        scopeKey: 'personal:user-1:github.com/acme/repo',
        responseId: 'assistant-2',
        trigger: 'manual_review',
        target,
        projectionId: projection.id,
        sourceEventIds: ['assistant-2'],
        nextAttemptAt: 3,
        maxAttempts: 1,
        createdAt: 3,
      });
      await worker.drainDueJobsForTests(4);
      const filesAfterUpdate = await import('node:fs/promises').then((fs) => fs.readdir(expectedPath));
      expect(filesAfterUpdate).toEqual(files);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
