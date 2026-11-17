import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rename,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const streamGate=vi.hoisted(()=>({pauseNext:false,entered:false,release:undefined as undefined|(()=>void),reads:0}));
const watchGate=vi.hoisted(()=>({
  dropDirectoryEvents:false,
  fileWatchCount:0,
  fileWatcherCloses:0,
  dirWatchCount:0,
  dirWatcherCloses:0,
  lastFileWatchOpts:undefined as unknown,
}));
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();
  return {
    ...actual,
    watch:((filename:Parameters<typeof actual.watch>[0],options?:any,listener?:any)=>{
      const cb=typeof options==='function'?options:listener;
      const opts=typeof options==='function'?undefined:options;
      const isTranscriptFile=String(filename).endsWith('transcript_full.jsonl');
      if(isTranscriptFile){
        watchGate.fileWatchCount++;
        watchGate.lastFileWatchOpts=opts;
      }else{
        watchGate.dirWatchCount++;
      }
      const wrapped=cb
        ?(eventType:'rename'|'change',changedFile:string|Buffer|null)=>{
            if(!isTranscriptFile&&watchGate.dropDirectoryEvents)return;
            (cb as any)(eventType,changedFile);
          }
        :undefined;
      const watcher=opts!==undefined
        ?actual.watch(filename,opts,wrapped as any)
        :actual.watch(filename,wrapped as any);
      const origClose=watcher.close.bind(watcher);
      let closed=false;
      watcher.close=()=>{
        if(!closed){
          closed=true;
          if(isTranscriptFile)watchGate.fileWatcherCloses++;
          else watchGate.dirWatcherCloses++;
        }
        return origClose();
      };
      return watcher;
    }) as typeof actual.watch,
    createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{
      const stream=actual.createReadStream(...args);
      streamGate.reads++;
      if(!streamGate.pauseNext)return stream;
      streamGate.pauseNext=false;
      return(async function*(){
        streamGate.entered=true;
        await new Promise<void>(resolve=>{streamGate.release=resolve;});
        yield* stream;
      })();
    },
  };
});
import {AgyTranscriptBridge,agyTranscriptFile} from '../../src/agent/agy-transcript-bridge.js';
const roots:string[]=[],bridges:AgyTranscriptBridge[]=[];
afterEach(async()=>{watchGate.dropDirectoryEvents=false;streamGate.pauseNext=false;streamGate.entered=false;streamGate.release?.();streamGate.release=undefined;for(const b of bridges.splice(0))b.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
const row=(step_index:number,content='reply',status='DONE')=>JSON.stringify({step_index,type:'PLANNER_RESPONSE',status,content})+'\n';
const waitOpts={timeout:5000,interval:50};
describe('AG native transcript event bridge',()=>{
 it('baselines restored history, reads only new complete steps and does not replay after rotation',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);const file=agyTranscriptFile(home,'known')!;await mkdir(path.dirname(file),{recursive:true});
   await writeFile(file,row(0));const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);await b.start();expect(cb).not.toHaveBeenCalled();
   await appendFile(file,row(1));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1),waitOpts);expect(cb.mock.calls[0][0].step_index).toBe(1);
   await rename(file,file+'.old');await writeFile(file,row(0)+row(1));await b.flush();expect(cb).toHaveBeenCalledTimes(1);
   const bytes=Buffer.from(row(2,'summary 😀'));const split=bytes.indexOf(Buffer.from('😀'))+2;await appendFile(file,bytes.subarray(0,split));await b.flush();expect(cb).toHaveBeenCalledTimes(1);
   await appendFile(file,bytes.subarray(split));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(2),waitOpts);expect(cb.mock.calls[1][0].content).toBe('summary 😀');
   b.close();await appendFile(file,row(3,'new assignment'));await b.resume();expect(cb).toHaveBeenCalledTimes(3);expect(cb.mock.calls[2][0].content).toBe('new assignment');
 });
 it('serializes slow baseline reads against automatic catch-up and delivers concurrent appends once after baseline',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);
   const file1=agyTranscriptFile(home,'slow-baseline-idle')!;await mkdir(path.dirname(file1),{recursive:true});
   await writeFile(file1,row(0,'restored private history'));
   streamGate.pauseNext=true;streamGate.entered=false;streamGate.release=undefined;streamGate.reads=0;
   const cb1=vi.fn(),b1=new AgyTranscriptBridge(file1,cb1);bridges.push(b1);
   const starting1=b1.start();
   await vi.waitFor(()=>expect(streamGate.entered).toBe(true),waitOpts);
   await new Promise(r=>setTimeout(r,160));
   expect(cb1).not.toHaveBeenCalled();expect(streamGate.reads).toBe(1);
   streamGate.release?.();await starting1;
   expect(cb1).not.toHaveBeenCalled();expect(streamGate.reads).toBe(1);

   const file2=agyTranscriptFile(home,'slow-baseline-append')!;await mkdir(path.dirname(file2),{recursive:true});
   await writeFile(file2,row(0,'restored baseline'));
   streamGate.pauseNext=true;streamGate.entered=false;streamGate.release=undefined;streamGate.reads=0;
   const cb2=vi.fn(),b2=new AgyTranscriptBridge(file2,cb2);bridges.push(b2);
   const starting2=b2.start();
   await vi.waitFor(()=>expect(streamGate.entered).toBe(true),waitOpts);
   await appendFile(file2,row(1,'live turn during slow baseline'));
   await new Promise(r=>setTimeout(r,160));
   expect(cb2).not.toHaveBeenCalled();
   streamGate.release?.();await starting2;
   await vi.waitFor(()=>expect(cb2).toHaveBeenCalledTimes(1),waitOpts);
   expect(cb2.mock.calls[0][0]).toMatchObject({step_index:1,content:'live turn during slow baseline'});
   await new Promise(r=>setTimeout(r,100));expect(cb2).toHaveBeenCalledTimes(1);
 });
 it('watches late directory creation without polling and closes all observers',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);const file=agyTranscriptFile(home,'new-owner')!;
   const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);await b.start();
   await mkdir(path.dirname(file),{recursive:true});await writeFile(file,row(0));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1),waitOpts);
   await appendFile(file,row(1));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(2),waitOpts);
   b.close();await appendFile(file,row(2));await new Promise(r=>setTimeout(r,100));expect(cb).toHaveBeenCalledTimes(2);
   expect(agyTranscriptFile(home,'../other')).toBeUndefined();expect(agyTranscriptFile('relative','id')).toBeUndefined();
 });
 it('reattaches after the watched logs directory is replaced, including later appends',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);
   const file=agyTranscriptFile(home,'rotated-directory')!;await mkdir(path.dirname(file),{recursive:true});
   await writeFile(file,row(0));const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);await b.start();
   await rename(path.dirname(file),path.dirname(file)+'.old');
   await mkdir(path.dirname(file));await writeFile(file,row(1));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1),waitOpts);
   await appendFile(file,row(2));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(2),waitOpts);
   expect(cb.mock.calls.map(([r])=>r.step_index)).toEqual([1,2]);
 });
 it('delivers consecutive appends, file rotation, close and resume via non-recursive file watcher when directory FSEvents are silent',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);
   const file=agyTranscriptFile(home,'fsevents-silent')!;
   const baseFileWatches=watchGate.fileWatchCount;
   const baseFileCloses=watchGate.fileWatcherCloses;
   const baseDirWatches=watchGate.dirWatchCount;
   const baseDirCloses=watchGate.dirWatcherCloses;

   const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);
   await b.start();

   // Create directory and initial file, then silence all directory watcher callbacks
   // to simulate overloaded macOS fseventsd dropping/delaying subsequent directory events.
   await mkdir(path.dirname(file),{recursive:true});
   await writeFile(file,row(0,'initial'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1),waitOpts);
   expect(watchGate.fileWatchCount-baseFileWatches).toBe(1);
   expect(watchGate.lastFileWatchOpts).toEqual({persistent:false});

   watchGate.dropDirectoryEvents=true;

   // Three consecutive rapid appends must still arrive via direct file vnode watcher.
   await appendFile(file,row(1,'append-1'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(2),waitOpts);
   await appendFile(file,row(2,'append-2'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(3),waitOpts);
   await appendFile(file,row(3,'append-3'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(4),waitOpts);
   expect(cb.mock.calls.map(([r])=>r.content)).toEqual(['initial','append-1','append-2','append-3']);

   // Rotate the file while directory events remain silent; old fileWatcher must close
   // and rebind to the new inode so subsequent appends also fire without directory events.
   await rename(file,file+'.rotated');
   await writeFile(file,row(0,'initial')+row(1,'append-1')+row(4,'after-rotation'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(5),waitOpts);
   expect(cb.mock.calls[4][0]).toMatchObject({step_index:4,content:'after-rotation'});
   expect(watchGate.fileWatcherCloses-baseFileCloses).toBeGreaterThanOrEqual(1);
   expect(watchGate.fileWatchCount-baseFileWatches).toBe(2);

   await appendFile(file,row(5,'post-rotation-append'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(6),waitOpts);
   expect(cb.mock.calls[5][0]).toMatchObject({step_index:5,content:'post-rotation-append'});

   // close() must release both directory and file watchers; resume() must re-arm fileWatcher.
   b.close();
   expect(watchGate.fileWatcherCloses-baseFileCloses).toBe(watchGate.fileWatchCount-baseFileWatches);
   expect(watchGate.dirWatcherCloses-baseDirCloses).toBe(watchGate.dirWatchCount-baseDirWatches);
   await appendFile(file,row(6,'while-closed'));
   await new Promise(r=>setTimeout(r,120));
   expect(cb).toHaveBeenCalledTimes(6);

   await b.resume();
   expect(cb).toHaveBeenCalledTimes(7);
   expect(cb.mock.calls[6][0]).toMatchObject({step_index:6,content:'while-closed'});

   await appendFile(file,row(7,'after-resume'));
   await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(8),waitOpts);
   expect(cb.mock.calls[7][0]).toMatchObject({step_index:7,content:'after-resume'});
 });

});
