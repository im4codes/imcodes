import { isOwnerPrivateMemoryScope, type MemoryScope } from './memory-scope.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import type { ObservationClass } from './memory-observation.js';

export const SELF_LEARNING_FEATURE_FLAG = MEMORY_FEATURE_FLAGS_BY_NAME.selfLearning;

export const SELF_LEARNING_CLASSIFICATION_PHASES = [
  'classify',
  'dedup',
  'durable_signal',
] as const;
export type SelfLearningClassificationPhase = (typeof SELF_LEARNING_CLASSIFICATION_PHASES)[number];

export const DEDUP_DECISIONS = [
  'new_observation',
  'merge_same_scope',
  'reject_cross_scope_merge',
  'reject_low_confidence',
] as const;
export type DedupDecision = (typeof DEDUP_DECISIONS)[number];

export const STARTUP_MEMORY_STATES = ['cold', 'warm', 'resumed'] as const;
export type StartupMemoryState = (typeof STARTUP_MEMORY_STATES)[number];

export interface SelfLearningCandidate {
  scope: MemoryScope;
  observationClass: ObservationClass;
  text: string;
  confidence: number;
  sourceEventIds: readonly string[];
}

export interface SelfLearningDedupInput {
  candidate: SelfLearningCandidate;
  existing?: { scope: MemoryScope; sourceEventIds: readonly string[]; fingerprint: string };
  candidateFingerprint: string;
}

export interface SelfLearningDedupResult {
  decision: DedupDecision;
  fingerprint: string;
  sourceEventIds: readonly string[];
}

export function classifyStartupMemoryState(input: { hasExistingDurableMemory: boolean; resumedSession: boolean }): StartupMemoryState {
  if (input.resumedSession) return 'resumed';
  return input.hasExistingDurableMemory ? 'warm' : 'cold';
}

export function canAutoPromoteBetweenScopes(fromScope: MemoryScope, toScope: MemoryScope): boolean {
  if (isOwnerPrivateMemoryScope(fromScope) && fromScope !== toScope) return false;
  return fromScope === toScope;
}

export function dedupeSelfLearningCandidate(input: SelfLearningDedupInput): SelfLearningDedupResult {
  if (input.candidate.confidence < 0.2) {
    return { decision: 'reject_low_confidence', fingerprint: input.candidateFingerprint, sourceEventIds: input.candidate.sourceEventIds };
  }
  if (!input.existing) {
    return { decision: 'new_observation', fingerprint: input.candidateFingerprint, sourceEventIds: input.candidate.sourceEventIds };
  }
  if (input.existing.scope !== input.candidate.scope) {
    return { decision: 'reject_cross_scope_merge', fingerprint: input.candidateFingerprint, sourceEventIds: input.candidate.sourceEventIds };
  }
  return {
    decision: 'merge_same_scope',
    fingerprint: input.existing.fingerprint,
    sourceEventIds: [...new Set([...input.existing.sourceEventIds, ...input.candidate.sourceEventIds])],
  };
}

export function withSelfLearningFailureIsolation<T>(fallback: T, fn: () => T): { value: T; failed: boolean } {
  try {
    return { value: fn(), failed: false };
  } catch {
    return { value: fallback, failed: true };
  }
}

export interface SelfLearningPipelinePlanInput {
  featureEnabled: boolean;
  responseDelivered: boolean;
  scope: MemoryScope;
  startupState: StartupMemoryState;
}

export type SelfLearningPipelineSkipReason = 'disabled' | 'not_delivered';

export type SelfLearningPipelinePlan =
  | {
      enabled: true;
      foreground: false;
      phases: readonly SelfLearningClassificationPhase[];
      startupState: StartupMemoryState;
      scope: MemoryScope;
    }
  | { enabled: false; foreground: false; phases: readonly []; skipReason: SelfLearningPipelineSkipReason };

export function buildSelfLearningPipelinePlan(input: SelfLearningPipelinePlanInput): SelfLearningPipelinePlan {
  if (!input.featureEnabled) return { enabled: false, foreground: false, phases: [], skipReason: 'disabled' };
  if (!input.responseDelivered) return { enabled: false, foreground: false, phases: [], skipReason: 'not_delivered' };
  return {
    enabled: true,
    foreground: false,
    phases: SELF_LEARNING_CLASSIFICATION_PHASES,
    startupState: input.startupState,
    scope: input.scope,
  };
}
