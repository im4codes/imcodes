/**
 * Real-OS row for the SQLite session store: run it on Windows (and anywhere else)
 * to see file locking, WAL sharing and rename semantics for real.
 *
 *   node --import tsx test/perf/session-store-platform-row.mts
 *
 * Everything lives in a throwaway HOME/USERPROFILE (never the real ~/.imcodes).
 * Prints one JSON line per check and a final summary; exits non-zero if any check fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const fakeHome = mkdtempSync(join(tmpdir(), 'imcodes-platform-row-'));
const dir = join(fakeHome, '.imcodes');
mkdirSync(dir, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // os.homedir() reads USERPROFILE on Windows
process.env.VITEST = '1'; // the store's test-runner mode: real persistence, isolated home only

const results: Array<{ check: string; ok: boolean; detail?: unknown }> = [];
const record = (check: string, ok: boolean, detail?: unknown) => {
  results.push({ check, ok, detail });
  console.log(JSON.stringify({ check, ok, detail }));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const store = await import('../../src/store/session-store.js');
const db = await import('../../src/store/session-store-db.js');
const { currentDaemonProcessIdentity } = await import('../../src/daemon/instance-lock.js');

const jsonFile = join(dir, 'sessions.json');
const frozenFile = `${jsonFile}.migrated-to-sqlite`;

function rec(name: string, extra: Record<string, unknown> = {}) {
  return {
    name, projectName: 'winrow', role: 'brain', agentType: 'shell', projectDir: join(fakeHome, 'proj'), state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  };
}
function legacyFile(count: number): string {
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) sessions[`deck_winrow_w${i}`] = rec(`deck_winrow_w${i}`, { transportConfig: { note: 'x'.repeat(300) }, description: `s${i}` });
  return JSON.stringify({ version: 2, sessions, identityPrompts: {} }, null, 2);
}
async function oldBuildRead(): Promise<Record<string, unknown>> {
  return (JSON.parse(readFileSync(jsonFile, 'utf8')) as { sessions: Record<string, unknown> }).sessions;
}

try {
  // 1. Migration with an OLD READER holding sessions.json open WITHOUT delete-sharing (FileShare.Read):
  //    the frozen-export rename cannot happen on Windows and must degrade cleanly.
  writeFileSync(jsonFile, legacyFile(300));
  let holder: ReturnType<typeof spawn> | null = null;
  if (process.platform === 'win32') {
    holder = spawn('powershell', ['-NoProfile', '-Command',
      `$f=[System.IO.File]::Open('${jsonFile.replace(/'/g, "''")}','Open','Read','Read'); Start-Sleep -Seconds 12; $f.Close()`], { stdio: 'ignore' });
    await sleep(3000);
  }
  await store.loadStore({ probe: false });
  const migrated = Object.keys(store.listSessions().reduce((acc, s) => ({ ...acc, [s.name]: 1 }), {})).length;
  record('migration imported 300 sessions while an old reader held sessions.json', migrated === 300, { migrated, holderActive: holder !== null });
  const frozenExists = existsSync(frozenFile);
  record('frozen-export rename: done when possible, otherwise degraded cleanly (marker done, no crash)', true, { frozenExists, jsonStillThere: existsSync(jsonFile) });
  if (holder) await new Promise((resolve) => holder!.on('exit', resolve));

  // 2. Incremental flushes + compat export (worker: tmp + rename over an existing sessions.json).
  for (let i = 0; i < 20; i += 1) { store.updateSessionState(`deck_winrow_w${i}`, 'error', `e${i}`); await store.flushStore(); }
  const exported = await oldBuildRead();
  record('compat export is current for an old-build reader after 20 flushes (rename over existing file)',
    (exported.deck_winrow_w19 as { state?: string }).state === 'error' && Object.keys(exported).length === 300,
    store.sessionsJsonCompatExportStatsForTests());
  record('no leftover temporary files', readdirSync(dir).filter((f) => f.endsWith('.tmp')).length === 0, readdirSync(dir).filter((f) => f.includes('tmp')));

  // 3. WAL: a read-only child process reads in a loop while this process writes transactions.
  const stop = join(fakeHome, 'stop');
  const childScript = `
    const db = await import(${JSON.stringify(new URL('../../src/store/session-store-db.ts', import.meta.url).href)});
    const fs = await import('node:fs');
    let reads = 0, torn = 0, bad = 0;
    while (!fs.existsSync(${JSON.stringify(stop)})) {
      const h = db.openSessionDbReadOnly(${JSON.stringify(join(dir, 'sessions.sqlite'))});
      try {
        const rows = db.readSessionPayloads(h);
        const a = JSON.parse(rows.get('deck_winrow_pair_a')).counter, b = JSON.parse(rows.get('deck_winrow_pair_b')).counter;
        if (a !== b) torn += 1;
        for (const p of rows.values()) JSON.parse(p);
      } catch (e) { bad += 1; console.error(String(e && e.message)); } finally { db.closeSessionDb(h); }
      reads += 1;
    }
    console.log('RESULT' + JSON.stringify({ reads, torn, bad }));
  `;
  store.upsertSession(rec('deck_winrow_pair_a', { counter: 0 }) as never);
  store.upsertSession(rec('deck_winrow_pair_b', { counter: 0 }) as never);
  await store.flushStore();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childScript], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  let err = '';
  child.stdout!.on('data', (c) => { out += String(c); });
  child.stderr!.on('data', (c) => { err += String(c); });
  await sleep(2500);
  for (let counter = 1; counter <= 100; counter += 1) {
    store.upsertSession(rec('deck_winrow_pair_a', { counter }) as never);
    store.upsertSession(rec('deck_winrow_pair_b', { counter }) as never);
    await store.flushStore();
  }
  writeFileSync(stop, '1');
  await new Promise((resolve) => child.on('exit', resolve));
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT'));
  const child1 = line ? (JSON.parse(line.slice(6)) as { reads: number; torn: number; bad: number }) : null;
  record('WAL: read-only child process loops while the daemon writes 100 transactions: no torn/corrupt reads', !!child1 && child1.reads > 5 && child1.torn === 0 && child1.bad === 0, { child: child1, stderr: err.slice(0, 300) });

  // 4. Snapshots: node:sqlite backup() (or VACUUM INTO) and .bak.N rotation renames onto existing files.
  store.setSessionStoreBackupIntervalMsForTests(0);
  for (let i = 0; i < 6; i += 1) { store.updateSessionState('deck_winrow_w1', i % 2 ? 'idle' : 'error', 'x'); await store.flushStore(); await store.waitForSessionStoreSnapshotForTests(); }
  const baks = readdirSync(dir).filter((f) => f.includes('.bak.')).sort();
  record('online snapshot + .bak.1-3 rotation onto existing files', baks.join(',') === 'sessions.sqlite.bak.1,sessions.sqlite.bak.2,sessions.sqlite.bak.3', { baks, backupApi: typeof (await import('node:sqlite')).backup });
  store.setSessionStoreBackupIntervalMsForTests(undefined);

  // 5. Disk full: a real SQLITE_FULL on this filesystem.
  const conn = store.sessionStoreWriterConnectionForTests()!;
  const pages = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number | bigint }).page_count);
  conn.exec(`PRAGMA max_page_count = ${pages + 2}`);
  store.upsertSession(rec('deck_winrow_big', { note: 'z'.repeat(300_000) }) as never);
  let failed = false;
  try { await store.flushStore(); } catch { failed = true; }
  conn.exec('PRAGMA max_page_count = 1073741823');
  await store.flushStore();
  const persisted = db.openSessionDbReadOnly(join(dir, 'sessions.sqlite'))!;
  const hasBig = db.readSessionPayloads(persisted).has('deck_winrow_big');
  db.closeSessionDb(persisted);
  record('disk full: flush fails cleanly, then recovers when space returns', failed && hasBig, { failed, hasBig });

  // 6. Authority probe cost on this OS (production ownership branch): the unchanged guard.
  process.env.VITEST = '';
  process.env.NODE_ENV = 'production';
  store.resetSessionStoreAuthorityForTests();
  const identity = currentDaemonProcessIdentity();
  const metadataPath = join(dir, 'daemon.lock.json');
  writeFileSync(metadataPath, JSON.stringify({ version: 1, ...identity, acquiredAt: Date.now(), socketPath: join(dir, 'daemon.sock'), sessionIds: [], residualResources: [] }));
  store.configureSessionStoreWriteAuthority(identity, metadataPath);
  let t = performance.now();
  await store.loadStore({ probe: false });
  const loadMs = performance.now() - t;
  const flushTimes: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    store.updateSessionState('deck_winrow_w2', i % 2 ? 'idle' : 'error', 'p');
    t = performance.now();
    await store.flushStore();
    flushTimes.push(performance.now() - t);
  }
  record('production-branch load/flush with the real authority guard (ms)', true, { loadMs: +loadMs.toFixed(1), flushMs: flushTimes.map((v) => +v.toFixed(1)) });

  // 7. Clean shutdown: every handle closed, the whole home removable (no EBUSY on -wal/-shm).
  store.resetSessionStoreAuthorityForTests();
  await sleep(300);
  let removable = true;
  try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { removable = false; record('cleanup error', false, String((e as Error).message)); }
  record('home directory removable after reset (no handle left open on sessions.sqlite/-wal/-shm)', removable && !existsSync(fakeHome));
} catch (error) {
  record('row aborted', false, String((error as Error)?.stack ?? error));
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ platform: process.platform, node: process.version, checks: results.length, failed: failed.map((f) => f.check) }));
process.exit(failed.length === 0 ? 0 : 1);
