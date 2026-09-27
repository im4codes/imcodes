import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { TIMELINE_MESSAGES, TIMELINE_PROTOCOL_CAPABILITY } from '../../../shared/timeline-protocol.ts';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
let Client;
let WebSocket;
try {
  ({ Client } = require('pg'));
  WebSocket = require('ws');
} catch {
  // The compose daemon uses the built server image, whose dependencies live at
  // /app/node_modules rather than in the bind-mounted checkout.
  ({ Client } = createRequire(import.meta.url)('pg'));
  WebSocket = createRequire(import.meta.url)('ws');
}

const serverId = process.env.IMC_PERF_SERVER_ID ?? 'imc_perf_harness_server';
const token = process.env.IMC_PERF_DAEMON_TOKEN ?? 'imc-perf-daemon-token';
const serverUrl = process.env.IMC_PERF_SERVER_URL ?? 'ws://server:19138';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://imcodes_perf:perf-only-password@postgres:5432/imcodes_perf';
const userId = 'imc_perf_user';
const apiKey = 'deck_perf_browser_key';
const sessions = Number(process.env.IMC_PERF_SESSIONS ?? 20);
const perfSeed = (0x4d57494e).toString(36);
const sessionNames = Array.from({ length: sessions }, (_, index) => `deck_perflat_imcperf-${perfSeed}-${index.toString(36)}_brain`);
const subSessionIds = Array.from({ length: Math.max(0, sessions - 1) }, (_, index) => `perfsub${index.toString(36)}`);
const subSessionNames = subSessionIds.map((id) => `deck_sub_${id}`);
const activeTimelineNames = [...sessionNames.slice(0, 1), ...subSessionNames];
const longChatSessions = [500, 2000, 8000].map((size) => ({ size, name: `deck_perflat_imcperf-long${size}_brain` }));
const allSessionNames = [...sessionNames, ...longChatSessions.map((item) => item.name)];
const historyNames = [...allSessionNames, ...subSessionNames];
const hash = crypto.createHash('sha256').update(token).digest('hex');
const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
process.stdout.write(JSON.stringify({ phase: 'starting', sessions }) + '\n');

const client = new Client({ connectionString: databaseUrl });
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { await client.connect(); break; } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const now = Date.now();
    await client.query('INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, now]);
    await client.query(`INSERT INTO api_keys (id, user_id, key_hash, label, created_at)
      VALUES ('imc_perf_browser_key', $1, $2, 'browser performance harness', $3)
      ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, revoked_at = NULL`, [userId, apiKeyHash, now]);
    await client.query(`INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role)
      VALUES ($1, $2, $3, $4, 'offline', $5, 'full')
      ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, user_id = EXCLUDED.user_id`, [serverId, userId, 'browser harness daemon', hash, now]);
    for (let index = 0; index < allSessionNames.length; index += 1) {
      await client.query(`INSERT INTO sessions (id, server_id, name, project_name, project_dir, role, agent_type, state, created_at, updated_at)
        VALUES ($1, $2, $3, 'perflat-imcperf', '/tmp/imc-perf-project', 'brain', 'perf', 'idle', $4, $4)
        ON CONFLICT (id) DO UPDATE SET state='idle', updated_at=EXCLUDED.updated_at`, [`perf-session-${index}`, serverId, allSessionNames[index], now]);
    }
    for (let index = 0; index < subSessionIds.length; index += 1) {
      const id = subSessionIds[index];
      await client.query(`INSERT INTO sub_sessions (id, server_id, type, cwd, label, parent_session, created_at, updated_at)
        VALUES ($1, $2, 'codex', '/tmp/imc-perf-project', $3, $4, $5, $5)
        ON CONFLICT (id, server_id) DO UPDATE SET closed_at=NULL, parent_session=EXCLUDED.parent_session, updated_at=EXCLUDED.updated_at`, [id, serverId, `Perf sub ${index + 1}`, sessionNames[0], now]);
    }
    break;
  } catch (error) {
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const seeded = await client.query('SELECT count(*)::int AS count FROM sub_sessions WHERE server_id = $1', [serverId]);
await client.end();
process.stdout.write(JSON.stringify({ phase: 'database_ready', sessions, subSessions: subSessionIds.length, seededSubSessions: seeded.rows[0]?.count ?? 0 }) + '\n');

const ws = new WebSocket(`${serverUrl}/api/server/${encodeURIComponent(serverId)}/ws`);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
process.stdout.write(JSON.stringify({ phase: 'socket_open' }) + '\n');
ws.send(JSON.stringify({ type: 'auth', serverId, token, daemonVersion: 'perf-harness' }));
ws.send(JSON.stringify({ type: 'daemon.hello', daemonId: serverId, capabilities: [TIMELINE_PROTOCOL_CAPABILITY], timelineProtocolRevision: 1, helloEpoch: 1, sentAt: Date.now() }));

const epoch = 1;
const history = new Map(historyNames.map((name) => [name, []]));
function sendEvent(name, type, payload) {
  const events = history.get(name) ?? [];
  const event = { eventId: `perf-${name}-${events.length + 1}`, sessionId: name, epoch, seq: events.length + 1, ts: Date.now(), type, payload };
  events.push(event);
  history.set(name, events);
  ws.send(JSON.stringify({ type: TIMELINE_MESSAGES.EVENT, event }));
}
for (const [index, name] of activeTimelineNames.entries()) {
  sendEvent(name, 'user.message', { text: `Perf session ${index + 1} ready` });
  const toolBody = 'x'.repeat(19_000 + ((index * 7_919) % 40_001));
  sendEvent(name, 'tool.call', { name: 'shell', status: 'running', input: toolBody });
  sendEvent(name, 'tool.result', { name: 'shell', status: 'ok', output: toolBody });
  sendEvent(name, 'session.state', { state: 'idle' });
}
for (const { name, size } of longChatSessions) {
  const events = history.get(name);
  for (let index = 1; index <= size - 2; index += 1) {
    events.push({ eventId: `perf-${name}-${index}`, sessionId: name, epoch, seq: index, ts: Date.now() + index, type: index % 2 ? 'user.message' : 'assistant.text', payload: { text: index % 2 ? `Long chat request ${index}` : `Long chat response ${index}`, streaming: false } });
  }
  events.push({ eventId: `perf-${name}-${size - 1}`, sessionId: name, epoch, seq: size - 1, ts: Date.now() + size - 1, type: 'assistant.text', payload: { text: `Long chat streaming ${size}`, streaming: true } });
  events.push({ eventId: `perf-${name}-${size}`, sessionId: name, epoch, seq: size, ts: Date.now() + size, type: 'assistant.text', payload: { text: `Long chat final ${size}`, streaming: false } });
}
const announce = () => ws.send(JSON.stringify({ type: 'session_list', daemonVersion: 'perf-harness', sessions: allSessionNames.map((name, index) => ({ name, project: 'perflat-imcperf', projectDir: '/tmp/imc-perf-project', role: 'brain', agentType: 'perf', state: 'idle', runtimeType: 'transport', label: name.includes('-long') ? name.slice(name.indexOf('-long') + 1, -6) : `Perf ${index + 1}` })) }));
announce();
const announceTimer = setInterval(announce, 2_000);
process.stdout.write(JSON.stringify({ connected: true, serverId, sessions: sessionNames.length }) + '\n');

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  // The real SPA probes these daemon-backed P2P endpoints from every tab.
  // Answer them explicitly so the server's pending-request map does not fill
  // with synthetic requests that this harness forgot to service.
  if (msg.type === 'p2p.status') {
    ws.send(JSON.stringify({ type: 'p2p.status_response', requestId: msg.requestId, runs: [] }));
    return;
  }
  if (msg.type === 'p2p.list_discussions') {
    ws.send(JSON.stringify({ type: 'p2p.list_discussions_response', requestId: msg.requestId, discussions: [] }));
    return;
  }
  if (msg.type === 'p2p.read_discussion') {
    ws.send(JSON.stringify({ type: 'p2p.read_discussion_response', requestId: msg.requestId, discussion: null }));
    return;
  }
  if (msg.type === 'p2p.config.save') {
    ws.send(JSON.stringify({ type: 'p2p.config.save_response', requestId: msg.requestId, ok: true }));
    return;
  }
  if (typeof msg.sessionName !== 'string') return;
  if (msg.type === TIMELINE_MESSAGES.HISTORY_REQUEST || msg.type === TIMELINE_MESSAGES.REPLAY_REQUEST || msg.type === TIMELINE_MESSAGES.PAGE_REQUEST) {
    const events = history.get(msg.sessionName) ?? [];
    const afterSeq = Number(msg.cursor?.afterSeq ?? msg.afterSeq ?? 0);
    const type = msg.type === TIMELINE_MESSAGES.PAGE_REQUEST ? TIMELINE_MESSAGES.PAGE : (msg.type === TIMELINE_MESSAGES.REPLAY_REQUEST ? TIMELINE_MESSAGES.REPLAY : TIMELINE_MESSAGES.HISTORY);
    ws.send(JSON.stringify({ type, sessionName: msg.sessionName, requestId: msg.requestId, status: 'ok', source: 'cache', epoch, events: events.filter((event) => event.seq > afterSeq), hasMore: false, payloadTruncated: false }));
  }
});

let burst = 0;
const tick = setInterval(() => {
  for (let index = 0; index < activeTimelineNames.length; index += 1) {
    const name = activeTimelineNames[index];
    if (index < 5) sendEvent(name, 'assistant.text', { text: `stream-${++burst}`, streaming: true });
    else sendEvent(name, 'agent.status', { status: 'working', burst });
    if (index < 3) sendEvent(name, 'usage.update', { inputTokens: burst, outputTokens: burst * 2 });
  }
  if (burst > 0 && burst % 250 === 0) for (const name of sessionNames) sendEvent(name, 'assistant.text', { text: `Final answer for ${name}.`, streaming: false });
  if (burst % 25 === 0) for (const name of sessionNames) sendEvent(name, 'session.state', { state: 'idle' });
}, 40);
process.on('SIGTERM', () => { clearInterval(tick); clearInterval(announceTimer); ws.close(); process.exit(0); });
