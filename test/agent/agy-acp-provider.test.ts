import logger from '../../src/util/logger.js';
import { agyNativeStartNotAttemptedError } from '../../src/agent/agy-session-persistence.js';
import { ACP_ERROR_PHASE } from '../../shared/provider-error-codes.js';
import { SDK_SUBAGENT_DETAIL_KIND } from '../../shared/sdk-subagent-status.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';
import { readPersistedAgySystemPrompt } from '../../src/agent/agy-persisted-system-prompt.js';
import { AGY_ACP_AGENT_NAME, AGY_CLI_PATH_ENV } from '../../shared/agy-agent.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, unlink, appendFile, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AgyAcpProvider, createAgyProvider, supportsAgyAcp } from '../../src/agent/providers/agy-acp.js';
import { AgySdkProvider, resolveAgyBinary } from '../../src/agent/providers/agy-sdk.js';
import { AGENT_DELEGATION_NOTIFICATION_RESULTS } from '../../shared/agent-delegation.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import { PROVIDER_ERROR_CODES, normalizeProviderPayload } from '../../src/agent/transport-provider.js';
import { AGY_NATIVE_START_RECOVERY_HINT, AGY_NATIVE_START_NOT_ATTEMPTED } from '../../shared/agy-agent.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { onConfirmedProviderStop } from '../../src/agent/provider-stop-confirmation.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { SessionInfoUpdate, ToolCallEvent } from '../../src/agent/transport-provider.js';

const resources: Array<{ provider: AgyAcpProvider; root: string }> = [];
afterEach(async () => { for (const { provider, root } of resources.splice(0)) { await provider.disconnect(); await rm(root, { recursive: true, force: true }); } vi.unstubAllEnvs(); });
async function setup(scenario = '', extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-acp-'));
  const binary = path.join(root, 'agy');
  const fixture = path.resolve('test/fixtures/agy-acp.mjs');
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o700 });
  const provider = new AgyAcpProvider(); resources.push({ provider, root });
  const log = path.join(root, 'rpc.jsonl');
  await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME, AGY_ACP_FIXTURE_LOG: log, AGY_ACP_FIXTURE_SCENARIO: scenario, ...extraEnv } });
  const requests = async () => (await readFile(log, 'utf8').catch(e => e?.code === 'ENOENT' ? '' : Promise.reject(e))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
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
    if (action === 'stop') {
      expect(await readFile(file,'utf8')).toContain('PARENT-CONTINUED CHILD-RESULT');
    } else {
      expect(old.isolatedTransport).toBeUndefined();
    }
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
  it('attributes G1 output when active steering/ask_question answer writes no new USER_EXPLICIT row (G1 resolves first)',async()=>{
    const {provider,requests}=await setup('absorbed-steering-g1-first');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'initial task');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B','Proceed'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('ABSORBED FINAL G1-FIRST');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:400,output_tokens:5});
    expect(errors).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('defers absorbed G2 settlement until G1 finishes when G2 RPC resolves first',async()=>{
    const {provider,requests}=await setup('absorbed-steering-g2-first');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'initial task');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B','Proceed'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await new Promise(r=>setTimeout(r,15));
    expect(done).not.toHaveBeenCalled();
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('ABSORBED FINAL G2-FIRST');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:200,output_tokens:5});
    expect(errors).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('fails boundedly without publishing unattributed ACP text when absorbed steering produces no terminal native output',async()=>{
    const {provider}=await setup('absorbed-steering-no-native');const id=await route(provider),done=vi.fn(),errors=vi.fn(),deltas=vi.fn();
    provider.onComplete(done);provider.onError(errors);provider.onDelta(deltas);
    await provider.send(id,'initial task');
    const state=(provider as any).sessions.get(id);
    await vi.waitFor(()=>expect(state.agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    state.agyForeground.deadlineMs=30;
    expect(await provider.notifyActiveDelegation(id,notification('B','Proceed'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(()=>expect(errors).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(errors.mock.calls[0][1].message).toContain('could not be attributed');
    expect(done).not.toHaveBeenCalled();
    expect(deltas.mock.calls.filter(([,d])=>d.type==='text')).toHaveLength(0);
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
  });
  it('keeps genuine G2 input logged after G2 RPC ACK attributable instead of dropping it as foreign (F1)',async()=>{
    const {provider,requests}=await setup('native-steering-delayed-input');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'A');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B','genuine steered prompt'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('STEERED DELAYED RESULT');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:400,output_tokens:5});
    expect(errors).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('does not promote pre-answer ask_question when G1 RPC settles before delayed continuation lands (F2: G1 first)',async()=>{
    const {provider,requests}=await setup('absorbed-steering-g1-first-delayed');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'initial task');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B','Proceed'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('ABSORBED FINAL G1-FIRST DELAYED');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:400,output_tokens:5});
    expect(errors).not.toHaveBeenCalled();
    expect((await requests()).filter(r=>r.method==='session/prompt')).toHaveLength(2);
  });
  it('waits past pre-answer ask_question even when both G1 and G2 RPCs settle before delayed native continuation lands (F2: both RPCs first)',async()=>{
    const {provider,requests}=await setup('absorbed-steering-both-before-native');const id=await route(provider),done=vi.fn(),errors=vi.fn();provider.onComplete(done);provider.onError(errors);
    await provider.send(id,'initial task');await vi.waitFor(()=>expect((provider as any).sessions.get(id).agyForeground?.authoritative).toBe(true), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id,notification('B','Proceed'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    const state=(provider as any).sessions.get(id);
    // Flush bridge after fixture appends delayed row at 55ms so host EMFILE inotify limits cannot mask bridge delivery.
    setTimeout(()=>{ void state.agyBridges?.get(state.acpSessionId)?.flush(); }, 80);
    await vi.waitFor(()=>expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0][1].content).toBe('ABSORBED FINAL BOTH-BEFORE-NATIVE');
    expect(done.mock.calls[0][1].metadata.usage).toMatchObject({input_tokens:400,output_tokens:5});
    expect(errors).not.toHaveBeenCalled();
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
  it.each([
    [PROVIDER_ERROR_CODES.CONFIG_ERROR, 'AG conversation has no trusted resume id or unused proof'],
    [PROVIDER_ERROR_CODES.CONFIG_ERROR, 'Cannot persist AG native start; no process was started'],
    [PROVIDER_ERROR_CODES.CANCELLED, 'AG start owner changed'],
  ])('preserves structured durable barrier error %s: %s', async (code, message) => {
    const error = agyNativeStartNotAttemptedError(message, code);
    const { provider, requests } = await setup();
    const id = await route(provider, undefined, { beforeNativeSessionStart: async () => { throw error; } });
    await expect(provider.send(id, 'A')).rejects.toBe(error);
    expect((await requests()).some(x => x.method === 'session/new')).toBe(false);
  });

  it.each([
    [ACP_ERROR_PHASE.NEW_SESSION, 'newSession'],
    [ACP_ERROR_PHASE.RESUME_SESSION, 'resumeSession'],
    [ACP_ERROR_PHASE.LOAD_SESSION, 'loadSession'],
    [ACP_ERROR_PHASE.CONFIRM_MODEL, 'unstable_setSessionModel'],
    [ACP_ERROR_PHASE.PROMPT, 'prompt'],
  ])('logs only safe structured ACP diagnostics during %s', async (phase, method) => {
    const { provider } = await setup();
    // Exercise the shared ACP engine's load option as well as AG's resume option.
    if (phase === ACP_ERROR_PHASE.LOAD_SESSION) {
      Object.defineProperty(provider, 'profile', { value: { ...(provider as any).profile, resumeWithoutReplay: false } });
    }
    const raw = 'PRIVATE_PROMPT /Users/private/path secret-token-value';
    const error = Object.assign(new Error(raw), { code: -32602, data: { prompt: raw, path: raw } });
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errors = vi.fn(); provider.onError(errors);
    try {
      const id = await route(provider, undefined, phase === ACP_ERROR_PHASE.RESUME_SESSION || phase === ACP_ERROR_PHASE.LOAD_SESSION
        ? { resumeId: 'native-existing' } : phase === ACP_ERROR_PHASE.CONFIRM_MODEL ? { agentId: 'model-b' } : {});
      await (provider as any).startPerSessionAcpServer(id, (provider as any).sessions.get(id));
      vi.spyOn((provider as any).sessions.get(id).isolatedTransport.connection, method).mockRejectedValue(error);
      await provider.send(id, 'user prompt').catch(() => {});
      await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 5000 });
      expect(warnings.mock.calls.some(([fields]) => (fields as any)?.acpPhase === phase
        && (fields as any)?.rpcCode === -32602 && (fields as any)?.errorCode === '-32602')).toBe(true);
      const exposed = JSON.stringify({ warnings: warnings.mock.calls, errors: errors.mock.calls });
      for (const secret of ['PRIVATE_PROMPT', '/Users/private/path', 'secret-token-value']) expect(exposed).not.toContain(secret);
      if (phase === ACP_ERROR_PHASE.NEW_SESSION) expect(errors.mock.calls[0][1].message).toContain('session_restart reset=true');
    } finally { warnings.mockRestore(); }
  });

  it('does not log arbitrary upstream error codes as safe identifiers', async () => {
    const { provider } = await setup();
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const id = await route(provider);
      await (provider as any).startPerSessionAcpServer(id, (provider as any).sessions.get(id));
      vi.spyOn((provider as any).sessions.get(id).isolatedTransport.connection, 'newSession').mockRejectedValue(Object.assign(new Error('private text'), { code: 'secret-token-value' }));
      await expect(provider.send(id, 'A')).rejects.toMatchObject({ details: { acpPhase: ACP_ERROR_PHASE.NEW_SESSION, errorCode: 'unknown' } });
      expect(warnings.mock.calls.some(([fields]) => (fields as any)?.acpPhase === ACP_ERROR_PHASE.NEW_SESSION
        && (fields as any)?.errorCode === 'unknown' && !('rpcCode' in (fields as any)))).toBe(true);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret-token-value');
    } finally { warnings.mockRestore(); }
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
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await Promise.all([writeFile(hold, 'hold'), writeFile(modelHold, 'hold')]);
    const complete = vi.fn(), info = vi.fn(); provider.onComplete(complete); provider.onSessionInfo(info);
    try {
      await provider.send(id, 'A');
      const switching = provider.applySessionModel(id, 'model-b');
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      const repeated = provider.applySessionModel(id, 'model-b');
      await rm(modelHold, { force: true });
      expect(await switching).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await repeated).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect(await provider.applySessionModel(id, 'model-b')).toBe(SESSION_MODEL_APPLIED.NEXT_START);
      expect((await requests()).filter(row => row.method === 'session/set_model')).toHaveLength(1);
      expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(false);
      await provider.notifyActiveDelegation(id, notification('STEER_AFTER_SELECTION'));
      await vi.waitFor(async () => expect((await requests()).filter(row => row.fixture === 'prompt-model').map(row => row.model)).toEqual(['model-a', 'model-a']), { timeout: 5000 });
    } finally { await Promise.all([rm(hold, { force: true }), rm(modelHold, { force: true })]); }
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0][1].metadata.model).toBe('model-a');
    await provider.send(id, 'NEXT_TURN');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(complete.mock.calls[1][1].metadata.model).toBe('model-b');
    expect(info.mock.calls.some(call => call[1].model === 'model-b')).toBe(true);
    expect((await requests()).filter(row => row.fixture === 'prompt-model').at(-1).model).toBe('model-b');
  });

  it('orders C after a delayed B but never publishes the superseded B ACK', async () => {
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await writeFile(modelHold, 'hold');
    try {
      const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CANCELLED });
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      const second = provider.applySessionModel(id, 'model-c');
      await rm(modelHold, { force: true });
      expect(await second).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    } finally { await rm(modelHold, { force: true }); }
    expect(info.mock.calls.map(call => call[1].model)).toEqual(['model-c']);
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-c']);
  });
  it.each(['cancel', 'replace', 'disconnect'])('rejects a delayed model ACK after %s without stale actual', async action => {
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'A'); provider.onSessionInfo(info);
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await writeFile(modelHold, 'hold');
    try {
      const switching = provider.applySessionModel(id, 'model-b'); const rejected = expect(switching).rejects.toBeTruthy();
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      if (action === 'cancel') await provider.cancel(id);
      else if (action === 'replace') await route(provider, id, { fresh: true });
      else await provider.disconnect();
      await rm(modelHold, { force: true });
      await rejected;
    } finally { await rm(modelHold, { force: true }); }
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
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider);
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await writeFile(modelHold, 'hold');
    try {
      const first = provider.applySessionModel(id, 'model-b'); const rejected = expect(first).rejects.toBeTruthy();
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      const second = provider.applySessionModel(id, 'model-a');
      await rm(modelHold, { force: true });
      expect(await second).toBe(SESSION_MODEL_APPLIED.LIVE); await rejected;
    } finally { await rm(modelHold, { force: true }); }
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['model-b', 'model-a']);
  });
  it('returns to the retained selection if C fails after superseding a pending B', async () => {
    const { provider, requests, root } = await setup('model-late'); const id = await route(provider); const info = vi.fn();
    await provider.send(id, 'warm'); await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false), { timeout: 5000 });
    provider.onSessionInfo(info);
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await writeFile(modelHold, 'hold');
    try {
      const old = provider.applySessionModel(id, 'model-b'); const rejected = expect(old).rejects.toBeTruthy();
      await vi.waitFor(async () => expect((await requests()).some(row => row.method === 'session/set_model')).toBe(true), { timeout: 5000 });
      const failed = provider.applySessionModel(id, 'invalid');
      await rm(modelHold, { force: true });
      await expect(failed).rejects.toBeTruthy(); await rejected;
    } finally { await rm(modelHold, { force: true }); }
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

    // Resumed native session without explicit agentId ALSO locks to gemini-4-hydrogen-high
    // rather than adopting upstream's unpersisted default currentModelId.
    const resumedId = 'deck_test_agy_acp_resumed';
    await provider.createSession({ sessionKey: resumedId, sessionName: resumedId, cwd: process.cwd(), resumeId: 'owned-native' });
    await provider.send(resumedId, 'resumed turn');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');
    expect((await requests()).filter(row => row.method === 'session/set_model').map(row => row.params.modelId)).toEqual(['gemini-4-hydrogen-high', 'gemini-4-hydrogen-high']);
  });

  it('locks both newSession and resumeSession against upstream gemini-4-carbon-medium while honoring explicit agentId and fallback listModels', async () => {
    const { provider, requests } = await setup('upstream-carbon-default');
    // Before any ACP session loads, listModels falls back to static AGY models + gemini-4-hydrogen-high default.
    expect(provider.getCachedModels()).toBeNull();
    const preloaded = await provider.listModels();
    expect(preloaded.defaultModel).toBe('gemini-4-hydrogen-high');
    expect(preloaded.isAuthenticated).toBe(true);
    expect(preloaded.models.some(m => m.id === 'gemini-4-hydrogen-high')).toBe(true);

    const emittedModels: Array<[string, string]> = [];
    const done = vi.fn();
    provider.onSessionInfo((sid, info) => {
      if (info.model) emittedModels.push([sid, info.model]);
    });
    provider.onComplete(done);

    // 1) Resumed session without explicit agentId: must apply gemini-4-hydrogen-high and never emit carbon-medium.
    const defaultResume = 'deck_test_agy_carbon_default_resume';
    await provider.createSession({ sessionKey: defaultResume, sessionName: defaultResume, cwd: process.cwd(), resumeId: 'native-default-1' });
    expect(await provider.restoreSession(defaultResume)).toBe(true);
    await provider.send(defaultResume, 'after daemon restart');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // 2) Resumed session WITH explicit user-selected model: must replay gemini-4-argon-high and never emit carbon-medium or hydrogen-high.
    const customResume = 'deck_test_agy_carbon_custom_resume';
    await provider.createSession({ sessionKey: customResume, sessionName: customResume, cwd: process.cwd(), resumeId: 'native-custom-1', agentId: 'gemini-4-argon-high' });
    await provider.send(customResume, 'custom model turn');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-argon-high');

    expect(emittedModels.some(([, m]) => m === 'gemini-4-carbon-medium')).toBe(false);
    expect(emittedModels.filter(([sid]) => sid === defaultResume).every(([, m]) => m === 'gemini-4-hydrogen-high')).toBe(true);
    expect(emittedModels.filter(([sid]) => sid === customResume).every(([, m]) => m === 'gemini-4-argon-high')).toBe(true);

    const setModelCalls = (await requests()).filter(row => row.method === 'session/set_model').map(row => ({
      sessionId: row.params.sessionId,
      modelId: row.params.modelId,
    }));
    expect(setModelCalls).toEqual([
      { sessionId: 'native-default-1', modelId: 'gemini-4-hydrogen-high' },
      { sessionId: 'native-custom-1', modelId: 'gemini-4-argon-high' },
    ]);

    // 3) Cached/live listModels retains full upstream dynamic list for manual switching, with defaultModel locked to gemini-4-hydrogen-high.
    const postLoaded = await provider.listModels();
    expect(postLoaded.defaultModel).toBe('gemini-4-hydrogen-high');
    expect(postLoaded.models.map(m => m.id)).toEqual([
      'gemini-4-carbon-medium',
      'gemini-4-hydrogen-high',
      'gemini-4-argon-high',
    ]);
    expect(provider.getCachedModels()?.defaultModel).toBe('gemini-4-hydrogen-high');
  });

  it('does not submit a prompt if native model selection fails', async () => {
    const { provider, requests } = await setup(); const id = await route(provider, undefined, { agentId: 'invalid' });
    await expect(provider.send(id, 'A')).rejects.toBeTruthy(); expect((await requests()).some(x => x.method === 'session/prompt')).toBe(false);
  });
  it('keeps a timed-out write pending and deduplicates its retry before native submission', async () => {
    const { provider, requests } = await setup(); const id = await route(provider);
    await provider.send(id, 'A');
    const tracker = (provider as any).sessions.get(id).isolatedTransport.connection.connection;
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
    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual(['--version']);
    const id = await route(provider);
    await provider.send(id, 'warm');
    expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual(['--version', 'acp --stdio --dangerously-skip-permissions']);
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
      await vi.waitFor(async () => expect((await requests()).some((r) =>
        r.method === 'session/prompt' && JSON.stringify(r.params?.prompt ?? '').includes('STEER_IN_AUTO')
      )).toBe(true), { timeout: 5000 });
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
        expect(snap?.backgroundWorkCount).toBe(1);
        expect(snap?.activeToolCount).toBe(0);
        expect(snap?.busyReasons).toContain('background_monitor');
        expect(snap?.busyReasons).not.toContain('open_tool_call');
      }, { timeout: 5000 });
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);
      expect(runtime.getActivitySnapshot().backgroundWorkCount).toBe(1);
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

      await vi.waitFor(() => {
        expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
          activeWorkCount: 1,
          backgroundWorkCount: 1,
          activeToolCount: 0,
          busyReasons: ['background_monitor'],
        });
      }, { timeout: 5000 });
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);
      expect(runtime.getActivitySnapshot().backgroundWorkCount).toBe(1);
      expect(runtime.getStatus()).toBe('tool_running');

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
      await vi.waitFor(() => expect(runtime.getActivitySnapshot().backgroundWorkCount).toBe(0), { timeout: 5000 });
      expect(runtime.getStatus()).toBe('idle');
      expect(statuses).toContain('tool_running');
    } finally {
      await runtime.kill();
    }
  });

  it('starts an autonomous turn when wakeup session/update frames arrive in the same stdout chunk right after prompt end_turn', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-same-tick-'));
    const holdFile = path.join(root, 'auto.hold');
    const script = path.join(root, 'same-tick-agy.mjs');
    const binary = path.join(root, 'agy');
    await writeFile(holdFile, 'hold');
    await writeFile(script, `
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
const holdFile = ${JSON.stringify(holdFile)};
const rl = createInterface({ input: process.stdin });
const send = (lines) => process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send([{ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version: '2.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
    } }]);
    return;
  }
  if (msg.method === 'session/new') {
    send([{ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 'native-same-tick',
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }] },
    } }]);
    return;
  }
  if (msg.method === 'session/prompt') {
    send([
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-same-tick', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'INITIAL_OK' } } } },
      { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-same-tick', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } } } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-same-tick', update: { sessionUpdate: 'tool_call', toolCallId: 'edit-same-tick', title: 'Edit', kind: 'edit', status: 'running' } } },
    ]);
    const poll = setInterval(() => {
      if (existsSync(holdFile)) return;
      clearInterval(poll);
      send([
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-same-tick', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AUTO_SAME_TICK_DONE' } } } },
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-same-tick', update: { sessionUpdate: 'turn_completed' } } },
      ]);
    }, 5);
  }
});
`);
    await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
    const provider = new AgyAcpProvider();
    resources.push({ provider, root });
    await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME } });
    const id = await route(provider, 'deck_test_same_tick');
    const complete = vi.fn();
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onError(errors);

    try {
      await provider.send(id, 'hello');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(true), { timeout: 5000 });
      expect(complete.mock.calls[0]?.[1].content).toBe('INITIAL_OK');
    } finally {
      await unlink(holdFile).catch(() => {});
    }

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(complete.mock.calls[1]?.[1].content).toBe('AUTO_SAME_TICK_DONE');
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('preserves second prompt text and settles idle when response(A), second chunk, and response(B) arrive in the same stdout chunk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-dual-prompt-'));
    const script = path.join(root, 'dual-prompt-agy.mjs');
    const binary = path.join(root, 'agy');
    await writeFile(script, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (lines) => process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n');
let promptAId = null;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send([{ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentInfo: { name: ${JSON.stringify(AGY_ACP_AGENT_NAME)}, version: '2.0.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
    } }]);
    return;
  }
  if (msg.method === 'session/new') {
    send([{ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 'native-dual-prompt',
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }] },
    } }]);
    return;
  }
  if (msg.method === 'session/prompt') {
    if (promptAId === null) {
      promptAId = msg.id;
      send([
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-dual-prompt', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FIRST ' } } } },
      ]);
      return;
    }
    send([
      { jsonrpc: '2.0', id: promptAId, result: { stopReason: 'end_turn' } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-dual-prompt', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SECOND' } } } },
      { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } },
    ]);
  }
});
`);
    await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
    const provider = new AgyAcpProvider();
    resources.push({ provider, root });
    await provider.connect({ binaryPath: binary, env: { HOME: root, AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME } });
    const id = await route(provider, 'deck_test_dual_prompt');
    const complete = vi.fn();
    const deltas: string[] = [];
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onDelta((sid, evt) => {
      if (sid === id && evt.type === 'text' && evt.delta) deltas.push(evt.delta);
    });
    provider.onError(errors);

    await provider.send(id, 'FIRST');
    await vi.waitFor(() => expect(deltas.join('')).toBe('FIRST '), { timeout: 5000 });
    expect(await provider.notifyActiveDelegation(id, notification('SECOND'))).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1].content).toBe('FIRST SECOND');
    expect(provider.getSessionDiagnostics(id)?.promptInFlight).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not create bogus Agent cards or bleed sibling background/MCP outputs onto parallel subagent tool calls', async () => {
    const { provider, root } = await setup('native-child-log');
    const id = await route(provider, 'deck_test_parallel_bleed');
    const done = vi.fn();
    const events: ToolCallEvent[] = [];
    provider.onComplete(done);
    provider.onToolCall((_, tool) => events.push(tool));

    await provider.send(id, 'launch');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(
      () => expect(events.some((e) => e.detail?.meta?.agentPath === 'native-child-fixture' && e.detail?.meta?.normalizedStatus === 'complete')).toBe(true),
      { timeout: 5000 },
    );

    const state = (provider as any).sessions.get(id);
    const nativeId = state.acpSessionId as string;
    const file = path.join(root, '.gemini/antigravity-cli/brain', nativeId, '.system_generated/logs/transcript_full.jsonl');
    const beforeAgentCount = events.filter((e) => e.detail?.kind === SDK_SUBAGENT_DETAIL_KIND).length;
    const update = (u: any) => (provider as any).handleSessionUpdate({ sessionId: nativeId, update: u });

    // Case 1: send_message to IM.codes deck_sub_* in parallel with run_command background task & send_list_targets.
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'peer-send-1',
      title: 'Run send_message',
      status: 'in_progress',
      rawInput: { Recipient: 'deck_sub_602p4q1r', Message: 'ping' },
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'peer-send-1',
      status: 'failed',
      rawOutput: 'recipient not found',
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'mcp-list-1',
      title: 'send_list_targets',
      status: 'completed',
      rawOutput: 'Created At: 2026-11-13T20:18:29+08:00\nsend_list_targets: []',
    });

    await appendFile(
      file,
      JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { name: 'send_message', args: { Recipient: 'deck_sub_602p4q1r', Message: 'ping' } },
          { name: 'send_list_targets', args: {} },
          { name: 'run_command', args: { CommandLine: 'sleep 10', WaitMsBeforeAsync: 5000 } },
        ],
      }) + '\n'
      + JSON.stringify({
        step_index: 11,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${nativeId}/task-999`,
      }) + '\n'
      + JSON.stringify({
        step_index: 12,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created At: 2026-11-13T20:18:29+08:00\nsend_list_targets: []',
      }) + '\n'
      + JSON.stringify({
        step_index: 13,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'checked',
      }) + '\n',
    );

    await vi.waitFor(() => {
      expect(provider.getActiveWorkSnapshot(id)?.busyReasons).toContain('background_monitor');
    }, { timeout: 5000 });
    expect(events.filter((e) => e.detail?.kind === SDK_SUBAGENT_DETAIL_KIND)).toHaveLength(beforeAgentCount);

    // Case 2: parallel [invoke_subagent, run_command] where run_command's RUNNING row arrives first.
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'parallel-launch-1',
      title: 'Run invoke_subagent',
      status: 'in_progress',
      rawInput: { Role: 'ParallelWorker', Prompt: 'work' },
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'parallel-launch-1',
      status: 'completed',
    });
    await appendFile(
      file,
      JSON.stringify({
        step_index: 14,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'ParallelWorker', Prompt: 'work' } },
          { name: 'run_command', args: { CommandLine: 'npm test', WaitMsBeforeAsync: 5000 } },
        ],
      }) + '\n'
      + JSON.stringify({
        step_index: 15,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${nativeId}/task-1000`,
      }) + '\n'
      + JSON.stringify({
        step_index: 16,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created the following subagent:\n' + JSON.stringify({ conversationId: 'parallel-child-1', status: 'running' }),
      }) + '\n',
    );

    await vi.waitFor(() => {
      const bound = events.find((e) => e.detail?.meta?.agentPath === 'parallel-child-1');
      expect(bound).toBeTruthy();
      expect(bound?.output ?? '').not.toContain('Tool is running as a background task');
    }, { timeout: 5000 });
  });

  it('preserves authoritative ACP rawOutput across out-of-order parallel MCP GENERIC rows without duplicating or leaking outputs', async () => {
    const { provider, root } = await setup('native-child-log');
    const id = await route(provider, 'deck_test_f1_rawoutput_race');
    const done = vi.fn();
    const events: ToolCallEvent[] = [];
    provider.onComplete(done);
    provider.onToolCall((_, tool) => events.push(tool));

    await provider.send(id, 'launch');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(
      () => expect(events.some((e) => e.detail?.meta?.agentPath === 'native-child-fixture' && e.detail?.meta?.normalizedStatus === 'complete')).toBe(true),
      { timeout: 5000 },
    );

    const state = (provider as any).sessions.get(id);
    const nativeId = state.acpSessionId as string;
    const file = path.join(root, '.gemini/antigravity-cli/brain', nativeId, '.system_generated/logs/transcript_full.jsonl');
    const update = (u: any) => (provider as any).handleSessionUpdate({ sessionId: nativeId, update: u });

    // Case 1: rawOutput-only subagent completes via ACP BEFORE sibling send_list_targets's
    // GENERIC arrives and BEFORE send_list_targets's ACP update arrives.
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'f1-invoke-1',
      title: 'Run invoke_subagent',
      status: 'in_progress',
      rawInput: { Role: 'RealWorker', Prompt: 'do work' },
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'f1-list-1',
      title: 'send_list_targets',
      status: 'in_progress',
      rawInput: {},
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'f1-invoke-1',
      status: 'completed',
      rawOutput: { conversationId: 'real-child', status: 'running' },
    });

    const eventsBeforeGeneric = events.filter((e) => e.detail?.meta?.agentPath === 'real-child').length;
    expect(eventsBeforeGeneric).toBe(1);

    await appendFile(
      file,
      JSON.stringify({
        step_index: 20,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'RealWorker', Prompt: 'do work' } },
          { name: 'send_list_targets', args: {} },
        ],
      }) + '\n'
      + JSON.stringify({
        step_index: 21,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created At: 2026-11-13T20:18:29+08:00\nsend_list_targets: MCPPARALLEL_RESULT',
      }) + '\n',
    );

    // Sibling MCP update arrives AFTER both transcript rows have been consumed;
    // real-child must NOT receive MCPPARALLEL_RESULT. A fixed sleep is flaky on
    // loaded macOS runners, so wait on the reader's observable native order.
    await vi.waitFor(() => {
      // The GENERIC row consumes send_list_targets immediately; the remaining
      // invoke_subagent order entry proves both transcript rows were handled.
      expect(state.agyNativeToolOrder?.map((entry: { name: string }) => entry.name))
        .toEqual(['invoke_subagent']);
    }, { timeout: 5000 });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'f1-list-1',
      status: 'completed',
      rawOutput: 'Created At: 2026-11-13T20:18:29+08:00\nsend_list_targets: MCPPARALLEL_RESULT',
    });

    // Now the real child's own GENERIC row arrives later.
    await appendFile(
      file,
      JSON.stringify({
        step_index: 22,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created the following subagent:\n' + JSON.stringify({ conversationId: 'real-child', status: 'running' }),
      }) + '\n',
    );

    await vi.waitFor(() => {
      expect(state.agyConsumedNativeTools?.has('f1-invoke-1')).toBe(true);
    }, { timeout: 5000 });

    const realChildEvents = events.filter((e) => e.detail?.meta?.agentPath === 'real-child');
    expect(realChildEvents).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('"agentPath":"real-child","output":"Created At:');
    expect(realChildEvents.some((e) => (e.output ?? '').includes('MCPPARALLEL_RESULT'))).toBe(false);
    expect(state.agyNativeToolOrder).toEqual([]);

    // Case 2: two parallel invoke_subagent calls (Alpha completes via ACP, Beta completes via
    // transcript GENERIC first, Alpha's GENERIC arrives second).
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'f1-alpha',
      title: 'Run invoke_subagent',
      status: 'in_progress',
      rawInput: { Role: 'Alpha', Prompt: 'alpha work' },
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'f1-beta',
      title: 'Run invoke_subagent',
      status: 'in_progress',
      rawInput: { Role: 'Beta', Prompt: 'beta work' },
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'f1-alpha',
      status: 'completed',
      rawOutput: { conversationId: 'child-alpha', status: 'running' },
    });

    await appendFile(
      file,
      JSON.stringify({
        step_index: 23,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [
          { name: 'invoke_subagent', args: { Role: 'Alpha', Prompt: 'alpha work' } },
          { name: 'invoke_subagent', args: { Role: 'Beta', Prompt: 'beta work' } },
        ],
      }) + '\n'
      + JSON.stringify({
        step_index: 24,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created the following subagent:\n' + JSON.stringify({ conversationId: 'child-beta', status: 'running' }),
      }) + '\n'
      + JSON.stringify({
        step_index: 25,
        type: 'GENERIC',
        status: 'DONE',
        content: 'Created the following subagent:\n' + JSON.stringify({ conversationId: 'child-alpha', status: 'running' }),
      }) + '\n',
    );

    await vi.waitFor(() => {
      expect(events.some((e) => e.detail?.meta?.agentPath === 'child-beta')).toBe(true);
      expect(state.agyConsumedNativeTools?.has('f1-alpha')).toBe(true);
      expect(state.agyConsumedNativeTools?.has('f1-beta')).toBe(true);
    }, { timeout: 5000 });

    const alphaEvents = events.filter((e) => e.detail?.meta?.agentPath === 'child-alpha');
    const betaEvents = events.filter((e) => e.detail?.meta?.agentPath === 'child-beta');
    expect(alphaEvents).toHaveLength(1);
    expect(betaEvents).toHaveLength(1);
    expect(alphaEvents[0].detail?.meta?.agentName).toBe('Alpha');
    expect(betaEvents[0].detail?.meta?.agentName).toBe('Beta');
    expect(state.agyNativeToolOrder).toEqual([]);
  });

  it('cancel() when !promptInFlight clears background tasks, open tool calls, and waiting status without a synthetic error', async () => {
    const { provider } = await setup();
    const id = await route(provider);
    const completed: Array<{ content: string }> = [];
    const errors: unknown[] = [];
    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onComplete((_sid, msg) => completed.push({ content: msg.content }));
    provider.onError((_sid, err) => errors.push(err));
    provider.onStatus((_sid, status) => statuses.push({ status: status.status, label: status.label }));

    await provider.send(id, 'warm');
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });

    const state = (provider as any).sessions.get(id);
    const nativeId = state.acpSessionId as string;
    expect(state.promptInFlight).toBe(false);

    // Simulate active background task + non-in-flight open tool call + waiting status.
    (provider as any).updateAgyBackgroundTasks(id, state, {
      text: `Tool is running as a background task with task id: ${nativeId}/task-stale-bg`,
      toolName: 'run_command',
    });
    (provider as any).handleToolCall(id, state, {
      sessionUpdate: 'tool_call',
      toolCallId: 'orphan-tool-call',
      title: 'Bash',
      status: 'in_progress',
    });
    expect(state.promptInFlight).toBe(false);

    await vi.waitFor(() => {
      const snap = provider.getActiveWorkSnapshot(id);
      expect(snap?.activeWorkCount).toBeGreaterThan(0);
      expect(snap?.busyReasons).toContain('background_monitor');
      expect(snap?.busyReasons).toContain('open_tool_call');
    }, { timeout: 5000 });

    await provider.cancel(id);

    expect(errors).toHaveLength(0);
    expect(state.agyBackgroundTasks?.size ?? 0).toBe(0);
    expect(state.toolCalls.size).toBe(0);
    expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
    expect(statuses.at(-1)).toEqual({ status: null, label: null });

    await provider.send(id, 'follow up');
    await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
  });

  it('dispatches plain-text append sends immediately while background tasks run with !promptInFlight', async () => {
    resetTransportQueueStoreForTests();
    const { provider } = await setup();
    const id = 'deck_test_agy_bg_append';
    const completed: Array<{ content: string }> = [];
    const runtime = new TransportSessionRuntime(provider, id);
    provider.onComplete((sid, msg) => { if (sid === id) completed.push({ content: msg.content }); });
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    try {
      expect(runtime.send('warm', 'warm-1')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;
      expect(state.promptInFlight).toBe(false);
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/task-bg-append`,
        toolName: 'run_command',
      });

      const snap = provider.getActiveWorkSnapshot(id);
      expect(snap).toMatchObject({
        activeWorkCount: 1,
        backgroundWorkCount: 1,
        activeToolCount: 0,
        busyReasons: ['background_monitor'],
      });
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);
      expect(runtime.getStatus()).toBe('tool_running');

      expect(runtime.send('plain append while bg runs', 'bg-plain-1', undefined, undefined, {
        deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      })).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
      expect(runtime.pendingEntries).toEqual([]);
    } finally {
      await runtime.kill();
    }
  });

  it('clears provisional ACP tools on useAgyNativeOutput and ignores status-less late tool_call_update when idle', async () => {
    const { provider } = await setup();
    const id = await route(provider);
    const completed: Array<{ content: string }> = [];
    provider.onComplete((_sid, msg) => completed.push({ content: msg.content }));

    await provider.send(id, 'warm');
    await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });

    const state = (provider as any).sessions.get(id);
    const nativeId = state.acpSessionId as string;
    (provider as any).handleSessionUpdate({
      sessionId: nativeId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'provisional-tool',
        title: 'Bash',
        status: 'in_progress',
      },
    });
    expect(state.promptInFlight).toBe(true);
    expect(state.toolCalls.size).toBe(1);

    (provider as any).useAgyNativeOutput(state);
    expect(state.promptInFlight).toBe(false);
    expect(state.toolCalls.size).toBe(0);

    (provider as any).handleSessionUpdate({
      sessionId: nativeId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late-statusless-tool',
        rawOutput: 'late output',
      },
    });

    expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
      activeWorkCount: 0,
      backgroundWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('retires provisional tools from TransportSessionRuntime on useAgyNativeOutput, blocks non-terminal late frames, and drains/dispatches appends immediately', async () => {
    resetTransportQueueStoreForTests();
    const { provider, requests, root } = await setup();
    const id = 'deck_test_agy_provisional_runtime_handoff';
    const toolEvents: ToolCallEvent[] = [];
    const completed: Array<{ content: string }> = [];
    provider.onToolCall((sid, evt) => { if (sid === id) toolEvents.push(evt); });
    const runtime = new TransportSessionRuntime(provider, id);
    provider.onComplete((sid, msg) => { if (sid === id) completed.push({ content: msg.content }); });
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    try {
      expect(runtime.send('warm', 'warm-rt-1')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;

      // Prepare native transcript log so post-handoff turns attribute cleanly.
      const nativeLogFile = path.join(root, '.gemini/antigravity-cli/brain', nativeId, '.system_generated/logs/transcript_full.jsonl');
      await mkdir(path.dirname(nativeLogFile), { recursive: true });
      await appendFile(
        nativeLogFile,
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'warm' }) + '\n'
        + JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'warm ok' }) + '\n',
      );

      // Provisional ACP tool opens an autonomous generation while idle; a concurrent send queues.
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'provisional-tool',
          title: 'Bash',
          status: 'in_progress',
        },
      });
      expect(state.promptInFlight).toBe(true);
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
      expect(runtime.send('queued during provisional', 'handoff-queued-1')).toBe('queued');
      expect(runtime.pendingEntries).toHaveLength(1);

      // Native output handoff retires the provisional generation, closes Runtime._openTools, and drains queue immediately.
      (provider as any).useAgyNativeOutput(state);

      const syntheticEnd = toolEvents.find((e) => e.id === 'provisional-tool' && e.status !== 'running');
      expect(syntheticEnd).toMatchObject({
        id: 'provisional-tool',
        status: 'complete',
        terminalStatus: 'abandoned',
        terminalReason: 'generation_rollover',
        terminalSynthetic: true,
        terminalSource: 'provider_snapshot',
      });

      await vi.waitFor(async () => expect((await requests()).filter((r) => r.method === 'session/prompt')).toHaveLength(2), { timeout: 5000 });
      await appendFile(
        nativeLogFile,
        JSON.stringify({ step_index: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'queued during provisional' }) + '\n'
        + JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'NATIVE DRAINED ON ROLLOVER' }) + '\n',
      );
      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });
      expect(completed[1]?.content).toBe('NATIVE DRAINED ON ROLLOVER');

      expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
        activeWorkCount: 0,
        backgroundWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });
      expect(runtime.getActivitySnapshot()).toMatchObject({
        blockingWorkCount: 0,
        backgroundWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });
      expect(runtime.getStatus()).toBe('idle');

      // Late explicit non-terminal frames (tool_call_update in_progress / pending, delayed tool_call re-entry,
      // and unowned orphan in_progress update) must NOT reopen state.toolCalls or Runtime._openTools.
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'provisional-tool',
          status: 'in_progress',
        },
      });
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'provisional-tool',
          status: 'pending',
        },
      });
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'provisional-tool',
          title: 'Bash',
          status: 'in_progress',
        },
      });
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'orphan-nonterminal-tool',
          title: 'Bash',
          status: 'in_progress',
        },
      });

      expect(state.promptInFlight).toBe(false);
      expect(state.toolCalls.size).toBe(0);
      expect(runtime.getActivitySnapshot()).toMatchObject({
        blockingWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });
      expect(runtime.getStatus()).toBe('idle');

      // Plain-text active append dispatches immediately without sticking in queue.
      expect(runtime.send('plain append after handoff', 'handoff-plain-1', undefined, undefined, {
        deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      })).toBe('sent');
      await vi.waitFor(async () => expect((await requests()).filter((r) => r.method === 'session/prompt')).toHaveLength(3), { timeout: 5000 });
      await appendFile(
        nativeLogFile,
        JSON.stringify({ step_index: 4, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'plain append after handoff' }) + '\n'
        + JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'NATIVE AFTER HANDOFF' }) + '\n',
      );
      await vi.waitFor(() => expect(completed).toHaveLength(3), { timeout: 5000 });
      expect(completed[2]?.content).toBe('NATIVE AFTER HANDOFF');
      expect(runtime.pendingEntries).toEqual([]);
      expect(runtime.getStatus()).toBe('idle');
    } finally {
      await runtime.kill();
    }
  });

  it('retires open tools on non-turn-completion cancel(!promptInFlight) across provider and runtime while preserving real active-turn & background gates', async () => {
    resetTransportQueueStoreForTests();
    const { provider } = await setup();
    const id = 'deck_test_agy_non_turn_cancel_and_controls';
    const completed: Array<{ content: string }> = [];
    const runtime = new TransportSessionRuntime(provider, id);
    provider.onComplete((sid, msg) => { if (sid === id) completed.push({ content: msg.content }); });
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    try {
      expect(runtime.send('warm', 'warm-rt-2')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;

      // Mark foreground authoritative and inject an unowned idle running tool (no promptInFlight).
      (state.agyForeground ??= {} as any).authoritative = true;
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'idle-open-tool',
          title: 'Read',
          status: 'in_progress',
        },
      });
      expect(state.promptInFlight).toBe(false);
      expect(runtime.getActivitySnapshot().busyReasons).toContain('open_tool_call');

      // Cancelling while !promptInFlight must close Runtime._openTools and suppress late reopening.
      await provider.cancel(id);
      expect(runtime.getActivitySnapshot()).toMatchObject({
        blockingWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });

      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'idle-open-tool',
          status: 'in_progress',
        },
      });
      expect(state.toolCalls.size).toBe(0);
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);

      // clearSessionWorkAfterFailure while !promptInFlight also closes Runtime._openTools and retires IDs.
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'failure-open-tool',
          title: 'Bash',
          status: 'in_progress',
        },
      });
      expect(runtime.getActivitySnapshot().busyReasons).toContain('open_tool_call');
      (provider as any).clearSessionWorkAfterFailure(id, state);
      expect(runtime.getActivitySnapshot()).toMatchObject({
        blockingWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      });
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'failure-open-tool',
          status: 'in_progress',
        },
      });
      expect(state.toolCalls.size).toBe(0);
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);

      // Positive control 1: genuine active turn + open tool preserves blocking telemetry.
      (state.agyForeground as any).authoritative = false;
      expect(runtime.send('real turn', 'real-turn-1')).toBe('sent');
      await vi.waitFor(() => expect(state.promptInFlight || completed.length >= 2).toBe(true), { timeout: 5000 });
      if (state.promptInFlight) {
        (provider as any).handleSessionUpdate({
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'real-active-tool',
            title: 'Edit',
            status: 'in_progress',
          },
        });
        expect(runtime.getActivitySnapshot().blockingWorkCount).toBeGreaterThan(0);
        expect(provider.getActiveWorkSnapshot(id)?.activeToolCount).toBe(1);
        (provider as any).handleSessionUpdate({
          sessionId: nativeId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'real-active-tool',
            status: 'completed',
          },
        });
      }
      await vi.waitFor(() => expect(completed).toHaveLength(2), { timeout: 5000 });

      // Positive control 2: background_monitor stays non-blocking on provider/runtime while turn is idle.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/task-bg-ctrl`,
        toolName: 'run_command',
      });
      expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
        activeWorkCount: 1,
        backgroundWorkCount: 1,
        activeToolCount: 0,
        busyReasons: ['background_monitor'],
      });
      expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);
    } finally {
      await runtime.kill();
    }
  });

  it('isolates per-session ACP processes so busy or crashing siblings never block or disconnect other sessions', async () => {
    const { provider, root, requests } = await setup();
    const log = path.join(root, 'rpc.jsonl');
    const holdFile = log + '.hold';
    const complete = vi.fn();
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onError(errors);

    const idA = await route(provider, 'deck_test_iso_a');
    await writeFile(holdFile, 'hold');
    try {
      await provider.send(idA, 'A_HELD');
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(idA)?.promptInFlight).toBe(true), { timeout: 5000 });
      const pidA = (provider as any).sessions.get(idA)?.isolatedTransport?.child?.pid;
      expect(pidA).toBeTypeOf('number');

      // Busy sibling A does not block starting and running sibling B in its own process.
      await unlink(holdFile);
      const idB = await route(provider, 'deck_sub_iso_b');
      await provider.send(idB, 'B_DONE');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
      const pidB = (provider as any).sessions.get(idB)?.isolatedTransport?.child?.pid;
      expect(pidB).toBeTypeOf('number');
      expect(pidB).not.toBe(pidA);
      expect((provider as any).child).toBeNull();

      // Crashing sibling B emits CONNECTION_LOST only for B while keeping A intact and loaded.
      const childB = (provider as any).sessions.get(idB)?.isolatedTransport?.child;
      childB.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errors.mock.calls.filter(([sid]) => sid === idA)).toHaveLength(0);
      expect((provider as any).sessions.get(idA)?.loaded).toBe(true);
      expect((provider as any).sessions.get(idA)?.isolatedTransport?.child?.pid).toBe(pidA);
      expect((provider as any).sessions.get(idB)?.acpSessionId).toBeTruthy();

      const boots = (await requests()).filter((r) => r.fixture === 'boot');
      expect(boots.length).toBeGreaterThanOrEqual(2);
    } finally {
      await unlink(holdFile).catch(() => {});
    }
  });

  it('recovers per-session ACP binary replacements on disk and bounds worker-spawn ENOENT retries without affecting siblings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-test-agy-per-upgrade-'));
    const binary = path.join(root, 'agy');
    const staging = path.join(root, 'agy.next');
    const fixture = path.resolve('test/fixtures/agy-acp.mjs');
    const log = path.join(root, 'rpc.jsonl');
    const holdFile = log + '.hold';
    const writeBinary = (target: string, version: string) => writeFile(
      target,
      `#!/bin/sh\nAGY_ACP_FIXTURE_VERSION='${version}' exec '${process.execPath}' '${fixture}' "$@"\n`,
      { mode: 0o700 },
    );

    await writeBinary(binary, '1.5.8');
    vi.stubEnv(AGY_CLI_PATH_ENV, binary);
    const config = {
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin',
        AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME,
        AGY_ACP_FIXTURE_LOG: log,
      },
    };
    const provider = await createAgyProvider(config) as AgyAcpProvider;
    resources.push({ provider, root });
    await provider.connect(config);

    const complete = vi.fn();
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onError(errors);

    const idBusy = await route(provider, 'deck_test_upgrade_busy');
    await writeFile(holdFile, 'hold');
    try {
      await provider.send(idBusy, 'BUSY_1');
      await vi.waitFor(() => expect(provider.getSessionDiagnostics(idBusy)?.promptInFlight).toBe(true), { timeout: 5000 });
      const busyPid = (provider as any).sessions.get(idBusy)?.isolatedTransport?.child?.pid;

      const idOther = await route(provider, 'deck_sub_upgrade_other');
      await unlink(holdFile);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
      await provider.send(idOther, 'OTHER_V1');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

      // Replace binary on disk while idBusy and idOther exist.
      await writeBinary(staging, '1.5.9');
      await rename(staging, binary);

      // Next send on idOther detects binary change on its per-session process and resumes on 1.5.9 without touching idBusy.
      await provider.send(idOther, 'OTHER_V2');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });
      expect((provider as any).sessions.get(idBusy)?.isolatedTransport?.child?.pid).toBe(busyPid);

      // Worker-spawn ENOENT retries once per session (and is bounded when persistent), privacy-safe without recovery hint.
      const beforeNativeSessionStart = vi.fn(async () => {});
      const idRetry = await route(provider, 'deck_sub_reactive_new', { beforeNativeSessionStart });
      await writeFile(log + '.worker-enoent', '1');
      await writeFile(log + '.worker-enoent-clear-on-init', '1');
      await provider.send(idRetry, 'RETRY_ONCE_OK');
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(4), { timeout: 5000 });
      expect(beforeNativeSessionStart).toHaveBeenCalledTimes(1);

      const idFail = await route(provider, 'deck_sub_reactive_bounded');
      await writeFile(log + '.worker-enoent', '1');
      let thrown: any;
      try {
        await provider.send(idFail, 'SHOULD_FAIL_AFTER_ONE_RETRY');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: PROVIDER_ERROR_CODES.CONNECTION_LOST, recoverable: true });
      expect(thrown.message).not.toContain('/secret/private/path');
      expect(thrown.message).not.toContain(AGY_NATIVE_START_RECOVERY_HINT);
      expect(errors).toHaveBeenCalledTimes(1);

      const rows = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows.some(r => r.fixture === 'boot' && r.version === '1.5.9')).toBe(true);
      expect(rows.some(r => r.method === 'session/resume')).toBe(true);
    } finally {
      await unlink(holdFile).catch(() => {});
      await unlink(log + '.worker-enoent').catch(() => {});
      await unlink(log + '.worker-enoent-clear-on-init').catch(() => {});
    }
  });

  it('hibernates idle per-session ACP processes after TTL and resumes seamlessly on next send', async () => {
    vi.stubEnv('IMCODES_AGY_IDLE_HIBERNATE_MS', '120');
    const { provider, requests } = await setup();
    const complete = vi.fn();
    const errors = vi.fn();
    provider.onComplete(complete);
    provider.onError(errors);

    const id = await route(provider, 'deck_sub_idle_hib');
    await provider.send(id, 'TURN_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const state = (provider as any).sessions.get(id);
    const pid1 = state.isolatedTransport?.child?.pid;
    const acpId = state.acpSessionId;
    expect(pid1).toBeTypeOf('number');
    expect(acpId).toBeTruthy();

    await vi.waitFor(() => {
      expect(state.isolatedTransport).toBeUndefined();
      expect(state.loaded).toBe(false);
    }, { timeout: 5000 });
    expect(state.acpSessionId).toBe(acpId);
    expect(errors).not.toHaveBeenCalled();

    // Waking the hibernated session spawns a fresh process and calls session/resume.
    await provider.send(id, 'TURN_2');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(state.isolatedTransport?.child?.pid).toBeTypeOf('number');
    expect(state.isolatedTransport?.child?.pid).not.toBe(pid1);
    const resumes = (await requests()).filter((r) => r.method === 'session/resume' && r.params?.sessionId === acpId);
    expect(resumes).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('evicts oldest idle sub-sessions before main sessions when warm cap is reached without blocking busy sessions', async () => {
    vi.stubEnv('IMCODES_AGY_MAX_WARM_SESSIONS', '2');
    vi.stubEnv('IMCODES_AGY_IDLE_HIBERNATE_MS', '60000');
    const { provider, root, requests } = await setup();
    const log = path.join(root, 'rpc.jsonl');
    const holdFile = log + '.hold';
    const complete = vi.fn();
    provider.onComplete(complete);

    const mainId = await route(provider, 'deck_proj_main');
    await provider.send(mainId, 'MAIN_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const sub1 = await route(provider, 'deck_sub_lru_1');
    await provider.send(sub1, 'SUB1_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    // Spawning sub2 hits cap=2 -> evicts idle sub1 BEFORE mainId even though mainId is older.
    const sub2 = await route(provider, 'deck_sub_lru_2');
    await provider.send(sub2, 'SUB2_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });

    expect((provider as any).sessions.get(mainId)?.isolatedTransport).toBeDefined();
    expect((provider as any).sessions.get(sub2)?.isolatedTransport).toBeDefined();
    expect((provider as any).sessions.get(sub1)?.isolatedTransport).toBeUndefined();
    expect((provider as any).sessions.get(sub1)?.loaded).toBe(false);
    const sub1AcpId = (provider as any).sessions.get(sub1)?.acpSessionId;

    // Resuming evicted sub1 succeeds transparently.
    await provider.send(sub1, 'SUB1_RESUMED');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(4), { timeout: 5000 });
    expect((await requests()).some((r) => r.method === 'session/resume' && r.params?.sessionId === sub1AcpId)).toBe(true);

    // Even when all warm sessions are busy, spawning another session is never blocked.
    await writeFile(holdFile, 'hold');
    try {
      await provider.send(mainId, 'BUSY_MAIN');
      await provider.send(sub1, 'BUSY_SUB1');
      const sub3 = await route(provider, 'deck_sub_busy_3');
      await provider.send(sub3, 'BUSY_SUB3');
      await unlink(holdFile);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(7), { timeout: 5000 });
    } finally {
      await unlink(holdFile).catch(() => {});
    }
  });

  it('keeps incognito sessions non-resumable and excluded from idle hibernation and warm-cap eviction', async () => {
    vi.stubEnv('IMCODES_AGY_MAX_WARM_SESSIONS', '1');
    vi.stubEnv('IMCODES_AGY_IDLE_HIBERNATE_MS', '80');
    const { provider } = await setup();
    const complete = vi.fn();
    provider.onComplete(complete);

    const idIncog = await route(provider, 'deck_test_incog_per', { incognito: true });
    await provider.send(idIncog, 'INCOG_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const incogPid = (provider as any).sessions.get(idIncog)?.isolatedTransport?.child?.pid;
    expect(incogPid).toBeTypeOf('number');

    // Wait past idle TTL AND spawn a regular session exceeding cap=1: incognito stays alive.
    await new Promise((resolve) => setTimeout(resolve, 140));
    const idSub = await route(provider, 'deck_sub_regular');
    await provider.send(idSub, 'REG_1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    const incogState = (provider as any).sessions.get(idIncog);
    expect(incogState?.loaded).toBe(true);
    expect(incogState?.isolatedTransport?.child?.pid).toBe(incogPid);

    await provider.endSession(idIncog);
    expect(incogState?.disposed).toBe(true);
  });
});

describe('AG ACP _meta.antigravity.systemPrompt.append delivery', () => {
  it('delivers sessionSystemText via session/new _meta, omits it from session/prompt and /compact, and never logs identity text', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const debugSpy = vi.spyOn(logger, 'debug');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const { provider, requests } = await setup('usage-missing', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
      const id = await route(provider);
      const complete = vi.fn();
      provider.onComplete(complete);

      const identityPayload = '<imcodes-agent-identity>\nSECRET_META_IDENTITY_TOKEN_991\n' + 'padding '.repeat(80) + '</imcodes-agent-identity>';
      const makePayload = (msg: string) => {
        const p = normalizeProviderPayload(msg);
        p.sessionSystemText = identityPayload;
        p.context = { ...p.context, sessionSystemText: identityPayload };
        return p;
      };

      await provider.send(id, makePayload('A'));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(complete.mock.calls[0]?.[1]?.metadata?.usage).toMatchObject({ context_usage_estimated: true });
      expect(Number(complete.mock.calls[0]?.[1]?.metadata?.usage?.input_tokens)).toBeGreaterThan(50);

      await provider.send(id, makePayload('/compact'));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

      await provider.send(id, makePayload('after compact'));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });

      const reqs = await requests();
      const newReq = reqs.find((x) => x.method === 'session/new');
      expect(newReq?.params?._meta).toEqual({
        antigravity: { systemPrompt: { append: identityPayload } },
      });
      expect(reqs.filter((x) => x.method === 'session/resume')).toHaveLength(0);

      const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
      expect(prompts).toEqual(['A', '/compact', 'after compact']);
      for (const promptText of prompts) {
        expect(promptText).not.toContain('<imcodes-agent-identity>');
        expect(promptText).not.toContain('SECRET_META_IDENTITY_TOKEN_991');
      }

      for (const spy of [infoSpy, debugSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('SECRET_META_IDENTITY_TOKEN_991');
        }
      }
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('delivers sessionSystemText via session/resume _meta on reconnect and keeps session/prompt clean', async () => {
    const { provider, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = await route(provider, 'deck_test_meta_resume', { resumeId: 'saved-meta-1' });
    const complete = vi.fn();
    provider.onComplete(complete);

    const identityPayload = '<imcodes-agent-identity>RESUMED_IDENTITY_77</imcodes-agent-identity>';
    const p = normalizeProviderPayload('resumed hello');
    p.sessionSystemText = identityPayload;
    p.context = { ...p.context, sessionSystemText: identityPayload };

    await provider.send(id, p);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const reqs = await requests();
    const resumeReq = reqs.find((x) => x.method === 'session/resume');
    expect(resumeReq?.params?.sessionId).toBe('saved-meta-1');
    expect(resumeReq?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: identityPayload } },
    });
    const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts).toEqual(['resumed hello']);
  });

  it('refreshes, updates, and clears mid-session identity via session/resume _meta without leaking into session/prompt', async () => {
    const { provider, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = await route(provider, 'deck_test_meta_mid_refresh');
    const complete = vi.fn();
    provider.onComplete(complete);

    const makePayload = (msg: string, sys?: string) => {
      const p = normalizeProviderPayload(msg);
      p.sessionSystemText = sys;
      p.context = { ...p.context, sessionSystemText: sys };
      return p;
    };

    const id1 = '<imcodes-agent-identity>IDENTITY_V1</imcodes-agent-identity>';
    const id2 = '<imcodes-agent-identity>IDENTITY_V2</imcodes-agent-identity>';

    await provider.send(id, makePayload('turn-1', id1));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    provider.refreshSessionSystemText(id);
    await provider.send(id, makePayload('turn-2-refresh', id1));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    await provider.send(id, makePayload('turn-3-update', id2));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });

    await provider.send(id, makePayload('turn-4-clear', ''));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(4), { timeout: 5000 });

    await provider.send(id, makePayload('turn-5-still-empty', ''));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(5), { timeout: 5000 });

    const reqs = await requests();
    const newReq = reqs.find((x) => x.method === 'session/new');
    expect(newReq?.params?._meta).toEqual({ antigravity: { systemPrompt: { append: id1 } } });

    const resumes = reqs.filter((x) => x.method === 'session/resume');
    expect(resumes.map((r) => r.params?._meta?.antigravity?.systemPrompt?.append)).toEqual([id1, id2, '']);

    const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts).toEqual(['turn-1', 'turn-2-refresh', 'turn-3-update', 'turn-4-clear', 'turn-5-still-empty']);
  });

  it('omits _meta when sessionSystemText is initially empty and guards incognito from session/resume', async () => {
    const { provider, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = await route(provider, 'deck_test_meta_empty');
    const complete = vi.fn();
    provider.onComplete(complete);

    await provider.send(id, 'empty-1');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await provider.send(id, 'empty-2');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    const incogId = await route(provider, 'deck_test_meta_incog', { incognito: true });
    const incogP1 = normalizeProviderPayload('incog-1');
    incogP1.sessionSystemText = '<imcodes-agent-identity>INCOG_V1</imcodes-agent-identity>';
    incogP1.context = { ...incogP1.context, sessionSystemText: incogP1.sessionSystemText };
    await provider.send(incogId, incogP1);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3), { timeout: 5000 });

    const incogP2 = normalizeProviderPayload('incog-2');
    incogP2.sessionSystemText = '<imcodes-agent-identity>INCOG_V2</imcodes-agent-identity>';
    incogP2.context = { ...incogP2.context, sessionSystemText: incogP2.sessionSystemText };
    await provider.send(incogId, incogP2);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(4), { timeout: 5000 });

    const reqs = await requests();
    const newReqs = reqs.filter((x) => x.method === 'session/new');
    expect(newReqs[0]?.params?._meta).toBeUndefined();
    expect(newReqs[1]?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: '<imcodes-agent-identity>INCOG_V1</imcodes-agent-identity>' } },
    });
    expect(reqs.filter((x) => x.method === 'session/resume')).toHaveLength(0);

    const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts[0]).toBe('empty-1');
    expect(prompts[1]).toBe('empty-2');
    expect(prompts[2]).toBe('incog-1');
    expect(prompts[3]).toContain('INCOG_V2');
  });

  it('matches AgyForegroundOwnership cleanly against promptText without sessionSystemText', async () => {
    const { provider, requests } = await setup('native-steering', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = await route(provider, 'deck_test_meta_foreground');
    const complete = vi.fn();
    provider.onComplete(complete);

    const p = normalizeProviderPayload('CLEAN_FOREGROUND_A');
    p.sessionSystemText = '<imcodes-agent-identity>FOREGROUND_IDENTITY</imcodes-agent-identity>';
    p.context = { ...p.context, sessionSystemText: p.sessionSystemText };

    await provider.send(id, p);
    await provider.notifyActiveDelegation(id, notification('CLEAN_FOREGROUND_B'));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(complete.mock.calls[0]?.[1]?.content).toBe('STEERED OWNED RESULT');

    const prompts = (await requests()).filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts).toEqual(['CLEAN_FOREGROUND_A', 'CLEAN_FOREGROUND_B']);
  });

  it('re-confirms target model across syncMetaOnLoaded session/resume after system-prompt refresh or /model switch without reverting to gemini-4-carbon-medium', async () => {
    const { provider, requests } = await setup('upstream-carbon-default', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = 'deck_test_agy_resume_meta_reconfirm';
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd(), fresh: true });
    const emittedModels: string[] = [];
    const done = vi.fn();
    provider.onSessionInfo((sid, info) => {
      if (sid === id && info.model) emittedModels.push(info.model);
    });
    provider.onComplete(done);

    const makePayload = (msg: string, sys: string) => {
      const p = normalizeProviderPayload(msg);
      p.sessionSystemText = sys;
      p.context = { ...p.context, sessionSystemText: sys };
      return p;
    };

    const sys1 = '<imcodes-agent-identity>ID_V1</imcodes-agent-identity>';
    const sys2 = '<imcodes-agent-identity>ID_V2</imcodes-agent-identity>';

    // Turn 1: initial session/new confirms default gemini-4-hydrogen-high over upstream carbon-medium.
    await provider.send(id, makePayload('turn-1', sys1));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // Turn 2: refreshSessionSystemText / updated system prompt triggers syncMetaOnLoaded session/resume
    // while state.model and state.modelRevision are unchanged.
    provider.refreshSessionSystemText(id);
    await provider.send(id, makePayload('turn-2', sys2));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // Turn 3: /model switch (applySessionModel + refreshSessionSystemText, matching TransportSessionRuntime.applyAgentId)
    // followed by next turn triggering syncMetaOnLoaded session/resume.
    expect(await provider.applySessionModel(id, 'gemini-4-argon-high')).toBe(SESSION_MODEL_APPLIED.LIVE);
    provider.refreshSessionSystemText(id);
    await provider.send(id, makePayload('turn-3', sys2));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(done.mock.calls[2]?.[1].metadata.model).toBe('gemini-4-argon-high');

    expect(emittedModels).not.toContain('gemini-4-carbon-medium');

    const reqs = await requests();
    expect(reqs.filter((r) => r.method === 'session/resume')).toHaveLength(2);
    expect(reqs.filter((r) => r.method === 'session/set_model').map((r) => r.params.modelId)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
      'gemini-4-argon-high',
      'gemini-4-argon-high',
    ]);
    expect(reqs.filter((r) => r.fixture === 'completed-model').map((r) => r.model)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
      'gemini-4-argon-high',
    ]);
  });

  it('re-issues session/set_model on same-model applySessionModel when confirmedModel drifted to gemini-4-carbon-medium', async () => {
    const { provider, requests } = await setup('upstream-carbon-default', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = 'deck_test_agy_same_model_self_heal';
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd(), fresh: true });
    const emittedModels: string[] = [];
    const done = vi.fn();
    provider.onSessionInfo((sid, info) => {
      if (sid === id && info.model) emittedModels.push(info.model);
    });
    provider.onComplete(done);

    await provider.send(id, 'turn-1');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const state = (provider as any).sessions.get(id);
    const conn = (provider as any).connectionForState(state);
    // Simulate upstream session/resume resetting native model and confirmedModel to carbon-medium
    // while state.model remains gemini-4-hydrogen-high and state.modelRevision is unchanged.
    await (provider as any).resumeOrLoadAcpSession(id, state, conn, 'RESUMED_META');
    expect(state.model).toBe('gemini-4-hydrogen-high');
    expect(state.confirmedModel).toBe('gemini-4-carbon-medium');

    expect(await provider.applySessionModel(id, 'gemini-4-hydrogen-high')).toBe(SESSION_MODEL_APPLIED.LIVE);
    expect(state.confirmedModel).toBe('gemini-4-hydrogen-high');

    await provider.send(id, 'turn-2');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');
    expect(emittedModels).not.toContain('gemini-4-carbon-medium');

    const reqs = await requests();
    expect(reqs.filter((r) => r.method === 'session/set_model').map((r) => r.params.modelId)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
    ]);
    expect(reqs.filter((r) => r.fixture === 'completed-model').map((r) => r.model)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
    ]);
  });

  it('re-confirms target model after disposeIsolatedSession idle hibernate wakeup and child exit respawn', async () => {
    const { provider, requests } = await setup('upstream-carbon-default', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = 'deck_test_agy_hibernate_reconfirm';
    await provider.createSession({
      sessionKey: id,
      sessionName: id,
      cwd: process.cwd(),
      agentId: 'gemini-4-argon-high',
      fresh: true,
    });
    const emittedModels: string[] = [];
    const done = vi.fn();
    provider.onSessionInfo((sid, info) => {
      if (sid === id && info.model) emittedModels.push(info.model);
    });
    provider.onComplete(done);

    await provider.send(id, 'before-hibernate');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0]?.[1].metadata.model).toBe('gemini-4-argon-high');

    const state = (provider as any).sessions.get(id);
    const savedNativeId = state.acpSessionId;
    await (provider as any).disposeIsolatedSession(state, { bestEffortCloseSession: true, preserveResumeId: true });
    expect(state.loaded).toBe(false);
    expect(state.confirmedModel).toBeUndefined();
    expect(state.modelApplyRequest).toBeUndefined();
    expect(state.acpSessionId).toBe(savedNativeId);

    await provider.send(id, 'after-hibernate');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-argon-high');

    // Also verify unexpected child process exit clears confirmedModel & modelApplyRequest and re-confirms on next turn.
    const child = state.isolatedTransport?.child as import('node:child_process').ChildProcess | null;
    expect(child).toBeTruthy();
    child!.kill('SIGKILL');
    await vi.waitFor(() => expect(state.loaded).toBe(false), { timeout: 5000 });
    expect(state.confirmedModel).toBeUndefined();
    expect(state.modelApplyRequest).toBeUndefined();

    await provider.send(id, 'after-child-crash');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(done.mock.calls[2]?.[1].metadata.model).toBe('gemini-4-argon-high');
    expect(emittedModels).not.toContain('gemini-4-carbon-medium');

    const reqs = await requests();
    expect(reqs.filter((r) => r.method === 'session/set_model').map((r) => r.params.modelId)).toEqual([
      'gemini-4-argon-high',
      'gemini-4-argon-high',
      'gemini-4-argon-high',
    ]);
    expect(reqs.filter((r) => r.fixture === 'completed-model').map((r) => r.model)).toEqual([
      'gemini-4-argon-high',
      'gemini-4-argon-high',
      'gemini-4-argon-high',
    ]);
  });

  it('re-confirms model when LoadSessionResponse omits models ({}), createSession rebinds, or recycleSharedAcpServer recycles, while deduplicating concurrent in-flight confirmStrictSessionModel', async () => {
    const { provider, requests, root, binary } = await setup('resume-empty-metadata', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const id = 'deck_test_agy_empty_resume_and_inflight';
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd(), fresh: true });
    const done = vi.fn();
    provider.onComplete(done);

    const makePayload = (msg: string, sys: string) => {
      const p = normalizeProviderPayload(msg);
      p.sessionSystemText = sys;
      p.context = { ...p.context, sessionSystemText: sys };
      return p;
    };

    await provider.send(id, makePayload('turn-1', '<imcodes-agent-identity>META_1</imcodes-agent-identity>'));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(done.mock.calls[0]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // session/resume returns {} (missing models.currentModelId): must reset confirmedModel to undefined and re-send session/set_model.
    provider.refreshSessionSystemText(id);
    await provider.send(id, makePayload('turn-2', '<imcodes-agent-identity>META_2</imcodes-agent-identity>'));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(done.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // Re-calling createSession without fresh:true creates loaded:false state and must not inherit stale confirmedModel.
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd() });
    const reboundState = (provider as any).sessions.get(id);
    expect(reboundState.loaded).toBe(false);
    expect(reboundState.confirmedModel).toBeUndefined();
    expect(reboundState.modelApplyRequest).toBeUndefined();

    await provider.send(id, makePayload('turn-3', '<imcodes-agent-identity>META_2</imcodes-agent-identity>'));
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(done.mock.calls[2]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');

    // Concurrent in-flight deduplication: two simultaneous applySessionModel calls while RPC is held share 1 RPC.
    const modelHold = path.join(root, 'rpc.jsonl.model-hold');
    await writeFile(modelHold, 'hold');
    try {
      const first = provider.applySessionModel(id, 'gemini-4-argon-high');
      await vi.waitFor(async () => {
        const argonCalls = (await requests()).filter((r) => r.method === 'session/set_model' && r.params.modelId === 'gemini-4-argon-high');
        expect(argonCalls).toHaveLength(1);
      }, { timeout: 5000 });
      const second = provider.applySessionModel(id, 'gemini-4-argon-high');
      await rm(modelHold, { force: true });
      expect(await Promise.all([first, second])).toEqual([SESSION_MODEL_APPLIED.LIVE, SESSION_MODEL_APPLIED.LIVE]);
    } finally {
      await rm(modelHold, { force: true });
    }

    const reqs = await requests();
    expect(reqs.filter((r) => r.method === 'session/set_model').map((r) => r.params.modelId)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
      'gemini-4-argon-high',
    ]);
    expect(reqs.filter((r) => r.fixture === 'completed-model').map((r) => r.model)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
    ]);

    // Shared ACP server recycle path: clears confirmedModel & modelApplyRequest and re-confirms on next turn.
    const sharedLog = path.join(root, 'shared-rpc.jsonl');
    const sharedProvider = new AgyAcpProvider();
    (sharedProvider as any).profile = { ...(sharedProvider as any).profile, perSessionTransport: false };
    resources.push({ provider: sharedProvider, root });
    await sharedProvider.connect({
      binaryPath: binary,
      env: {
        HOME: root,
        AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME,
        AGY_ACP_FIXTURE_LOG: sharedLog,
        AGY_ACP_FIXTURE_SCENARIO: 'upstream-carbon-default',
      },
    });
    const sharedId = 'deck_test_agy_shared_recycle';
    const sharedDone = vi.fn();
    sharedProvider.onComplete(sharedDone);
    await sharedProvider.createSession({ sessionKey: sharedId, sessionName: sharedId, cwd: process.cwd(), fresh: true });
    await sharedProvider.send(sharedId, 'shared-1');
    await vi.waitFor(() => expect(sharedDone).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const sharedState = (sharedProvider as any).sessions.get(sharedId);
    await (sharedProvider as any).recycleSharedAcpServer('test_recycle');
    expect(sharedState.loaded).toBe(false);
    expect(sharedState.confirmedModel).toBeUndefined();
    expect(sharedState.modelApplyRequest).toBeUndefined();

    await sharedProvider.send(sharedId, 'shared-2');
    await vi.waitFor(() => expect(sharedDone).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(sharedDone.mock.calls[1]?.[1].metadata.model).toBe('gemini-4-hydrogen-high');
    const sharedReqs = (await readFile(sharedLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(sharedReqs.filter((r) => r.method === 'session/set_model').map((r) => r.params.modelId)).toEqual([
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-high',
    ]);
  });

  it('keeps AG reactive/native-output long tasks non-idle across multi-step tool calls, protects active long native turns from silent recovery, and returns to idle cleanly', async () => {
    const { provider, root } = await setup('native-child-log');
    const id = 'deck_test_agy_reactive_native_long';
    const runtime = new TransportSessionRuntime(provider, id);
    await provider.createSession({ sessionKey: id, sessionName: id, cwd: process.cwd(), fresh: true });
    runtime.setProviderSessionId(id);

    const done = vi.fn();
    provider.onComplete(done);
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });
    expect(runtime.send('launch', 'turn-1')).toBe('sent');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });

    const state = (provider as any).sessions.get(id);
    const nativeId = state.acpSessionId as string;
    const file = path.join(root, '.gemini/antigravity-cli/brain', nativeId, '.system_generated/logs/transcript_full.jsonl');

    // 1) Reactive [Message] wakeup sets agyReactive and stays non-idle even across useAgyNativeOutput and native tool steps.
    await appendFile(
      file,
      JSON.stringify({
        step_index: 50,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '[Message] timestamp=2026-11-16T00:00:00Z sender=worker-a content=wake parent',
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(state.agyReactive).toBe(true);
      expect(runtime.getStatus()).not.toBe('idle');
    }, { timeout: 5000 });
    expect(runtime.getActivitySnapshot().backgroundKeepsSessionRunning).toBe(true);
    expect(runtime.getActivitySnapshot().blockingWorkCount).toBe(0);

    (provider as any).useAgyNativeOutput(state);
    expect(runtime.getStatus()).not.toBe('idle');

    const prevActivityAt = state.lastActivityAt;
    await appendFile(
      file,
      JSON.stringify({
        step_index: 51,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', WaitMsBeforeAsync: 5000 } }],
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(state.agyNativeToolOrder?.length).toBeGreaterThan(0);
    }, { timeout: 5000 });
    expect(state.lastActivityAt).toBeGreaterThanOrEqual(prevActivityAt);
    expect(runtime.getStatus()).not.toBe('idle');

    // Empty final non-tool-call PLANNER_RESPONSE settles reactive turn cleanly back to idle.
    await appendFile(
      file,
      JSON.stringify({
        step_index: 52,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(state.agyReactive).toBe(false);
      expect(runtime.getStatus()).toBe('idle');
    }, { timeout: 5000 });

    // 2) cancel() during reactive turn clears agyReactive and settles to idle.
    await appendFile(
      file,
      JSON.stringify({
        step_index: 53,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '[Message] timestamp=2026-11-16T00:01:00Z sender=worker-b content=wake again',
      }) + '\n',
    );
    await vi.waitFor(() => expect(state.agyReactive).toBe(true), { timeout: 5000 });
    await provider.cancel(id);
    expect(state.agyReactive).toBe(false);
    expect(runtime.getStatus()).toBe('idle');

    // 3) During an in-flight native turn with active native tool calls, getActiveWorkSnapshot reports activeToolCount > 0
    // and recoverSilentActiveTurn does not falsely settle the active long native turn at the short threshold.
    state.promptInFlight = true;
    state.agyReactive = true;
    state.agyNativeToolOrder = [{ name: 'run_command', interactive: false }];
    (runtime as any).setStatus('tool_running');
    expect(provider.getActiveWorkSnapshot(id)?.activeToolCount).toBeGreaterThan(0);
    expect(runtime.recoverSilentActiveTurn({ nowMs: Date.now() + 10_000, staleMs: 5_000 })).toBe(false);
    expect(runtime.getStatus()).toBe('tool_running');
    state.agyNativeToolOrder = [];
    state.promptInFlight = false;
    state.agyReactive = false;
    (provider as any).syncAgyStatusAfterTurn(id, state);
    expect(runtime.getStatus()).toBe('idle');
    await runtime.kill();
  });

  it('ignores IsDaemon run_command background ids, reconciles empty manage_task(list), and ignores errored manage_task(list)', async () => {
    const { provider } = await setup();
    const id = 'deck_test_agy_daemon_and_list';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: Array<{ content: string }> = [];
    provider.onComplete((sid, m) => { if (sid === id) completed.push({ content: m.content }); });

    try {
      expect(runtime.send('warm', 'warm-daemon')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;

      // IsDaemon: true must NOT enter agyBackgroundTasks or hold runtime running.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/daemon-1`,
        toolName: 'run_command',
        toolInput: { CommandLine: 'npm run dev', IsDaemon: true, WaitMsBeforeAsync: 500 },
        toolStatus: 'complete',
      });
      expect(state.agyBackgroundTasks?.size ?? 0).toBe(0);
      expect(provider.getActiveWorkSnapshot(id)?.backgroundWorkCount).toBe(0);
      expect(runtime.getStatus()).toBe('idle');

      // Non-daemon background task holds runtime tool_running.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/stale-bg-1`,
        toolName: 'run_command',
        toolInput: { CommandLine: 'sleep 30', WaitMsBeforeAsync: 500 },
        toolStatus: 'running',
      });
      expect(runtime.getStatus()).toBe('tool_running');

      // Errored manage_task(list) must NOT clear agyBackgroundTasks.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: 'No running tasks',
        toolName: 'manage_task',
        toolInput: { Action: 'list' },
        toolStatus: 'error',
      });
      expect(state.agyBackgroundTasks?.has(`${nativeId}/stale-bg-1`)).toBe(true);
      expect(runtime.getStatus()).toBe('tool_running');

      // Successful empty manage_task(list) reconciles stale ids and drops cleanly back to idle.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: 'No running tasks.',
        toolName: 'manage_task',
        toolInput: { Action: 'list' },
        toolStatus: 'complete',
      });
      expect(state.agyBackgroundTasks?.size ?? 0).toBe(0);
      expect(provider.getActiveWorkSnapshot(id)?.backgroundWorkCount).toBe(0);
      expect(runtime.getStatus()).toBe('idle');
    } finally {
      await runtime.kill();
    }
  });

  it('handles child transcript RUNNING guard, empty-content terminal, SYSTEM_ERROR, and ACP failure subagent interrupt + idle cleanup', async () => {
    const { provider } = await setup();
    const id = 'deck_test_agy_child_errors_and_crash';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: Array<{ content: string }> = [];
    const events: ToolCallEvent[] = [];
    provider.onComplete((sid, msg) => { if (sid === id) completed.push({ content: msg.content }); });
    provider.onToolCall((sid, evt) => { if (sid === id) events.push(evt); });

    try {
      expect(runtime.send('launch', 'child-check-1')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });
      const state = (provider as any).sessions.get(id);

      // Register three native children through handleSessionUpdate (real invoke_subagent ACP batch result):
      // 1 finishes with empty content after a RUNNING chunk, 1 fails with SYSTEM_ERROR, 1 stays running until ACP crash.
      (provider as any).handleSessionUpdate({
        sessionId: state.acpSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'launch-batch-child-check',
          title: 'Run invoke_subagent',
          status: 'completed',
          rawInput: { Subagents: [{ Role: 'EmptyDone' }, { Role: 'ErrChild' }, { Role: 'CrashChild' }] },
          rawOutput: JSON.stringify({
            subagents: [
              { conversationId: 'child-empty-done', status: 'running' },
              { conversationId: 'child-err', status: 'running' },
              { conversationId: 'child-crash', status: 'running' },
            ],
          }),
        },
      });
      await vi.waitFor(() => expect(state.agySubagents?.activeCount()).toBe(3), { timeout: 5000 });

      // 1) Child PLANNER_RESPONSE with status RUNNING must NOT close prematurely.
      (provider as any).handleAgyTranscriptRow(id, state, 'child-empty-done', {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        content: 'partial chunk',
      });
      expect(state.agySubagents.activeCount()).toBe(3);

      // 2) Child PLANNER_RESPONSE DONE with empty content completes and closes bridge.
      (provider as any).handleAgyTranscriptRow(id, state, 'child-empty-done', {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
      });
      expect(events.find((e) => e.detail?.meta?.agentPath === 'child-empty-done' && e.detail?.meta?.terminal)?.detail?.meta?.normalizedStatus).toBe('complete');
      expect(state.agySubagents.activeCount()).toBe(2);

      // 3) Child SYSTEM_ERROR emits error and closes bridge.
      (provider as any).handleAgyTranscriptRow(id, state, 'child-err', {
        step_index: 1,
        type: 'SYSTEM_ERROR',
        status: 'ERROR',
        content: 'subagent crashed',
      });
      const errEvt = events.find((e) => e.detail?.meta?.agentPath === 'child-err' && e.detail?.meta?.terminal);
      expect(errEvt?.status).toBe('error');
      expect(errEvt?.detail?.meta?.normalizedStatus).toBe('error');
      expect(state.agySubagents.activeCount()).toBe(1);

      // 4) Simulate ACP failure/exit while agyReactive and child-crash are active -> interrupts subagent & resets to idle.
      state.agyReactive = true;
      (provider as any).syncAgyStatusAfterTurn(id, state);
      expect(runtime.getStatus()).not.toBe('idle');

      const hadActive = (provider as any).clearSessionWorkAfterFailure(id);
      expect(hadActive).toBe(true);
      expect(state.agyReactive).toBe(false);
      expect(state.agySubagents.activeCount()).toBe(0);
      expect(events.some((e) => e.detail?.meta?.agentPath === 'child-crash' && e.detail?.meta?.normalizedStatus === 'interrupted')).toBe(true);
      expect(runtime.getStatus()).toBe('idle');
    } finally {
      await runtime.kill();
    }
  });

  it('settles runtime cleanly to idle when native ACP end_turn records an ack before delayed reactive transcript arrives, preserves background/prompt work, and avoids duplicate onComplete', async () => {
    const { provider } = await setup();
    const id = 'deck_test_agy_f1_ack_idle';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: Array<{ content: string }> = [];
    provider.onComplete((sid, m) => { if (sid === id) completed.push({ content: m.content }); });

    try {
      expect(runtime.send('warm', 'ack-warm-1')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;
      const beforeReactiveCompleted = completed.length;

      // Case 1: SYSTEM_MESSAGE wakeup makes agyReactive=true; ACP native autonomous end_turn arrives FIRST,
      // then delayed matching transcript PLANNER_RESPONSE arrives and consumes agyNativeAcks[0].
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 20,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '[Message] timestamp=2026-11-18T00:00:00Z sender=worker-ack content=wake',
      });
      expect(state.agyReactive).toBe(true);
      expect(runtime.getStatus()).not.toBe('idle');

      // Native autonomous ACP end_turn settles while agyReactive=true (status stays running, ack pushed).
      (provider as any).startAutonomousTurn(id, state);
      const gen1 = state.autonomousTurnGeneration as number;
      state.currentMessageId = `${nativeId}:acp-1`;
      state.currentText = 'NATIVE-ACP-FIRST-DONE';
      (state.activePromptGenerations ??= new Set()).add(gen1);
      (provider as any).settleTurn(id, state, gen1, 'end_turn');
      expect(completed).toHaveLength(beforeReactiveCompleted + 1);
      expect(completed.at(-1)?.content).toBe('NATIVE-ACP-FIRST-DONE');
      expect(state.agyNativeAcks).toHaveLength(1);
      expect(runtime.getStatus()).not.toBe('idle');

      // Delayed transcript PLANNER_RESPONSE arrives with matching text: consumes ack without duplicate onComplete,
      // and transitions runtime cleanly to idle (zero remaining work).
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 21,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'NATIVE-ACP-FIRST-DONE',
      });
      expect(state.agyReactive).toBe(false);
      expect(state.agyNativeAcks).toHaveLength(0);
      expect(completed).toHaveLength(beforeReactiveCompleted + 1);
      expect(provider.getActiveWorkSnapshot(id)).toMatchObject({
        activeWorkCount: 0,
        backgroundWorkCount: 0,
        busyReasons: [],
      });
      expect(runtime.getStatus()).toBe('idle');

      // Case 2: Same ACP-first + delayed ack sequence while a real non-daemon background task IS still active:
      // status must remain tool_running until the background task finishes.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/bg-keep-1`,
        toolName: 'run_command',
        toolInput: { CommandLine: 'npm test', WaitMsBeforeAsync: 500 },
        toolStatus: 'running',
      });
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 22,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: '[Message] timestamp=2026-11-18T00:01:00Z sender=worker-ack-2 content=wake2',
      });
      (provider as any).startAutonomousTurn(id, state);
      const gen2 = state.autonomousTurnGeneration as number;
      state.currentMessageId = `${nativeId}:acp-2`;
      state.currentText = 'NATIVE-ACP-WITH-BG';
      (state.activePromptGenerations ??= new Set()).add(gen2);
      (provider as any).settleTurn(id, state, gen2, 'end_turn');
      expect(completed).toHaveLength(beforeReactiveCompleted + 2);
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 23,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'NATIVE-ACP-WITH-BG',
      });
      expect(completed).toHaveLength(beforeReactiveCompleted + 2);
      expect(runtime.getStatus()).toBe('tool_running');

      // Background task completion clears cleanly to idle.
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 24,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `[Message] timestamp=2026-11-18T00:02:00Z sender=${nativeId}/bg-keep-1 content=Task id "${nativeId}/bg-keep-1" finished with result:\nCommand exited with code 0.`,
      });
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 25,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
      });
      expect(runtime.getStatus()).toBe('idle');

      // Case 3: Successor foreground prompt in flight must not be cleared when delayed ack row arrives,
      // and foreground claim clearing agyReactive while !promptInFlight must settle cleanly to idle.
      state.agyReactive = true;
      state.promptInFlight = true;
      (provider as any).emitStatus(id, state, { status: 'thinking', label: 'Thinking...' });
      state.agyNativeAcks = [{ generation: 99, text: 'DELAYED-ACK' }];
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 26,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'DELAYED-ACK',
      });
      expect(state.promptInFlight).toBe(true);
      expect(state.lastStatusSignature).not.toBe(JSON.stringify({ status: null, label: null }));
      state.promptInFlight = false;
      state.agyPendingResponses?.clear();
      state.agyNativeAcks = [];
      state.agyReactive = true;
      (provider as any).syncAgyStatusAfterTurn(id, state);
      expect(runtime.getStatus()).not.toBe('idle');
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 27,
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'user cleared reactive',
      });
      expect(state.agyReactive).toBe(false);
      expect(runtime.getStatus()).toBe('idle');
    } finally {
      await runtime.kill();
    }
  });

  it('re-emits Running background task status after onComplete across end_turn and max_tokens, clears to null on task finish, and does not clobber a synchronous next turn', async () => {
    const { provider } = await setup();
    const id = 'deck_test_agy_bg_status_after_complete';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const timeline: Array<{ kind: 'complete' | 'status'; content?: string; status?: string | null; label?: string | null }> = [];
    let launchNextTurnOnComplete = false;
    let launchedNextTurn = false;
    provider.onComplete((sid, m) => {
      if (sid !== id) return;
      timeline.push({ kind: 'complete', content: m.content });
      if (launchNextTurnOnComplete && !launchedNextTurn) {
        launchedNextTurn = true;
        launchNextTurnOnComplete = false;
        void provider.send(id, 'synchronous follow-up turn');
        const currentState = (provider as any).sessions.get(id);
        (provider as any).emitStatus(id, currentState, { status: 'thinking', label: 'Thinking...' });
      }
    });
    provider.onStatus((sid, st) => {
      if (sid === id) timeline.push({ kind: 'status', status: st.status, label: st.label });
    });

    try {
      expect(runtime.send('warm', 'warm-up')).toBe('sent');
      await vi.waitFor(() => expect(timeline.some((e) => e.kind === 'complete')).toBe(true), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'), { timeout: 5000 });

      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;

      // Seed an active native background task.
      (provider as any).updateAgyBackgroundTasks(id, state, {
        text: `Tool is running as a background task with task id: ${nativeId}/bg-status-1`,
        toolName: 'run_command',
        toolInput: { CommandLine: 'sleep 10', WaitMsBeforeAsync: 500 },
        toolStatus: 'running',
      });

      // 1) end_turn settles with onComplete, then re-emits Running background task AFTER onComplete.
      timeline.length = 0;
      (provider as any).startAutonomousTurn(id, state);
      const genEndTurn = state.autonomousTurnGeneration as number;
      state.currentMessageId = `${nativeId}:end-turn`;
      state.currentText = 'foreground reply while bg running';
      (state.activePromptGenerations ??= new Set()).add(genEndTurn);
      (provider as any).settleTurn(id, state, genEndTurn, 'end_turn');

      const completeIdx1 = timeline.findIndex((e) => e.kind === 'complete' && e.content === 'foreground reply while bg running');
      expect(completeIdx1).toBeGreaterThanOrEqual(0);
      expect(timeline.at(-1)).toEqual({ kind: 'status', status: 'waiting', label: 'Running background task' });
      expect(timeline.length - 1).toBeGreaterThan(completeIdx1);

      // 2) max_tokens path also emits Running background task AFTER onComplete.
      timeline.length = 0;
      (provider as any).startAutonomousTurn(id, state);
      const genMaxTok = state.autonomousTurnGeneration as number;
      state.currentMessageId = `${nativeId}:max-tokens`;
      state.currentText = 'truncated reply while bg running';
      (state.activePromptGenerations ??= new Set()).add(genMaxTok);
      (provider as any).settleTurn(id, state, genMaxTok, 'max_tokens');

      const completeIdx2 = timeline.findIndex((e) => e.kind === 'complete' && e.content === 'truncated reply while bg running');
      expect(completeIdx2).toBeGreaterThanOrEqual(0);
      expect(timeline.at(-1)).toEqual({ kind: 'status', status: 'waiting', label: 'Running background task' });
      expect(timeline.length - 1).toBeGreaterThan(completeIdx2);

      // 3) If onComplete synchronously starts the next turn (promptInFlight === true),
      //    settleTurn tail must NOT overwrite the new turn's Thinking... with Running background task.
      timeline.length = 0;
      launchNextTurnOnComplete = true;
      (provider as any).startAutonomousTurn(id, state);
      const genOverlap = state.autonomousTurnGeneration as number;
      state.currentMessageId = `${nativeId}:overlap`;
      state.currentText = 'reply triggering successor';
      (state.activePromptGenerations ??= new Set()).add(genOverlap);
      (provider as any).settleTurn(id, state, genOverlap, 'end_turn');

      expect(launchedNextTurn).toBe(true);
      const firstCompleteIdx = timeline.findIndex((e) => e.kind === 'complete' && e.content === 'reply triggering successor');
      expect(firstCompleteIdx).toBeGreaterThanOrEqual(0);
      // Immediately upon settleTurn returning while the synchronous successor turn is in flight,
      // settleTurn's tail must NOT overwrite the successor's Thinking... with Running background task.
      expect(timeline.slice(firstCompleteIdx + 1)).toEqual([
        { kind: 'status', status: 'thinking', label: 'Thinking...' },
      ]);
      await vi.waitFor(() => expect(timeline.some((e) => e.kind === 'complete' && e.content === 'synchronous follow-up turn')).toBe(true), { timeout: 5000 });
      expect(timeline.at(-1)).toEqual({ kind: 'status', status: 'waiting', label: 'Running background task' });

      // 4) Background task completion clears status to null once reactive wakeup finishes.
      timeline.length = 0;
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 30,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `[Message] timestamp=2026-11-18T00:03:00Z sender=${nativeId}/bg-status-1 content=Task id "${nativeId}/bg-status-1" finished with result:\nCommand exited with code 0.`,
      });
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 31,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '',
      });
      expect(timeline.at(-1)).toEqual({ kind: 'status', status: null, label: null });
      expect(runtime.getStatus()).toBe('idle');
    } finally {
      await runtime.kill();
    }
  });

  it('does not reconcile active subagents on transcript-first ERROR/RUNNING manage_subagents(list) or mixed ACP/transcript errors, and reconciles cleanly on terminal DONE', async () => {
    const { provider } = await setup();
    const id = 'deck_test_agy_f2_generic_status';
    const runtime = new TransportSessionRuntime(provider, id);
    await runtime.initialize({ sessionKey: id, sessionName: id, cwd: process.cwd(), agentId: 'model-a' });
    const completed: Array<{ content: string }> = [];
    const events: ToolCallEvent[] = [];
    provider.onComplete((sid, m) => { if (sid === id) completed.push({ content: m.content }); });
    provider.onToolCall((sid, evt) => { if (sid === id) events.push(evt); });

    try {
      expect(runtime.send('warm', 'f2-warm')).toBe('sent');
      await vi.waitFor(() => expect(completed).toHaveLength(1), { timeout: 5000 });
      const state = (provider as any).sessions.get(id);
      const nativeId = state.acpSessionId as string;

      // Seed one running native child.
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'f2-launch',
          title: 'Run invoke_subagent',
          status: 'completed',
          rawInput: { Subagents: [{ Role: 'WorkerKeep' }] },
          rawOutput: JSON.stringify({ conversationId: 'child-keep', status: 'running' }),
        },
      });
      await vi.waitFor(() => expect(state.agySubagents?.activeCount()).toBe(1), { timeout: 5000 });
      const beforeEvents = events.length;

      // 1) Transcript-first GENERIC status:ERROR with content:'[]' (no pending ACP event) MUST NOT complete child-keep.
      state.agyNativeToolOrder = [{ name: 'manage_subagents', input: { Action: 'list' }, step: 10, index: 0 }];
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 11,
        type: 'GENERIC',
        status: 'ERROR',
        content: '[]',
      });
      expect(state.agySubagents.activeCount()).toBe(1);
      expect(events.slice(beforeEvents).some((e) => e.detail?.meta?.normalizedStatus === 'complete')).toBe(false);

      // 2) Transcript-first GENERIC status:RUNNING with content:'[]' MUST NOT complete child-keep.
      state.agyNativeToolOrder = [{ name: 'manage_subagents', input: { Action: 'list' }, step: 12, index: 0 }];
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 13,
        type: 'GENERIC',
        status: 'RUNNING',
        content: '[]',
      });
      expect(state.agySubagents.activeCount()).toBe(1);
      expect(events.slice(beforeEvents).some((e) => e.detail?.meta?.normalizedStatus === 'complete')).toBe(false);

      // 3) Mixed order: ACP tool_call complete with empty output, followed by transcript GENERIC status:ERROR content:'[]':
      // transcript ERROR still wins and MUST NOT complete child-keep.
      (provider as any).handleSessionUpdate({
        sessionId: nativeId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'f2-list-acp-empty',
          title: 'Run manage_subagents',
          status: 'completed',
          rawInput: { Action: 'list' },
        },
      });
      state.agyNativeToolOrder = [{ name: 'manage_subagents', input: { Action: 'list' }, step: 14, index: 0 }];
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 15,
        type: 'GENERIC',
        status: 'ERROR',
        content: '[]',
      });
      expect(state.agySubagents.activeCount()).toBe(1);
      expect(events.slice(beforeEvents).some((e) => e.detail?.meta?.normalizedStatus === 'complete')).toBe(false);

      // 4) Positive control: transcript-first GENERIC status:DONE content:'[]' reconciles child-keep to COMPLETE.
      state.agyNativeToolOrder = [{ name: 'manage_subagents', input: { Action: 'list' }, step: 16, index: 0 }];
      (provider as any).handleAgyTranscriptRow(id, state, nativeId, {
        step_index: 17,
        type: 'GENERIC',
        status: 'DONE',
        content: '[]',
      });
      expect(state.agySubagents.activeCount()).toBe(0);
      expect(events.slice(beforeEvents).some((e) => e.detail?.meta?.agentPath === 'child-keep' && e.detail?.meta?.normalizedStatus === 'complete')).toBe(true);
    } finally {
      await runtime.kill();
    }
  });

  it('spawns per-session ACP server in state.cwd (never /) under launchd cwd=/, handles nonexistent cwd safely, and recycles on cwd change preserving resumeId', async () => {
    const { provider, requests, root } = await setup();
    const wsA = path.join(root, 'workspace-a');
    const wsB = path.join(root, 'workspace-b');
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });

    const done = vi.fn();
    const errors = vi.fn();
    provider.onComplete(done);
    provider.onError(errors);

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/');
    try {
      // 1) Explicit valid workspace cwd wins even when daemon process.cwd() === '/'.
      const sid = 'deck_test_acp_cwd';
      await provider.createSession({ sessionKey: sid, sessionName: sid, cwd: wsA, agentId: 'model-a' });
      await provider.send(sid, 'turn in wsA');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      let boots = (await requests()).filter((r) => r.fixture === 'boot');
      expect(boots).toHaveLength(1);
      expect(boots[0].cwd).toBe(realpathSync(wsA));
      expect(boots[0].pwd).toBe(realpathSync(wsA));

      const firstResumeId = (provider as any).sessions.get(sid)?.acpSessionId;
      expect(firstResumeId).toBe('native-1');

      // 2) Moving an existing idle perSessionTransport session to a different valid cwd recycles child while preserving resumeId.
      await provider.createSession({ sessionKey: sid, sessionName: sid, cwd: wsB, agentId: 'model-a' });
      await provider.send(sid, 'turn in wsB');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      const allReqs = await requests();
      boots = allReqs.filter((r) => r.fixture === 'boot');
      expect(boots).toHaveLength(2);
      expect(boots[1].pid).not.toBe(boots[0].pid);
      expect(boots[1].cwd).toBe(realpathSync(wsB));
      expect(allReqs.some((r) => r.method === 'session/resume' && r.params?.sessionId === 'native-1' && r.params?.cwd === wsB)).toBe(true);

      // 3) Omitted cwd or non-existent synthetic cwd under process.cwd() === '/' falls back safely to homedir (never '/' or ENOENT).
      const sidOmitted = 'deck_test_acp_omitted_cwd';
      await provider.createSession({ sessionKey: sidOmitted, sessionName: sidOmitted, agentId: 'model-a' });
      expect((provider as any).sessions.get(sidOmitted)?.cwd).toBe(realpathSync(homedir()));
      await provider.send(sidOmitted, 'turn omitted cwd');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(3), { timeout: 5000 });

      const sidMissing = 'deck_test_acp_missing_cwd';
      await provider.createSession({
        sessionKey: sidMissing,
        sessionName: sidMissing,
        cwd: path.join(root, 'synthetic-missing-dir'),
        agentId: 'model-a',
      });
      await provider.send(sidMissing, 'turn missing cwd');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(4), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      boots = (await requests()).filter((r) => r.fixture === 'boot');
      expect(boots).toHaveLength(4);
      expect(boots[2].cwd).toBe(realpathSync(homedir()));
      expect(boots[3].cwd).toBe(realpathSync(homedir()));
      // 4) Symlinked workspace canonicalization (macOS /tmp -> /private/tmp, /var -> /private/var):
      //    boot.cwd and boot.pwd both match realpathSync(realWs), and switching from symlinkWs to realWs does NOT respawn.
      const realWs = path.join(root, 'workspace-real');
      const symlinkWs = path.join(root, 'workspace-symlink');
      await mkdir(realWs, { recursive: true });
      symlinkSync(realWs, symlinkWs, 'dir');

      const sidSym = 'deck_test_acp_symlink_cwd';
      await provider.createSession({ sessionKey: sidSym, sessionName: sidSym, cwd: symlinkWs, agentId: 'model-a' });
      await provider.send(sidSym, 'turn via symlinkWs');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(5), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      boots = (await requests()).filter((r) => r.fixture === 'boot');
      expect(boots).toHaveLength(5);
      expect(boots[4].cwd).toBe(realpathSync(realWs));
      expect(boots[4].pwd).toBe(realpathSync(realWs));

      await provider.createSession({ sessionKey: sidSym, sessionName: sidSym, cwd: realWs, agentId: 'model-a' });
      await provider.send(sidSym, 'turn via realWs alias');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(6), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      boots = (await requests()).filter((r) => r.fixture === 'boot');
      expect(boots).toHaveLength(5);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('sets PWD to spawnCwd and hoists Homebrew/user tool dirs ahead of /usr/bin without shadowing leading caller PATH shims', async () => {
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'imcodes-acp-path-home-'));
    const ws = path.join(fakeHome, 'project');
    await mkdir(ws, { recursive: true });
    try {
      const launchdPath = [
        '/tmp/test-shim',
        `${fakeHome}/.local/bin`,
        '/usr/local/bin',
        '/System/Cryptexes/App/usr/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/opt/homebrew/bin',
      ].join(':');
      const { provider, requests } = await setup('', {
        HOME: fakeHome,
        PWD: '/',
        PATH: launchdPath,
      });
      const done = vi.fn();
      const errors = vi.fn();
      provider.onComplete(done);
      provider.onError(errors);

      const sid = 'deck_test_acp_env_path';
      await provider.createSession({ sessionKey: sid, sessionName: sid, cwd: ws, agentId: 'model-a' });
      await provider.send(sid, 'check env');
      await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 5000 });
      expect(errors).not.toHaveBeenCalled();

      const boot = (await requests()).find((r) => r.fixture === 'boot');
      expect(boot).toBeTruthy();
      expect(boot.pwd).toBe(realpathSync(ws));
      if (process.platform !== 'win32') {
        const entries = String(boot.path ?? '').split(':');
        expect(entries[0]).toBe('/tmp/test-shim');
        const cryptexIdx = entries.indexOf('/System/Cryptexes/App/usr/bin');
        const usrBinIdx = entries.indexOf('/usr/bin');
        expect(cryptexIdx).toBeGreaterThan(0);
        expect(usrBinIdx).toBeGreaterThan(cryptexIdx);
        for (const expectedDir of [
          path.join(fakeHome, '.local', 'bin'),
          path.join(fakeHome, '.gemini', 'antigravity-cli', 'bin'),
          path.join(fakeHome, '.npm-global', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ]) {
          const idx = entries.indexOf(expectedDir);
          expect(idx).toBeGreaterThan(0);
          expect(idx).toBeLessThan(cryptexIdx);
          expect(entries.filter((entry) => entry === expectedDir)).toHaveLength(1);
        }
      }
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  function encodeProtobufVarint(n: number): Buffer {
    const out: number[] = [];
    let val = n;
    while (val >= 0x80) {
      out.push((val & 0x7f) | 0x80);
      val = Math.floor(val / 128);
    }
    out.push(val);
    return Buffer.from(out);
  }

  async function writeAgyMetadataBlobDb(
    homeDir: string,
    acpSessionId: string,
    blobData: Buffer,
  ): Promise<string> {
    const dir = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
    await mkdir(dir, { recursive: true });
    const dbPath = path.join(dir, `${acpSessionId}.db`);
    suppressSqliteExperimentalWarning();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)');
      db.prepare('INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', blobData);
    } finally {
      db.close();
    }
    return dbPath;
  }

  function buildPersistedSystemPromptBlob(promptText: string): Buffer {
    const payload = Buffer.from(promptText, 'utf8');
    const marker = Buffer.from('\x0a\x11acp_system_prompt\x12', 'latin1');
    const prefix = Buffer.from('08011a086d65746164617461', 'hex');
    const suffix = Buffer.from('1001', 'hex');
    return Buffer.concat([prefix, marker, encodeProtobufVarint(payload.length), payload, suffix]);
  }

  it('omits session/resume _meta when SQLite trajectory_metadata_blob already persisted acp_system_prompt (Scenario A)', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const debugSpy = vi.spyOn(logger, 'debug');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const { provider, root, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
      const identity = '<imcodes-agent-identity>\nSECRET_SLOT_A_IDENTITY_101\n</imcodes-agent-identity>';
      const persistedPrompt = `${'OUTER_SYSTEM_CONTRACT_V1 '.repeat(2400)}\n${identity}`;
      await writeAgyMetadataBlobDb(root, 'persisted-slot-a', buildPersistedSystemPromptBlob(persistedPrompt));

      const id = await route(provider, 'deck_test_slot_a_resume', { resumeId: 'persisted-slot-a' });
      const complete = vi.fn();
      provider.onComplete(complete);

      // Cold session/resume after hibernation or daemon upgrade (outer contract tweaked, identity unchanged)
      const upgradedOuterPrompt = `${'OUTER_SYSTEM_CONTRACT_V2 '.repeat(2400)}\n${identity}`;
      const p1 = normalizeProviderPayload('wake from hibernation');
      p1.sessionSystemText = upgradedOuterPrompt;
      p1.context = { ...p1.context, sessionSystemText: upgradedOuterPrompt };
      await provider.send(id, p1);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

      // Live syncMetaOnLoaded after refreshSessionSystemText while identity is still unchanged
      provider.refreshSessionSystemText(id);
      const p2 = normalizeProviderPayload('turn after refresh');
      p2.sessionSystemText = upgradedOuterPrompt;
      p2.context = { ...p2.context, sessionSystemText: upgradedOuterPrompt };
      await provider.send(id, p2);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

      const reqs = await requests();
      const resumes = reqs.filter((x) => x.method === 'session/resume');
      expect(resumes).toHaveLength(1);
      expect(resumes[0]?.params?.sessionId).toBe('persisted-slot-a');
      expect(resumes[0]?.params?._meta).toBeUndefined();

      const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
      expect(prompts).toEqual(['wake from hibernation', 'turn after refresh']);
      for (const promptText of prompts) {
        expect(promptText).not.toContain('OUTER_SYSTEM_CONTRACT');
        expect(promptText).not.toContain('SECRET_SLOT_A_IDENTITY_101');
      }

      for (const spy of [infoSpy, debugSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('SECRET_SLOT_A_IDENTITY_101');
        }
      }
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('sends only updated <imcodes-agent-identity> block via _meta when Slot A already persisted outer prompt (Scenario B)', async () => {
    const { provider, root, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    const outerContract = 'OUTER_CONTRACT_55KB_PADDING '.repeat(2200);
    const idV1 = '<imcodes-agent-identity>\nIDENTITY_V1\n</imcodes-agent-identity>';
    const idV2 = '<imcodes-agent-identity>\nIDENTITY_V2_UPDATED\n</imcodes-agent-identity>';
    await writeAgyMetadataBlobDb(root, 'persisted-slot-b', buildPersistedSystemPromptBlob(`${outerContract}\n${idV1}`));

    const id = await route(provider, 'deck_test_slot_b_identity_delta', { resumeId: 'persisted-slot-b' });
    const complete = vi.fn();
    provider.onComplete(complete);

    const makePayload = (msg: string, sys: string) => {
      const p = normalizeProviderPayload(msg);
      p.sessionSystemText = sys;
      p.context = { ...p.context, sessionSystemText: sys };
      return p;
    };

    // Cold resume with updated <imcodes-agent-identity>: only sends the delta identity block
    await provider.send(id, makePayload('turn-1-delta', `${outerContract}\n${idV2}`));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // Mid-session identity cleared while outer contract remains: sends empty identity override only
    await provider.send(id, makePayload('turn-2-clear-identity', outerContract));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { timeout: 5000 });

    const reqs = await requests();
    const resumes = reqs.filter((x) => x.method === 'session/resume');
    expect(resumes).toHaveLength(2);
    expect(resumes[0]?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: idV2 } },
    });
    expect(resumes[1]?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: '<imcodes-agent-identity>\n</imcodes-agent-identity>' } },
    });
    for (const resumeReq of resumes) {
      expect(resumeReq?.params?._meta?.antigravity?.systemPrompt?.append).not.toContain('OUTER_CONTRACT_55KB_PADDING');
    }
    const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts).toEqual(['turn-1-delta', 'turn-2-clear-identity']);
  });

  it('delivers full _meta on session/resume when SQLite trajectory_metadata_blob lacks acp_system_prompt (Scenario C)', async () => {
    const { provider, root, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    // Legacy ~812-byte metadata blob without acp_system_prompt field
    await writeAgyMetadataBlobDb(root, 'legacy-no-slot-a', Buffer.alloc(812, 0x20));

    const id = await route(provider, 'deck_test_legacy_db_resume', { resumeId: 'legacy-no-slot-a' });
    const complete = vi.fn();
    provider.onComplete(complete);

    const fullSystemText = `${'LEGACY_FULL_SYSTEM_CONTRACT '.repeat(200)}\n<imcodes-agent-identity>LEGACY_V1</imcodes-agent-identity>`;
    const p = normalizeProviderPayload('legacy resume turn');
    p.sessionSystemText = fullSystemText;
    p.context = { ...p.context, sessionSystemText: fullSystemText };
    await provider.send(id, p);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const reqs = await requests();
    const resumeReq = reqs.find((x) => x.method === 'session/resume');
    expect(resumeReq?.params?._meta).toEqual({
      antigravity: { systemPrompt: { append: fullSystemText } },
    });
    const prompts = reqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(prompts).toEqual(['legacy resume turn']);
  });

  it('safely returns null from readPersistedAgySystemPrompt on traversal, missing/empty/corrupt DB, and busy lock', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'imcodes-agy-blob-bounds-'));
    try {
      expect(readPersistedAgySystemPrompt('', 'valid-id')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, '')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, '.')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, '..')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, '../escape')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, 'nested/id')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, 'win\\id')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, 'null\0id')).toBeNull();
      expect(readPersistedAgySystemPrompt(root, 'does-not-exist')).toBeNull();

      // Valid round-trip (>128 bytes multi-byte varint + UTF-8)
      const roundTripText = '中文边界测试 '.repeat(40);
      await writeAgyMetadataBlobDb(root, 'valid-utf8', buildPersistedSystemPromptBlob(roundTripText));
      expect(readPersistedAgySystemPrompt(root, 'valid-utf8')).toBe(roundTripText);

      // Empty table (no 'main' row)
      const dir = path.join(root, '.gemini', 'antigravity-cli', 'conversations');
      suppressSqliteExperimentalWarning();
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      const emptyDb = new DatabaseSync(path.join(dir, 'empty-row.db'));
      emptyDb.exec('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)');
      emptyDb.close();
      expect(readPersistedAgySystemPrompt(root, 'empty-row')).toBeNull();

      // Truncated varint / length exceeding buffer
      const marker = Buffer.from('\x0a\x11acp_system_prompt\x12', 'latin1');
      await writeAgyMetadataBlobDb(root, 'truncated-varint', Buffer.concat([marker, Buffer.from([0x80])]));
      expect(readPersistedAgySystemPrompt(root, 'truncated-varint')).toBeNull();

      await writeAgyMetadataBlobDb(root, 'truncated-payload', Buffer.concat([marker, encodeProtobufVarint(50), Buffer.from('short')]));
      expect(readPersistedAgySystemPrompt(root, 'truncated-payload')).toBeNull();

      // Invalid UTF-8 bytes inside payload
      await writeAgyMetadataBlobDb(root, 'bad-utf8', Buffer.concat([marker, encodeProtobufVarint(2), Buffer.from([0xff, 0xfe])]));
      expect(readPersistedAgySystemPrompt(root, 'bad-utf8')).toBeNull();

      // Busy lock (EXCLUSIVE transaction held while busy_timeout=0)
      const lockDbPath = path.join(dir, 'valid-utf8.db');
      const lockingDb = new DatabaseSync(lockDbPath);
      try {
        lockingDb.exec('BEGIN EXCLUSIVE');
        expect(readPersistedAgySystemPrompt(root, 'valid-utf8')).toBeNull();
        lockingDb.exec('ROLLBACK');
      } finally {
        lockingDb.close();
      }
      // After lock release, reading succeeds again (no leaked handle / corruption)
      expect(readPersistedAgySystemPrompt(root, 'valid-utf8')).toBe(roundTripText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'Slot A with identity: A -> B -> B(outer refresh) -> A -> A(outer refresh) -> rebuild(A)',
      initialIdentity: '<imcodes-agent-identity>\nIDENTITY_A\n</imcodes-agent-identity>',
      revertAppend: '<imcodes-agent-identity>\nIDENTITY_A\n</imcodes-agent-identity>',
      sessionId: 'slot-a-revert-with-id',
    },
    {
      label: 'Slot A without identity: none -> B -> B(outer refresh) -> none -> none(outer refresh) -> rebuild(none)',
      initialIdentity: undefined,
      revertAppend: '',
      sessionId: 'slot-a-revert-no-id',
    },
  ])('reverts Slot B override back to Slot A baseline cleanly ($label)', async ({ initialIdentity, revertAppend, sessionId }) => {
    const outerV1 = 'OUTER_SYSTEM_CONTRACT_V1 '.repeat(2200);
    const outerV2 = 'OUTER_SYSTEM_CONTRACT_V2 '.repeat(2200);
    const outerV3 = 'OUTER_SYSTEM_CONTRACT_V3 '.repeat(2200);
    const identityB = '<imcodes-agent-identity>\nIDENTITY_B_DYNAMIC\n</imcodes-agent-identity>';

    const buildSystemText = (outer: string, idBlock?: string) => (idBlock ? `${outer}\n${idBlock}` : outer);
    const persistedText = buildSystemText(outerV1, initialIdentity);

    const { provider, root, binary, requests } = await setup('', { AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1' });
    await writeAgyMetadataBlobDb(root, sessionId, buildPersistedSystemPromptBlob(persistedText));

    const routeName = `deck_test_${sessionId}`;
    await route(provider, routeName, { resumeId: sessionId });
    const complete = vi.fn();
    provider.onComplete(complete);

    const sendTurn = async (msg: string, sys: string, expectedCount: number) => {
      const p = normalizeProviderPayload(msg);
      p.sessionSystemText = sys;
      p.context = { ...p.context, sessionSystemText: sys };
      await provider.send(routeName, p);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(expectedCount), { timeout: 5000 });
    };

    // 1. Cold resume at baseline -> omits _meta
    await sendTurn('turn-1-baseline', persistedText, 1);
    expect((await requests()).filter((x) => x.method === 'session/resume').map((x) => x.params?._meta ?? null)).toEqual([null]);

    // 2. Live update to B -> sends B delta
    await sendTurn('turn-2-apply-b', buildSystemText(outerV1, identityB), 2);
    expect((await requests()).filter((x) => x.method === 'session/resume').map((x) => x.params?._meta?.antigravity?.systemPrompt?.append ?? null)).toEqual([
      null,
      identityB,
    ]);

    // 3. Outer contract refresh + refreshSessionSystemText while B unchanged -> no extra resume RPC
    provider.refreshSessionSystemText(routeName);
    await sendTurn('turn-3-keep-b-outer-refresh', buildSystemText(outerV2, identityB), 3);
    expect((await requests()).filter((x) => x.method === 'session/resume')).toHaveLength(2);

    // 4. Revert back to Slot A baseline -> MUST send resume override to clear/replace B in Slot B
    await sendTurn('turn-4-revert-to-a', buildSystemText(outerV2, initialIdentity), 4);
    expect((await requests()).filter((x) => x.method === 'session/resume').map((x) => x.params?._meta?.antigravity?.systemPrompt?.append ?? null)).toEqual([
      null,
      identityB,
      revertAppend,
    ]);

    // 5. Outer contract refresh + refreshSessionSystemText while reverted baseline unchanged -> no extra resume RPC
    provider.refreshSessionSystemText(routeName);
    await sendTurn('turn-5-keep-reverted-outer-refresh', buildSystemText(outerV3, initialIdentity), 5);
    expect((await requests()).filter((x) => x.method === 'session/resume')).toHaveLength(3);

    // 6. Transport rebuild on a fresh provider instance (simulating daemon restart / hibernation wake) ->
    //    activeSlotBIdentityOverride resets to undefined, cold resume at baseline omits _meta again
    const logAfterRebuild = path.join(root, 'rpc-rebuild.jsonl');
    const providerAfterRebuild = new AgyAcpProvider();
    resources.push({ provider: providerAfterRebuild, root });
    await providerAfterRebuild.connect({
      binaryPath: binary,
      env: {
        HOME: root,
        AGY_ACP_FIXTURE_AGENT_NAME: AGY_ACP_AGENT_NAME,
        AGY_ACP_FIXTURE_LOG: logAfterRebuild,
        AGY_ACP_FIXTURE_SYSTEM_PROMPT_META: '1',
      },
    });
    const rebuildComplete = vi.fn();
    providerAfterRebuild.onComplete(rebuildComplete);
    await providerAfterRebuild.createSession({
      sessionKey: routeName,
      sessionName: routeName,
      cwd: process.cwd(),
      agentId: 'model-a',
      resumeId: sessionId,
    });
    const pRebuild = normalizeProviderPayload('turn-6-after-rebuild');
    pRebuild.sessionSystemText = buildSystemText(outerV3, initialIdentity);
    pRebuild.context = { ...pRebuild.context, sessionSystemText: pRebuild.sessionSystemText };
    await providerAfterRebuild.send(routeName, pRebuild);
    await vi.waitFor(() => expect(rebuildComplete).toHaveBeenCalledTimes(1), { timeout: 5000 });

    const rebuildReqs = (await readFile(logAfterRebuild, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const rebuildResumes = rebuildReqs.filter((x) => x.method === 'session/resume');
    expect(rebuildResumes).toHaveLength(1);
    expect(rebuildResumes[0]?.params?._meta).toBeUndefined();

    // Prompts stay clean across both transports (never leaking system contract or identity)
    const initialPrompts = (await requests()).filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    const rebuildPrompts = rebuildReqs.filter((x) => x.method === 'session/prompt').map((x) => x.params.prompt[0].text);
    expect(initialPrompts).toEqual([
      'turn-1-baseline',
      'turn-2-apply-b',
      'turn-3-keep-b-outer-refresh',
      'turn-4-revert-to-a',
      'turn-5-keep-reverted-outer-refresh',
    ]);
    expect(rebuildPrompts).toEqual(['turn-6-after-rebuild']);
  });
});
