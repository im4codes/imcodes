import { resolveEffectiveSessionModel, type SessionModelMetadata } from '@shared/session-model.js';
import { loadLegacyCodexModelPreferenceForModelessSession } from './codex-model-preference.js';

export interface QuickAgentDelegationModelSource extends SessionModelMetadata {
  name?: string | null;
  sessionName?: string | null;
  agentType?: string | null;
  type?: string | null;
}

/**
 * Resolve the model shown by Quick delegation candidates from the same sources
 * as the bottom sub-session cards. Persisted daemon metadata remains
 * authoritative, followed by live detection, the latest usage event, and the
 * legacy per-session Codex preference for old model-less records.
 */
export function resolveQuickAgentDelegationModel(
  session: QuickAgentDelegationModelSource | null | undefined,
  detectedModel?: string | null,
  usageModel?: string | null,
): string | undefined {
  const legacyCodexModel = loadLegacyCodexModelPreferenceForModelessSession(
    session,
    detectedModel,
    usageModel,
  );
  return resolveEffectiveSessionModel(session, detectedModel, usageModel, legacyCodexModel);
}
