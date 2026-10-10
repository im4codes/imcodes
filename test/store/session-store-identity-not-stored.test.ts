/**
 * 158 / owner (2026-10-07): "the 250-550 KB identity prompt does not need to be in sqlite -- do not store it".
 *
 * The identity prompt is derived data (the user / project / session profiles rendered when a session launches). A session
 * record keeps only two short digests; nothing -- row, blob table, snapshot, export, write-ahead log -- may hold the text.
 * Rows an older build wrote are cleaned on the first start (and on every later start that finds one), the freed bytes are
 * compacted away, and the old copies the daemon's own rotation left beside the database are removed after that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configureSessionStoreWriteAuthority,
  flushStore,
  getSession,
  loadStore,
  resetIdentityBackupCleanupForTests,
  resetSessionStoreAuthorityForTests,
  upsertSession,
  waitForCompatExportForTests,
  waitForIdentityBackupCleanupForTests,
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
  scrubStoredIdentityRows,
  setSessionDbFailAfterRowWritesForTests,
} from '../../src/store/session-store-db.js';
import { externalizeSessionRecord, hydrateSessionRecord } from '../../src/store/session-record-blobs.js';
import { cleanupIdentityBackups, fileContainsText, rotationProductNames } from '../../src/store/session-identity-backups.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { identityContentHash, identityPromptHash } from '../../src/util/identity-prompt-hash.js';
import logger from '../../src/util/logger.js';
import {
  LEGACY_JSON_BACKUP_COUNT,
  SESSION_DB_BACKUP_COUNT,
  SESSION_DB_META_IDENTITY_SCRUB,
} from '../../shared/session-store-compat.js';
import { persistedSessionBlobs, persistedSessions, sessionDbPathForHome } from '../helpers/session-store-db.js';

let home = '';
let dir = '';

const CANARY = 'IDENTITY-CANARY-7f3a91';
/** ~500 KB of CJK text with the canary in it (the shape of the 158 contracts). */
function bigIdentity(seed: string, session?: string): string {
  const unit = '软件开发前置资料流程规则基线契约依据分层判准取值怎么实测到什么数；';
  let body = '';
  while (body.length < 250_000) body += `${seed}-${body.length}:${unit}\n`;
  const sessionSection = session ? `\n<session>\n${session}\n</session>` : '';
  return `<imcodes-agent-identity>\n<user>\n${CANARY}-${seed}\n${body}\n</user>${sessionSection}\n</imcodes-agent-identity>`;
}
function record(name: string, extra: Record<string, unknown> = {}): SessionRecord {
  return {
    name, projectName: 'realproj', role: 'w1', agentType: 'codex-sdk', projectDir: '/home/user/work/realproj',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
async function freshStore(): Promise<void> {
  resetSessionStoreAuthorityForTests();
  resetIdentityBackupCleanupForTests();
  configureSessionStoreWriteAuthority(currentDaemonProcessIdentity());
  await loadStore({ probe: false });
}
function bytesOfStateFiles(): string {
  const parts: string[] = [];
  for (const suffix of ['', '-wal']) {
    const path = `${sessionDbPathForHome(home)}${suffix}`;
    if (existsSync(path)) parts.push(readFileSync(path).toString('latin1'));
  }
  return parts.join('\n');
}
/** The latin1 form of the canary (the text is UTF-8 in the file; the ASCII canary is byte-identical). */
const hasCanary = (bytes: string): boolean => bytes.includes(CANARY);

/** Rows as the PREVIOUS builds wrote them: inline prompts, and prompts by reference into the blob table. */
function seedLegacyDatabase(): { inline: string; referenced: string; provisioned: string; sessionText: string } {
  const inline = bigIdentity('inline');
  const referenced = bigIdentity('ref');
  const sessionText = 'You are the release engineer.';
  const provisioned = bigIdentity('prov', sessionText);
  const handle = openSessionDbForWrite(sessionDbPathForHome(home));
  try {
    const row = (name: string, payload: Record<string, unknown>, blobs: Array<{ hash: string; text: string }> = []) => ({
      name, projectName: 'realproj', parentSession: null, agentType: 'codex-sdk', state: 'idle', updatedAt: 1,
      payload: JSON.stringify({ ...record(name), ...payload }), blobs,
    });
    const refHash = 'a'.repeat(32);
    commitSessionChanges(handle, {
      upserts: [
        row('deck_inline_brain', { identityPrompt: inline }),
        row('deck_ref_brain', { identityPromptRef: refHash }, [{ hash: refHash, text: referenced }]),
        row('deck_prov_w1', { identityPrompt: provisioned }),
        row('deck_hashed_w2', { identityPrompt: provisioned, provisionedIdentityHash: 'kept-existing-hash', appliedIdentityHash: 'kept-applied' }),
        row('deck_plain_w3', { description: 'no identity here' }),
      ],
      deletes: [], allowEmpty: true,
    });
    markLegacyImportDone(handle); // a database of the SQLite build: sessions.json was imported long ago
    handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { closeSessionDb(handle); }
  return { inline, referenced, provisioned, sessionText };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-identity-not-stored-'));
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
  await waitForSessionStoreSnapshotForTests().catch(() => undefined);
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('a session record never stores the identity prompt', () => {
  it('a 500 KB identity on 40 sessions reaches no row, blob, snapshot, export or log; the database does not grow with it', async () => {
    await freshStore();
    upsertSession(record('deck_baseline_brain'));
    await flushStore();
    const baselineBytes = statSync(sessionDbPathForHome(home)).size;

    for (let index = 0; index < 40; index += 1) {
      upsertSession(record(`deck_p${index}_brain`, { identityPrompt: bigIdentity(`s${index % 4}`), appliedIdentityHash: 'digest' } as Record<string, unknown>));
    }
    await flushStore();
    await waitForCompatExportForTests();
    await waitForSessionStoreSnapshotForTests();

    const persisted = persistedSessions(home);
    expect(Object.keys(persisted)).toHaveLength(41);
    for (const [name, row] of Object.entries(persisted)) {
      expect(row, name).not.toHaveProperty('identityPrompt');
      expect(row, name).not.toHaveProperty('identityPromptRef');
      expect(JSON.stringify(row).length, name).toBeLessThan(2_000);
    }
    expect(persistedSessionBlobs(home).size).toBe(0);
    // Nothing on disk anywhere in the state directory holds the text (database, write-ahead log, snapshot, export).
    for (const file of await readdir(dir)) {
      if (!file.startsWith('sessions.')) continue;
      expect(hasCanary(readFileSync(join(dir, file)).toString('latin1')), file).toBe(false);
    }
    // The size does not follow the identity size: 40 sessions x 500 KB would be 20 MB.
    expect(statSync(sessionDbPathForHome(home)).size - baselineBytes).toBeLessThan(512 * 1024);
    // The export an older build reads has no prompt and no identityPrompts table.
    const exported = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as Record<string, unknown>;
    expect(exported).not.toHaveProperty('identityPrompts');
    // The record handed back by the store has no prompt either, after a reload.
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_p3_brain')).toBeDefined();
    expect(getSession('deck_p3_brain')).not.toHaveProperty('identityPrompt');
  });

  it('the digests are kept: appliedIdentityHash survives a reload', async () => {
    await freshStore();
    upsertSession(record('deck_digest_brain', { appliedIdentityHash: identityPromptHash('whatever') }));
    await flushStore();
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_digest_brain')?.appliedIdentityHash).toBe(identityPromptHash('whatever'));
  });
});

describe('migration of a database an older build wrote', () => {
  it('removes inline and referenced prompts, keeps digests, and leaves no byte of the text in the database or its log', async () => {
    const seeded = seedLegacyDatabase();
    // The counterexample that makes the assertions below mean something: the text IS in the file before the migration.
    expect(hasCanary(bytesOfStateFiles())).toBe(true);
    const sizeBefore = statSync(sessionDbPathForHome(home)).size;
    expect(sizeBefore).toBeGreaterThan(1_500_000);

    await freshStore();

    const persisted = persistedSessions(home);
    expect(Object.keys(persisted).sort()).toEqual(['deck_hashed_w2', 'deck_inline_brain', 'deck_plain_w3', 'deck_prov_w1', 'deck_ref_brain']);
    for (const [name, row] of Object.entries(persisted)) {
      expect(row, name).not.toHaveProperty('identityPrompt');
      expect(row, name).not.toHaveProperty('identityPromptRef');
    }
    expect(persisted['deck_inline_brain']!['appliedIdentityHash']).toBe(identityPromptHash(seeded.inline));
    expect(persisted['deck_ref_brain']!['appliedIdentityHash']).toBe(identityPromptHash(seeded.referenced));
    // An Agent provisioned with a session identity is still found by the same request: its section's hash is stamped.
    expect(persisted['deck_prov_w1']!['provisionedIdentityHash']).toBe(identityContentHash(seeded.sessionText));
    // A hash that was already there is never overwritten.
    expect(persisted['deck_hashed_w2']).toMatchObject({ provisionedIdentityHash: 'kept-existing-hash', appliedIdentityHash: 'kept-applied' });
    expect(persisted['deck_plain_w3']).not.toHaveProperty('appliedIdentityHash');
    expect(persistedSessionBlobs(home).size).toBe(0);
    // Privacy: the freed pages are compacted away and the log is truncated.
    expect(hasCanary(bytesOfStateFiles())).toBe(false);
    expect(statSync(sessionDbPathForHome(home)).size).toBeLessThan(sizeBefore / 10);
    // And the loaded records never expose a prompt.
    for (const name of Object.keys(persisted)) expect(getSession(name), name).not.toHaveProperty('identityPrompt');
    const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
    try { expect(readSessionDbMeta(reader, SESSION_DB_META_IDENTITY_SCRUB)).toBe('done'); } finally { closeSessionDb(reader); }
  });

  it('is idempotent: a second start changes nothing, and a prompt an older build writes after a downgrade is cleaned again', async () => {
    seedLegacyDatabase();
    await freshStore();
    const after = JSON.stringify(persistedSessions(home));
    const handle = openSessionDbForWrite(sessionDbPathForHome(home));
    try {
      expect(scrubStoredIdentityRows(handle)).toEqual({ scrubbedRows: 0, compacted: false });
    } finally { closeSessionDb(handle); }
    await freshStore();
    expect(JSON.stringify(persistedSessions(home))).toBe(after);

    // Downgrade, run the old build for a while, upgrade again.
    const old = openSessionDbForWrite(sessionDbPathForHome(home));
    try {
      commitSessionChanges(old, {
        upserts: [{ name: 'deck_regress_brain', projectName: 'realproj', parentSession: null, agentType: 'codex-sdk', state: 'idle', updatedAt: 1, payload: JSON.stringify({ ...record('deck_regress_brain'), identityPrompt: bigIdentity('regress') }) }],
        deletes: [], allowEmpty: true,
      });
    } finally { closeSessionDb(old); }
    expect(hasCanary(bytesOfStateFiles())).toBe(true);
    await freshStore();
    expect(persistedSessions(home)['deck_regress_brain']).not.toHaveProperty('identityPrompt');
    expect(hasCanary(bytesOfStateFiles())).toBe(false);
  });

  it('a failure in the middle changes nothing (one transaction), reports it, starts anyway, and the next start finishes the job', async () => {
    seedLegacyDatabase();
    const before = JSON.stringify(persistedSessions(home));
    const error = vi.spyOn(logger, 'error');
    setSessionDbFailAfterRowWritesForTests(2); // the third row write fails, as a full disk would
    await freshStore();
    expect(JSON.stringify(persistedSessions(home))).toBe(before); // rolled back: not one row half-cleaned
    expect(error.mock.calls.some(([, message]) => String(message).includes('Stored identity prompts could not be removed'))).toBe(true);
    // The store still loads, and what it hands out has no prompt.
    expect(getSession('deck_inline_brain')).toBeDefined();
    expect(getSession('deck_inline_brain')).not.toHaveProperty('identityPrompt');

    setSessionDbFailAfterRowWritesForTests(null);
    await freshStore();
    for (const row of Object.values(persistedSessions(home))) expect(row).not.toHaveProperty('identityPrompt');
    expect(hasCanary(bytesOfStateFiles())).toBe(false);
  });

  it('whoever reads a row that still holds a prompt (a process that cannot clean it) gets the record without it', () => {
    const inline = hydrateSessionRecord({ name: 'a', identityPrompt: bigIdentity('x') }, () => undefined);
    expect(inline).not.toHaveProperty('identityPrompt');
    const referenced = hydrateSessionRecord({ name: 'b', identityPromptRef: 'a'.repeat(32) }, () => bigIdentity('y'));
    expect(referenced).not.toHaveProperty('identityPrompt');
    expect(referenced).not.toHaveProperty('identityPromptRef');
    expect(externalizeSessionRecord({ name: 'c', identityPrompt: bigIdentity('z'), description: 'd' }).payload).toBe('{"name":"c","description":"d"}');
  });

  it('an older build reading the migrated database finds valid sessions that merely lack an identity (it derives or omits it)', async () => {
    seedLegacyDatabase();
    await freshStore();
    // What the previous build does with a row: parse it, look for identityPromptRef / identityPrompt, use what it finds.
    const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
    try {
      const rows = reader.db.prepare('SELECT payload FROM sessions').all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(5);
      for (const { payload } of rows) {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        expect(typeof parsed['name']).toBe('string');
        expect(parsed['identityPromptRef']).toBeUndefined();
        expect(parsed['identityPrompt']).toBeUndefined();
      }
    } finally { closeSessionDb(reader); }
  });
});

describe('the old copies the daemon itself rotated beside the database', () => {
  const MARKED = `{"sessions":{"a":{"identityPrompt":"${CANARY} old copy"}}}`;
  const REFERENCED = '{"sessions":{"a":{"identityPromptRef":"0123456789abcdef0123456789abcdef"}},"identityPrompts":{}}';
  const CLEAN = '{"sessions":{"a":{"name":"a"}}}';
  const UUID = '123e4567-e89b-12d3-a456-426614174000';

  async function seedBackupSet(): Promise<{ rotation: string[]; cleanRotation: string[]; foreign: string[] }> {
    const db = sessionDbPathForHome(home);
    const rotation = [`${db}.bak.1`, `${db}.bak.3`, `${db}.bak.tmp`, join(dir, 'sessions.json.1'), join(dir, 'sessions.json.4'), join(dir, `sessions.json.4242.${UUID}.tmp`)];
    const cleanRotation = [`${db}.bak.2`, join(dir, 'sessions.json.2')];
    const foreign = [
      join(dir, 'sessions.json.backup-20260901'), join(dir, 'sessions.json.pre-final-clean'),
      join(dir, 'sessions.json.migrated-to-sqlite'), join(dir, 'sessions.json.empty-at-1789000000'), join(dir, 'sessions.sqlite.hand-made'),
    ];
    for (const path of rotation) await writeFile(path, path.endsWith('.4') ? REFERENCED : MARKED);
    for (const path of cleanRotation) await writeFile(path, CLEAN);
    for (const path of foreign) await writeFile(path, MARKED);
    return { rotation, cleanRotation, foreign };
  }

  it('after the migration committed: rotation products that hold a prompt are deleted, clean ones and everything else stay', async () => {
    seedLegacyDatabase();
    const files = await seedBackupSet();
    const info = vi.spyOn(logger, 'info');
    await freshStore();
    await waitForIdentityBackupCleanupForTests();

    for (const path of files.rotation) expect(existsSync(path), path).toBe(false);
    for (const path of [...files.cleanRotation, ...files.foreign]) expect(existsSync(path), path).toBe(true);
    // The non-rotation files are only listed, with sizes.
    const listing = info.mock.calls.find(([, message]) => String(message).includes('left untouched'));
    expect(listing).toBeDefined();
    const listed = (listing![0] as { files: Array<{ name: string; bytes: number }> }).files.map((file) => file.name).sort();
    expect(listed).toEqual(['sessions.json.backup-20260901', 'sessions.json.empty-at-1789000000', 'sessions.json.migrated-to-sqlite', 'sessions.json.pre-final-clean', 'sessions.sqlite.hand-made']);
    // The live files are never candidates.
    expect(existsSync(sessionDbPathForHome(home))).toBe(true);
  });

  it('is idempotent: a second start removes and lists nothing new', async () => {
    seedLegacyDatabase();
    await seedBackupSet();
    await freshStore();
    await waitForIdentityBackupCleanupForTests();
    const before = (await readdir(dir)).sort();
    const info = vi.spyOn(logger, 'info');
    await freshStore();
    await waitForIdentityBackupCleanupForTests();
    expect((await readdir(dir)).filter((name) => name.startsWith('sessions.')).sort()).toEqual(before.filter((name) => name.startsWith('sessions.')));
    expect(info.mock.calls.some(([, message]) => String(message).includes('Removed old session backups'))).toBe(false);
  });

  it('a file that cannot be deleted never stops the start; it is reported and the next start deletes it', async () => {
    seedLegacyDatabase();
    const files = await seedBackupSet();
    const warn = vi.spyOn(logger, 'warn');
    resetSessionStoreAuthorityForTests();
    resetIdentityBackupCleanupForTests({ removeFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    configureSessionStoreWriteAuthority(currentDaemonProcessIdentity());
    const store = await loadStore({ probe: false });
    await waitForIdentityBackupCleanupForTests();
    expect(Object.keys(store.sessions)).toHaveLength(5); // started normally
    for (const path of files.rotation) expect(existsSync(path), path).toBe(true);
    expect(warn.mock.calls.some(([, message]) => String(message).includes('could not be removed'))).toBe(true);

    await freshStore(); // the real removal, as the next start
    await waitForIdentityBackupCleanupForTests();
    for (const path of files.rotation) expect(existsSync(path), path).toBe(false);
  });

  it('nothing is deleted when the migration did not commit', async () => {
    seedLegacyDatabase();
    const files = await seedBackupSet();
    setSessionDbFailAfterRowWritesForTests(1);
    await freshStore();
    await waitForIdentityBackupCleanupForTests();
    for (const path of [...files.rotation, ...files.cleanRotation, ...files.foreign]) expect(existsSync(path), path).toBe(true);
  });

  it('the newest snapshot being removed lets the very next flush write a clean one', async () => {
    seedLegacyDatabase();
    await seedBackupSet();
    await freshStore();
    await waitForIdentityBackupCleanupForTests();
    expect(existsSync(`${sessionDbPathForHome(home)}.bak.1`)).toBe(false);
    upsertSession(record('deck_after_cleanup_brain'));
    await flushStore();
    await waitForSessionStoreSnapshotForTests();
    const fresh = `${sessionDbPathForHome(home)}.bak.1`;
    expect(existsSync(fresh)).toBe(true);
    expect(hasCanary(readFileSync(fresh).toString('latin1'))).toBe(false);
  });

  it('only names built from the daemon rotation constants are candidates', () => {
    const names = rotationProductNames('sessions.sqlite', 'sessions.json', [
      `sessions.json.4242.${UUID}.tmp`, 'sessions.json.backup-1', 'sessions.json.tmp', 'sessions.json.1x', `sessions.json.${UUID}.tmp`, 'other.json.1',
    ]);
    expect(names.sort()).toEqual([
      ...Array.from({ length: SESSION_DB_BACKUP_COUNT }, (_, index) => `sessions.sqlite.bak.${index + 1}`),
      'sessions.sqlite.bak.tmp',
      ...Array.from({ length: LEGACY_JSON_BACKUP_COUNT }, (_, index) => `sessions.json.${index + 1}`),
      `sessions.json.4242.${UUID}.tmp`,
    ].sort());
  });

  // Creating a symlink needs a privilege a Windows runner may not have; the rule it pins is platform-independent.
  it.skipIf(process.platform === 'win32')('does not follow a link out of the state directory', async () => {
    const outside = join(home, 'outside.txt');
    await writeFile(outside, MARKED);
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(dir, 'sessions.json.1'));
    const result = await cleanupIdentityBackups(sessionDbPathForHome(home), join(dir, 'sessions.json'));
    expect(result.removed).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('scanning a file for the marker', () => {
  it('finds it across a read-chunk boundary and in a file larger than one chunk, and reports its absence', async () => {
    const needle = '"identityPromptRef"';
    const chunk = 1024 * 1024;
    const across = join(home, 'across.bin');
    await writeFile(across, Buffer.concat([Buffer.alloc(chunk - 5, 0x61), Buffer.from(needle), Buffer.alloc(chunk, 0x62)]));
    expect(await fileContainsText(across, needle)).toBe(true);
    const absent = join(home, 'absent.bin');
    await writeFile(absent, Buffer.alloc(chunk * 2 + 3, 0x63));
    expect(await fileContainsText(absent, needle)).toBe(false);
    const empty = join(home, 'empty.bin');
    await writeFile(empty, '');
    expect(await fileContainsText(empty, needle)).toBe(false);
    await utimes(empty, new Date(), new Date());
  });
});
