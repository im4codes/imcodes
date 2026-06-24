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
  | 'user_cancelled'
  | 'generation_rollover'
  | 'daemon_restart_orphan'
  | 'provider_stale'
  | 'unknown_tool'
  | 'duplicate_terminal';

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

export function isProviderSnapshotBlocking(
  snapshot: ProviderActiveWorkSnapshot | null | undefined,
  currentGeneration?: ActivityGenerationLike,
): boolean {
  return evaluateProviderSnapshot(snapshot, currentGeneration).blocking;
}

export function hasProviderActiveWork(snapshot: ProviderActiveWorkSnapshot | null | undefined): boolean {
  return isProviderSnapshotBlocking(snapshot);
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
  return status === 'succeeded'
    || status === 'abandoned'
    || status === 'cancelled'
    || status === 'errored'
    || status === 'stale'
    ? status
    : undefined;
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
