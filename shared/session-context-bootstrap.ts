import type {
  ContextFreshness,
  ContextNamespace,
  SharedScopePolicyOverride,
} from './context-types.js';

export interface SessionContextBootstrapState {
  /** Effective namespace currently resolved for runtime shared-context decisions. */
  contextNamespace?: ContextNamespace;
  /** Diagnostics describing how the current namespace was derived. */
  contextNamespaceDiagnostics?: string[];
  /** Backend/shared processed freshness resolved for the current namespace. */
  contextRemoteProcessedFreshness?: ContextFreshness;
  /** Local processed freshness resolved for the current namespace. */
  contextLocalProcessedFreshness?: ContextFreshness;
  /** Whether shared namespace retry has already been exhausted. */
  contextRetryExhausted?: boolean;
  /** Persisted policy override applied to the shared namespace. */
  contextSharedPolicyOverride?: SharedScopePolicyOverride;
}
