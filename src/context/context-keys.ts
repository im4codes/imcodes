import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';

function joinPart(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function serializeContextNamespace(namespace: ContextNamespace): string {
  return [
    namespace.scope,
    joinPart(namespace.enterpriseId),
    joinPart(namespace.workspaceId),
    joinPart(namespace.userId),
    joinPart(namespace.projectId),
  ].join('::');
}

export function serializeContextTarget(target: ContextTargetRef): string {
  return [
    serializeContextNamespace(target.namespace),
    target.kind,
    joinPart(target.sessionName),
  ].join('::');
}
