/**
 * Browser-safe supervision task console wire contract (V1).
 *
 * Filename and message namespace follow Cx3's proposal
 * (supervision-live-task-console-web-cx3-v1). Backend projection + durable
 * outbox are owned by CC2 (supervision-registry-pools-cc2-v1). Neither side
 * widens this file without telling the other.
 *
 * Transport is the EXISTING authenticated WS push:
 *   daemon (SQLite + outbox, authority)  ->  server WsBridge (relay only)  ->  browser
 * The browser never reaches SQLite, MCP, timeline or any daemon module.
 *
 * Invariants:
 *  1. Status is always a fixed id from the one authoritative lifecycle enum.
 *     A model never authors status -- the daemon derives it from transition
 *     functions and projects the result here.
 *  2. Every projection carries (schemaVersion, statusContractVersion,
 *     projectionVersion, lastDurableEventId). Replay is idempotent; a gap,
 *     reorder, or schema/contract mismatch forces a full snapshot.
 *  3. Ordering is decided by projectionVersion, never by arrival time.
 *
 * ORDERING MODEL -- the two counters are deliberately different:
 *  - projectionVersion is DENSE and monotonic per (projectName, coordinator).
 *    Gap detection uses this and only this.
 *  - lastDurableEventId/eventId is the SQLite AUTOINCREMENT rowid: monotonic
 *    but NOT dense (rolled-back or filtered-out events leave holes), so it is
 *    a resume cursor for catch-up, never a gap detector.
 *
 * BROWSER SAFETY: only imports from browser-safe shared modules.
 * `supervision-durable-identity.ts` is NOT browser-safe (it reaches
 * `node:crypto` via memory-content-hash); ids cross this boundary as plain
 * values and only `import type` may ever reference that module.
 */
import {
  isSupervisionTaskLifecycleStatus,
  SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
  type SupervisionTaskLifecycleStatus,
} from './supervision-config.js';
import { isPeerAuditVerdict, type PeerAuditVerdict } from './peer-audit.js';
import {
  SUPERVISION_EXECUTION_POOL_KINDS,
  type SupervisionExecutionPoolKind,
} from './supervision-execution-pool.js';

/** Bump only with a migration that maps every prior console payload forward. */
export const SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION = 1;

export const SUPERVISION_TASK_CONSOLE_MSG = {
  SUBSCRIBE: 'supervision.task_console.subscribe',
  UNSUBSCRIBE: 'supervision.task_console.unsubscribe',
  SNAPSHOT: 'supervision.task_console.snapshot',
  DELTA: 'supervision.task_console.delta',
  /** Client-side durable cursor ack; lets the daemon prune its outbox. */
  ACK: 'supervision.task_console.ack',
  RESYNC_REQUIRED: 'supervision.task_console.resync_required',
  UNAVAILABLE: 'supervision.task_console.unavailable',
} as const;
export type SupervisionTaskConsoleMessageType =
  typeof SUPERVISION_TASK_CONSOLE_MSG[keyof typeof SUPERVISION_TASK_CONSOLE_MSG];

const CONSOLE_MSG_TYPES = new Set<string>(Object.values(SUPERVISION_TASK_CONSOLE_MSG));

export function isSupervisionTaskConsoleMessageType(
  value: unknown,
): value is SupervisionTaskConsoleMessageType {
  return typeof value === 'string' && CONSOLE_MSG_TYPES.has(value);
}

/** Why a full snapshot is being demanded. Fixed enum, never free text. */
export const SUPERVISION_CONSOLE_RESYNC_REASONS = [
  'initial',
  'version_gap',
  'schema_mismatch',
  'status_contract_mismatch',
  'scope_mismatch',
  'cursor_unknown',
  'outbox_truncated',
  'authority_epoch_changed',
  'stale_subscription',
] as const;
export type SupervisionConsoleResyncReason = typeof SUPERVISION_CONSOLE_RESYNC_REASONS[number];

// ── scope + cursor ──────────────────────────────────────────────────────────

/**
 * Audience scoping key.
 *
 * `projectName` (not `projectId`): IM.codes has no general project-id concept --
 * `projectId` exists only inside the memory namespace subsystem. Project names
 * are the convention everywhere else.
 */
export interface SupervisionTaskConsoleScope {
  projectName: string;
  coordinatorSessionName: string;
}

export interface SupervisionTaskConsoleCursor {
  schemaVersion: number;
  statusContractVersion: number;
  /** Dense, monotonic per scope. Gap detection uses this. */
  projectionVersion: number;
  /** SQLite AUTOINCREMENT rowid. Resume cursor only; null before first sync. */
  lastDurableEventId: number | null;
  /**
   * Daemon projection authority epoch.
   *
   * projectionVersion is restored monotonically from SQLite across restart, so
   * it does NOT reset in the normal case. This epoch exists for the abnormal
   * one: a rebuilt/truncated projection store restarts numbering, and without
   * an epoch the browser would read the replayed low versions as duplicates and
   * silently freeze. Any epoch change forces a full resync.
   */
  projectionEpoch: string;
}

export type SupervisionTaskConsoleCursorState =
  SupervisionTaskConsoleCursor & { scope: SupervisionTaskConsoleScope };

export interface SupervisionTaskConsoleSubscribe extends SupervisionTaskConsoleCursor {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE;
  scope: SupervisionTaskConsoleScope;
  /** Client-minted per subscribe attempt; echoed on every projection. */
  subscriptionId: string;
  /** null demands a full snapshot; a number resumes catch-up after that event. */
  afterEventId: number | null;
  reason: SupervisionConsoleResyncReason;
}

export interface SupervisionTaskConsoleUnsubscribe {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE;
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
}

/** Client -> daemon durable cursor ack, so the outbox can prune safely. */
export interface SupervisionTaskConsoleAck {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.ACK;
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
  projectionVersion: number;
  lastDurableEventId: number | null;
  projectionEpoch: string;
}

/** Daemon -> client demand for a full snapshot. Carries no partial state. */
export interface SupervisionTaskConsoleResyncRequired {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED;
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
  reason: SupervisionConsoleResyncReason;
}

export const SUPERVISION_CONSOLE_UNAVAILABLE_REASONS = {
  PROJECTION_UNAVAILABLE: 'projection_unavailable',
} as const;
export type SupervisionConsoleUnavailableReason =
  typeof SUPERVISION_CONSOLE_UNAVAILABLE_REASONS[keyof typeof SUPERVISION_CONSOLE_UNAVAILABLE_REASONS];

/**
 * Correlated terminal response when the authority cannot build a snapshot.
 * It carries no projection rows, so a failure can never be mistaken for an
 * authoritative empty snapshot.
 */
export interface SupervisionTaskConsoleUnavailable {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.UNAVAILABLE;
  subscriptionId: string;
  scope: SupervisionTaskConsoleScope;
  reason: SupervisionConsoleUnavailableReason;
  retryable: true;
}

/**
 * Reject a projection that answers a subscribe the client has already replaced.
 * Without this a slow snapshot from a dead reconnect can land after a newer one
 * and roll the console backwards.
 */
export function isStaleSupervisionConsoleResponse(input: {
  activeSubscriptionId: string;
  responseSubscriptionId: string;
}): boolean {
  return input.activeSubscriptionId !== input.responseSubscriptionId;
}

// ── status grouping (single source for UI columns) ──────────────────────────

export const SUPERVISION_CONSOLE_STATUS_GROUPS = ['active', 'audit', 'rework', 'integration', 'final'] as const;
export type SupervisionConsoleStatusGroup = typeof SUPERVISION_CONSOLE_STATUS_GROUPS[number];

/**
 * Fixed status -> group mapping so the web console never restates status ids or
 * invents its own buckets. Every lifecycle status appears exactly once; a test
 * asserts exhaustiveness so adding a status cannot silently fall through.
 * Group membership is layout data -- localized labels stay in web i18n.
 */
export const SUPERVISION_CONSOLE_STATUS_GROUP: Readonly<Record<SupervisionTaskLifecycleStatus, SupervisionConsoleStatusGroup>> = Object.freeze({
  planned: 'active',
  delegated: 'active',
  implementing: 'active',
  retrying_external_ci: 'active',
  validated: 'active',
  recovered: 'active',
  ready_for_audit: 'audit',
  auditing: 'audit',
  passed: 'audit',
  rework: 'rework',
  ready_for_integration: 'integration',
  integrating: 'integration',
  final_audit: 'integration',
  finalizing: 'integration',
  committed: 'integration',
  pushed: 'final',
  finalized: 'final',
  blocked: 'final',
  cancelled: 'final',
});

export function supervisionConsoleStatusGroup(
  status: SupervisionTaskLifecycleStatus,
): SupervisionConsoleStatusGroup {
  return SUPERVISION_CONSOLE_STATUS_GROUP[status];
}

/** Validation outcome the UI renders next to a task/assignment. */
export const SUPERVISION_CONSOLE_VALIDATION_STATES = ['unknown', 'pending', 'passed', 'failed', 'unavailable'] as const;
export type SupervisionConsoleValidationState = typeof SUPERVISION_CONSOLE_VALIDATION_STATES[number];

// ── projected rows ──────────────────────────────────────────────────────────

export interface SupervisionTaskConsoleProgress {
  completed: number;
  total: number;
}

export interface SupervisionTaskConsoleTaskRow {
  taskId: string;
  semanticKey?: string;
  topLevelTaskId?: string;
  title: string;
  /** Fixed enum id. Never free text, never model-authored. */
  status: SupervisionTaskLifecycleStatus;
  ownerSessionName?: string;
  ownerAgentType?: string;
  /** Daemon-OBSERVED model, not self-reported. */
  observedModel?: string;
  poolId?: string;
  poolKind?: SupervisionExecutionPoolKind;
  progress?: SupervisionTaskConsoleProgress;
  /** Coarse stage label derived from status; never model-authored. */
  phase: SupervisionConsoleStatusGroup;
  /** Rendered hints only; authority stays server-side. */
  currentAction?: string;
  nextAction?: string;
  validationState: SupervisionConsoleValidationState;
  blocker?: string;
  /** Last daemon-observed liveness beat, ms epoch. Absent = never observed. */
  heartbeatAt?: number;
  checkpointId?: string;
  auditAttemptId?: string;
  auditRound?: string;
  auditVerdict?: PeerAuditVerdict;
  recoveryState?: string;
  recoveryReason?: string;
  workspaceId?: string;
  snapshotId?: string;
  snapshotState?: string;
  updatedAt: number;
  /** Durable event that produced this row. */
  lastEventId: number;
}

export interface SupervisionTaskConsoleAssignmentRow {
  assignmentId: string;
  taskId: string;
  status: SupervisionTaskLifecycleStatus;
  phase: SupervisionConsoleStatusGroup;
  /** Free-form slice role, e.g. "implementer" / "auditor". */
  role?: string;
  ownerSessionName?: string;
  /** Human label; may differ from the canonical session name. */
  ownerSessionLabel?: string;
  ownerAgentType?: string;
  /** Daemon-OBSERVED, not self-reported. */
  observedModel?: string;
  observedProvider?: string;
  poolId?: string;
  poolKind?: SupervisionExecutionPoolKind;
  currentAction?: string;
  nextAction?: string;
  validationState: SupervisionConsoleValidationState;
  auditAttemptId?: string;
  auditRound?: string;
  auditVerdict?: PeerAuditVerdict;
  blocker?: string;
  recoveryState?: string;
  recoveryReason?: string;
  heartbeatAt?: number;
  workspaceId?: string;
  snapshotId?: string;
  checkpointId?: string;
  updatedAt: number;
  lastEventId: number;
}

export interface SupervisionTaskConsolePoolRow {
  poolId: string;
  label: string;
  activeCount: number;
  capacity: number;
}

export interface SupervisionTaskConsoleSnapshot extends SupervisionTaskConsoleCursor {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT;
  scope: SupervisionTaskConsoleScope;
  /** Echoes the subscribe this answers; stale responses are droppable. */
  subscriptionId: string;
  generatedAt: number;
  tasks: SupervisionTaskConsoleTaskRow[];
  assignments: SupervisionTaskConsoleAssignmentRow[];
  pools: SupervisionTaskConsolePoolRow[];
}

/**
 * Delta operations. One durable event produces exactly one delta, which is what
 * makes eventId-keyed dedup trivial on the browser side.
 */
export const SUPERVISION_CONSOLE_DELTA_OPS = [
  'task_upsert',
  'task_remove',
  'assignment_upsert',
  'assignment_remove',
  'pools_update',
] as const;
export type SupervisionConsoleDeltaOp = typeof SUPERVISION_CONSOLE_DELTA_OPS[number];

export interface SupervisionTaskConsoleDelta extends SupervisionTaskConsoleCursor {
  type: typeof SUPERVISION_TASK_CONSOLE_MSG.DELTA;
  scope: SupervisionTaskConsoleScope;
  subscriptionId: string;
  /** Durable SQLite event id that produced this delta. */
  eventId: number;
  op: SupervisionConsoleDeltaOp;
  task?: SupervisionTaskConsoleTaskRow;
  assignment?: SupervisionTaskConsoleAssignmentRow;
  removedId?: string;
  pools?: SupervisionTaskConsolePoolRow[];
}

// ── ordering ────────────────────────────────────────────────────────────────

export type SupervisionConsoleCursorDecision = 'apply' | 'ignore_duplicate' | 'resync_required';

export interface SupervisionConsoleCursorEvaluation {
  decision: SupervisionConsoleCursorDecision;
  reason: 'in_order' | 'already_applied' | SupervisionConsoleResyncReason;
}

/**
 * Decide what the browser should do with an incoming delta.
 *
 * Fail-closed: anything that is not provably the next in-order delta for this
 * exact scope and schema resolves to a full resync. Patching across a gap would
 * silently produce a console that disagrees with durable state, which is the
 * one outcome this contract exists to prevent.
 */
export function evaluateSupervisionConsoleCursor(input: {
  client: SupervisionTaskConsoleCursorState;
  incoming: SupervisionTaskConsoleCursorState;
}): SupervisionConsoleCursorEvaluation {
  const { client, incoming } = input;
  if (incoming.schemaVersion !== client.schemaVersion) {
    return { decision: 'resync_required', reason: 'schema_mismatch' };
  }
  if (incoming.statusContractVersion !== client.statusContractVersion) {
    return { decision: 'resync_required', reason: 'status_contract_mismatch' };
  }
  // Checked before any version comparison: across an epoch change the numbers
  // are not comparable at all, so `<=` would misread a reset as a duplicate.
  if (incoming.projectionEpoch !== client.projectionEpoch) {
    return { decision: 'resync_required', reason: 'authority_epoch_changed' };
  }
  if (
    incoming.scope.projectName !== client.scope.projectName
    || incoming.scope.coordinatorSessionName !== client.scope.coordinatorSessionName
  ) {
    return { decision: 'resync_required', reason: 'scope_mismatch' };
  }
  // Re-delivery of an already-applied version is safe to drop: that is what
  // makes at-least-once outbox replay idempotent at the browser.
  if (incoming.projectionVersion <= client.projectionVersion) {
    return { decision: 'ignore_duplicate', reason: 'already_applied' };
  }
  if (incoming.projectionVersion !== client.projectionVersion + 1) {
    return { decision: 'resync_required', reason: 'version_gap' };
  }
  return { decision: 'apply', reason: 'in_order' };
}

// ── coalescing ──────────────────────────────────────────────────────────────

/**
 * Fields that encode a TRANSITION. Dropping an intermediate value here would
 * erase a lifecycle or audit step from the console, so any delta touching one
 * of these must be delivered on its own.
 */
export const SUPERVISION_CONSOLE_TRANSITION_FIELDS: readonly string[] = Object.freeze([
  'status', 'phase', 'auditVerdict', 'auditAttemptId', 'auditRound',
  'recoveryState', 'recoveryReason', 'snapshotState', 'validationState',
  'blocker', 'checkpointId',
]);

/**
 * Fields whose change is presentation-neutral -- a later value fully supersedes
 * an earlier one and no intermediate value carries meaning.
 */
export const SUPERVISION_CONSOLE_COALESCEABLE_FIELDS: readonly string[] = Object.freeze([
  'progress', 'updatedAt', 'nextAction', 'currentAction', 'observedModel',
  'observedProvider', 'poolId', 'poolKind', 'title', 'heartbeatAt',
]);

/**
 * May two consecutive task rows for the same task be collapsed into one push?
 *
 * Only when neither carries a lifecycle or audit transition. Conservative by
 * design: an unknown-shaped change is treated as a transition, and a field that
 * is in neither list also blocks coalescing.
 */
export function canCoalesceSupervisionTaskRows(
  previous: SupervisionTaskConsoleTaskRow,
  next: SupervisionTaskConsoleTaskRow,
): boolean {
  if (previous.taskId !== next.taskId) return false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const before = previous[key as keyof SupervisionTaskConsoleTaskRow];
    const after = next[key as keyof SupervisionTaskConsoleTaskRow];
    if (before === after) continue;
    if (SUPERVISION_CONSOLE_TRANSITION_FIELDS.includes(key)) return false;
    // `lastEventId` always advances; it is bookkeeping, not presentation.
    if (key === 'lastEventId') continue;
    if (!SUPERVISION_CONSOLE_COALESCEABLE_FIELDS.includes(key)) return false;
  }
  return true;
}

// ── audience scoping ────────────────────────────────────────────────────────

/**
 * A coordinator may see a task only if it participates in it. Absence of a
 * recorded participant is not evidence of entitlement -- refuse.
 */
export function isSupervisionConsoleAudienceMember(input: {
  coordinatorSessionName: string;
  participantSessionNames: readonly string[] | undefined;
}): boolean {
  if (!input.coordinatorSessionName) return false;
  const participants = input.participantSessionNames;
  if (!participants || participants.length === 0) return false;
  return participants.includes(input.coordinatorSessionName);
}

// ── wire validation ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasConsoleBaseline(value: Record<string, unknown>): boolean {
  return isFiniteNumber(value.schemaVersion)
    && isFiniteNumber(value.projectionVersion)
    && isFiniteNumber(value.statusContractVersion)
    && (value.lastDurableEventId === null || isFiniteNumber(value.lastDurableEventId))
    && typeof value.projectionEpoch === 'string' && value.projectionEpoch.length > 0
    && typeof value.subscriptionId === 'string' && value.subscriptionId.length > 0
    && isRecord(value.scope)
    && typeof value.scope.projectName === 'string'
    && value.scope.projectName.length > 0
    && typeof value.scope.coordinatorSessionName === 'string'
    && value.scope.coordinatorSessionName.length > 0;
}

/**
 * `phase` is DERIVED from status, so a frame may not disagree with the mapping.
 * Accepting `{status:'auditing', phase:'final'}` would let a buggy or hostile
 * producer silently re-bucket a task in the console. Reported by Cx3.
 */
function hasDerivedPhase(value: Record<string, unknown>): boolean {
  if (!isSupervisionTaskLifecycleStatus(value.status)) return false;
  return typeof value.phase === 'string'
    && (SUPERVISION_CONSOLE_STATUS_GROUPS as readonly string[]).includes(value.phase)
    && value.phase === supervisionConsoleStatusGroup(value.status);
}

function isTaskRow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.taskId === 'string'
    && typeof value.title === 'string'
    // Rejects unknown/case-variant/model-authored status.
    && isSupervisionTaskLifecycleStatus(value.status)
    && hasDerivedPhase(value)
    && (value.auditVerdict === undefined || isPeerAuditVerdict(value.auditVerdict))
    && (value.poolKind === undefined || (SUPERVISION_EXECUTION_POOL_KINDS as readonly string[]).includes(value.poolKind as string))
    && typeof value.validationState === 'string'
    && (SUPERVISION_CONSOLE_VALIDATION_STATES as readonly string[]).includes(value.validationState)
    && isFiniteNumber(value.updatedAt)
    && isFiniteNumber(value.lastEventId);
}

function isAssignmentRow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.assignmentId === 'string'
    && typeof value.taskId === 'string'
    && isSupervisionTaskLifecycleStatus(value.status)
    && hasDerivedPhase(value)
    && (value.auditVerdict === undefined || isPeerAuditVerdict(value.auditVerdict))
    && (value.poolKind === undefined || (SUPERVISION_EXECUTION_POOL_KINDS as readonly string[]).includes(value.poolKind as string))
    && typeof value.validationState === 'string'
    && (SUPERVISION_CONSOLE_VALIDATION_STATES as readonly string[]).includes(value.validationState)
    && isFiniteNumber(value.updatedAt)
    && isFiniteNumber(value.lastEventId);
}

function isPoolRow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.poolId === 'string'
    && typeof value.label === 'string'
    && isFiniteNumber(value.activeCount)
    && isFiniteNumber(value.capacity);
}

/** Fail-closed structural validator for projections arriving on the console wire. */
export function isValidSupervisionTaskConsoleEvent(
  value: unknown,
): value is SupervisionTaskConsoleSnapshot | SupervisionTaskConsoleDelta {
  if (!isRecord(value) || !isSupervisionTaskConsoleMessageType(value.type)) return false;
  if (!hasConsoleBaseline(value)) return false;
  switch (value.type) {
    case SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT:
      return isFiniteNumber(value.generatedAt)
        && Array.isArray(value.tasks) && value.tasks.every(isTaskRow)
        && Array.isArray(value.assignments) && value.assignments.every(isAssignmentRow)
        && Array.isArray(value.pools) && value.pools.every(isPoolRow);
    case SUPERVISION_TASK_CONSOLE_MSG.DELTA: {
      if (!isFiniteNumber(value.eventId)) return false;
      if (typeof value.op !== 'string'
        || !(SUPERVISION_CONSOLE_DELTA_OPS as readonly string[]).includes(value.op)) return false;
      switch (value.op as SupervisionConsoleDeltaOp) {
        case 'task_upsert': return isTaskRow(value.task);
        case 'assignment_upsert': return isAssignmentRow(value.assignment);
        case 'task_remove':
        case 'assignment_remove': return typeof value.removedId === 'string' && value.removedId.length > 0;
        case 'pools_update': return Array.isArray(value.pools) && value.pools.every(isPoolRow);
        default: return false;
      }
    }
    default:
      // SUBSCRIBE/UNSUBSCRIBE/ACK/RESYNC_REQUIRED are control frames, not projections.
      return false;
  }
}

/** Cursor a fresh client presents before it has any durable state. */
export function initialSupervisionConsoleCursor(
  scope: SupervisionTaskConsoleScope,
  projectionEpoch = '',
): SupervisionTaskConsoleCursorState {
  return {
    schemaVersion: SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 0,
    lastDurableEventId: null,
    projectionEpoch,
    scope,
  };
}
