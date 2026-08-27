/**
 * Versioned SQLite migrations for the supervision registry.
 *
 * Before this module the store used bare `CREATE TABLE IF NOT EXISTS` with no
 * `user_version`, which meant an existing database silently kept an old shape
 * forever -- new columns were never added and nothing detected the drift. Every
 * schema change now goes through an ordered, transactional migration.
 *
 * Two properties:
 *  1. Recovery is deterministic from durable records. Projection version, outbox
 *     delivery state and integration ownership all live in SQLite, so a restart
 *     reconstructs them without chat context or model recollection.
 *  2. Status is enforced at the DB boundary. A normalized status-code table plus
 *     INSERT/UPDATE triggers make an invalid status a write error, not a value
 *     that quietly lands and is discovered later in the UI.
 */
import { SUPERVISION_TASK_LIFECYCLE_STATUSES } from '../../shared/supervision-config.js';

/** Bump with every migration appended below. */
export const SUPERVISION_SCHEMA_VERSION = 3;

/** Minimal surface we need; avoids importing node:sqlite types at the boundary. */
export interface SupervisionMigrationDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export interface SupervisionMigration {
  version: number;
  description: string;
  up(db: SupervisionMigrationDb): void;
}

function tableColumns(db: SupervisionMigrationDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row?.name ?? '')));
}

function tableExists(db: SupervisionMigrationDb, table: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { name?: string } | undefined;
  return !!row?.name;
}

/** ALTER TABLE ADD COLUMN is not idempotent; make it so. */
function addColumnIfMissing(db: SupervisionMigrationDb, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

/**
 * Guard a status column at the DB boundary.
 *
 * SQLite cannot add a CHECK constraint to an existing table without rebuilding
 * it, so the equivalent guarantee comes from a normalized code table plus
 * triggers. An unknown status aborts the write.
 */
function createStatusGuard(db: SupervisionMigrationDb, table: string, column: string): void {
  if (!tableExists(db, table)) return;
  for (const event of ['INSERT', 'UPDATE'] as const) {
    const name = `${table}_${column}_guard_${event.toLowerCase()}`;
    db.exec(`
      DROP TRIGGER IF EXISTS ${name};
      CREATE TRIGGER ${name}
      BEFORE ${event} ON ${table}
      FOR EACH ROW
      WHEN NEW.${column} IS NOT NULL
        AND NEW.${column} NOT IN (SELECT status_id FROM supervision_status_codes)
      BEGIN
        SELECT RAISE(ABORT, 'invalid supervision lifecycle status');
      END;
    `);
  }
}

const MIGRATION_1: SupervisionMigration = {
  version: 1,
  description: 'status code table + guards, console projection state, durable outbox, integration queue, attestations, recovery fields',
  up(db) {
    // 1. Normalized status codes, seeded from the ONE authoritative enum.
    db.exec(`
      CREATE TABLE IF NOT EXISTS supervision_status_codes (
        status_id TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL
      );
    `);
    const insertStatus = db.prepare(
      'INSERT OR IGNORE INTO supervision_status_codes(status_id, contract_version) VALUES (?, ?)',
    );
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) insertStatus.run(status, 1);
    // Drop any code that is no longer part of the contract (e.g. an event type
    // that leaked in before status and event vocabularies were separated).
    const valid = SUPERVISION_TASK_LIFECYCLE_STATUSES.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM supervision_status_codes WHERE status_id NOT IN (${valid})`,
    ).run(...SUPERVISION_TASK_LIFECYCLE_STATUSES);

    // 2. Recovery + ownership + scope fields on existing rows.
    addColumnIfMissing(db, 'supervision_tasks', 'project_name', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'integration_owner', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'next_action', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'blocked_reason', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'recovery_state', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'recovery_reason', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'last_durable_event_id', 'INTEGER');
    addColumnIfMissing(db, 'supervision_tasks', 'semantic_key', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'next_action', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'recovery_state', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'recovery_reason', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'last_durable_event_id', 'INTEGER');
    addColumnIfMissing(db, 'supervision_task_assignments', 'semantic_key', 'TEXT');

    // 3. Console projection cursor. projectionVersion is dense per scope and is
    //    restored from here on restart; the epoch changes only if this row is
    //    rebuilt, which is what tells a browser its cursor is incomparable.
    db.exec(`
      CREATE TABLE IF NOT EXISTS supervision_projection_state (
        project_name TEXT NOT NULL,
        coordinator_session_name TEXT NOT NULL,
        projection_version INTEGER NOT NULL DEFAULT 0,
        projection_epoch TEXT NOT NULL,
        last_durable_event_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_name, coordinator_session_name)
      );
    `);

    // 4. Durable outbox. Committed in the SAME transaction as the event and the
    //    projection, so a crash between commit and broadcast still leaves the
    //    frame pending rather than losing it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS supervision_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_name TEXT NOT NULL,
        coordinator_session_name TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        projection_version INTEGER NOT NULL,
        projection_epoch TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        delivery_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (delivery_state IN ('pending','sent','acked','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_outbox_pending_idx
        ON supervision_outbox(project_name, coordinator_session_name, delivery_state, id);
      CREATE UNIQUE INDEX IF NOT EXISTS supervision_outbox_scope_version_idx
        ON supervision_outbox(project_name, coordinator_session_name, projection_epoch, projection_version);
    `);

    // 5. Integration queue: a PASS must land here with an owner, or carry an
    //    explicit blocked reason. Reconstructed verbatim on restart.
    db.exec(`
      CREATE TABLE IF NOT EXISTS supervision_integration_queue (
        task_id TEXT PRIMARY KEY,
        parent_task_id TEXT,
        integration_owner TEXT,
        attempt_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        next_action TEXT,
        blocked_reason TEXT,
        queued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (integration_owner IS NOT NULL OR blocked_reason IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS supervision_integration_queue_owner_idx
        ON supervision_integration_queue(integration_owner, queued_at);
    `);

    // 6. Audit attestations: append-only, one row per applied receipt. The
    //    UNIQUE attempt_id is what makes replayed receipts idempotent at the
    //    storage layer rather than only in application code.
    db.exec(`
      CREATE TABLE IF NOT EXISTS supervision_audit_attestations (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('PASS','REWORK')),
        auditor_session_name TEXT NOT NULL,
        findings TEXT,
        event_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_audit_attestations_task_idx
        ON supervision_audit_attestations(task_id, created_at);
    `);

    // 7. Fail-closed status enforcement at the DB boundary.
    createStatusGuard(db, 'supervision_tasks', 'status');
    createStatusGuard(db, 'supervision_task_assignments', 'status');
  },
};

/**
 * Pool binding + validation outcome.
 *
 * `pool_kind` was previously only derivable by guessing from provider_family,
 * which is exactly the kind of inference the console must not do; the console
 * shows which pool an assignment actually occupies, so it has to be recorded.
 */
const MIGRATION_2: SupervisionMigration = {
  version: 2,
  description: 'assignment pool binding and durable validation outcome',
  up(db) {
    addColumnIfMissing(db, 'supervision_task_assignments', 'pool_kind', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'validation_state', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'observed_model', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'observed_provider', 'TEXT');
    addColumnIfMissing(db, 'supervision_task_assignments', 'heartbeat_at', 'INTEGER');
    addColumnIfMissing(db, 'supervision_tasks', 'validation_state', 'TEXT');
    addColumnIfMissing(db, 'supervision_tasks', 'heartbeat_at', 'INTEGER');
    // Same rationale as the status guard: an unknown pool kind must be a write
    // error, not a value the console has to defend against later.
    db.exec(`
      DROP TRIGGER IF EXISTS supervision_assignments_pool_kind_guard;
      CREATE TRIGGER supervision_assignments_pool_kind_guard
      BEFORE UPDATE ON supervision_task_assignments
      FOR EACH ROW WHEN NEW.pool_kind IS NOT NULL AND NEW.pool_kind NOT IN ('primary','economy')
      BEGIN SELECT RAISE(ABORT, 'invalid supervision pool kind'); END;
    `);
  },
};

const MIGRATION_3: SupervisionMigration = {
  version: 3,
  description: 'authoritative project scope for supervision task projections',
  up(db) {
    addColumnIfMissing(db, 'supervision_tasks', 'project_name', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS supervision_tasks_project_idx
        ON supervision_tasks(project_name, updated_at);
      DROP TRIGGER IF EXISTS supervision_tasks_project_guard_insert;
      CREATE TRIGGER supervision_tasks_project_guard_insert
      BEFORE INSERT ON supervision_tasks
      FOR EACH ROW WHEN NEW.project_name IS NULL OR trim(NEW.project_name) = ''
      BEGIN SELECT RAISE(ABORT, 'supervision task project scope is required'); END;
      DROP TRIGGER IF EXISTS supervision_tasks_project_guard_update;
      CREATE TRIGGER supervision_tasks_project_guard_update
      BEFORE UPDATE ON supervision_tasks
      FOR EACH ROW WHEN NEW.project_name IS NULL OR trim(NEW.project_name) = ''
      BEGIN SELECT RAISE(ABORT, 'supervision task project scope is required'); END;
    `);
  },
};

export const SUPERVISION_MIGRATIONS: readonly SupervisionMigration[] = Object.freeze([MIGRATION_1, MIGRATION_2, MIGRATION_3]);

export function readSupervisionSchemaVersion(db: SupervisionMigrationDb): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const value = Number(row?.user_version ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface SupervisionMigrationResult {
  from: number;
  to: number;
  applied: number[];
}

/**
 * Apply every pending migration in order, each in its own transaction.
 *
 * A failing migration rolls back and rethrows with its version, leaving
 * user_version untouched -- a half-migrated database would be far worse than a
 * daemon that refuses to start.
 */
export function migrateSupervisionStore(db: SupervisionMigrationDb): SupervisionMigrationResult {
  const from = readSupervisionSchemaVersion(db);
  const applied: number[] = [];
  for (const migration of SUPERVISION_MIGRATIONS) {
    if (migration.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      // PRAGMA does not accept a bound parameter; the value is a checked integer.
      db.exec(`PRAGMA user_version = ${Math.floor(migration.version)}`);
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `supervision migration ${migration.version} (${migration.description}) failed: ${String(error)}`,
      );
    }
  }
  return { from, to: readSupervisionSchemaVersion(db), applied };
}
