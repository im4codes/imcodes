import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  type SessionRecord,
} from '../../src/store/session-store.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';

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
  it('a non-owner is read-only and cannot create or clobber sessions.json', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const storePath = join(home, '.imcodes', 'sessions.json');
    const before = await readFile(storePath, 'utf8');
    resetSessionStoreAuthorityForTests();
    await loadStore();
    removeSession('deck_store_owner_brain');
    await flushStore();
    expect(await readFile(storePath, 'utf8')).toBe(before);
  });

  it('stops writing when the lock metadata changes to another pid/start token', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const storePath = join(home, '.imcodes', 'sessions.json');
    const before = await readFile(storePath, 'utf8');
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
    await flushStore();
    expect(await readFile(storePath, 'utf8')).toBe(before);
  });

  it('does not flush an unloaded in-memory store from a stop-like process', async () => {
    await flushStore();
    await expect(readFile(join(home, '.imcodes', 'sessions.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an empty replacement until explicitly authorized', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    const storePath = join(home, '.imcodes', 'sessions.json');
    const before = await readFile(storePath, 'utf8');

    removeSession('deck_store_owner_brain');
    await flushStore();
    expect(await readFile(storePath, 'utf8')).toBe(before);

    authorizeEmptySessionStoreWrite();
    await flushStore();
    expect(JSON.parse(await readFile(storePath, 'utf8')).sessions).toEqual({});
  });

  it('rotates atomic backups and restores the newest non-empty backup', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_store_owner_brain'));
    await flushStore();
    upsertSession({ ...record('deck_store_owner_brain'), state: 'running' });
    await flushStore();
    const storePath = join(home, '.imcodes', 'sessions.json');
    expect(JSON.parse(await readFile(`${storePath}.1`, 'utf8')).sessions.deck_store_owner_brain.state).toBe('idle');

    // Simulate the incident's empty file while retaining the rotating backup.
    await writeFile(storePath, JSON.stringify({ version: 2, sessions: {}, identityPrompts: {} }), 'utf8');
    resetSessionStoreAuthorityForTests();
    await installOwner();
    await loadStore();
    expect(listSessions().map((session) => session.name)).toEqual(['deck_store_owner_brain']);
    await flushStore();
    expect(JSON.parse(await readFile(storePath, 'utf8')).sessions.deck_store_owner_brain).toBeDefined();
  });

  it('test mode rejects the real HOME even when VITEST is absent', async () => {
    vi.stubEnv('HOME', userInfo().homedir);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', '');
    // The path guard is asserted by loadStore before any mkdir/write side effect.
    await expect(loadStore()).rejects.toThrow(/real ~\/\.imcodes/);
  });
});
