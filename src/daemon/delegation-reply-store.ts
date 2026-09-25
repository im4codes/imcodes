import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_MESSAGE_KINDS,
  AGENT_DELEGATION_REPLY_STATUSES,
  AGENT_DELEGATION_REPLY_MAX_MESSAGES,
  AGENT_DELEGATION_REPLY_TTL_MS,
  readTrustedAgentDelegationPeerAuditCompletionBinding,
  type AgentDelegationPurpose,
  type AgentDelegationReplyMessageKind,
  type AgentDelegationReplyStatus,
} from '../../shared/agent-delegation.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'delegation-replies.sqlite');

function persistedMessageKind(result: string): AgentDelegationReplyMessageKind {
  try {
    return readTrustedAgentDelegationPeerAuditCompletionBinding(JSON.parse(result))
      ? AGENT_DELEGATION_REPLY_MESSAGE_KINDS.PEER_AUDIT_FINAL
      : AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION;
  } catch {
    return AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION;
  }
}

export interface DelegationReplyBoundIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
}

export interface DelegationReplyRecord {
  delegationId: string;
  /** Historical hashes remain readable but are no longer authority. */
  capabilityHash: string;
  origin: DelegationReplyBoundIdentity;
  target: DelegationReplyBoundIdentity;
  dispatchId: string;
  messageId: string;
  notificationId: string;
  messageKind?: AgentDelegationReplyMessageKind;
  purpose?: AgentDelegationPurpose;
  auditAttemptId?: string;
  auditRevision?: string;
  auditedSessionName?: string;
  taskId?: string;
  assignmentId?: string;
  /** The task's ORIGINAL coordinator assignment; the only authority that may
   *  advance this return onto a re-authorized origin. */
  coordinatorAssignmentId?: string;
  status: AgentDelegationReplyStatus;
  result?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface CreateDelegationReplyInput {
  origin: DelegationReplyBoundIdentity;
  target: DelegationReplyBoundIdentity;
  dispatchId: string;
  messageId: string;
  purpose?: AgentDelegationPurpose;
  auditAttemptId?: string;
  auditRevision?: string;
  auditedSessionName?: string;
  taskId?: string;
  assignmentId?: string;
  /** The task's ORIGINAL coordinator assignment; the only authority that may
   *  advance this return onto a re-authorized origin. */
  coordinatorAssignmentId?: string;
  now?: number;
}

export interface CreatedDelegationReply {
  record: DelegationReplyRecord;
}

export type ReceiveDelegationReplyResult =
  | { ok: true; record: DelegationReplyRecord; replay: boolean }
  | { ok: false; reason: 'not_found' | 'capability' | 'identity' | 'expired' | 'already_replied' | 'limit' };

export type CurrentAssignmentReplyAuthority =
  | { status: 'none' }
  | { status: 'matched'; record: DelegationReplyRecord }
  | { status: 'ambiguous' };

export type PendingAuditDeliveryAuthority = CurrentAssignmentReplyAuthority;

export interface PendingAuditDeliveryAssignmentAuthority {
  assignmentId: string;
  messageId: string;
  supersededMessageIds: readonly string[];
  /**
   * Registry-proven target-generation replacements. A message id alone is not
   * enough to retire a different verdict principal: the durable recovery event
   * must also name the session that owned that superseded delivery.
   */
  supersededDeliveries?: readonly {
    messageId: string;
    targetSessionName: string;
  }[];
  origins: readonly DelegationReplyBoundIdentity[];
  target: DelegationReplyBoundIdentity;
}

export interface DelegationReplyStoreOptions {
  dbPath?: string;
  database?: DatabaseSyncInstance;
  busyTimeoutMs?: number;
}

function opaqueId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function resultKey(result: string): string {
  return createHash('sha256').update(result, 'utf8').digest('base64url');
}

function identityMatches(left: DelegationReplyBoundIdentity, right: DelegationReplyBoundIdentity): boolean {
  return left.sessionName === right.sessionName
    && left.sessionInstanceId === right.sessionInstanceId
    && left.runtimeEpoch === right.runtimeEpoch;
}

function rowString(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? '');
}

function parseRow(row: Record<string, unknown>): DelegationReplyRecord {
  const result = typeof row.result === 'string' ? row.result : undefined;
  const deliveredAt = typeof row.deliveredAt === 'number' ? row.deliveredAt : undefined;
  const purpose = typeof row.purpose === 'string' && row.purpose
    ? row.purpose as AgentDelegationPurpose
    : undefined;
  const auditAttemptId = typeof row.auditAttemptId === 'string' && row.auditAttemptId
    ? row.auditAttemptId
    : undefined;
  const auditRevision = typeof row.auditRevision === 'string' && row.auditRevision
    ? row.auditRevision
    : undefined;
  const auditedSessionName = typeof row.auditedSessionName === 'string' && row.auditedSessionName
    ? row.auditedSessionName
    : undefined;
  const taskId = typeof row.taskId === 'string' && row.taskId ? row.taskId : undefined;
  const assignmentId = typeof row.assignmentId === 'string' && row.assignmentId ? row.assignmentId : undefined;
  const coordinatorAssignmentId = typeof row.coordinatorAssignmentId === 'string' && row.coordinatorAssignmentId
    ? row.coordinatorAssignmentId
    : undefined;
  const messageKind = typeof row.messageKind === 'string' && row.messageKind
    ? row.messageKind as AgentDelegationReplyMessageKind
    : undefined;
  return {
    delegationId: rowString(row, 'delegationId'),
    capabilityHash: rowString(row, 'capabilityHash'),
    origin: {
      sessionName: rowString(row, 'originSessionName'),
      sessionInstanceId: rowString(row, 'originSessionInstanceId'),
      runtimeEpoch: rowString(row, 'originRuntimeEpoch'),
    },
    target: {
      sessionName: rowString(row, 'targetSessionName'),
      sessionInstanceId: rowString(row, 'targetSessionInstanceId'),
      runtimeEpoch: rowString(row, 'targetRuntimeEpoch'),
    },
    dispatchId: rowString(row, 'dispatchId'),
    messageId: rowString(row, 'messageId'),
    notificationId: rowString(row, 'notificationId'),
    ...(messageKind ? { messageKind } : {}),
    ...(purpose ? { purpose } : {}),
    ...(auditAttemptId ? { auditAttemptId } : {}),
    ...(auditRevision ? { auditRevision } : {}),
    ...(auditedSessionName ? { auditedSessionName } : {}),
    ...(taskId ? { taskId } : {}),
    ...(assignmentId ? { assignmentId } : {}),
    ...(coordinatorAssignmentId ? { coordinatorAssignmentId } : {}),
    status: rowString(row, 'status') as AgentDelegationReplyStatus,
    ...(result !== undefined ? { result } : {}),
    createdAt: Number(row.createdAt ?? 0),
    expiresAt: Number(row.expiresAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
  };
}

export class DelegationReplyStore {
  readonly #db: DatabaseSyncInstance;
  readonly #ownsDb: boolean;
  #closed = false;

  constructor(options: DelegationReplyStoreOptions = {}) {
    if (options.database) {
      this.#db = options.database;
      this.#ownsDb = false;
    } else {
      const dbPath = options.dbPath?.trim()
        || process.env.IMCODES_DELEGATION_REPLY_DB_PATH?.trim()
        || (process.env.VITEST ? ':memory:' : DEFAULT_DB_PATH);
      assertNotRealImcodesPathInTests(dbPath, 'delegation-replies.sqlite');
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      this.#db = new DatabaseSync(dbPath);
      this.#ownsDb = true;
    }
    const timeout = Math.max(0, Math.min(60_000, Math.floor(options.busyTimeoutMs ?? 5_000)));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${timeout};
      CREATE TABLE IF NOT EXISTS delegation_replies (
        delegation_id TEXT PRIMARY KEY,
        capability_hash TEXT NOT NULL,
        origin_session_name TEXT NOT NULL,
        origin_session_instance_id TEXT NOT NULL,
        origin_runtime_epoch TEXT NOT NULL,
        target_session_name TEXT NOT NULL,
        target_session_instance_id TEXT NOT NULL,
        target_runtime_epoch TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        purpose TEXT,
        audit_attempt_id TEXT,
        audit_revision TEXT,
        audited_session_name TEXT,
        task_id TEXT,
        assignment_id TEXT,
        coordinator_assignment_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS delegation_replies_status_idx
        ON delegation_replies(status, updated_at);
      CREATE TABLE IF NOT EXISTS delegation_reply_messages (
        delegation_id TEXT NOT NULL,
        result_key TEXT NOT NULL,
        notification_id TEXT NOT NULL UNIQUE,
        message_kind TEXT NOT NULL DEFAULT 'delegation_completion',
        result TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY (delegation_id, result_key),
        FOREIGN KEY (delegation_id) REFERENCES delegation_replies(delegation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS delegation_reply_messages_pending_idx
        ON delegation_reply_messages(status, updated_at);
    `);
    const columns = this.#db.prepare('PRAGMA table_info(delegation_replies)').all() as Array<{ name?: unknown }>;
    const names = new Set(columns.map((column) => String(column.name ?? '')));
    if (!names.has('purpose')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN purpose TEXT');
    }
    if (!names.has('audit_attempt_id')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN audit_attempt_id TEXT');
    }
    if (!names.has('audit_revision')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN audit_revision TEXT');
    }
    if (!names.has('audited_session_name')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN audited_session_name TEXT');
    }
    if (!names.has('task_id')) this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN task_id TEXT');
    if (!names.has('assignment_id')) this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN assignment_id TEXT');
    // The ORIGINAL coordinator assignment a task-bound return is addressed to.
    // Rows written before this column exists stay NULL and are unadoptable: no
    // coordinator can claim authority over a return that never recorded one.
    if (!names.has('coordinator_assignment_id')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN coordinator_assignment_id TEXT');
    }
    const messageColumns = this.#db.prepare('PRAGMA table_info(delegation_reply_messages)').all() as Array<{ name?: unknown }>;
    if (!new Set(messageColumns.map((column) => String(column.name ?? ''))).has('message_kind')) {
      this.#db.exec(`ALTER TABLE delegation_reply_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT '${AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION}'`);
      // Before message_kind existed, the only daemon-authored verdict payload
      // had this exact top-level status prefix. Preserve those historical
      // cards without ever classifying arbitrary PASS/REWORK prose as verdict.
      this.#db.prepare(`
        UPDATE delegation_reply_messages SET message_kind = ?
        WHERE result LIKE ?
      `).run(
        AGENT_DELEGATION_REPLY_MESSAGE_KINDS.PEER_AUDIT_FINAL,
        `{"status":"peer_audit_completed"%`,
      );
    }
    // Preserve durable replies created by versions that stored the single
    // message directly on the authority row.
    const legacyRows = this.#db.prepare(`
      SELECT delegation_id AS delegationId, notification_id AS notificationId,
             result, status, updated_at AS updatedAt, delivered_at AS deliveredAt
      FROM delegation_replies
      WHERE result IS NOT NULL AND status IN (?, ?)
    `).all(
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
      AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
    ) as Array<Record<string, unknown>>;
    const migrateLegacy = this.#db.prepare(`
      INSERT OR IGNORE INTO delegation_reply_messages (
        delegation_id, result_key, notification_id, message_kind, result, status,
        created_at, updated_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyRows) {
      const result = String(row.result ?? '');
      const updatedAt = Number(row.updatedAt ?? Date.now());
      migrateLegacy.run(
        String(row.delegationId ?? ''),
        resultKey(result),
        String(row.notificationId ?? opaqueId()),
        persistedMessageKind(result),
        result,
        String(row.status ?? AGENT_DELEGATION_REPLY_STATUSES.RECEIVED),
        updatedAt,
        updatedAt,
        typeof row.deliveredAt === 'number' ? row.deliveredAt : null,
      );
    }
  }

  close(): void {
    if (this.#ownsDb && !this.#closed) this.#db.close();
    this.#closed = true;
  }

  create(input: CreateDelegationReplyInput): CreatedDelegationReply {
    const now = input.now ?? Date.now();
    const delegationId = opaqueId();
    const notificationId = opaqueId();
    // An exact audit redelivery replaces its previous transport authority.
    // The registry assignment/attempt/revision remains the final authority;
    // retaining two equivalent pending rows only makes a legitimate auditor
    // fail with attempt_mismatch after a daemon/manual delivery recovery.
    if (input.purpose === AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
      && input.auditAttemptId && input.auditRevision
      && input.taskId && input.assignmentId) {
      this.#db.prepare(`
        UPDATE delegation_replies
        SET status = ?, updated_at = ?
        WHERE purpose = ?
          AND task_id = ?
          AND assignment_id = ?
          AND audit_attempt_id = ?
          AND audit_revision = ?
          AND origin_session_name = ?
          AND origin_session_instance_id = ?
          AND origin_runtime_epoch = ?
          AND target_session_name = ?
          AND target_session_instance_id = ?
          AND target_runtime_epoch = ?
          AND COALESCE(audited_session_name, '') = ?
          AND status = ?
      `).run(
        AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
        now,
        AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        input.taskId,
        input.assignmentId,
        input.auditAttemptId,
        input.auditRevision,
        input.origin.sessionName,
        input.origin.sessionInstanceId,
        input.origin.runtimeEpoch,
        input.target.sessionName,
        input.target.sessionInstanceId,
        input.target.runtimeEpoch,
        input.auditedSessionName ?? '',
        AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      );
    }
    this.#db.prepare(`
      INSERT INTO delegation_replies (
        delegation_id, capability_hash,
        origin_session_name, origin_session_instance_id, origin_runtime_epoch,
        target_session_name, target_session_instance_id, target_runtime_epoch,
        dispatch_id, message_id, notification_id, purpose, audit_attempt_id,
        audit_revision, audited_session_name, task_id, assignment_id,
        coordinator_assignment_id, status,
        created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delegationId,
      '',
      input.origin.sessionName,
      input.origin.sessionInstanceId,
      input.origin.runtimeEpoch,
      input.target.sessionName,
      input.target.sessionInstanceId,
      input.target.runtimeEpoch,
      input.dispatchId,
      input.messageId,
      notificationId,
      input.purpose ?? null,
      input.auditAttemptId ?? null,
      input.auditRevision ?? null,
      input.auditedSessionName ?? null,
      input.taskId ?? null,
      input.assignmentId ?? null,
      input.coordinatorAssignmentId ?? null,
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      now,
      now + AGENT_DELEGATION_REPLY_TTL_MS,
      now,
    );
    const record = this.get(delegationId);
    if (!record) throw new Error('delegation reply authority insert failed');
    return { record };
  }

  get(delegationId: string): DelegationReplyRecord | undefined {
    const row = this.#db.prepare(`
      SELECT
        delegation_id AS delegationId,
        capability_hash AS capabilityHash,
        origin_session_name AS originSessionName,
        origin_session_instance_id AS originSessionInstanceId,
        origin_runtime_epoch AS originRuntimeEpoch,
        target_session_name AS targetSessionName,
        target_session_instance_id AS targetSessionInstanceId,
        target_runtime_epoch AS targetRuntimeEpoch,
        dispatch_id AS dispatchId,
        message_id AS messageId,
        notification_id AS notificationId,
        purpose,
        audit_attempt_id AS auditAttemptId,
        audit_revision AS auditRevision,
        audited_session_name AS auditedSessionName,
        task_id AS taskId,
        assignment_id AS assignmentId,
        coordinator_assignment_id AS coordinatorAssignmentId,
        status,
        result,
        created_at AS createdAt,
        expires_at AS expiresAt,
        updated_at AS updatedAt,
        delivered_at AS deliveredAt
      FROM delegation_replies WHERE delegation_id = ?
    `).get(delegationId) as Record<string, unknown> | undefined;
    return row ? parseRow(row) : undefined;
  }

  getMessage(delegationId: string, notificationId: string): DelegationReplyRecord | undefined {
    const row = this.#db.prepare(`
      SELECT
        authority.delegation_id AS delegationId,
        authority.capability_hash AS capabilityHash,
        authority.origin_session_name AS originSessionName,
        authority.origin_session_instance_id AS originSessionInstanceId,
        authority.origin_runtime_epoch AS originRuntimeEpoch,
        authority.target_session_name AS targetSessionName,
        authority.target_session_instance_id AS targetSessionInstanceId,
        authority.target_runtime_epoch AS targetRuntimeEpoch,
        authority.dispatch_id AS dispatchId,
        authority.message_id AS messageId,
        message.notification_id AS notificationId,
        message.message_kind AS messageKind,
        authority.purpose,
        authority.audit_attempt_id AS auditAttemptId,
        authority.audit_revision AS auditRevision,
        authority.audited_session_name AS auditedSessionName,
        authority.task_id AS taskId,
        authority.assignment_id AS assignmentId,
        authority.coordinator_assignment_id AS coordinatorAssignmentId,
        message.status,
        message.result,
        authority.created_at AS createdAt,
        authority.expires_at AS expiresAt,
        message.updated_at AS updatedAt,
        message.delivered_at AS deliveredAt
      FROM delegation_reply_messages message
      JOIN delegation_replies authority ON authority.delegation_id = message.delegation_id
      WHERE message.delegation_id = ? AND message.notification_id = ?
    `).get(delegationId, notificationId) as Record<string, unknown> | undefined;
    return row ? parseRow(row) : undefined;
  }

  /** Apply only after the registry has recorded an explicit Brain-authorized rebind. */
  /**
   * Advance a task-bound reply onto a re-authorized coordinator origin.
   *
   * A pending return is addressed to the ORIGINAL coordinator assignment. When
   * that coordinator's runtime is legitimately replaced (a restart rotates its
   * instance/epoch), the reply must move WITH the authorization rather than be
   * lost or silently delivered to whoever now holds the name. Authority is the
   * exact (taskId, assignmentId) pair the record was minted under; anything else
   * returns undefined and changes nothing.
   */
  rebindAuthorizedOrigin(input: {
    delegationId: string;
    taskId: string;
    assignmentId: string;
    /** The task's ORIGINAL coordinator assignment. Required: authority to move a
     *  return belongs to that assignment, not to whoever holds the origin name. */
    coordinatorAssignmentId: string;
    origin: DelegationReplyBoundIdentity;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const current = this.get(input.delegationId);
    if (!current || current.taskId !== input.taskId || current.assignmentId !== input.assignmentId) return undefined;
    // Fail closed on a record that never recorded a coordinator (legacy rows):
    // an unbound return must not become adoptable by any coordinator.
    if (!current.coordinatorAssignmentId
      || current.coordinatorAssignmentId !== input.coordinatorAssignmentId) return undefined;
    // The logical coordinator is the same session; only its runtime rotated.
    // A different NAME is a different coordinator and is never adopted here.
    if (current.origin.sessionName !== input.origin.sessionName) return undefined;
    this.#db.prepare(`
      UPDATE delegation_replies
      SET origin_session_instance_id = ?, origin_runtime_epoch = ?, updated_at = ?
      WHERE delegation_id = ? AND task_id = ? AND assignment_id = ?
    `).run(
      input.origin.sessionInstanceId,
      input.origin.runtimeEpoch,
      input.now ?? Date.now(),
      input.delegationId,
      input.taskId,
      input.assignmentId,
    );
    return this.get(input.delegationId);
  }

  rebindAssignmentTarget(input: {
    delegationId: string;
    taskId: string;
    assignmentId: string;
    target: DelegationReplyBoundIdentity;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const current = this.get(input.delegationId);
    if (!current || current.taskId !== input.taskId || current.assignmentId !== input.assignmentId) return undefined;
    this.#db.prepare(`
      UPDATE delegation_replies
      SET target_session_name = ?, target_session_instance_id = ?, target_runtime_epoch = ?, updated_at = ?
      WHERE delegation_id = ? AND task_id = ? AND assignment_id = ?
    `).run(
      input.target.sessionName,
      input.target.sessionInstanceId,
      input.target.runtimeEpoch,
      input.now ?? Date.now(),
      input.delegationId,
      input.taskId,
      input.assignmentId,
    );
    return this.get(input.delegationId);
  }

  #getMessageByResultKey(delegationId: string, key: string): DelegationReplyRecord | undefined {
    const row = this.#db.prepare(`
      SELECT notification_id AS notificationId
      FROM delegation_reply_messages
      WHERE delegation_id = ? AND result_key = ?
    `).get(delegationId, key) as { notificationId?: unknown } | undefined;
    return row?.notificationId
      ? this.getMessage(delegationId, String(row.notificationId))
      : undefined;
  }

  matchPendingAuthority(input: {
    delegationId: string;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const current = this.get(input.delegationId);
    const now = input.now ?? Date.now();
    if (!current
      || current.status !== AGENT_DELEGATION_REPLY_STATUSES.PENDING
      || now >= current.expiresAt) return undefined;
    return current;
  }

  /**
   * Resolve an ordinary reply channel for one exact active assignment.
   * Expired/closed history is non-authoritative. A duplicate live row fails
   * closed so a continuation can never mint a third competing authority.
   */
  findCurrentAssignmentAuthority(input: {
    taskId: string;
    assignmentId: string;
    origin: DelegationReplyBoundIdentity;
    target: DelegationReplyBoundIdentity;
    now?: number;
  }): CurrentAssignmentReplyAuthority {
    const now = input.now ?? Date.now();
    const rows = this.#db.prepare(`
      SELECT delegation_id AS delegationId
      FROM delegation_replies
      WHERE purpose IS NULL
        AND task_id = ?
        AND assignment_id = ?
        AND origin_session_name = ?
        AND origin_session_instance_id = ?
        AND origin_runtime_epoch = ?
        AND target_session_name = ?
        AND target_session_instance_id = ?
        AND target_runtime_epoch = ?
        AND status = ?
        AND expires_at > ?
    `).all(
      input.taskId,
      input.assignmentId,
      input.origin.sessionName,
      input.origin.sessionInstanceId,
      input.origin.runtimeEpoch,
      input.target.sessionName,
      input.target.sessionInstanceId,
      input.target.runtimeEpoch,
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      now,
    ) as Array<{ delegationId?: unknown }>;
    if (rows.length === 0) return { status: 'none' };
    if (rows.length !== 1 || typeof rows[0]?.delegationId !== 'string') return { status: 'ambiguous' };
    const record = this.get(rows[0].delegationId);
    return record ? { status: 'matched', record } : { status: 'none' };
  }

  /**
   * Resolve the reply authority minted by `send_message({ audit: ... })`.
   *
   * Manual supervision audits intentionally expose `peer_audit_reply`, not
   * `delegation_reply`. This durable dispatch row is discovery only; the
   * registry's attempt/revision/assignment/current-session identity is the
   * fail-closed authority and survives daemon restart.
   */
  matchPendingAuditAuthority(input: {
    taskId: string;
    assignmentId: string;
    auditAttemptId: string;
    auditRevision: string;
    sender: DelegationReplyBoundIdentity;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const rows = this.#db.prepare(`
      SELECT delegation_id AS delegationId
      FROM delegation_replies
      WHERE purpose = ?
        AND task_id = ?
        AND assignment_id = ?
        AND audit_attempt_id = ?
        AND audit_revision = ?
        AND target_session_name = ?
        AND target_session_instance_id = ?
        AND target_runtime_epoch = ?
        AND status = ?
    `).all(
      AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      input.taskId,
      input.assignmentId,
      input.auditAttemptId,
      input.auditRevision,
      input.sender.sessionName,
      input.sender.sessionInstanceId,
      input.sender.runtimeEpoch,
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
    ) as Array<{ delegationId?: unknown }>;
    if (rows.length === 0 || typeof rows[0]?.delegationId !== 'string') return undefined;
    const records = rows
      .map((row) => typeof row.delegationId === 'string' ? this.get(row.delegationId) : undefined)
      .filter((record): record is DelegationReplyRecord => Boolean(record));
    if (records.length !== rows.length) return undefined;
    const current = records.reduce((latest, candidate) => (
      candidate.createdAt > latest.createdAt
        || (candidate.createdAt === latest.createdAt && candidate.delegationId > latest.delegationId)
        ? candidate
        : latest
    ));
    // Versions before exact-redelivery replacement could leave several
    // equivalent pending rows. They are one logical authority only when every
    // immutable origin/audited binding agrees; any disagreement stays closed.
    if (records.some((candidate) => (
      !identityMatches(candidate.origin, current.origin)
      || candidate.auditedSessionName !== current.auditedSessionName
    ))) return undefined;
    for (const superseded of records) {
      if (superseded.delegationId === current.delegationId) continue;
      this.#db.prepare(`
        UPDATE delegation_replies SET status = ?, updated_at = ?
        WHERE delegation_id = ? AND status = ?
      `).run(
        AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
        input.now ?? Date.now(),
        superseded.delegationId,
        AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      );
    }
    return current
      && current.purpose === AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
      && current.taskId === input.taskId
      && current.assignmentId === input.assignmentId
      && current.auditAttemptId === input.auditAttemptId
      && current.auditRevision === input.auditRevision
      && current.status === AGENT_DELEGATION_REPLY_STATUSES.PENDING
      && identityMatches(current.target, input.sender)
      ? current
      : undefined;
  }

  /**
   * Find the ONE durable audit brief that already owns an exact attempt and
   * revision, even when a crash left its registry assignment unmaterialised.
   * The caller still authenticates every tuple field before adoption.
   */
  findPendingAuditDelivery(input: {
    taskId: string;
    auditAttemptId: string;
    auditRevision: string;
    auditedSessionName: string;
    /**
     * The registry's one exact current auditor. When present it is the object
     * authority; durable delivery rows may only be converged onto this binding.
     */
    assignmentAuthority?: PendingAuditDeliveryAssignmentAuthority;
    now?: number;
  }): PendingAuditDeliveryAuthority {
    const taskId = input.taskId.trim();
    const auditAttemptId = input.auditAttemptId.trim();
    const auditRevision = input.auditRevision.trim();
    const auditedSessionName = input.auditedSessionName.trim();
    if (!taskId || !auditAttemptId || !auditRevision || !auditedSessionName) {
      return { status: 'none' };
    }
    const queryRows = () => this.#db.prepare(`
      SELECT delegation_id AS delegationId
      FROM delegation_replies
      WHERE purpose = ?
        AND task_id = ?
        AND audit_attempt_id = ?
        AND audit_revision = ?
        AND assignment_id IS NOT NULL
        AND assignment_id <> ''
        AND status = ?
      ORDER BY created_at ASC, delegation_id ASC
    `).all(
      AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      taskId,
      auditAttemptId,
      auditRevision,
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
    ) as Array<{ delegationId?: unknown }>;
    const resolveRecords = (rows: Array<{ delegationId?: unknown }>) => rows
      .map((row) => typeof row.delegationId === 'string' ? this.get(row.delegationId) : undefined)
      .filter((record): record is DelegationReplyRecord => Boolean(record));
    if (!input.assignmentAuthority) {
      const rows = queryRows();
      if (rows.length === 0) return { status: 'none' };
      if (rows.length !== 1 || typeof rows[0]?.delegationId !== 'string') {
        return { status: 'ambiguous' };
      }
      const record = this.get(rows[0].delegationId);
      return record?.auditedSessionName === auditedSessionName
        ? { status: 'matched', record }
        : { status: 'ambiguous' };
    }

    const authority = input.assignmentAuthority;
    if (!authority.assignmentId.trim() || !authority.messageId.trim()
      || authority.origins.length === 0) return { status: 'none' };
    const originNames = new Set(authority.origins.map((origin) => origin.sessionName));
    const authoritativeMessageIds = new Set([
      authority.messageId,
      ...authority.supersededMessageIds,
    ]);
    const supersededDeliveries = new Set((authority.supersededDeliveries ?? []).map((delivery) => (
      `${delivery.messageId}\0${delivery.targetSessionName}`
    )));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = queryRows();
      if (rows.length === 0) {
        this.#db.exec('COMMIT');
        return { status: 'none' };
      }
      const records = resolveRecords(rows);
      const isExplicitlySupersededTarget = (record: DelegationReplyRecord) => (
        supersededDeliveries.has(`${record.messageId}\0${record.target.sessionName}`)
      );
      if (records.length !== rows.length
        || records.some((record) => (
          record.assignmentId !== authority.assignmentId
          || record.auditedSessionName !== auditedSessionName
          || !originNames.has(record.origin.sessionName)
          // A stale target runtime is metadata only when the registry already
          // names its message id as this exact assignment's superseded
          // delivery. An unknown row from another same-name runtime remains a
          // competing verdict principal and must fail closed.
          || (!identityMatches(record.target, authority.target)
            && !isExplicitlySupersededTarget(record)
            && (record.target.sessionName !== authority.target.sessionName
              || !authoritativeMessageIds.has(record.messageId)))
        ))) {
        this.#db.exec('ROLLBACK');
        return { status: 'ambiguous' };
      }
      // message_id is delivery metadata, not a second owner. A manual
      // audit-metadata continuation and an automatic redelivery can both leave
      // pending rows for the SAME registry assignment/attempt/revision. Once
      // the exact registry object, audited session, authorized origin name and
      // target name all agree above, an unexpected message id is redundant
      // metadata and is retired below together with the other superseded rows.
      // The canonical row is still selected by the current deterministic id
      // and exact runtime identities, so an unbound/non-canonical row can never
      // become authority by itself.
      const activeRecords = records.filter((record) => !isExplicitlySupersededTarget(record));
      let current = activeRecords.filter((record) => (
        record.messageId === authority.messageId
        && identityMatches(record.target, authority.target)
        && authority.origins.some((origin) => identityMatches(record.origin, origin))
      )).reduce<DelegationReplyRecord | undefined>((latest, candidate) => (
        !latest
          || candidate.createdAt > latest.createdAt
          || (candidate.createdAt === latest.createdAt && candidate.delegationId > latest.delegationId)
          ? candidate
          : latest
      ), undefined);
      // The audit target and canonical message id are the delivery authority.
      // A Brain restart can rotate only the origin epoch after the durable
      // brief was accepted. When there is exactly one such row and exactly one
      // current task participant with that session name, advance the origin
      // identity in this same transaction rather than misreporting one stale
      // row as multiple competing deliveries. A stale target remains closed:
      // it is the principal allowed to return the verdict.
      if (!current) {
        const staleOriginCandidates = activeRecords.filter((record) => (
          record.messageId === authority.messageId
          && identityMatches(record.target, authority.target)
          && authority.origins.filter((origin) => origin.sessionName === record.origin.sessionName).length === 1
        ));
        if (staleOriginCandidates.length === 1) {
          const candidate = staleOriginCandidates[0]!;
          const reboundOrigin = authority.origins.find(
            (origin) => origin.sessionName === candidate.origin.sessionName,
          )!;
          this.#db.prepare(`
            UPDATE delegation_replies
            SET origin_session_instance_id = ?, origin_runtime_epoch = ?, updated_at = ?
            WHERE delegation_id = ? AND status = ?
          `).run(
            reboundOrigin.sessionInstanceId,
            reboundOrigin.runtimeEpoch,
            input.now ?? Date.now(),
            candidate.delegationId,
            AGENT_DELEGATION_REPLY_STATUSES.PENDING,
          );
          current = { ...candidate, origin: reboundOrigin };
        }
      }
      // Without one exact current target/canonical-delivery claim there is no
      // proof a resend or adoption is safe, so leave every row untouched.
      if (!current) {
        if (activeRecords.length === 0 && records.length > 0) {
          const now = input.now ?? Date.now();
          for (const superseded of records) {
            this.#db.prepare(`
              UPDATE delegation_replies SET status = ?, updated_at = ?
              WHERE delegation_id = ? AND status = ?
            `).run(
              AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
              now,
              superseded.delegationId,
              AGENT_DELEGATION_REPLY_STATUSES.PENDING,
            );
          }
          this.#db.exec('COMMIT');
          return { status: 'none' };
        }
        this.#db.exec('ROLLBACK');
        return { status: 'ambiguous' };
      }
      // The registry supplies the single assignment authority. Once an exact
      // current claim exists, older claims for that SAME object are superseded
      // history, not competing auditors. Retire them with the selection in one
      // SQLite write transaction so a crash can expose neither two authorities
      // nor a partially-pruned decision.
      this.#db.prepare(`
        UPDATE delegation_replies
        SET status = ?, updated_at = ?
        WHERE purpose = ?
          AND task_id = ?
          AND assignment_id = ?
          AND audit_attempt_id = ?
          AND audit_revision = ?
          AND status = ?
          AND delegation_id <> ?
      `).run(
        AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
        input.now ?? Date.now(),
        AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
        taskId,
        authority.assignmentId,
        auditAttemptId,
        auditRevision,
        AGENT_DELEGATION_REPLY_STATUSES.PENDING,
        current.delegationId,
      );
      this.#db.exec('COMMIT');
      const record = this.get(current.delegationId);
      return record ? { status: 'matched', record } : { status: 'none' };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  receive(input: {
    delegationId: string;
    result: string;
    sender: DelegationReplyBoundIdentity;
    /** Current registry identity after an explicit assignment recovery/rebind. */
    authorizedSender?: DelegationReplyBoundIdentity;
    messageKind?: AgentDelegationReplyMessageKind;
    hold?: boolean;
    now?: number;
  }): ReceiveDelegationReplyResult {
    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(input.delegationId);
      if (!current) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }
      const expectedSender = input.authorizedSender ?? current.target;
      if (!identityMatches(expectedSender, input.sender)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'identity' };
      }
      if (!(current.taskId && current.assignmentId)
        && (current.status === AGENT_DELEGATION_REPLY_STATUSES.EXPIRED || now >= current.expiresAt)) {
        this.#db.prepare(`
          UPDATE delegation_replies SET status = ?, updated_at = ? WHERE delegation_id = ?
        `).run(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED, now, input.delegationId);
        this.#db.exec('COMMIT');
        return { ok: false, reason: 'expired' };
      }
      const key = resultKey(input.result);
      const existing = this.#getMessageByResultKey(input.delegationId, key);
      if (existing) {
        this.#db.exec('ROLLBACK');
        return { ok: true, record: existing, replay: true };
      }
      const messageCount = Number((this.#db.prepare(`
        SELECT COUNT(*) AS count FROM delegation_reply_messages WHERE delegation_id = ?
      `).get(input.delegationId) as { count?: unknown } | undefined)?.count ?? 0);
      if (messageCount >= AGENT_DELEGATION_REPLY_MAX_MESSAGES) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'limit' };
      }
      const notificationId = opaqueId();
      const messageKind = input.messageKind ?? AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION;
      const messageStatus = input.hold
        ? AGENT_DELEGATION_REPLY_STATUSES.HELD
        : AGENT_DELEGATION_REPLY_STATUSES.RECEIVED;
      this.#db.prepare(`
        INSERT INTO delegation_reply_messages (
          delegation_id, result_key, notification_id, message_kind, result, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.delegationId,
        key,
        notificationId,
        messageKind,
        input.result,
        messageStatus,
        now,
        now,
      );
      // A held audit completion is evidence/debug text, not the verdict
      // channel. It must not close the still-pending peer_audit_reply authority.
      if (!input.hold) {
        this.#db.prepare(`
          UPDATE delegation_replies
          SET status = ?, result = ?, notification_id = ?, updated_at = ?
          WHERE delegation_id = ?
        `).run(
          AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
          input.result,
          notificationId,
          now,
          input.delegationId,
        );
      }
      const updated = this.getMessage(input.delegationId, notificationId);
      this.#db.exec('COMMIT');
      if (!updated) throw new Error('delegation reply authority disappeared');
      return { ok: true, record: updated, replay: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /** Suppress only held completion prose for one exact audit identity tuple. */
  suppressHeldAuditCompletions(input: {
    delegationId: string;
    taskId: string;
    assignmentId: string;
    auditAttemptId: string;
    auditRevision: string;
    sender: DelegationReplyBoundIdentity;
    now?: number;
  }): string[] {
    const rows = this.#db.prepare(`
      SELECT message.notification_id AS notificationId
      FROM delegation_reply_messages message
      JOIN delegation_replies authority ON authority.delegation_id = message.delegation_id
      WHERE authority.delegation_id = ? AND authority.purpose = ?
        AND authority.task_id = ? AND authority.assignment_id = ?
        AND authority.audit_attempt_id = ? AND authority.audit_revision = ?
        AND authority.target_session_name = ?
        AND authority.target_session_instance_id = ?
        AND authority.target_runtime_epoch = ?
        AND message.message_kind = ? AND message.status = ?
    `).all(
      input.delegationId,
      AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      input.taskId,
      input.assignmentId,
      input.auditAttemptId,
      input.auditRevision,
      input.sender.sessionName,
      input.sender.sessionInstanceId,
      input.sender.runtimeEpoch,
      AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION,
      AGENT_DELEGATION_REPLY_STATUSES.HELD,
    ) as Array<{ notificationId?: unknown }>;
    const ids = rows.map((row) => String(row.notificationId ?? '')).filter(Boolean);
    if (ids.length === 0) return [];
    this.#db.prepare(`
      UPDATE delegation_reply_messages SET status = ?, updated_at = ?
      WHERE delegation_id = ? AND message_kind = ? AND status = ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.SUPPRESSED,
      input.now ?? Date.now(),
      input.delegationId,
      AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION,
      AGENT_DELEGATION_REPLY_STATUSES.HELD,
    );
    return ids;
  }

  /** Release one held completion after the bounded receipt reconciliation. */
  releaseHeldAuditCompletion(input: {
    delegationId: string;
    notificationId: string;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const held = this.getMessage(input.delegationId, input.notificationId);
    if (!held || held.status !== AGENT_DELEGATION_REPLY_STATUSES.HELD
      || held.messageKind !== AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION) return undefined;
    const now = input.now ?? Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.#db.prepare(`
        UPDATE delegation_reply_messages SET status = ?, updated_at = ?
        WHERE delegation_id = ? AND notification_id = ? AND message_kind = ? AND status = ?
      `).run(
        AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
        now,
        input.delegationId,
        input.notificationId,
        AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION,
        AGENT_DELEGATION_REPLY_STATUSES.HELD,
      );
      if (Number(changed.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return undefined;
      }
      // Delivery of fallback prose does not consume the verdict authority.
      // A late exact peer_audit_reply must remain acceptable after the bounded
      // reconciliation window has elapsed.
      this.#db.exec('COMMIT');
      return this.getMessage(input.delegationId, input.notificationId);
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  markDelivered(delegationId: string, notificationId: string, now = Date.now()): boolean {
    const message = this.getMessage(delegationId, notificationId);
    const result = this.#db.prepare(`
      UPDATE delegation_reply_messages
      SET status = ?, delivered_at = ?, updated_at = ?
      WHERE delegation_id = ? AND notification_id = ? AND status = ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
      now,
      now,
      delegationId,
      notificationId,
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
    );
    if (Number(result.changes) !== 1) return false;
    if (message?.purpose === AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
      && message.messageKind === AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION) {
      return true;
    }
    const pending = Number((this.#db.prepare(`
      SELECT COUNT(*) AS count FROM delegation_reply_messages
      WHERE delegation_id = ? AND status = ?
    `).get(delegationId, AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) as { count?: unknown } | undefined)?.count ?? 0);
    if (pending === 0) {
      this.#db.prepare(`
        UPDATE delegation_replies
        SET status = ?, delivered_at = ?, updated_at = ?
        WHERE delegation_id = ?
      `).run(AGENT_DELEGATION_REPLY_STATUSES.DELIVERED, now, now, delegationId);
    }
    return true;
  }

  expire(delegationId: string, now = Date.now()): void {
    this.#db.prepare(`
      UPDATE delegation_replies
      SET status = ?, updated_at = ?
      WHERE delegation_id = ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      now,
      delegationId,
    );
    this.#db.prepare(`
      UPDATE delegation_reply_messages
      SET status = ?, updated_at = ?
      WHERE delegation_id = ? AND status = ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      now,
      delegationId,
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
    );
  }

  /**
   * Retire every still-open return of a delegation whose task has ENDED.
   *
   * Unlike {@link expire}, this also closes HELD audit completions: those are
   * re-listed on every startup resume, so leaving them open would re-arm the
   * same stale delivery after each daemon restart.
   */
  retireForEndedTask(delegationId: string, now = Date.now()): number {
    this.#db.prepare(`
      UPDATE delegation_replies
      SET status = ?, updated_at = ?
      WHERE delegation_id = ? AND status <> ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      now,
      delegationId,
      AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
    );
    const result = this.#db.prepare(`
      UPDATE delegation_reply_messages
      SET status = ?, updated_at = ?
      WHERE delegation_id = ? AND status IN (?, ?)
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      now,
      delegationId,
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
      AGENT_DELEGATION_REPLY_STATUSES.HELD,
    );
    return Number(result.changes ?? 0);
  }

  /**
   * Every still-open return owned by one exact (task, coordinator assignment).
   *
   * This is what connects an authorized coordinator rebind to the pending
   * replies it owns: without it `rebindAuthorizedOrigin` had no production
   * caller and a real rebind still stranded the return. Delivered and expired
   * rows are excluded -- there is nothing left to advance.
   */
  listPendingByCoordinator(input: { taskId: string; coordinatorAssignmentId: string }): DelegationReplyRecord[] {
    const taskId = input.taskId?.trim();
    const coordinatorAssignmentId = input.coordinatorAssignmentId?.trim();
    if (!taskId || !coordinatorAssignmentId) return [];
    const rows = this.#db.prepare(`
      SELECT delegation_id AS delegationId
      FROM delegation_replies
      WHERE task_id = ? AND coordinator_assignment_id = ?
      ORDER BY created_at ASC
    `).all(taskId, coordinatorAssignmentId) as Array<{ delegationId?: unknown }>;
    // Reuse the single proven read path rather than restating its projection.
    return rows
      .map((row) => this.get(String(row.delegationId ?? '')))
      .filter((record): record is DelegationReplyRecord => (
        record !== undefined
        && record.status !== AGENT_DELEGATION_REPLY_STATUSES.DELIVERED
        && record.status !== AGENT_DELEGATION_REPLY_STATUSES.EXPIRED
      ));
  }

  /**
   * The message ids that carried one exact assignment to one target session:
   * the original task dispatch plus any reply-bound continuation. Reply status
   * is irrelevant here -- a delivered or expired reply still proves which
   * message bound the assignment to that session.
   */
  listAssignmentDeliveryMessageIds(input: {
    taskId: string;
    assignmentId: string;
    targetSessionName: string;
  }): string[] {
    const taskId = input.taskId?.trim();
    const assignmentId = input.assignmentId?.trim();
    const targetSessionName = input.targetSessionName?.trim();
    if (!taskId || !assignmentId || !targetSessionName) return [];
    const rows = this.#db.prepare(`
      SELECT message_id AS messageId
      FROM delegation_replies
      WHERE task_id = ? AND assignment_id = ? AND target_session_name = ?
      ORDER BY created_at ASC
    `).all(taskId, assignmentId, targetSessionName) as Array<{ messageId?: unknown }>;
    return [...new Set(rows
      .map((row) => (typeof row.messageId === 'string' ? row.messageId.trim() : ''))
      .filter((messageId) => messageId.length > 0))];
  }

  /**
   * Durable replies still owed to (or not yet delivered to) one origin session.
   * Delivered and expired rows are closed and never returned (the status
   * filter is the query's own; `get` reads the same column synchronously). A
   * non-task reply whose deadline passed is closed even before the expiry
   * sweep marks it. A task-bound row never times out, so its liveness is the
   * supervision registry's to decide -- callers must check it there.
   */
  listOpenByOriginSession(sessionName: string, now = Date.now()): DelegationReplyRecord[] {
    const origin = sessionName?.trim();
    if (!origin) return [];
    const rows = this.#db.prepare(`
      SELECT delegation_id AS delegationId
      FROM delegation_replies
      WHERE origin_session_name = ? AND status IN (?, ?)
      ORDER BY created_at ASC
    `).all(
      origin,
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
    ) as Array<{ delegationId?: unknown }>;
    return rows
      .map((row) => this.get(String(row.delegationId ?? '')))
      .filter((record): record is DelegationReplyRecord => (
        record !== undefined
        && (Boolean(record.taskId && record.assignmentId) || record.expiresAt > now)
      ));
  }

  listReceived(limit = 128): DelegationReplyRecord[] {
    const rows = this.#db.prepare(`
      SELECT
        authority.delegation_id AS delegationId,
        authority.capability_hash AS capabilityHash,
        authority.origin_session_name AS originSessionName,
        authority.origin_session_instance_id AS originSessionInstanceId,
        authority.origin_runtime_epoch AS originRuntimeEpoch,
        authority.target_session_name AS targetSessionName,
        authority.target_session_instance_id AS targetSessionInstanceId,
        authority.target_runtime_epoch AS targetRuntimeEpoch,
        authority.dispatch_id AS dispatchId,
        authority.message_id AS messageId,
        message.notification_id AS notificationId,
        message.message_kind AS messageKind,
        authority.purpose,
        authority.audit_attempt_id AS auditAttemptId,
        authority.audit_revision AS auditRevision,
        authority.audited_session_name AS auditedSessionName,
        authority.task_id AS taskId,
        authority.assignment_id AS assignmentId,
        authority.coordinator_assignment_id AS coordinatorAssignmentId,
        message.status,
        message.result,
        authority.created_at AS createdAt,
        authority.expires_at AS expiresAt,
        message.updated_at AS updatedAt,
        message.delivered_at AS deliveredAt
      FROM delegation_reply_messages message
      JOIN delegation_replies authority ON authority.delegation_id = message.delegation_id
      WHERE message.status = ?
      ORDER BY message.updated_at ASC
      LIMIT ?
    `).all(AGENT_DELEGATION_REPLY_STATUSES.RECEIVED, Math.max(1, Math.min(1_024, limit))) as Record<string, unknown>[];
    return rows.map(parseRow);
  }

  listHeldAuditCompletions(limit = 128): DelegationReplyRecord[] {
    const rows = this.#db.prepare(`
      SELECT
        authority.delegation_id AS delegationId,
        authority.capability_hash AS capabilityHash,
        authority.origin_session_name AS originSessionName,
        authority.origin_session_instance_id AS originSessionInstanceId,
        authority.origin_runtime_epoch AS originRuntimeEpoch,
        authority.target_session_name AS targetSessionName,
        authority.target_session_instance_id AS targetSessionInstanceId,
        authority.target_runtime_epoch AS targetRuntimeEpoch,
        authority.dispatch_id AS dispatchId,
        authority.message_id AS messageId,
        message.notification_id AS notificationId,
        message.message_kind AS messageKind,
        authority.purpose, authority.audit_attempt_id AS auditAttemptId,
        authority.audit_revision AS auditRevision, authority.audited_session_name AS auditedSessionName,
        authority.task_id AS taskId, authority.assignment_id AS assignmentId,
        authority.coordinator_assignment_id AS coordinatorAssignmentId,
        message.status, message.result, authority.created_at AS createdAt,
        authority.expires_at AS expiresAt, message.updated_at AS updatedAt,
        message.delivered_at AS deliveredAt
      FROM delegation_reply_messages message
      JOIN delegation_replies authority ON authority.delegation_id = message.delegation_id
      WHERE authority.purpose = ? AND message.message_kind = ? AND message.status = ?
      ORDER BY message.updated_at ASC LIMIT ?
    `).all(
      AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
      AGENT_DELEGATION_REPLY_MESSAGE_KINDS.DELEGATION_COMPLETION,
      AGENT_DELEGATION_REPLY_STATUSES.HELD,
      Math.max(1, Math.min(1_024, limit)),
    ) as Record<string, unknown>[];
    return rows.map(parseRow);
  }
}

let defaultStore: DelegationReplyStore | undefined;

export function getDelegationReplyStore(): DelegationReplyStore {
  defaultStore ??= new DelegationReplyStore();
  return defaultStore;
}

export function resetDelegationReplyStoreForTests(): void {
  defaultStore?.close();
  defaultStore = undefined;
}
