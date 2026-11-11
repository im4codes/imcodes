import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rename,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {AgyTranscriptBridge,agyTranscriptFile} from '../../src/agent/agy-transcript-bridge.js';
const roots:string[]=[],bridges:AgyTranscriptBridge[]=[];
afterEach(async()=>{for(const b of bridges.splice(0))b.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
const row=(step_index:number,content='reply',status='DONE')=>JSON.stringify({step_index,type:'PLANNER_RESPONSE',status,content})+'\n';
describe('AG native transcript event bridge',()=>{
 it('baselines restored history, reads only new complete steps and does not replay after rotation',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);const file=agyTranscriptFile(home,'known')!;await mkdir(path.dirname(file),{recursive:true});
   await writeFile(file,row(0));const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);await b.start();expect(cb).not.toHaveBeenCalled();
   await appendFile(file,row(1));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1));expect(cb.mock.calls[0][0].step_index).toBe(1);
   await rename(file,file+'.old');await writeFile(file,row(0)+row(1));await b.flush();expect(cb).toHaveBeenCalledTimes(1);
   const bytes=Buffer.from(row(2,'summary 😀'));const split=bytes.indexOf(Buffer.from('😀'))+2;await appendFile(file,bytes.subarray(0,split));await b.flush();expect(cb).toHaveBeenCalledTimes(1);
   await appendFile(file,bytes.subarray(split));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(2));expect(cb.mock.calls[1][0].content).toBe('summary 😀');
   b.close();await appendFile(file,row(3,'new assignment'));await b.resume();expect(cb).toHaveBeenCalledTimes(3);expect(cb.mock.calls[2][0].content).toBe('new assignment');
 });
 it('watches late directory creation without polling and closes all observers',async()=>{
   const home=await mkdtemp(path.join(tmpdir(),'imcodes-ag-native-'));roots.push(home);const file=agyTranscriptFile(home,'new-owner')!;
   const cb=vi.fn(),b=new AgyTranscriptBridge(file,cb);bridges.push(b);await b.start();
   await mkdir(path.dirname(file),{recursive:true});await writeFile(file,row(0));await vi.waitFor(()=>expect(cb).toHaveBeenCalledTimes(1));
   b.close();await appendFile(file,row(1));await new Promise(r=>setTimeout(r,100));expect(cb).toHaveBeenCalledTimes(1);
   expect(agyTranscriptFile(home,'../other')).toBeUndefined();expect(agyTranscriptFile('relative','id')).toBeUndefined();
 });
});
