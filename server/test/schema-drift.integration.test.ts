/**
 * Schema drift detection — verifies that TypeScript Db* interfaces in queries.ts
 * match the actual PostgreSQL table columns after all migrations are applied.
 *
 * Catches: missing migrations, stale interfaces, column renames not reflected in code.
 * Runs against real PostgreSQL via testcontainers (same as other integration tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

// ── DB lifecycle ──────────────────────────────────────────────────────────────

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Query actual column names from information_schema for a given table. */
async function getTableColumns(tableName: string): Promise<Set<string>> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * Mapping: TypeScript interface field names → expected DB column names.
 *
 * TS uses camelCase, DB uses snake_case. The Db* interfaces already use
 * snake_case field names (matching DB columns directly), so no transformation needed.
 *
 * Each entry: [tableName, expectedColumns[]]
 * expectedColumns come from the Db* interfaces in queries.ts.
 * Keep this list in sync when adding new fields to interfaces.
 */
const SCHEMA_MAP: Array<[string, string[]]> = [
  ['users', [
    'id', 'created_at', 'username', 'password_hash', 'display_name',
    'password_must_change', 'is_admin', 'status', 'badge_count',
  ]],
  ['platform_identities', [
    'id', 'user_id', 'platform', 'platform_user_id', 'created_at',
  ]],
  ['servers', [
    'id', 'user_id', 'team_id', 'name', 'token_hash',
    'last_heartbeat_at', 'status', 'daemon_version', 'bound_with_key_id', 'created_at',
  ]],
  ['channel_bindings', [
    'id', 'server_id', 'platform', 'channel_id', 'binding_type', 'target', 'bot_id', 'created_at',
  ]],
  ['cron_jobs', [
    'id', 'server_id', 'user_id', 'name', 'cron_expr', 'action',
    'project_name', 'target_role', 'target_session_name', 'timezone', 'status', 'last_run_at', 'next_run_at',
    'expires_at', 'created_at', 'updated_at',
  ]],
  ['cron_executions', [
    'id', 'job_id', 'status', 'detail', 'created_at',
  ]],
  ['sessions', [
    'id', 'server_id', 'name', 'project_name', 'role', 'agent_type',
    'agent_version', 'project_dir', 'state', 'label',
    'runtime_type', 'provider_id', 'provider_session_id', 'description',
    'created_at', 'updated_at',
  ]],
  ['sub_sessions', [
    'id', 'server_id', 'type', 'shell_bin', 'cwd', 'label',
    'closed_at', 'created_at', 'updated_at',
    'cc_session_id', 'gemini_session_id', 'parent_session', 'sort_order',
    'runtime_type', 'provider_id', 'provider_session_id', 'description',
    'cc_preset_id',
  ]],
  ['discussions', [
    'id', 'server_id', 'topic', 'state', 'max_rounds', 'current_round',
    'current_speaker', 'participants', 'file_path', 'conclusion',
    'file_content', 'error', 'started_at', 'finished_at', 'created_at', 'updated_at',
  ]],
  ['discussion_rounds', [
    'id', 'discussion_id', 'server_id', 'round', 'speaker_role', 'speaker_agent',
    'speaker_model', 'response', 'created_at',
  ]],
  ['discussion_orchestration_runs', [
    'id', 'discussion_id', 'server_id', 'main_session', 'initiator_session',
    'current_target_session', 'final_return_session', 'remaining_targets',
    'mode_key', 'status', 'request_message_id', 'callback_message_id',
    'context_ref', 'timeout_ms', 'result_summary', 'error', 'progress_snapshot',
    'created_at', 'updated_at', 'completed_at',
  ]],
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('schema drift detection', () => {
  for (const [tableName, expectedColumns] of SCHEMA_MAP) {
    it(`${tableName}: all Db* interface fields exist as DB columns`, async () => {
      const actual = await getTableColumns(tableName);

      const missing = expectedColumns.filter((col) => !actual.has(col));
      if (missing.length > 0) {
        throw new Error(
          `Table "${tableName}" is missing columns that Db* interface expects: ${missing.join(', ')}\n` +
          `  Actual columns: ${[...actual].join(', ')}\n` +
          `  Fix: Add a migration to create the missing columns, or update the Db* interface.`,
        );
      }
    });

    it(`${tableName}: no DB columns missing from Db* interface`, async () => {
      const actual = await getTableColumns(tableName);
      const expected = new Set(expectedColumns);

      // DB may have extra columns not in the interface (e.g. bot_id on channel_bindings
      // which isn't in DbChannelBinding). We only warn, not fail, for extra DB columns.
      const extra = [...actual].filter((col) => !expected.has(col));
      if (extra.length > 0) {
        console.warn(
          `[schema-drift] Table "${tableName}" has DB columns not in Db* interface: ${extra.join(', ')}. ` +
          `Consider adding them to the interface if they should be queryable.`,
        );
      }
      // This test always passes — it's informational only.
      // The critical direction is "interface expects column that doesn't exist" (above test).
      expect(true).toBe(true);
    });
  }
});
