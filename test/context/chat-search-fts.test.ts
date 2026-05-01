import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { archiveEventsForMaterialization, recordContextEvent, resetContextStoreForTests, searchArchiveFts } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('archive FTS search', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await createIsolatedSharedContextDb('archive-fts'); });
  afterEach(async () => { resetContextStoreForTests(); await cleanupIsolatedSharedContextDb(tempDir); });

  it('returns archived Chinese content and stays in sync after insert', () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo' };
    const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-fts', target, eventType: 'user.message', content: '记忆 系统 升级 完成', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    expect(searchArchiveFts('记忆', 5).map((row) => row.id)).toContain('evt-fts');
  });

  it('keeps FTS in sync after archive update and delete triggers', () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo' };
    const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-fts-mut', target, eventType: 'user.message', content: 'before-token', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);

    const database = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
    database.prepare('UPDATE context_event_archive SET content = ? WHERE id = ?').run('after-token 记忆升级', 'evt-fts-mut');
    database.close();

    expect(searchArchiveFts('after-token', 5).map((row) => row.id)).toContain('evt-fts-mut');
    expect(searchArchiveFts('before-token', 5).map((row) => row.id)).not.toContain('evt-fts-mut');

    const deleteDb = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
    deleteDb.prepare('DELETE FROM context_event_archive WHERE id = ?').run('evt-fts-mut');
    deleteDb.close();
    expect(searchArchiveFts('after-token', 5).map((row) => row.id)).not.toContain('evt-fts-mut');
  });

  it('falls back to bounded LIKE for malformed FTS MATCH syntax', () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo' };
    const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-fts-malformed', target, eventType: 'user.message', content: 'literal foo" token survived with AND operator text', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    expect(() => searchArchiveFts('foo"', 5)).not.toThrow();
    expect(searchArchiveFts('foo"', 5).map((row) => row.id)).toContain('evt-fts-malformed');
    expect(() => searchArchiveFts('AND', 5)).not.toThrow();
    expect(searchArchiveFts('AND', 5).map((row) => row.id)).toContain('evt-fts-malformed');
    expect(() => searchArchiveFts('OR foo', 5)).not.toThrow();
    expect(searchArchiveFts('   ', 5)).toEqual([]);
  });
});
