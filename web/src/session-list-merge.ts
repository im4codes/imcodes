/**
 * Pure merge helper for turning a daemon `session_list` broadcast entry into
 * a `SessionInfo` snapshot, layered on top of the previous UI state entry.
 *
 * Extracted from `app.tsx` so the merge contract can be unit-tested without
 * mounting the whole app shell. The critical invariants the tests defend:
 *
 * 1. When the daemon broadcast's `transportConfig` lacks the `supervision`
 *    key (e.g. a stale heartbeat that re-synced a session row before the
 *    authoritative supervision update landed), the user's previously-saved
 *    supervision snapshot MUST survive. This was the root cause of the Auto
 *    dropdown "自动跳回关闭状态" regression: naive `incoming ?? existing`
 *    treated `{}` and `{ someKey: 'x' }` as truthy and wiped supervision.
 *
 * 2. When the daemon sends an explicit supervision snapshot (including
 *    `{ mode: 'off' }`), it IS authoritative and replaces the existing one.
 *
 * 3. All other `SessionInfo` fields retain their previous coalesce-with-
 *    existing semantics so intermittent omissions from daemon snapshots
 *    don't flicker the UI.
 */

import { mergeTransportConfigPreservingSupervision } from '@shared/supervision-config.js';
import type { SessionInfo } from './types.js';
import { resolveRuntimeType } from './runtime-type.js';
import {
  extractTransportPendingMessages,
  extractTransportPendingVersion,
  nextTransportQueueVersion,
  normalizeTransportPendingEntries,
  shouldApplyTransportQueueSnapshotForPayload,
} from './transport-queue.js';

/**
 * Minimum shape of the daemon's `session_list` entry consumed here. Kept
 * structurally typed so we don't couple the web build to the daemon's
 * `SessionListItem` type — any field not listed is simply ignored.
 */
export interface IncomingSessionListEntry {
  name: string;
  project: string;
  role: string;
  agentType: string;
  agentVersion?: string;
  state: string;
  projectDir?: string;
  runtimeType?: string;
  label?: string | null;
  userCreated?: boolean;
  description?: string | null;
  ccPreset?: string | null;
  qwenModel?: string;
  requestedModel?: string;
  activeModel?: string;
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  codexAvailableModels?: string[];
  modelDisplay?: string;
  planLabel?: string | null;
  quotaLabel?: string | null;
  quotaUsageLabel?: string | null;
  quotaMeta?: SessionInfo['quotaMeta'];
  effort?: SessionInfo['effort'];
  contextNamespace?: SessionInfo['contextNamespace'];
  contextNamespaceDiagnostics?: string[];
  transportConfig?: Record<string, unknown> | null;
  transportPendingMessages?: unknown;
  transportPendingMessageEntries?: unknown;
  transportPendingMessageVersion?: unknown;
  sharedState?: SessionInfo['sharedState'];
  /** DAEMON-AUTHORITATIVE: whether this session may serve as an execution-clone
   *  template. Computed by the daemon; the UI renders it rather than recomputing
   *  eligibility client-side. */
  executionTemplateEligible?: boolean;
  /** DAEMON-AUTHORITATIVE: reason the session is NOT eligible as an execution
   *  template (only meaningful when `executionTemplateEligible === false`). */
  executionTemplateIneligibleReason?: string;
}

export function isSubSessionName(sessionName: string): boolean {
  return sessionName.startsWith('deck_sub_');
}

export function parseMainSessionName(sessionName: string): { project: string; role: SessionInfo['role'] } | null {
  const match = /^deck_(.+)_(brain|w\d+)$/.exec(sessionName);
  if (!match) return null;
  return {
    project: match[1],
    role: match[2] as SessionInfo['role'],
  };
}

export function isWorkerSessionName(sessionName: string): boolean {
  const parsed = parseMainSessionName(sessionName);
  return Boolean(parsed && parsed.role !== 'brain');
}

export function isNavigableMainSession(session: { name: string; role?: string | null }): boolean {
  return !isSubSessionName(session.name)
    && !isWorkerSessionName(session.name)
    && session.role === 'brain';
}

export function mergeSessionListEntry(
  incoming: IncomingSessionListEntry,
  existing: SessionInfo | undefined,
): SessionInfo {
  const isCodexFamily = incoming.agentType === 'codex' || incoming.agentType === 'codex-sdk';
  // Codex AND claude-code-sdk surface provider quota that the daemon may omit on
  // a given session_list pass (idle / 30-min throttle / a transient B failure);
  // preserve the last known value so the footer doesn't flicker blank between
  // updates instead of dropping it to undefined.
  const preservesProviderQuota = isCodexFamily || incoming.agentType === 'claude-code-sdk';
  const shouldKeepPendingQueue = incoming.state === 'queued' || incoming.state === 'running';
  const hasPendingMessagesField = Object.prototype.hasOwnProperty.call(incoming, 'transportPendingMessages');
  const hasPendingEntriesField = Object.prototype.hasOwnProperty.call(incoming, 'transportPendingMessageEntries');
  const hasExplicitPendingSnapshot = hasPendingMessagesField || hasPendingEntriesField;

  const parsedMessages = extractTransportPendingMessages(incoming.transportPendingMessages);
  const normalizedEntries = normalizeTransportPendingEntries(
    incoming.transportPendingMessageEntries,
    parsedMessages,
    incoming.name,
    {
      hasEntriesField: hasPendingEntriesField,
      hasMessagesField: hasPendingMessagesField,
    },
  );
  const normalizedMessages = hasPendingEntriesField
    ? normalizedEntries.map((entry) => entry.text)
    : parsedMessages;

  // Monotonic version guard: a `session_list` heartbeat can be built before
  // a drain but delivered after it. If this snapshot's queue version is older
  // than what we've already applied, it is stale — keep the existing queue so
  // it can't resurrect already-drained entries.
  const incomingVersion = extractTransportPendingVersion(incoming.transportPendingMessageVersion);
  const existingVersion = existing?.transportPendingMessageVersion;
  const applyPendingSnapshot = hasExplicitPendingSnapshot
    && shouldApplyTransportQueueSnapshotForPayload(existingVersion, incomingVersion, {
      hasExplicitSnapshot: true,
      isExplicitEmpty: normalizedMessages.length === 0 && normalizedEntries.length === 0,
    });

  const nextPendingMessages = applyPendingSnapshot
    ? normalizedMessages
    : hasExplicitPendingSnapshot
      // Stale snapshot — keep what we have rather than overwrite.
      ? (existing?.transportPendingMessages ?? [])
      : shouldKeepPendingQueue
        ? (existing?.transportPendingMessages ?? [])
        : [];
  const nextPendingEntries = applyPendingSnapshot
    ? normalizedEntries
    : hasExplicitPendingSnapshot
      ? (existing?.transportPendingMessageEntries ?? [])
      : shouldKeepPendingQueue
        ? (existing?.transportPendingMessageEntries ?? [])
        : [];
  const nextPendingVersion = applyPendingSnapshot
    ? nextTransportQueueVersion(existingVersion, incomingVersion)
    : existingVersion;

  return {
    name: incoming.name,
    project: incoming.project,
    role: incoming.role as SessionInfo['role'],
    agentType: incoming.agentType,
    agentVersion: incoming.agentVersion,
    state: incoming.state as SessionInfo['state'],
    projectDir: incoming.projectDir ?? existing?.projectDir,
    runtimeType: resolveRuntimeType({
      runtimeType: (incoming.runtimeType as SessionInfo['runtimeType']) ?? existing?.runtimeType,
      agentType: incoming.agentType,
    }),
    label: incoming.label ?? existing?.label,
    userCreated: incoming.userCreated ?? existing?.userCreated,
    description: incoming.description ?? existing?.description,
    ccPreset: incoming.ccPreset !== undefined ? incoming.ccPreset : existing?.ccPreset,
    qwenModel: incoming.qwenModel ?? existing?.qwenModel,
    requestedModel: incoming.requestedModel ?? existing?.requestedModel,
    activeModel: incoming.activeModel ?? existing?.activeModel,
    qwenAuthType: incoming.qwenAuthType ?? existing?.qwenAuthType,
    qwenAuthLimit: incoming.qwenAuthLimit ?? existing?.qwenAuthLimit,
    qwenAvailableModels: incoming.qwenAvailableModels ?? existing?.qwenAvailableModels,
    codexAvailableModels: incoming.codexAvailableModels ?? existing?.codexAvailableModels,
    modelDisplay: incoming.modelDisplay ?? incoming.activeModel ?? existing?.modelDisplay,
    planLabel: incoming.planLabel ?? (preservesProviderQuota ? existing?.planLabel : undefined),
    quotaLabel: incoming.quotaLabel ?? (preservesProviderQuota ? existing?.quotaLabel : undefined),
    quotaUsageLabel: incoming.quotaUsageLabel ?? (preservesProviderQuota ? existing?.quotaUsageLabel : undefined),
    quotaMeta: incoming.quotaMeta ?? (preservesProviderQuota ? existing?.quotaMeta : undefined),
    effort: incoming.effort ?? existing?.effort,
    contextNamespace: incoming.contextNamespace ?? existing?.contextNamespace,
    contextNamespaceDiagnostics: incoming.contextNamespaceDiagnostics ?? existing?.contextNamespaceDiagnostics,
    transportConfig: mergeTransportConfigPreservingSupervision(
      incoming.transportConfig,
      existing?.transportConfig,
    ),
    transportPendingMessages: nextPendingMessages,
    transportPendingMessageEntries: nextPendingEntries,
    transportPendingMessageVersion: nextPendingVersion,
    sharedState: incoming.sharedState ?? existing?.sharedState,
    executionTemplateEligible: incoming.executionTemplateEligible ?? existing?.executionTemplateEligible,
    executionTemplateIneligibleReason:
      incoming.executionTemplateIneligibleReason ?? existing?.executionTemplateIneligibleReason,
  };
}
