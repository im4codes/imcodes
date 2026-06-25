import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from '../agent/codex-display.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from '../agent/provider-quota.js';
import { getClaudeSdkRuntimeConfig } from '../agent/sdk-runtime-config.js';
import { getClaudeUsageQuota } from '../agent/claude-usage-quota.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import type { ServerLink } from './server-link.js';
import { EXECUTION_CLONE_KIND, type ExecutionCloneMetadata } from '../../shared/execution-clone.js';
import logger from '../util/logger.js';

/**
 * Runtime-identity fields that MUST NOT replicate to Postgres for an execution
 * clone. Kept as an explicit, decoupled list (mirrors the shared
 * transport-identity denylist) so this module never depends on the in-progress
 * `execution-clone.ts` daemon helper. If that module later exports a
 * `buildScrubbedSyncOverrides`, this can be swapped to reuse it.
 */
const CLONE_PAYLOAD_IDENTITY_FIELDS = [
  'ccSessionId',
  'codexSessionId',
  'geminiSessionId',
  'opencodeSessionId',
  'providerSessionId',
  'providerResumeId',
] as const satisfies readonly (keyof SessionRecord)[];

function isExecutionClone(metadata: ExecutionCloneMetadata | null | undefined): boolean {
  return metadata?.kind === EXECUTION_CLONE_KIND;
}

export interface SubSessionSyncTransportQueueSnapshot {
  pendingMessages: string[];
  pendingEntries: Array<{ clientMessageId: string; text: string }>;
  pendingVersion?: number;
}

export interface SubSessionSyncOptions {
  transportQueue?: SubSessionSyncTransportQueueSnapshot | null;
}

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
  options?: SubSessionSyncOptions,
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
        ? mergeCodexDisplayMetadata(await getCodexRuntimeConfig({ probe: false }).catch(() => ({})), r)
        : {};

  // Option B (best-effort, ≤1 fetch / 30min): proactive 5h+weekly quota for a
  // claude-code-sdk sub-session. null → fall back to the rate_limit_event quota.
  const usageQuota = isClaudeSdkSession(r.agentType) ? await getClaudeUsageQuota().catch(() => null) : null;
  const transportQueue = options?.transportQueue ?? null;

  // Execution clones inherit runtime CONFIG but NEVER runtime IDENTITY. Null out
  // every identity field so stale identity never replicates to Postgres (and
  // never survives a conflict upsert — see createSubSession's clone-aware CASE).
  const cloneMetadata = r.executionCloneMetadata ?? null;
  const isClone = isExecutionClone(cloneMetadata);
  const identity = (field: (typeof CLONE_PAYLOAD_IDENTITY_FIELDS)[number]): string | null =>
    isClone ? null : ((r[field] as string | undefined) ?? null);

  return {
    type: 'subsession.sync',
    id,
    state: r.state ?? null,
    sessionType: r.agentType,
    cwd: r.projectDir ?? null,
    // shell/script launch binary is CONFIG (not identity): send the real value so
    // the server `sub_sessions.shell_bin` column stays aligned and an inherited
    // shellBin survives cross-device restore. Execution clones may sync their
    // copied shellBin too (identity ids are still scrubbed via `identity()`).
    shellBin: (r.agentType === 'shell' || r.agentType === 'script') ? (r.shellBin ?? null) : null,
    ccSessionId: identity('ccSessionId'),
    geminiSessionId: identity('geminiSessionId'),
    executionCloneMetadata: cloneMetadata,
    parentSession: r.parentSession ?? null,
    ccPresetId: r.ccPreset ?? null,
    description: r.description ?? null,
    label: r.label ?? null,
    runtimeType: r.runtimeType ?? null,
    providerId: r.providerId ?? null,
    providerSessionId: identity('providerSessionId'),
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
    ...(transportQueue ? {
      transportPendingMessages: transportQueue.pendingMessages,
      transportPendingMessageEntries: transportQueue.pendingEntries,
      ...(typeof transportQueue.pendingVersion === 'number'
        ? { transportPendingMessageVersion: transportQueue.pendingVersion }
        : {}),
    } : {}),
  };
}

export async function sendSubSessionSync(
  serverLink: Pick<ServerLink, 'send'>,
  id: string,
  overrides?: Partial<SessionRecord>,
  options?: SubSessionSyncOptions,
): Promise<void> {
  const payload = await buildSubSessionSyncPayload(id, overrides, options);
  if (!payload) return;
  serverLink.send(payload);
}
