import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from '../agent/codex-display.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from '../agent/provider-quota.js';
import { getClaudeSdkRuntimeConfig } from '../agent/sdk-runtime-config.js';
import { getClaudeUsageQuota } from '../agent/claude-usage-quota.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import type { ServerLink } from './server-link.js';
import logger from '../util/logger.js';

function isQwenSession(agentType: string | null | undefined): boolean {
  return agentType === 'qwen';
}

function isClaudeSdkSession(agentType: string | null | undefined): boolean {
  return agentType === 'claude-code-sdk';
}

function isCodexFamilySession(agentType: string | null | undefined): boolean {
  return agentType === 'codex' || agentType === 'codex-sdk';
}

/**
 * Build the canonical daemon -> server/web sub-session metadata sync payload.
 * Clone, normal create, restart restore, and metadata refresh paths should use
 * this shape so the server DB and browser state stay aligned.
 */
export async function buildSubSessionSyncPayload(
  id: string,
  overrides?: Partial<SessionRecord>,
): Promise<Record<string, unknown> | null> {
  const sessionName = `deck_sub_${id}`;
  const record = getSession(sessionName);
  const r = { ...record, ...overrides };
  if (!r?.agentType) {
    logger.warn({ id, sessionName }, 'Skipping subsession.sync without agentType');
    return null;
  }

  const freshDisplay: Partial<Pick<SessionRecord, 'modelDisplay' | 'codexAvailableModels' | 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta'>> = isQwenSession(r.agentType)
    ? getQwenDisplayMetadata({
        model: r.qwenModel,
        authType: r.qwenAuthType,
        authLimit: r.qwenAuthLimit,
        quotaUsageLabel: r.qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
      })
    : isClaudeSdkSession(r.agentType)
      ? await getClaudeSdkRuntimeConfig().catch(() => ({}))
      : isCodexFamilySession(r.agentType)
        ? mergeCodexDisplayMetadata(await getCodexRuntimeConfig().catch(() => ({})), r)
        : {};

  // Option B (best-effort, ≤1 fetch / 30min): proactive 5h+weekly quota for a
  // claude-code-sdk sub-session. null → fall back to the rate_limit_event quota.
  const usageQuota = isClaudeSdkSession(r.agentType) ? await getClaudeUsageQuota().catch(() => null) : null;
  const transportRuntime = getTransportRuntime(sessionName);

  return {
    type: 'subsession.sync',
    id,
    state: r.state ?? null,
    sessionType: r.agentType,
    cwd: r.projectDir ?? null,
    shellBin: null,
    ccSessionId: r.ccSessionId ?? null,
    geminiSessionId: r.geminiSessionId ?? null,
    parentSession: r.parentSession ?? null,
    ccPresetId: r.ccPreset ?? null,
    description: r.description ?? null,
    label: r.label ?? null,
    runtimeType: r.runtimeType ?? null,
    providerId: r.providerId ?? null,
    providerSessionId: r.providerSessionId ?? null,
    requestedModel: r.requestedModel ?? null,
    activeModel: r.activeModel ?? r.modelDisplay ?? null,
    contextNamespace: r.contextNamespace ?? null,
    contextNamespaceDiagnostics: r.contextNamespaceDiagnostics ?? null,
    contextRemoteProcessedFreshness: r.contextRemoteProcessedFreshness ?? null,
    contextLocalProcessedFreshness: r.contextLocalProcessedFreshness ?? null,
    contextRetryExhausted: r.contextRetryExhausted ?? null,
    contextSharedPolicyOverride: r.contextSharedPolicyOverride ?? null,
    transportConfig: r.transportConfig ?? null,
    qwenModel: r.qwenModel ?? null,
    qwenAuthType: r.qwenAuthType ?? null,
    qwenAuthLimit: r.qwenAuthLimit ?? null,
    qwenAvailableModels: r.qwenAvailableModels ?? null,
    codexAvailableModels: freshDisplay.codexAvailableModels ?? r.codexAvailableModels ?? null,
    modelDisplay: freshDisplay.modelDisplay ?? r.modelDisplay ?? null,
    planLabel: freshDisplay.planLabel ?? r.planLabel ?? null,
    quotaLabel: usageQuota?.quotaLabel ?? freshDisplay.quotaLabel ?? r.quotaLabel ?? null,
    quotaUsageLabel: freshDisplay.quotaUsageLabel ?? r.quotaUsageLabel ?? null,
    quotaMeta: usageQuota?.quotaMeta ?? freshDisplay.quotaMeta ?? r.quotaMeta ?? null,
    effort: r.effort ?? null,
    ...(transportRuntime ? {
      transportPendingMessages: transportRuntime.pendingMessages,
      transportPendingMessageEntries: transportRuntime.pendingEntries,
      transportPendingMessageVersion: transportRuntime.pendingVersion,
    } : {}),
  };
}

export async function sendSubSessionSync(
  serverLink: Pick<ServerLink, 'send'>,
  id: string,
  overrides?: Partial<SessionRecord>,
): Promise<void> {
  const payload = await buildSubSessionSyncPayload(id, overrides);
  if (!payload) return;
  serverLink.send(payload);
}
