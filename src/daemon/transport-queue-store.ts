import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  FAILED_QUEUE_ENTRY_STATUSES,
  LIVE_QUEUE_ENTRY_STATUSES,
  type QueueDropReason,
  type QueueDeliveryFact,
  type QueueFailureReason,
  type QueuePlacement,
  type QueueProjectionEntry,
  type QueueResetReason,
  type QueueSnapshot,
  type QueueStoredEntry,
} from '../../shared/transport-queue-types.js';
import { buildQueueProjectionEntry } from '../../shared/transport-queue-privacy.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'transport-queue.sqlite');

export interface TransportQueueStoreOptions {
  dbPath?: string;
  database?: DatabaseSyncInstance;
  busyTimeoutMs?: number;
}

export interface EnqueueTransportQueueEntryInput {
  sessionName: string;
  text: string;
  clientMessageId?: string;
  commandId?: string;
  placement?: QueuePlacement;
  now?: number;
  activityGeneration?: number | string;
  replacesClientMessageId?: string;
  privateMaterialJson?: string;
}

export interface EnqueueTransportQueueEntryResult {
  queueSnapshot: QueueSnapshot;
  dropSnapshot?: QueueSnapshot;
}

export interface HandoffTransportQueueEntry {
  entry: QueueProjectionEntry;
  handoffId: string;
  privateMaterialJson?: string;
}

export interface FinalizeTransportQueueSentResult {
  snapshot: QueueSnapshot;
  deliveryFacts: QueueDeliveryFact[];
}

export interface QueueDegradedDiagnostic {
  degraded: true;
  degradedReason: 'sqlite_busy_or_locked' | 'sqlite_error' | 'queue_authority_corrupt';
  errorClass: string;
}

export type QueueSafeMutationResult<T> =
  | { ok: true; result: T }
  | { ok: false; snapshot: QueueSnapshot; diagnostic: QueueDegradedDiagnostic };

function normalizeSessionName(sessionName: string): string {
  const trimmed = sessionName.trim();
  if (!trimmed) throw new Error('transport queue sessionName is required');
  return trimmed;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value) throw new Error(`transport queue ${label} is required`);
  return value;
}

function nowMs(input?: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : Date.now();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeSqliteDiagnostic(err: unknown): QueueDegradedDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const isBusyOrLocked = /\b(SQLITE_BUSY|SQLITE_LOCKED|busy|locked)\b/i.test(message);
  const isCorrupt = /\b(SQLITE_CORRUPT|corrupt|malformed)\b/i.test(message);
  return {
    degraded: true,
    degradedReason: isCorrupt ? 'queue_authority_corrupt' : (isBusyOrLocked ? 'sqlite_busy_or_locked' : 'sqlite_error'),
    errorClass: err instanceof Error ? err.name : 'Error',
  };
}

function parseStoredEntry(row: Record<string, unknown>): QueueStoredEntry {
  const attachmentsJson = readString(row.attachmentsJson);
  const sharedActorJson = readString(row.sharedActorJson);
  return {
    sessionName: requireNonEmpty(String(row.sessionName ?? ''), 'row.sessionName'),
    queueEpoch: requireNonEmpty(String(row.queueEpoch ?? ''), 'row.queueEpoch'),
    queueAuthorityId: requireNonEmpty(String(row.queueAuthorityId ?? ''), 'row.queueAuthorityId'),
    clientMessageId: requireNonEmpty(String(row.clientMessageId ?? ''), 'row.clientMessageId'),
    ...(readString(row.commandId) ? { commandId: readString(row.commandId) } : {}),
    text: String(row.text ?? ''),
    status: String(row.status ?? 'queued') as QueueStoredEntry['status'],
    placement: String(row.placement ?? 'normal') as QueuePlacement,
    ordinal: Number(row.ordinal ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
    pendingMessageVersion: Number(row.pendingMessageVersion ?? 0),
    ...(readString(row.activityGeneration) ? { activityGeneration: readString(row.activityGeneration) } : {}),
    ...(readString(row.replacesClientMessageId) ? { replacesClientMessageId: readString(row.replacesClientMessageId) } : {}),
    ...(readString(row.failureReason) ? { failureReason: readString(row.failureReason) as QueueFailureReason } : {}),
    ...(readString(row.dropReason) ? { dropReason: readString(row.dropReason) as QueueDropReason } : {}),
    ...(readString(row.resetReason) ? { resetReason: readString(row.resetReason) as QueueResetReason } : {}),
    ...(attachmentsJson ? { attachments: JSON.parse(attachmentsJson) as QueueStoredEntry['attachments'] } : {}),
    ...(sharedActorJson ? { sharedActor: JSON.parse(sharedActorJson) as QueueStoredEntry['sharedActor'] } : {}),
    ...(readString(row.handoffId) ? { handoffId: readString(row.handoffId) } : {}),
    ...(readNumber(row.handoffStartedAt) !== undefined ? { handoffStartedAt: readNumber(row.handoffStartedAt) } : {}),
    ...(readNumber(row.handoffExpiresAt) !== undefined ? { handoffExpiresAt: readNumber(row.handoffExpiresAt) } : {}),
    ...(readNumber(row.handoffAttempt) !== undefined ? { handoffAttempt: readNumber(row.handoffAttempt) } : {}),
    ...(readString(row.privateMaterialRef) ? { privateMaterialRef: readString(row.privateMaterialRef) } : {}),
  };
}

export class TransportQueueStore {
  private readonly db: DatabaseSyncInstance;
  private readonly ownsDb: boolean;
  private closed = false;

  constructor(options: TransportQueueStoreOptions = {}) {
    if (options.database) {
      this.db = options.database;
      this.ownsDb = false;
    } else {
      const dbPath = options.dbPath?.trim()
        || process.env.IMCODES_TRANSPORT_QUEUE_DB_PATH?.trim()
        || (process.env.VITEST ? ':memory:' : DEFAULT_DB_PATH);
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDb = true;
    }
    this.initialize(options.busyTimeoutMs);
  }

  close(): void {
    if (this.ownsDb && !this.closed) this.db.close();
    this.closed = true;
  }

  private initialize(busyTimeoutMs = 5000): void {
    const boundedBusyTimeout = Math.max(0, Math.min(60_000, Math.floor(busyTimeoutMs)));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${boundedBusyTimeout};

      CREATE TABLE IF NOT EXISTS queue_meta (
        session_name TEXT PRIMARY KEY,
        queue_epoch TEXT NOT NULL,
        queue_authority_id TEXT NOT NULL,
        pending_message_version INTEGER NOT NULL DEFAULT 0,
        next_ordinal INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_entries (
        session_name TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        command_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        placement TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        activity_generation TEXT,
        replaces_client_message_id TEXT,
        failure_reason TEXT,
        drop_reason TEXT,
        reset_reason TEXT,
        attachments_json TEXT,
        shared_actor_json TEXT,
        handoff_id TEXT,
        handoff_started_at INTEGER,
        handoff_expires_at INTEGER,
        handoff_attempt INTEGER,
        private_material_ref TEXT,
        PRIMARY KEY (session_name, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS queue_private_material (
        session_name TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        material_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_name, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS queue_delivery_tombstones (
        session_name TEXT NOT NULL,
        queue_epoch TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        delivery_frame_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_name, queue_epoch, client_message_id)
      );
    `);
  }

  mutateSafely<T>(
    sessionNameInput: string,
    source: string,
    mutation: () => T,
  ): QueueSafeMutationResult<T> {
    try {
      return { ok: true, result: mutation() };
    } catch (err) {
      const diagnostic = safeSqliteDiagnostic(err);
      return {
        ok: false,
        snapshot: this.readSnapshotSafely(sessionNameInput, source),
        diagnostic,
      };
    }
  }

  private ensureMeta(sessionName: string, now = Date.now()): { queueEpoch: string; queueAuthorityId: string; pendingMessageVersion: number; nextOrdinal: number } {
    const session = normalizeSessionName(sessionName);
    const existing = this.db.prepare(`
      SELECT queue_epoch AS queueEpoch, queue_authority_id AS queueAuthorityId,
        pending_message_version AS pendingMessageVersion, next_ordinal AS nextOrdinal
      FROM queue_meta WHERE session_name = ?
    `).get(session) as { queueEpoch: string; queueAuthorityId: string; pendingMessageVersion: number; nextOrdinal: number } | undefined;
    if (existing) return existing;
    const meta = {
      queueEpoch: randomUUID(),
      queueAuthorityId: randomUUID(),
      pendingMessageVersion: 0,
      nextOrdinal: 0,
    };
    this.db.prepare(`
      INSERT INTO queue_meta (session_name, queue_epoch, queue_authority_id, pending_message_version, next_ordinal, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session, meta.queueEpoch, meta.queueAuthorityId, meta.pendingMessageVersion, meta.nextOrdinal, now);
    return meta;
  }

  private bumpVersion(sessionName: string, now = Date.now()): { queueEpoch: string; queueAuthorityId: string; pendingMessageVersion: number } {
    this.ensureMeta(sessionName, now);
    this.db.prepare(`
      UPDATE queue_meta
      SET pending_message_version = pending_message_version + 1, updated_at = ?
      WHERE session_name = ?
    `).run(now, sessionName);
    const meta = this.ensureMeta(sessionName, now);
    return {
      queueEpoch: meta.queueEpoch,
      queueAuthorityId: meta.queueAuthorityId,
      pendingMessageVersion: meta.pendingMessageVersion,
    };
  }

  enqueue(input: EnqueueTransportQueueEntryInput): QueueSnapshot {
    return this.enqueueWithCapacityEviction(input).queueSnapshot;
  }

  enqueueWithCapacityEviction(
    input: EnqueueTransportQueueEntryInput,
    evictClientMessageIdInput?: string,
  ): EnqueueTransportQueueEntryResult {
    const sessionName = normalizeSessionName(input.sessionName);
    const now = nowMs(input.now);
    const clientMessageId = input.clientMessageId?.trim() || randomUUID();
    const evictClientMessageId = evictClientMessageIdInput?.trim() || undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const meta = this.ensureMeta(sessionName, now);
      if (evictClientMessageId) {
        this.db.prepare('DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ?').run(sessionName, evictClientMessageId);
        this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, evictClientMessageId);
      }
      const ordinal = meta.nextOrdinal;
      this.db.prepare('UPDATE queue_meta SET next_ordinal = next_ordinal + 1, updated_at = ? WHERE session_name = ?').run(now, sessionName);
      this.db.prepare(`
        INSERT INTO queue_entries (
          session_name, client_message_id, command_id, text, status, placement, ordinal,
          created_at, updated_at, activity_generation, replaces_client_message_id, private_material_ref
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionName,
        clientMessageId,
        input.commandId?.trim() || null,
        input.text,
        input.placement ?? 'normal',
        ordinal,
        now,
        now,
        input.activityGeneration === undefined ? null : String(input.activityGeneration),
        input.replacesClientMessageId?.trim() || null,
        input.privateMaterialJson === undefined ? null : clientMessageId,
      );
      if (input.privateMaterialJson !== undefined) {
        this.db.prepare(`
          INSERT OR REPLACE INTO queue_private_material (session_name, client_message_id, material_json, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(sessionName, clientMessageId, input.privateMaterialJson, now);
      }
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return {
        queueSnapshot: this.readSnapshot(sessionName, 'enqueue', version),
        ...(evictClientMessageId ? { dropSnapshot: this.readSnapshot(sessionName, 'drop', { ...version, dropReason: 'capacity_evicted' }) } : {}),
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  edit(sessionNameInput: string, clientMessageIdInput: string, text: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries SET text = ?, updated_at = ? WHERE session_name = ? AND client_message_id = ?
      `).run(text, now, sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'edit', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markHandoffInFlight(sessionNameInput: string, clientMessageIds: string[], leaseMs = 60_000, now = Date.now()): HandoffTransportQueueEntry[] {
    const sessionName = normalizeSessionName(sessionNameInput);
    if (clientMessageIds.length === 0) return [];
    const handoffId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      const update = this.db.prepare(`
        UPDATE queue_entries
        SET status = 'handoff_inflight', handoff_id = ?, handoff_started_at = ?, handoff_expires_at = ?,
          handoff_attempt = COALESCE(handoff_attempt, 0) + 1, updated_at = ?
        WHERE session_name = ? AND client_message_id = ?
      `);
      for (const id of clientMessageIds) {
        update.run(handoffId, now, now + leaseMs, now, sessionName, id);
      }
      this.bumpVersion(sessionName, now);
      const rows = this.readRows(sessionName).filter((entry) => clientMessageIds.includes(entry.clientMessageId));
      const materialRows = this.db.prepare(`
        SELECT client_message_id AS clientMessageId, material_json AS materialJson
        FROM queue_private_material WHERE session_name = ?
      `).all(sessionName) as Array<{ clientMessageId: string; materialJson: string }>;
      const material = new Map(materialRows.map((row) => [row.clientMessageId, row.materialJson]));
      this.db.exec('COMMIT');
      return rows.map((entry) => ({
        entry: buildQueueProjectionEntry(entry),
        handoffId,
        ...(material.get(entry.clientMessageId) ? { privateMaterialJson: material.get(entry.clientMessageId) } : {}),
      }));
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  readPrivateDispatchMaterial(sessionNameInput: string, clientMessageIdInput: string): string | undefined {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    const row = this.db.prepare(`
      SELECT material_json AS materialJson
      FROM queue_private_material
      WHERE session_name = ? AND client_message_id = ?
    `).get(sessionName, clientMessageId) as { materialJson?: string } | undefined;
    return readString(row?.materialJson);
  }

  markMissingPrivateMaterialFailed(sessionNameInput: string, clientMessageIdInput: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries
        SET status = 'failed', failure_reason = 'private_material_missing',
          drop_reason = 'private_material_missing', updated_at = ?
        WHERE session_name = ? AND client_message_id = ?
      `).run(now, sessionName, clientMessageId);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'private_material_missing', { ...version, dropReason: 'private_material_missing' });
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  finalizeSent(sessionNameInput: string, clientMessageIdInput: string, deliveryFrameId = randomUUID(), now = Date.now()): QueueSnapshot {
    return this.finalizeSentBatch(sessionNameInput, [clientMessageIdInput], deliveryFrameId, now).snapshot;
  }

  finalizeSentBatch(
    sessionNameInput: string,
    clientMessageIdInputs: string[],
    deliveryFrameId = randomUUID(),
    now = Date.now(),
  ): FinalizeTransportQueueSentResult {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageIds = [...new Set(clientMessageIdInputs.map((id) => id.trim()).filter(Boolean))];
    if (clientMessageIds.length === 0) {
      const snapshot = this.readSnapshot(sessionName, 'finalize_sent_noop');
      return { snapshot, deliveryFacts: [] };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const meta = this.ensureMeta(sessionName, now);
      const deleteEntry = this.db.prepare('DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ?');
      const deletePrivateMaterial = this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?');
      const insertTombstone = this.db.prepare(`
        INSERT OR REPLACE INTO queue_delivery_tombstones (session_name, queue_epoch, client_message_id, delivery_frame_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const clientMessageId of clientMessageIds) {
        insertTombstone.run(sessionName, meta.queueEpoch, clientMessageId, deliveryFrameId, now);
        deleteEntry.run(sessionName, clientMessageId);
        deletePrivateMaterial.run(sessionName, clientMessageId);
      }
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      const deliveryFacts = clientMessageIds.map((clientMessageId): QueueDeliveryFact => ({
        type: 'transport.queue.delivery',
        sessionName,
        clientMessageId,
        queueEpoch: version.queueEpoch,
        queueAuthorityId: version.queueAuthorityId,
        pendingMessageVersion: version.pendingMessageVersion,
        deliveryFrameId,
        deliveryFrameVersion: version.pendingMessageVersion,
      }));
      return {
        snapshot: this.readSnapshot(sessionName, 'finalize_sent', version),
        deliveryFacts,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  hasDeliveryTombstone(sessionNameInput: string, clientMessageIdInput: string): boolean {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    const row = this.db.prepare(`
      SELECT 1 FROM queue_delivery_tombstones
      WHERE session_name = ? AND client_message_id = ?
      LIMIT 1
    `).get(sessionName, clientMessageId);
    return !!row;
  }

  markDeleted(sessionNameInput: string, clientMessageIdInput: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries SET status = 'deleted', updated_at = ?
        WHERE session_name = ? AND client_message_id = ?
      `).run(now, sessionName, clientMessageId);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'delete', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markFailed(
    sessionNameInput: string,
    clientMessageIdInput: string,
    failureReason: QueueFailureReason,
    now = Date.now(),
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries SET status = 'failed', failure_reason = ?, updated_at = ?
        WHERE session_name = ? AND client_message_id = ?
      `).run(failureReason, now, sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'mark_failed', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  retry(
    sessionNameInput: string,
    failedClientMessageIdInput: string,
    input: Omit<EnqueueTransportQueueEntryInput, 'sessionName' | 'replacesClientMessageId'>,
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const failedClientMessageId = requireNonEmpty(failedClientMessageIdInput.trim(), 'failedClientMessageId');
    return this.enqueue({
      ...input,
      sessionName,
      replacesClientMessageId: failedClientMessageId,
    });
  }

  dismissFailed(sessionNameInput: string, clientMessageIdInput: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries SET status = 'dismissed', updated_at = ?
        WHERE session_name = ? AND client_message_id = ? AND status IN ('failed', 'expired', 'capacity_evicted', 'cancelled')
      `).run(now, sessionName, clientMessageId);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'dismiss_failed', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  cleanup(sessionNameInput: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        DELETE FROM queue_entries
        WHERE session_name = ? AND status IN ('sent', 'deleted', 'dismissed', 'session_removed')
      `).run(sessionName);
      this.db.prepare(`
        DELETE FROM queue_private_material
        WHERE session_name = ? AND client_message_id NOT IN (
          SELECT client_message_id FROM queue_entries WHERE session_name = ?
        )
      `).run(sessionName, sessionName);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'cleanup', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  drop(sessionNameInput: string, clientMessageIdInput: string, dropReason: QueueDropReason, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare('DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'drop', { ...version, dropReason });
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  dropAll(sessionNameInput: string, dropReason: QueueDropReason, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare('DELETE FROM queue_entries WHERE session_name = ?').run(sessionName);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ?').run(sessionName);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'drop_all', { ...version, dropReason });
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reset(
    sessionNameInput: string,
    resetReason: QueueResetReason,
    now = Date.now(),
    options: { activityGeneration?: number | string } = {},
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM queue_entries WHERE session_name = ?').run(sessionName);
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ?').run(sessionName);
      this.db.prepare('DELETE FROM queue_delivery_tombstones WHERE session_name = ?').run(sessionName);
      const queueEpoch = randomUUID();
      const queueAuthorityId = randomUUID();
      this.db.prepare(`
        INSERT INTO queue_meta (session_name, queue_epoch, queue_authority_id, pending_message_version, next_ordinal, updated_at)
        VALUES (?, ?, ?, 1, 0, ?)
        ON CONFLICT(session_name) DO UPDATE SET
          queue_epoch = excluded.queue_epoch,
          queue_authority_id = excluded.queue_authority_id,
          pending_message_version = queue_meta.pending_message_version + 1,
          next_ordinal = 0,
          updated_at = excluded.updated_at
      `).run(sessionName, queueEpoch, queueAuthorityId, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'reset', {
        ...this.ensureMeta(sessionName, now),
        resetReason,
        ...(options.activityGeneration !== undefined ? { activityGeneration: options.activityGeneration } : {}),
      });
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reinitializeAfterCorruption(
    sessionNameInput: string,
    now = Date.now(),
    options: { activityGeneration?: number | string } = {},
  ): QueueSnapshot {
    return this.reset(sessionNameInput, 'authority_corrupt_reinitialized', now, options);
  }

  readSnapshotSafely(sessionNameInput: string, source = 'read'): QueueSnapshot {
    try {
      return this.readSnapshot(sessionNameInput, source);
    } catch (err) {
      const sessionName = normalizeSessionName(sessionNameInput);
      const diagnostic = safeSqliteDiagnostic(err);
      return {
        type: 'transport.queue.snapshot',
        sessionName,
        queueEpoch: 'unavailable',
        queueAuthorityId: 'unavailable',
        pendingMessageVersion: 0,
        pendingMessageEntries: [],
        failedMessageEntries: [],
        source,
        degraded: diagnostic.degraded,
        degradedReason: diagnostic.degradedReason,
      };
    }
  }

  restoreExpiredHandoffs(sessionNameInput: string, now = Date.now()): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries
        SET status = 'queued', handoff_id = NULL, handoff_started_at = NULL, handoff_expires_at = NULL, updated_at = ?
        WHERE session_name = ? AND status = 'handoff_inflight' AND handoff_expires_at IS NOT NULL AND handoff_expires_at <= ?
      `).run(now, sessionName, now);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'restore_expired_handoffs', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  readSnapshot(
    sessionNameInput: string,
    source = 'read',
    override?: {
      queueEpoch: string;
      queueAuthorityId: string;
      pendingMessageVersion: number;
      resetReason?: QueueResetReason;
      dropReason?: QueueDropReason;
      activityGeneration?: number | string;
    },
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const meta = override ?? this.ensureMeta(sessionName);
    const rows = this.readRows(sessionName);
    return {
      type: 'transport.queue.snapshot',
      sessionName,
      queueEpoch: meta.queueEpoch,
      queueAuthorityId: meta.queueAuthorityId,
      pendingMessageVersion: meta.pendingMessageVersion,
      pendingMessageEntries: rows
        .filter((entry) => LIVE_QUEUE_ENTRY_STATUSES.has(entry.status))
        .sort((a, b) => {
          if (a.placement !== b.placement) return a.placement === 'front' ? -1 : 1;
          return a.ordinal - b.ordinal || a.createdAt - b.createdAt || a.clientMessageId.localeCompare(b.clientMessageId);
        })
        .map(buildQueueProjectionEntry),
      failedMessageEntries: rows
        .filter((entry) => FAILED_QUEUE_ENTRY_STATUSES.has(entry.status))
        .sort((a, b) => {
          if (a.placement !== b.placement) return a.placement === 'front' ? -1 : 1;
          return a.ordinal - b.ordinal || a.createdAt - b.createdAt || a.clientMessageId.localeCompare(b.clientMessageId);
        })
        .map(buildQueueProjectionEntry),
      source,
      ...(override?.resetReason ? { resetReason: override.resetReason } : {}),
      ...(override?.dropReason ? { dropReason: override.dropReason } : {}),
      ...(override?.activityGeneration !== undefined ? { activityGeneration: override.activityGeneration } : {}),
    };
  }

  private readRows(sessionName: string): QueueStoredEntry[] {
    const rows = this.db.prepare(`
      SELECT
        e.session_name AS sessionName,
        m.queue_epoch AS queueEpoch,
        m.queue_authority_id AS queueAuthorityId,
        e.client_message_id AS clientMessageId,
        e.command_id AS commandId,
        e.text,
        e.status,
        e.placement,
        e.ordinal,
        e.created_at AS createdAt,
        e.updated_at AS updatedAt,
        m.pending_message_version AS pendingMessageVersion,
        e.activity_generation AS activityGeneration,
        e.replaces_client_message_id AS replacesClientMessageId,
        e.failure_reason AS failureReason,
        e.drop_reason AS dropReason,
        e.reset_reason AS resetReason,
        e.attachments_json AS attachmentsJson,
        e.shared_actor_json AS sharedActorJson,
        e.handoff_id AS handoffId,
        e.handoff_started_at AS handoffStartedAt,
        e.handoff_expires_at AS handoffExpiresAt,
        e.handoff_attempt AS handoffAttempt,
        e.private_material_ref AS privateMaterialRef
      FROM queue_entries e
      JOIN queue_meta m ON m.session_name = e.session_name
      WHERE e.session_name = ?
      ORDER BY CASE e.placement WHEN 'front' THEN 0 ELSE 1 END, e.ordinal, e.created_at, e.client_message_id
    `).all(sessionName) as Array<Record<string, unknown>>;
    return rows.map(parseStoredEntry);
  }
}

let singleton: TransportQueueStore | null = null;

export function getTransportQueueStore(): TransportQueueStore {
  singleton ??= new TransportQueueStore();
  return singleton;
}

export function resetTransportQueueStoreForTests(): void {
  singleton?.close();
  singleton = null;
}
