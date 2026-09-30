/**
 * Incident guard (2026-09-26): a test wrote its fixture sessions into the real
 * ~/.imcodes/sessions.json, and the running daemon's in-process send_message
 * refresh (`loadStore({ probe: false })`) replaced its live store with that file,
 * dropping every main session. Two invariants:
 *  - a test process can never read or write the real ~/.imcodes (session store
 *    or any SQLite store);
 *  - once the daemon owns the store, a read-only refresh never replaces memory
 *    with a disk snapshot.
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushStore,
  listSessions,
  loadStore,
  markSessionStoreAuthoritative,
  removeSession,
  resetSessionStoreAuthorityForTests,
  upsertSession,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { assertNotRealImcodesPathInTests, isRealImcodesPath } from '../../src/util/test-home-guard.js';
import { TaskPairStore } from '../../src/daemon/task-pairs/store.js';
import { replacePersistedSessions } from '../helpers/session-store-db.js';

const realImcodes = join(userInfo().homedir, '.imcodes');

function record(name: string, projectDir: string): SessionRecord {
  return {
    name, projectName: 'guardproj', role: 'brain', agentType: 'shell', projectDir, state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

describe('real ~/.imcodes is off limits to tests', () => {
  it('recognises the real store directory and anything inside it', () => {
    expect(isRealImcodesPath(realImcodes)).toBe(true);
    expect(isRealImcodesPath(join(realImcodes, 'sessions.json'))).toBe(true);
    expect(isRealImcodesPath(join(realImcodes, 'task-pairs.sqlite'))).toBe(true);
    expect(isRealImcodesPath(join(tmpdir(), '.imcodes', 'sessions.json'))).toBe(false);
    expect(isRealImcodesPath(`${realImcodes}-other/sessions.json`)).toBe(false);
  });

  it('throws for real paths and lets temp paths and :memory: through', () => {
    expect(() => assertNotRealImcodesPathInTests(join(realImcodes, 'x.sqlite'), 'x')).toThrow(/real ~\/\.imcodes/);
    expect(() => assertNotRealImcodesPathInTests(join(tmpdir(), 'x.sqlite'), 'x')).not.toThrow();
    expect(() => assertNotRealImcodesPathInTests(':memory:', 'x')).not.toThrow();
  });

  it('refuses to open a SQLite store in the real home', () => {
    expect(() => new TaskPairStore(join(realImcodes, 'task-pairs.sqlite'))).toThrow(/real ~\/\.imcodes/);
  });

  it('refuses to load the session store when HOME points at the real home', async () => {
    const previous = process.env.HOME;
    process.env.HOME = userInfo().homedir;
    try {
      await expect(loadStore()).rejects.toThrow(/real ~\/\.imcodes/);
    } finally {
      process.env.HOME = previous;
    }
  });
});

describe('authoritative store is never replaced by a disk snapshot', () => {
  let home = '';
  const previousHome = process.env.HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'imcodes-test-home-guard-'));
    mkdirSync(join(home, '.imcodes'), { recursive: true });
    process.env.HOME = home;
  });

  afterEach(async () => {
    for (const name of ['deck_guardproj_brain', 'deck_guardproj_w1', 'deck_guardproj_w2']) removeSession(name);
    await flushStore();
    resetSessionStoreAuthorityForTests();
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('a read-only refresh keeps the daemon memory when a foreign writer clobbered the file', async () => {
    await loadStore();
    upsertSession(record('deck_guardproj_brain', home));
    upsertSession(record('deck_guardproj_w1', home));
    await flushStore();
    markSessionStoreAuthoritative();

    // A foreign process rewrites the persisted sessions with a partial snapshot.
    replacePersistedSessions(home, [{ ...record('deck_guardproj_w2', home) }]);

    await loadStore({ probe: false });
    const names = listSessions().map((session) => session.name).sort();
    expect(names).toEqual(['deck_guardproj_brain', 'deck_guardproj_w1']);
  });

  it('a non-authoritative consumer still refreshes from disk', async () => {
    await loadStore();
    upsertSession(record('deck_guardproj_brain', home));
    await flushStore();

    replacePersistedSessions(home, [{ ...record('deck_guardproj_w2', home) }]);

    await loadStore({ probe: false });
    expect(listSessions().map((session) => session.name)).toEqual(['deck_guardproj_w2']);
  });
});
