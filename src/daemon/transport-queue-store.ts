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

/**
 * The RUNTIME a queue row is addressed to.
 *
 * A session name is a reusable handle; queued work belongs to the instance that
 * was live when it was queued. Rows carry this so a later session reusing the
 * name cannot drain another runtime's messages.
 */
export interface QueueRecipientIdentity {
  sessionInstanceId: string;
  runtimeEpoch: string;
}

/** Usable identity, or null. A blank field is not a wildcard. */
export function normalizeQueueRecipient(
  recipient: Partial<QueueRecipientIdentity> | null | undefined,
): QueueRecipientIdentity | null {
  const sessionInstanceId = recipient?.sessionInstanceId?.trim();
  const runtimeEpoch = recipient?.runtimeEpoch?.trim();
  return sessionInstanceId && runtimeEpoch ? { sessionInstanceId, runtimeEpoch } : null;
}

export interface EnqueueTransportQueueEntryInput {
  sessionName: string;
  /** Bound at enqueue from the live SessionRecord. */
  recipient?: QueueRecipientIdentity;
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
        updated_at INTEGER NOT NULL,
        recipient_session_instance_id TEXT,
        recipient_runtime_epoch TEXT
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
        recipient_session_instance_id TEXT,
        recipient_runtime_epoch TEXT,
        PRIMARY KEY (session_name, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS queue_private_material (
        session_name TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        material_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        recipient_session_instance_id TEXT,
        recipient_runtime_epoch TEXT,
        PRIMARY KEY (session_name, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS queue_delivery_tombstones (
        session_name TEXT NOT NULL,
        queue_epoch TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        delivery_frame_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        recipient_session_instance_id TEXT,
        recipient_runtime_epoch TEXT,
        PRIMARY KEY (session_name, queue_epoch, client_message_id)
      );
    `);
    this.migrateRecipientIdentityColumns();
  }

  /**
   * Bounded migration for databases written before recipient identity existed.
   *
   * A queue row is addressed to a RUNTIME, not to a name. Existing rows carry no
   * identity, so they are left NULL and quarantined by `queueBelongsTo` below --
   * never handed to a session that merely reuses the name. Adding the columns is
   * idempotent, so repeated daemon starts are a no-op.
   */
  private migrateRecipientIdentityColumns(): void {
    const tables = ['queue_meta', 'queue_entries', 'queue_private_material', 'queue_delivery_tombstones'];
    for (const table of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
      const present = new Set(columns.map((column) => String(column.name ?? '')));
      for (const column of ['recipient_session_instance_id', 'recipient_runtime_epoch']) {
        if (present.has(column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
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

  private ensureMeta(
    sessionName: string,
    now = Date.now(),
    recipient?: QueueRecipientIdentity | null,
  ): { queueEpoch: string; queueAuthorityId: string; pendingMessageVersion: number; nextOrdinal: number } {
    const session = normalizeSessionName(sessionName);
    const bound = normalizeQueueRecipient(recipient);
    const existing = this.db.prepare(`
      SELECT queue_epoch AS queueEpoch, queue_authority_id AS queueAuthorityId,
        pending_message_version AS pendingMessageVersion, next_ordinal AS nextOrdinal,
        recipient_session_instance_id AS recipientSessionInstanceId,
        recipient_runtime_epoch AS recipientRuntimeEpoch
      FROM queue_meta WHERE session_name = ?
    `).get(session) as {
      queueEpoch: string; queueAuthorityId: string; pendingMessageVersion: number; nextOrdinal: number;
      recipientSessionInstanceId?: string | null; recipientRuntimeEpoch?: string | null;
    } | undefined;
    if (existing) {
      // Adopt an identity only for a row that has none (a legacy row, or one
      // minted before the recipient was known). An existing DIFFERENT identity is
      // never overwritten here -- that is a new instance taking the name, and
      // `queueBelongsTo` refuses it.
      if (bound && !existing.recipientSessionInstanceId && !existing.recipientRuntimeEpoch) {
        this.db.prepare(`
          UPDATE queue_meta SET recipient_session_instance_id = ?, recipient_runtime_epoch = ?, updated_at = ?
          WHERE session_name = ?
        `).run(bound.sessionInstanceId, bound.runtimeEpoch, now, session);
      }
      return existing;
    }
    const meta = {
      queueEpoch: randomUUID(),
      queueAuthorityId: randomUUID(),
      pendingMessageVersion: 0,
      nextOrdinal: 0,
    };
    this.db.prepare(`
      INSERT INTO queue_meta (
        session_name, queue_epoch, queue_authority_id, pending_message_version, next_ordinal, updated_at,
        recipient_session_instance_id, recipient_runtime_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session, meta.queueEpoch, meta.queueAuthorityId, meta.pendingMessageVersion, meta.nextOrdinal, now,
      bound?.sessionInstanceId ?? null, bound?.runtimeEpoch ?? null,
    );
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
      const recipient = normalizeQueueRecipient(input.recipient);
      const meta = this.ensureMeta(sessionName, now, recipient);
      if (evictClientMessageId) {
        this.db.prepare('DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ?').run(sessionName, evictClientMessageId);
        this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, evictClientMessageId);
      }
      const ordinal = meta.nextOrdinal;
      this.db.prepare('UPDATE queue_meta SET next_ordinal = next_ordinal + 1, updated_at = ? WHERE session_name = ?').run(now, sessionName);
      this.db.prepare(`
        INSERT INTO queue_entries (
          session_name, client_message_id, command_id, text, status, placement, ordinal,
          created_at, updated_at, activity_generation, replaces_client_message_id, private_material_ref,
          recipient_session_instance_id, recipient_runtime_epoch
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        recipient?.sessionInstanceId ?? null,
        recipient?.runtimeEpoch ?? null,
      );
      if (input.privateMaterialJson !== undefined) {
        this.db.prepare(`
          INSERT OR REPLACE INTO queue_private_material (
            session_name, client_message_id, material_json, updated_at,
            recipient_session_instance_id, recipient_runtime_epoch
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          sessionName, clientMessageId, input.privateMaterialJson, now,
          recipient?.sessionInstanceId ?? null, recipient?.runtimeEpoch ?? null,
        );
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

  edit(
    sessionNameInput: string,
    clientMessageIdInput: string,
    text: string,
    now = Date.now(),
    /**
     * Freshly computed dispatch material for the NEW text. Absent ⇒ the edit
     * references no alias and the entry is delivered verbatim.
     */
    replacement?: { providerText?: string; aliasAudit?: unknown },
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`
        UPDATE queue_entries SET text = ?, updated_at = ? WHERE session_name = ? AND client_message_id = ?
      `).run(text, now, sessionName, clientMessageId);
      // RV-B (clear-on-edit): an edit is fresh verbatim user text with no
      // attached alias resolution — the runtime drops the in-memory
      // `providerText`/`messagePreamble`. Rewrite the persisted private material
      // to the new text and STRIP the now-stale expanded alias value + preamble,
      // so a restart before re-delivery cannot rehydrate the old secret (and
      // cannot deliver the old expansion with the new text).
      this.rewritePrivateMaterialTextStrippingSecrets(sessionName, clientMessageId, text, now, replacement);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'edit', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * RV-B helper: when a queued entry's text is edited, its private dispatch
   * material must forget the previous alias expansion. Load the existing
   * material row (if any), replace its `text`, and delete the secret
   * `providerText`/`messagePreamble` keys, then persist it back. No-op when no
   * material row exists. Must run inside the caller's transaction.
   */
  private rewritePrivateMaterialTextStrippingSecrets(
    sessionName: string,
    clientMessageId: string,
    text: string,
    now: number,
    replacement?: { providerText?: string; aliasAudit?: unknown },
  ): void {
    const row = this.db.prepare(`
      SELECT material_json AS materialJson
      FROM queue_private_material
      WHERE session_name = ? AND client_message_id = ?
    `).get(sessionName, clientMessageId) as { materialJson?: string } | undefined;
    const existingJson = readString(row?.materialJson);
    if (!existingJson) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(existingJson) as Record<string, unknown>;
    } catch {
      // Corrupt material for an edited entry is safest dropped: the projection
      // `text` is lossless, so rehydrate falls back to it (never a stale secret).
      this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?').run(sessionName, clientMessageId);
      return;
    }
    // Always drop the previous expansion first: it belongs to the old text, and
    // a restart before re-delivery must never rehydrate that secret. Anything
    // written back below was computed from the NEW text.
    delete parsed.providerText;
    delete parsed.messagePreamble;
    delete parsed.aliasAudit;
    parsed.text = text;
    if (replacement?.providerText != null) parsed.providerText = replacement.providerText;
    if (replacement?.aliasAudit) parsed.aliasAudit = replacement.aliasAudit;
    this.db.prepare(`
      INSERT OR REPLACE INTO queue_private_material (session_name, client_message_id, material_json, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(sessionName, clientMessageId, JSON.stringify(parsed), now);
  }

  markHandoffInFlight(
    sessionNameInput: string,
    clientMessageIds: string[],
    leaseMs = 60_000,
    now = Date.now(),
    recipient?: QueueRecipientIdentity | null,
  ): HandoffTransportQueueEntry[] {
    const sessionName = normalizeSessionName(sessionNameInput);
    if (clientMessageIds.length === 0) return [];
    const caller = normalizeQueueRecipient(recipient);
    // A caller that proves an identity leases ONLY rows addressed to it; a caller
    // that proves none leases only rows that carry none (legacy). Identity-bound
    // work is therefore never handed to an unproven caller, and legacy rows are
    // never handed to a new instance. Unleased ids make the drain abort, because
    // the caller compares leased.length against what it requested. The row filter
    // in the UPDATE below is the single enforcement point; a meta-level pre-check
    // here would be fully masked by it, i.e. redundant rather than defence.
    const handoffId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now, caller);
      const update = this.db.prepare(`
        UPDATE queue_entries
        SET status = 'handoff_inflight', handoff_id = ?, handoff_started_at = ?, handoff_expires_at = ?,
          handoff_attempt = COALESCE(handoff_attempt, 0) + 1, updated_at = ?
        WHERE session_name = ? AND client_message_id = ? AND status = 'queued'
          AND ${this.recipientPredicate(caller).sql}
      `);
      const gate = this.recipientPredicate(caller).params;
      let changed = 0;
      for (const id of clientMessageIds) {
        changed += Number(update.run(
          handoffId, now, now + leaseMs, now, sessionName, id, ...gate,
        ).changes ?? 0);
      }
      if (changed > 0) this.bumpVersion(sessionName, now);
      const rows = this.readRows(sessionName).filter((entry) => (
        clientMessageIds.includes(entry.clientMessageId)
        && entry.status === 'handoff_inflight'
        && entry.handoffId === handoffId
      ));
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

  /**
   * Return one failed active-turn append reservation to the ordinary queue.
   * The handoff id is mandatory: a late failure from an older request must not
   * release entries already claimed by a newer delivery attempt.
   */
  releaseHandoff(
    sessionNameInput: string,
    handoffIdInput: string,
    clientMessageIds: string[],
    now = Date.now(),
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const handoffId = requireNonEmpty(handoffIdInput.trim(), 'handoffId');
    const ids = [...new Set(clientMessageIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return this.readSnapshot(sessionName, 'release_handoff_noop');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      const update = this.db.prepare(`
        UPDATE queue_entries
        SET status = 'queued', handoff_id = NULL, handoff_started_at = NULL,
          handoff_expires_at = NULL, updated_at = ?
        WHERE session_name = ? AND client_message_id = ?
          AND status = 'handoff_inflight' AND handoff_id = ?
      `);
      let changed = 0;
      for (const id of ids) {
        changed += Number(update.run(now, sessionName, id, handoffId).changes ?? 0);
      }
      const version = changed > 0 ? this.bumpVersion(sessionName, now) : undefined;
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'release_handoff', version);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  readPrivateDispatchMaterial(
    sessionNameInput: string,
    clientMessageIdInput: string,
    recipient?: QueueRecipientIdentity | null,
  ): string | undefined {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    const gate = this.recipientPredicate(normalizeQueueRecipient(recipient));
    const row = this.db.prepare(`
      SELECT material_json AS materialJson
      FROM queue_private_material
      WHERE session_name = ? AND client_message_id = ? AND ${gate.sql}
    `).get(sessionName, clientMessageId, ...gate.params) as { materialJson?: string } | undefined;
    return readString(row?.materialJson);
  }

  /**
   * Remove only persisted peer-audit queue rows after daemon restart. Their
   * capability/controller authority is memory-only, so replay would be both
   * unauthenticated and surprising. Ordinary queue rows are left byte-for-byte.
   */
  scrubPeerAuditOrphans(sessionNameInput: string, now = Date.now()): string[] {
    const sessionName = normalizeSessionName(sessionNameInput);
    const rows = this.db.prepare(`
      SELECT client_message_id AS clientMessageId, material_json AS materialJson
      FROM queue_private_material
      WHERE session_name = ?
    `).all(sessionName) as Array<{ clientMessageId: string; materialJson: string }>;
    const orphanIds = rows.flatMap((row) => {
      try {
        const material = JSON.parse(row.materialJson) as { peerAudit?: unknown };
        const marker = material.peerAudit;
        if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return [];
        const value = marker as Record<string, unknown>;
        return typeof value.contractVersion === 'string' && typeof value.attemptHash === 'string'
          ? [row.clientMessageId]
          : [];
      } catch {
        return [];
      }
    });
    if (orphanIds.length === 0) return [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      const removeEntry = this.db.prepare('DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ?');
      const removeMaterial = this.db.prepare('DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ?');
      for (const clientMessageId of orphanIds) {
        removeEntry.run(sessionName, clientMessageId);
        removeMaterial.run(sessionName, clientMessageId);
      }
      this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return orphanIds;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  finalizeSent(sessionNameInput: string, clientMessageIdInput: string, deliveryFrameId: string = randomUUID(), now = Date.now()): QueueSnapshot {
    return this.finalizeSentBatch(sessionNameInput, [clientMessageIdInput], deliveryFrameId, now).snapshot;
  }

  finalizeSentBatch(
    sessionNameInput: string,
    clientMessageIdInputs: string[],
    deliveryFrameId: string = randomUUID(),
    now = Date.now(),
    recipient?: QueueRecipientIdentity | null,
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
      // Only the runtime a row is addressed to may record it delivered; a wrong
      // runtime must not tombstone or destroy another instance's work.
      const gate = this.recipientPredicate(normalizeQueueRecipient(recipient));
      const deleteEntry = this.db.prepare(
        `DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ? AND ${gate.sql}`,
      );
      const deletePrivateMaterial = this.db.prepare(
        `DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ? AND ${gate.sql}`,
      );
      const finalized: string[] = [];
      const insertTombstone = this.db.prepare(`
        INSERT OR REPLACE INTO queue_delivery_tombstones (
          session_name, queue_epoch, client_message_id, delivery_frame_id, created_at,
          recipient_session_instance_id, recipient_runtime_epoch
        ) VALUES (?, ?, ?, ?, ?, (
          SELECT recipient_session_instance_id FROM queue_meta WHERE session_name = ?
        ), (
          SELECT recipient_runtime_epoch FROM queue_meta WHERE session_name = ?
        ))
      `);
      for (const clientMessageId of clientMessageIds) {
        // Delete first: its row count is the authorization answer. A tombstone is
        // only written for a row this caller was actually entitled to finalize.
        const removed = Number(deleteEntry.run(sessionName, clientMessageId, ...gate.params).changes ?? 0);
        if (removed === 0) continue;
        deletePrivateMaterial.run(sessionName, clientMessageId, ...gate.params);
        insertTombstone.run(sessionName, meta.queueEpoch, clientMessageId, deliveryFrameId, now, sessionName, sessionName);
        finalized.push(clientMessageId);
      }
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      const deliveryFacts = finalized.map((clientMessageId): QueueDeliveryFact => ({
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

  /**
   * Was this id already delivered IN THE CURRENT EPOCH?
   *
   * queue_epoch is part of the tombstone primary key but was omitted from this
   * lookup, so a tombstone from a previous epoch suppressed a legitimately
   * re-queued message after a reset. The epoch defaults to the session's current
   * one, which is what every caller means.
   */
  hasDeliveryTombstone(sessionNameInput: string, clientMessageIdInput: string, queueEpochInput?: string): boolean {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    const queueEpoch = queueEpochInput?.trim() || (this.db.prepare(
      'SELECT queue_epoch AS queueEpoch FROM queue_meta WHERE session_name = ?',
    ).get(sessionName) as { queueEpoch?: string } | undefined)?.queueEpoch;
    if (!queueEpoch) return false;
    const row = this.db.prepare(`
      SELECT 1 FROM queue_delivery_tombstones
      WHERE session_name = ? AND client_message_id = ? AND queue_epoch = ?
      LIMIT 1
    `).get(sessionName, clientMessageId, queueEpoch);
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

  /**
   * Is this entry inside a LIVE handoff lease right now?
   *
   * The UI projection deliberately does not carry lease internals, but deleting
   * an entry that is genuinely mid-delivery is a different failure from deleting
   * a stale one: the provider may already hold the text. The authority answers
   * this, so callers can distinguish "reclaimable" from "too late" instead of
   * guessing from a status string.
   */
  hasLiveHandoff(sessionNameInput: string, clientMessageIdInput: string, now = Date.now()): boolean {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = clientMessageIdInput.trim();
    if (!clientMessageId) return false;
    const row = this.db.prepare(`
      SELECT handoff_expires_at AS expiresAt FROM queue_entries
      WHERE session_name = ? AND client_message_id = ? AND status = 'handoff_inflight'
    `).get(sessionName, clientMessageId) as { expiresAt?: number | null } | undefined;
    const expiresAt = typeof row?.expiresAt === 'number' ? row.expiresAt : undefined;
    return expiresAt !== undefined && expiresAt > now;
  }

  drop(
    sessionNameInput: string,
    clientMessageIdInput: string,
    dropReason: QueueDropReason,
    now = Date.now(),
    recipient?: QueueRecipientIdentity | null,
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    const clientMessageId = requireNonEmpty(clientMessageIdInput.trim(), 'clientMessageId');
    const gate = this.recipientPredicate(normalizeQueueRecipient(recipient));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      this.db.prepare(`DELETE FROM queue_entries WHERE session_name = ? AND client_message_id = ? AND ${gate.sql}`)
        .run(sessionName, clientMessageId, ...gate.params);
      this.db.prepare(`DELETE FROM queue_private_material WHERE session_name = ? AND client_message_id = ? AND ${gate.sql}`)
        .run(sessionName, clientMessageId, ...gate.params);
      const version = this.bumpVersion(sessionName, now);
      this.db.exec('COMMIT');
      return this.readSnapshot(sessionName, 'drop', { ...version, dropReason });
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * May this runtime drain the queue held under that session name?
   *
   * Fail-closed in every ambiguous direction: an unusable caller identity, a
   * queue bound to a DIFFERENT instance/epoch, and a legacy row carrying no
   * identity at all are all refused. A name with no queue at all is allowed --
   * there is nothing to mis-deliver.
   */
  queueBelongsTo(sessionNameInput: string, recipient?: QueueRecipientIdentity | null): boolean {
    const sessionName = normalizeSessionName(sessionNameInput);
    const caller = normalizeQueueRecipient(recipient);
    if (!caller) return false;
    const meta = this.db.prepare(`
      SELECT recipient_session_instance_id AS sessionInstanceId, recipient_runtime_epoch AS runtimeEpoch
      FROM queue_meta WHERE session_name = ?
    `).get(sessionName) as { sessionInstanceId?: string | null; runtimeEpoch?: string | null } | undefined;
    if (!meta) return true;
    const bound = normalizeQueueRecipient({
      sessionInstanceId: meta.sessionInstanceId ?? '',
      runtimeEpoch: meta.runtimeEpoch ?? '',
    });
    if (!bound) return false;
    return bound.sessionInstanceId === caller.sessionInstanceId && bound.runtimeEpoch === caller.runtimeEpoch;
  }

  /**
   * THE row-level recipient predicate, defined once and reused by every
   * recipient-sensitive read/write.
   *
   * A caller proving an identity matches ONLY rows addressed to it; a caller
   * proving none matches ONLY rows that carry none (legacy). Every other
   * combination fails closed, so a same-named successor can neither drain, drop,
   * finalize, nor read the private material of a previous instance's work.
   */
  private recipientPredicate(caller: QueueRecipientIdentity | null): { sql: string; params: (string | null)[] } {
    return {
      sql: '((? IS NULL AND recipient_session_instance_id IS NULL)'
        + ' OR (recipient_session_instance_id = ? AND recipient_runtime_epoch = ?))',
      params: [
        caller?.sessionInstanceId ?? null,
        caller?.sessionInstanceId ?? null,
        caller?.runtimeEpoch ?? null,
      ],
    };
  }

  /** Every session name carrying durable queue state, memory mirror or not. */
  listSessionNames(): string[] {
    const rows = this.db.prepare(
      'SELECT session_name AS sessionName FROM queue_meta UNION SELECT session_name AS sessionName FROM queue_entries',
    ).all() as { sessionName?: unknown }[];
    return rows.map((row) => String(row.sessionName ?? '')).filter((name) => name.length > 0);
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

  restoreExpiredHandoffs(
    sessionNameInput: string,
    now = Date.now(),
    options: { includeUnexpired?: boolean } = {},
  ): QueueSnapshot {
    const sessionName = normalizeSessionName(sessionNameInput);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.ensureMeta(sessionName, now);
      const restored = this.db.prepare(`
        UPDATE queue_entries
        SET status = 'queued', handoff_id = NULL, handoff_started_at = NULL, handoff_expires_at = NULL, updated_at = ?
        WHERE session_name = ? AND status = 'handoff_inflight'
          AND (? = 1 OR (handoff_expires_at IS NOT NULL AND handoff_expires_at <= ?))
      `).run(now, sessionName, options.includeUnexpired ? 1 : 0, now);
      const version = Number(restored.changes ?? 0) > 0
        ? this.bumpVersion(sessionName, now)
        : undefined;
      this.db.exec('COMMIT');
      return this.readSnapshot(
        sessionName,
        options.includeUnexpired ? 'restore_restart_handoffs' : 'restore_expired_handoffs',
        version,
      );
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
