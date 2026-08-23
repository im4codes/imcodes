import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_INSTALL_STATES } from '../../shared/capability-management.js';

describe('capability migration contract', () => {
  it('pins the operation-state CHECK to the shared vocabulary', () => {
    const sql = readFileSync(new URL('../src/db/migrations/068_capability_operations_evidence.sql', import.meta.url), 'utf8');
    const stateCheck = sql.match(/state\s+TEXT\s+NOT NULL CHECK \(state IN \(\s*([\s\S]*?)\s*\)\)/i)?.[1];
    expect(stateCheck).toBeDefined();
    const sqlStates = [...stateCheck!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(sqlStates).toEqual([...CAPABILITY_INSTALL_STATES]);
  });

  it('keeps tree identity separate from bounded transfer bytes and persists cross-pod token consumption', () => {
    const versionsSql = readFileSync(new URL('../src/db/migrations/066_capability_items_versions.sql', import.meta.url), 'utf8');
    const syncSql = readFileSync(new URL('../src/db/migrations/070_capability_sync_readiness.sql', import.meta.url), 'utf8');
    expect(versionsSql).toMatch(/artifact_digest\s+TEXT NOT NULL/);
    expect(versionsSql).toMatch(/blob_digest\s+TEXT/);
    expect(versionsSql).toMatch(/blob_byte_size\s+BIGINT/);
    expect(versionsSql).toMatch(/blob_digest IS NULL\) = \(blob_byte_size IS NULL/);
    expect(syncSql).toMatch(/content\s+BYTEA/);
    expect(syncSql).toMatch(/octet_length\(content\) = byte_size/);
    expect(syncSql).toMatch(/CREATE TABLE IF NOT EXISTS capability_blob_tokens/);
    expect(syncSql).toMatch(/consumed_at\s+BIGINT/);
    expect(syncSql).toMatch(/CREATE TABLE IF NOT EXISTS capability_install_commits/);
    expect(syncSql).toMatch(/authority_item_revision\s+BIGINT NOT NULL/);
    expect(syncSql).toMatch(/expires_at\s+BIGINT NOT NULL/);
    expect(syncSql).toMatch(/phase\s+TEXT NOT NULL CHECK \(phase IN \(/);
    expect(syncSql).toMatch(/'prepare_sent', 'prepared', 'commit_sent', 'applied', 'committed', 'aborted'/);
  });
});
