import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  currentDir,
  '../src/db/migrations/073_remote_desktop_guest_authority.sql',
);
const reuseMigrationPath = join(
  currentDir,
  '../src/db/migrations/083_remote_desktop_link_reuse_policy.sql',
);

describe('remote desktop guest authority migration', () => {
  it('persists hash-only authority and upgrades to per-policy browser/session binding', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const reuseSql = await readFile(reuseMigrationPath, 'utf8');
    expect(sql).toContain('token_hash               TEXT NOT NULL UNIQUE');
    expect(sql).not.toMatch(/\btoken\s+TEXT/i);
    expect(sql).toContain('remote_desktop_guest_browser_claims');
    expect(reuseSql).toContain("use_policy IN ('single_use', 'reusable')");
    expect(reuseSql).toContain('PRIMARY KEY (link_id, browser_key_hash)');
    expect(reuseSql).toContain('idx_rd_guest_sessions_one_live_link_browser');
    expect(sql).toContain("actor_kind IN ('attended_link', 'unattended_link', 'node_password')");
  });

  it('separates authority generation from expiry revision and schedules by database records', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('authority_generation');
    expect(sql).toContain('expiry_revision');
    expect(sql).toContain('commit_revision');
    expect(sql).toContain('remote_desktop_guest_expiry_due');
    expect(sql).toContain('PRIMARY KEY (link_id, expiry_revision)');
    expect(sql).toContain("effect_type IN ('terminal', 'downgrade', 'deadline_update')");
    expect(sql).toContain('target_server_id         TEXT');
    expect(sql).toContain('target_route_generation  BIGINT CHECK');
    expect(sql).toContain('(target_server_id IS NULL) = (target_route_generation IS NULL)');
    expect(sql).toContain('slo_anchor_at            BIGINT NOT NULL');
  });

  it('makes privacy admission fail closed outside the idle phase', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('remote_desktop_management_privacy');
    expect(sql).toContain("phase <> 'idle' AND admission_open = FALSE AND epoch_id IS NOT NULL");
    expect(sql).toContain('route_snapshot');
    expect(sql).toContain('acknowledged_routes');
    expect(sql).toContain('fresh_frame_generation');
  });

  it('stores only password verifier material and bounded audit references', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('remote_desktop_unattended_passwords');
    expect(sql).toContain('verifier_version');
    expect(sql).toContain('pepper_version');
    expect(sql).not.toMatch(/password\s+TEXT/i);
    expect(sql).toContain('actor_reference_hash');
  });
});
