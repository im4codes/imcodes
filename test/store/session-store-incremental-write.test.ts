/**
 * Session-store flushes no longer parse the store twice, hold the event loop for
 * the whole serialisation, or rebuild the sessions array on every listSessions
 * call (tsk_cd_session_store_incremental_write).
 *
 * What must NOT change is what these tests pin: the bytes written, atomic
 * replace and crash safety, coalescing of a burst of mutations into one write,
 * the empty-overwrite guard, test-session hygiene and write authority.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failure = vi.hoisted(() => ({ failAfterWrites: -1, writes: 0, opens: 0, renames: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (String(from).endsWith('.tmp') && String(to).endsWith('sessions.json')) failure.renames += 1; // a commit of the store
      return actual.rename(from, to);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      const handle = await actual.open(...args);
      if (!path.endsWith('.tmp')) return handle;
      failure.opens += 1;
      const write = handle.write.bind(handle) as (...w: unknown[]) => Promise<unknown>;
      // A crash between writes: the temporary file is left half written.
      (handle as unknown as { write: typeof write }).write = async (...w: unknown[]) => {
        failure.writes += 1;
        if (failure.failAfterWrites >= 0 && failure.writes > failure.failAfterWrites) throw new Error('simulated crash mid-write');
        return write(...w);
      };
      return handle;
    },
  };
});

import {
  authorizeEmptySessionStoreWrite,
  configureSessionStoreWriteAuthority,
  findSessionByProviderSessionId,
  flushStore,
  listSessions,
  loadStore,
  removeSession,
  resetSessionStoreAuthorityForTests,
  serializeSessionStoreForTests,
  setSessionStoreSerializeSliceMsForTests,
  updateSessionState,
  upsertSession,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';

let home = '';
let storeFile = '';

function record(name: string, extra: Partial<SessionRecord> & Record<string, unknown> = {}): SessionRecord {
  return {
    name, projectName: 'realproj', role: 'brain', agentType: 'shell', projectDir: '/home/user/work/realproj',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

/** The serializer exactly as it was before this change: the whole persisted object, stringified once. */
function referenceSerialize(sessions: SessionRecord[]): string {
  const identityPrompts: Record<string, string> = {};
  const refs = new Map<string, string>();
  const persisted: Record<string, unknown> = {};
  for (const session of sessions) {
    const { identityPrompt, ...rest } = session;
    if (typeof identityPrompt === 'string') {
      let ref = refs.get(identityPrompt);
      if (ref === undefined) { ref = `p${refs.size}`; refs.set(identityPrompt, ref); identityPrompts[ref] = identityPrompt; }
      persisted[session.name] = { ...rest, identityPromptRef: ref };
    } else persisted[session.name] = rest;
  }
  return JSON.stringify({ version: 2, sessions: persisted, identityPrompts }, null, 2);
}

const diskSessions = async () => (JSON.parse(await readFile(storeFile, 'utf8')) as { sessions: Record<string, SessionRecord> }).sessions;
const tmpFiles = async () => (await readdir(join(home, '.imcodes'))).filter((file) => file.endsWith('.tmp'));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-store-incremental-'));
  storeFile = join(home, '.imcodes', 'sessions.json');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  resetSessionStoreAuthorityForTests();
  failure.failAfterWrites = -1; failure.writes = 0; failure.opens = 0; failure.renames = 0;
  await mkdir(join(home, '.imcodes'), { recursive: true });
  await loadStore({ probe: false });
});

afterEach(async () => {
  setSessionStoreSerializeSliceMsForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('the file written is byte-for-byte what the whole-store serializer wrote', () => {
  it('matches for a mixed store: shared identity prompts, undefined fields, awkward strings, nested values', async () => {
    const sessions = [
      record('deck_realproj_brain', { identityPrompt: 'shared prompt\nwith a "quote" and   and é' }),
      record('deck_realproj_w1', { identityPrompt: 'shared prompt\nwith a "quote" and   and é', label: undefined, error: undefined }),
      record('deck_realproj_w2', { identityPrompt: 'another' }),
      record('deck_realproj_w3', { transportConfig: { supervision: { mode: 'off', list: [1, 2, { a: 'x\ny' }], empty: {}, none: [] } }, note: 'line1\nline2' }),
      record('name with "quotes" and \\ backslash', { projectName: 'p' }),
    ];
    for (const session of sessions) upsertSession(session);
    const stored = listSessions();
    expect(await serializeSessionStoreForTests()).toBe(referenceSerialize(stored));
  });

  it('matches for an empty store and for a production-shaped 300-session store', async () => {
    expect(await serializeSessionStoreForTests()).toBe(referenceSerialize([]));
    for (let i = 0; i < 300; i += 1) {
      upsertSession(record(`deck_realproj${i % 40}_w${i}`, {
        projectName: `realproj${i % 40}`,
        ...(i < 5 ? { summarySyncFingerprints: Object.fromEntries(Array.from({ length: 400 }, (_, k) => [`sum_${k}`, { fingerprint: `${i}${k}`.repeat(8), syncedAt: k }])) } : {}),
        ...(i % 3 === 0 ? { identityPrompt: `prompt ${i % 5}` } : {}),
      }));
    }
    expect(await serializeSessionStoreForTests()).toBe(referenceSerialize(listSessions()));
    await flushStore();
    expect(await readFile(storeFile, 'utf8')).toBe(referenceSerialize(listSessions()));
  });

  it('leaves known test sessions out, exactly as before', async () => {
    upsertSession(record('deck_realproj_brain'));
    upsertSession(record('deck_e2e_leaked_brain'));
    upsertSession(record('deck_realproj_w1', { projectName: 'e2e-leak' }));
    const text = await serializeSessionStoreForTests();
    expect(Object.keys(JSON.parse(text).sessions)).toEqual(['deck_realproj_brain']);
    expect(text).toBe(referenceSerialize(listSessions().filter((session) => session.name === 'deck_realproj_brain')));
  });
});

describe('serialisation does not hold the event loop', () => {
  it('yields between records: other turns run while a large store is serialised', async () => {
    for (let i = 0; i < 1000; i += 1) upsertSession(record(`deck_realproj${i % 40}_w${i}`, { note: 'x'.repeat(200) }));
    setSessionStoreSerializeSliceMsForTests(0); // yield after every record
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 0);
    let immediates = 0;
    const spin = () => { immediates += 1; if (!done) setImmediate(spin); };
    let done = false;
    setImmediate(spin);
    await flushStore();
    done = true;
    clearInterval(timer);
    // One yield per record (1000) means other immediates interleave; a single synchronous pass would see ~0.
    expect(immediates).toBeGreaterThan(100);
    expect(Object.keys(await diskSessions())).toHaveLength(1000);
    void ticks;
  });

  it('a very large store (1000 sessions) is written whole and parses back', async () => {
    for (let i = 0; i < 1000; i += 1) upsertSession(record(`deck_realproj${i % 40}_w${i}`, { identityPrompt: `p${i % 7}` }));
    await flushStore();
    const written = JSON.parse(await readFile(storeFile, 'utf8')) as { sessions: Record<string, unknown>; identityPrompts: Record<string, string> };
    expect(Object.keys(written.sessions)).toHaveLength(1000);
    expect(Object.keys(written.identityPrompts)).toHaveLength(7);
  });
});

describe('atomic replace, crash safety and coalescing are unchanged', () => {
  it('a crash mid-write keeps the last good file and leaves no half-written sessions.json', async () => {
    upsertSession(record('deck_realproj_brain'));
    upsertSession(record('deck_realproj_w1', { note: 'y'.repeat(600_000) })); // several write batches
    await flushStore();
    const good = await readFile(storeFile, 'utf8');
    expect(Object.keys(JSON.parse(good).sessions)).toHaveLength(2);

    upsertSession(record('deck_realproj_w2', { note: 'z'.repeat(600_000) }));
    failure.writes = 0;
    failure.failAfterWrites = 1; // die after the first batch reached the temporary file
    await expect(flushStore()).rejects.toThrow('simulated crash mid-write');

    expect(await readFile(storeFile, 'utf8')).toBe(good);
    expect(await tmpFiles()).toEqual([]); // the half-written temporary is set aside, never renamed over the store
    expect((await readdir(join(home, '.imcodes'))).some((file) => file.endsWith('.stale'))).toBe(true);

    failure.failAfterWrites = -1;
    await flushStore();
    expect(Object.keys(await diskSessions())).toHaveLength(3);
  });

  it('a burst of mutations inside the debounce window becomes one write with the final state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    upsertSession(record('deck_realproj_brain'));
    for (let i = 0; i < 50; i += 1) {
      updateSessionState('deck_realproj_brain', i % 2 === 0 ? 'running' : 'idle');
      upsertSession(record(`deck_realproj_w${i}`));
      await vi.advanceTimersByTimeAsync(100); // never a full 500 ms of quiet
    }
    expect(failure.renames).toBe(0);
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
    await flushStore();
    // The debounced write and the explicit flush are the only writers; the burst itself wrote nothing.
    expect(failure.renames).toBeLessThanOrEqual(2);
    const disk = await diskSessions();
    expect(Object.keys(disk)).toHaveLength(51);
    expect(disk.deck_realproj_brain!.state).toBe('idle');
  });

  it('a mutation made while a flush is serialising is not lost', async () => {
    for (let i = 0; i < 200; i += 1) upsertSession(record(`deck_realproj_w${i}`));
    setSessionStoreSerializeSliceMsForTests(0);
    const flush = flushStore();
    upsertSession(record('deck_realproj_late', { note: 'made mid-flush' }));
    await flush;
    await flushStore();
    expect((await diskSessions()).deck_realproj_late).toMatchObject({ note: 'made mid-flush' });
  });

  it('a daemon restart with a flush pending loses nothing: shutdown flushes, the next process loads it', async () => {
    upsertSession(record('deck_realproj_brain', { identityPrompt: 'shared' }));
    upsertSession(record('deck_realproj_w1', { identityPrompt: 'shared' }));
    // The debounce timer is still pending (500 ms not elapsed) when shutdown calls flushStore().
    await flushStore();
    resetSessionStoreAuthorityForTests(); // the new process starts from nothing in memory
    const loaded = await loadStore({ probe: false });
    expect(Object.keys(loaded.sessions).sort()).toEqual(['deck_realproj_brain', 'deck_realproj_w1']);
    expect(loaded.sessions.deck_realproj_w1!.identityPrompt).toBe('shared');
  });

  it('upgrade: a sessions.json written by the previous serializer loads, and the first new flush replaces it with the same bytes', async () => {
    const old = [record('deck_realproj_brain', { identityPrompt: 'p' }), record('deck_realproj_w1')];
    await writeFile(storeFile, referenceSerialize(old), 'utf8');
    resetSessionStoreAuthorityForTests();
    const loaded = await loadStore({ probe: false });
    expect(Object.keys(loaded.sessions)).toHaveLength(2);
    const before = await readFile(storeFile, 'utf8');
    await flushStore();
    const after = await readFile(storeFile, 'utf8');
    expect(JSON.parse(after).sessions.deck_realproj_brain.identityPromptRef).toBe('p0');
    expect(after).toBe(referenceSerialize(listSessions()));
    expect(await readFile(`${storeFile}.1`, 'utf8')).toBe(before); // rotated backup of the old file
  });

  it('rotates backups exactly as before', async () => {
    upsertSession(record('deck_realproj_brain'));
    for (let i = 0; i < 4; i += 1) { updateSessionState('deck_realproj_brain', i % 2 === 0 ? 'running' : 'idle'); await flushStore(); }
    for (const index of [1, 2, 3]) expect(JSON.parse(await readFile(`${storeFile}.${index}`, 'utf8')).sessions.deck_realproj_brain).toBeDefined();
  });
});

describe('the steady-state flush does not re-read or re-parse the file it just wrote', () => {
  it('parses nothing on the second and third flush, but does re-verify a file that changed underneath it', async () => {
    upsertSession(record('deck_realproj_brain'));
    await flushStore(); // cold: nothing known about the file yet
    const parse = vi.spyOn(JSON, 'parse');
    updateSessionState('deck_realproj_brain', 'running');
    await flushStore();
    updateSessionState('deck_realproj_brain', 'idle');
    await flushStore();
    expect(parse).not.toHaveBeenCalled();
    parse.mockClear();

    // Someone else replaces the file: size and mtime differ, so it is inspected again.
    await writeFile(storeFile, referenceSerialize([record('deck_realproj_other'), record('deck_realproj_other2')]), 'utf8');
    updateSessionState('deck_realproj_brain', 'running');
    await flushStore();
    expect(parse).toHaveBeenCalled();
  });

  it('the empty-overwrite guard still holds against a file replaced behind the cache', async () => {
    upsertSession(record('deck_realproj_brain'));
    await flushStore();
    updateSessionState('deck_realproj_brain', 'running');
    await flushStore(); // cache warm
    const foreign = referenceSerialize([record('deck_realproj_foreign1'), record('deck_realproj_foreign2'), record('deck_realproj_foreign3')]);
    await writeFile(storeFile, foreign, 'utf8');
    removeSession('deck_realproj_brain'); // the store is now empty
    await flushStore();
    expect(await readFile(storeFile, 'utf8')).toBe(foreign);
    authorizeEmptySessionStoreWrite();
    await flushStore();
    expect(Object.keys(await diskSessions())).toEqual([]);
  });

  it('a cached count of a file this process wrote itself also guards: an empty store does not replace it', async () => {
    upsertSession(record('deck_realproj_brain'));
    await flushStore();
    const good = await readFile(storeFile, 'utf8');
    removeSession('deck_realproj_brain');
    await flushStore(); // served from the cache, no parse
    expect(await readFile(storeFile, 'utf8')).toBe(good);
  });

  it('never trusts the cache past its window: a same-size, same-mtime replacement is caught on the next verification', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    upsertSession(record('deck_realproj_brain'));
    await flushStore();
    const written = await readFile(storeFile, 'utf8');
    const info = await stat(storeFile);
    // A same-length, non-empty foreign file with the mtime restored: indistinguishable by signature.
    const foreign = written.replace('deck_realproj_brain', 'deck_realproj_other');
    await writeFile(storeFile, foreign, 'utf8');
    await utimes(storeFile, info.atime, info.mtime);
    vi.setSystemTime(Date.now() + 61_000);
    removeSession('deck_realproj_brain');
    await flushStore();
    expect(await readFile(storeFile, 'utf8')).toBe(foreign); // refused: the file it would replace holds a session
  });
});

describe('write authority is unchanged', () => {
  const identity = currentDaemonProcessIdentity();
  let metadataPath = '';

  async function installOwner(): Promise<void> {
    metadataPath = join(home, '.imcodes', 'daemon.lock.json');
    await writeFile(metadataPath, JSON.stringify({
      version: 1, ...identity, acquiredAt: Date.now(), socketPath: join(home, '.imcodes', 'daemon.sock'),
      sessionIds: ['deck_realproj_brain'], residualResources: [],
    }), 'utf8');
    configureSessionStoreWriteAuthority(identity, metadataPath);
  }

  beforeEach(() => {
    // The production ownership branch, not Vitest's isolated-home allowance; the path is still temporary.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    resetSessionStoreAuthorityForTests();
  });

  it('a read-only secondary daemon cannot write, even after the owner warmed the cache in this process', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_realproj_brain'));
    await flushStore();
    const owned = await readFile(storeFile, 'utf8');

    // Ownership passes to another daemon: the lock names a different start token.
    await writeFile(metadataPath, JSON.stringify({
      version: 1, pid: identity.pid, startToken: `${identity.startToken}-other`, acquiredAt: Date.now(),
      socketPath: join(home, '.imcodes', 'daemon.sock'), sessionIds: [], residualResources: [],
    }), 'utf8');
    updateSessionState('deck_realproj_brain', 'running');
    upsertSession(record('deck_realproj_w9'));
    await flushStore();
    expect(await readFile(storeFile, 'utf8')).toBe(owned);
    expect(failure.opens).toBe(1); // only the owner's earlier write ever opened a temporary file
  });

  it('a process that never held the lock stays read-only', async () => {
    await installOwner();
    await loadStore();
    upsertSession(record('deck_realproj_brain'));
    await flushStore();
    const owned = await readFile(storeFile, 'utf8');
    resetSessionStoreAuthorityForTests(); // a consumer process: no authority configured
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_w9'));
    await flushStore();
    expect(await readFile(storeFile, 'utf8')).toBe(owned);
  });
});

describe('listSessions', () => {
  it('returns a fresh array each time, follows upserts, removals and reloads, and sees in-place record changes', async () => {
    upsertSession(record('deck_realproj_a'));
    upsertSession(record('deck_realproj_b', { projectName: 'other', providerSessionId: 'prov-b' }));
    const first = listSessions();
    first.pop(); // a caller mutating its copy must not corrupt the store
    first.length = 0;
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
    expect(listSessions('other').map((s) => s.name)).toEqual(['deck_realproj_b']);
    expect(findSessionByProviderSessionId('prov-b')?.name).toBe('deck_realproj_b');

    upsertSession(record('deck_realproj_c'));
    expect(listSessions()).toHaveLength(3);
    upsertSession(record('deck_realproj_a', { projectName: 'other' })); // replaced record object
    expect(listSessions('other').map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
    removeSession('deck_realproj_c');
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);

    updateSessionState('deck_realproj_a', 'running'); // in place: the list holds the live object
    expect(listSessions().find((s) => s.name === 'deck_realproj_a')?.state).toBe('running');

    await flushStore();
    resetSessionStoreAuthorityForTests();
    await loadStore({ probe: false });
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
  });
});
