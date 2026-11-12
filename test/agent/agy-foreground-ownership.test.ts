import { describe, expect, it } from 'vitest';
import { AgyForegroundOwnership } from '../../src/agent/agy-foreground-ownership.js';
import type { AgyTranscriptRow } from '../../src/agent/agy-transcript-bridge.js';
const row = (step: number, type: string, content: string, source = 'MODEL'): AgyTranscriptRow => ({step_index:step,type,content,source,status:'DONE'});
describe('AG captured native foreground ownership', () => {
  it('binds wrapped explicit inputs FIFO, not repeated output body or ACP arrival', async () => {
    const owner=new AgyForegroundOwnership();owner.register(1,'same user');owner.register(2,'same user');
    owner.observe(row(0,'USER_INPUT','wrapper same user tail','USER_EXPLICIT'));
    owner.observe(row(1,'PLANNER_RESPONSE','same answer'));
    owner.observe(row(2,'SYSTEM_MESSAGE','[Message] sender=child content=result'));
    owner.observe(row(3,'PLANNER_RESPONSE','same answer'));
    owner.observe(row(4,'USER_INPUT','wrapper same user tail','USER_EXPLICIT'));
    owner.observe(row(5,'PLANNER_RESPONSE','same answer'));
    expect((await owner.output(1))?.step_index).toBe(1);expect((await owner.output(2))?.step_index).toBe(5);
    expect(owner.latest?.generation).toBe(2);
  });
  it('does not bind summaries, foreign inputs, tools or reactive outputs to a foreground', async () => {
    const owner=new AgyForegroundOwnership(20);owner.register(1,'exact user payload');
    owner.observe(row(0,'USER_INPUT','exact user payload','SYSTEM'));
    owner.observe(row(1,'PLANNER_RESPONSE','unowned'));
    owner.observe(row(2,'USER_INPUT','foreign','USER_EXPLICIT'));
    owner.observe(row(3,'PLANNER_RESPONSE','foreign output'));
    expect(await owner.output(1)).toBeUndefined();
    owner.observe(row(4,'USER_INPUT','exact user payload','USER_EXPLICIT'));
    owner.observe({...row(5,'PLANNER_RESPONSE','tool'),tool_calls:[{name:'invoke_subagent'}]});
    owner.observe(row(6,'PLANNER_RESPONSE','owned'));expect((await owner.output(1))?.content).toBe('owned');
    owner.observe(row(7,'PLANNER_RESPONSE','unattributed duplicate'));expect((await owner.output(1))?.step_index).toBe(6);
  });
  it('waits for a native file event after the RPC boundary and releases on teardown',async()=>{
    const owner=new AgyForegroundOwnership(100);owner.register(1,'first');
    const pending=owner.output(1);owner.observe(row(0,'USER_INPUT','first','USER_EXPLICIT'));
    owner.observe(row(1,'PLANNER_RESPONSE','first result'));expect((await pending)?.content).toBe('first result');
    owner.register(2,'next');const cancelled=owner.output(2);owner.clear();expect(await cancelled).toBeUndefined();
    expect(owner.latest).toBeUndefined();owner.register(3,'next');owner.observe(row(2,'USER_INPUT','next','USER_EXPLICIT'));
    owner.observe(row(3,'PLANNER_RESPONSE','new owner'));expect((await owner.output(3))?.content).toBe('new owner');
  });
});
