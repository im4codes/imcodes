import { describe, expect, it } from 'vitest';
import {
  SELF_LEARNING_FEATURE_FLAG,
  buildSelfLearningPipelinePlan,
  canAutoPromoteBetweenScopes,
  classifyStartupMemoryState,
  dedupeSelfLearningCandidate,
  withSelfLearningFailureIsolation,
} from '../../shared/self-learning.js';

void SELF_LEARNING_FEATURE_FLAG;

describe('self-learning background contract', () => {
  it('classifies cold/warm/resumed startup state for named-stage bootstrap', () => {
    expect(classifyStartupMemoryState({ hasExistingDurableMemory: false, resumedSession: false })).toBe('cold');
    expect(classifyStartupMemoryState({ hasExistingDurableMemory: true, resumedSession: false })).toBe('warm');
    expect(classifyStartupMemoryState({ hasExistingDurableMemory: true, resumedSession: true })).toBe('resumed');
  });



  it('plans classification/dedup/durable-signal as post-delivery background phases only', () => {
    expect(buildSelfLearningPipelinePlan({ featureEnabled: false, responseDelivered: true, scope: 'project_shared', startupState: 'warm' })).toEqual({
      enabled: false,
      foreground: false,
      phases: [],
      skipReason: 'disabled',
    });
    expect(buildSelfLearningPipelinePlan({ featureEnabled: true, responseDelivered: false, scope: 'project_shared', startupState: 'warm' })).toEqual({
      enabled: false,
      foreground: false,
      phases: [],
      skipReason: 'not_delivered',
    });
    expect(buildSelfLearningPipelinePlan({ featureEnabled: true, responseDelivered: true, scope: 'project_shared', startupState: 'warm' })).toEqual({
      enabled: true,
      foreground: false,
      phases: ['classify', 'dedup', 'durable_signal'],
      startupState: 'warm',
      scope: 'project_shared',
    });
  });

  it('dedupes only within the same scope and unions source ids', () => {
    const candidate = { scope: 'project_shared' as const, observationClass: 'bugfix' as const, text: 'Fix cache', confidence: 0.9, sourceEventIds: ['e2'] };
    expect(dedupeSelfLearningCandidate({ candidate, candidateFingerprint: 'fp-new' }).decision).toBe('new_observation');
    expect(dedupeSelfLearningCandidate({ candidate, candidateFingerprint: 'fp-new', existing: { scope: 'project_shared', fingerprint: 'fp-old', sourceEventIds: ['e1'] } })).toEqual({
      decision: 'merge_same_scope',
      fingerprint: 'fp-old',
      sourceEventIds: ['e1', 'e2'],
    });
    expect(dedupeSelfLearningCandidate({ candidate, candidateFingerprint: 'fp-new', existing: { scope: 'personal', fingerprint: 'fp-private', sourceEventIds: ['e1'] } }).decision).toBe('reject_cross_scope_merge');
  });

  it('prevents automatic private-to-shared promotion and isolates failures', () => {
    expect(canAutoPromoteBetweenScopes('personal', 'project_shared')).toBe(false);
    expect(canAutoPromoteBetweenScopes('user_private', 'user_private')).toBe(true);
    expect(withSelfLearningFailureIsolation('fallback', () => { throw new Error('classify failed'); })).toEqual({ value: 'fallback', failed: true });
  });
});
