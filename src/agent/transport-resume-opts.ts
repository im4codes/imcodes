import type { LaunchOpts } from './session-manager.js';
import type { SessionRecord } from '../store/session-store.js';
import type { AgentType } from './detect.js';
import type { RemoteSessionInfo } from './transport-provider.js';
import { canonicalizeTransportCwd } from './transport-paths.js';
import { isCodeBuddyProviderId } from '../../shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';

/** Providers whose durable conversation id is stored in SessionRecord.providerResumeId. */
export function usesProviderResumeId(agentType: string | undefined): boolean {
  return agentType === 'cursor-headless'
    || agentType === 'copilot-sdk'
    || agentType === 'kimi-sdk'
    || agentType === HERMES_AGENT_PROVIDER_ID
    || agentType === 'grok-sdk'
    || agentType === 'opencode-sdk'
    || agentType === 'deepseek-harness'
    || agentType === 'pi'
    || isCodeBuddyProviderId(agentType);
}

/**
 * The durable identity of the provider CONVERSATION a transport session record
 * points at: the history a delivered message actually lives in.
 *
 * Where the provider resumes through a resume id (Claude/Codex SDK and the
 * providerResumeId providers) that id is the conversation: it survives a
 * resumed relaunch, while a fresh/reset launch mints a new one or leaves it
 * unset until the provider reports it. Every other transport resumes by binding
 * its route key (qwen, openclaw) or never resumes (qoder), so the route key is
 * the conversation. A runtime epoch is NOT a conversation: SDK providers rotate
 * it on every relaunch, resumed or not.
 */
export function resolveTransportConversationKey(
  record: Pick<SessionRecord, 'agentType' | 'ccSessionId' | 'codexSessionId' | 'providerResumeId' | 'providerSessionId'>
    | null
    | undefined,
): string | undefined {
  if (!record) return undefined;
  const key = record.agentType === 'claude-code-sdk'
    ? record.ccSessionId
    : record.agentType === 'codex-sdk'
      ? record.codexSessionId
      : usesProviderResumeId(record.agentType)
        ? record.providerResumeId
        : record.providerSessionId;
  const normalized = typeof key === 'string' ? key.trim() : '';
  return normalized || undefined;
}

/** Providers whose remote session namespace is partitioned by working directory. */
export function usesDirectoryScopedSessionListing(agentType: string | undefined): boolean {
  return agentType === 'opencode-sdk'
    || agentType === 'copilot-sdk'
    || agentType === 'kimi-sdk'
    || agentType === HERMES_AGENT_PROVIDER_ID
    || agentType === 'grok-sdk'
    || isCodeBuddyProviderId(agentType);
}

/**
 * Recover a durable provider id for records created before providerResumeId
 * was persisted reliably. Prefer an exact legacy id match; otherwise accept
 * only one uniquely named remote conversation. Ambiguity fails closed so a
 * daemon restart can never attach the cron/send path to the wrong history.
 * Directory-scoped providers must also return the exact requested directory;
 * missing or mismatched directory metadata fails closed.
 */
export function findLegacyProviderResumeId(
  record: Pick<SessionRecord, 'name' | 'label' | 'providerSessionId'>,
  remoteSessions: readonly RemoteSessionInfo[],
  expectedDirectory?: string,
): string | undefined {
  const directoryScopeRequested = expectedDirectory !== undefined;
  const normalizedExpectedDirectory = canonicalizeTransportCwd(expectedDirectory) ?? '';
  if (directoryScopeRequested && !normalizedExpectedDirectory) return undefined;
  const scopedSessions = normalizedExpectedDirectory
    ? remoteSessions.filter((session) => (
      !!session.directory
      && canonicalizeTransportCwd(session.directory) === normalizedExpectedDirectory
    ))
    : remoteSessions;

  const legacyId = record.providerSessionId?.trim();
  if (legacyId && scopedSessions.some((session) => session.key === legacyId)) {
    return legacyId;
  }

  const preferredName = record.label?.trim() || record.name?.trim();
  if (!preferredName) return undefined;
  const matches = new Set(
    scopedSessions
      .filter((session) => {
        const displayName = session.displayName?.trim();
        return !!displayName && displayName === preferredName;
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
    ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen' || record.agentType === 'deepseek-harness' || record.agentType === 'pi') ? record.ccPreset : undefined,
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
