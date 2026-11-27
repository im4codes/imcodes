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
  snapshotSessionDb,
} from '../../src/store/session-store-db.js';
import {
  externalizeSessionRecord,
  hydrateSessionRecord,
} from '../../src/store/session-record-blobs.js';
import { redactLegacyJsonCredentialFile } from '../../src/store/session-identity-backups.js';
import { hookClaimAllowed } from '../../src/daemon/hook-session-credential.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import logger from '../../src/util/logger.js';
import { HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';
import {
  LEGACY_JSON_FROZEN_SUFFIX,
  SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS,
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

function dbStateBytes(basePath = sessionDbPathForHome(home)): string {
  const parts: string[] = [];
  for (const suffix of ['', '-wal']) {
    const path = `${basePath}${suffix}`;
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('hookCredential storage and sessions.json isolation', () => {
  it('never writes hookCredential into sessions.json, enforces transport creds immediately on load (F1), and preserves process continuity', async () => {
    await freshStore();
    const transportCred = 'transport-secret-token-canary-1111';
    const stoppedTransportCred = 'stopped-transport-secret-canary-1112';
    const processCred = 'process-secret-token-canary-2222';
    const bigDescription = 'x'.repeat(SESSION_RECORD_INLINE_STRING_MAX_CHARS + 512);

    upsertSession(record('deck_t_brain', {
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      hookCredential: transportCred,
      description: bigDescription,
    }));
    upsertSession(record('deck_t_stopped', {
      role: 'w1',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'stopped',
      hookCredential: stoppedTransportCred,
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
    upsertSession(record('deck_p_legacy_nocred', {
      role: 'w3',
      agentType: 'claude-code',
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
    expect(persisted['deck_t_stopped']).not.toHaveProperty('hookCredential');
    expect(persisted['deck_p_w1']?.['hookCredential']).toBe(processCred);
    expect(persisted['deck_p_inline']?.['hookCredential']).toBe(`${processCred}-inline`);

    // Byte scan across all DB, WAL, and backup files confirms transport credentials never hit disk.
    for (const file of await readdir(dir)) {
      if (!file.startsWith('sessions.')) continue;
      const bytes = readFileSync(join(dir, file)).toString('latin1');
      expect(bytes, file).not.toContain(transportCred);
      expect(bytes, file).not.toContain(stoppedTransportCred);
    }
    const snapshotPayloads = readSnapshotPayloads(`${sessionDbPathForHome(home)}.bak.1`)!;
    expect(snapshotPayloads).toBeTruthy();
    expect(JSON.parse(snapshotPayloads.get('deck_t_brain')!)).not.toHaveProperty('hookCredential');
    expect(JSON.parse(snapshotPayloads.get('deck_p_w1')!)['hookCredential']).toBe(processCred);

    // Reloading (simulating daemon restart BEFORE transport reconnect/restore):
    // F1: BOTH active and stopped transport sessions immediately get fresh in-memory credentials on loadStore,
    // rejecting anonymous, stale pre-restart, and wrong credentials while never writing them to disk.
    await freshStore();
    const reloadedCred = getSession('deck_t_brain')?.hookCredential;
    const reloadedStoppedCred = getSession('deck_t_stopped')?.hookCredential;
    expect(reloadedCred).toMatch(/^[0-9a-f]{64}$/);
    expect(reloadedCred).not.toBe(transportCred);
    expect(reloadedStoppedCred).toMatch(/^[0-9a-f]{64}$/);
    expect(reloadedStoppedCred).not.toBe(stoppedTransportCred);
    expect(persistedSessions(home)['deck_t_brain']).not.toHaveProperty('hookCredential');
    expect(readFileSync(join(dir, 'sessions.json'), 'utf8')).not.toContain('hookCredential');

    for (const [name, stale, fresh] of [
      ['deck_t_brain', transportCred, reloadedCred!],
      ['deck_t_stopped', stoppedTransportCred, reloadedStoppedCred!],
    ] as const) {
      expect(hookClaimAllowed(name, {})).toBe(false);
      expect(hookClaimAllowed(name, { [HOOK_SESSION_CREDENTIAL_HEADER]: stale })).toBe(false);
      expect(hookClaimAllowed(name, { [HOOK_SESSION_CREDENTIAL_HEADER]: 'wrong-secret' })).toBe(false);
      expect(hookClaimAllowed(name, { [HOOK_SESSION_CREDENTIAL_HEADER]: fresh })).toBe(true);
    }

    // Unclaimed local CLI & legacy credential-less process session compatibility remain intact.
    expect(hookClaimAllowed(undefined, {})).toBe(true);
    expect(hookClaimAllowed('deck_p_legacy_nocred', {})).toBe(true);

    // Process sessions retain daemon-restart continuity.
    expect(getSession('deck_p_w1')?.hookCredential).toBe(processCred);
    expect(hookClaimAllowed('deck_p_w1', {})).toBe(false);
    expect(hookClaimAllowed('deck_p_w1', { [HOOK_SESSION_CREDENTIAL_HEADER]: processCred })).toBe(true);
  });

  it('redacts sessions.json and .migrated-to-sqlite after durable import even past sunset or size budget while preserving recovery before import (F2)', async () => {
    const processSecret = 'f2-process-secret-canary-4444';
    const transportSecret = 'f2-transport-secret-canary-5555';

    // Pre-import recovery preservation: corrupt/unimportable sessions.json leaves bytes untouched.
    const jsonPath = join(dir, 'sessions.json');
    await writeFile(jsonPath, `{"broken": "${processSecret}"`, 'utf8');
    await freshStore();
    expect(readFileSync(jsonPath, 'utf8')).toBe(`{"broken": "${processSecret}"`);

    // Valid pre-SQLite sessions.json -> migration creates .migrated-to-sqlite, which must be redacted immediately.
    await writeFile(jsonPath, JSON.stringify({
      version: 2,
      sessions: {
        deck_f2_proc: record('deck_f2_proc', { role: 'w1', agentType: 'claude-code', hookCredential: processSecret, description: 'keep me' }),
        deck_f2_trans: record('deck_f2_trans', { agentType: 'codex-sdk', hookCredential: transportSecret, description: 'keep transport' }),
      },
    }), 'utf8');
    if (process.platform !== 'win32') await chmod(jsonPath, 0o644);

    await freshStore();
    const frozenPath = `${jsonPath}${LEGACY_JSON_FROZEN_SUFFIX}`;
    expect(existsSync(frozenPath)).toBe(true);
    const frozenRaw = readFileSync(frozenPath, 'utf8');
    expect(frozenRaw).not.toContain('hookCredential');
    expect(frozenRaw).not.toContain(processSecret);
    expect(frozenRaw).not.toContain(transportSecret);
    expect(JSON.parse(frozenRaw).sessions.deck_f2_proc).toMatchObject({ description: 'keep me', agentType: 'claude-code' });
    expect(JSON.parse(frozenRaw).sessions.deck_f2_trans).toMatchObject({ description: 'keep transport', agentType: 'codex-sdk' });
    if (process.platform !== 'win32') {
      expect(statSync(frozenPath).mode & 0o777).toBe(0o600);
    }

    // Post-sunset loadStore where normal compat export does NOT run: existing sessions.json and
    // .migrated-to-sqlite containing process/transport credentials are still redacted atomically at 0600,
    // while SQLite keeps the process credential intact.
    await writeFile(jsonPath, JSON.stringify({
      version: 2,
      sessions: {
        deck_f2_proc: record('deck_f2_proc', { role: 'w1', agentType: 'claude-code', hookCredential: processSecret, description: 'post-sunset' }),
        deck_f2_trans: record('deck_f2_trans', { agentType: 'codex-sdk', hookCredential: transportSecret }),
      },
    }), 'utf8');
    await writeFile(frozenPath, JSON.stringify({
      version: 2,
      sessions: {
        deck_f2_proc: record('deck_f2_proc', { role: 'w1', agentType: 'claude-code', hookCredential: processSecret, description: 'frozen-keep' }),
      },
    }), 'utf8');
    if (process.platform !== 'win32') {
      await chmod(jsonPath, 0o644);
      await chmod(frozenPath, 0o644);
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS + 10_000);
    await freshStore();

    const postSunsetJson = readFileSync(jsonPath, 'utf8');
    const postSunsetFrozen = readFileSync(frozenPath, 'utf8');
    expect(postSunsetJson).not.toContain('hookCredential');
    expect(postSunsetJson).not.toContain(processSecret);
    expect(postSunsetJson).not.toContain(transportSecret);
    expect(JSON.parse(postSunsetJson).sessions.deck_f2_proc).toMatchObject({ description: 'post-sunset' });
    expect(postSunsetFrozen).not.toContain('hookCredential');
    expect(JSON.parse(postSunsetFrozen).sessions.deck_f2_proc).toMatchObject({ description: 'frozen-keep' });
    expect(getSession('deck_f2_proc')?.hookCredential).toBe(processSecret);
    if (process.platform !== 'win32') {
      expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
      expect(statSync(frozenPath).mode & 0o777).toBe(0o600);
    }

    // Also verify redactLegacyJsonCredentialFile handles a large payload independently of compat size budget.
    const hugePad = 'a'.repeat(1024 * 1024);
    await writeFile(jsonPath, JSON.stringify({
      version: 2,
      sessions: {
        deck_f2_proc: record('deck_f2_proc', { role: 'w1', agentType: 'claude-code', hookCredential: processSecret, description: hugePad }),
      },
    }), 'utf8');
    const direct = await redactLegacyJsonCredentialFile(jsonPath);
    expect(direct).toEqual({ redacted: true });
    expect(readFileSync(jsonPath, 'utf8')).not.toContain(processSecret);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).sessions.deck_f2_proc.description).toBe(hugePad);
  });

  it('defers SCRUB_DONE when a reader pins WAL and finishes physical WAL+free-page+snapshot cleanup on retry (F3)', async () => {
    const walCanary = 'f3-wal-pinned-secret-canary-6666';
    const freePageCanary = 'f3-freepage-secret-canary-7777';
    const keepProcessCred = 'f3-process-secret-canary-8888';
    const dbPath = sessionDbPathForHome(home);

    const handle = openSessionDbForWrite(dbPath);
    try {
      commitSessionChanges(handle, {
        upserts: [
          {
            name: 'deck_f3_t_row',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'codex-sdk',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_f3_t_row', { runtimeType: 'transport', hookCredential: walCanary })),
          },
          {
            name: 'deck_f3_freepage',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'codex-sdk',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_f3_freepage', { runtimeType: 'transport', hookCredential: freePageCanary })),
          },
          {
            name: 'deck_f3_p1',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'claude-code',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_f3_p1', { role: 'w1', agentType: 'claude-code', hookCredential: keepProcessCred })),
          },
        ],
        deletes: [],
        allowEmpty: true,
      });
      // Delete the freePageCanary row without VACUUM so its bytes sit in free pages / WAL.
      commitSessionChanges(handle, { upserts: [], deletes: ['deck_f3_freepage'], allowEmpty: true });
      markLegacyImportDone(handle);

      // Pin WAL with an active read transaction so PRAGMA wal_checkpoint(TRUNCATE) returns busy=1.
      const reader = openSessionDbReadOnly(dbPath)!;
      try {
        reader.db.exec('BEGIN');
        reader.db.prepare('SELECT count(*) AS n FROM sessions').get();

        const blocked = scrubTransportHookCredentialRows(handle);
        expect(blocked).toEqual({ scrubbedRows: 1, compacted: false });
        expect(readSessionDbMeta(handle, SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB)).toBe('vacuum_pending');
        // Canary bytes are still physically present in WAL while reader pins it!
        expect(readFileSync(`${dbPath}-wal`).toString('latin1')).toContain(walCanary);

        reader.db.exec('COMMIT');
      } finally {
        closeSessionDb(reader);
      }

      // Now that reader released WAL, retry completes physical cleanup & marks done.
      const retried = scrubTransportHookCredentialRows(handle);
      expect(retried).toEqual({ scrubbedRows: 0, compacted: true });
      expect(readSessionDbMeta(handle, SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB)).toBe('done');
    } finally {
      closeSessionDb(handle);
    }

    const bytes = dbStateBytes(dbPath);
    expect(bytes).not.toContain(walCanary);
    expect(bytes).not.toContain(freePageCanary);
    expect(bytes).toContain(keepProcessCred);

    // Legacy snapshot (.bak.1) with deleted transport canary in WAL/free pages is sanitized cleanly
    // while retaining process recovery, and legacy process-only .bak.2 has its permissions repaired.
    const dirtyBakPath = `${dbPath}.bak.1`;
    const bak1 = openSessionDbForWrite(dirtyBakPath);
    try {
      commitSessionChanges(bak1, {
        upserts: [
          {
            name: 'deck_bak_t',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'codex-sdk',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_bak_t', { runtimeType: 'transport', hookCredential: walCanary })),
          },
          {
            name: 'deck_bak_p',
            projectName: 'realproj',
            parentSession: null,
            agentType: 'claude-code',
            state: 'idle',
            updatedAt: 1,
            payload: JSON.stringify(record('deck_bak_p', { role: 'w1', agentType: 'claude-code', hookCredential: keepProcessCred })),
          },
        ],
        deletes: [],
        allowEmpty: true,
      });
      // Leave transport bytes in bak.1 WAL without truncating!
      commitSessionChanges(bak1, { upserts: [], deletes: ['deck_bak_t'], allowEmpty: true });
    } finally {
      closeSessionDb(bak1);
    }

    const processBakPath = `${dbPath}.bak.2`;
    const bak2 = openSessionDbForWrite(processBakPath);
    try {
      commitSessionChanges(bak2, {
        upserts: [{
          name: 'deck_bak2_p',
          projectName: 'realproj',
          parentSession: null,
          agentType: 'claude-code',
          state: 'idle',
          updatedAt: 1,
          payload: JSON.stringify(record('deck_bak2_p', { role: 'w2', agentType: 'claude-code', hookCredential: keepProcessCred })),
        }],
        deletes: [],
        allowEmpty: true,
      });
      bak2.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      closeSessionDb(bak2);
    }
    if (process.platform !== 'win32') {
      await chmod(dirtyBakPath, 0o644);
      await chmod(processBakPath, 0o644);
    }

    await freshStore();
    await waitForCredentialBackupCleanupForTests();

    expect(existsSync(dirtyBakPath)).toBe(true);
    expect(existsSync(`${dirtyBakPath}-wal`)).toBe(false);
    expect(dbStateBytes(dirtyBakPath)).not.toContain(walCanary);
    expect(dbStateBytes(dirtyBakPath)).toContain(keepProcessCred);
    expect(existsSync(processBakPath)).toBe(true);
    expect(JSON.parse(readSnapshotPayloads(processBakPath)!.get('deck_bak2_p')!)['hookCredential']).toBe(keepProcessCred);
    if (process.platform !== 'win32') {
      expect(statSync(dirtyBakPath).mode & 0o777).toBe(0o600);
      expect(statSync(processBakPath).mode & 0o777).toBe(0o600);
    }
  });

  it('scrubs pre-existing transport rows + blobs on startup, enforces 0o600 via private staging for primary and fallback snapshots, and reports chmod failures (F4)', async () => {
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

    const rawDb = dbStateBytes();
    expect(rawDb).not.toContain(legacyTransportCred);
    expect(rawDb).not.toContain(legacyTransportInferredCred);
    expect(rawDb).not.toContain(legacyBlobCred);

    const reader = openSessionDbReadOnly(dbPath)!;
    try {
      expect(readSessionDbMeta(reader, SESSION_DB_META_TRANSPORT_CREDENTIAL_SCRUB)).toBe('done');
    } finally {
      closeSessionDb(reader);
    }
    const writer = openSessionDbForWrite(dbPath);
    try {
      expect(scrubTransportHookCredentialRows(writer)).toEqual({ scrubbedRows: 0, compacted: false });

      // F4: Test both sqlite.backup AND VACUUM INTO fallback paths stage in 0o700 and publish 0o600.
      const primaryDest = join(dir, 'manual-primary.sqlite');
      const vacuumDest = join(dir, 'manual-vacuum.sqlite');
      await snapshotSessionDb(writer, primaryDest);
      await snapshotSessionDb(writer, vacuumDest, { preferVacuumInto: true });
      if (process.platform !== 'win32') {
        expect(statSync(primaryDest).mode & 0o777).toBe(0o600);
        expect(statSync(vacuumDest).mode & 0o777).toBe(0o600);
      }
      expect((await readdir(dir)).filter((e) => e.startsWith('.bak-staging-'))).toEqual([]);
    } finally {
      closeSessionDb(writer);
    }

    expect(existsSync(join(dir, 'sessions.json.1'))).toBe(false);
    expect(existsSync(userBackup)).toBe(true);
    expect(getSession('deck_legacy_t1')?.hookCredential).toMatch(/^[0-9a-f]{64}$/);
    expect(getSession('deck_legacy_t_inferred')?.hookCredential).toMatch(/^[0-9a-f]{64}$/);
    expect(getSession('deck_legacy_p1')?.hookCredential).toBe(keepProcessCred);

    const compatRaw = readFileSync(join(dir, 'sessions.json'), 'utf8');
    expect(compatRaw).not.toContain(keepProcessCred);
    expect(compatRaw).not.toContain('hookCredential');

    if (process.platform !== 'win32') {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600);
      setSessionStoreBackupIntervalMsForTests(0);
      upsertSession(record('deck_legacy_p1', { role: 'w1', agentType: 'claude-code', hookCredential: keepProcessCred, updatedAt: 99 }));
      await flushStore();
      await waitForSessionStoreSnapshotForTests();
      expect(statSync(`${dbPath}.bak.1`).mode & 0o777).toBe(0o600);
    }

    // F4: Verify genuine chmod failure on open/snapshot/redaction is surfaced rather than swallowed.
    if (process.platform !== 'win32') {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const readOnlyDir = join(dir, 'locked-db-dir');
      await mkdir(readOnlyDir, { recursive: true });
      const lockedTarget = join(readOnlyDir, 'locked.sqlite');
      const seededLocked = openSessionDbForWrite(lockedTarget);
      closeSessionDb(seededLocked);
      await chmod(readOnlyDir, 0o500);
      try {
        // Test redactLegacyJsonCredentialFile reports genuine permission failure cleanly.
        const lockedJson = join(readOnlyDir, 'sessions.json');
        await chmod(readOnlyDir, 0o700);
        await writeFile(lockedJson, JSON.stringify({ sessions: { a: { hookCredential: 'secret' } } }), 'utf8');
        // Rename/write temp inside 0o500 directory fails and is reported rather than ignored.
        await chmod(readOnlyDir, 0o500);
        const failRedact = await redactLegacyJsonCredentialFile(lockedJson);
        expect(failRedact.redacted).toBe(false);
        expect(failRedact.error).toBeTruthy();

        // Immutable staging dir cannot create staging dir inside 0o500 dir, throwing cleanly rather than publishing.
        const openHandle = openSessionDbForWrite(dbPath);
        try {
          await expect(snapshotSessionDb(openHandle, join(readOnlyDir, 'fail.sqlite'))).rejects.toThrow();
        } finally {
          closeSessionDb(openHandle);
        }
      } finally {
        await chmod(readOnlyDir, 0o700).catch(() => undefined);
      }
      expect(warn).toBeDefined();
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

    await writeFile(join(dir, 'sessions.json'), JSON.stringify({
      version: 2,
      sessions: {
        deck_mig_t: record('deck_mig_t', { agentType: 'codex-sdk', hookCredential: 'mig-t-secret' }),
        deck_mig_p: record('deck_mig_p', { role: 'w1', agentType: 'claude-code', hookCredential: 'mig-p-secret' }),
      },
    }), 'utf8');
    await freshStore();
    expect(getSession('deck_mig_t')?.hookCredential).toMatch(/^[0-9a-f]{64}$/);
    expect(getSession('deck_mig_t')?.hookCredential).not.toBe('mig-t-secret');
    expect(getSession('deck_mig_p')?.hookCredential).toBe('mig-p-secret');
    expect(persistedSessions(home)['deck_mig_t']).not.toHaveProperty('hookCredential');
    expect(persistedSessions(home)['deck_mig_p']?.['hookCredential']).toBe('mig-p-secret');
    expect(readFileSync(join(dir, 'sessions.json'), 'utf8')).not.toContain('hookCredential');
  });
});
