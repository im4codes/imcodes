#!/usr/bin/env node

/**
 * A tiny, persistent Codex app-server used by the upgrade/auto-resume
 * integration harness.  It intentionally speaks the JSON-RPC-over-stdio
 * protocol consumed by src/agent/providers/codex-sdk.ts; it is not a mock of
 * the daemon.  Turns remain in progress until interrupted, and the state/log
 * files survive an app-server restart so the daemon's thread/resume path can
 * be audited from one append-only RPC transcript.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

const stateDir = process.env.IMCODES_CODEX_FIXTURE_STATE_DIR || '/tmp/imcodes-codex-fixture';
const statePath = join(stateDir, 'state.json');
const logPath = process.env.IMCODES_CODEX_FIXTURE_LOG || join(stateDir, 'rpc.jsonl');
const streamMs = Math.max(60_000, Number.parseInt(process.env.IMCODES_CODEX_FIXTURE_STREAM_MS || '300000', 10));
const tickMs = Math.max(100, Number.parseInt(process.env.IMCODES_CODEX_FIXTURE_TICK_MS || '1000', 10));

let state = {
  threadId: 'fixture-thread-1',
  nextTurn: 1,
  activeTurn: null,
};
try {
  state = { ...state, ...JSON.parse(await readFile(statePath, 'utf8')) };
} catch {
  // First process for a fixture directory.
}
await mkdir(dirname(statePath), { recursive: true });
await mkdir(dirname(logPath), { recursive: true });

const active = new Map();

async function persist() {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');
}

async function log(message) {
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`, 'utf8');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadIdFor(params) {
  return String(params?.threadId || params?.thread?.id || state.threadId);
}

async function stopTurn(threadId, status = 'interrupted') {
  const turn = active.get(threadId);
  if (!turn) return;
  clearInterval(turn.timer);
  clearTimeout(turn.expiry);
  active.delete(threadId);
  if (state.activeTurn?.threadId === threadId) {
    state.activeTurn = { ...state.activeTurn, status };
    await persist();
  }
  send({ method: 'turn/completed', params: {
    threadId,
    turn: { id: turn.id, status, error: null },
  } });
}

async function startTurn(id, params) {
  const threadId = threadIdFor(params);
  const turnId = `fixture-turn-${state.nextTurn++}`;
  const itemId = `fixture-message-${turnId}`;
  const input = String(params?.input?.[0]?.text || '');
  await persist();
  state.activeTurn = { threadId, turnId, itemId, input, status: 'inProgress', startedAt: Date.now() };
  await persist();
  send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
  send({ method: 'item/started', params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', text: '' } } });
  let tick = 0;
  const emit = () => {
    tick += 1;
    send({ method: 'item/agentMessage/delta', params: {
      threadId, turnId, itemId, delta: `fixture tick ${tick}\n`,
    } });
    send({ method: 'thread/tokenUsage/updated', params: {
      threadId, turnId,
      tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: tick }, total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: tick, totalTokens: tick + 1 }, modelContextWindow: 1_000_000 },
    } });
  };
  emit();
  const timer = setInterval(emit, tickMs);
  const expiry = setTimeout(() => { void stopTurn(threadId, 'completed'); }, streamMs);
  active.set(threadId, { id: turnId, timer, expiry });
}

async function handle(message) {
  await log({ direction: 'in', id: message.id ?? null, method: message.method ?? null, params: message.params ?? null });
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (id !== undefined) send({ id, result: { userAgent: 'imcodes-fixture-codex/1', platform: process.platform } });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'mcpServerStatus/list') {
    if (id !== undefined) send({ id, result: { data: [{ name: 'imcodes-memory', runtimeStatus: 'connected', tools: { send_list_targets: {}, send_message: {} } }] } });
    return;
  }
  if (method === 'model/list') {
    if (id !== undefined) send({ id, result: { data: [{ id: 'fixture-model', model: 'fixture-model' }] } });
    return;
  }
  if (method === 'thread/start') {
    state.threadId = `fixture-thread-${Date.now()}`;
    await persist();
    if (id !== undefined) send({ id, result: { thread: { id: state.threadId } } });
    send({ method: 'thread/started', params: { thread: { id: state.threadId } } });
    return;
  }
  if (method === 'thread/resume') {
    const threadId = threadIdFor(params);
    state.threadId = threadId;
    await persist();
    if (id !== undefined) send({ id, result: { thread: { id: threadId } } });
    return;
  }
  if (method === 'thread/read' || method === 'thread/status') {
    if (id !== undefined) send({ id, result: { thread: { id: threadIdFor(params), status: state.activeTurn?.status || 'idle' } } });
    return;
  }
  if (method === 'turn/start') {
    await startTurn(id, params);
    return;
  }
  if (method === 'turn/interrupt') {
    const threadId = threadIdFor(params);
    if (id !== undefined) send({ id, result: {} });
    await stopTurn(threadId);
    return;
  }
  if (method === 'thread/unsubscribe') {
    if (id !== undefined) send({ id, result: { status: 'unsubscribed' } });
    return;
  }
  // Keep probes added by newer Codex SDKs from hanging the daemon. Unknown
  // notifications are intentionally ignored; unknown requests get a benign
  // empty result, matching the fixture's narrow protocol role.
  if (id !== undefined) send({ id, result: {} });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)); } catch (error) { void log({ direction: 'error', error: String(error) }); }
});

async function shutdown() {
  for (const threadId of [...active.keys()]) await stopTurn(threadId);
  await persist();
}
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
