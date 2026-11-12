import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rename,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const streamGate=vi.hoisted(()=>({pauseNext:false,entered:false,release:undefined as undefined|(()=>void),reads:0}));
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>();
  return {...actual,createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{
    const stream=actual.createReadStream(...args);
    streamGate.reads++;
    if(!streamGate.pauseNext)return stream;
    streamGate.pauseNext=false;
    return(async function*(){
      streamGate.entered=true;
      await new Promise<void>(resolve=>{streamGate.release=resolve;});
      yield* stream;
    })();
  }};
});
import {AgyTranscriptBridge,agyTranscriptFile} from '../../src/agent/agy-transcript-bridge.js';
const roots:string[]=[],bridges:AgyTranscriptBridge[]=[];
afterEach(async()=>{streamGate.pauseNext=false;streamGate.entered=false;streamGate.release?.();streamGate.release=undefined;for(const b of bridges.splice(0))b.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
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

});
