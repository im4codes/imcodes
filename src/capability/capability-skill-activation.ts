import type { ContextNamespace } from '../../shared/context-types.js';
import {
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  type CapabilityErrorResult,
  type CapabilityStatusResult,
  type CapabilitySummary,
} from '../../shared/capability-management.js';
import { SKILL_MAX_BYTES } from '../../shared/skill-envelope.js';
import { resolveSkillByKey } from '../context/skill-resolver.js';

export interface CapabilitySkillActivationContext {
  ownerId: string;
  namespace: ContextNamespace;
  sessionId: string;
  projectDir?: string;
  providerId: string;
  serverId: string;
  homeDir?: string;
}

function error(reason: CapabilityErrorResult['reason'], message: string): CapabilityErrorResult {
  return { status: 'error', reason, error: message, retryable: false };
}

/**
 * Resolve one Skill body only after the shared resolver has re-verified every
 * current binding and signed-authority dimension. Package resources and paths
 * are deliberately not returned across the MCP boundary.
 */
export function activateCapabilitySkill(
  capability: CapabilitySummary,
  context: CapabilitySkillActivationContext,
): CapabilityStatusResult | CapabilityErrorResult {
  if (capability.kind !== CAPABILITY_KIND.SKILL || !capability.versionId) {
    return error(CAPABILITY_ERROR.INVALID_INPUT, 'An installed Skill version is required');
  }
  if (!context.ownerId || !context.sessionId || !context.providerId || !context.serverId) {
    return error(CAPABILITY_ERROR.FORBIDDEN, 'Current authenticated Skill activation context is unavailable');
  }
  const resolved = resolveSkillByKey({
    namespace: context.namespace,
    trustedOwnerId: context.ownerId,
    sessionId: context.sessionId,
    projectDir: context.projectDir,
    providerId: context.providerId,
    serverId: context.serverId,
    homeDir: context.homeDir,
    key: capability.id,
    maxBytes: SKILL_MAX_BYTES,
  });
  if (!resolved.ok || resolved.registryId !== capability.id || resolved.versionId !== capability.versionId) {
    return error(CAPABILITY_ERROR.FORBIDDEN, 'Skill is not authorized for the current session');
  }
  return {
    status: 'ok',
    capability,
    skillActivation: {
      capabilityId: capability.id,
      versionId: resolved.versionId,
      generationId: resolved.generationId!,
      instructions: resolved.text,
    },
  };
}
