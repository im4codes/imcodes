import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getLocalSessionIdentityProfile,
  identityStoreReadStatsForTests,
  listLocalSessionIdentityProfiles,
  localSessionIdentityDbPath,
  localSessionIdentityStorePath,
  pruneOrphanedSessionIdentityProfiles,
  putLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfile,
  removeSessionIdentitiesForSession,
  resetIdentityStoreCacheForTests,
} from '../../src/daemon/session-identity-local-store.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const home = mkdtempSync(join(tmpdir(), 'imcodes-identity-local-store-'));

beforeEach(async () => {
  resetIdentityStoreCacheForTests();
  await rm(home, { recursive: true, force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  resetIdentityStoreCacheForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('daemon-local session identity store', () => {
  it('writes content only below the configured scoped home and reopens atomically', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const saved = await putLocalSessionIdentityProfile({
      scope: 'user', scopeKey: '', content: '  local identity  ', source: 'web',
    });
    expect(saved.content).toBe('local identity');
    expect(saved.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(localSessionIdentityStorePath()).toBe(join(home, 'session-identities.json'));
    expect(localSessionIdentityDbPath()).toBe(join(home, 'session-identities.sqlite'));
    expect(existsSync(localSessionIdentityDbPath())).toBe(true);

    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'local identity', revision: 1 });
    expect(existsSync(localSessionIdentityStorePath())).toBe(false);
    resetIdentityStoreCacheForTests();
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'local identity', revision: 1 });
  });

  it.each(['project', 'session'] as const)('persists and reopens 500k code points for %s without accepting one more', async (scope) => {
    vi.stubEnv('IMCODES_HOME', home);
    const content = '😀'.repeat(500_000);
    const saved = await putLocalSessionIdentityProfile({ scope, scopeKey: 'limit-test', content, source: 'mcp' });
    expect(saved.content).toBe(content);

    resetIdentityStoreCacheForTests();
    expect(await getLocalSessionIdentityProfile(scope, 'limit-test')).toEqual(saved);
    await expect(putLocalSessionIdentityProfile({
      scope, scopeKey: 'limit-test', content: `${content}x`, source: 'mcp',
    })).rejects.toThrow('identity_content_too_large');

    resetIdentityStoreCacheForTests();
    expect(await getLocalSessionIdentityProfile(scope, 'limit-test')).toEqual(saved);
  });

  it('preserves independent scopes and removes only the requested key', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'user', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'project', source: 'mcp' });
    expect((await listLocalSessionIdentityProfiles()).map((profile) => profile.scope)).toEqual(['user', 'project']);
    await expect(removeLocalSessionIdentityProfile('user', '')).resolves.toBe(true);
    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'project' });
    expect(await getLocalSessionIdentityProfile('user', '')).toBeNull();
  });

  /**
   * Regression for the P0 the auditor found in round 1: every mutator did
   * readStore() -> mutate -> writeStore() on the WHOLE shared file with no
   * serialization. Firing two writes for DIFFERENT keys concurrently (no
   * await between them) used to interleave so the second writeStore() call
   * clobbered the file with a snapshot that never saw the first call's
   * change -- exactly the concurrency this feature exists to serve (an MCP
   * write racing a browser-triggered save, or two agent sessions writing
   * PROJECT vs SESSION scope on the same daemon). Fails on the pre-fix code
   * nondeterministically (one of the two entries goes missing); passes now
   * that every mutation is queued.
   */
  it('never loses a concurrent write for a different scope/scopeKey', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await Promise.all([
      putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-a', content: 'a', source: 'mcp' }),
      putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-b', content: 'b', source: 'mcp' }),
      putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'c', source: 'mcp' }),
    ]);
    const profiles = await listLocalSessionIdentityProfiles();
    expect(profiles.map((profile) => profile.content).sort()).toEqual(['a', 'b', 'c']);
  });

  it('prunes session-scoped profiles when sessions are not active, preserving user/project/pair', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-a', content: 'project', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'user', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:active_session', content: 'keep-me', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:dead_session', content: 'delete-me', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'dead_no_prefix', content: 'delete-me-too', source: 'mcp' });

    const removed = await pruneOrphanedSessionIdentityProfiles(new Set(['active_session']));
    expect(removed).toBe(2);

    const remaining = await listLocalSessionIdentityProfiles();
    expect(remaining.map((p) => p.content).sort()).toEqual(['keep-me', 'project', 'user']);
  });

  it('immediately purges session-scoped identity profiles when removeSessionIdentitiesForSession is called', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_sub_123', content: 'sub-identity', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'session', scopeKey: 'deck_sub_456', content: 'sub-identity-bare', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'keep-project', source: 'mcp' });

    expect(await getLocalSessionIdentityProfile('session', 'srv-1:deck_sub_123')).not.toBeNull();
    const deleted = await removeSessionIdentitiesForSession('deck_sub_123');
    expect(deleted).toBe(1);
    expect(await getLocalSessionIdentityProfile('session', 'srv-1:deck_sub_123')).toBeNull();

    const deletedBare = await removeSessionIdentitiesForSession('deck_sub_456');
    expect(deletedBare).toBe(1);
    expect(await getLocalSessionIdentityProfile('session', 'deck_sub_456')).toBeNull();

    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'keep-project' });
  });

  it('automatically migrates existing legacy session-identities.json into SQLite on first access', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });
    const legacy = {
      version: 1,
      profiles: {
        'user\0': { scope: 'user', scopeKey: '', content: 'legacy-user', contentHash: 'h1', revision: 3, updatedAt: 100, source: 'web' },
        'project\0my-repo': { scope: 'project', scopeKey: 'my-repo', content: 'legacy-project', contentHash: 'h2', revision: 2, updatedAt: 200, source: 'mcp' },
      },
      migratedAt: 12345678,
    };
    await writeFile(join(home, 'session-identities.json'), JSON.stringify(legacy));

    // Access store -- should auto-migrate into SQLite
    const profiles = await listLocalSessionIdentityProfiles();
    expect(profiles).toHaveLength(2);
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'legacy-user', revision: 3 });
    expect(await getLocalSessionIdentityProfile('project', 'my-repo')).toMatchObject({ content: 'legacy-project', revision: 2 });
    expect(existsSync(localSessionIdentityDbPath())).toBe(true);
  });

  it('stops rewriting legacy JSON after migration, serves single-key gets without full-table scans, and keeps WAL bounded', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });
    const legacyPath = join(home, 'session-identities.json');
    const legacyRaw = JSON.stringify({
      version: 1,
      profiles: {
        'user\0': { scope: 'user', scopeKey: '', content: 'seed-user', contentHash: 'h0', revision: 1, updatedAt: 100, source: 'web' },
      },
      migratedAt: 1000,
    });
    await writeFile(legacyPath, legacyRaw);
    const beforeStat = await stat(legacyPath);

    // First read migrates legacy JSON once.
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'seed-user', revision: 1 });
    const statsBeforeGets = identityStoreReadStatsForTests();
    expect(statsBeforeGets.loads).toBe(1);

    // Subsequent writes + single-key reads do not rewrite legacy JSON and do not full-scan the table.
    const largePayload = 'X'.repeat(350_000);
    for (let i = 0; i < 35; i += 1) {
      await putLocalSessionIdentityProfile({
        scope: 'session',
        scopeKey: `srv-1:sess-${i % 8}`,
        content: `${i}:${largePayload}`,
        source: 'mcp',
      });
    }
    const readOne = await getLocalSessionIdentityProfile('session', 'srv-1:sess-3');
    expect(readOne?.revision).toBeGreaterThanOrEqual(4);

    const statsAfter = identityStoreReadStatsForTests();
    expect(statsAfter.listScans).toBe(0);
    expect(statsAfter.pkReads).toBe(2);
    expect(statsAfter.walCheckpoints).toBeGreaterThan(0);

    const afterStat = await stat(legacyPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyRaw);

    const walPath = `${localSessionIdentityDbPath()}-wal`;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    // Cumulative writes exceeded 12 MB; bounded WAL limit (8 MB) + checkpoint keeps WAL small.
    expect(walBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 512 * 1024);
  });

  it('truncates pre-existing bloated historical WAL on startup open', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });

    // Seed a valid store, then append >9 MB of uncheckpointed WAL frames from a raw connection.
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'seed', source: 'web' });
    resetIdentityStoreCacheForTests();

    const dbPath = localSessionIdentityDbPath();
    // Hold an open read transaction while writing from a second connection so SQLite retains the >8 MB WAL on close.
    const pinReader = new DatabaseSync(dbPath);
    pinReader.exec('BEGIN; SELECT count(*) FROM session_identity_profiles;');

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    const bigText = 'W'.repeat(400_000);
    const stmt = rawDb.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES ('session', ?, ?, 'h', 1, 1000, 'mcp', NULL)
    `);
    for (let i = 0; i < 28; i += 1) {
      stmt.run(`bloat-${i}`, bigText);
    }
    rawDb.close();
    pinReader.exec('ROLLBACK');

    const walPath = `${dbPath}-wal`;
    const bloatedWalBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(bloatedWalBytes).toBeGreaterThan(8 * 1024 * 1024);

    // Opening via the store runs startup checkpoint(TRUNCATE) and shrinks the WAL.
    expect(await getLocalSessionIdentityProfile('session', 'bloat-5')).toMatchObject({ content: bigText });
    pinReader.close();
    const shrunkWalBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(shrunkWalBytes).toBeLessThan(1024 * 1024);
  });

  it('does not block on startup when a concurrent reader pins a bloated WAL, and auto-truncates once the read lock drops without user writes', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });

    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'seed', source: 'web' });
    resetIdentityStoreCacheForTests();

    const dbPath = localSessionIdentityDbPath();
    const pinReader = new DatabaseSync(dbPath);
    pinReader.exec('BEGIN; SELECT count(*) FROM session_identity_profiles;');

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    const bigText = 'Z'.repeat(400_000);
    const stmt = rawDb.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES ('session', ?, ?, 'h', 1, 1000, 'mcp', NULL)
    `);
    for (let i = 0; i < 28; i += 1) {
      stmt.run(`locked-bloat-${i}`, bigText);
    }
    rawDb.close();

    const walPath = `${dbPath}-wal`;
    expect(statSync(walPath).size).toBeGreaterThan(8 * 1024 * 1024);

    // 1. Open while pinReader holds an active read snapshot -> read succeeds immediately (never waits 5s busy_timeout).
    const startedAt = Date.now();
    try {
      expect(await getLocalSessionIdentityProfile('session', 'locked-bloat-3')).toMatchObject({ content: bigText });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(statSync(walPath).size).toBeGreaterThan(8 * 1024 * 1024);

      // 2. Release read snapshot with ZERO subsequent user writes -> coalesced maintenance shrinks WAL automatically.
      pinReader.exec('ROLLBACK');
      await vi.waitFor(() => {
        const size = existsSync(walPath) ? statSync(walPath).size : 0;
        expect(size).toBeLessThan(1024 * 1024);
      }, { timeout: 3_000 });

      // 3. Subsequent writes and reads keep monotonic revision and normal busy_timeout intact.
      const w1 = await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'after-truncate-1', source: 'mcp' });
      const w2 = await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'after-truncate-2', source: 'mcp' });
      expect(w1.revision).toBe(2);
      expect(w2.revision).toBe(3);
      expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'after-truncate-2', revision: 3 });
    } finally {
      try { pinReader.close(); } catch { /* ignore */ }
    }
  });

  it('continues steady low-frequency background WAL truncate after initial backoff window and shrinks once unlocked during idle', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await mkdir(home, { recursive: true });

    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'seed', source: 'web' });
    resetIdentityStoreCacheForTests();

    const dbPath = localSessionIdentityDbPath();
    const pinReader = new DatabaseSync(dbPath);
    pinReader.exec('BEGIN; SELECT count(*) FROM session_identity_profiles;');

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    const bigText = 'Q'.repeat(400_000);
    const stmt = rawDb.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES ('session', ?, ?, 'h', 1, 1000, 'mcp', NULL)
    `);
    for (let i = 0; i < 28; i += 1) {
      stmt.run(`long-lock-${i}`, bigText);
    }
    rawDb.close();

    const walPath = `${dbPath}-wal`;
    expect(statSync(walPath).size).toBeGreaterThan(8 * 1024 * 1024);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      expect(await getLocalSessionIdentityProfile('session', 'long-lock-2')).toMatchObject({ content: bigText });
      expect(statSync(walPath).size).toBeGreaterThan(8 * 1024 * 1024);

      // Hold the read lock past the entire prior 8-attempt exponential window (~12.7s) -> 30s idle.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statSync(walPath).size).toBeGreaterThan(8 * 1024 * 1024);
      expect(vi.getTimerCount()).toBe(1);

      // Release the read snapshot after the backoff ceiling was reached, calling NO further store APIs.
      pinReader.exec('ROLLBACK');
      await vi.advanceTimersByTimeAsync(5_500);

      const finalWalBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      expect(finalWalBytes).toBeLessThan(1024 * 1024);
      // Maintenance stops scheduling once the WAL shrinks below threshold.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      try { pinReader.close(); } catch { /* ignore */ }
    }
  });
});
