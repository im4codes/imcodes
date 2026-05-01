import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import { MEMORY_DEFAULTS } from './memory-defaults.js';
import { isSkillReviewTrigger, type SkillReviewTrigger } from './skill-review-triggers.js';

export const SKILL_AUTO_CREATION_FEATURE_FLAG = MEMORY_FEATURE_FLAGS_BY_NAME.skillAutoCreation;

export interface SkillReviewSchedulerPolicy {
  minIntervalMs: number;
  dailyCap: number;
  maxRetries: number;
  backoffBaseMs: number;
  maxConcurrentPerScope: number;
  staleRunningMs: number;
  toolIterationThreshold: number;
}

export const DEFAULT_SKILL_REVIEW_SCHEDULER_POLICY: SkillReviewSchedulerPolicy = {
  minIntervalMs: MEMORY_DEFAULTS.skillReviewMinIntervalMs,
  dailyCap: MEMORY_DEFAULTS.skillReviewDailyLimit,
  maxRetries: 3,
  backoffBaseMs: 60 * 1000,
  maxConcurrentPerScope: 1,
  staleRunningMs: 15 * 60 * 1000,
  toolIterationThreshold: MEMORY_DEFAULTS.skillReviewToolIterationThreshold,
};

export const SKILL_REVIEW_SCHEDULE_PHASES = [
  'send_ack',
  'provider_delivery',
  'post_response_background',
  'stop',
  'approval_feedback',
  'shutdown',
] as const;

export type SkillReviewSchedulePhase = (typeof SKILL_REVIEW_SCHEDULE_PHASES)[number];

export const SKILL_REVIEW_JOB_STATES = [
  'pending',
  'running',
  'succeeded',
  'retry_wait',
  'failed',
] as const;

export type SkillReviewJobState = (typeof SKILL_REVIEW_JOB_STATES)[number];

export interface SkillReviewState {
  pendingKeys: ReadonlySet<string>;
  lastRunByScope: ReadonlyMap<string, number>;
  dailyCountByScope: ReadonlyMap<string, number>;
  runningCountByScope?: ReadonlyMap<string, number>;
}

export interface SkillReviewScheduleInput {
  featureEnabled: boolean;
  delivered: boolean;
  shuttingDown?: boolean;
  trigger: SkillReviewTrigger | string;
  scopeKey: string;
  responseId: string;
  now: number;
  state: SkillReviewState;
  policy?: Partial<SkillReviewSchedulerPolicy>;
  phase?: SkillReviewSchedulePhase;
  triggerEvidence?: {
    toolIterationCount?: number;
  };
}

export type SkillReviewScheduleDecision =
  | { action: 'skip'; reason: 'disabled' | 'not_delivered' | 'not_background' | 'shutdown' | 'invalid_trigger' | 'below_trigger_threshold' | 'coalesced' | 'min_interval' | 'daily_cap' | 'per_scope_concurrency' }
  | { action: 'enqueue'; idempotencyKey: string; nextAttemptAt: number; maxAttempts: number };

export interface SkillReviewJobSnapshot {
  idempotencyKey: string;
  scopeKey: string;
  state: SkillReviewJobState;
  attempt: number;
  updatedAt: number;
  nextAttemptAt?: number;
}

export type SkillReviewClaimDecision =
  | { action: 'skip'; reason: 'disabled' | 'shutdown' | 'not_due' | 'not_pending' | 'per_scope_concurrency' | 'attempts_exhausted' }
  | { action: 'claim'; state: 'running'; attempt: number; claimedAt: number };

export interface SkillReviewRepairDecision {
  idempotencyKey: string;
  action: 'keep' | 'retry' | 'fail';
  state: SkillReviewJobState;
  nextAttemptAt?: number;
}

function policyWithDefaults(policy?: Partial<SkillReviewSchedulerPolicy>): SkillReviewSchedulerPolicy {
  return { ...DEFAULT_SKILL_REVIEW_SCHEDULER_POLICY, ...policy };
}

export function makeSkillReviewIdempotencyKey(input: { scopeKey: string; responseId: string; trigger: SkillReviewTrigger }): string {
  return ['skill-review:v1', input.scopeKey.trim(), input.responseId.trim(), input.trigger].join('\u0000');
}

export function makeSkillReviewDailyCountKey(input: { scopeKey: string; now: number }): string {
  const day = new Date(input.now).toISOString().slice(0, 10);
  return ['skill-review:daily:v1', input.scopeKey.trim(), day].join('\u0000');
}

/** Skill auto-creation is post-delivery background work only; it never runs in the foreground send path. */
export function decideSkillReviewSchedule(input: SkillReviewScheduleInput): SkillReviewScheduleDecision {
  const policy = policyWithDefaults(input.policy);
  if (!input.featureEnabled) return { action: 'skip', reason: 'disabled' };
  if (input.phase === 'shutdown') return { action: 'skip', reason: 'shutdown' };
  if (input.phase && input.phase !== 'post_response_background') return { action: 'skip', reason: 'not_background' };
  if (!input.delivered) return { action: 'skip', reason: 'not_delivered' };
  if (input.shuttingDown) return { action: 'skip', reason: 'shutdown' };
  if (!isSkillReviewTrigger(input.trigger)) return { action: 'skip', reason: 'invalid_trigger' };
  if (
    input.trigger === 'tool_iteration_count'
    && Math.max(0, Math.floor(input.triggerEvidence?.toolIterationCount ?? 0)) < policy.toolIterationThreshold
  ) {
    return { action: 'skip', reason: 'below_trigger_threshold' };
  }
  const idempotencyKey = makeSkillReviewIdempotencyKey({ scopeKey: input.scopeKey, responseId: input.responseId, trigger: input.trigger });
  if (input.state.pendingKeys.has(idempotencyKey)) return { action: 'skip', reason: 'coalesced' };
  const runningCount = input.state.runningCountByScope?.get(input.scopeKey) ?? 0;
  if (runningCount >= policy.maxConcurrentPerScope) return { action: 'skip', reason: 'per_scope_concurrency' };
  const lastRun = input.state.lastRunByScope.get(input.scopeKey) ?? 0;
  if (lastRun > 0 && input.now - lastRun < policy.minIntervalMs) return { action: 'skip', reason: 'min_interval' };
  const dailyCount = input.state.dailyCountByScope.get(makeSkillReviewDailyCountKey({ scopeKey: input.scopeKey, now: input.now })) ?? 0;
  if (dailyCount >= policy.dailyCap) return { action: 'skip', reason: 'daily_cap' };
  return { action: 'enqueue', idempotencyKey, nextAttemptAt: input.now, maxAttempts: policy.maxRetries + 1 };
}

export function nextSkillReviewRetryAt(now: number, attempt: number, policy: Partial<SkillReviewSchedulerPolicy> = {}): number {
  const resolved = policyWithDefaults(policy);
  const boundedAttempt = Math.max(0, Math.min(attempt, resolved.maxRetries));
  return now + resolved.backoffBaseMs * 2 ** boundedAttempt;
}

export function decideSkillReviewClaim(input: {
  featureEnabled: boolean;
  shuttingDown?: boolean;
  job: SkillReviewJobSnapshot;
  now: number;
  runningCountByScope: ReadonlyMap<string, number>;
  policy?: Partial<SkillReviewSchedulerPolicy>;
}): SkillReviewClaimDecision {
  const policy = policyWithDefaults(input.policy);
  if (!input.featureEnabled) return { action: 'skip', reason: 'disabled' };
  if (input.shuttingDown) return { action: 'skip', reason: 'shutdown' };
  if (input.job.state !== 'pending' && input.job.state !== 'retry_wait') {
    return { action: 'skip', reason: 'not_pending' };
  }
  if (input.job.attempt > policy.maxRetries) {
    return { action: 'skip', reason: 'attempts_exhausted' };
  }
  if ((input.job.nextAttemptAt ?? 0) > input.now) {
    return { action: 'skip', reason: 'not_due' };
  }
  const runningCount = input.runningCountByScope.get(input.job.scopeKey) ?? 0;
  if (runningCount >= policy.maxConcurrentPerScope) {
    return { action: 'skip', reason: 'per_scope_concurrency' };
  }
  return {
    action: 'claim',
    state: 'running',
    attempt: input.job.attempt,
    claimedAt: input.now,
  };
}

export function repairSkillReviewJob(input: {
  job: SkillReviewJobSnapshot;
  now: number;
  policy?: Partial<SkillReviewSchedulerPolicy>;
}): SkillReviewRepairDecision {
  const policy = policyWithDefaults(input.policy);
  if (input.job.state === 'succeeded' || input.job.state === 'failed' || input.job.state === 'pending') {
    return {
      idempotencyKey: input.job.idempotencyKey,
      action: 'keep',
      state: input.job.state,
      nextAttemptAt: input.job.nextAttemptAt,
    };
  }
  if (input.job.state === 'retry_wait') {
    return {
      idempotencyKey: input.job.idempotencyKey,
      action: 'keep',
      state: input.job.state,
      nextAttemptAt: input.job.nextAttemptAt,
    };
  }
  if (input.now - input.job.updatedAt < policy.staleRunningMs) {
    return {
      idempotencyKey: input.job.idempotencyKey,
      action: 'keep',
      state: 'running',
    };
  }
  if (input.job.attempt >= policy.maxRetries) {
    return {
      idempotencyKey: input.job.idempotencyKey,
      action: 'fail',
      state: 'failed',
    };
  }
  return {
    idempotencyKey: input.job.idempotencyKey,
    action: 'retry',
    state: 'retry_wait',
    nextAttemptAt: nextSkillReviewRetryAt(input.now, input.job.attempt + 1, policy),
  };
}
