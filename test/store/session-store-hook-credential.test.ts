import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configureSessionStoreWriteAuthority,
  flushStore,
  getSession,
  loadStore,
  resetIdentityBackupCleanupForTests,
  resetSessionStoreAuthorityForTests,
  setSessionStoreBackupIntervalMsForTests,
  upsertSession,
  waitForCompatExportForTests,
  waitForCredentialBackupCleanupForTests,
  waitForSessionStoreSnapshotForTests,
  type SessionRecord,
} from '../../src/store/session-store.js';
import {
  closeSessionDb,
  commitSessionChanges,
  markLegacyImportDone,
  openSessionDbForWrite,
  openSessionDbReadOnly,
  readSessionDbMeta,
  readSnapshotPayloads,
  scrubTransportHookCredentialRows,
  setSessionDbFailAfterRowWritesForTests,
} from '../../src/store/session-store-db.js';
import {
  externalizeSessionRecord,
  hydrateSessionRecord,
} from '../../src/store/session-record-blobs.js';
import { hookClaimAllowed } from '../../src/daemon/hook-session-credential.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';
import {
  SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB,
  SESSION_RECORD_INLINE_STRING_MAX_CHARS,
} from '../../shared/session-store-compat.js';
import { persistedSessionBlobs, persistedSessions, sessionDbPathForHome } from '../helpers/session-store-db.js';

let home = '';
let dir = '';

function record(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    projectName: 'realproj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/home/user/work/realproj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

async function freshStore(): Promise<void> {
  resetSessionStoreAuthorityForTests();
  resetIdentityBackupCleanupForTests();
  configureSessionStoreWriteAuthority(currentDaemonProcessIdentity());
  await loadStore({ probe: false });
  await waitForCompatExportForTests();
}

function dbStateBytes(): string {
  const parts: string[] = [];
  for (const suffix of ['', '-wal']) {
    const path = `${sessionDbPathForHome(home)}${suffix}`;
    if (existsSync(path)) parts.push(readFileSync(path).toString('latin1'));
  }
  return parts.join('\n');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-hook-cred-store-'));
  dir = join(home, '.imcodes');
  await mkdir(dir, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('IMCODES_HOME', dir);
  resetSessionStoreAuthorityForTests();
  resetIdentityBackupCleanupForTests();
});

afterEach(async () => {
  setSessionDbFailAfterRowWritesForTests(null);
  await waitForCompatExportForTests().catch(() => undefined);
  await waitForCredentialBackupCleanupForTests().catch(() => undefined);
  await waitForSessionStoreSnapshotForTests().catch(() => undefined);
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('hookCredential storage and sessions.json isolation', () => {
  it('never writes hookCredential into sessions.json for transport or process sessions (even with blob refs)', async () => {
    await freshStore();
    const transportCred = 'transport-secret-token-canary-1111';
    const processCred = 'process-secret-token-canary-2222';
    const bigDescription = 'x'.repeat(SESSION_RECORD_INLINE_STRING_MAX_CHARS + 512);

    upsertSession(record('deck_t_brain', {
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      hookCredential: transportCred,
      description: bigDescription,
    }));
    upsertSession(record('deck_p_w1', {
      role: 'w1',
      agentType: 'claude-code',
      runtimeType: 'process',
      hookCredential: processCred,
      description: bigDescription,
    }));
    upsertSession(record('deck_p_inline', {
      role: 'w2',
      agentType: 'shell',
      hookCredential: `${processCred}-inline`,
    }));

    await flushStore();
    await waitForCompatExportForTests();
    await waitForSessionStoreSnapshotForTests();

    const jsonRaw = readFileSync(join(dir, 'sessions.json'), 'utf8');
    const exported = JSON.parse(jsonRaw) as { sessions: Record<string, Record<string, unknown>> };
    expect(jsonRaw).not.toContain('hookCredential');
    expect(jsonRaw).not.toContain(transportCred);
    expect(jsonRaw).not.toContain(processCred);
    expect(exported.sessions['deck_t_brain']).toMatchObject({ agentType: 'codex-sdk', description: bigDescription });
    expect(exported.sessions['deck_p_w1']).toMatchObject({ agentType: 'claude-code', description: bigDescription });
    expect(exported.sessions['deck_p_inline']).toMatchObject({ agentType: 'shell' });

    // Transport session keeps its credential in memory & enforces hookClaimAllowed,
    // while SQLite + backups hold zero copies of transport credentials.
    expect(getSession('deck_t_brain')?.hookCredential).toBe(transportCred);
    expect(hookClaimAllowed('deck_t_brain', {})).toBe(false);
    expect(hookClaimAllowed('deck_t_brain', { [HOOK_SESSION_CREDENTIAL_HEADER]: transportCred })).toBe(true);

    const persisted = persistedSessions(home);
    expect(persisted['deck_t_brain']).not.toHaveProperty('hookCredential');
    expect(persisted['deck_p_w1']?.['hookCredential']).toBe(processCred);
    expect(persisted['deck_p_inline']?.['hookCredential']).toBe(`${processCred}-inline`);

    // Byte scan across all DB, WAL, and backup files confirms transport credential never hits disk.
    for (const file of await readdir(dir)) {
      if (!file.startsWith('sessions.')) continue;
      expect(readFileSync(join(dir, file)).toString('latin1'), file).not.toContain(transportCred);
    }
    const snapshotPayloads = readSnapshotPayloads(`${sessionDbPathForHome(home)}.bak.1`)!;
    expect(snapshotPayloads).toBeTruthy();
    expect(JSON.parse(snapshotPayloads.get('deck_t_brain')!)).not.toHaveProperty('hookCredential');
    expect(JSON.parse(snapshotPayloads.get('deck_p_w1')!)['hookCredential']).toBe(processCred);

    // Reloading (simulating daemon restart) drops in-memory transport credential and retains process continuity.
    await freshStore();
    expect(getSession('deck_t_brain')?.hookCredential).toBeUndefined();
    expect(getSession('deck_p_w1')?.hookCredential).toBe(processCred);
    expect(hookClaimAllowed('deck_p_w1', {})).toBe(false);
    expect(hookClaimAllowed('deck_p_w1', { [HOOK_SESSION_CREDENTIAL_HEADER]: processCred })).toBe(true);
  });

  it('scrubs legacy persisted transport hookCredentials from SQLite and stale backups on startup without breaking process rows', async () => {
    const legacyTransportCred = 'legacy-transport-cred-canary-9999';
    const legacyTransportInferredCred = 'legacy-inferred-transport-canary-8888';
    const legacyBlobCred = 'z'.repeat(SESSION_RECORD_INLINE_STRING_MAX_CHARS + 128);
    const keepProcessCred = 'keep-process-cred-canary-7777';
    const dbPath = sessionDbPathForHome(home);
    const handle = openSessionDbForWrite(dbPath);
    try {
      const refHash = 'b'.repeat(32);
      commitSessionChanges(handle, {
        upserts: [
          {
            name: 'deck_legacy_t1',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'codex-sdk',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_legacy_t1', {
              runtimeType: 'transport',
              hookCredential: legacyTransportCred,
            })),
          },
          {
            name: 'deck_legacy_t_inferred',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'claude-code-sdk',
            state: 'idle',
            updatedAt: 1,
            // Pre-runtimeType transport row stored by an older build
            payload: JSON.stringify({
              ...record('deck_legacy_t_inferred', { agentType: 'claude-code-sdk', hookCredential: legacyTransportInferredCred }),
            }),
          },
          {
            name: 'deck_legacy_t_blob',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'codex-sdk',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify({ ...record('deck_legacy_t_blob'), blobRefs: { hookCredential: refHash } }),
            blobs: [{ hash: refHash, text: legacyBlobCred }],
          },
          {
            name: 'deck_legacy_p1',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'claude-code',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_legacy_p1', {
              role: 'w1',
              agentType: 'claude-code',
              hookCredential: keepProcessCred,
            })),
          },
        ],
        deletes: [],
        allowEmpty: true,
      });
      markLegacyImportDone(handle);
      handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      closeSessionDb(handle);
    }

    // Also plant a dirty SQLite backup with transport creds, a clean process-only backup, a rotated sessions.json.1, and a foreign file.
    const dirtyBak = openSessionDbForWrite(`${dbPath}.bak.1`);
    try {
      commitSessionChanges(dirtyBak, {
        upserts: [{
          name: 'deck_legacy_t1',
          projectName: 'realproj',
          parentSession: null,
          agentType: 'codex-sdk',
          state: 'idle',
          updatedAt: 1,
          payload: JSON.stringify(record('deck_legacy_t1', { runtimeType: 'transport', hookCredential: legacyTransportCred })),
        }],
        deletes: [],
        allowEmpty: true,
      });
    } finally {
      closeSessionDb(dirtyBak);
    }
    const processOnlyBak = openSessionDbForWrite(`${dbPath}.bak.2`);
    try {
      commitSessionChanges(processOnlyBak, {
        upserts: [{
          name: 'deck_legacy_p1',
          projectName: 'realproj',
          parentSession: null,
          agentType: 'claude-code',
          state: 'idle',
          updatedAt: 1,
          payload: JSON.stringify(record('deck_legacy_p1', { agentType: 'claude-code', hookCredential: keepProcessCred })),
        }],
        deletes: [],
        allowEmpty: true,
      });
    } finally {
      closeSessionDb(processOnlyBak);
    }
    await writeFile(join(dir, 'sessions.json.1'), JSON.stringify({
      sessions: { deck_legacy_p1: { name: 'deck_legacy_p1', hookCredential: keepProcessCred } },
    }));
    const userBackup = join(dir, 'sessions.json.backup-manual');
    await writeFile(userBackup, JSON.stringify({ sessions: { manual: { hookCredential: legacyTransportCred } } }));

    if (process.platform !== 'win32') {
      await chmod(dbPath, 0o644);
    }

    expect(dbStateBytes()).toContain(legacyTransportCred);

    await freshStore();
    await waitForCredentialBackupCleanupForTests();

    const persisted = persistedSessions(home);
    expect(persisted['deck_legacy_t1']).not.toHaveProperty('hookCredential');
    expect(persisted['deck_legacy_t_inferred']).not.toHaveProperty('hookCredential');
    expect(persisted['deck_legacy_t_blob']).not.toHaveProperty('hookCredential');
    expect(persisted['deck_legacy_t_blob']).not.toHaveProperty('blobRefs');
    expect(persistedSessionBlobs(home).size).toBe(0);
    expect(persisted['deck_legacy_p1']?.['hookCredential']).toBe(keepProcessCred);

    // Compacted away from database bytes + WAL.
    const rawDb = dbStateBytes();
    expect(rawDb).not.toContain(legacyTransportCred);
    expect(rawDb).not.toContain(legacyTransportInferredCred);
    expect(rawDb).not.toContain(legacyBlobCred);

    // Scrub meta is marked done and idempotent.
    const reader = openSessionDbReadOnly(dbPath)!;
    try {
      expect(readSessionDbMeta(reader, SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB)).toBe('done');
    } finally {
      closeSessionDb(reader);
    }
    const writer = openSessionDbForWrite(dbPath);
    try {
      expect(scrubTransportHookCredentialRows(writer)).toEqual({ scrubbedRows: 0, compacted: false });
    } finally {
      closeSessionDb(writer);
    }

    // Dirty rotation files were removed; process-only snapshot & user-created manual backup stay untouched.
    expect(existsSync(`${dbPath}.bak.1`)).toBe(false);
    expect(existsSync(`${dbPath}.bak.2`)).toBe(true);
    expect(existsSync(join(dir, 'sessions.json.1'))).toBe(false);
    expect(existsSync(userBackup)).toBe(true);

    // In-memory store exposes no stale transport credentials and preserves process credential.
    expect(getSession('deck_legacy_t1')?.hookCredential).toBeUndefined();
    expect(getSession('deck_legacy_t_inferred')?.hookCredential).toBeUndefined();
    expect(getSession('deck_legacy_p1')?.hookCredential).toBe(keepProcessCred);

    // Compatibility export written cleanly without any hookCredential.
    const compatRaw = readFileSync(join(dir, 'sessions.json'), 'utf8');
    expect(compatRaw).not.toContain(keepProcessCred);
    expect(compatRaw).not.toContain('hookCredential');

    // POSIX file modes are owner-only (0o600).
    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600);
      setSessionStoreBackupIntervalMsForTests(0);
      upsertSession(record('deck_legacy_p1', { role: 'w1', agentType: 'claude-code', hookCredential: keepProcessCred, updatedAt: 99 }));
      await flushStore();
      await waitForSessionStoreSnapshotForTests();
      expect(statSync(`${dbPath}.bak.1`).mode & 0o777).toBe(0o600);
    }
  });

  it('strips transport hookCredential at externalize/hydrate and legacy sessions.json migration boundaries', async () => {
    const extTransport = externalizeSessionRecord({
      name: 'deck_ext_t',
      agentType: 'codex-sdk',
      hookCredential: 'should-never-persist',
      description: 'ok',
    });
    expect(extTransport.payload).toBe('{"name":"deck_ext_t","agentType":"codex-sdk","description":"ok"}');
    expect(extTransport.blobs).toEqual([]);

    const extProcess = externalizeSessionRecord({
      name: 'deck_ext_p',
      agentType: 'claude-code',
      hookCredential: 'must-persist-for-tmux',
    });
    expect(JSON.parse(extProcess.payload)).toMatchObject({ hookCredential: 'must-persist-for-tmux' });

    const hydratedTransport = hydrateSessionRecord(
      { name: 'deck_hyd_t', agentType: 'codex-sdk', hookCredential: 'stale-disk-secret' },
      () => undefined,
    );
    expect(hydratedTransport).not.toHaveProperty('hookCredential');

    const hydratedProcess = hydrateSessionRecord(
      { name: 'deck_hyd_p', agentType: 'codex', hookCredential: 'kept-process-secret' },
      () => undefined,
    );
    expect(hydratedProcess['hookCredential']).toBe('kept-process-secret');

    // Legacy sessions.json migration strips transport credentials and preserves process ones in SQLite (not exported JSON).
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({
      version: 2,
      sessions: {
        deck_mig_t: record('deck_mig_t', { agentType: 'codex-sdk', hookCredential: 'mig-t-secret' }),
        deck_mig_p: record('deck_mig_p', { role: 'w1', agentType: 'claude-code', hookCredential: 'mig-p-secret' }),
      },
    }), 'utf8');
    await freshStore();
    expect(getSession('deck_mig_t')?.hookCredential).toBeUndefined();
    expect(getSession('deck_mig_p')?.hookCredential).toBe('mig-p-secret');
    expect(persistedSessions(home)['deck_mig_t']).not.toHaveProperty('hookCredential');
    expect(persistedSessions(home)['deck_mig_p']?.['hookCredential']).toBe('mig-p-secret');
    expect(readFileSync(join(dir, 'sessions.json'), 'utf8')).not.toContain('hookCredential');
  });
});
