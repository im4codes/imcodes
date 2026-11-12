import { SDK_SUBAGENT_DETAIL_KIND } from '../../shared/sdk-subagent-status.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { readFileSync } from 'node:fs';
import { AGY_ACP_AGENT_NAME, AGY_CLI_PATH_ENV } from '../../shared/agy-agent.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyAcpProvider, createAgyProvider, supportsAgyAcp } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider, resolveAgyBinary } from '../../src/agent/providers/agy-sdk.js';
import { AGENT_DELEGATION_NOTIFICATION_RESULTS } from '../../shared/agent-delegation.js';
import { PROVIDER_ERROR_CODES, normalizeProviderPayload } from '../../src/agent/transport-provider.js';
import { AGY_NATIVE_START_NOT_ATTEMPTED } from '../../shared/agy-agent.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { onConfirmedProviderStop } from '../../src/agent/provider-stop-confirmation.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { SessionInfoUpdate, ToolCallEvent } from '../../src/agent/transport-provider.js';

const resources: Array<{ provider: AgyAcpProvider; root: string }> = [];
afterEach(async () => { for (const { provider, root } of resources.splice(0)) { await provider.disconnect(); await rm(root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
async function setup(scenario = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-acp-'));
  const binary = path.join(root, 'agy');
  const fixture = path.resolve('test/fixtures/agy-acp.mjs');
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  const provider = new AgyAcpProvider(); resources.push({ provider, root });
  const log = path.join(root, 'rpc.jsonl');
  await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_SCENARIO: scenario } });
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { provider, root, binary, requests };
}
const notification = (id: string, text = id) => ({ notificationId: id, text });
async function route(provider: AgyAcpProvider, name = 'deck_test_agy_acp', extra = {}) {
  await provider.createSession({ sessionKey: name, sessionName: name, cwd: process.cwd(), agentId: 'model-a', ...extra }); return name;
}
describe('AG native ACP', () => {
  it.each(['normal', 'reordered'])('keeps A/B/C in one active native run and emits one terminal (%s)', async scenario => {
    const { provider, requests } = await setup(scenario);
    const id = await route(provider); const complete = vi.fn(), errors = vi.fn();
    provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A');
    await Promise.all([provider.notifyActiveDelegation(id, notification('B')), provider.notifyActiveDelegation(id, notification('C'))]);
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1].content).toBe('A B C'); expect(errors).not.toHaveBeenCalled();
    const prompts = (await requests()).filter(x => x.method === 'session/prompt');
    expect(prompts.map(x => x.params.sessionId)).toEqual(['native-1', 'native-1', 'native-1']);
    expect((await requests()).some(x => x.method === 'session/cancel')).toBe(false);
    expect(complete.mock.calls[0]?.[1].metadata.usage).toMatchObject({ inputTokens: scenario === 'reordered' ? 30 : 10, outputTokens: scenario === 'reordered' ? 15 : 5 });
  });
  it('deduplicates durable ids, including retries after the superseded A response', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    await provider.send(id, 'A');
    await Promise.all([provider.notifyActiveDelegation(id, notification('B')), provider.notifyActiveDelegation(id, notification('B'))]);
    await provider.notifyActiveDelegation(id, notification('B'));
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2), { timeout: 5000 });
  });
  it('does not clear an active A/tool when only B RPC is rejected', async () => {
    const { provider } = await setup('reject-b'); const id = await route(provider), complete = vi.fn(), errors = vi.fn(); provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(complete).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1), { timeout: 5000 }); expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
  });
  it('Stop cancels the aggregate once without allowing delayed updates to revive it', async () => {
    const { provider } = await setup('reordered'); const id = await route(provider); const complete = vi.fn(), errors = vi.fn(); provider.onComplete(complete); provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B')); await provider.cancelAndWait(id);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1), { timeout: 5000 }); expect(complete).not.toHaveBeenCalled();
    expect(await provider.notifyActiveDelegation(id, notification('C'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
  });
  it('keeps one stable ACP prefix and normalizes native usage for relay', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    const complete = vi.fn(); provider.onComplete(complete);
    const text = 'UNCOMPRESSED Brain role; user/project/pair/session identity; MCP policy 完整 😀';
    for (const message of ['ordinary one', 'after silent compaction']) {
      const payload = normalizeProviderPayload(message);
      payload.sessionSystemText = text;
      await provider.send(id, payload);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(message === 'ordinary one' ? 1 : 2), { timeout: 5000 });
    }
    const prompts = (await requests()).filter(x => x.method === 'session/prompt');
    expect(prompts[0].params.prompt[0].text).toContain(text);
    expect(prompts[1].params.prompt[0].text).not.toContain(text);
    expect(complete.mock.calls[1][1].metadata.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
  it('reasserts byte-identical ACP contracts once after summary/model/compact/clear/initialize', async () => {
    const {provider,requests,root}=await setup('usage-missing'); let id=await route(provider);
    const done=vi.fn(); provider.onComplete(done); let count=0;
    const contract='UNCOMPRESSED Brain-only delegation; USER/PROJECT/PAIR/SESSION identity; MCP guidance 完整 😀';
    const send=async(label:string, injected:boolean) => {
      const payload=normalizeProviderPayload(label); payload.sessionSystemText=contract;
      await provider.send(id,payload); count++;
      await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(count), { timeout: 5000 });
      const prompt=(await requests()).filter(x=>x.method==='session/prompt').at(-1).params.prompt[0].text;
      expect(prompt.split(contract).length-1).toBe(injected?1:0);
      if(label!=='/compact') expect(Number(done.mock.calls.at(-1)![1].metadata.usage.input_tokens)).toBeGreaterThan(0);
      return prompt;
    };
    const first=await send('ordinary one',true);
    await send('ordinary two',false); await send('ordinary three',false); await send('ordinary four',false);
    const native=(await requests()).find(x=>x.method==='session/prompt').params.sessionId;
    const logs=path.join(root,'.gemini/antigravity-cli/brain',native,'.system_generated/logs'); await mkdir(logs,{recursive:true});
    await writeFile(path.join(logs,'transcript.jsonl'),JSON.stringify({step_index:10,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-11-12T00:00:00Z',content:'<CONTEXT_SUMMARY>summary</CONTEXT_SUMMARY>'})+'\n');
    const restored=await send('after summary',true);
    expect(restored.slice(0,restored.indexOf('after summary'))).toBe(first.slice(0,first.indexOf('ordinary one')));
    await send('post summary ordinary',false);
    provider.setSessionAgentId(id,'model-b'); await send('after set model',true); await send('post set ordinary',false);
    await provider.applySessionModel(id,'model-a'); await send('after apply model',true); await send('post apply ordinary',false);
    await send('/compact',false); await send('after compact',true); await send('post compact ordinary',false);
    provider.refreshSessionSystemText(id); await send('after clear',true); await send('post clear ordinary',false);
    id=await route(provider,id,{fresh:true}); await send('after initialize',true); await send('post initialize ordinary',false);
  });
  it('keeps registered originals through real runtime fresh initialization, injects once and withdraws without resurrection',async()=>{
    const {provider,requests,root}=await setup();const key='deck_test_agy_reset_contract';
    vi.stubEnv('IMCODES_TRANSPORT_QUEUE_DB_PATH',path.join(root,'contracts-queue.sqlite'));resetTransportQueueStoreForTests();
    let runtime=new TransportSessionRuntime(provider,key);const config={sessionKey:key,sessionInstanceId:'logical-owner',cwd:root,agentId:'model-a',systemPrompt:'Original system'};
    let n=0;
    const send=async(body?:string)=>{
      const before=(await requests()).filter(r=>r.method==='session/prompt').length;
      runtime.send('ordinary-'+(++n),'id-'+n,undefined,undefined,body===undefined?undefined:{registeredSystemContract:{contractId:'dynamic',signature:body,body}});
      await vi.waitFor(async()=>expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(before+1), { timeout: 5000 });
      await vi.waitFor(()=>expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });
      return (await requests()).filter(r=>r.method==='session/prompt').at(-1).params.prompt.map((b:any)=>b.text??'').join('');
    };
    try {
      await runtime.initialize(config);
      expect(await send('COMPLETE ORIGINAL REGISTERED BODY')).toContain('COMPLETE ORIGINAL REGISTERED BODY');
      expect(await send()).not.toContain('COMPLETE ORIGINAL REGISTERED BODY');
      for(const extra of [{fresh:true},{startupMemoryAlreadyInjected:true},{runtimeEpoch:'next-runtime'}]) {
        await runtime.initialize({...config,...extra});
        expect(await send()).toContain('COMPLETE ORIGINAL REGISTERED BODY');
        expect(await send()).not.toContain('COMPLETE ORIGINAL REGISTERED BODY');
      }
      // Real /clear creates a new Runtime object; closing/reopening the
      // private store also models daemon restore, not module-global retention.
      await runtime.kill();resetTransportQueueStoreForTests();runtime=new TransportSessionRuntime(provider,key);
      await runtime.initialize({...config,fresh:true,runtimeEpoch:'restored-epoch'});
      expect(await send()).toContain('COMPLETE ORIGINAL REGISTERED BODY');
      expect(await send()).not.toContain('COMPLETE ORIGINAL REGISTERED BODY');
      await send('');await runtime.kill();resetTransportQueueStoreForTests();runtime=new TransportSessionRuntime(provider,key);
      await runtime.initialize({...config,fresh:true,runtimeEpoch:'after-withdrawal'});
      expect(await send()).not.toContain('COMPLETE ORIGINAL REGISTERED BODY');
    } finally {await runtime.kill();resetTransportQueueStoreForTests();}
  });
  it.each(['usage-missing','usage-zero','usage-used'])('reports positive current ACP occupancy (%s)', async scenario => {
    const {provider}=await setup(scenario); const id=await route(provider); const done=vi.fn(),usage=vi.fn(); provider.onComplete(done);provider.onUsage(usage);
    const p=normalizeProviderPayload('hello');p.sessionSystemText='full system contract '.repeat(100);
    await provider.send(id,p); await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const value=done.mock.calls[0][1].metadata.usage;
    if(scenario==='usage-used') expect(value).toMatchObject({input_tokens:45000,model_context_window:1000000});
    else { expect(value.input_tokens).toBeGreaterThan(100);expect(value.context_usage_estimated).toBe(true); }
    expect(usage.mock.calls.some(([,u])=>u.usage.input_tokens>0)).toBe(true);
  });
  it('synchronizes real ACP tool calls and native snapshots into canonical Agent lifecycles', async () => {
    const {provider}=await setup('subagents');const id=await route(provider),done=vi.fn(),events:ToolCallEvent[]=[];
    provider.onComplete(done);provider.onToolCall((_,t)=>events.push(t));
    await provider.send(id,'children');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const child=events.filter(t=>t.name==='Agent');expect(child.length).toBeGreaterThan(8);
    for(const normalizedStatus of ['running','complete','error','interrupted']) expect(child.some(t=>t.detail?.meta?.normalizedStatus===normalizedStatus)).toBe(true);
    const a=child.filter(t=>t.detail?.meta?.agentPath==='child-a'); expect(new Set(a.map(t=>t.id)).size).toBe(1);
    expect(a.at(-1)?.detail?.meta?.terminal).toBe(true);
    expect(child.some(t=>t.detail?.input?.description==='find info')).toBe(true);
    const one=child.filter(t=>t.detail?.meta?.agentName==='MultiOne');
    const two=child.filter(t=>t.detail?.meta?.agentName==='MultiTwo');
    expect(one.length).toBeGreaterThan(2);expect(two.length).toBeGreaterThan(2);
    expect(new Set(one.map(t=>t.id)).size).toBe(1);expect(new Set(two.map(t=>t.id)).size).toBe(1);
    expect(one[0].id).not.toBe(two[0].id);
    expect(one.at(-1)?.detail?.meta?.normalizedStatus).toBe('complete');
    expect(two.at(-1)?.detail?.meta?.normalizedStatus).toBe('error');

  });
  it.each(['acp-child-json','acp-child-text','acp-child-inline','acp-child-update-only'])('tracks ACP-only launch results through real child and parent transcript callbacks (%s)',async scenario=>{
    const {provider,requests}=await setup(scenario),id=await route(provider),done=vi.fn(),events:ToolCallEvent[]=[];
    provider.onComplete(done);provider.onToolCall((_,tool)=>events.push(tool));
    await provider.send(id,'launch directly');
    const state=(provider as any).sessions.get(id),childId='12345678-1234-1234-1234-123456789abc';
    await vi.waitFor(()=>expect(state.agyBridges?.has(childId)).toBe(true),{timeout:3000});
    await vi.waitFor(()=>expect(events.some(e=>e.detail?.meta?.agentPath===childId && e.detail?.meta?.terminal===true)).toBe(true),{timeout:5000});
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2),{timeout:5000});
    expect(done.mock.calls.map(([,message])=>message.content)).toEqual(['PARENT-STARTED','PARENT-CONTINUED CHILD-RESULT']);
    expect(events.every(e=>e.detail?.kind===SDK_SUBAGENT_DETAIL_KIND)).toBe(true);
    expect(new Set(events.map(e=>e.id)).size).toBe(1);
    if(scenario==='acp-child-inline') expect(events[0].detail?.input?.description).toBe('return child result');
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
    await new Promise(r=>setTimeout(r,120));expect(done).toHaveBeenCalledTimes(2);
  });
  it.each(['stop','rebind'])('does not deliver ACP-only child or parent callback after %s',async action=>{
    const {provider,root,requests}=await setup('acp-child-json'),id=await route(provider),done=vi.fn(),events:ToolCallEvent[]=[];
    provider.onComplete(done);provider.onToolCall((_,tool)=>events.push(tool));
    await provider.send(id,'launch directly');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1),{timeout:5000});
    const old=(provider as any).sessions.get(id);
    if(action==='stop') await provider.cancel(id);else await route(provider,id,{fresh:true});
    const before=events.length;
    await new Promise(r=>setTimeout(r,450));
    expect(old.agyBridges.size).toBe(0);expect(done).toHaveBeenCalledTimes(1);expect(events).toHaveLength(before);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
    const file=path.join(root,'.gemini/antigravity-cli/brain/native-1/.system_generated/logs/transcript_full.jsonl');
    expect(await readFile(file,'utf8')).toContain('PARENT-CONTINUED CHILD-RESULT');
  });
  it('never observes an input-only peer or a request UUID in unrelated launch output',async()=>{
    const {provider,requests}=await setup('acp-child-json'),id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch directly');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2),{timeout:5000});
    const state=(provider as any).sessions.get(id);
    const update=(update:any)=>(provider as any).handleSessionUpdate({sessionId:state.acpSessionId,update});
    update({sessionUpdate:'tool_call',toolCallId:'peer',title:'Run send_message',status:'in_progress',rawInput:{Recipient:'unrelated-peer',Prompt:'note'}});
    update({sessionUpdate:'tool_call',toolCallId:'unresolved',title:'Run invoke_subagent',status:'in_progress',rawInput:{Prompt:'work'}});
    update({sessionUpdate:'tool_call_update',toolCallId:'unresolved',status:'completed',rawOutput:'Request ID: aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
    expect([...state.agyBridges.keys()].sort()).toEqual(['12345678-1234-1234-1234-123456789abc','native-1']);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
  });
  it.each(['native-child-log','native-child-both','native-child-rpc-late','native-child-late','native-child-late-chunks'])('bridges real-shaped native child results/reactive parent completion once without another RPC (%s)', async scenario => {
    const {provider,requests}=await setup(scenario);const id=await route(provider),done=vi.fn(),events:ToolCallEvent[]=[];
    provider.onComplete(done);provider.onToolCall((_,t)=>events.push(t));
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2),{timeout:6000});
    expect(done.mock.calls.map(([,m])=>m.content)).toEqual(['PARENT-STARTED','PARENT-WOKE CHILD-PONG']);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
    const children=events.filter(t=>t.name==='Agent');
    expect(children.some(t=>t.detail?.meta?.agentPath==='native-child-fixture')).toBe(true);
    await vi.waitFor(()=>expect(events.some(t=>t.detail?.meta?.normalizedStatus==='complete')).toBe(true), { timeout: 5000 });
    expect(new Set(children.filter(t=>t.detail?.meta?.agentPath==='native-child-fixture').map(t=>t.id)).size).toBe(1);
    await new Promise(r=>setTimeout(r,500));expect(done).toHaveBeenCalledTimes(2);
    const state=(provider as any).sessions.get(id);await provider.endSession(id);expect(state.agyBridges.size).toBe(0);
  });
  it('pairs native-first duplicate streams once per native step, not permanently by response text',async()=>{
    const {provider,requests}=await setup('native-child-same-twice');const id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(3),{timeout:5000});
    await new Promise(r=>setTimeout(r,500));
    expect(done.mock.calls.map(([,m])=>m.content)).toEqual(['PARENT-STARTED','PARENT-WOKE CHILD-PONG','PARENT-WOKE CHILD-PONG']);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
  });
  it('does not mistake a previous late ACP reply for a new foreground successor child wake',async()=>{
    const {provider,root,requests}=await setup('native-child-late');const id=await route(provider),messages:string[]=[],nativeSteps:number[]=[];
    provider.onComplete((_,m)=>{
      messages.push(m.content??'');
      if(m.content==='PARENT-WOKE CHILD-PONG') {
        const file=path.join(root,'.gemini/antigravity-cli/brain/native-1/.system_generated/logs/transcript_full.jsonl');
        nativeSteps.push(Math.max(...readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line).step_index)));
      }
    });
    await provider.send(id,'launch');await vi.waitFor(()=>expect(messages).toHaveLength(2), { timeout: 5000 });
    await provider.send(id,'immediate successor');await vi.waitFor(()=>expect(messages).toHaveLength(4), { timeout: 5000 });
    await new Promise(r=>setTimeout(r,500));
    expect(nativeSteps).toEqual([5,11]);
    expect(messages).toHaveLength(4);expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('uses independent native steps after async, ignoring unowned ACP even with repeated bodies',async()=>{
    const {provider,root}=await setup('native-child-log');const id=await route(provider),done=vi.fn(),deltas=vi.fn();provider.onComplete(done);provider.onDelta(deltas);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const state=(provider as any).sessions.get(id),native=state.acpSessionId;
    const update=(update:any)=>(provider as any).handleSessionUpdate({sessionId:native,update});
    const before=deltas.mock.calls.length;
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Different response'}});
    update({sessionUpdate:'turn_completed'});expect(done).toHaveBeenCalledTimes(2);expect(deltas).toHaveBeenCalledTimes(before);
    update({sessionUpdate:'tool_call_update',toolCallId:'launch-1',status:'completed'});
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    const file=path.join(root,'.gemini/antigravity-cli/brain',native,'.system_generated/logs/transcript_full.jsonl');
    for(const [i,body] of ['Different response','PARENT-WOKE CHILD-PONG'].entries()) {
      await appendFile(file,JSON.stringify({step_index:6+i*2,type:'SYSTEM_MESSAGE',status:'DONE',content:'[Message] sender=child content=result'})+'\n'+JSON.stringify({step_index:7+i*2,type:'PLANNER_RESPONSE',status:'DONE',content:body})+'\n');
      await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(3+i), { timeout: 5000 });
      expect(done.mock.calls.at(-1)![1].content).toBe(body);
    }
  });
  it.each(['native-child-slow-foreground','native-child-same-foreground','native-child-cross-chunks'])('keeps an actively running successor foreground isolated from late prior chunks, usage and terminals (%s)',async scenario=>{
    const {provider,requests}=await setup(scenario);const id=await route(provider),done=vi.fn(),deltas=vi.fn();provider.onComplete(done);provider.onDelta(deltas);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const start=deltas.mock.calls.length;
    await provider.send(id,'successor foreground');
    await new Promise(r=>setTimeout(r,600));expect(done).toHaveBeenCalledTimes(2);
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    expect(deltas.mock.calls.slice(start).filter(([,d])=>d.type==='text')).toHaveLength(0);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(4),{timeout:5000});
    expect(done.mock.calls.map(([,m])=>m.content)).toEqual(['PARENT-STARTED','PARENT-WOKE CHILD-PONG',scenario==='native-child-same-foreground'?'PARENT-WOKE CHILD-PONG':'PARENT-STARTED','PARENT-WOKE CHILD-PONG']);
    expect(done.mock.calls[2][1].metadata.usage).toMatchObject({input_tokens:700,output_tokens:71});
    expect(done.mock.calls[3][1].metadata.usage).toMatchObject({input_tokens:120,output_tokens:3});
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
    await new Promise(r=>setTimeout(r,300));expect(done).toHaveBeenCalledTimes(4);
  });
  it('keeps async active steering correlated to the latest explicit native input without waiting for superseded output',async()=>{
    const {provider,requests}=await setup('native-steering');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'A');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });expect(done.mock.calls[0][1].content).toBe('STEERED OWNED RESULT');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:400,output_tokens:5});expect(errors).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('waits on the native output event after prompt RPC settlement, not a dedup grace timer',async()=>{
    const {provider,requests}=await setup('native-child-output-after-ack');const id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls.map(([,m])=>m.content)).toEqual(['PARENT-STARTED','PARENT-WOKE CHILD-PONG']);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
  });
  it.each(['stop','rebind'])('releases an unresolved native foreground wait on %s',async action=>{
    const {provider,requests}=await setup('native-child-wait');const id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch');const old=(provider as any).sessions.get(id);
    await vi.waitFor(()=>expect(old.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    await (provider as any).promptTerminals.get(old); // Actual RPC has ended; native PLANNER has not.
    expect(done).not.toHaveBeenCalled();
    if(action==='stop') await provider.cancel(id);else await route(provider,id,{fresh:true});
    await vi.waitFor(()=>expect(old.agyBridges.size).toBe(0), { timeout: 5000 });
    await new Promise(r=>setTimeout(r,700));expect(done).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
  });
  it('fails boundedly without publishing unattributed async ACP text when the native output is absent',async()=>{
    const {provider}=await setup('native-child-no-owned-output');const id=await route(provider),done=vi.fn(),errors=vi.fn(),deltas=vi.fn();provider.onComplete(done);provider.onError(errors);provider.onDelta(deltas);
    // Shorten only the failure deadline on this captured owner, not file ordering/coalescing.
    const {AgyForegroundOwnership}=await import('../../src/agent/agy-foreground-ownership.js');
    (provider as any).sessions.get(id).agyForeground=new AgyForegroundOwnership(30);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(errors).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(errors.mock.calls[0][1].message).toContain('could not be attributed');expect(done).not.toHaveBeenCalled();
    expect(deltas.mock.calls.filter(([,d])=>d.type==='text')).toHaveLength(0);
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    expect((provider as any).sessions.get(id).agyBridges.size).toBe(0);
  });
  it('attributes foreground output once when a peer SYSTEM_MESSAGE arrives during active tool calls',async()=>{
    const {provider,root}=await setup('native-child-no-owned-output');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'launch');
    const state=(provider as any).sessions.get(id);
    await vi.waitFor(()=>expect(state.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    await (provider as any).promptTerminals.get(state);
    const native=state.acpSessionId;
    const file=path.join(root,'.gemini/antigravity-cli/brain',native,'.system_generated/logs/transcript_full.jsonl');
    await appendFile(file,
      JSON.stringify({step_index:3,type:'SYSTEM_MESSAGE',status:'DONE',content:'[Message] sender=peer content=mid-turn note'})+'\n'+
      JSON.stringify({step_index:4,type:'PLANNER_RESPONSE',status:'DONE',content:'',tool_calls:[{name:'read_file',args:{Path:'/tmp/x'}}]})+'\n'+
      JSON.stringify({step_index:5,type:'PLANNER_RESPONSE',status:'DONE',content:'FOREGROUND-AFTER-MID-TURN-MESSAGE'})+'\n');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('FOREGROUND-AFTER-MID-TURN-MESSAGE');
    expect(errors).not.toHaveBeenCalled();
    await new Promise(r=>setTimeout(r,200));
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('attributes foreground output when native turn ends with tool_calls (e.g. ask_question)',async()=>{
    const {provider,root}=await setup('native-child-no-owned-output');const id=await route(provider),done=vi.fn(),errors=vi.fn(),deltas=vi.fn();provider.onComplete(done);provider.onError(errors);provider.onDelta(deltas);
    await provider.send(id,'launch');
    const state=(provider as any).sessions.get(id);
    await vi.waitFor(()=>expect(state.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    await (provider as any).promptTerminals.get(state);
    const native=state.acpSessionId;
    const file=path.join(root,'.gemini/antigravity-cli/brain',native,'.system_generated/logs/transcript_full.jsonl');
    await appendFile(file,
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Please confirm before proceeding',
        tool_calls: [{ name: 'ask_question', args: { question: 'Confirm?' } }],
      }) + '\n');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('Please confirm before proceeding');
    expect(errors).not.toHaveBeenCalled();
    expect(deltas.mock.calls.some(([,d])=>d.delta==='Please confirm before proceeding')).toBe(true);
    await new Promise(r=>setTimeout(r,200));
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('does not time out on a final ask_question tool response with empty content',async()=>{
    const {provider,root}=await setup('native-child-no-owned-output');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'launch');
    const state=(provider as any).sessions.get(id);
    await vi.waitFor(()=>expect(state.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    await (provider as any).promptTerminals.get(state);
    const native=state.acpSessionId;
    const file=path.join(root,'.gemini/antigravity-cli/brain',native,'.system_generated/logs/transcript_full.jsonl');
    await appendFile(file,
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'ask_question', args: { question: 'Confirm?' } }],
      }) + '\n');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('');
    expect(errors).not.toHaveBeenCalled();
    await new Promise(r=>setTimeout(r,200));
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('does not replace delayed native final text with nonempty intermediate tool commentary',async()=>{
    const {provider,requests}=await setup('native-child-commentary');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'launch');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(errors).not.toHaveBeenCalled();
    expect(done.mock.calls.map(([,m])=>m.content)).toEqual(['PARENT-STARTED','PARENT-WOKE CHILD-PONG']);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(1);
  });
  it('keeps ordinary no-async ACP chunk streaming before the prompt RPC terminates',async()=>{
    const {provider}=await setup('stream-before-ack');const id=await route(provider),done=vi.fn(),deltas=vi.fn();provider.onComplete(done);provider.onDelta(deltas);
    await provider.send(id,'normal');await vi.waitFor(()=>expect(deltas.mock.calls.some(([,d])=>d.delta==='direct ')).toBe(true), { timeout: 5000 });
    expect(done).not.toHaveBeenCalled();await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });expect(done.mock.calls[0][1].content).toBe('direct stream');
  });
  it.each(['stop','rebind'])('discards native-first late ACP receipts across %s',async action=>{
    const {provider}=await setup('native-child-late');const id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    if(action==='stop') await provider.cancel(id);else await route(provider,id,{fresh:true});
    await new Promise(r=>setTimeout(r,600));expect(done).toHaveBeenCalledTimes(2);
  });
  it('reuses a completed native child cursor after send_message without replaying its old terminal',async()=>{
    const {provider,requests}=await setup('native-child-reuse');const id=await route(provider),done=vi.fn(),events:ToolCallEvent[]=[];
    provider.onComplete(done);provider.onToolCall((_,t)=>events.push(t));
    const terminals=()=>events.filter(t=>t.name==='Agent'&&t.detail?.meta?.agentPath==='native-child-fixture'&&t.detail?.meta?.terminal);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });await vi.waitFor(()=>expect(terminals()).toHaveLength(1), { timeout: 5000 });
    const key=terminals()[0].id;
    await provider.send(id,'send child another assignment');
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(4), { timeout: 5000 });await vi.waitFor(()=>expect(terminals()).toHaveLength(2), { timeout: 5000 });
    expect(terminals().every(t=>t.id===key)).toBe(true);
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
    expect(terminals()[1].output).toBe('REUSE-PONG');
  });
  it('closes native log observers on Stop and never revives the stopped parent',async()=>{
    const {provider}=await setup('native-child-log');const id=await route(provider),done=vi.fn();provider.onComplete(done);
    await provider.send(id,'launch');await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const state=(provider as any).sessions.get(id);await provider.cancel(id);
    expect(state.agyBridges.size).toBe(0);await new Promise(r=>setTimeout(r,300));expect(done).toHaveBeenCalledTimes(1);
  });
  it.each(['reordered', 'reject-b'])('Stop waits for all RPCs even after the last one settled (%s)', async scenario => {
    const { provider } = await setup(scenario), id = await route(provider), errors = vi.fn();
    provider.onError(errors);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    const state = (provider as any).sessions.get(id);
    // The last RPC has ended/rejected but the original native A is still live.
    await (provider as any).promptTerminals.get(state).catch(() => {});
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
    const stopping = provider.cancelAndWait(id), confirmed = vi.fn();
    const off = onConfirmedProviderStop(stopping, confirmed);
    try {
      await expect(Promise.race([stopping.then(() => 'stopped'), new Promise(resolve => setTimeout(() => resolve('timeout'), 300))])).resolves.toBe('stopped');
      expect(confirmed).toHaveBeenCalledTimes(1);
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      await expect(provider.send(id, 'AFTER_STOP')).resolves.toBeUndefined();
    } finally { off(); }
  });
  it('confirms an aggregate Stop on captured child death, not a single RPC rejection', async () => {
    const { provider } = await setup('crash-on-cancel'), id = await route(provider), errors = vi.fn();
    provider.onError(errors); await provider.send(id, 'A');
    await provider.notifyActiveDelegation(id, notification('B'));
    await expect(provider.cancelAndWait(id)).resolves.toBeUndefined();
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });
  it('never cancels or confirms a replacement owner through a captured old Stop', async () => {
    const { provider, requests } = await setup(), id = await route(provider), complete = vi.fn();
    provider.onComplete(complete); await provider.send(id, 'A');
    const stopping = provider.cancelAndWait(id), confirmed = vi.fn();
    const rejected = expect(stopping).rejects.toThrow('changed');
    const off = onConfirmedProviderStop(stopping, confirmed);
    try {
      await route(provider, id, { fresh: true });
      await provider.send(id, 'NEW_OWNER'); await rejected;
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(complete.mock.calls[0]?.[1].content).toBe('NEW_OWNER');
      expect(confirmed).not.toHaveBeenCalled();
      expect((await requests()).some(x => x.method === 'session/cancel')).toBe(false);
    } finally { off(); }
  });
  it('holds session/new behind durable ownership and preserves queued no-start evidence', async () => {
    const { provider, requests } = await setup(); const id = await route(provider, undefined, { beforeNativeSessionStart: async () => { throw new Error('disk failed'); } });
    await expect(provider.send(id, 'A')).rejects.toMatchObject({ details: { [AGY_NATIVE_START_NOT_ATTEMPTED]: true } });
    expect((await requests()).some(x => x.method === 'session/new')).toBe(false);
  });
  it('retries a transient initial model rejection without changing the selected model or native conversation', async () => {
    const { provider, requests } = await setup('model-error-once');
    const id = await route(provider, undefined, { agentId: 'model-b' });
    await expect(provider.send(id, 'first')).rejects.toBeTruthy();
    await expect(provider.send(id, 'retry')).resolves.toBeUndefined();
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(1), { timeout: 5000 });
    const rows = await requests();
    expect(rows.filter(x => x.method === 'session/new')).toHaveLength(1);
    expect(rows.filter(x => x.method === 'session/set_model').map(x => x.params.modelId)).toEqual(['model-b', 'model-b']);
  });
  it('does not prompt or publish a late new-session result after Stop', async () => {
    const { provider, requests } = await setup('late-new'); const id = await route(provider); const info = vi.fn(); provider.onSessionInfo(info);
    const sending = provider.send(id, 'A'); const rejected = expect(sending).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CANCELLED });
    await vi.waitFor(async () => expect((await requests()).some(x => x.method === 'session/new')).toBe(true), { timeout: 5000 });
    await provider.cancel(id); await rejected;
    expect((await requests()).some(x => x.method === 'session/prompt')).toBe(false); expect(info).not.toHaveBeenCalled();
  });
  it('resumes exact native IDs without fresh fallback or replay, and isolates main/sub routes', async () => {
    const { provider, requests } = await setup(); const a = await route(provider, 'deck_test_agy_main', { resumeId: 'persisted-main' }); const b = await route(provider, 'deck_test_agy_sub', { resumeId: 'persisted-sub' });
    await provider.send(a, 'A'); await provider.send(b, 'A');
    const rows = await requests(); expect(rows.filter(x => x.method === 'session/resume').map(x => x.params.sessionId)).toEqual(['persisted-main', 'persisted-sub']); expect(rows.some(x => x.method === 'session/new' || x.method === 'session/load')).toBe(false);
    const missing = await route(provider, 'deck_test_agy_missing', { resumeId: 'missing-native' }); await expect(provider.send(missing, 'A')).rejects.toBeTruthy(); expect((await requests()).some(x => x.method === 'session/new')).toBe(false);
  });
  it('selects pending B only on the next idle turn and reports confirmed models', async () => {
    const { provider, requests } = await setup(); const id = await route(provider); const complete = vi.fn(), info: SessionInfoUpdate[] = []; provider.onComplete(complete); provider.onSessionInfo((_id, update) => info.push(update));
    await provider.send(id, 'A'); provider.setSessionAgentId(id, 'model-b');
    expect(info.filter(x => x.model === 'model-b')).toHaveLength(0);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 }); expect(complete.mock.calls[0]?.[1].metadata.model).toBe('model-a');
    await provider.send(id, 'A'); expect(info.some(x => x.model === 'model-b')).toBe(true);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    provider.setSessionAgentId(id, 'model-a'); await provider.send(id, 'A');
    expect((await requests()).filter(x => x.method === 'session/set_model').map(x => x.params.modelId)).toEqual(['model-b', 'model-a']);
  });
  it('ACKs busy selection without changing captured actual or steering, then uses B on the next turn', async () => {
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider);
    const hold = path.join(root, 'rpc.jsonl.hold');
    await writeFile(hold, 'hold');
    const complete = vi.fn(), info = vi.fn(); provider.onComplete(complete); provider.onSessionInfo(info);
    try {
      await provider.send(id, 'A');
      const switching = provider.applySessionModel(id, 'model-b');
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      const repeated = provider.applySessionModel(id, 'model-b');
      expect(await switching).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await repeated).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect((await requests()).filter(row => row.method === 'session/set_model')).toHaveLength(1);
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      await provider.notifyActiveDelegation(id, notification('STEER_AFTER_SELECTION'));
      await vi.waitFor(async () => expect((await requests()).filter(row => row.fixture === 'prompt-model').map(row => row.model)).toEqual(['model-a', 'model-a']), { timeout: 5000 });
    } finally { await unlink(hold); }
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0][1].metadata.model).toBe('model-a');
    await provider.send(id, 'NEXT_TURN');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(complete.mock.calls[1][1].metadata.model).toBe('model-b');
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(true);
    expect((await requests()).filter(row => row.fixture === 'prompt-model').at(-1).model).toBe('model-b');
  });

  it('orders C after a delayed B but never publishes the superseded B ACK', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CANCELLED });
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
    expect(await provider.applySessionModel(id, 'model-c')).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    expect(info.mock.calls.map(call => call[1].model)).toEqual(['model-c']);
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-c']);
  });
  it.each(['cancel', 'replace', 'disconnect'])('rejects a delayed model ACK after %s without stale actual', async action => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'A'); provider.onSessionInfo(info);
    const switching = provider.applySessionModel(id, 'model-b'); const rejected = expect(switching).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
    if (action === 'cancel') await provider.cancel(id);
    else if (action === 'replace') await route(provider, id, { fresh: true });
    else await provider.disconnect();
    await rejected;
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
  });
  it.each(['model-error', 'model-unsupported'])('does not report false model success on %s', async scenario => {
    const { provider } = await setup(scenario); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    await expect(provider.applySessionModel(id, 'model-b')).rejects.toBeTruthy();
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
    await provider.send(id, 'after-rejection');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
  });
  it('reapplies A after a delayed superseded B instead of trusting the old A cache', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider);
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
    expect(await provider.applySessionModel(id, 'model-a')).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-a']);
  });
  it('returns to the retained selection if C fails after superseding a pending B', async () => {
    const { provider, requests } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    const old = provider.applySessionModel(id, 'model-b'); const rejected = expect(old).rejects.toBeTruthy();
    await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
    await expect(provider.applySessionModel(id, 'invalid')).rejects.toBeTruthy(); await rejected;
    await provider.send(id, 'after-failed-c');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'invalid', 'model-a']);
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
  });

  it('bounds a model RPC timeout, rejects its late ACK, and recovers on a new confirmed selection', async () => {
    const { provider } = await setup('model-timeout'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    await expect(provider.applySessionModel(id, 'model-b')).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.PROVIDER_ERROR });
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
    expect(await provider.applySessionModel(id, 'model-c')).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect(info.mock.calls.map(call => call[1].model)).toEqual(['model-c']);
    await provider.send(id, 'after-timeout');
    await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
  }, 10000);

  it('keeps an unloaded selection next-start without creating native work', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    expect((await requests()).some(row => row.method === 'session/new' || row.method === 'session/set_model')).toBe(false);
  });

  it.each(['deck_test_agy_main', 'deck_test_agy_sub'])('confirms a pending unloaded choice when restoring %s without native creation', async name => {
    const { provider, requests } = await setup();
    const id = await route(provider, name, { resumeId: 'owned-native' }); const info = vi.fn();
    provider.onSessionInfo(info);
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    expect(await provider.restoreSession(id)).toBe(true);
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(true);
    expect((await requests()).some(row => row.method === 'session/new')).toBe(false);
    expect((await requests()).find(row => row.method === 'session/set_model').params).toEqual({ sessionId: 'owned-native', modelId: 'model-b' });
    expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect((await requests()).filter(row => row.method === 'session/set_model')).toHaveLength(1);
  });

  it('passes combined native base-model/thought IDs unchanged and captures the original executor choice', async () => {
    const { provider, requests, root } = await setup();
    const id = await route(provider, undefined, { agentId: 'gemini-3.8-flash-low' }); const done = vi.fn(); provider.onComplete(done);
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(await provider.applySessionModel(id, 'gemini-3.8-flash-high')).toBe(SESSION_MODEL_APPLIED.LIVE);
    const hold = path.join(root, 'rpc.jsonl.hold'); await writeFile(hold, 'hold');
    try {
      await provider.send(id, 'A');
      expect(await provider.applySessionModel(id, 'gemini-4-carbon-medium')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
    } finally { await unlink(hold); }
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1][1].metadata.model).toBe('gemini-3.8-flash-high');
    await provider.send(id, 'next'); await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(done.mock.calls[2][1].metadata.model).toBe('gemini-4-carbon-medium');
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-4-carbon-medium']);
  });

  it('defaults new sessions without agentId and cached listModels defaultModel to gemini-4-hydrogen-high when supported', async () => {
    const { provider, requests } = await setup('legacy-flash-default');
    const id = 'deck_test_agy_acp_default';
    const done = vi.fn();
    provider.onComplete(done);
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd(), fresh: true });
    await provider.send(id, 'hello');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['gemini-4-hydrogen-high']);
    expect((await provider.listModels()).defaultModel).toBe('gemini-4-hydrogen-high');
    expect(provider.getCachedModels()?.defaultModel).toBe('gemini-4-hydrogen-high');

    // Resumed native session without explicit agentId keeps its native currentModelId.
    const resumedId = 'deck_test_agy_acp_resumed';
    await provider.createSession({ sessionKey: resumedId, sessionName: resumedId, cwd: process.cwd(), resumeId: 'owned-native' });
    await provider.send(resumedId, 'resumed turn');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-3.8-flash-high');
  });

  it('does not submit a prompt if native model selection fails', async () => {
    const { provider, requests } = await setup(); const id = await route(provider, undefined, { agentId: 'invalid' });
    await expect(provider.send(id, 'A')).rejects.toBeTruthy(); expect((await requests()).some(x => x.method === 'session/prompt')).toBe(false);
  });
  it('keeps a timed-out write pending and deduplicates its retry before native submission', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    await provider.send(id, 'A');
    const tracker = (provider as any).connection.connection;
    let release!: () => void; tracker.writeQueue = new Promise<void>(resolve => { release = resolve; });
    let admitted = false;
    const first = provider.notifyActiveDelegation(id, notification('B')).then(x => { admitted = true; return x; });
    await new Promise(resolve => setTimeout(resolve, 25)); expect(admitted).toBe(false);
    const retry = provider.notifyActiveDelegation(id, notification('B')); release();
    expect(await first).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED); expect(await retry).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2), { timeout: 5000 });
  });
  it('isolates child death to this provider and never replays the admitted B', async () => {
    const { provider, requests } = await setup('crash'); const id = await route(provider), errors = vi.fn(), complete = vi.fn();
    provider.onError(errors); provider.onComplete(complete);
    await provider.send(id, 'A'); await provider.notifyActiveDelegation(id, notification('B'));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete).not.toHaveBeenCalled(); expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(2), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id, notification('C'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
  });
  it('replaces a pending startup owner even when the canonical route is unchanged', async () => {
    const { provider, requests } = await setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const id = await route(provider, 'deck_test_agy_owner', { beforeNativeSessionStart: () => gate });
    const oldSend = provider.send(id, 'old-owner').then(() => 'sent', error => error.code);
    await new Promise(resolve => setTimeout(resolve, 15));
    try {
      await route(provider, id, { beforeNativeSessionStart: async () => {} });
      await expect(provider.send(id, 'new-owner')).resolves.toBeUndefined();
    } finally { release(); }
    expect(await oldSend).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt').map(x => x.params.prompt[0].text)).toEqual(['new-owner']), { timeout: 5000 });
  });
  it('ignores old native-session updates and terminals after delete/recreate of the route', async () => {
    const { provider } = await setup(); const id = await route(provider); const complete = vi.fn(), deltas = vi.fn(); provider.onComplete(complete); provider.onDelta(deltas);
    await provider.send(id, 'A');
    await provider.createSession({ sessionKey: id, cwd: process.cwd(), fresh: true, agentId: 'model-a' });
    await provider.send(id, 'new-owner'); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0]?.[1].content).toBe('new-owner');
    expect(deltas.mock.calls.some(x => x[1].delta === 'A')).toBe(false);
  });
  it('suppresses all resume replay and keeps the current real error visible', async () => {
    const { provider } = await setup('resume-history'); const id = await route(provider, undefined, { resumeId: 'saved-id' });
    const deltas = vi.fn(), complete = vi.fn(); provider.onDelta(deltas); provider.onComplete(complete);
    await provider.send(id, 'A'); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1].content).toBe('A'); expect(deltas.mock.calls.some(x => x[1].delta.includes('OLD_ERROR'))).toBe(false);
  });
  it('includes stable system instructions once per native history and reasserts after refresh', async () => {
    const { provider, requests } = await setup(); const id = await route(provider), complete = vi.fn(); provider.onComplete(complete);
    const base = normalizeProviderPayload('A');
    const input = { ...base, sessionSystemText: 'IDENTITY_TEST_334', context: { ...base.context, sessionSystemText: 'IDENTITY_TEST_334' } };
    await provider.send(id, input); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await provider.send(id, input); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    provider.refreshSessionSystemText(id); await provider.send(id, input);
    // send resolves at native write, before the peer necessarily logs receipt.
    await vi.waitFor(async () => expect((await requests()).filter(x => x.method === 'session/prompt')).toHaveLength(3), { timeout: 5000 });
    const text = (await requests()).filter(x => x.method === 'session/prompt').map(x => x.params.prompt[0].text);
    expect(text.map(x => x.includes('IDENTITY_TEST_334'))).toEqual([true, false, true]);
  });
  it.each(['env', 'home'])('probes and initializes the same CLI without binaryPath on sparse PATH (%s)', async source => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-path-'));
    const binary = path.join(root, source === 'home' ? '.local/bin/agy' : 'chosen-agy');
    await mkdir(path.dirname(binary), { recursive: true });
    const argvLog = path.join(root, 'argv.log'), rpcLog = path.join(root, 'rpc.jsonl');
    await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${process.execPath}' '${path.resolve('test/fixtures/agy-acp.mjs')}' "$@"\n`, { mode: 0o700 });
    vi.stubEnv('HOME', root); vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv(AGY_CLI_PATH_ENV, source === 'env' ? binary : '');
    const config = { env: { HOME: root, PATH: '/usr/bin:/bin', AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: rpcLog } };
    const provider = await createAgyProvider(config) as AgyAcpProvider;
    resources.push({ provider, root });
    // Resolution is frozen at the version probe, not repeated against changed env.
    vi.stubEnv(AGY_CLI_PATH_ENV, path.join(root, 'not-the-probed-cli'));
    await provider.connect(config);
    expect(provider).toBeInstanceOf(AgyAcpProvider);
    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual(['--version', 'acp --process-per-session --dangerously-skip-permissions']);
    const rows = (await readFile(rpcLog, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
    expect(rows.some(x => x.method === 'initialize')).toBe(true);
  });
  it('forwards autonomous wakeup turn stream, maintains provider/runtime busy state, and settles on turn_completed', async () => {
    const { provider, root } = await setup();
    const id = 'deck_test_agy_auto_wakeup';
    const runtime = new TransportSessionRuntime(provider, id);
    const statuses: string[] = [];
    runtime.onStatusChange = s => statuses.push(s);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const deltas: string[] = [], tools: ToolCallEvent[] = [], completed: any[] = [];
    provider.onDelta((sid, d) => { if (sid === id) deltas.push(d.delta); });
    provider.onToolCall((sid, t) => { if (sid === id) tools.push(t); });
    provider.onComplete((sid, m) => { if (sid === id) completed.push(m); });

    const startHold = path.join(root, 'rpc.jsonl.auto-start-hold');
    const thoughtHold = path.join(root, 'rpc.jsonl.auto-thought-hold');
    const autoHold = path.join(root, 'rpc.jsonl.auto-hold');
    await writeFile(startHold, 'hold');
    await writeFile(thoughtHold, 'hold');
    await writeFile(autoHold, 'hold');
    try {
      runtime.send('SCHEDULE_WAKEUP');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      expect(runtime.getStatus()).toBe('idle');

      // Release startHold so autonomous wakeup turn begins with agent_thought_chunk while thoughtHold is held.
      await unlink(startHold);
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('thinking'), { timeout: 5000 });
      expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
        activeWorkCount: 1,
        busyReasons: ['provider_wait'],
      });

      // Release thoughtHold so tool_call (in_progress) is emitted while autoHold is held.
      await unlink(thoughtHold);
      await vi.waitFor(() => expect(tools.some(t => t.id === 'edit-1' && t.status === 'running')).toBe(true), { timeout: 5000 });
      expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
        activeWorkCount: 1,
        activeToolCount: 1,
        busyReasons: ['provider_wait', 'open_tool_call'],
      });
      expect(runtime.getActivitySnapshot()).toMatchObject({
        activeToolCount: 1,
        busyReasons: expect.arrayContaining(['provider_wait', 'open_tool_call']),
      });
      expect((runtime as any)._openTools.get('edit-1')).toMatchObject({
        name: 'edit_file',
        status: 'running',
      });
    } finally {
      await unlink(startHold).catch(() => {});
      await unlink(thoughtHold).catch(() => {});
      await unlink(autoHold).catch(() => {});
    }

    await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
    expect(runtime.getStatus()).toBe('idle');
    expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
    expect(deltas).toContain('AUTONOMOUS_WAKEUP_DONE');
    expect(tools.some(t => t.id === 'edit-1' && t.status === 'complete')).toBe(true);
    expect(completed[1]).toMatchObject({
      content: 'AUTONOMOUS_WAKEUP_DONE',
      metadata: {
        model: 'model-a',
        usage: { inputTokens: 22, outputTokens: 11 },
      },
    });
    await runtime.kill();
  });
  it('converges auto -> external steering to a single terminal and prevents delayed frames after Stop from reviving an autonomous turn', async () => {
    const { provider, root, requests } = await setup('late-after-cancel');
    const id = await route(provider);
    const complete = vi.fn(), errors = vi.fn(), deltas = vi.fn();
    provider.onComplete(complete); provider.onError(errors); provider.onDelta(deltas);

    // 1. auto -> external steering converges to a single terminal onComplete.
    const autoHold = path.join(root, 'rpc.jsonl.auto-hold');
    const autoCancelHold = path.join(root, 'rpc.jsonl.auto-cancel-hold');
    await writeFile(autoHold, 'hold');
    try {
      await provider.send(id, 'SCHEDULE_WAKEUP');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true), { timeout: 5000 });
      expect(await provider.notifyActiveDelegation(id, notification('STEER_IN_AUTO'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    } finally {
      await unlink(autoHold).catch(() => {});
    }
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(complete.mock.calls[1]?.[1].content).toBe('AUTONOMOUS_WAKEUP_DONE STEER_IN_AUTO');
    expect(errors).not.toHaveBeenCalled();

    // 2. Stop / cancelAndWait during an autonomous turn waits for native turn_completed before confirming, then ignores delayed post-Stop frames.
    await writeFile(autoHold, 'hold');
    await writeFile(autoCancelHold, 'hold');
    try {
      await provider.send(id, 'SCHEDULE_WAKEUP');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true), { timeout: 5000 });
      let proof = false, resolved = false;
      const stopping = provider.cancelAndWait(id);
      stopping.then(() => { resolved = true; }, () => {});
      const off = onConfirmedProviderStop(stopping, () => { proof = true; });
      try {
        await vi.waitFor(async () => expect((await requests()).some(r => r.fixture === 'auto-cancel-requested')).toBe(true), { timeout: 5000 });
        expect(proof).toBe(false);
        expect(resolved).toBe(false);
        expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
        await unlink(autoCancelHold);
        await expect(stopping).resolves.toBeUndefined();
        expect(proof).toBe(true);
        expect(resolved).toBe(true);
      } finally {
        off();
      }
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]?.[1].code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
      expect(complete).toHaveBeenCalledTimes(3);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(deltas.mock.calls.some(c => c[1].delta.includes('LATE_AFTER_STOP'))).toBe(false);
    } finally {
      await unlink(autoHold).catch(() => {});
      await unlink(autoCancelHold).catch(() => {});
    }
  });
  it('requires native terminal proof for Stop of an autonomous turn, retains queued work while cancel is ignored, and recovers once native terminal arrives', async () => {
    const { provider, root, requests } = await setup('ignore-auto-cancel');
    const id = 'deck_test_agy_auto_stop_proof';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: any[] = [], errors: any[] = [];
    provider.onComplete((sid, m) => { if (sid === id) completed.push(m); });
    provider.onError((sid, e) => { if (sid === id) errors.push(e); });

    const autoHold = path.join(root, 'rpc.jsonl.auto-hold');
    await writeFile(autoHold, 'hold');
    let off = () => {};
    try {
      runtime.send('SCHEDULE_WAKEUP');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true), { timeout: 5000 });
      expect(runtime.send('QUEUED_SUCCESSOR', 'msg-after-auto-stop')).toBe('queued');

      let proof = false, resolved = false;
      const stop = provider.cancelAndWait(id);
      stop.then(() => { resolved = true; }, () => {});
      off = onConfirmedProviderStop(stop, () => { proof = true; });
      await runtime.cancel();

      await vi.waitFor(async () => expect((await requests()).some(row => row.fixture === 'cancel-ignored')).toBe(true), { timeout: 5000 });
      const ignored = (await requests()).find(row => row.fixture === 'cancel-ignored');
      expect(ignored?.inAutoWakeup).toBe(true);
      expect(proof, 'cancel request is not native terminal proof').toBe(false);
      expect(resolved).toBe(false);
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true);
      expect((await requests()).filter(row => row.method === 'session/prompt')).toHaveLength(1);

      await unlink(autoHold);
      await expect(stop).resolves.toBeUndefined();
      expect(proof).toBe(true);
      expect(resolved).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);

      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
      expect(completed[1]?.content).toBe('QUEUED_SUCCESSOR');
      expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    } finally {
      off();
      await unlink(autoHold).catch(() => {});
      await runtime.kill();
    }
  });
  it('keeps the Windows shim entrypoint/prepend args, not just node.exe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-shim-'));
    const platform = process.platform;
    try {
      const scriptDir = path.join(root, 'node_modules', 'test-agy');
      await mkdir(scriptDir, { recursive: true });
      const script = path.join(scriptDir, 'cli.js'), shim = path.join(root, 'agy.cmd');
      await writeFile(script, '#!/usr/bin/env node\n');
      await writeFile(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\test-agy\\cli.js" %*\r\n');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const config = { binaryPath: shim }, provider = new AgyAcpProvider();
      const spawned = (provider as any).resolveAcpExecutable(config);
      expect(spawned).toEqual(resolveAgyBinary(config));
      expect(spawned.prependArgs).toEqual([script]);
      expect(spawned.executable).toBe(process.execPath);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses version-only selection, preserving unsupported CLI stream FIFO without retrying ACP errors', async () => {
    const { root, binary } = await setup();
    const old = await createAgyProvider({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_VERSION: '1.4.12' } }); expect(old).toBeInstanceOf(AgySdkProvider);
    const current = await createAgyProvider({ binaryPath: binary, env: { HOME: root } }); expect(current).toBeInstanceOf(AgyAcpProvider);
    expect(supportsAgyAcp('unrecognized')).toBe(false); expect(supportsAgyAcp('1.5.0')).toBe(true);
  });
  it('tracks AG native background run_command tasks across end_turn and settles cleanly on completion or server restart', async () => {
    const { provider, root } = await setup('native-child-no-owned-output');
    const id = 'deck_test_agy_bg_task';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: Array<{ content: string }> = [];
    const statuses: string[] = [];
    provider.onComplete((sid, m) => { if (sid === id) completed.push(m); });
    runtime.onStatusChange = (status) => { statuses.push(status); };

    try {
      expect(runtime.send('launch', 'msg-bg-1')).toBe('sent');
      const state = (provider as any).sessions.get(id);
      await vi.waitFor(() => expect(state?.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
      await (provider as any).promptTerminals.get(state);
      const native = state.acpSessionId as string;
      const file = path.join(root, '.gemini/antigravity-cli/brain', native, '.system_generated/logs/transcript_full.jsonl');

      await appendFile(
        file,
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', WaitMsBeforeAsync: 5000 } }],
        }) + '\n'
        + JSON.stringify({
          step_index: 4,
          type: 'GENERIC',
          status: 'RUNNING',
          content: `Tool is running as a background task with task id: ${native}/task-11351`,
        }) + '\n'
        + JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Running full unit suite in background...',
        }) + '\n',
      );

      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      expect(completed[0]?.content).toBe('Running full unit suite in background...');
      await vi.waitFor(() => {
        const snap = provider.getActiveWorkSnapshot(id);
        expect(snap?.activeWorkCount).toBe(1);
        expect(snap?.busyReasons).toContain('background_monitor');
      }, { timeout: 5000 });
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
      expect(runtime.getStatus()).toBe('tool_running');

      // Completion SYSTEM_MESSAGE + reactive PLANNER_RESPONSE settles back to idle.
      await appendFile(
        file,
        JSON.stringify({
          step_index: 6,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: `[Message] timestamp=2026-11-12T18:10:10Z sender=${native}/task-11351 priority=MESSAGE_PRIORITY_HIGH content=Task id "${native}/task-11351" finished with result:\nCommand exited with code 0.`,
        }) + '\n'
        + JSON.stringify({
          step_index: 7,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'BACKGROUND-TASK-DONE',
        }) + '\n',
      );

      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
      expect(completed[1]?.content).toBe('BACKGROUND-TASK-DONE');
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });
      expect(provider.getActiveWorkSnapshot(id)?.activeWorkCount).toBe(0);

      // Standing cron schedule does not hold the session busy; another background command + server restart settles to idle without a reactive PLANNER_RESPONSE.
      await appendFile(
        file,
        JSON.stringify({
          step_index: 8,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: '',
          tool_calls: [
            { name: 'schedule', args: { CronExpression: '*/5 * * * *', IsDaemon: true, Prompt: 'tick' } },
            { name: 'run_command', args: { CommandLine: 'sleep 60', WaitMsBeforeAsync: 5000 } },
          ],
        }) + '\n'
        + JSON.stringify({
          step_index: 9,
          type: 'GENERIC',
          status: 'RUNNING',
          content: `Tool is running as a background task with task id: ${native}/cron-standing`,
        }) + '\n'
        + JSON.stringify({
          step_index: 10,
          type: 'GENERIC',
          status: 'RUNNING',
          content: `Tool is running as a background task with task id: ${native}/task-22222`,
        }) + '\n',
      );

      await vi.waitFor(() => expect(provider.getActiveWorkSnapshot(id)?.activeWorkCount).toBe(1), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('tool_running'), { timeout: 5000 });

      await appendFile(
        file,
        JSON.stringify({
          step_index: 11,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: 'All your subagents and background tasks have been stopped due to server restart.',
        }) + '\n',
      );

      await vi.waitFor(() => expect(provider.getActiveWorkSnapshot(id)?.activeWorkCount).toBe(0), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });
      expect(statuses).toContain('tool_running');
    } finally {
      await runtime.kill();
    }
  });
});
