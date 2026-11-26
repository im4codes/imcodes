/**
 * 158 (2026-10-07): after the SQLite migration every session row carried its OWN copy of a 250-550 KB string
 * (the identity prompt, 117 of 180 sessions, nine distinct texts): the store went from 8.4 MB to 84 MB, and every
 * sweep / compatibility export serialised 45 MB on the main thread (a 1.2 s event-loop stall, every few seconds).
 * The identity prompt is no longer stored at all (session-store-identity-not-stored.test.ts); what stays here is the
 * bound for ANY other large field, pinned with `description`: large string fields are stored ONCE (blob table), rows keep
 * a reference; old inline rows still load and are rewritten as references; unreferenced blobs are dropped; the
 * compatibility export stays readable by older builds; no row ever holds a long inline string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configureSessionStoreWriteAuthority,
  flushStore,
  getSession,
  loadStore,
  removeSession,
  resetSessionStoreAuthorityForTests,
  sessionStoreCommittedBytesForTests,
  upsertSession,
  waitForCompatExportForTests,
  waitForSessionStoreSnapshotForTests,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { hashSessionBlob, internSessionText, resetSessionBlobCachesForTests, sessionBlobCacheStatsForTests } from '../../src/store/session-record-blobs.js';
import { SESSION_BLOB_CACHE_MAX_CHARS } from '../../shared/daemon-memory-guard.js';
import { SESSION_DB_VACUUM_MIN_FREE_BYTES } from '../../shared/session-store-compat.js';
import { closeSessionDb, commitSessionChanges, openSessionDbForWrite, openSessionDbReadOnly, readSessionStoreSnapshot, vacuumSessionDbIfFragmented } from '../../src/store/session-store-db.js';
import { existsSync, statSync } from 'node:fs';
import { SESSION_RECORD_INLINE_STRING_MAX_CHARS } from '../../shared/session-store-compat.js';
import { persistedSessionBlobs, persistedSessions, replacePersistedSessions, sessionDbPathForHome } from '../helpers/session-store-db.js';

let home = '';
let dir = '';

function cjk(chars: number, seed: number): string {
  let out = '';
  const unit = '软件开发前置资料流程规则基线契约依据分层判准取值怎么实测到什么数；';
  while (out.length < chars) out += `${seed}-${out.length}:${unit}\n`;
  return out.slice(0, chars);
}
const NAMES = (count: number) => Array.from({ length: count }, (_, index) => `deck_p${index % 20}_w${index}`);
function record(name: string, extra: Record<string, unknown> = {}): SessionRecord {
  return {
    name, projectName: 'realproj', role: 'w1', agentType: 'codex-sdk', projectDir: '/home/user/work/realproj',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}
async function freshStore(): Promise<void> {
  resetSessionStoreAuthorityForTests();
  configureSessionStoreWriteAuthority(currentDaemonProcessIdentity());
  await loadStore({ probe: false });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-store-blobs-'));
  dir = join(home, '.imcodes');
  await mkdir(dir, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('IMCODES_HOME', dir);
  resetSessionStoreAuthorityForTests();
  resetSessionBlobCachesForTests();
});
afterEach(async () => {
  await waitForSessionStoreSnapshotForTests().catch(() => undefined);
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('a large field is stored once, not once per record', () => {
  it('158 shape: 117 of 180 sessions share nine 250-550 KB values of one field -> nine blobs, tiny rows, small files', async () => {
    await freshStore();
    const prompts = Array.from({ length: 9 }, (_, index) => cjk(250_000 + index * 35_000, index));
    const names = NAMES(180);
    names.forEach((name, index) => upsertSession(record(name, index < 117 ? { description: prompts[index % 9] } : {})));
    await flushStore();
    await waitForCompatExportForTests();

    const persisted = persistedSessions(home);
    expect(Object.keys(persisted)).toHaveLength(180);
    expect(persistedSessionBlobs(home).size).toBe(9);
    // What every sweep compares and every export concatenates: kilobytes, not the 45 MB it was.
    const committed = sessionStoreCommittedBytesForTests();
    expect(committed.rows).toBe(180);
    expect(committed.payloadBytes).toBeLessThan(180 * 1_500);
    expect(committed.blobs).toBe(9);
    // The database is a few MB (the 9 distinct texts), not 84 MB. (The older-build export inlines such a field for readers
    // that know no blob table, and is skipped past its size budget: session-store-compat-budget.test.ts.)
    expect((await stat(sessionDbPathForHome(home))).size).toBeLessThan(12 * 1024 * 1024);
    // Invariant for the whole class: no persisted row holds a long inline string.
    for (const [name, entry] of Object.entries(persisted)) {
      for (const [field, value] of Object.entries(entry)) {
        if (typeof value === 'string') expect(value.length, `${name}.${field}`).toBeLessThanOrEqual(SESSION_RECORD_INLINE_STRING_MAX_CHARS);
      }
    }
  });

  it('reload gives every session its exact text back, and sessions with the same text still have the same text', async () => {
    await freshStore();
    const prompts = [cjk(300_000, 1), cjk(280_000, 2)];
    NAMES(10).forEach((name, index) => upsertSession(record(name, { description: prompts[index % 2] })));
    await flushStore();
    resetSessionStoreAuthorityForTests();
    await freshStore();
    NAMES(10).forEach((name, index) => expect(getSession(name)?.description === prompts[index % 2], name).toBe(true));
    expect(getSession(NAMES(10)[0]!)?.description).not.toBe(getSession(NAMES(10)[1]!)?.description);
  });

  it('small values stay inline; a long value of ANY field is externalised', async () => {
    await freshStore();
    const description = cjk(30_000, 7);
    upsertSession(record('deck_small_brain', { label: 'short label', description: 'short' }));
    upsertSession(record('deck_big_brain', { description }));
    await flushStore();
    const persisted = persistedSessions(home);
    expect(persisted['deck_small_brain']).toMatchObject({ label: 'short label', description: 'short' });
    expect(persisted['deck_big_brain']!['description']).toBeUndefined();
    expect(persisted['deck_big_brain']!['blobRefs']).toMatchObject({ description: expect.stringMatching(/^[0-9a-f]{32}$/) });
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_big_brain')?.description).toBe(description);
    expect(getSession('deck_big_brain')).not.toHaveProperty('blobRefs');
  });
});

describe('rows written by an older build (a long value inline) keep working', () => {
  it('loads them exactly, then the first flush rewrites them as references', async () => {
    const prompt = cjk(400_000, 3);
    await freshStore();
    await flushStore();
    // What a pre-fix daemon left behind: the whole value inline in every row.
    replacePersistedSessions(home, NAMES(8).map((name) => ({ ...record(name, { description: prompt }) }) as Record<string, unknown> & { name: string }));
    expect(Object.values(persistedSessions(home)).every((entry) => entry.description === prompt)).toBe(true);

    resetSessionStoreAuthorityForTests();
    await freshStore();
    NAMES(8).forEach((name) => expect(getSession(name)?.description === prompt).toBe(true));
    // Nothing is marked dirty by the load, but the sweep finds every row differs from its reference form.
    upsertSession({ ...getSession(NAMES(8)[0]!)!, updatedAt: 99 });
    await flushStore();
    const rewritten = persistedSessions(home);
    expect(Object.values(rewritten).every((entry) => entry.description === undefined && typeof (entry.blobRefs as Record<string, string>)?.description === 'string')).toBe(true);
    expect(persistedSessionBlobs(home).size).toBe(1);
    expect(sessionStoreCommittedBytesForTests().payloadBytes).toBeLessThan(8 * 1_500);
  });
});

describe('blobs follow their references', () => {
  it('an edited value frees the old blob unless another session still uses it; a removed session frees its blob', async () => {
    await freshStore();
    const a = cjk(50_000, 11);
    const b = cjk(60_000, 12);
    upsertSession(record('deck_a_one', { description: a }));
    upsertSession(record('deck_a_two', { description: a }));
    await flushStore();
    expect(persistedSessionBlobs(home).size).toBe(1);

    upsertSession({ ...getSession('deck_a_one')!, description: b });
    await flushStore();
    expect([...persistedSessionBlobs(home).values()].sort()).toEqual([a, b].sort()); // deck_a_two still needs a

    removeSession('deck_a_two');
    await flushStore();
    expect([...persistedSessionBlobs(home).values()]).toEqual([b]);

    removeSession('deck_a_one');
    // an empty store needs the explicit admin act; keep one session instead
    upsertSession(record('deck_keep_brain'));
    await flushStore();
    expect(persistedSessionBlobs(home).size).toBe(0);
  });
});

describe('the older-build export stays small and readable', () => {
  it('writes the v2 layout with every large field inline, no blob references and NO identityPrompts table', async () => {
    await freshStore();
    const texts = [cjk(20_000, 21), cjk(22_000, 22), cjk(24_000, 23)];
    NAMES(30).forEach((name, index) => upsertSession(record(name, { description: texts[index % 3] })));
    await flushStore();
    await waitForCompatExportForTests();
    const exported = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as {
      version: number; sessions: Record<string, Record<string, unknown>>; identityPrompts?: unknown;
    };
    expect(exported.version).toBe(2);
    expect(exported.identityPrompts).toBeUndefined();
    NAMES(30).forEach((name, index) => {
      expect(exported.sessions[name]!['description'], name).toBe(texts[index % 3]);
      expect(exported.sessions[name]!['blobRefs'], name).toBeUndefined(); // older readers know no blob table
    });
  });
});

describe('the migration corners', () => {
  it('(i) a blob freed by collection and then taken again by another session with the same text is stored again and survives a reload', async () => {
    await freshStore();
    const text = cjk(40_000, 31);
    upsertSession(record('deck_first_brain', { description: text }));
    upsertSession(record('deck_keep_brain'));
    await flushStore();
    upsertSession({ ...getSession('deck_first_brain')!, description: undefined });
    await flushStore();
    expect(persistedSessionBlobs(home).size).toBe(0); // freed
    upsertSession(record('deck_second_brain', { description: text }));
    await flushStore();
    expect([...persistedSessionBlobs(home).values()]).toEqual([text]);
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_second_brain')?.description === text).toBe(true);
  });

  it('(ii) in ONE flush where session A drops hash H and session B takes it, H is kept', async () => {
    await freshStore();
    const shared = cjk(40_000, 41);
    upsertSession(record('deck_a_brain', { description: shared }));
    upsertSession(record('deck_b_brain'));
    await flushStore();
    upsertSession({ ...getSession('deck_a_brain')!, description: undefined });
    upsertSession({ ...getSession('deck_b_brain')!, description: shared });
    await flushStore();
    expect([...persistedSessionBlobs(home).values()]).toEqual([shared]);
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_b_brain')?.description === shared).toBe(true);
    expect(getSession('deck_a_brain')?.description).toBeUndefined();
  });

  it('(iii) restoring from a snapshot after the live rows and blobs are gone brings back both long fields, and persists them again', async () => {
    await freshStore();
    const identity = cjk(60_000, 51);
    const description = cjk(20_000, 52);
    upsertSession(record('deck_snap_brain', { label: identity, description }));
    await flushStore();
    await waitForSessionStoreSnapshotForTests();
    // The live database loses everything (an empty store beside a usable snapshot).
    const live = openSessionDbForWrite(sessionDbPathForHome(home));
    live.db.exec('DELETE FROM sessions; DELETE FROM session_blobs;');
    closeSessionDb(live);
    const backup = `${sessionDbPathForHome(home)}.bak.1`;
    expect(existsSync(backup)).toBe(true);
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_snap_brain')?.label === identity).toBe(true);
    expect(getSession('deck_snap_brain')?.description === description).toBe(true);
    await flushStore();
    expect(persistedSessionBlobs(home).size).toBe(2);
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_snap_brain')?.label === identity).toBe(true);
  });

  it('a reader sees rows and blobs from ONE point in time', () => {
    const path = sessionDbPathForHome(home);
    const writer = openSessionDbForWrite(path);
    try {
      const blob = { hash: 'a'.repeat(32), text: cjk(10_000, 61) };
      commitSessionChanges(writer, { upserts: [{ name: 'deck_x', projectName: 'p', parentSession: null, agentType: 'codex-sdk', state: 'idle', updatedAt: 1, payload: JSON.stringify({ name: 'deck_x', blobRefs: { description: blob.hash } }), blobs: [blob] }], deletes: [], allowEmpty: true });
      const reader = openSessionDbReadOnly(path)!;
      try {
        const first = readSessionStoreSnapshot(reader);
        // The daemon collects the blob while the reader still holds nothing: a LATER snapshot is consistent too.
        commitSessionChanges(writer, { upserts: [], deletes: ['deck_x'], allowEmpty: true });
        const second = readSessionStoreSnapshot(reader);
        expect(first.payloads.size).toBe(1);
        expect(first.blobs.get(blob.hash)).toBe(blob.text);
        expect(second.payloads.size).toBe(0);
        expect(second.blobs.size).toBe(0);
      } finally { closeSessionDb(reader); }
    } finally { closeSessionDb(writer); }
  });
});

describe('disk and cache footprint', () => {
  it('a database whose rows shrank is compacted once its free pages are large, and the file shrinks', () => {
    const path = sessionDbPathForHome(home);
    const handle = openSessionDbForWrite(path);
    try {
      const rows = Array.from({ length: 6 }, (_, index) => ({
        name: `deck_big_${index}`, projectName: 'p', parentSession: null, agentType: 'codex-sdk', state: 'idle', updatedAt: 1,
        payload: JSON.stringify({ name: `deck_big_${index}`, filler: 'x'.repeat(Math.ceil(SESSION_DB_VACUUM_MIN_FREE_BYTES / 4)) }),
      }));
      commitSessionChanges(handle, { upserts: rows, deletes: [], allowEmpty: true });
      expect(vacuumSessionDbIfFragmented(handle).vacuumed).toBe(false); // nothing free yet
      commitSessionChanges(handle, { upserts: [], deletes: rows.map((row) => row.name), allowEmpty: true });
      const before = statSync(path).size;
      const result = vacuumSessionDbIfFragmented(handle);
      expect(result.vacuumed).toBe(true);
      expect(result.freeBytes).toBeGreaterThanOrEqual(SESSION_DB_VACUUM_MIN_FREE_BYTES);
      expect(statSync(path).size).toBeLessThan(before / 4);
    } finally { closeSessionDb(handle); }
  });

  it('the hash and intern caches are bounded by the characters they hold, and still answer correctly', () => {
    resetSessionBlobCachesForTests();
    const unit = 'y'.repeat(1_000_000);
    const texts = Array.from({ length: Math.ceil(SESSION_BLOB_CACHE_MAX_CHARS / 1_000_000) + 20 }, (_, index) => `${index}:${unit}`);
    for (const text of texts) { hashSessionBlob(text); internSessionText(text); }
    const stats = sessionBlobCacheStatsForTests();
    expect(stats.hashChars).toBeLessThanOrEqual(SESSION_BLOB_CACHE_MAX_CHARS);
    expect(stats.internChars).toBeLessThanOrEqual(SESSION_BLOB_CACHE_MAX_CHARS);
    expect(hashSessionBlob(texts[0]!)).toBe(hashSessionBlob(`${0}:${unit}`)); // cleared entries are simply recomputed
    expect(internSessionText(texts[1]!)).toBe(texts[1]);
  });
});
