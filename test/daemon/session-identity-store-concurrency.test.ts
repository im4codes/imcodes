/**
 * 158 (2026-10-08): the daemon-local identity store is one 33.5 MB JSON file (184 sessions, prompts of 250-550 KB). Every list/get
 * read and parsed ALL of it with `readFile(path, 'utf8')`, which decodes a big file in 512 KB chunks into a growing string, so
 * N concurrent readers held N half-built copies at once. About 200 concurrent callers (a server `get`, an MCP call or a launch per
 * session) took the heap from 200 MB to the 8 GB limit within seconds; the guard restarted the daemon four times, and the runtime's
 * own OOM report ended in `StringDecoder::DecodeData`.
 *
 * Reproduction at production shape (scoped home, 184 x 122 KB mixed Chinese/English profiles = 33.2 MB, 8 GB heap):
 *   readers   1: 92 MB peak | 20: 2.1 GB | 60: 4.0 GB | 120: 5.3 GB | ~200: heap OOM in StringDecoder::DecodeData
 *   after the fix: 50 MB peak at 1, 120 and 250 readers.
 * The assertions below are structural (how many times the file was read), never timing or heap-size thresholds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getLocalSessionIdentityProfile,
  identityStoreReadStatsForTests,
  isSessionIdentityMigrated,
  listLocalSessionIdentityProfiles,
  localSessionIdentityDbPath,
  localSessionIdentityStorePath,
  putLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfile,
  resetIdentityStoreCacheForTests,
} from '../../src/daemon/session-identity-local-store.js';
import { collectMemoryProbes } from '../../src/daemon/memory-probes.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imc-identity-concurrency-'));
  vi.stubEnv('IMCODES_HOME', home);
  resetIdentityStoreCacheForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await chmod(join(home, 'session-identities.json'), 0o600).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

/** A store shaped like 158's: one profile per session, prompts of ~122 KB with Chinese text (two-byte strings in memory). */
async function writeProductionShapedStore(sessions: number, contentChars: number): Promise<void> {
  const unit = '身份契约：你是一个严格遵循流程的工程师 agent。You must follow the pairing protocol. ';
  const profiles: Record<string, unknown> = {};
  for (let index = 0; index < sessions; index += 1) {
    const content = `${unit}${index}`.repeat(Math.ceil(contentChars / unit.length)).slice(0, contentChars);
    profiles[`session\0srv:s${index}`] = { scope: 'session', scopeKey: `srv:s${index}`, content, contentHash: `h${index}`, revision: 1, updatedAt: 1, source: 'web' };
  }
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'session-identities.json'), `${JSON.stringify({ version: 1, profiles })}\n`, { mode: 0o600 });
}

describe('identity store: concurrent readers share one read of the file', () => {
  it('250 concurrent gets and lists read and parse the file once, and every caller gets its own correct profile', async () => {
    await writeProductionShapedStore(184, 20_000);
    const gets = Array.from({ length: 250 }, (_, index) => getLocalSessionIdentityProfile('session', `srv:s${index % 184}`));
    const lists = Array.from({ length: 20 }, () => listLocalSessionIdentityProfiles());
    const [profiles, listed] = [await Promise.all(gets), await Promise.all(lists)];
    profiles.forEach((profile, index) => expect(profile?.scopeKey).toBe(`srv:s${index % 184}`));
    listed.forEach((list) => expect(list).toHaveLength(184));
    expect(identityStoreReadStatsForTests().loads).toBe(1);
  });

  it('later reads query SQLite directly by primary key without re-reading legacy JSON', async () => {
    await writeProductionShapedStore(8, 1_000);
    await getLocalSessionIdentityProfile('session', 'srv:s1');
    for (let round = 0; round < 5; round += 1) await getLocalSessionIdentityProfile('session', 'srv:s2');
    expect(identityStoreReadStatsForTests()).toMatchObject({ loads: 1, pkReads: 6, listScans: 0 });
  });

  it('returns copies: a caller editing its profile cannot change what the next reader sees', async () => {
    await writeProductionShapedStore(2, 100);
    const first = await getLocalSessionIdentityProfile('session', 'srv:s0');
    first!.content = 'tampered';
    expect((await getLocalSessionIdentityProfile('session', 'srv:s0'))!.content).not.toBe('tampered');
  });

  it('ignores external changes to legacy JSON once migrated while seeing direct SQLite writes immediately', async () => {
    await writeProductionShapedStore(3, 100);
    expect(await listLocalSessionIdentityProfiles()).toHaveLength(3);
    const file = join(home, 'session-identities.json');
    const prevStat = await stat(file);
    await writeProductionShapedStore(5, 100);
    // Force an identical mtime (same millisecond & inode) — SQLite remains authoritative and never wipes & reimports legacy JSON.
    await utimes(file, prevStat.atime, prevStat.mtime);
    expect(await listLocalSessionIdentityProfiles()).toHaveLength(3);

    // An independent SQLite writer's update is visible on the very next single-key get.
    const externalDb = new DatabaseSync(localSessionIdentityDbPath());
    externalDb.prepare(`
      INSERT OR REPLACE INTO session_identity_profiles
        (scope, scope_key, content, content_hash, revision, updated_at, source, source_file)
      VALUES ('session', 'srv:external', 'from-external-writer', 'hx', 7, 9999, 'mcp', NULL)
    `).run();
    externalDb.close();
    expect(await getLocalSessionIdentityProfile('session', 'srv:external')).toMatchObject({
      content: 'from-external-writer',
      revision: 7,
    });
  });

  it('a write is visible to the very next read without rewriting legacy JSON even when list reads run concurrently', async () => {
    await writeProductionShapedStore(50, 50_000);
    const jsonStatBefore = await stat(localSessionIdentityStorePath());
    const staleReaders = Array.from({ length: 30 }, () => listLocalSessionIdentityProfiles());
    const written = putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'after', source: 'mcp' });
    const second = putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-2', content: 'after-2', source: 'mcp' });
    await Promise.all([...staleReaders, written, second]);
    const after = await listLocalSessionIdentityProfiles();
    expect(after).toHaveLength(52);
    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'after' });
    expect(await getLocalSessionIdentityProfile('project', 'repo-2')).toMatchObject({ content: 'after-2' });
    await removeLocalSessionIdentityProfile('project', 'repo');
    expect(await listLocalSessionIdentityProfiles()).toHaveLength(51);

    // Legacy JSON stays untouched (zero full-file rewrite amplification); SQLite persists all 51 across cache reset.
    expect((await stat(localSessionIdentityStorePath())).mtimeMs).toBe(jsonStatBefore.mtimeMs);
    expect(Object.keys(JSON.parse(await readFile(localSessionIdentityStorePath(), 'utf8')).profiles)).toHaveLength(50);
    resetIdentityStoreCacheForTests();
    expect(await listLocalSessionIdentityProfiles()).toHaveLength(51);
  });

  it('a missing file reads as empty, and a file that is not JSON reads as empty and heals cleanly in SQLite', async () => {
    expect(await listLocalSessionIdentityProfiles()).toEqual([]);
    expect(await isSessionIdentityMigrated()).toBe(false);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'session-identities.json'), '{ not json');
    resetIdentityStoreCacheForTests();
    expect(await listLocalSessionIdentityProfiles()).toEqual([]);
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'healed', source: 'web' });
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'healed' });
  });

  it.skipIf(process.getuid?.() === 0)('a legacy store that cannot be READ never marks migration complete or loses unmigrated data', async () => {
    await writeProductionShapedStore(4, 100);
    const file = join(home, 'session-identities.json');
    const before = await readFile(file, 'utf8');
    await chmod(file, 0o000);
    await expect(putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'new', source: 'web' })).rejects.toThrow();
    await chmod(file, 0o600);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await listLocalSessionIdentityProfiles()).toHaveLength(4);
  });

  it('reports its read counters (numbers only) to the memory guard diagnostic with zero cached table bytes', async () => {
    await writeProductionShapedStore(2, 100);
    await listLocalSessionIdentityProfiles();
    const probe = collectMemoryProbes()['identityStore'];
    expect(probe).toMatchObject({ loads: 1, listScans: 1, cachedBytes: 0 });
  });

  it('supports concurrent multi-process SQLite writes without SQLITE_BUSY loss or revision regression', async () => {
    await mkdir(home, { recursive: true });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'shared-race', content: 'seed', source: 'mcp' });

    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const storeModuleUrl = new URL('../../src/daemon/session-identity-local-store.ts', import.meta.url).href;
    const workerScript = `
      const { putLocalSessionIdentityProfile } = await import(${JSON.stringify(storeModuleUrl)});
      const workerId = process.argv[1];
      await putLocalSessionIdentityProfile({
        scope: 'session',
        scopeKey: 'proc:' + workerId,
        content: 'owned-by-' + workerId,
        source: 'mcp',
      });
      await putLocalSessionIdentityProfile({
        scope: 'project',
        scopeKey: 'shared-race',
        content: 'updated-by-' + workerId,
        source: 'mcp',
      });
    `;

    await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map((workerId) =>
        execFileAsync(tsxBin, ['--input-type=module', '-e', workerScript, workerId], {
          env: { ...process.env, IMCODES_HOME: home },
        }),
      ),
    );

    const shared = await getLocalSessionIdentityProfile('project', 'shared-race');
    expect(shared?.revision).toBe(5);
    for (const workerId of ['w1', 'w2', 'w3', 'w4']) {
      expect(await getLocalSessionIdentityProfile('session', `proc:${workerId}`)).toMatchObject({
        content: `owned-by-${workerId}`,
        revision: 1,
      });
    }
  });
});
