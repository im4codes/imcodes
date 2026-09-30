import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  authorizeEmptySessionStoreWrite,
  configureSessionStoreWriteAuthority,
  flushStore,
  loadStore,
  listSessions,
  removeSession,
  resetSessionStoreAuthorityForTests,
  upsertSession,
  waitForSessionStoreSnapshotForTests,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { persistedSessions, replacePersistedSessions } from '../helpers/session-store-db.js';

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

  it('test mode rejects the real HOME even when VITEST is absent', async () => {
    vi.stubEnv('HOME', userInfo().homedir);
    vi.stubEnv('IMCODES_HOME', ''); // unset: the default state directory derives from the (real) HOME
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', '');
    // The path guard is asserted by loadStore before any mkdir/write side effect.
    await expect(loadStore()).rejects.toThrow(/real ~\/\.imcodes/);
  });
});
