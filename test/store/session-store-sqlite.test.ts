/**
 * The session store lives in SQLite (tsk_cd_session_store_incremental_write):
 * one row per session, written incrementally in one transaction per flush,
 * migrated once from the legacy sessions.json.
 *
 * Pinned here: lossless and crash-safe migration, incremental writes, the
 * empty-overwrite guard, write authority, disk-full behaviour, snapshots
 * instead of per-flush backup copies, and readers in other processes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizeEmptySessionStoreWrite,
  configureSessionStoreWriteAuthority,
  findSessionByProviderSessionId,
  flushStore,
  getSession,
  listSessions,
  loadStore,
  removeSession,
  resetSessionStoreAuthorityForTests,
  sessionStoreWriterConnectionForTests,
  setSessionStoreBackupIntervalMsForTests,
  setSessionStoreSweepSliceMsForTests,
  updateSessionState,
  upsertSession,
  waitForCompatExportForTests,
  waitForSessionStoreSnapshotForTests,
  sessionsJsonCompatExportStatsForTests,
  type SessionRecord,
} from '../../src/store/session-store.js';
import {
  SESSION_DB_LEGACY_IMPORT_DONE,
  SESSION_DB_META_LEGACY_IMPORT,
  closeSessionDb,
  openSessionDbReadOnly,
  readSessionDbMeta,
  setSessionDbFailAfterRowWritesForTests,
  setSessionDbRowWriteHookForTests,
} from '../../src/store/session-store-db.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import logger from '../../src/util/logger.js';
import {
  SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION,
  SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY,
  SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS,
} from '../../shared/session-store-compat.js';
import { persistedSessions, sessionDbPathForHome } from '../helpers/session-store-db.js';

const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/daemon/instance-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/instance-lock.js')>();
  return { ...actual, isRecordedProcessIdentityCurrent: (...args: Parameters<typeof actual.isRecordedProcessIdentityCurrent>) => { probe.calls += 1; return actual.isRecordedProcessIdentityCurrent(...args); } };
});

const execFileAsync = promisify(execFile);
let home = '';
let dir = '';
const jsonFile = () => join(dir, 'sessions.json');
const frozenFile = () => `${jsonFile()}.migrated-to-sqlite`;

function record(name: string, extra: Record<string, unknown> = {}): SessionRecord {
  return {
    name, projectName: 'realproj', role: 'brain', agentType: 'shell', projectDir: '/home/user/work/realproj',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

/** A store shaped like a real one: a few huge records, some mid, most tiny; shared prompts by reference. */
function productionShapedFile(count: number): { text: string; expected: Record<string, Record<string, unknown>> } {
  const sessions: Record<string, Record<string, unknown>> = {};
  const identityPrompts: Record<string, string> = { p0: 'shared prompt\nwith "quotes",   and é 中 😀', p1: 'other' };
  const expected: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < count; i += 1) {
    const name = `deck_realproj${i % 40}_${i % 7 === 0 ? 'brain' : `w${i}`}${i}`;
    const fingerprints = i < 5 ? 400 : i < 45 ? 60 : 0;
    const base: Record<string, unknown> = {
      name, projectName: `realproj${i % 40}`, role: i % 7 === 0 ? 'brain' : `w${i % 5}`,
      agentType: i % 3 === 0 ? 'claude-code-sdk' : 'codex-sdk', runtimeType: 'transport',
      projectDir: `/home/user/work/realproj${i % 40}`, state: i % 4 === 0 ? 'running' : 'idle',
      sessionInstanceId: `instance-${i}`, runtimeEpoch: `epoch-${i}`, restarts: i % 3, restartTimestamps: [1, 2, 3].slice(0, i % 4),
      createdAt: 1_789_000_000_000 + i, updatedAt: 1_790_000_000_000 + i, shellBin: i % 11 === 0 ? null : undefined,
      transportConfig: { supervision: { mode: 'off', list: [1, { a: 'x\ny' }], empty: {}, none: [] }, note: `n${i}` },
      quotaMeta: { usedPercent: 12.5, resetAt: 1_790_000_000_000 },
      ...(fingerprints > 0 ? { summarySyncFingerprints: Object.fromEntries(Array.from({ length: fingerprints }, (_, k) => [`sum_${k}`, { fingerprint: `${i}-${k}`.repeat(6), syncedAt: k }])) } : {}),
    };
    const withPrompt = i % 3 === 0 ? { ...base, identityPromptRef: i % 2 === 0 ? 'p0' : 'p1' } : base;
    sessions[name] = withPrompt;
    const { identityPromptRef, ...rest } = withPrompt;
    expected[name] = JSON.parse(JSON.stringify({ ...rest, ...(identityPromptRef ? { identityPrompt: identityPrompts[identityPromptRef as string] } : {}) }));
  }
  return { text: JSON.stringify({ version: 2, sessions, identityPrompts }, null, 2), expected };
}

async function fresh(): Promise<void> {
  resetSessionStoreAuthorityForTests();
  await loadStore({ probe: false });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'imcodes-store-sqlite-'));
  dir = join(home, '.imcodes');
  await mkdir(dir, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('IMCODES_HOME', dir); // the state directory wins over HOME: move both
  resetSessionStoreAuthorityForTests();
});

afterEach(async () => {
  setSessionDbRowWriteHookForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('one-time migration from sessions.json', () => {
  it('imports a production-shaped store losslessly and freezes the file as a rollback export', async () => {
    const { text, expected } = productionShapedFile(300);
    await writeFile(jsonFile(), text, 'utf8');
    await loadStore({ probe: false });

    expect(Object.keys(persistedSessions(home))).toHaveLength(300);
    expect(persistedSessions(home)).toEqual(expected);
    expect(Object.fromEntries(listSessions().map((session) => [session.name, JSON.parse(JSON.stringify(session))]))).toEqual(expected);
    expect(await readFile(frozenFile(), 'utf8')).toBe(text); // byte-identical rollback export
    const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
    expect(readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT)).toBe(SESSION_DB_LEGACY_IMPORT_DONE);
    closeSessionDb(reader);
  });

  it('imports legacy v1 snapshots (inline identity prompts, no version)', async () => {
    await writeFile(jsonFile(), JSON.stringify({ sessions: { deck_realproj_brain: record('deck_realproj_brain', { identityPrompt: 'inline' }) } }), 'utf8');
    await loadStore({ probe: false });
    expect(persistedSessions(home).deck_realproj_brain).toMatchObject({ identityPrompt: 'inline' });
  });

  it('is idempotent: a later start never re-reads sessions.json, even one an older daemon recreated', async () => {
    await writeFile(jsonFile(), productionShapedFile(20).text, 'utf8');
    await loadStore({ probe: false });
    const migrated = persistedSessions(home);
    updateSessionState('deck_realproj0_brain0', 'error', 'boom');
    await flushStore();
    const afterEdit = persistedSessions(home);
    expect(afterEdit).not.toEqual(migrated);

    // A downgraded daemon ran and left a different sessions.json behind; the upgraded one starts again.
    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: { deck_old_brain: record('deck_old_brain') }, identityPrompts: {} }), 'utf8');
    await fresh();
    await fresh();
    expect(persistedSessions(home)).toEqual(afterEdit);
    expect(getSession('deck_old_brain')).toBeUndefined(); // sessions.json is write-only now: never read back
  });

  it('a crash mid-import leaves nothing behind and the retry imports everything', async () => {
    const { text, expected } = productionShapedFile(300);
    await writeFile(jsonFile(), text, 'utf8');
    setSessionDbFailAfterRowWritesForTests(120);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await loadStore({ probe: false });
    expect(warn).toHaveBeenCalled();
    expect(persistedSessions(home)).toEqual({}); // rolled back: not 120 rows
    expect(await readFile(jsonFile(), 'utf8')).toBe(text); // and the source is untouched

    setSessionDbFailAfterRowWritesForTests(null);
    await fresh();
    expect(persistedSessions(home)).toEqual(expected);
    expect(existsSync(frozenFile())).toBe(true);
  });

  it('survives a real SIGKILL in the middle of the import transaction', async () => {
    const { text, expected } = productionShapedFile(300);
    await writeFile(jsonFile(), text, 'utf8');
    const script = `
      const db = await import(process.env.DB_MODULE);
      const store = await import(process.env.STORE_MODULE);
      db.setSessionDbRowWriteHookForTests((n) => { if (n === 150) process.kill(process.pid, 'SIGKILL'); });
      await store.loadStore({ probe: false });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env, HOME: home, IMCODES_HOME: join(home, '.imcodes'), USERPROFILE: home,
        DB_MODULE: new URL('../../src/store/session-store-db.ts', import.meta.url).href,
        STORE_MODULE: new URL('../../src/store/session-store.ts', import.meta.url).href,
      },
      stdio: 'ignore',
    });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    // POSIX reports the signal; Windows terminates the process outright (no signal, non-zero code).
    expect(exit.signal === 'SIGKILL' || (process.platform === 'win32' && exit.code !== 0)).toBe(true);

    expect(await readFile(jsonFile(), 'utf8')).toBe(text); // source intact
    expect(persistedSessions(home)).toEqual({}); // the half-import never committed
    await loadStore({ probe: false }); // the next start retries from scratch
    expect(persistedSessions(home)).toEqual(expected);
  }, 60_000);

  it('a missing sessions.json is a fresh install: empty store, migration marked done', async () => {
    await loadStore({ probe: false });
    expect(listSessions()).toEqual([]);
    const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
    expect(readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT)).toBe(SESSION_DB_LEGACY_IMPORT_DONE);
    closeSessionDb(reader);
  });

  it('an empty sessions.json migrates to an empty store', async () => {
    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: {}, identityPrompts: {} }), 'utf8');
    await loadStore({ probe: false });
    expect(listSessions()).toEqual([]);
    expect(existsSync(frozenFile())).toBe(true);
  });

  it('a missing or empty sessions.json falls back to the newest non-empty rotated backup, as before', async () => {
    const backup = JSON.stringify({ version: 2, sessions: { deck_realproj_brain: record('deck_realproj_brain', { note: 'from backup' }) }, identityPrompts: {} });
    await writeFile(`${jsonFile()}.2`, backup, 'utf8');
    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: {}, identityPrompts: {} }), 'utf8');
    await loadStore({ probe: false });
    expect(persistedSessions(home).deck_realproj_brain).toMatchObject({ note: 'from backup' });
    expect(await readFile(`${jsonFile()}.2`, 'utf8')).toBe(backup); // old backups are left alone
  });

  it('a corrupt sessions.json is reported and not destroyed; fixing it lets a later start migrate', async () => {
    const corrupt = '{"version": 2, "sessions": {"deck_realproj_brain": {"name": "x"';
    await writeFile(jsonFile(), corrupt, 'utf8');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await loadStore({ probe: false });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ jsonPath: jsonFile() }), expect.stringContaining('could not be read'));
    expect(await readFile(jsonFile(), 'utf8')).toBe(corrupt);
    expect(existsSync(frozenFile())).toBe(false);
    const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
    expect(readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT)).toBeNull(); // not marked done: retry after repair
    closeSessionDb(reader);

    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: { deck_realproj_brain: record('deck_realproj_brain') }, identityPrompts: {} }), 'utf8');
    await fresh();
    expect(Object.keys(persistedSessions(home))).toEqual(['deck_realproj_brain']);
  });

  // The one-time import retries on the next start for as long as sessions.json cannot be
  // read, so until the marker says "imported" the file is the user's only copy. Nothing may
  // replace it -- least of all the write-only compatibility export of the (still empty)
  // database. CI flake (macOS, dev c4e92ab9c): the export requested by the first load landed
  // after the user repaired the file and replaced it, so the next start migrated nothing.
  describe('an unmigrated sessions.json is the only copy: the compat export never touches it', () => {
    const corrupt = '{"version": 2, "sessions": {"deck_realproj_brain": {"name": "x"';
    const repaired = () => JSON.stringify({ version: 2, sessions: { deck_realproj_brain: record('deck_realproj_brain') }, identityPrompts: {} });
    const leftovers = async () => (await readdir(dir)).filter((entry) => entry.startsWith('sessions.json.') && entry.endsWith('.tmp'));
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { error = vi.spyOn(logger, 'error').mockImplementation(() => undefined); });

    it('a corrupt file survives every export the store would run, byte for byte', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false });
      await waitForCompatExportForTests();
      expect(await readFile(jsonFile(), 'utf8')).toBe(corrupt);

      // Ordinary session writes and a flush also request exports: still not the file's business.
      upsertSession(record('deck_realproj_w1'));
      await flushStore();
      await waitForCompatExportForTests();
      expect(await readFile(jsonFile(), 'utf8')).toBe(corrupt);
      expect(await leftovers()).toEqual([]);
      expect(sessionsJsonCompatExportStatsForTests().completed).toBe(0);
      expect(error).toHaveBeenCalled();
    });

    it('CAUSAL RACE: corrupt -> load -> the user repairs the file -> the pending export fires -> the next start still migrates the sessions', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false }); // the first load requests an export
      const text = repaired(); // the user repairs the file while that export is pending
      await writeFile(jsonFile(), text, 'utf8');
      await waitForCompatExportForTests(); // the pending export fires now
      expect(await readFile(jsonFile(), 'utf8')).toBe(text); // the repaired file is intact
      await fresh(); // the next start
      expect(Object.keys(persistedSessions(home))).toEqual(['deck_realproj_brain']);
      expect(existsSync(frozenFile())).toBe(true);
    });

    it('once the import is done the export is written again, unchanged', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false });
      await writeFile(jsonFile(), repaired(), 'utf8');
      await fresh();
      await waitForCompatExportForTests();
      const exported = JSON.parse(await readFile(jsonFile(), 'utf8')) as Record<string, unknown>;
      expect(exported[SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY]).toMatchObject({ format: SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION });
      expect(Object.keys(exported.sessions as object)).toEqual(['deck_realproj_brain']);
      expect(sessionsJsonCompatExportStatsForTests().completed).toBeGreaterThan(0);
    });

    it('an empty file, or no file at all, is "nothing to migrate": marked done, and the export works', async () => {
      await loadStore({ probe: false });
      upsertSession(record('deck_realproj_brain'));
      await flushStore();
      await waitForCompatExportForTests();
      expect(Object.keys((JSON.parse(await readFile(jsonFile(), 'utf8')) as { sessions: object }).sessions)).toEqual(['deck_realproj_brain']);
    });

    it('CAUSAL: sessions written while the file was unreadable do not stop the repaired file from migrating -- the database row wins for a shared name, the rest is added', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false }); // unreadable: import not done, the daemon keeps working
      upsertSession(record('deck_realproj_live', { note: 'written while the file was unreadable' }));
      upsertSession(record('deck_realproj_shared', { note: 'live database row' }));
      await flushStore();
      expect(persistedSessions(home)).toHaveProperty('deck_realproj_live');

      // The user repairs the file: it knows the shared name (stale) plus two sessions only it has.
      await writeFile(jsonFile(), JSON.stringify({
        version: 2,
        sessions: {
          deck_realproj_brain: record('deck_realproj_brain', { note: 'only in the file' }),
          deck_realproj_w9: record('deck_realproj_w9', { note: 'only in the file too' }),
          deck_realproj_shared: record('deck_realproj_shared', { note: 'stale file row' }),
        },
        identityPrompts: {},
      }), 'utf8');
      await fresh(); // the next start
      const persisted = persistedSessions(home);
      expect(Object.keys(persisted).sort()).toEqual(['deck_realproj_brain', 'deck_realproj_live', 'deck_realproj_shared', 'deck_realproj_w9']);
      expect(persisted.deck_realproj_shared).toMatchObject({ note: 'live database row' }); // existing rows always win
      expect(persisted.deck_realproj_live).toMatchObject({ note: 'written while the file was unreadable' });
      expect(persisted.deck_realproj_brain).toMatchObject({ note: 'only in the file' });
      const reader = openSessionDbReadOnly(sessionDbPathForHome(home))!;
      expect(readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT)).toBe(SESSION_DB_LEGACY_IMPORT_DONE);
      closeSessionDb(reader);
      expect(existsSync(frozenFile())).toBe(true);
      expect(JSON.parse(await readFile(frozenFile(), 'utf8')).sessions.deck_realproj_shared.note).toBe('stale file row'); // the file itself is kept as it was
    });

    it('a database that already had every legacy name imports nothing and still marks the import done', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false });
      upsertSession(record('deck_realproj_brain', { note: 'live' }));
      await flushStore();
      await writeFile(jsonFile(), repaired(), 'utf8');
      await fresh();
      expect(persistedSessions(home).deck_realproj_brain).toMatchObject({ note: 'live' });
      expect(existsSync(frozenFile())).toBe(true);
      await fresh(); // and it is not imported again
      expect(Object.keys(persistedSessions(home))).toEqual(['deck_realproj_brain']);
    });

    it('a restart in the middle of the wait (a second unreadable start) still leaves the file alone', async () => {
      await writeFile(jsonFile(), corrupt, 'utf8');
      await loadStore({ probe: false });
      await fresh(); // still corrupt on the next start
      await waitForCompatExportForTests();
      expect(await readFile(jsonFile(), 'utf8')).toBe(corrupt);
      const text = repaired();
      await writeFile(jsonFile(), text, 'utf8');
      await waitForCompatExportForTests();
      expect(await readFile(jsonFile(), 'utf8')).toBe(text);
      await fresh();
      expect(Object.keys(persistedSessions(home))).toEqual(['deck_realproj_brain']);
    });
  });

  it('a 1000-session store migrates and then flushes one row per change', async () => {
    const { text, expected } = productionShapedFile(1000);
    await writeFile(jsonFile(), text, 'utf8');
    await loadStore({ probe: false });
    expect(persistedSessions(home)).toEqual(expected);
    const writes: number[] = [];
    setSessionDbRowWriteHookForTests((n) => writes.push(n));
    updateSessionState('deck_realproj0_brain0', 'error', 'x');
    await flushStore();
    expect(writes).toEqual([1]);
  });

  it('migrates in the production ownership branch too (write authority held)', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    resetSessionStoreAuthorityForTests();
    const identity = currentDaemonProcessIdentity();
    const metadataPath = join(dir, 'daemon.lock.json');
    await writeFile(metadataPath, JSON.stringify({
      version: 1, ...identity, acquiredAt: Date.now(), socketPath: join(dir, 'daemon.sock'), sessionIds: [], residualResources: [],
    }), 'utf8');
    configureSessionStoreWriteAuthority(identity, metadataPath);
    await writeFile(jsonFile(), productionShapedFile(30).text, 'utf8');
    await loadStore();
    expect(Object.keys(persistedSessions(home))).toHaveLength(30);
    expect(existsSync(frozenFile())).toBe(true);
  });
});

describe('writes are incremental', () => {
  beforeEach(async () => {
    await writeFile(jsonFile(), productionShapedFile(300).text, 'utf8');
    await loadStore({ probe: false });
  });

  it('a flush after one change writes exactly that row, not the store', async () => {
    const writes: number[] = [];
    setSessionDbRowWriteHookForTests((n) => writes.push(n));
    updateSessionState('deck_realproj1_w11', 'error', 'boom');
    await flushStore();
    expect(writes).toEqual([1]);
    expect(persistedSessions(home).deck_realproj1_w11).toMatchObject({ state: 'error', error: 'boom' });
    await flushStore();
    expect(writes).toEqual([1]); // nothing changed: nothing written
  });

  it('the debounced flush serialises only the changed record, not all 300', async () => {
    await flushStore(); // settles the first full comparison
    const stringify = vi.spyOn(JSON, 'stringify');
    updateSessionState('deck_realproj1_w11', 'running');
    await sleep(900); // the 500 ms debounce fires and its write completes
    expect(persistedSessions(home).deck_realproj1_w11).toMatchObject({ state: 'running' });
    const stringifiedRecords = stringify.mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'projectName' in (value as object)).length;
    expect(stringifiedRecords).toBeLessThanOrEqual(3);
  });

  it('a burst of mutations inside the debounce window is one transaction with the final state', async () => {
    const perTransaction: number[] = [];
    setSessionDbRowWriteHookForTests((n) => { if (n === 1) perTransaction.push(0); perTransaction[perTransaction.length - 1] = n; });
    for (let i = 0; i < 50; i += 1) {
      updateSessionState('deck_realproj1_w11', i % 2 === 0 ? 'running' : 'idle');
      upsertSession(record(`deck_realproj_burst${i}`));
    }
    await flushStore();
    expect(perTransaction).toEqual([51]); // one transaction: 50 new rows + the one changed row
    expect(Object.keys(persistedSessions(home))).toHaveLength(350);
    expect(persistedSessions(home).deck_realproj1_w11).toMatchObject({ state: 'idle' });
  });

  it('an in-place mutation made through getSession() is persisted by flushStore()', async () => {
    getSession('deck_realproj1_w11')!.description = 'edited in place';
    (getSession('deck_realproj1_w11')!.transportConfig as Record<string, unknown>).note = 'nested edit';
    await flushStore();
    expect(persistedSessions(home).deck_realproj1_w11).toMatchObject({ description: 'edited in place', transportConfig: { note: 'nested edit' } });
  });

  it('an in-place mutation is also caught by the periodic full comparison on an ordinary flush', async () => {
    await flushStore();
    vi.useFakeTimers({ toFake: ['Date'] }); // the debounce timer stays real; only the clock jumps
    getSession('deck_realproj1_w11')!.description = 'edited in place';
    vi.setSystemTime(Date.now() + 31_000);
    upsertSession(record('deck_realproj_trigger'));
    await sleep(900);
    expect(persistedSessions(home).deck_realproj1_w11).toMatchObject({ description: 'edited in place' });
  });

  it('a session removed and another created while a flush is comparing rows both land', async () => {
    setSessionStoreSweepSliceMsForTests(0); // yield after every record
    const flush = flushStore();
    removeSession('deck_realproj1_w11');
    upsertSession(record('deck_realproj_racer', { note: 'made mid-flush' }));
    await flush;
    await flushStore();
    const persisted = persistedSessions(home);
    expect(persisted.deck_realproj1_w11).toBeUndefined();
    expect(persisted.deck_realproj_racer).toMatchObject({ note: 'made mid-flush' });
    expect(Object.keys(persisted)).toHaveLength(300);
  });

  it('a restart with a flush pending loses nothing', async () => {
    upsertSession(record('deck_realproj_pending', { identityPrompt: 'kept' }));
    await flushStore(); // shutdown path, before the 500 ms debounce fired
    await fresh();
    expect(getSession('deck_realproj_pending')?.identityPrompt).toBe('kept');
    expect(listSessions()).toHaveLength(301);
  });

  it('comparing rows yields to the event loop instead of holding it for the whole store', async () => {
    setSessionStoreSweepSliceMsForTests(0);
    let turns = 0;
    let done = false;
    const spin = () => { turns += 1; if (!done) setImmediate(spin); };
    setImmediate(spin);
    await flushStore();
    done = true;
    expect(turns).toBeGreaterThan(100);
  });
});

describe('failure keeps the last good state', () => {
  beforeEach(async () => {
    await writeFile(jsonFile(), productionShapedFile(50).text, 'utf8');
    await loadStore({ probe: false });
  });

  it('a write that fails midway rolls the whole flush back, then the retry succeeds', async () => {
    const before = persistedSessions(home);
    for (let i = 0; i < 10; i += 1) upsertSession(record(`deck_realproj_new${i}`));
    setSessionDbFailAfterRowWritesForTests(4);
    await expect(flushStore()).rejects.toThrow(/simulated/);
    expect(persistedSessions(home)).toEqual(before);
    setSessionDbFailAfterRowWritesForTests(null);
    await flushStore();
    expect(Object.keys(persistedSessions(home))).toHaveLength(60);
  });

  it('a real full disk (SQLITE_FULL) fails cleanly, keeps every committed row, and recovers when space returns', async () => {
    const db = sessionStoreWriterConnectionForTests()!;
    const pages = Number((db.prepare('PRAGMA page_count').get() as { page_count: number | bigint }).page_count);
    const before = persistedSessions(home);
    db.exec(`PRAGMA max_page_count = ${pages + 2}`); // the database cannot grow past this
    for (let i = 0; i < 5; i += 1) upsertSession(record(`deck_realproj_big${i}`, { note: 'x'.repeat(200_000) }));
    await expect(flushStore()).rejects.toThrow(/full/i);
    expect(persistedSessions(home)).toEqual(before);
    db.exec('PRAGMA max_page_count = 1073741823');
    await flushStore(); // the rows stayed dirty
    expect(Object.keys(persistedSessions(home))).toHaveLength(55);
  });

  it('a best-effort debounced write that fails does not throw into the daemon, and retries on the next flush', async () => {
    const before = persistedSessions(home);
    upsertSession(record('deck_realproj_later'));
    setSessionDbFailAfterRowWritesForTests(0);
    await sleep(800);
    expect(persistedSessions(home)).toEqual(before);
    setSessionDbFailAfterRowWritesForTests(null);
    await flushStore();
    expect(persistedSessions(home).deck_realproj_later).toBeDefined();
  });

  it('the empty-overwrite guard refuses to delete the last rows until authorised', async () => {
    for (const session of listSessions()) removeSession(session.name);
    await flushStore();
    expect(Object.keys(persistedSessions(home))).toHaveLength(50);
    authorizeEmptySessionStoreWrite();
    await flushStore();
    expect(persistedSessions(home)).toEqual({});
  });

  it('a row that no longer parses is skipped on load, not fatal', async () => {
    const db = sessionStoreWriterConnectionForTests()!;
    db.prepare("UPDATE sessions SET payload = '{not json' WHERE name = ?").run('deck_realproj1_w1' + '1');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await fresh();
    expect(error).toHaveBeenCalled();
    expect(listSessions()).toHaveLength(49);
  });
});

describe('snapshots replace the per-flush backup copies', () => {
  const dbFiles = async () => (await readdir(dir)).filter((file) => file.startsWith('sessions.sqlite')).sort();

  it('takes an online snapshot at most once per interval, however many flushes, and keeps three', async () => {
    await writeFile(jsonFile(), productionShapedFile(50).text, 'utf8');
    await loadStore({ probe: false });
    for (let i = 0; i < 25; i += 1) { updateSessionState('deck_realproj1_w11', i % 2 === 0 ? 'running' : 'idle'); await flushStore(); }
    await waitForSessionStoreSnapshotForTests();
    expect((await dbFiles()).filter((file) => file.includes('.bak.'))).toEqual(['sessions.sqlite.bak.1']);
    expect((await readdir(dir)).filter((file) => /^sessions\.json\.\d$/.test(file))).toEqual([]); // no JSON rotation any more

    setSessionStoreBackupIntervalMsForTests(0);
    for (let i = 0; i < 6; i += 1) { updateSessionState('deck_realproj1_w11', i % 2 === 0 ? 'error' : 'idle'); await flushStore(); await waitForSessionStoreSnapshotForTests(); }
    expect((await dbFiles()).filter((file) => file.includes('.bak.')).sort()).toEqual(['sessions.sqlite.bak.1', 'sessions.sqlite.bak.2', 'sessions.sqlite.bak.3']);
    const snapshot = openSessionDbReadOnly(join(dir, 'sessions.sqlite.bak.1'))!;
    expect((snapshot.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(50);
    closeSessionDb(snapshot);
  });

  it('a flush does not rewrite anything near the size of the store', async () => {
    await writeFile(jsonFile(), productionShapedFile(300).text, 'utf8');
    await loadStore({ probe: false });
    await flushStore();
    await waitForSessionStoreSnapshotForTests();
    const db = sessionStoreWriterConnectionForTests()!;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = (await stat(join(dir, 'sessions.sqlite'))).size;
    updateSessionState('deck_realproj1_w11', 'running');
    await flushStore();
    const walBytes = (await stat(join(dir, 'sessions.sqlite-wal'))).size;
    expect(dbBytes).toBeGreaterThan(400_000);
    expect(walBytes).toBeLessThan(64 * 1024); // a few pages of a store that is hundreds of KB
  });
});

describe('readers without write authority', () => {
  const consumerEnv = () => { vi.stubEnv('VITEST', ''); vi.stubEnv('NODE_ENV', 'production'); resetSessionStoreAuthorityForTests(); };

  it('read the migrated database and never write, create or migrate anything', async () => {
    await writeFile(jsonFile(), productionShapedFile(40).text, 'utf8');
    await loadStore({ probe: false });
    await flushStore();
    consumerEnv(); // closes the daemon connection: the WAL is checkpointed into the file
    const before = await stat(join(dir, 'sessions.sqlite'));
    await loadStore();
    expect(listSessions()).toHaveLength(40);
    upsertSession(record('deck_realproj_intruder'));
    removeSession('deck_realproj0_brain0');
    await flushStore();
    const after = await stat(join(dir, 'sessions.sqlite'));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(Object.keys(persistedSessions(home))).toHaveLength(40);
  });

  it('read a not-yet-migrated install from sessions.json without touching it (an older daemon still owns it)', async () => {
    const { text } = productionShapedFile(25);
    await writeFile(jsonFile(), text, 'utf8');
    consumerEnv();
    await loadStore({ probe: false });
    expect(listSessions()).toHaveLength(25);
    expect(await readFile(jsonFile(), 'utf8')).toBe(text);
    expect(existsSync(sessionDbPathForHome(home))).toBe(false);
    expect(existsSync(frozenFile())).toBe(false);
  });

  it('a separate process (the cli / memory MCP server) reads the database through the store API', async () => {
    await writeFile(jsonFile(), productionShapedFile(60).text, 'utf8');
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_fresh', { identityPrompt: 'exact ✓' }));
    await flushStore();
    const script = `
      const store = await import(process.env.STORE_MODULE);
      await store.loadStore({ probe: false });
      const s = store.getSession('deck_realproj_fresh');
      console.log('RESULT' + JSON.stringify({ count: store.listSessions().length, prompt: s?.identityPrompt }));
    `;
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, IMCODES_HOME: join(home, '.imcodes'), USERPROFILE: home, VITEST: '', NODE_ENV: 'production', STORE_MODULE: new URL('../../src/store/session-store.ts', import.meta.url).href },
    });
    expect(JSON.parse(stdout.split('\n').find((line) => line.startsWith('RESULT'))!.slice(6))).toEqual({ count: 61, prompt: 'exact ✓' });
  }, 60_000);

  it('another process reading in a loop while the daemon writes never sees a torn or corrupt state (WAL)', async () => {
    await writeFile(jsonFile(), productionShapedFile(100).text, 'utf8');
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_pair_a', { counter: 0 }));
    upsertSession(record('deck_realproj_pair_b', { counter: 0 }));
    await flushStore();
    const stop = join(home, 'stop');
    const script = `
      const db = await import(process.env.DB_MODULE);
      const fs = await import('node:fs');
      let reads = 0, torn = 0, corrupt = 0, maxCounter = 0;
      while (!fs.existsSync(process.env.STOP_FILE)) {
        const handle = db.openSessionDbReadOnly(process.env.DB_FILE);
        try {
          const rows = db.readSessionPayloads(handle);
          const a = JSON.parse(rows.get('deck_realproj_pair_a')).counter;
          const b = JSON.parse(rows.get('deck_realproj_pair_b')).counter;
          for (const payload of rows.values()) JSON.parse(payload);
          if (a !== b) torn += 1;
          maxCounter = Math.max(maxCounter, a);
          if (rows.size < 102) corrupt += 1;
        } catch (error) { corrupt += 1; } finally { db.closeSessionDb(handle); }
        reads += 1;
        if (reads === 1) console.log('READY');
      }
      console.log('RESULT' + JSON.stringify({ reads, torn, corrupt, maxCounter }));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env, HOME: home, IMCODES_HOME: join(home, '.imcodes'), DB_MODULE: new URL('../../src/store/session-store-db.ts', import.meta.url).href,
        DB_FILE: sessionDbPathForHome(home), STOP_FILE: stop,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    // Wait for the reader's first read instead of a fixed delay: under CPU load a fresh tsx process can take
    // far longer than that to start, and the writer would finish before a single read happened.
    const readyBy = Date.now() + 60_000;
    while (!out.includes('READY') && Date.now() < readyBy) await sleep(25);
    expect(out).toContain('READY');
    for (let counter = 1; counter <= 150; counter += 1) {
      // Both rows change in one flush = one transaction; a reader must see both or neither.
      upsertSession(record('deck_realproj_pair_a', { counter }));
      upsertSession(record('deck_realproj_pair_b', { counter }));
      await flushStore();
    }
    await sleep(200); // the reader keeps looping over the final state too
    await writeFile(stop, '1');
    await new Promise((resolve) => child.on('exit', resolve));
    const result = JSON.parse(out.split('\n').find((line) => line.startsWith('RESULT'))!.slice(6)) as { reads: number; torn: number; corrupt: number; maxCounter: number };
    expect(result.reads).toBeGreaterThan(20);
    expect(result.torn).toBe(0);
    expect(result.corrupt).toBe(0);
    expect(result.maxCounter).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * What a process running the PREVIOUS build does to see sessions: the body of the base
 * build's loadStore + hydrateStore read path (read sessions.json, v2 with or without
 * prompt references, else fall back to the newest rotated backup, else nothing).
 */
async function oldBuildReadsSessions(): Promise<Record<string, Record<string, unknown>>> {
  const hydrate = (value: unknown): Record<string, Record<string, unknown>> | null => {
    const v = value as { version?: number; sessions?: Record<string, Record<string, unknown>>; identityPrompts?: Record<string, string> } | null;
    if (!v || typeof v !== 'object' || !v.sessions || typeof v.sessions !== 'object') return null;
    if (v.version === 2 && v.identityPrompts && typeof v.identityPrompts === 'object') {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [name, raw] of Object.entries(v.sessions)) {
        const { identityPromptRef, identityPrompt: inline, ...rest } = raw as Record<string, unknown>;
        const rec: Record<string, unknown> = { ...rest };
        if (typeof inline === 'string') rec.identityPrompt = inline;
        else if (typeof identityPromptRef === 'string' && typeof v.identityPrompts[identityPromptRef] === 'string') rec.identityPrompt = v.identityPrompts[identityPromptRef];
        out[name] = rec;
      }
      return out;
    }
    return v.sessions;
  };
  try {
    return hydrate(JSON.parse(await readFile(jsonFile(), 'utf8'))) ?? {};
  } catch {
    for (let index = 1; index <= 5; index += 1) {
      try {
        const backup = hydrate(JSON.parse(await readFile(`${jsonFile()}.${index}`, 'utf8')));
        if (backup && Object.keys(backup).length > 0) return backup;
      } catch { /* next backup */ }
    }
    return {};
  }
}

describe('sessions.json compatibility export (older processes, downgrade)', () => {
  const finishedExports = async () => { await waitForCompatExportForTests(); return sessionsJsonCompatExportStatsForTests().completed; };

  it('an old-build reader sees a session created AFTER the migration (P0 skew counterexample)', async () => {
    await writeFile(jsonFile(), productionShapedFile(40).text, 'utf8');
    await loadStore({ probe: false });
    await finishedExports();
    expect(Object.keys(await oldBuildReadsSessions())).toHaveLength(40); // right after migration, not a stale .1-.5

    upsertSession(record('deck_realproj_after_upgrade', { identityPrompt: 'p ✓' }));
    updateSessionState('deck_realproj0_brain0', 'error', 'boom');
    await flushStore();
    const seen = await oldBuildReadsSessions();
    expect(seen.deck_realproj_after_upgrade).toMatchObject({ projectName: 'realproj', identityPrompt: 'p ✓' });
    expect(seen.deck_realproj0_brain0).toMatchObject({ state: 'error', error: 'boom' });
    expect(Object.keys(seen)).toHaveLength(41);
  });

  it('carries a format marker and mirrors the database exactly', async () => {
    await writeFile(jsonFile(), productionShapedFile(30).text, 'utf8');
    await loadStore({ probe: false });
    await flushStore();
    const exported = JSON.parse(await readFile(jsonFile(), 'utf8')) as Record<string, unknown>;
    expect(exported.version).toBe(2);
    expect(exported[SESSIONS_JSON_COMPAT_EXPORT_MARKER_KEY]).toMatchObject({ format: SESSIONS_JSON_COMPAT_EXPORT_FORMAT_VERSION, source: 'sessions.sqlite' });
    expect(exported.sessions).toEqual(persistedSessions(home));
  });

  it('is written only after a flush that committed changed rows, coalesced to one per interval', async () => {
    await loadStore({ probe: false });
    await flushStore();
    const baseline = await finishedExports();
    await flushStore(); await flushStore(); // nothing changed
    expect(await finishedExports()).toBe(baseline);

    // shutdown/explicit flushes export what is pending at once (the old readers must be current at exit)
    upsertSession(record('deck_realproj_explicit'));
    await flushStore();
    expect((await oldBuildReadsSessions()).deck_realproj_explicit).toBeDefined();
  });

  it('debounced commits inside the interval are coalesced into one export that carries all of them', async () => {
    await loadStore({ probe: false });
    await flushStore(); // exports now: the interval starts
    const baseline = await finishedExports();
    for (let i = 0; i < 5; i += 1) { upsertSession(record(`deck_realproj_c${i}`)); await sleep(650); } // 5 commits, ~3.3 s < 5 s
    expect(persistedSessions(home)).toHaveProperty('deck_realproj_c4'); // all committed to the database...
    expect(sessionsJsonCompatExportStatsForTests().completed).toBe(baseline); // ...and not one export yet
    expect(Object.keys(await oldBuildReadsSessions())).toEqual([]);
    await sleep(2_600); // the interval elapses
    expect(sessionsJsonCompatExportStatsForTests().completed).toBe(baseline + 1); // one export, not five
    expect(Object.keys(await oldBuildReadsSessions()).sort()).toEqual(['deck_realproj_c0', 'deck_realproj_c1', 'deck_realproj_c2', 'deck_realproj_c3', 'deck_realproj_c4']);
  }, 30_000);

  it('a debounced write is exported by the timer, not per mutation', async () => {
    await loadStore({ probe: false });
    await flushStore();
    const before = await finishedExports();
    upsertSession(record('deck_realproj_timer'));
    await sleep(900); // debounce 500 ms; then the export timer (interval is far from elapsed only if it just ran)
    await sleep(5_300);
    expect(sessionsJsonCompatExportStatsForTests().completed).toBeGreaterThan(before);
    expect((await oldBuildReadsSessions()).deck_realproj_timer).toBeDefined();
  }, 30_000);

  it('is atomic (no leftover temporary file) and never rotates .1-.5', async () => {
    await loadStore({ probe: false });
    for (let i = 0; i < 8; i += 1) { upsertSession(record(`deck_realproj_r${i}`)); await flushStore(); }
    await waitForCompatExportForTests();
    const files = await readdir(dir);
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(files.filter((file) => /^sessions\.json\.\d$/.test(file))).toEqual([]);
  });

  it('an empty-store refusal exports nothing new', async () => {
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_keep'));
    await flushStore();
    const baseline = await finishedExports();
    removeSession('deck_realproj_keep');
    await flushStore(); // refused
    expect(await finishedExports()).toBe(baseline);
    expect(Object.keys(await oldBuildReadsSessions())).toEqual(['deck_realproj_keep']);
  });

  it('stops at the sunset instant: the one switch', async () => {
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_before'));
    await flushStore();
    await waitForCompatExportForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SESSIONS_JSON_COMPAT_EXPORT_SUNSET_AT_MS + 1000);
    const baseline = sessionsJsonCompatExportStatsForTests().completed;
    upsertSession(record('deck_realproj_after_sunset'));
    await flushStore();
    expect(sessionsJsonCompatExportStatsForTests().completed).toBe(baseline);
    expect((await oldBuildReadsSessions()).deck_realproj_after_sunset).toBeUndefined();
    expect(persistedSessions(home).deck_realproj_after_sunset).toBeDefined(); // the database is unaffected
  });

  it('the main thread only hands the strings over: well under a millisecond-scale budget at 300 sessions', async () => {
    await writeFile(jsonFile(), productionShapedFile(300).text, 'utf8');
    await loadStore({ probe: false });
    await flushStore();
    updateSessionState('deck_realproj1_w11', 'running');
    await flushStore();
    expect(sessionsJsonCompatExportStatsForTests().lastMainThreadMs).toBeLessThan(15); // generous CI bound; measured ~1 ms
  });

  it('does not keep a process alive: a writer process that loaded, flushed and exported exits by itself', async () => {
    const script = `
      const store = await import(process.env.STORE_MODULE);
      await store.loadStore({ probe: false });
      store.upsertSession(${JSON.stringify(record('deck_realproj_exit'))});
      await store.flushStore();
    `;
    const started = Date.now();
    await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, IMCODES_HOME: join(home, '.imcodes'), USERPROFILE: home, STORE_MODULE: new URL('../../src/store/session-store.ts', import.meta.url).href },
      timeout: 30_000,
    });
    expect(Date.now() - started).toBeLessThan(25_000); // a ref'd export worker would run into the timeout above
    expect(JSON.parse(await readFile(jsonFile(), 'utf8')).sessions.deck_realproj_exit).toBeDefined();
  }, 40_000);

  it('never reads it back: a downgrade-and-reupgrade keeps the database, ignoring what the old daemon wrote', async () => {
    await writeFile(jsonFile(), productionShapedFile(30).text, 'utf8');
    await loadStore({ probe: false });
    await flushStore();
    const rows = persistedSessions(home);
    // An older daemon ran (downgrade window) and rewrote sessions.json with different sessions.
    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: { deck_old_brain: record('deck_old_brain') }, identityPrompts: {} }), 'utf8');
    await fresh();
    expect(persistedSessions(home)).toEqual(rows);
    expect(getSession('deck_old_brain')).toBeUndefined();
    expect(listSessions()).toHaveLength(30);
  });

  it('the export adds no process-identity probe: one flush with its export costs exactly one (the database write\'s)', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    resetSessionStoreAuthorityForTests();
    const identity = currentDaemonProcessIdentity();
    const metadataPath = join(dir, 'daemon.lock.json');
    await writeFile(metadataPath, JSON.stringify({
      version: 1, ...identity, acquiredAt: Date.now(), socketPath: join(dir, 'daemon.sock'), sessionIds: [], residualResources: [],
    }), 'utf8');
    configureSessionStoreWriteAuthority(identity, metadataPath);
    await loadStore();
    await flushStore();
    await waitForCompatExportForTests();
    upsertSession(record('deck_realproj_probe_count'));
    probe.calls = 0;
    await flushStore(); // one database write + one export
    await waitForCompatExportForTests();
    expect(probe.calls).toBe(1);
    expect((await oldBuildReadsSessions()).deck_realproj_probe_count).toBeDefined(); // and the export did run
  });

  it('a worker replaced by a reset never fails the next export: its late exit only concerns its own jobs', async () => {
    // resetSessionStoreAuthorityForTests terminates the worker; its 'exit' event arrives later, possibly
    // after the next store has posted its export to a NEW worker. That late event used to settle every job
    // in flight as failed, so the export was never written (intermittent ENOENT under load).
    for (let round = 0; round < 25; round += 1) {
      await loadStore({ probe: false });
      upsertSession(record(`deck_realproj_round${round}`));
      await flushStore();
      await waitForCompatExportForTests();
      const exported = JSON.parse(await readFile(jsonFile(), 'utf8')) as { sessions: Record<string, unknown> };
      expect(Object.keys(exported.sessions)).toEqual([`deck_realproj_round${round}`]);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      resetSessionStoreAuthorityForTests();
    }
  }, 60_000);

  it('a lost lock stops the export too (production ownership branch)', async () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    resetSessionStoreAuthorityForTests();
    const identity = currentDaemonProcessIdentity();
    const metadataPath = join(dir, 'daemon.lock.json');
    const lock = (startToken: string) => writeFile(metadataPath, JSON.stringify({
      version: 1, pid: identity.pid, startToken, acquiredAt: Date.now(), socketPath: join(dir, 'daemon.sock'), sessionIds: [], residualResources: [],
    }), 'utf8');
    await lock(identity.startToken);
    configureSessionStoreWriteAuthority(identity, metadataPath);
    await loadStore();
    upsertSession(record('deck_realproj_owned'));
    await flushStore();
    await waitForCompatExportForTests();
    const exported = await readFile(jsonFile(), 'utf8');
    await lock(`${identity.startToken}-other`);
    upsertSession(record('deck_realproj_intruder'));
    await flushStore();
    await waitForCompatExportForTests();
    expect(await readFile(jsonFile(), 'utf8')).toBe(exported);
  });
});

describe('downgrade and version skew', () => {
  it('an older daemon started after the migration reads the current export, and the database is never touched by it', async () => {
    const { text } = productionShapedFile(30);
    await writeFile(jsonFile(), text, 'utf8');
    await writeFile(`${jsonFile()}.1`, text, 'utf8');
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_current'));
    await flushStore();
    const seen = await oldBuildReadsSessions();
    expect(Object.keys(seen)).toHaveLength(31); // current, not the stale .1
    expect(await readFile(frozenFile(), 'utf8')).toBe(text); // rollback export stays byte-identical
    const rows = persistedSessions(home);
    await writeFile(jsonFile(), JSON.stringify({ version: 2, sessions: {}, identityPrompts: {} }), 'utf8'); // the older daemon rewrites it
    await fresh();
    expect(persistedSessions(home)).toEqual(rows);
    expect(listSessions()).toHaveLength(31);
  });
});

describe('listSessions', () => {
  it('returns a fresh array each time and follows upserts, removals, in-place changes and reloads', async () => {
    await loadStore({ probe: false });
    upsertSession(record('deck_realproj_a'));
    upsertSession(record('deck_realproj_b', { projectName: 'other', providerSessionId: 'prov-b' }));
    const first = listSessions();
    first.length = 0; // a caller mutating its copy must not corrupt the store
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
    expect(listSessions('other').map((s) => s.name)).toEqual(['deck_realproj_b']);
    expect(findSessionByProviderSessionId('prov-b')?.name).toBe('deck_realproj_b');

    upsertSession(record('deck_realproj_c'));
    expect(listSessions()).toHaveLength(3);
    upsertSession(record('deck_realproj_a', { projectName: 'other' }));
    expect(listSessions('other').map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
    removeSession('deck_realproj_c');
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
    updateSessionState('deck_realproj_a', 'running');
    expect(listSessions().find((s) => s.name === 'deck_realproj_a')?.state).toBe('running');

    await flushStore();
    await fresh();
    expect(listSessions().map((s) => s.name).sort()).toEqual(['deck_realproj_a', 'deck_realproj_b']);
  });
});
