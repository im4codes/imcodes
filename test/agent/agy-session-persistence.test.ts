import { AGY_ACP_AGENT_NAME } from '../../shared/agy-agent.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGY_NATIVE_SESSION_STATE as AG } from '../../shared/agy-agent.js';
import { PROVIDER_ERROR_CODES } from '../../shared/provider-error-codes.js';
import { AgyAcpProvider } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider } from '../../src/agent/providers/agy-sdk.js';
import { persistAgyNativeSessionStart } from '../../src/agent/agy-session-persistence.js';
import * as store from '../../src/store/session-store.js';
import { setSessionDbFailAfterRowWritesForTests } from '../../src/store/session-store-db.js';
import { currentDaemonProcessIdentity } from '../../src/daemon/instance-lock.js';
import { writeAgyNativeChildFixture } from '../helpers/agy-native-child.js';
import { persistedSessions } from '../helpers/session-store-db.js';

// Persistence fixtures are not live sessions: use production-shaped records
// ONLY in this isolated SQLite HOME (like session-store-sqlite.test.ts).
let home: string;
let bin: string;
let provider: AgySdkProvider;
const main = 'deck_realproj_ag_brain';
function record(name = main, extra: Partial<store.SessionRecord> = {}): store.SessionRecord {
  return { name, projectName: 'realproj', role: 'brain', agentType: 'agy-sdk', providerId: 'agy-sdk',
    providerSessionId: 'route-'+name, projectDir: '/work/realproj', state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
    agyNativeSessionState: AG.UNSTARTED, ...extra };
}
async function waitFor(predicate: () => boolean) {
  for (let i=0;i<200;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('fixture event timeout');
}
function start(name=main, isCurrent=()=>true) {
  const expected={...store.getSession(name)!};
  return persistAgyNativeSessionStart(name,expected,isCurrent);
}
beforeEach(async () => {
  home=mkdtempSync(path.join(tmpdir(),'imcodes-ag-persistence-'));
  mkdirSync(path.join(home,'.imcodes'));
  vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); vi.stubEnv('IMCODES_HOME',path.join(home,'.imcodes'));
  store.resetSessionStoreAuthorityForTests();
  await store.loadStore({probe:false});
  bin=writeAgyNativeChildFixture(home);
  provider=new AgySdkProvider();await provider.connect({binaryPath:bin});
});
afterEach(async () => {
  setSessionDbFailAfterRowWritesForTests(null);vi.restoreAllMocks();
  await provider.disconnect();await store.flushStore().catch(()=>{});
  await store.waitForSessionStoreSnapshotForTests();store.resetSessionStoreAuthorityForTests();
  vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});
});

describe('AG native start durable evidence (real SQLite and SDK child fixture)',()=>{
  it.each(['brain', 'w1'])('ACP commits before session/new and disk roundtrips the exact native handle for %s', async role => {
    // Production-shaped records ONLY in isolated SQLite; never live user sessions.
    store.upsertSession(record(main, { role, ...(role === 'w1' ? { parentSession: 'deck_realproj_brain' } : {}) }));
    await store.flushStore();
    const executable = path.join(home, 'agy-acp');
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
    const acp = new AgyAcpProvider();
    let completed = 0;
    try {
      await acp.connect({ binaryPath: executable, env: { HOME: home, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME } });
      acp.onSessionInfo((_sid, info) => { if (info.resumeId) store.upsertSession({ ...store.getSession(main)!, providerResumeId: info.resumeId }); });
      acp.onComplete(() => { completed++; });
      const sid = await acp.createSession({ sessionKey: 'route-' + main, cwd: home, beforeNativeSessionStart: async () => {
        await start(); expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.STARTED);
      } });
      await acp.send(sid, 'A'); await waitFor(() => completed === 1); await store.flushStore();
      const native = persistedSessions(home)[main].providerResumeId as string;
      expect(native).toBeTruthy();
      await acp.disconnect(); store.resetSessionStoreAuthorityForTests(); await store.loadStore({ probe: false });
      expect(store.getSession(main)?.providerResumeId).toBe(native);
      await acp.connect({ binaryPath: executable, env: { HOME: home, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME } });
      const resumed = await acp.createSession({ sessionKey: 'restored-route', cwd: home, resumeId: native });
      await acp.send(resumed, 'after-restart'); await waitFor(() => completed === 2);
      expect(store.getSession(main)?.providerResumeId).toBe(native);
    } finally { await acp.disconnect(); }
  });

  it.each(['brain','w1'])('commits before spawn and reloads the exact learned native handle for %s',async role=>{
    store.upsertSession(record(main,{role,...(role==='w1'?{parentSession:'deck_realproj_brain'}:{})}));
    await store.flushStore();
    expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.UNSTARTED);
    let native='';let completed=0;
    provider.onSessionInfo((_sid,info)=>{
      if(info.resumeId){native=info.resumeId;store.upsertSession({...store.getSession(main)!,providerResumeId:info.resumeId});}
    });
    provider.onComplete(()=>{completed++;});
    const sid=await provider.createSession({sessionKey:'route-'+main,cwd:home,
      beforeNativeSessionStart:async()=>{
        await start();
        expect(readFileSync(path.join(home,'launches'),'utf8')).toBe('');
        expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.STARTED);
      }});
    await provider.send(sid,'first');await waitFor(()=>completed===1);await store.flushStore();
    expect(native).toMatch(/^[a-f\d-]{36}$/);
    expect(persistedSessions(home)[main].providerResumeId).toBe(native);
    await provider.disconnect();
    store.resetSessionStoreAuthorityForTests();await store.loadStore({probe:false});
    expect(store.getSession(main)?.providerResumeId).toBe(native);
    expect(store.getSession(main)?.parentSession).toBe(role==='w1'?'deck_realproj_brain':undefined);
    await provider.connect({binaryPath:bin});
    const resumed=await provider.createSession({sessionKey:'new-route',cwd:home,resumeId:store.getSession(main)!.providerResumeId});
    await provider.send(resumed,'second');await waitFor(()=>completed===2);
    const launches=readFileSync(path.join(home,'launches'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
    expect(launches).toEqual([{id:native,resumed:false},{id:native,resumed:true}]);
    expect(readFileSync(path.join(home,'inputs'),'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('a failed commit never spawns; disk keeps its previous safe state',async()=>{
    store.upsertSession(record());await store.flushStore();
    setSessionDbFailAfterRowWritesForTests(0);
    const sid=await provider.createSession({sessionKey:'failure',cwd:home,beforeNativeSessionStart:()=>start()});
    await expect(provider.send(sid,'never sent')).rejects.toMatchObject({recoverable:false});
    expect(readFileSync(path.join(home,'launches'),'utf8')).toBe('');
    expect(readFileSync(path.join(home,'inputs'),'utf8')).toBe('');
    expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.UNSTARTED);
  });

  it.each(['before','queued','sweep'])('never spawns when write authority is lost %s the strict commit',async stage=>{
    store.upsertSession(record());await store.flushStore();
    vi.stubEnv('VITEST','');vi.stubEnv('NODE_ENV','production');
    const identity=currentDaemonProcessIdentity();
    const metadataPath=path.join(home,'.imcodes','daemon.lock.json');
    const metadata={version:1,...identity,acquiredAt:Date.now(),socketPath:path.join(home,'.imcodes','daemon.sock'),sessionIds:[],residualResources:[]};
    writeFileSync(metadataPath,JSON.stringify(metadata));
    store.configureSessionStoreWriteAuthority(identity,metadataPath);
    const revoke=()=>writeFileSync(metadataPath,JSON.stringify({...metadata,pid:identity.pid+1,startToken:'foreign'}));
    if(stage==='before')revoke();
    if(stage==='sweep'){store.setSessionStoreSweepSliceMsForTests(0);setImmediate(revoke);}
    const sid=await provider.createSession({sessionKey:'authority-failure',cwd:home,beforeNativeSessionStart:()=>start()});
    const pending=provider.send(sid,'must stay unaccepted');
    if(stage==='queued')revoke();
    await expect(pending).rejects.toMatchObject({recoverable:false});
    expect(readFileSync(path.join(home,'launches'),'utf8')).toBe('');
    expect(readFileSync(path.join(home,'inputs'),'utf8')).toBe('');
    expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.UNSTARTED);
  });

  it('strict flush rejects an unloaded store instead of treating a skipped write as committed',async()=>{
    vi.stubEnv('VITEST','');vi.stubEnv('NODE_ENV','production');store.resetSessionStoreAuthorityForTests();
    await expect(store.flushStore({requireWrite:true})).rejects.toThrow('not loaded');
    await expect(store.flushStore()).resolves.toBeUndefined();
  });

  it('strict flush rejects empty-store refusal without changing the old default behavior',async()=>{
    store.upsertSession(record());await store.flushStore();store.removeSession(main);
    await expect(store.flushStore({requireWrite:true})).rejects.toThrow();
    expect(persistedSessions(home)[main]).toBeDefined();
    await expect(store.flushStore()).resolves.toBeUndefined();
    expect(persistedSessions(home)[main]).toBeDefined();
  });

  it('a committed start without an init cannot turn back into an unused record across reload',async()=>{
    store.upsertSession(record());await store.flushStore();
    const stale={...store.getSession(main)!};
    await start(); // crash window: commit finished, no child/init yet.
    store.upsertSession(stale);await store.flushStore();
    store.resetSessionStoreAuthorityForTests();await store.loadStore({probe:false});
    expect(store.getSession(main)?.agyNativeSessionState).toBe(AG.STARTED);
    await expect(start()).rejects.toThrow('no trusted resume id or unused proof');
  });

  it('leaves a started proof on disk after a real process crash immediately following commit', async () => {
    const childHome=path.join(home,'crash-home');mkdirSync(childHome);
    const storeUrl=new URL('../../src/store/session-store.ts',import.meta.url).href;
    const barrierUrl=new URL('../../src/agent/agy-session-persistence.ts',import.meta.url).href;
    const code=`const s=await import(${JSON.stringify(storeUrl)});const {persistAgyNativeSessionStart}=await import(${JSON.stringify(barrierUrl)});
      await s.loadStore({probe:false});s.upsertSession(${JSON.stringify(record())});
      await persistAgyNativeSessionStart(${JSON.stringify(main)},s.getSession(${JSON.stringify(main)}),()=>true);
      process.kill(process.pid,'SIGKILL');`;
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{
      cwd:process.cwd(),env:{...process.env,HOME:childHome,USERPROFILE:childHome,IMCODES_HOME:path.join(childHome,'.imcodes')},timeout:15000});
    expect(result.signal,result.stderr?.toString()).toBe('SIGKILL');
    expect(persistedSessions(childHome)[main]).toMatchObject({agyNativeSessionState:AG.STARTED});
    expect(persistedSessions(childHome)[main].providerResumeId).toBeUndefined();
    expect(readFileSync(path.join(home,'launches'),'utf8')).toBe('');
  });

  it('preserves a learned id against stale same-route metadata, but not against an explicit new route',async()=>{
    store.upsertSession(record());await store.flushStore();const stale={...store.getSession(main)!};
    store.upsertSession({...stale,providerResumeId:'native-trusted'});
    store.upsertSession(stale);await store.flushStore();
    expect(persistedSessions(home)[main]).toMatchObject({providerResumeId:'native-trusted',agyNativeSessionState:AG.STARTED});
    store.upsertSession({...stale,providerSessionId:'fresh-route',providerResumeId:undefined,agyNativeSessionState:AG.UNSTARTED});
    await store.flushStore();expect(persistedSessions(home)[main].providerResumeId).toBeUndefined();
    expect(persistedSessions(home)[main].agyNativeSessionState).toBe(AG.UNSTARTED);
  });

  it.each([undefined,AG.STARTED])('does not upgrade %s unknown evidence to an unused proof',async state=>{
    store.upsertSession(record(main,{agyNativeSessionState:state}));await store.flushStore();
    await expect(start()).rejects.toMatchObject({recoverable:false});
    expect(persistedSessions(home)[main].agyNativeSessionState).toBe(state);
  });

  it.each(['stop','delete','recreate','rebind','resumeRebind'])('rejects %s while the commit is pending',async action=>{
    store.upsertSession(record());await store.flushStore();
    let done!:()=>void;let entered=false;let current=true;
    vi.spyOn(store,'flushStore').mockImplementationOnce(()=>new Promise<void>(r=>{entered=true;done=r;}));
    const pending=start(main,()=>current);const rejected=expect(pending).rejects.toMatchObject({code:PROVIDER_ERROR_CODES.CANCELLED});
    await waitFor(()=>entered);
    if(action==='stop')current=false;
    else if(action==='delete')store.removeSession(main);
    else if(action==='recreate'){store.removeSession(main);store.upsertSession(record());}
    else if(action==='resumeRebind')store.upsertSession({...store.getSession(main)!,providerResumeId:'new-native'});
    else store.upsertSession({...store.getSession(main)!,providerSessionId:'replacement'});
    done();await rejected;expect(readFileSync(path.join(home,'launches'),'utf8')).toBe('');
  });

  it('keeps multiple same-cwd owners isolated and refuses an already owned native id',async()=>{
    store.upsertSession(record());const other=main+'2';store.upsertSession(record(other));await store.flushStore();
    await start();expect(persistedSessions(home)[other].agyNativeSessionState).toBe(AG.UNSTARTED);
    const native='native-conflict';
    store.upsertSession({...store.getSession(main)!,providerResumeId:native});
    store.upsertSession({...store.getSession(other)!,providerResumeId:native});await store.flushStore();
    await expect(start()).rejects.toThrow('belongs to another');
  });

  it('skips native start persistence and disk writes for incognito sessions', async () => {
    store.upsertSession(record(main, { incognito: true }));
    await start(main);
    expect(persistedSessions(home)[main]).toBeUndefined();
    expect(store.getSession(main)?.agyNativeSessionState).toBe(AG.UNSTARTED);
  });
});
