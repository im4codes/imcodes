/** Isolated app-server protocol peer; never authenticates or runs a model. */
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.137.0'); process.exit(0); }
const log = (value) => appendFileSync(process.env.SEND_IDENTITY_LOG, JSON.stringify(value) + '\n');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => emit({ method, params });
let thread = 0;
let turn = 0;
const turns = new Map();
log({ kind: 'spawn' });
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  const { id, method, params = {} } = request;
  const reply = (result) => { if (id !== undefined) emit({ id, result }); };
  if (method === 'initialize') { reply({ userAgent: 'synthetic', platformFamily: 'unix' }); continue; }
  if (method === 'thread/start' || method === 'thread/resume') {
    const threadId = params.threadId ?? `fixture-thread-${++thread}`;
    reply({ thread: { id: threadId, turns: [] } }); continue;
  }
  if (method === 'thread/read') { reply({ thread: { id: params.threadId, turns: [] } }); continue; }
  if (method === 'turn/start') {
    const text = JSON.stringify(params.input);
    const turnId = `fixture-turn-${++turn}`;
    const threadId = params.threadId;
    log({ kind: 'input', method, threadId, text });
    reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
    event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    event('item/started', { threadId, turnId, item: { id: turnId, type: 'agentMessage', text: '' } });
    event('item/agentMessage/delta', { threadId, turnId, itemId: turnId, delta: 'Synthetic complete reply' });
    const finish = () => {
      event('item/completed', { threadId, turnId, item: { id: turnId, type: 'agentMessage', text: 'Synthetic complete reply' } });
      event('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } });
      turns.delete(threadId);
    };
    turns.set(threadId, { turnId, finish });
    setTimeout(finish, text.includes('HOLD') ? 4000 : 40);
    continue;
  }
  if (method === 'turn/steer') {
    log({ kind: 'input', method, threadId: params.threadId, text: JSON.stringify(params.input) });
    reply({ turnId: turns.get(params.threadId)?.turnId ?? params.expectedTurnId });
    continue;
  }
  reply({});
}
