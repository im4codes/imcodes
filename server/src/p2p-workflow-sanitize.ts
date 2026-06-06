import {
  P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES,
  P2P_SANITIZE_MAX_ARRAY_ITEMS,
  P2P_SANITIZE_MAX_DEPTH,
  P2P_SANITIZE_MAX_OBJECT_KEYS,
  P2P_SANITIZE_MAX_STRING_BYTES,
  P2P_SANITIZE_MAX_TOTAL_BYTES,
  P2P_WORKFLOW_PROJECTION_VERSION,
} from '../../shared/p2p-workflow-constants.js';
import {
  P2P_WORKFLOW_DIAGNOSTIC_CODES,
  P2P_WORKFLOW_DIAGNOSTIC_PHASES,
  P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES,
  makeP2pWorkflowDiagnostic,
  type P2pWorkflowDiagnostic,
  type P2pWorkflowDiagnosticCode,
  type P2pWorkflowDiagnosticPhase,
  type P2pWorkflowDiagnosticSeverity,
} from '../../shared/p2p-workflow-diagnostics.js';
import { buildPersistedSnapshotFromProjection } from '../../shared/p2p-workflow-projection.js';
import type { P2pPersistedWorkflowSnapshot, P2pWorkflowStatusProjection } from '../../shared/p2p-workflow-types.js';
import type { ShareAuthorizationSnapshot, SharedActorEnvelope, ShareTarget } from '../../shared/tab-sharing.js';

const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  ...P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES,
]);

const PROJECTION_STATUSES = new Set<P2pWorkflowStatusProjection['status']>([
  'queued',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'stale',
]);

const WORKFLOW_DIAGNOSTIC_CODES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_CODES);
const WORKFLOW_DIAGNOSTIC_PHASES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_PHASES);
const WORKFLOW_DIAGNOSTIC_SEVERITIES = new Set<string>(P2P_WORKFLOW_DIAGNOSTIC_SEVERITIES);
const SERVER_SIDE_SANITIZE_CODES = new Set<P2pWorkflowDiagnosticCode>([
  'private_projection_field_dropped',
  'legacy_progress_snapshot_sanitized',
]);

type BoundedCloneContext = {
  remainingBytes: number;
  truncated: boolean;
  seen: Set<unknown>;
};

export type SanitizedP2pOrchestrationRun = {
  id: string;
  discussion_id: string;
  server_id: string;
  main_session: string;
  initiator_session: string;
  current_target_session: string | null;
  final_return_session: string;
  remaining_targets: string;
  mode_key: string;
  status: string;
  request_message_id: string | null;
  callback_message_id: string | null;
  context_ref: string;
  timeout_ms: number;
  result_summary: string | null;
  error: string | null;
  progress_snapshot: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  workflow_projection: P2pWorkflowStatusProjection;
  current_round?: number;
  total_rounds?: number;
  total_count?: number;
  total_hops?: number;
  completed_hops_count?: number;
  active_hop_number?: number | null;
  active_round_hop_number?: number | null;
  active_phase?: string;
  execution_attempt?: number | null;
  execution_cycle_current?: number | null;
  execution_cycle_total?: number | null;
  current_round_mode?: string;
  current_target_label?: string | null;
  initiator_label?: string | null;
  run_phase?: string;
  summary_phase?: string | null;
  hop_states?: Array<Record<string, unknown>>;
  hop_counts?: Record<string, number>;
  all_nodes?: Array<Record<string, unknown>>;
  advanced_p2p_enabled?: boolean;
  current_round_id?: string | null;
  advanced_nodes?: Array<Record<string, unknown>>;
  scope_kind?: ShareTarget['kind'] | null;
  scope_server_id?: string | null;
  scope_session_name?: string | null;
  scope_sub_session_id?: string | null;
  created_by_user_id?: string | null;
  authorization_snapshot?: ShareAuthorizationSnapshot | string | null;
  primary_share_id?: string | null;
  covering_share_ids?: string[] | string | null;
  visible_after_ms?: number | null;
  history_cutoff_at_ms?: number | null;
  share_target_snapshot?: ShareTarget | string | null;
  shareScope?: {
    target: ShareTarget;
    historyCutoffAt: number;
    primaryShareId: string | null;
    coveringShareIds: string[];
  };
  sharedActor?: SharedActorEnvelope;
};

export type SanitizedP2pRunUpdate = SanitizedP2pOrchestrationRun & Record<string, unknown>;

const SAFE_LEGACY_RUN_UPDATE_FIELDS = [
  'current_round_mode',
  'current_round',
  'total_rounds',
  'total_count',
  'total_hops',
  'remaining_count',
  'completed_hops_count',
  'completed_round_hops_count',
  'skipped_hops',
  'active_phase',
  'execution_attempt',
  'execution_cycle_current',
  'execution_cycle_total',
  'hop_started_at',
  'active_hop_number',
  'active_round_hop_number',
  'current_target_label',
  'initiator_label',
  'hop_states',
  'hop_counts',
  'terminal_reason',
  'advanced_p2p_enabled',
  'current_round_id',
  'current_execution_step',
  'current_round_attempt',
  'round_attempt_counts',
  'round_jump_counts',
  'routing_history',
  'helper_diagnostics',
  'advanced_nodes',
  'run_phase',
  'summary_phase',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredString(value: unknown, fallback: string): string {
  const resolved = stringValue(value);
  return resolved && resolved.trim() ? boundedString(resolved) : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? boundedString(value) : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return optionalNumber(value);
}

function normalizeShareTarget(value: unknown): ShareTarget | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const serverId = typeof value.serverId === 'string' && value.serverId.trim() ? boundedString(value.serverId.trim()) : '';
  if (!serverId) return null;
  if (kind === 'server') return { kind, serverId };
  if (kind === 'main') {
    const sessionName = typeof value.sessionName === 'string' && value.sessionName.trim()
      ? boundedString(value.sessionName.trim())
      : '';
    return sessionName ? { kind, serverId, sessionName } : null;
  }
  if (kind === 'subsession') {
    const subSessionId = typeof value.subSessionId === 'string' && value.subSessionId.trim()
      ? boundedString(value.subSessionId.trim())
      : '';
    return subSessionId && !subSessionId.startsWith('deck_sub_') ? { kind, serverId, subSessionId } : null;
  }
  return null;
}

function normalizeShareAuthorizationSnapshot(value: unknown): ShareAuthorizationSnapshot | null {
  if (!isRecord(value)) return null;
  const target = normalizeShareTarget(value.target);
  const effectiveRole = value.effectiveRole;
  const historyCutoffAt = numberValue(value.historyCutoffAt, 0);
  const authorizedAt = optionalNumber(value.authorizedAt);
  const nextCoverageRecheckAt = value.nextCoverageRecheckAt === null
    ? null
    : optionalNumber(value.nextCoverageRecheckAt) ?? null;
  const coveringShareIds = Array.isArray(value.coveringShareIds)
    ? value.coveringShareIds
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
      .map((item) => boundedString(item.trim()))
    : [];
  const primaryShareId = typeof value.primaryShareId === 'string' && value.primaryShareId.trim()
    ? boundedString(value.primaryShareId.trim())
    : null;
  if (!target || (effectiveRole !== 'viewer' && effectiveRole !== 'participant') || authorizedAt === undefined) {
    return null;
  }
  return {
    target,
    effectiveRole,
    historyCutoffAt,
    nextCoverageRecheckAt,
    coveringShareIds,
    primaryShareId,
    authorizedAt,
  };
}

function normalizeSharedActor(value: unknown): SharedActorEnvelope | null {
  if (!isRecord(value)) return null;
  const snapshot = normalizeShareAuthorizationSnapshot(value.snapshot);
  const actorUserId = typeof value.actorUserId === 'string' && value.actorUserId.trim()
    ? boundedString(value.actorUserId.trim())
    : '';
  const actorDisplayName = typeof value.actorDisplayName === 'string' && value.actorDisplayName.trim()
    ? boundedString(value.actorDisplayName.trim())
    : actorUserId;
  const effectiveActorRole = value.effectiveActorRole;
  const actionId = typeof value.actionId === 'string' && value.actionId.trim()
    ? boundedString(value.actionId.trim())
    : '';
  const origin = value.origin;
  const authorizedAt = optionalNumber(value.authorizedAt);
  if (
    !snapshot ||
    !actorUserId ||
    !actionId ||
    authorizedAt === undefined ||
    !['viewer', 'participant', 'server-member', 'server-manager', 'system'].includes(String(effectiveActorRole)) ||
    !['shared-server', 'shared-tab', 'server-member'].includes(String(origin))
  ) {
    return null;
  }
  return {
    actorUserId,
    actorDisplayName,
    snapshot,
    primaryShareId: typeof value.primaryShareId === 'string' && value.primaryShareId.trim()
      ? boundedString(value.primaryShareId.trim())
      : snapshot.primaryShareId,
    effectiveActorRole: effectiveActorRole as SharedActorEnvelope['effectiveActorRole'],
    actionId,
    origin: origin as SharedActorEnvelope['origin'],
    authorizedAt,
    queuedAt: optionalNumber(value.queuedAt),
    daemonAckedAt: optionalNumber(value.daemonAckedAt),
  };
}

function normalizeShareScope(value: unknown, actor: SharedActorEnvelope | null): SanitizedP2pOrchestrationRun['shareScope'] | null {
  if (!isRecord(value)) {
    return actor ? {
      target: actor.snapshot.target,
      historyCutoffAt: actor.snapshot.historyCutoffAt,
      primaryShareId: actor.snapshot.primaryShareId,
      coveringShareIds: actor.snapshot.coveringShareIds,
    } : null;
  }
  const target = normalizeShareTarget(value.target);
  if (!target) return null;
  const coveringShareIds = Array.isArray(value.coveringShareIds)
    ? value.coveringShareIds
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
      .map((item) => boundedString(item.trim()))
    : actor?.snapshot.coveringShareIds ?? [];
  return {
    target,
    historyCutoffAt: numberValue(value.historyCutoffAt, actor?.snapshot.historyCutoffAt ?? 0),
    primaryShareId: typeof value.primaryShareId === 'string' && value.primaryShareId.trim()
      ? boundedString(value.primaryShareId.trim())
      : actor?.snapshot.primaryShareId ?? null,
    coveringShareIds,
  };
}

function truncateUtf8String(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  if (maxBytes <= 0) return { value: '', truncated: true };
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { value: chars.slice(0, low).join(''), truncated: true };
}

function boundedString(value: string, ctx?: BoundedCloneContext): string {
  const stringCap = P2P_SANITIZE_MAX_STRING_BYTES;
  const byteCap = ctx ? Math.min(stringCap, Math.max(0, ctx.remainingBytes)) : stringCap;
  const truncated = truncateUtf8String(value, byteCap);
  if (truncated.truncated && ctx) ctx.truncated = true;
  if (ctx) {
    ctx.remainingBytes = Math.max(0, ctx.remainingBytes - Buffer.byteLength(truncated.value, 'utf8'));
  }
  return truncated.value;
}

function chargeBytes(ctx: BoundedCloneContext, value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > ctx.remainingBytes) {
    ctx.truncated = true;
    return false;
  }
  ctx.remainingBytes -= bytes;
  return true;
}

function jsonObjectString(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return '{}';
  const cloned = cloneSafePublicValue(value);
  try {
    if (cloned.truncated || cloned.value === undefined) {
      return JSON.stringify(cloned.value ?? {});
    }
    return JSON.stringify(cloned.value);
  } catch {
    return '{}';
  }
}

function isoTimestamp(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date().toISOString();
}

function normalizeProjectionStatus(value: unknown): P2pWorkflowStatusProjection['status'] {
  if (typeof value !== 'string') return 'running';
  if (PROJECTION_STATUSES.has(value as P2pWorkflowStatusProjection['status'])) {
    return value as P2pWorkflowStatusProjection['status'];
  }
  if (value === 'dispatched' || value === 'awaiting_next_hop' || value === 'timed_out') return 'running';
  return 'failed';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => boundedString(item));
}

function sanitizeDiagnosticString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? boundedString(value)
    : undefined;
}

/**
 * Retain diagnostics produced by workflow parse/compile/bind/execute/project
 * phases. The daemon/server may provide the raw object, but the bridge owns the
 * public shape: known code only, trusted messageKey recomputed, scalar context
 * fields bounded. Unknown codes are dropped rather than surfaced to web.
 */
export function sanitizeWorkflowDiagnosticForRetention(
  raw: unknown,
  fallbackRunId?: string,
): P2pWorkflowDiagnostic | null {
  if (!isRecord(raw)) return null;
  const code = stringValue(raw.code);
  if (!code || !WORKFLOW_DIAGNOSTIC_CODES.has(code)) return null;

  const rawPhase = stringValue(raw.phase);
  const phase = rawPhase && WORKFLOW_DIAGNOSTIC_PHASES.has(rawPhase)
    ? rawPhase as P2pWorkflowDiagnosticPhase
    : undefined;

  const diagnostic = makeP2pWorkflowDiagnostic(code as P2pWorkflowDiagnosticCode, phase, {
    summary: sanitizeDiagnosticString(raw.summary),
    nodeId: sanitizeDiagnosticString(raw.nodeId),
    runId: sanitizeDiagnosticString(raw.runId) ?? fallbackRunId,
    fieldPath: sanitizeDiagnosticString(raw.fieldPath),
  });

  const rawSeverity = stringValue(raw.severity);
  if (rawSeverity && WORKFLOW_DIAGNOSTIC_SEVERITIES.has(rawSeverity)) {
    diagnostic.severity = rawSeverity as P2pWorkflowDiagnosticSeverity;
  }
  // Never trust raw.messageKey; makeP2pWorkflowDiagnostic derives it from code.
  return diagnostic;
}

/**
 * Diagnostics generated by the sanitizer itself remain restricted to sanitize
 * codes. Use this only for server-side generated sanitize events, not for
 * retaining workflow diagnostics from a valid projection/snapshot.
 */
export function sanitizeServerSideDiagnostic(
  raw: unknown,
  fallbackRunId?: string,
): P2pWorkflowDiagnostic | null {
  const retained = sanitizeWorkflowDiagnosticForRetention(raw, fallbackRunId);
  if (!retained || !SERVER_SIDE_SANITIZE_CODES.has(retained.code)) return null;
  return makeP2pWorkflowDiagnostic(retained.code, 'sanitize', {
    summary: retained.summary,
    nodeId: retained.nodeId,
    runId: retained.runId ?? fallbackRunId,
    fieldPath: retained.fieldPath,
  });
}

function collectForbiddenFieldDiagnostics(raw: unknown, runId: string): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, path: string, depth: number) => {
    if (diagnostics.length >= 20 || depth > 5 || !isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const keys = Object.keys(value);
    if (keys.length > P2P_SANITIZE_MAX_OBJECT_KEYS) {
      diagnostics.push(makeP2pWorkflowDiagnostic('private_projection_field_dropped', 'sanitize', {
        runId,
        summary: 'Sanitized oversized workflow payload',
      }));
    }
    for (const key of keys.slice(0, P2P_SANITIZE_MAX_OBJECT_KEYS)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) {
        diagnostics.push(makeP2pWorkflowDiagnostic('private_projection_field_dropped', 'sanitize', {
          runId,
          summary: 'Dropped private field from daemon projection',
        }));
        continue;
      }
      visit(value[key], fieldPath, depth + 1);
    }
  };
  visit(raw, '', 0);
  return diagnostics;
}

function sanitizedRecordArray(value: unknown, allowedKeys: readonly string[]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(allowedKeys);
  const rows: Array<Record<string, unknown>> = [];
  for (const item of value.slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)) {
    if (!isRecord(item)) continue;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(item).slice(0, P2P_SANITIZE_MAX_OBJECT_KEYS)) {
      if (!allowed.has(key)) continue;
      const field = item[key];
      if (
        typeof field === 'number'
        || typeof field === 'boolean'
        || field === null
      ) {
        out[key] = field;
      } else if (typeof field === 'string') {
        out[key] = boundedString(field);
      }
    }
    rows.push(out);
  }
  return rows;
}

function sanitizedNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of Object.keys(value).slice(0, P2P_SANITIZE_MAX_OBJECT_KEYS)) {
    const field = value[key];
    if (typeof field === 'number' && Number.isFinite(field)) out[key] = field;
  }
  return out;
}

function addOptional<T extends object, K extends string>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (value !== undefined) {
    (target as Record<K, unknown>)[key] = value;
  }
}

function cloneSafePublicValue(value: unknown): { value: unknown; truncated: boolean } {
  const ctx: BoundedCloneContext = {
    remainingBytes: P2P_SANITIZE_MAX_TOTAL_BYTES,
    truncated: false,
    seen: new Set<unknown>(),
  };
  return { value: cloneSafePublicValueInner(value, ctx, 0), truncated: ctx.truncated };
}

function cloneSafePublicValueInner(value: unknown, ctx: BoundedCloneContext, depth: number): unknown {
  if (ctx.remainingBytes <= 0) {
    ctx.truncated = true;
    return undefined;
  }
  if (value === null) {
    if (!chargeBytes(ctx, 'null')) return undefined;
    return null;
  }
  if (typeof value === 'string') return boundedString(value, ctx);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !chargeBytes(ctx, String(value))) return undefined;
    return value;
  }
  if (typeof value === 'boolean') {
    if (!chargeBytes(ctx, value ? 'true' : 'false')) return undefined;
    return value;
  }
  if (depth >= P2P_SANITIZE_MAX_DEPTH) {
    ctx.truncated = true;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (ctx.seen.has(value)) {
      ctx.truncated = true;
      return undefined;
    }
    ctx.seen.add(value);
    if (value.length > P2P_SANITIZE_MAX_ARRAY_ITEMS) ctx.truncated = true;
    const output: unknown[] = [];
    for (const entry of value.slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)) {
      const cloned = cloneSafePublicValueInner(entry, ctx, depth + 1);
      if (cloned !== undefined) output.push(cloned);
    }
    ctx.seen.delete(value);
    return output;
  }
  if (isRecord(value)) {
    if (ctx.seen.has(value)) {
      ctx.truncated = true;
      return undefined;
    }
    ctx.seen.add(value);
    const output: Record<string, unknown> = {};
    const keys = Object.keys(value);
    if (keys.length > P2P_SANITIZE_MAX_OBJECT_KEYS) ctx.truncated = true;
    for (const key of keys.slice(0, P2P_SANITIZE_MAX_OBJECT_KEYS)) {
      if (FORBIDDEN_KEYS.has(key)) {
        ctx.truncated = true;
        continue;
      }
      if (!chargeBytes(ctx, key)) break;
      const cloned = cloneSafePublicValueInner(value[key], ctx, depth + 1);
      if (cloned !== undefined) output[key] = cloned;
    }
    ctx.seen.delete(value);
    return output;
  }
  return undefined;
}

function sanitizeCapabilitySnapshot(raw: unknown): P2pWorkflowStatusProjection['capabilitySnapshot'] | undefined {
  if (!isRecord(raw)) return undefined;
  const daemonId = stringValue(raw.daemonId);
  const helloEpoch = numberValue(raw.helloEpoch, Number.NaN);
  const sentAt = numberValue(raw.sentAt, Number.NaN);
  if (!daemonId || !Number.isFinite(helloEpoch) || !Number.isFinite(sentAt)) return undefined;
  return {
    daemonId,
    capabilities: stringArray(raw.capabilities),
    helloEpoch,
    sentAt,
  };
}

export function sanitizeP2pWorkflowStatusProjection(
  raw: unknown,
  diagnosticSource: unknown = raw,
): P2pWorkflowStatusProjection {
  const source = isRecord(raw) ? raw : {};
  const runId = requiredString(source.runId ?? source.id, 'unknown');
  const workflowId = requiredString(source.workflowId ?? source.workflow_id ?? source.mode_key, 'legacy');
  const currentNodeId = stringValue(source.currentNodeId ?? source.current_node_id ?? source.current_round_id ?? source.current_target_session);
  const updatedAt = isoTimestamp(source.updatedAt ?? source.updated_at);
  const rawDiagnostics = Array.isArray(source.diagnostics)
    ? source.diagnostics.slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
    : [];
  const diagnostics = rawDiagnostics
    .map((item) => sanitizeWorkflowDiagnosticForRetention(item, runId))
    .filter((item): item is P2pWorkflowDiagnostic => item !== null);
  diagnostics.push(...collectForbiddenFieldDiagnostics(diagnosticSource, runId));

  return {
    projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
    runId,
    workflowId,
    status: normalizeProjectionStatus(source.status),
    ...(currentNodeId ? { currentNodeId } : {}),
    completedNodeIds: stringArray(source.completedNodeIds ?? source.completed_node_ids),
    diagnostics,
    ...(sanitizeCapabilitySnapshot(source.capabilitySnapshot) ? { capabilitySnapshot: sanitizeCapabilitySnapshot(source.capabilitySnapshot) } : {}),
    updatedAt,
  };
}

export function sanitizeP2pPersistedWorkflowSnapshot(raw: unknown): P2pPersistedWorkflowSnapshot {
  return buildPersistedSnapshotFromProjection(sanitizeP2pWorkflowStatusProjection(raw));
}

export type LegacyProgressSnapshotSanitizeResult = {
  projection: P2pWorkflowStatusProjection;
  snapshot: P2pPersistedWorkflowSnapshot;
  diagnostic: P2pWorkflowDiagnostic | null;
};

/**
 * Detect whether a parsed object is already a valid persisted-projection snapshot.
 * Avoids re-sanitizing rows that were written by the new projection-only path.
 */
function isValidPersistedSnapshotShape(value: unknown): value is P2pPersistedWorkflowSnapshot {
  if (!isRecord(value)) return false;
  if (value.projectionVersion !== P2P_WORKFLOW_PROJECTION_VERSION) return false;
  if (typeof value.runId !== 'string' || value.runId === '') return false;
  if (typeof value.workflowId !== 'string' || value.workflowId === '') return false;
  if (typeof value.updatedAt !== 'string' || value.updatedAt === '') return false;
  if (!PROJECTION_STATUSES.has(value.status as P2pWorkflowStatusProjection['status'])) return false;
  if (!Array.isArray(value.completedNodeIds)) return false;
  if (value.completedNodeIds.some((id) => typeof id !== 'string' || id === '')) return false;
  if (!Array.isArray(value.diagnostics)) return false;
  if (value.currentNodeId !== undefined && typeof value.currentNodeId !== 'string') return false;
  // Persisted snapshots are projection-only and must NOT carry projection-extra fields.
  if (value.capabilitySnapshot !== undefined) return false;
  if (value.artifactSummaries !== undefined) return false;
  if (value.nodeSummaries !== undefined) return false;
  // Reject any forbidden private keys at the top level.
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return false;
  }
  return true;
}

function emptyValidLegacyProjection(runId: string, workflowId: string): P2pWorkflowStatusProjection {
  return {
    projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
    runId: runId || 'unknown',
    workflowId: workflowId || 'legacy',
    status: 'stale',
    completedNodeIds: [],
    diagnostics: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Optional row-level context for `sanitizeLegacyP2pProgressSnapshot`. When the
 *  caller has the real `id` / `discussion_id` of the DB row being read, they
 *  should be passed here so legacy diagnostics can be traced back to a
 *  concrete row instead of the placeholder `'unknown'` / `'legacy'`. */
export type SanitizeLegacyP2pProgressSnapshotContext = {
  runId?: string;
  workflowId?: string;
};

function isEmptyPlaceholderObject(value: unknown): value is Record<string, never> {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 0;
}

/**
 * Read-time sanitizer for legacy `progress_snapshot` JSON strings stored in
 * `discussion_orchestration_runs.progress_snapshot`.
 *
 * Behavior:
 * - Parses the JSON; on parse failure returns a safe empty projection plus a
 *   `legacy_progress_snapshot_sanitized` diagnostic.
 * - If the parsed value is the empty placeholder `{}` (the migration default
 *   for newly-created rows that have not yet written a projection), returns a
 *   safe empty projection WITHOUT a diagnostic — these rows are not "legacy",
 *   they are simply uninitialized.
 * - If the parsed object is already a valid `P2pPersistedWorkflowSnapshot`
 *   (correct projection version, required fields, no private/forbidden keys),
 *   it is returned unchanged with no diagnostic.
 * - Otherwise, treats the row as legacy and projects it through the
 *   allowlist sanitizer, attaches `legacy_progress_snapshot_sanitized`, and
 *   returns the new projection + persisted snapshot.
 *
 * Optional `context` lets callers supply the real DB `runId` / `workflowId` so
 * legacy diagnostics retain audit traceability to the originating row instead
 * of falling back to the `'unknown'` / `'legacy'` placeholders.
 *
 * This function MUST NOT mutate any DB row; it is a read-time projection only.
 */
export function sanitizeLegacyP2pProgressSnapshot(
  rawSnapshotJson: string,
  context?: SanitizeLegacyP2pProgressSnapshotContext,
): LegacyProgressSnapshotSanitizeResult {
  const safeRunId = context?.runId && context.runId !== '' ? context.runId : 'unknown';
  const safeWorkflowId = context?.workflowId && context.workflowId !== '' ? context.workflowId : 'legacy';

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSnapshotJson);
  } catch {
    const projection = emptyValidLegacyProjection(safeRunId, safeWorkflowId);
    const diagnostic = makeP2pWorkflowDiagnostic('legacy_progress_snapshot_sanitized', 'sanitize', {
      runId: projection.runId,
      summary: 'Sanitized malformed legacy progress snapshot',
    });
    projection.diagnostics.push(diagnostic);
    return {
      projection,
      snapshot: buildPersistedSnapshotFromProjection(projection),
      diagnostic,
    };
  }

  // Empty placeholder ({}): this is the default value of the migration column
  // for freshly-created rows that have not yet emitted a projection. They are
  // NOT legacy and must not pollute metrics or the UI with a sanitize
  // diagnostic — return a quiet empty projection.
  if (isEmptyPlaceholderObject(parsed)) {
    const projection = emptyValidLegacyProjection(safeRunId, safeWorkflowId);
    return {
      projection,
      snapshot: buildPersistedSnapshotFromProjection(projection),
      diagnostic: null,
    };
  }

  if (isValidPersistedSnapshotShape(parsed)) {
    // Already projection-shaped; return unchanged. We still re-build the
    // persisted snapshot through the canonical builder so callers can rely
    // on a consistent return shape, but no sanitize diagnostic is emitted.
    const projection: P2pWorkflowStatusProjection = {
      projectionVersion: P2P_WORKFLOW_PROJECTION_VERSION,
      runId: parsed.runId,
      workflowId: parsed.workflowId,
      status: parsed.status,
      ...(parsed.currentNodeId ? { currentNodeId: parsed.currentNodeId } : {}),
      completedNodeIds: [...parsed.completedNodeIds],
      diagnostics: parsed.diagnostics
        .map((item) => sanitizeWorkflowDiagnosticForRetention(item, parsed.runId))
        .filter((diagnostic): diagnostic is P2pWorkflowDiagnostic => diagnostic !== null),
      updatedAt: parsed.updatedAt,
    };
    return {
      projection,
      snapshot: buildPersistedSnapshotFromProjection(projection),
      diagnostic: null,
    };
  }

  // Legacy or otherwise non-conforming payload: project through the allowlist
  // sanitizer, which already drops `__proto__`, `constructor`, `compiledWorkflow`,
  // `rawPrompt`, `scriptRawOutputs`, `artifactBaselines`, env/token-like keys, etc.
  const projection = sanitizeP2pWorkflowStatusProjection(parsed);
  // Restore audit-traceable IDs from the row context: the inner sanitizer can
  // only see what was inside the JSON blob (often missing or wrong for legacy
  // rows). Prefer the real DB ids that the caller passed in.
  if (context?.runId && context.runId !== '' && (projection.runId === 'unknown' || projection.runId === '')) {
    projection.runId = context.runId;
  }
  if (context?.workflowId && context.workflowId !== '' && (projection.workflowId === 'legacy' || projection.workflowId === '')) {
    projection.workflowId = context.workflowId;
  }
  const diagnostic = makeP2pWorkflowDiagnostic('legacy_progress_snapshot_sanitized', 'sanitize', {
    runId: projection.runId,
    summary: 'Sanitized legacy progress snapshot at read time',
  });
  projection.diagnostics.push(diagnostic);
  return {
    projection,
    snapshot: buildPersistedSnapshotFromProjection(projection),
    diagnostic,
  };
}

export function sanitizeP2pOrchestrationRunForBridge(raw: unknown, overrides: {
  serverId: string;
  status?: string;
  completedAt?: string | null;
  updatedAt?: string;
}): SanitizedP2pOrchestrationRun {
  const source = isRecord(raw) ? raw : {};
  const sharedActor = normalizeSharedActor(source.sharedActor);
  const shareScope = normalizeShareScope(source.shareScope, sharedActor);
  const authorizationSnapshot = sharedActor?.snapshot ?? normalizeShareAuthorizationSnapshot(source.authorization_snapshot);
  const shareTarget = shareScope?.target ?? authorizationSnapshot?.target ?? normalizeShareTarget(source.share_target_snapshot ?? source.shareTargetSnapshot);
  const updatedAt = overrides.updatedAt ?? isoTimestamp(source.updated_at ?? source.updatedAt);
  const runForProjection = {
    id: source.id,
    runId: source.runId,
    workflowId: source.workflowId,
    workflow_id: source.workflow_id,
    mode_key: source.mode_key,
    status: overrides.status ?? source.status,
    currentNodeId: source.currentNodeId,
    current_node_id: source.current_node_id,
    current_round_id: source.current_round_id,
    current_target_session: source.current_target_session,
    completedNodeIds: source.completedNodeIds,
    completed_node_ids: source.completed_node_ids,
    diagnostics: source.diagnostics,
    capabilitySnapshot: source.capabilitySnapshot,
    updated_at: updatedAt,
  };
  const projection = sanitizeP2pWorkflowStatusProjection(runForProjection, raw);
  const snapshot = buildPersistedSnapshotFromProjection(projection);

  const sanitized: SanitizedP2pOrchestrationRun = {
    id: requiredString(source.id ?? source.runId, projection.runId),
    discussion_id: requiredString(source.discussion_id, ''),
    server_id: overrides.serverId,
    main_session: requiredString(source.main_session, ''),
    initiator_session: requiredString(source.initiator_session, ''),
    current_target_session: nullableString(source.current_target_session),
    final_return_session: requiredString(source.final_return_session, ''),
    remaining_targets: jsonObjectString(source.remaining_targets),
    mode_key: requiredString(source.mode_key, projection.workflowId),
    status: overrides.status ?? requiredString(source.status, projection.status),
    request_message_id: nullableString(source.request_message_id),
    callback_message_id: nullableString(source.callback_message_id),
    context_ref: jsonObjectString(source.context_ref),
    timeout_ms: numberValue(source.timeout_ms, 0),
    result_summary: nullableString(source.result_summary),
    error: nullableString(source.error),
    progress_snapshot: JSON.stringify(snapshot),
    created_at: isoTimestamp(source.created_at),
    updated_at: updatedAt,
    completed_at: overrides.completedAt === undefined ? nullableString(source.completed_at) : overrides.completedAt,
    workflow_projection: projection,
  };
  addOptional(sanitized, 'current_round', optionalNumber(source.current_round));
  addOptional(sanitized, 'total_rounds', optionalNumber(source.total_rounds));
  addOptional(sanitized, 'total_count', optionalNumber(source.total_count));
  addOptional(sanitized, 'total_hops', optionalNumber(source.total_hops));
  addOptional(sanitized, 'completed_hops_count', optionalNumber(source.completed_hops_count));
  addOptional(sanitized, 'active_hop_number', nullableNumber(source.active_hop_number));
  addOptional(sanitized, 'active_round_hop_number', nullableNumber(source.active_round_hop_number));
  addOptional(sanitized, 'active_phase', stringValue(source.active_phase) ?? undefined);
  addOptional(sanitized, 'execution_attempt', nullableNumber(source.execution_attempt));
  addOptional(sanitized, 'execution_cycle_current', nullableNumber(source.execution_cycle_current));
  addOptional(sanitized, 'execution_cycle_total', nullableNumber(source.execution_cycle_total));
  addOptional(sanitized, 'current_round_mode', stringValue(source.current_round_mode) ?? undefined);
  addOptional(sanitized, 'current_target_label', nullableString(source.current_target_label));
  addOptional(sanitized, 'initiator_label', nullableString(source.initiator_label));
  addOptional(sanitized, 'run_phase', stringValue(source.run_phase) ?? undefined);
  addOptional(sanitized, 'summary_phase', nullableString(source.summary_phase));
  addOptional(sanitized, 'hop_states', sanitizedRecordArray(source.hop_states, [
    'hop_index',
    'round_index',
    'session',
    'mode',
    'status',
    'started_at',
    'completed_at',
    'error',
  ]));
  addOptional(sanitized, 'hop_counts', sanitizedNumberRecord(source.hop_counts));
  addOptional(sanitized, 'all_nodes', sanitizedRecordArray(source.all_nodes, [
    'session',
    'label',
    'displayLabel',
    'display_label',
    'agentType',
    'ccPreset',
    'cc_preset',
    'mode',
    'phase',
    'status',
  ]));
  addOptional(sanitized, 'advanced_p2p_enabled', typeof source.advanced_p2p_enabled === 'boolean' ? source.advanced_p2p_enabled : undefined);
  addOptional(sanitized, 'current_round_id', nullableString(source.current_round_id));
  addOptional(sanitized, 'advanced_nodes', sanitizedRecordArray(source.advanced_nodes, [
    'id',
    'title',
    'preset',
    'status',
    'attempt',
    'step',
  ]));
  if (shareTarget) {
    addOptional(sanitized, 'scope_kind', shareTarget.kind);
    addOptional(sanitized, 'scope_server_id', shareTarget.serverId);
    addOptional(sanitized, 'scope_session_name', shareTarget.kind === 'main' ? shareTarget.sessionName : null);
    addOptional(sanitized, 'scope_sub_session_id', shareTarget.kind === 'subsession' ? shareTarget.subSessionId : null);
    addOptional(sanitized, 'share_target_snapshot', shareTarget);
  }
  if (authorizationSnapshot) {
    addOptional(sanitized, 'authorization_snapshot', authorizationSnapshot);
    addOptional(sanitized, 'primary_share_id', authorizationSnapshot.primaryShareId);
    addOptional(sanitized, 'covering_share_ids', authorizationSnapshot.coveringShareIds);
    addOptional(sanitized, 'visible_after_ms', optionalNumber(source.visible_after_ms) ?? optionalNumber(source.visibleAfterMs) ?? 0);
    addOptional(sanitized, 'history_cutoff_at_ms', authorizationSnapshot.historyCutoffAt);
  } else if (shareScope) {
    addOptional(sanitized, 'primary_share_id', shareScope.primaryShareId);
    addOptional(sanitized, 'covering_share_ids', shareScope.coveringShareIds);
    addOptional(sanitized, 'visible_after_ms', optionalNumber(source.visible_after_ms) ?? optionalNumber(source.visibleAfterMs) ?? 0);
    addOptional(sanitized, 'history_cutoff_at_ms', shareScope.historyCutoffAt);
  }
  if (sharedActor) {
    addOptional(sanitized, 'created_by_user_id', sharedActor.actorUserId);
    addOptional(sanitized, 'sharedActor', sharedActor);
  }
  if (shareScope) addOptional(sanitized, 'shareScope', shareScope);
  return sanitized;
}

export function sanitizeP2pRunUpdateForBroadcast(raw: unknown, overrides: {
  serverId: string;
  status?: string;
  completedAt?: string | null;
  updatedAt?: string;
}): SanitizedP2pRunUpdate {
  const source = isRecord(raw) ? raw : {};
  const run = sanitizeP2pOrchestrationRunForBridge(source, overrides) as SanitizedP2pRunUpdate;
  let legacyPayloadTruncated = false;
  for (const field of SAFE_LEGACY_RUN_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const cloned = cloneSafePublicValue(source[field]);
    if (cloned.truncated) legacyPayloadTruncated = true;
    if (cloned.value !== undefined) (run as Record<string, unknown>)[field] = cloned.value;
  }
  if (legacyPayloadTruncated) {
    run.workflow_projection.diagnostics.push(makeP2pWorkflowDiagnostic('private_projection_field_dropped', 'sanitize', {
      runId: run.id,
      summary: 'Sanitized oversized workflow payload',
    }));
  }
  return run;
}

/**
 * Canonical single-pass sanitize for P2P run RUN_SAVE/RUN_COMPLETE/RUN_ERROR
 * paths. Produces ONE projection that is shared between the DB upsert payload
 * and the broadcast payload. Both `persisted` and `broadcast` reference the same
 * `workflow_projection` object (and same `progress_snapshot` JSON), so the set
 * of diagnostic codes the browser sees is byte-identical to what is written to
 * the DB row.
 *
 * The DB-bound `persisted` payload deliberately omits legacy public fields like
 * `hop_states`, `routing_history` etc.; those are broadcast-only (the columns
 * used by `upsertOrchestrationRun` already form a strict subset of
 * `SanitizedP2pOrchestrationRun`). The broadcast payload re-uses the same
 * sanitized base and layers the legacy public fields on top.
 */
export function sanitizeP2pRunForPersistAndBroadcast(raw: unknown, overrides: {
  serverId: string;
  status?: string;
  completedAt?: string | null;
  updatedAt?: string;
}): { persisted: SanitizedP2pOrchestrationRun; broadcast: SanitizedP2pRunUpdate } {
  const source = isRecord(raw) ? raw : {};
  const persisted = sanitizeP2pOrchestrationRunForBridge(source, overrides);

  // Broadcast shares the SAME projection object (and progress_snapshot string)
  // as the persisted payload, but adds legacy public fields. Mutating
  // `broadcast.workflow_projection.diagnostics` (e.g. for truncation) therefore
  // also updates `persisted.workflow_projection.diagnostics` — the DB and the
  // browser stay in sync by construction.
  const broadcast: SanitizedP2pRunUpdate = { ...persisted } as SanitizedP2pRunUpdate;
  broadcast.workflow_projection = persisted.workflow_projection;

  let legacyPayloadTruncated = false;
  for (const field of SAFE_LEGACY_RUN_UPDATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const cloned = cloneSafePublicValue(source[field]);
    if (cloned.truncated) legacyPayloadTruncated = true;
    if (cloned.value !== undefined) (broadcast as Record<string, unknown>)[field] = cloned.value;
  }
  if (legacyPayloadTruncated) {
    const truncationDiagnostic = makeP2pWorkflowDiagnostic('private_projection_field_dropped', 'sanitize', {
      runId: persisted.id,
      summary: 'Sanitized oversized workflow payload',
    });
    persisted.workflow_projection.diagnostics.push(truncationDiagnostic);
    // Re-serialize the persisted snapshot string so the DB column reflects the
    // truncation diagnostic too. This keeps the DB and broadcast bytes aligned.
    const refreshed = buildPersistedSnapshotFromProjection(persisted.workflow_projection);
    persisted.progress_snapshot = JSON.stringify(refreshed);
  }
  return { persisted, broadcast };
}
