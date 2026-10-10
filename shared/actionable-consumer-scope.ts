import type { ContextNamespace } from './context-types.js';

/**
 * Shared producer-side scope boundary for actionable references and bindings.
 * Mutable runtime incarnation metadata is deliberately absent: a durable
 * supervision consumer is project + session, while a memory handle is bound to
 * its complete context namespace.
 */
export function matchesProjectSessionConsumer(
  expected: { projectName?: string | null; sessionName?: string | null },
  candidate: { projectName?: string | null; sessionName?: string | null },
): boolean {
  const projectName = expected.projectName?.trim();
  const sessionName = expected.sessionName?.trim();
  return Boolean(projectName && sessionName
    && candidate.projectName?.trim() === projectName
    && candidate.sessionName?.trim() === sessionName);
}

export function matchesContextConsumerNamespace(
  candidate: ContextNamespace | null | undefined,
  target: ContextNamespace | null | undefined,
): boolean {
  if (!candidate || !target) return false;
  return candidate.scope === target.scope
    && (candidate.projectId ?? undefined) === (target.projectId ?? undefined)
    && (candidate.userId ?? undefined) === (target.userId ?? undefined)
    && (candidate.workspaceId ?? undefined) === (target.workspaceId ?? undefined)
    && (candidate.enterpriseId ?? undefined) === (target.enterpriseId ?? undefined)
    && (candidate.localTenant ?? undefined) === (target.localTenant ?? undefined)
    && (candidate.canonicalRepoId ?? undefined) === (target.canonicalRepoId ?? undefined);
}
