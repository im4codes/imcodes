// Deterministic stdio peer for the REAL ACP SDK client. No model/network/auth.
import readline from 'node:readline';
import fs from 'node:fs';
const logPath = process.env.AGY_ACP_FIXTURE_LOG;
const scenario = process.env.AGY_ACP_FIXTURE_SCENARIO || '';
const sessions = new Map(); let nextId = 0; let modelAttempts = 0;
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
const ok = (id, result = {}) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32602, message } });
const note = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const record = data => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(data) + '\n'); };
if (process.argv.includes('--help')) { console.log('Usage: agy'); process.exit(0); }
if (process.argv.includes('--version')) { console.log(process.env.AGY_ACP_FIXTURE_VERSION || '1.5.4'); process.exit(0); }
const models = { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }, { modelId: 'model-b', name: 'Model B' }] };
function startAutoWakeup(sid, state) {
  if (logPath && fs.existsSync(logPath + '.auto-start-hold')) {
    state.autoTimer = setTimeout(() => startAutoWakeup(sid, state), 10); return;
  }
  state.inAutoWakeup = true;
  state.autoToolStarted = false;
  state.inputs = ['AUTONOMOUS_WAKEUP_DONE'];
  state.turnModel = state.model || models.currentModelId;
  note(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'waking up...' } });
  state.autoTimer = setTimeout(() => continueAutoWakeup(sid, state), 10);
}
function continueAutoWakeup(sid, state) {
  if (logPath && fs.existsSync(logPath + '.auto-thought-hold')) {
    state.autoTimer = setTimeout(() => continueAutoWakeup(sid, state), 10); return;
  }
  if (!state.autoToolStarted) {
    state.autoToolStarted = true;
    note(sid, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'edit_file', kind: 'edit', status: 'in_progress', rawInput: { path: 'src/a.ts' } });
  }
  if (logPath && fs.existsSync(logPath + '.auto-hold')) {
    state.autoTimer = setTimeout(() => continueAutoWakeup(sid, state), 10); return;
  }
  state.inAutoWakeup = false; state.autoToolStarted = false; state.autoTimer = undefined;
  note(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed', rawOutput: 'edited' });
  note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: state.inputs.join(' ') } });
  note(sid, { sessionUpdate: 'usage_update', tokens: { inputTokens: 22, outputTokens: 11 } });
  note(sid, { sessionUpdate: 'turn_completed' });
  for (const id of state.pending.splice(0)) ok(id, { stopReason: 'end_turn', usage: { inputTokens: 22, outputTokens: 11 } });
  state.inputs = [];
}
function finishAutoCancel(sid, state) {
  if (logPath && fs.existsSync(logPath + '.auto-cancel-hold')) {
    state.autoTimer = setTimeout(() => finishAutoCancel(sid, state), 10); return;
  }
  state.inAutoWakeup = false; state.autoToolStarted = false; state.autoTimer = undefined; state.inputs = [];
  record({ fixture: 'auto-cancel-stopped', sessionId: sid, inAutoWakeup: false });
  note(sid, { sessionUpdate: 'turn_completed' });
  if (scenario === 'late-after-cancel') {
    setTimeout(() => {
      note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_AFTER_STOP' } });
      note(sid, { sessionUpdate: 'turn_completed' });
    }, 15);
  }
}
function finish(sid, state) {
  // Explicit process-fixture handshake, not a timing assumption about CI CPU.
  if (logPath && fs.existsSync(logPath + '.hold')) {
    state.timer = setTimeout(() => finish(sid, state), 10); return;
  }
  state.timer = undefined;
  const shouldScheduleWakeup = state.inputs.some(x => x.includes('SCHEDULE_WAKEUP'));
  record({ fixture: 'completed-model', sessionId: sid, model: state.turnModel });
  note(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'sleep', status: 'completed', rawOutput: 'done' });
  note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: state.inputs.join(' ') } });
  if (scenario === 'usage-used') note(sid,{sessionUpdate:'usage_update',used:45000,size:1000000});
  const pending = state.pending.splice(0);
  if (scenario === 'reordered') pending.reverse();
  for (const [i, id] of pending.entries()) setTimeout(() => ok(id, { stopReason: 'end_turn', usage: scenario === 'usage-missing' ? {} : scenario === 'usage-zero' ? {inputTokens:0,outputTokens:0} : { inputTokens: 10, outputTokens: 5 } }), i * (Number(process.env.AGY_ACP_FIXTURE_REPLY_GAP_MS) || 20));
  state.inputs = [];
  if (shouldScheduleWakeup) state.autoTimer = setTimeout(() => startAutoWakeup(sid, state), 20);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line); const p = req.params || {}; record(req);
  switch (req.method) {
    case 'initialize': return ok(req.id, { protocolVersion: 1, agentInfo: { name: process.env.AGY_ACP_FIXTURE_AGENT_NAME, version: '1.5.4' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, list: {} } } });
    case 'session/new': {
      if (scenario === 'new-error-once' && !fs.existsSync(logPath + '.new-failed')) {
        fs.writeFileSync(logPath + '.new-failed', 'failed'); return error(req.id, 'native creation unavailable');
      }
      const sessionId = `native-${++nextId}`; sessions.set(sessionId, { pending: [], inputs: [] });
      return setTimeout(() => ok(req.id, { sessionId, models }), scenario === 'late-new' ? 150 : 0);
    }
    case 'session/resume': {
      if (p.sessionId === 'missing-native') return error(req.id, 'Session not found');
      sessions.set(p.sessionId, { pending: [], inputs: [] });
      if (scenario === 'resume-history') note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD_ERROR from history' } });
      return ok(req.id, { sessionId: p.sessionId, models });
    }
    case 'session/set_model': {
      if (p.modelId === 'invalid' || (scenario === 'unsupported-carbon' && p.modelId === 'gemini-4-carbon-medium') || scenario === 'model-error'
        || (scenario === 'model-error-once' && modelAttempts++ === 0)) return error(req.id, 'Unknown model');
      if (scenario === 'model-unsupported') return error(req.id, 'Method unavailable');
      const respond = () => { const state = sessions.get(p.sessionId); if (state) state.model = p.modelId; ok(req.id); };
      return setTimeout(respond, p.modelId === 'model-b' && scenario === 'model-late' ? 180 : p.modelId === 'model-b' && scenario === 'model-timeout' ? 5500 : 0);
    }
    case 'session/set_mode': return ok(req.id);
    case 'session/close': {
      const state = sessions.get(p.sessionId); if (state) { clearTimeout(state.timer); clearTimeout(state.autoTimer); for (const id of state.pending) ok(id, { stopReason: 'cancelled' }); }
      sessions.delete(p.sessionId); return ok(req.id);
    }
    case 'session/cancel': {
      if (scenario === 'ignore-auto-cancel') {
        record({ fixture: 'cancel-ignored', sessionId: p.sessionId, inAutoWakeup: sessions.get(p.sessionId)?.inAutoWakeup });
        return;
      }
      if (scenario === 'crash-on-cancel') return process.exit(12);
      const state = sessions.get(p.sessionId); if (!state) return;
      clearTimeout(state.timer); clearTimeout(state.autoTimer);
      if (state.inAutoWakeup && state.pending.length === 0) {
        record({ fixture: 'auto-cancel-requested', sessionId: p.sessionId, inAutoWakeup: true });
        finishAutoCancel(p.sessionId, state);
        return;
      }
      state.inAutoWakeup = false; state.autoToolStarted = false;
      for (const id of state.pending.splice(0)) ok(id, { stopReason: 'cancelled' }); state.inputs = [];
      if (scenario === 'late-after-cancel') {
        setTimeout(() => {
          note(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE_AFTER_STOP' } });
          note(p.sessionId, { sessionUpdate: 'turn_completed' });
        }, 15);
      }
      return;
    }
    case 'session/prompt': {
      const state = sessions.get(p.sessionId); if (!state) return error(req.id, 'Missing session');
      const text = p.prompt.map(x => x.text || '').join('');
      if(scenario==='native-steering') {
        const dir=`${process.env.HOME}/.gemini/antigravity-cli/brain/${p.sessionId}/.system_generated/logs`;fs.mkdirSync(dir,{recursive:true});
        const file=dir+'/transcript_full.jsonl',row=(step_index,type,content,extra={})=>JSON.stringify({step_index,type,content,status:'DONE',source:type==='USER_INPUT'?'USER_EXPLICIT':'MODEL',...extra})+'\n';
        if(!state.steeringPass) {
          state.steeringPass=1;state.steeredRpc=req.id;
          fs.writeFileSync(file,row(0,'USER_INPUT',text));
          note(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'launch',title:'Run invoke_subagent',kind:'other',status:'in_progress',rawInput:{Role:'Child',Prompt:'work'}});
          return;
        }
        fs.appendFileSync(file,row(1,'USER_INPUT',text)+row(2,'PLANNER_RESPONSE','STEERED OWNED RESULT'));
        note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'unattributed stale ACP'}});
        ok(state.steeredRpc,{stopReason:'end_turn',usage:{inputTokens:100,outputTokens:2}});
        ok(req.id,{stopReason:'end_turn',usage:{inputTokens:300,outputTokens:3}});return;
      }
      if (scenario.startsWith('acp-child-')) {
        const dir = `${process.env.HOME}/.gemini/antigravity-cli/brain/${p.sessionId}/.system_generated/logs`;
        fs.mkdirSync(dir,{recursive:true});
        const file=dir+'/transcript_full.jsonl';
        const row=(step_index,type,content)=>JSON.stringify({step_index,type,status:'DONE',source:type==='USER_INPUT'?'USER_EXPLICIT':'MODEL',content})+'\n';
        const childId='12345678-1234-1234-1234-123456789abc';
        fs.writeFileSync(file,row(0,'USER_INPUT',text)+row(1,'PLANNER_RESPONSE','PARENT-STARTED'));
        const inline=scenario==='acp-child-inline';
        const title=inline?'Run invoke_subagent {"Model":"inherit","Prompt":"return child result"}':'Run invoke_subagent';
        if(scenario!=='acp-child-update-only') note(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'direct-child',title,status:'in_progress',...(inline?{}:{rawInput:{Model:'inherit',Prompt:'return child result'}})});
        const output=scenario==='acp-child-text'
          ? {content:[{type:'content',content:{type:'text',text:'Created subagent: '+childId}}]}
          : {rawOutput:{conversationId:childId}};
        note(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'direct-child',title,status:'completed',...output});
        note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT-STARTED'}});
        ok(req.id,{stopReason:'end_turn'});
        setTimeout(()=>{
          const childDir=`${process.env.HOME}/.gemini/antigravity-cli/brain/${childId}/.system_generated/logs`;
          fs.mkdirSync(childDir,{recursive:true});fs.writeFileSync(childDir+'/transcript_full.jsonl',row(0,'PLANNER_RESPONSE','CHILD-RESULT'));
          // Real-shaped native callback: the parent engine reacts without an
          // additional platform prompt RPC, even after ACP's prompt ended.
          fs.appendFileSync(file,row(2,'SYSTEM_MESSAGE','[Message] sender='+childId+' content=CHILD-RESULT')+row(3,'PLANNER_RESPONSE','PARENT-CONTINUED CHILD-RESULT'));
        },180);
        return;
      }
      if (scenario.startsWith('native-child-')) {
        const dir = `${process.env.HOME}/.gemini/antigravity-cli/brain/${p.sessionId}/.system_generated/logs`;
        fs.mkdirSync(dir,{recursive:true});
        const file=dir+'/transcript_full.jsonl';
        const row=(step_index,type,content,extra={})=>JSON.stringify({step_index,type,status:'DONE',source:type==='USER_INPUT'?'USER_EXPLICIT':'MODEL',created_at:'2026-11-12T00:00:00Z',content,...extra})+'\n';
        const childId='native-child-fixture';
        const pass = state.bridgePass = (state.bridgePass || 0)+1, offset=(pass-1)*6;
        if(pass===1) fs.writeFileSync(file,row(offset,'USER_INPUT',text));else fs.appendFileSync(file,row(offset,'USER_INPUT',text));
        note(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'launch-'+pass,title:pass===1?'Run invoke_subagent':'Run send_message',kind:'other',status:'in_progress',rawInput:pass===1?{Role:'WakeProbe',Prompt:'return result',Model:'model-a'}:{Recipient:childId,Prompt:'next assignment'}});
        note(p.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'launch-'+pass,status:'completed'});
        const intermediateContent = scenario === 'native-child-commentary' ? 'Launching worker' : '';
        fs.appendFileSync(file,row(offset+1,'PLANNER_RESPONSE',intermediateContent,{tool_calls:[{name:pass===1?'invoke_subagent':'send_message',args:pass===1?{Role:'WakeProbe'}:{Recipient:childId}}]})+row(offset+2,'GENERIC',pass===1?'Created the following subagent:\n'+JSON.stringify({conversationId:childId}):'Message sent'));
        const foregroundRow=()=>fs.appendFileSync(file,row(offset+3,'PLANNER_RESPONSE',scenario==='native-child-same-foreground'&&pass===2?'PARENT-WOKE CHILD-PONG':'PARENT-STARTED'));
        if(['native-child-output-after-ack','native-child-commentary'].includes(scenario)) setTimeout(foregroundRow,120);else if(scenario==='native-child-wait') setTimeout(foregroundRow,600);else if(scenario!=='native-child-no-owned-output') foregroundRow();
        note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT-STARTED'}});
        const finishFirst=()=>ok(req.id,{stopReason:'end_turn',usage:{inputTokens:pass===2?700:100,outputTokens:pass===2?71:2}});
        if(pass===2 && ['native-child-slow-foreground','native-child-same-foreground','native-child-cross-chunks'].includes(scenario)) setTimeout(finishFirst,900);else if(scenario==='native-child-rpc-late') setTimeout(finishFirst,300);else finishFirst();
        if(['native-child-wait','native-child-no-owned-output'].includes(scenario)) return;
        setTimeout(()=>{
          const childDir=`${process.env.HOME}/.gemini/antigravity-cli/brain/${childId}/.system_generated/logs`;fs.mkdirSync(childDir,{recursive:true});
          if(pass===1) fs.writeFileSync(childDir+'/transcript_full.jsonl',row(0,'PLANNER_RESPONSE','CHILD-PONG'));
          else fs.appendFileSync(childDir+'/transcript_full.jsonl',row(1,'USER_INPUT','next assignment')+row(2,'PLANNER_RESPONSE','REUSE-PONG'));
          if(scenario==='native-child-both' || scenario==='native-child-late' || scenario==='native-child-late-chunks' || scenario==='native-child-same-twice' || ['native-child-slow-foreground','native-child-same-foreground','native-child-cross-chunks'].includes(scenario)) {
            if(scenario==='native-child-both') note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT-WOKE CHILD-PONG'}});
            else setTimeout(()=>{
              note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT-WOKE '}});
              setTimeout(()=>{note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'CHILD-PONG'}});note(p.sessionId,{sessionUpdate:'usage_update',used:999999,size:1000000});note(p.sessionId,{sessionUpdate:'turn_completed'});},scenario==='native-child-late-chunks'?80:scenario==='native-child-cross-chunks'?300:0);
            },scenario==='native-child-cross-chunks'?0:200);
          }
          fs.appendFileSync(file,row(offset+4,'SYSTEM_MESSAGE','[Message] sender='+childId+' content=CHILD-PONG')+row(offset+5,'PLANNER_RESPONSE','PARENT-WOKE CHILD-PONG',{input_tokens:120,cache_read_tokens:80,output_tokens:3}));
          if(scenario==='native-child-both') note(p.sessionId,{sessionUpdate:'turn_completed'});
          if(scenario==='native-child-same-twice') setTimeout(()=>{
            fs.appendFileSync(file,row(offset+6,'SYSTEM_MESSAGE','[Message] sender='+childId+' content=another result')+row(offset+7,'PLANNER_RESPONSE','PARENT-WOKE CHILD-PONG'));
            setTimeout(()=>{note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT-WOKE CHILD-PONG'}});note(p.sessionId,{sessionUpdate:'turn_completed'});},scenario==='native-child-cross-chunks'?0:200);
          },500);
        },180);
        return;
      }
      if (scenario === 'subagents') {
      const nativeDir=`${process.env.HOME}/.gemini/antigravity-cli/brain/${p.sessionId}/.system_generated/logs`;fs.mkdirSync(nativeDir,{recursive:true});
      const nativeRow=(step_index,type,content)=>JSON.stringify({step_index,type,content,status:'DONE',source:type==='USER_INPUT'?'USER_EXPLICIT':'MODEL'})+'\n';
      fs.writeFileSync(nativeDir+'/transcript_full.jsonl',nativeRow(0,'USER_INPUT',text));
      const ops = [
        ['define_subagent', {name:'Researcher',prompt:'definition only'}, {}],
        ['invoke_subagent', {Subagents:[{Role:'Researcher',Prompt:'find info',Model:'model-a'}]}, {conversationId:'child-a',status:'running'}],
        ['manage_subagents', {action:'list'}, {subagents:[{conversationId:'child-a',status:'completed',role:'Researcher'}]}],
        ['swarm', {action:'add',conversationId:'child-b',prompt:'work'}, {conversationId:'child-b',status:'running'}],
        ['swarm', {action:'status'}, {agents:[{conversationId:'child-b',status:'error'}]}],
        ['send_message', {conversationId:'child-b',prompt:'try again'}, {}],
        ['manage_subagents', {action:'kill',conversationId:'child-b'}, {}],
        ['browser_subagent', {prompt:'inspect local page'}, {conversationId:'browser-c',status:'completed'}],
        ['invoke_subagent', {Subagents:[{Role:'MultiOne',Prompt:'first member'},{Role:'MultiTwo',Prompt:'second member'}]}, {subagents:[{conversationId:'multi-one',status:'running',role:'MultiOne'},{conversationId:'multi-two',status:'running',role:'MultiTwo'}]}],
        ['manage_subagents', {action:'list'}, {subagents:[{conversationId:'multi-one',status:'completed',role:'MultiOne'},{conversationId:'multi-two',status:'failed',role:'MultiTwo'}]}],

      ];
        for (const [i,[title,rawInput,rawOutput]] of ops.entries()) {
          note(p.sessionId, {sessionUpdate:'tool_call',toolCallId:`child-tool-${i}`,title,kind:'other',status:'in_progress',rawInput});
          note(p.sessionId, {sessionUpdate:'tool_call_update',toolCallId:`child-tool-${i}`,status:'completed',rawOutput});
        }
        fs.appendFileSync(nativeDir+'/transcript_full.jsonl',nativeRow(1,'PLANNER_RESPONSE','children synced'));
        note(p.sessionId, {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'children synced'}});
        return ok(req.id,{stopReason:'end_turn',usage:{inputTokens:50,outputTokens:2}});
      }
      if (scenario==='stream-before-ack') {
        note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'direct '}});
        setTimeout(()=>{note(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'stream'}});ok(req.id,{stopReason:'end_turn',usage:{inputTokens:40,outputTokens:2}});},300);return;
      }
      if (text === 'B' && scenario === 'reject-b') return error(req.id, 'B was rejected');
      if (state.inAutoWakeup) {
        record({ fixture: 'prompt-model', sessionId: p.sessionId, model: state.turnModel, text });
        state.pending.push(req.id); state.inputs.push(text);
        note(p.sessionId, { sessionUpdate: 'turn_completed' });
        return;
      }
      clearTimeout(state.timer);
      if (scenario !== 'reordered' && state.pending.length) for (const id of state.pending.splice(0)) ok(id, { stopReason: 'end_turn' });
      if (!state.inputs.length) state.turnModel = state.model || models.currentModelId;
      record({ fixture: 'prompt-model', sessionId: p.sessionId, model: state.turnModel, text });
      state.pending.push(req.id); state.inputs.push(text);
      note(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      if (state.inputs.length === 1) note(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'sleep', title: 'Test sleep', kind: 'execute', status: 'in_progress', rawInput: { command: 'fixture-only' } });
      if (scenario === 'crash' && text === 'B') return process.exit(12);
      state.timer = setTimeout(() => finish(p.sessionId, state), text === 'A' || text.includes('RUN_A') ? 600 : 220); return;
    }
    default: if (req.id !== undefined) error(req.id, 'Method unavailable');
  }
});
