import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_DELEGATION_REPLY_STATUSES,
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
  capabilityHash: string;
  origin: DelegationReplyBoundIdentity;
  target: DelegationReplyBoundIdentity;
  dispatchId: string;
  messageId: string;
  notificationId: string;
  purpose?: AgentDelegationPurpose;
  auditAttemptId?: string;
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
  now?: number;
}

export interface CreatedDelegationReply {
  record: DelegationReplyRecord;
  replyCapability: string;
}

export type ReceiveDelegationReplyResult =
  | { ok: true; record: DelegationReplyRecord; replay: boolean }
  | { ok: false; reason: 'not_found' | 'capability' | 'identity' | 'expired' | 'already_replied' };

export interface DelegationReplyStoreOptions {
  dbPath?: string;
  database?: DatabaseSyncInstance;
  busyTimeoutMs?: number;
}

function opaqueId(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function capabilityHash(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('base64url');
}

function capabilityMatches(storedHash: string, capability: string): boolean {
  const expected = Buffer.from(storedHash, 'utf8');
  const actual = Buffer.from(capabilityHash(capability), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
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
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS delegation_replies_status_idx
        ON delegation_replies(status, updated_at);
    `);
    const columns = this.#db.prepare('PRAGMA table_info(delegation_replies)').all() as Array<{ name?: unknown }>;
    const names = new Set(columns.map((column) => String(column.name ?? '')));
    if (!names.has('purpose')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN purpose TEXT');
    }
    if (!names.has('audit_attempt_id')) {
      this.#db.exec('ALTER TABLE delegation_replies ADD COLUMN audit_attempt_id TEXT');
    }
  }

  close(): void {
    if (this.#ownsDb && !this.#closed) this.#db.close();
    this.#closed = true;
  }

  create(input: CreateDelegationReplyInput): CreatedDelegationReply {
    const now = input.now ?? Date.now();
    const delegationId = opaqueId();
    const replyCapability = opaqueId(32);
    const notificationId = opaqueId();
    this.#db.prepare(`
      INSERT INTO delegation_replies (
        delegation_id, capability_hash,
        origin_session_name, origin_session_instance_id, origin_runtime_epoch,
        target_session_name, target_session_instance_id, target_runtime_epoch,
        dispatch_id, message_id, notification_id, purpose, audit_attempt_id, status,
        created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delegationId,
      capabilityHash(replyCapability),
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
      AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      now,
      now + AGENT_DELEGATION_REPLY_TTL_MS,
      now,
    );
    const record = this.get(delegationId);
    if (!record) throw new Error('delegation reply authority insert failed');
    return { record, replyCapability };
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

  matchPendingAuthority(input: {
    delegationId: string;
    replyCapability: string;
    now?: number;
  }): DelegationReplyRecord | undefined {
    const current = this.get(input.delegationId);
    const now = input.now ?? Date.now();
    if (!current
      || current.status !== AGENT_DELEGATION_REPLY_STATUSES.PENDING
      || now >= current.expiresAt
      || !capabilityMatches(current.capabilityHash, input.replyCapability)) return undefined;
    return current;
  }

  receive(input: {
    delegationId: string;
    replyCapability: string;
    result: string;
    sender: DelegationReplyBoundIdentity;
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
      if (!capabilityMatches(current.capabilityHash, input.replyCapability)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'capability' };
      }
      if (!identityMatches(current.target, input.sender)) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'identity' };
      }
      if (current.status === AGENT_DELEGATION_REPLY_STATUSES.EXPIRED || now >= current.expiresAt) {
        this.#db.prepare(`
          UPDATE delegation_replies SET status = ?, updated_at = ? WHERE delegation_id = ?
        `).run(AGENT_DELEGATION_REPLY_STATUSES.EXPIRED, now, input.delegationId);
        this.#db.exec('COMMIT');
        return { ok: false, reason: 'expired' };
      }
      if (current.status === AGENT_DELEGATION_REPLY_STATUSES.DELIVERED) {
        this.#db.exec('ROLLBACK');
        return { ok: false, reason: 'already_replied' };
      }
      if (current.status === AGENT_DELEGATION_REPLY_STATUSES.RECEIVED) {
        this.#db.exec('ROLLBACK');
        return current.result === input.result
          ? { ok: true, record: current, replay: true }
          : { ok: false, reason: 'already_replied' };
      }
      this.#db.prepare(`
        UPDATE delegation_replies
        SET status = ?, result = ?, updated_at = ?
        WHERE delegation_id = ? AND status = ?
      `).run(
        AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
        input.result,
        now,
        input.delegationId,
        AGENT_DELEGATION_REPLY_STATUSES.PENDING,
      );
      const updated = this.get(input.delegationId);
      this.#db.exec('COMMIT');
      if (!updated) throw new Error('delegation reply authority disappeared');
      return { ok: true, record: updated, replay: false };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  markDelivered(delegationId: string, now = Date.now()): boolean {
    const result = this.#db.prepare(`
      UPDATE delegation_replies
      SET status = ?, delivered_at = ?, updated_at = ?
      WHERE delegation_id = ? AND status = ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
      now,
      now,
      delegationId,
      AGENT_DELEGATION_REPLY_STATUSES.RECEIVED,
    );
    return Number(result.changes) === 1;
  }

  expire(delegationId: string, now = Date.now()): void {
    this.#db.prepare(`
      UPDATE delegation_replies
      SET status = ?, updated_at = ?
      WHERE delegation_id = ? AND status != ?
    `).run(
      AGENT_DELEGATION_REPLY_STATUSES.EXPIRED,
      now,
      delegationId,
      AGENT_DELEGATION_REPLY_STATUSES.DELIVERED,
    );
  }

  listReceived(limit = 128): DelegationReplyRecord[] {
    const rows = this.#db.prepare(`
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
        status,
        result,
        created_at AS createdAt,
        expires_at AS expiresAt,
        updated_at AS updatedAt,
        delivered_at AS deliveredAt
      FROM delegation_replies
      WHERE status = ?
      ORDER BY updated_at ASC
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
