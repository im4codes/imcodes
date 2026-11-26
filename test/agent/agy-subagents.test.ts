import { describe, expect, it } from 'vitest';
import { AgySubagentTracker, isAgySubagentTool } from '../../src/agent/agy-subagents.js';
import { SDK_SUBAGENT_DETAIL_KIND, SDK_SUBAGENT_STATUS as S } from '../../shared/sdk-subagent-status.js';
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
  it('parses real AG prose-wrapped multi-child list snapshots and preserves every child',()=>{
    const t=new AgySubagentTracker('parent');
    const events=t.tool({id:'list',name:'Run manage_subagents',status:'complete',input:{Action:'list'},output:'Created At: native\nYou have 2 active subagent(s):\n'+JSON.stringify([{conversationId:'one',state:'idle',role:'One'},{conversationId:'two',state:'running',role:'Two'}])});
    expect(events).toHaveLength(2);expect(events.map(t=>t.detail?.meta?.normalizedStatus)).toEqual([S.COMPLETE,S.RUNNING]);
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
  it.each(['batch','split','reverse roles'])('keeps multi-member launch slots unique through %s results and independent terminals', mode=>{
    const t=new AgySubagentTracker('parent');
    const launch={id:'multi',name:'invoke_subagent',status:'running' as const,input:{Subagents:[{Role:'One',Prompt:'task-one'},{Role:'Two',Prompt:'task-two'},{Role:'Three',Prompt:'task-three'}]}};
    const started=t.tool(launch);const keys=started.map(e=>e.id);expect(new Set(keys).size).toBe(3);
    expect(t.tool(launch).map(e=>e.id)).toEqual(keys);
    const rows=[{conversationId:'one',role:'One',status:'running'},{conversationId:'two',role:'Two',status:'running'},{conversationId:'three',role:'Three',status:'running'}];
    if(mode==='batch') expect(t.tool({...launch,status:'complete',output:JSON.stringify({subagents:rows})}).map(e=>e.id)).toEqual(keys);
    else for(const row of mode==='reverse roles'?[...rows].reverse():rows) {
      const index=rows.indexOf(row);expect(t.tool({...launch,status:'complete',output:JSON.stringify(row)})[0].id).toBe(keys[index]);
    }
    expect(t.tool(launch).map(e=>e.id)).toEqual(keys);
    expect(t.snapshot({conversationId:'one',status:'completed'})[0].id).toBe(keys[0]);
    expect(t.snapshot({conversationId:'two',status:'error'})[0]).toMatchObject({id:keys[1],status:'error'});
    expect(t.interrupt().map(e=>e.id)).toEqual([keys[2]]);
    expect(t.snapshot({conversationId:'three',status:'running'})).toEqual([]);
  });
  it('binds split anonymous native results in unbound slot order without overwriting members',()=>{
    const t=new AgySubagentTracker('parent');const input={Subagents:[{Role:'One'},{Role:'Two'}]};
    const start=t.tool({id:'m',name:'invoke_subagent',status:'running',input});
    for(const [i,id] of ['native-one','native-two'].entries()) expect(t.tool({id:'m',name:'invoke_subagent',status:'complete',input,output:JSON.stringify({conversationId:id,status:'running'})})[0].id).toBe(start[i].id);
    expect(t.interrupt().map(e=>e.id)).toEqual(start.map(e=>e.id));
  });

  it.each(['Run invoke_subagent', 'Run invoke_subagent {"Model":"inherit","Prompt":"task"}', ' invoke_subagent '])('normalizes first and terminal-only packets for %s', name => {
    const tracker = new AgySubagentTracker('parent');
    const start = tracker.tool({id:'inline', name, status:'running'})[0];
    expect(start?.detail?.kind).toBe(SDK_SUBAGENT_DETAIL_KIND);
    const terminal = tracker.tool({id:'inline', name, status:'complete', output:JSON.stringify({conversationId:'child-inline'})})[0];
    expect(terminal?.id).toBe(start.id);
    expect(terminal?.detail?.meta).toMatchObject({agentPath:'child-inline', active:true});
    const only = new AgySubagentTracker('parent');
    const result = only.tool({id:'terminal-only', name, status:'complete', output:JSON.stringify({conversationId:'child-inline'})})[0];
    expect(result?.detail?.kind).toBe(SDK_SUBAGENT_DETAIL_KIND);
    expect(only.tool({id:'terminal-only', name, status:'running'})[0]?.id).toBe(result.id);
  });
  it.each([
    'Created subagent: 12345678-1234-1234-1234-123456789abc',
    'Conversation ID: 12345678-1234-1234-1234-123456789abc',
    '12345678-1234-1234-1234-123456789abc',
  ])('binds native launch identity from text: %s', output => {
    const tracker = new AgySubagentTracker('parent');
    const start = tracker.tool({id:'text-result', name:'Run invoke_subagent', status:'running', input:{Prompt:'work'}})[0];
    const bound = tracker.tool({id:'text-result', name:'Run invoke_subagent', status:'complete', output})[0];
    expect(bound.id).toBe(start.id);
    expect(bound.detail?.meta?.agentPath).toBe('12345678-1234-1234-1234-123456789abc');
  });
  it('does not treat unrelated UUID text or input-only peer ids as a native launch result', () => {
    const tracker = new AgySubagentTracker('parent');
    const event = tracker.tool({id:'negative', name:'invoke_subagent', status:'complete', output:'Request correlation ID: 12345678-1234-1234-1234-123456789abc'})[0];
    expect(event.detail?.meta?.agentPath).toBe('negative');
  });
  it('does not revive a terminal child when its launch running packet is duplicated', () => {
    const tracker = new AgySubagentTracker('parent');
    const launch = {id:'late', name:'invoke_subagent', status:'running' as const};
    tracker.tool(launch);
    tracker.tool({...launch, status:'complete', output:JSON.stringify({conversationId:'finished'})});
    tracker.snapshot({conversationId:'finished',status:'completed'});
    expect(tracker.tool(launch)[0]?.detail?.meta?.normalizedStatus).toBe(S.COMPLETE);
    expect(tracker.tool({id:'new-send',name:'send_message',status:'running',input:{Recipient:'finished'}})[0].detail?.meta?.active).toBe(true);
  });

  it('ignores send_message and non-launch kill calls for unknown or IM.codes deck_sub_* targets', () => {
    const tracker = new AgySubagentTracker('parent');
    expect(tracker.tool({
      id: 'send-deck-1',
      name: 'send_message',
      status: 'running',
      input: { Recipient: 'deck_sub_602p4q1r', Message: 'hello sibling' },
    })).toEqual([]);
    expect(tracker.tool({
      id: 'send-deck-1',
      name: 'send_message',
      status: 'error',
      input: { Recipient: 'deck_sub_602p4q1r', Message: 'hello sibling' },
      output: 'Created At: 2026-11-13T20:18:29+08:00\nsend_list_targets',
    })).toEqual([]);
    expect(tracker.tool({
      id: 'send-deck-2',
      name: 'send_message',
      status: 'complete',
      input: { Recipient: 'deck_sub_pair_auto_e4ba27483bf435b4', Message: 'audit' },
      output: JSON.stringify({ id: 'msg_99', status: 'queued' }),
    })).toEqual([]);
    expect(tracker.tool({
      id: 'kill-unknown',
      name: 'manage_subagents',
      status: 'complete',
      input: { action: 'kill', conversationId: 'deck_sub_602p4q1r' },
    })).toEqual([]);
    expect(tracker.isNativeChild('deck_sub_602p4q1r')).toBe(false);

    // Known children launched via invoke_subagent still track send_message normally.
    tracker.tool({
      id: 'launch-known',
      name: 'invoke_subagent',
      status: 'complete',
      output: JSON.stringify({ conversationId: 'real-child', status: 'running' }),
    });
    const sendKnown = tracker.tool({
      id: 'send-known',
      name: 'send_message',
      status: 'running',
      input: { Recipient: 'real-child', Message: 'continue' },
    });
    expect(sendKnown).toHaveLength(1);
    expect(sendKnown[0].detail?.meta).toMatchObject({ agentPath: 'real-child', active: true });
  });

  it('tracks activeCount including waiting/waiting_for_dependents, reconciles missing nativeChildren on manage_subagents(list), and never completes on errors', () => {
    const tracker = new AgySubagentTracker('parent');
    expect(tracker.activeCount()).toBe(0);

    // Waiting/waiting_for_dependents map to RUNNING and contribute to activeCount().
    tracker.snapshot({
      subagents: [
        { conversationId: 'child-wait', status: 'waiting_for_dependents', role: 'Waiter' },
        { conversationId: 'child-wait2', status: 'waiting', role: 'Waiter2' },
        { conversationId: 'child-done', status: 'completed', role: 'Done' },
      ],
    });
    expect(tracker.activeCount()).toBe(2);

    // Unbound placeholder launch must NOT be prematurely completed by manage_subagents(list).
    tracker.tool({ id: 'unbound-launch', name: 'invoke_subagent', status: 'running', input: { Role: 'Unbound' } });
    expect(tracker.activeCount()).toBe(3);

    // Authoritative error / unparseable non-list output must never complete running subagents.
    expect(tracker.tool({
      id: 'list-err',
      name: 'manage_subagents',
      status: 'error',
      input: { Action: 'list' },
      output: '[]',
    })).toEqual([]);
    expect(tracker.tool({
      id: 'list-prose-err',
      name: 'manage_subagents',
      status: 'complete',
      input: { Action: 'list' },
      output: 'Error: control plane unavailable',
    })).toEqual([]);
    expect(tracker.activeCount()).toBe(3);

    // Prose-wrapped single-element array keeps child-wait running and reconciles absent native child-wait2 to COMPLETE.
    const partialList = tracker.tool({
      id: 'list-partial',
      name: 'manage_subagents',
      status: 'complete',
      input: { Action: 'list' },
      output: 'Created At: native\nYou have 1 active subagent(s):\n' + JSON.stringify([{ conversationId: 'child-wait', status: 'running' }]),
    });
    expect(partialList.find((e) => e.detail?.meta?.agentPath === 'child-wait2')?.detail?.meta).toMatchObject({
      active: false,
      terminal: true,
      normalizedStatus: S.COMPLETE,
    });
    expect(partialList.find((e) => e.detail?.meta?.agentPath === 'child-wait')?.detail?.meta?.active).toBe(true);
    expect(tracker.activeCount()).toBe(2); // child-wait + unbound-launch

    // Empty explicit list reconciles remaining native child-wait to COMPLETE while leaving unbound-launch intact.
    const emptyList = tracker.tool({
      id: 'list-empty',
      name: 'manage_subagents',
      status: 'complete',
      input: { Action: 'list' },
      output: JSON.stringify({ subagents: [] }),
    });
    expect(emptyList).toHaveLength(1);
    expect(emptyList[0].detail?.meta).toMatchObject({
      agentPath: 'child-wait',
      active: false,
      terminal: true,
      normalizedStatus: S.COMPLETE,
    });
    expect(tracker.activeCount()).toBe(1);
  });

  it('resolves AG sub-agent model aliases, inherits parent active model without overwriting existing runs, and refines from child updates', () => {
    let parentModel: string | undefined;
    const tracker = new AgySubagentTracker('parent', () => parentModel);

    // 1. inherit with unknown parent model keeps meta.model undefined (never renders "inherit").
    const unknownParent = tracker.tool({
      id: 'launch-unknown-parent',
      name: 'invoke_subagent',
      status: 'running',
      input: { Role: 'Researcher', Model: 'inherit', Prompt: 'inspect' },
    })[0];
    expect(unknownParent.detail?.meta?.model).toBeUndefined();

    // 2. Parent model becomes known -> newly launched omitted/default child resolves to parentModel.
    parentModel = 'gemini-4-pro-high';
    const inheritedChild = tracker.tool({
      id: 'launch-inherited',
      name: 'invoke_subagent',
      status: 'running',
      input: { Role: 'Explorer', Model: 'default', Prompt: 'explore' },
    })[0];
    expect(inheritedChild.detail?.meta?.model).toBe('gemini-4-pro-high');

    const boundInherited = tracker.tool({
      id: 'launch-inherited',
      name: 'invoke_subagent',
      status: 'complete',
      output: JSON.stringify({ conversationId: 'conv-inherited', status: 'running' }),
    })[0];
    expect(boundInherited.detail?.meta?.model).toBe('gemini-4-pro-high');

    // 3. Explicit alias field overrides parentModel.
    const aliasedChild = tracker.tool({
      id: 'launch-aliased',
      name: 'invoke_subagent',
      status: 'running',
      input: { Role: 'Fast', modelId: 'gemini-4-flash', Prompt: 'quick' },
    })[0];
    expect(aliasedChild.detail?.meta?.model).toBe('gemini-4-flash');

    // 4. Switching parent model mid-session does NOT overwrite already-started child's captured launch model.
    parentModel = 'gemini-4-argon-high';
    const progressInherited = tracker.snapshot({ conversationId: 'conv-inherited', status: 'running' })[0];
    expect(progressInherited.detail?.meta?.model).toBe('gemini-4-pro-high');

    // 5. Explicit model reported in later child snapshot (e.g., transcript PLANNER_RESPONSE.model) refines it.
    const refined = tracker.snapshot({ conversationId: 'conv-inherited', status: 'completed', model: 'gemini-4-hydrogen-high' })[0];
    expect(refined.detail?.meta?.model).toBe('gemini-4-hydrogen-high');

    // 6. Newly started child after parent switch picks up new parentModel.
    const newerChild = tracker.tool({
      id: 'launch-newer',
      name: 'invoke_subagent',
      status: 'running',
      input: { Role: 'Reviewer', Prompt: 'review' },
    })[0];
    expect(newerChild.detail?.meta?.model).toBe('gemini-4-argon-high');
  });

});
