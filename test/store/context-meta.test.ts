import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getContextMeta, resetContextStoreForTests, setContextMeta, tryAlter } from '../../src/store/context-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('context_meta migration helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-meta');
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('round-trips sentinel values and returns undefined for absent keys', () => {
    expect(getContextMeta('missing')).toBeUndefined();
    setContextMeta('migration_archive_backfilled', '1');
    expect(getContextMeta('migration_archive_backfilled')).toBe('1');
  });

  it('returns true for a successful ALTER and false for an idempotent duplicate', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
      expect(tryAlter(db, 'ALTER TABLE t ADD COLUMN value TEXT')).toBe(true);
      expect(tryAlter(db, 'ALTER TABLE t ADD COLUMN value TEXT')).toBe(false);
    } finally {
      db.close();
    }
  });
});
