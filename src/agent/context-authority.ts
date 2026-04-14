import type {
  ContextAuthorityDecision,
  ContextFreshness,
  ContextNamespace,
  ProviderSupportClass,
} from '../../shared/context-types.js';

export interface ContextAuthorityEvaluatorInput {
  namespace: ContextNamespace;
  providerSupport: ProviderSupportClass;
  localProcessedFreshness?: ContextFreshness;
  remoteProcessedFreshness?: ContextFreshness;
  retryExhausted?: boolean;
  allowSharedDegraded?: boolean;
  allowSharedLocalFallback?: boolean;
}

function isSharedScope(scope: ContextNamespace['scope']): boolean {
  return scope !== 'personal';
}

function freshnessOrMissing(value: ContextFreshness | undefined): ContextFreshness {
  return value ?? 'missing';
}

function resolveProviderPolicyOutcome(
  providerSupport: ProviderSupportClass,
  sharedScope: boolean,
  allowSharedDegraded: boolean | undefined,
): ContextAuthorityDecision['providerPolicyOutcome'] {
  if (providerSupport === 'unsupported') return 'unsupported';
  if (providerSupport === 'degraded-message-side-context-mapping') {
    if (sharedScope && allowSharedDegraded === false) return 'degraded-blocked';
    return 'degraded-allowed';
  }
  return 'allowed';
}

export function evaluateContextAuthority(input: ContextAuthorityEvaluatorInput): ContextAuthorityDecision {
  const namespace = input.namespace;
  const remoteFreshness = freshnessOrMissing(input.remoteProcessedFreshness);
  const localFreshness = freshnessOrMissing(input.localProcessedFreshness);
  const sharedScope = isSharedScope(namespace.scope);
  const diagnostics: string[] = [];
  const providerPolicyOutcome = resolveProviderPolicyOutcome(
    input.providerSupport,
    sharedScope,
    input.allowSharedDegraded,
  );

  if (input.providerSupport === 'unsupported') {
    diagnostics.push('provider-unsupported');
    return {
      namespace,
      authoritySource: 'none',
      freshness: 'missing',
      fallbackAllowed: false,
      retryScheduled: false,
      providerPolicyOutcome,
      diagnostics,
    };
  }

  if (sharedScope
    && input.providerSupport === 'degraded-message-side-context-mapping'
    && input.allowSharedDegraded === false) {
    diagnostics.push('shared-scope-provider-degraded');
    return {
      namespace,
      authoritySource: 'none',
      freshness: 'missing',
      fallbackAllowed: false,
      retryScheduled: false,
      providerPolicyOutcome,
      diagnostics,
    };
  }

  if (sharedScope) {
    if (remoteFreshness === 'fresh') {
      diagnostics.push('shared-remote-fresh');
      return {
        namespace,
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        providerPolicyOutcome,
        diagnostics,
      };
    }
    if (!input.retryExhausted) {
      diagnostics.push(`shared-remote-${remoteFreshness}`);
      diagnostics.push('shared-retry-scheduled');
      return {
        namespace,
        authoritySource: 'none',
        freshness: remoteFreshness,
        fallbackAllowed: false,
        retryScheduled: true,
        providerPolicyOutcome,
        diagnostics,
      };
    }
    if (input.allowSharedLocalFallback && localFreshness === 'fresh') {
      diagnostics.push('shared-local-fallback');
      return {
        namespace,
        authoritySource: 'processed_local',
        freshness: 'fresh',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome,
        diagnostics,
      };
    }
    diagnostics.push('shared-retry-exhausted');
    return {
      namespace,
      authoritySource: 'none',
      freshness: remoteFreshness,
      fallbackAllowed: false,
      retryScheduled: false,
      providerPolicyOutcome,
      diagnostics,
    };
  }

  if (localFreshness === 'fresh') {
    diagnostics.push('personal-local-fresh');
    return {
      namespace,
      authoritySource: 'processed_local',
      freshness: 'fresh',
      fallbackAllowed: true,
      retryScheduled: false,
      providerPolicyOutcome,
      diagnostics,
    };
  }
  if (remoteFreshness === 'fresh') {
    diagnostics.push('personal-remote-fresh');
    return {
      namespace,
      authoritySource: 'processed_remote',
      freshness: 'fresh',
      fallbackAllowed: true,
      retryScheduled: false,
      providerPolicyOutcome,
      diagnostics,
    };
  }
  diagnostics.push('personal-no-processed-context');
  return {
    namespace,
    authoritySource: 'none',
    freshness: localFreshness !== 'missing' ? localFreshness : remoteFreshness,
    fallbackAllowed: true,
    retryScheduled: false,
    providerPolicyOutcome,
    diagnostics,
  };
}
