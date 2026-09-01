import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_STATUSES,
  AGENT_DELEGATION_REPLY_MAX_MESSAGES,
  AGENT_DELEGATION_REPLY_TTL_MS,
  type AgentDelegationPurpose,
  type AgentDelegationReplyStatus,
} from '../../shared/agent-delegation.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'delegation-replies.sqlite');

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
  purpose?: AgentDelegationPurpose;
  auditAttemptId?: string;
  auditRevision?: string;
  auditedSessionName?: string;
  taskId?: string;
  assignmentId?: string;
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
    ...(purpose ? { purpose } : {}),
    ...(auditAttemptId ? { auditAttemptId } : {}),
    ...(auditRevision ? { auditRevision } : {}),
    ...(auditedSessionName ? { auditedSessionName } : {}),
    ...(taskId ? { taskId } : {}),
    ...(assignmentId ? { assignmentId } : {}),
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
        delegation_id, result_key, notification_id, result, status,
        created_at, updated_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacyRows) {
      const result = String(row.result ?? '');
      const updatedAt = Number(row.updatedAt ?? Date.now());
      migrateLegacy.run(
        String(row.delegationId ?? ''),
        resultKey(result),
        String(row.notificationId ?? opaqueId()),
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
        audit_revision, audited_session_name, task_id, assignment_id, status,
        created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        authority.purpose,
        authority.audit_attempt_id AS auditAttemptId,
        authority.audit_revision AS auditRevision,
        authority.audited_session_name AS auditedSessionName,
        authority.task_id AS taskId,
        authority.assignment_id AS assignmentId,
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

  receive(input: {
    delegationId: string;
    result: string;
    sender: DelegationReplyBoundIdentity;
    /** Current registry identity after an explicit assignment recovery/rebind. */
    authorizedSender?: DelegationReplyBoundIdentity;
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
      this.#db.prepare(`
        INSERT INTO delegation_reply_messages (
          delegation_id, result_key, notification_id, result, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.delegationId,
        key,
        notificationId,
        input.result,
        AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
        now,
        now,
      );
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
      const updated = this.getMessage(input.delegationId, notificationId);
      this.#db.exec('COMMIT');
      if (!updated) throw new Error('delegation reply authority disappeared');
      return { ok: true, record: updated, replay: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  markDelivered(delegationId: string, notificationId: string, now = Date.now()): boolean {
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
        authority.purpose,
        authority.audit_attempt_id AS auditAttemptId,
        authority.audit_revision AS auditRevision,
        authority.audited_session_name AS auditedSessionName,
        authority.task_id AS taskId,
        authority.assignment_id AS assignmentId,
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
