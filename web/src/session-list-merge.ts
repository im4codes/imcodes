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
  normalizeTransportPendingEntries,
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
  description?: string | null;
  qwenModel?: string;
  requestedModel?: string;
  activeModel?: string;
  qwenAuthType?: string;
  qwenAuthLimit?: string;
  qwenAvailableModels?: string[];
  codexAvailableModels?: string[];
  modelDisplay?: string;
  planLabel?: string;
  quotaLabel?: string;
  quotaUsageLabel?: string;
  quotaMeta?: SessionInfo['quotaMeta'];
  effort?: SessionInfo['effort'];
  transportConfig?: Record<string, unknown> | null;
  transportPendingMessages?: unknown;
  transportPendingMessageEntries?: unknown;
}

export function mergeSessionListEntry(
  incoming: IncomingSessionListEntry,
  existing: SessionInfo | undefined,
): SessionInfo {
  const shouldKeepPendingQueue = incoming.state === 'queued' || incoming.state === 'running';
  const hasPendingMessagesField = Object.prototype.hasOwnProperty.call(incoming, 'transportPendingMessages');
  const hasPendingEntriesField = Object.prototype.hasOwnProperty.call(incoming, 'transportPendingMessageEntries');
  const hasExplicitPendingSnapshot = hasPendingMessagesField || hasPendingEntriesField;

  const parsedMessages = extractTransportPendingMessages(incoming.transportPendingMessages);
  const normalizedEntries = normalizeTransportPendingEntries(
    incoming.transportPendingMessageEntries,
    parsedMessages,
    incoming.name,
  );
  const normalizedMessages = parsedMessages.length > 0
    ? parsedMessages
    : normalizedEntries.map((entry) => entry.text);

  const nextPendingMessages = hasExplicitPendingSnapshot
    ? normalizedMessages
    : shouldKeepPendingQueue
      ? (existing?.transportPendingMessages ?? [])
      : [];
  const nextPendingEntries = hasExplicitPendingSnapshot
    ? normalizedEntries
    : shouldKeepPendingQueue
      ? (existing?.transportPendingMessageEntries ?? [])
      : [];

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
    description: incoming.description ?? existing?.description,
    qwenModel: incoming.qwenModel ?? existing?.qwenModel,
    requestedModel: incoming.requestedModel ?? existing?.requestedModel,
    activeModel: incoming.activeModel ?? existing?.activeModel,
    qwenAuthType: incoming.qwenAuthType ?? existing?.qwenAuthType,
    qwenAuthLimit: incoming.qwenAuthLimit ?? existing?.qwenAuthLimit,
    qwenAvailableModels: incoming.qwenAvailableModels ?? existing?.qwenAvailableModels,
    codexAvailableModels: incoming.codexAvailableModels ?? existing?.codexAvailableModels,
    modelDisplay: incoming.modelDisplay ?? incoming.activeModel ?? existing?.modelDisplay,
    planLabel: incoming.planLabel,
    quotaLabel: incoming.quotaLabel,
    quotaUsageLabel: incoming.quotaUsageLabel,
    quotaMeta: incoming.quotaMeta ?? existing?.quotaMeta,
    effort: incoming.effort ?? existing?.effort,
    transportConfig: mergeTransportConfigPreservingSupervision(
      incoming.transportConfig,
      existing?.transportConfig,
    ),
    transportPendingMessages: nextPendingMessages,
    transportPendingMessageEntries: nextPendingEntries,
  };
}
