import { describe, expect, it } from 'vitest';
import { AgySubagentTracker, isAgySubagentTool } from '../../src/agent/agy-subagents.js';
import { SDK_SUBAGENT_STATUS as S } from '../../shared/sdk-subagent-status.js';
describe('AG native child lifecycle adapter', () => {
  it('keeps canonical identity across launch, native id, snapshots, send, kill and late completion', () => {
    const t=new AgySubagentTracker('parent');
    const tool={id:'launch',name:'invoke_subagent',input:{Subagents:[{Role:'Researcher',Prompt:'full assignment',Model:'model-a'}]},status:'running' as const};
    const start=t.tool(tool)[0]; expect(start.name).toBe('Agent'); expect(start.detail?.meta).toMatchObject({active:true,normalizedStatus:S.RUNNING,agentName:'Researcher',model:'model-a'});
    const bound=t.tool({...tool,status:'complete',output:JSON.stringify({conversationId:'child',status:'running'})})[0];
    expect(bound.id).toBe(start.id); expect(bound.detail?.meta?.agentPath).toBe('child');
    const done=t.snapshot({data:{agents:[{conversationId:'child',status:'completed'}]}})[0];
    expect(done.id).toBe(start.id); expect(done.detail?.meta).toMatchObject({active:false,terminal:true,normalizedStatus:S.COMPLETE});
    expect(t.snapshot({id:'child',state:'running'})).toEqual([]);
    expect(t.tool({id:'send',name:'send_message',input:{conversationId:'child',prompt:'next'},status:'running'})[0].detail?.meta?.active).toBe(true);
    const killed=t.tool({id:'kill',name:'manage_subagents',input:{action:'kill',conversationId:'child'},status:'complete'})[0];
    expect(killed.detail?.meta?.normalizedStatus).toBe(S.INTERRUPTED);
    expect(t.interrupt()).toEqual([]);
  });
  it('handles native spelling, definitions/list without invented execution, swarm and explicit errors', () => {
    for(const name of ['invoke_subagent','InvokeSubagent','browser-subagent','manage_subagents','define_subagent','swarm','send_message']) expect(isAgySubagentTool(name)).toBe(true);
    const t=new AgySubagentTracker('parent');
    expect(t.tool({id:'list',name:'manage_subagents',input:{action:'list'},status:'complete'})).toEqual([]);
    expect(t.tool({id:'def',name:'define_subagent',input:{name:'research'},status:'running'})).toEqual([]);
    expect(t.tool({id:'def',name:'define_subagent',input:{name:'research'},status:'complete'})[0].detail?.meta?.active).toBe(false);
    const started=t.tool({id:'add',name:'swarm',input:{action:'add',conversationId:'worker'},status:'running'})[0];
    expect(t.snapshot({agents:[{conversationId:'worker',status:'failed'}]})[0].id).toBe(started.id);
    expect(t.snapshot({agents:[{conversationId:'worker',status:'failed'}]})[0].status).toBe('error');
    const another=new AgySubagentTracker('other-parent');
    expect(another.tool({id:'add',name:'swarm',input:{action:'add',conversationId:'worker'},status:'running'})[0].id).not.toBe(started.id);
  });
});
