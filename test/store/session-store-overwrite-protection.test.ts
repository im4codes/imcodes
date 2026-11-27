import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  authorizeClosedSessionRemoval,
  authorizeEmptySessionStoreWrite,
  configureSessionStoreWriteAuthority,
  flushStore,
  loadStore,
  listSessions,
  removeSession,
  resetSessionStoreAuthorityForTests,
  setSessionStoreBackupIntervalMsForTests,
  setSessionStoreSweepSliceMsForTests,
  upsertSession,
  waitForSessionStoreSnapshotForTests,
  type SessionRecord,
} from '../../src/store/session-store.js';
import {
  SESSION_DB_META_LEGITIMATE_EMPTY,
  closeSessionDb,
  openSessionDbReadOnly,
  readSessionDbMeta,
} from '../../src/store/session-store-db.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { persistedSessions, replacePersistedSessions, sessionDbPathForHome } from '../helpers/session-store-db.js';

const identity = currentDaemonProcessIdentity();
let home = '';
let metadataPath = '';

function record(name: string): SessionRecord {
  return {
    name,
    projectName: 'overwrite-test',
    role: 'brain',
    agentType: 'shell',
    projectDir: '/tmp/overwrite-test',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

async function installOwner(): Promise<void> {
  await mkdir(join(home, '.imcodes'), { recursive: true });
  await writeFile(metadataPath, JSON.stringify({
    version: 1,
    ...identity,
    acquiredAt: Date.now(),
    socketPath: join(home, '.imcodes', 'daemon.sock'),
    sessionIds: ['deck_store_owner_brain'],
    residualResources: [],
  }), 'utf8');
  configureSessionStoreWriteAuthority(identity, metadataPath);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-session-overwrite-'));
  metadataPath = join(home, '.imcodes', 'daemon.lock.json');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  // IMCODES_HOME (pinned by the test setup) is the state directory and wins over HOME: move it with HOME.
  vi.stubEnv('IMCODES_HOME', join(home, '.imcodes'));
  // Exercise the production ownership branch rather than Vitest's isolated-
  // home allowance. The path is still temporary and never the real HOME.
  vi.stubEnv('VITEST', '');
  vi.stubEnv('NODE_ENV', 'production');
  resetSessionStoreAuthorityForTests();
});

afterEach(async () => {
  setSessionStoreBackupIntervalMsForTests(undefined);
  setSessionStoreSweepSliceMsForTests(undefined);
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('session-store ownership and recovery', () => {
  it('a non-owner is read-only and cannot create or clobber the persisted sessions', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const before = persistedSessions(home);
    expect(Object.keys(before)).toEqual(['deck_store_owner_brain']);
    resetSessionStoreAuthorityForTests();
    await loadStore();
    removeSession('deck_store_owner_brain');
    upsertSession(record('deck_store_intruder_w1'));
    await flushStore();
    expect(persistedSessions(home)).toEqual(before);
  });

  it('a non-owner never creates the database', async () => {
    await mkdir(join(home, '.imcodes'), { recursive: true });
    await loadStore();
    upsertSession(record('deck_store_intruder_brain'));
    await flushStore();
    expect((await readdir(join(home, '.imcodes'))).filter((file) => file.startsWith('sessions'))).toEqual([]);
  });

  it('stops writing when the lock metadata changes to another pid/start token', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const before = persistedSessions(home);
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      pid: identity.pid + 1,
      startToken: 'foreign-start-token',
      acquiredAt: Date.now(),
      socketPath: join(home, '.imcodes', 'daemon.sock'),
      sessionIds: [],
      residualResources: [],
    }), 'utf8');
    removeSession('deck_store_owner_brain');
    upsertSession(record('deck_store_late_w1'));
    await flushStore();
    expect(persistedSessions(home)).toEqual(before);
  });

  it('does not flush an unloaded in-memory store from a stop-like process', async () => {
    await flushStore();
    expect((await readdir(join(home, '.imcodes')).catch(() => [] as string[])).filter((file) => file.startsWith('sessions'))).toEqual([]);
  });

  it('refuses an empty replacement until explicitly authorized', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const before = persistedSessions(home);

    removeSession('deck_store_owner_brain');
    await flushStore();
    expect(persistedSessions(home)).toEqual(before);

    authorizeEmptySessionStoreWrite();
    await flushStore();
    expect(persistedSessions(home)).toEqual({});
  });

  it('restores the newest non-empty database snapshot when the live database was emptied', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    await waitForSessionStoreSnapshotForTests(); // the first flush started the periodic online snapshot
    expect(await readdir(join(home, '.imcodes'))).toContain('sessions.sqlite.bak.1');

    // Simulate the incident's empty store while the snapshot is retained.
    replacePersistedSessions(home, []);
    resetSessionStoreAuthorityForTests();
    await installOwner();
    await loadStore();
    expect(listSessions().map((session) => session.name)).toEqual(['deck_store_owner_brain']);
    await flushStore();
    expect(persistedSessions(home).deck_store_owner_brain).toBeDefined();
  });

  it('confirmed closed-session removals persist an empty store past backup snapshots, then restore recovery resumes once non-empty rows exist', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    upsertSession({ ...record('deck_sub_tree_1'), parentSession: 'deck_store_owner_brain' });
    await flushStore();
    await waitForSessionStoreSnapshotForTests();
    expect(await readdir(join(home, '.imcodes'))).toContain('sessions.sqlite.bak.1');

    authorizeClosedSessionRemoval('deck_store_owner_brain');
    removeSession('deck_store_owner_brain');
    authorizeClosedSessionRemoval('deck_sub_tree_1');
    removeSession('deck_sub_tree_1');
    await flushStore();
    expect(persistedSessions(home)).toEqual({});

    resetSessionStoreAuthorityForTests();
    await installOwner();
    await loadStore();
    expect(listSessions()).toEqual([]);

    // Writing a new session clears the legitimate-empty marker so accidental emptying restores again.
    setSessionStoreBackupIntervalMsForTests(0);
    upsertSession(record('deck_store_reborn_brain'));
    await flushStore();
    await waitForSessionStoreSnapshotForTests();
    replacePersistedSessions(home, []);
    resetSessionStoreAuthorityForTests();
    await installOwner();
    await loadStore();
    expect(listSessions().map((session) => session.name)).toEqual(['deck_store_reborn_brain']);
  });

  it('scopes empty-store authorization to the exact closed names and keeps unauthorized or partial-failure rows intact', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    upsertSession(record('deck_store_other_w1'));
    await flushStore();
    const before = persistedSessions(home);

    // Mixed delete batch: confirmed closed A commits on the first flush while
    // unauthorized B is refused and stays persisted across reload without any later upsert.
    authorizeClosedSessionRemoval('deck_store_owner_brain');
    removeSession('deck_store_owner_brain');
    removeSession('deck_store_other_w1');
    await flushStore();
    expect(persistedSessions(home)).toEqual({ deck_store_other_w1: before.deck_store_other_w1 });

    resetSessionStoreAuthorityForTests();
    await installOwner();
    await loadStore();
    expect(listSessions().map((session) => session.name)).toEqual(['deck_store_other_w1']);

    // Independent partial close failure: closed A is removed while surviving B stays in error state.
    upsertSession(record('deck_store_partial_a'));
    upsertSession(record('deck_store_partial_b'));
    await flushStore();
    authorizeClosedSessionRemoval('deck_store_partial_a');
    removeSession('deck_store_partial_a');
    upsertSession({ ...record('deck_store_partial_b'), state: 'error', error: 'close failed' });
    await flushStore();
    expect(persistedSessions(home).deck_store_partial_a).toBeUndefined();
    expect(persistedSessions(home).deck_store_partial_b?.state).toBe('error');
  });

  it('aborts a normal sweep before commit when another daemon takes the instance lock mid-sweep', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const before = persistedSessions(home);

    setSessionStoreSweepSliceMsForTests(0);
    const flushing = flushStore();
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        authorizeClosedSessionRemoval('deck_store_owner_brain');
        removeSession('deck_store_owner_brain');
        writeFileSync(metadataPath, JSON.stringify({
          version: 1,
          pid: identity.pid + 1,
          startToken: 'foreign-start-token',
          acquiredAt: Date.now(),
          socketPath: join(home, '.imcodes', 'daemon.sock'),
          sessionIds: [],
          residualResources: [],
        }), 'utf8');
        resolve();
      });
    });
    await flushing;

    expect(persistedSessions(home)).toEqual(before);
    const handle = openSessionDbReadOnly(sessionDbPathForHome(home));
    expect(handle).not.toBeNull();
    try {
      expect(readSessionDbMeta(handle!, SESSION_DB_META_LEGITIMATE_EMPTY)).toBeNull();
    } finally {
      if (handle) closeSessionDb(handle);
    }
  });

  it('test mode rejects the real HOME even when VITEST is absent', async () => {
    vi.stubEnv('HOME', userInfo().homedir);
    vi.stubEnv('IMCODES_HOME', ''); // unset: the default state directory derives from the (real) HOME
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', '');
    // The path guard is asserted by loadStore before any mkdir/write side effect.
    await expect(loadStore()).rejects.toThrow(/real ~\/\.imcodes/);
  });
});
