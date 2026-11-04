import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { HISTORY_RETENTION, getHistoryKeep, parseHistoryKeep, setHistoryKeep } from '../../src/store/history-retention.js';
import { nextHistoryCleanupAt } from '../../src/daemon/history-retention-clock.mjs';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const DAY = HISTORY_RETENTION.dayMs;
const enabledAt = new Date(2040, 5, 3, 12).getTime();
const due = nextHistoryCleanupAt(enabledAt);
const cutoff = due - 3 * DAY;
const workers: Worker[] = [];
const homes: string[] = [];
const originalHome = process.env.IMCODES_HOME;

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  process.env.IMCODES_HOME = originalHome;
  vi.restoreAllMocks();
});

function event(sessionId: string, seq: number, ts: number, type: TimelineEvent['type'] = 'assistant.text'): TimelineEvent {
  return { sessionId, seq, ts, epoch: 40, eventId: `${sessionId}-${seq}`, type,
    source: 'daemon', confidence: 'high', payload: { text: `body-${seq}`, streaming: false } };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'imcodes-history-retention-'));
  homes.push(home);
  mkdirSync(join(home, 'timeline'));
  return home;
}

function config(home: string, days: number | null, at = enabledAt): void {
  const target = join(home, HISTORY_RETENTION.fileName);
  writeFileSync(`${target}.tmp`, JSON.stringify({ keepDays: days, enabledAt: at }));
  renameSync(`${target}.tmp`, target);
}

function source(home: string, session: string, events: TimelineEvent[]): string {
  const path = join(home, 'timeline', `${session.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return path;
}

function start(home: string) {
  const worker = new Worker(new URL('../../src/daemon/timeline-projection-worker.ts', import.meta.url), {
    workerData: { dbPath: join(home, 'timeline.sqlite'), stateDir: home,
      retention: { ...HISTORY_RETENTION, configPath: join(home, HISTORY_RETENTION.fileName) } },
    execArgv: ['--disable-warning=ExperimentalWarning'],
  });
  workers.push(worker);
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  worker.on('message', response => {
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new Error(response.error));
  });
  worker.on('error', err => { for (const entry of pending.values()) entry.reject(err); pending.clear(); });
  worker.on('exit', () => { for (const entry of pending.values()) entry.reject(new Error('worker exited')); pending.clear(); });
  return { worker, request: (type: string, payload: object = {}): Promise<any> => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  }) };
}

function inspect(home: string, sql: string): any[] {
  const db = new DatabaseSync(join(home, 'timeline.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

async function rebuild(client: ReturnType<typeof start>, sessionId: string): Promise<void> {
  expect(await client.request('rebuildSession', { sessionId })).toBe(true);
}

describe('SQLite chat retention settings', () => {
  it('is opt-in; strict arguments and overflow cannot change config', () => {
    process.env.IMCODES_HOME = makeHome();
    expect(getHistoryKeep()).toBeNull();
    expect(setHistoryKeep('3')).toBe(3);
    const before = readFileSync(join(process.env.IMCODES_HOME, HISTORY_RETENTION.fileName), 'utf8');
    for (const invalid of ['0', '-1', '1.2', 'NaN', 'Infinity', '1e3', ' 3', '3 ', '100000001', '9007199254740992', '', '03']) {
      expect(() => setHistoryKeep(invalid), invalid).toThrow();
      expect(readFileSync(join(process.env.IMCODES_HOME, HISTORY_RETENTION.fileName), 'utf8')).toBe(before);
    }
    expect(parseHistoryKeep('1')).toBe(1);
    expect(parseHistoryKeep('100000000')).toBe(100000000);
    expect(setHistoryKeep('3')).toBe(3);
    expect(readFileSync(join(process.env.IMCODES_HOME, HISTORY_RETENTION.fileName), 'utf8')).toBe(before);
    expect(getHistoryKeep()).toBe(3);
    expect(setHistoryKeep('off')).toBeNull();
    expect(getHistoryKeep()).toBeNull();
  });
});

describe('real SQLite writer retention', () => {
  it('keeps exact boundaries/body, all session forms, invalid ts; SQL deletes rows not JSONL; cursor survives all-old and missing JSONL', async () => {
    const home = makeHome();
    const client = start(home);
    const sessions = ['deck_proj_brain', 'deck_sub_child', 'odd/session:名', 'all_old', 'empty'];
    const bytes = new Map<string, string>();
    for (const session of sessions) {
      const events = session === 'empty' ? [] : session === 'all_old'
        ? [event(session, 1, cutoff - 10), event(session, 2, cutoff - 1)]
        : [event(session, 1, cutoff - 1), event(session, 2, cutoff), event(session, 3, cutoff + 1, 'user.message'),
          event(session, 4, cutoff - 2, 'session.state'), event(session, 5, -1), event(session, 6, Number.NaN)];
      const path = source(home, session, events);
      bytes.set(path, readFileSync(path, 'utf8'));
      await rebuild(client, session);
    }
    config(home, 3);
    const before = await client.request('retentionTick', { now: due - 1 });
    expect(before).toMatchObject({ runs: 0, cutoff: null, next_run: due, skipped: true });
    const result = await client.request('retentionTick', { now: due });
    expect(result).toMatchObject({ runs: 1, deleted: 8, cutoff, last_success: due });
    for (const session of sessions.slice(0, 3)) {
      const rows = inspect(home, `SELECT seq, ts, payload_json FROM timeline_projection_events WHERE session_id = '${session}' ORDER BY append_ordinal`);
      expect(rows.map(row => row.seq)).toEqual([2, 3, 5, 6]);
      expect(JSON.parse(rows[1].payload_json).text).toBe('body-3');
    }
    expect(inspect(home, "SELECT * FROM timeline_projection_events WHERE session_id IN ('all_old','empty')")).toHaveLength(0);
    expect(await client.request('queryLatest', { sessionId: 'all_old' })).toEqual({ epoch: 40, seq: 2 });
    expect(inspect(home, "SELECT last_projected_append_ordinal FROM timeline_projection_sessions WHERE session_id='all_old'" )[0].last_projected_append_ordinal).toBe(2);
    for (const [path, body] of bytes) expect(readFileSync(path, 'utf8')).toBe(body);
    unlinkSync(join(home, 'timeline', 'deck_sub_child.jsonl'));
    await rebuild(client, 'deck_sub_child');
    expect((await client.request('queryHistory', { sessionId: 'deck_sub_child' })).events).toHaveLength(4);
    expect(await client.request('queryLatest', { sessionId: 'deck_sub_child' })).toEqual({ epoch: 40, seq: 6 });
  });

  it('does not sweep on reads/appends/restarts/repeated settings; daily expiry and import fence survive disk roundtrip and off', async () => {
    const home = makeHome();
    let client = start(home);
    const path = source(home, 'deck_main', [event('deck_main', 1, cutoff - 1), event('deck_main', 2, cutoff)]);
    await rebuild(client, 'deck_main');
    config(home, 3);
    const first = await client.request('retentionTick', { now: due });
    for (let seq = 3; seq < 30; seq++) {
      const e = event('deck_main', seq, seq % 2 ? cutoff - 1 : cutoff + 100);
      appendFileSync(path, JSON.stringify(e) + '\n');
      await client.request('recordAppendedEvent', { event: e });
      await client.request('queryHistory', { sessionId: 'deck_main', afterSeq: 1, epoch: 40 });
    }
    // No automatic scans during per-event operations. Just O(1) import filtering.
    config(home, 3);
    expect(await client.request('retentionTick', { now: due + 1 })).toMatchObject({ runs: 1, batches: first.batches, skipped: true });
    await rebuild(client, 'deck_main');
    expect(inspect(home, `SELECT * FROM timeline_projection_events WHERE ts < ${cutoff}`)).toHaveLength(0);
    await client.worker.terminate();
    client = start(home);
    expect(await client.request('retentionTick', { now: due + DAY - 1 })).toMatchObject({ runs: 1, skipped: true });
    expect(await client.request('queryLatest', { sessionId: 'deck_main' })).toEqual({ epoch: 40, seq: 29 });
    expect(await client.request('retentionTick', { now: due + DAY })).toMatchObject({ runs: 2, cutoff: cutoff + DAY });
    expect(inspect(home, 'SELECT * FROM timeline_projection_events')).toHaveLength(0);
    expect(await client.request('queryLatest', { sessionId: 'deck_main' })).toEqual({ epoch: 40, seq: 29 });
    config(home, null);
    expect(await client.request('retentionTick', { now: due + 20 * DAY })).toEqual({ skipped: true });
    await rebuild(client, 'deck_main');
    expect(inspect(home, 'SELECT * FROM timeline_projection_events')).toHaveLength(0);
    // Off stops new expiry; a timestamp beyond the previously purged range stays.
    const late = event('deck_main', 30, cutoff + DAY);
    appendFileSync(path, JSON.stringify(late) + '\n');
    await client.request('recordAppendedEvent', { event: late });
    expect(inspect(home, 'SELECT seq FROM timeline_projection_events').map(e => e.seq)).toEqual([30]);
  });

  it('default/upgrade without config never deletes; large days and rollback do not widen deletion', async () => {
    const home = makeHome();
    const client = start(home);
    source(home, 'deck_test', [event('deck_test', 1, 1)]);
    await rebuild(client, 'deck_test');
    expect(await client.request('retentionTick', { now: due })).toEqual({ skipped: true });
    expect(inspect(home, 'SELECT * FROM timeline_projection_events')).toHaveLength(1);
    config(home, HISTORY_RETENTION.maxDays);
    expect(await client.request('retentionTick', { now: due })).toMatchObject({ runs: 1, deleted: 0, cutoff: 0 });
    expect(await client.request('retentionTick', { now: enabledAt - DAY })).toMatchObject({ runs: 1, skipped: true });
  });

  it('missed slots catch up once, changes keep the slot, off/on waits for a new 03:00', async () => {
    const home = makeHome();
    config(home, 3);
    const client = start(home);
    source(home, 'deck_test', [event('deck_test', 1, 1)]);
    await rebuild(client, 'deck_test');
    const resumed = due + 10 * DAY + 100;
    expect(await client.request('retentionTick', { now: resumed })).toMatchObject({ runs: 1, last_success: resumed, next_run: nextHistoryCleanupAt(resumed) });
    config(home, 1);
    expect(await client.request('retentionTick', { now: resumed + 1 })).toMatchObject({ runs: 1, skipped: true });
    config(home, null);
    await client.request('retentionTick', { now: resumed + DAY });
    config(home, 1, resumed + DAY);
    expect(await client.request('retentionTick', { now: resumed + DAY })).toMatchObject({ runs: 1, skipped: true, next_run: nextHistoryCleanupAt(resumed + DAY) });
  });

  it('batch yields allow concurrent read/append/rebuild; disabling interrupts; partial progress is retryable', async () => {
    const home = makeHome();
    const client = start(home);
    const events = Array.from({ length: 5000 }, (_, i) => event('deck_test', i + 1, cutoff - 1));
    const path = source(home, 'deck_test', events);
    await rebuild(client, 'deck_test');
    config(home, 3);
    const cleaning = client.request('retentionTick', { now: due });
    const read = client.request('queryLatest', { sessionId: 'deck_test' });
    const fresh = event('deck_test', 5001, cutoff + 1);
    appendFileSync(path, JSON.stringify(fresh) + '\n');
    const write = client.request('recordAppendedEvent', { event: fresh });
    expect(await read).toEqual({ epoch: 40, seq: 5000 });
    await write;
    config(home, null);
    await cleaning;
    expect(inspect(home, `SELECT * FROM timeline_projection_events WHERE seq=5001`)).toHaveLength(1);
    config(home, 3);
    await client.request('retentionTick', { now: due });
    await rebuild(client, 'deck_test');
    expect(inspect(home, 'SELECT seq FROM timeline_projection_events').map(e => e.seq)).toEqual([5001]);
  });

  it('CLI settings reach the already-running writer without restart', async () => {
    const home = makeHome();
    const client = start(home);
    const ts = Date.now();
    source(home, 'deck_cli', [event('deck_cli', 1, ts - 10 * DAY), event('deck_cli', 2, ts)]);
    await rebuild(client, 'deck_cli');
    const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', entry, 'history', 'keep', '3'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, IMCODES_HOME: home }, encoding: 'utf8', timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, HISTORY_RETENTION.fileName), 'utf8'));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && inspect(home, 'SELECT next_run FROM timeline_retention')[0].next_run === null) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const next = nextHistoryCleanupAt(saved.enabledAt);
    expect(inspect(home, 'SELECT next_run FROM timeline_retention')[0].next_run).toBe(next);
    expect(inspect(home, 'SELECT * FROM timeline_projection_events')).toHaveLength(2);
    expect(await client.request('retentionTick', { now: next })).toMatchObject({ runs: 1, deleted: 1 });
    expect(inspect(home, 'SELECT seq FROM timeline_projection_events').map(e => e.seq)).toEqual([2]);
  });

  it('a killed mid-sweep writer retains its fence and retries partial deletion after restart', async () => {
    const home = makeHome();
    let client = start(home);
    source(home, 'deck_killed', Array.from({ length: 10000 }, (_, i) => event('deck_killed', i + 1, cutoff - 1)));
    await rebuild(client, 'deck_killed');
    config(home, 3);
    const cleaning = client.request('retentionTick', { now: due }).catch(error => error);
    await client.request('queryLatest', { sessionId: 'deck_killed' });
    await client.worker.terminate();
    await cleaning;
    const partial = inspect(home, 'SELECT * FROM timeline_retention')[0];
    expect(partial.cutoff).toBe(cutoff);
    expect(partial.deleted).toBeGreaterThan(0);
    expect(partial.deleted).toBeLessThan(10000);
    expect(partial.runs).toBe(0);
    client = start(home);
    expect(await client.request('retentionTick', { now: due + 1 })).toMatchObject({ runs: 1, deleted: 10000 });
    expect(await client.request('queryLatest', { sessionId: 'deck_killed' })).toEqual({ epoch: 40, seq: 10000 });
    expect(inspect(home, 'PRAGMA integrity_check')[0].integrity_check).toBe('ok');
  });

  it('100k production-shaped rows clean in indexed batches without blocking the main event loop', async () => {
    const home = makeHome();
    const client = start(home);
    await client.request('queryHistory', { sessionId: 'empty' }); // schema only, no data scan
    const db = new DatabaseSync(join(home, 'timeline.sqlite'));
    const insert = db.prepare(`INSERT INTO timeline_projection_events
      (session_id,append_ordinal,event_id,ts,seq,epoch,type,source,confidence,text,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,40,'assistant.text','daemon','high',?,?,?,?)`);
    const meta = db.prepare(`INSERT INTO timeline_projection_sessions VALUES (?,2500,0,0,1,'ready',NULL)`);
    const body = 'x'.repeat(512);
    db.exec('BEGIN');
    for (let session = 0; session < 40; session++) {
      const id = `deck_${session % 2 ? 'sub' : 'main'}_${session}`;
      meta.run(id);
      for (let seq = 1; seq <= 2500; seq++) {
        const ts = seq <= 2000 ? cutoff - seq : cutoff + seq;
        insert.run(id, seq, `${id}-${seq}`, ts, seq, body, JSON.stringify({ text: body }), ts, ts);
      }
    }
    db.exec('COMMIT');
    db.close();
    config(home, 3);
    let maxTimerDelayMs = 0;
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last); last = now; }, 5);
    const started = performance.now();
    try {
      const cleaning = client.request('retentionTick', { now: due });
      const queryStart = performance.now();
      const reading = client.request('queryHistory', { sessionId: 'deck_main_0', limit: 20 });
      expect((await reading).events.length).toBeGreaterThan(0);
      const queryMs = performance.now() - queryStart;
      const state = await cleaning;
      const cleanupMs = performance.now() - started;
      console.log('RETENTION_PERF', JSON.stringify({ rows: 100000, sessions: 40, deleted: state.deleted,
        batches: state.batches, cleanupMs, concurrentQueryMs: queryMs, maxMainTimerDelayMs: maxTimerDelayMs }));
      expect(state).toMatchObject({ runs: 1, deleted: 80000, batches: 200 });
      expect(cleanupMs).toBeLessThan(20000);
      expect(queryMs).toBeLessThan(2000);
      expect(maxTimerDelayMs).toBeLessThan(500);
      expect(inspect(home, 'SELECT count(*) AS n FROM timeline_projection_events')[0].n).toBe(20000);
      const before = inspect(home, 'SELECT batches FROM timeline_retention')[0].batches;
      for (let i = 0; i < 100; i++) await client.request('queryHistory', { sessionId: 'deck_main_0', limit: 1 });
      expect(inspect(home, 'SELECT batches FROM timeline_retention')[0].batches).toBe(before);
    } finally { clearInterval(timer); }
  }, 60000);

  it('interrupted worker retries idempotently; lock failure is visible, backed off and retryable', async () => {
    const home = makeHome();
    let client = start(home);
    source(home, 'deck_test', Array.from({ length: 2000 }, (_, i) => event('deck_test', i + 1, cutoff - 1)));
    await rebuild(client, 'deck_test');
    config(home, 3);
    const lock = new DatabaseSync(join(home, 'timeline.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    const cleaning = client.request('retentionTick', { now: due });
    // SQLite busy timeout is in the worker; main thread remains responsive.
    await expect(cleaning).rejects.toThrow(/locked|busy/i);
    lock.exec('ROLLBACK');
    lock.close();
    expect(await client.request('retentionTick', { now: due + 60_001 })).toMatchObject({ runs: 1, deleted: 2000 });
    await client.worker.terminate();
    client = start(home);
    expect(await client.request('retentionTick', { now: due + 60_002 })).toMatchObject({ runs: 1, skipped: true });
    expect(inspect(home, 'PRAGMA integrity_check')[0].integrity_check).toBe('ok');
  }, 30_000);
});
