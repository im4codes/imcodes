import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  migrateSupervisionStore,
  readSupervisionSchemaVersion,
  SUPERVISION_SCHEMA_VERSION,
  type SupervisionMigrationDb,
} from '../../src/daemon/supervision-store-migrations.js';
import {
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
} from '../../shared/supervision-config.js';

/** The pre-migration (version 0) shape, exactly as the store created it. */
const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervision_tasks (
    task_id TEXT PRIMARY KEY,
    top_level_task_id TEXT NOT NULL,
    classification TEXT NOT NULL,
    status TEXT NOT NULL,
    current_revision TEXT,
    commit_sha TEXT,
    push_remote_ref TEXT,
    blocker TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supervision_task_assignments (
    assignment_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    session_name TEXT NOT NULL,
    session_instance_id TEXT NOT NULL,
    runtime_epoch TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    provider_family TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    audit_attempt_id TEXT,
    audit_revision TEXT,
    verdict TEXT,
    blocker TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function insertTask(db: DatabaseSync, taskId: string, status: string): void {
  db.prepare(`INSERT INTO supervision_tasks
    (task_id, top_level_task_id, classification, status, payload_json, created_at, updated_at)
    VALUES (?, ?, 'slice', ?, '{}', 1, 1)`).run(taskId, 'top', status);
}

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY_SCHEMA);
});

function migrate() { return migrateSupervisionStore(db as unknown as SupervisionMigrationDb); }
function columns(table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
}

describe('supervision store migrations', () => {
  it('migrates a legacy version-0 database deterministically', () => {
    expect(readSupervisionSchemaVersion(db as never)).toBe(0);
    const result = migrate();
    expect(result).toEqual({ from: 0, to: SUPERVISION_SCHEMA_VERSION, applied: [1, 2] });
    for (const column of ['project_name', 'integration_owner', 'next_action', 'blocked_reason',
      'recovery_state', 'recovery_reason', 'last_durable_event_id', 'semantic_key']) {
      expect(columns('supervision_tasks'), column).toContain(column);
    }
  });

  it('adds pool binding and validation columns in migration 2', () => {
    migrate();
    for (const column of ['pool_kind', 'validation_state', 'observed_model', 'observed_provider', 'heartbeat_at']) {
      expect(columns('supervision_task_assignments'), column).toContain(column);
    }
  });

  it('rejects an unknown pool kind at the DB boundary', () => {
    migrate();
    db.prepare(`INSERT INTO supervision_task_assignments
      (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
       agent_type, provider_family, lease_id, generation, payload_json, created_at, updated_at)
      VALUES ('asg1','t','implementer','implementing','s','i','e','codex','openai','l',1,'{}',1,1)`).run();
    const set = (kind: string) => db.prepare('UPDATE supervision_task_assignments SET pool_kind = ? WHERE assignment_id = ?').run(kind, 'asg1');
    expect(() => set('primary')).not.toThrow();
    expect(() => set('economy')).not.toThrow();
    expect(() => set('turbo')).toThrow(/invalid supervision pool kind/);
  });

  it('is idempotent: a second run applies nothing', () => {
    migrate();
    const second = migrate();
    expect(second).toEqual({ from: SUPERVISION_SCHEMA_VERSION, to: SUPERVISION_SCHEMA_VERSION, applied: [] });
  });

  it('preserves existing rows across migration', () => {
    insertTask(db, 'tsk_legacy', 'implementing');
    migrate();
    const row = db.prepare('SELECT task_id, status FROM supervision_tasks').get() as { task_id: string; status: string };
    expect(row).toEqual({ task_id: 'tsk_legacy', status: 'implementing' });
  });
});

describe('DB-level status enforcement', () => {
  beforeEach(() => { migrate(); });

  it('seeds exactly the authoritative lifecycle enum', () => {
    const rows = db.prepare('SELECT status_id FROM supervision_status_codes ORDER BY status_id').all() as Array<{ status_id: string }>;
    expect(rows.map((r) => r.status_id)).toEqual([...SUPERVISION_TASK_LIFECYCLE_STATUSES].sort());
  });

  it('does not admit event types as statuses', () => {
    for (const eventOnly of SUPERVISION_TASK_REGISTRY_EVENT_TYPES) {
      if ((SUPERVISION_TASK_LIFECYCLE_STATUSES as readonly string[]).includes(eventOnly)) continue;
      const hit = db.prepare('SELECT status_id FROM supervision_status_codes WHERE status_id = ?').get(eventOnly);
      expect(hit, eventOnly).toBeUndefined();
    }
  });

  it('accepts every valid status on direct insert', () => {
    for (const [index, status] of SUPERVISION_TASK_LIFECYCLE_STATUSES.entries()) {
      expect(() => insertTask(db, `tsk_${index}`, status), status).not.toThrow();
    }
  });

  it('FAILS a direct invalid-status insert at the DB boundary', () => {
    for (const bad of ['file_event', 'scope_violation', 'Implementing', ' implementing', 'in_progress', 'nonsense']) {
      expect(() => insertTask(db, `tsk_bad_${bad.trim()}`, bad), bad).toThrow(/invalid supervision lifecycle status/);
    }
  });

  it('FAILS an invalid-status UPDATE, not only INSERT', () => {
    insertTask(db, 'tsk_ok', 'implementing');
    expect(() => db.prepare('UPDATE supervision_tasks SET status = ? WHERE task_id = ?')
      .run('file_event', 'tsk_ok')).toThrow(/invalid supervision lifecycle status/);
    const row = db.prepare('SELECT status FROM supervision_tasks WHERE task_id = ?').get('tsk_ok') as { status: string };
    expect(row.status).toBe('implementing');
  });

  it('guards assignments too', () => {
    expect(() => db.prepare(`INSERT INTO supervision_task_assignments
      (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
       agent_type, provider_family, lease_id, generation, payload_json, created_at, updated_at)
      VALUES ('asg1','tsk1','impl','bogus','s','i','e','claude-code','anthropic','l',1,'{}',1,1)`).run())
      .toThrow(/invalid supervision lifecycle status/);
  });
});

describe('durable outbox and integration queue constraints', () => {
  beforeEach(() => { migrate(); });

  it('rejects an unknown delivery state', () => {
    const insert = (state: string) => db.prepare(`INSERT INTO supervision_outbox
      (project_name, coordinator_session_name, event_id, projection_version, projection_epoch,
       frame_json, delivery_state, created_at, updated_at)
      VALUES ('p','c',1,1,'e','{}',?,1,1)`).run(state);
    expect(() => insert('pending')).not.toThrow();
    expect(() => insert('maybe')).toThrow();
  });

  it('refuses two frames at the same scope+epoch+version', () => {
    const insert = (version: number) => db.prepare(`INSERT INTO supervision_outbox
      (project_name, coordinator_session_name, event_id, projection_version, projection_epoch,
       frame_json, created_at, updated_at)
      VALUES ('p','c',1,?,'e','{}',1,1)`).run(version);
    insert(1);
    expect(() => insert(1)).toThrow();
    expect(() => insert(2)).not.toThrow();
  });

  it('refuses a queue row with neither an owner nor a blocked reason', () => {
    const insert = (owner: string | null, reason: string | null) => db.prepare(
      `INSERT INTO supervision_integration_queue
       (task_id, attempt_id, revision, integration_owner, blocked_reason, queued_at, updated_at)
       VALUES (?, 'att', 'rev', ?, ?, 1, 1)`,
    ).run(`tsk_${owner ?? 'none'}_${reason ?? 'none'}`, owner, reason);
    expect(() => insert('deck_cd_cc2', null)).not.toThrow();
    expect(() => insert(null, 'owner on leave')).not.toThrow();
    // This is the orphaned-PASS shape the feature exists to prevent.
    expect(() => insert(null, null)).toThrow();
  });

  it('makes a replayed attestation idempotent at the storage layer', () => {
    const insert = () => db.prepare(`INSERT INTO supervision_audit_attestations
      (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, created_at)
      VALUES ('att-1','tsk','asg','rev','PASS','auditor',1)`).run();
    insert();
    expect(() => insert()).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM supervision_audit_attestations').get())
      .toEqual({ n: 1 });
  });

  it('rejects an arbitrary verdict at the DB boundary', () => {
    expect(() => db.prepare(`INSERT INTO supervision_audit_attestations
      (attempt_id, task_id, assignment_id, revision, verdict, auditor_session_name, created_at)
      VALUES ('att-2','tsk','asg','rev','LGTM','auditor',1)`).run()).toThrow();
  });
});

describe('migration failure handling', () => {
  it('leaves user_version untouched when a migration throws', () => {
    const failing = {
      exec(sql: string) {
        if (sql.startsWith('PRAGMA user_version =')) throw new Error('boom');
        return (db as unknown as SupervisionMigrationDb).exec(sql);
      },
      prepare: (sql: string) => (db as unknown as SupervisionMigrationDb).prepare(sql),
    } as SupervisionMigrationDb;
    expect(() => migrateSupervisionStore(failing)).toThrow(/supervision migration 1/);
    expect(readSupervisionSchemaVersion(db as never)).toBe(0);
  });
});
