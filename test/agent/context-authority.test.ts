import { describe, expect, it } from 'vitest';
import { evaluateContextAuthority } from '../../src/agent/context-authority.js';

describe('evaluateContextAuthority', () => {
  it('uses fresh remote processed context for shared scopes', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'project_shared', projectId: 'repo' },
      providerSupport: 'full-normalized-context-injection',
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'fresh',
      retryExhausted: false,
    });

    expect(decision.authoritySource).toBe('processed_remote');
    expect(decision.freshness).toBe('fresh');
    expect(decision.fallbackAllowed).toBe(false);
    expect(decision.providerPolicyOutcome).toBe('allowed');
  });

  it('schedules retry before failing shared scope resolution', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'project_shared', projectId: 'repo' },
      providerSupport: 'full-normalized-context-injection',
      remoteProcessedFreshness: 'stale',
      retryExhausted: false,
    });

    expect(decision.authoritySource).toBe('none');
    expect(decision.retryScheduled).toBe(true);
    expect(decision.providerPolicyOutcome).toBe('allowed');
    expect(decision.diagnostics).toContain('shared-retry-scheduled');
  });

  it('allows degraded providers in shared scope by architecture default', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'org_shared', projectId: 'repo' },
      providerSupport: 'degraded-message-side-context-mapping',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(decision.authoritySource).toBe('processed_remote');
    expect(decision.providerPolicyOutcome).toBe('degraded-allowed');
    expect(decision.diagnostics).toContain('shared-remote-fresh');
  });

  it('allows degraded providers in shared scope when policy explicitly permits them', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'workspace_shared', projectId: 'repo', workspaceId: 'ws-1' },
      providerSupport: 'degraded-message-side-context-mapping',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      allowSharedDegraded: true,
    });

    expect(decision.authoritySource).toBe('processed_remote');
    expect(decision.providerPolicyOutcome).toBe('degraded-allowed');
    expect(decision.diagnostics).toContain('shared-remote-fresh');
  });

  it('blocks degraded providers in shared scope when explicit policy tightens support requirements', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'workspace_shared', projectId: 'repo', workspaceId: 'ws-1' },
      providerSupport: 'degraded-message-side-context-mapping',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      allowSharedDegraded: false,
    });

    expect(decision.authoritySource).toBe('none');
    expect(decision.providerPolicyOutcome).toBe('degraded-blocked');
    expect(decision.diagnostics).toContain('shared-scope-provider-degraded');
  });

  it('uses local processed context for personal scope continuity', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'personal', projectId: 'repo' },
      providerSupport: 'degraded-message-side-context-mapping',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(decision.authoritySource).toBe('processed_local');
    expect(decision.fallbackAllowed).toBe(true);
    expect(decision.providerPolicyOutcome).toBe('degraded-allowed');
  });

  it('reports unsupported provider policy outcome and blocks send for unsupported providers', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'project_shared', projectId: 'repo' },
      providerSupport: 'unsupported',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(decision.authoritySource).toBe('none');
    expect(decision.providerPolicyOutcome).toBe('unsupported');
    expect(decision.diagnostics).toContain('provider-unsupported');
  });

  it('returns the same providerPolicyOutcome for identical inputs consumed by runtime and diagnostics', () => {
    const input = {
      namespace: { scope: 'project_shared' as const, projectId: 'repo' },
      providerSupport: 'degraded-message-side-context-mapping' as const,
      remoteProcessedFreshness: 'fresh' as const,
      retryExhausted: true,
      allowSharedDegraded: true,
    };

    const decision1 = evaluateContextAuthority(input);
    const decision2 = evaluateContextAuthority(input);

    expect(decision1.providerPolicyOutcome).toBe(decision2.providerPolicyOutcome);
    expect(decision1.authoritySource).toBe(decision2.authoritySource);
    expect(decision1.freshness).toBe(decision2.freshness);
    expect(decision1.diagnostics).toEqual(decision2.diagnostics);
  });

  it('hard-fails shared scope after retry exhaustion even when local processed is fresh', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'org_shared', projectId: 'repo', enterpriseId: 'ent-1' },
      providerSupport: 'full-normalized-context-injection',
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(decision.authoritySource).toBe('none');
    expect(decision.fallbackAllowed).toBe(false);
    expect(decision.providerPolicyOutcome).toBe('allowed');
  });

  it('allows shared local fallback only when explicit policy flag is set', () => {
    const decision = evaluateContextAuthority({
      namespace: { scope: 'org_shared', projectId: 'repo', enterpriseId: 'ent-1' },
      providerSupport: 'full-normalized-context-injection',
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
      allowSharedLocalFallback: true,
    });

    expect(decision.authoritySource).toBe('processed_local');
    expect(decision.fallbackAllowed).toBe(true);
  });
});
