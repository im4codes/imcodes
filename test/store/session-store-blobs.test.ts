/**
 * 158 (2026-10-07): after the SQLite migration every session row carried its OWN copy of the user's
 * 250-550 KB identity contract (117 of 180 sessions, nine distinct texts): the store went from 8.4 MB
 * (sessions.json de-duplicated them) to 84 MB, and every sweep / compatibility export serialised 45 MB on
 * the main thread (a 1.2 s event-loop stall, every few seconds, until the heap ran out).
 *
 * Pinned here: large string fields are stored ONCE (blob table), rows keep a reference; old inline rows
 * still load and are rewritten as references; unreferenced blobs are dropped; the compatibility export
 * stays small and readable by older builds; no row ever holds a long inline string again.
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
import { resetSessionBlobCachesForTests } from '../../src/store/session-record-blobs.js';
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
  it('158 shape: 117 of 180 sessions share nine 250-550 KB identity contracts -> nine blobs, tiny rows, small files', async () => {
    await freshStore();
    const prompts = Array.from({ length: 9 }, (_, index) => cjk(250_000 + index * 35_000, index));
    const names = NAMES(180);
    names.forEach((name, index) => upsertSession(record(name, index < 117 ? { identityPrompt: prompts[index % 9] } : {})));
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
    // The database and the older-build export are a few MB (the 9 distinct texts), not 84 MB.
    expect((await stat(sessionDbPathForHome(home))).size).toBeLessThan(12 * 1024 * 1024);
    expect((await stat(join(dir, 'sessions.json'))).size).toBeLessThan(12 * 1024 * 1024);
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
    NAMES(10).forEach((name, index) => upsertSession(record(name, { identityPrompt: prompts[index % 2] })));
    await flushStore();
    resetSessionStoreAuthorityForTests();
    await freshStore();
    NAMES(10).forEach((name, index) => expect(getSession(name)?.identityPrompt === prompts[index % 2], name).toBe(true));
    expect(getSession(NAMES(10)[0]!)?.identityPrompt).not.toBe(getSession(NAMES(10)[1]!)?.identityPrompt);
  });

  it('small prompts and ordinary fields stay inline; a long non-identity field (any field) is externalised too', async () => {
    await freshStore();
    const description = cjk(30_000, 7);
    upsertSession(record('deck_small_brain', { identityPrompt: 'short identity', description: 'short' }));
    upsertSession(record('deck_big_brain', { description }));
    await flushStore();
    const persisted = persistedSessions(home);
    expect(persisted['deck_small_brain']).toMatchObject({ identityPrompt: 'short identity', description: 'short' });
    expect(persisted['deck_big_brain']!['description']).toBeUndefined();
    expect(persisted['deck_big_brain']!['blobRefs']).toMatchObject({ description: expect.stringMatching(/^[0-9a-f]{32}$/) });
    resetSessionStoreAuthorityForTests();
    await freshStore();
    expect(getSession('deck_big_brain')?.description).toBe(description);
    expect(getSession('deck_big_brain')).not.toHaveProperty('blobRefs');
  });
});

describe('rows written by an older build (inline identity) keep working', () => {
  it('loads them exactly, then the first flush rewrites them as references', async () => {
    const prompt = cjk(400_000, 3);
    await freshStore();
    await flushStore();
    // What a pre-fix daemon left behind: the whole prompt inline in every row.
    replacePersistedSessions(home, NAMES(8).map((name) => ({ ...record(name, { identityPrompt: prompt }) }) as Record<string, unknown> & { name: string }));
    expect(Object.values(persistedSessions(home)).every((entry) => entry.identityPrompt === prompt)).toBe(true);

    resetSessionStoreAuthorityForTests();
    await freshStore();
    NAMES(8).forEach((name) => expect(getSession(name)?.identityPrompt === prompt).toBe(true));
    // Nothing is marked dirty by the load, but the sweep finds every row differs from its reference form.
    upsertSession({ ...getSession(NAMES(8)[0]!)!, updatedAt: 99 });
    await flushStore();
    const rewritten = persistedSessions(home);
    expect(Object.values(rewritten).every((entry) => entry.identityPrompt === undefined && typeof entry.identityPromptRef === 'string')).toBe(true);
    expect(persistedSessionBlobs(home).size).toBe(1);
    expect(sessionStoreCommittedBytesForTests().payloadBytes).toBeLessThan(8 * 1_500);
  });
});

describe('blobs follow their references', () => {
  it('an edited identity frees the old blob unless another session still uses it; a removed session frees its blob', async () => {
    await freshStore();
    const a = cjk(50_000, 11);
    const b = cjk(60_000, 12);
    upsertSession(record('deck_a_one', { identityPrompt: a }));
    upsertSession(record('deck_a_two', { identityPrompt: a }));
    await flushStore();
    expect(persistedSessionBlobs(home).size).toBe(1);

    upsertSession({ ...getSession('deck_a_one')!, identityPrompt: b });
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
  it('writes the legacy v2 layout: identityPromptRef per session and ONE identityPrompts table', async () => {
    await freshStore();
    const prompts = [cjk(200_000, 21), cjk(220_000, 22), cjk(240_000, 23)];
    NAMES(30).forEach((name, index) => upsertSession(record(name, { identityPrompt: prompts[index % 3], description: index === 0 ? cjk(9_000, 9) : 'd' })));
    await flushStore();
    await waitForCompatExportForTests();
    const exported = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')) as {
      version: number; sessions: Record<string, Record<string, unknown>>; identityPrompts: Record<string, string>;
    };
    expect(exported.version).toBe(2);
    expect(Object.keys(exported.identityPrompts)).toHaveLength(3);
    expect(Object.values(exported.identityPrompts).sort()).toEqual([...prompts].sort());
    for (const [name, entry] of Object.entries(exported.sessions)) {
      expect(entry.identityPrompt, name).toBeUndefined();
      expect(exported.identityPrompts[entry.identityPromptRef as string], name).toBeDefined();
      expect(entry.blobRefs, name).toBeUndefined(); // other large fields are inlined for older readers
    }
    expect(exported.sessions[NAMES(30)[0]!]!['description']).toBe(cjk(9_000, 9));
  });
});
