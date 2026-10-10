import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from '../agent/codex-display.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from '../agent/provider-quota.js';
import { getClaudeSdkRuntimeConfig } from '../agent/sdk-runtime-config.js';
import { getClaudeUsageQuota } from '../agent/claude-usage-quota.js';
import { fetchAgyUsageQuota } from '../agent/agy-usage-quota.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import type { ServerLink } from './server-link.js';
import { EXECUTION_CLONE_KIND, type ExecutionCloneMetadata } from '../../shared/execution-clone.js';
import logger from '../util/logger.js';
import type { QueueSnapshot } from '../../shared/transport-queue-types.js';
import { buildTransportQueueSnapshotPayload, type TransportQueueSnapshotPayload } from './transport-queue-projection.js';
import { getSupervisionHeartbeatProjectionForWire } from './supervision-heartbeat-projection.js';

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
  pendingMessages?: string[];
  pendingEntries?: Array<{ clientMessageId: string; text: string }>;
  pendingVersion?: number;
  queueSnapshot?: QueueSnapshot;
  pendingMessageEntries?: QueueSnapshot['pendingMessageEntries'];
  pendingMessageVersion?: number;
  queueEpoch?: string;
  queueAuthorityId?: string;
  failedMessageEntries?: QueueSnapshot['failedMessageEntries'];
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

  const freshDisplay: Partial<Pick<SessionRecord, 'modelDisplay' | 'codexAvailableModels' | 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta' | 'codexCreditsBalance' | 'codexCreditsHasCredits' | 'codexCreditsUnlimited'>> = isQwenSession(r.agentType)
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
  const agyUsageQuota = r.agentType === 'agy-sdk' ? await fetchAgyUsageQuota().catch(() => null) : null;
  void options;
  let transportQueue: TransportQueueSnapshotPayload | null = null;
  if (r.runtimeType === 'transport') {
    transportQueue = buildTransportQueueSnapshotPayload(sessionName, 'subsession_sync');
  }

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
    sessionInstanceId: r.sessionInstanceId ?? null,
    runtimeEpoch: r.runtimeEpoch ?? null,
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
    supervisionHeartbeat: getSupervisionHeartbeatProjectionForWire(sessionName) ?? null,
    qwenModel: r.qwenModel ?? null,
    qwenAuthType: r.qwenAuthType ?? null,
    qwenAuthLimit: r.qwenAuthLimit ?? null,
    qwenAvailableModels: r.qwenAvailableModels ?? null,
    codexAvailableModels: freshDisplay.codexAvailableModels ?? r.codexAvailableModels ?? null,
    modelDisplay: freshDisplay.modelDisplay ?? r.modelDisplay ?? null,
    planLabel: freshDisplay.planLabel ?? r.planLabel ?? null,
    quotaLabel: usageQuota?.quotaLabel ?? agyUsageQuota?.quotaLabel ?? freshDisplay.quotaLabel ?? r.quotaLabel ?? null,
    quotaUsageLabel: freshDisplay.quotaUsageLabel ?? r.quotaUsageLabel ?? null,
    quotaMeta: usageQuota?.quotaMeta ?? agyUsageQuota?.quotaMeta ?? freshDisplay.quotaMeta ?? r.quotaMeta ?? null,
    codexCreditsBalance: freshDisplay.codexCreditsBalance ?? r.codexCreditsBalance ?? null,
    codexCreditsHasCredits: freshDisplay.codexCreditsHasCredits ?? r.codexCreditsHasCredits ?? null,
    codexCreditsUnlimited: freshDisplay.codexCreditsUnlimited ?? r.codexCreditsUnlimited ?? null,
    effort: r.effort ?? null,
    ...(transportQueue ?? {}),
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

/** What `announceSubSession` achieved. `no_link`: nothing was sent (no server link, or its socket is not open); the reconnect resync covers it. */
export type SubSessionAnnounceOutcome = 'announced' | 'no_link' | 'failed';

/**
 * Tell the server (and through it every browser) that a sub-session the daemon launched on its own exists: the server learns of a
 * daemon-created sub-session only through `subsession.sync`, which it turns into the `sub_sessions` row and `subsession.created`.
 * Unlike `sendSubSessionSync` this reports whether the message actually left: a dropped send is `no_link`, and a record that cannot
 * be described (no agentType) is `failed`.
 */
export async function announceSubSession(
  link: { send(msg: object): void; trySend?(msg: unknown): boolean; isConnected?(): boolean } | null,
  id: string,
): Promise<SubSessionAnnounceOutcome> {
  if (!link || (link.isConnected && !link.isConnected())) return 'no_link';
  const payload = await buildSubSessionSyncPayload(id);
  if (!payload) return 'failed';
  try {
    if (link.trySend) return link.trySend(payload) ? 'announced' : 'no_link';
    link.send(payload);
    return 'announced';
  } catch (error) {
    logger.warn({ err: error, id }, 'subsession announce: send failed');
    return 'no_link';
  }
}
