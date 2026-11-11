import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { TransportQueueStore } from '../../src/daemon/transport-queue-store.js';
const live=vi.hoisted(()=>vi.fn());
vi.mock('../../src/store/session-store.js',()=>({getSession:live}));
const require=createRequire(import.meta.url);const {DatabaseSync}=require('node:sqlite') as typeof import('node:sqlite');
const roots:string[]=[];const stores:TransportQueueStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});live.mockReset();});
const open=(dbPath:string)=>{const s=new TransportQueueStore({dbPath});stores.push(s);return s;};
const file=()=>{const root=mkdtempSync(join(tmpdir(),'imcodes-test-system-contracts-'));roots.push(root);return join(root,'queue.sqlite');};
describe('private logical system-contract source',()=>{
 it('reopens original bodies, isolates logical owner/scope, replaces and withdraws without resurrection',()=>{
  const path=file();let s=open(path);live.mockReturnValue({sessionInstanceId:'instance',runtimeEpoch:'first'});
  s.writeSessionSystemContracts('same-name','instance','scope-a','first',[{contractId:'one',body:'FULL ORIGINAL 😀'},{contractId:'two',body:'SECOND'}]);
  s.close();s=open(path);live.mockReturnValue({sessionInstanceId:'instance',runtimeEpoch:'new-runtime'});
  expect([...s.readSessionSystemContracts('same-name','instance','scope-a')]).toEqual([['one','FULL ORIGINAL 😀'],['two','SECOND']]);
  expect(s.readSessionSystemContracts('same-name','instance','scope-b').size).toBe(0);
  expect(s.readSessionSystemContracts('same-name','other-instance','scope-a').size).toBe(0);
  expect(()=>s.writeSessionSystemContracts('same-name','instance','scope-a','first',[{contractId:'one',body:'STALE'}])).toThrow('replaced');
  s.writeSessionSystemContracts('same-name','instance','scope-a','new-runtime',[{contractId:'one',body:'NEW ORIGINAL'},{contractId:'two',body:''}]);
  s.close();s=open(path);expect([...s.readSessionSystemContracts('same-name','instance','scope-a')]).toEqual([['one','NEW ORIGINAL']]);
  // A queue epoch reset is not a logical owner deletion or contract revoke.
  s.discardSessionQueueState('same-name');expect(s.readSessionSystemContracts('same-name','instance','scope-a').get('one')).toBe('NEW ORIGINAL');
  expect(JSON.stringify(s.readSnapshot('same-name'))).not.toContain('NEW ORIGINAL');
 });
 it('keeps separate writers and existing queue rows, retries idempotently after partial DDL, and atomically rolls back a failed registration batch',()=>{
  const path=file();const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE session_system_contracts (session_name TEXT NOT NULL,session_instance_id TEXT NOT NULL,owner_key TEXT NOT NULL,contract_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session_name,session_instance_id,owner_key,contract_id));`);
  db.close();const a=open(path);live.mockReturnValue(undefined);a.enqueue({sessionName:'s',text:'existing queue row',clientMessageId:'queued-before'});const b=open(path);
  expect(b.readSnapshot('s').pendingMessageEntries[0].text).toBe('existing queue row');
  a.writeSessionSystemContracts('s','i','owner',undefined,[{contractId:'a',body:'A'}]);
  b.writeSessionSystemContracts('s','i','owner',undefined,[{contractId:'b',body:'B'}]);
  a.writeSessionSystemContracts('s','i','owner',undefined,[{contractId:'a',body:'A'}]);
  expect([...b.readSessionSystemContracts('s','i','owner')]).toEqual([['a','A'],['b','B']]);
  const trigger=new DatabaseSync(path);trigger.exec(`CREATE TRIGGER fail_bad BEFORE INSERT ON session_system_contracts WHEN NEW.contract_id='bad' BEGIN SELECT RAISE(ABORT,'injected'); END;`);trigger.close();
  expect(()=>a.writeSessionSystemContracts('s','i','owner',undefined,[{contractId:'first',body:'MUST ROLLBACK'},{contractId:'bad',body:'FAIL'}])).toThrow('injected');
  expect(b.readSessionSystemContracts('s','i','owner').has('first')).toBe(false);
  live.mockReturnValue({sessionInstanceId:'new-i',runtimeEpoch:'new'});
  expect(()=>a.writeSessionSystemContracts('s','i','owner',undefined,[{contractId:'a',body:'OLD OWNER'}])).toThrow('replaced');
  expect(a.readSessionSystemContracts('s','i','owner').size).toBe(0);
 });
});
