export type SessionActivityBusyReason =
  | 'runtime_dispatch'
  | 'active_dispatch_entry'
  | 'recoverable_retry'
  | 'provider_session_binding'
  | 'provider_tool_item'
  | 'provider_compaction'
  | 'provider_background'
  | 'background_monitor'
  | 'provider_wait'
  | 'open_tool_call'
  | 'snapshot_stale'
  | 'snapshot_unavailable'
  | 'snapshot_error'
  | 'pending_queue_drain'
  | 'daemon_restart_orphan';

export type ProviderSnapshotStatus = 'current' | 'stale' | 'unavailable' | 'error';

export type ToolTerminalStatus = 'succeeded' | 'abandoned' | 'cancelled' | 'errored' | 'stale';

export type ToolTerminalReason =
  | 'provider_result'
  | 'provider_error'
  | 'provider_cancelled'
  | 'provider_interrupted'
  | 'user_cancelled'
  | 'generation_rollover'
  | 'daemon_restart_orphan'
  | 'provider_stale'
  | 'thread_idle_settle'
  | 'app_server_completed'
  | 'app_server_failed'
  | 'app_server_disconnect'
  | 'auth_refresh_recovery_failed'
  | 'app_server_restart_recovery_failed'
  | 'unexpected_eof'
  | 'no_current_work_disconnect'
  | 'unknown_tool'
  | 'duplicate_terminal';

export type CodexLifecycleEvidenceSource =
  | 'app_server_jsonrpc'
  | 'exec_jsonl_compat'
  | 'rollout_jsonl_diagnostic'
  | 'provider_snapshot'
  | 'projection_only'
  | 'daemon_synthetic';

export type CodexLifecycleItemKind =
  | 'turn_start'
  | 'command_execution'
  | 'web_search'
  | 'mcp_tool_call'
  | 'provider_tool_like'
  | 'sdk_subagent'
  | 'codex_collaboration'
  | 'context_compaction'
  | 'agent_message'
  | 'reasoning'
  | 'usage_or_status'
  | 'diagnostic'
  | 'unknown';

export interface ActivityGeneration {
  scope: 'session';
  sessionName: string;
  generation: number;
}

export type ActivityGenerationLike = ActivityGeneration | number | string | null | undefined;

export interface ActivityDiagnosticInput {
  source: string;
  reason: SessionActivityBusyReason | 'clear';
  count?: number;
}

export interface ProviderActiveWorkSnapshot {
  status?: ProviderSnapshotStatus;
  activeWorkCount: number;
  activeToolCount: number;
  busyReasons: SessionActivityBusyReason[];
  /** Runtime-minted generation. Required for a clear snapshot to prove clean idle. */
  activityGeneration?: ActivityGenerationLike;
  /** Provider-native diagnostic id (turn id, conversation id, etc.). Never a clean-idle proof. */
  providerDiagnosticGeneration?: string | number | null;
  /** @deprecated use activityGeneration for runtime proof and providerDiagnosticGeneration for diagnostics. */
  generation?: ActivityGenerationLike;
  updatedAt?: number;
}

export interface AuthoritativeIdlePayload {
  state: 'idle';
  authoritative: true;
  activityGeneration: ActivityGenerationLike;
  blockingWorkCount: 0;
  activeWorkCount: 0;
  activeToolCount: 0;
  pendingCount: number;
  pendingVersion: number;
  decisionReason: string;
  clearInputs: ActivityDiagnosticInput[];
}

export interface ActivityDrainEntryMetadata {
  clientMessageId: string;
  ordinal: number;
  queuedAt?: number;
  replyToMessageId?: string;
  attachmentIds?: string[];
  actorSessionName?: string;
  sharedActionId?: string;
}

export interface ActivityDrainMetadata {
  activityGeneration: ActivityGenerationLike;
  pendingVersion: number;
  entries: ActivityDrainEntryMetadata[];
}

export interface CodexLifecycleTerminalMetadata {
  sessionId: string;
  terminalStatus: ToolTerminalStatus;
  terminalReason: ToolTerminalReason;
  synthetic: boolean;
  source: CodexLifecycleEvidenceSource;
  decisionReason: string;
  idempotencyKey: string;
  activityGeneration?: ActivityGenerationLike;
  itemId?: string;
  toolCallId?: string;
  turnId?: string;
  itemKind?: CodexLifecycleItemKind;
}

export interface TimelineActivityEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface TimelineActivityState {
  active: boolean;
  degraded: boolean;
  openToolCount: number;
  currentGeneration?: string;
  degradedReasons: string[];
  lastTerminalStatus?: ToolTerminalStatus;
  lastTerminalReason?: string;
}

export function normalizeActivityGeneration(value: ActivityGenerationLike): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? `session:${value}` : null;
  if (typeof value === 'string') return value.trim() || null;
  const sessionName = value.sessionName.trim();
  if (!sessionName || !Number.isFinite(value.generation)) return null;
  return `${value.scope}:${sessionName}:${value.generation}`;
}

const TOOL_TERMINAL_STATUSES = new Set<ToolTerminalStatus>([
  'succeeded',
  'abandoned',
  'cancelled',
  'errored',
  'stale',
]);

const TOOL_TERMINAL_REASONS = new Set<ToolTerminalReason>([
  'provider_result',
  'provider_error',
  'provider_cancelled',
  'provider_interrupted',
  'user_cancelled',
  'generation_rollover',
  'daemon_restart_orphan',
  'provider_stale',
  'thread_idle_settle',
  'app_server_completed',
  'app_server_failed',
  'app_server_disconnect',
  'auth_refresh_recovery_failed',
  'app_server_restart_recovery_failed',
  'unexpected_eof',
  'no_current_work_disconnect',
  'unknown_tool',
  'duplicate_terminal',
]);

const CODEX_LIFECYCLE_SOURCES = new Set<CodexLifecycleEvidenceSource>([
  'app_server_jsonrpc',
  'exec_jsonl_compat',
  'rollout_jsonl_diagnostic',
  'provider_snapshot',
  'projection_only',
  'daemon_synthetic',
]);

const CODEX_LIFECYCLE_ITEM_KINDS = new Set<CodexLifecycleItemKind>([
  'turn_start',
  'command_execution',
  'web_search',
  'mcp_tool_call',
  'provider_tool_like',
  'sdk_subagent',
  'codex_collaboration',
  'context_compaction',
  'agent_message',
  'reasoning',
  'usage_or_status',
  'diagnostic',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanMetadataString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function buildCodexLifecycleIdempotencyKey(input: {
  sessionId: string;
  terminalStatus: ToolTerminalStatus;
  terminalReason: ToolTerminalReason;
  activityGeneration?: ActivityGenerationLike;
  itemId?: string;
  toolCallId?: string;
  turnId?: string;
}): string {
  const generation = normalizeActivityGeneration(input.activityGeneration) ?? 'generation:unknown';
  const workId = input.itemId?.trim()
    ? `item:${input.itemId.trim()}`
    : input.toolCallId?.trim()
      ? `tool:${input.toolCallId.trim()}`
      : input.turnId?.trim()
        ? `turn:${input.turnId.trim()}`
        : 'work:unknown';
  return [
    'codex-terminal',
    input.sessionId.trim() || 'session:unknown',
    generation,
    workId,
    input.terminalStatus,
    input.terminalReason,
  ].join(':');
}

export function isCodexLifecycleTerminalMetadata(value: unknown): value is CodexLifecycleTerminalMetadata {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) return false;
  if (!TOOL_TERMINAL_STATUSES.has(value.terminalStatus as ToolTerminalStatus)) return false;
  if (!TOOL_TERMINAL_REASONS.has(value.terminalReason as ToolTerminalReason)) return false;
  if (typeof value.synthetic !== 'boolean') return false;
  if (!CODEX_LIFECYCLE_SOURCES.has(value.source as CodexLifecycleEvidenceSource)) return false;
  if (typeof value.decisionReason !== 'string' || !value.decisionReason.trim()) return false;
  if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim()) return false;
  if (value.activityGeneration !== undefined && normalizeActivityGeneration(value.activityGeneration as ActivityGenerationLike) === null) return false;
  if (value.itemId !== undefined && (typeof value.itemId !== 'string' || !value.itemId.trim())) return false;
  if (value.toolCallId !== undefined && (typeof value.toolCallId !== 'string' || !value.toolCallId.trim())) return false;
  if (value.turnId !== undefined && (typeof value.turnId !== 'string' || !value.turnId.trim())) return false;
  if (value.itemKind !== undefined && !CODEX_LIFECYCLE_ITEM_KINDS.has(value.itemKind as CodexLifecycleItemKind)) return false;
  return true;
}

export function buildCodexLifecycleTerminalMetadata(input: Omit<CodexLifecycleTerminalMetadata, 'idempotencyKey'> & { idempotencyKey?: string }): CodexLifecycleTerminalMetadata {
  const idempotencyKey = input.idempotencyKey ?? buildCodexLifecycleIdempotencyKey(input);
  return {
    sessionId: input.sessionId,
    terminalStatus: input.terminalStatus,
    terminalReason: input.terminalReason,
    synthetic: input.synthetic,
    source: input.source,
    decisionReason: input.decisionReason,
    idempotencyKey,
    ...(input.activityGeneration !== undefined ? { activityGeneration: input.activityGeneration } : {}),
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.itemKind !== undefined ? { itemKind: input.itemKind } : {}),
  };
}

export function toPrivacySafeLifecycleMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const stringKeys = [
    'sessionId',
    'itemId',
    'toolCallId',
    'turnId',
    'terminalStatus',
    'terminalReason',
    'source',
    'decisionReason',
    'idempotencyKey',
    'itemKind',
  ];
  for (const key of stringKeys) {
    const value = cleanMetadataString(input[key]);
    if (value !== undefined) output[key] = value;
  }
  if (typeof input.synthetic === 'boolean') output.synthetic = input.synthetic;
  if (typeof input.activeWorkCount === 'number' && Number.isFinite(input.activeWorkCount)) output.activeWorkCount = input.activeWorkCount;
  if (typeof input.activeToolCount === 'number' && Number.isFinite(input.activeToolCount)) output.activeToolCount = input.activeToolCount;
  if (typeof input.blockingWorkCount === 'number' && Number.isFinite(input.blockingWorkCount)) output.blockingWorkCount = input.blockingWorkCount;
  if (input.activityGeneration !== undefined && normalizeActivityGeneration(input.activityGeneration as ActivityGenerationLike) !== null) {
    output.activityGeneration = input.activityGeneration;
  }
  return output;
}

export function sameActivityGeneration(a: ActivityGenerationLike, b: ActivityGenerationLike): boolean {
  const left = normalizeActivityGeneration(a);
  const right = normalizeActivityGeneration(b);
  return left !== null && right !== null && left === right;
}

export type ProviderSnapshotEvaluation =
  | { state: 'none'; blocking: false; clear: false; reason: 'snapshot_unavailable' }
  | { state: 'active'; blocking: true; clear: false; reason: SessionActivityBusyReason }
  | { state: 'clear'; blocking: false; clear: true; reason: 'clear' }
  | { state: 'stale'; blocking: true; clear: false; reason: 'snapshot_stale' }
  | { state: 'unavailable'; blocking: true; clear: false; reason: 'snapshot_unavailable' }
  | { state: 'error'; blocking: true; clear: false; reason: 'snapshot_error' }
  | { state: 'unattributed_clear'; blocking: true; clear: false; reason: 'snapshot_unavailable' };

export function evaluateProviderSnapshot(
  snapshot: ProviderActiveWorkSnapshot | null | undefined,
  currentGeneration?: ActivityGenerationLike,
): ProviderSnapshotEvaluation {
  if (!snapshot) return { state: 'none', blocking: false, clear: false, reason: 'snapshot_unavailable' };
  const status = snapshot.status ?? 'current';
  if (status === 'stale') return { state: 'stale', blocking: true, clear: false, reason: 'snapshot_stale' };
  if (status === 'unavailable') return { state: 'unavailable', blocking: true, clear: false, reason: 'snapshot_unavailable' };
  if (status === 'error') return { state: 'error', blocking: true, clear: false, reason: 'snapshot_error' };
  if (snapshot.activeWorkCount > 0 || snapshot.activeToolCount > 0) {
    return { state: 'active', blocking: true, clear: false, reason: snapshot.busyReasons[0] ?? 'provider_tool_item' };
  }
  const snapshotGeneration = snapshot.activityGeneration ?? snapshot.generation;
  if (currentGeneration !== undefined && !sameActivityGeneration(snapshotGeneration, currentGeneration)) {
    const snapshotNormalized = normalizeActivityGeneration(snapshotGeneration);
    const currentNormalized = normalizeActivityGeneration(currentGeneration);
    const currentPrefix = typeof currentGeneration === 'object' && currentGeneration
      ? `session:${currentGeneration.sessionName}:`
      : null;
    if (snapshotNormalized && currentNormalized && currentPrefix && snapshotNormalized.startsWith(currentPrefix)) {
      return { state: 'stale', blocking: true, clear: false, reason: 'snapshot_stale' };
    }
    return { state: 'unattributed_clear', blocking: true, clear: false, reason: 'snapshot_unavailable' };
  }
  return { state: 'clear', blocking: false, clear: true, reason: 'clear' };
}

export function isProviderSnapshotNonBlockingForStoppedGeneration(
  snapshot: ProviderActiveWorkSnapshot | null | undefined,
  stoppedGeneration: ActivityGenerationLike,
): boolean {
  if (!snapshot) return false;
  if ((snapshot.status ?? 'current') !== 'current') return false;
  if (snapshot.activeWorkCount <= 0 && snapshot.activeToolCount <= 0) return false;
  const snapshotGeneration = snapshot.activityGeneration ?? snapshot.generation;
  return sameActivityGeneration(snapshotGeneration, stoppedGeneration);
}

export function isProviderSnapshotBlocking(
  snapshot: ProviderActiveWorkSnapshot | null | undefined,
  currentGeneration?: ActivityGenerationLike,
): boolean {
  return evaluateProviderSnapshot(snapshot, currentGeneration).blocking;
}

export function hasProviderActiveWork(snapshot: ProviderActiveWorkSnapshot | null | undefined): boolean {
  return isProviderSnapshotBlocking(snapshot);
}

export const SDK_TURN_LOST_RECOVERY_REASON = 'sdk_turn_lost' as const;

export type SdkTurnLostClassifier =
  | 'idle_missing_turn'
  | 'not_loaded_with_active_lease'
  | 'start_grace_expired_no_current_turn';

export type SdkTurnLostReplayDecision =
  | 'pending'
  | 'safe_replay'
  | 'unsafe_side_effect'
  | 'unsafe_ambiguous'
  | 'unsafe_terminal'
  | 'budget_exhausted'
  | 'failed'
  | 'not_applicable';

export type SdkTurnLostRecoveryPhase = 'detected' | 'recovering' | 'recovered' | 'failed';

export interface SdkTurnLostRecoveryMetadata {
  reason: typeof SDK_TURN_LOST_RECOVERY_REASON;
  localSessionKey: string;
  sessionName?: string;
  providerId?: string;
  providerSessionId?: string;
  codexThreadId?: string;
  codexTurnId?: string;
  activityGeneration: ActivityGenerationLike;
  leaseStartedAt?: number;
  lastStrongActivityAt?: number;
  lastProviderEventAt?: number;
  heartbeatStartedAt?: number;
  heartbeatCompletedAt?: number;
  heartbeatDurationMs?: number;
  heartbeatFailureCount?: number;
  silenceDurationMs?: number;
  classifier: SdkTurnLostClassifier;
  attempt?: number;
  recoveryAttemptId?: string;
  correlationId?: string;
  replayDecision: SdkTurnLostReplayDecision;
  phase?: SdkTurnLostRecoveryPhase;
}

export interface SdkTurnLostRecoveryEnvelope {
  reason: typeof SDK_TURN_LOST_RECOVERY_REASON;
  metadata: SdkTurnLostRecoveryMetadata;
}

const SDK_TURN_LOST_CLASSIFIERS = new Set<SdkTurnLostClassifier>([
  'idle_missing_turn',
  'not_loaded_with_active_lease',
  'start_grace_expired_no_current_turn',
]);

const SDK_TURN_LOST_REPLAY_DECISIONS = new Set<SdkTurnLostReplayDecision>([
  'pending',
  'safe_replay',
  'unsafe_side_effect',
  'unsafe_ambiguous',
  'unsafe_terminal',
  'budget_exhausted',
  'failed',
  'not_applicable',
]);

const SDK_TURN_LOST_RECOVERY_PHASES = new Set<SdkTurnLostRecoveryPhase>([
  'detected',
  'recovering',
  'recovered',
  'failed',
]);

export interface SdkTurnLostRecoverySanitizeOptions {
  expectedLocalSessionKey?: string;
  expectedSessionName?: string;
  expectedProviderSessionId?: string;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function readString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function readFiniteNumber(value: unknown, maxValue = Number.MAX_SAFE_INTEGER): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.trunc(value), maxValue);
}

function isActivityGenerationLikeValue(value: unknown): value is ActivityGenerationLike {
  return normalizeActivityGeneration(value as ActivityGenerationLike) !== null;
}

function sanitizeActivityGenerationValue(value: unknown): ActivityGenerationLike | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 256) : null;
  }
  const object = readObject(value);
  if (!object) return null;
  if (object.scope !== 'session') return null;
  const sessionName = readString(object.sessionName, 256);
  const generation = readFiniteNumber(object.generation);
  if (!sessionName || generation === undefined) return null;
  return {
    scope: 'session',
    sessionName,
    generation,
  };
}

function expectedMatches(actual: string | undefined, expected: string | undefined): boolean {
  return !actual || !expected || actual === expected;
}

export function isSdkTurnLostRecoveryPhase(value: unknown): value is SdkTurnLostRecoveryPhase {
  return SDK_TURN_LOST_RECOVERY_PHASES.has(value as SdkTurnLostRecoveryPhase);
}

export function readSdkTurnLostRecoveryMetadata(
  value: unknown,
  options: SdkTurnLostRecoverySanitizeOptions = {},
): SdkTurnLostRecoveryMetadata | null {
  const source = readObject(value);
  if (!source) return null;
  const details = readObject(source.details);
  const candidate = readObject(details?.metadata) ?? details ?? source;
  if (candidate.reason !== SDK_TURN_LOST_RECOVERY_REASON) return null;
  const localSessionKey = readString(candidate.localSessionKey);
  if (!localSessionKey) return null;
  const activityGeneration = sanitizeActivityGenerationValue(candidate.activityGeneration);
  if (activityGeneration === null || !isActivityGenerationLikeValue(activityGeneration)) return null;
  if (!SDK_TURN_LOST_CLASSIFIERS.has(candidate.classifier as SdkTurnLostClassifier)) return null;
  if (!SDK_TURN_LOST_REPLAY_DECISIONS.has(candidate.replayDecision as SdkTurnLostReplayDecision)) return null;
  const sessionName = readString(candidate.sessionName);
  const providerSessionId = readString(candidate.providerSessionId);
  if (!expectedMatches(localSessionKey, options.expectedLocalSessionKey)) return null;
  if (!expectedMatches(sessionName, options.expectedSessionName)) return null;
  if (!expectedMatches(providerSessionId, options.expectedProviderSessionId)) return null;

  return {
    reason: SDK_TURN_LOST_RECOVERY_REASON,
    localSessionKey,
    ...(sessionName ? { sessionName } : {}),
    ...(readString(candidate.providerId) ? { providerId: readString(candidate.providerId) } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(readString(candidate.codexThreadId) ? { codexThreadId: readString(candidate.codexThreadId) } : {}),
    ...(readString(candidate.codexTurnId) ? { codexTurnId: readString(candidate.codexTurnId) } : {}),
    activityGeneration,
    ...(readFiniteNumber(candidate.leaseStartedAt) !== undefined ? { leaseStartedAt: readFiniteNumber(candidate.leaseStartedAt) } : {}),
    ...(readFiniteNumber(candidate.lastStrongActivityAt) !== undefined ? { lastStrongActivityAt: readFiniteNumber(candidate.lastStrongActivityAt) } : {}),
    ...(readFiniteNumber(candidate.lastProviderEventAt) !== undefined ? { lastProviderEventAt: readFiniteNumber(candidate.lastProviderEventAt) } : {}),
    ...(readFiniteNumber(candidate.heartbeatStartedAt) !== undefined ? { heartbeatStartedAt: readFiniteNumber(candidate.heartbeatStartedAt) } : {}),
    ...(readFiniteNumber(candidate.heartbeatCompletedAt) !== undefined ? { heartbeatCompletedAt: readFiniteNumber(candidate.heartbeatCompletedAt) } : {}),
    ...(readFiniteNumber(candidate.heartbeatDurationMs) !== undefined ? { heartbeatDurationMs: readFiniteNumber(candidate.heartbeatDurationMs) } : {}),
    ...(readFiniteNumber(candidate.heartbeatFailureCount) !== undefined ? { heartbeatFailureCount: readFiniteNumber(candidate.heartbeatFailureCount) } : {}),
    ...(readFiniteNumber(candidate.silenceDurationMs) !== undefined ? { silenceDurationMs: readFiniteNumber(candidate.silenceDurationMs) } : {}),
    classifier: candidate.classifier as SdkTurnLostClassifier,
    ...(readFiniteNumber(candidate.attempt) !== undefined ? { attempt: readFiniteNumber(candidate.attempt) } : {}),
    ...(readString(candidate.recoveryAttemptId) ? { recoveryAttemptId: readString(candidate.recoveryAttemptId) } : {}),
    ...(readString(candidate.correlationId) ? { correlationId: readString(candidate.correlationId) } : {}),
    replayDecision: candidate.replayDecision as SdkTurnLostReplayDecision,
    ...(isSdkTurnLostRecoveryPhase(candidate.phase) ? { phase: candidate.phase } : {}),
  };
}

export function sanitizeSdkTurnLostRecoveryMetadata(
  value: unknown,
  options: SdkTurnLostRecoverySanitizeOptions = {},
): SdkTurnLostRecoveryMetadata | null {
  return readSdkTurnLostRecoveryMetadata(value, options);
}

export function isSdkTurnLostRecovery(value: unknown): value is SdkTurnLostRecoveryEnvelope {
  return readSdkTurnLostRecoveryMetadata(value) !== null;
}

export function isAuthoritativeIdlePayloadShape(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.state === 'idle'
    && payload.authoritative === true
    && payload.blockingWorkCount === 0
    && payload.activeWorkCount === 0
    && payload.activeToolCount === 0
    && typeof payload.pendingCount === 'number'
    && Number.isFinite(payload.pendingCount)
    && typeof payload.pendingVersion === 'number'
    && Number.isFinite(payload.pendingVersion)
    && typeof payload.decisionReason === 'string'
    && payload.decisionReason.length > 0
    && Array.isArray(payload.clearInputs)
    && normalizeActivityGeneration(payload.activityGeneration as ActivityGenerationLike) !== null;
}

export function isAuthoritativeCleanIdlePayload(
  payload: Record<string, unknown> | null | undefined,
  expectedGeneration?: ActivityGenerationLike,
): boolean {
  if (!isAuthoritativeIdlePayloadShape(payload)) return false;
  if (expectedGeneration === undefined) return true;
  return sameActivityGeneration(payload?.activityGeneration as ActivityGenerationLike, expectedGeneration);
}

export function isWeakIdlePayload(payload: Record<string, unknown> | null | undefined): boolean {
  return payload?.state === 'idle' && !isAuthoritativeCleanIdlePayload(payload);
}

function readTerminalStatus(payload: Record<string, unknown> | undefined): ToolTerminalStatus | undefined {
  const status = typeof payload?.terminalStatus === 'string'
    ? payload.terminalStatus
    : typeof payload?.status === 'string'
      ? payload.status
      : undefined;
  return TOOL_TERMINAL_STATUSES.has(status as ToolTerminalStatus) ? status as ToolTerminalStatus : undefined;
}

function readToolKey(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) return null;
  for (const key of ['toolCallId', 'toolUseId', 'callId', 'id']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return `${key}:${value.trim()}`;
  }
  return null;
}

export function reduceTimelineActivity(events: TimelineActivityEvent[]): TimelineActivityState {
  const openToolIds = new Set<string>();
  let anonymousOpenToolCount = 0;
  let degraded = false;
  let active = false;
  let currentGeneration: string | undefined;
  const degradedReasons = new Set<string>();
  let lastTerminalStatus: ToolTerminalStatus | undefined;
  let lastTerminalReason: string | undefined;

  for (const event of events) {
    if (event.type === 'tool.call') {
      const key = readToolKey(event.payload);
      if (key) openToolIds.add(key);
      else anonymousOpenToolCount += 1;
      active = true;
      continue;
    }
    if (event.type === 'tool.result') {
      const key = readToolKey(event.payload);
      if (key) {
        if (openToolIds.has(key)) openToolIds.delete(key);
        else degraded = true;
      } else if (anonymousOpenToolCount > 0) {
        anonymousOpenToolCount -= 1;
      } else {
        degraded = true;
      }
      lastTerminalStatus = readTerminalStatus(event.payload) ?? (event.payload?.error ? 'errored' : 'succeeded');
      lastTerminalReason = typeof event.payload?.terminalReason === 'string' ? event.payload.terminalReason : undefined;
      if (lastTerminalStatus !== 'succeeded') degraded = true;
      active = openToolIds.size + anonymousOpenToolCount > 0;
      continue;
    }
    if (event.type === 'session.state') {
      const state = String(event.payload?.state ?? '');
      const eventGeneration = normalizeActivityGeneration(event.payload?.activityGeneration as ActivityGenerationLike);
      if (state !== 'idle' && eventGeneration) currentGeneration = eventGeneration;
      if (state === 'idle') {
        const expectedGeneration = currentGeneration ?? eventGeneration ?? undefined;
        if (isAuthoritativeCleanIdlePayload(event.payload, expectedGeneration)) {
          openToolIds.clear();
          anonymousOpenToolCount = 0;
          active = false;
          if (eventGeneration) currentGeneration = eventGeneration;
        } else if (openToolIds.size > 0) {
          // Anonymous tool calls are common in legacy/process-backed histories and
          // cannot be attributed to the current transport generation. Do not let
          // old anonymous calls poison every reconnect as permanently working.
          anonymousOpenToolCount = 0;
          active = true;
          degraded = true;
          degradedReasons.add('weak_idle_with_open_work');
        } else {
          anonymousOpenToolCount = 0;
          active = false;
          degraded = true;
          degradedReasons.add('weak_idle');
        }
        continue;
      }
      if (state === 'running' || state === 'queued' || state === 'streaming' || state === 'thinking' || state === 'tool_running') {
        active = true;
      }
    }
  }

  const openToolCount = openToolIds.size + anonymousOpenToolCount;
  return {
    active: active || openToolCount > 0,
    degraded,
    openToolCount,
    ...(currentGeneration ? { currentGeneration } : {}),
    degradedReasons: [...degradedReasons],
    lastTerminalStatus,
    lastTerminalReason,
  };
}
