import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_DECISION,
  REMOTE_DESKTOP_CONSENT_LIMITS,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LINK_LIMITS,
  validateRemoteDesktopConsentMessage,
  type RemoteDesktopConsentCancel,
  type RemoteDesktopConsentCancelReason,
  type RemoteDesktopConsentRequest,
} from '../../../shared/remote-desktop-access.js';
import {
  isBoundedRemoteDesktopString,
  isRemoteDesktopId,
  isSafeNonNegativeRemoteDesktopInteger,
} from '../../../shared/remote-desktop-contract-primitives.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  type RemoteDesktopAccessMode,
} from '../../../shared/remote-desktop.js';

const BROWSER_KEY_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_CANCEL_BATCH = 128;
const DEFAULT_SWEEP_LIMIT = 128;

export const REMOTE_DESKTOP_CONSENT_STATE = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
} as const;

export type RemoteDesktopConsentState = typeof REMOTE_DESKTOP_CONSENT_STATE[
  keyof typeof REMOTE_DESKTOP_CONSENT_STATE
];

/** Server-only audit cause. The node still receives the existing shared cancel reason. */
export const REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER = {
  BROWSER_DISCONNECT: 'browser_disconnect',
  LINK_REVOKE: 'link_revoke',
  LOCAL_STOP: 'local_stop',
  ENDPOINT_REPLACED: 'endpoint_replaced',
  DAEMON_DISCONNECT: 'daemon_disconnect',
  CALLER_CANCEL: 'caller_cancel',
  NODE_CANCEL: 'node_cancel',
  TIMEOUT: 'timeout',
} as const;

export type RemoteDesktopConsentCancelTrigger = typeof REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER[
  keyof typeof REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER
];

export const REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  DISPATCH_FAILED: 'dispatch_failed',
  NOT_FOUND: 'not_found',
  NOT_APPROVED: 'not_approved',
  EXPIRED: 'expired',
  BINDING_MISMATCH: 'binding_mismatch',
  ALREADY_CONSUMED: 'already_consumed',
} as const;

export type RemoteDesktopConsentCoordinatorErrorCode = typeof REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR[
  keyof typeof REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR
];

export class RemoteDesktopConsentCoordinatorError extends Error {
  constructor(readonly code: RemoteDesktopConsentCoordinatorErrorCode) {
    super(code);
    this.name = 'RemoteDesktopConsentCoordinatorError';
  }
}

export interface RemoteDesktopConsentDispatchCommand {
  executionServerId: string;
  daemonGeneration: number;
  message: RemoteDesktopConsentRequest | RemoteDesktopConsentCancel;
}

export type RemoteDesktopConsentDispatcher = (
  command: RemoteDesktopConsentDispatchCommand,
) => boolean;

export interface RemoteDesktopConsentNodeResultEnvelope {
  executionServerId: string;
  daemonGeneration: number;
  message: unknown;
}

export type RemoteDesktopConsentResultConsumer = (
  envelope: RemoteDesktopConsentNodeResultEnvelope,
) => Promise<boolean>;

interface ConsentRow {
  approval_id: string;
  host_id: string;
  actor_source: typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK;
  actor_audit_id: string;
  browser_key_hash: string;
  execution_server_id: string;
  endpoint_generation: number;
  daemon_generation: number;
  access_mode: RemoteDesktopAccessMode;
  requester_label: string;
  state: RemoteDesktopConsentState;
  node_decision: 'approved' | 'denied' | null;
  node_cancel_reason: RemoteDesktopConsentCancelReason | null;
  node_resolved_at: number | null;
  cancel_reason: RemoteDesktopConsentCancelReason | null;
  cancel_trigger: RemoteDesktopConsentCancelTrigger | null;
  created_at: number;
  deadline_at: number;
  resolved_at: number | null;
  consumed_at: number | null;
  consumed_session_id: string | null;
  updated_at: number;
}

export interface RemoteDesktopAttendedConsent {
  approvalId: string;
  hostId: string;
  actorAuditId: string;
  browserKeyHash: string;
  executionServerId: string;
  endpointGeneration: number;
  daemonGeneration: number;
  mode: RemoteDesktopAccessMode;
  requesterLabel: string;
  state: RemoteDesktopConsentState;
  nodeDecision: 'approved' | 'denied' | null;
  nodeCancelReason: RemoteDesktopConsentCancelReason | null;
  cancelReason: RemoteDesktopConsentCancelReason | null;
  cancelTrigger: RemoteDesktopConsentCancelTrigger | null;
  createdAt: number;
  deadlineAt: number;
  resolvedAt: number | null;
  consumedAt: number | null;
  consumedSessionId: string | null;
}

export interface RequestAttendedConsentInput {
  hostId: string;
  actorAuditId: string;
  /** SHA-256 hex of the canonical browser-key thumbprint. */
  browserKeyHash: string;
  executionServerId: string;
  endpointGeneration: number;
  daemonGeneration: number;
  mode: RemoteDesktopAccessMode;
  requesterLabel: string;
  deadlineAt: number;
}

export interface RequestAttendedConsentOptions {
  dispatch: RemoteDesktopConsentDispatcher;
  approvalId?: () => string;
}

export type CancelAttendedConsentSelector =
  | { approvalId: string }
  | { browserKeyHash: string }
  | { actorAuditId: string }
  | { hostId: string }
  | { executionServerId: string; daemonGeneration?: number };

export interface CancelAttendedConsentsInput {
  selector: CancelAttendedConsentSelector;
  reason: RemoteDesktopConsentCancelReason;
  trigger: RemoteDesktopConsentCancelTrigger;
  dispatch?: RemoteDesktopConsentDispatcher;
}

export interface ConsumeAttendedConsentInput {
  approvalId: string;
  hostId: string;
  actorAuditId: string;
  browserKeyHash: string;
  executionServerId: string;
  endpointGeneration: number;
  daemonGeneration: number;
  mode: RemoteDesktopAccessMode;
  sessionId: string;
}

export interface ConsumedAttendedConsent extends RemoteDesktopAttendedConsent {
  exactSessionResume: boolean;
}

function toConsent(row: ConsentRow): RemoteDesktopAttendedConsent {
  return {
    approvalId: row.approval_id,
    hostId: row.host_id,
    actorAuditId: row.actor_audit_id,
    browserKeyHash: row.browser_key_hash,
    executionServerId: row.execution_server_id,
    endpointGeneration: Number(row.endpoint_generation),
    daemonGeneration: Number(row.daemon_generation),
    mode: row.access_mode,
    requesterLabel: row.requester_label,
    state: row.state,
    nodeDecision: row.node_decision,
    nodeCancelReason: row.node_cancel_reason,
    cancelReason: row.cancel_reason,
    cancelTrigger: row.cancel_trigger,
    createdAt: Number(row.created_at),
    deadlineAt: Number(row.deadline_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    consumedSessionId: row.consumed_session_id,
  };
}

async function readDatabaseClock(db: Database): Promise<number> {
  const row = await db.queryOne<{ now_ms: number }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms',
  );
  if (!row || !Number.isSafeInteger(Number(row.now_ms))) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
  return Number(row.now_ms);
}

function isMode(value: unknown): value is RemoteDesktopAccessMode {
  return value === REMOTE_DESKTOP_ACCESS_MODE.VIEW
    || value === REMOTE_DESKTOP_ACCESS_MODE.CONTROL;
}

function validateRequestInput(input: RequestAttendedConsentInput, now: number): void {
  if (!isRemoteDesktopId(input.hostId)
    || !isRemoteDesktopId(input.actorAuditId)
    || !BROWSER_KEY_HASH_RE.test(input.browserKeyHash)
    || !isRemoteDesktopId(input.executionServerId)
    || !isSafeNonNegativeRemoteDesktopInteger(input.endpointGeneration)
    || !isSafeNonNegativeRemoteDesktopInteger(input.daemonGeneration)
    || !isMode(input.mode)
    || !isBoundedRemoteDesktopString(
      input.requesterLabel,
      REMOTE_DESKTOP_CONSENT_LIMITS.REQUESTER_LABEL_BYTES,
    )
    || !Number.isSafeInteger(input.deadlineAt)
    || input.deadlineAt <= now
    || input.deadlineAt - now > REMOTE_DESKTOP_LINK_LIMITS.CONSENT_DEADLINE_MS) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
}

function validateConsumeInput(input: ConsumeAttendedConsentInput): void {
  if (!isRemoteDesktopId(input.approvalId)
    || !isRemoteDesktopId(input.hostId)
    || !isRemoteDesktopId(input.actorAuditId)
    || !BROWSER_KEY_HASH_RE.test(input.browserKeyHash)
    || !isRemoteDesktopId(input.executionServerId)
    || !isSafeNonNegativeRemoteDesktopInteger(input.endpointGeneration)
    || !isSafeNonNegativeRemoteDesktopInteger(input.daemonGeneration)
    || !isMode(input.mode)
    || !isRemoteDesktopId(input.sessionId)) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
}

function hasExactBinding(row: ConsentRow, input: ConsumeAttendedConsentInput): boolean {
  return row.host_id === input.hostId
    && row.actor_source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
    && row.actor_audit_id === input.actorAuditId
    && row.browser_key_hash === input.browserKeyHash
    && row.execution_server_id === input.executionServerId
    && Number(row.endpoint_generation) === input.endpointGeneration
    && Number(row.daemon_generation) === input.daemonGeneration
    && row.access_mode === input.mode;
}

export async function getAttendedConsent(
  db: Database,
  approvalId: string,
): Promise<RemoteDesktopAttendedConsent | null> {
  if (!isRemoteDesktopId(approvalId)) return null;
  const row = await db.queryOne<ConsentRow>(
    'SELECT * FROM remote_desktop_attended_consents WHERE approval_id = $1',
    [approvalId],
  );
  return row ? toConsent(row) : null;
}

export async function requestAttendedConsent(
  db: Database,
  input: RequestAttendedConsentInput,
  options: RequestAttendedConsentOptions,
): Promise<RemoteDesktopAttendedConsent> {
  const now = await readDatabaseClock(db);
  validateRequestInput(input, now);
  const approvalId = (options.approvalId ?? randomUUID)();
  if (!isRemoteDesktopId(approvalId)) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }

  await db.execute(
    `INSERT INTO remote_desktop_attended_consents (
       approval_id, host_id, actor_source, actor_audit_id, browser_key_hash,
       execution_server_id, endpoint_generation, daemon_generation, access_mode,
       requester_label, state, created_at, deadline_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12)`,
    [
      approvalId,
      input.hostId,
      REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK,
      input.actorAuditId,
      input.browserKeyHash,
      input.executionServerId,
      input.endpointGeneration,
      input.daemonGeneration,
      input.mode,
      input.requesterLabel,
      REMOTE_DESKTOP_CONSENT_STATE.PENDING,
      now,
      input.deadlineAt,
    ],
  );

  const message: RemoteDesktopConsentRequest = {
    type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
    approvalId,
    hostId: input.hostId,
    mode: input.mode,
    requesterLabel: input.requesterLabel,
    createdAt: now,
    deadlineAt: input.deadlineAt,
    daemonGeneration: input.daemonGeneration,
  };
  const validated = validateRemoteDesktopConsentMessage(message);
  if (!validated.ok || validated.value.type !== REMOTE_DESKTOP_CONSENT_MSG.REQUEST) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }

  if (!options.dispatch({
    executionServerId: input.executionServerId,
    daemonGeneration: input.daemonGeneration,
    message,
  })) {
    await cancelAttendedConsents(db, {
      selector: { approvalId },
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
      trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.CALLER_CANCEL,
    });
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.DISPATCH_FAILED,
    );
  }

  const created = await getAttendedConsent(db, approvalId);
  if (!created) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.NOT_FOUND,
    );
  }
  return created;
}

export async function recordAttendedConsentNodeMessage(
  db: Database,
  input: RemoteDesktopConsentNodeResultEnvelope,
): Promise<boolean> {
  const parsed = validateRemoteDesktopConsentMessage(input.message);
  if (!parsed.ok
    || (parsed.value.type !== REMOTE_DESKTOP_CONSENT_MSG.RESULT
      && parsed.value.type !== REMOTE_DESKTOP_CONSENT_MSG.CANCEL)
    || !isRemoteDesktopId(input.executionServerId)
    || !isSafeNonNegativeRemoteDesktopInteger(input.daemonGeneration)) return false;

  const nodeMessage = parsed.value;
  return db.transaction(async (tx) => {
    const now = await readDatabaseClock(tx);
    const row = await tx.queryOne<ConsentRow>(
      'SELECT * FROM remote_desktop_attended_consents WHERE approval_id = $1 FOR UPDATE',
      [nodeMessage.approvalId],
    );
    if (!row
      || row.state !== REMOTE_DESKTOP_CONSENT_STATE.PENDING
      || row.node_resolved_at !== null
      || row.execution_server_id !== input.executionServerId
      || Number(row.daemon_generation) !== input.daemonGeneration) return false;

    if (now >= Number(row.deadline_at)) {
      await tx.execute(
        `UPDATE remote_desktop_attended_consents
         SET state = $2, cancel_reason = $3, cancel_trigger = $4,
             resolved_at = $5, updated_at = $5
         WHERE approval_id = $1 AND state = $6 AND node_resolved_at IS NULL`,
        [
          row.approval_id,
          REMOTE_DESKTOP_CONSENT_STATE.TIMED_OUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.TIMEOUT,
          now,
          REMOTE_DESKTOP_CONSENT_STATE.PENDING,
        ],
      );
      return false;
    }

    if (nodeMessage.type === REMOTE_DESKTOP_CONSENT_MSG.RESULT) {
      if (nodeMessage.daemonGeneration !== input.daemonGeneration) return false;
      const nextState = nodeMessage.decision === REMOTE_DESKTOP_CONSENT_DECISION.APPROVED
        ? REMOTE_DESKTOP_CONSENT_STATE.APPROVED
        : REMOTE_DESKTOP_CONSENT_STATE.DENIED;
      const result = await tx.execute(
        `UPDATE remote_desktop_attended_consents
         SET state = $2, node_decision = $3, node_resolved_at = $4,
             resolved_at = $4, updated_at = $4
         WHERE approval_id = $1 AND state = $5 AND node_resolved_at IS NULL`,
        [
          row.approval_id,
          nextState,
          nodeMessage.decision,
          now,
          REMOTE_DESKTOP_CONSENT_STATE.PENDING,
        ],
      );
      return result.changes === 1;
    }

    const result = await tx.execute(
      `UPDATE remote_desktop_attended_consents
       SET state = $2, node_cancel_reason = $3, node_resolved_at = $4,
           cancel_reason = $3, cancel_trigger = $5,
           resolved_at = $4, updated_at = $4
       WHERE approval_id = $1 AND state = $6 AND node_resolved_at IS NULL`,
      [
        row.approval_id,
        REMOTE_DESKTOP_CONSENT_STATE.CANCELLED,
        nodeMessage.reason,
        now,
        REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.NODE_CANCEL,
        REMOTE_DESKTOP_CONSENT_STATE.PENDING,
      ],
    );
    return result.changes === 1;
  });
}

/** Narrow Bridge hook: the transport owns authentication/capability/current-
 * generation checks, then hands only its endpoint identity and the untrusted
 * frame to this durable consumer. */
export function createRemoteDesktopConsentResultConsumer(
  db: Database,
): RemoteDesktopConsentResultConsumer {
  return (envelope) => recordAttendedConsentNodeMessage(db, envelope);
}

function selectorSql(selector: CancelAttendedConsentSelector): {
  clause: string;
  params: unknown[];
} {
  if ('approvalId' in selector) {
    if (!isRemoteDesktopId(selector.approvalId)) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
    return { clause: 'approval_id = $1', params: [selector.approvalId] };
  }
  if ('browserKeyHash' in selector) {
    if (!BROWSER_KEY_HASH_RE.test(selector.browserKeyHash)) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
    return { clause: 'browser_key_hash = $1', params: [selector.browserKeyHash] };
  }
  if ('actorAuditId' in selector) {
    if (!isRemoteDesktopId(selector.actorAuditId)) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
    return { clause: 'actor_audit_id = $1', params: [selector.actorAuditId] };
  }
  if ('hostId' in selector) {
    if (!isRemoteDesktopId(selector.hostId)) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
    return { clause: 'host_id = $1', params: [selector.hostId] };
  }
  if (!isRemoteDesktopId(selector.executionServerId)
    || (selector.daemonGeneration !== undefined
      && !isSafeNonNegativeRemoteDesktopInteger(selector.daemonGeneration))) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
  return selector.daemonGeneration === undefined
    ? { clause: 'execution_server_id = $1', params: [selector.executionServerId] }
    : {
      clause: 'execution_server_id = $1 AND daemon_generation = $2',
      params: [selector.executionServerId, selector.daemonGeneration],
    };
}

export async function cancelAttendedConsents(
  db: Database,
  input: CancelAttendedConsentsInput,
): Promise<RemoteDesktopAttendedConsent[]> {
  if (!Object.values(REMOTE_DESKTOP_CONSENT_CANCEL_REASON).includes(input.reason)
    || !Object.values(REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER).includes(input.trigger)) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
  const selector = selectorSql(input.selector);
  const cancelled = await db.transaction(async (tx) => {
    const now = await readDatabaseClock(tx);
    const rows = await tx.query<ConsentRow>(
      `SELECT * FROM remote_desktop_attended_consents
       WHERE ${selector.clause}
         AND state IN ('pending', 'approved') AND consumed_at IS NULL
       ORDER BY created_at, approval_id
       FOR UPDATE SKIP LOCKED
       LIMIT ${MAX_CANCEL_BATCH}`,
      selector.params,
    );
    const output: RemoteDesktopAttendedConsent[] = [];
    for (const row of rows) {
      const result = await tx.execute(
        `UPDATE remote_desktop_attended_consents
         SET state = $2, cancel_reason = $3, cancel_trigger = $4,
             resolved_at = $5, updated_at = $5
         WHERE approval_id = $1 AND state IN ($6, $7) AND consumed_at IS NULL`,
        [
          row.approval_id,
          REMOTE_DESKTOP_CONSENT_STATE.CANCELLED,
          input.reason,
          input.trigger,
          now,
          REMOTE_DESKTOP_CONSENT_STATE.PENDING,
          REMOTE_DESKTOP_CONSENT_STATE.APPROVED,
        ],
      );
      if (result.changes === 1) {
        output.push(toConsent({
          ...row,
          state: REMOTE_DESKTOP_CONSENT_STATE.CANCELLED,
          cancel_reason: input.reason,
          cancel_trigger: input.trigger,
          resolved_at: now,
          updated_at: now,
        }));
      }
    }
    return output;
  });

  if (input.dispatch) {
    for (const entry of cancelled) {
      input.dispatch({
        executionServerId: entry.executionServerId,
        daemonGeneration: entry.daemonGeneration,
        message: {
          type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
          approvalId: entry.approvalId,
          reason: input.reason,
        },
      });
    }
  }
  return cancelled;
}

export async function sweepTimedOutAttendedConsents(
  db: Database,
  input: { dispatch?: RemoteDesktopConsentDispatcher; limit?: number } = {},
): Promise<RemoteDesktopAttendedConsent[]> {
  const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_SWEEP_LIMIT) {
    throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.INVALID_REQUEST,
    );
  }
  const timedOut = await db.transaction(async (tx) => {
    const now = await readDatabaseClock(tx);
    const rows = await tx.query<ConsentRow>(
      `SELECT * FROM remote_desktop_attended_consents
       WHERE deadline_at <= $1
         AND state IN ('pending', 'approved') AND consumed_at IS NULL
       ORDER BY deadline_at, approval_id
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [now, limit],
    );
    const output: RemoteDesktopAttendedConsent[] = [];
    for (const row of rows) {
      const result = await tx.execute(
        `UPDATE remote_desktop_attended_consents
         SET state = $2, cancel_reason = $3, cancel_trigger = $4,
             resolved_at = $5, updated_at = $5
         WHERE approval_id = $1 AND state IN ($6, $7) AND consumed_at IS NULL`,
        [
          row.approval_id,
          REMOTE_DESKTOP_CONSENT_STATE.TIMED_OUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.TIMEOUT,
          now,
          REMOTE_DESKTOP_CONSENT_STATE.PENDING,
          REMOTE_DESKTOP_CONSENT_STATE.APPROVED,
        ],
      );
      if (result.changes === 1) {
        output.push(toConsent({
          ...row,
          state: REMOTE_DESKTOP_CONSENT_STATE.TIMED_OUT,
          cancel_reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
          cancel_trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.TIMEOUT,
          resolved_at: now,
          updated_at: now,
        }));
      }
    }
    return output;
  });

  if (input.dispatch) {
    for (const entry of timedOut) {
      input.dispatch({
        executionServerId: entry.executionServerId,
        daemonGeneration: entry.daemonGeneration,
        message: {
          type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
          approvalId: entry.approvalId,
          reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
        },
      });
    }
  }
  return timedOut;
}

export async function consumeApprovedAttendedConsent(
  db: Database,
  input: ConsumeAttendedConsentInput,
): Promise<ConsumedAttendedConsent> {
  validateConsumeInput(input);
  return db.transaction(async (tx) => {
    const now = await readDatabaseClock(tx);
    const row = await tx.queryOne<ConsentRow>(
      'SELECT * FROM remote_desktop_attended_consents WHERE approval_id = $1 FOR UPDATE',
      [input.approvalId],
    );
    if (!row) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.NOT_FOUND,
    );
    if (!hasExactBinding(row, input)) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.BINDING_MISMATCH,
    );

    if (row.consumed_at !== null) {
      if (row.state === REMOTE_DESKTOP_CONSENT_STATE.APPROVED
        && row.consumed_session_id === input.sessionId) {
        return { ...toConsent(row), exactSessionResume: true };
      }
      throw new RemoteDesktopConsentCoordinatorError(
        REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.ALREADY_CONSUMED,
      );
    }

    if (row.state !== REMOTE_DESKTOP_CONSENT_STATE.APPROVED
      || row.node_decision !== REMOTE_DESKTOP_CONSENT_DECISION.APPROVED) {
      throw new RemoteDesktopConsentCoordinatorError(
        REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.NOT_APPROVED,
      );
    }
    if (now >= Number(row.deadline_at)) {
      await tx.execute(
        `UPDATE remote_desktop_attended_consents
         SET state = $2, cancel_reason = $3, cancel_trigger = $4,
             resolved_at = $5, updated_at = $5
         WHERE approval_id = $1 AND state = $6 AND consumed_at IS NULL`,
        [
          row.approval_id,
          REMOTE_DESKTOP_CONSENT_STATE.TIMED_OUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
          REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.TIMEOUT,
          now,
          REMOTE_DESKTOP_CONSENT_STATE.APPROVED,
        ],
      );
      throw new RemoteDesktopConsentCoordinatorError(
        REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.EXPIRED,
      );
    }

    const updated = await tx.execute(
      `UPDATE remote_desktop_attended_consents
       SET consumed_at = $2, consumed_session_id = $3, updated_at = $2
       WHERE approval_id = $1 AND state = $4 AND consumed_at IS NULL`,
      [
        row.approval_id,
        now,
        input.sessionId,
        REMOTE_DESKTOP_CONSENT_STATE.APPROVED,
      ],
    );
    if (updated.changes !== 1) throw new RemoteDesktopConsentCoordinatorError(
      REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.ALREADY_CONSUMED,
    );
    return {
      ...toConsent({
        ...row,
        consumed_at: now,
        consumed_session_id: input.sessionId,
        updated_at: now,
      }),
      exactSessionResume: false,
    };
  });
}

/** Named cancellation seams for Router/link/local-stop integration. */
export const remoteDesktopConsentCancellation = {
  browserDisconnected: (
    db: Database,
    browserKeyHash: string,
    dispatch?: RemoteDesktopConsentDispatcher,
  ) => cancelAttendedConsents(db, {
    selector: { browserKeyHash },
    reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED,
    trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.BROWSER_DISCONNECT,
    dispatch,
  }),
  linkRevoked: (
    db: Database,
    actorAuditId: string,
    dispatch?: RemoteDesktopConsentDispatcher,
  ) => cancelAttendedConsents(db, {
    selector: { actorAuditId },
    reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LINK_REVOKED,
    trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.LINK_REVOKE,
    dispatch,
  }),
  localStop: (
    db: Database,
    hostId: string,
    dispatch?: RemoteDesktopConsentDispatcher,
  ) => cancelAttendedConsents(db, {
    selector: { hostId },
    // The shared wire has no separate local-stop reason. LOCAL_UI_FAILED is
    // fail closed on the node; the durable trigger preserves exact audit cause.
    reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.LOCAL_STOP,
    dispatch,
  }),
  endpointReplaced: (
    db: Database,
    executionServerId: string,
    daemonGeneration: number,
  ) => cancelAttendedConsents(db, {
    selector: { executionServerId, daemonGeneration },
    reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED,
    trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.ENDPOINT_REPLACED,
  }),
  daemonDisconnected: (
    db: Database,
    executionServerId: string,
    daemonGeneration: number,
  ) => cancelAttendedConsents(db, {
    selector: { executionServerId, daemonGeneration },
    reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.NODE_RESTARTED,
    trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.DAEMON_DISCONNECT,
  }),
} as const;
