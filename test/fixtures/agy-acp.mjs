// Deterministic stdio peer for the REAL ACP SDK client. No model/network/auth.
import readline from 'node:readline';
import fs from 'node:fs';
const logPath = process.env.AGY_ACP_FIXTURE_LOG;
const scenario = process.env.AGY_ACP_FIXTURE_SCENARIO || '';
const sessions = new Map(); let nextId = 0;
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
const ok = (id, result = {}) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32602, message } });
const note = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const record = data => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(data) + '\n'); };
if (process.argv.includes('--help')) { console.log('Usage: agy'); process.exit(0); }
if (process.argv.includes('--version')) { console.log(process.env.AGY_ACP_FIXTURE_VERSION || '1.5.4'); process.exit(0); }
const models = { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }, { modelId: 'model-b', name: 'Model B' }] };
function finish(sid, state) {
  // Explicit process-fixture handshake, not a timing assumption about CI CPU.
  if (logPath && fs.existsSync(logPath + '.hold')) {
    state.timer = setTimeout(() => finish(sid, state), 10); return;
  }
  state.timer = undefined;
  record({ fixture: 'completed-model', sessionId: sid, model: state.turnModel });
  note(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'sleep', status: 'completed', rawOutput: 'done' });
  note(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: state.inputs.join(' ') } });
  const pending = state.pending.splice(0);
  if (scenario === 'reordered') pending.reverse();
  for (const [i, id] of pending.entries()) setTimeout(() => ok(id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }), i * (Number(process.env.AGY_ACP_FIXTURE_REPLY_GAP_MS) || 20));
  state.inputs = [];
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line); const p = req.params || {}; record(req);
  switch (req.method) {
    case 'initialize': return ok(req.id, { protocolVersion: 1, agentInfo: { name: process.env.AGY_ACP_FIXTURE_AGENT_NAME, version: '1.5.4' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, list: {} } } });
    case 'session/new': {
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
      if (p.modelId === 'invalid' || scenario === 'model-error') return error(req.id, 'Unknown model');
      if (scenario === 'model-unsupported') return error(req.id, 'Method unavailable');
      const respond = () => { const state = sessions.get(p.sessionId); if (state) state.model = p.modelId; ok(req.id); };
      return setTimeout(respond, p.modelId === 'model-b' && scenario === 'model-late' ? 180 : p.modelId === 'model-b' && scenario === 'model-timeout' ? 5500 : 0);
    }
    case 'session/set_mode': return ok(req.id);
    case 'session/close': {
      const state = sessions.get(p.sessionId); if (state) { clearTimeout(state.timer); for (const id of state.pending) ok(id, { stopReason: 'cancelled' }); }
      sessions.delete(p.sessionId); return ok(req.id);
    }
    case 'session/cancel': {
      if (scenario === 'crash-on-cancel') return process.exit(12);
      const state = sessions.get(p.sessionId); if (!state) return;
      clearTimeout(state.timer); for (const id of state.pending.splice(0)) ok(id, { stopReason: 'cancelled' }); state.inputs = []; return;
    }
    case 'session/prompt': {
      const state = sessions.get(p.sessionId); if (!state) return error(req.id, 'Missing session');
      const text = p.prompt.map(x => x.text || '').join('');
      if (text === 'B' && scenario === 'reject-b') return error(req.id, 'B was rejected');
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
