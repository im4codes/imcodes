import type { ContextNamespace } from '../../shared/context-types.js';
import { CAPABILITY_SCOPE } from '../../shared/capability-management.js';
import type { ManagedSkillBinding } from './managed-skill-store.js';

export interface ManagedSkillBindingContext {
  namespace: ContextNamespace;
  /**
   * Account identity learned from the current authenticated ServerLink.
   * This is deliberately separate from the namespace because personal
   * fallback namespaces do not always carry a userId.
   */
  trustedOwnerId?: string;
  sessionId?: string;
  /** Exact runtime provider ID, for example `claude-code-sdk` or `codex-sdk`. */
  providerId?: string;
  /** Exact bound daemon/server identity for machine-scoped availability. */
  serverId?: string;
}

/**
 * Binding dimensions are an intersection. Legacy omitted/empty provider and
 * machine arrays remain unrestricted; a non-empty dimension fails closed when
 * the current exact runtime identity is absent or does not match.
 */
export function managedSkillBindingApplies(
  binding: ManagedSkillBinding,
  context: ManagedSkillBindingContext,
): boolean {
  if (binding.active === false || binding.removed === true) return false;
  const ownerId = context.trustedOwnerId ?? context.namespace.userId;
  if (binding.ownerId && binding.ownerId !== ownerId) return false;
  if (binding.scope === CAPABILITY_SCOPE.LOCAL && binding.serverId && binding.serverId !== context.serverId) return false;
  if (binding.scope === CAPABILITY_SCOPE.PROJECT
    && binding.projectId !== (context.namespace.canonicalRepoId ?? context.namespace.projectId)) return false;
  if (binding.scope === CAPABILITY_SCOPE.SESSION && binding.sessionId !== context.sessionId) return false;
  if (binding.providers?.length && (!context.providerId || !binding.providers.includes(context.providerId))) return false;
  if (binding.machines?.length && (!context.serverId || !binding.machines.includes(context.serverId))) return false;
  return true;
}
