import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyHistoryReader, hashAgyPrompt, recoverAgyResponseSync } from '../../src/agent/agy-native-history.js';
import { AGY_HISTORY_LIMIT } from '../../shared/agy-native-history.js';
// Native layout fixture is executable by both the fake CLI and this suite.
const fixture = createRequire(import.meta.url)('../fixtures/agy-native-history/fixture.cjs');
const dirs: string[] = [];
const readers: AgyHistoryReader[] = [];
function setup(options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'imcodes-agy-history-'));
  dirs.push(home);
  const now = Date.now();
  fixture.persist(home, 'current input', { at: now, ...options });
  return { home, conversationId: fixture.CONVERSATION, promptHash: hashAgyPrompt('current input'), sentAt: now-1, resultAt: now+1, error: fixture.ERROR };
}
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.dispose();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('AG native completed-turn proof (read-only)', () => {
  it('recovers a lost current response while the old quota record remains, without modifying the DB', () => {
    const request = setup();
    const file = path.join(request.home, '.gemini/antigravity-cli/conversations', `${fixture.CONVERSATION}.db`);
    const before = readFileSync(file);
    expect(recoverAgyResponseSync(request)).toEqual({ userStepIndex:11928,responseStepIndex:11929,text:'The actual current answer' });
    expect(readFileSync(file)).toEqual(before);
    const db = fixture.open(request.home);
    expect(db.prepare('SELECT status FROM steps WHERE idx=11927').get().status).toBe(5);
    db.close();
  });
  it.each(['partial','currentError','laterTool','errorDetails','mismatch','noHistory'])('does not recover without complete proof: %s', key => {
    expect(recoverAgyResponseSync(setup({ [key]:true }))).toBeUndefined();
  });
  it('rejects stale and future input/output timestamps, mismatched input/error/conversation and path traversal', () => {
    const request = setup();
    for (const delta of [
      {sentAt:request.resultAt+100}, {resultAt:request.sentAt}, {promptHash:hashAgyPrompt('another input')},
      {error:'Individual quota reached. New quota error'}, {conversationId:'../../sessions'},
      {conversationId:'00000000-0000-0000-0000-000000000000'}, {home:'relative'},
    ]) expect(recoverAgyResponseSync({...request,...delta})).toBeUndefined();
  });
  it('refuses two indistinguishable queued inputs rather than recovering the other turn', () => {
    const request = setup();
    fixture.persist(request.home, 'current input', {at:request.resultAt});
    expect(recoverAgyResponseSync(request)).toBeUndefined();
  });
  it('binds different queued inputs to their own completed turn, not the newest response', () => {
    const request = setup();
    fixture.persist(request.home, 'second input', {at:request.resultAt,answer:'Second'});
    expect(recoverAgyResponseSync(request)?.text).toBe('The actual current answer');
    expect(recoverAgyResponseSync({...request,promptHash:hashAgyPrompt('second input')})?.text).toBe('Second');
  });
  it('refuses unknown/truncated payloads and overlarge rows', () => {
    const request = setup();
    const db = fixture.open(request.home);
    for (const bytes of [Buffer.from([0x82,0x01,0xff]),Buffer.alloc(AGY_HISTORY_LIMIT.ROW_BYTES+1)]) {
      db.prepare('UPDATE steps SET step_payload=? WHERE idx=11929').run(bytes);
      expect(recoverAgyResponseSync(request)).toBeUndefined();
    }
    db.close();
  });
  it('does not create a missing DB or accept an unknown schema', () => {
    const request = setup();
    const file = path.join(request.home, '.gemini/antigravity-cli/conversations', `${fixture.CONVERSATION}.db`);
    rmSync(file);
    expect(recoverAgyResponseSync(request)).toBeUndefined();
    writeFileSync(file,'not sqlite');
    expect(recoverAgyResponseSync(request)).toBeUndefined();
  });
  it('uses one reusable isolated worker and closes pending reads safely', async () => {
    const request = setup();
    const reader = new AgyHistoryReader();
    readers.push(reader);
    expect((await reader.read(request))?.text).toBe('The actual current answer');
    expect((await reader.read(request))?.text).toBe('The actual current answer');
    const pending = reader.read(request);
    reader.close();
    expect(await pending).toBeUndefined();
  });
  it('bounds a wedged worker, releases all callers and ignores late IPC from the old instance', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter();
    const worker = Object.assign(events, {pid:1,exitSignal:null,unref:vi.fn(),postMessage:vi.fn(),forceKill:vi.fn(),terminate:async()=>0});
    const create = vi.fn(()=>worker);
    const reader = new AgyHistoryReader(create);
    readers.push(reader);
    const request = setup();
    const a = reader.read(request);
    const b = reader.read(request);
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGY_HISTORY_LIMIT.TIMEOUT_MS);
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
    expect(worker.forceKill).toHaveBeenCalledTimes(1);
    events.emit('message',{id:1,response:{text:'late'}});
  });

  it('fails closed on a busy database and a missing step inside the current turn', () => {
    const request = setup();
    const db = fixture.open(request.home);
    db.exec('BEGIN EXCLUSIVE');
    expect(recoverAgyResponseSync(request)).toBeUndefined();
    db.exec('ROLLBACK');
    db.exec('UPDATE steps SET idx=11930 WHERE idx=11929');
    expect(recoverAgyResponseSync(request)).toBeUndefined();
    db.close();
  });

  it('reads a bounded tail of a production-sized history, not its tool payloads', () => {
    const request = setup();
    const db = fixture.open(request.home);
    db.exec('DELETE FROM steps WHERE idx>11927');
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(11928) UNION ALL SELECT i+1 FROM n WHERE i<29927)
      INSERT INTO steps SELECT i,132,3,?,NULL,zeroblob(12288) FROM n`).run(fixture.metadata(request.sentAt-86400000));
    db.close();
    fixture.persist(request.home,'current input',{at:request.sentAt+1});
    const started = performance.now();
    expect(recoverAgyResponseSync(request)?.text).toBe('The actual current answer');
    console.info('AG history bounded read: 18,000 historical 12-KiB tool payloads, ms=',performance.now()-started);
  });

});
