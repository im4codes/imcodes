import type { LaunchOpts } from './session-manager.js';
import type { SessionRecord } from '../store/session-store.js';
import type { AgentType } from './detect.js';
import type { RemoteSessionInfo } from './transport-provider.js';

/** Providers whose durable conversation id is stored in SessionRecord.providerResumeId. */
export function usesProviderResumeId(agentType: string | undefined): boolean {
  return agentType === 'cursor-headless'
    || agentType === 'copilot-sdk'
    || agentType === 'kimi-sdk'
    || agentType === 'grok-sdk'
    || agentType === 'opencode-sdk';
}

/**
 * Recover a durable provider id for records created before providerResumeId
 * was persisted reliably. Prefer an exact legacy id match; otherwise accept
 * only one uniquely named remote conversation. Ambiguity fails closed so a
 * daemon restart can never attach the cron/send path to the wrong history.
 */
export function findLegacyProviderResumeId(
  record: Pick<SessionRecord, 'name' | 'label' | 'providerSessionId'>,
  remoteSessions: readonly RemoteSessionInfo[],
): string | undefined {
  const legacyId = record.providerSessionId?.trim();
  if (legacyId && remoteSessions.some((session) => session.key === legacyId)) {
    return legacyId;
  }

  const names = new Set(
    [record.label, record.name]
      .map((value) => value?.trim())
      .filter((value): value is string => !!value),
  );
  if (names.size === 0) return undefined;
  const matches = new Set(
    remoteSessions
      .filter((session) => {
        const displayName = session.displayName?.trim();
        return !!displayName && names.has(displayName);
      })
      .map((session) => session.key),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * Build the LaunchOpts that RESUME a transport session's existing conversation
 * from its persisted record — threading the provider resume ids back so the
 * provider reuses the same conversation instead of starting fresh.
 *
 * Single source of truth shared by the manual send-recovery path
 * (`resumeTransportRuntimeAfterLoss` in command-handler) and
 * `ensureTransportRuntimeForPendingResend` (session-manager) — repo rule: never
 * copy code. Lives in its own dependency-free module (type-only imports) so it
 * is unit-testable without pulling in the full session-manager machinery, and so
 * the recovery flows that mock session-manager still exercise the REAL builder.
 */
export function buildTransportResumeLaunchOpts(record: SessionRecord): LaunchOpts {
  return {
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as AgentType,
    projectDir: record.projectDir,
    label: record.label,
    description: record.description,
    requestedModel: record.requestedModel,
    effort: record.effort,
    transportConfig: record.transportConfig,
    ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen') ? record.ccPreset : undefined,
    // Thread resume ids back so the provider reuses the same conversation.
    ...(record.agentType === 'claude-code-sdk' && record.ccSessionId ? { ccSessionId: record.ccSessionId } : {}),
    ...(record.agentType === 'codex-sdk' && record.codexSessionId ? { codexSessionId: record.codexSessionId } : {}),
    ...(usesProviderResumeId(record.agentType) && record.providerResumeId
      ? { providerResumeId: record.providerResumeId } : {}),
    ...(record.agentType === 'openclaw' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.agentType === 'qwen' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
  };
}
