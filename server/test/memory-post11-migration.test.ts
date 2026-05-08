import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('post-1.1 memory migration coverage', () => {
  const migration = readFileSync(new URL('../src/db/migrations/044_memory_scope_search_citations_org.sql', import.meta.url), 'utf8').toLowerCase();
  const hardeningMigration = readFileSync(new URL('../src/db/migrations/045_memory_post11_hardening.sql', import.meta.url), 'utf8').toLowerCase();

  it('adds nullable fingerprint/origin parity columns for backfillable shared storage', () => {
    expect(migration).toContain('add column if not exists summary_fingerprint text');
    expect(migration).toContain('add column if not exists origin text');
    expect(migration).toContain('idx_shared_context_projections_fingerprint');
    expect(migration).toContain('shared_context_projections_origin_check');
  });

  it('creates server namespace/observation/audit tables matching daemon post-foundations schema', () => {
    expect(migration).toContain('create table if not exists memory_context_namespaces');
    expect(migration).toContain('create table if not exists memory_context_observations');
    expect(migration).toContain('create table if not exists memory_observation_promotion_audit');
    expect(migration).toContain('uq_memory_context_observations_idempotency');
    expect(migration).toContain("action in ('web_ui_promote', 'cli_mem_promote', 'admin_api_promote')");
  });

  it('hardens post-1.1 owner-private contracts and persistent citation drift markers', () => {
    expect(hardeningMigration).toContain('delete from shared_context_records where scope =');
    expect(hardeningMigration).toContain('delete from shared_context_projections where scope =');
    expect(hardeningMigration).toContain('update shared_context_projections');
    expect(hardeningMigration).toContain('content_hash');
    expect(hardeningMigration).toContain('owner_private_memories_kind_check');
    expect(hardeningMigration).toContain('owner_private_memories_origin_check');
    expect(hardeningMigration).toContain('owner_private_memories_size_check');
    expect(hardeningMigration).toContain('shared_context_records_scope_no_user_private');
    expect(hardeningMigration).toContain('shared_context_projections_personal_identity_check');
  });
});
